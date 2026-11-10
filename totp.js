// Time-based one-time codes (RFC 6238) for two-step sign-in, compatible with Google Authenticator,
// Microsoft Authenticator, 1Password and similar apps. 6 digits, 30-second steps, SHA-1.
const crypto = require('crypto');
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHA.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function newSecret() { return base32Encode(crypto.randomBytes(20)); }

function codeAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}

// Accepts the current code and the one before and after it (clock drift of up to 30 seconds).
function verify(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return false;
  const counter = Math.floor(now / 1000 / 30);
  for (const d of [-1, 0, 1]) {
    const expect = codeAt(secret, counter + d);
    if (crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(c))) return true;
  }
  return false;
}

function otpauthUri(secret, account, issuer = 'Bright Clean') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { newSecret, verify, codeAt, otpauthUri, base32Encode, base32Decode };
