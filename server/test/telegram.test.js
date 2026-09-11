import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { hashPassword, newId } from '../src/lib/crypto.js';
import { createSubscriber } from '../src/domain/subscribers.js';
import { findChat, getChat, issueLinkCode, transcript } from '../src/domain/chats.js';

const SECRET = 'test-webhook-secret';
const OPERATOR = '424242';

/**
 * The bot, end to end, with both ends faked.
 *
 * Telegram is a fetch that records what would have been sent; the assistant is
 * a function that returns what it was told to. What is being tested is the part
 * in between — routing, commands, linking, and the rule that the bot stops
 * talking once a person has taken over.
 */
async function botServer({ replies = [] } = {}) {
  const db = openDatabase(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO admins (id,username,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(newId('adm'), 'admin', hashPassword('irrelevant'), now, now);

  const sent = [];
  const send = async (chatId, text) => { sent.push({ chatId: String(chatId), text }); return true; };

  const scripted = [...replies];
  const assistant = {
    async reply(chat, text) {
      const next = scripted.shift()
        || { reply: 'I looked and everything seems fine.', handedOver: false, reason: null };
      return { ...next, asked: text, chatId: chat.id };
    },
  };

  const previous = { ...config.assistant, telegram: { ...config.assistant.telegram } };
  config.assistant.enabled = true;
  config.assistant.telegram.webhookSecret = SECRET;
  config.assistant.telegram.operatorChatId = OPERATOR;

  const app = createApp({ db, startedAt: now, assistant, sendMessage: send });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const update = async (chatId, text, { secret = SECRET } = {}) => {
    const res = await fetch(`${base}/telegram/webhook/${SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
      body: JSON.stringify({ message: { chat: { id: chatId }, text } }),
    });
    // The route answers Telegram before it does the work, so give the work a
    // moment to finish before asserting on what it sent.
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    return res;
  };

  return {
    db,
    sent,
    update,
    lastTo: (chatId) => [...sent].reverse().find((m) => m.chatId === String(chatId))?.text,
    async close() {
      Object.assign(config.assistant, previous);
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

test('the bot', async (t) => {
  const ctx = await botServer();
  t.after(() => ctx.close());

  await t.test('greets a new chat and says what it can do', async () => {
    await ctx.update(1001, '/start');
    assert.match(ctx.lastTo(1001), /\/link/);
    assert.ok(findChat(ctx.db, 'telegram', '1001'), 'the chat was not remembered');
  });

  await t.test('refuses an update without the secret header', async () => {
    const before = ctx.sent.length;
    await ctx.update(1002, '/start', { secret: 'wrong' });
    assert.equal(ctx.sent.length, before, 'an unauthenticated update was answered');
  });

  await t.test('answers Telegram immediately, whatever happens after', async () => {
    const res = await ctx.update(1003, 'hello');
    assert.equal(res.status, 200);
  });

  await t.test('hands anything that is not a command to the assistant', async () => {
    await ctx.update(1004, 'it will not connect');
    assert.equal(ctx.lastTo(1004), 'I looked and everything seems fine.');
  });

  await t.test('links an account with a code, and only a real one', async () => {
    const customerId = newId('cus');
    ctx.db.prepare('INSERT INTO customers (id,email,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run(customerId, 'bot@example.com', hashPassword('x'), Date.now(), Date.now());

    await ctx.update(1005, '/link 000000');
    assert.match(ctx.lastTo(1005), /not valid/);

    const { code } = issueLinkCode(ctx.db, customerId);
    await ctx.update(1005, `/link ${code}`);
    assert.match(ctx.lastTo(1005), /Linked/);
    assert.equal(findChat(ctx.db, 'telegram', '1005').customer_id, customerId);
  });

  await t.test('/status reads the real subscription', async () => {
    const chat = findChat(ctx.db, 'telegram', '1005');
    createSubscriber(ctx.db, {
      name: 'bot-status',
      quotaBytes: 20 * 1024 ** 3,
      expiresAt: Date.now() + 10 * 86400000,
      customerId: chat.customer_id,
    });
    await ctx.update(1005, '/status');
    const answer = ctx.lastTo(1005);
    assert.match(answer, /Active/);
    assert.match(answer, /20 GB/);
  });

  await t.test('/status on an unlinked chat says how to link, not "error"', async () => {
    await ctx.update(1006, '/status');
    assert.match(ctx.lastTo(1006), /not linked/);
  });

  await t.test('/plans works with no account at all', async () => {
    await ctx.update(1007, '/plans');
    assert.ok(ctx.lastTo(1007).length > 0);
  });
});

test('handing a chat to a person', async (t) => {
  const ctx = await botServer({
    replies: [{ reply: 'A person will pick this up.', handedOver: true, reason: 'wants a refund' }],
  });
  t.after(() => ctx.close());

  await t.test('/human hands over and tells the operator', async () => {
    await ctx.update(2001, '/human');
    assert.match(ctx.lastTo(2001), /person/);
    assert.equal(findChat(ctx.db, 'telegram', '2001').state, 'human');

    const toOperator = ctx.lastTo(OPERATOR);
    assert.match(toOperator, /Handover/);
    assert.match(toOperator, /\/reply cht_/);
  });

  await t.test('the bot goes quiet once a person has it', async () => {
    const chat = findChat(ctx.db, 'telegram', '2001');
    const before = ctx.sent.filter((m) => m.chatId === '2001').length;
    await ctx.update(2001, 'are you there?');
    const after = ctx.sent.filter((m) => m.chatId === '2001').length;
    assert.equal(after, before, 'the assistant answered over an operator');

    // But the message is not lost: it is in the transcript and on the
    // operator's screen.
    assert.ok(transcript(ctx.db, chat.id).some((row) => row.body === 'are you there?'));
    assert.match(ctx.lastTo(OPERATOR), /are you there\?/);
  });

  await t.test('the operator answers, and their words are kept', async () => {
    const chat = findChat(ctx.db, 'telegram', '2001');
    await ctx.update(OPERATOR, `/reply ${chat.id} I have refunded it.`);
    assert.equal(ctx.lastTo(2001), 'I have refunded it.');
    assert.ok(transcript(ctx.db, chat.id).some((row) => row.role === 'operator'));
  });

  await t.test('/waiting lists who is waiting', async () => {
    await ctx.update(OPERATOR, '/waiting');
    assert.match(ctx.lastTo(OPERATOR), /cht_/);
  });

  await t.test('the operator can give the chat back', async () => {
    const chat = findChat(ctx.db, 'telegram', '2001');
    await ctx.update(OPERATOR, `/bot ${chat.id}`);
    assert.equal(getChat(ctx.db, chat.id).state, 'bot');

    // Answering again at all is the point; which words come back is the
    // assistant's business and is scripted elsewhere in this file.
    const before = ctx.sent.filter((m) => m.chatId === '2001').length;
    await ctx.update(2001, 'one more thing');
    assert.ok(
      ctx.sent.filter((m) => m.chatId === '2001').length > before,
      'the assistant did not take the chat back',
    );
  });

  await t.test('an escalation the assistant decides on reaches the operator too', async () => {
    const escalating = await botServer({
      replies: [{ reply: 'Passing this on.', handedOver: true, reason: 'cannot answer from the tools' }],
    });
    await escalating.update(3001, 'my card was charged twice');
    assert.match(escalating.lastTo(OPERATOR), /cannot answer from the tools/);
    assert.equal(findChat(escalating.db, 'telegram', '3001').state, 'bot',
      'the assistant service owns the handoff row; the route must not write it twice');
    await escalating.close();
  });
});
