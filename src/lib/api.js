const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const TOKEN_KEY = 'jordan.session';

let session = readSession();
const listeners = new Set();

function readSession() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.token || new Date(parsed.expiresAt).getTime() <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(value) {
  session = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, JSON.stringify(value));
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode: session lives in memory only */ }
  listeners.forEach((fn) => fn(session));
}

export const auth = {
  get current() { return session; },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  signOut() { writeSession(null); },
};

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, auth: needsAuth = true, withMeta = false } = {}) {
  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(needsAuth && session ? { authorization: `Bearer ${session.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Control plane unreachable');
  }

  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }

  // A 401 normally means the session is gone, and the console should stop
  // pretending otherwise. REAUTH_FAILED is the exception: the session is fine
  // and a password or code typed into it was wrong, so signing the operator
  // out would be the wrong answer to a typo.
  if (response.status === 401 && needsAuth && payload?.error?.code !== 'REAUTH_FAILED') {
    writeSession(null);
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired — sign in again');
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code || 'ERROR',
      payload?.error?.message || `Request failed (${response.status})`,
      payload?.error?.details,
    );
  }
  // A few endpoints carry aggregate `meta` next to `data`; the hook keeps it.
  if (withMeta) return { data: payload?.data, meta: payload?.meta };
  return payload?.data;
}

export const api = {
  /**
   * [code] is the one-time code, or a recovery code, and is absent on the
   * first attempt: an account with a second factor answers 401 TOTP_REQUIRED,
   * which is how the sign-in screen learns to ask for one.
   */
  async signIn(username, password, code) {
    const data = await request('/api/v1/auth/login', {
      method: 'POST', body: { username, password, ...(code ? { code } : {}) }, auth: false,
    });
    writeSession({ token: data.token, expiresAt: data.expiresAt, admin: data.admin });
    return data;
  },
  async signOut() {
    try { await request('/api/v1/auth/logout', { method: 'POST' }); } catch { /* already gone */ }
    writeSession(null);
  },
  changePassword: (currentPassword, newPassword) =>
    request('/api/v1/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),

  twoFactor: () => request('/api/v1/auth/totp'),
  startTwoFactor: () => request('/api/v1/auth/totp/setup', { method: 'POST' }),
  // Returns the recovery codes, the one time they are readable.
  confirmTwoFactor: (code) => request('/api/v1/auth/totp/confirm', { method: 'POST', body: { code } }),
  disableTwoFactor: (password, code) =>
    request('/api/v1/auth/totp/disable', { method: 'POST', body: { password, code } }),

  backups: () => request('/api/v1/backups', { withMeta: true }),
  takeBackup: () => request('/api/v1/backups', { method: 'POST' }),
  /**
   * Downloads a snapshot to the operator's own machine.
   *
   * Not a plain link: the API needs the bearer token, and an `<a href>` carries
   * no headers. The file is fetched, handed to the browser as a blob, and the
   * object URL released — a database is large enough that leaking one per click
   * is worth avoiding.
   */
  async downloadBackup(name) {
    const response = await fetch(`${BASE}/api/v1/backups/${encodeURIComponent(name)}`, {
      headers: session ? { authorization: `Bearer ${session.token}` } : {},
    });
    if (!response.ok) throw new ApiError(response.status, 'ERROR', 'Could not download that snapshot');
    const url = URL.createObjectURL(await response.blob());
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  },

  overview: () => request('/api/v1/overview'),
  routes: () => request('/api/v1/routes'),
  reevaluateRoutes: () => request('/api/v1/routes/reevaluate', { method: 'POST' }),

  gateways: () => request('/api/v1/gateways'),
  gateway: (id) => request(`/api/v1/gateways/${id}`),
  createGateway: (body) => request('/api/v1/gateways', { method: 'POST', body }),
  updateGateway: (id, body) => request(`/api/v1/gateways/${id}`, { method: 'PATCH', body }),
  deleteGateway: (id) => request(`/api/v1/gateways/${id}`, { method: 'DELETE' }),
  checkGateway: (id) => request(`/api/v1/gateways/${id}/check`, { method: 'POST' }),
  rotateAgentKey: (id) => request(`/api/v1/gateways/${id}/agent-key`, { method: 'POST' }),
  gatewayConfig: (id) => request(`/api/v1/gateways/${id}/xray-config`),
  assignEgress: (id, body) => request(`/api/v1/gateways/${id}/egresses`, { method: 'POST', body }),
  unassignEgress: (id, egressId) => request(`/api/v1/gateways/${id}/egresses/${egressId}`, { method: 'DELETE' }),

  egresses: () => request('/api/v1/egresses'),
  egress: (id) => request(`/api/v1/egresses/${id}`),
  createEgress: (body) => request('/api/v1/egresses', { method: 'POST', body }),
  updateEgress: (id, body) => request(`/api/v1/egresses/${id}`, { method: 'PATCH', body }),
  deleteEgress: (id) => request(`/api/v1/egresses/${id}`, { method: 'DELETE' }),

  subscribers: (query = '') => request(`/api/v1/subscribers${query}`),
  subscriber: (id) => request(`/api/v1/subscribers/${id}`),
  createSubscriber: (body) => request('/api/v1/subscribers', { method: 'POST', body }),
  updateSubscriber: (id, body) => request(`/api/v1/subscribers/${id}`, { method: 'PATCH', body }),
  deleteSubscriber: (id) => request(`/api/v1/subscribers/${id}`, { method: 'DELETE' }),
  rotateToken: (id) => request(`/api/v1/subscribers/${id}/rotate-token`, { method: 'POST' }),
  createBatch: (body) => request('/api/v1/subscribers/batch', { method: 'POST', body }),
  batches: () => request('/api/v1/subscribers/batches'),
  batch: (batchId) => request(`/api/v1/subscribers/batches/${batchId}`),
  revealSubscription: (id) => request(`/api/v1/subscribers/${id}/subscription`),
  rotateCredential: (id, graceMinutes) =>
    request(`/api/v1/subscribers/${id}/rotate-credential`, { method: 'POST', body: { graceMinutes } }),

  plans: () => request('/api/v1/plans'),
  createPlan: (body) => request('/api/v1/plans', { method: 'POST', body }),
  updatePlan: (id, body) => request(`/api/v1/plans/${id}`, { method: 'PATCH', body }),
  deletePlan: (id) => request(`/api/v1/plans/${id}`, { method: 'DELETE' }),
  orders: (query = '') => request(`/api/v1/orders${query}`, { withMeta: true }),
  settleOrder: (id, body) => request(`/api/v1/orders/${id}/settle`, { method: 'POST', body }),
  customers: () => request('/api/v1/customers'),
  paymentConfig: () => request('/api/v1/payments/config'),
  scanPayments: () => request('/api/v1/payments/scan', { method: 'POST' }),

  events: (limit = 50) => request(`/api/v1/events?limit=${limit}`),
  healthChecks: (query = '') => request(`/api/v1/health-checks${query}`),
  health: () => request('/health', { auth: false }),
};
