// Sends email through Postmark's HTTP API. Exposes the same sendMail() shape as nodemailer so the
// rest of the app (notifications, proposals, reminders) does not change.
module.exports = function createPostmarkMailer(token, opts = {}) {
  const base = (opts.apiUrl || 'https://api.postmarkapp.com').replace(/\/$/, '');
  return {
    provider: 'postmark',
    async sendMail({ from, to, subject, text, replyTo }) {
      const r = await fetch(base + '/email', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token },
        body: JSON.stringify({ From: from, To: Array.isArray(to) ? to.join(',') : to, Subject: subject, TextBody: text, ReplyTo: replyTo || undefined, MessageStream: opts.stream || 'outbound' })
      });
      let j = {};
      try { j = await r.json(); } catch { /* non-JSON error */ }
      if (!r.ok || (j.ErrorCode && j.ErrorCode !== 0)) {
        const e = new Error(`Postmark ${r.status}${j.ErrorCode ? ' code ' + j.ErrorCode : ''}: ${j.Message || 'send failed'}`);
        e.code = j.ErrorCode; throw e;
      }
      return { messageId: j.MessageID, accepted: [to] };
    }
  };
};
