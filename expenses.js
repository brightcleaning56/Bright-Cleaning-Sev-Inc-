// Expenses and payroll costs posted to Bright Clean's ledger (Phase 5 of the accounting plan).
// - Vendor bills: on the books once approved, dated the bill date (Dr expense / Cr accounts payable). Unapproved bills are not posted. Paying a bill: Dr payable / Cr cash.
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
  for (const [c, t] of [['receipt_ref', 'TEXT'], ['approved_by', 'TEXT'], ['approved_at', 'TEXT'], ['receipt_file', 'TEXT'], ['void_reason', 'TEXT'], ['void_by', 'TEXT'], ['void_at', 'TEXT'], ['source', 'TEXT']]) if (!cols.includes(c)) db.exec(`ALTER TABLE expense_bills ADD COLUMN ${c} ${t}`);
  db.exec(`CREATE TABLE IF NOT EXISTS expense_bill_splits(id INTEGER PRIMARY KEY AUTOINCREMENT, bill_id INTEGER NOT NULL, project_id INTEGER, category TEXT, amount REAL NOT NULL, created_at TEXT NOT NULL)`);
  if (hasTable(db, 'project_costs') && !db.prepare('PRAGMA table_info(project_costs)').all().some(c => c.name === 'source_bill_id')) db.exec('ALTER TABLE project_costs ADD COLUMN source_bill_id INTEGER');
}
// Settings that make approval and a receipt required before a bill is paid. Both are off until the owner turns them on.
function billRule(db, key) {
  try { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return !!r && r.value === '1'; } catch { return false; }
}
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const postedEntry = (db, source, ref) => db.prepare('SELECT id FROM ledger_entries WHERE source=? AND source_ref=? AND reverses_id IS NULL').get(source, ref);
// A bill's entry that has not been reversed. A reversed bill can be posted again (after an edit).
const activeEntry = (db, source, ref) => db.prepare(`SELECT e.id FROM ledger_entries e WHERE e.source=? AND e.source_ref=? AND e.reverses_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_id=e.id)`).get(source, ref);
const bizdate = require('./bizdate');
// Each approved time entry keeps the pay rate in force when it was approved (labor_rate). Older entries fall back to the employee's rate.
function ensureRateColumn(db) {
  const cols = db.prepare('PRAGMA table_info(time_entries)').all().map(c => c.name);
  if (cols.length && !cols.includes('labor_rate')) db.exec('ALTER TABLE time_entries ADD COLUMN labor_rate REAL');
}
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

