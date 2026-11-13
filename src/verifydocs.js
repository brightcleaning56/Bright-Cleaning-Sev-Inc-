// Documents a publisher uploads for verification (licence, registration, insurance certificate). PDFs only, stored
// outside the database with a hash, and visible only to the company that uploaded them. Staff review of these files is
// a separate screen; this module records what was uploaded and when.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { now } from './store.js';
import { can } from './publishing.js';

const MAX_DOCS = 10;
const KINDS = ['license', 'registration', 'insurance', 'other'];
const safeName = n => String(n || 'document.pdf').replace(/[^\w.\- ()&#,]+/g, '_').slice(0, 160) || 'document.pdf';

export function saveVerificationDoc(store, org, user, { name, buffer, kind }) {
  if (org.kind !== 'buyer') return { ok: false, code: 403, error: 'publisher accounts only' };
  if (!can(user, 'publish')) return { ok: false, code: 403, error: 'your company has not given you permission to publish' };
  if (!buffer || buffer.length === 0) return { ok: false, code: 400, error: 'choose a file' };
  if (buffer.length > config.maxDocBytes) return { ok: false, code: 413, error: `file is larger than ${Math.round(config.maxDocBytes / 1048576)} MB` };
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, code: 400, error: 'only PDF files are accepted' };
  const docs = org.publisher?.documents || [];
  if (docs.length >= MAX_DOCS) return { ok: false, code: 409, error: `a company can keep up to ${MAX_DOCS} verification documents` };
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (docs.some(d => d.sha256 === sha256)) return { ok: false, code: 409, error: 'this exact file is already uploaded' };
  const id = 'vdoc_' + crypto.randomBytes(8).toString('hex');
  const doc = { id, name: safeName(name), kind: KINDS.includes(kind) ? kind : 'other', size: buffer.length, sha256, uploadedAt: now(), uploadedBy: user.email };
  fs.mkdirSync(config.docDir, { recursive: true });
  fs.writeFileSync(path.join(config.docDir, `${id}.pdf`), buffer);
  org.publisher = { ...(org.publisher || { status: 'unverified' }), documents: [...docs, doc] };
  store.put('orgs', org);
  store.audit({ actor: user.email, orgId: org.id, action: 'publisher.document', target: id, detail: { name: doc.name, kind: doc.kind, sha256 } });
  return { ok: true, document: doc };
}

export function verificationDocPath(org, docId) {
  const d = (org.publisher?.documents || []).find(x => x.id === docId);
  return d ? { doc: d, file: path.join(config.docDir, `${d.id}.pdf`) } : null;
}
