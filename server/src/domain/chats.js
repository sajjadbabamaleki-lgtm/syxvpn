/**
 * Support conversations: who is on the other end, and who is answering.
 *
 * A chat is a row and a transcript. The row carries the only piece of state
 * that matters operationally — `state`, which is `bot` while the assistant
 * answers and `human` once it has handed over. Nothing puts a chat back to
 * `bot` except an operator saying so: a person who asked for a human and keeps
 * getting a machine has been told their request does not count.
 */

import crypto from 'node:crypto';
import { EVENT, recordEvent } from './events.js';

/** How long a storefront-issued link code is good for. */
const LINK_CODE_TTL_MS = 10 * 60 * 1000;

export function findChat(db, channel, channelChatId) {
  return db.prepare('SELECT * FROM assistant_chats WHERE channel = ? AND channel_chat_id = ?')
    .get(channel, String(channelChatId)) || null;
}

export function getChat(db, id) {
  return db.prepare('SELECT * FROM assistant_chats WHERE id = ?').get(id) || null;
}

/** The chat for this channel conversation, created on first contact. */
export function openChat(db, channel, channelChatId) {
  const existing = findChat(db, channel, channelChatId);
  if (existing) return existing;
  const now = Date.now();
  const id = `cht_${crypto.randomBytes(6).toString('hex')}`;
  db.prepare(`INSERT INTO assistant_chats
      (id,channel,channel_chat_id,customer_id,state,created_at,updated_at)
      VALUES (?,?,?,NULL,'bot',?,?)`)
    .run(id, channel, String(channelChatId), now, now);
  return getChat(db, id);
}

export function appendMessage(db, chatId, role, body) {
  db.prepare('INSERT INTO assistant_messages (chat_id,role,body,created_at) VALUES (?,?,?,?)')
    .run(chatId, role, String(body).slice(0, 4000), Date.now());
  db.prepare('UPDATE assistant_chats SET updated_at = ? WHERE id = ?').run(Date.now(), chatId);
}

/** The last [limit] messages, oldest first — the order a conversation is read in. */
export function transcript(db, chatId, limit = 20) {
  return db.prepare('SELECT role, body, created_at FROM assistant_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?')
    .all(chatId, limit)
    .reverse();
}

/**
 * Hands a chat to a person.
 *
 * Idempotent on purpose: the assistant may decide to escalate twice in one
 * turn, and an operator should see one handoff, not two.
 */
export function markHandoff(db, chatId, reason) {
  const chat = getChat(db, chatId);
  if (!chat || chat.state === 'human') return chat;
  const now = Date.now();
  db.prepare("UPDATE assistant_chats SET state='human', handoff_reason=?, handoff_at=?, updated_at=? WHERE id=?")
    .run(String(reason).slice(0, 500), now, now, chatId);
  recordEvent(db, {
    type: EVENT.SUPPORT_HANDOFF,
    severity: 'warning',
    targetType: 'chat',
    targetId: chatId,
    message: `Support chat handed to a person: ${reason}`,
    data: { customerId: chat.customer_id },
  });
  return getChat(db, chatId);
}

/** Gives a chat back to the assistant. Only an operator does this. */
export function resumeBot(db, chatId) {
  db.prepare("UPDATE assistant_chats SET state='bot', handoff_reason=NULL, handoff_at=NULL, updated_at=? WHERE id=?")
    .run(Date.now(), chatId);
  return getChat(db, chatId);
}

/** Chats currently waiting on a person, longest first. */
export function waitingChats(db, limit = 20) {
  return db.prepare("SELECT * FROM assistant_chats WHERE state='human' ORDER BY handoff_at LIMIT ?").all(limit);
}

/**
 * A short code that proves, once, which account a chat belongs to.
 *
 * Issued to a signed-in storefront session and typed into the bot. Six digits
 * is enough because it lives ten minutes, is single-use, and is bound to the
 * account that asked for it — guessing one wins nothing but somebody else's
 * unused code.
 */
export function issueLinkCode(db, customerId) {
  const now = Date.now();
  // Clear this customer's earlier codes: two live codes for one account is one
  // more than anybody needs.
  db.prepare('DELETE FROM link_codes WHERE customer_id = ?').run(customerId);
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare('INSERT INTO link_codes (code,customer_id,created_at,expires_at,used_at) VALUES (?,?,?,?,NULL)')
    .run(code, customerId, now, now + LINK_CODE_TTL_MS);
  return { code, expiresAt: now + LINK_CODE_TTL_MS };
}

/**
 * Spends a link code and attaches the chat to that account.
 *
 * @returns the customer id, or null when the code is unknown, spent or stale.
 */
export function redeemLinkCode(db, chatId, code) {
  const now = Date.now();
  const row = db.prepare('SELECT * FROM link_codes WHERE code = ?').get(String(code).trim());
  if (!row || row.used_at || row.expires_at <= now) return null;
  db.prepare('UPDATE link_codes SET used_at = ? WHERE code = ?').run(now, row.code);
  db.prepare('UPDATE assistant_chats SET customer_id = ?, updated_at = ? WHERE id = ?')
    .run(row.customer_id, now, chatId);
  return row.customer_id;
}

/** Forgets which account a chat belongs to. The transcript stays. */
export function unlinkChat(db, chatId) {
  db.prepare('UPDATE assistant_chats SET customer_id = NULL, updated_at = ? WHERE id = ?')
    .run(Date.now(), chatId);
  return getChat(db, chatId);
}
