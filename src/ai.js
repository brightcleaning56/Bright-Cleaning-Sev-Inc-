// AI floor-plan analysis on plan-room drawings. Reports only what is printed on the sheets, cites the sheet for
// every item, and starts as "unverified" until a person checks it against the drawing.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { now } from './store.js';
import { canView } from './documents.js';
import { aiAllowance } from './entitlements.js';

export const PROMPT = `You are reading a commercial construction drawing set (PDF). Extract ONLY information that is printed on the sheets.
Rules:
- Never estimate, infer or compute an area that is not printed. If a room's area is not printed, set areaSqFt to null and basis to "not_stated".
- If an area is printed in a room tag or an area/room schedule, copy it exactly and set basis to "printed".
- Every room, material and scope item must cite the sheet number it came from (e.g. "A2.1"). If you cannot tell the sheet, use null.
- Do not invent sheet numbers, room names, dimensions, materials or levels.
Return ONLY a JSON object, no prose, with this shape:
{"sheets":[{"sheet":"A2.1","title":"LEVEL 1 FLOOR PLAN","level":"Level 1","scale":"1/8\\" = 1'-0\\""}],
 "rooms":[{"number":"101","name":"LOBBY","level":"Level 1","areaSqFt":2450,"basis":"printed","sheet":"A2.1"}],
 "finishes":[{"item":"Carpet tile CPT-1","location":"Offices","sheet":"A6.1"}],
 "scopes":[{"trade":"flooring","note":"Polished concrete in warehouse","sheet":"A2.1"}],
 "notes":["anything a bidder must know, with sheet references"],
 "confidence":"low|medium|high"}`;

const clean = v => (typeof v === 'string' ? v.slice(0, 300) : v);
function normalize(raw) {
  const arr = (x, f) => (Array.isArray(x) ? x.slice(0, 500).map(f).filter(Boolean) : []);
  const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e7 ? v : null);
  const rooms = arr(raw.rooms, r => r && typeof r === 'object' ? { number: clean(r.number ?? null), name: clean(r.name ?? null), level: clean(r.level ?? null),
    areaSqFt: r.basis === 'printed' ? num(r.areaSqFt) : null, basis: r.basis === 'printed' && num(r.areaSqFt) ? 'printed' : 'not_stated', sheet: clean(r.sheet ?? null) } : null);
  const printed = rooms.filter(r => r.basis === 'printed');
  return {
    sheets: arr(raw.sheets, x => x && typeof x === 'object' ? { sheet: clean(x.sheet ?? null), title: clean(x.title ?? null), level: clean(x.level ?? null), scale: clean(x.scale ?? null) } : null),
    rooms,
    finishes: arr(raw.finishes, x => x && typeof x === 'object' ? { item: clean(x.item), location: clean(x.location ?? null), sheet: clean(x.sheet ?? null) } : null),
    scopes: arr(raw.scopes, x => x && typeof x === 'object' ? { trade: clean(x.trade), note: clean(x.note), sheet: clean(x.sheet ?? null) } : null),
    notes: arr(raw.notes, x => (typeof x === 'string' ? x.slice(0, 500) : null)),
    confidence: ['low', 'medium', 'high'].includes(raw.confidence) ? raw.confidence : 'low',
    totals: { roomsFound: rooms.length, roomsWithPrintedArea: printed.length, printedAreaSqFt: printed.length ? printed.reduce((n, r) => n + r.areaSqFt, 0) : null },
  };
}

export function parseModelJson(text) {
  const t = String(text || '').replace(/```json|```/g, '').trim();
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the model did not return JSON');
  return JSON.parse(t.slice(start, end + 1));
}

