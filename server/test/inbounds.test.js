import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedGateway, seedEgress } from './helpers.js';
import { createSubscriber } from '../src/domain/subscribers.js';
import { config } from '../src/config.js';
import {
  derivedKey, inboundConfig, inboundProfile, requestedProtocols, inCohort, SS_METHOD,
} from '../src/domain/inbounds.js';
import { gatewayServerConfig, structuralConfig } from '../src/domain/xray.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gateway = (overrides = {}) => ({
  id: 'gw_one', name: 'Edge A', region: 'de', host: '203.0.113.4', port: 443,
  transport: 'ws', tls_mode: 'none', ws_path: '/ws', ws_host: null, sni: null,
  listen_address: '0.0.0.0', listen_port: null, block_private_ranges: 1,
  ...overrides,
});

const clients = [
  { credentialId: 'cr_one', uuid: '11111111-2222-3333-4444-555555555555' },
  { credentialId: 'cr_two', uuid: '99999999-8888-7777-6666-555555555555' },
];

const ss = (overrides = {}) => ({
  id: 'ib_ss', gateway_id: 'gw_one', kind: 'shadowsocks', port: 8388,
  listen_address: null, enabled: 1, method: SS_METHOD,
  server_key: 'c2VydmVyLWtleS10aGlydHktdHdvLWJ5dGVzLWxvbmch', status: 'online',
  ...overrides,
});

const trojan = (overrides = {}) => ({
  id: 'ib_tj', gateway_id: 'gw_one', kind: 'trojan', port: 8443,
  listen_address: null, enabled: 1, status: 'online', ...overrides,
});

const realityInbound = (overrides = {}) => ({
  id: 'ib_re', gateway_id: 'gw_one', kind: 'reality', port: 8444,
  listen_address: null, enabled: 1, status: 'online',
  reality_dest: 'www.microsoft.com:443',
  reality_server_names: 'www.microsoft.com',
  reality_short_ids: 'a1b2c3d4',
  reality_private_key: 'APN6heJyxD3VwSIRcoy0G1jf39S5mXDh_J9DjygZb1U',
  reality_public_key: 'uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA',
  reality_fingerprint: 'chrome',
  ...overrides,
});

test('derived subscriber keys', async (t) => {
  await t.test('are deterministic, so the gateway and the profile agree', () => {
    const a = derivedKey(clients[0].uuid, 'ib_ss');
    const b = derivedKey(clients[0].uuid, 'ib_ss');
    assert.deepEqual(a, b);
    assert.equal(a.length, 32);
  });

  await t.test('differ per inbound, so one leaked profile does not open the others', () => {
    assert.notDeepEqual(derivedKey(clients[0].uuid, 'ib_ss'), derivedKey(clients[0].uuid, 'ib_re'));
  });

  await t.test('differ per subscriber, which is what the counters are for', () => {
    assert.notDeepEqual(derivedKey(clients[0].uuid, 'ib_ss'), derivedKey(clients[1].uuid, 'ib_ss'));
  });

  await t.test('die with the credential they came from', () => {
    // Rotation has to rotate everything. A key that outlives the credential is
    // a subscriber who was cut off and is still connected.
    const rotated = '00000000-1111-2222-3333-444444444444';
    assert.notDeepEqual(derivedKey(clients[0].uuid, 'ib_ss'), derivedKey(rotated, 'ib_ss'));
  });
});

