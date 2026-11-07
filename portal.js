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
  const sign = payload => { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return body + '.' + crypto.createHmac('sha256', SECRET()).update(body).digest('base64url'); };
  const unsign = tok => {
    const [body, sig] = String(tok || '').split('.'); if (!body || !sig) return null;
    const good = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.exp > Date.now() ? p : null; } catch { return null; }
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
    res.json({ session: sign({ email: row.email, exp: Date.now() + 8 * 3600000 }), email: row.email });
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
    const invoices = db.prepare(`SELECT invoice_number, amount, paid_amount, due_date, status FROM invoices WHERE lower(email)=? AND status NOT IN ('Draft','Void') ORDER BY id DESC`).all(e)
      .map(i => ({ number: i.invoice_number, amount: i.amount, paid: i.paid_amount || 0, balance: Math.max(0, (i.amount || 0) - (i.paid_amount || 0)), due: i.due_date, status: i.status }));
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
    res.json({ email: e, proposals, contracts, invoices, projects, visits, activity: activity.slice(0, 10) });
  });
};
