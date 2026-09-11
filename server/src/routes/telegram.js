/**
 * The bot.
 *
 * Telegram is where this market already is: people buy in it, ask for help in
 * it, and send each other configs in it. It is also reachable on a phone whose
 * tunnel is down, which a support channel has to be — the moment somebody needs
 * support is the moment the thing they would use to reach a support page is not
 * working.
 *
 * Three kinds of message arrive here:
 *
 *  - a command (`/start`, `/link`, `/plans`, `/status`, `/human`), handled in
 *    code, because a command is a promise about what will happen;
 *  - anything else from a customer, handled by the assistant, unless the chat
 *    has been handed to a person — then the bot stays quiet and only records it;
 *  - a command from the operator's own chat, which is how a person answers,
 *    takes a chat back, or hands it to the assistant again.
 *
 * The webhook is authenticated twice: the URL carries a secret path segment and
 * Telegram is asked to send a secret header. Both are checked, because a URL
 * ends up in logs and proxies and a header does not.
 */

import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  openChat, getChat, appendMessage, markHandoff, resumeBot, redeemLinkCode, waitingChats,
} from '../domain/chats.js';
import { listPlans, fromMicro } from '../domain/shop.js';
import { subscriberForCustomer, entitlement } from '../domain/subscribers.js';

const CHANNEL = 'telegram';

const HELP = [
  'What I can do:',
  '/link <code> — connect this chat to your account (the storefront gives you the code)',
  '/status — your subscription at a glance',
  '/plans — what is on sale',
  '/human — hand this conversation to a person',
  '',
  'Or just tell me what is wrong and I will look into it.',
].join('\n');

/**
 * Sends a message through the Bot API.
 *
 * Injectable so tests drive the whole route without a network, and so a
 * deployment with no token still boots — it simply cannot answer.
 */
export function telegramSender(token, fetchImpl = fetch) {
  return async function send(chatId, text) {
    if (!token) {
      logger.warn('telegram send skipped: no bot token configured');
      return false;
    }
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!response.ok) {
      logger.warn('telegram send failed', { status: response.status });
      return false;
    }
    return true;
  };
}