// A bill on a job is also a job cost (the job-cost view reads recorded costs). One row per bill, kept in step with the bill:
// present while the bill is approved, on a job, and not void; removed otherwise. The ledger posts it once, from the bill.
function syncJobCost(db, id) {
  if (!hasTable(db, 'project_costs')) return;
  ensureSchema(db);
  const b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(Number(id));
  db.prepare('DELETE FROM project_costs WHERE source_bill_id=?').run(Number(id));
  if (!(b && b.approved_by && b.status !== 'Void')) return;
  const desc = (b.vendor + (b.description ? ': ' + b.description : '')).slice(0, 300);
  for (const a of allocationsOf(db, b).filter(x => x.project_id)) {
    db.prepare('INSERT INTO project_costs(project_id,category,description,amount,cost_date,entered_by,created_at,source_bill_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(a.project_id, a.category, desc, a.amount, b.bill_date, b.approved_by, new Date().toISOString(), b.id);
  }
}

// Where a bill's money goes: its split lines when it has any, otherwise its single job (or overhead).
function splitRows(db, id) { return hasTable(db, 'expense_bill_splits') ? db.prepare('SELECT * FROM expense_bill_splits WHERE bill_id=? ORDER BY id').all(Number(id)) : []; }
function allocationsOf(db, b) {
  const rows = splitRows(db, b.id);
  const cat = b.category || b.description || b.vendor;
  if (rows.length) return rows.map(r => ({ project_id: r.project_id || null, category: r.category || cat, amount: r2(r.amount) }));
  return [{ project_id: b.project_id || null, category: cat, amount: r2(b.amount) }];
}

function postBill(db, id) {
  const b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(id);
  if (!b || b.status === 'Void' || activeEntry(db, 'bill', 'bill:' + id)) return false;
  // A bill on a job is job cost (by category). A bill with no job is an operating expense (6000), whatever its category.
  const allocs = allocationsOf(db, b);
  L.postEntry(db, {
    date: b.bill_date, memo: 'Bill from ' + b.vendor + (b.description ? ': ' + b.description : ''), source: 'bill', sourceRef: 'bill:' + id, by: 'expense-sync',
    lines: [...allocs.map(a => ({ account: a.project_id ? accountFor(a.category).code : '6000', debit: a.amount })), { account: '2000', credit: r2(allocs.reduce((t, a) => t + a.amount, 0)) }]
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
  // Not on the books until approved: approveBill posts it.
  return id;
}

function approveBill(db, id, by) {
  L.seedChart(db);
  ensureSchema(db);
  const b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(Number(id));
  if (!b) throw new Error('Bill not found.');
  if (b.status === 'Void') throw new Error('A void bill cannot be approved.');
  if (b.approved_by) throw new Error('This bill is already approved.');
  db.prepare('UPDATE expense_bills SET approved_by=?, approved_at=? WHERE id=?').run(by || 'owner', new Date().toISOString(), b.id);
  postBill(db, b.id); // approval is what puts the bill on the books
  syncJobCost(db, b.id);
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
  if (!b.approved_by) throw new Error('Approve this bill before it is paid. Approval puts it on the books.');
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

// Bills that look like an earlier one: same vendor, amount and bill date, or the same receipt reference. Void bills are ignored.
function findDuplicates(db, b) {
  const vendor = String(b.vendor || '').trim().toLowerCase(), amount = r2(b.amount), date = String(b.bill_date || '');
  const ref = String(b.receipt_ref || '').trim();
  return db.prepare(`SELECT id, vendor, amount, bill_date, status FROM expense_bills WHERE status<>'Void'
    AND ((lower(vendor)=? AND ROUND(amount,2)=? AND bill_date=?) OR (?<>'' AND receipt_ref=?)) ORDER BY id DESC LIMIT 5`).all(vendor, amount, date, ref, ref);
}

// Checks the fields of a bill and returns them cleaned. Used for new bills and for edits.
// Splits a bill across jobs and overhead. Each line is a job (by id or exact name) or overhead, with an amount. The lines must add
// up to the bill amount to the cent. Changing the split takes an approved bill off the books until it is approved again.
function setSplits(db, id, rows, by) {
  ensureSchema(db); L.seedChart(db);
  const b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(Number(id));
  if (!b) throw new Error('Bill not found.');
  if (b.status === 'Void') throw new Error('A void bill cannot be changed.');
  if (b.status === 'Paid') throw new Error('A paid bill cannot be changed. Void it and enter it again.');
  const list = Array.isArray(rows) ? rows : [];
  const hasProjects = hasTable(db, 'projects');
  const clean = list.map((r, i) => {
    const amount = r2(r.amount);
    if (!(amount > 0)) throw new Error('Line ' + (i + 1) + ': the amount must be above zero.');
    let project_id = null;
    if (!r.overhead && (r.project_id || String(r.project_name || '').trim())) {
      if (r.project_id) {
        project_id = Number(r.project_id);
        if (hasProjects && !db.prepare('SELECT id FROM projects WHERE id=?').get(project_id)) throw new Error('Line ' + (i + 1) + ': that job does not exist.');
      } else {
        const hits = hasProjects ? db.prepare('SELECT id FROM projects WHERE lower(name)=?').all(String(r.project_name).trim().toLowerCase()) : [];
        if (hits.length !== 1) throw new Error('Line ' + (i + 1) + ': no single job is named "' + String(r.project_name).trim() + '".');
        project_id = hits[0].id;
      }
    }
    return { project_id, category: String(r.category || '').trim().slice(0, 80), amount };
  });
  if (clean.length) {
    const lineCents = clean.reduce((t, r) => t + Math.round(r.amount * 100), 0);
    if (lineCents !== Math.round(r2(b.amount) * 100)) throw new Error('The lines add up to $' + (lineCents / 100).toFixed(2) + ' but the bill is $' + r2(b.amount).toFixed(2) + '. They must match to the cent.');
  }
  db.transaction(() => {
    const posted = activeEntry(db, 'bill', 'bill:' + b.id);
    if (posted) L.reverseEntry(db, posted.id, { reason: 'Bill ' + b.id + ' split changed', by });
    db.prepare('DELETE FROM expense_bill_splits WHERE bill_id=?').run(b.id);
    for (const r of clean) db.prepare('INSERT INTO expense_bill_splits(bill_id,project_id,category,amount,created_at) VALUES(?,?,?,?,?)').run(b.id, r.project_id, r.category || null, r.amount, new Date().toISOString());
    db.prepare('UPDATE expense_bills SET project_id=?, approved_by=NULL, approved_at=NULL WHERE id=?').run(clean.length ? null : b.project_id, b.id);
    syncJobCost(db, b.id);
    require('./audit').record(db, { actor: by, action: 'split bill', entity: 'bill', entityId: b.id, detail: clean.length ? clean.map(r => (r.project_id ? 'job ' + r.project_id : 'overhead') + ' ' + r.amount.toFixed(2)).join('; ') : 'split cleared' });
  })();
  return b.id;
}

function cleanBill(b) {
  const vendor = String(b.vendor || '').trim();
  const amount = r2(b.amount);
  if (!vendor) throw new Error('A bill needs a vendor.');
  if (!(amount > 0)) throw new Error('A bill needs an amount above zero.');
  if (!isDate(b.bill_date)) throw new Error('A bill needs a real date (YYYY-MM-DD).');
  return {
    vendor: vendor.slice(0, 200), amount, bill_date: b.bill_date,
    description: String(b.description || '').slice(0, 300), category: String(b.category || '').slice(0, 80),
    project_id: b.project_id ? Number(b.project_id) : null, receipt_ref: String(b.receipt_ref || '').trim().slice(0, 300) || null
  };
}

// Edits an open bill. The old bill entry is reversed and the bill is posted again with the new figures, in one transaction,
// so the ledger always shows the current bill. A bill that is paid cannot be edited (void it, which reverses the payment).
// Changing the amount, vendor, date, category or job clears the approval, so the change is approved again.
function updateBill(db, id, body, by) {
  ensureSchema(db); L.seedChart(db);
  const b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(Number(id));
  if (!b) throw new Error('Bill not found.');
  if (b.status === 'Void') throw new Error('A void bill cannot be edited.');
  if (b.status === 'Paid') throw new Error('A paid bill cannot be edited. Void it (this reverses the payment) and enter the bill again.');
  const next = cleanBill({
    vendor: body.vendor !== undefined ? body.vendor : b.vendor,
    description: body.description !== undefined ? body.description : b.description,
    category: body.category !== undefined ? body.category : b.category,
    amount: body.amount !== undefined ? body.amount : b.amount,
    bill_date: body.bill_date !== undefined ? body.bill_date : b.bill_date,
    project_id: body.project_id !== undefined ? body.project_id : b.project_id,
    receipt_ref: body.receipt_ref !== undefined ? body.receipt_ref : b.receipt_ref
  });
  const costFields = ['vendor', 'amount', 'bill_date', 'category', 'project_id'];
  const changed = costFields.filter(k => String(next[k] ?? '') !== String(b[k] ?? ''));
  const splitN = splitRows(db, b.id).length;
  if (splitN && changed.includes('amount')) throw new Error('This bill is split across jobs. Change the split so it adds up to the new amount.');
  if (splitN && changed.includes('project_id')) throw new Error('This bill is split across jobs. Change the split instead of the job.');
  const other = ['description', 'receipt_ref'].filter(k => String(next[k] ?? '') !== String(b[k] ?? ''));
  if (!changed.length && !other.length) return b.id;
  require('./aging').ensureVendor(db, next.vendor);
  const summary = [...changed, ...other].map(k => `${k}: ${b[k] ?? ''} -> ${next[k] ?? ''}`).join('; ');
  db.transaction(() => {
    // Only a change to the cost (or the job, category or date) needs the ledger entry redone. A note or receipt reference does not.
    if (changed.length) {
      const posted = activeEntry(db, 'bill', 'bill:' + b.id);
      if (posted) L.reverseEntry(db, posted.id, { reason: 'Bill ' + b.id + ' edited', by });
    }
    db.prepare('UPDATE expense_bills SET vendor=?,description=?,category=?,amount=?,bill_date=?,project_id=?,receipt_ref=?,approved_by=?,approved_at=? WHERE id=?')
      .run(next.vendor, next.description, next.category, next.amount, next.bill_date, next.project_id, next.receipt_ref,
        changed.length ? null : b.approved_by, changed.length ? null : b.approved_at, b.id);
    require('./audit').record(db, { actor: by, action: 'edited bill', entity: 'bill', entityId: b.id, detail: summary.slice(0, 500) });
    // An edited bill is no longer approved, so it stays off the books until it is approved again.
    syncJobCost(db, b.id);
  })();
  return b.id;
}

// Voids a bill. Nothing is deleted: the bill's entry (and its payment entry, if it was paid) is reversed, and the bill
// keeps its history with the reason and who voided it. A void bill cannot be paid, approved or edited.
function voidBill(db, id, { reason, by } = {}) {
  ensureSchema(db); L.seedChart(db);
  const b = db.prepare('SELECT * FROM expense_bills WHERE id=?').get(Number(id));
  if (!b) throw new Error('Bill not found.');
  if (b.status === 'Void') throw new Error('This bill is already void.');
  const why = String(reason || '').trim();
  if (!why) throw new Error('Give a reason for voiding the bill.');
  db.transaction(() => {
    const note = 'Bill ' + b.id + ' voided: ' + why;
    const pay = activeEntry(db, 'bill-payment', 'bill-payment:' + b.id);
    if (pay) L.reverseEntry(db, pay.id, { reason: note, by });
    const bill = activeEntry(db, 'bill', 'bill:' + b.id);
    if (bill) L.reverseEntry(db, bill.id, { reason: note, by });
    db.prepare('UPDATE expense_bills SET status=?, void_reason=?, void_by=?, void_at=? WHERE id=?').run('Void', why.slice(0, 300), by || null, new Date().toISOString(), b.id);
    syncJobCost(db, b.id);
    require('./audit').record(db, { actor: by, action: 'voided bill', entity: 'bill', entityId: b.id, detail: (b.vendor + ' ' + Number(b.amount).toFixed(2) + ': ' + why).slice(0, 500) });
  })();
  return b.id;
}

// Posts recorded project costs, bills and approved unassigned time that are not yet on the ledger.
function syncRecorded(db) {
  ensureSchema(db); L.seedChart(db); ensureRateColumn(db); LB.ensureColumns(db);
  const out = { bills_posted: 0, project_costs_posted: 0, payroll_posted: 0, errors: [] };
  for (const b of db.prepare('SELECT id FROM expense_bills WHERE approved_by IS NOT NULL AND project_id IS NOT NULL').all()) { try { syncJobCost(db, b.id); } catch (e) { out.errors.push('job cost for bill ' + b.id + ': ' + e.message); } }
  for (const b of db.prepare("SELECT id FROM expense_bills WHERE status<>'Void' AND approved_by IS NOT NULL ORDER BY id").all()) {
    try { if (postBill(db, b.id)) out.bills_posted++; } catch (e) { out.errors.push('bill ' + b.id + ': ' + e.message); }
  }
  if (hasTable(db, 'project_costs')) {
    for (const c of db.prepare('SELECT * FROM project_costs ORDER BY id').all()) {
      if (c.source_bill_id) continue; // posted from its bill
      const ref = 'project-cost:' + c.id;
      if (postedEntry(db, 'project-cost', ref) || !(Number(c.amount) > 0)) continue;
      const isLabor = /labou?r|crew|wage|payroll/i.test(String(c.category || ''));
      const exp = accountFor(c.category);
      const date = String(c.cost_date || '').slice(0, 10) || (c.created_at ? bizdate.today(new Date(c.created_at)) : bizdate.today());
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
          date: bizdate.today(new Date(t.clock_in)), memo: 'Approved time not assigned to a job (time ' + t.id + ')', source: 'payroll', sourceRef: ref, by: 'expense-sync',
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
// When set, burden posts once for each posted labor line: job labor (Dr 5000) or unassigned payroll (Dr 6100), credit payroll taxes payable (2400), the account a remittance debits.
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
    L.postEntry(db, { date, memo, source: 'burden', sourceRef: ref, by: 'expense-sync', lines: [{ account, debit: amt }, { account: '2400', credit: amt }] });
    n++;
  };
  if (hasTable(db, 'project_costs')) {
    for (const c of db.prepare('SELECT * FROM project_costs ORDER BY id').all()) {
      if (!/labou?r|crew|wage|payroll/i.test(String(c.category || ''))) continue;
      if (!postedEntry(db, 'project-cost', 'project-cost:' + c.id)) continue;
      post('burden:project-cost:' + c.id, Number(c.amount) || 0, String(c.cost_date || '').slice(0, 10) || (c.created_at ? bizdate.today(new Date(c.created_at)) : bizdate.today()), 'Labor burden on job cost ' + c.id, '5000');
    }
  }
  if (hasTable(db, 'time_entries') && hasTable(db, 'employees')) {
    for (const t of db.prepare('SELECT t.*, COALESCE(t.labor_rate, e.hourly_rate) AS hourly_rate FROM time_entries t JOIN employees e ON e.id=t.employee_id WHERE t.approved_by IS NOT NULL AND t.cost_id IS NULL AND t.project_id IS NULL AND t.clock_in IS NOT NULL ORDER BY t.id').all()) {
      if (!postedEntry(db, 'payroll', 'time:' + t.id)) continue;
      const base = LB.storedCost(t);
      post('burden:time:' + t.id, base, bizdate.today(new Date(t.clock_in)), 'Labor burden on unassigned time ' + t.id, '6100');
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

// Weekly close: the bills in a date range that are not approved yet. Approving posts them; nothing else is posted here.
function closeList(db, q) {
  ensureSchema(db);
  const ok = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const from = ok(q.from) ? q.from : '0000-00-00', to = ok(q.to) ? q.to : '9999-12-31';
  const bills = db.prepare("SELECT * FROM expense_bills WHERE approved_by IS NULL AND status<>'Void' AND bill_date BETWEEN ? AND ? ORDER BY bill_date, id").all(from, to);
  const R = require('./expense-review');
  const withReview = bills.map(b => ({ ...b, review: R.reviewFor(db, b) }));
  return { from, to, count: bills.length, total: r2(bills.reduce((t, b) => t + Number(b.amount || 0), 0)), bills: withReview };
}
// Approves each chosen bill on its own, so one failure does not stop the rest; returns what happened to each.
function approveBatch(db, ids, by) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(n => n > 0))];
  const out = { approved: [], failed: [] };
  for (const id of list) { try { approveBill(db, id, by); out.approved.push(id); } catch (e) { out.failed.push({ id, error: e.message }); } }
  return out;
}

// A receipt a crew member sends from the job (Phase 2). It is an open bill with its photo, the crew member and the job.
// It posts only when the office approves it, like any other bill. The caller checks that the job is assigned to the crew member.
function createCrewReceipt(db, { employee, project_id, vendor, amount, description, category, bill_date }, file) {
  ensureSchema(db);
  const name = String((employee && employee.name) || '').trim().slice(0, 80) || 'Crew member';
  const v = String(vendor || '').trim().slice(0, 120);
  if (!v) throw new Error('Enter the vendor name from the receipt.');
  const amt = r2(amount);
  if (!(amt > 0)) throw new Error('The amount must be above zero.');
  if (!file || !file.filename) throw new Error('Attach a photo or PDF of the receipt.');
  const date = isDate(bill_date) ? bill_date : new Date().toISOString().slice(0, 10);
  const cat = ['materials', 'equipment', 'travel', 'other'].includes(category) ? category : 'materials';
  const pid = project_id ? Number(project_id) : null;
  return db.transaction(() => {
    const id = db.prepare('INSERT INTO expense_bills(vendor,description,category,amount,bill_date,project_id,status,created_by,created_at,receipt_ref,receipt_file,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(v, String(description || '').trim().slice(0, 300) || null, cat, amt, date, pid, 'Open', 'crew: ' + name, new Date().toISOString(),
        String(file.originalname || file.filename).slice(0, 300), file.filename, 'crew').lastInsertRowid;
    require('./audit').record(db, { actor: 'crew: ' + name, action: 'sent receipt', entity: 'bill', entityId: Number(id), detail: v + ' ' + amt.toFixed(2) + (pid ? ' job ' + pid : ' no job') });
    return { id: Number(id) };
  })();
}

// Monthly bills: a template makes one Open bill each month, on its day (1 to 28, so every month has it).
// Nothing is approved here; approval stays in the weekly close. A template never makes the same month twice.
function ensureRecurring(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS recurring_bills(id INTEGER PRIMARY KEY AUTOINCREMENT, vendor TEXT NOT NULL, description TEXT, category TEXT, amount REAL NOT NULL,
    day_of_month INTEGER NOT NULL, project_id INTEGER, active INTEGER NOT NULL DEFAULT 1, last_month TEXT, created_by TEXT, created_at TEXT NOT NULL)`);
}
function createDueRecurring(db, today) {
  ensureSchema(db); ensureRecurring(db);
  const ym = String(today).slice(0, 7), day = Number(String(today).slice(8, 10));
  const made = [];
  for (const t of db.prepare('SELECT * FROM recurring_bills WHERE active=1 ORDER BY id').all()) {
    if (t.last_month === ym || day < t.day_of_month) continue;
    made.push(db.transaction(() => {
      const billId = createBill(db, { vendor: t.vendor, amount: t.amount, bill_date: ym + '-' + String(t.day_of_month).padStart(2, '0'), category: t.category,
        description: 'Monthly: ' + (t.description || ''), project_id: t.project_id, confirm_duplicate: true }, 'monthly bill');
      db.prepare('UPDATE recurring_bills SET last_month=? WHERE id=?').run(ym, t.id);
      return billId;
    })());
  }
  return made;
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
  // Monthly bills: a daily check (and each list load) makes any due bill. A failure is retried on the next check.
  const runMonthly = () => { try { createDueRecurring(db, bizdate.today()); } catch (e) { console.error('monthly bills:', e.message); } };
  setInterval(runMonthly, 60 * 60 * 1000).unref();
  app.get('/api/admin/recurring-bills', auth, (req, res) => { ensureRecurring(db); res.json({ bills: db.prepare('SELECT * FROM recurring_bills ORDER BY id').all() }); });
  app.post('/api/admin/recurring-bills', auth, (req, res) => {
    ensureRecurring(db);
    const b = req.body || {}, vendor = String(b.vendor || '').trim(), amount = r2(b.amount), day = Math.trunc(Number(b.day_of_month));
    if (!vendor) return res.status(400).json({ error: 'A monthly bill needs a vendor.' });
    if (!(amount > 0)) return res.status(400).json({ error: 'The amount must be above zero.' });
    if (!(day >= 1 && day <= 28)) return res.status(400).json({ error: 'Choose a day from 1 to 28, so every month has it.' });
    const today = bizdate.today();
    // Starts with this month if its day has not come yet; otherwise next month. The office can set the month it starts from.
    const startMonth = /^\d{4}-\d{2}$/.test(String(b.last_month || '')) ? b.last_month : (Number(today.slice(8, 10)) >= day ? today.slice(0, 7) : null);
    const info = db.prepare('INSERT INTO recurring_bills(vendor,description,category,amount,day_of_month,project_id,active,last_month,created_by,created_at) VALUES(?,?,?,?,?,?,1,?,?,?)')
      .run(vendor.slice(0, 200), String(b.description || '').slice(0, 300), String(b.category || '').slice(0, 80), amount, day, b.project_id ? Number(b.project_id) : null, startMonth, req.user && req.user.email, new Date().toISOString());
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  });
  app.post('/api/admin/recurring-bills/:id/stop', auth, (req, res) => { ensureRecurring(db); db.prepare('UPDATE recurring_bills SET active=0 WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });
  app.get('/api/admin/expenses', auth, (req, res) => {
    runMonthly();
    const bills = db.prepare('SELECT * FROM expense_bills ORDER BY id DESC LIMIT 300').all();
    const named = hasTable(db, 'projects');
    const lines = hasTable(db, 'expense_bill_splits') ? db.prepare(`SELECT s.bill_id, s.project_id, s.category, s.amount${named ? ', p.name AS project_name' : ''} FROM expense_bill_splits s ${named ? 'LEFT JOIN projects p ON p.id=s.project_id' : ''} ORDER BY s.id`).all() : [];
    const byBill = {}; for (const l of lines) (byBill[l.bill_id] = byBill[l.bill_id] || []).push(l);
    const jobNames = named ? Object.fromEntries(db.prepare('SELECT id, name FROM projects').all().map(p => [p.id, p.name])) : {};
    res.json({ bills: bills.map(b => ({ ...b, splits: byBill[b.id] || [], project_name: b.project_id ? (jobNames[b.project_id] || null) : null })) });
  });
  app.get('/api/admin/expenses/close', auth, (req, res) => res.json(closeList(db, req.query || {})));
  app.post('/api/admin/expenses/close/approve', auth, (req, res) => res.json(approveBatch(db, (req.body || {}).ids, req.user && req.user.email)));
  app.put('/api/admin/expenses/:id/splits', auth, (req, res) => {
    try { setSplits(db, req.params.id, (req.body || {}).splits, req.user && req.user.email); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/expenses', auth, (req, res) => {
    const b = req.body || {};
    if (!b.confirm_duplicate) {
      const dups = findDuplicates(db, b);
      if (dups.length) return res.status(409).json({ error: 'Possible duplicate: bill ' + dups.map(d => '#' + d.id + ' (' + d.vendor + ', ' + Number(d.amount).toFixed(2) + ', ' + d.bill_date + ')').join('; ') + '. Save anyway only if this is a different bill.', duplicates: dups });
    }
    try { const id = createBill(db, req.body || {}, req.user && req.user.email); res.status(201).json({ ok: true, id }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.patch('/api/admin/expenses/:id', auth, (req, res) => {
    try { updateBill(db, req.params.id, req.body || {}, req.user && req.user.email); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  // Bills are voided, not deleted: the reversal and the reason stay on record.
  app.post('/api/admin/expenses/:id/void', auth, (req, res) => {
    try { voidBill(db, req.params.id, { reason: (req.body || {}).reason, by: req.user && req.user.email }); res.json({ ok: true }); }
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

module.exports = { ensureSchema, closeList, approveBatch, setSplits, allocationsOf, createBill, updateBill, voidBill, approveBill, payBill, syncRecorded, costDrift, recordPayrollPayment, attachReceipt, receiptPath, createCrewReceipt, burdenPct, findDuplicates, createDueRecurring, ensureRecurring, mount };
