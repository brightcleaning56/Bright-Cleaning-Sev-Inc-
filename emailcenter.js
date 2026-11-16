// Email Center: one list of the emails the system sent and the mail received from the connected Outlook inbox, grouped
// into mailboxes, linked to the customer, lead, proposal or contract they belong to, with delivery and reply status.
// Read-only over email_log and inbox_messages. Drafts and scheduled emails are listed from their own records.
module.exports = function (app, { db, auth }) {
  const low = s => String(s || '').trim().toLowerCase();
  const isAddr = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
  const MAILBOXES = ['All', 'Customer', 'Lead inquiries', 'Estimates & proposals', 'Contracts', 'Invoices', 'Sent', 'Needs reply', 'Scheduled', 'Drafts', 'Archived'];

  function safe(sql, args = []) { try { return db.prepare(sql).all(...args); } catch { return []; } }

  // Who an address belongs to: a customer, a lead, a proposal, in that order.
  function linkFor(addr, cache) {
    const a = low(addr);
    if (!a) return null;
    if (cache.has(a)) return cache.get(a);
    let link = null;
    const cu = db.prepare('SELECT id, name, company FROM customers WHERE lower(email)=? ORDER BY id LIMIT 1').get(a);
    const ld = db.prepare("SELECT id, contact_name, company, status FROM leads WHERE lower(email)=? ORDER BY id DESC LIMIT 1").get(a);
    const es = db.prepare('SELECT id, project_name, status FROM estimates WHERE lower(email)=? ORDER BY id DESC LIMIT 1').get(a);
    if (cu) link = { type: 'customer', id: cu.id, name: cu.name || cu.company, company: cu.company || '' };
    else if (ld) link = { type: 'lead', id: ld.id, name: ld.contact_name || ld.company, company: ld.company || '', status: ld.status };
    if (es) link = { ...(link || {}), proposal_id: es.id, proposal_status: es.status, proposal_name: es.project_name || ('Proposal #' + es.id) };
    cache.set(a, link);
    return link;
  }

  // Category: decided from the subject and the linked records, so each email lands in one mailbox.
  function categoryOf(m) {
    const s = String(m.subject || '');
    if (m.link && m.link.proposal_id || /proposal|estimate|\bbid\b/i.test(s)) return 'Estimates & proposals';
    if (/contract|agreement|signature|amendment/i.test(s)) return 'Contracts';
    if (/invoice|payment|receipt|balance/i.test(s)) return 'Invoices';
    if (m.direction === 'in' && m.link && m.link.type === 'lead') return 'Lead inquiries';
    if (m.direction === 'in' && !m.link) return 'Lead inquiries';
    if (m.link && m.link.type === 'customer') return 'Customer';
    return 'Customer';
  }

  function build() {
    const cache = new Map();
    const sent = safe("SELECT id, to_addr, subject, body, status, error, created_at, sent_by FROM email_log ORDER BY id DESC LIMIT 500");
    const inbound = safe("SELECT id, from_addr, from_name, subject, preview, received_at, lead_id, customer_id, conversation_id FROM inbox_messages ORDER BY id DESC LIMIT 500");
    const suppressed = new Map(safe('SELECT address, reason FROM email_suppression').map(r => [low(r.address), r.reason]));
    const out = sent.map(m => {
      const addr = m.to_addr;
      const bounced = suppressed.get(low(addr)) === 'bounced';
      const replied = inbound.some(i => low(i.from_addr) === low(addr) && String(i.received_at || '') > String(m.created_at || ''));
      const row = { key: 'out-' + m.id, id: m.id, direction: 'out', source: 'system', at: m.created_at, from: 'Bright Clean', to: addr, subject: m.subject || '(no subject)', status: m.status, delivery: m.status === 'failed' ? 'Failed' : bounced ? 'Bounced' : 'Sent', reply: replied ? 'Customer replied' : 'No reply yet', sent_by: m.sent_by || 'System' };
      row.link = linkFor(addr, cache);
      row.category = categoryOf(row);
      return row;
    });
    const ins = inbound.map(m => {
      const addr = m.from_addr;
      const answered = sent.some(s => low(s.to_addr) === low(addr) && String(s.created_at || '') > String(m.received_at || ''));
      const row = { key: 'in-' + m.id, id: m.id, direction: 'in', source: 'mailbox', at: m.received_at, from: m.from_name || addr, to: 'Bright Clean', subject: m.subject || '(no subject)', preview: m.preview || '', status: 'received', delivery: 'Received', reply: answered ? 'Answered' : 'Needs reply', sent_by: '' };
      row.link = m.customer_id ? (linkFor(addr, cache) || { type: 'customer', id: m.customer_id }) : m.lead_id ? (linkFor(addr, cache) || { type: 'lead', id: m.lead_id }) : linkFor(addr, cache);
      row.category = categoryOf(row);
      return row;
    });
    const all = [...out, ...ins].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const scheduled = safe("SELECT f.id, f.due_date, f.channel, f.message, f.estimate_id, e.email, e.project_name FROM proposal_followups f LEFT JOIN estimates e ON e.id=f.estimate_id WHERE f.status='Scheduled' AND f.channel='email' ORDER BY f.due_date");
    const counts = {
      'All': all.length,
      'Customer': all.filter(m => m.category === 'Customer').length,
      'Lead inquiries': all.filter(m => m.category === 'Lead inquiries').length,
      'Estimates & proposals': all.filter(m => m.category === 'Estimates & proposals').length,
      'Contracts': all.filter(m => m.category === 'Contracts').length,
      'Invoices': all.filter(m => m.category === 'Invoices').length,
      'Sent': out.length,
      'Needs reply': ins.filter(m => m.reply === 'Needs reply').length,
      'Scheduled': scheduled.length,
      'Drafts': 0,
      'Archived': 0
    };
    const scheduledRows = scheduled.map(f => ({ key: 'sched-' + f.id, id: f.id, direction: 'out', source: 'scheduled', at: f.due_date + 'T00:00:00Z', from: 'Bright Clean', to: f.email || '', subject: 'Follow-up (' + (f.project_name || 'proposal') + ')', preview: f.message, status: 'scheduled', delivery: 'Scheduled for ' + f.due_date, reply: '', sent_by: 'Automatic', link: f.email ? linkFor(f.email, cache) : null, category: 'Scheduled' }));
    return { messages: [...all, ...scheduledRows], counts, mailboxes: MAILBOXES };
  }

  app.get('/api/admin/email-center', auth, (req, res) => res.json(build()));

  // One message in full, with the record it belongs to and the team's history with that person.
  app.get('/api/admin/email-center/:key', auth, (req, res) => {
    const [kind, idRaw] = String(req.params.key).split('-'); const id = Number(idRaw);
    const cache = new Map();
    let m = null;
    if (kind === 'out') {
      const r = db.prepare('SELECT * FROM email_log WHERE id=?').get(id);
      if (r) m = { key: req.params.key, direction: 'out', at: r.created_at, from: 'Bright Clean', to: r.to_addr, subject: r.subject || '(no subject)', body: r.body || '', status: r.status, error: r.error || '', sent_by: r.sent_by || 'System' };
    } else if (kind === 'in') {
      const r = db.prepare('SELECT * FROM inbox_messages WHERE id=?').get(id);
      if (r) m = { key: req.params.key, direction: 'in', at: r.received_at, from: r.from_name || r.from_addr, from_addr: r.from_addr, to: 'Bright Clean', subject: r.subject || '(no subject)', body: r.preview || '', status: 'received', sent_by: '' , lead_id: r.lead_id, customer_id: r.customer_id };
    } else if (kind === 'sched') {
      const r = db.prepare("SELECT f.*, e.email FROM proposal_followups f LEFT JOIN estimates e ON e.id=f.estimate_id WHERE f.id=?").get(id);
      if (r) m = { key: req.params.key, direction: 'out', at: r.due_date, from: 'Bright Clean', to: r.email || '', subject: 'Scheduled follow-up', body: r.message, status: 'scheduled', sent_by: 'Automatic' };
    }
    if (!m) return res.status(404).json({ error: 'That email was not found.' });
    const addr = m.direction === 'in' ? m.from_addr : m.to;
    m.link = linkFor(addr, cache);
    if (m.direction === 'in' && (m.lead_id || m.customer_id)) m.link = m.link || (m.customer_id ? { type: 'customer', id: m.customer_id } : { type: 'lead', id: m.lead_id });
    m.category = categoryOf(m);
    // Requests and unanswered questions come from the message text itself. Nothing is inferred beyond it.
    const text = String(m.body || '') + ' ' + String(m.subject || '');
    const questions = (text.match(/[^.?!\n]*\?/g) || []).map(s => s.trim()).filter(Boolean).slice(0, 6);
    const asks = [];
    const rules = [[/start date|when can you start|availability|schedule/i, 'Scheduling or start date'], [/quote|price|pricing|estimate|bid/i, 'Pricing or a quote'], [/invoice|payment|balance|paid/i, 'Invoice or payment'], [/contract|sign|agreement/i, 'Contract or signature'], [/insurance|certificate|coi/i, 'Insurance certificate'], [/complain|problem|missed|damage|unhappy/i, 'A complaint or problem']];
    for (const [re, label] of rules) if (re.test(text)) asks.push(label);
    const history = m.link && m.link.type === 'customer'
      ? { customer_id: m.link.id } : m.link && m.link.type === 'lead' ? { lead_id: m.link.id } : null;
    res.json({ message: m, questions, requests: asks, history, note: 'Summary and requests are read from the message text only. Replies are drafted for a person to review and send.' });
  });
  module.exports.build = build;
};
