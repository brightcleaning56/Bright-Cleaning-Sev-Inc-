// Email Center: one list of the emails the system sent and the mail received from the connected Outlook inbox, grouped
// into mailboxes, linked to the customer, lead, proposal or contract they belong to, with delivery and reply status.
// Read-only over email_log and inbox_messages. Drafts and scheduled emails are listed from their own records.
module.exports = function (app, { db, auth }) {
  const low = s => String(s || '').trim().toLowerCase();
  const isAddr = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
  const MAILBOXES = ['All', 'Customer', 'Lead inquiries', 'Estimates & proposals', 'Contracts', 'Invoices', 'Sent', 'Needs reply', 'Scheduled', 'Drafts', 'Archived'];

  db.exec(`CREATE TABLE IF NOT EXISTS email_drafts(id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, subject TEXT, body TEXT, customer_id INTEGER, lead_id INTEGER, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_archive(key TEXT PRIMARY KEY, archived_at TEXT NOT NULL, archived_by TEXT);
    CREATE TABLE IF NOT EXISTS email_flags(key TEXT PRIMARY KEY, read_at TEXT, starred INTEGER NOT NULL DEFAULT 0);`);
  const who = req => String((req.user && req.user.email) || '');
  for (const col of ['provider_id TEXT', 'delivered_at TEXT', 'bounced_at TEXT', 'bounce_reason TEXT']) { try { db.exec('ALTER TABLE email_log ADD COLUMN ' + col); } catch { /* already there */ } }
  const ES = require('./emailsuppress');

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
    const sent = safe("SELECT id, to_addr, subject, body, status, error, created_at, sent_by, provider_id, delivered_at, bounced_at, bounce_reason FROM email_log ORDER BY id DESC LIMIT 500");
    const inbound = safe("SELECT id, from_addr, from_name, subject, preview, received_at, lead_id, customer_id, conversation_id FROM inbox_messages ORDER BY id DESC LIMIT 500");
    const suppressed = new Map(safe('SELECT address, reason FROM email_suppression').map(r => [low(r.address), r.reason]));
    const out = sent.map(m => {
      const addr = m.to_addr;
      const bounced = !!m.bounced_at || suppressed.get(low(addr)) === 'bounced';
      const replied = inbound.some(i => low(i.from_addr) === low(addr) && String(i.received_at || '') > String(m.created_at || ''));
      const row = { key: 'out-' + m.id, id: m.id, direction: 'out', source: 'system', at: m.created_at, from: 'Bright Clean', to: addr, subject: m.subject || '(no subject)', status: m.status, delivery: m.status === 'failed' ? 'Failed' : bounced ? 'Bounced' : m.delivered_at ? 'Delivered' : 'Sent', reply: replied ? 'Customer replied' : 'No reply yet', sent_by: m.sent_by || 'System' };
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
    const arch = new Set(safe('SELECT key FROM email_archive').map(r => r.key));
    const flags = new Map(safe('SELECT key, read_at, starred FROM email_flags').map(r => [r.key, r]));
    for (const m of all) { m.archived = arch.has(m.key); const f = flags.get(m.key); m.read = !!(f && f.read_at); m.starred = !!(f && f.starred); }
    const live = all.filter(m => !m.archived);
    const scheduled = safe("SELECT f.id, f.due_date, f.channel, f.message, f.estimate_id, e.email, e.project_name FROM proposal_followups f LEFT JOIN estimates e ON e.id=f.estimate_id WHERE f.status='Scheduled' AND f.channel='email' ORDER BY f.due_date");
    const drafts = safe('SELECT * FROM email_drafts ORDER BY updated_at DESC LIMIT 200').map(d => ({ key: 'draft-' + d.id, id: d.id, direction: 'out', source: 'draft', at: d.updated_at, from: 'Bright Clean', to: d.to_addr || '', subject: d.subject || '(no subject)', preview: String(d.body || '').slice(0, 160), body: d.body || '', status: 'draft', delivery: 'Draft', reply: '', sent_by: d.created_by || '', link: d.to_addr ? linkFor(d.to_addr, cache) : null, category: 'Drafts', archived: false }));
    const scheduledRows = scheduled.map(f => ({ key: 'sched-' + f.id, id: f.id, direction: 'out', source: 'scheduled', at: f.due_date + 'T00:00:00Z', from: 'Bright Clean', to: f.email || '', subject: 'Follow-up (' + (f.project_name || 'proposal') + ')', preview: f.message, status: 'scheduled', delivery: 'Scheduled for ' + f.due_date, reply: '', sent_by: 'Automatic', link: f.email ? linkFor(f.email, cache) : null, category: 'Scheduled', archived: false }));
    const counts = {
      'All': live.length,
      'Customer': live.filter(m => m.category === 'Customer').length,
      'Lead inquiries': live.filter(m => m.category === 'Lead inquiries').length,
      'Estimates & proposals': live.filter(m => m.category === 'Estimates & proposals').length,
      'Contracts': live.filter(m => m.category === 'Contracts').length,
      'Invoices': live.filter(m => m.category === 'Invoices').length,
      'Sent': live.filter(m => m.direction === 'out' && m.source === 'system').length,
      'Needs reply': live.filter(m => m.reply === 'Needs reply').length,
      'Scheduled': scheduled.length,
      'Drafts': drafts.length,
      'Archived': all.filter(m => m.archived).length
    };
    return { messages: [...live, ...scheduledRows, ...drafts, ...all.filter(m => m.archived)], counts, mailboxes: MAILBOXES };
  }

  app.get('/api/admin/email-center', auth, (req, res) => res.json(build()));

  // Postmark sends delivery and bounce events here. Set POSTMARK_WEBHOOK_TOKEN in Render and use the same token in the URL.
  app.post('/api/webhooks/postmark', (req, res) => {
    const want = process.env.POSTMARK_WEBHOOK_TOKEN || '';
    if (!want) return res.status(503).type('text/plain').send('Postmark events are not set up (POSTMARK_WEBHOOK_TOKEN missing).');
    const got = String(req.query.token || '');
    if (got.length !== want.length || !require('crypto').timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.status(403).type('text/plain').send('Forbidden.');
    const b = req.body || {}, id = String(b.MessageID || '');
    const t = new Date().toISOString();
    if (b.RecordType === 'SpamComplaint') { const sa = String(b.Email || b.Recipient || '').toLowerCase(); if (sa) { try { ES.suppress(db, sa, 'spam complaint', 'postmark', 'Marked as spam', 'system'); } catch { /* best effort */ } } }
    if (b.RecordType === 'Delivery' && id) {
      db.prepare('UPDATE email_log SET delivered_at=COALESCE(delivered_at, ?) WHERE provider_id=?').run(String(b.DeliveredAt || t), id);
    } else if (b.RecordType === 'Bounce' && id) {
      const addr = String(b.Email || b.Recipient || '').toLowerCase();
      db.prepare('UPDATE email_log SET bounced_at=COALESCE(bounced_at, ?), bounce_reason=? WHERE provider_id=?').run(String(b.BouncedAt || t), String(b.Description || b.Type || 'bounced').slice(0, 300), id);
      if (addr) { try { ES.suppress(db, addr, 'bounced', 'postmark', String(b.Description || b.Type || 'bounced').slice(0, 300), 'system'); } catch { /* suppression is best effort */ } }
    }
    res.status(200).json({ ok: true });
  });

  // Drafts: saved, edited and discarded here. A draft is sent only when someone presses Send.
  const draftFields = b => {
    const to = String(b.to || '').trim().slice(0, 254), subject = String(b.subject || '').trim().slice(0, 200), body = String(b.body || '').trim().slice(0, 10000);
    return { to, subject, body };
  };
  app.post('/api/admin/email-center/drafts', auth, (req, res) => {
    const f = draftFields(req.body || {});
    if (!f.body) return res.status(400).json({ error: 'Write the email first.' });
    if (f.to && !isAddr(f.to)) return res.status(400).json({ error: 'Enter a valid email address, or leave it blank.' });
    const t = new Date().toISOString();
    const id = db.prepare('INSERT INTO email_drafts(to_addr,subject,body,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(f.to, f.subject, f.body, who(req), t, t).lastInsertRowid;
    res.status(201).json({ ok: true, id });
  });
  app.post('/api/admin/email-center/drafts/:id', auth, (req, res) => {
    const cur = db.prepare('SELECT * FROM email_drafts WHERE id=?').get(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Draft not found.' });
    const f = draftFields(req.body || {});
    if (!f.body) return res.status(400).json({ error: 'Write the email first.' });
    if (f.to && !isAddr(f.to)) return res.status(400).json({ error: 'Enter a valid email address, or leave it blank.' });
    db.prepare('UPDATE email_drafts SET to_addr=?, subject=?, body=?, updated_at=? WHERE id=?').run(f.to, f.subject, f.body, new Date().toISOString(), cur.id);
    res.json({ ok: true });
  });
  app.delete('/api/admin/email-center/drafts/:id', auth, (req, res) => {
    const r = db.prepare('DELETE FROM email_drafts WHERE id=?').run(Number(req.params.id));
    if (!r.changes) return res.status(404).json({ error: 'Draft not found.' });
    res.json({ ok: true });
  });

  // Archive: a separate record. The email itself is never changed or removed.
  // Read and star are kept for the team, per email. Opening an email does not mark it read; someone presses Mark read.
  app.post('/api/admin/email-center/:key/flags', auth, (req, res) => {
    const key = String(req.params.key);
    if (!/^(out|in)-\d+$/.test(key)) return res.status(400).json({ error: 'Only received and sent emails can be marked.' });
    const b = req.body || {};
    const cur = db.prepare('SELECT * FROM email_flags WHERE key=?').get(key) || { read_at: null, starred: 0 };
    const read_at = 'read' in b ? (b.read ? new Date().toISOString() : null) : cur.read_at;
    const starred = 'starred' in b ? (b.starred ? 1 : 0) : cur.starred;
    db.prepare('INSERT INTO email_flags(key,read_at,starred) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET read_at=excluded.read_at, starred=excluded.starred').run(key, read_at, starred);
    res.json({ ok: true, read: !!read_at, starred: !!starred });
  });
  app.post('/api/admin/email-center/:key/archive', auth, (req, res) => {
    const key = String(req.params.key);
    if (!/^(out|in)-\d+$/.test(key)) return res.status(400).json({ error: 'Only received and sent emails can be archived.' });
    if (req.body && req.body.archived === false) db.prepare('DELETE FROM email_archive WHERE key=?').run(key);
    else db.prepare('INSERT OR REPLACE INTO email_archive(key,archived_at,archived_by) VALUES(?,?,?)').run(key, new Date().toISOString(), who(req));
    res.json({ ok: true, archived: !(req.body && req.body.archived === false) });
  });

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
    } else if (kind === 'draft') {
      const r = db.prepare('SELECT * FROM email_drafts WHERE id=?').get(id);
      if (r) m = { key: req.params.key, direction: 'out', at: r.updated_at, from: 'Bright Clean', to: r.to_addr || '', subject: r.subject || '(no subject)', body: r.body || '', status: 'draft', sent_by: r.created_by || '', draft_id: r.id, customer_id: r.customer_id || null };
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
  // Assistant for one email: the same summary and draft rules as conversations; the draft is never sent by this.
  app.post('/api/admin/email-center/:key/assist', auth, async (req, res) => {
    const [kind, idRaw] = String(req.params.key).split('-'); const id = Number(idRaw);
    let m = null;
    if (kind === 'out') { const r = db.prepare('SELECT * FROM email_log WHERE id=?').get(id); if (r) m = { dir: 'out', at: r.created_at, body: (r.subject || '') + '\n' + (r.body || '') }; }
    else if (kind === 'in') { const r = db.prepare('SELECT * FROM inbox_messages WHERE id=?').get(id); if (r) m = { dir: 'in', at: r.received_at, body: (r.subject || '') + '\n' + (r.preview || '') }; }
    if (!m) return res.status(404).json({ error: 'That email was not found.' });
    const result = await require('./assist').assist(app, [{ ...m, channel: 'email' }], 'email');
    res.json(result);
  });
  module.exports.build = build;
};
