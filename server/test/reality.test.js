import test from 'node:test';
import assert from 'node:assert/strict';
import { clientProfile, gatewayServerConfig, listenEndpoint, isReality } from '../src/domain/xray.js';
import {
  realityKeyPair, realityPublicKey, generateShortIds, parseDest, SHORT_ID_SHAPE,
} from '../src/lib/reality.js';
import { startTestServer } from './helpers.js';

const realityGateway = (overrides = {}) => ({
  id: 'gw_reality', name: 'Edge R', region: 'de', host: '203.0.113.9', port: 443,
  transport: 'reality', tls_mode: 'none', ws_path: '/ws', ws_host: null, sni: null,
  listen_address: '0.0.0.0', listen_port: null, block_private_ranges: 1,
  reality_dest: 'www.microsoft.com:443',
  reality_server_names: 'www.microsoft.com',
  reality_private_key: 'APN6heJyxD3VwSIRcoy0G1jf39S5mXDh_J9DjygZb1U',
  reality_public_key: 'uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA',
  reality_short_ids: 'a1b2c3d4,ffee',
  reality_fingerprint: 'chrome',
  ...overrides,
});
const client = { credentialId: 'cr_one', uuid: '11111111-2222-3333-4444-555555555555' };

test('REALITY key material', async (t) => {
  await t.test('derives the public key the way X25519 says to', () => {
    // RFC 7748 §6.1. If the encoding or the clamping is wrong, this is where it
    // shows — not on the gateway, three hours later, as a handshake that fails.
    const priv = Buffer.from(
      '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex',
    ).toString('base64url');
    assert.equal(
      Buffer.from(realityPublicKey(priv), 'base64url').toString('hex'),
      '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    );
  });

  await t.test('a generated pair belongs together, and no two are alike', () => {
    const a = realityKeyPair();
    const b = realityKeyPair();
    assert.equal(realityPublicKey(a.privateKey), a.publicKey);
    assert.notEqual(a.privateKey, b.privateKey);
    // Unpadded base64url of 32 bytes: what `xray x25519` prints, character for
    // character, because Xray parses exactly that.
    assert.match(a.publicKey, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(a.publicKey, 'base64url').length, 32);
  });

  await t.test('refuses a key that is not 32 bytes rather than deriving nonsense', () => {
    assert.throws(() => realityPublicKey(Buffer.alloc(16).toString('base64url')), /32 bytes/);
  });

  await t.test('short IDs are hex and the shape check agrees with them', () => {
    generateShortIds(4).forEach((id) => assert.match(id, SHORT_ID_SHAPE, id));
    assert.ok(!SHORT_ID_SHAPE.test(''), 'an empty short ID admits anyone who has the public key');
    assert.ok(!SHORT_ID_SHAPE.test('zz'));
    assert.ok(!SHORT_ID_SHAPE.test('abc'), 'a short ID is bytes, so an odd number of digits is wrong');
  });

  await t.test('a borrowed site needs a port, because Xray dials it', () => {
    assert.deepEqual(parseDest(' www.microsoft.com:443 '), {
      host: 'www.microsoft.com', port: 443, value: 'www.microsoft.com:443',
    });
    assert.equal(parseDest('www.microsoft.com'), null);
    assert.equal(parseDest('www.microsoft.com:0'), null);
    assert.equal(parseDest(''), null);
  });
});

test('REALITY client profiles', async (t) => {
  await t.test('says reality, over tcp, with vision', () => {
    const uri = clientProfile(realityGateway(), client.uuid);
    const params = new URL(uri).searchParams;
    assert.equal(params.get('security'), 'reality');
    assert.equal(params.get('type'), 'tcp');
    assert.equal(params.get('flow'), 'xtls-rprx-vision');
    assert.equal(params.get('pbk'), 'uNm292XHIOI0wHLfn5fiOOquk47pn6kjiYhqwermDjA');
    assert.equal(params.get('sid'), 'a1b2c3d4');
    assert.equal(params.get('sni'), 'www.microsoft.com');
    assert.equal(params.get('fp'), 'chrome');
  });

  await t.test('never carries the private key', () => {
    const uri = clientProfile(realityGateway(), client.uuid);
    assert.ok(!uri.includes('APN6heJyxD3VwSIRcoy0G1jf39S5mXDh_J9DjygZb1U'));
  });

  await t.test('claims a name the borrowed site serves, not the gateway address', () => {
    const uri = clientProfile(realityGateway(), client.uuid);
    // The SNI is somebody else's domain on purpose; the socket still goes to
    // the gateway's own address.
    assert.equal(new URL(uri).hostname, '203.0.113.9');
    assert.notEqual(new URL(uri).searchParams.get('sni'), '203.0.113.9');
  });

  await t.test('leaves WebSocket gateways exactly as they were', () => {
    const uri = clientProfile({ ...realityGateway(), transport: 'ws', tls_mode: 'reverse-proxy' }, client.uuid);
    assert.match(uri, /security=tls/);
    assert.match(uri, /type=ws/);
    assert.ok(!uri.includes('pbk='));
  });
});

test('REALITY gateway configuration', async (t) => {
  const config = gatewayServerConfig(realityGateway(), [client], [], null);
  const inbound = config.inbounds.find((i) => i.tag === 'client-in');

  await t.test('the inbound borrows a handshake instead of serving a certificate', () => {
    assert.equal(inbound.streamSettings.network, 'tcp');
    assert.equal(inbound.streamSettings.security, 'reality');
    assert.equal(inbound.streamSettings.realitySettings.dest, 'www.microsoft.com:443');
    assert.deepEqual(inbound.streamSettings.realitySettings.serverNames, ['www.microsoft.com']);
    assert.deepEqual(inbound.streamSettings.realitySettings.shortIds, ['a1b2c3d4', 'ffee']);
    assert.equal(inbound.streamSettings.realitySettings.privateKey, 'APN6heJyxD3VwSIRcoy0G1jf39S5mXDh_J9DjygZb1U');
    assert.equal(inbound.streamSettings.wsSettings, undefined);
    assert.equal(inbound.streamSettings.tlsSettings, undefined);
  });

  await t.test('clients carry the flow, which is where Vision is switched on', () => {
    assert.equal(inbound.settings.clients[0].flow, 'xtls-rprx-vision');
  });

  await t.test('a WebSocket inbound still has no flow on its clients', () => {
    // Xray refuses to start with a flow set on a non-TCP inbound, so this is
    // the difference between two products and a broken gateway.
    const ws = gatewayServerConfig({ ...realityGateway(), transport: 'ws' }, [client], [], null);
    assert.equal(ws.inbounds.find((i) => i.tag === 'client-in').settings.clients[0].flow, undefined);
  });

  await t.test('binds the public address: nothing can proxy a borrowed handshake', () => {
    const behindProxy = realityGateway({ tls_mode: 'reverse-proxy', listen_port: 10001 });
    assert.equal(listenEndpoint(behindProxy).address, '0.0.0.0');
    assert.ok(isReality(behindProxy));
  });
});

test('registering a REALITY gateway', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  const token = await ctx.login();

  const base = {
    name: 'Reality edge', region: 'de', host: '203.0.113.10', port: 443,
    transport: 'reality', realityDest: 'www.microsoft.com:443',
  };
  let gatewayId = null;

  await t.test('issues its own key pair, so nobody runs xray x25519 by hand', async () => {
    const res = await ctx.request('POST', '/api/v1/gateways', { token, body: base });
    assert.equal(res.status, 201);
    gatewayId = res.body.data.id;
    const { reality } = res.body.data;
    assert.match(reality.publicKey, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(reality.serverNames, ['www.microsoft.com'], 'defaults to the borrowed site itself');
    assert.equal(reality.shortIds.length, 2);
    reality.shortIds.forEach((id) => assert.match(id, SHORT_ID_SHAPE));
  });

  await t.test('the private key never leaves the control plane', async () => {
    const res = await ctx.request('GET', `/api/v1/gateways/${gatewayId}`, { token });
    const secret = ctx.db.prepare('SELECT reality_private_key AS k FROM gateways WHERE id = ?').get(gatewayId).k;
    assert.ok(secret, 'it is stored');
    assert.ok(!JSON.stringify(res.body).includes(secret), 'and it is not served');
    assert.equal(realityPublicKey(secret), res.body.data.reality.publicKey);
  });

  await t.test('but it does reach the gateway agent, which cannot work without it', async () => {
    const res = await ctx.request('GET', `/api/v1/gateways/${gatewayId}/xray-config`, { token });
    const inbound = res.body.data.config.inbounds.find((i) => i.tag === 'client-in');
    assert.equal(inbound.streamSettings.security, 'reality');
    assert.ok(inbound.streamSettings.realitySettings.privateKey);
  });

  await t.test('refuses a borrowed site with no port', async () => {
    const res = await ctx.request('POST', '/api/v1/gateways', {
      token,
      body: { ...base, host: '203.0.113.11', realityDest: 'www.microsoft.com' },
    });
    assert.equal(res.status, 422);
  });

  await t.test('refuses a reverse proxy in front of it', async () => {
    const res = await ctx.request('POST', '/api/v1/gateways', {
      token,
      body: { ...base, host: '203.0.113.12', tlsMode: 'reverse-proxy', listenPort: 10002 },
    });
    assert.equal(res.status, 422);
  });

  await t.test('refuses a short ID that is not hex', async () => {
    const res = await ctx.request('POST', '/api/v1/gateways', {
      token,
      body: { ...base, host: '203.0.113.13', realityShortIds: ['nothex'] },
    });
    assert.equal(res.status, 422);
  });

  await t.test('changing the port keeps the keys, so issued profiles still work', async () => {
    const before = ctx.db.prepare('SELECT reality_private_key AS k FROM gateways WHERE id = ?').get(gatewayId).k;
    const res = await ctx.request('PATCH', `/api/v1/gateways/${gatewayId}`, { token, body: { port: 8443 } });
    assert.equal(res.status, 200);
    const after = ctx.db.prepare('SELECT reality_private_key AS k FROM gateways WHERE id = ?').get(gatewayId).k;
    assert.equal(after, before);
  });

  await t.test('turning REALITY off clears the key material with it', async () => {
    const res = await ctx.request('PATCH', `/api/v1/gateways/${gatewayId}`, {
      token,
      body: { transport: 'ws', tlsMode: 'reverse-proxy', listenPort: 10005 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.reality, null);
    const row = ctx.db.prepare('SELECT * FROM gateways WHERE id = ?').get(gatewayId);
    assert.equal(row.reality_private_key, null, 'a key for a transport nobody uses is only a liability');
    assert.equal(row.reality_dest, null);
  });

  await t.test('and a WebSocket gateway can be turned into a REALITY one', async () => {
    const made = await ctx.request('POST', '/api/v1/gateways', {
      token,
      body: { name: 'Was ws', region: 'de', host: '203.0.113.14', port: 443 },
    });
    const id = made.body.data.id;
    assert.equal(made.body.data.reality, null);
    const res = await ctx.request('PATCH', `/api/v1/gateways/${id}`, {
      token,
      body: { transport: 'reality', realityDest: 'www.cloudflare.com:443' },
    });
    assert.equal(res.status, 200);
    assert.match(res.body.data.reality.publicKey, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(res.body.data.reality.serverNames, ['www.cloudflare.com']);
  });
});
