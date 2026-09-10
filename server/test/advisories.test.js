import test from 'node:test';
import assert from 'node:assert/strict';
import { fleetAdvisories } from '../src/domain/advisories.js';
import { startTestServer } from './helpers.js';

/**
 * These are the checks that stay quiet while everything is green. Each one
 * describes a fleet that works perfectly today and is arranged so that one
 * decision somewhere else takes all of it.
 */
test('what no single gateway can notice', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const now = Date.now();

  const add = (id, fields = {}) => {
    const row = {
      id,
      name: id,
      region: 'de',
      host: `${id}.example.net`,
      port: 443,
      transport: 'ws',
      tls_mode: 'none',
      reality_dest: null,
      reality_public_key: null,
      enabled: 1,
      ...fields,
    };
    ctx.db.prepare(`INSERT INTO gateways
      (id,name,region,host,port,transport,tls_mode,reality_dest,reality_public_key,enabled,created_at,updated_at)
      VALUES (@id,@name,@region,@host,@port,@transport,@tls_mode,@reality_dest,@reality_public_key,@enabled,${now},${now})`)
      .run(row);
    return row;
  };
  const clear = () => ctx.db.prepare('DELETE FROM gateways').run();
  const codes = () => fleetAdvisories(ctx.db).map((a) => a.code);

  await t.test('an empty fleet has nothing to say about itself', () => {
    assert.deepEqual(fleetAdvisories(ctx.db), []);
  });

  await t.test('one gateway is not a single point of failure worth reporting', () => {
    // It plainly is one. Saying so on a fleet of one is noise, and an advisory
    // that is always on is one nobody reads.
    clear();
    add('gw_only');
    assert.deepEqual(codes(), []);
  });

  await t.test('a well-spread fleet stays quiet', () => {
    clear();
    add('gw_de', { region: 'de', transport: 'reality', reality_dest: 'www.microsoft.com:443', reality_public_key: 'AAA' });
    add('gw_nl', { region: 'nl', transport: 'reality', reality_dest: 'www.cloudflare.com:443', reality_public_key: 'BBB' });
    add('gw_fi', { region: 'fi', transport: 'reality', reality_dest: 'www.apple.com:443', reality_public_key: 'CCC' });
    assert.deepEqual(codes(), []);
  });

  await t.test('a key pair on two gateways is critical, because one seizure takes both', () => {
    clear();
    add('gw_a', { region: 'de', transport: 'reality', reality_dest: 'a.example:443', reality_public_key: 'SAME' });
    add('gw_b', { region: 'nl', transport: 'reality', reality_dest: 'b.example:443', reality_public_key: 'SAME' });
    const found = fleetAdvisories(ctx.db);
    assert.equal(found[0].code, 'reality-key-reused');
    assert.equal(found[0].severity, 'critical');
    assert.deepEqual(found[0].gatewayIds.sort(), ['gw_a', 'gw_b']);
  });

  await t.test('one borrowed site across the fleet is a fingerprint of its own', () => {
    clear();
    add('gw_a', { region: 'de', transport: 'reality', reality_dest: 'www.microsoft.com:443', reality_public_key: 'AAA' });
    add('gw_b', { region: 'nl', transport: 'reality', reality_dest: 'www.microsoft.com:443', reality_public_key: 'BBB' });
    const found = fleetAdvisories(ctx.db);
    assert.ok(found.some((a) => a.code === 'reality-dest-shared'));
    assert.match(found.find((a) => a.code === 'reality-dest-shared').message, /www\.microsoft\.com:443/);
  });

  await t.test('two WebSocket gateways with no dest at all are not "sharing" one', () => {
    // Null is not a value two things have in common.
    clear();
    add('gw_a', { region: 'de' });
    add('gw_b', { region: 'nl' });
    assert.ok(!codes().includes('reality-dest-shared'));
    assert.ok(!codes().includes('reality-key-reused'));
  });

  await t.test('a fleet in one country is one decision from nothing', () => {
    clear();
    add('gw_a', { region: 'de' });
    add('gw_b', { region: 'de' });
    const found = fleetAdvisories(ctx.db);
    assert.ok(found.some((a) => a.code === 'single-region'));
    assert.match(found.find((a) => a.code === 'single-region').message, /de/);
  });

  await t.test('two gateways on one address are one address away from both', () => {
    clear();
    add('gw_a', { region: 'de', host: 'edge.example.net', port: 443 });
    add('gw_b', { region: 'nl', host: 'edge.example.net', port: 8443 });
    const found = fleetAdvisories(ctx.db);
    assert.ok(found.some((a) => a.code === 'shared-address'));
  });

  await t.test('a disabled gateway is not part of the arrangement', () => {
    clear();
    add('gw_a', { region: 'de', transport: 'reality', reality_dest: 'same.example:443', reality_public_key: 'AAA' });
    add('gw_off', { region: 'de', transport: 'reality', reality_dest: 'same.example:443', reality_public_key: 'BBB', enabled: 0 });
    assert.ok(!codes().includes('reality-dest-shared'));
    assert.ok(!codes().includes('single-region'), 'one enabled gateway is not a region problem');
  });

  await t.test('the worst thing is said first', () => {
    clear();
    add('gw_a', { region: 'de', host: 'one.example.net', transport: 'reality', reality_dest: 'x.example:443', reality_public_key: 'SAME' });
    add('gw_b', { region: 'de', host: 'one.example.net', transport: 'reality', reality_dest: 'x.example:443', reality_public_key: 'SAME' });
    const found = fleetAdvisories(ctx.db);
    assert.equal(found[0].severity, 'critical');
    assert.ok(found.length >= 3, 'this fleet has several things wrong with it');
    assert.deepEqual(found.map((a) => a.severity), [...found.map((a) => a.severity)].sort());
  });

  await t.test('the overview carries them, so they are on the first screen', async () => {
    const token = await ctx.login();
    const res = await ctx.request('GET', '/api/v1/overview', { token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data.advisories));
    assert.ok(res.body.data.advisories.some((a) => a.code === 'reality-key-reused'));
  });
});
