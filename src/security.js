import crypto from 'node:crypto';
import { config } from './config.js';
import { now } from './store.js';

const secret = () => {
  if (!config.appSecret || config.appSecret.length < 32) throw new Error('APP_SECRET must be set (>=32 chars)');
  return config.appSecret;
};

export function hashPassword(pw) {
  if (!pw || pw.length < 12) throw new Error('password must be at least 12 characters');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function unsign(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}

const SESSION_TTL_MS = 12 * 3600e3;
export function createSession(store, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  store.put('sessions', { id: tokenHash, userId: user.id, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
  return token;
}

export function sessionUser(store, token) {
  if (!token) return null;
  const s = store.get('sessions', crypto.createHash('sha256').update(token).digest('hex'));
  if (!s || Date.parse(s.expiresAt) < Date.now()) return null;
  const u = store.get('users', s.userId);
  return u && !u.disabled ? u : null;
}

export function revokeSession(store, token) {
  store.remove('sessions', crypto.createHash('sha256').update(token).digest('hex'));
}

// Simple fixed-window rate limiter for login + public endpoints.
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const t = Date.now(); const b = buckets.get(key);
  if (!b || b.reset < t) { buckets.set(key, { n: 1, reset: t + windowMs }); return true; }
  b.n++; return b.n <= max;
}

export function verifyStripeSignature(rawBody, header, whsec, toleranceSec = 300) {
  if (!header || !whsec) return false;
  const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')).filter(p => p.length === 2 && p[0] !== 'v1'));
  const v1s = header.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expect = crypto.createHmac('sha256', whsec).update(`${t}.${rawBody}`).digest('hex');
  return v1s.some(v => v.length === expect.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expect)));
}

export { now };