test('inbound configuration', async (t) => {
  await t.test('shadowsocks carries every entitled client, keyed by credential', () => {
    const built = inboundConfig(gateway(), ss(), clients);
    assert.equal(built.protocol, 'shadowsocks');
    assert.equal(built.port, 8388);
    assert.equal(built.settings.method, SS_METHOD);
    assert.equal(built.settings.clients.length, 2);
    // The email is the credential id on purpose: usage accounting reads Xray's
    // per-user counters by it, so a subscriber on this door spends the same
    // quota as one on the gateway's own. Without it, a second door is a way to
    // use the service for nothing.
    assert.deepEqual(built.settings.clients.map((c) => c.email), ['cr_one', 'cr_two']);
    assert.notEqual(built.settings.clients[0].password, built.settings.clients[1].password);
  });

  await t.test('trojan is refused on a gateway that holds no certificate', () => {
    assert.throws(() => inboundConfig(gateway(), trojan(), clients), /certificate material/);
  });

  await t.test('trojan uses the certificate the gateway already has', () => {
    const withCert = gateway({
      tls_mode: 'xray', sni: 'edge.example.net',
      tls_cert_path: '/etc/ssl/edge.pem', tls_key_path: '/etc/ssl/edge.key',
    });
    const built = inboundConfig(withCert, trojan(), clients);
    assert.equal(built.streamSettings.security, 'tls');
    assert.equal(built.streamSettings.tlsSettings.certificates[0].certificateFile, '/etc/ssl/edge.pem');
    assert.deepEqual(built.settings.clients.map((c) => c.email), ['cr_one', 'cr_two']);
  });

  await t.test('a second REALITY door borrows its own site and its own key', () => {
    const built = inboundConfig(gateway(), realityInbound(), clients);
    assert.equal(built.streamSettings.security, 'reality');
    assert.equal(built.streamSettings.realitySettings.dest, 'www.microsoft.com:443');
    assert.equal(built.streamSettings.realitySettings.privateKey, realityInbound().reality_private_key);
    assert.equal(built.settings.clients[0].flow, 'xtls-rprx-vision');
  });

  await t.test('an unknown kind is refused rather than emitted half-formed', () => {
    assert.throws(() => inboundConfig(gateway(), ss({ kind: 'wireguard' }), clients), /unsupported/);
  });
});

test('the gateway configuration the agent deploys', async (t) => {
  const egresses = [{ id: 'eg_one', kind: 'direct', enabled: 1, priority: 10 }];

  await t.test('is byte for byte the old one when there are no extra inbounds', () => {
    const before = gatewayServerConfig(gateway(), clients, egresses, 'eg_one');
    const after = gatewayServerConfig(gateway(), clients, egresses, 'eg_one', []);
    assert.deepEqual(before, after);
    assert.equal(before.inbounds.filter((i) => String(i.tag).startsWith('client-in')).length, 1);
  });

  await t.test('adds each door after the gateway\'s own', () => {
    const built = gatewayServerConfig(gateway(), clients, egresses, 'eg_one', [ss(), realityInbound()]);
    const tags = built.inbounds.map((i) => i.tag);
    assert.deepEqual(tags.slice(0, 3), ['client-in', 'client-in-ib_ss', 'client-in-ib_re']);
  });

  await t.test('fails closed on every door when no egress is usable', () => {
    // The rule that blackholes client traffic named one inbound tag when there
    // was only one. A door it does not name is a door that leaks out of the
    // gateway's own default route while the gateway is meant to be failing
    // closed — the exact hole the blackhole exists to close.
    const built = gatewayServerConfig(gateway(), clients, egresses, null, [ss(), realityInbound()]);
    const rule = built.routing.rules.find((r) => r.outboundTag === 'block' && r.inboundTag);
    assert.deepEqual(rule.inboundTag, ['client-in', 'client-in-ib_ss', 'client-in-ib_re']);
  });

  await t.test('keeps subscriber churn out of the structural hash', () => {
    // The agent applies a client-list change live and redeploys only when the
    // structure moves. Leaving clients on the extra inbounds here would have
    // turned every new subscriber into a fleet-wide redeploy.
    const one = structuralConfig(gatewayServerConfig(gateway(), clients, egresses, 'eg_one', [ss()]));
    const two = structuralConfig(gatewayServerConfig(gateway(), [clients[0]], egresses, 'eg_one', [ss()]));
    assert.deepEqual(one, two);
    assert.deepEqual(one.inbounds[1].settings.clients, []);
  });
});

