// Relational tables for the Project Intelligence Core and Plan Room (schema version 3: v2 core, v3 drawing sets/sheets/revisions). Written in the same transaction as the
// document records (see pgstore), so the two can't drift. Queries that must scale (search, map, reporting) read here.
export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS bi_projects (
  id text PRIMARY KEY, name text, status text, phase text, address text, city text, state text, site_keys text[],
  lat double precision, lng double precision, project_type text, est_value numeric, building_sf integer,
  first_seen timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS bi_projects_state_city ON bi_projects (state, city);
CREATE INDEX IF NOT EXISTS bi_projects_phase ON bi_projects (phase);
CREATE INDEX IF NOT EXISTS bi_projects_type ON bi_projects (project_type);
CREATE INDEX IF NOT EXISTS bi_projects_value ON bi_projects (est_value DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS bi_projects_site ON bi_projects USING gin (site_keys);
CREATE TABLE IF NOT EXISTS bi_project_links (
  id text PRIMARY KEY, project_id text NOT NULL, kind text NOT NULL, ref_id text NOT NULL, method text, confidence text,
  source_url text, first_seen timestamptz, last_seen timestamptz, UNIQUE (kind, ref_id));
CREATE INDEX IF NOT EXISTS bi_project_links_project ON bi_project_links (project_id);
CREATE TABLE IF NOT EXISTS bi_project_companies (
  id text PRIMARY KEY, project_id text NOT NULL, company_key text NOT NULL, name text, role text, source_kind text, source_ref text,
  source_url text, method text, verified boolean, first_seen timestamptz, last_seen timestamptz);
CREATE INDEX IF NOT EXISTS bi_project_companies_project ON bi_project_companies (project_id);
CREATE INDEX IF NOT EXISTS bi_project_companies_company ON bi_project_companies (company_key, role);
ALTER TABLE bi_project_companies ADD COLUMN IF NOT EXISTS evidence jsonb;
CREATE TABLE IF NOT EXISTS bi_project_phases (id text PRIMARY KEY, project_id text NOT NULL, phase text, started_at timestamptz, ended_at timestamptz, source text);
ALTER TABLE bi_project_phases ADD COLUMN IF NOT EXISTS seq integer;
CREATE INDEX IF NOT EXISTS bi_project_phases_project ON bi_project_phases (project_id);
CREATE TABLE IF NOT EXISTS bi_project_aliases (alias_id text PRIMARY KEY, project_id text NOT NULL, merged_at timestamptz, merged_by text);
CREATE TABLE IF NOT EXISTS bi_drawing_sets (id text PRIMARY KEY, project_id text, request_id text, discipline text, name text, source text, rights jsonb);
CREATE INDEX IF NOT EXISTS bi_drawing_sets_project ON bi_drawing_sets (project_id);
CREATE TABLE IF NOT EXISTS bi_drawing_sheets (id text PRIMARY KEY, set_id text NOT NULL, project_id text, sheet text, title text, kind text, current_revision text, revision_count integer);
CREATE INDEX IF NOT EXISTS bi_drawing_sheets_set ON bi_drawing_sheets (set_id);
CREATE TABLE IF NOT EXISTS bi_drawing_revisions (id text PRIMARY KEY, sheet_id text NOT NULL, set_id text, project_id text, document_id text, seq integer, label text, addendum integer, uploaded_at timestamptz);
CREATE INDEX IF NOT EXISTS bi_drawing_revisions_sheet ON bi_drawing_revisions (sheet_id);
-- Permits with filter columns derived at write time by the same functions the app uses (exact parity with memory reads).
CREATE TABLE IF NOT EXISTS bi_permits (
  id text PRIMARY KEY, commercial boolean, archived boolean, state text, city_l text, project_type text, status text,
  est_start text, est_start_d date, work text[], hay text, valuation double precision, sqft double precision,
  change_ts timestamptz, change_txt text, site_key text, lat double precision, lng double precision, contractor text);
ALTER TABLE bi_permits ADD COLUMN IF NOT EXISTS changed_at text;
CREATE INDEX IF NOT EXISTS bi_permits_state ON bi_permits (state, change_ts DESC);
CREATE INDEX IF NOT EXISTS bi_permits_type ON bi_permits (project_type);
CREATE INDEX IF NOT EXISTS bi_permits_site ON bi_permits (site_key);
CREATE INDEX IF NOT EXISTS bi_permits_work ON bi_permits USING gin (work);
CREATE INDEX IF NOT EXISTS bi_project_links_ref ON bi_project_links (kind, ref_id);
UPDATE schema_meta SET value = '3' WHERE key = 'version' AND value::int < 3;
`;

const ts = v => v || null;
// collection → [table, columns, row mapper]
// Derived-value functions are injected by leads.js (avoids a load-order cycle): the same code computes them everywhere.
export const derived = {};
export const CORE_TABLES = {
  projects: ['bi_projects', ['id', 'name', 'status', 'phase', 'address', 'city', 'state', 'site_keys', 'lat', 'lng', 'project_type', 'est_value', 'building_sf', 'first_seen'],
    r => [r.id, r.name, r.status, r.phase, r.address, r.city, r.state, r.siteKeys || [], r.lat ?? null, r.lng ?? null, r.projectType, r.estValue ?? null, r.buildingSf ? Math.round(r.buildingSf) : null, ts(r.firstSeenAt)]],
  projectLinks: ['bi_project_links', ['id', 'project_id', 'kind', 'ref_id', 'method', 'confidence', 'source_url', 'first_seen', 'last_seen'],
    r => [r.id, r.projectId, r.kind, r.refId, r.method, r.confidence, r.sourceUrl, ts(r.firstSeenAt), ts(r.lastSeenAt)]],
  projectCompanies: ['bi_project_companies', ['id', 'project_id', 'company_key', 'name', 'role', 'source_kind', 'source_ref', 'source_url', 'method', 'verified', 'first_seen', 'last_seen', 'evidence'],
    r => [r.id, r.projectId, r.companyKey, r.name, r.role, r.sourceKind, r.sourceRef, r.sourceUrl, r.method, !!r.verified, ts(r.firstSeenAt), ts(r.lastSeenAt), JSON.stringify(r.evidence || [])]],
  projectPhases: ['bi_project_phases', ['id', 'project_id', 'phase', 'started_at', 'ended_at', 'source', 'seq'], r => [r.id, r.projectId, r.phase, ts(r.startedAt), ts(r.endedAt), r.source, r.seq ?? null]],
  drawingSets: ['bi_drawing_sets', ['id', 'project_id', 'request_id', 'discipline', 'name', 'source', 'rights'], r => [r.id, r.projectId, r.requestId, r.discipline, r.name, r.source, JSON.stringify(r.rights || {})]],
  drawingSheets: ['bi_drawing_sheets', ['id', 'set_id', 'project_id', 'sheet', 'title', 'kind', 'current_revision', 'revision_count'], r => [r.id, r.setId, r.projectId, r.sheet, r.title, r.kind, r.currentRevisionId || null, r.revisionCount || 0]],
  drawingRevisions: ['bi_drawing_revisions', ['id', 'sheet_id', 'set_id', 'project_id', 'document_id', 'seq', 'label', 'addendum', 'uploaded_at'], r => [r.id, r.sheetId, r.setId, r.projectId, r.documentId, r.seq ?? null, r.label || null, r.addendum || 0, r.uploadedAt || null]],
  permits: ['bi_permits', ['id', 'commercial', 'archived', 'state', 'city_l', 'project_type', 'status', 'est_start', 'est_start_d', 'work', 'hay', 'valuation', 'sqft', 'change_ts', 'change_txt', 'site_key', 'lat', 'lng', 'contractor', 'changed_at'],
    r => { const t = derived.timeline(r); const ch = String(r.changedAt || r.createdAt || '');
      return [r.id, !!r.commercial, !!r.archived, r.state ? String(r.state).toUpperCase() : null, String(r.city || '').toLowerCase(), r.projectType || null, r.status || null,
        t?.estimatedStart || null, t?.estimatedStart || null, derived.workTags(r), [r.projectName, r.description, r.address, r.city, r.contractorOnPermit, r.owner, r.architect, r.permitId].join(' ').toLowerCase(),
        Number.isFinite(r.valuation) ? r.valuation : null, Number.isFinite(r.squareFeet) ? r.squareFeet : null, Number.isNaN(Date.parse(ch)) ? null : ch, ch, derived.siteKey(r),
        Number.isFinite(r.lat) ? r.lat : null, Number.isFinite(r.lng) ? r.lng : null, r.contractorOnPermit || null, String(r.changedAt || '')]; }],
  projectAliases: ['bi_project_aliases', ['alias_id', 'project_id', 'merged_at', 'merged_by'], r => [r.id, r.projectId, ts(r.at), r.by || null]],
};

/** Upsert/delete core rows inside an open transaction (one statement per row; core writes are small batches). */
export async function writeCoreRows(client, puts, dels) {
  // Permits can arrive by the thousand (ingest, resync): one set-based statement per batch instead of one per row.
  const permitRows = puts.filter(([c]) => c === 'permits');
  if (permitRows.length && !derived.timeline) await import('./leads.js');   // never depend on module load order
  if (permitRows.length) {
    const [, cols, map] = CORE_TABLES.permits;
    for (let n = 0; n < permitRows.length; n += 1000) {
      const json = JSON.stringify(permitRows.slice(n, n + 1000).map(([, r]) => Object.fromEntries(map(r).map((v, k) => [cols[k], v]))));
      await client.query(`INSERT INTO bi_permits SELECT * FROM json_populate_recordset(null::bi_permits, $1::json)
        ON CONFLICT (id) DO UPDATE SET ${cols.slice(1).map(x => `${x} = EXCLUDED.${x}`).join(', ')}`, [json]);
    }
  }
  for (const [c, rec] of puts.filter(([c]) => c !== 'permits')) {
    const t = CORE_TABLES[c]; if (!t) continue;
    const [table, cols, map] = t; const vals = map(rec);
    const key = cols[0];
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})
      ON CONFLICT (${key}) DO UPDATE SET ${cols.slice(1).map(x => `${x} = EXCLUDED.${x}`).join(', ')}${table === 'bi_projects' ? ', updated_at = now()' : ''}`, vals);
  }
  for (const [c, id] of dels) { const t = CORE_TABLES[c]; if (t) await client.query(`DELETE FROM ${t[0]} WHERE ${t[1][0]} = $1`, [id]); }
}

