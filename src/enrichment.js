// State contractor-license enrichment + planning/zoning early signals.
// Licenses never invent a link to a project: they are matched only to contractors a permit already names.
import { config } from './config.js';
import { now } from './store.js';
import { normName } from './domain.js';

const lastCall = new Map();
async function throttle(id, perMin = 30) {
  const gap = 60000 / perMin, prev = lastCall.get(id) || 0, wait = prev + gap - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall.set(id, Date.now());
}
const sq = v => String(v).replace(/'/g, "''");
const MATCH_VERSION = 2; // bump when matching logic improves so earlier misses are retried

/**
 * License sources (adapter 'license-socrata'): look up only the contractor names that appear on permits in
 * that state, in batches, instead of copying the whole register. Re-checks each name at most every 7 days.
 * adapterConfig: { domain, dataset, nameField, fields: { licenseNumber, businessName, status, type, phone, address, city, zip, expiresAt, principal, specialties[] } }
 */
export async function syncLicenses(store, src, { fetchImpl = fetch } = {}) {
  const c = src.adapterConfig, f = c.fields || {};
  if (!c.nameField || !f.licenseNumber) throw new Error('license field map not set (run the probe)');
  const known = new Map(store.list('licenses', l => l.state === src.state).map(l => [l.normName, l]));
  const names = new Map();
  for (const p of store.list('permits', p => p.state === src.state && p.contractorOnPermit && !p.archived)) {
    if (/^\s*blanket\b/i.test(p.contractorOnPermit)) continue; // Seattle "BLANKET: <building>" permits name a building, not a contractor
    const k = normName(p.contractorOnPermit); if (!k) continue;
    const prev = known.get(k);
    if (prev && (prev.found || prev.matchVersion === MATCH_VERSION) && Date.now() - Date.parse(prev.checkedAt) < 7 * 864e5) continue;
    if (!names.has(k)) names.set(k, p.contractorOnPermit.trim());
  }
  const out = { looked: names.size, found: 0, notFound: 0 };
  const list = [...names.entries()];
  const headers = config.socrataAppToken ? { 'X-App-Token': config.socrataAppToken } : {};
  // Names on permits are often shorter or punctuated differently than the legal name ("Centimark" vs
  // "CENTIMARK CORPORATION", "Scott Wall Construction, Inc."). Search by cleaned prefix, then accept only a
  // candidate whose core name (no Inc/LLC/Corp/Construction...) is identical. Two different companies = no match.
  const core = n => n.toUpperCase().replace(/[^A-Z0-9& ]+/g, ' ')
    .replace(/\b(INC|LLC|L L C|LLP|LP|LTD|CO|CORP|CORPORATION|COMPANY|INCORPORATED|PLLC|PC|THE)\b/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < list.length && i < (c.maxNamesPerCycle || 500); i += 20) {
    const batch = list.slice(i, i + 20).filter(([, n]) => core(n).length >= 3);
    if (!batch.length) continue;
    const where = batch.map(([, n]) => `starts_with(upper(${c.nameField}), '${sq(core(n))}')`).join(' OR ');
    await throttle(src.id);
    const res = await fetchImpl(`https://${c.domain}/resource/${c.dataset}.json?${new URLSearchParams({ $where: where, $limit: '2000' })}`, { headers });
    if (!res.ok) throw new Error(`license lookup ${res.status}`);
    const rows = await res.json();
    for (const [k, original] of batch) {
      const cands = rows.filter(r => normName(r[c.nameField]) === k);
      const isActive = r => /activ/i.test(String(r[f.status] || ''));
      const legal = r => String(r[c.nameField] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      // Different legal entities with the same core name: only accept if exactly one of them is active.
      const pool = new Set(cands.map(legal)).size > 1 ? cands.filter(isActive) : cands;
      const ambiguous = new Set(pool.map(legal)).size > 1;
      let hit = null;
      for (const r of pool) {
        const active = isActive(r);
        if (!hit || (active && !hit.active) || (active === hit.active && String(r[f.expiresAt] || '') > String(hit.row[f.expiresAt] || ''))) hit = { row: r, active };
      }
      const prev = known.get(k);
      if (!hit || ambiguous) { store.put('licenses', { ...(prev || {}), id: `${src.state}:${k}`, state: src.state, normName: k, businessName: original, found: false, ambiguous: !!ambiguous, matchVersion: MATCH_VERSION, checkedAt: now(), sourceId: src.id }); out.notFound++; continue; }
      const r = hit.row;
      store.put('licenses', {
        id: `${src.state}:${k}`, state: src.state, normName: k, found: true, matchVersion: MATCH_VERSION, checkedAt: now(), sourceId: src.id,
        licenseNumber: r[f.licenseNumber] || null, businessName: r[f.businessName] || original, status: r[f.status] || null, active: hit.active,
        type: r[f.type] || null, phone: r[f.phone] || null, address: [r[f.address], r[f.city], r[f.zip]].filter(Boolean).join(', ') || null,
        expiresAt: r[f.expiresAt] || null, principal: r[f.principal] || null,
        specialties: (f.specialties || []).map(x => r[x]).filter(Boolean),
        sourceUrl: `https://${c.domain}/resource/${c.dataset}.json?${encodeURIComponent(f.licenseNumber)}=${encodeURIComponent(r[f.licenseNumber] || '')}`,
      });
      out.found++;
    }
  }
  return out;
}

export function licenseFor(store, state, contractorName) {
  if (!contractorName) return null;
  const l = store.get('licenses', `${String(state || '').toUpperCase()}:${normName(contractorName)}`);
  return l && l.found ? l : null;
}

// ---------------- Legistar planning / zoning signals ----------------
export const LAND_USE = /rezone|re-zone|site plan|subdivision|\bplat\b|conditional use|variance|development agreement|planned (unit|development)|master (use|plan)|street vacation|annex/i;
// Council records are full of appointments and citywide code changes; keep only items tied to a specific site.
const NOT_SITE = /appointment|reappointment|confirm(ing)? the appointment|budget|relating to the (land use|zoning) code|amending sections?|technical amendments|citywide/i;
const SITE = /\b\d{2,6}\s+[A-Z0-9][\w.]*(\s+[\w.]+){0,4}\s+(st|street|ave|avenue|way|blvd|rd|road|dr|drive|pl|place|ln|lane|ct|pkwy|hwy|sw|se|nw|ne|n|s|e|w)\b|contract rezone|clerk file|council land use action|\bplat\b|street vacation|located at|parcel/i;
export const isSiteSpecificLandUse = text => LAND_USE.test(text) && SITE.test(text) && !NOT_SITE.test(text);

/** adapterConfig: { client, daysBack } — reads the city's public Legistar Web API (no key). */
export async function syncLegistar(store, src, { fetchImpl = fetch } = {}) {
  const c = src.adapterConfig;
  const since = new Date(Date.now() - (c.daysBack || 120) * 864e5).toISOString().slice(0, 10);
  const q = new URLSearchParams({ $filter: `MatterIntroDate ge datetime'${since}'`, $orderby: 'MatterIntroDate desc', $top: '1000' });
  await throttle(src.id, 20);
  const res = await fetchImpl(`https://webapi.legistar.com/v1/${encodeURIComponent(c.client)}/matters?${q}`);
  if (!res.ok) throw new Error(`legistar ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('legistar: unexpected response');
  const out = { received: rows.length, landUse: 0, removed: 0 };
  const kept = new Set();
  for (const m of rows) {
    const text = [m.MatterTypeName, m.MatterTitle, m.MatterName].join(' ');
    if (!isSiteSpecificLandUse(text)) continue;
    out.landUse++; kept.add(`${c.client}:${m.MatterId}`);
    store.put('signals', {
      id: `${c.client}:${m.MatterId}`, kind: 'planning', state: src.state, city: src.city, sourceId: src.id,
      file: m.MatterFile || null, title: m.MatterTitle || m.MatterName || '(untitled)', type: m.MatterTypeName || null,
      status: m.MatterStatusName || null, introDate: m.MatterIntroDate || null, lastModified: m.MatterLastModifiedUtc || null,
      url: `https://${c.client}.legistar.com/LegislationDetail.aspx?ID=${m.MatterId}&GUID=${m.MatterGuid}`,
    });
  }
  // Items stored under an earlier, looser filter are removed when they no longer qualify.
  for (const sg of store.list('signals', x => x.sourceId === src.id && !kept.has(x.id))) { store.remove('signals', sg.id); out.removed++; }
  return out;
}

