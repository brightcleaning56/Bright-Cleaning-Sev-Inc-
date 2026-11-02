// Admin back-office routes added in the admin upgrade.
// Mounted from server.js before the static and 404 handlers.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function mountAdminExt(app, ctx) {
  const { db, auth, logAction, clean, num, required, estimateMath, uploadDir, bcrypt, adminEmail, adminHash } = ctx;
  const today = () => new Date().toISOString().slice(0, 10);
  const id = req => Number(req.params.id);

  // ---------- Dashboard ----------
  app.get('/api/admin/dashboard', auth, (req, res) => {
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const in14 = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const leadCounts = db.prepare(`SELECT kind, COUNT(*) n, SUM(status='New') fresh, SUM(created_at>=?) week FROM leads GROUP BY kind`).all(weekAgo);
    const fin = db.prepare(`SELECT COALESCE(SUM(amount),0) billed, COALESCE(SUM(paid_amount),0) collected FROM invoices WHERE status<>'Void'`).get();
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
    const b = req.body || {};
    const e = db.prepare('SELECT * FROM estimates WHERE id=?').get(id(req));
    if (!e) return res.status(404).json({ error: 'Not found' });
    if (['Approved'].includes(e.status)) return res.status(409).json({ error: 'This proposal was approved by the customer. Duplicate it to make changes.' });
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
    const paid = Math.round((Number(inv.paid_amount || 0) + amt) * 100) / 100;
    const status = paid >= Number(inv.amount || 0) ? 'Paid' : 'Partially Paid';
    db.prepare('UPDATE invoices SET paid_amount=?,status=? WHERE id=?').run(paid, status, inv.id);
    // Dated payment record (feeds "collected this month" on the Command Center).
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.received_on || '')) && req.body.received_on <= new Date().toISOString().slice(0, 10) ? req.body.received_on : null;
    const nowIso = new Date().toISOString();
    db.prepare('INSERT INTO payments(invoice_id,amount,note,received_at,recorded_by,created_at) VALUES(?,?,?,?,?,?)')
      .run(inv.id, amt, clean(req.body.note || '', 300), day ? day + 'T12:00:00.000Z' : nowIso, (req.user && req.user.email) || null, nowIso);
    logAction(req, 'recorded payment', 'invoice', inv.id, `$${amt.toFixed(2)}${req.body.note ? ' — ' + clean(req.body.note, 300) : ''}`);
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
  app.get('/api/admin/me', auth, (req, res) => res.json({ email: req.user && req.user.email }));

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
    res.json({ ok: true, message: 'Password changed. Use the new password next time you sign in.' });
  });

  app.get('/api/admin/users', auth, (req, res) => {
    const rows = db.prepare('SELECT id,email,name,created_at,last_login_at FROM admin_users ORDER BY id').all();
    const envListed = adminEmail && !rows.some(r => r.email === adminEmail);
    res.json({ users: [...(envListed ? [{ id: 0, email: adminEmail, name: 'Owner', created_at: '', last_login_at: '', owner: true }] : []), ...rows.map(r => ({ ...r, owner: r.email === adminEmail }))] });
  });

  app.post('/api/admin/users', auth, async (req, res) => {
    const email = clean(req.body.email, 254).toLowerCase();
    const name = clean(req.body.name, 120);
    const password = String(req.body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 14) return res.status(400).json({ error: 'Temporary password must be at least 14 characters.' });
    if (email === adminEmail || db.prepare('SELECT id FROM admin_users WHERE email=?').get(email)) return res.status(409).json({ error: 'That email already has access.' });
    const r = db.prepare('INSERT INTO admin_users(email,name,password_hash,created_at) VALUES(?,?,?,?)').run(email, name, await bcrypt.hash(password, 12), new Date().toISOString());
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
