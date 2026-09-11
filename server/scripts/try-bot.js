#!/usr/bin/env node
/**
 * The support bot, in a terminal, with Telegram taken out of the middle.
 *
 *   node scripts/try-bot.js
 *
 * It boots a whole control plane in memory — a customer, a subscription, two
 * gateways, a plan — and wires the real webhook to your keyboard. What you type
 * goes in as a Telegram update; what the bot would send back is printed. The
 * commands, the linking, the handover and the operator side are all the ones
 * that will run in production, because they are the same code.
 *
 * With ANTHROPIC_API_KEY set, the assistant is real and so is the bill (a few
 * cents a conversation). Without one it runs in a stand-in mode that exercises
 * every path except the model's own words — enough to test the commands, the
 * link code and the handover for free.
 *
 * Nothing here touches your real database: it is :memory:, and it is gone when
 * you quit.
 */

import readline from 'node:readline';

// The config module reads the environment once, at import. Set it first.
process.env.LOG_LEVEL ||= 'error';
process.env.NODE_ENV = 'development';
process.env.SECRET_KEY ||= 'try-bot-local-key-not-a-secret-0000000000=';
process.env.TELEGRAM_WEBHOOK_SECRET ||= 'local';
process.env.TELEGRAM_OPERATOR_CHAT_ID ||= '999';
process.env.TELEGRAM_BOT_USERNAME ||= 'local_test_bot';

const { config } = await import('../src/config.js');
const { openDatabase } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const { createAssistant } = await import('../src/services/assistant.js');
const { createAnthropic } = await import('../src/services/anthropic.js');
const { createGateway } = await import('../src/domain/gateways.js');
const { createEgress, assignEgress } = await import('../src/domain/egresses.js');
const { createSubscriber } = await import('../src/domain/subscribers.js');
const { registerCustomer, createPlan, toMicro } = await import('../src/domain/shop.js');
const { issueLinkCode, findChat } = await import('../src/domain/chats.js');
const { hashPassword, newId } = await import('../src/lib/crypto.js');

