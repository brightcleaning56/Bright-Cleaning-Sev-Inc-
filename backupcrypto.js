// Encrypts database backups at rest (AES-256-GCM). Turned on by setting BACKUP_KEY in Render.
// Without BACKUP_KEY backups stay plain copies, as before. Keep the key somewhere other than the backups themselves:
// a backup without its key cannot be opened.
const crypto = require('crypto'), fs = require('fs');
const MAGIC = Buffer.from('BCENC1');

function keyFromEnv() {
  const k = process.env.BACKUP_KEY || '';
  return k ? crypto.createHash('sha256').update(k).digest() : null;
}

function encryptFile(src, dest, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(fs.readFileSync(src)), c.final()]);
  fs.writeFileSync(dest, Buffer.concat([MAGIC, iv, c.getAuthTag(), body]));
}

// Throws if the key is wrong or the file was changed (GCM authentication).
function decryptBuffer(buf, key) {
  if (buf.length < 34 || !buf.subarray(0, 6).equals(MAGIC)) throw new Error('Not an encrypted Bright Clean backup.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(6, 18));
  d.setAuthTag(buf.subarray(18, 34));
  return Buffer.concat([d.update(buf.subarray(34)), d.final()]);
}

module.exports = { keyFromEnv, encryptFile, decryptBuffer };
