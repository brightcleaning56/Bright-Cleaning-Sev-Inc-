// Expenses and payroll costs posted to Bright Clean's ledger (Phase 5 of the accounting plan).
// - Vendor bills: recognised on the bill date (Dr expense / Cr accounts payable). Paying a bill: Dr payable / Cr cash.
// - Recorded project costs (materials, equipment, subcontractors, travel, other): Dr expense / Cr accounts payable.
//   Recorded project labor: Dr job labor / Cr accrued payroll.
// - Approved time not tied to a job: Dr payroll not assigned to a job / Cr accrued payroll.
// Each source posts once (keyed by its id); running the sync again posts nothing new.
// Known gaps, shown in the drift check: labor burden and overtime are not added; payroll cash payments are not recorded yet
// (the ADP file is not connected); a project cost that changes after it posted is flagged, not re-posted.

const L = require('./ledger');
const { accountFor } = require('./job-cost');
const LB = require('./labor');

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS expense_bills(
    id INTEGER PRIMARY KEY AUTOINCREMENT, vendor TEXT NOT NULL, description TEXT, category TEXT,
    amount REAL NOT NULL, bill_date TEXT NOT NULL, project_id INTEGER, status TEXT NOT NULL DEFAULT 'Open',
    paid_at TEXT, created_by TEXT, created_at TEXT NOT NULL)`);
  // Receipts and approvals (audit G11). Added on first use; switched on by settings (both off by default).
  const cols = db.prepare('PRAGMA table_info(expense_bills)').all().map(c => c.name);
  for (const [c, t] of [['receipt_ref', 'TEXT'], ['approved_by', 'TEXT'], ['approved_at', 'TEXT'], ['receipt_file', 'TEXT']]) if (!cols.includes(c)) db.exec(`ALTER TABLE expense_bills ADD COLUMN ${c} ${t}`);
}
// Settings that make approval and a receipt required before a bill is paid. Both are off until the owner turns them on.
function billRule(db, key) {
  try { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return !!r && r.value === '1'; } catch { return false; }
}
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const postedEntry = (db, source, ref) => db.prepare('SELECT id FROM ledger_entries WHERE source=? AND source_ref=? AND reverses_id IS NULL').get(source, ref);
// Each approved time entry keeps the pay rate in force when it was approved (labor_rate). Older entries fall back to the employee's rate.
function ensureRateColumn(db) {
  const cols = db.prepare('PRAGMA table_info(time_entries)').all().map(c => c.name);
  if (cols.length && !cols.includes('labor_rate')) db.exec('ALTER TABLE time_entries ADD COLUMN labor_rate REAL');
}
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

function postBill(db, id) {
  const b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(id);
  if (!b || b.status === 'Void' || postedEntry(db, 'bill', 'bill:' + id)) return false;
  const exp = accountFor(b.category || b.description || b.vendor);
  L.postEntry(db, {
    date: b.bill_date, memo: 'Bill from ' + b.vendor + (b.description ? ': ' + b.description : ''), source: 'bill', sourceRef: 'bill:' + id, by: 'expense-sync',
    lines: [{ account: exp.code, debit: b.amount }, { account: '2000', credit: b.amount }]
  });
  return true;
}

function createBill(db, b, by) {
  ensureSchema(db); L.seedChart(db);
  const vendor = String(b.vendor || '').trim();
  const amount = r2(b.amount);
  if (!vendor) throw new Error('A bill needs a vendor.');
  if (!(amount > 0)) throw new Error('A bill needs an amount above zero.');
  if (!isDate(b.bill_date)) throw new Error('A bill needs a real date (YYYY-MM-DD).');
  require('./aging').ensureVendor(db, vendor);
  const id = db.prepare('INSERT INTO expense_bills(vendor,description,category,amount,bill_date,project_id,status,created_by,created_at,receipt_ref) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(vendor.slice(0, 200), String(b.description || '').slice(0, 300), String(b.category || '').slice(0, 80), amount, b.bill_date,
      b.project_id ? Number(b.project_id) : null, 'Open', by || null, new Date().toISOString(), String(b.receipt_ref || '').trim().slice(0, 300) || null).lastInsertRowid;
  postBill(db, id);
  return id;
}

function approveBill(db, id, by) {
  ensureSchema(db);
  const b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(Number(id));
  if (!b) throw new Error('Bill not found.');
  if (b.status === 'Void') throw new Error('A void bill cannot be approved.');
  if (b.approved_by) throw new Error('This bill is already approved.');
  db.prepare('UPDATE expense_bills SET approved_by=?, approved_at=? WHERE id=?').run(by || 'owner', new Date().toISOString(), b.id);
  require('./audit').record(db, { actor: by, action: 'approved bill', entity: 'bill', entityId: b.id, detail: b.vendor + ' ' + Number(b.amount).toFixed(2) });
  return b.id;
}

function payBill(db, id, { date, by } = {}) {
  ensureSchema(db); L.seedChart(db);
  const b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(Number(id));
  if (!b) throw new Error('Bill not found.');
  if (b.status === 'Paid') throw new Error('This bill is already paid.');
  if (b.status === 'Void') throw new Error('A void bill cannot be paid.');
  if (billRule(db, 'bill_receipt_required') && !b.receipt_ref) throw new Error('This bill needs a receipt reference before it is paid.');
  if (billRule(db, 'bill_approval_required') && !b.approved_by) throw new Error('This bill needs approval before it is paid.');
  const d = date || new Date().toISOString().slice(0, 10);
  if (!isDate(d)) throw new Error('Payment date must be a real date.');
  postBill(db, b.id);
  L.postEntry(db, {
    date: d, memo: 'Paid bill ' + b.id + ' to ' + b.vendor, source: 'bill-payment', sourceRef: 'bill-payment:' + b.id, by: by || 'expense-sync',
    lines: [{ account: '2000', debit: b.amount }, { account: '1000', credit: b.amount }]
  });
  db.prepare("UPDATE expense_bills SET status='Paid', paid_at=? WHERE id=?").run(new Date().toISOString(), b.id);
  return b.id;
}

// Posts recorded project costs, bills and approved unassigned time that are not yet on the ledger.
function syncRecorded(db) {
  ensureSchema(db); L.seedChart(db); ensureRateColumn(db); LB.ensureColumns(db);
  const out = { bills_posted: 0, project_costs_posted: 0, payroll_posted: 0, errors: [] };
  for (const b of db.prepare("SELECT id FROM expense_bills WHERE status<>'Void' ORDER BY id").all()) {
    try { if (postBill(db, b.id)) out.bills_posted++; } catch (e) { out.errors.push('bill ' + b.id + ': ' + e.message); }
  }
  if (hasTable(db, 'project_costs')) {
    for (const c of db.prepare('SELECT * FROM project_costs ORDER BY id').all()) {
      const ref = 'project-cost:' + c.id;
      if (postedEntry(db, 'project-cost', ref) || !(Number(c.amount) > 0)) continue;
      const isLabor = /labou?r|crew|wage|payroll/i.test(String(c.category || ''));
      const exp = accountFor(c.category);
      const date = String(c.cost_date || c.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
      try {
        L.postEntry(db, {
          date, memo: 'Job cost: ' + (c.description || c.category) + ' (project ' + c.project_id + ')', source: 'project-cost', sourceRef: ref, by: 'expense-sync',
          lines: [{ account: exp.code, debit: r2(c.amount) }, { account: isLabor ? '2300' : '2000', credit: r2(c.amount) }]
        });
        out.project_costs_posted++;
      } catch (e) { out.errors.push('project cost ' + c.id + ': ' + e.message); }
    }
  }
  if (hasTable(db, 'time_entries') && hasTable(db, 'employees')) {
    const rows = db.prepare('SELECT t.*, COALESCE(t.labor_rate, e.hourly_rate) AS hourly_rate FROM time_entries t JOIN employees e ON e.id=t.employee_id WHERE t.approved_by IS NOT NULL AND t.cost_id IS NULL AND t.project_id IS NULL AND t.clock_in IS NOT NULL ORDER BY t.id').all();
    for (const t of rows) {
      const ref = 'time:' + t.id;
      const amount = r2(LB.storedCost(t));
      if (postedEntry(db, 'payroll', ref) || !(amount > 0)) continue;
      try {
        L.postEntry(db, {
          date: String(t.clock_in).slice(0, 10), memo: 'Approved time not assigned to a job (time ' + t.id + ')', source: 'payroll', sourceRef: ref, by: 'expense-sync',
          lines: [{ account: '6100', debit: amount }, { account: '2300', credit: amount }]
        });
        out.payroll_posted++;
      } catch (e) { out.errors.push('time ' + t.id + ': ' + e.message); }
    }
  }
  out.burden_posted = syncBurden(db);
  return out;
}

// Labor burden (payroll taxes, insurance, benefits) is optional. The rate is the setting ledger_burden_pct (a percentage), zero by default.
// When set, burden posts once for each posted labor line: job labor (Dr 5000) and unassigned payroll (Dr 6100), both credit accrued payroll.
function burdenPct(db) {
  try { const r = db.prepare("SELECT value FROM settings WHERE key='ledger_burden_pct'").get(); const v = Number(r && r.value); return v > 0 && v <= 100 ? v : 0; }
  catch { return 0; }
}
function syncBurden(db) {
  const pct = burdenPct(db);
  if (!pct) return 0;
  ensureRateColumn(db); LB.ensureColumns(db);
  let n = 0;
  const post = (ref, base, date, memo, account) => {
    const amt = r2(base * pct / 100);
    if (!(amt > 0) || postedEntry(db, 'burden', ref)) return;
    L.postEntry(db, { date, memo, source: 'burden', sourceRef: ref, by: 'expense-sync', lines: [{ account, debit: amt }, { account: '2300', credit: amt }] });
    n++;
  };
  if (hasTable(db, 'project_costs')) {
    for (const c of db.prepare('SELECT * FROM project_costs ORDER BY id').all()) {
      if (!/labou?r|crew|wage|payroll/i.test(String(c.category || ''))) continue;
      if (!postedEntry(db, 'project-cost', 'project-cost:' + c.id)) continue;
      post('burden:project-cost:' + c.id, Number(c.amount) || 0, String(c.cost_date || c.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10), 'Labor burden on job cost ' + c.id, '5000');
    }
  }
  if (hasTable(db, 'time_entries') && hasTable(db, 'employees')) {
    for (const t of db.prepare('SELECT t.*, COALESCE(t.labor_rate, e.hourly_rate) AS hourly_rate FROM time_entries t JOIN employees e ON e.id=t.employee_id WHERE t.approved_by IS NOT NULL AND t.cost_id IS NULL AND t.project_id IS NULL AND t.clock_in IS NOT NULL ORDER BY t.id').all()) {
      if (!postedEntry(db, 'payroll', 'time:' + t.id)) continue;
      const base = LB.storedCost(t);
      post('burden:time:' + t.id, base, String(t.clock_in).slice(0, 10), 'Labor burden on unassigned time ' + t.id, '6100');
    }
  }
  return n;
}

// Payroll payments (audit G2). Until the ADP link exists, the owner records what was paid out.
//  - Net pay paid to employees: Dr 2300 accrued payroll / Cr 1000 cash.
//  - Payroll taxes remitted: Dr 2400 payroll taxes payable / Cr 1000 cash.
// Each payment is an entry of its own; it cannot be edited (reverse it instead).
function recordPayrollPayment(db, { kind, amount, date, memo, by }) {
  ensureSchema(db); L.seedChart(db);
  const amt = r2(amount);
  if (!(amt > 0)) throw new Error('A payroll payment needs an amount above zero.');
  if (!isDate(date)) throw new Error('A payroll payment needs a real date (YYYY-MM-DD).');
  if (!String(memo || '').trim()) throw new Error('Describe the payroll payment (for example the pay period).');
  const k = kind === 'taxes' ? 'taxes' : kind === 'net' ? 'net' : null;
  if (!k) throw new Error('Choose net pay or payroll taxes.');
  const debit = k === 'taxes' ? '2400' : '2300';
  return L.postEntry(db, { date, memo: (k === 'taxes' ? 'Payroll taxes remitted: ' : 'Net pay paid: ') + String(memo).trim().slice(0, 200), source: 'payroll-payment', sourceRef: 'payroll-payment:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8), by: by || 'payroll',
    lines: [{ account: debit, debit: amt }, { account: '1000', credit: amt }] });
}

// Recorded costs that changed or disappeared after they posted. Shown for review, never silently re-posted.
function costDrift(db) {
  const drift = [];
  if (!hasTable(db, 'project_costs')) return drift;
  const posted = db.prepare("SELECT e.source_ref, SUM(l.debit_cents) d FROM ledger_entries e JOIN ledger_lines l ON l.entry_id=e.id WHERE e.source='project-cost' AND e.reverses_id IS NULL GROUP BY e.id").all();
  for (const p of posted) {
    const id = Number(String(p.source_ref).split(':')[1]);
    const c = db.prepare('SELECT amount FROM project_costs WHERE id=?').get(id);
    if (!c) drift.push({ ref: p.source_ref, issue: 'The cost was deleted after it posted to the ledger.' });
    else if (Math.round(c.amount * 100) !== p.d) drift.push({ ref: p.source_ref, issue: 'The cost changed after it posted (ledger ' + (p.d / 100).toFixed(2) + ', now ' + r2(c.amount).toFixed(2) + ').' });
  }
  return drift;
}

// Receipt files for bills (audit G11). The file is stored by the upload guard (virus check and type check) under a random name.
// The bill keeps the original name as its receipt reference. Only owners and managers can attach or download.
function attachReceipt(db, { billId, file, by, uploadDir }) {
  ensureSchema(db);
  const b = db.prepare('SELECT id, vendor, amount FROM expense_bills WHERE id=?').get(Number(billId));
  if (!b) throw new Error('Bill not found.');
  if (!file || !file.filename) throw new Error('Choose a receipt file.');
  const name = String(file.originalname || file.filename).slice(0, 300);
  db.prepare("UPDATE expense_bills SET receipt_file=?, receipt_ref=COALESCE(NULLIF(receipt_ref,''), ?) WHERE id=?").run(file.filename, name, b.id);
  require('./audit').record(db, { actor: by, action: 'attached receipt', entity: 'bill', entityId: b.id, detail: name });
  return { id: b.id, receipt: name };
}

function receiptPath(db, billId, uploadDir) {
  ensureSchema(db);
  const b = db.prepare('SELECT receipt_file, receipt_ref FROM expense_bills WHERE id=?').get(Number(billId));
  if (!b || !b.receipt_file) return null;
  const path = require('path'), fs = require('fs');
  const p = path.join(uploadDir, path.basename(b.receipt_file));
  if (!fs.existsSync(p)) return null;
  return { path: p, name: b.receipt_ref || b.receipt_file };
}

function mount(app, ctx) {
  const { db, auth, upload, uploadDir } = ctx;
  ensureSchema(db);
  app.post('/api/admin/expenses/:id/receipt', auth, ...(upload ? upload.single('receipt') : []), (req, res) => {
    try { res.status(201).json({ ok: true, ...attachReceipt(db, { billId: req.params.id, file: req.file, by: req.user && req.user.email, uploadDir }) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/admin/expenses/:id/receipt', auth, (req, res) => {
    const r = receiptPath(db, req.params.id, uploadDir);
    if (!r) return res.status(404).json({ error: 'No receipt is attached to this bill.' });
    res.download(r.path, r.name);
  });
  app.get('/api/admin/expenses', auth, (req, res) => res.json({ bills: db.prepare('SELECT * FROM expense_bills ORDER BY id DESC LIMIT 300').all() }));
  app.post('/api/admin/expenses', auth, (req, res) => {
    try { const id = createBill(db, req.body || {}, req.user && req.user.email); res.status(201).json({ ok: true, id }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/expenses/:id/approve', auth, (req, res) => {
    try { approveBill(db, req.params.id, req.user && req.user.email); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/expenses/:id/pay', auth, (req, res) => {
    try { payBill(db, req.params.id, { date: (req.body || {}).date, by: req.user && req.user.email }); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/admin/ledger/cost-drift', auth, (req, res) => res.json({ drift: costDrift(db) }));
  app.post('/api/admin/ledger/payroll-payment', auth, (req, res) => {
    try { const b = req.body || {}; const id = recordPayrollPayment(db, { kind: b.kind, amount: b.amount, date: b.date, memo: b.memo, by: req.user && req.user.email }); res.status(201).json({ ok: true, entry: id }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { ensureSchema, createBill, approveBill, payBill, syncRecorded, costDrift, recordPayrollPayment, attachReceipt, receiptPath, burdenPct, mount };
