/**
 * Blackout-lab driver.
 *
 * Registers real infrastructure against a real control plane, then asserts each
 * scenario by observing actual traffic and actual control-plane state. Nothing
 * here simulates a result: every check either runs a command in a container or
 * reads the control-plane API.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, 'state');
const API = process.env.LAB_API || 'http://127.0.0.1:8790';
const ADMIN_PASSWORD = process.env.LAB_ADMIN_PASSWORD || 'lab-admin-password';

const results = [];
let token = null;

const log = (msg) => process.stdout.write(`${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(id, name, ok, detail = '') {
  results.push({ id, name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? `\n         ${detail}` : ''}`);
}

async function compose(args, options = {}) {
  return exec('docker', ['compose', '-f', path.join(HERE, 'docker-compose.yml'), ...args], {
    cwd: HERE,
    env: { ...process.env },
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

/** Runs a command inside a lab container and returns { code, stdout }. */
async function inContainer(service, command) {
  try {
    const { stdout } = await compose(['exec', '-T', service, 'sh', '-c', command]);
    return { code: 0, stdout: stdout.trim() };
  } catch (err) {
    return { code: err.code ?? 1, stdout: `${err.stdout || ''}${err.stderr || ''}`.trim() };
  }
}

async function apiRequest(method, apiPath, body) {
  const res = await fetch(API + apiPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  if (!res.ok) {
    throw new Error(`${method} ${apiPath} -> ${res.status} ${payload ? JSON.stringify(payload.error) : text.slice(0, 200)}`);
  }
  return payload?.data;
}

async function waitFor(label, predicate, { timeoutMs = 90000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

const routeFor = async (gatewayId) =>
  (await apiRequest('GET', '/api/v1/routes')).find((r) => r.gatewayId === gatewayId);

async function main() {
  await fs.mkdir(STATE, { recursive: true });
  await fs.rm(path.join(STATE, 'client.json'), { force: true });

  log('\n=== SyxVPN blackout lab ===\n');

  if (process.env.LAB_SKIP_BUILD === '1') {
    log('· LAB_SKIP_BUILD=1, using existing images');
  } else {
    log('· building images');
    await compose(['build']);
  }

  log('· starting control plane, origin and egress nodes');
  await compose(['up', '-d', 'control', 'origin', 'egress-a', 'egress-b']);

  await waitFor('control plane readiness', async () => {
    const res = await fetch(`${API}/readiness`);
    return res.ok;
  });

  token = (await apiRequest('POST', '/api/v1/auth/login', {
    username: 'admin', password: ADMIN_PASSWORD,
  })).token;
  log('· authenticated to the control plane');

  // --- register infrastructure ---------------------------------------------
  const gateway = await apiRequest('POST', '/api/v1/gateways', {
    name: 'Lab gateway',
    region: 'lab-edge',
    host: 'gateway',
    port: 8080,
    tlsMode: 'none',
    wsPath: '/lab',
    // The lab origin lives on a private range, so the guard rule is off here.
    blockPrivateRanges: false,
  });

  const egressA = await apiRequest('POST', '/api/v1/egresses', {
    name: 'Lab egress A', region: 'lab-world', kind: 'socks',
    host: 'egress-a', port: 1080, probeUrl: 'http://origin/ok',
    priority: 10, authorizationNote: 'lab-only simulated upstream',
  });
  const egressB = await apiRequest('POST', '/api/v1/egresses', {
    name: 'Lab egress B', region: 'lab-world', kind: 'socks',
    host: 'egress-b', port: 1080, probeUrl: 'http://origin/ok',
    priority: 20, authorizationNote: 'lab-only simulated upstream',
  });
  await apiRequest('POST', `/api/v1/gateways/${gateway.id}/egresses`, { egressId: egressA.id, priority: 10 });
  await apiRequest('POST', `/api/v1/gateways/${gateway.id}/egresses`, { egressId: egressB.id, priority: 20 });

  const subscriber = await apiRequest('POST', '/api/v1/subscribers', {
    name: 'Lab subscriber', quotaGb: 1, days: 1,
  });
  log(`· registered gateway ${gateway.id} with two egress paths and one subscriber`);

  // --- start the gateway agent ---------------------------------------------
  process.env.LAB_GATEWAY_ID = gateway.id;
  process.env.LAB_AGENT_KEY = gateway.agentKey;
  await compose(['up', '-d', 'gateway']);
  log('· gateway agent starting');

  await waitFor('agent to deploy its configuration', async () => {
    const detail = await apiRequest('GET', `/api/v1/gateways/${gateway.id}`);
    return detail.config.inSync && detail.agent.status === 'online';
  });
  log('· agent deployed the generated Xray configuration');

  // A subscription only carries profiles for gateways the control plane has
  // actually measured as reachable, so probe before fetching.
  await waitFor('the control plane to measure the gateway as reachable', async () => {
    const check = await apiRequest('POST', `/api/v1/gateways/${gateway.id}/check`);
    return check.ingress.status === 'online';
  });

  // --- start the isolated client -------------------------------------------
  const subscription = await (await fetch(`${API}/sub/${subscriber.subscriptionToken}?format=json`)).json();
  const profile = subscription.data.profiles[0];
  if (!profile) throw new Error('no profile served; the gateway never became usable');
  const uri = new URL(profile.uri);
  await fs.writeFile(path.join(STATE, 'client.json'), `${JSON.stringify({
    log: { loglevel: 'warning' },
    inbounds: [{ tag: 'socks-in', listen: '127.0.0.1', port: 1080, protocol: 'socks', settings: { auth: 'noauth', udp: false } }],
    outbounds: [{
      tag: 'cvpn',
      protocol: 'vless',
      settings: { vnext: [{ address: uri.hostname, port: Number(uri.port), users: [{ id: uri.username, encryption: 'none' }] }] },
      streamSettings: {
        network: 'ws',
        wsSettings: { path: uri.searchParams.get('path'), headers: { Host: uri.searchParams.get('host') } },
      },
    }],
  }, null, 2)}\n`);
  await compose(['up', '-d', 'client']);
  await sleep(4000);
  log('· client started from a real subscription fetch\n');

  // probe.mjs ships in the lab image so the containers need no extra packages.
  const throughTunnel = () =>
    inContainer('client', 'node /usr/local/bin/probe.mjs http://origin/ok socks5://127.0.0.1:1080');
  const direct = () =>
    inContainer('client', 'PROBE_TIMEOUT_MS=5000 node /usr/local/bin/probe.mjs http://origin/ok');

  // --- scenario 1: baseline -------------------------------------------------
  const baseline = await waitFor('first successful tunnel request', async () => {
    const r = await throughTunnel();
    return r.stdout.includes('cvpn-origin-ok') ? r : false;
  }, { timeoutMs: 40000 });
  record('S1', 'Baseline: client reaches the origin through the gateway', true, baseline.stdout);

  // --- scenario 2: the client has no direct path ---------------------------
  const directResult = await direct();
  record('S2', 'Client has no direct route to the test internet',
    !directResult.stdout.includes('cvpn-origin-ok'),
    `exit ${directResult.code}, output ${JSON.stringify(directResult.stdout.slice(0, 80))}`);

  // --- scenario 3: ingress reachability ------------------------------------
  const check = await apiRequest('POST', `/api/v1/gateways/${gateway.id}/check`);
  record('S3', 'Control plane measures the gateway as reachable',
    check.ingress.status === 'online', check.ingress.detail);

  // --- scenario 4: egress availability -------------------------------------
  const healthyRoute = await waitFor('egress A to report healthy', async () => {
    const route = await routeFor(gateway.id);
    return route.egress?.id === egressA.id && route.egress.pairStatus === 'online' ? route : false;
  });
  record('S4', 'Gateway measures its egress path end to end',
    healthyRoute.state === 'healthy',
    `state=${healthyRoute.state}, egress=${healthyRoute.egress.name}, ${healthyRoute.egress.pairDetail || ''}`);

  // --- scenario 6: primary egress failure ----------------------------------
  log('\n· stopping egress A (primary)');
  await compose(['stop', 'egress-a']);
  const switched = await waitFor('the control plane to route around egress A', async () => {
    const route = await routeFor(gateway.id);
    return route.egress?.id === egressB.id ? route : false;
  });
  record('S6', 'Primary egress failure is detected and routed around', true,
    `now ${switched.egress.name}; reason: ${switched.selectionReason}`);

  // --- scenario 7: traffic recovers on the backup --------------------------
  const recovered = await waitFor('client traffic to recover on the backup path', async () => {
    const r = await throughTunnel();
    return r.stdout.includes('cvpn-origin-ok') ? r : false;
  }, { timeoutMs: 60000 });
  const egressBLog = await compose(['logs', '--tail', '20', 'egress-b']);
  record('S7', 'Client traffic recovers over the backup egress',
    recovered.stdout.includes('cvpn-origin-ok') && /socks-in/.test(egressBLog.stdout),
    'egress-b carried the request');

  // --- scenario 5: no usable egress at all ---------------------------------
  log('\n· stopping egress B as well (no usable path remains)');
  await compose(['stop', 'egress-b']);
  const failClosed = await waitFor('the control plane to report no usable egress', async () => {
    const route = await routeFor(gateway.id);
    return route.state === 'no-egress' || route.state === 'egress-down' ? route : false;
  });
  const ingressStillUp = await apiRequest('POST', `/api/v1/gateways/${gateway.id}/check`);
  record('S5a', 'Gateway stays reachable while its egress is dead',
    ingressStillUp.ingress.status === 'online',
    `route state ${failClosed.state}, ingress ${ingressStillUp.ingress.status} — two different failures`);

  const blocked = await waitFor('client traffic to stop once no egress is usable', async () => {
    const r = await throughTunnel();
    return r.stdout.includes('cvpn-origin-ok') ? false : r;
  }, { timeoutMs: 60000 });
  record('S5b', 'With no usable egress the gateway fails closed', true,
    `client request no longer completes (exit ${blocked.code})`);

  // --- recovery -------------------------------------------------------------
  log('\n· restarting egress A');
  await compose(['start', 'egress-a']);
  const restored = await waitFor('traffic to return to the primary path', async () => {
    const route = await routeFor(gateway.id);
    if (route.egress?.id !== egressA.id) return false;
    const r = await throughTunnel();
    return r.stdout.includes('cvpn-origin-ok') ? route : false;
  }, { timeoutMs: 90000 });
  record('S8', 'Primary egress recovery restores the original route', true,
    `active egress ${restored.egress.name}, state ${restored.state}`);

  // --- usage accounting -----------------------------------------------------
  const usage = await waitFor('usage to be accounted from Xray counters', async () => {
    const detail = await apiRequest('GET', `/api/v1/subscribers/${subscriber.id}`);
    return detail.usedBytes > 0 ? detail : false;
  }, { timeoutMs: 60000 });
  record('S9', 'Traffic is accounted against the subscriber quota', true,
    `${usage.usedBytes} bytes recorded from gateway reports`);

  const passed = results.filter((r) => r.ok).length;
  log(`\n${passed}/${results.length} scenarios passed\n`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`\nlab failed: ${err.message}\n`);
  process.exitCode = 1;
});
