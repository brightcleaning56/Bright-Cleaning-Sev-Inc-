// Super Admin Phase 2b: platform analytics and the admin action queue.
// Both are computed from stored records at request time. Nothing is estimated or hard-coded:
// an empty month is zero, and a missing value is reported as missing.
import { authorityQueue } from './service.js';
import { sourceComplianceIssues } from '../sources/registry.js';

const MONTHS = 12;
const monthOf = iso => (iso ? String(iso).slice(0, 7) : null);

export function lastMonths(n, asOf) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

function series(key, label, rows, months, { formula, field = 'createdAt' } = {}) {
  const counts = {};
  for (const r of rows) { const m = monthOf(r[field]); if (m) counts[m] = (counts[m] || 0) + 1; }
  return {
    key, label, formula,
    values: months.map(m => ({ month: m, count: counts[m] || 0 })),
    total: rows.length,
    inWindow: months.reduce((n, m) => n + (counts[m] || 0), 0),
  };
}

export function platformAnalytics(store, { asOf = new Date() } = {}) {
  const months = lastMonths(MONTHS, asOf);
  const orgs = store.list('orgs');
  return {
    asOf: asOf.toISOString(),
    timezone: 'UTC',
    window: { from: months[0], to: months[months.length - 1] },
    series: [
      series('companies', 'Company accounts', orgs.filter(o => o.subscription?.plan !== 'internal'), months,
        { formula: 'company accounts created per month; the platform company is excluded' }),
      series('users', 'User accounts', store.list('users'), months, { formula: 'user accounts created per month' }),
      series('projects', 'Permanent projects', store.list('projects'), months, { formula: 'project records created per month' }),
      series('permits', 'Permit records collected', store.list('permits'), months, { formula: 'permit records stored per month' }),
      series('bid_requests', 'Bid requests posted', store.list('bidRequests'), months, { formula: 'bid requests created per month' }),
      series('submissions', 'Bids submitted', store.list('submissions'), months, { formula: 'bid submissions created per month' }),
      series('publications', 'Publications', store.list('publications'), months, { formula: 'publisher project publications created per month' }),
    ],
    sources: store.list('sources').map(s => ({
      id: s.id, name: s.name, enabled: !!s.enabled,
      lastSuccessAt: s.lastSuccessAt || null,
      lastError: s.lastError || null,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const KIND_LABEL = {
  publisher_review: 'Publisher verification',
  authority_review: 'Project authority',
  source_compliance: 'Data source not compliant',
  source_failing: 'Data source failing',
  privacy_request: 'Privacy request open',
};

export function actionQueue(store, { asOf = new Date() } = {}) {
  const items = [];
  const add = (kind, id, title, detail, since, link) =>
    items.push({ kind, label: KIND_LABEL[kind], id, title, detail, since: since || null, link });

  for (const o of store.list('orgs', o => o.kind === 'buyer' && o.publisher?.status === 'pending')) {
    add('publisher_review', o.id, o.name, 'publisher company awaiting verification', o.createdAt, `#/company/${o.id}`);
  }
  const authority = authorityQueue(store, new URLSearchParams('limit=100'));
  if (authority.ok) {
    for (const p of authority.items.filter(x => x.review === 'pending')) {
      add('authority_review', p.id, p.title, `${p.publisher} · ${p.relationship}`, p.createdAt, '#/authority');
    }
  }
  for (const s of store.list('sources', s => s.enabled)) {
    const issues = sourceComplianceIssues(s);
    if (issues.length) add('source_compliance', s.id, s.name, issues.join('; '), s.updatedAt, `#/source/${s.id}`);
    if (s.lastError) add('source_failing', s.id, s.name, `last run failed: ${s.lastError}`, s.lastFailureAt || s.updatedAt, `#/source/${s.id}`);
  }
  for (const r of store.list('privacyRequests', r => r.status === 'open')) {
    add('privacy_request', r.id, `${r.type || 'privacy'} request`, r.email || '', r.createdAt, null);
  }
  items.sort((a, b) => String(a.since || '').localeCompare(String(b.since || '')) || String(a.id).localeCompare(String(b.id)));
  return { ok: true, asOf: asOf.toISOString(), count: items.length, items };
}
