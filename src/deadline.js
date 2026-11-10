// Changing the bid due date of a published package. Published scope and dates are never edited in place: a deadline change
// is recorded as an addendum (numbered, with the old and new date and the buyer's reason), so every invited bidder must
// acknowledge it before bidding. The existing addendum notice carries the change to each invited company.
import { now } from './store.js';
import { can } from './publishing.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const day = v => String(v).slice(0, 10);

export function changeDeadline(store, buyerOrg, user, requestId, body = {}) {
  const r = store.get('bidRequests', requestId);
  if (!r || r.buyerOrgId !== buyerOrg.id) return { ok: false, code: 404, error: 'not found' };
  if (!can(user, 'publish')) return { ok: false, code: 403, error: 'no permission to change dates' };
  if (r.status !== 'open') return { ok: false, code: 409, error: 'only a published package can have its deadline changed' };
  const raw = String(body.dueDate || '').trim();
  const next = DATE_ONLY.test(raw) ? raw : (Number.isNaN(Date.parse(raw)) ? null : new Date(raw).toISOString());
  if (!next || Date.parse(next) <= Date.now()) return { ok: false, code: 400, error: 'the new due date must be in the future' };
  if (day(next) === day(r.dueDate)) return { ok: false, code: 400, error: 'that is the same date as the current deadline' };
  const note = String(body.note || '').trim().slice(0, 1000);
  if (!note) return { ok: false, code: 400, error: 'give the bidders a reason for the change' };
  const number = (r.addendumCount || 0) + 1;
  const text = `Bid due date changed from ${day(r.dueDate)} to ${day(next)}.\n\n${note}`;
  const old = r.dueDate;
  r.dueDate = next; r.addendumCount = number;
  r.addenda = [...(r.addenda || []), { number, note: text, at: now(), by: user.email, kind: 'deadline', previousDueDate: old }];
  store.put('bidRequests', r);
  store.audit({ actor: user.email, orgId: buyerOrg.id, action: 'request.deadline', target: r.id, detail: { from: old, to: next, addendum: number } });
  return { ok: true, request: r, addendum: number };
}
