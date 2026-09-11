#!/usr/bin/env node
/**
 * The three Telegram calls that stand between a bot token and a working bot.
 *
 *   node scripts/telegram-webhook.js whoami   which chat id is yours
 *   node scripts/telegram-webhook.js set      point the bot at this deployment
 *   node scripts/telegram-webhook.js info     is it working, and if not why
 *   node scripts/telegram-webhook.js delete   stop it
 *
 * Each is a curl one-liner underneath, but the one-liner has a token in it, a
 * secret in it, and a URL that has to match the deployment exactly — which is
 * three ways to get it wrong quietly, since a misregistered webhook fails by
 * saying nothing at all.
 *
 * Reads .env, so it uses the same values the control plane is running with.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Loads .env without adding a dependency for four lines of parsing. */
function loadEnv() {
  const candidates = [
    path.resolve(here, '../../.env'), // repo root, where docker compose reads it
    path.resolve(here, '../.env'),
    path.resolve(process.cwd(), '.env'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[2].trim().replace(/^["']|["']$/g, '');
      // A real environment variable always wins over the file.
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
    return file;
  }
  return null;
}

const envFile = loadEnv();
const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const baseUrl = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const command = (process.argv[2] || 'info').toLowerCase();

const die = (message) => { console.error(`\n  ${message}\n`); process.exit(1); };

if (!token) {
  die(`No TELEGRAM_BOT_TOKEN${envFile ? ` in ${envFile}` : ' and no .env found'}.\n`
    + '  Get one from @BotFather with /newbot, then put it in .env.');
}

async function api(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => null);
  // No JSON at all is not Telegram answering: it is a proxy, a firewall or a
  // captive network in the way, which is a different problem from a bad token.
  if (!payload) {
    die(`No answer from api.telegram.org (HTTP ${response.status}).`
      + '\n  Something between this machine and Telegram is intercepting the request.');
  }
  if (!payload.ok) die(`Telegram refused ${method}: ${payload.description || `HTTP ${response.status}`}`);
  return payload.result;
}

const webhookUrl = () => `${baseUrl}/telegram/webhook/${secret}`;

switch (command) {
  case 'set': {
    if (!secret) die('No TELEGRAM_WEBHOOK_SECRET. Generate one: openssl rand -hex 24');
    if (!baseUrl) die('No PUBLIC_BASE_URL. It must be the public https address of the control plane.');
    if (!baseUrl.startsWith('https://')) die(`Telegram only delivers to https. PUBLIC_BASE_URL is ${baseUrl}`);

    await api('setWebhook', {
      url: webhookUrl(),
      secret_token: secret,
      allowed_updates: ['message'],
      // Anything Telegram queued while the bot was down is stale by now, and
      // answering it would look like the bot replying to yesterday.
      drop_pending_updates: true,
    });
    const me = await api('getMe');
    console.log(`\n  Registered. @${me.username} now delivers to:\n    ${webhookUrl()}\n`
      + `  Message @${me.username} and say /start.\n`);
    break;
  }

  case 'info': {
    const info = await api('getWebhookInfo');
    const me = await api('getMe');
    console.log(`\n  Bot:      @${me.username}`);
    console.log(`  Webhook:  ${info.url || '(none registered)'}`);
    if (baseUrl && secret && info.url && info.url !== webhookUrl()) {
      console.log(`  ${'\x1b[33m'}Mismatch: this .env expects ${webhookUrl()}\x1b[0m`);
    }
    console.log(`  Waiting:  ${info.pending_update_count} update(s)`);
    if (info.last_error_message) {
      console.log(`  ${'\x1b[33m'}Last error: ${info.last_error_message}`
        + ` (${new Date(info.last_error_date * 1000).toISOString()})\x1b[0m`);
      console.log('\n  A number that will not come down plus an error here means the control'
        + '\n  plane is not answering Telegram: check that /telegram/* reaches the API'
        + '\n  container (deploy/Caddyfile.example) and that ASSISTANT_ENABLED is true.');
    } else if (info.url) {
      console.log('  No delivery errors.');
    }
    console.log('');
    break;
  }

  case 'delete': {
    await api('deleteWebhook', { drop_pending_updates: true });
    console.log('\n  Webhook removed. The bot is plainly silent now rather than seemingly ignoring people.\n');
    break;
  }

  case 'whoami': {
    const info = await api('getWebhookInfo');
    if (info.url) {
      die('A webhook is registered, so Telegram will not hand these over here.\n'
        + '  Either read the operator id off the control plane\'s logs, or run\n'
        + '  `delete`, run `whoami`, and run `set` again.');
    }
    const updates = await api('getUpdates', { allowed_updates: ['message'], limit: 20 });
    const chats = new Map();
    for (const update of updates) {
      const chat = update.message?.chat;
      if (chat) chats.set(String(chat.id), chat);
    }
    if (!chats.size) {
      die('Nothing to read. Send the bot a message first, then run this again.');
    }
    console.log('\n  Chats that have written to this bot:\n');
    for (const [id, chat] of chats) {
      const who = chat.username ? `@${chat.username}` : [chat.first_name, chat.last_name].filter(Boolean).join(' ');
      console.log(`    ${id}\t${chat.type}\t${who || chat.title || ''}`);
    }
    console.log('\n  Yours is the one to put in TELEGRAM_OPERATOR_CHAT_ID.\n');
    break;
  }

  default:
    die('Use one of: whoami | set | info | delete');
}
