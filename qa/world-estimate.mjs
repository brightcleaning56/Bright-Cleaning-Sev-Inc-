import '../test/_env.js';
import { fileURLToPath } from 'node:url';
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
import { Store } from '../src/store.js';
import { createServer, bootstrap } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { createRequest } from '../src/marketplace.js';
import { saveDocument } from '../src/documents.js';
import { config } from '../src/config.js';
config.docDir = process.env.DOC_DIR || config.docDir;
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const s = new Store(null);
const gc = s.put('orgs', { slug: 'gc', name: 'Acme GC', kind: 'buyer', status: 'active', publisher: { status: 'verified', note: 'demo: verified' }, settings: {} });
s.put('users', { email: 'pm@acme.test', role: 'owner', orgId: gc.id, passwordHash: hashPassword('demo password 123') });
const sub = s.put('orgs', { slug: 'floor', name: 'Prairie Flooring', kind: 'subscriber', trades: ['flooring'], territories: ['IA'], status: 'active', legal: { name: 'Prairie Flooring LLC', postalAddress: '1 Main, Ankeny IA' }, settings: {}, subscription: { plan: 'local', status: 'active' } });
s.put('users', { email: 'est@prairie.test', role: 'owner', orgId: sub.id, passwordHash: hashPassword('demo password 123') });
const { request } = createRequest(s, gc, { email: 'pm@acme.test' }, { title: 'Clinic flooring', address: '1 Main', city: 'Ankeny', state: 'IA', projectType: 'medical', trades: ['flooring'], dueDate: D(9) });
const doc = saveDocument(s, gc, { email: 'pm@acme.test' }, request.id, { name: 'A2.1 Level 1 Floor Plan.pdf', buffer: (await import('node:fs')).readFileSync(FIX + 'A2.1 - Level 1 Floor Plan GEOM.pdf') }).document;
s.tput('analyses', sub.id, { documentId: doc.id, requestId: request.id, documentName: doc.name, model: 'claude-sonnet-5-5', status: 'verified', verifiedBy: 'est@prairie.test', verifiedAt: new Date().toISOString(),
  result: { confidence: 'high', rooms: [{ number: '101', name: 'LOBBY', level: 'Level 1', areaSqFt: 2450, basis: 'printed', sheet: 'A2.1' }, { number: '102', name: 'EXAM', level: 'Level 1', areaSqFt: 1200, basis: 'printed', sheet: 'A2.1' }],
    finishes: [{ item: 'LVT-1', location: 'Exam', sheet: 'A6.1' }], scopes: [], notes: [], sheets: [], totals: { roomsFound: 2, roomsWithPrintedArea: 2, printedAreaSqFt: 3650 } } });
bootstrap(s); // same startup as production (includes the project-core backfill)
createServer(s).listen(Number(process.env.QA_PORT), () => console.log('up'));
