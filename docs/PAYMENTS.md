# Payments (USDT, TRC-20)

## Two products

The VPN tab and the Configs tab are sold separately, and a plan says which one
it is (`product`) and how it is priced (`billing`).

| | VPN | Configs |
|---|---|---|
| what it is | managed servers, one button, pick a country | a config list, to use here or carry to another client |
| sold as | 1, 3, 6 or 12 months | the same months at the same prices, **or** by the gigabyte |

A customer holds one subscription per product. Buying Configs no longer tops up
the quota the VPN tab is spending — which is what one shared subscription per
customer meant, and it meant a customer paying for one thing was given more of
another.

Subscriptions sold before the split carry `product: 'all'` and answer for both.
Taking half of what somebody paid for away from them is not a migration. An
operator can grant `all` deliberately too.

### By-the-gigabyte plans

These are settled by hand, so they are only on sale while `SHOP_VOLUME_SALES`
is on — off by default. Off the shelf they cannot be *ordered*, not merely
hidden: a plan id is not a secret, it was in the response the last time the
shelf was up.

One switch takes the whole shelf down rather than an operator remembering to
disable each plan and re-enable it. Selling something nobody is watching is
worse than not selling it.

### Configs bought elsewhere

A config a customer imported from another provider is theirs. It needs no plan,
no subscription and no account — see docs/ISSUING-CONFIGS.md.

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
