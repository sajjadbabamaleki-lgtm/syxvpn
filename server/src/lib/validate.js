import { z } from 'zod';
import { invalidInput } from './errors.js';

/** Express middleware factory: validates and *replaces* the given request part. */
export function validate(schema, part = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[part] ?? {});
    if (!result.success) {
      return next(invalidInput(result.error.issues.map((i) => ({
        path: i.path.join('.') || '(root)',
        message: i.message,
        code: i.code,
      }))));
    }
    // req.query is a getter in Express 5; keep the parsed copy alongside.
    if (part === 'query') req.validatedQuery = result.data;
    else req[part] = result.data;
    return next();
  };
}

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

/** Hostname, IPv4 or bracket-free IPv6 literal. Rejects URLs and ports. */
export const hostField = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((v) => {
    if (IPV4.test(v)) return v.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
    if (v.includes(':')) return /^[0-9a-fA-F:]+$/.test(v); // IPv6 literal
    return HOSTNAME.test(v);
  }, 'must be a hostname, IPv4 or IPv6 address');

export const portField = z.coerce.number().int().min(1).max(65535);
export const idField = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/, 'invalid id');
export const nameField = z.string().trim().min(1).max(64);
export const regionField = z.string().trim().min(2).max(32);
export const wsPathField = z
  .string()
  .trim()
  .max(128)
  .regex(/^\/[A-Za-z0-9._~\-/]*$/, 'must start with / and contain URL-safe characters');
export const uuidField = z.string().uuid();

export { z };
