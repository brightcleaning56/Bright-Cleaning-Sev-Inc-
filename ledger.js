// Bright Clean's own general ledger (double-entry). Phase 1 foundation.
// - Money is stored in whole cents, so totals never drift.
// - Every posted entry balances (debits = credits) and is checked before it is written.
// - Posted entries and lines cannot be edited or deleted (database triggers). A mistake is fixed with a reversing entry.
// - Nothing here changes existing invoices, payments or reports yet. Those modules will post here in later phases.
// - Read-only routes are exposed to admins; posting is done by server code only for now.

const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const NORMAL = { asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', revenue: 'credit' };

// Starter chart of accounts. Codes follow the usual 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx-6xxx costs.
const STARTER_CHART = [
  ['1000', 'Cash', 'asset'],
  ['1100', 'Accounts receivable', 'asset'],
  ['2000', 'Accounts payable', 'liability'],
  ['2100', 'Sales tax payable', 'liability'],
  ['2200', 'Customer deposits (not yet earned)', 'liability'],
  ['2300', 'Accrued payroll', 'liability'],
  ['2400', 'Payroll taxes payable', 'liability'],
  ['3000', "Owner's equity", 'equity'],
  ['4000', 'Cleaning service revenue', 'revenue'],
  ['4900', 'Discounts and customer credits', 'revenue'],
  ['5000', 'Direct labor', 'expense'],
  ['5100', 'Materials and supplies', 'expense'],
  ['5200', 'Equipment and rentals', 'expense'],
  ['5300', 'Subcontractors', 'expense'],
  ['5400', 'Travel and disposal', 'expense'],
  ['5900', 'Other job costs', 'expense'],
  ['6000', 'Operating expenses', 'expense'],
  ['6100', 'Payroll not assigned to a job', 'expense']
];

const cents = v => Math.round(Number(v) * 100);
// A real calendar date: the text must survive a round trip (so 2026-02-30 is refused).
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

const ensured = new WeakSet();
function ensureSchema(db) {
  if (ensured.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_accounts(
      code TEXT PRIMARY KEY, name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
      active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS ledger_entries(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date TEXT NOT NULL, memo TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT,
      reverses_id INTEGER, created_by TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_lines(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES ledger_entries(id),
      account_code TEXT NOT NULL REFERENCES ledger_accounts(code),
      debit_cents INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
      credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
      CHECK ((debit_cents > 0 AND credit_cents = 0) OR (debit_cents = 0 AND credit_cents > 0)));
    CREATE TABLE IF NOT EXISTS ledger_periods(
      id INTEGER PRIMARY KEY AUTOINCREMENT, closed_through TEXT NOT NULL, closed_at TEXT NOT NULL,
      closed_by TEXT, trial_balance_ok INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update BEFORE UPDATE ON ledger_entries
      BEGIN SELECT RAISE(ABORT, 'Posted ledger entries cannot be changed. Post a reversing entry instead.'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete BEFORE DELETE ON ledger_entries
      BEGIN SELECT RAISE(ABORT, 'Posted ledger entries cannot be deleted. Post a reversing entry instead.'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_lines_no_update BEFORE UPDATE ON ledger_lines
      BEGIN SELECT RAISE(ABORT, 'Posted ledger lines cannot be changed. Post a reversing entry instead.'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_lines_no_delete BEFORE DELETE ON ledger_lines
      BEGIN SELECT RAISE(ABORT, 'Posted ledger lines cannot be deleted. Post a reversing entry instead.'); END;
  `);
  ensured.add(db);
}

function seedChart(db) {
  ensureSchema(db);
  const ins = db.prepare('INSERT OR IGNORE INTO ledger_accounts(code,name,type,active) VALUES(?,?,?,1)');
  for (const [code, name, type] of STARTER_CHART) ins.run(code, name, type);
}

// Posts one balanced entry. lines: [{ account, debit, credit }] in dollars; one side per line.
// Throws an Error with a plain message when the entry is not valid; nothing is written in that case.
function postEntry(db, { date, memo, source, sourceRef = null, lines, by = 'system', reverses = null }) {
  ensureSchema(db);
  if (!isDate(date)) throw new Error('Entry date must be a real date (YYYY-MM-DD).');
  const closed = db.prepare('SELECT MAX(closed_through) m FROM ledger_periods').get();
  if (closed && closed.m && date <= closed.m) throw new Error('The books are closed through ' + closed.m + '. Post the entry after that date, or a reversing entry today.');
  if (!String(memo || '').trim()) throw new Error('Every entry needs a memo.');
  if (!String(source || '').trim()) throw new Error('Every entry needs a source.');
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('An entry needs at least two lines.');
  const norm = lines.map((l, i) => {
    const acct = db.prepare('SELECT code, active FROM ledger_accounts WHERE code=?').get(String(l.account || ''));
    if (!acct) throw new Error(`Line ${i + 1}: unknown account "${l.account}".`);
    if (!acct.active) throw new Error(`Line ${i + 1}: account ${acct.code} is closed.`);
    const d = cents(l.debit || 0), c = cents(l.credit || 0);
    if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0) throw new Error(`Line ${i + 1}: amounts must be zero or more.`);
    if ((d > 0) === (c > 0)) throw new Error(`Line ${i + 1}: enter an amount on exactly one side (debit or credit).`);
    return { code: acct.code, d, c };
  });
  const dr = norm.reduce((s, l) => s + l.d, 0), cr = norm.reduce((s, l) => s + l.c, 0);
  if (dr !== cr) throw new Error(`Entry does not balance: debits ${(dr / 100).toFixed(2)} vs credits ${(cr / 100).toFixed(2)}.`);
  if (dr === 0) throw new Error('An entry must move money. A zero entry is not allowed.');
  const at = new Date().toISOString();
  return db.transaction(() => {
    const id = db.prepare('INSERT INTO ledger_entries(entry_date,memo,source,source_ref,reverses_id,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(date, String(memo).trim().slice(0, 300), String(source).trim().slice(0, 60), sourceRef == null ? null : String(sourceRef).slice(0, 120), reverses, String(by).slice(0, 200), at).lastInsertRowid;
    const ln = db.prepare('INSERT INTO ledger_lines(entry_id,account_code,debit_cents,credit_cents) VALUES(?,?,?,?)');
    for (const l of norm) ln.run(id, l.code, l.d, l.c);
    return id;
  })();
}

// Posts the mirror image of an entry. Each entry can be reversed once, and a reversal cannot be reversed.
function reverseEntry(db, entryId, { reason, by = 'system' } = {}) {
  ensureSchema(db);
  const e = db.prepare('SELECT * FROM ledger_entries WHERE id=?').get(Number(entryId));
  if (!e) throw new Error('Entry not found.');
  if (e.reverses_id) throw new Error('A reversing entry cannot itself be reversed.');
  if (db.prepare('SELECT 1 FROM ledger_entries WHERE reverses_id=?').get(e.id)) throw new Error('This entry has already been reversed.');
  if (!String(reason || '').trim()) throw new Error('Give a reason for the reversal.');
  require('./audit').record(db, { actor: by, action: 'reversed entry', entity: 'ledger_entry', entityId: e.id, detail: String(reason).trim() });
  const lines = db.prepare('SELECT account_code, debit_cents, credit_cents FROM ledger_lines WHERE entry_id=?').all(e.id);
  return postEntry(db, {
    date: require('./bizdate').today(), memo: `Reversal of entry ${e.id}: ${reason}`, source: 'reversal', sourceRef: String(e.id), by, reverses: e.id,
    lines: lines.map(l => ({ account: l.account_code, debit: l.credit_cents / 100, credit: l.debit_cents / 100 }))
  });
}

// Balance per account (debit-positive for assets and costs, shown as the normal balance), plus the check that all debits equal all credits.
function trialBalance(db, { asOf = null } = {}) {
  ensureSchema(db);
  // Only lines of entries dated on or before asOf count. Every account still appears, with zero, when it has no such lines.
  const dated = asOf ? ' AND l.entry_id IN (SELECT id FROM ledger_entries WHERE entry_date <= ?)' : '';
  const args = asOf ? [asOf] : [];
  const rows = db.prepare(`
    SELECT a.code, a.name, a.type, COALESCE(SUM(l.debit_cents),0) AS dr, COALESCE(SUM(l.credit_cents),0) AS cr
    FROM ledger_accounts a
    LEFT JOIN ledger_lines l ON l.account_code = a.code${dated}
    GROUP BY a.code, a.name, a.type ORDER BY a.code`).all(...args);
  const accounts = rows.map(r => {
    const net = NORMAL[r.type] === 'debit' ? r.dr - r.cr : r.cr - r.dr;
    return { code: r.code, name: r.name, type: r.type, debit: r.dr / 100, credit: r.cr / 100, balance: net / 100 };
  });
  const totalDebit = rows.reduce((s, r) => s + r.dr, 0), totalCredit = rows.reduce((s, r) => s + r.cr, 0);
  return { as_of: asOf, accounts, total_debit: totalDebit / 100, total_credit: totalCredit / 100, balanced: totalDebit === totalCredit };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  seedChart(db);
  app.get('/api/admin/ledger/accounts', auth, (req, res) => {
    ensureSchema(db);
    res.json({ accounts: db.prepare('SELECT code,name,type,active FROM ledger_accounts ORDER BY code').all(), types: TYPES });
  });
  app.get('/api/admin/ledger/trial-balance', auth, (req, res) => {
    const asOf = req.query.as_of ? String(req.query.as_of) : null;
    if (asOf && !isDate(asOf)) return res.status(400).json({ error: 'as_of must be a date (YYYY-MM-DD).' });
    res.json(trialBalance(db, { asOf }));
  });
  // Owner and manager adjustments: a manual journal entry (balanced, dated, with a memo) and a reversal of an entry.
  app.post('/api/admin/ledger/adjustments', auth, (req, res) => {
    try {
      const b = req.body || {};
      const by = req.user && req.user.email;
      const id = postEntry(db, { date: b.date, memo: b.memo, source: 'adjustment', sourceRef: 'adjustment:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8), by, lines: b.lines || [] });
      require('./audit').record(db, { actor: by, action: 'manual journal entry', entity: 'ledger_entry', entityId: id, detail: String(b.memo || '').slice(0, 200) });
      res.status(201).json({ ok: true, entry: id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/ledger/entries/:id/reverse', auth, (req, res) => {
    try { const r = reverseEntry(db, Number(req.params.id), { reason: (req.body || {}).reason, by: req.user && req.user.email }); res.status(201).json({ ok: true, entry: r }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/admin/ledger/entries', auth, (req, res) => {
    ensureSchema(db);
    const entries = db.prepare('SELECT * FROM ledger_entries ORDER BY id DESC LIMIT 200').all();
    const lineStmt = db.prepare('SELECT account_code, debit_cents, credit_cents FROM ledger_lines WHERE entry_id=? ORDER BY id');
    res.json({ entries: entries.map(e => ({ ...e, lines: lineStmt.all(e.id).map(l => ({ account: l.account_code, debit: l.debit_cents / 100, credit: l.credit_cents / 100 })) })) });
  });
}

module.exports = { STARTER_CHART, TYPES, NORMAL, ensureSchema, seedChart, postEntry, reverseEntry, trialBalance, mount };
