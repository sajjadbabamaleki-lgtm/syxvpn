# Payments (USDT, TRC-20)

## The flow

```
customer picks a plan
      │
      ▼
order created  ──▶  unique amount, e.g. 5.000007 USDT, valid 60 minutes
      │
customer sends that exact amount to the operator's TRON address
      │
      ▼
watcher polls TronGrid for incoming USDT transfers
      │
      ├─ amount matches an open order?      no  ──▶ ignored
      ├─ transaction succeeded?             no  ──▶ ignored
      ├─ enough confirmations?              no  ──▶ order shown as "seen", waits
      │
      ▼
order fulfilled + subscription provisioned, in one transaction
```

## Why a unique amount

Giving every order its own deposit address means managing keys for every
address. Instead each open order asks for the price plus a few micro-USDT, and
no two open orders ever ask for the same amount. An incoming transfer therefore
maps to exactly one order, and the operator keeps a single address they control.

The consequence is worth stating to customers, and the UI does: **sending a
different amount will not settle automatically**. An operator can settle such a
payment by hand once they have verified it, and that is recorded as
`settledBy: admin:<username>` rather than as a chain payment.

## What the control plane can and cannot do

It only ever **reads** the chain. There is no private key anywhere in this
codebase; it cannot move, refund or sweep funds. Refunds are an out-of-band
operator action.

## Configuration

```sh
TRON_ADDRESS=T...              # your receiving address (required to sell)
TRON_API_KEY=...               # free TronGrid key; without it you share a low
                               # anonymous rate limit
USDT_CONTRACT=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t   # mainnet USDT
PAYMENT_CONFIRMATIONS=19       # TRON finality is ~19 blocks (~57s)
PAYMENT_WINDOW_MINUTES=60
PAYMENT_POLL_SECONDS=30
```

Without `TRON_ADDRESS` the storefront still lists plans and refuses to open an
order, and `/readiness` reports `payments: not-configured`. It never pretends to
take money.

## Renewals

A customer has one subscription. Buying again adds the plan's quota to whatever
is left and extends the expiry from the later of "now" and the current expiry.
The subscription URL does not change, so the config already loaded in their app
keeps working.

## Operating it

- `/admin/orders` lists orders with totals, and has a "Scan chain now" button
  that runs one watcher pass immediately.
- Watcher failures (TronGrid unreachable, rate limited) raise a
  `payments.error` event rather than failing silently.
- Every pass re-scans a window behind the last one, so a transfer that landed
  mid-request is picked up on the next pass.

## Testing without a chain

`createPaymentWatcher(db, { client })` takes any object with
`incomingTransfers`, `latestBlock` and `transactionStatus`. `server/test/shop.test.js`
uses a fake one to cover unconfirmed transfers, confirmed settlement, replays,
failed transactions, non-matching amounts, expiry and renewal.
