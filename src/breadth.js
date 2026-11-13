// Bid breadth: how wide the bidding is for a package, and what would widen it. Everything is counted from stored records.
// The recommendations are plain, specific, and only shown when the numbers support them.
import { now } from './store.js';
import { enqueueEmail, drainOutbox } from './outbox.js';
import { config } from './config.js';
import { searchBidders } from './publishing.js';
import { inviteCompanies } from './marketplace.js';

const DAY = 864e5;
const REMIND_COOLDOWN = 2 * DAY;

export function bidBreadth(store, pkg, { at = Date.now() } = {}) {
  const invitations = store.list('invitations', i => i.requestId === pkg.id);
  const invited = new Set(invitations.map(i => i.sellerOrgId));
  const responded = invitations.filter(i => i.intent && i.intent !== 'undecided');
  const bidders = new Set(store.list('submissions', s => s.requestId === pkg.id).map(s => s.sellerOrgId));
  const willBid = invitations.filter(i => i.intent === 'will_bid').length;
  const notAnswered = invitations.filter(i => !i.intent || i.intent === 'undecided');
  const eligibleNotInvited = pkg.distribution === 'invite_only' ? [] :
    searchBidders(store, { packageId: pkg.id, limit: 200, at }).filter(r => r.eligible && !invited.has(r.id));
  const daysLeft = Math.ceil((Date.parse(pkg.dueDate) + DAY - at) / DAY);
  const open = pkg.status === 'open' && daysLeft >= 0;
  const actions = [];
  if (open && eligibleNotInvited.length) actions.push({ key: 'invite_eligible', label: `Invite ${eligibleNotInvited.length} eligible compan${eligibleNotInvited.length === 1 ? 'y' : 'ies'} not yet on the list`, count: eligibleNotInvited.length });
  if (open && notAnswered.length) {
    const lastRemind = pkg.lastRemindedAt ? Date.parse(pkg.lastRemindedAt) : 0;
    const cooling = at - lastRemind < REMIND_COOLDOWN;
    actions.push({ key: 'remind', label: `Remind ${notAnswered.length} invited compan${notAnswered.length === 1 ? 'y' : 'ies'} that have not answered`, count: notAnswered.length, disabled: cooling, note: cooling ? 'Reminded in the last two days.' : null });
  }
  if (open && bidders.size < 3 && daysLeft <= 7) actions.push({ key: 'extend', label: 'Fewer than three bids with a week or less to go: consider moving the deadline (an addendum tells every invited company)', count: bidders.size });
  return {
    invited: invited.size, responded: responded.length, willBid, bids: bidders.size, notAnswered: notAnswered.length,
    eligibleNotInvited: eligibleNotInvited.length, daysLeft, open,
    lastRemindedAt: pkg.lastRemindedAt || null,
    status: !open ? 'closed' : bidders.size >= 3 ? 'healthy' : bidders.size === 0 && daysLeft <= 3 ? 'at_risk' : 'thin',
    actions,
  };
}

/** Sends a reminder to every invited company that has not answered. Once per package every two days. */
export async function remindUnanswered(store, org, user, pkg, { at = Date.now(), fetchImpl = fetch } = {}) {
  const b = bidBreadth(store, pkg, { at });
  if (!b.open) return { ok: false, code: 409, error: 'only an open package can be reminded' };
  if (pkg.lastRemindedAt && at - Date.parse(pkg.lastRemindedAt) < REMIND_COOLDOWN) return { ok: false, code: 429, error: 'companies were reminded in the last two days' };
  const targets = store.list('invitations', i => i.requestId === pkg.id && (!i.intent || i.intent === 'undecided'));
  let queued = 0;
  for (const inv of targets) {
    for (const u of store.list('users', x => x.orgId === inv.sellerOrgId && !x.disabled && ['owner', 'platform_owner', 'member'].includes(x.role))) {
      enqueueEmail(store, { orgId: inv.sellerOrgId, kind: 'bid_reminder', to: u.email, subject: `Reminder: bids due ${String(pkg.dueDate).slice(0, 10)} for ${pkg.title}`,
        text: `${pkg.buyerName} invited you to bid on ${pkg.title} (${pkg.address}, ${pkg.city}, ${pkg.state}). Bids are due ${String(pkg.dueDate).slice(0, 10)}.\n\nTell them whether you will bid, or pass, in BUILDINTEL: ${config.baseUrl}/app#invitations` });
      queued++;
    }
  }
  pkg.lastRemindedAt = new Date(at).toISOString(); store.put('bidRequests', pkg);
  store.audit({ actor: user.email, orgId: org.id, action: 'request.remind', target: pkg.id, detail: { invitations: targets.length, queued } });
  await drainOutbox(store, { fetchImpl });
  return { ok: true, invitations: targets.length, queued };
}

/** Invites every eligible company that is not yet on the list (for packages open to eligible companies). */
export function inviteEligible(store, org, user, pkg, { at = Date.now() } = {}) {
  if (!pkg.status || pkg.status === 'draft') return { ok: false, code: 409, error: 'publish the project first; draft packages take invitations at publication' };
  if (pkg.distribution === 'invite_only') return { ok: false, code: 409, error: 'this package is invite-only; add companies by name' };
  const ids = searchBidders(store, { packageId: pkg.id, limit: 200, at }).filter(r => r.eligible && !r.invited).map(r => r.id);
  const n = inviteCompanies(store, pkg, ids);
  store.audit({ actor: user.email, orgId: org.id, action: 'request.invite_eligible', target: pkg.id, detail: { invited: n } });
  return { ok: true, invited: n };
}

/**
 * Scheduled reminders: for each open package closing within three days, remind the invited companies that have not
 * answered. Uses the same rules as the manual reminder (only unanswered companies, at most once every two days).
 */
export async function autoRemind(store, { at = Date.now(), fetchImpl = fetch } = {}) {
  const sent = [];
  for (const pkg of store.list('bidRequests', r => r.status === 'open' && r.publicationId)) {
    const daysLeft = Math.ceil((Date.parse(pkg.dueDate) + DAY - at) / DAY);
    if (daysLeft < 0 || daysLeft > 3) continue;
    if (!store.list('invitations', i => i.requestId === pkg.id && (!i.intent || i.intent === 'undecided')).length) continue;
    const org = store.get('orgs', pkg.buyerOrgId);
    const owner = store.list('users', u => u.orgId === pkg.buyerOrgId && u.role === 'owner' && !u.disabled)[0];
    if (!org || !owner) continue;
    const x = await remindUnanswered(store, org, { id: 'system', email: 'automatic reminder' }, pkg, { at, fetchImpl });
    if (x.ok) sent.push({ packageId: pkg.id, queued: x.queued });
  }
  return sent;
}
