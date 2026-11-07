// Authenticator-app MFA (TOTP, RFC 6238: 30-second steps, 6 digits, HMAC-SHA1) for platform staff. Secrets are stored
// encrypted with a key derived from APP_SECRET. A code can be used once (replay refused).
import crypto from 'node:crypto';
import { config } from '../config.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32 = buf => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const unbase32 = s => { let bits = ''; for (const c of String(s).toUpperCase().replace(/=+$/, '')) { const v = B32.indexOf(c); if (v < 0) throw new Error('bad secret'); bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
export function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const key = () => crypto.createHash('sha256').update('bi-mfa:' + config.appSecret).digest();
export const seal = secret => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv); const e = Buffer.concat([c.update(secret, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64'); };
const open = sealed => { const b = Buffer.from(sealed, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); };
export const newSecret = () => base32(crypto.randomBytes(20));
export const otpauthUri = (email, secret) => `otpauth://totp/BUILDINTEL:${encodeURIComponent(email)}?secret=${secret}&issuer=BUILDINTEL&algorithm=SHA1&digits=6&period=30`;
/** Check a code against a sealed secret (±1 step for clock drift). Returns the step used, or null. Refuses reuse. */
export function checkCode(sealed, code, lastStep = -1) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const secret = open(sealed), now = Math.floor(Date.now() / 30000);
  for (const st of [now, now - 1, now + 1]) if (st > lastStep && crypto.timingSafeEqual(Buffer.from(totp(secret, st)), Buffer.from(String(code)))) return st;
  return null;
}
