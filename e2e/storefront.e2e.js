/**
 * Browser smoke test for the customer storefront and the operator console.
 *
 * Runs a real purchase flow against a running control plane: register, order a
 * plan, read the payment screen, have an operator settle the order, then check
 * that the config screen hands over a working subscription link.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   DASHBOARD_URL=http://localhost:4173 API_URL=http://localhost:8787 \
 *   ADMIN_PASSWORD=... node e2e/storefront.e2e.js
 *
 * Set CHROMIUM_PATH to use a browser that is already installed.
 */
import http from 'node:http';
import { chromium } from 'playwright';

const DASHBOARD = process.env.DASHBOARD_URL || 'http://localhost:4173';
const API = process.env.API_URL || 'http://localhost:8787';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SHOTS = process.env.SCREENSHOT_DIR || null;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const api = async (method, path, { body, token } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const noOverflow = (page) => page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0);

/**
 * Stands in for a gateway's WebSocket inbound on GATEWAY_PORT so the control
 * plane's ingress probe succeeds and the subscription actually carries a
 * profile. Without it the correct behaviour is an empty subscription, which is
 * not what this test is checking.
 */
function fakeGateway(port) {
  const server = http.createServer((_req, res) => { res.writeHead(400); res.end(); });
  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function run() {
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is required');
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const errors = [];
  const email = `buyer-${Date.now()}@example.test`;
  const password = 'a-good-password';

  // ---------------------------------------------------------------- customer
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(DASHBOARD, { waitUntil: 'networkidle' });
  const planCount = await page.locator('.plan').count();
  check('store lists plans without signing in', planCount > 0, `${planCount} plans`);
  check('store does not scroll horizontally', await noOverflow(page));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/shop-store.png`, fullPage: true });

  // Buying while signed out sends the visitor to the account screen.
  await page.locator('.plan .btn').first().click();
  await page.waitForSelector('input[type="email"]', { timeout: 8000 });
  check('buying while signed out asks for an account', true);

  await page.click('.link-btn'); // switch to "create account"
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.bottom-nav', { timeout: 10000 });
  check('registration signs the customer in', true);

  await page.goto(`${DASHBOARD}/#/account`);
  await page.waitForSelector('.empty, .state-name', { timeout: 8000 });
  const emptyText = await page.textContent('.empty h3').catch(() => null);
  check('a new customer sees no config yet, not a fake one', emptyText === 'No config yet', emptyText);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/shop-account-empty.png`, fullPage: true });

  await page.goto(`${DASHBOARD}/#/`);
  await page.waitForSelector('.plan');
  await page.locator('.plan .btn').first().click();
  await page.waitForSelector('.pay-amount', { timeout: 10000 });

  const amount = (await page.textContent('.pay-amount strong')).trim();
  const address = (await page.textContent('.token-box')).trim();
  check('payment screen shows an exact amount', /\d/.test(amount), amount);
  check('payment screen shows the receiving address', address.length > 25, address.slice(0, 12) + '…');
  check('payment screen renders a QR code', (await page.locator('.qr svg').count()) === 1);
  check('payment screen does not scroll horizontally', await noOverflow(page));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/shop-order.png`, fullPage: true });

  // ------------------------------------------------------------- fulfilment
  const adminToken = (await api('POST', '/api/v1/auth/login', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  })).body.data.token;
  const orders = (await api('GET', '/api/v1/orders?status=pending', { token: adminToken })).body.data;
  const order = orders.find((o) => o.payAmountUsdt);
  check('the order reached the control plane', Boolean(order), order?.id);

  const settled = await api('POST', `/api/v1/orders/${order.id}/settle`, {
    token: adminToken, body: { note: 'e2e test settlement' },
  });
  check('an operator can settle an order', settled.status === 200, settled.body?.data?.order?.settledBy);

  // Make the registered gateway answer, then let the control plane measure it,
  // so the subscription has a profile to hand out.
  const gateways = (await api('GET', '/api/v1/gateways', { token: adminToken })).body.data;
  const gatewayPort = gateways[0]?.port;
  const stub = gatewayPort ? await fakeGateway(gatewayPort) : null;
  for (const gateway of gateways) {
    await api('POST', `/api/v1/gateways/${gateway.id}/check`, { token: adminToken });
  }

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.state-name', { timeout: 10000 });
  const orderState = await page.textContent('.state-name');
  check('the payment screen turns into a receipt', /activated/i.test(orderState), orderState);

  await page.goto(`${DASHBOARD}/#/account`);
  await page.waitForSelector('.token-box', { timeout: 10000 });
  const subUrl = (await page.textContent('.token-box')).trim();
  check('my config shows the subscription link', /\/sub\/[A-Za-z0-9_-]{20,}$/.test(subUrl), subUrl.replace(/\/sub\/.*/, '/sub/…'));
  check('my config renders a QR code', (await page.locator('.qr svg').count()) === 1);
  check('my config does not scroll horizontally', await noOverflow(page));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/shop-account.png`, fullPage: true });

  const subscription = await fetch(subUrl);
  const subBody = await subscription.text();
  const decoded = Buffer.from(subBody, 'base64').toString('utf8');
  check('the link served in the browser is a working subscription',
    subscription.ok && decoded.startsWith('vless://'), decoded.split('\n')[0].slice(0, 40));

  stub?.closeAllConnections();
  stub?.close();

  // Narrow-screen pass over the same screens.
  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of ['/', '/account']) {
    await page.goto(`${DASHBOARD}/#${path}`);
    await page.waitForTimeout(700);
    check(`customer ${path} fits 320px`, await noOverflow(page));
  }
  await context.close();

  // ---------------------------------------------------------------- operator
  const adminContext = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const adminPage = await adminContext.newPage();
  adminPage.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  adminPage.on('pageerror', (e) => errors.push(e.message));

  await adminPage.goto(`${DASHBOARD}/#/admin`, { waitUntil: 'networkidle' });
  await adminPage.fill('input[autocomplete="username"]', ADMIN_USERNAME);
  await adminPage.fill('input[type="password"]', ADMIN_PASSWORD);
  await adminPage.click('button[type="submit"]');
  await adminPage.waitForSelector('.bottom-nav', { timeout: 10000 });
  check('operator console signs in at /admin', true);

  for (const [label, path] of [
    ['Overview', '/admin'],
    ['Gateways', '/admin/gateways'],
    ['Routes', '/admin/routes'],
    ['Subscribers', '/admin/users'],
    ['More', '/admin/more'],
    ['Plans', '/admin/plans'],
    ['Orders', '/admin/orders'],
    ['Egress paths', '/admin/egresses'],
    ['Events', '/admin/events'],
    ['Health checks', '/admin/health'],
    ['Blackout lab', '/admin/lab'],
    ['Settings', '/admin/settings'],
  ]) {
    await adminPage.goto(`${DASHBOARD}/#${path}`);
    await adminPage.waitForTimeout(500);
    const title = await adminPage.textContent('.screen-title');
    check(`operator ${label} renders`, title === label, title);
    check(`operator ${label} fits 390px`, await noOverflow(adminPage));
    if (SHOTS) await adminPage.screenshot({ path: `${SHOTS}/admin-${path.replace(/\W+/g, '-')}.png`, fullPage: true });
  }

  const settledOrder = await adminPage.textContent('body');
  void settledOrder;
  await adminContext.close();
  await browser.close();

  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(`\n${passed}/${results.length} checks passed\n`);
  if (passed !== results.length) process.exit(1);
}

run().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