export function telegramRoutes({ db, assistant, send, secret = config.assistant.telegram.webhookSecret }) {
  const router = Router();

  const operatorChatId = String(config.assistant.telegram.operatorChatId || '');
  const isOperator = (chatId) => operatorChatId !== '' && String(chatId) === operatorChatId;

  const notifyOperator = async (chat, reason, lastMessage) => {
    if (!operatorChatId) return;
    await send(operatorChatId, [
      `Handover · ${chat.id}`,
      `Reason: ${reason}`,
      `Account: ${chat.customer_id || 'not linked'}`,
      `They said: ${lastMessage}`,
      '',
      `Reply with:  /reply ${chat.id} your message`,
      `Give it back with:  /bot ${chat.id}`,
    ].join('\n'));
  };

  router.post(`/telegram/webhook/${secret}`, async (req, res) => {
    // Answer Telegram immediately whatever happens next: a webhook that is slow
    // or errors gets retried, and a retried update is a duplicate reply.
    res.status(200).json({ ok: true });

    if (!config.assistant.enabled) return;
    const headerSecret = req.get('x-telegram-bot-api-secret-token');
    if (secret && headerSecret !== secret) {
      logger.warn('telegram webhook rejected: bad secret header');
      return;
    }

    const message = req.body?.message;
    const chatId = message?.chat?.id;
    const text = String(message?.text || '').trim();
    if (!chatId || !text) return;

    try {
      await handle(String(chatId), text);
    } catch (error) {
      logger.error('telegram update failed', { message: error.message });
      await send(chatId, 'Something went wrong on our side. A person will look at this.').catch(() => {});
    }
  });

  async function handle(chatId, text) {
    if (isOperator(chatId) && text.startsWith('/')) {
      const handled = await operatorCommand(text);
      if (handled) return;
    }

    const chat = openChat(db, CHANNEL, chatId);
    const [command, ...rest] = text.split(/\s+/);
    const argument = rest.join(' ');

    switch (command) {
      case '/start':
        appendMessage(db, chat.id, 'user', text);
        await send(chatId, `Hello. ${HELP}`);
        return;
      case '/help':
        await send(chatId, HELP);
        return;
      case '/link':
        await link(chat, chatId, argument);
        return;
      case '/status':
        await status(chat, chatId);
        return;
      case '/plans':
        await plans(chatId);
        return;
      case '/human': {
        appendMessage(db, chat.id, 'user', text);
        markHandoff(db, chat.id, 'they asked for a person');
        await send(chatId, 'Passing you to a person now. They will see everything above.');
        await notifyOperator(getChat(db, chat.id), 'they asked for a person', text);
        return;
      }
      default:
        break;
    }

    // Already with a person: record it, tell them it landed, and stay out of
    // the way. A bot that keeps answering over an operator is the reason people
    // stop trusting the handover.
    if (chat.state === 'human') {
      appendMessage(db, chat.id, 'user', text);
      if (operatorChatId) await send(operatorChatId, `${chat.id}: ${text}`);
      return;
    }

    const result = await assistant.reply(chat, text);
    await send(chatId, result.reply);
    if (result.handedOver) await notifyOperator(getChat(db, chat.id), result.reason, text);
  }

  async function link(chat, chatId, code) {
    if (!code) {
      await send(chatId, 'Send /link followed by the code from the storefront — for example /link 481902.');
      return;
    }
    const customerId = redeemLinkCode(db, chat.id, code);
    if (!customerId) {
      await send(chatId, 'That code is not valid any more. Codes last ten minutes and work once — get a fresh one from the storefront.');
      return;
    }
    await send(chatId, 'Linked. I can see your subscription now — ask me anything about it.');
  }

  async function status(chat, chatId) {
    const linked = getChat(db, chat.id);
    if (!linked.customer_id) {
      await send(chatId, 'This chat is not linked to an account yet. Sign in on the storefront, and it gives you a code for /link.');
      return;
    }
    const subscriber = subscriberForCustomer(db, linked.customer_id);
    if (!subscriber) {
      await send(chatId, 'Your account has no subscription yet. /plans shows what is on sale.');
      return;
    }
    const state = entitlement(subscriber);
    const gb = (bytes) => `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
    await send(chatId, [
      state.entitled ? 'Active' : `Not active — ${state.reason}`,
      subscriber.quota_bytes > 0
        ? `${gb(Math.max(0, subscriber.quota_bytes - subscriber.used_bytes))} left of ${gb(subscriber.quota_bytes)}`
        : `${gb(subscriber.used_bytes)} used · unmetered`,
      `Expires ${new Date(subscriber.expires_at).toISOString().slice(0, 10)}`,
    ].join('\n'));
  }

  async function plans(chatId) {
    const available = listPlans(db);
    if (!available.length) {
      await send(chatId, 'Nothing is on sale at the moment.');
      return;
    }
    await send(chatId, [
      'On sale now:',
      ...available.map((plan) => {
        const size = plan.quota_bytes > 0 ? `${Math.round(plan.quota_bytes / 1024 ** 3)} GB` : 'unmetered';
        return `· ${plan.name} — ${size}, ${plan.duration_days} days — ${fromMicro(plan.price_micro)} USDT`;
      }),
      '',
      'Buying happens on the storefront, where the payment is watched on-chain.',
    ].join('\n'));
  }

  /** @returns true when the text was an operator command and was dealt with. */
  async function operatorCommand(text) {
    const [command, target, ...rest] = text.split(/\s+/);
    const body = rest.join(' ');

    if (command === '/waiting') {
      const waiting = waitingChats(db);
      await send(operatorChatId, waiting.length
        ? waiting.map((chat) => `${chat.id} · ${chat.handoff_reason}`).join('\n')
        : 'Nobody is waiting.');
      return true;
    }

    if (command === '/reply') {
      const chat = target ? getChat(db, target) : null;
      if (!chat) {
        await send(operatorChatId, 'No chat with that id.');
        return true;
      }
      if (!body) {
        await send(operatorChatId, 'Nothing to send.');
        return true;
      }
      appendMessage(db, chat.id, 'operator', body);
      await send(chat.channel_chat_id, body);
      return true;
    }

    if (command === '/bot') {
      const chat = target ? getChat(db, target) : null;
      if (!chat) {
        await send(operatorChatId, 'No chat with that id.');
        return true;
      }
      resumeBot(db, chat.id);
      await send(operatorChatId, `${chat.id} is back with the assistant.`);
      return true;
    }

    return false;
  }

  return router;
}
