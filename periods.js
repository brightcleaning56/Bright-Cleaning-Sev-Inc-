// Accounting periods and bank reconciliation (Phase 7 of the accounting plan).
// - Closing a period sets a date through which nothing can be posted (the ledger refuses entries dated on or before it).
//   Closes only move forward, and the trial balance must balance before a close is recorded.
// - Bank reconciliation compares the bank statement balance on a date with the ledger's cash balance on that date.
//   Each check is recorded; the difference must be explained before the owner signs it off.

const L = require('./ledger');

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function ensureSchema(db) {
  L.ensureSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS bank_reconciliations(
    id INTEGER PRIMARY KEY AUTOINCREMENT, as_of TEXT NOT NULL, statement_balance REAL NOT NULL, ledger_balance REAL NOT NULL,
    difference REAL NOT NULL, note TEXT, reconciled_by TEXT, created_at TEXT NOT NULL)`);
}

function closedThrough(db) {
  const r = db.prepare('SELECT MAX(closed_through) m FROM ledger_periods').get();
  return r && r.m || null;
}

function closePeriod(db, through, by) {
  ensureSchema(db); L.seedChart(db);
  if (!isDate(through)) throw new Error('Close through a real date (YYYY-MM-DD).');
  const current = closedThrough(db);
  if (current && through <= current) throw new Error('The books are already closed through ' + current + '. A close can only move forward.');
  const tb = L.trialBalance(db, { asOf: through });
  if (!tb.balanced) throw new Error('The trial balance does not balance, so the period cannot be closed.');
  const id = db.prepare('INSERT INTO ledger_periods(closed_through,closed_at,closed_by,trial_balance_ok) VALUES(?,?,?,1)')
    .run(through, new Date().toISOString(), by || null).lastInsertRowid;
  return { id, closed_through: through };
}

function listPeriods(db) {
  ensureSchema(db);
  return { closed_through: closedThrough(db), periods: db.prepare('SELECT * FROM ledger_periods ORDER BY id DESC').all() };
}

// Compares the bank statement balance with the ledger's cash (account 1000) on the same date.
function reconcileCash(db, { asOf, statementBalance, note, by }) {
  ensureSchema(db); L.seedChart(db);
  if (!isDate(asOf)) throw new Error('Reconcile on a real date (YYYY-MM-DD).');
  const sb = Number(statementBalance);
  if (!Number.isFinite(sb)) throw new Error('Enter the bank statement balance as a number.');
  const ledgerBalance = L.trialBalance(db, { asOf }).accounts.find(a => a.code === '1000').balance;
  const difference = r2(sb - ledgerBalance);
  const id = db.prepare('INSERT INTO bank_reconciliations(as_of,statement_balance,ledger_balance,difference,note,reconciled_by,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(asOf, r2(sb), r2(ledgerBalance), difference, String(note || '').slice(0, 300), by || null, new Date().toISOString()).lastInsertRowid;
  return { id, as_of: asOf, statement_balance: r2(sb), ledger_balance: r2(ledgerBalance), difference, matched: difference === 0,
    next_step: difference === 0 ? 'Matched.' : 'Explain the difference before signing off: a deposit or payment not yet on the ledger, a bank fee, or a posting error.' };
}

function listReconciliations(db) {
  ensureSchema(db);
  return { reconciliations: db.prepare('SELECT * FROM bank_reconciliations ORDER BY id DESC LIMIT 100').all() };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  ensureSchema(db);
  const run = (res, fn) => { try { res.json(fn()); } catch (e) { res.status(400).json({ error: e.message }); } };
  app.get('/api/admin/ledger/periods', auth, (req, res) => run(res, () => listPeriods(db)));
  app.post('/api/admin/ledger/periods/close', auth, (req, res) => run(res, () => closePeriod(db, (req.body || {}).through, req.user && req.user.email)));
  app.get('/api/admin/ledger/reconciliations', auth, (req, res) => run(res, () => listReconciliations(db)));
  app.post('/api/admin/ledger/reconciliations', auth, (req, res) => run(res, () => reconcileCash(db, { asOf: (req.body || {}).as_of, statementBalance: (req.body || {}).statement_balance, note: (req.body || {}).note, by: req.user && req.user.email })));
}

module.exports = { ensureSchema, closePeriod, listPeriods, reconcileCash, listReconciliations, closedThrough, mount };
