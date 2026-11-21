// Refunds and credit notes on customer invoices (audit gap G3). Each one posts to the ledger when recorded.
//  - Refund: money returned to the customer. Dr 1100 accounts receivable / Cr 1000 cash. Refunds cannot exceed the payments received on the invoice.
//  - Credit note: the invoice is reduced. Dr 4900 discounts and customer credits / Cr 1100 accounts receivable.
//    A credit cannot exceed what the customer still owes on the invoice.
// Both are recorded once, by id. They are reversed, never edited (through the ledger reverse function, by the owner).

const L = require('./ledger');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

function ensureSchema(db) {
  L.seedChart(db);
  db.exec(`CREATE TABLE IF NOT EXISTS refunds(
    id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, amount REAL NOT NULL, refund_date TEXT NOT NULL,
    reason TEXT NOT NULL, recorded_by TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credit_notes(
    id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, amount REAL NOT NULL, credit_date TEXT NOT NULL,
    reason TEXT NOT NULL, recorded_by TEXT, created_at TEXT NOT NULL);`);
}

// Money the invoice has in payments, refunds and credits, all in one place for checks and the tie-out.
function invoiceBalance(db, invoiceId) {
  const hasTax = db.prepare('PRAGMA table_info(invoices)').all().some(c => c.name === 'tax_amount');
  const inv = db.prepare(`SELECT id, amount, ${hasTax ? 'COALESCE(tax_amount,0)' : '0'} tax FROM invoices WHERE id=?`).get(Number(invoiceId));
  if (!inv) throw new Error('Invoice not found.');
  const sum = (sql) => Number(db.prepare(sql).get(inv.id).v) || 0;
  const billed = r2((Number(inv.amount) || 0) + (Number(inv.tax) || 0));
  const paid = r2(sum('SELECT COALESCE(SUM(amount),0) v FROM payments WHERE invoice_id=?'));
  const refunded = hasTable(db, 'refunds') ? r2(sum('SELECT COALESCE(SUM(amount),0) v FROM refunds WHERE invoice_id=?')) : 0;
  const credited = hasTable(db, 'credit_notes') ? r2(sum('SELECT COALESCE(SUM(amount),0) v FROM credit_notes WHERE invoice_id=?')) : 0;
  return { invoice_id: inv.id, billed, paid, refunded, credited, owed: r2(billed - paid + refunded - credited), paid_net: r2(paid - refunded) };
}

function recordRefund(db, { invoiceId, amount, date, reason, by }) {
  ensureSchema(db);
  const amt = r2(amount);
  if (!(amt > 0)) throw new Error('A refund needs an amount above zero.');
  if (!isDate(date)) throw new Error('A refund needs a real date (YYYY-MM-DD).');
  if (!String(reason || '').trim()) throw new Error('Give the reason for the refund.');
  const b = invoiceBalance(db, invoiceId);
  if (amt > b.paid_net + 0.005) throw new Error(`The refund (${amt.toFixed(2)}) is more than the payments received on this invoice (${b.paid_net.toFixed(2)}).`);
  const at = new Date().toISOString();
  return db.transaction(() => {
    const id = db.prepare('INSERT INTO refunds(invoice_id,amount,refund_date,reason,recorded_by,created_at) VALUES(?,?,?,?,?,?)')
      .run(b.invoice_id, amt, date, String(reason).trim().slice(0, 300), by || null, at).lastInsertRowid;
    L.postEntry(db, { date, memo: 'Refund ' + id + ' on invoice ' + b.invoice_id + ': ' + String(reason).trim().slice(0, 120), source: 'refund', sourceRef: 'refund:' + id, by: by || 'receivables',
      lines: [{ account: '1100', debit: amt }, { account: '1000', credit: amt }] });
    return id;
  })();
}

function recordCredit(db, { invoiceId, amount, date, reason, by }) {
  ensureSchema(db);
  const amt = r2(amount);
  if (!(amt > 0)) throw new Error('A credit note needs an amount above zero.');
  if (!isDate(date)) throw new Error('A credit note needs a real date (YYYY-MM-DD).');
  if (!String(reason || '').trim()) throw new Error('Give the reason for the credit note.');
  const b = invoiceBalance(db, invoiceId);
  if (amt > b.owed + 0.005) throw new Error(`The credit (${amt.toFixed(2)}) is more than the customer still owes on this invoice (${b.owed.toFixed(2)}).`);
  const at = new Date().toISOString();
  return db.transaction(() => {
    const id = db.prepare('INSERT INTO credit_notes(invoice_id,amount,credit_date,reason,recorded_by,created_at) VALUES(?,?,?,?,?,?)')
      .run(b.invoice_id, amt, date, String(reason).trim().slice(0, 300), by || null, at).lastInsertRowid;
    L.postEntry(db, { date, memo: 'Credit note ' + id + ' on invoice ' + b.invoice_id + ': ' + String(reason).trim().slice(0, 120), source: 'credit-note', sourceRef: 'credit-note:' + id, by: by || 'receivables',
      lines: [{ account: '4900', debit: amt }, { account: '1100', credit: amt }] });
    return id;
  })();
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  ensureSchema(db);
  const run = (res, fn) => { try { res.json(fn()); } catch (e) { res.status(400).json({ error: e.message }); } };
  app.get('/api/admin/invoices/:id/balance', auth, (req, res) => run(res, () => invoiceBalance(db, req.params.id)));
  app.post('/api/admin/invoices/:id/credit-note', auth, (req, res) => run(res, () => ({ ok: true, id: recordCredit(db, { invoiceId: req.params.id, amount: (req.body || {}).amount, date: (req.body || {}).date, reason: (req.body || {}).reason, by: req.user && req.user.email }) })));
}

module.exports = { ensureSchema, invoiceBalance, recordRefund, recordCredit, mount };
