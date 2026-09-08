import { openDatabase } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { hashPassword, newId, sha256 } from '../src/lib/crypto.js';
import { signRequest } from '../src/auth/agent.js';

export const ADMIN_PASSWORD = 'test-admin-password';

/** Boots an isolated control plane on an ephemeral port. */
export async function startTestServer() {
  const db = openDatabase(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO admins (id,username,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(newId('adm'), 'admin', hashPassword(ADMIN_PASSWORD), now, now);

  const app = createApp({ db, startedAt: now });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const request = async (method, path, { body, token, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* plain text response */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };

  const login = async (password = ADMIN_PASSWORD, username = 'admin') => {
    const res = await request('POST', '/api/v1/auth/login', { body: { username, password } });
    return res.body?.data?.token;
  };

  /** Issues a correctly signed gateway-agent request. */
  const agentRequest = async (method, path, { key, gatewayId, body, overrides = {} } = {}) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const signed = signRequest({ key, method, path, body: payload });
    const headers = {
      'content-type': 'application/json',
      'x-jordan-gateway': gatewayId,
      'x-jordan-timestamp': String(signed.timestamp),
      'x-jordan-nonce': signed.nonce,
      'x-jordan-signature': signed.signature,
      ...overrides,
    };
    const res = await fetch(base + path, { method, headers, ...(payload ? { body: payload } : {}) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, body: json, text };
  };

  return {
    db,
    base,
    request,
    login,
    agentRequest,
    sha256,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

/** Registers a gateway plus an egress and returns the ids and agent key. */
export async function seedGateway(ctx, token, overrides = {}) {
  const gatewayRes = await ctx.request('POST', '/api/v1/gateways', {
    token,
    body: {
      name: 'Edge A',
      region: 'lab',
      host: '127.0.0.1',
      port: 18443,
      tlsMode: 'none',
      wsPath: '/ws',
      blockPrivateRanges: false,
      ...overrides,
    },
  });
  return gatewayRes.body.data;
}

export async function seedEgress(ctx, token, overrides = {}) {
  const res = await ctx.request('POST', '/api/v1/egresses', {
    token,
    body: { name: 'Uplink', region: 'eu', kind: 'direct', priority: 100, ...overrides },
  });
  return res.body.data;
}
