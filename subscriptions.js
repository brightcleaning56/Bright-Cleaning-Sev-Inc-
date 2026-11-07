// Recurring service subscriptions (residential and apartment monthly plans; office monthly contracts).
// A subscription is a monthly price for an ongoing service. The monthly billing run creates ONE draft invoice per active
// subscription per month. Drafts are reviewed and sent from Invoices, so nothing reaches a customer without a person.
// Owners and managers manage subscriptions and run billing; every change is logged.
module.exports = function mountSubscriptions(app, ctx) {
  const { db, auth, logAction, clean, adminEmail } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS subscriptions(
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, customer_name TEXT NOT NULL, company TEXT, email TEXT,
    project_id INTEGER, service TEXT, frequency TEXT NOT NULL DEFAULT 'Monthly', monthly_amount REAL NOT NULL,
    start_date TEXT NOT NULL, end_date TEXT, status TEXT NOT NULL DEFAULT 'Active', notes TEXT,
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT)`);
  const icols = db.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
  for (const [c, t] of [['subscription_id', 'INTEGER'], ['billing_period', 'TEXT']])
    if (!icols.includes(c)) db.exec(`ALTER TABLE invoices ADD COLUMN ${c} ${t}`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS invoices_subscription_period ON invoices(subscription_id, billing_period) WHERE subscription_id IS NOT NULL');

  const now = () => new Date().toISOString(), today = () => require('./bizdate').today();
  const who = req => (req.user && req.user.email) || null;
  const roleOf = req => { const e = String(who(req) || '').toLowerCase(); if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  const canBill = req => ['owner', 'manager'].includes(roleOf(req));
  const FREQ = ['Monthly', 'Biweekly', 'Weekly'];
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
  const isPeriod = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
  const periodOf = d => d.slice(0, 7);
  const lastDay = p => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const nextInvoiceNumber = () => {
    const y = new Date().getFullYear();
    const mx = db.prepare('SELECT invoice_number FROM invoices WHERE invoice_number LIKE ?').all(`BC-${y}-%`).reduce((m, r) => Math.max(m, Number(String(r.invoice_number).split('-')[2]) || 0), 0);
    return `BC-${y}-${String(mx + 1).padStart(4, '0')}`;
  };

  app.get('/api/admin/subscriptions', auth, (req, res) => {
    if (!canBill(req)) return res.status(403).json({ error: 'Only an owner or manager can see subscriptions.' });
    res.json({ subscriptions: db.prepare('SELECT * FROM subscriptions ORDER BY status, customer_name').all() });
  });

  app.post('/api/admin/subscriptions', auth, (req, res) => {
    if (!canBill(req)) return res.status(403).json({ error: 'Only an owner or manager can set up a subscription.' });
    const b = req.body || {};
    const name = clean(b.customer_name, 200), amount = Number(b.monthly_amount), frequency = FREQ.includes(b.frequency) ? b.frequency : 'Monthly';
    if (!name) return res.status(400).json({ error: 'Enter the customer name.' });
    if (!(amount > 0)) return res.status(400).json({ error: 'Enter the monthly price.' });
    if (!isDate(b.start_date)) return res.status(400).json({ error: 'Enter the start date.' });
    if (b.end_date && (!isDate(b.end_date) || b.end_date < b.start_date)) return res.status(400).json({ error: 'The end date must be a date after the start date.' });
    const t = now();
    const id = db.prepare(`INSERT INTO subscriptions(customer_id,customer_name,company,email,project_id,service,frequency,monthly_amount,start_date,end_date,status,notes,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?, 'Active', ?,?,?,?)`).run(
      Number(b.customer_id) || null, name, clean(b.company, 200), clean(b.email, 254), Number(b.project_id) || null, clean(b.service, 120), frequency,
      amount, b.start_date, b.end_date || null, clean(b.notes, 2000), who(req), t, t).lastInsertRowid;
    logAction(req, 'created', 'subscription', id, `${name}: ${amount}/${frequency.toLowerCase()} from ${b.start_date}`);
    res.status(201).json({ id });
  });

  app.patch('/api/admin/subscriptions/:id', auth, (req, res) => {
    if (!canBill(req)) return res.status(403).json({ error: 'Only an owner or manager can change a subscription.' });
    const s = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(Number(req.params.id));
    if (!s) return res.status(404).json({ error: 'Subscription not found.' });
    const b = req.body || {}, set = {};
    if ('status' in b) {
      if (!['Active', 'Paused', 'Cancelled'].includes(b.status)) return res.status(400).json({ error: 'Status must be Active, Paused or Cancelled.' });
      if (s.status === 'Cancelled' && b.status !== 'Cancelled') return res.status(409).json({ error: 'A cancelled subscription cannot be restarted. Create a new one.' });
      set.status = b.status;
    }
    if ('monthly_amount' in b) { const v = Number(b.monthly_amount); if (!(v > 0)) return res.status(400).json({ error: 'Enter the monthly price.' }); set.monthly_amount = v; }
    if ('end_date' in b) { if (b.end_date && (!isDate(b.end_date) || b.end_date < s.start_date)) return res.status(400).json({ error: 'The end date must be a date after the start date.' }); set.end_date = b.end_date || null; }
    if ('notes' in b) set.notes = clean(b.notes, 2000);
    const keys = Object.keys(set);
    if (!keys.length) return res.json({ ok: true });
    db.prepare(`UPDATE subscriptions SET ${keys.map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`).run(...keys.map(k => set[k]), now(), s.id);
    logAction(req, 'updated', 'subscription', s.id, keys.map(k => `${k}=${set[k]}`).join(', '));
    res.json({ ok: true });
  });

  // Monthly billing run: one DRAFT invoice per active subscription that covers the month, never twice for the same month.
  app.post('/api/admin/subscriptions/bill-run', auth, (req, res) => {
    if (!canBill(req)) return res.status(403).json({ error: 'Only an owner or manager can run billing.' });
    const period = String((req.body || {}).period || periodOf(today()));
    if (!isPeriod(period)) return res.status(400).json({ error: 'Choose the month as YYYY-MM.' });
    const start = `${period}-01`, end = lastDay(period), due = `${period}-15`;
    const subs = db.prepare(`SELECT * FROM subscriptions WHERE status='Active' AND start_date<=? AND (end_date IS NULL OR end_date>=?) ORDER BY id`).all(end, start);
    const created = [], skipped = [];
    db.transaction(() => {
      for (const s of subs) {
        const exists = db.prepare('SELECT id, invoice_number FROM invoices WHERE subscription_id=? AND billing_period=?').get(s.id, period);
        if (exists) { skipped.push({ subscription_id: s.id, customer: s.customer_name, reason: `already billed for ${period} (${exists.invoice_number})` }); continue; }
        const number = nextInvoiceNumber();
        const id = db.prepare(`INSERT INTO invoices(project_id,customer_name,company,email,invoice_number,amount,due_date,status,paid_amount,subscription_id,billing_period,created_at,terms)
          VALUES(?,?,?,?,?,?,?,'Draft',0,?,?,?,?)`).run(s.project_id, s.customer_name, s.company, s.email, number, s.monthly_amount, due, s.id, period, now(), `${s.service || 'Cleaning service'} · ${s.frequency} · ${period}`).lastInsertRowid;
        created.push({ subscription_id: s.id, invoice_id: id, invoice_number: number, customer: s.customer_name, amount: s.monthly_amount });
      }
    })();
    logAction(req, 'ran billing', 'subscription', 0, `${period}: ${created.length} drafted, ${skipped.length} skipped`);
    res.json({ period, created, skipped });
  });
};
