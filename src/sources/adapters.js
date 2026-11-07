import { config } from '../config.js';

const lastCall = new Map();
async function throttle(source) {
  const minGap = 60000 / (source.rateLimitPerMin || 10);
  const prev = lastCall.get(source.id) || 0;
  const wait = prev + minGap - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall.set(source.id, Date.now());
}

function mapFields(row, fields) {
  const out = {};
  for (const [k, col] of Object.entries(fields)) {
    if (col && typeof col === 'object' && Array.isArray(col.any)) { // first non-empty of several columns
      const v = col.any.map(c => row[c]).find(x => x !== undefined && x !== null && x !== '' && Number(x) !== 0); if (v !== undefined) out[k] = v; continue;
    }
    if (Array.isArray(col)) { const v = col.map(c => row[c]).filter(x => x !== undefined && x !== null && x !== '').join(' ').trim(); if (v) out[k] = v; }
    else if (row[col] !== undefined) out[k] = row[col];
  }
  return out;
}

// Some portals (e.g. Chicago) list many contacts per permit, each with a type. Pick roles by type,
// never by position, so an owner or architect is never labeled as the contractor.
export function contactRoles(row, slots) {
  if (!slots) return {};
  const out = {};
  for (let i = 1; i <= slots.count; i++) {
    const type = row[`${slots.prefix}${i}${slots.typeSuffix}`]; const name = row[`${slots.prefix}${i}${slots.nameSuffix}`];
    if (!type || !name) continue;
    for (const [field, pattern] of Object.entries(slots.roles)) if (!out[field] && new RegExp(pattern, 'i').test(type)) out[field] = name;
  }
  return out;
}

export async function socrata(source, { since, fetchImpl = fetch } = {}) {
  const c = source.adapterConfig;
  // Incremental by the portal's own record-updated time, oldest change first, paging forward so the cursor
  // never skips records. First sync backfills c.backfillDays (default 120). Optional c.where filters at the source.
  // sync 'window': some portals (e.g. Austin) rewrite every row daily, so :updated_at is meaningless there.
  // Instead re-pull a rolling window of recently issued/applied permits each cycle (also catches status changes).
  const windowMode = c.sync === 'window';
  const from = windowMode ? new Date(Date.now() - (c.windowDays || 120) * 864e5).toISOString()
    : since || new Date(Date.now() - (c.backfillDays || 120) * 864e5).toISOString();
  const dateClause = windowMode
    ? '(' + (c.windowFields || [c.dateField]).map(f => `${f} > '${from.slice(0, 19)}'`).join(' OR ') + ')'
    : `:updated_at > '${from.slice(0, 23)}'`;
  const where = [dateClause, c.where].filter(Boolean).join(' AND ');
  const headers = config.socrataAppToken ? { 'X-App-Token': config.socrataAppToken } : {};
  const rows = [];
  for (let page = 0; page < (c.maxPages || 5); page++) {
    const params = new URLSearchParams({ $select: ':*,*', $where: where, $order: windowMode ? ':id' : ':updated_at ASC, :id ASC', $limit: '1000', $offset: String(page * 1000) });
    await throttle(source);
    const res = await fetchImpl(`https://${c.domain}/resource/${c.dataset}.json?${params}`, { headers });
    if (!res.ok) throw new Error(`socrata ${res.status}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows.map(r => ({
    _cursor: windowMode ? null : (r[':updated_at'] || null),
    ...mapFields(r, c.fields),
    ...contactRoles(r, c.contactSlots),
    lat: r.latitude ?? r.location?.latitude, lng: r.longitude ?? r.location?.longitude,
    sourceUrl: (c.sourceUrlField && (r[c.sourceUrlField]?.url || (typeof r[c.sourceUrlField] === 'string' && r[c.sourceUrlField]))) || `https://${c.domain}/resource/${c.dataset}.json?${encodeURIComponent([].concat(c.fields.permitId)[0])}=${encodeURIComponent(r[[].concat(c.fields.permitId)[0]] ?? '')}`,
  }));
}

