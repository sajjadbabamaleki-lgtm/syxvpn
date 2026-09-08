#!/usr/bin/env node
/** Prints a scrypt hash for ADMIN_PASSWORD_HASH. Usage: node scripts/hash-password.js */
import readline from 'node:readline';
import { hashPassword } from '../src/lib/crypto.js';

const arg = process.argv[2];
if (arg) {
  process.stdout.write(`${hashPassword(arg)}\n`);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
rl.question('Password: ', (answer) => {
  rl.close();
  if (!answer || answer.length < 12) {
    process.stderr.write('Password must be at least 12 characters\n');
    process.exit(1);
  }
  process.stdout.write(`${hashPassword(answer)}\n`);
});
