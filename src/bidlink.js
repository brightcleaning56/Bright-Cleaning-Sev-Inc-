// Bid without signing in. An invited company gets a link in its invitation email. The link is signed with the
// server secret, names one invitation, and expires two days after the bids are due. It lets the holder see that
// one request and submit one bid for it. It grants nothing else: no account, no other requests, no plan room.
import { sign, unsign } from './security.js';
import { submitBid, TRADES } from './marketplace.js';

const LINK_KIND = 'bid';
const DAY = 864e5;
const NOT_FOUND = 'This bid link is invalid or has expired. Sign in to BUILDINTEL to see your invitations.';

export const bidLinkToken = (invitation, request) => sign({ i: invitation.id, k: LINK_KIND, x: Date.parse(request.dueDate) + 2 * DAY });

export function resolveBidLink(store, token) {
  const p = unsign(token);
  if (!p || p.k !== LINK_KIND || !(Number(p.x) > Date.now())) return { ok: false, code: 404, error: NOT_FOUND };
  const invitation = store.get('invitations', p.i);
  const request = invitation && store.get('bidRequests', invitation.requestId);
  const org = invitation && store.get('orgs', invitation.sellerOrgId);
  if (!invitation || !request || !org) return { ok: false, code: 404, error: NOT_FOUND };
  return { ok: true, invitation, request, org };
}

export function bidLinkView(store, token) {
  const x = resolveBidLink(store, token);
  if (!x.ok) return x;
  const { invitation: inv, request: r, org } = x;
  const labels = (r.trades || []).map(k => (TRADES.find(([key]) => key === k) || [k, k])[1]);
  return { ok: true, company: org.legal?.name || org.name,
    request: { title: r.title, address: r.address, city: r.city, state: r.state, projectType: r.projectType, dueDate: String(r.dueDate).slice(0, 10),
      description: r.description || '', trades: labels, buyerName: r.buyerName, addenda: r.addendumCount || 0, open: r.status === 'open' },
    addendaAcknowledged: (inv.ackAddendum || 0) >= (r.addendumCount || 0), submitted: !!inv.submissionId };
}

export function submitBidLink(store, token, body = {}) {
  const x = resolveBidLink(store, token);
  if (!x.ok) return x;
  const email = String(body.contactEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, code: 400, error: 'enter the work email the bid should come from' };
  if (String(body.contactName || '').trim().length < 2) return { ok: false, code: 400, error: 'enter your name' };
  if ((x.request.addendumCount || 0) > (x.invitation.ackAddendum || 0)) return { ok: false, code: 409, error: 'This request has addenda. Sign in to BUILDINTEL to review and acknowledge them before you bid.' };
  const r = submitBid(store, x.org, { email, name: String(body.contactName).trim().slice(0, 120) }, x.invitation.id,
    { amount: body.amount, scope: body.scope, exclusions: body.exclusions, documentUrl: body.documentUrl, validDays: body.validDays, recurring: !!body.recurring });
  if (r.ok) store.audit({ actor: email, orgId: x.org.id, action: 'bid.via_link', target: x.invitation.id, detail: { requestId: x.request.id } });
  return r;
}
