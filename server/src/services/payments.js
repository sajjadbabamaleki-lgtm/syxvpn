import { config } from '../config.js';
import { logger } from '../logger.js';
import { recordEvent } from '../domain/events.js';
import {
  expireStaleOrders, matchOrderForTransfer, settleOrder, transferAlreadyApplied, fromMicro,
} from '../domain/shop.js';
import { createTronClient, paymentsConfigured } from './tron.js';

/**
 * Payment watcher.
 *
 * Polls the operator's TRC-20 address for incoming USDT, matches each transfer
 * to the single open order that asked for that exact amount, waits for the
 * configured number of confirmations, then settles and provisions.
 *
 * An order is never fulfilled because a customer said they paid: the only path
 * to `fulfilled` is a confirmed on-chain transfer, or an operator explicitly
 * settling it by hand (which is recorded as such).
 */
export function createPaymentWatcher(db, {
  cfg = config.shop,
  client = null,
  now = () => Date.now(),
} = {}) {
  const tron = client || createTronClient(cfg);
  let timer = null;
  let running = false;

  const lastScanKey = 'payments.last_scan_ms';
  const readLastScan = () => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(lastScanKey);
    return row ? Number(row.value) : null;
  };
  const writeLastScan = (value) => {
    db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(lastScanKey, String(value), now());
  };

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    const summary = { checked: 0, matched: 0, settled: 0, pendingConfirmation: 0, expired: 0 };
    try {
      summary.expired = expireStaleOrders(db, now());
      if (!paymentsConfigured(cfg)) return summary;

      // Re-scan a window behind the last pass so a transfer is never missed
      // because it landed while the previous request was in flight.
      const overlapMs = cfg.paymentWindowMinutes * 60000;
      const sinceMs = Math.max(0, (readLastScan() ?? now() - overlapMs) - overlapMs);
      const transfers = await tron.incomingTransfers({ sinceMs });
      summary.checked = transfers.length;

      let latestBlock = null;
      for (const transfer of transfers) {
        if (transfer.contract && transfer.contract !== cfg.usdtContract) continue;
        if (transferAlreadyApplied(db, transfer.txHash)) continue;

        const order = matchOrderForTransfer(db, {
          amountMicro: transfer.amountMicro,
          timestamp: transfer.timestamp,
        });
        if (!order) continue;
        summary.matched += 1;

        const status = await tron.transactionStatus(transfer.txHash);
        if (!status.found || !status.success) {
          logger.warn('ignoring failed transaction', { txHash: transfer.txHash });
          continue;
        }
        if (latestBlock === null) latestBlock = await tron.latestBlock();
        const confirmations = Math.max(0, latestBlock - status.blockNumber);
        if (confirmations < cfg.confirmations) {
          summary.pendingConfirmation += 1;
          // Show the customer that the payment was seen while it matures.
          db.prepare("UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), confirmations = ? WHERE id = ? AND status = 'pending'")
            .run(now(), confirmations, order.id);
          continue;
        }

        settleOrder(db, order.id, {
          txHash: transfer.txHash,
          fromAddress: transfer.from,
          confirmations,
          settledBy: 'chain',
        });
        summary.settled += 1;
        logger.info('order settled on chain', {
          orderId: order.id, amount: fromMicro(transfer.amountMicro), confirmations,
        });
      }

      writeLastScan(now());
      return summary;
    } catch (err) {
      logger.error('payment watcher failed', { message: err.message });
      recordEvent(db, {
        type: 'payments.error', severity: 'warning',
        message: `Payment watcher could not reach the chain: ${err.message}`.slice(0, 300),
      });
      return { ...summary, error: err.message };
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (!cfg.watcherEnabled) return null;
      if (!paymentsConfigured(cfg)) {
        logger.warn('payment watcher idle: TRON_ADDRESS is not set');
      }
      timer = setInterval(tick, Math.max(10, cfg.pollSeconds) * 1000);
      timer.unref?.();
      const kickoff = setTimeout(tick, 3000);
      kickoff.unref?.();
      return timer;
    },
    stop() { clearInterval(timer); },
  };
}
