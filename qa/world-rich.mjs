import '../test/_env.js';
import { fileURLToPath } from 'node:url';
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
import { Store } from '../src/store.js';
import { ingestPermits } from '../src/permits.js';
import { createServer, bootstrap } from '../src/server.js';
import { seedSources } from '../src/sources/registry.js';
import { hashPassword } from '../src/security.js';
import { createRequest } from '../src/marketplace.js';
import { saveDocument } from '../src/documents.js';
import { config } from '../src/config.js';
import fs from 'node:fs';
import { normName } from '../src/domain.js';
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const s = new Store(null); seedSources(s);
const src = { id: 'src_wa', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'https://data.seattle.gov' };
ingestPermits(s, src, [
  { permitId: 'S1', address: '400 Pine St', permitType: 'New', description: 'New 5-story Class A office building with structured parking and tenant build-outs', issuedDate: D(-20), status: 'Issued', valuation: '48500000', squareFeet: '128000', contractor: 'Sellen Construction Co Inc', owner: 'Pine Street Development LLC', architect: 'Carter & Reeves Architects', lat: 47.612, lng: -122.334 },
  { permitId: 'S2', address: '400 Pine Street', permitType: 'Addition/Alteration', description: 'Tenant improvement, office', issuedDate: D(-5), status: 'Issued', valuation: '300000', contractor: 'Sellen Construction Co Inc' },
  { permitId: 'S3', address: '12 Mercer St', permitType: 'Addition/Alteration', description: 'Commercial reroof', appliedDate: D(-3), status: 'In Review', valuation: '150000', contractor: 'Centimark' },
]);
const co = s.put('companies', { name: 'Sellen Construction', normName: normName('Sellen Construction Co Inc'), website: 'https://www.sellen.com' });
s.put('contacts', { companyId: co.id, name: 'Preconstruction Team', role: 'Chief Estimator', email: 'precon@sellen.example', status: 'source_confirmed', evidenceUrl: 'https://www.sellen.com/contact' });
s.put('licenses', { id: 'WA:' + normName('Sellen Construction Co Inc'), state: 'WA', normName: normName('Sellen Construction Co Inc'), found: true, licenseNumber: 'SELLECC999', status: 'ACTIVE', active: true, phone: '2065550100', checkedAt: new Date().toISOString(), sourceUrl: 'https://data.wa.gov/x' });
s.put('signals', { id: 'lu:1', kind: 'land_use_application', state: 'WA', city: 'Seattle', file: '3041234-LU', address: '1501 4TH AVE', title: 'Land use application for a 24-story office tower', type: 'Commercial', status: 'Reviews In Process', introDate: D(-30), url: 'https://seattle.gov/x' });
const bc = s.put('orgs', { slug: 'bc', name: 'Bright Cleaning Sev Inc.', status: 'onboarding', legal: {}, settings: {}, subscription: { plan: 'internal', status: 'active' } });
s.put('users', { email: 'eric@bc.test', role: 'platform_owner', orgId: bc.id, passwordHash: hashPassword('demo password 123') });
const sub = s.put('orgs', { slug: 'sub', name: 'Emerald Glass', kind: 'subscriber', trade: 'Glazing', trades: ['cleaning', 'glazing'], territories: ['WA'], status: 'active', settings: {}, subscription: { plan: 'trial', status: 'trialing', trialEndsAt: new Date(Date.now() + 9 * 864e5).toISOString() } });
s.put('users', { email: 'sub@em.test', role: 'owner', orgId: sub.id, passwordHash: hashPassword('demo password 123') });
const buyer = s.put('orgs', { slug: 'gc', name: 'Acme PM', kind: 'buyer', buyerKind: 'property_manager', status: 'active', publisher: { status: 'verified', note: 'demo: verified' }, settings: {} });
s.put('users', { email: 'pm@acme.test', role: 'owner', orgId: buyer.id, passwordHash: hashPassword('demo password 123') });
config.docDir = process.env.DOC_DIR || config.docDir;
const rq = createRequest(s, buyer, { email: 'pm@acme.test' }, { title: 'Pine St Office — Glazing & Final Clean', address: '400 Pine St', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['glazing', 'cleaning'], dueDate: new Date(Date.now() + 26 * 864e5).toISOString().slice(0, 10), documentsUrl: '' }).request;
for (const f of ['A2.1 - Level 1 Floor Plan.pdf', 'E2.01_Lighting_Plan.pdf', 'Project Manual - Division 26 Electrical.pdf']) saveDocument(s, buyer, { email: 'pm@acme.test' }, rq.id, { name: f, buffer: fs.readFileSync(FIX + f) });
const d1 = s.list('documents', d => d.sheet === 'A2.1')[0];
s.tput('analyses', sub.id, { documentId: d1.id, requestId: rq.id, documentName: d1.name, sheet: 'A2.1', model: 'claude-sonnet-5-5', status: 'verified', verifiedBy: 'sub@em.test', verifiedAt: new Date().toISOString(),
  result: { confidence: 'high', sheets: [], finishes: [], scopes: [], notes: [], rooms: [
    { number: '101', name: 'Open Office', areaSqFt: 12460, basis: 'printed', sheet: 'A2.1' }, { number: '102', name: 'Lobby', areaSqFt: 2450, basis: 'printed', sheet: 'A2.1' },
    { number: '103', name: 'Conference', areaSqFt: 3200, basis: 'printed', sheet: 'A2.1' }, { number: '104', name: 'Restrooms', areaSqFt: 1200, basis: 'printed', sheet: 'A2.1' }, { number: '105', name: 'Storage', areaSqFt: null, basis: 'not_stated', sheet: 'A2.1' }],
    totals: { roomsFound: 5, roomsWithPrintedArea: 4, printedAreaSqFt: 19310 } } });
bootstrap(s); // same startup as production (includes the project-core backfill)
createServer(s).listen(Number(process.env.QA_PORT), () => console.log('up'));