/** One model call on one PDF → normalized result. Shared by the plan room and the accuracy harness. */
export async function readDrawing(buffer, name, { fetchImpl = fetch } = {}) {
  if (!config.anthropicKey) return { ok: false, code: 503, error: 'AI analysis is not switched on yet: add ANTHROPIC_API_KEY in Render' };
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: config.anthropicModel, max_tokens: 8000, messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
      { type: 'text', text: PROMPT + `\nFile name: ${name}` }] }] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, code: 502, error: `AI service error: ${body.error?.message || res.status}` };
  try { return { ok: true, result: normalize(parseModelJson((body.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'))), usage: body.usage || null }; }
  catch (e) { return { ok: false, code: 502, error: 'AI response could not be read: ' + e.message }; }
}

/** Score a reading against the known answer for that sheet. Inventing an area that isn't printed counts against it. */
export function scoreReading(result, truth) {
  const key = r => String(r.number || r.name || '').trim().toUpperCase();
  const truthRooms = new Map(truth.rooms.map(r => [key(r), r]));
  const got = new Map(result.rooms.map(r => [key(r), r]));
  const found = [...truthRooms.keys()].filter(k => got.has(k));
  const extra = [...got.keys()].filter(k => !truthRooms.has(k));
  const withArea = truth.rooms.filter(r => r.areaSqFt);
  const areaRight = withArea.filter(r => { const g = got.get(key(r)); return g && g.areaSqFt != null && Math.abs(g.areaSqFt - r.areaSqFt) <= 1; });
  const invented = result.rooms.filter(r => r.areaSqFt != null && !(truthRooms.get(key(r))?.areaSqFt)).length;
  return { truthRooms: truthRooms.size, roomsFound: found.length, roomRecall: truthRooms.size ? found.length / truthRooms.size : null,
    extraRooms: extra.length, roomPrecision: got.size ? found.length / got.size : null,
    printedAreas: withArea.length, areasExact: areaRight.length, areaAccuracy: withArea.length ? areaRight.length / withArea.length : null, inventedAreas: invented };
}

export async function analyzeDocument(store, org, user, docId, { fetchImpl = fetch } = {}) {
  if (!config.anthropicKey) return { ok: false, code: 503, error: 'AI analysis is not switched on yet: add ANTHROPIC_API_KEY in Render' };
  const d = store.get('documents', docId);
  if (!d || d.removed || !canView(store, org, d)) return { ok: false, code: 404, error: 'not found' };
  if (d.size > 30 * 1024 * 1024) return { ok: false, code: 413, error: 'file is too large to analyze (30 MB max)' };
  const today = new Date().toISOString().slice(0, 10);
  const plan = aiAllowance(org);
  if (!plan) return { ok: false, code: 402, error: 'AI drawing analysis is not included in your plan — upgrade to use it' };
  const limit = Math.min(config.aiDailyLimit, plan);                       // the plan's credits, never above the platform cap
  if (store.tlist('analyses', org.id, a => String(a.createdAt).startsWith(today)).length >= limit) return { ok: false, code: 429, error: `daily AI analysis limit reached (${limit} on your plan)` };
  const file = path.join(config.docDir, `${d.id}.pdf`);
  if (!fs.existsSync(file)) return { ok: false, code: 410, error: 'file is no longer available' };
  const out = await readDrawing(fs.readFileSync(file), d.name, { fetchImpl });
  if (!out.ok) return out;
  const { result, usage } = out;
  const a = store.tput('analyses', org.id, { documentId: d.id, requestId: d.requestId, documentName: d.name, sheet: d.sheet, model: config.anthropicModel,
    status: 'unverified', result, requestedBy: user.email, usage: usage || null });
  store.audit({ actor: user.email, orgId: org.id, action: 'ai.analyze', target: d.id, detail: { analysis: a.id, rooms: result.rooms.length } });
  return { ok: true, analysis: a };
}

export function verifyAnalysis(store, org, user, id, { note } = {}) {
  const a = store.tget('analyses', org.id, id);
  if (!a) return { ok: false, code: 404, error: 'not found' };
  Object.assign(a, { status: 'verified', verifiedBy: user.email, verifiedAt: now(), verifyNote: String(note || '').slice(0, 1000) });
  store.tput('analyses', org.id, a);
  store.audit({ actor: user.email, orgId: org.id, action: 'ai.verify', target: id });
  return { ok: true, analysis: a };
}
