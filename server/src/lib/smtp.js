/**
 * Enough SMTP to send one short message.
 *
 * A dependency was not added for this. The whole job is: open the socket, say
 * hello, authenticate, name a sender and a recipient, and push a few hundred
 * bytes of text — and every library that does it also does attachments,
 * templating, connection pools and OAuth, none of which this deployment will
 * ever ask for. What it does need is to fail loudly and quickly, which is the
 * part a general-purpose client makes hardest to see.
 *
 * It speaks implicit TLS (port 465) and STARTTLS (587), AUTH LOGIN and AUTH
 * PLAIN. That covers Gmail, Fastmail, Zoho, Brevo, Postmark and every ordinary
 * relay. It does not speak plaintext: a password and a customer's address are
 * not going over a socket in the clear, even on a private network.
 */

import net from 'node:net';
import tls from 'node:tls';

/** One reply: its code, and every line of it. A hyphen means more is coming. */
function parseReply(buffer) {
  const lines = buffer.split(/\r?\n/).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (!/^\d{3} /.test(last)) return null;
  return { code: Number(last.slice(0, 3)), text: lines.join('\n') };
}

/**
 * A conversation over one socket: write a line, wait for the reply, check it.
 *
 * The timeout covers the whole exchange rather than each step. A relay that
 * answers every command slowly and never finishes is the failure worth
 * bounding, and a per-step timer never catches it.
 */
function talk(socket, timeoutMs) {
  let buffer = '';
  let waiting = null;
  let failure = null;

  const settle = (err) => {
    failure = err;
    if (waiting) {
      const { reject } = waiting;
      waiting = null;
      reject(err);
    }
  };

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    const reply = parseReply(buffer);
    if (reply && waiting) {
      buffer = '';
      const { resolve } = waiting;
      waiting = null;
      resolve(reply);
    }
  });
  socket.on('error', settle);
  socket.on('close', () => settle(new Error('SMTP connection closed early')));
  const timer = setTimeout(() => {
    settle(new Error(`SMTP timed out after ${timeoutMs}ms`));
    socket.destroy();
  }, timeoutMs);
  timer.unref?.();

  const read = () => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const reply = parseReply(buffer);
    if (reply) {
      buffer = '';
      return resolve(reply);
    }
    waiting = { resolve, reject };
    return undefined;
  });

  return {
    read,
    async send(line, expected) {
      socket.write(`${line}\r\n`);
      const reply = await read();
      if (expected && !expected.includes(reply.code)) {
        throw new Error(`SMTP ${line.split(' ')[0]} refused: ${reply.text}`);
      }
      return reply;
    },
    async expect(expected) {
      const reply = await read();
      if (!expected.includes(reply.code)) throw new Error(`SMTP said: ${reply.text}`);
      return reply;
    },
    done() {
      clearTimeout(timer);
    },
  };
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/** Headers and body, with the one escaping rule SMTP has: a leading dot. */
export function buildMessage({ from, to, subject, text, date = new Date() }) {
  const body = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return [
    `From: ${from}`,
    `To: ${to}`,
    // Anything outside ASCII has to be announced, or the subject arrives as
    // mojibake in half the clients that read it.
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@syxvpn.pro>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n');
}

export async function sendMail({
  host,
  port = 465,
  secure = port === 465,
  user,
  pass,
  from,
  to,
  subject,
  text,
  timeoutMs = 15000,
}) {
  if (!host) throw new Error('no SMTP host configured');

  let socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  await new Promise((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });

  let wire = talk(socket, timeoutMs);
  try {
    await wire.expect([220]);
    const helo = 'syxvpn';
    await wire.send(`EHLO ${helo}`, [250]);

    if (!secure) {
      await wire.send('STARTTLS', [220]);
      wire.done();
      // The upgraded socket is a new stream; the old reader would keep the
      // encrypted bytes to itself.
      socket = tls.connect({ socket, host, servername: host });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      wire = talk(socket, timeoutMs);
      await wire.send(`EHLO ${helo}`, [250]);
    }

    if (user) {
      // AUTH LOGIN first: it is what the relays people actually use accept,
      // and PLAIN is the fallback for the ones that refuse it.
      const auth = await wire.send('AUTH LOGIN', [334, 500, 502, 504]);
      if (auth.code === 334) {
        await wire.send(b64(user), [334]);
        await wire.send(b64(pass), [235]);
      } else {
        await wire.send(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235]);
      }
    }

    // The envelope carries the address alone, never the display name.
    const envelopeFrom = /<([^>]+)>/.exec(from)?.[1] || from;
    await wire.send(`MAIL FROM:<${envelopeFrom}>`, [250]);
    await wire.send(`RCPT TO:<${to}>`, [250, 251]);
    await wire.send('DATA', [354]);
    socket.write(`${buildMessage({ from, to, subject, text })}\r\n.\r\n`);
    await wire.expect([250]);
    await wire.send('QUIT', [221, 250]).catch(() => {});
  } finally {
    wire.done();
    socket.destroy();
  }
  return true;
}
