import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedGateway, seedEgress } from './helpers.js';
import { config } from '../src/config.js';
import { createSubscriber } from '../src/domain/subscribers.js';
import { createAssistant, SYSTEM_PROMPT } from '../src/services/assistant.js';
import { TOOLS, runTool, useGatewaySelector } from '../src/domain/assistant.js';
import {
  openChat, getChat, appendMessage, transcript, issueLinkCode, redeemLinkCode, markHandoff, resumeBot,
} from '../src/domain/chats.js';
import { usableGatewaysFor } from '../src/routes/public.js';

/**
 * A stand-in for the Claude client.
 *
 * Every test here drives the assistant through scripted model turns, so the
 * loop, the tools, the transcript and the handover are all exercised with no
 * network and no spend. What the model would *say* is not what these test —
 * that is an eval's job, not a unit test's.
 */
function stubClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(request) {
        // A snapshot, not the array itself: the loop keeps appending to the
        // same `messages` array, so a stored reference would show every later
        // turn too and the assertions below would be about nothing.
        calls.push(structuredClone(request));
        const next = script.shift();
        if (!next) throw new Error('the stub ran out of scripted turns');
        return next;
      },
    },
  };
}

const text = (body) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: body }],
});

const toolCall = (name, input = {}) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_${name}`, name, input }],
});

test('the tools the assistant is given', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  useGatewaySelector(usableGatewaysFor);
  const token = await ctx.login();

  const gw = await seedGateway(ctx, token);
  const egress = await seedEgress(ctx, token);
  await ctx.request('POST', `/api/v1/gateways/${gw.id}/egresses`, {
    token, body: { egressId: egress.id, priority: 10 },
  });
  ctx.db.prepare("UPDATE gateways SET ingress_status='online', ingress_latency_ms=42, ingress_checked_at=? WHERE id=?")
    .run(Date.now(), gw.id);
  ctx.db.prepare("UPDATE gateway_egress SET status='online', checked_at=? WHERE gateway_id=?")
    .run(Date.now(), gw.id);

  const register = await ctx.request('POST', '/api/v1/shop/register', {
    body: { email: 'assistant@example.com', password: 'a-long-enough-password' },
  });
  const customerToken = register.body.data.token;
  const customerId = ctx.db.prepare('SELECT id FROM customers WHERE email = ?').get('assistant@example.com').id;
  const subscriber = createSubscriber(ctx.db, {
    name: 'assistant-test',
    quotaBytes: 10 * 1024 ** 3,
    expiresAt: Date.now() + 30 * 86400000,
    customerId,
  });

  const chat = openChat(ctx.db, 'telegram', '555');
  ctx.db.prepare('UPDATE assistant_chats SET customer_id = ? WHERE id = ?').run(customerId, chat.id);
  const linked = getChat(ctx.db, chat.id);

  await t.test('a chat with no account is told how to link one, not refused', () => {
    const stranger = openChat(ctx.db, 'telegram', '999');
    const answer = runTool(ctx.db, stranger, 'get_subscription');
    assert.equal(answer.linked, false);
    assert.match(answer.note, /\/link/);
    // And the one tool that needs no account still works for them.
    assert.ok(Array.isArray(runTool(ctx.db, stranger, 'get_plans').plans));
  });

  await t.test('the subscription tool answers the question tickets actually ask', () => {
    const answer = runTool(ctx.db, linked, 'get_subscription');
    assert.equal(answer.active, true);
    assert.equal(answer.state, 'active');
    assert.equal(answer.quotaGb, 10);
    assert.equal(answer.remainingGb, 10);
  });

  await t.test('an exhausted quota is reported as exactly that', () => {
    ctx.db.prepare('UPDATE subscribers SET used_bytes = quota_bytes WHERE id = ?').run(subscriber.id);
    const answer = runTool(ctx.db, linked, 'get_subscription');
    assert.equal(answer.active, false);
    assert.equal(answer.state, 'quota-exhausted');
    assert.equal(answer.remainingGb, 0);
    ctx.db.prepare('UPDATE subscribers SET used_bytes = 0 WHERE id = ?').run(subscriber.id);
  });

  await t.test('an expired subscription is reported as expired, not as broken', () => {
    ctx.db.prepare('UPDATE subscribers SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 86400000, subscriber.id);
    assert.equal(runTool(ctx.db, linked, 'get_subscription').state, 'expired');
    ctx.db.prepare('UPDATE subscribers SET expires_at = ? WHERE id = ?')
      .run(Date.now() + 30 * 86400000, subscriber.id);
  });

  await t.test('the servers tool names and places gateways, and addresses none of them', () => {
    const answer = runTool(ctx.db, linked, 'get_servers');
    assert.equal(answer.servers.length, 1);
    const [server] = answer.servers;
    assert.equal(server.name, 'Edge A');
    assert.equal(server.ingress, 'online');
    assert.equal(server.latencyMs, 42);
    // An address in a transcript is an address in somebody's chat history.
    const serialised = JSON.stringify(answer);
    assert.ok(!serialised.includes('127.0.0.1'), 'a gateway address reached the assistant');
    assert.ok(!serialised.includes('18443'), 'a gateway port reached the assistant');
  });

  await t.test('nothing a tool returns is a credential', () => {
    const everything = JSON.stringify(
      ['get_subscription', 'get_servers', 'get_orders', 'get_plans', 'get_service_status']
        .map((name) => runTool(ctx.db, linked, name)),
    );
    const token = ctx.db.prepare('SELECT token_hash FROM subscribers WHERE id = ?').get(subscriber.id).token_hash;
    const uuid = ctx.db.prepare('SELECT uuid FROM credentials WHERE subscriber_id = ?').get(subscriber.id)?.uuid;
    assert.ok(!everything.includes(token));
    if (uuid) assert.ok(!everything.includes(uuid), 'a credential UUID reached the assistant');
    assert.ok(!everything.includes('vless://'));
    assert.ok(!everything.includes('/sub/'));
  });

  await t.test('the service status tool can tell one bad gateway from a bad day', () => {
    const answer = runTool(ctx.db, linked, 'get_service_status');
    assert.equal(answer.gatewaysEnabled, 1);
    assert.equal(answer.online, 1);
    assert.ok(Array.isArray(answer.recentTrouble));
  });

  await t.test('an unknown tool is an answer, not a crash', () => {
    assert.match(runTool(ctx.db, linked, 'refund_everything').error, /no such tool/);
  });

  await t.test('the link code is single use, short-lived, and account-bound', async () => {
    const issued = await ctx.request('POST', '/api/v1/shop/link-code', { token: customerToken });
    assert.equal(issued.status, 200);
    const { code } = issued.body.data;
    assert.match(code, /^\d{6}$/);

    const fresh = openChat(ctx.db, 'telegram', '777');
    assert.equal(redeemLinkCode(ctx.db, fresh.id, code), customerId);
    // Once.
    assert.equal(redeemLinkCode(ctx.db, fresh.id, code), null);
    // And never for a code nobody issued.
    assert.equal(redeemLinkCode(ctx.db, fresh.id, '000000'), null);

    const expired = issueLinkCode(ctx.db, customerId);
    ctx.db.prepare('UPDATE link_codes SET expires_at = ? WHERE code = ?')
      .run(Date.now() - 1000, expired.code);
    assert.equal(redeemLinkCode(ctx.db, fresh.id, expired.code), null);
  });

  await t.test('a link code needs a signed-in customer', async () => {
    const res = await ctx.request('POST', '/api/v1/shop/link-code');
    assert.equal(res.status, 401);
  });

  await t.test('the storefront is told about the bot only when there is one', async () => {
    const previous = { ...config.assistant, telegram: { ...config.assistant.telegram } };
    try {
      config.assistant.enabled = false;
      config.assistant.telegram.botUsername = 'sixvpn_support_bot';
      let res = await ctx.request('GET', '/api/v1/shop/config');
      assert.equal(res.body.data.supportBot, null, 'a disabled assistant was advertised');

      config.assistant.enabled = true;
      config.assistant.telegram.botUsername = '';
      res = await ctx.request('GET', '/api/v1/shop/config');
      assert.equal(res.body.data.supportBot, null, 'a bot with no handle was advertised');

      config.assistant.telegram.botUsername = 'sixvpn_support_bot';
      res = await ctx.request('GET', '/api/v1/shop/config');
      assert.deepEqual(res.body.data.supportBot, { telegram: 'sixvpn_support_bot' });
    } finally {
      Object.assign(config.assistant, previous);
    }
  });
});

test('the assistant loop', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  useGatewaySelector(usableGatewaysFor);

  const chat = openChat(ctx.db, 'telegram', '100');

  await t.test('answers in one turn when it needs no tool', async () => {
    const client = stubClient([text('We are a VPN service. Ask me anything.')]);
    const assistant = createAssistant({ db: ctx.db, client });
    const result = await assistant.reply(chat, 'what is this?');
    assert.equal(result.reply, 'We are a VPN service. Ask me anything.');
    assert.equal(result.handedOver, false);
  });

  await t.test('reads the account before answering about it', async () => {
    const client = stubClient([
      toolCall('get_subscription'),
      text('Your data ran out. Top up and it works again.'),
    ]);
    const assistant = createAssistant({ db: ctx.db, client });
    const result = await assistant.reply(chat, 'it will not connect');

    assert.equal(result.reply, 'Your data ran out. Top up and it works again.');
    // Second request carries the tool result the first one asked for.
    const second = client.calls[1];
    const results = second.messages.at(-1).content;
    assert.equal(results[0].type, 'tool_result');
    assert.equal(results[0].tool_use_id, 'tu_get_subscription');
  });

  await t.test('sends the instructions as a cached prefix, every time', async () => {
    const client = stubClient([text('hello')]);
    const assistant = createAssistant({ db: ctx.db, client });
    await assistant.reply(chat, 'hello');
    const [request] = client.calls;
    assert.equal(request.system[0].text, SYSTEM_PROMPT);
    // Without this the whole prompt is billed at full rate on every message.
    assert.deepEqual(request.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(request.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  });

  await t.test('the transcript is what an operator will read', async () => {
    const fresh = openChat(ctx.db, 'telegram', '101');
    const client = stubClient([text('I have checked and it looks fine.')]);
    const assistant = createAssistant({ db: ctx.db, client });
    await assistant.reply(fresh, 'is my account ok?');

    const rows = transcript(ctx.db, fresh.id);
    assert.deepEqual(rows.map((row) => row.role), ['user', 'assistant']);
    assert.equal(rows[0].body, 'is my account ok?');
  });

  await t.test('an operator\'s words are in the history, marked as theirs', async () => {
    const fresh = openChat(ctx.db, 'telegram', '102');
    appendMessage(ctx.db, fresh.id, 'user', 'my payment is stuck');
    appendMessage(ctx.db, fresh.id, 'operator', 'I refunded it by hand.');
    const client = stubClient([text('ok')]);
    const assistant = createAssistant({ db: ctx.db, client });
    await assistant.reply(fresh, 'thanks');

    const sent = client.calls[0].messages.map((m) => m.content).join(' | ');
    assert.match(sent, /\[support agent\]: I refunded it by hand\./);
  });

  await t.test('handing over is recorded, announced and irreversible from the bot side', async () => {
    const fresh = openChat(ctx.db, 'telegram', '103');
    const client = stubClient([
      toolCall('escalate_to_human', { reason: 'they want a refund' }),
      text('I cannot do refunds myself — a person will pick this up.'),
    ]);
    const assistant = createAssistant({ db: ctx.db, client });
    const result = await assistant.reply(fresh, 'I want my money back');

    assert.equal(result.handedOver, true);
    assert.equal(result.reason, 'they want a refund');
    assert.equal(getChat(ctx.db, fresh.id).state, 'human');

    const events = ctx.db.prepare("SELECT * FROM events WHERE type='support.handoff' AND target_id=?")
      .all(fresh.id);
    assert.equal(events.length, 1, 'the operator gets exactly one handover, not none and not two');
  });

  await t.test('a loop ends in a person rather than in silence', async () => {
    const fresh = openChat(ctx.db, 'telegram', '104');
    // A model that keeps asking for the same thing: seven turns, ceiling is six.
    const client = stubClient(Array.from({ length: 7 }, () => toolCall('get_plans')));
    const assistant = createAssistant({ db: ctx.db, client });
    const result = await assistant.reply(fresh, 'hello?');

    assert.equal(result.handedOver, true);
    assert.equal(getChat(ctx.db, fresh.id).state, 'human');
    assert.match(result.reply, /person/);
    assert.equal(client.calls.length, 6, 'the ceiling did not hold');
  });

  await t.test('an empty answer is a handover, not an empty message', async () => {
    const fresh = openChat(ctx.db, 'telegram', '105');
    const client = stubClient([{ stop_reason: 'end_turn', content: [] }]);
    const assistant = createAssistant({ db: ctx.db, client });
    const result = await assistant.reply(fresh, 'hello?');
    assert.equal(result.handedOver, true);
    assert.ok(result.reply.length > 0);
  });

  await t.test('a handed-over chat can be given back, by an operator', () => {
    const fresh = openChat(ctx.db, 'telegram', '106');
    markHandoff(ctx.db, fresh.id, 'because');
    assert.equal(getChat(ctx.db, fresh.id).state, 'human');
    resumeBot(ctx.db, fresh.id);
    assert.equal(getChat(ctx.db, fresh.id).state, 'bot');
  });
});

test('the assistant is off unless it is configured', async (t) => {
  await t.test('no API key means no assistant, whatever the flag says', () => {
    // The config module reads the environment at import, so this asserts the
    // rule rather than re-importing: enabled is the AND of both.
    assert.equal(typeof config.assistant.enabled, 'boolean');
    if (!process.env.ANTHROPIC_API_KEY) {
      assert.equal(config.assistant.enabled, false, 'an assistant with no key would fail on first message');
    }
  });
});
