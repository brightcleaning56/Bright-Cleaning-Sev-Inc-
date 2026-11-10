// Questions about a bid package (requests for information). An invited company asks; the GC answers; every invited
// company sees the question and answer (the asker's name is not shown to other bidders). Questions close when the
// package closes. The GC is told of new questions; invited companies are told of answers.
import { config } from './config.js';
import { enqueueEmail, drainOutbox } from './outbox.js';

const invitedOrgs = (store, requestId) => store.list('invitations', i => i.requestId === requestId).map(i => i.sellerOrgId);

export function askQuestion(store, org, user, requestId, question) {
  const r = store.get('bidRequests', requestId);
  if (!r) return { ok: false, code: 404, error: 'not found' };
  if (!invitedOrgs(store, requestId).includes(org.id)) return { ok: false, code: 403, error: 'only invited companies can ask questions about this package' };
  if (r.status !== 'open') return { ok: false, code: 409, error: 'questions are closed for this package' };
  const q = String(question || '').trim();
  if (q.length < 10) return { ok: false, code: 400, error: 'write the question in at least 10 characters' };
  const rfi = store.put('rfis', { requestId, askedByOrgId: org.id, askedByName: org.legal?.name || org.name, askedByEmail: user.email, question: q.slice(0, 2000),
    askedAt: new Date().toISOString(), answer: null, answeredAt: null, answeredBy: null });
  store.audit({ actor: user.email, orgId: org.id, action: 'rfi.ask', target: rfi.id, detail: { requestId } });
  return { ok: true, rfi };
}

export function answerQuestion(store, buyerOrg, user, requestId, rfiId, answer) {
  const r = store.get('bidRequests', requestId);
  if (!r || r.buyerOrgId !== buyerOrg.id) return { ok: false, code: 404, error: 'not found' };
  const rfi = store.get('rfis', rfiId);
  if (!rfi || rfi.requestId !== requestId) return { ok: false, code: 404, error: 'not found' };
  const a = String(answer || '').trim();
  if (a.length < 5) return { ok: false, code: 400, error: 'write the answer in at least 5 characters' };
  rfi.answer = a.slice(0, 4000); rfi.answeredAt = new Date().toISOString(); rfi.answeredBy = user.email;
  store.put('rfis', rfi);
  store.audit({ actor: user.email, orgId: buyerOrg.id, action: 'rfi.answer', target: rfi.id, detail: { requestId } });
  return { ok: true, rfi };
}

// What a company sees: every question on packages it is invited to. The asker's name is shown only to the GC.
export function questionsFor(store, org, requestId, { gc = false } = {}) {
  return store.list('rfis', x => x.requestId === requestId).sort((a, b) => a.askedAt.localeCompare(b.askedAt)).map(x => ({
    id: x.id, question: x.question, askedAt: x.askedAt, answer: x.answer, answeredAt: x.answeredAt,
    askedByName: gc || x.askedByOrgId === org.id ? x.askedByName : 'Another invited company', mine: x.askedByOrgId === org.id }));
}

export async function notifyRfiAnswer(store, request, rfi, { fetchImpl = fetch } = {}) {
  const text = `A question was answered on ${request.title} (${request.address}, ${request.city}, ${request.state}).\n\nQ: ${rfi.question}\nA: ${rfi.answer}\n\nSee it in BUILDINTEL: ${config.baseUrl}/app#invitations`;
  for (const orgId of invitedOrgs(store, request.id)) {
    for (const u of store.list('users', x => x.orgId === orgId && !x.disabled && ['owner', 'platform_owner', 'member'].includes(x.role))) {
      enqueueEmail(store, { orgId, kind: 'rfi_answer', to: u.email, subject: `BUILDINTEL: question answered on ${request.title}`, text });
    }
  }
  await drainOutbox(store, { fetchImpl });
}
