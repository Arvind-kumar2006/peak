// Password hashing and encryption of stored integration tokens.
import { scryptSync, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { config } from './config.js';
import { kvOnce } from './db.js';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

// APP_SECRET if set, otherwise a random key generated on first run and kept in the database.
let keyPromise = null;
const getKey = () =>
  (keyPromise ??= (async () =>
    createHash('sha256')
      .update(config.appSecret || (await kvOnce('app_secret', () => randomBytes(32).toString('base64'))))
      .digest())());

export async function encrypt(obj) {
  const key = await getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export async function decrypt(text) {
  if (!text) return {};
  const key = await getKey();
  const [iv, tag, data] = text.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

export const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
