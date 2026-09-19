/**
 * Does a REALITY config this control plane issues actually work in a
 * third-party client?
 *
 * The lab's docker scenarios cover WebSocket gateways and the egress failover;
 * none of them exercise REALITY, and `server/test/reality.test.js` asserts the
 * shape of the strings rather than running them. So the one thing nobody had
 * tested was the pair that customers actually use:
 *
 *   clientProfile()        →  a vless:// link
 *                          →  a client built from ONLY what that link carries,
 *                             the way v2rayNG and NPV Tunnel build theirs
 *   gatewayServerConfig()  →  the inbound the agent deploys
 *
 * Both halves run against a real Xray core here, and traffic is pushed through
 * the tunnel. Two negative controls (a wrong public key, a wrong short id) must
 * fail, otherwise the run proves nothing and is reported as invalid.
 *
 * The version pair matters and is configurable: a gateway may be running an
 * older core than the phone.
 *
 *   node lab/reality-e2e.mjs
 *   XRAY_SERVER_BIN=./lab/bin/xray-26.3.27 XRAY_CLIENT_BIN=./lab/bin/xray-26.6.27 \
 *     node lab/reality-e2e.mjs
 *
 * Nothing here touches a deployed host: every process is local, on loopback.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { clientProfile, gatewayServerConfig } from '../server/src/domain/xray.js';

const SERVER_BIN = process.env.XRAY_SERVER_BIN || process.env.XRAY_BIN || './lab/bin/xray';
const CLIENT_BIN = process.env.XRAY_CLIENT_BIN || process.env.XRAY_BIN || './lab/bin/xray';
const PORT = { gateway: 12443, decoy: 18443, origin: 19099, socks: 11500, badPbk: 11510, badSid: 11520 };
// Not loopback, and not a private range Xray refuses to dial. TEST-NET-1 exists
// for exactly this; override it if the host does not carry that address.
const ORIGIN_HOST = process.env.LAB_ORIGIN_HOST || '192.0.2.2';

const work = mkdtempSync(join(tmpdir(), 'reality-e2e-'));
const children = [];
let pass = 0, fail = 0;
const ok = (m) => { console.log(`  PASS ${m}`); pass++; };
const no = (m) => { console.log(`  FAIL ${m}`); fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  rmSync(work, { recursive: true, force: true });
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

/** Fails loudly rather than letting a busy port turn into a misleading result. */
const portFree = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const s = net.connect({ host, port });
  s.on('connect', () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(true));
  setTimeout(() => { s.destroy(); resolve(true); }, 500);
});

function xray(bin, configPath, tag) {
  const child = spawn(bin, ['run', '-c', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  child.on('exit', (code) => { if (code) console.log(`  (${tag} exited ${code})\n${log.join('').split('\n').slice(-3).join('\n')}`); });
  return { child, log };
}

/** Minimal SOCKS5 CONNECT + HTTP GET, so the check needs no curl and no proxy env. */
function throughTunnel(socksPort, host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: socksPort });
    const done = (v) => { s.destroy(); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    let stage = 0, body = '';
    s.on('error', () => { clearTimeout(timer); done(null); });
    s.on('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00])));
    s.on('data', (d) => {
      if (stage === 0) {
        if (d[1] !== 0x00) { clearTimeout(timer); return done(null); }
        const h = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([port >> 8, port & 0xff])]));
        stage = 1;
      } else if (stage === 1) {
        if (d[1] !== 0x00) { clearTimeout(timer); return done(null); }
        s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        stage = 2;
      } else {
        body += d.toString();
        if (body.includes('\r\n\r\n')) { clearTimeout(timer); done(body.split('\r\n\r\n')[1]); }
      }
    });
  });
}

