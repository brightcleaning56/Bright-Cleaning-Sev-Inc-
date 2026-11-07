import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { createRequest } from '../src/marketplace.js';
import { saveDocument } from '../src/documents.js';
import { createBackup, readBackup, backupDocuments, verifyDocumentVault, restoreDocuments, sigV4, syncOffsite } from '../src/backup.js';
import { pgTls } from '../src/pgtls.js';

const KEY = crypto.randomBytes(32).toString('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bi-bk-'));
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
function world() {
  config.docDir = tmp();
  const store = new Store(null);
  const gc = store.put('orgs', { slug: 'gc', name: 'GC', kind: 'buyer', status: 'active' });
  const { request } = createRequest(store, gc, { email: 'pm' }, { title: 'Clinic', address: '1 A', city: 'Ankeny', state: 'IA', projectType: 'medical', trades: ['flooring'], dueDate: D(9) });
  const docs = ['A2.1 Floor Plan.pdf', 'E2.01 Lighting.pdf', 'Project Manual.pdf'].map((n, i) => saveDocument(store, gc, { email: 'pm' }, request.id, { name: n, buffer: Buffer.from(`%PDF-1.4\n% sheet ${i}\n` + 'x'.repeat(5000 + i)) }).document);
  return { store, docs };
}

test('document vault: encrypted at rest, incremental, detects corrupted and missing files', () => {
  const w = world(), dir = tmp();
  const r1 = backupDocuments(w.store, config.docDir, dir, KEY);
  assert.deepEqual([r1.documents, r1.newBlobs.length, r1.alreadyStored], [3, 3, 0]);
  const blob = fs.readFileSync(path.join(dir, 'docs', r1.newBlobs[0] + '.enc'));
  assert.ok(!blob.includes(Buffer.from('%PDF'))); // not readable without the key
  assert.equal(backupDocuments(w.store, config.docDir, dir, KEY).newBlobs.length, 0); // nothing new
  fs.writeFileSync(path.join(config.docDir, w.docs[1].id + '.pdf'), '%PDF-1.4 tampered');
  fs.unlinkSync(path.join(config.docDir, w.docs[2].id + '.pdf'));
  const r3 = backupDocuments(w.store, config.docDir, tmp(), KEY);
  assert.deepEqual([r3.corrupted, r3.missingOnDisk], [[w.docs[1].id], [w.docs[2].id]]);
});

test('vault verification: every record needs its file; files must decrypt to a PDF with the recorded fingerprint', () => {
  const w = world(), dir = tmp();
  backupDocuments(w.store, config.docDir, dir, KEY);
  const v = verifyDocumentVault(w.store, dir, KEY);
  assert.deepEqual([v.ok, v.documents, v.verifiedPdfs], [true, 3, 3]);
  fs.unlinkSync(path.join(dir, 'docs', w.store.get('documents', w.docs[0].id).sha256 + '.enc'));
  assert.deepEqual(verifyDocumentVault(w.store, dir, KEY).missingBlobs, [w.docs[0].id]);
  assert.equal(verifyDocumentVault(w.store, dir, crypto.randomBytes(32).toString('hex')).ok, false); // wrong key fails, never "passes"
});

test('disaster drill: lose the server disk, restore database + drawings, every drawing byte-identical', () => {
  const w = world(), dir = tmp();
  const originals = Object.fromEntries(w.docs.map(d => [d.id, fs.readFileSync(path.join(config.docDir, d.id + '.pdf'))]));
  const b = createBackup(w.store, dir, KEY); backupDocuments(w.store, config.docDir, dir, KEY);
  fs.rmSync(config.docDir, { recursive: true }); // the disk is gone
  const restored = readBackup(b.file, KEY);
  const target = tmp();
  const r = restoreDocuments(restored, dir, KEY, target);
  assert.deepEqual([r.restored, r.failed.length], [3, 0]);
  for (const d of w.docs) { const got = fs.readFileSync(path.join(target, d.id + '.pdf')); assert.ok(got.equals(originals[d.id])); assert.equal(got.subarray(0, 5).toString(), '%PDF-'); }
});

test('off-site signing matches the AWS published Signature V4 example', () => {
  const r = sigV4({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z' });
  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('off-site sync: uploads the newest database backup and new document blobs only, signed', async () => {
  const w = world(), dir = tmp();
  createBackup(w.store, dir, KEY); backupDocuments(w.store, config.docDir, dir, KEY);
  const puts = [];
  const fetchImpl = async (url, o) => { puts.push({ url, auth: o.headers.authorization, method: o.method }); return { ok: true }; };
  const cfg = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'bi-backups', region: 'auto', accessKeyId: 'AK', secretAccessKey: 'SK' };
  const r1 = await syncOffsite(cfg, dir, {}, { fetchImpl });
  assert.equal(r1.uploaded, 4); // 1 database backup + 3 drawings
  assert.ok(puts.every(p => p.method === 'PUT' && /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request/.test(p.auth)));
  assert.ok(puts.some(p => p.url.startsWith('https://acct.r2.cloudflarestorage.com/bi-backups/db/')));
  assert.equal((await syncOffsite(cfg, dir, r1.state, { fetchImpl })).uploaded, 0); // nothing new
  await assert.rejects(syncOffsite(cfg, dir, {}, { fetchImpl: async () => ({ ok: false, status: 403 }) }), /off-site upload 403/);
});

test('database TLS: verified by default over the internet; opt-out is explicit; private network has no TLS', () => {
  assert.equal(pgTls('postgres://u:p@dpg-abc-a/db', undefined, {}).mode, 'private-network');
  const v = pgTls('postgres://u:p@dpg-abc.oregon-postgres.render.com/db', undefined, {});
  assert.deepEqual([v.mode, v.ssl.rejectUnauthorized], ['verify', true]);
  assert.equal(pgTls('postgres://x@db.neon.tech/db?sslmode=require', undefined, { PGSSL_CA: '-----BEGIN CERTIFICATE-----' }).ssl.ca, '-----BEGIN CERTIFICATE-----');
  assert.equal(pgTls('postgres://x@db.neon.tech/db', undefined, { PGSSL_NO_VERIFY: 'true' }).mode, 'no-verify');
});
