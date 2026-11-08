// Client Portal: customers sign in with a one-time link sent to their email (no passwords), then see their own
// proposals, contracts, invoices and project status. Read-only. Signing and payment use the existing secure links.
// Nothing reveals whether an email is on file: the sign-in request always answers the same way.
const crypto = require('crypto');
const fs = require('fs'), path = require('path');
module.exports = function mountPortal(app, ctx) {
  const { db, getMailer, auth, syncLead, ops, afterDecision, upload, uploadDir } = ctx;
  // One proposal as the customer sees it in the portal. Only this customer's own proposal, never internal notes.
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const numberOf = p => 'P-' + (String(p.created_at || '').slice(0, 4) || '2026') + '-' + String(1000 + p.id);
  function portalProposal(p) {
    let items = []; try { items = JSON.parse(p.line_items || '[]'); } catch { items = []; }
    items = (Array.isArray(items) ? items : []).map(i => ({ description: String(i.description || ''), amount: Number(i.amount) || 0, frequency: String(i.frequency || '') }));
    const decided = ['Approved', 'Declined'].includes(p.status);
    const expired = !decided && !!p.expires_on && p.expires_on < todayStr();
    const actionable = ['Sent', 'Viewed'].includes(p.status) && !expired;
    return {
      id: p.id, number: numberOf(p), title: p.project_name || 'Proposal', site: p.site_address || '', company: p.company || '', customer: p.customer_name || '',
      total: p.proposal_total || 0, tax_pct: p.tax_pct || 0, scope: p.scope || '', area_sqft: p.area_sqft || 0, items, terms: p.terms || '',
      status: expired ? 'Expired' : p.status, raw_status: p.status, issued: String(p.created_at || '').slice(0, 10), expires: p.expires_on || '',
      decided_at: p.decided_at ? String(p.decided_at).slice(0, 10) : '', decline_reason: p.decline_reason || '', signer_name: p.signer_name || '',
      actionable, pdf: '/api/proposal/' + p.public_token + '/pdf', link: '/proposal/' + p.public_token
    };
  }
  db.exec(`CREATE TABLE IF NOT EXISTS portal_logins(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL)`);
  const SECRET = () => (process.env.JWT_SECRET || 'dev-portal') + ':client-portal';
  const now = () => new Date().toISOString();
  const norm = e => String(e || '').trim().toLowerCase().slice(0, 254);
  const isEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  db.exec(`CREATE TABLE IF NOT EXISTS portal_profiles(email TEXT PRIMARY KEY, name TEXT, company TEXT, phone TEXT, notify TEXT, valid_after TEXT, updated_at TEXT)`);
  // A session is valid only if it was issued after the customer last signed out everywhere.
  const sessionOk = p => { const r = db.prepare('SELECT valid_after FROM portal_profiles WHERE email=?').get(p.email); return !(r && r.valid_after && (!p.iat || p.iat < Date.parse(r.valid_after))); };
  const sign = payload => { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return body + '.' + crypto.createHmac('sha256', SECRET()).update(body).digest('base64url'); };
  const unsign = tok => {
    const [body, sig] = String(tok || '').split('.'); if (!body || !sig) return null;
    const good = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.exp > Date.now() && sessionOk(p) ? p : null; } catch { return null; }
  };
  const base = () => (process.env.PUBLIC_BASE_URL || 'https://brightclean.net').replace(/\/$/, '');

  // Step 1: ask for a link. Same answer whether or not the email is on file.
  // At most 5 sign-in requests per address space (IP) every 10 minutes, to stop mail flooding.
  const hits = new Map();
  const tooMany = ip => { const t = Date.now(), a = (hits.get(ip) || []).filter(x => t - x < 600000); a.push(t); hits.set(ip, a); return a.length > 5; };
  app.post('/api/portal/request', async (req, res) => {
    if (tooMany(req.ip || 'x')) return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
    const email = norm((req.body || {}).email);
    const done = () => res.json({ ok: true, message: 'If this email is on file with Bright Clean, a sign-in link is on its way. The link expires in 30 minutes.' });
    if (!isEmail(email)) return done();
    const recent = db.prepare("SELECT created_at FROM portal_logins WHERE email=? ORDER BY id DESC LIMIT 1").get(email);
    if (recent && Date.now() - Date.parse(recent.created_at) < 60000) return done(); // one link a minute
    const onFile = db.prepare(`SELECT 1 FROM estimates WHERE lower(email)=? UNION SELECT 1 FROM contracts WHERE lower(email)=? UNION SELECT 1 FROM invoices WHERE lower(email)=? UNION SELECT 1 FROM customers WHERE lower(email)=? UNION SELECT 1 FROM leads WHERE lower(email)=? LIMIT 1`).get(email, email, email, email, email);
    if (!onFile) return done();
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO portal_logins(email,token_hash,expires_at,created_at) VALUES(?,?,?,?)').run(email, sha(token), new Date(Date.now() + 30 * 60000).toISOString(), now());
    const m = getMailer && getMailer();
    if (m) {
      try { await m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || 'info@brightclean.net', to: email, subject: 'Your Bright Clean client portal sign-in link', text: `Use this link to open your Bright Clean client portal. It expires in 30 minutes and works once.\n\n${base()}/portal.html#${token}\n\nIf you did not ask for this, you can ignore this email.\n\nBright Cleaning Sev Inc.` }); }
      catch (e) { console.error('portal link not sent', e.message); try { db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES('automation','sign-in link not delivered','portal',0,?,?)").run((email + ' — ' + e.message).slice(0, 300), now()); } catch { /* */ } }
    }
    done();
  });

  // Step 2: the link becomes a session (valid 8 hours), used once.
  app.post('/api/portal/verify', (req, res) => {
    const token = String((req.body || {}).token || '');
    if (!token) return res.status(400).json({ error: 'This sign-in link is not valid.' });
    const row = db.prepare('SELECT * FROM portal_logins WHERE token_hash=? AND used_at IS NULL').get(sha(token));
    if (!row || Date.parse(row.expires_at) < Date.now()) return res.status(401).json({ error: 'This sign-in link has expired or was already used. Request a new one.' });
    db.prepare('UPDATE portal_logins SET used_at=? WHERE id=?').run(now(), row.id);
    res.json({ session: sign({ email: row.email, iat: Date.now(), exp: Date.now() + 8 * 3600000 }), email: row.email });
  });

  // Step 3: the customer's own records only (non-draft), read-only.
  app.get('/api/portal/me', (req, res) => {
    const s = unsign(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!s) return res.status(401).json({ error: 'Please sign in again.' });
    const e = s.email;
    const proposals = db.prepare(`SELECT id, project_name, customer_name, company, site_address, scope, area_sqft, line_items, terms, tax_pct, proposal_total, status, public_token, expires_on, decided_at, decline_reason, signer_name, lead_id, created_at FROM estimates WHERE lower(email)=? AND status NOT IN ('Draft','Ready','Superseded','Withdrawn') ORDER BY created_at DESC`).all(e)
      .map(portalProposal);
    const contracts = db.prepare(`SELECT id, title, value, status, signature_status, public_token FROM contracts WHERE lower(email)=? AND status NOT IN ('Draft','Superseded') ORDER BY id DESC`).all(e)
      .map(k => ({ id: k.id, title: k.title || 'Contract', value: k.value, status: k.status, signature: k.signature_status, link: k.public_token && k.signature_status !== 'Signed' ? `/contract/${k.public_token}` : null }));
    const invoices = db.prepare(`SELECT id, invoice_number, amount, paid_amount, due_date, status FROM invoices WHERE lower(email)=? AND status NOT IN ('Draft','Void') ORDER BY id DESC`).all(e)
      .map(i => ({ id: i.id, number: i.invoice_number, amount: i.amount, paid: i.paid_amount || 0, balance: Math.max(0, (i.amount || 0) - (i.paid_amount || 0)), due: i.due_date, status: i.status }));
    const projects = db.prepare(`SELECT p.name, p.status, p.progress, p.site_address FROM projects p JOIN contracts k ON k.id=p.contract_id WHERE lower(k.email)=? ORDER BY p.id DESC`).all(e)
      .map(p => ({ name: p.name, status: p.status, progress: p.progress || 0, site: p.site_address || '' }));
    // Scheduled visits: confirmed or in progress (tentative visits are not shown until they are confirmed).
    // Scheduled visits: confirmed, in progress, or done in the last two weeks. Tentative visits are not shown.
    const visits = db.prepare(`SELECT v.id, v.title, v.type, v.date, v.start_time, v.end_time, v.address, v.status, p.name AS project FROM visits v JOIN projects p ON p.id=v.project_id JOIN contracts k ON k.id=p.contract_id WHERE lower(k.email)=? AND v.status IN ('Scheduled','In progress','Done') AND v.date >= date('now','-14 days') ORDER BY v.date, v.start_time LIMIT 25`).all(e)
      .map(v => ({ id: v.id, title: v.title || v.type, type: v.type, date: v.date, start: v.start_time || '', end: v.end_time || '', address: v.address || '', status: v.status, project: v.project || '' }));
    // Recent activity: only this customer's own records, newest first. No internal notes.
    const activity = [];
    db.prepare(`SELECT project_name, status, created_at FROM estimates WHERE lower(email)=? AND status NOT IN ('Draft','Ready','Superseded','Withdrawn') ORDER BY created_at DESC LIMIT 10`).all(e)
      .forEach(x => activity.push({ at: x.created_at, text: 'Proposal: ' + (x.project_name || 'Proposal') + ' (' + x.status + ')' }));
    db.prepare(`SELECT title, signature_status, created_at, signed_at FROM contracts WHERE lower(email)=? AND status NOT IN ('Draft','Superseded') ORDER BY id DESC LIMIT 10`).all(e)
      .forEach(x => activity.push({ at: x.signed_at || x.created_at, text: 'Contract: ' + (x.title || 'Contract') + ' (' + x.signature_status + ')' }));
    db.prepare(`SELECT invoice_number, status, created_at FROM invoices WHERE lower(email)=? AND status NOT IN ('Draft','Void') ORDER BY id DESC LIMIT 10`).all(e)
      .forEach(x => activity.push({ at: x.created_at, text: 'Invoice ' + x.invoice_number + ' (' + x.status + ')' }));
    visits.filter(v => v.status === 'Done').forEach(v => activity.push({ at: v.date, text: 'Service completed: ' + v.title }));
    activity.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    // Properties: the site addresses on this customer's projects, proposals and visits.
    const siteRows = db.prepare(`SELECT p.site_address AS a, p.name AS n, p.status AS s FROM projects p JOIN contracts k ON k.id=p.contract_id WHERE lower(k.email)=? AND p.site_address IS NOT NULL AND p.site_address<>''
      UNION SELECT site_address AS a, project_name AS n, status AS s FROM estimates WHERE lower(email)=? AND site_address IS NOT NULL AND site_address<>'' AND status NOT IN ('Draft','Ready','Superseded','Withdrawn')`).all(e, e);
    const seen = new Map();
    siteRows.forEach(r => { const k = String(r.a).trim().toLowerCase(); if (!seen.has(k)) seen.set(k, { address: r.a, name: r.n || r.a, status: r.s || '' }); });
    const properties = [...seen.values()];
    // Service requests this customer sent from the portal, with their status.
    const requests = db.prepare(`SELECT id, service, status, created_at FROM leads WHERE lower(email)=? AND details LIKE 'Source: client portal%' ORDER BY id DESC LIMIT 20`).all(e)
      .map(r => ({ id: r.id, service: r.service || 'Service request', status: r.status, at: r.created_at }));
    const messages = db.prepare('SELECT id, subject, body, created_at FROM portal_messages WHERE lower(email)=? ORDER BY id DESC LIMIT 20').all(e)
      .map(m => ({ id: m.id, subject: m.subject, body: m.body, at: m.created_at, replies: db.prepare('SELECT body, created_at FROM portal_message_replies WHERE message_id=? ORDER BY id').all(m.id).map(r => ({ body: r.body, at: r.created_at })) }));
    const pr = db.prepare('SELECT name, company, phone, notify FROM portal_profiles WHERE email=?').get(e) || {};
    const profile = { email: e, name: pr.name || '', company: pr.company || '', phone: pr.phone || '', notify: pr.notify ? JSON.parse(pr.notify) : { schedule: true, proposals: true, invoices: true, projects: true, messages: true } };
    // Inspection reports: signed inspections for this customer's properties and projects only.
    let inspections = [];
    try {
      inspections = db.prepare(`SELECT i.id, i.date, i.area, i.score, i.passed, i.status, i.itype, i.signed_name, i.signed_at, p.name AS project
        FROM inspections i LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN projects p ON p.id=i.project_id LEFT JOIN contracts k ON k.id=p.contract_id
        WHERE i.signed_at IS NOT NULL AND i.status <> 'Cancelled' AND (lower(c.email)=? OR lower(k.email)=?) ORDER BY i.date DESC, i.id DESC LIMIT 20`).all(e, e)
        .map(i => ({ id: i.id, date: i.date || String(i.signed_at || '').slice(0, 10), area: i.area || '', score: i.score == null ? null : Math.round(i.score), passed: !!i.passed, status: i.status || '', project: i.project || '', signed_by: i.signed_name || '' }));
    } catch { inspections = []; }
    // Files the customer uploaded from the portal (kept with their records).
    const uploads = db.prepare(`SELECT d.id, d.title, d.file_name, d.file_url, d.size, d.created_at, d.estimate_id FROM documents d WHERE lower(d.uploaded_by)=? AND d.kind='Customer upload' AND COALESCE(d.status,'Current')<>'Archived' ORDER BY d.id DESC LIMIT 50`).all(e)
      .map(d => ({ id: d.id, title: d.title || d.file_name || 'Document', file_name: d.file_name || '', file: path.basename(String(d.file_url || '')), size: d.size || 0, at: d.created_at, proposal_id: d.estimate_id || null }));
    res.json({ email: e, uploads, inspections, proposals, contracts, invoices, projects, visits, activity: activity.slice(0, 10), properties, requests, messages, profile });
  });

  // A signed-in customer requests service from inside the portal. It becomes a bid lead on their own email.
  db.exec(`CREATE TABLE IF NOT EXISTS portal_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS portal_message_replies(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, body TEXT NOT NULL, by_user TEXT, created_at TEXT NOT NULL)`);
  // Whether this customer wants emails of a kind (defaults to yes).
  function wantsEmail(email, kind) {
    const r = db.prepare('SELECT notify FROM portal_profiles WHERE email=?').get(String(email || '').toLowerCase());
    if (!r || !r.notify) return true;
    try { return JSON.parse(r.notify)[kind] !== false; } catch { return true; }
  }
  app.locals.portalWantsEmail = wantsEmail;
  // Staff: the messages customers sent from the portal, with replies.
  app.get('/api/admin/portal-messages', auth, (req, res) => {
    const rows = db.prepare('SELECT id, email, subject, body, created_at FROM portal_messages ORDER BY id DESC LIMIT 100').all();
    res.json({ messages: rows.map(m => ({ ...m, replies: db.prepare('SELECT id, body, by_user, created_at FROM portal_message_replies WHERE message_id=? ORDER BY id').all(m.id) })) });
  });
  // Staff reply: saved to the conversation and emailed to the customer unless they turned message emails off.
  app.post('/api/admin/portal-messages/:id/reply', auth, async (req, res) => {
    const m = db.prepare('SELECT * FROM portal_messages WHERE id=?').get(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'Message not found.' });
    const body = String((req.body || {}).body || '').trim().slice(0, 4000);
    if (body.length < 2) return res.status(400).json({ error: 'Write the reply first.' });
    const by = (req.user && req.user.email) || 'staff';
    const id = db.prepare('INSERT INTO portal_message_replies(message_id,body,by_user,created_at) VALUES(?,?,?,?)').run(m.id, body, by, new Date().toISOString()).lastInsertRowid;
    const mailer2 = getMailer && getMailer();
    let emailed = false;
    if (mailer2 && wantsEmail(m.email, 'messages')) {
      try { await mailer2.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || 'info@brightclean.net', to: m.email, subject: 'Re: ' + m.subject, text: body + '\n\nYou can see this conversation in your Bright Clean client portal.\n\nBright Cleaning Sev Inc. · +1 (515) 303-3024' }); emailed = true; }
      catch (e) { console.error('portal reply not sent', e.message); }
    }
    res.status(201).json({ ok: true, id, emailed });
  });
  const msgHits = new Map();
  // Customer message from the portal. Saved to the account and sent to the office.
  app.post('/api/portal/messages', async (req, res) => {
    const sess = unsign(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!sess) return res.status(401).json({ error: 'Please sign in again.' });
    const t = Date.now(), recent = (msgHits.get(sess.email) || []).filter(x => t - x < 3600000);
    if (recent.length >= 5) return res.status(429).json({ error: 'You have sent several messages. Please call (515) 303-3024 for urgent help.' });
    recent.push(t); msgHits.set(sess.email, recent);
    const subject = String((req.body || {}).subject || '').trim().slice(0, 200) || 'Message from the client portal';
    const body = String((req.body || {}).body || '').trim().slice(0, 4000);
    if (body.length < 5) return res.status(400).json({ error: 'Write your message first.' });
    const at = now();
    const id = db.prepare('INSERT INTO portal_messages(email,subject,body,created_at) VALUES(?,?,?,?)').run(sess.email, subject, body, at).lastInsertRowid;
    const m = getMailer && getMailer();
    if (m) {
      const from = process.env.FROM_EMAIL || process.env.SMTP_USER || 'info@brightclean.net';
      try { await m.sendMail({ from, to: process.env.NOTIFY_EMAIL || 'info@brightclean.net', subject: 'Client portal message: ' + subject, text: 'From: ' + sess.email + '\n\n' + body + '\n\nReply to this email to answer the customer.', replyTo: sess.email }); } catch (e) { console.error('portal message notice not sent', e.message); }
      try { await m.sendMail({ from, to: sess.email, subject: 'We received your message', text: 'Thank you. We received your message and will reply soon.\n\nBright Cleaning Sev Inc. · +1 (515) 303-3024' }); } catch (e) { console.error('portal message ack not sent', e.message); }
    }
    res.status(201).json({ ok: true, id, message: 'Thank you. Your message was sent to the Bright Clean team.' });
  });
  // Account: name, company, phone and which updates the customer wants. Email changes are handled by the team.
  const NOTIFY = ['schedule', 'proposals', 'invoices', 'projects', 'messages'];
  app.put('/api/portal/profile', (req, res) => {
    const sess = unsign(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!sess) return res.status(401).json({ error: 'Please sign in again.' });
    const b = req.body || {};
    const cur = db.prepare('SELECT * FROM portal_profiles WHERE email=?').get(sess.email) || {};
    const notify = {};
    NOTIFY.forEach(k => { notify[k] = b.notify && typeof b.notify === 'object' ? !!b.notify[k] : (cur.notify ? !!JSON.parse(cur.notify)[k] : true); });
    const name = String(b.name == null ? cur.name || '' : b.name).trim().slice(0, 150);
    const company = String(b.company == null ? cur.company || '' : b.company).trim().slice(0, 200);
    const phone = String(b.phone == null ? cur.phone || '' : b.phone).trim().slice(0, 60);
    db.prepare(`INSERT INTO portal_profiles(email,name,company,phone,notify,valid_after,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET name=excluded.name, company=excluded.company, phone=excluded.phone, notify=excluded.notify, updated_at=excluded.updated_at`)
      .run(sess.email, name, company, phone, JSON.stringify(notify), cur.valid_after || null, new Date().toISOString());
    res.json({ ok: true, message: 'Saved.' });
  });
  // Sign out everywhere: every session issued before now stops working.
  app.post('/api/portal/sign-out-everywhere', (req, res) => {
    const sess = unsign(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!sess) return res.status(401).json({ error: 'Please sign in again.' });
    const t = new Date(Date.now() + 1000).toISOString();
    db.prepare(`INSERT INTO portal_profiles(email,valid_after,updated_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET valid_after=excluded.valid_after, updated_at=excluded.updated_at`).run(sess.email, t, t);
    res.json({ ok: true, message: 'You were signed out everywhere. Sign in again with a new link.' });
  });
  const reqHits = new Map();
  const ownProposal = (sess, id) => db.prepare('SELECT * FROM estimates WHERE id=? AND lower(email)=?').get(Number(id), sess.email);
  // Approve or decline from the portal. Same rules as the emailed proposal link: a typed name to approve, one decision only.
  app.post('/api/portal/proposals/:id/respond', (req, res) => {
    const sess = unsign(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!sess) return res.status(401).json({ error: 'Please sign in again.' });
    const e = ownProposal(sess, req.params.id);
    if (!e) return res.status(404).json({ error: 'Proposal not found.' });
    const b = req.body || {};
    const decision = String(b.decision || '');
    if (!['approve', 'decline'].includes(decision)) return res.status(400).json({ error: 'Choose approve or decline.' });
    if (['Draft', 'Ready', 'Superseded', 'Withdrawn'].includes(e.status)) return res.status(409).json({ error: 'This proposal is not open for a decision. Message Bright Clean for help.' });
    if (['Approved', 'Declined'].includes(e.status)) return res.status(409).json({ error: 'This proposal was already ' + e.status.toLowerCase() + '.' });
    if (e.expires_on && e.expires_on < todayStr()) return res.status(410).json({ error: 'This proposal has expired. Message Bright Clean for an updated proposal.' });
    const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    const dt = now();
    if (decision === 'approve') {
      const signer = clip(b.signer_name, 120);
      if (signer.length < 2 || !b.agree) return res.status(400).json({ error: 'To approve, type your full name and confirm you are authorized to approve this proposal.' });
      db.prepare('UPDATE estimates SET signer_name=?, signer_title=?, signed_at=? WHERE id=?').run(signer, clip(b.signer_title, 120), dt, e.id);
    } else if (clip(b.reason, 1000)) {
      db.prepare('UPDATE estimates SET decline_reason=? WHERE id=?').run(clip(b.reason, 1000), e.id);
    }
    const status = decision === 'approve' ? 'Approved' : 'Declined';
    db.prepare('UPDATE estimates SET status=?, updated_at=?, decided_at=?, decision_ip=?, decision_agent=? WHERE id=?')
      .run(status, dt, dt, clip(req.ip, 100), clip((req.headers && req.headers['user-agent']) || '', 300), e.id);
    if (typeof syncLead === 'function') syncLead(e.lead_id, decision === 'approve' ? 'approved' : 'declined', e.id);
    if (typeof afterDecision === 'function') { try { afterDecision(e, decision); } catch (err) { console.error('portal decision follow-up failed', err.message); } }
    db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(sess.email, decision === 'approve' ? 'approved proposal in client portal' : 'declined proposal in client portal', 'estimate', e.id, 'from the client portal', dt);
    if (decision === 'approve' && ops && ops.upsertCustomer) { try { ops.upsertCustomer({ name: e.customer_name, company: e.company, email: e.email, address: e.site_address }, 'approved proposal'); } catch { /* */ } }
    res.json({ ok: true, status, message: decision === 'approve' ? 'Thank you. Your approval was recorded and our team will confirm next steps.' : 'Thank you. Your decision was recorded.' });
  });
  // Ask for changes: sent to the office as a message on the customer's account, linked to the proposal number.
  app.post('/api/portal/proposals/:id/changes', async (req, res) => {
    const sess = unsign(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!sess) return res.status(401).json({ error: 'Please sign in again.' });
    const e = ownProposal(sess, req.params.id);
    if (!e) return res.status(404).json({ error: 'Proposal not found.' });
    if (['Approved', 'Declined', 'Withdrawn', 'Superseded'].includes(e.status)) return res.status(409).json({ error: 'This proposal is already closed. Message Bright Clean for changes.' });
    const body = String((req.body || {}).body || '').trim().slice(0, 4000);
    if (body.length < 5) return res.status(400).json({ error: 'Describe the changes you need.' });
    const number = numberOf(e);
    const subject = 'Change request: ' + number + ' ' + (e.project_name || 'proposal');
    const at = now();
    const id = db.prepare('INSERT INTO portal_messages(email,subject,body,created_at) VALUES(?,?,?,?)').run(sess.email, subject.slice(0, 200), body, at).lastInsertRowid;
    const m = getMailer && getMailer();
    if (m) { try { await m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || 'info@brightclean.net', to: process.env.NOTIFY_EMAIL || 'info@brightclean.net', subject: 'Change request on ' + number, text: 'From: ' + sess.email + '\n\n' + body + '\n\nReply to this email to answer the customer.', replyTo: sess.email }); } catch (err) { console.error('change request notice not sent', err.message); } }
    res.status(201).json({ ok: true, id, message: 'Thank you. Your change request was sent to the Bright Clean team. We will send an updated proposal.' });
  });
  // Customer uploads a document (PDF, Word, Excel, image or zip), optionally for one of their proposals.
  app.post('/api/portal/documents', (req, res) => {
    const sess = unsign(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!sess) return res.status(401).json({ error: 'Please sign in again.' });
    if (!upload) return res.status(503).json({ error: 'Uploads are not available right now. Please email the file to the Bright Clean team.' });
    const [mwUp, verifyUp] = upload.single('file');
    mwUp(req, res, err => verifyUp(req, res, () => portalDocHandler(req, res, err, sess)));
  });
  function portalDocHandler(req, res, err, sess) {
    {
      const f = req.file;
      const drop = () => { if (f) try { fs.unlinkSync(f.path); } catch { /* */ } };
      if (err) { drop(); return res.status(400).json({ error: err.message === 'Unsupported file type' ? 'That file type is not accepted. Use PDF, Word, Excel, an image or a zip file.' : 'The file could not be uploaded. Please try a smaller file.' }); }
      if (!f) return res.status(400).json({ error: 'Choose a file to upload.' });
      const body = req.body || {};
      const title = String(body.title || '').trim().slice(0, 200) || f.originalname;
      let eid = null;
      if (body.proposal_id) {
        const own = db.prepare('SELECT id FROM estimates WHERE id=? AND lower(email)=?').get(Number(body.proposal_id), sess.email);
        if (!own) { drop(); return res.status(400).json({ error: 'Choose one of your own proposals, or leave it blank.' }); }
        eid = own.id;
      }
      const at = now();
      const id = db.prepare("INSERT INTO documents(estimate_id,title,kind,file_name,file_url,size,uploaded_by,created_at,status,version) VALUES(?,?,?,?,?,?,?,?,'Current',1)")
        .run(eid, title, 'Customer upload', f.originalname, '/api/portal/files/' + path.basename(f.filename), f.size, sess.email, at).lastInsertRowid;
      try { db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(sess.email, 'uploaded a document in client portal', 'document', id, f.originalname, at); } catch { /* */ }
      res.status(201).json({ ok: true, id, message: 'Thank you. Your document was uploaded to the Bright Clean team.' });
    }
  }
  // Download one of the customer's own uploads (checked against the signed-in customer).
  app.get('/api/portal/files/:name', (req, res) => {
    const sess = unsign(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!sess) return res.status(401).json({ error: 'Please sign in again.' });
    const name = path.basename(req.params.name);
    const row = db.prepare("SELECT d.file_name FROM documents d LEFT JOIN estimates e ON e.id=d.estimate_id WHERE d.file_url=? AND (lower(d.uploaded_by)=? OR lower(e.email)=?)").get('/api/portal/files/' + name, sess.email, sess.email);
    if (!row || !uploadDir) return res.status(404).json({ error: 'File not found.' });
    const p = path.join(uploadDir, name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'File not found.' });
    res.download(p, row.file_name || name);
  });
  app.post('/api/portal/request-service', async (req, res) => {
    const sess = unsign(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!sess) return res.status(401).json({ error: 'Please sign in again.' });
    const t = Date.now(), recent = (reqHits.get(sess.email) || []).filter(x => t - x < 300000);
    if (recent.length >= 3) return res.status(429).json({ error: 'You have sent several requests just now. Please wait a few minutes or call (515) 303-3024.' });
    recent.push(t); reqHits.set(sess.email, recent);
    const b = req.body || {};
    const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    const service = clip(b.service, 200), details = clip(b.details, 4000), address = clip(b.address, 300);
    const company = clip(b.company, 200), phone = clip(b.phone, 60), name = clip(b.contact_name, 150);
    if (!service) return res.status(400).json({ error: 'Choose the service you need.' });
    if (details.length < 10) return res.status(400).json({ error: 'Describe what you need in a few words.' });
    const at = now();
    const id = db.prepare("INSERT INTO leads(kind,status,contact_name,company,email,phone,address,service,project_name,details,created_at,updated_at) VALUES('bid','New',?,?,?,?,?,?,?,?,?,?)")
      .run(name || company || sess.email, company, sess.email, phone, address, service, service, 'Source: client portal\n' + details, at, at).lastInsertRowid;
    try { db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(sess.email, 'requested service in client portal', 'lead', id, service, at); } catch { /* */ }
    const m = getMailer && getMailer();
    if (m) {
      const from = process.env.FROM_EMAIL || process.env.SMTP_USER || 'info@brightclean.net';
      try { await m.sendMail({ from, to: process.env.NOTIFY_EMAIL || 'info@brightclean.net', subject: 'New service request from the client portal', text: 'From: ' + sess.email + '\nService: ' + service + '\nAddress: ' + address + '\n\n' + details }); } catch (e) { console.error('portal request notice not sent', e.message); }
      try { await m.sendMail({ from, to: sess.email, subject: 'We received your Bright Clean request', text: 'Thank you for reaching out to Bright Cleaning Sev Inc. We received your request for ' + service + '. Our team will review the details and follow up with you.\n\nYou can also call +1 (515) 303-3024.\n\nBright Cleaning Sev Inc.' }); } catch (e) { console.error('portal request ack not sent', e.message); }
    }
    res.status(201).json({ ok: true, id, message: 'Thank you. We received your request and will follow up with you soon.' });
  });
};