function mmddyyyy(d) {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

// Federal opportunities are bid solicitations, not permits; they map onto the same record shape
// with status 'applied' and the solicitation number as permitId.
export async function samgov(source, { fetchImpl = fetch } = {}) {
  const key = process.env[source.credentialEnv];
  if (!key) throw new Error('SAM_API_KEY not configured');
  const to = new Date(); const from = new Date(Date.now() - 14 * 864e5);
  const out = [];
  for (const state of source.adapterConfig.states || []) {
    for (const naics of source.adapterConfig.naics || []) {
      await throttle(source);
      const p = new URLSearchParams({ api_key: key, postedFrom: mmddyyyy(from), postedTo: mmddyyyy(to),
        limit: '100', ncode: naics, state });
      const res = await fetchImpl(`https://api.sam.gov/opportunities/v2/search?${p}`);
      if (res.status === 429) throw new Error('sam.gov daily quota reached');
      if (!res.ok) throw new Error(`sam.gov ${res.status}`);
      const body = await res.json();
      for (const o of body.opportunitiesData || []) {
        const poc = (o.pointOfContact || [])[0] || {};
        out.push({
          permitId: o.solicitationNumber || o.noticeId,
          projectName: o.title,
          address: [o.placeOfPerformance?.streetAddress, o.placeOfPerformance?.city?.name].filter(Boolean).join(', ') || o.officeAddress?.city || state,
          city: o.placeOfPerformance?.city?.name || null, state,
          description: `Federal solicitation (${o.type}) — commercial ${o.title}`,
          permitType: 'federal solicitation', status: 'applied',
          appliedDate: o.postedDate, owner: o.fullParentPathName,
          responseDeadline: o.responseDeadLine || null,
          sourceUrl: o.uiLink || source.url,
          contactName: poc.fullName || null, contactEmail: poc.email || null,
        });
      }
    }
  }
  return out;
}

// Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF).
export function parseCsv(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = ''; if (row.some(v => v !== '')) rows.push(row); row = [];
    } else f += ch;
  }
  row.push(f); if (row.some(v => v !== '')) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map(h => h.trim());
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

// CSV columns must use BUILDINTEL field names: permitId,address,city,state,zip,permitType,
// workClass,description,status,issuedDate,valuation,squareFeet,contractor,owner,sourceUrl
export function csvImport(text) { return parseCsv(text); }

export const ADAPTERS = { socrata, samgov };

/** Read a Socrata dataset's official schema (not a sample row, which omits blank fields). */
export async function probeSocrata(c, { fetchImpl = fetch, distinct } = {}) {
  let values = null;
  if (distinct) { // how the city actually labels a column, e.g. its permit classes
    if (!/^[a-z0-9_]+$/i.test(distinct)) throw new Error('bad column name');
    const p = new URLSearchParams({ $select: `${distinct}, count(*) as n`, $group: distinct, $order: 'n DESC', $limit: '25' });
    const recent = `:updated_at > '${new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 23)}'`;
    p.set('$where', [recent, c.where].filter(Boolean).join(' AND '));
    const r = await fetchImpl(`https://${c.domain}/resource/${c.dataset}.json?${p}`);
    if (!r.ok) throw new Error(`values ${r.status}`);
    values = (await r.json()).map(x => ({ value: x[distinct] ?? null, count: Number(x.n) }));
  }
  const res = await fetchImpl(`https://${c.domain}/api/views/${c.dataset}.json`);
  if (!res.ok) throw new Error(`metadata ${res.status}`);
  const meta = await res.json();
  const columns = (meta.columns || []).map(x => x.fieldName);
  const needed = Object.entries(c.fields).flatMap(([k, col]) => (col && col.any ? col.any : [].concat(col)).map(cc => [k, cc]));
  if (c.contactSlots) needed.push(['contacts', `${c.contactSlots.prefix}1${c.contactSlots.typeSuffix}`], ['contacts', `${c.contactSlots.prefix}1${c.contactSlots.nameSuffix}`]);
  if (c.sourceUrlField) needed.push(['sourceUrl', c.sourceUrlField]);
  return {
    columns, lastUpdated: meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString() : null,
    license: meta.license?.name || meta.licenseId || null, attribution: meta.attribution || null, values,
    mappedFieldsMissing: needed.filter(([, col]) => !columns.includes(col)).map(([k, col]) => `${k} -> ${col}`),
  };
}

