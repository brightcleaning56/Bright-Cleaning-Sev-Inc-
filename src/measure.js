// On-drawing takeoff: scale, lengths, areas, counts and notes on plan-room sheets.
// Points are stored in PDF units (1/72 inch on the printed sheet), so zoom never changes a result. The server
// recomputes every value from the points and the scale, so a quantity can't be typed in through the API.
import { now } from './store.js';
import { canView } from './documents.js';

// Feet per printed inch for common architectural and engineering scales.
export const SCALES = {
  '1/16" = 1\'-0"': 16, '3/32" = 1\'-0"': 32 / 3, '1/8" = 1\'-0"': 8, '3/16" = 1\'-0"': 16 / 3, '1/4" = 1\'-0"': 4, '3/8" = 1\'-0"': 8 / 3,
  '1/2" = 1\'-0"': 2, '3/4" = 1\'-0"': 4 / 3, '1" = 1\'-0"': 1, '1" = 10\'': 10, '1" = 20\'': 20, '1" = 30\'': 30, '1" = 40\'': 40, '1" = 50\'': 50, '1" = 100\'': 100,
};
export const KINDS = { linear: 'LF', area: 'SF', count: 'EA', note: null };
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const round2 = n => Math.round(n * 100) / 100;

/** Feet per PDF unit from a preset scale or a two-point calibration. */
export function resolveScale(scale) {
  if (!scale) return { error: 'set the drawing scale first' };
  if (scale.preset) {
    if (!SCALES[scale.preset]) return { error: 'unknown scale' };
    return { ftPerPt: SCALES[scale.preset] / 72, label: scale.preset, method: 'printed scale' };
  }
  if (scale.calibration) {
    const { p1, p2, lengthFt } = scale.calibration;
    if (!validPt(p1) || !validPt(p2) || !(Number(lengthFt) > 0)) return { error: 'calibration needs two points and a real length in feet' };
    const d = dist(p1, p2); if (d < 5) return { error: 'calibration points are too close together' };
    return { ftPerPt: Number(lengthFt) / d, label: `calibrated: ${Number(lengthFt)} ft`, method: 'two-point calibration' };
  }
  return { error: 'set the drawing scale first' };
}
const validPt = p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && v >= 0 && v <= 50000);

export function measureValue(kind, points, ftPerPt) {
  if (kind === 'count') return points.length;
  if (kind === 'note') return null;
  if (kind === 'linear') { let n = 0; for (let i = 1; i < points.length; i++) n += dist(points[i - 1], points[i]); return round2(n * ftPerPt); }
  // Shoelace formula for the polygon's area, converted to square feet.
  let a = 0; for (let i = 0; i < points.length; i++) { const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length]; a += x1 * y2 - x2 * y1; }
  return round2(Math.abs(a) / 2 * ftPerPt * ftPerPt);
}

export function saveMeasurement(store, org, user, docId, b) {
  const d = store.get('documents', docId);
  if (!d || d.removed || !canView(store, org, d)) return { ok: false, code: 404, error: 'not found' };
  if (!(b.kind in KINDS)) return { ok: false, code: 400, error: `kind must be ${Object.keys(KINDS).join(', ')}` };
  const points = Array.isArray(b.points) ? b.points : [];
  if (!points.length || !points.every(validPt)) return { ok: false, code: 400, error: 'points must be [x, y] pairs on the sheet' };
  const need = { linear: 2, area: 3, count: 1, note: 1 }[b.kind];
  if (points.length < need) return { ok: false, code: 400, error: `${b.kind} needs at least ${need} point(s)` };
  if (points.length > 2000) return { ok: false, code: 400, error: 'too many points' };
  let scale = null, value = null;
  if (b.kind === 'linear' || b.kind === 'area') {
    const sc = resolveScale(b.scale); if (sc.error) return { ok: false, code: 400, error: sc.error };
    scale = { ...b.scale, ftPerPt: sc.ftPerPt, label: sc.label, method: sc.method };
    value = measureValue(b.kind, points, sc.ftPerPt);
  } else if (b.kind === 'count') value = points.length;
  const text = String(b.label || '').trim().slice(0, 200);
  if (b.kind === 'note' && !text) return { ok: false, code: 400, error: 'a note needs text' };
  const m = store.tput('measurements', org.id, { documentId: d.id, requestId: d.requestId, sheet: d.sheet, page: Math.max(1, Math.floor(Number(b.page) || 1)),
    kind: b.kind, points, scale, value, unit: KINDS[b.kind], label: text || null, createdBy: user.email });
  store.audit({ actor: user.email, orgId: org.id, action: 'measure.save', target: m.id, detail: { documentId: d.id, kind: b.kind, value } });
  return { ok: true, measurement: m };
}

export const listMeasurements = (store, org, docId) => store.tlist('measurements', org.id, m => m.documentId === docId && !m.deleted).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
export function deleteMeasurement(store, org, id) {
  const m = store.tget('measurements', org.id, id); if (!m) return { ok: false, code: 404, error: 'not found' };
  if (m.deleted) return { ok: false, code: 404, error: 'not found' };
  store.tput('measurements', org.id, { ...m, deleted: true, deletedAt: now() }); // kept for the audit trail, hidden everywhere
  return { ok: true };
}
