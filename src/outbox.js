// Transactional outbox for email raised by request handlers (award and regret notices, amendment notices, question answers).
// A handler records the message in the 'outbox' collection, which is saved with the rest of the data, and then tries to send
// it straight away. A message that cannot be sent is kept and retried with a growing wait, so a mail outage or a restart
// does not lose it. After MAX_ATTEMPTS the message is marked failed and the reason is kept in the message log.
import { sendEmail } from './outbound.js';
import { config } from './config.js';
import { now } from './store.js';

export const MAX_ATTEMPTS = 5;
const fromAddress = () => config.platformFrom || 'no-reply@' + new URL(config.baseUrl).hostname;
const minutes = n => n * 60e3;

/** Records one email for sending. Returns the outbox row. Never sends by itself. */
export function enqueueEmail(store, { orgId, kind, to, subject, text }) {
  return store.put('outbox', { orgId, kind, to, subject, text, from: fromAddress(), status: 'pending', attempts: 0,
    nextAt: now(), lastError: null, sentAt: null, createdAt: now() });
}

/**
 * Sends every pending message that is due. Each send is logged in 'messages' as before. A failure is retried at 1, 2, 4 and 8
 * minutes; the fifth failure marks the message failed. Runs one at a time: a second call while one is running does nothing.
 */
export async function drainOutbox(store, { fetchImpl = fetch, at = Date.now(), limit = 50 } = {}) {
  const r = await store.withLock('outbox', async () => {
    const due = store.list('outbox', x => x.status === 'pending' && Date.parse(x.nextAt) <= at)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, limit);
    const out = { sent: 0, retrying: 0, failed: 0 };
    for (const row of due) {
      let res;
      try {
        res = await sendEmail({ From: row.from, To: row.to, Subject: row.subject, TextBody: row.text, MessageStream: config.postmarkStream }, { fetchImpl });
      } catch (e) { res = { ok: false, error: e.message }; }
      row.attempts += 1;
      if (res.ok) {
        row.status = 'sent'; row.sentAt = now(); row.lastError = null;
        store.put('messages', { orgId: row.orgId, kind: row.kind, to: row.to, dryRun: !!res.dryRun, messageId: res.messageId || null, error: null, preview: res.dryRun ? row.text : undefined });
        out.sent++;
      } else {
        row.lastError = res.error || 'send failed';
        if (row.attempts >= MAX_ATTEMPTS) {
          row.status = 'failed';
          store.put('messages', { orgId: row.orgId, kind: row.kind, to: row.to, error: row.lastError });
          out.failed++;
        } else {
          row.nextAt = new Date(at + minutes(2 ** (row.attempts - 1))).toISOString();
          out.retrying++;
        }
      }
      store.put('outbox', row);
    }
    return out;
  });
  return r.ran ? r.result : { sent: 0, retrying: 0, failed: 0, skipped: true };
}

/** Counts for the Super Admin and the release log. */
export const outboxCounts = store => {
  const c = { pending: 0, sent: 0, failed: 0 };
  for (const x of store.list('outbox', () => true)) c[x.status] = (c[x.status] || 0) + 1;
  return c;
};