test('client profiles for the extra doors', async (t) => {
  await t.test('shadowsocks is SIP002, and carries both halves of the key', () => {
    const uri = inboundProfile(gateway(), ss(), clients[0].uuid);
    assert.match(uri, /^ss:\/\/[A-Za-z0-9_-]+@203\.0\.113\.4:8388#/);
    const userinfo = Buffer.from(uri.slice(5).split('@')[0], 'base64url').toString('utf8');
    const [method, serverKey, userKey] = userinfo.split(':');
    assert.equal(method, SS_METHOD);
    assert.equal(serverKey, ss().server_key);
    assert.equal(userKey, derivedKey(clients[0].uuid, 'ib_ss').toString('base64'));
  });

  await t.test('trojan names the certificate the gateway serves', () => {
    const uri = inboundProfile(gateway({ sni: 'edge.example.net' }), trojan(), clients[0].uuid);
    assert.match(uri, /^trojan:\/\/[A-Za-z0-9_-]+@203\.0\.113\.4:8443\?/);
    assert.match(uri, /security=tls/);
    assert.match(uri, /sni=edge\.example\.net/);
  });

  await t.test('the second REALITY door is a vless profile on its own port', () => {
    const uri = inboundProfile(gateway(), realityInbound(), clients[0].uuid);
    assert.match(uri, /^vless:\/\/11111111-2222-3333-4444-555555555555@203\.0\.113\.4:8444\?/);
    assert.match(uri, /security=reality/);
    assert.match(uri, /pbk=uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA/);
    // The private half stays here. It is the one value that must never travel.
    assert.ok(!uri.includes(realityInbound().reality_private_key));
  });
});

test('who is told that the extra doors exist', async (t) => {
  await t.test('a client that asks for nothing is asking for what it has always had', () => {
    assert.deepEqual(requestedProtocols(undefined), ['vless']);
    assert.deepEqual(requestedProtocols(''), ['vless']);
  });

  await t.test('a client that asks gets what it asked for, and always vless', () => {
    assert.deepEqual(requestedProtocols('shadowsocks,reality'), ['vless', 'shadowsocks', 'reality']);
    // Dropping vless would be asking to be handed nothing at all on a gateway
    // with no extra inbounds configured.
    assert.deepEqual(requestedProtocols('shadowsocks'), ['vless', 'shadowsocks']);
    assert.deepEqual(requestedProtocols('nonsense'), ['vless']);
  });

  await t.test('the cohort is stable, and only ever grows', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `sub_${i}`);
    assert.ok(ids.every((id) => inCohort(id, 0) === false));
    assert.ok(ids.every((id) => inCohort(id, 100) === true));
    // Stable: the same subscriber gets the same answer every fetch. A
    // subscriber who is in and then out would measure a door, lose it, and
    // measure it again forever.
    assert.ok(ids.every((id) => inCohort(id, 50) === inCohort(id, 50)));
    // Monotonic: raising the dial never takes the feature away from somebody
    // who already had it, which is what makes a staged rollout staged.
    assert.ok(ids.every((id) => !inCohort(id, 10) || inCohort(id, 30)));
    const share = ids.filter((id) => inCohort(id, 25)).length / ids.length;
    assert.ok(share > 0.15 && share < 0.35, `25% cohort held ${Math.round(share * 100)}%`);
  });
});

