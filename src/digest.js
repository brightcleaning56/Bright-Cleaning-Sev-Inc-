// Weekly digest to each seller company's owners: what needs a decision, what's out, what's blocked.
// Transactional account email to the account's own owners. Recorded in messages either way.
import { config } from './config.js';
import { now } from './store.js';
import { analytics, directoryGaps } from './engagement.js';
import { expiringSoon } from './credentials.js';
import { readiness } from './readiness.js';
import { sendEmail } from './outbound.js';
import { collectAlerts } from './leads.js';
import { leadAccess } from './billing.js';
import { bidLinkToken } from './bidlink.js';

const DAY = 864e5;
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function buildDigest(store, org, { includePlatform = false } = {}) {
  const a = analytics(store, org.id);
  const pending = store.tlist('bids', org.id, b => b.status === 'pending_approval').sort((x, y) => y.total - x.total);
  const replies = store.tlist('bids', org.id, b => b.needsAttention);
  const gaps = directoryGaps(store, org.id).slice(0, 5);
  const creds = expiringSoon(store, org.id, 30);
  const failedSources = store.list('sources', s => s.enabled && s.lastError);
  const lines = [];
  lines.push(`BUILDINTEL weekly digest — ${org.name}`, '');
  lines.push(`Waiting for your approval: ${pending.length} bid(s), ${money(a.value.awaitingApproval)}`);
  for (const b of pending.slice(0, 5)) {
    const o = store.tget('opportunities', org.id, b.opportunityId);
    const p = (o?.permitId && store.get('permits', o.permitId)) || o?.project || {};
    lines.push(`  • ${p.projectName || p.description || 'Project'} — ${p.address || ''}, ${p.city || ''}: ${money(b.total)}${b.recurring ? '/mo' : ''}`);
  }
  lines.push(`Replies to read: ${replies.length}`);
  lines.push(`Out with GCs and buyers: ${money(a.value.outstanding)}`);
  lines.push(`Won to date: ${money(a.value.won)}${a.winRate == null ? '' : ` (win rate ${a.winRate}%)`}`, '');
  if (gaps.length) {
    lines.push('Add these GC contacts to unlock bids:');
    for (const g of gaps) lines.push(`  • ${g.contractor}: ${g.projects} project(s), ${money(g.blockedValue)} waiting`);
    lines.push('');
  }
  if (creds.length) {
    lines.push('Insurance / licenses expiring within 30 days:');
    for (const c of creds) lines.push(`  • ${c.type.toUpperCase()} ${c.number} (${c.issuer}) ${c.expired ? 'EXPIRED' : 'expires'} ${c.expiresAt.slice(0, 10)}`);
    lines.push('');
  }
  if (failedSources.length) {
    lines.push('Data sources with errors:');
    for (const s of failedSources) lines.push(`  • ${s.name}: ${s.lastError}`);
    lines.push('');
  }
  if (includePlatform) {
    const r = readiness(store);
    lines.push(`Launch gates: ${r.verdict} (${r.passed}/${r.total}). Open: ${r.gates.filter(g => g.status !== 'pass').map(g => g.name).join('; ')}`, '');
  }
  lines.push(`Open the dashboard: ${config.baseUrl}/app`);
  return { subject: `BUILDINTEL: ${pending.length} to approve, ${replies.length} replies, ${money(a.value.outstanding)} out`, text: lines.join('\n') };
}

export async function sendDigests(store, { fetchImpl, force = false } = {}) {
  const out = [];
  for (const org of store.list('orgs', o => o.status === 'active' && o.kind !== 'buyer')) {
    if (!force && org.lastDigestAt && Date.now() - Date.parse(org.lastDigestAt) < 6.5 * DAY) continue;
    if (!force && org.settings?.digestDay !== undefined && new Date().getDay() !== org.settings.digestDay) continue;
    const owners = store.list('users', u => u.orgId === org.id && ['owner', 'platform_owner'].includes(u.role) && !u.disabled);
    for (const u of owners) {
      const d = buildDigest(store, org, { includePlatform: u.role === 'platform_owner' });
      const from = config.platformFrom || org.senderEmail;
      const r = from ? await sendEmail({ From: from, To: u.email, Subject: d.subject, TextBody: d.text, MessageStream: config.postmarkStream }, { fetchImpl })
        : { ok: false, error: 'no PLATFORM_FROM or sender email' };
      store.put('messages', { orgId: org.id, kind: 'digest', to: u.email, dryRun: !!r.dryRun, messageId: r.messageId || null, error: r.ok ? null : r.error, preview: r.dryRun ? d : undefined });
      out.push({ org: org.slug, to: u.email, ok: r.ok, dryRun: !!r.dryRun });
    }
    org.lastDigestAt = now(); store.put('orgs', org);
  }
  return out;
}

