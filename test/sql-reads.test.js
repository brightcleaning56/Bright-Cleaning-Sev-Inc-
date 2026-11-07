import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestPermits } from '../src/permits.js';
import { backfillCore } from '../src/core.js';
import { searchProjects } from '../src/leads.js';

// Database-backed search must return exactly what the in-memory search returns (WS1 stage A).
const url = process.env.TEST_DATABASE_URL;
const D = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
function dataset() {
  const rows = [], streets = ['Pine St', 'Pine Street', 'Main St', 'Oak Ave', 'Union St'], types = ['New', 'Addition/Alteration', 'Roof', 'Tenant Improvement'];
  const desc = ['New commercial office building', 'Retail tenant improvement, interior alterations', 'Commercial reroof', 'New warehouse with loading docks', 'Restaurant TI and kitchen hood', 'Medical office remodel'];
  for (let i = 0; i < 400; i++) rows.push({ permitId: 'P' + i, address: `${100 + (i % 90)} ${streets[i % 5]}${i % 13 === 0 ? ' Suite 200' : ''}`, permitType: types[i % 4],
    description: desc[i % 6] + (i % 7 === 0 ? ' Sellen' : ''), issuedDate: i % 9 === 0 ? null : D(-(i % 200)), appliedDate: D(-(i % 300)),
    status: ['Issued', 'Applied', 'Final', 'Issued', 'Approved', 'Expired'][i % 6],
    valuation: i % 11 === 0 ? '' : String([500000, 500000, 2500000, 150000, 48500000][i % 5]), contractor: ['Sellen Construction', 'Abbott Construction', '', 'GLY'][i % 4],
    lat: i % 17 === 0 ? null : 47.6 + (i % 40) / 1000, lng: -122.33 });
  return rows;
}
test('SQL search returns exactly the in-memory results: every filter, sort, page, both grouping modes', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const { PgStore } = await import('../src/pgstore.js');
  const { sqlSearchProjects } = await import('../src/permitsql.js');
  const reset = await new PgStore(url, { listen: false }).init();
  await reset.pool.query('TRUNCATE records, audit, bi_projects, bi_project_links, bi_project_companies, bi_project_phases, bi_project_aliases, bi_permits'); await reset.pool.end();
  const s = await new PgStore(url, { listen: false }).init();
  try {
    ingestPermits(s, { id: 'sea', jurisdiction: 'sea', city: 'Seattle', state: 'WA', url: 'u' }, dataset());
    ingestPermits(s, { id: 'aus', jurisdiction: 'aus', city: 'Austin', state: 'TX', url: 'u' }, dataset().slice(0, 120).map(r => ({ ...r, permitId: 'T' + r.permitId })));
    backfillCore(s); s.save(); await s.flushed();
    const org = s.put('orgs', { slug: 'o', kind: 'subscriber', territories: ['WA'], status: 'active', settings: {}, subscription: { plan: 'local', status: 'active' } });
    const nat = s.put('orgs', { slug: 'n', kind: 'subscriber', territories: ['WA'], status: 'active', settings: {}, subscription: { plan: 'national', status: 'active' } });
    const queries = [{}, { includeClosed: 'true' }, { stage: 'issued' }, { stage: 'under_construction,applied' }, { type: 'office' }, { work: 'new_construction' }, { work: 'roofing,interior_remodel' },
      { minValue: '1000000' }, { maxValue: '600000', includeClosed: 'true' }, { q: 'sellen' }, { q: 'office pine' }, { state: 'TX' }, { city: 'seattle' }, { since: new Date(Date.now() - 864e5).toISOString() }];
    let compared = 0;
    for (const o of [org, nat]) for (const coreReads of ['off', 'on']) for (const sort of ['newest', 'value', 'start']) for (const q of queries) for (const page of [1, 2]) {
      const qs = new URLSearchParams(q), opt = { page, pageSize: 25, sort, coreReads };
      const mem = searchProjects(s, o, qs, opt), sql = await sqlSearchProjects(s, o, qs, opt);
      const label = JSON.stringify({ org: o.slug, coreReads, sort, q, page });
      assert.deepEqual([sql.total, sql.permitTotal], [mem.total, mem.permitTotal], label);
      assert.equal(sql.results.length, mem.results.length, label);
      sql.results.forEach((r, i) => { const m = mem.results[i];
        assert.deepEqual([r.groupKey, r.id, r.title, r.stage, r.permitCount, r.combinedValue, r.latestActivity, r.earliestStart, [...r.permitIds].sort(), [...r.work].sort(), r.market.status],
          [m.groupKey, m.id, m.title, m.stage, m.permitCount, m.combinedValue, m.latestActivity, m.earliestStart, [...m.permitIds].sort(), [...m.work].sort(), m.market.status], `${label} row ${i}`); });
      compared++;
    }
    assert.equal(compared, 2 * 2 * 3 * queries.length * 2);
  } finally { await s.close(); }
});
