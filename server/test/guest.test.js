import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedGateway, seedEgress } from './helpers.js';

async function usableGateway(ctx, token) {
  const gateway = await seedGateway(ctx, token);
  const egress = await seedEgress(ctx, token);
  await ctx.request('POST', `/api/v1/gateways/${gateway.id}/egresses`, {
    token, body: { egressId: egress.id, priority: 10 },
  });
  ctx.db.prepare("UPDATE gateways SET ingress_status='online', ingress_checked_at=? WHERE id=?")
    .run(Date.now(), gateway.id);
  ctx.db.prepare("UPDATE gateway_egress SET status='online', checked_at=? WHERE gateway_id=?")
    .run(Date.now(), gateway.id);
  return gateway;
}

const DEVICE = 'device-aaaaaaaaaaaaaaaaaaaa';
const OTHER = 'device-bbbbbbbbbbbbbbbbbbbb';

test('guest: the switch works before the account does', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const adminToken = await ctx.login();
  await usableGateway(ctx, adminToken);

  const { config } = await import('../src/config.js');
  const original = { ...config.guest };
  Object.assign(config.guest, {
    enabled: true, sessionMinutes: 3, sessionsPerDevice: 2, sessionMb: 100, leasesPerDay: 50,
  });
  t.after(() => Object.assign(config.guest, original));

  const lease = (deviceId) => ctx.request('POST', '/api/v1/guest/session', { body: { deviceId } });

  await t.test('a device with no account is handed a config that works now', async () => {
    const res = await lease(DEVICE);
    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.ok(data.profiles.length > 0, 'something to connect with');
    assert.match(data.profiles[0].uri, /^vless:\/\//);
    assert.equal(data.sessionMinutes, 3);
    assert.equal(data.sessionsLeft, 1);
    // Short enough that nothing here is worth keeping.
    assert.ok(data.secondsLeft <= 180 && data.secondsLeft > 150, `secondsLeft was ${data.secondsLeft}`);
    assert.equal(data.subscriptionUrl, undefined, 'a guest is given no durable URL');
  });

  await t.test('and it really does stop: the gateway is told when, not just the app', async () => {
    const row = ctx.db.prepare("SELECT * FROM subscribers WHERE note LIKE 'guest%'").get();
    assert.ok(row.expires_at - Date.now() <= 3 * 60000);
    assert.equal(row.quota_bytes, 100 * 1024 * 1024);
    // The enforcement that matters is the credential leaving the gateway's
    // client list, so check the query the agent is actually served from.
    const { entitledCredentials } = await import('../src/domain/gateways.js');
    const mine = (now) => entitledCredentials(ctx.db, now).some((c) => c.subscriberId === row.id);
    assert.equal(mine(Date.now()), true, 'served while the session is live');
    assert.equal(mine(row.expires_at + 1), false, 'and gone the moment it is not');
  });

  await t.test('a second session reuses the row rather than leaving a trail of them', async () => {
    const before = ctx.db.prepare("SELECT COUNT(*) n FROM subscribers WHERE note LIKE 'guest%'").get().n;
    const res = await lease(DEVICE);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.sessionsLeft, 0);
    const after = ctx.db.prepare("SELECT COUNT(*) n FROM subscribers WHERE note LIKE 'guest%'").get().n;
    assert.equal(after, before, 'one subscription per device, however many sessions');
  });

  await t.test('past the count, it is refused and says what to do instead', async () => {
    const res = await lease(DEVICE);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.details.reason, 'spent');
    assert.match(res.body.error.message, /account/i);
  });

  await t.test('another device is unaffected by the first one running out', async () => {
    const res = await lease(OTHER);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.sessionsLeft, 1);
  });

  await t.test('standing says what is left without spending anything', async () => {
    const before = ctx.db.prepare('SELECT COUNT(*) n FROM guest_leases').get().n;
    const res = await ctx.request('GET', `/api/v1/guest/standing?deviceId=${OTHER}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.guest, {
      sessionMinutes: 3, sessionsPerDevice: 2, sessionsLeft: 1,
    });
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM guest_leases').get().n, before);
  });

  await t.test('the day has a ceiling that holds however many devices there are', async () => {
    // The per-device count is a speed bump; this is the limit that actually
    // bounds what the giveaway can cost, so it is the one worth a test.
    Object.assign(config.guest, { leasesPerDay: 1, sessionsPerDevice: 99 });
    const res = await lease('device-cccccccccccccccccccc');
    assert.equal(res.status, 429);
    assert.equal(res.body.error.details.reason, 'busy');
  });

  await t.test('switched off, nothing is handed out and standing says so', async () => {
    Object.assign(config.guest, { enabled: false });
    const res = await lease('device-dddddddddddddddddddd');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.details.reason, 'off');
    const standing = await ctx.request('GET', '/api/v1/guest/standing');
    assert.equal(standing.body.data.guest, null);
  });

  await t.test('a device identifier is never stored in a form a leak could reuse', async () => {
    const rows = ctx.db.prepare('SELECT id FROM guest_devices').all();
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.notEqual(row.id, DEVICE);
      assert.notEqual(row.id, OTHER);
      assert.match(row.id, /^[0-9a-f]{64}$/, 'stored as a hash');
    }
  });
});