/** Daily saved-search alerts for every subscriber with lead access. One email per search with hits. */
export async function sendLeadAlerts(store, { fetchImpl, force = false } = {}) {
  const out = [];
  for (const org of store.list('orgs', o => o.status === 'active' && o.kind !== 'buyer' && leadAccess(o).ok)) {
    for (const { search, hits } of collectAlerts(store, org)) {
      if (!force && search.lastRunAt && Date.now() - Date.parse(search.lastRunAt) < 20 * 3600e3) continue;
      if (hits.length) {
        const lines = [`${hits.length} new or updated project(s) for "${search.name}":`, ''];
        for (const h of hits.slice(0, 25)) {
          lines.push(`• ${h.title} — ${h.address}, ${h.city}, ${h.state}`);
          lines.push(`  ${h.why}; ${h.stage.replace('_', ' ')}${h.valuation ? `; reported value $${Number(h.valuation).toLocaleString()}` : ''}${h.estimatedStart ? `; est. start ${h.estimatedStart}` : ''}`);
          lines.push(`  ${config.baseUrl}/app#project/${h.id}`);
        }
        if (hits.length > 25) lines.push('', `…and ${hits.length - 25} more in the app.`);
        lines.push('', `Manage alerts: ${config.baseUrl}/app`);
        const from = config.platformFrom || org.senderEmail;
        const r = from ? await sendEmail({ From: from, To: search.alertEmail, Subject: `BUILDINTEL: ${hits.length} project(s) for "${search.name}"`, TextBody: lines.join('\n'), MessageStream: config.postmarkStream }, { fetchImpl })
          : { ok: false, error: 'no PLATFORM_FROM configured' };
        store.put('messages', { orgId: org.id, kind: 'lead_alert', searchId: search.id, to: search.alertEmail, hits: hits.length, dryRun: !!r.dryRun, messageId: r.messageId || null, error: r.ok ? null : r.error, preview: r.dryRun ? lines.join('\n') : undefined });
        out.push({ org: org.slug, search: search.name, hits: hits.length, ok: r.ok });
      }
      search.lastRunAt = now(); search.lastHits = hits.length; store.tput('savedSearches', org.id, search);
    }
    // Tracked projects: tell the team the moment a permit they're watching changes stage.
    const changes = [];
    for (const t of store.tlist('tracked', org.id)) {
      const p = store.get('permits', t.permitId); if (!p) continue;
      const since = t.lastNotifiedAt || t.createdAt;
      const fresh = (p.statusHistory || []).filter(h => Date.parse(h.at) > Date.parse(since));
      if (fresh.length) {
        const h = p.statusHistory || [];
        const atNotice = h.filter(x => Date.parse(x.at) <= Date.parse(since)).at(-1); // what the team last knew
        const from = atNotice ? atNotice.status : (h.length >= 2 ? h[h.length - 2].status : 'new');
        if (from !== fresh.at(-1).status) changes.push({ t, p, from, to: fresh.at(-1).status });
      }
    }
    if (changes.length) {
      const owners = store.list('users', u => u.orgId === org.id && ['owner', 'platform_owner'].includes(u.role) && !u.disabled);
      const lines = [`${changes.length} tracked project(s) changed stage:`, ''];
      for (const c of changes) lines.push(`• ${c.p.projectName || c.p.description || 'Project'} — ${c.p.address}, ${c.p.city}: ${c.from} → ${c.to} (you marked it "${c.t.stage}")`, `  ${config.baseUrl}/app#project/${c.p.id}`);
      const from = config.platformFrom || org.senderEmail;
      for (const u of owners) {
        const r = from ? await sendEmail({ From: from, To: u.email, Subject: `BUILDINTEL: ${changes.length} tracked project(s) changed stage`, TextBody: lines.join('\n'), MessageStream: config.postmarkStream }, { fetchImpl })
          : { ok: false, error: 'no PLATFORM_FROM configured' };
        store.put('messages', { orgId: org.id, kind: 'stage_alert', to: u.email, changes: changes.length, dryRun: !!r.dryRun, messageId: r.messageId || null, error: r.ok ? null : r.error, preview: r.dryRun ? lines.join('\n') : undefined });
      }
      for (const c of changes) { c.t.lastNotifiedAt = now(); store.tput('tracked', org.id, c.t); }
      out.push({ org: org.slug, stageChanges: changes.length });
    }
  }
  return out;
}

/** Tell each invited company about new invitations to bid (one email per company per batch). */

