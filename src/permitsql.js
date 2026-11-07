// Database-backed project search (WS1 stage A). Same results as leads.searchProjects, computed in PostgreSQL:
// filtering, grouping (address or permanent project), lead permit, totals, sorting and paging. Only the requested page
// is turned into full summaries. Filter columns were derived at write time by the app's own functions (coredb.js).
import { leadAccess } from './billing.js';
import { parseFilters, coreReadsOn, summaryFor, cmpC } from './leads.js';
import { marketStatus } from './publishing.js';

export const sqlSupports = f => !f.hasContact;        // "has a sendable contact" depends on other live records → memory path

function where(f, access, args) {
  const a = v => { args.push(v); return '$' + args.length; };
  const w = ['p.commercial', 'NOT p.archived', `(p.state IS NULL OR p.state = ANY(${a(access.states)}))`];
  if (f.states.length) w.push(`coalesce(p.state, '') = ANY(${a(f.states)})`);
  if (f.cities.length) w.push(`p.city_l = ANY(${a(f.cities)})`);
  if (f.types.length) w.push(`p.project_type = ANY(${a(f.types)})`);
  if (f.work.length) w.push(`p.work && ${a(f.work)}::text[]`);
  const stage = `(CASE WHEN p.status IN ('finaled','expired') THEN p.status WHEN p.status = 'issued' THEN CASE WHEN p.est_start_d IS NOT NULL AND p.est_start_d <= (now() AT TIME ZONE 'UTC')::date THEN 'under_construction' ELSE 'issued' END WHEN p.status = 'unknown' THEN 'applied' ELSE p.status END)`;
  if (f.stages.length) w.push(`${stage} = ANY(${a(f.stages)})`); else if (!f.includeClosed) w.push(`${stage} NOT IN ('finaled','expired')`);
  // Unknown values: the app treats a missing value as 0 in these comparisons, so an unknown-value project passes a
  // maximum filter (it might be under it) but not a positive minimum. Same rule here, stated explicitly.
  if (f.minValue != null) { const x = a(f.minValue); w.push(`(p.valuation >= ${x} OR (p.valuation IS NULL AND 0 >= ${x}))`); }
  if (f.maxValue != null) { const x = a(f.maxValue); w.push(`(p.valuation <= ${x} OR (p.valuation IS NULL AND 0 <= ${x}))`); }
  if (f.minSqft != null) { const x = a(f.minSqft); w.push(`(p.sqft >= ${x} OR (p.sqft IS NULL AND 0 >= ${x}))`); }
  if (f.since) w.push(`p.change_ts > ${a(f.since)}::timestamptz`);
  if (f.text) for (const word of f.text.split(/\s+/)) w.push(`position(${a(word)} in p.hay) > 0`);
  return w.join(' AND ');
}

export async function sqlSearchProjects(store, org, query, { page = 1, pageSize = 50, sort = 'newest', coreReads } = {}) {
  const access = leadAccess(org);
  if (!access.ok) return { ok: false, error: access.reason, code: 402 };
  const f = parseFilters(query);
  const core = coreReadsOn({ coreReads });
  const args = [];
  const w = where(f, access, args);
  const gkey = core ? `coalesce(coalesce(al.project_id, l.project_id), 'site:' || p.site_key)` : 'p.site_key';
  const order = { newest: 'latest DESC, gk', value: 'combined DESC NULLS LAST, gk', start: `coalesce(earliest, '9'), gk` }[sort] || 'latest DESC, gk';
  args.push(Math.max(1, Math.min(1000, Number(pageSize) || 50)), (Math.max(1, Number(page) || 1) - 1) * (Number(pageSize) || 50));
  const sql = `
    WITH m AS (
      SELECT p.*, ${gkey} COLLATE "C" AS gk FROM bi_permits p
      LEFT JOIN bi_project_links l ON l.kind = 'permit' AND l.ref_id = p.id
      LEFT JOIN bi_project_aliases al ON al.alias_id = l.project_id
      WHERE ${w}),
    g AS (
      SELECT gk, array_agg(id ORDER BY coalesce(valuation, 0) DESC, changed_at COLLATE "C" DESC, id COLLATE "C") AS ids,
        count(*)::int AS n, sum(valuation) FILTER (WHERE valuation <> 0) AS combined,
        max(change_txt COLLATE "C") AS latest, min(est_start COLLATE "C") AS earliest
      FROM m GROUP BY gk),
    page AS (SELECT * FROM g ORDER BY ${order} LIMIT $${args.length - 1} OFFSET $${args.length}),
    tot AS (SELECT count(*)::int AS total, coalesce(sum(n), 0)::int AS permit_total FROM g)
    -- totals always present (an empty page past the end still reports them); work tags only for this page's groups
    SELECT tot.total, tot.permit_total, page.*, (SELECT array_agg(DISTINCT w ORDER BY w) FROM m, unnest(m.work) AS w WHERE m.gk = page.gk) AS work
    FROM tot LEFT JOIN page ON true ORDER BY ${order.replace(/latest|combined|earliest|gk/g, x => 'page.' + x)}`;
  const { rows } = await store.pool.query(sql, args);
  const results = rows.filter(r => r.gk != null).map(r => {
    const lead = store.get('permits', r.ids[0]);
    const s = summaryFor(store, lead, org.id);
    const proj = core && r.gk.startsWith('BI-') ? store.get('projects', r.gk) : null;
    const out = { ...s, groupKey: r.gk, ...(proj ? { id: proj.id, projectId: proj.id, anchorPermitId: lead.id, title: proj.name || s.title, phase: proj.phase } : {}),
      permitIds: r.ids, work: r.work || [], permitCount: r.n, combinedValue: r.combined == null ? null : Number(r.combined), latestActivity: r.latest, earliestStart: r.earliest || null };
    const pid = out.projectId || (store.get('projectLinks', 'permit:' + lead.id)?.projectId) || null;
    return { ...out, market: marketStatus(store, pid && pid.startsWith('BI-') ? (store.get('projectAliases', pid)?.projectId || pid) : null, org) };
  });
  return { ok: true, total: rows[0]?.total || 0, permitTotal: rows[0]?.permit_total || 0, page: Number(page) || 1, pageSize: Number(pageSize) || 50,
    territories: access.states.length > 50 ? 'all states' : access.states, results, engine: 'postgres' };
}