// ---------------- ArcGIS FeatureServer (the other major government data platform) ----------------
// Config: { serviceUrl | itemId, layer, fields, dateField, where }. itemId resolves through ArcGIS Online
// so a Hub dataset can be added by its item id alone.
async function arcgisBase(c, fetchImpl) {
  if (c.serviceUrl) return c.serviceUrl.replace(/\/$/, '');
  const res = await fetchImpl(`https://www.arcgis.com/sharing/rest/content/items/${c.itemId}?f=json`);
  if (!res.ok) throw new Error(`arcgis item ${res.status}`);
  const item = await res.json();
  if (!item.url) throw new Error('arcgis item has no service url');
  return item.url.replace(/\/$/, '');
}

const isoDate = v => (typeof v === 'number' ? new Date(v).toISOString() : v);

export async function arcgis(source, { since, fetchImpl = fetch } = {}) {
  const c = source.adapterConfig;
  const base = await arcgisBase(c, fetchImpl);
  const clauses = [c.where || '1=1'];
  if (since) clauses.push(`${c.dateField} > DATE '${since.slice(0, 10)}'`);
  const p = new URLSearchParams({ where: clauses.join(' AND '), outFields: '*', orderByFields: `${c.dateField} DESC`, resultRecordCount: '1000', f: 'json' });
  await throttle(source);
  const res = await fetchImpl(`${base}/${c.layer ?? 0}/query?${p}`);
  if (!res.ok) throw new Error(`arcgis ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`arcgis: ${body.error.message || 'query error'}`);
  const idCol = [].concat(c.fields.permitId)[0];
  return (body.features || []).map(f => {
    const a = f.attributes || {};
    const row = mapFields(a, c.fields);
    for (const k of ['issuedDate', 'appliedDate']) if (row[k] != null) row[k] = isoDate(row[k]);
    return {
      ...row, lat: a.Latitude ?? f.geometry?.y, lng: a.Longitude ?? f.geometry?.x,
      sourceUrl: `${base}/${c.layer ?? 0}/query?where=${encodeURIComponent(`${idCol}='${String(a[idCol] ?? '').replace(/'/g, "''")}'`)}&outFields=*&f=html`,
    };
  });
}

export async function probeArcgis(c, { fetchImpl = fetch } = {}) {
  const base = await arcgisBase(c, fetchImpl);
  const res = await fetchImpl(`${base}/${c.layer ?? 0}?f=json`);
  if (!res.ok) throw new Error(`arcgis layer ${res.status}`);
  const layer = await res.json();
  if (layer.error) throw new Error(`arcgis: ${layer.error.message}`);
  const columns = (layer.fields || []).map(f => f.name);
  const needed = Object.entries(c.fields || {}).flatMap(([k, col]) => [].concat(col).map(cc => [k, cc]));
  if (c.dateField) needed.push(['dateField', c.dateField]);
  const lastEdit = layer.editingInfo?.lastEditDate || layer.editingInfo?.dataLastEditDate;
  return {
    serviceUrl: base, columns, lastUpdated: lastEdit ? new Date(lastEdit).toISOString() : null,
    license: layer.copyrightText || null, mappedFieldsMissing: needed.filter(([, col]) => !columns.includes(col)).map(([k, col]) => `${k} -> ${col}`),
  };
}

ADAPTERS.arcgis = arcgis;
