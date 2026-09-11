/**
 * The support assistant: the loop, the instructions, and the limits.
 *
 * It answers from the tools in `domain/assistant.js` or it hands over. There is
 * no third option, and the system prompt says so in as many words — a support
 * bot that fills a gap with a plausible sentence is worse than one that says "a
 * person will take this", because the plausible sentence is what a customer
 * acts on.
 *
 * The loop is written out rather than taken from the SDK's tool runner because
 * three things here have to be ours: the transcript is persisted per turn (an
 * operator reads it when a chat is handed over), the iteration ceiling is hard,
 * and the whole thing has to be drivable in tests with a stub client and no
 * network.
 *
 * Cost, at the numbers this is sized for: the instructions and tool schemas are
 * one stable prefix and are cached, so a conversation costs a few cents. What
 * makes it cheap is that it is *short* — the assistant reads state and answers,
 * rather than reasoning its way around not having any.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { TOOLS, runTool } from '../domain/assistant.js';
import { appendMessage, markHandoff, transcript } from '../domain/chats.js';

/** A turn that has not finished by here is looping; stop and hand over. */
const MAX_ITERATIONS = 6;

/** How much of the conversation the model is shown. Support threads are short. */
const HISTORY_TURNS = 20;

export const SYSTEM_PROMPT = `You are the support assistant for a VPN service. You answer in the customer's own language — if they write Persian, answer Persian; if English, English. Keep replies short: two or three sentences, no lists unless you are giving steps.

WHAT YOU CAN DO
You have tools that read this customer's real account and the real state of the servers. Use them before answering anything specific. Never state a fact about an account, an order or a server that a tool did not just tell you.

WHAT YOU MUST NOT DO
- Do not invent an explanation. If the tools do not explain it, hand over.
- Do not promise a refund, an extension, a discount or a credit. You cannot give one. Hand over.
- Do not ask for a password, a subscription link, a config line or a payment receipt. You never need them.
- Do not claim an outage unless get_service_status shows one.

HANDING OVER
Call escalate_to_human when: you cannot answer from the tools, money or access would have to change, the person asks for a human, or they are angry. Tell them plainly that a person will pick it up — do not hand over silently and do not keep talking as if you had solved it.

WHAT TICKETS USUALLY TURN OUT TO BE
- "It will not connect" is most often an expired subscription or an exhausted quota. get_subscription says which.
- "It was working yesterday" is usually one gateway going degraded. get_servers says which ones are healthy; tell them to turn Automatic on so the app picks another.
- "I paid and nothing happened" is usually confirmations still arriving. get_orders gives the count and how many are needed; a TRON transfer normally settles in a couple of minutes.
- "It is slow" is a gateway with high latency or a degraded route. Suggest Automatic, or a different country if they pinned one.
- Someone with no linked account cannot be looked up at all. Ask them to link it — the storefront gives them a code for /link.

The app: one switch, a VPN tab that picks a server for them, a Configs tab for configs they added themselves, and a Support tab with a diagnostics block they can copy. Encrypted DNS is a setting on the Account tab. Configs also work in other apps (v2rayNG, Hiddify, NPV Tunnel) — the subscription link or a single config line, both are on the storefront.`;

/**
 * @param client an Anthropic SDK client, or anything with the same
 *   `messages.create` shape. Injected so tests run without a network.
 */
export function createAssistant({ db, client, model = config.assistant.model, effort = config.assistant.effort }) {
  /**
   * One turn: the customer's message in, the assistant's reply out.
   *
   * @returns {Promise<{reply: string, handedOver: boolean, reason: string|null}>}
   */
  async function reply(chat, userText) {
    appendMessage(db, chat.id, 'user', userText);

    const messages = transcript(db, chat.id, HISTORY_TURNS).map((row) => ({
      role: row.role === 'assistant' ? 'assistant' : 'user',
      // An operator's own words are the customer's context too, and the model
      // must not mistake them for its own: they are labelled, not hidden.
      content: row.role === 'operator' ? `[support agent]: ${row.body}` : row.body,
    }));

    let handedOver = false;
    let reason = null;
    const conversation = [...messages];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        // The instructions and the tool schemas never change between requests,
        // so they are the cached prefix; the conversation goes after it.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        thinking: { type: 'adaptive' },
        // A support chat is latency-sensitive and the questions are not hard;
        // the depth that pays off on a coding task costs seconds here.
        output_config: { effort },
        tools: TOOLS,
        messages: conversation,
      });

      conversation.push({ role: 'assistant', content: response.content });

      if (response.stop_reason !== 'tool_use') {
        const text = textOf(response);
        const answer = text || 'Sorry — I could not put that into words. A person will take this.';
        if (!text) {
          markHandoff(db, chat.id, 'the assistant produced no answer');
          handedOver = true;
          reason = 'the assistant produced no answer';
        }
        appendMessage(db, chat.id, 'assistant', answer);
        return { reply: answer, handedOver, reason };
      }

      const results = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const output = runTool(db, chat, block.name, block.input, {
          onEscalate(why) {
            handedOver = true;
            reason = why;
            markHandoff(db, chat.id, why);
          },
        });
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(output),
        });
      }
      // Every result in one user message: splitting them teaches the model to
      // stop asking for more than one thing at a time.
      conversation.push({ role: 'user', content: results });
    }

    // Out of iterations. Something is looping, and the customer has been
    // waiting through all of it.
    const why = 'the assistant could not finish this on its own';
    markHandoff(db, chat.id, why);
    const answer = 'I have not been able to work this one out. I am passing it to a person now.';
    appendMessage(db, chat.id, 'assistant', answer);
    logger.warn('assistant hit its iteration ceiling', { chatId: chat.id });
    return { reply: answer, handedOver: true, reason: why };
  }

  return { reply };
}

function textOf(response) {
  return (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
