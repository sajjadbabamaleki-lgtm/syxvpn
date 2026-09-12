/**
 * The one message this deployment sends: a sign-in code.
 *
 * Off until a relay is configured. A control plane that thinks it is sending
 * mail and is not is worse than one that says it cannot: the app would open a
 * code field for a code that never arrives, which is exactly the failure this
 * module exists to make impossible. `mailEnabled()` is what the route asks
 * before it offers to send anything.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendMail } from '../lib/smtp.js';

export const mailEnabled = () => Boolean(config.mail.host && config.mail.from);

export async function sendLoginCode(email, code) {
  const minutes = Math.round(config.mail.codeTtlMs / 60000);
  const text = [
    `${code}`,
    '',
    `This is your SYX VPN code. It is good for ${minutes} minutes and works once.`,
    'If you did not ask for it, somebody typed your address by mistake — nothing',
    'has been opened and there is nothing to do.',
  ].join('\n');

  await sendMail({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    user: config.mail.user,
    pass: config.mail.pass,
    from: config.mail.from,
    to: email,
    subject: `${code} is your SYX VPN code`,
    text,
  });
  // The address, never the code: a log is not a place a credential belongs.
  logger.info('sign-in code sent', { to: email });
}
