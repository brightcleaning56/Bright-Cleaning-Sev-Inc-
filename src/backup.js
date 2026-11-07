import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Store, now } from './store.js';

function key(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) throw new Error('BACKUP_KEY must be 64 hex chars');
  return Buffer.from(hex, 'hex');
}

/** gzip + AES-256-GCM. File = iv(12) | tag(16) | ciphertext. */
export function createBackup(store, dir, keyHex) {
  fs.mkdirSync(dir, { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(keyHex), iv);
  const plain = zlib.gzipSync(store.serialize());
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const file = path.join(dir, `buildintel-${now().replace(/[:.]/g, '-')}.bak`);
  fs.writeFileSync(file, Buffer.concat([iv, cipher.getAuthTag(), enc]));
  const checksum = store.checksum();
  pruneBackups(dir, 30);
  return { file, checksum, bytes: fs.statSync(file).size, at: now() };
}

export function readBackup(file, keyHex) {
  const buf = fs.readFileSync(file);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(keyHex), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  const s = new Store(null);
  s.load(zlib.gunzipSync(plain).toString('utf8'));
  return s;
}

/** Real restore test: decrypt the backup into a fresh store and compare checksums. */
export function restoreTest(file, expectedChecksum, keyHex) {
  try {
    const restored = readBackup(file, keyHex);
    const got = restored.checksum();
    return { ok: got === expectedChecksum, file, expectedChecksum, restoredChecksum: got,
      counts: Object.fromEntries(Object.entries(restored.data).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.keys(v).length])), at: now() };
  } catch (e) { return { ok: false, file, error: e.message, at: now() }; }
}

function pruneBackups(dir, keep) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.bak')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(dir, f));
}

// ---------------- plan-room documents: encrypted, content-addressed vault ----------------
// Each PDF is stored once under its SHA-256 (documents never change after upload), encrypted with the backup key.
// Backups are incremental; restore tests prove the files decrypt to the exact bytes the database expects.
const encBuf = (plain, keyHex) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(keyHex), iv); const e = Buffer.concat([c.update(plain), c.final()]); return Buffer.concat([iv, c.getAuthTag(), e]); };
const decBuf = (buf, keyHex) => { const d = crypto.createDecipheriv('aes-256-gcm', key(keyHex), buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28)); return Buffer.concat([d.update(buf.subarray(28)), d.final()]); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

export function backupDocuments(store, docDir, dir, keyHex) {
  const vault = path.join(dir, 'docs'); fs.mkdirSync(vault, { recursive: true });
  const out = { documents: 0, newBlobs: [], alreadyStored: 0, missingOnDisk: [], corrupted: [] };
  for (const d of store.list('documents', x => !x.removed)) {
    out.documents++;
    const src = path.join(docDir, `${d.id}.pdf`);
    if (!fs.existsSync(src)) { out.missingOnDisk.push(d.id); continue; }
    const buf = fs.readFileSync(src);
    if (sha(buf) !== d.sha256) { out.corrupted.push(d.id); continue; }      // never back up a damaged file over a good one
    const blob = path.join(vault, `${d.sha256}.enc`);
    if (fs.existsSync(blob)) { out.alreadyStored++; continue; }
    fs.writeFileSync(blob, encBuf(buf, keyHex)); out.newBlobs.push(d.sha256);
  }
  return out;
}

/** Every document record must have its blob; sampled blobs must decrypt to a PDF with the recorded fingerprint. */
export function verifyDocumentVault(store, dir, keyHex, { sample = 25 } = {}) {
  const vault = path.join(dir, 'docs');
  const docs = store.list('documents', x => !x.removed);
  const missing = docs.filter(d => !fs.existsSync(path.join(vault, `${d.sha256}.enc`))).map(d => d.id);
  const checked = [], bad = [];
  for (const d of docs.filter(x => !missing.includes(x.id)).slice(0, sample)) {
    try { const plain = decBuf(fs.readFileSync(path.join(vault, `${d.sha256}.enc`)), keyHex);
      if (sha(plain) !== d.sha256 || plain.subarray(0, 5).toString('latin1') !== '%PDF-') bad.push(d.id); else checked.push(d.id);
    } catch { bad.push(d.id); }
  }
  return { ok: !missing.length && !bad.length, documents: docs.length, missingBlobs: missing, verifiedPdfs: checked.length, failed: bad };
}

/** Disaster recovery: write every document back to disk from the vault, verified byte-for-byte. */
export function restoreDocuments(store, dir, keyHex, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const out = { restored: 0, failed: [] };
  for (const d of store.list('documents', x => !x.removed)) {
    try { const plain = decBuf(fs.readFileSync(path.join(dir, 'docs', `${d.sha256}.enc`)), keyHex);
      if (sha(plain) !== d.sha256) throw new Error('checksum');
      fs.writeFileSync(path.join(targetDir, `${d.id}.pdf`), plain); out.restored++;
    } catch { out.failed.push(d.id); }
  }
  return out;
}

// ---------------- off-site copies: any S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, Wasabi) ----------------
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
/** AWS Signature Version 4 (no SDK). Returns the Authorization header for the given request. */
export function sigV4({ method, host, path: p, query = '', headers, payloadHash, region, service = 's3', accessKeyId, secretAccessKey, amzDate }) {
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonHeaders = names.map(h => `${h}:${String(headers[Object.keys(headers).find(k => k.toLowerCase() === h)]).trim()}\n`).join('');
  const signed = names.join(';');
  const canon = [method, p, query, canonHeaders, signed, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canon).digest('hex')].join('\n');
  const kSign = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
  return { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`, signature };
}

export async function putOffsite(cfg, objectKey, body, { fetchImpl = fetch } = {}) {
  const u = new URL(cfg.endpoint);
  const p = `/${cfg.bucket}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const payloadHash = sha(body);
  const headers = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const { authorization } = sigV4({ method: 'PUT', host: u.host, path: p, headers, payloadHash, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate });
  const res = await fetchImpl(`${u.origin}${p}`, { method: 'PUT', headers: { ...headers, authorization, 'content-length': String(body.length) }, body });
  if (!res.ok) throw new Error(`off-site upload ${res.status}`);
  return { key: objectKey, bytes: body.length };
}

/** Upload the newest database backup and any document blobs not yet off-site. */
export async function syncOffsite(cfg, dir, state = {}, { fetchImpl } = {}) {
  const uploaded = [];
  const baks = fs.readdirSync(dir).filter(f => f.endsWith('.bak')).sort();
  if (baks.length) { const f = baks.at(-1); if (state.lastBak !== f) { uploaded.push(await putOffsite(cfg, `db/${f}`, fs.readFileSync(path.join(dir, f)), { fetchImpl })); state.lastBak = f; } }
  const done = new Set(state.blobs || []);
  const vault = path.join(dir, 'docs');
  for (const f of fs.existsSync(vault) ? fs.readdirSync(vault) : []) if (!done.has(f)) { uploaded.push(await putOffsite(cfg, `docs/${f}`, fs.readFileSync(path.join(vault, f)), { fetchImpl })); done.add(f); }
  state.blobs = [...done]; state.lastSyncAt = now();
  return { uploaded: uploaded.length, bytes: uploaded.reduce((n, x) => n + x.bytes, 0), state };
}
