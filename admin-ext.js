// Admin back-office routes added in the admin upgrade.
// Mounted from server.js before the static and 404 handlers.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function mountAdminExt(app, ctx) {
  const { db, auth, logAction, clean, num, required, estimateMath, uploadDir, bcrypt, adminEmail, adminHash } = ctx;
  const today = () => require('./bizdate').today();
  const id = req => Number(req.params.id);

  // ---------- Dashboard ----------
  app.get('/api/admin/dashboard', auth, (req, res) => {
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const in14 = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const leadCounts = db.prepare(`SELECT kind, COUNT(*) n, SUM(status='New') fresh, SUM(created_at>=?) week FROM leads GROUP BY kind`).all(weekAgo);
    // Billed = invoices actually sent (Draft and Void are not owed by the customer). Same rule as Reports and Command.
    const fin = db.prepare(`SELECT COALESCE(SUM(amount),0) billed, COALESCE(SUM(paid_amount),0) collected FROM invoices WHERE status NOT IN ('Draft','Void')`).get();
    res.json({
      leads: leadCounts,
      newLeads: db.prepare(`SELECT id,kind,contact_name,company,project_name,created_at FROM leads WHERE status='New' ORDER BY created_at DESC LIMIT 8`).all(),
      awaitingResponse: db.prepare(`SELECT id,customer_name,company,project_name,proposal_total,status,updated_at FROM estimates WHERE status IN ('Sent','Viewed') ORDER BY updated_at DESC LIMIT 8`).all(),
      draftProposals: db.prepare(`SELECT COUNT(*) n FROM estimates WHERE status IN ('Draft','Ready')`).get().n,
      dueProjects: db.prepare(`SELECT id,name,customer_name,company,due_date,status,progress FROM projects WHERE status NOT IN ('Completed','On Hold') AND due_date<>'' AND due_date IS NOT NULL AND due_date<=? ORDER BY due_date LIMIT 8`).all(in14),
      overdueInvoices: db.prepare(`SELECT id,invoice_number,customer_name,company,amount,paid_amount,due_date FROM invoices WHERE status NOT IN ('Paid','Void','Draft') AND due_date<>'' AND due_date IS NOT NULL AND due_date<? AND paid_amount<amount ORDER BY due_date LIMIT 8`).all(today()),
      renewals: db.prepare(`SELECT id,title,customer_name,company,end_date,status FROM contracts WHERE status IN ('Active','Renewal Due') AND end_date<>'' AND end_date IS NOT NULL AND end_date<=? ORDER BY end_date LIMIT 8`).all(new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10)),
      finance: { ...fin, outstanding: Math.max(0, fin.billed - fin.collected) },
      activity: db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 12`).all()
    });
  });

  // ---------- Leads ----------
  app.delete('/api/admin/leads/:id', auth, (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(id(req));
    if (!lead) return res.status(404).json({ error: 'Not found' });
    for (const f of JSON.parse(lead.files || '[]')) {
      const p = path.join(uploadDir, path.basename(f.url || ''));
      try { if (p.startsWith(path.resolve(uploadDir)) && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
    }
    db.prepare('DELETE FROM leads WHERE id=?').run(lead.id);
    logAction(req, 'deleted', 'lead', lead.id, lead.contact_name || '');
    res.json({ ok: true });
  });

  // ---------- Estimates ----------
  const estimateFields = b => ({
    lead_id: num(b.lead_id) || null,
    customer_name: clean(b.customer_name, 180), company: clean(b.company, 200), email: clean(b.email, 254),
    project_name: clean(b.project_name, 200), site_address: clean(b.site_address, 500), scope: clean(b.scope, 10000),
    area_sqft: num(b.area_sqft), production_rate: num(b.production_rate), labor_rate: num(b.labor_rate),
    supplies_cost: num(b.supplies_cost), equipment_cost: num(b.equipment_cost), other_cost: num(b.other_cost),
    overhead_pct: num(b.overhead_pct), margin_pct: num(b.margin_pct), tax_pct: num(b.tax_pct),
    line_items: JSON.stringify(require('./estimating').lineItemsOf(b)),
    terms: clean(b.terms, 5000), expires_on: clean(b.expires_on, 30)
  });

  app.put('/api/admin/estimates/:id', auth, (req, res) => {
    { const pr = Number((req.body || {}).production_rate); if (pr > 0 && pr < 20) return res.status(400).json({ error: `Production rate is square feet cleaned per labor hour (typically 1,000–3,000). ${pr} looks like a price per square foot — enter the rate in sq ft per hour.` }); }
    const b = req.body || {};
    const e = db.prepare('SELECT * FROM estimates WHERE id=?').get(id(req));
    if (!e) return res.status(404).json({ error: 'Not found' });
    if (['Approved'].includes(e.status)) return res.status(409).json({ error: 'This proposal was approved by the customer. Duplicate it to make changes.' });
    if (['Sent', 'Viewed', 'Declined'].includes(e.status)) {
      const locked = ['proposal_total', 'scope', 'terms', 'tax_pct', 'area_sqft', 'production_rate', 'labor_hours', 'labor_rate', 'use_line_items', 'customer_name', 'email', 'company', 'site_address', 'project_name'];
      const norm = v => v === true ? '1' : v === false ? '0' : (v === null || v === undefined) ? '' : String(v).trim();
      const same = (a, z) => (a !== '' && z !== '' && isFinite(Number(a)) && isFinite(Number(z))) ? Number(a) === Number(z) : norm(a) === norm(z);
      const changed = locked.filter(f => f in b && !same(b[f], e[f]));
      if (changed.length) return res.status(409).json({ error: `This proposal was already sent to the client, so ${changed.join(', ')} cannot change on it. Duplicate the proposal to revise it.` });
    }
    if (!required(b.customer_name) || !required(b.scope)) return res.status(400).json({ error: 'Customer and scope are required.' });
    if (b.email && !require('./ops').isEmail(b.email)) return res.status(400).json({ error: 'Enter a valid customer email address.' });
    const scopeErr = require('./scopes').resolveLines(db, b);
    if (scopeErr) return res.status(400).json({ error: scopeErr });
    const m = estimateMath(b);
    const f = { ...estimateFields(b), labor_hours: m.labor_hours, labor_cost: m.labor_cost, total_cost: m.total_cost, proposal_total: m.proposal_total, updated_at: new Date().toISOString(), id: e.id };
    db.prepare(`UPDATE estimates SET lead_id=@lead_id,customer_name=@customer_name,company=@company,email=@email,project_name=@project_name,site_address=@site_address,scope=@scope,area_sqft=@area_sqft,production_rate=@production_rate,labor_hours=@labor_hours,labor_rate=@labor_rate,labor_cost=@labor_cost,supplies_cost=@supplies_cost,equipment_cost=@equipment_cost,other_cost=@other_cost,overhead_pct=@overhead_pct,margin_pct=@margin_pct,tax_pct=@tax_pct,total_cost=@total_cost,proposal_total=@proposal_total,line_items=@line_items,terms=@terms,expires_on=@expires_on,updated_at=@updated_at WHERE id=@id`).run(f);
    require('./estimating').saveExtras(db, e.id, b, m);
    logAction(req, 'edited', 'estimate', e.id);
    res.json({ estimate: db.prepare('SELECT * FROM estimates WHERE id=?').get(e.id) });
  });

  app.post('/api/admin/estimates/:id/duplicate', auth, (req, res) => {
    const e = db.prepare('SELECT * FROM estimates WHERE id=?').get(id(req));
    if (!e) return res.status(404).json({ error: 'Not found' });
    const now = new Date().toISOString();
    const copy = { ...e, id: undefined, status: 'Draft', public_token: crypto.randomBytes(24).toString('hex'), project_name: (e.project_name || 'Proposal') + ' (copy)', created_at: now, updated_at: now, sent_at: null, viewed_at: null, last_viewed_at: null, view_count: 0, decided_at: null, decision_ip: null, decision_agent: null };
    delete copy.id;
    const cols = Object.keys(copy);
    const r = db.prepare(`INSERT INTO estimates(${cols.join(',')}) VALUES(${cols.map(c => '@' + c).join(',')})`).run(copy);
    logAction(req, 'duplicated', 'estimate', r.lastInsertRowid, 'from #' + e.id);
    res.status(201).json({ id: r.lastInsertRowid });
  });

  app.delete('/api/admin/estimates/:id', auth, (req, res) => {
    const e = db.prepare('SELECT * FROM estimates WHERE id=?').get(id(req));
    if (!e) return res.status(404).json({ error: 'Not found' });
    if (e.status === 'Approved') return res.status(409).json({ error: 'Approved proposals are kept for your records and can’t be deleted.' });
    db.prepare('DELETE FROM estimates WHERE id=?').run(e.id);
    logAction(req, 'deleted', 'estimate', e.id, e.customer_name);
    res.json({ ok: true });
  });

  // ---------- Contracts / projects / invoices: delete ----------
  for (const table of ['contracts', 'projects', 'invoices']) {
    app.delete(`/api/admin/${table}/:id`, auth, (req, res) => {
      // Audit D-11: only owners/managers delete, and only records with no financial or signed history.
      const em = String((req.user && req.user.email) || '').toLowerCase(), ow = String(process.env.ADMIN_EMAIL || '').toLowerCase();
      const role = !ow || em === ow ? 'owner' : ((db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(em) || {}).role || 'staff');
      if (!['owner', 'manager'].includes(role)) return res.status(403).json({ error: 'Only an owner or manager can delete records.' });
      const r = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id(req)); if (!r) return res.status(404).json({ error: 'Not found' });
      if (table === 'contracts' && (r.signature_status === 'Signed' || ['Active', 'Completed'].includes(r.status))) return res.status(409).json({ error: 'A signed or active contract cannot be deleted. Close or archive it instead so its history is kept.' });
      if (table === 'invoices' && (Number(r.paid_amount) > 0 || ['Sent', 'Paid', 'Partially Paid', 'Overdue'].includes(r.status) || r.sent_at)) return res.status(409).json({ error: 'An invoice that was sent or has payments cannot be deleted. Void it instead.' });
      if (table === 'projects' && db.prepare('SELECT COUNT(*) n FROM invoices WHERE project_id=?').get(r.id).n) return res.status(409).json({ error: 'This project has invoices. Archive it instead of deleting.' });
      const x = db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id(req));
      if (!x.changes) return res.status(404).json({ error: 'Not found' });
      logAction(req, 'deleted', table.slice(0, -1), id(req));
      res.json({ ok: true });
    });
  }

  // Extra editable fields that the original register routes don't cover.
  app.patch('/api/admin/extra/:table/:id', auth, (req, res) => {
    const allowed = { contracts: ['notes'], invoices: ['notes', 'issue_date'] }[req.params.table];
    if (!allowed) return res.status(404).json({ error: 'Not found' });
    const keys = allowed.filter(k => Object.prototype.hasOwnProperty.call(req.body || {}, k));
    if (!keys.length) return res.json({ ok: true });
    db.prepare(`UPDATE ${req.params.table} SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => clean(req.body[k], 10000)), id(req));
    res.json({ ok: true });
  });

  // ---------- Invoices: record payment ----------
  app.post('/api/admin/invoices/:id/payment', auth, (req, res) => {
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(id(req));
    if (!inv) return res.status(404).json({ error: 'Not found' });
    const amt = num(req.body && req.body.amount);
    if (!amt) return res.status(400).json({ error: 'Enter a payment amount greater than zero.' });
    if (inv.status === 'Void') return res.status(409).json({ error: 'This invoice is void. Payments cannot be recorded on it.' });
    if (inv.status === 'Draft') return res.status(409).json({ error: 'Send this invoice before recording a payment on it.' });
    const balance = Math.round((Number(inv.amount || 0) - Number(inv.paid_amount || 0)) * 100) / 100;
    if (balance <= 0) return res.status(409).json({ error: 'This invoice is already paid in full.' });
    if (amt > balance + 0.005) return res.status(400).json({ error: `That is more than the balance due ($${balance.toFixed(2)}). Record the exact amount, or record the extra as a separate credit.` });
    const paid = Math.round((Number(inv.paid_amount || 0) + amt) * 100) / 100;
    const status = paid >= Number(inv.amount || 0) ? 'Paid' : 'Partially Paid';
    db.prepare('UPDATE invoices SET paid_amount=?,status=? WHERE id=?').run(paid, status, inv.id);
    // Dated payment record (feeds "collected this month" on the Command Center).
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.received_on || '')) && req.body.received_on <= require('./bizdate').today() ? req.body.received_on : null;
    const nowIso = new Date().toISOString();
    db.prepare('INSERT INTO payments(invoice_id,amount,note,received_at,recorded_by,created_at) VALUES(?,?,?,?,?,?)')
      .run(inv.id, amt, clean(req.body.note || '', 300), day ? day + 'T12:00:00.000Z' : nowIso, (req.user && req.user.email) || null, nowIso);
    logAction(req, 'recorded payment', 'invoice', inv.id, `$${amt.toFixed(2)}${req.body.note ? ' — ' + clean(req.body.note, 300) : ''}`);
    res.json({ ok: true, paid_amount: paid, status });
  });

  // ---------- Invoices: refund ----------
  // A refund returns money already received. It is kept as a negative payment so the payment history stays complete.
  app.post('/api/admin/invoices/:id/refund', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req.user && req.user.email))) return res.status(403).json({ error: 'Only an owner or manager can record a refund.' });
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(id(req));
    if (!inv) return res.status(404).json({ error: 'Not found' });
    if (['Draft', 'Void'].includes(inv.status)) return res.status(409).json({ error: 'Only a sent invoice can be refunded.' });
    const amt = num(req.body && req.body.amount);
    if (!amt) return res.status(400).json({ error: 'Enter a refund amount greater than zero.' });
    const note = clean((req.body && req.body.note) || '', 300);
    if (!note) return res.status(400).json({ error: 'Say why the money is being refunded.' });
    const before = Math.round(Number(inv.paid_amount || 0) * 100) / 100;
    if (amt > before + 0.005) return res.status(409).json({ error: `Only $${before.toFixed(2)} has been received on this invoice, so the refund cannot be more than that.` });
    const paid = Math.round((before - amt) * 100) / 100;
    const status = paid <= 0 ? 'Sent' : (paid >= Number(inv.amount || 0) ? 'Paid' : 'Partially Paid');
    const nowIso = new Date().toISOString();
    db.transaction(() => {
      db.prepare('INSERT INTO payments(invoice_id,amount,note,received_at,recorded_by,created_at) VALUES(?,?,?,?,?,?)')
        .run(inv.id, -amt, 'Refund: ' + note, nowIso, (req.user && req.user.email) || null, nowIso);
      db.prepare('UPDATE invoices SET paid_amount=?,status=? WHERE id=?').run(paid, status, inv.id);
    })();
    logAction(req, 'refunded', 'invoice', inv.id, `$${amt.toFixed(2)} refunded — ${note}`);
    res.json({ ok: true, paid_amount: paid, status });
  });

  app.get('/api/admin/next-invoice-number', auth, (req, res) => {
    const year = new Date().getFullYear();
    const rows = db.prepare(`SELECT invoice_number FROM invoices WHERE invoice_number LIKE ?`).all(`BC-${year}-%`);
    const max = rows.reduce((m, r) => Math.max(m, Number(String(r.invoice_number).split('-')[2]) || 0), 0);
    res.json({ number: `BC-${year}-${String(max + 1).padStart(4, '0')}` });
  });

  // Customers are served by ops.js (persistent customer directory).

  // ---------- Account & users ----------
  app.get('/api/admin/me', auth, (req, res) => { const R = require('./roles'), e = req.user && req.user.email, ow = String(adminEmail || '').toLowerCase(); const role = !ow || String(e || '').toLowerCase() === ow ? 'owner' : ((db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(String(e || '').toLowerCase()) || {}).role || 'staff');
    const nm = role === 'owner' && String(e || '').toLowerCase() === ow ? ownerName() : ((db.prepare('SELECT name FROM admin_users WHERE lower(email)=?').get(String(e || '').toLowerCase()) || {}).name || '');
    res.json({ email: e, name: nm, role, label: (R.ROLES[role] || {}).label || role, views: R.VIEWS[role] || null, home: R.HOME[role] || 'overview', sees_money: R.seesMoney(role), mfa_setup_required: !!(req.user && req.user.mfa !== true && ['owner', 'manager'].includes(role)) }); });
  const ownerName = () => { try { const r = db.prepare("SELECT value FROM settings WHERE key='owner_name'").get(); return (r && r.value) || process.env.ADMIN_NAME || 'Owner'; } catch { return process.env.ADMIN_NAME || 'Owner'; } };
  // Each person sets their own display name (owner account from the environment is stored in settings).
  app.put('/api/admin/account/name', auth, (req, res) => {
    const name = clean((req.body || {}).name, 120); if (!name) return res.status(400).json({ error: 'Enter your name.' });
    const e = String((req.user && req.user.email) || '').toLowerCase();
    const row = db.prepare('SELECT id FROM admin_users WHERE lower(email)=?').get(e);
    if (row) db.prepare('UPDATE admin_users SET name=? WHERE id=?').run(name, row.id);
    if (e === String(adminEmail || '').toLowerCase()) { db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)'); db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('owner_name',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(name, new Date().toISOString()); }
    logAction(req, 'updated display name', 'account', row ? row.id : 0, name); res.json({ ok: true, name });
  });
  // Lead review: every lead can be marked real or fake, and many can be archived or restored at once (each change is audited).
  if (!db.prepare('PRAGMA table_info(leads)').all().some(x => x.name === 'review')) db.exec("ALTER TABLE leads ADD COLUMN review TEXT NOT NULL DEFAULT 'unreviewed'");
  const LEAD_BULK = {
    real: "review='real'",
    fake: "review='fake', status='Archived'",
    archive: "status='Archived'",
    restore: "status='New', stage=CASE WHEN follow_up_date IS NOT NULL AND follow_up_date<>'' THEN 'followup' ELSE 'new' END",
    unreviewed: "review='unreviewed'"
  };
  app.post('/api/admin/leads/bulk', auth, (req, res) => {
    if (!['owner', 'manager', 'staff', 'sales'].includes(roleOf(req.user && req.user.email))) return res.status(403).json({ error: 'Your role cannot review leads.' });
    const b = req.body || {};
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
    if (!ids.length) return res.status(400).json({ error: 'Select at least one lead.' });
    const set = LEAD_BULK[String(b.action || '')];
    if (!set) return res.status(400).json({ error: 'Choose what to do: real, fake, archive, restore or unreviewed.' });
    const stmt = db.prepare(`UPDATE leads SET ${set} WHERE id=?`);
    db.transaction(() => ids.forEach(id => stmt.run(id)))();
    if (b.action !== 'restore') ids.forEach(id => { if (app.locals.recomputeLeadStage) app.locals.recomputeLeadStage(id); });
    logAction(req, 'bulk lead review: ' + b.action, 'lead', 0, `${ids.length} lead(s): ${ids.slice(0, 50).join(', ')}`);
    res.json({ ok: true, changed: ids.length });
  });
  // Names and roles of the people who sign in (for showing who did or was assigned what). No passwords.
  app.get('/api/admin/people', auth, (req, res) => {
    const R = require('./roles');
    const rows = db.prepare('SELECT email,name,role FROM admin_users').all().filter(r => !adminEmail || r.email.toLowerCase() !== String(adminEmail).toLowerCase());
    const people = [];
    if (adminEmail) people.push({ email: adminEmail, name: ownerName(), role: 'owner' });
    for (const r of rows) people.push({ email: r.email, name: r.name || '', role: r.role });
    res.json({ people: people.map(p => ({ ...p, label: (R.ROLES[p.role] || {}).label || p.role })) });
  });
  // Labor assumptions from the business plan (planning values). Stored in settings. The estimator keeps using per-scope
  // labor rates until these are wired in as a separate, previewed change.
  const LABOR_DEFAULTS = { base_wage_per_hour: 20, payroll_burden_pct: 20, loaded_paid_hour_cost: 24, productive_utilization_pct: 80, productive_labor_hour_cost: 30, target_contribution_margin_pct: 30 };
  const laborGet = () => { try { const r = db.prepare("SELECT value FROM settings WHERE key='labor_assumptions'").get(); return { ...LABOR_DEFAULTS, ...(r ? JSON.parse(r.value) : {}) }; } catch { return { ...LABOR_DEFAULTS }; } };
  app.get('/api/admin/labor-assumptions', auth, (req, res) => res.json({ labor: laborGet(), defaults: LABOR_DEFAULTS, can_change: ['owner', 'manager'].includes(roleOf(req.user && req.user.email)) }));
  app.put('/api/admin/labor-assumptions', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req.user && req.user.email))) return res.status(403).json({ error: 'Only an owner or manager can change labor assumptions.' });
    const b = req.body || {}, next = laborGet();
    for (const k of Object.keys(LABOR_DEFAULTS)) {
      if (b[k] === undefined) continue;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < 0 || v > 1000) return res.status(400).json({ error: `${k.replace(/_/g, ' ')} must be a number from 0 to 1000.` });
      next[k] = v;
    }
    db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('labor_assumptions',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(JSON.stringify(next), new Date().toISOString());
    logAction(req, 'changed labor assumptions', 'settings', 0, JSON.stringify(next).slice(0, 400));
    res.json({ ok: true, labor: next });
  });
  app.get('/api/admin/roles', auth, (req, res) => res.json({ roles: Object.entries(require('./roles').ROLES).map(([key, v]) => ({ key, ...v })) }));

  app.post('/api/admin/account/password', auth, async (req, res) => {
    const email = req.user && req.user.email;
    const { current = '', next = '' } = req.body || {};
    if (String(next).length < 14) return res.status(400).json({ error: 'New password must be at least 14 characters.' });
    const row = db.prepare('SELECT * FROM admin_users WHERE email=?').get(email);
    const currentHash = row ? row.password_hash : (email === adminEmail ? adminHash : '');
    if (!currentHash || !(await bcrypt.compare(String(current), currentHash))) return res.status(400).json({ error: 'Current password is incorrect.' });
    const hash = await bcrypt.hash(String(next), 12);
    if (row) db.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(hash, row.id);
    else db.prepare('INSERT INTO admin_users(email,name,password_hash,created_at) VALUES(?,?,?,?)').run(email, 'Owner', hash, new Date().toISOString());
    logAction(req, 'changed password', 'account', row ? row.id : 0);
    ctx.bumpTv(email); // every other session ends now; this device gets a fresh token
    res.json({ ok: true, token: ctx.signToken(email, req.user && req.user.mfa === true), message: 'Password changed. Other devices have been signed out.' });
  });
  app.post('/api/admin/account/sign-out-everywhere', auth, (req, res) => {
    const email = req.user && req.user.email; ctx.bumpTv(email);
    logAction(req, 'signed out other sessions', 'account', 0);
    res.json({ ok: true, token: ctx.signToken(email, req.user && req.user.mfa === true), message: 'All other devices are signed out.' });
  });

  // Roles: owner (approves, manages roles and rules), manager (approves proposals), staff (prepares, requests approval).
  if (!db.prepare('PRAGMA table_info(admin_users)').all().some(c => c.name === 'role')) db.exec("ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'staff'");
  const roleOf = email => { const e = String(email || '').toLowerCase(); if (adminEmail && e === adminEmail.toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return r ? r.role : 'staff'; };
  app.get('/api/admin/users', auth, (req, res) => {
    const rows = db.prepare('SELECT id,email,name,role,created_at,last_login_at FROM admin_users ORDER BY id').all();
    const envListed = adminEmail && !rows.some(r => r.email === adminEmail);
    res.json({ me: { email: req.user && req.user.email, role: roleOf(req.user && req.user.email) }, can_manage_roles: roleOf(req.user && req.user.email) === 'owner',
      users: [...(envListed ? [{ id: 0, email: adminEmail, name: ownerName(), role: 'owner', env_owner: true, created_at: '', last_login_at: '', owner: true }] : []), ...rows.map(r => ({ ...r, role: r.email === adminEmail ? 'owner' : r.role, env_owner: r.email === adminEmail, owner: r.email === adminEmail }))] });
  });
  app.patch('/api/admin/users/:id/role', auth, (req, res) => {
    if (roleOf(req.user && req.user.email) !== 'owner') return res.status(403).json({ error: 'Only an owner can change roles.' });
    const role = String((req.body || {}).role || ''); if (!require('./roles').isRole(role)) return res.status(400).json({ error: 'Choose a valid role: owner, manager, supervisor, inspector, sales or staff.' });
    const u = db.prepare('SELECT * FROM admin_users WHERE id=?').get(Number(req.params.id)); if (!u) return res.status(404).json({ error: 'User not found.' });
    if (u.email === adminEmail) return res.status(400).json({ error: 'The main owner account is always an owner.' });
    db.prepare('UPDATE admin_users SET role=? WHERE id=?').run(role, u.id);
    logAction(req, 'changed role', 'user', u.id, `${u.email}: ${u.role} → ${role}`);
    res.json({ ok: true });
  });

  app.post('/api/admin/users', auth, async (req, res) => {
    const email = clean(req.body.email, 254).toLowerCase();
    const name = clean(req.body.name, 120);
    const password = String(req.body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 14) return res.status(400).json({ error: 'Temporary password must be at least 14 characters.' });
    if (email === adminEmail || db.prepare('SELECT id FROM admin_users WHERE email=?').get(email)) return res.status(409).json({ error: 'That email already has access.' });
    const newRole = String((req.body || {}).role || 'staff'); if (!require('./roles').isRole(newRole) || newRole === 'owner') return res.status(400).json({ error: 'Choose a role: manager, supervisor, inspector, sales or staff (owners are set by changing a role).' });
    const r = db.prepare('INSERT INTO admin_users(email,name,password_hash,created_at,role) VALUES(?,?,?,?,?)').run(email, name, await bcrypt.hash(password, 12), new Date().toISOString(), newRole);
    logAction(req, 'added user', 'account', r.lastInsertRowid, email);
    res.status(201).json({ id: r.lastInsertRowid });
  });

  app.delete('/api/admin/users/:id', auth, (req, res) => {
    const row = db.prepare('SELECT * FROM admin_users WHERE id=?').get(id(req));
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.email === adminEmail) return res.status(409).json({ error: 'The owner account can’t be removed.' });
    if (req.user && row.email === req.user.email) return res.status(409).json({ error: 'You can’t remove your own access.' });
    db.prepare('DELETE FROM admin_users WHERE id=?').run(row.id);
    logAction(req, 'removed user', 'account', row.id, row.email);
    res.json({ ok: true });
  });
};
