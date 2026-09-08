import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Symmetric encryption for the few secrets the control plane must be able to
 * read back in plaintext (gateway agent HMAC keys, upstream egress credentials).
 *
 * The key-encryption key comes from SECRET_KEY. In development it is persisted
 * next to the database with 0600 permissions so restarts keep working; in
 * production it must be supplied explicitly.
 */
function resolveKeyMaterial() {
  const fromEnv = process.env.SECRET_KEY;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (config.isProd) {
    throw Object.assign(new Error('SECRET_KEY (>=16 chars) is required in production'), {
      code: 'CONFIG_INVALID',
    });
  }
  const file = config.dbPath === ':memory:'
    ? null
    : path.join(path.dirname(path.resolve(config.dbPath)), '.jordan-secret-key');
  if (!file) return crypto.randomBytes(32).toString('base64');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const generated = crypto.randomBytes(32).toString('base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
    logger.warn('generated development SECRET_KEY', { file });
    return generated;
  }
}

let cachedKey = null;
function key() {
  if (!cachedKey) {
    cachedKey = crypto.scryptSync(resolveKeyMaterial(), 'jordan-secretbox-v1', 32);
  }
  return cachedKey;
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function open(sealed) {
  if (!sealed) return null;
  const [version, iv, tag, ct] = String(sealed).split('.');
  if (version !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch (err) {
    logger.error('secretbox open failed', { error: err.message });
    return null;
  }
}

/** Resets the cached key; used by tests that swap SECRET_KEY. */
export function _resetKeyCache() {
  cachedKey = null;
}
