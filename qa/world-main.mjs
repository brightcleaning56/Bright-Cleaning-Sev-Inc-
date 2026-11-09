import '../test/_env.js';
import { fileURLToPath } from 'node:url';
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
import { Store } from '../src/store.js';
import { ingestPermits } from '../src/permits.js';
import { createServer, bootstrap } from '../src/server.js';
import { seedSources } from '../src/sources/registry.js';
import { hashPassword } from '../src/security.js';
import { normName } from '../src/domain.js';
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const s = new Store(null); seedSources(s);
const src = { id: 'src_wa', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'https://data.seattle.gov' };
ingestPermits(s, src, [
  { permitId: 'S1', address: '400 Pine St', permitType: 'New', description: 'New commercial office building <script>alert(1)</script>', issuedDate: D(-20), status: 'Issued', valuation: '9000000', contractor: 'Sellen Construction Co Inc', sourceUrl: 'javascript:alert(1)' },
  { permitId: 'S2', address: '400 Pine Street', permitType: 'Addition/Alteration', description: 'Tenant improvement, office', issuedDate: D(-5), status: 'Issued', valuation: '300000', contractor: 'Sellen Construction Co Inc' },
  { permitId: 'S3', address: '12 Mercer St', permitType: 'Addition/Alteration', description: 'Commercial reroof', appliedDate: D(-3), status: 'In Review', valuation: '150000', contractor: 'Centimark' },
]);
s.put('licenses', { id: 'WA:' + normName('Sellen Construction Co Inc'), state: 'WA', normName: normName('Sellen Construction Co Inc'), found: true, licenseNumber: 'SELLECC999', status: 'ACTIVE', active: true, phone: '2065550100', checkedAt: new Date().toISOString(), sourceUrl: 'https://data.wa.gov/x' });
s.put('signals', { id: 'lu:1', kind: 'land_use_application', state: 'WA', city: 'Seattle', file: '3041234-LU', address: '1501 4TH AVE', title: 'Land use application for a 24-story office tower', type: 'Commercial', status: 'Reviews In Process', introDate: D(-30), url: 'https://seattle.gov/x' });
const bc = s.put('orgs', { slug: 'bc', name: 'Bright Cleaning Sev Inc.', status: 'onboarding', legal: {}, settings: {}, subscription: { plan: 'internal', status: 'active' } });
s.put('users', { email: 'eric@bc.test', role: 'platform_owner', orgId: bc.id, passwordHash: hashPassword('demo password 123') });
s.put('users', { email: 'ops@bc.test', role: 'member', platformRoles: ['platform_admin'], orgId: bc.id, passwordHash: hashPassword('demo password 123') });   // staff account for the MFA browser check
const sub = s.put('orgs', { slug: 'sub', name: 'Emerald Glass', kind: 'subscriber', trade: 'Glazing', territories: ['WA'], status: 'active', settings: {}, subscription: { plan: 'trial', status: 'trialing', trialEndsAt: new Date(Date.now() + 9 * 864e5).toISOString() } });
s.put('users', { email: 'sub@em.test', role: 'owner', orgId: sub.id, passwordHash: hashPassword('demo password 123') });
// Role demo accounts: a subcontractor and a service provider, set up the way sign-up sets them up.
// A general contractor waiting for publisher verification, so staff can review it in Super Admin.
const ridge = s.put('orgs', { slug: 'ridge', name: 'Ridge Builders', kind: 'buyer', buyerKind: 'general_contractor', status: 'active', publisher: { status: 'pending', evidence: { licenseNumber: 'WA-7781', website: 'https://ridge.example', notes: 'GC for multifamily work in Seattle' }, requestedAt: new Date().toISOString(), requestedBy: 'gc@ridge.test' }, settings: {} });
s.put('users', { email: 'gc@ridge.test', role: 'owner', orgId: ridge.id, passwordHash: hashPassword('demo password 123') });
const trade = s.put('orgs', { slug: 'trade', name: 'Bright Electric', kind: 'subscriber', segment: 'subcontractor', trade: 'Electrical', trades: ['electrical'], territories: ['WA'], status: 'active', settings: {}, subscription: { plan: 'trial', status: 'trialing', trialEndsAt: new Date(Date.now() + 9 * 864e5).toISOString() } });
s.put('users', { email: 'trade@elec.test', role: 'owner', orgId: trade.id, passwordHash: hashPassword('demo password 123') });
const svc = s.put('orgs', { slug: 'svc', name: 'Clear Pane Cleaning', kind: 'subscriber', segment: 'service_provider', trade: 'Construction cleaning, Janitorial & facility services', trades: ['cleaning', 'janitorial'], services: ['post_construction', 'windows'], territories: ['WA'], status: 'active', settings: {}, subscription: { plan: 'trial', status: 'trialing', trialEndsAt: new Date(Date.now() + 9 * 864e5).toISOString() } });
s.put('users', { email: 'svc@clean.test', role: 'owner', orgId: svc.id, passwordHash: hashPassword('demo password 123') });
const buyer = s.put('orgs', { slug: 'gc', name: 'Acme PM', kind: 'buyer', buyerKind: 'property_manager', status: 'active', publisher: { status: 'verified', note: 'demo: verified' }, settings: {} });
s.put('users', { email: 'pm@acme.test', role: 'owner', orgId: buyer.id, passwordHash: hashPassword('demo password 123') });
// Demo bid requests from the owner, posted the way the app posts them, so the owner and subcontractor dashboards show real work.
import { quickPublish } from '../src/publishing.js';
const pmUser = s.list('users', u => u.email === 'pm@acme.test')[0];
const posted1 = quickPublish(s, buyer, pmUser, { title: 'Electrical rough-in, Seattle office', address: '500 Union St', city: 'Seattle', state: 'WA', projectType: 'office', trades: ['electrical'], dueDate: D(21), description: 'Rough-in and trim for a 4-floor office fit-out.' });
const posted2 = quickPublish(s, buyer, pmUser, { title: 'Post-construction clean, Seattle clinic', address: '900 Pine St', city: 'Seattle', state: 'WA', projectType: 'medical', services: ['post_construction'], squareFeet: 18000, dueDate: D(14), description: 'Final clean and window detail before occupancy.' });
if (!posted1.ok || !posted2.ok) console.error('demo requests not posted', posted1.error || posted2.error);

bootstrap(s); // same startup as production (includes the project-core backfill)
createServer(s).listen(Number(process.env.QA_PORT), () => console.log('up'));
