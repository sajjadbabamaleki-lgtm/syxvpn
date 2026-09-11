# The support assistant

Support is answered by a bot in Telegram. It reads the asker's own account and
the real state of the fleet through a small set of read-only tools, answers in
the language the question was asked in, and hands the conversation to a person
the moment it cannot answer or money would have to change.

Telegram, and not a support page, because the moment somebody needs support is
the moment the app they would open a support page in is not working.

## What it can see

Six tools, all of them reads. None of them takes an argument that identifies
somebody else: every account tool answers for the account the *chat* is linked
to, so the worst a chat can learn is what its own owner could already see on
the storefront.

| Tool | Answers |
| --- | --- |
| `get_subscription` | active or not and why, data left, expiry, last fetch |
| `get_servers` | the gateways this account is offered: health, latency, live protocols — names and regions, never addresses |
| `get_orders` | recent orders: status, amount, confirmations so far, when the window closes |
| `get_plans` | what is on sale, in USDT — works with no account at all |
| `get_service_status` | the fleet as a whole, so a local problem can be told from an outage |
| `escalate_to_human` | hands the chat to a person, with one line of why |

What no tool returns, by construction: a token, a subscription URL, a
credential UUID, a config line, a gateway address, or anything about traffic.
State, not content. The bot is told in its prompt never to ask for a password,
a subscription link or a payment receipt, because it never needs one.

## Trying it before any of this

```sh
cd server && npm run try-bot
```

That boots a whole control plane in memory — a customer, a subscription, one
healthy gateway and one degraded one, a plan — and wires the real webhook to
your keyboard. No bot, no token, no public URL, no Telegram. What you type goes
in as an update; what would have been sent back is printed.

With `ANTHROPIC_API_KEY` set the assistant is the real one, and each reply is
worth a fraction of a cent; the tools it consults are printed as it uses them,
because an answer about a subscription that never called `get_subscription` is
an answer somebody made up. Without a key it runs a stand-in, which exercises
the commands, the link code, the handover and the operator side for free —
everything except the model's own words.

Besides the customer commands, the harness understands `!code` (issue a link
code, so `/link` can be tried), `!op <command>` (type as the operator), `!id`
(the chat id, for `/reply`) and `!quit`. The database is `:memory:` and is gone
when you leave.

The thing worth testing by hand is the handover: send `/human`, watch it reach
the operator, answer with `!op /reply <id> …`, then type again as the customer
and confirm the bot says *nothing* — only the operator sees it — until
`!op /bot <id>` gives the chat back.

## Turning it on

1. **A bot.** `@BotFather` → `/newbot` → a token. `TELEGRAM_BOT_TOKEN`.
2. **A webhook secret.** `openssl rand -hex 24` → `TELEGRAM_WEBHOOK_SECRET`.
   It is both the secret path segment and the `x-telegram-bot-api-secret-token`
   header, and both are checked: a URL ends up in logs and proxies, a header
   does not.
3. **The bot's handle.** `TELEGRAM_BOT_USERNAME`, without the `@`. The
   storefront shows the linking step only when this is set, so nobody is
   offered a code for a chat that does not exist.
4. **An operator chat.** Message the bot from the account that will answer, or
   add it to a group, and read the numeric chat id off the update. That is
   `TELEGRAM_OPERATOR_CHAT_ID` — where handovers are announced and the only
   chat the operator commands work from.
5. **A key.** `ANTHROPIC_API_KEY`, then `ASSISTANT_ENABLED=true`. Without the
   key the flag does nothing: a support channel that cannot answer is worse
   than no support channel.
6. **Restart the control plane**, so it comes up holding all of that:

   ```sh
   docker compose -f deploy/docker-compose.yml up -d api
   ```

   The startup line names the model when the assistant is on and says `off`
   when it is not.

7. **Register the webhook:**

   ```sh
   cd server && npm run telegram set
   ```

   That reads the same `.env` and points the bot at
   `PUBLIC_BASE_URL/telegram/webhook/<secret>`, with the secret header set.
   `npm run telegram info` says whether Telegram is getting through, and
   `npm run telegram delete` stops it.

For step 4, `npm run telegram whoami` lists the chats that have written to the
bot, which is where the operator chat id comes from. It only works before a
webhook is registered — Telegram delivers updates one way or the other, not
both — so do it in that order, or run `delete`, `whoami`, `set`.

**The reverse proxy has to send `/telegram/*` to the API**, not to the web app.
`deploy/Caddyfile.example` does; a proxy that does not will answer Telegram
with the storefront's HTML and no reply will ever arrive. The webhook's own
secret is in the path and in a header, both checked, so exposing that prefix
publicly is what it is designed for.

## Linking an account

A chat starts anonymous, and an anonymous chat can be told about plans and
nothing else. To link it the customer signs in on the storefront, which calls
`POST /api/v1/shop/link-code` and shows a six-digit code. They send the bot
`/link 481902`.

The code lasts ten minutes, works once, and is bound to the account that asked
for it — guessing one wins nothing but somebody else's unused code. Asking for
a new one deletes the old one.

## What a customer can type

| | |
| --- | --- |
| `/start`, `/help` | what the bot can do |
| `/link <code>` | connect this chat to an account |
| `/status` | the subscription at a glance |
| `/plans` | what is on sale |
| `/human` | hand the conversation to a person, immediately |

Anything that is not a command goes to the assistant.

## What an operator can type

Only from `TELEGRAM_OPERATOR_CHAT_ID`, and only when it is set.

| | |
| --- | --- |
| `/waiting` | chats waiting on a person, longest first, with the reason |
| `/reply <chatId> <text>` | send those words to that customer, as you |
| `/bot <chatId>` | give the chat back to the assistant |

A handover announcement carries the chat id, the reason, the account, and what
the customer just said — with the two commands spelled out, so answering is a
copy and an edit.

## The rule about handovers

Once a chat is `human`, the bot stops talking in it. Further messages are
recorded and forwarded to the operator chat, and nothing is sent back
automatically. Only `/bot <chatId>` puts it back.

This is not a detail. A person who asked for a human and keeps getting a
machine has been told their request does not count, and that is the point at
which people stop trusting the handover and start opening a second ticket.

The bot hands over when: it is asked to; the tools do not explain what
happened; money or access would have to change; the model returns nothing; or
it has gone six tool rounds without an answer. Every handover raises a
`support.handoff` event, so it is visible in the dashboard as well as in
Telegram.

## Watching it

- `support.handoff` events — the rate is the number that matters. A rising
  share of chats ending with a person means the tools stopped covering
  something, not that people got harder.
- The startup log line: `assistant: claude-opus-5` or `assistant: off`.
- `npm run telegram info` → `Waiting`. A number that does not come back down
  means the control plane is not answering Telegram, and `Last error` says
  why.
- The webhook replies `200` before it does any work, so Telegram never retries
  into a duplicate answer; a failure shows up in the logs, not as a second
  message to the customer.

## Turning it off

`ASSISTANT_ENABLED=false` and restart. The webhook then accepts and drops
updates, which is quiet but not honest for long — also `npm run telegram
delete` if it is staying off, so the bot is plainly silent rather than seemingly ignoring
people. Nothing else in the control plane depends on it.