test('the subscription endpoint', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();

  const gw = await seedGateway(ctx, token);
  const egress = await seedEgress(ctx, token);
  await ctx.request('POST', `/api/v1/gateways/${gw.id}/egresses`, {
    token, body: { egressId: egress.id, priority: 10 },
  });
  ctx.db.prepare("UPDATE gateways SET ingress_status='online', ingress_checked_at=? WHERE id=?")
    .run(Date.now(), gw.id);
  ctx.db.prepare("UPDATE gateway_egress SET status='online', checked_at=? WHERE gateway_id=?")
    .run(Date.now(), gw.id);

  const original = { ...config.adaptiveInbounds };
  t.after(() => Object.assign(config.adaptiveInbounds, original));
  Object.assign(config.adaptiveInbounds, { enabled: true, rolloutPercent: 100 });

  const created = await ctx.request('POST', '/api/v1/subscribers', {
    token, body: { name: 'Adaptive', quotaGb: 5, days: 30 },
  });
  const subToken = created.body.data.subscriptionToken;

  const added = await ctx.request('POST', `/api/v1/gateways/${gw.id}/inbounds`, {
    token, body: { kind: 'shadowsocks', port: 8388 },
  });
  assert.equal(added.status, 201);
  const inboundId = added.body.data.id;
  ctx.db.prepare("UPDATE gateway_inbounds SET status='online' WHERE id=?").run(inboundId);

  await t.test('an old client is handed exactly what it was handed before', async () => {
    // The app already on phones asks for no protocols and cannot read an ss://
    // line. Serving it one would be a client that connects to nothing.
    const res = await ctx.request('GET', `/sub/${subToken}?format=json`);
    assert.equal(res.body.data.profiles.length, 1);
    assert.equal(res.body.data.profiles[0].protocol, 'vless');

    const plain = await ctx.request('GET', `/sub/${subToken}`);
    const lines = Buffer.from(plain.text, 'base64').toString('utf8').split('\n');
    // Line by line, and by prefix: "vless://" contains "ss://", which is a
    // substring check that passes while the fleet is on fire.
    assert.ok(
      lines.every((line) => line.startsWith('vless://')),
      `an old client was handed a protocol it cannot read: ${lines.join(' ')}`,
    );
  });

  await t.test('a client that asks is told about the other door', async () => {
    const res = await ctx.request('GET', `/sub/${subToken}?format=json&protocols=shadowsocks`);
    const kinds = res.body.data.profiles.map((p) => p.protocol);
    assert.deepEqual(kinds, ['vless', 'shadowsocks']);
    // The gateway's own inbound stays first: a client reading the list in
    // order still tries the connection it has always made.
    assert.match(res.body.data.profiles[1].uri, /^ss:\/\//);
    assert.equal(res.body.data.profiles[1].inboundId, inboundId);
  });

  await t.test('asking for a protocol no inbound serves changes nothing', async () => {
    const res = await ctx.request('GET', `/sub/${subToken}?format=json&protocols=trojan`);
    assert.deepEqual(res.body.data.profiles.map((p) => p.protocol), ['vless']);
  });

  await t.test('an inbound measured offline stops being advertised', async () => {
    ctx.db.prepare("UPDATE gateway_inbounds SET status='offline' WHERE id=?").run(inboundId);
    const res = await ctx.request('GET', `/sub/${subToken}?format=json&protocols=shadowsocks`);
    assert.deepEqual(res.body.data.profiles.map((p) => p.protocol), ['vless']);
    ctx.db.prepare("UPDATE gateway_inbounds SET status='online' WHERE id=?").run(inboundId);
  });

  await t.test('a disabled inbound is neither deployed nor advertised', async () => {
    await ctx.request('PATCH', `/api/v1/gateways/${gw.id}/inbounds/${inboundId}`, {
      token, body: { enabled: false },
    });
    const res = await ctx.request('GET', `/sub/${subToken}?format=json&protocols=shadowsocks`);
    assert.deepEqual(res.body.data.profiles.map((p) => p.protocol), ['vless']);

    const built = await ctx.request('GET', `/api/v1/gateways/${gw.id}/xray-config`, { token });
    assert.ok(!built.body.data.config.inbounds.some((i) => i.tag === `client-in-${inboundId}`));

    await ctx.request('PATCH', `/api/v1/gateways/${gw.id}/inbounds/${inboundId}`, {
      token, body: { enabled: true },
    });
  });

  await t.test('nobody is told about anything while the flag is off', async () => {
    // The rollback. Rows stay in the table, the gateway keeps its own door, and
    // the fleet generates what it generated before the feature existed.
    config.adaptiveInbounds.enabled = false;
    const res = await ctx.request('GET', `/sub/${subToken}?format=json&protocols=shadowsocks`);
    assert.deepEqual(res.body.data.profiles.map((p) => p.protocol), ['vless']);

    const built = await ctx.request('GET', `/api/v1/gateways/${gw.id}/xray-config`, { token });
    assert.ok(!built.body.data.config.inbounds.some((i) => String(i.tag).startsWith('client-in-')));
    config.adaptiveInbounds.enabled = true;
  });

  await t.test('a subscriber outside the cohort is not in the rollout', async () => {
    config.adaptiveInbounds.rolloutPercent = 0;
    const res = await ctx.request('GET', `/sub/${subToken}?format=json&protocols=shadowsocks`);
    assert.deepEqual(res.body.data.profiles.map((p) => p.protocol), ['vless']);
    config.adaptiveInbounds.rolloutPercent = 100;
  });

  await t.test('the deployed configuration carries the door', async () => {
    const built = await ctx.request('GET', `/api/v1/gateways/${gw.id}/xray-config`, { token });
    const door = built.body.data.config.inbounds.find((i) => i.tag === `client-in-${inboundId}`);
    assert.equal(door.protocol, 'shadowsocks');
    assert.equal(door.port, 8388);
  });
});

/**
 * The only check that can say the gateway will actually start.
 *
 * Everything else here asserts the shape of an object this repository made up.
 * Xray decides whether it is a configuration, and it has opinions nothing in a
 * schema knows about — Shadowsocks 2022 in multi-user mode refuses to start if
 * a user carries a `method`, which is how that bug was found rather than on a
 * gateway after a deploy.
 *
 * Skipped where there is no binary. `lab/fetch-xray.sh` puts one in lab/bin.
 */
