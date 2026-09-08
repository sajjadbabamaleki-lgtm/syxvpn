import crypto from 'node:crypto';

/**
 * Signed control-plane client.
 *
 * Every request carries an HMAC-SHA256 signature over method, path, timestamp,
 * nonce and body hash. The control plane rejects a repeated nonce, so a
 * captured request cannot be replayed against it.
 */
export function createClient({ controlPlaneUrl, gatewayId, agentKey }) {
  async function request(method, path, body) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(12).toString('base64url');
    const bodyHash = crypto.createHash('sha256').update(payload).digest('hex');
    const canonical = [method.toUpperCase(), path, String(timestamp), nonce, bodyHash].join('\n');
    const signature = crypto.createHmac('sha256', agentKey).update(canonical).digest('hex');

    const res = await fetch(`${controlPlaneUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-jordan-gateway': gatewayId,
        'x-jordan-timestamp': String(timestamp),
        'x-jordan-nonce': nonce,
        'x-jordan-signature': signature,
        'user-agent': 'jordan-gateway-agent/0.2.0',
      },
      ...(payload ? { body: payload } : {}),
    });

    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const message = parsed?.error?.message || `HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.code = parsed?.error?.code;
      throw err;
    }
    return parsed?.data;
  }

  return {
    heartbeat: (body) => request('POST', '/api/v1/agent/heartbeat', body),
    fetchConfig: () => request('GET', '/api/v1/agent/config'),
    reportConfigStatus: (body) => request('POST', '/api/v1/agent/config-status', body),
    reportHealth: (body) => request('POST', '/api/v1/agent/health', body),
    reportUsage: (body) => request('POST', '/api/v1/agent/usage', body),
  };
}
