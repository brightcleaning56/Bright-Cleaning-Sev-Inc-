import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { saveVerificationDoc, verificationDocPath } from '../src/verifydocs.js';

config.docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-vdoc-'));
const pdf = text => Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);
const setup = () => {
  const store = new Store(null);
  const org = store.put('orgs', { slug: 'gc', name: 'ABC', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const other = store.put('orgs', { slug: 'x', name: 'Other', kind: 'buyer', buyerKind: 'developer', status: 'active', settings: {} });
  const user = store.put('users', { email: 'gm@abc.test', role: 'owner', orgId: org.id });
  return { store, org, other, user };
};

test('a PDF is stored with its hash and kind; the file is written; the uploader is recorded', () => {
  const { store, org, user } = setup();
  const r = saveVerificationDoc(store, org, user, { name: 'WA license.pdf', kind: 'license', buffer: pdf('license') });
  assert.equal(r.ok, true, r.error);
  const fresh = store.get('orgs', org.id);
  assert.equal(fresh.publisher.documents.length, 1);
  assert.equal(fresh.publisher.documents[0].kind, 'license');
  assert.equal(fresh.publisher.documents[0].uploadedBy, 'gm@abc.test');
  assert.ok(fs.existsSync(path.join(config.docDir, `${r.document.id}.pdf`)));
});

test('only PDFs, no duplicates, at most ten, and only the owning company can reach a document', () => {
  const { store, org, other, user } = setup();
  assert.equal(saveVerificationDoc(store, org, user, { name: 'x.png', buffer: Buffer.from('\x89PNG') }).code, 400);
  assert.equal(saveVerificationDoc(store, org, user, { name: 'a.pdf', buffer: Buffer.alloc(0) }).code, 400);
  const first = saveVerificationDoc(store, org, user, { name: 'a.pdf', buffer: pdf('same') });
  assert.equal(saveVerificationDoc(store, store.get('orgs', org.id), user, { name: 'copy.pdf', buffer: pdf('same') }).code, 409, 'the same file is not stored twice');
  for (let i = 0; i < 9; i++) assert.equal(saveVerificationDoc(store, store.get('orgs', org.id), user, { name: `d${i}.pdf`, buffer: pdf('doc ' + i) }).ok, true);
  assert.equal(saveVerificationDoc(store, store.get('orgs', org.id), user, { name: 'eleventh.pdf', buffer: pdf('eleventh') }).code, 409);
  assert.ok(verificationDocPath(store.get('orgs', org.id), first.document.id), 'the owner can reach it');
  assert.equal(verificationDocPath(store.get('orgs', other.id), first.document.id), null, 'another company cannot');
});