test('the real Xray accepts what is generated', async (t) => {
  const binary = process.env.XRAY_BIN
    || [join(process.cwd(), 'lab/bin/xray'), join(process.cwd(), '../lab/bin/xray')]
      .find((candidate) => existsSync(candidate));
  if (!binary) {
    t.skip('no xray binary: set XRAY_BIN or run lab/fetch-xray.sh');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'cvpn-inbounds-'));
  // Trojan is TLS, and TLS needs a certificate that exists on disk.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'tls.pem'),
    '-days', '1', '-subj', '/CN=edge.example.net',
  ], { stdio: 'ignore' });

  const withCert = gateway({
    tls_mode: 'xray', sni: 'edge.example.net',
    tls_cert_path: join(dir, 'tls.pem'), tls_key_path: join(dir, 'tls.key'),
  });
  const built = gatewayServerConfig(
    withCert,
    clients,
    [{ id: 'eg_one', kind: 'direct', enabled: 1, priority: 10, bind_address: null }],
    'eg_one',
    [ss(), trojan(), realityInbound()],
  );
  const path = join(dir, 'gateway.json');
  writeFileSync(path, JSON.stringify(built));
  const output = execFileSync(binary, ['-test', '-config', path], { encoding: 'utf8' });
  assert.match(output, /Configuration OK/);
});