/** Row counts per table vs. the document records: proof the dual-write is complete. */
export async function reconcileCore(pool, store) {
  const out = {};
  for (const [c, [table]] of Object.entries(CORE_TABLES)) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    out[c] = { records: store.list(c).length, table: rows[0].n };
  }
  const ok = Object.values(out).every(x => x.records === x.table);
  const v = (await pool.query("SELECT value FROM schema_meta WHERE key = 'version'")).rows[0]?.value;
  return { ok, schemaVersion: Number(v), tables: out };
}

/** Database-side project search (scales without loading permits into memory). */
export async function searchCoreSql(pool, { states, q, type, phase, minValue, limit = 50 }) {
  const where = [], args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', '$' + args.length)); };
  if (states?.length) add('state = ANY(?)', states);
  if (q) add("(name ILIKE ? OR address ILIKE $" + (args.length + 1) + ")", `%${q}%`);
  if (type) add('project_type = ?', type);
  if (phase) add('phase = ?', phase);
  if (minValue) add('est_value >= ?', Number(minValue));
  args.push(Math.min(200, Number(limit) || 50));
  const { rows } = await pool.query(`SELECT id, name, phase, address, city, state, project_type, est_value, building_sf, lat, lng FROM bi_projects
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY est_value DESC NULLS LAST, id LIMIT $${args.length}`, args);
  return rows.map(r => ({ id: r.id, name: r.name, phase: r.phase, address: r.address, city: r.city, state: r.state, projectType: r.project_type,
    estValue: r.est_value == null ? null : Number(r.est_value), buildingSf: r.building_sf, lat: r.lat, lng: r.lng }));
}
