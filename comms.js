// One communication history for a customer or a lead: calls, texts, emails sent and received, notes, proposal events
// and follow-ups, in date order. Read from the records that already hold them; nothing is copied.
module.exports = function (app, { db, auth }) {
  const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
  const low = s => String(s || '').trim().toLowerCase();

  function history({ customerId, leadId }) {
    const cust = customerId ? db.prepare('SELECT * FROM customers WHERE id=?').get(customerId) : null;
    const lead = leadId ? db.prepare('SELECT * FROM leads WHERE id=?').get(leadId) : null;
    if (!cust && !lead) return null;
    const email = low((cust && cust.email) || (lead && lead.email));
    const phone = digits((cust && cust.phone) || (lead && lead.phone));
    const cid = cust ? cust.id : null, lid = lead ? lead.id : null;
    const out = [];

    // Proposals: the sent and viewed events, plus their follow-ups.
    const co = low(cust && cust.company);
    const ests = db.prepare("SELECT id, status, sent_at, viewed_at, view_count, project_name, lead_id, email, company FROM estimates WHERE (? IS NOT NULL AND lead_id=?) OR (?<>'' AND lower(email)=?) OR (?<>'' AND lower(company)=?)")
      .all(lid, lid, email, email, co, co);
    const estIds = new Set(ests.map(e => e.id));
    for (const e of ests) {
      const label = (e.project_name || 'Proposal') + ' #' + e.id;
      if (e.sent_at) out.push({ at: e.sent_at, channel: 'proposal', title: 'Proposal sent: ' + label, detail: e.status || '', actor: 'Proposals', ref: 'estimate:' + e.id });
      if (e.viewed_at) out.push({ at: e.viewed_at, channel: 'proposal', title: 'Customer viewed ' + label, detail: (e.view_count || 1) + ' view' + ((e.view_count || 1) === 1 ? '' : 's'), actor: 'Customer', ref: 'estimate:' + e.id });
    }
    if (estIds.size) {
      const ids = [...estIds];
      const fus = db.prepare('SELECT * FROM proposal_followups WHERE estimate_id IN (' + ids.map(() => '?').join(',') + ')').all(...ids);
      for (const f of fus) out.push({ at: f.sent_at || f.due_date + 'T00:00:00Z', channel: 'followup', title: (f.status === 'Sent' ? 'Follow-up sent' : 'Follow-up ' + f.status.toLowerCase()) + ' (' + (f.channel === 'sms' ? 'text' : 'email') + ')', detail: f.status === 'Scheduled' ? 'Due ' + f.due_date : (f.result || ''), actor: f.auto ? 'Automatic' : (f.created_by || ''), ref: 'followup:' + f.id });
      const sms = db.prepare('SELECT * FROM sms_messages ORDER BY id DESC LIMIT 2000').all().filter(m => estIds.has(m.estimate_id) || (phone && digits(m.to_number) === phone) || (cid && m.customer_id === cid) || (lid && m.lead_id === lid));
      for (const m of sms) out.push({ at: m.created_at, channel: 'sms', title: m.direction === 'in' ? 'Text received' : 'Text ' + (m.status === 'Sent' ? 'sent' : 'failed'), detail: m.body + (m.error ? ' (' + m.error + ')' : ''), actor: m.direction === 'in' ? 'Customer' : (m.created_by || ''), ref: 'sms:' + m.id });
    } else if (phone || cid || lid) {
      const sms = db.prepare('SELECT * FROM sms_messages ORDER BY id DESC LIMIT 2000').all().filter(m => (phone && digits(m.to_number) === phone) || (cid && m.customer_id === cid) || (lid && m.lead_id === lid));
      for (const m of sms) out.push({ at: m.created_at, channel: 'sms', title: m.direction === 'in' ? 'Text received' : 'Text ' + (m.status === 'Sent' ? 'sent' : 'failed'), detail: m.body + (m.error ? ' (' + m.error + ')' : ''), actor: m.direction === 'in' ? 'Customer' : (m.created_by || ''), ref: 'sms:' + m.id });
    }

    // Calls, matched by the customer or lead id, or by phone number.
    const calls = db.prepare('SELECT * FROM calls ORDER BY id DESC LIMIT 2000').all()
      .filter(c => (cid && c.customer_id === cid) || (lid && c.lead_id === lid) || (phone && digits(c.phone) === phone));
    for (const c of calls) out.push({ at: c.created_at, channel: 'call', title: (c.direction || '') + ' call: ' + (c.outcome || 'logged'), detail: c.summary || '', actor: c.handled_by || c.contact_name || 'Call log', ref: 'call:' + c.id });

    // Emails sent (to the address) and received (from it or linked to the lead).
    if (email) {
      try {
        const sent = db.prepare("SELECT * FROM email_log WHERE lower(to_addr)=? ORDER BY id DESC LIMIT 300").all(email);
        for (const m of sent) out.push({ at: m.created_at, channel: 'email', title: 'Email ' + (m.status === 'sent' ? 'sent' : m.status) + ': ' + (m.subject || '(no subject)'), detail: m.error || '', actor: m.sent_by || 'Email Center', ref: 'email:' + m.id });
      } catch { /* mail log not present yet */ }
    }
    try {
      const inbound = db.prepare('SELECT * FROM inbox_messages WHERE (? IS NOT NULL AND lead_id=?) OR (?<>\'\' AND lower(from_addr)=?) ORDER BY id DESC LIMIT 300').all(lid, lid, email, email);
      for (const m of inbound) out.push({ at: m.received_at, channel: 'email_in', title: 'Email received: ' + (m.subject || '(no subject)'), detail: m.from_addr || '', actor: 'Customer', ref: 'inbox:' + m.id });
    } catch { /* inbox not connected */ }

    // Notes and lead activity (calls attempted, conversations, voicemails, notes, meetings).
    if (lid) {
      const acts = db.prepare('SELECT * FROM lead_activity WHERE lead_id=? ORDER BY id DESC LIMIT 500').all(lid);
      for (const a of acts) out.push({ at: a.created_at, channel: a.kind === 'note' ? 'note' : 'activity', title: a.summary, detail: a.detail || '', actor: a.actor || '', ref: 'lead-activity:' + a.id });
    }
    if (cid) {
      try {
        const notes = db.prepare('SELECT * FROM customer_notes WHERE customer_id=? ORDER BY id DESC LIMIT 300').all(cid);
        for (const n of notes) out.push({ at: n.created_at, channel: 'note', title: 'Note', detail: n.body || '', actor: n.author || '', ref: 'customer-note:' + n.id });
      } catch { /* notes table name differs: the Notes tab still shows them */ }
    }

    out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const counts = { calls: 0, texts: 0, emails: 0, notes: 0, followups: 0, proposals: 0 };
    for (const e of out) {
      if (e.channel === 'call') counts.calls++; else if (e.channel === 'sms') counts.texts++; else if (e.channel === 'email' || e.channel === 'email_in') counts.emails++;
      else if (e.channel === 'note' || e.channel === 'activity') counts.notes++; else if (e.channel === 'followup') counts.followups++; else if (e.channel === 'proposal') counts.proposals++;
    }
    return { entries: out, counts, email, phone };
  }

  app.get('/api/admin/comms', auth, (req, res) => {
    const h = history({ customerId: Number(req.query.customer_id) || null, leadId: Number(req.query.lead_id) || null });
    if (!h) return res.status(400).json({ error: 'Give a customer or a lead.' });
    res.json(h);
  });
  module.exports.history = history;
};
