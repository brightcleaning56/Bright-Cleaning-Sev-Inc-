// Phase-2 parity check: the same reads with CORE_READS off (address grouping) and on (permanent projects), compared.
// Read-only: it never saves. A permit visible before but missing after is a hard failure.
import { searchProjects, commandCenter, mapPoints } from './leads.js';

export function compareReads(store, org) {
  const q = new URLSearchParams({ includeClosed: 'true' });
  const opt = { page: 1, pageSize: 1e9, sort: 'value' };
  const before = searchProjects(store, org, q, { ...opt, coreReads: 'off' });
  const after = searchProjects(store, org, q, { ...opt, coreReads: 'on' });
  if (!before.ok) return { org: org.slug, skipped: before.error };
  const permitsOf = rows => new Set(rows.flatMap(r => r.permitIds));
  const pb = permitsOf(before.results), pa = permitsOf(after.results);
  const missing = [...pb].filter(x => !pa.has(x)), extra = [...pa].filter(x => !pb.has(x));
  const groupOf = new Map(); after.results.forEach(r => r.permitIds.forEach(id => groupOf.set(id, r)));
  const out = { identical: 0, joined: 0, split: 0, examples: [] };
  const seenJoined = new Set();
  for (const g of before.results) {
    const targets = [...new Set(g.permitIds.map(id => groupOf.get(id)?.id).filter(Boolean))];
    if (targets.length > 1) { out.split++; out.examples.length < 10 && out.examples.push({ type: 'split', address: g.address, intoProjects: targets }); continue; }
    const t = after.results.find(r => r.id === targets[0]);
    if (t && t.permitIds.length === g.permitIds.length) out.identical++;
    else if (t && !seenJoined.has(t.id)) { seenJoined.add(t.id); out.joined++; out.examples.length < 10 && out.examples.push({ type: 'joined', project: t.id, title: t.title, permits: t.permitIds.length }); }
  }
  const sum = rows => rows.reduce((n, r) => n + (r.combinedValue || 0), 0);
  const unlinked = after.results.filter(r => !String(r.id).startsWith('BI-')).length;
  const kb = commandCenter(store, org, { coreReads: 'off' }).kpis, ka = commandCenter(store, org, { coreReads: 'on' }).kpis;
  const mb = mapPoints(store, org, new URLSearchParams(''), { coreReads: 'off' }), ma = mapPoints(store, org, new URLSearchParams(''), { coreReads: 'on' });
  return { org: org.slug, ok: !missing.length && !extra.length,
    groups: { before: before.total, after: after.total, ...out, notYetLinked: unlinked },
    permits: { before: pb.size, after: pa.size, missing: missing.slice(0, 20), extra: extra.slice(0, 20) },
    value: { before: sum(before.results), after: sum(after.results) },
    commandCenter: { activeSitesBefore: kb?.activeSites, activeProjectsAfter: ka?.activeSites, newThisMonthBefore: kb?.newSitesThisMonth, newThisMonthAfter: ka?.newSitesThisMonth },
    map: { pointsBefore: mb.total, pointsAfter: ma.total } };
}

export function parityReport(store) {
  const orgs = store.list('orgs', o => o.kind !== 'buyer' && o.status !== 'pending_verification');
  const rows = orgs.map(o => compareReads(store, o)).filter(r => !r.skipped);
  return { ok: rows.every(r => r.ok), checkedAt: new Date().toISOString(), accounts: rows.length, rows };
}
