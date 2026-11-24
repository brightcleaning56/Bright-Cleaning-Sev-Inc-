// Bank statement import and matching (audit G14).
// - Import: a CSV with date, description and amount (money in positive, money out negative). A header row is allowed.
//   A line already imported (same date, amount and description) is skipped, so re-importing a statement is safe.
// - Match: each statement line is matched to ledger cash entries (account 1000) with the same signed amount, within 5 days.
//   A line matches automatically only when exactly one entry fits and that entry is not already taken.
//   Anything else is matched by hand (the owner or manager picks the entry).
// - Summary: statement lines with no ledger entry, and ledger cash entries with no statement line (outstanding items).

const L = require('./ledger');
const AU = require('./audit');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const WINDOW_DAYS = 5;

function ensureSchema(db) {
  L.seedChart(db);
  db.exec(`CREATE TABLE IF NOT EXISTS bank_statement_lines(
    id INTEGER PRIMARY KEY AUTOINCREMENT, line_date TEXT NOT NULL, description TEXT, amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'Unmatched', entry_id INTEGER, imported_by TEXT, imported_at TEXT NOT NULL)`);
}

// Splits one CSV line, honouring quoted fields with commas and doubled quotes.
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseStatement(text) {
  const rows = [], problems = [];
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  lines.forEach((line, i) => {
    const [date, description, amountText] = splitCsv(line);
    if (i === 0 && /date/i.test(date || '') && /amount/i.test(amountText || '')) return; // header
    const amount = Number(String(amountText || '').replace(/[$,]/g, ''));
    if (!isDate(date)) return problems.push({ line: i + 1, problem: 'The date is not a real date (YYYY-MM-DD).' });
    if (!Number.isFinite(amount) || amount === 0) return problems.push({ line: i + 1, problem: 'The amount is missing or zero.' });
    rows.push({ line_date: date, description: String(description || '').slice(0, 300), amount: r2(amount) });
  });
  return { rows, problems };
}

function importStatement(db, text, by) {
  ensureSchema(db);
  const { rows, problems } = parseStatement(text);
  if (!rows.length) throw new Error('No statement lines were found. Expected date, description, amount.' + (problems.length ? ' First problem: line ' + problems[0].line + ' ' + problems[0].problem : ''));
  const countStmt = db.prepare('SELECT COUNT(*) n FROM bank_statement_lines WHERE line_date=? AND amount=? AND description=?');
  const keyOf = r => [r.line_date, r.amount, r.description].join('\u0001');
  // How many matching lines the database already holds, per line. Only that many of the same lines in this file are repeats.
  const before = new Map(); for (const r of rows) { const k = keyOf(r); if (!before.has(k)) before.set(k, countStmt.get(r.line_date, r.amount, r.description).n); }
  const seen = new Map();
  const at = new Date().toISOString();
  let added = 0, skipped = 0;
  db.transaction(() => {
    for (const r of rows) {
      const k = keyOf(r), nth = seen.get(k) || 0; seen.set(k, nth + 1);
      if (nth < before.get(k)) { skipped++; continue; }
      db.prepare('INSERT INTO bank_statement_lines(line_date,description,amount,status,imported_by,imported_at) VALUES(?,?,?,?,?,?)').run(r.line_date, r.description, r.amount, 'Unmatched', by || null, at);
      added++;
    }
  })();
  AU.record(db, { actor: by, action: 'imported bank statement', entity: 'bank', detail: `${added} line(s) added, ${skipped} already there, ${problems.length} skipped` });
  return { added, skipped, problems };
}

// Cash entries: one row per ledger entry that touches cash, with its signed amount (positive = money in).
function cashEntries(db) {
  return db.prepare(`SELECT e.id, e.entry_date, e.memo, ROUND(SUM(l.debit_cents - l.credit_cents) / 100.0, 2) AS amount
    FROM ledger_entries e JOIN ledger_lines l ON l.entry_id=e.id AND l.account_code='1000'
    GROUP BY e.id ORDER BY e.entry_date, e.id`).all();
}
const daysApart = (a, b) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5;