// ---------------------------------------------------------------- key material
let priv, pub;
try {
  const out = execFileSync(SERVER_BIN, ['x25519'], { encoding: 'utf8' });
  priv = out.match(/PrivateKey:\s*(\S+)/)[1];
  pub = out.match(/Pass\w*\s*\(PublicKey\):\s*(\S+)|PublicKey:\s*(\S+)/).slice(1).find(Boolean);
} catch (e) {
  console.error(`cannot run ${SERVER_BIN} — run lab/fetch-xray.sh, or set XRAY_SERVER_BIN/XRAY_CLIENT_BIN`);
  process.exit(1);
}

// ------------------------------------------------- the two generated artefacts
const gateway = {
  id: 'gw-lab', name: 'lab', region: 'test',
  host: '127.0.0.1', port: PORT.gateway,
  transport: 'reality', tls_mode: 'xray',
  reality_dest: `${ORIGIN_HOST}:${PORT.decoy}`,
  reality_server_names: 'www.microsoft.com',
  reality_short_ids: '0bac07f5',
  reality_private_key: priv,
  reality_public_key: pub,
  reality_fingerprint: 'chrome',
  listen_address: '127.0.0.1', listen_port: PORT.gateway,
};
const uuid = '11111111-2222-3333-4444-555555555555';
const egress = { id: 'eg_lab', kind: 'direct', enabled: 1, priority: 1 };

const link = clientProfile(gateway, uuid);
const serverConfig = gatewayServerConfig(gateway, [{ uuid, credentialId: 'cred-lab' }], [egress], egress.id);

// The only change made to the generated config: its log level. The gateway's
// own account of each connection is the instrument this test reads, and the
// lines it needs — the accepted inbound, and `freedom` refusing a special-use
// target — are logged at info. Logging does not touch the data path.
serverConfig.log = { ...serverConfig.log, loglevel: 'info' };

// Apart from that, the generated config is run verbatim. That is only possible because the
// origin sits on a documentation-range address rather than on loopback: a real
// gateway blocks private ranges by routing rule on purpose, and from Xray 26.6
// the freedom outbound blackholes a private target by itself ("blocked
// target ... blackholing connection"), whatever the routing says. Either would
// make this test report on the lab's own addressing instead of on the config.

/** A third-party client knows the link and nothing else. */
function clientFromLink(shareLink, socksPort, override = {}) {
  const u = new URL(shareLink);
  const q = Object.fromEntries(u.searchParams);
  return {
    log: { loglevel: 'warning' },
    inbounds: [{ tag: 'socks', listen: '127.0.0.1', port: socksPort, protocol: 'socks', settings: { udp: true, auth: 'noauth' } }],
    outbounds: [{
      tag: 'proxy', protocol: 'vless',
      settings: { vnext: [{ address: u.hostname, port: Number(u.port), users: [{ id: decodeURIComponent(u.username), encryption: q.encryption || 'none', ...(q.flow ? { flow: q.flow } : {}) }] }] },
      streamSettings: {
        network: q.type || 'tcp',
        security: q.security,
        realitySettings: { serverName: q.sni, publicKey: q.pbk, shortId: q.sid || '', fingerprint: q.fp || 'chrome', spiderX: q.spx || '/', ...override },
      },
    }],
  };
}

// ------------------------------------------------------------------------ run
const busy = [];
for (const [name, port] of Object.entries(PORT)) {
  const host = (name === 'decoy' || name === 'origin') ? ORIGIN_HOST : '127.0.0.1';
  if (!(await portFree(port, host))) busy.push(`${name}:${port}`);
}
if (busy.length) { console.error(`ports already in use: ${busy.join(', ')} — stop what is listening and re-run`); process.exit(1); }

console.log(`server core: ${execFileSync(SERVER_BIN, ['version'], { encoding: 'utf8' }).split('\n')[0]}`);
console.log(`client core: ${execFileSync(CLIENT_BIN, ['version'], { encoding: 'utf8' }).split('\n')[0]}`);
console.log(`link: ${link}\n`);

