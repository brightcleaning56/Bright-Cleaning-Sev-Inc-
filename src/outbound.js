import { config } from './config.js';
import { sign } from './security.js';
import { SENDABLE } from './domain.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function unsubscribeUrl(email) {
  return `${config.baseUrl}/u/${sign({ e: email.toLowerCase(), t: Date.now() })}`;
}

/** Hard checks every outbound bid email must pass. Returns list of blocking problems. */
export function outboundIssues(store, org, contact, proposal) {
  const i = [];
  const legal = org.legal || {};
  if (!legal.name) i.push('org legal name missing (CAN-SPAM sender identity)');
  if (!legal.postalAddress) i.push('org postal address missing (CAN-SPAM requires a valid physical address)');
  if (!org.senderEmail) i.push('org sender email missing');
  if (!contact?.email) i.push('recipient has no email');
  else {
    if (store.isSuppressed(contact.email)) i.push('recipient is suppressed (unsubscribed)');
    if (!SENDABLE.has(contact.status)) i.push(`recipient status "${contact.status}" is not sendable`);
  }
  if (!proposal?.html || !proposal?.total) i.push('proposal missing');
  if (proposal?.deadline && Date.parse(proposal.deadline) < Date.now()) i.push('bid deadline has passed');
  return i;
}

export function renderProposal(org, permit, estimate, opts = {}) {
  const legal = org.legal || {};
  const rows = estimate.lines.map(l => `<tr><td>${esc(l.service)}</td><td>${l.units.toLocaleString()} ${esc(l.unit)}${l.recurring ? ` × ${l.visitsPerMonth} visits/month (${money(l.perVisit)} per visit)` : ''}</td><td style="text-align:right">${money(l.price)}${l.recurring ? '/mo' : ''}</td></tr>`).join('');
  const totalLabel = estimate.recurring ? 'Total per month' : 'Total';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Proposal ${esc(permit.permitId)}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;color:#1d2731;max-width:720px;margin:32px auto;line-height:1.5}
table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}
.total{font-size:20px;font-weight:700}.fine{font-size:12px;color:#555}</style></head><body>
<h1>${esc(legal.name)} — Cleaning Proposal</h1>
<p><strong>Project:</strong> ${esc(permit.projectName || permit.description || 'Commercial project')}<br>
<strong>Location:</strong> ${esc(permit.address)}, ${esc(permit.city)}, ${esc(permit.state)}<br>
${permit.sourceUrl ? `<strong>Permit / solicitation:</strong> ${esc(permit.permitId)} (<a href="${esc(permit.sourceUrl)}">public record</a>)<br>` : `<strong>Request:</strong> ${esc(permit.permitId)}<br>`}
<strong>Prepared for:</strong> ${esc(opts.recipientCompany || permit.contractorOnPermit || 'General Contractor')}</p>
<table><tr><th>Service</th><th>Quantity</th><th style="text-align:right">Price</th></tr>${rows}
<tr><td colspan="2" class="total">${totalLabel}</td><td class="total" style="text-align:right">${money(estimate.total)}</td></tr></table>
<p class="fine">Quantities are based on ${permit.sourceUrl ? 'the square footage reported in the public permit record' : 'the square footage provided in your request'} and will be confirmed against plans or a site walk before contract. ${opts.credentials ? esc(opts.credentials) + '. ' : ''}Pricing valid for ${org.settings?.validDays || 30} days. This proposal is not a contract until accepted in writing by both parties. ${esc(org.settings?.proposalTerms || '')}</p>
<p>${esc(legal.name)}<br>${esc(legal.postalAddress)}<br>${esc(org.senderEmail)}${legal.phone ? ' · ' + esc(legal.phone) : ''}</p>
</body></html>`;
  return { html, total: estimate.total };
}

export function replyToFor(bidId) {
  if (!config.inboundReplyAddress || !bidId) return undefined;
  const [local, domain] = config.inboundReplyAddress.split('@');
  return `${local}+${bidId}@${domain}`;
}

export function buildEmail(org, contact, permit, proposal, bidId = null) {
  const unsub = unsubscribeUrl(contact.email);
  const legal = org.legal;
  const subject = `Cleaning proposal — ${permit.projectName || permit.address} (${permit.permitId})`;
  const text = `Hi ${contact.name.split(' ')[0]},

${legal.name} is submitting a final/post-construction cleaning proposal for ${permit.projectName || 'the project'} at ${permit.address}, ${permit.city} (permit ${permit.permitId}).

Proposed total: ${money(proposal.total)}. The full proposal is attached.

Quantities come from the public permit record and will be confirmed before contract.

${legal.name}
${legal.postalAddress}
${org.senderEmail}

You are receiving this because ${permit.contractorOnPermit || 'your company'} is listed on a public construction record. Unsubscribe: ${unsub}`;
  return {
    From: org.senderEmail, To: contact.email, Subject: subject, TextBody: text,
    Attachments: [{ Name: `proposal-${permit.permitId}.html`, Content: Buffer.from(proposal.html).toString('base64'), ContentType: 'text/html' }],
    Headers: [{ Name: 'List-Unsubscribe', Value: `<${unsub}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }],
    MessageStream: config.postmarkStream,
    ...(replyToFor(bidId) ? { ReplyTo: replyToFor(bidId) } : {}),
  };
}

/** One polite follow-up. Same identity, address and unsubscribe rules as the original. */
export function buildFollowUp(org, contact, permit, bid) {
  const unsub = unsubscribeUrl(contact.email);
  const legal = org.legal;
  return {
    From: org.senderEmail, To: contact.email,
    Subject: `Following up: cleaning proposal — ${permit.projectName || permit.address} (${permit.permitId})`,
    TextBody: `Hi ${contact.name.split(' ')[0]},

Following up on the cleaning proposal ${legal.name} sent for ${permit.address}, ${permit.city} (${money(bid.total)}). Happy to walk the site or adjust scope to your schedule. If someone else handles cleaning bids, a quick pointer would help.

${legal.name}
${legal.postalAddress}
${org.senderEmail}

Unsubscribe: ${unsub}`,
    Headers: [{ Name: 'List-Unsubscribe', Value: `<${unsub}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }],
    MessageStream: config.postmarkStream,
    ...(replyToFor(bid.id) ? { ReplyTo: replyToFor(bid.id) } : {}),
  };
}

/** Send through Postmark. In dry-run, nothing leaves the server and the result says so. */
export async function sendEmail(msg, { fetchImpl = fetch } = {}) {
  if (config.emailMode !== 'live') return { ok: true, dryRun: true, messageId: null };
  if (!config.postmarkToken) return { ok: false, error: 'POSTMARK_TOKEN missing' };
  if (!config.emailDomainVerified) return { ok: false, error: 'sending domain not verified (SPF/DKIM/DMARC)' };
  const res = await fetchImpl('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': config.postmarkToken },
    body: JSON.stringify(msg),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ErrorCode) return { ok: false, error: body.Message || `postmark ${res.status}` };
  if (!body.MessageID) return { ok: false, error: 'no MessageID returned' };
  return { ok: true, dryRun: false, messageId: body.MessageID };
}
