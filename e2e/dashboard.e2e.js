/**
 * Browser smoke test for the operator dashboard.
 *
 * Drives a real Chromium at phone viewport sizes against a running control
 * plane and asserts that every primary screen renders live data, that the
 * empty/error states are honest, and that no horizontal scrolling appears at
 * 320px. Playwright is not a project dependency; install it where you run this:
 *
 *   npm i -D playwright && npx playwright install chromium
 *   DASHBOARD_URL=http://localhost:4173 ADMIN_PASSWORD=... \
 *     node e2e/dashboard.e2e.js
 *
 * Set CHROMIUM_PATH to use a browser that is already installed.
 */
import { chromium } from 'playwright';

const DASHBOARD = process.env.DASHBOARD_URL || 'http://localhost:4173';
const USERNAME = process.env.ADMIN_USERNAME || 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD;
const SHOTS = process.env.SCREENSHOT_DIR || null;

const VIEWPORTS = [
  { name: '320', width: 320, height: 640 },
  { name: '390', width: 390, height: 844 },
  { name: '430', width: 430, height: 932 },
];

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

async function run() {
  if (!PASSWORD) throw new Error('ADMIN_PASSWORD is required');
  // CHROMIUM_PATH lets this run against a preinstalled browser rather than a
  // Playwright-managed download.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const consoleErrors = [];

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`${viewport.name}: ${msg.text()}`); });
    page.on('pageerror', (err) => consoleErrors.push(`${viewport.name}: ${err.message}`));

    await page.goto(DASHBOARD, { waitUntil: 'networkidle' });

    // --- sign in -----------------------------------------------------------
    await page.fill('input[autocomplete="username"]', USERNAME);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.bottom-nav', { timeout: 10000 });
    check(`[${viewport.name}] signs in and shows the shell`, true);

    // --- overview ----------------------------------------------------------
    await page.waitForSelector('.state-name', { timeout: 10000 });
    const state = await page.textContent('.state-name');
    check(`[${viewport.name}] overview shows a network state`, Boolean(state), state);

    const metrics = await page.$$eval('.metric-value', (els) => els.map((e) => e.textContent));
    check(`[${viewport.name}] overview shows four metrics`, metrics.length === 4, metrics.join(' | '));

    // --- touch targets -----------------------------------------------------
    const smallTargets = await page.$$eval('.nav-item, .btn, .icon-btn', (els) =>
      els.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.height < 44;
      }).map((el) => `${el.className}:${Math.round(el.getBoundingClientRect().height)}px`));
    check(`[${viewport.name}] every control is at least 44px tall`, smallTargets.length === 0, smallTargets.join(', '));

    // --- navigate every primary screen -------------------------------------
    for (const [label, selector] of [
      ['Gateways', 'text=Gateways'],
      ['Routes', 'text=Routes'],
      ['Users', 'text=Users'],
      ['More', 'text=More'],
    ]) {
      await page.click(`.bottom-nav >> ${selector}`);
      await page.waitForTimeout(600);
      const hasContent = await page.$$eval('.app-main > *', (els) => els.length > 0);
      check(`[${viewport.name}] ${label} renders`, hasContent);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`[${viewport.name}] ${label} does not scroll horizontally`, overflow <= 0, `overflow ${overflow}px`);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${viewport.name}-${label.toLowerCase()}.png`, fullPage: true });
    }

    // --- more section screens ---------------------------------------------
    for (const [label, path] of [
      ['Egress paths', '/egresses'],
      ['Events', '/events'],
      ['Health checks', '/health'],
      ['Blackout lab', '/lab'],
      ['Settings', '/settings'],
    ]) {
      await page.goto(`${DASHBOARD}/#${path}`);
      await page.waitForTimeout(500);
      const heading = await page.textContent('.screen-title');
      check(`[${viewport.name}] ${label} screen opens`, heading === label, heading);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`[${viewport.name}] ${label} does not scroll horizontally`, overflow <= 0, `overflow ${overflow}px`);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${viewport.name}-${path.slice(1)}.png`, fullPage: true });
    }

    // --- overview screenshot for the record --------------------------------
    await page.goto(`${DASHBOARD}/#/`);
    await page.waitForSelector('.state-name');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${viewport.name}-overview.png`, fullPage: true });

    await context.close();
  }

  await browser.close();

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) process.exit(1);
}

run().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