/**
 * Land-use applications as early signals (adapter 'signals-socrata'): site-specific approvals that come before
 * building permits (e.g. Seattle master use permits, design review). Rolling window by applied/issued date.
 * adapterConfig: { domain, dataset, windowDays, windowFields[], where, fields: { id, address, description, type, status, appliedDate, decisionDate, link } }
 */
export async function syncLandUseSignals(store, src, { fetchImpl = fetch } = {}) {
  const c = src.adapterConfig, f = c.fields || {};
  if (!f.id || !f.address || !(c.windowFields || []).length) throw new Error('signal field map not set (run the probe)');
  const from = new Date(Date.now() - (c.windowDays || 180) * 864e5).toISOString().slice(0, 19);
  const where = ['(' + c.windowFields.map(x => `${x} > '${from}'`).join(' OR ') + ')', c.where].filter(Boolean).join(' AND ');
  const headers = config.socrataAppToken ? { 'X-App-Token': config.socrataAppToken } : {};
  const rows = [];
  for (let page = 0; page < (c.maxPages || 5); page++) {
    await throttle(src.id);
    const res = await fetchImpl(`https://${c.domain}/resource/${c.dataset}.json?${new URLSearchParams({ $where: where, $order: ':id', $limit: '1000', $offset: String(page * 1000) })}`, { headers });
    if (!res.ok) throw new Error(`land use ${res.status}`);
    const batch = await res.json(); rows.push(...batch); if (batch.length < 1000) break;
  }
  const out = { received: rows.length, kept: 0 };
  for (const r of rows) {
    if (!r[f.id] || !r[f.address]) continue;
    const link = r[f.link]?.url || (typeof r[f.link] === 'string' ? r[f.link] : null);
    store.put('signals', {
      id: `${src.key}:${r[f.id]}`, kind: 'land_use_application', state: src.state, city: src.city, sourceId: src.id,
      file: r[f.id], address: r[f.address], title: String(r[f.description] || r[f.type] || 'Land use application').slice(0, 500),
      type: r[f.type] || null, status: r[f.status] || null, introDate: r[f.appliedDate] || null, decisionDate: r[f.decisionDate] || null,
      url: link || `https://${c.domain}/resource/${c.dataset}.json?${encodeURIComponent(f.id)}=${encodeURIComponent(r[f.id])}`,
    });
    out.kept++;
  }
  return out;
}
