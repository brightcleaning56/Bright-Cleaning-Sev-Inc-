// Subscriber → GC outreach from a project page. Commercial email rules (CAN-SPAM): real sender identity,
// a postal address, a working unsubscribe, and suppression honored platform-wide. Logged to the project's notes.
import { config } from './config.js';
import { now } from './store.js';
import { SENDABLE, normName } from './domain.js';
import { sendEmail, unsubscribeUrl } from './outbound.js';
import { projectDetail, trackProject } from './leads.js';

export async function contactFromProject(store, org, user, permitId, { contactId, message }, { fetchImpl } = {}) {
  const d = projectDetail(store, org, permitId);
  if (!d.ok) return d;
  const legal = org.legal || {};
  if (!legal.name || !legal.postalAddress) return { ok: false, code: 400, error: 'add your company legal name and postal address in Plan & profile first (required by law on business email)' };
  const c = store.get('contacts', contactId);
  if (!c || !c.email) return { ok: false, code: 404, error: 'contact not found' };
  const co = store.get('companies', c.companyId);
  const named = [d.project.contractorOnPermit, d.project.owner, d.project.architect].filter(Boolean).map(normName);
  if (!co || !named.includes(co.normName)) return { ok: false, code: 400, error: 'that contact is not tied to this project' };
  if (!SENDABLE.has(c.status)) return { ok: false, code: 400, error: 'only verified contacts can be emailed from BUILDINTEL' };
  if (store.isSuppressed(c.email)) return { ok: false, code: 400, error: 'this person has opted out of emails' };
  const text = String(message || '').trim();
  if (text.length < 20) return { ok: false, code: 400, error: 'write a short message (at least a sentence)' };
  if (text.length > 4000) return { ok: false, code: 400, error: 'message is too long' };
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = store.list('messages', m => m.kind === 'outreach' && m.orgId === org.id && String(m.createdAt || '').startsWith(today)).length;
  if (sentToday >= 25) return { ok: false, code: 429, error: 'daily outreach limit reached (25 per company)' };
  if (store.list('messages', m => m.kind === 'outreach' && m.orgId === org.id && m.to === c.email && m.permitId === permitId).length) return { ok: false, code: 409, error: 'you already contacted this person about this project' };
  const p = d.project;
  const body = `${text}\n\n—\n${user.name || user.email}, ${legal.name}\n${legal.postalAddress}${org.profile?.phone ? '\n' + org.profile.phone : ''}\nRe: ${p.title}, ${p.address}, ${p.city} (permit ${p.permitId})\n\nSent through BUILDINTEL because your company is named on this public permit. Unsubscribe: ${unsubscribeUrl(c.email)}`;
  const unsub = unsubscribeUrl(c.email);
  const from = config.platformFrom || org.senderEmail;
  const r = from ? await sendEmail({ From: from, To: c.email, ReplyTo: user.email, Subject: `${legal.name} re: ${p.title} (${p.address})`, TextBody: body,
    Headers: [{ Name: 'List-Unsubscribe', Value: `<${unsub}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }], MessageStream: config.postmarkStream }, { fetchImpl })
    : { ok: false, error: 'email sending is not set up yet' };
  store.put('messages', { kind: 'outreach', orgId: org.id, permitId, contactId: c.id, to: c.email, from: user.email, dryRun: !!r.dryRun, messageId: r.messageId || null, error: r.ok ? null : r.error, preview: r.dryRun ? body : undefined });
  trackProject(store, org, user, permitId, { stage: 'contacted', note: `${r.ok && !r.dryRun ? 'Emailed' : 'Prepared email to'} ${c.name} (${c.email}) via BUILDINTEL` });
  return { ok: true, sent: !!(r.ok && !r.dryRun), queued: !!r.dryRun, note: r.dryRun ? 'Saved. It will send once platform email is turned on.' : r.ok ? 'Sent.' : r.error };
}
