const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const TOKEN_KEY = 'sixvpn.customer';
// What it was called. Read so a rename does not sign every customer out of the
// account they paid for.
const LEGACY_TOKEN_KEYS = ['cvpn.customer', 'jordan.customer'];

let session = read();
const listeners = new Set();

function read() {
  try {
    let raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) {
      // Move it across on the first read under the new name. Leaving it where
      // it was would sign the customer back in after they signed out, since
      // signing out only clears the key this build writes.
      const key = LEGACY_TOKEN_KEYS.find((name) => localStorage.getItem(name));
      if (key) {
        raw = localStorage.getItem(key);
        localStorage.setItem(TOKEN_KEY, raw);
        LEGACY_TOKEN_KEYS.forEach((name) => localStorage.removeItem(name));
      }
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.token || new Date(parsed.expiresAt).getTime() <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function write(value) {
  session = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, JSON.stringify(value));
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode: session stays in memory */ }
  listeners.forEach((fn) => fn(session));
}

export const customer = {
  get current() { return session; },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  signOut() { write(null); },
};

export class ShopError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}/api/v1/shop${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth && session ? { authorization: `Bearer ${session.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ShopError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* not json */ }

  if (response.status === 401 && auth) {
    write(null);
    throw new ShopError(401, 'UNAUTHORIZED', 'Please sign in again');
  }
  if (!response.ok) {
    throw new ShopError(
      response.status,
      payload?.error?.code || 'ERROR',
      payload?.error?.message || `Request failed (${response.status})`,
      payload?.error?.details,
    );
  }
  return payload?.data;
}

export const shop = {
  config: () => request('/config', { auth: false }),
  plans: () => request('/plans', { auth: false }),

  async register(email, password) {
    const data = await request('/register', { method: 'POST', body: { email, password }, auth: false });
    write({ token: data.token, expiresAt: data.expiresAt, customer: data.customer });
    return data;
  },
  async signIn(email, password) {
    const data = await request('/login', { method: 'POST', body: { email, password }, auth: false });
    write({ token: data.token, expiresAt: data.expiresAt, customer: data.customer });
    return data;
  },
  async signOut() {
    try { await request('/logout', { method: 'POST' }); } catch { /* already gone */ }
    write(null);
  },

  me: () => request('/me'),
  // A short code that proves, once, which account a support chat belongs to.
  linkCode: () => request('/link-code', { method: 'POST' }),
  createOrder: (planId) => request('/orders', { method: 'POST', body: { planId } }),
  orders: () => request('/orders'),
  order: (id) => request(`/orders/${id}`),
  cancelOrder: (id) => request(`/orders/${id}/cancel`, { method: 'POST' }),
};