// Notification control for invitation emails (subscriber companies). Competitors' users complain about
// invitation email overload; this lets a company choose a daily digest and caps emails per day.
// Invitations always appear in the app at once. Only the email is batched.
export function notificationPrefs(org) {
  const n = org?.settings?.notifications || {};
  return { mode: n.mode === 'daily_digest' ? 'daily_digest' : 'immediate', maxPerDay: Math.min(20, Math.max(1, Number(n.maxPerDay) || 3)) };
}
export function batchingGate(org, prefs, at = new Date()) {
  const log = org?.settings?.notificationLog || {};
  if (prefs.mode === 'daily_digest' && log.lastAt && at - Date.parse(log.lastAt) < 24 * 3600e3) return { send: false, reason: 'daily digest: the next batch goes out 24 hours after the last one' };
  const today = at.toISOString().slice(0, 10);
  const count = log.day === today ? log.count || 0 : 0;
  if (count >= prefs.maxPerDay) return { send: false, reason: 'daily email limit reached for today' };
  return { send: true };
}
export function recordNotificationSent(org, at = new Date()) {
  const log = org.settings?.notificationLog || {};
  const today = at.toISOString().slice(0, 10);
  org.settings = { ...(org.settings || {}), notificationLog: { lastAt: at.toISOString(), day: today, count: (log.day === today ? log.count || 0 : 0) + 1 } };
}

export async function sendInvitationNotices(store, { fetchImpl } = {}) {
  // Addenda: every invited bidder is told when a new addendum is posted.
  for (const i of store.list('invitations', i => i.notifiedAt)) {
    const r = store.get('bidRequests', i.requestId);
    if (r?.status === 'open' && (r.addendumCount || 0) > (i.addendumNotified || 0)) {
      const org = store.get('orgs', i.sellerOrgId); const last = r.addenda.at(-1);
      const text = `Addendum ${r.addendumCount} was posted for "${r.title}" (${r.address}, ${r.city}).${last?.note ? '\n\n' + last.note : ''}\n\nReview and acknowledge it before bidding: ${config.baseUrl}/app#invitations`;
      const from = config.platformFrom || org?.senderEmail;
      for (const u of store.list('users', u => u.orgId === i.sellerOrgId && !u.disabled)) {
        const res = from ? await sendEmail({ From: from, To: u.email, Subject: last?.kind === 'deadline' ? `Bid due date changed: ${r.title}` : `Addendum ${r.addendumCount}: ${r.title}`, TextBody: text, MessageStream: config.postmarkStream }, { fetchImpl }) : { ok: false, error: 'no PLATFORM_FROM configured' };
        store.put('messages', { orgId: i.sellerOrgId, kind: 'addendum_notice', to: u.email, dryRun: !!res.dryRun, messageId: res.messageId || null, error: res.ok ? null : res.error, preview: res.dryRun ? text : undefined });
      }
      i.addendumNotified = r.addendumCount; store.put('invitations', i);
    }
  }
  const pending = store.list('invitations', i => !i.notifiedAt);
  const byOrg = new Map();
  for (const i of pending) { const r = store.get('bidRequests', i.requestId); if (!r || r.status !== 'open') { i.notifiedAt = now(); store.put('invitations', i); continue; } (byOrg.get(i.sellerOrgId) || byOrg.set(i.sellerOrgId, []).get(i.sellerOrgId)).push({ i, r }); }
  const out = [];
  for (const [orgId, items] of byOrg) {
    const org = store.get('orgs', orgId); if (!org) continue;
    const gate = batchingGate(org, notificationPrefs(org));
    if (!gate.send) { out.push({ org: org.slug, invitations: items.length, deferred: gate.reason }); continue; }
    const owners = store.list('users', u => u.orgId === orgId && ['owner', 'platform_owner', 'member'].includes(u.role) && !u.disabled);
    const lines = [`You've been invited to bid on ${items.length} project(s):`, ''];
    for (const { i: inv, r } of items) lines.push(`• ${r.title} — ${r.address}, ${r.city}, ${r.state}`, `  From ${r.buyerName} · bids due ${String(r.dueDate).slice(0, 10)}`,
      `  Bid without signing in (this link expires two days after bids are due): ${config.baseUrl}/bid/${bidLinkToken(inv, r)}`, `  Or sign in to see all your invitations: ${config.baseUrl}/app#invitations`);
    const from = config.platformFrom || org.senderEmail;
    for (const u of owners) {
      const r = from ? await sendEmail({ From: from, To: u.email, Subject: `BUILDINTEL: ${items.length} invitation(s) to bid`, TextBody: lines.join('\n'), MessageStream: config.postmarkStream }, { fetchImpl })
        : { ok: false, error: 'no PLATFORM_FROM configured' };
      store.put('messages', { orgId, kind: 'invitation_notice', to: u.email, dryRun: !!r.dryRun, messageId: r.messageId || null, error: r.ok ? null : r.error, preview: r.dryRun ? lines.join('\n') : undefined });
    }
    recordNotificationSent(org); store.put('orgs', org);
    for (const { i } of items) { i.notifiedAt = now(); store.put('invitations', i); }
    out.push({ org: org.slug, invitations: items.length });
  }
  return out;
}
