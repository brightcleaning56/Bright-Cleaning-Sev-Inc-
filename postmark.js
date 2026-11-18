// Sends email through Postmark's HTTP API. Exposes the same sendMail() shape as nodemailer so the
// rest of the app (notifications, proposals, reminders, invoices) does not change.
// Attachments use nodemailer's shape ({ filename, content, contentType }) and go out in Postmark's
// format ({ Name, Content (base64), ContentType }). Without this, the PDF was silently dropped.
const toPostmarkAttachments = list => (Array.isArray(list) ? list : []).filter(a => a && a.content != null).map(a => {
  const c = a.content;
  const buf = Buffer.isBuffer(c) ? c : (c instanceof Uint8Array ? Buffer.from(c) : Buffer.from(String(c)));
  return { Name: String(a.filename || a.name || 'attachment').slice(0, 200), Content: buf.toString('base64'), ContentType: a.contentType || 'application/octet-stream' };
});
module.exports = function createPostmarkMailer(token, opts = {}) {
  const base = (opts.apiUrl || 'https://api.postmarkapp.com').replace(/\/$/, '');
  return {
    provider: 'postmark',
    async sendMail({ from, to, subject, text, replyTo, attachments }) {
      const atts = toPostmarkAttachments(attachments);
      const r = await fetch(base + '/email', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token },
        body: JSON.stringify({ From: from, To: Array.isArray(to) ? to.join(',') : to, Subject: subject, TextBody: text, ReplyTo: replyTo || undefined, MessageStream: opts.stream || 'outbound', Attachments: atts.length ? atts : undefined })
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
module.exports.toPostmarkAttachments = toPostmarkAttachments;