test('the storefront hands over the same lines the subscription does', async (t) => {
  // Somebody using NPV Tunnel or v2rayNG copies their config from this screen.
  // Serving fewer doors here than /sub serves would give the people on other
  // apps less than the app's own users get, on the day it matters most.
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();

  const gw = await seedGateway(ctx, token);
  const egress = await seedEgress(ctx, token);
  await ctx.request('POST', `/api/v1/gateways/${gw.id}/egresses`, {
    token, body: { egressId: egress.id, priority: 10 },
  });
  ctx.db.prepare("UPDATE gateways SET ingress_status='online', ingress_checked_at=? WHERE id=?")
    .run(Date.now(), gw.id);
  ctx.db.prepare("UPDATE gateway_egress SET status='online', checked_at=? WHERE gateway_id=?")
    .run(Date.now(), gw.id);

  const original = { ...config.adaptiveInbounds };
  t.after(() => Object.assign(config.adaptiveInbounds, original));
  Object.assign(config.adaptiveInbounds, { enabled: true, rolloutPercent: 100 });

  const added = await ctx.request('POST', `/api/v1/gateways/${gw.id}/inbounds`, {
    token, body: { kind: 'shadowsocks', port: 8388 },
  });
  ctx.db.prepare("UPDATE gateway_inbounds SET status='online' WHERE id=?").run(added.body.data.id);

  const register = await ctx.request('POST', '/api/v1/shop/register', {
    body: { email: 'configs@example.com', password: 'a-long-enough-password' },
  });
  const customerToken = register.body.data.token;
  const customerId = ctx.db.prepare('SELECT id FROM customers WHERE email = ?').get('configs@example.com').id;
  createSubscriber(ctx.db, {
    name: 'configs',
    quotaBytes: 10 * 1024 ** 3,
    expiresAt: Date.now() + 30 * 86400000,
    customerId,
  });

  const res = await ctx.request('GET', '/api/v1/shop/me', { token: customerToken });
  assert.equal(res.status, 200);
  const profiles = res.body.data.subscription.profiles;

  await t.test('every door is written out, not only counted', () => {
    assert.deepEqual(profiles.map((p) => p.protocol), ['vless', 'shadowsocks']);
    assert.equal(res.body.data.subscription.profileCount, 2);
  });

  await t.test('each line carries what a person needs to tell them apart', () => {
    for (const profile of profiles) {
      assert.ok(profile.uri, 'a config with no line is nothing to copy');
      assert.ok(profile.label, 'a config with no label cannot be chosen between');
      assert.ok(profile.protocol);
    }
    assert.match(profiles[1].uri, /^ss:\/\//);
    assert.match(profiles[1].label, / · shadowsocks$/);
  });

  await t.test('the flag takes them away here too', async () => {
    config.adaptiveInbounds.enabled = false;
    const off = await ctx.request('GET', '/api/v1/shop/me', { token: customerToken });
    assert.deepEqual(off.body.data.subscription.profiles.map((p) => p.protocol), ['vless']);
    config.adaptiveInbounds.enabled = true;
  });
});

test('operating the extra doors', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();
  const gw = await seedGateway(ctx, token);

  await t.test('refuses a port the gateway already listens on', async () => {
    const res = await ctx.request('POST', `/api/v1/gateways/${gw.id}/inbounds`, {
      token, body: { kind: 'shadowsocks', port: 18443 },
    });
    assert.equal(res.status, 400);
  });

  await t.test('refuses two inbounds on one port', async () => {
    const first = await ctx.request('POST', `/api/v1/gateways/${gw.id}/inbounds`, {
      token, body: { kind: 'shadowsocks', port: 9000 },
    });
    assert.equal(first.status, 201);
    const second = await ctx.request('POST', `/api/v1/gateways/${gw.id}/inbounds`, {
      token, body: { kind: 'reality', port: 9000 },
    });
    assert.equal(second.status, 400);
  });

  await t.test('refuses trojan where it cannot work, and says why', async () => {
    const res = await ctx.request('POST', `/api/v1/gateways/${gw.id}/inbounds`, {
      token, body: { kind: 'trojan', port: 9443 },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /certificate material/);
    // And leaves nothing behind: a row for an inbound that cannot be rendered
    // would be deployed as a gateway that refuses to start.
    const rows = ctx.db.prepare('SELECT * FROM gateway_inbounds WHERE gateway_id=? AND port=9443').all(gw.id);
    assert.equal(rows.length, 0);
  });

  await t.test('issues REALITY material rather than asking an operator for it', async () => {
    const res = await ctx.request('POST', `/api/v1/gateways/${gw.id}/inbounds`, {
      token, body: { kind: 'reality', port: 9444, realityDest: 'www.cloudflare.com:443' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.realityDest, 'www.cloudflare.com:443');
    assert.ok(res.body.data.realityPublicKey);
    // The private half is not in an API response, ever.
    assert.ok(!JSON.stringify(res.body).includes(
      ctx.db.prepare('SELECT reality_private_key AS k FROM gateway_inbounds WHERE id=?').get(res.body.data.id).k,
    ));
  });

  await t.test('every change makes the agent fetch a new configuration', async () => {
    const before = ctx.db.prepare('SELECT config_version AS v FROM gateways WHERE id=?').get(gw.id).v;
    const created = await ctx.request('POST', `/api/v1/gateways/${gw.id}/inbounds`, {
      token, body: { kind: 'shadowsocks', port: 9500 },
    });
    const afterCreate = ctx.db.prepare('SELECT config_version AS v FROM gateways WHERE id=?').get(gw.id).v;
    assert.ok(afterCreate > before, 'adding a door did not bump the config version');

    await ctx.request('DELETE', `/api/v1/gateways/${gw.id}/inbounds/${created.body.data.id}`, { token });
    const afterDelete = ctx.db.prepare('SELECT config_version AS v FROM gateways WHERE id=?').get(gw.id).v;
    assert.ok(afterDelete > afterCreate, 'removing a door did not bump the config version');
  });

  await t.test('another gateway\'s inbound is not this gateway\'s to touch', async () => {
    const other = await seedGateway(ctx, token, { name: 'Edge B', port: 18444 });
    const mine = await ctx.request('POST', `/api/v1/gateways/${gw.id}/inbounds`, {
      token, body: { kind: 'shadowsocks', port: 9600 },
    });
    const res = await ctx.request('PATCH', `/api/v1/gateways/${other.id}/inbounds/${mine.body.data.id}`, {
      token, body: { enabled: false },
    });
    assert.equal(res.status, 404);
  });
});

test('the gateway agent is served the additional inbounds', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();
  const gw = await seedGateway(ctx, token);

  const original = { ...config.adaptiveInbounds };
  t.after(() => Object.assign(config.adaptiveInbounds, original));
  Object.assign(config.adaptiveInbounds, { enabled: true, rolloutPercent: 100 });

  const added = await ctx.request('POST', `/api/v1/gateways/${gw.id}/inbounds`, {
    token, body: { kind: 'shadowsocks', port: 8388 },
  });
  assert.equal(added.status, 201);

  // The agent's copy is the only one that is ever deployed. A door the control
  // plane generates, probes and advertises to subscribers but leaves out of
  // this response is a door no gateway ever opens, and nothing anywhere says so.
  const res = await ctx.agentRequest('GET', '/api/v1/agent/config', {
    key: gw.agentKey, gatewayId: gw.id,
  });
  assert.equal(res.status, 200);
  const ports = res.body.data.config.inbounds.map((i) => i.port);
  assert.ok(
    ports.includes(8388),
    `the agent was not served the extra inbound: ${ports.join(',')}`,
  );
});