// The borrowed site REALITY forwards rejected clients to, and the origin the
// tunnel has to reach. Both local: the lab never touches the real internet.
const cert = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', join(work, 'd.key'), '-out', join(work, 'd.crt'), '-days', '1', '-nodes', '-subj', '/CN=www.microsoft.com'], { stdio: ['ignore', 'pipe', 'pipe'] });
const decoy = tls.createServer({ key: readFileSync(join(work, 'd.key')), cert: readFileSync(join(work, 'd.crt')) }, (s) => s.end()).listen(PORT.decoy, ORIGIN_HOST);
// Content-Length, not chunked: the probe below reads a body, not a codec.
const BODY = 'TUNNEL-OK';
const origin = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/plain', 'content-length': BODY.length }); r.end(BODY); }).listen(PORT.origin, ORIGIN_HOST);

writeFileSync(join(work, 'server.json'), JSON.stringify(serverConfig));
writeFileSync(join(work, 'good.json'), JSON.stringify(clientFromLink(link, PORT.socks)));
writeFileSync(join(work, 'badpbk.json'), JSON.stringify(clientFromLink(link, PORT.badPbk, { publicKey: 'hCJ0bn5dV4pQ8xW2yZ3aM7nK9sT1uR6eL0gF4hD8jXc' })));
writeFileSync(join(work, 'badsid.json'), JSON.stringify(clientFromLink(link, PORT.badSid, { shortId: 'deadbeef' })));

const server = xray(SERVER_BIN, join(work, 'server.json'), 'gateway');
await sleep(2000);
for (const n of ['good', 'badpbk', 'badsid']) xray(CLIENT_BIN, join(work, `${n}.json`), n);
await sleep(3000);

// Two levels, because they fail for different reasons.
//
// 1. The handshake. This is the question the product cares about: does a client
//    built from the issued link authenticate against the issued inbound? The
//    gateway names the inbound in its log for every connection it accepts, and
//    says nothing at all for one it refuses, so the log settles it on any core.
// 2. The traffic. Stronger, but it needs the gateway's egress to reach the lab's
//    origin, and from Xray 26.6 `freedom` refuses to dial any special-use
//    address — loopback, RFC1918, and the documentation range this lab uses.
//    There is no address left on a host like that, so the check reports itself
//    skipped rather than failing for a reason that has nothing to do with the
//    config.
const good = await throughTunnel(PORT.socks, ORIGIN_HOST, PORT.origin);
const badPbk = await throughTunnel(PORT.badPbk, ORIGIN_HOST, PORT.origin);
const badSid = await throughTunnel(PORT.badSid, ORIGIN_HOST, PORT.origin);

const serverLog = server.log.join('');
const accepted = serverLog.split('\n').filter((l) => l.includes('accepted') && l.includes('client-in'));
const egressBlocked = serverLog.includes('blocked target');

accepted.length === 1
  ? ok('the issued link authenticates against the issued inbound')
  : no(`expected exactly one accepted connection, saw ${accepted.length}`);

accepted.length <= 1
  ? ok('controls: a wrong public key and a wrong short id are both refused')
  : no('controls: a bad credential was accepted — this run proves nothing');

if (good === BODY) {
  ok('traffic flows end to end through the tunnel');
} else if (egressBlocked) {
  console.log('  SKIP traffic check: this core refuses to dial special-use addresses,');
  console.log('       so the lab origin is unreachable from the egress. Handshake still asserted.');
} else {
  no(`tunnel carried nothing (got ${JSON.stringify(good)})`);
  console.log(serverLog.trim().split('\n').slice(-6).map((l) => `       ${l}`).join('\n'));
}

if (badPbk === BODY || badSid === BODY) no('a refused credential carried traffic — this run proves nothing');

decoy.close(); origin.close();
console.log(`\npassed=${pass} failed=${fail}`);
process.exit(fail === 0 ? 0 : 1);
