import './_env.js';
import { Store } from '../src/store.js';
import { seedSources } from '../src/sources/registry.js';
import { draftRateCard, approveRateCard } from '../src/estimate.js';
import { normName } from '../src/domain.js';
import { defaultSettings } from '../src/server.js';

export const RATE = {
  serviceName: 'Final construction clean', category: 'post_construction', unit: 'sqft',
  productionRate: 1000, laborRate: 18, payrollBurdenPct: 0.2, equipmentPerUnit: 0.01, suppliesPerUnit: 0.02,
  mobilization: 150, overheadPct: 0.1, contingencyPct: 0.05, targetMarginPct: 0.3, minimumPrice: 750,
  effectiveDate: '2026-01-01',
};

export function authorize(store, key) {
  const s = store.list('sources', x => x.key === key)[0];
  s.enabled = true;
  s.authorization = { commercialReuse: true, redistribution: true, reviewedBy: 'Test Counsel', reviewedAt: '2026-10-30', evidence: 'test://terms-snapshot' };
  store.put('sources', s);
  return s;
}

export function world() {
  const store = new Store(null);
  seedSources(store);
  const org = store.put('orgs', { slug: 'bright-clean', name: 'Bright Clean Inc.', status: 'active',
    legal: { name: 'Bright Clean Inc.', postalAddress: '100 Test St, Ankeny, IA 50023' }, senderEmail: 'bids@brightclean.test',
    settings: defaultSettings(), subscription: { plan: 'internal', status: 'active' } });
  const rc = draftRateCard(store, org.id, RATE, 'owner@test').rateCard;
  approveRateCard(store, org.id, rc.id, 'owner@test', 'owner');
  store.tput('credentials', org.id, { type: 'coi', issuer: 'Test Mutual', number: 'GL-1', coverages: [{ type: 'general_liability', limit: 1000000 }], expiresAt: '2099-01-01', verification: { status: 'on_file' } });
  const gc = store.put('companies', { name: 'Weitz Company', normName: normName('The Weitz Company LLC') });
  const contact = store.put('contacts', { companyId: gc.id, name: 'Pat Estimator', role: 'Estimator', email: 'pat@weitz.test', status: 'verified', evidenceUrl: 'https://weitz.test/contact' });
  return { store, org, rc, gc, contact };
}

export const DALLAS_ROWS = [
  { permit_number: 'BU-1001', permit_type: 'Commercial New Construction', issued_date: '2026-10-20T00:00:00.000',
    street_address: '500 Main St', zip_code: '75201', contractor: 'The Weitz Company LLC', value: '4500000', area: '42000',
    work_description: 'New office building shell and tenant finish', land_use: 'OFFICE' },
  { permit_number: 'BU-1002', permit_type: 'Building (BU) Single Family New Construction', issued_date: '2026-10-21T00:00:00.000',
    street_address: '12 Elm St', zip_code: '75214', contractor: 'Homes Inc', value: '300000', area: '2500',
    work_description: 'Single family dwelling', land_use: 'SINGLE FAMILY' },
  { permit_number: 'BU-1003', permit_type: 'Commercial Alteration', issued_date: '2026-10-22T00:00:00.000',
    street_address: '800 Commerce St', zip_code: '75202', contractor: 'Unknown Builders', value: '900000', area: '',
    work_description: 'Retail tenant finish out', land_use: 'RETAIL' },
];

export const stubFetch = (routes) => async (url, opts) => {
  for (const [match, handler] of routes) if (String(url).includes(match)) {
    const out = await handler(url, opts);
    return { ok: (out.status || 200) < 400, status: out.status || 200, json: async () => out.body };
  }
  throw new Error('unexpected fetch ' + url);
};
