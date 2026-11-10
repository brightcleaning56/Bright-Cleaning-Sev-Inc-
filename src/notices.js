// Award and regret notices. The winner is told its contract is ready to countersign; every other bidder is told it was
// not selected. Notices are transactional: they are sent for each award, not batched. A failed email never undoes an award.
import { sendEmail } from './outbound.js';
import { config } from './config.js';

const DAY = 864e5;
const fromAddress = () => config.platformFrom || 'no-reply@' + new URL(config.baseUrl).hostname;
const recipients = (store, orgId) => store.list('users', u => u.orgId === orgId && !u.disabled && ['owner', 'platform_owner', 'member'].includes(u.role)).map(u => u.email);

export async function sendAwardNotices(store, request, winner, others, { fetchImpl = fetch } = {}) {
  const sent = { winner: 0, regrets: 0, failed: 0 };
  const send = async (orgId, subject, text, kind) => {
    for (const to of recipients(store, orgId)) {
      try {
        const r = await sendEmail({ From: fromAddress(), To: to, Subject: subject, TextBody: text, MessageStream: config.postmarkStream }, { fetchImpl });
        store.put('messages', { orgId, kind, to, dryRun: !!r.dryRun, messageId: r.messageId || null, error: r.ok === false ? r.error : null, preview: r.dryRun ? text : undefined });
        if (r.ok === false) sent.failed++;
        else if (kind === 'award_notice') sent.winner++; else sent.regrets++;
      } catch (e) { sent.failed++; store.put('messages', { orgId, kind, to, error: e.message }); }
    }
  };
  const where = `${request.title} (${request.address}, ${request.city}, ${request.state})`;
  await send(winner.sellerOrgId, `BUILDINTEL: you were awarded ${request.title}`,
    `Congratulations. ${request.buyerName} has awarded you ${where}.\n\nThe contract is ready for your countersignature. Review it and countersign in BUILDINTEL: ${config.baseUrl}/app#contracts\n\nThe contract records the proposal you submitted and the customer's signature. Please countersign before work starts.`, 'award_notice');
  for (const o of others) {
    await send(o.sellerOrgId, `BUILDINTEL: ${request.title} was awarded to another company`,
      `Thank you for bidding on ${where}. ${request.buyerName} has awarded this work to another company, so your bid was not selected.\n\nYou can see your other invitations in BUILDINTEL: ${config.baseUrl}/app#invitations`, 'regret_notice');
  }
  return sent;
}
