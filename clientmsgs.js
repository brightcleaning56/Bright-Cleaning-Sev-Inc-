// Client Messages: one inbox for portal messages and texts, grouped by customer or lead. Replies go out by text or to the
// portal. Every message and reply is kept on the customer or lead it belongs to; closing a conversation only changes its
// inbox state, never its history or the customer or lead record.
module.exports = function (app, { db, auth, logAction, clean }) {
  const crypto = require('crypto');
  const bizdate = require('./bizdate');
  const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
  const low = s => String(s || '').trim().toLowerCase();
  const who = req => String((req.user && req.user.email) || '');
  const now = () => new Date().toISOString();
  const STATES = ['Open', 'Waiting on customer', 'Closed'];

  db.exec(`CREATE TABLE IF NOT EXISTS conversation_state(key TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'Open', owner TEXT, follow_up_date TEXT, last_read_at TEXT, updated_at TEXT NOT NULL);`);
  for (const sql of ['ALTER TABLE sms_messages ADD COLUMN direction TEXT NOT NULL DEFAULT \'out\'', 'ALTER TABLE sms_messages ADD COLUMN from_number TEXT']) { try { db.exec(sql); } catch { /* already there */ } }

  // Approved templates. The owner maintains this list; staff insert a template and can edit it before sending.
  const TEMPLATES = [
    { id: 'thanks', name: 'Thank you for reaching out', body: 'Hi {first}, thank you for reaching out to Bright Cleaning Sev Inc. We have your details and will follow up shortly. — Bright Cleaning Sev Inc.' },
    { id: 'received', name: 'Proposal received?', body: 'Hi {first}, this is Bright Cleaning Sev Inc. checking that our proposal reached you. Do you have any questions I can answer? — Bright Cleaning Sev Inc.' },
    { id: 'visit', name: 'Visit confirmation', body: 'Hi {first}, confirming our visit. Reply here if the time needs to change. — Bright Cleaning Sev Inc.' },
    { id: 'invoice', name: 'Invoice reminder', body: 'Hi {first}, a friendly reminder that an invoice from Bright Cleaning Sev Inc. is open. Let us know if you have any questions. — Bright Cleaning Sev Inc.' }
  ];

  function directory() {
    const customers = db.prepare('SELECT id, name, company, phone, email FROM customers').all();
    const leads = db.prepare('SELECT id, contact_name, company, phone, email, address, status, customer_id FROM leads ORDER BY id DESC').all();
    const custByPhone = new Map(), custByEmail = new Map(), leadByPhone = new Map(), leadByEmail = new Map();
    for (const c of customers) { const d = digits(c.phone); if (d && !custByPhone.has(d)) custByPhone.set(d, c); if (low(c.email) && !custByEmail.has(low(c.email))) custByEmail.set(low(c.email), c); }
    for (const l of leads) { const d = digits(l.phone); if (d && !leadByPhone.has(d)) leadByPhone.set(d, l); if (low(l.email) && !leadByEmail.has(low(l.email))) leadByEmail.set(low(l.email), l); }
    return { customers, leads, custByPhone, custByEmail, leadByPhone, leadByEmail, custById: new Map(customers.map(c => [c.id, c])), leadById: new Map(leads.map(l => [l.id, l])) };
  }

  // The conversation a message belongs to: a customer, a lead, or the number or address alone.
  function keyFor(dir, { phone, email, customer_id, lead_id }) {
    if (customer_id && dir.custById.has(customer_id)) return 'cust:' + customer_id;
    if (lead_id && dir.leadById.has(lead_id)) { const l = dir.leadById.get(lead_id); return l.customer_id && dir.custById.has(l.customer_id) ? 'cust:' + l.customer_id : 'lead:' + lead_id; }
    const d = digits(phone), e = low(email);
    if (e && dir.custByEmail.has(e)) return 'cust:' + dir.custByEmail.get(e).id;
    if (d && dir.custByPhone.has(d)) return 'cust:' + dir.custByPhone.get(d).id;
    if (e && dir.leadByEmail.has(e)) return 'lead:' + dir.leadByEmail.get(e).id;
    if (d && dir.leadByPhone.has(d)) return 'lead:' + dir.leadByPhone.get(d).id;
    if (d) return 'phone:' + d;
    if (e) return 'mail:' + e;
    return null;
  }

  function events() {
    // Customer messages and replies come from the shared conversation record, oldest first, in the shape this feed uses.
    const groups = require('./conversations').customerGroups(db, { limit: 100000 }).slice().reverse();
    const portal = groups.map(m => ({ id: m.id, email: m.email, subject: m.subject, body: m.body, created_at: m.created_at }));
    const replies = groups.flatMap(m => m.replies.map(r => ({ id: r.id, message_id: m.id, body: r.body, by_user: r.by_user, created_at: r.created_at })));
    const sms = db.prepare('SELECT * FROM sms_messages ORDER BY id').all();
    return { portal, replies, sms };
  }

  // One row per conversation for the inbox.
  function inbox() {
    const dir = directory(), ev = events();
    const groups = new Map();
    const add = (key, item) => { if (!key) return; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); };
    for (const m of ev.portal) {
      const key = keyFor(dir, { email: m.email });
      add(key, { id: 'p' + m.id, channel: 'portal', dir: 'in', at: m.created_at, body: m.body, subject: m.subject, msgId: m.id });
      for (const r of ev.replies.filter(x => x.message_id === m.id)) add(key, { id: 'pr' + r.id, channel: 'portal', dir: 'out', at: r.created_at, body: r.body, by: r.by_user, msgId: m.id });
    }
    for (const s of ev.sms) {
      const inbound = s.direction === 'in';
      const key = keyFor(dir, { phone: s.to_number, customer_id: s.customer_id, lead_id: s.lead_id });
      add(key, { id: 's' + s.id, channel: 'sms', dir: inbound ? 'in' : 'out', at: s.created_at, body: s.body, status: s.status, error: s.error, by: s.created_by || '' });
    }
    const states = new Map(db.prepare('SELECT * FROM conversation_state').all().map(r => [r.key, r]));
    const today = bizdate.today();
    const rows = [];
    for (const [key, items] of groups) {
      items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const last = items[items.length - 1];
      const st = states.get(key) || { status: 'Open', owner: null, follow_up_date: null, last_read_at: null };
      const [kind, idRaw] = key.split(':'); const id = Number(idRaw);
      let name = '', company = '', type = 'Unknown', property = '', contact = '';
      if (kind === 'cust' && dir.custById.has(id)) { const c = dir.custById.get(id); type = 'Customer'; name = c.name || c.company || 'Customer'; company = c.company || ''; contact = c.phone || c.email || ''; const pr = db.prepare('SELECT site_address FROM projects WHERE customer_id=? AND site_address IS NOT NULL ORDER BY id DESC LIMIT 1').get(id); property = pr ? pr.site_address : ''; }
      else if (kind === 'lead' && dir.leadById.has(id)) { const l = dir.leadById.get(id); type = 'Lead'; name = l.contact_name || l.company || 'Lead'; company = l.company || ''; contact = l.phone || l.email || ''; property = l.address || ''; }
      else { name = kind === 'mail' ? key.slice(5) : kind === 'phone' ? '+' + id : key; contact = name; }
      const unread = items.some(x => x.dir === 'in' && (!st.last_read_at || x.at > st.last_read_at));
      const needsReply = last.dir === 'in' && st.status !== 'Closed';
      rows.push({ key, type, name, company, property, contact, status: st.status, owner: st.owner, follow_up_date: st.follow_up_date,
        last_at: last.at, last_channel: last.channel, last_dir: last.dir, last_text: String(last.body || '').slice(0, 140),
        unread, needs_reply: needsReply, follow_up_due: !!(st.follow_up_date && st.follow_up_date <= today && st.status !== 'Closed'), count: items.length });
    }
    rows.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
    return rows;
  }

  function boxMatch(r, box, me) {
    if (box === 'All') return r.status !== 'Closed';
    if (box === 'Unread') return r.unread && r.status !== 'Closed';
    if (box === 'Needs reply') return r.needs_reply;
    if (box === 'My conversations') return r.owner === me && r.status !== 'Closed';
    if (box === 'Waiting on customer') return r.status === 'Waiting on customer';
    if (box === 'Follow-up due') return r.follow_up_due;
    if (box === 'Closed') return r.status === 'Closed';
    if (box === 'Customer') return r.type === 'Customer' && r.status !== 'Closed';
    if (box === 'Lead') return r.type === 'Lead' && r.status !== 'Closed';
    return true;
  }

  app.get('/api/admin/conversations', auth, (req, res) => {
    const rows = inbox(), me = who(req);
    const boxes = ['All', 'Unread', 'Needs reply', 'My conversations', 'Waiting on customer', 'Follow-up due', 'Closed', 'Customer', 'Lead'];
    const counts = Object.fromEntries(boxes.map(b => [b, rows.filter(r => boxMatch(r, b, me)).length]));
    const box = boxes.includes(req.query.box) ? req.query.box : 'All';
    res.json({ conversations: rows.filter(r => boxMatch(r, box, me)), boxes, counts, states: STATES, templates: TEMPLATES, me });
  });

  // The whole conversation, with the record it belongs to and the team's history with that person.
  app.get('/api/admin/conversations/:key', auth, (req, res) => {
    const key = String(req.params.key);
    const row = inbox().find(r => r.key === key);
    if (!row) return res.status(404).json({ error: 'That conversation was not found.' });
    const dir = directory(), ev = events();
    const [kind, idRaw] = key.split(':'); const id = Number(idRaw);
    const items = [];
    for (const m of ev.portal) if (keyFor(dir, { email: m.email }) === key) {
      items.push({ id: 'p' + m.id, channel: 'portal', dir: 'in', at: m.created_at, subject: m.subject, body: m.body, msgId: m.id });
      for (const r of ev.replies.filter(x => x.message_id === m.id)) items.push({ id: 'pr' + r.id, channel: 'portal', dir: 'out', at: r.created_at, body: r.body, by: r.by_user, msgId: m.id });
    }
    for (const s of ev.sms) if (keyFor(dir, { phone: s.to_number, customer_id: s.customer_id, lead_id: s.lead_id }) === key) {
      items.push({ id: 's' + s.id, channel: 'sms', dir: s.direction === 'in' ? 'in' : 'out', at: s.created_at, body: s.body, status: s.status, error: s.error, by: s.created_by || '' });
    }
    items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    let history = null, notes = [];
    const cid = kind === 'cust' ? id : null, lid = kind === 'lead' ? id : null;
    if (cid || lid) {
      try { history = require('./comms').history({ customerId: cid, leadId: lid }); } catch { history = null; }
      if (cid) notes = db.prepare('SELECT id, body, author, created_at, pinned FROM customer_notes WHERE customer_id=? ORDER BY id DESC LIMIT 50').all(cid);
      else if (lid) notes = db.prepare("SELECT id, summary AS body, actor AS author, created_at FROM lead_activity WHERE lead_id=? AND kind='note' ORDER BY id DESC LIMIT 50").all(lid);
    }
    const st = db.prepare('SELECT * FROM conversation_state WHERE key=?').get(key) || {};
    res.json({ conversation: row, items, history: history ? history.entries.slice(0, 200) : [], notes, templates: TEMPLATES, states: STATES, me: who(req),
      ai_note: 'Summary and questions are read from the messages in this conversation only. Replies are drafted for a person to review and send.' });
  });

  // Inbox state and owner. Closing a conversation changes only this record.
  app.post('/api/admin/conversations/:key/state', auth, (req, res) => {
    const key = String(req.params.key), b = req.body || {};
    if (!inbox().some(r => r.key === key)) return res.status(404).json({ error: 'That conversation was not found.' });
    const cur = db.prepare('SELECT * FROM conversation_state WHERE key=?').get(key) || { status: 'Open', owner: null, follow_up_date: null };
    const status = b.status !== undefined ? (STATES.includes(b.status) ? b.status : null) : cur.status;
    if (!status) return res.status(400).json({ error: 'Choose Open, Waiting on customer or Closed.' });
    const owner = b.owner !== undefined ? clean(b.owner, 200) || null : cur.owner;
    const fu = b.follow_up_date !== undefined ? (b.follow_up_date && /^\d{4}-\d{2}-\d{2}$/.test(b.follow_up_date) ? b.follow_up_date : null) : cur.follow_up_date;
    const readAt = b.mark_read ? now() : (db.prepare('SELECT last_read_at FROM conversation_state WHERE key=?').get(key) || {}).last_read_at || null;
    db.prepare('INSERT INTO conversation_state(key,status,owner,follow_up_date,last_read_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status, owner=excluded.owner, follow_up_date=excluded.follow_up_date, last_read_at=excluded.last_read_at, updated_at=excluded.updated_at')
      .run(key, status, owner, fu, readAt, now());
    // Keep the work queue's item for this conversation in step with the change made here.
    try { require('./work-engine').syncConversation(db, key, (req.user && req.user.email) || 'admin'); } catch (e) { console.error('work queue sync failed for conversation', key, e.message); }
    logAction(req, 'conversation ' + status.toLowerCase(), 'conversation', null, key + (fu ? ' follow-up ' + fu : ''));
    res.json({ ok: true, status, owner, follow_up_date: fu });
  });

  // Internal note: saved to the customer or lead, never shown to the customer.
  app.post('/api/admin/conversations/:key/note', auth, (req, res) => {
    const key = String(req.params.key), body = clean((req.body || {}).body, 4000);
    if (!body) return res.status(400).json({ error: 'Write the note first.' });
    const [kind, idRaw] = key.split(':'); const id = Number(idRaw);
    if (kind === 'cust') {
      const t = now();
      db.prepare('INSERT INTO customer_notes(customer_id,category,body,pinned,author,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, 'General', body, 0, who(req), t, t);
    } else if (kind === 'lead') {
      require('./leadlog').record(db, id, 'note', body.slice(0, 200), who(req), body.length > 200 ? body : null);
    } else return res.status(400).json({ error: 'Link this conversation to a customer or lead first, then add notes.' });
    logAction(req, 'internal note', kind === 'cust' ? 'customer' : 'lead', id, 'from client messages');
    res.status(201).json({ ok: true });
  });

  // Twilio texts in: signed by Twilio, saved to the conversation, and the customer's reply reopens a closed conversation.
  function validTwilio(req) {
    const token = process.env.TWILIO_AUTH_TOKEN; if (!token) return false;
    const sig = String(req.headers['x-twilio-signature'] || '');
    const url = (process.env.PUBLIC_BASE_URL || 'https://brightclean.net').replace(/\/$/, '') + req.originalUrl;
    const params = req.body || {};
    const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
    const expect = crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');
    return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  }
  app.post('/api/webhooks/twilio/sms', (req, res) => {
    if (!validTwilio(req)) return res.status(403).type('text/plain').send('Invalid signature.');
    const b = req.body || {}, from = String(b.From || ''), text = clean(b.Body, 1600);
    if (!from || !text) return res.type('text/xml').send('<Response/>');
    const dir = directory(), d = digits(from);
    const cust = dir.custByPhone.get(d), lead = dir.leadByPhone.get(d);
    const t = now();
    db.prepare("INSERT INTO sms_messages(estimate_id,customer_id,lead_id,to_number,body,status,provider_sid,error,created_by,created_at,direction,from_number) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(null, cust ? cust.id : null, lead ? lead.id : null, from, text, 'Received', String(b.MessageSid || ''), null, 'customer', t, 'in', from);
    if (lead) { try { require('./leadlog').record(db, lead.id, 'text_in', 'Text received: ' + text.slice(0, 120), 'Customer', text, t); } catch { /* best effort */ } }
    const key = keyFor(dir, { phone: from, customer_id: cust ? cust.id : null, lead_id: lead ? lead.id : null });
    if (key) { try { require('./work-engine').conversationNeedsAttention(db, key, 'Customer text'); } catch (e) { console.error('work queue sync failed for text', key, e.message); } }
    res.type('text/xml').send('<Response/>');
  });
  // Twilio reports each text's delivery. A text that did not arrive makes its conversation need attention now.
  app.post('/api/webhooks/twilio/sms-status', (req, res) => {
    if (!validTwilio(req)) return res.status(403).type('text/plain').send('Invalid signature.');
    const b = req.body || {}, sid = clean(b.MessageSid, 64), st = clean(b.MessageStatus, 20);
    const row = sid ? db.prepare('SELECT * FROM sms_messages WHERE provider_sid=?').get(sid) : null;
    if (!row || !st) return res.type('text/xml').send('<Response/>');
    const failed = st === 'failed' || st === 'undelivered';
    db.prepare('UPDATE sms_messages SET status=?, error=? WHERE id=?').run(st, failed ? 'Not delivered' + (b.ErrorCode ? ' (code ' + clean(b.ErrorCode, 10) + ')' : '') : row.error, row.id);
    if (failed) {
      const key = keyFor(directory(), { phone: row.to_number, customer_id: row.customer_id, lead_id: row.lead_id });
      if (key) { try { require('./work-engine').conversationNeedsAttention(db, key, 'Text not delivered'); } catch (e) { console.error('work queue sync failed for undelivered text', key, e.message); } }
    }
    res.type('text/xml').send('<Response/>');
  });

  // Communications for the Command Center: counts for the period, each one opens its own center.
  app.get('/api/admin/communications-summary', auth, (req, res) => {
    const allowed = [7, 30, 90, 365]; const days = allowed.includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const n = (sql, ...args) => { try { return db.prepare(sql).get(...args).n || 0; } catch { return 0; } };
    res.json({
      days,
      calls: n('SELECT COUNT(*) n FROM calls WHERE created_at>=?', since),
      voicemails: n("SELECT COUNT(*) n FROM calls WHERE created_at>=? AND outcome='Voicemail'", since),
      missed: n("SELECT COUNT(*) n FROM calls WHERE created_at>=? AND outcome='Missed'", since),
      texts_in: n("SELECT COUNT(*) n FROM sms_messages WHERE created_at>=? AND direction='in'", since),
      texts_out: n("SELECT COUNT(*) n FROM sms_messages WHERE created_at>=? AND (direction IS NULL OR direction<>'in')", since),
      emails_sent: n("SELECT COUNT(*) n FROM email_log WHERE created_at>=? AND status='sent'", since),
      emails_received: n('SELECT COUNT(*) n FROM inbox_messages WHERE received_at>=?', since)
    });
  });

  // Assistant for one conversation: a summary, requests, questions, a suggested reply to edit, and whether a person should look.
  app.post('/api/admin/conversations/:key/assist', auth, async (req, res) => {
    const key = String(req.params.key);
    if (!inbox().some(r => r.key === key)) return res.status(404).json({ error: 'That conversation was not found.' });
    const dir = directory(), ev = events(), lines = [];
    for (const m of ev.portal) if (keyFor(dir, { email: m.email }) === key) {
      lines.push({ dir: 'in', at: m.created_at, channel: 'portal', body: m.subject + '\n' + m.body });
      for (const r of ev.replies.filter(x => x.message_id === m.id)) lines.push({ dir: 'out', at: r.created_at, channel: 'portal', body: r.body });
    }
    for (const s of ev.sms) if (keyFor(dir, { phone: s.to_number, customer_id: s.customer_id, lead_id: s.lead_id }) === key) lines.push({ dir: s.direction === 'in' ? 'in' : 'out', at: s.created_at, channel: 'sms', body: s.body });
    lines.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const result = await require('./assist').assist(app, lines, 'conversation');
    logAction(req, 'assistant ' + result.source, 'conversation', null, key);
    res.json(result);
  });

  module.exports.TEMPLATES = TEMPLATES;
  module.exports.inbox = inbox;
};
