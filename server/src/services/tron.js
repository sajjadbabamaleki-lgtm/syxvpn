import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Minimal TronGrid client for watching incoming TRC-20 USDT transfers.
 *
 * Only read endpoints are used: the control plane never holds a private key and
 * cannot move funds. Payments arrive at an address the operator controls.
 */
export function createTronClient(cfg = config.shop, fetchImpl = fetch) {
  const headers = {
    accept: 'application/json',
    ...(cfg.tronApiKey ? { 'TRON-PRO-API-KEY': cfg.tronApiKey } : {}),
  };

  async function get(path) {
    const res = await fetchImpl(`${cfg.tronApiUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`TronGrid ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  async function post(path, body) {
    const res = await fetchImpl(`${cfg.tronApiUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`TronGrid ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  return {
    /** Incoming USDT transfers to the payment address, newest first. */
    async incomingTransfers({ sinceMs, limit = 100 }) {
      const params = new URLSearchParams({
        only_to: 'true',
        contract_address: cfg.usdtContract,
        limit: String(limit),
        order_by: 'block_timestamp,desc',
      });
      if (sinceMs) params.set('min_timestamp', String(sinceMs));
      const body = await get(`/v1/accounts/${cfg.payAddress}/transactions/trc20?${params}`);
      if (body?.success === false) throw new Error(`TronGrid error: ${JSON.stringify(body.error || body)}`);
      return (body?.data || [])
        .filter((t) => t.type === 'Transfer' && t.to === cfg.payAddress)
        .map((t) => ({
          txHash: t.transaction_id,
          from: t.from,
          to: t.to,
          // TRC-20 USDT has 6 decimals, which is exactly our micro unit.
          amountMicro: Number(t.value),
          decimals: Number(t.token_info?.decimals ?? 6),
          symbol: t.token_info?.symbol || 'USDT',
          contract: t.token_info?.address,
          timestamp: Number(t.block_timestamp),
        }));
    },

    async latestBlock() {
      const block = await post('/wallet/getnowblock', {});
      return Number(block?.block_header?.raw_data?.number ?? 0);
    },

    /** Execution result and depth of a transaction, used to require confirmations. */
    async transactionStatus(txHash) {
      const info = await post('/wallet/gettransactioninfobyid', { value: txHash });
      if (!info || !info.id) return { found: false };
      return {
        found: true,
        blockNumber: Number(info.blockNumber ?? 0),
        success: (info.receipt?.result ?? 'SUCCESS') === 'SUCCESS',
      };
    },
  };
}

/** True when the deployment has everything it needs to accept payments. */
export function paymentsConfigured(cfg = config.shop) {
  return Boolean(cfg.enabled && cfg.payAddress);
}

export function describePaymentConfig(cfg = config.shop) {
  return {
    enabled: Boolean(cfg.enabled),
    configured: paymentsConfigured(cfg),
    chain: 'tron',
    asset: 'USDT-TRC20',
    address: cfg.payAddress || null,
    contract: cfg.usdtContract,
    confirmations: cfg.confirmations,
    windowMinutes: cfg.paymentWindowMinutes,
    apiKeyConfigured: Boolean(cfg.tronApiKey),
  };
}

export { logger };