const CUSTOMER_CHAT = '1000';
const OPERATOR_CHAT = process.env.TELEGRAM_OPERATOR_CHAT_ID;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const paint = {
  bot: (s) => `\x1b[36m${s}\x1b[0m`,
  op: (s) => `\x1b[35m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};

// --- a world for the bot to answer about ------------------------------------

const db = openDatabase(':memory:');
const now = Date.now();
db.prepare('INSERT INTO admins (id,username,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)')
  .run(newId('adm'), 'admin', hashPassword('try-bot-local-password'), now, now);

const egress = createEgress(db, { name: 'Uplink', region: 'eu', kind: 'direct', priority: 100 });

// One healthy gateway and one degraded one, because "it worked yesterday" is
// the ticket that needs the difference between them to be visible.
const healthy = createGateway(db, {
  name: 'Frankfurt', region: 'de', host: '203.0.113.10', port: 443, tlsMode: 'none', wsPath: '/ws',
});
const shaky = createGateway(db, {
  name: 'Amsterdam', region: 'nl', host: '203.0.113.20', port: 443, tlsMode: 'none', wsPath: '/ws',
});
assignEgress(db, healthy.id, egress.id, 10);
assignEgress(db, shaky.id, egress.id, 10);
db.prepare("UPDATE gateways SET ingress_status='online', ingress_latency_ms=38, ingress_checked_at=? WHERE id=?")
  .run(now, healthy.id);
db.prepare("UPDATE gateways SET ingress_status='degraded', ingress_latency_ms=410, ingress_checked_at=? WHERE id=?")
  .run(now, shaky.id);

createPlan(db, {
  name: '1 month · 50 GB', description: 'Everything on, one month', quotaBytes: 50 * 1024 ** 3,
  durationDays: 30, priceMicro: toMicro(4.5), product: 'vpn', billing: 'duration',
});

const customer = registerCustomer(db, { email: 'demo@example.com', password: 'demo-password' });
createSubscriber(db, {
  name: 'demo', quotaBytes: 50 * 1024 ** 3, expiresAt: now + 12 * 86400000, customerId: customer.id,
});
// Enough of the quota spent that the numbers read like a real account.
db.prepare('UPDATE subscribers SET used_bytes = ? WHERE customer_id = ?')
  .run(Math.round(31.4 * 1024 ** 3), customer.id);

// --- the two ends, faked ----------------------------------------------------

// Resolved by `send`, so the prompt comes back after the answer rather than
// on top of it.
let answered = null;

/** Telegram's side: print instead of POSTing to api.telegram.org. */
async function send(chatId, text) {
  const label = String(chatId) === OPERATOR_CHAT ? paint.op('→ operator') : paint.bot('→ you');
  console.log(`\n${label}\n${text}\n`);
  answered?.();
  return true;
}

const after = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const live = Boolean((process.env.ANTHROPIC_API_KEY || '').trim());

/**
 * The real client, with the tool calls narrated.
 *
 * Seeing which tools a reply was built from is most of what there is to judge:
 * an answer about a subscription that never called get_subscription is an
 * answer somebody made up.
 */
function narrating(client) {
  return {
    messages: {
      async create(request) {
        const response = await client.messages.create(request);
        for (const block of response.content || []) {
          if (block.type === 'tool_use') {
            console.log(paint.dim(`   … looked up ${block.name}${block.input?.reason ? `: ${block.input.reason}` : ''}`));
          }
        }
        return response;
      },
    },
  };
}

/** No key, no model: everything but the words. */
const standIn = {
  async reply(chat, text) {
    const { appendMessage } = await import('../src/domain/chats.js');
    const { runTool } = await import('../src/domain/assistant.js');
    appendMessage(db, chat.id, 'user', text);
    const looked = runTool(db, chat, 'get_subscription');
    const answer = looked.error
      ? `[stand-in] I would answer this from the tools. Right now: ${looked.error}.`
      : `[stand-in] I would answer this from the tools. Your subscription reads: ${JSON.stringify(looked)}`;
    appendMessage(db, chat.id, 'assistant', answer);
    return { reply: answer, handedOver: false, reason: null };
  },
};

config.assistant.enabled = true;
const assistant = live
  ? createAssistant({ db, client: narrating(createAnthropic()) })
  : standIn;

const app = createApp({ db, startedAt: now, assistant, sendMessage: send });
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

/**
 * One Telegram update, as Telegram would deliver it.
 *
 * The webhook answers before it does the work — that is the point of it — so
 * this waits for the reply the way a person staring at Telegram would.
 */
async function deliver(chatId, text) {
  const reply = new Promise((resolve) => { answered = resolve; });
  await fetch(`${base}/telegram/webhook/${SECRET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({ message: { chat: { id: chatId }, text } }),
  });
  await Promise.race([reply, after(90000)]);
  // A handover sends twice: the customer, then the operator. Let the second land.
  await after(150);
  answered = null;
}

// --- the keyboard -----------------------------------------------------------

console.log(`
${paint.bot('The support bot, locally.')}

  ${live ? 'Assistant: real (ANTHROPIC_API_KEY is set — replies cost money).'
    : paint.warn('Assistant: stand-in. Set ANTHROPIC_API_KEY for real replies.')}
  Account:   demo@example.com · 50 GB plan, 18.6 GB left, 12 days
  Fleet:     Frankfurt online (38 ms) · Amsterdam degraded (410 ms)

${paint.dim('Type as the customer. Then:')}
  ${paint.dim('/start  /help  /status  /plans  /link <code>  /human')}
  ${paint.dim('!code            issue a link code, to test /link')}
  ${paint.dim('!op <command>    type as the operator: /waiting, /reply <id> ..., /bot <id>')}
  ${paint.dim('!id              the chat id, for /reply')}
  ${paint.dim('!quit')}
`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you > ' });
rl.prompt();

rl.on('line', async (raw) => {
  const line = raw.trim();
  try {
    if (!line) return;
    if (line === '!quit') { rl.close(); return; }

    if (line === '!code') {
      const { code } = issueLinkCode(db, customer.id);
      console.log(paint.dim(`\n   a code for demo@example.com: ${code}   →   /link ${code}\n`));
      return;
    }

    if (line === '!id') {
      const chat = findChat(db, 'telegram', CUSTOMER_CHAT);
      console.log(paint.dim(`\n   ${chat ? chat.id : 'say something first — the chat opens on first contact'}\n`));
      return;
    }

    if (line.startsWith('!op ')) {
      await deliver(OPERATOR_CHAT, line.slice(4).trim());
      return;
    }

    await deliver(CUSTOMER_CHAT, line);
  } catch (error) {
    console.error(paint.warn(`\n   ${error.message}\n`));
  } finally {
    rl.prompt();
  }
});

rl.on('close', () => {
  server.close(() => { db.close(); process.exit(0); });
});