function autoMatch(db) {
  ensureSchema(db);
  const lines = db.prepare("SELECT * FROM bank_statement_lines WHERE status='Unmatched' ORDER BY line_date, id").all();
  const cash = cashEntries(db);
  const taken = new Set(db.prepare("SELECT entry_id FROM bank_statement_lines WHERE status='Matched'").all().map(x => x.entry_id));
  let matched = 0;
  for (const line of lines) {
    const fits = cash.filter(c => !taken.has(c.id) && Math.abs(c.amount - line.amount) < 0.005 && daysApart(c.entry_date, line.line_date) <= WINDOW_DAYS);
    if (fits.length !== 1) continue;
    db.prepare("UPDATE bank_statement_lines SET status='Matched', entry_id=? WHERE id=?").run(fits[0].id, line.id);
    taken.add(fits[0].id);
    matched++;
  }
  return { matched };
}

function manualMatch(db, lineId, entryId, by) {
  ensureSchema(db);
  const line = db.prepare('SELECT * FROM bank_statement_lines WHERE id=?').get(Number(lineId));
  if (!line) throw new Error('Statement line not found.');
  const c = cashEntries(db).find(x => x.id === Number(entryId));
  if (!c) throw new Error('That ledger entry does not move cash.');
  if (Math.abs(c.amount - line.amount) > 0.005) throw new Error(`The amounts differ: the statement shows ${line.amount.toFixed(2)} and the ledger entry ${c.amount.toFixed(2)}.`);
  if (db.prepare("SELECT id FROM bank_statement_lines WHERE status='Matched' AND entry_id=? AND id<>?").get(c.id, line.id)) throw new Error('That ledger entry is already matched to another statement line.');
  db.prepare("UPDATE bank_statement_lines SET status='Matched', entry_id=? WHERE id=?").run(c.id, line.id);
  AU.record(db, { actor: by, action: 'matched bank line', entity: 'bank_line', entityId: line.id, detail: 'to ledger entry ' + c.id });
  return { ok: true };
}

function summary(db) {
  ensureSchema(db);
  const lines = db.prepare('SELECT * FROM bank_statement_lines ORDER BY line_date, id').all();
  const matchedEntries = new Set(lines.filter(l => l.status === 'Matched').map(l => l.entry_id));
  const unmatchedStatement = lines.filter(l => l.status === 'Unmatched');
  const outstanding = cashEntries(db).filter(c => !matchedEntries.has(c.id));
  const sum = list => r2(list.reduce((s, x) => s + Number(x.amount), 0));
  const ledgerCash = L.trialBalance(db).accounts.find(a => a.code === '1000').balance;
  return {
    statement_lines: lines.length, matched: lines.filter(l => l.status === 'Matched').length,
    unmatched_statement: unmatchedStatement, unmatched_statement_total: sum(unmatchedStatement),
    outstanding_ledger: outstanding, outstanding_ledger_total: sum(outstanding),
    ledger_cash: r2(ledgerCash),
    note: 'Outstanding ledger items are cash entries with no statement line yet (for example a deposit still in transit). Unmatched statement lines need an entry or a correction.'
  };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  ensureSchema(db);
  const run = (res, fn) => { try { res.json(fn()); } catch (e) { res.status(400).json({ error: e.message }); } };
  app.get('/api/admin/bank/summary', auth, (req, res) => run(res, () => summary(db)));
  app.get('/api/admin/bank/lines', auth, (req, res) => run(res, () => ({ lines: db.prepare('SELECT * FROM bank_statement_lines ORDER BY line_date DESC, id DESC LIMIT 500').all() })));
  app.post('/api/admin/bank/import', auth, (req, res) => run(res, () => importStatement(db, (req.body || {}).csv, req.user && req.user.email)));
  app.post('/api/admin/bank/auto-match', auth, (req, res) => run(res, () => autoMatch(db)));
  app.post('/api/admin/bank/lines/:id/match', auth, (req, res) => run(res, () => manualMatch(db, req.params.id, (req.body || {}).entry_id, req.user && req.user.email)));
}

module.exports = { ensureSchema, parseStatement, importStatement, autoMatch, manualMatch, summary, cashEntries, mount };
