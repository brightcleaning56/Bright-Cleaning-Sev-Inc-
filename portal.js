// Client Portal: customers sign in with a one-time link sent to their email (no passwords), then see their own
// proposals, contracts, invoices and project status. Read-only. Signing and payment use the existing secure links.
// Nothing reveals whether an email is on file: the sign-in request always answers the same way.
const crypto = require('crypto');
module.exports = function mountPortal(app, ctx) {
  const { db, getMailer } = ctx;
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
    const proposals = db.prepare(`SELECT id, project_name, proposal_total, status, public_token, created_at FROM estimates WHERE lower(email)=? AND status NOT IN ('Draft','Ready','Superseded','Withdrawn') ORDER BY created_at DESC`).all(e)
      .map(p => ({ id: p.id, title: p.project_name || 'Proposal', total: p.proposal_total, status: p.status, link: `/proposal/${p.public_token}` }));
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
      .map(m => ({ id: m.id, subject: m.subject, body: m.body, at: m.created_at }));
    const pr = db.prepare('SELECT name, company, phone, notify FROM portal_profiles WHERE email=?').get(e) || {};
    const profile = { email: e, name: pr.name || '', company: pr.company || '', phone: pr.phone || '', notify: pr.notify ? JSON.parse(pr.notify) : { schedule: true, proposals: true, invoices: true, projects: true, messages: true } };
    res.json({ email: e, proposals, contracts, invoices, projects, visits, activity: activity.slice(0, 10), properties, requests, messages, profile });
  });

  // A signed-in customer requests service from inside the portal. It becomes a bid lead on their own email.
  db.exec(`CREATE TABLE IF NOT EXISTS portal_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`);
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
