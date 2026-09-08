# Issuing configs

Two ways to get a config into someone's hands. Both produce the same thing: a
subscription with its own data allowance and expiry, enforced on the gateway.

## 1. Self-serve (the storefront)

The customer buys a plan with USDT and their subscription appears on their
account. No operator action. See [`PAYMENTS.md`](PAYMENTS.md).

## 2. Operator-issued (what you hand out on Telegram)

`/admin/users` → **Issue in bulk**. Choose how many, the data allowance, and how
long they last:

```
100 × 20 GB for 30 days, prefix tg-2026-09-08
   ↓
tg-2026-09-08-001 … tg-2026-09-08-100
```

You get, once, on that screen:

- **Copy all links** — every subscription URL, ready to paste
- **Download .txt** — name and link per config
- **Download .csv** — name, link, quota, expiry, for a spreadsheet or a script
- **Copy raw configs** — the `vless://` URIs themselves, for people who paste a
  single config rather than a subscription

### Link or raw config?

| | Subscription link | Raw `vless://` |
| --- | --- | --- |
| Survives a gateway change | yes, the client refetches | no, it is one server |
| Survives failover to another gateway | yes | no |
| Works in every client | yes | yes |
| One line to paste | yes | yes |

Hand out the **subscription link** unless someone specifically wants a single
config. It is the only form that keeps working when you add, move or lose a
gateway.

### Reading a link again

The whole batch is shown once, but any single link can be read again:
subscriber → **Show link**. Every reveal is recorded in the event log, because
it is a live credential.

If you plan to hand out hundreds, export the CSV at issue time and keep it
somewhere you control — the export endpoint (`GET
/api/v1/subscribers/batches/<id>?format=csv`) can also rebuild it later.

## What "20 GB" actually means here

It is enforced, not advertised. Gateway agents report Xray's per-user counters;
when a subscription passes its allowance or its expiry, the control plane
removes that credential from every gateway within about a minute and the
subscription URL stops serving profiles. Verified in
`server/test/usage.test.js` and again on real traffic in the lab.

## Issuing at volume without dropping connections

Adding a user to Xray normally means rewriting the config and restarting it,
which drops every connection on that gateway. Issuing a hundred configs a day
that way would mean a hundred interruptions.

Jordan splits a gateway's configuration into its structure (inbound, outbounds,
routing) and its client list. When only the client list changed, the agent
applies it through Xray's API — `xray api adu` / `rmu` — and rewrites the config
file without restarting. A batch of a hundred is one API call and zero dropped
connections; the event log records it as "users applied live".

A structural change (a new gateway setting, a failover to another egress) still
goes through the full validate → `xray -test` → atomic replace → reload path.

## From the API

```sh
# issue 100
curl -X POST https://control.example.net/api/v1/subscribers/batch \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"count":100,"namePrefix":"tg-2026-09-08","quotaGb":20,"days":30}'

# re-export later
curl "https://control.example.net/api/v1/subscribers/batches/$BATCH_ID?format=csv" \
  -H "authorization: Bearer $ADMIN_TOKEN"

# one subscriber's link and raw config
curl "https://control.example.net/api/v1/subscribers/$ID/subscription" \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

Limits: 500 per call, and the operator API is rate limited to 600 requests a
minute.
