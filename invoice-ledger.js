// Posts invoices and payments to Bright Clean's own ledger (Phase 4 of the accounting plan), and ties receivables out.
// Rules:
//  - An issued invoice: Dr Accounts receivable / Cr Cleaning service revenue, for the invoice amount.
//  - A payment: Dr Cash / Cr Accounts receivable.
//  - A voided invoice that was posted is reversed (reversing entry), never edited.
//  - Drafts post nothing. Each invoice and payment posts once (keyed by its id); running the sync again posts nothing new.
// Sales tax: optional per invoice (tax_amount). Where it is set, tax posts to 2100 and revenue stays the invoice amount.
// Where it is not set, the invoice amount is posted as revenue, as before.

const L = require('./ledger');

const ISSUED_SKIP = ['Draft'];
const dateOf = s => String(s || new Date().toISOString()).slice(0, 10);

// Sales tax per invoice is optional. The column is added on first use; zero means the invoice amount is the whole amount, as before.
function ensureTaxColumn(db) {
  const cols = db.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
  if (!cols.includes('tax_amount')) db.exec('ALTER TABLE invoices ADD COLUMN tax_amount REAL DEFAULT 0');
}
const taxOf = inv => Math.round((Number(inv.tax_amount) || 0) * 100) / 100;

function postedEntry(db, source, ref) {
  return db.prepare('SELECT id FROM ledger_entries WHERE source=? AND source_ref=? AND reverses_id IS NULL').get(source, ref);
}
function reversed(db, entryId) {
  return !!db.prepare('SELECT 1 FROM ledger_entries WHERE reverses_id=?').get(entryId);
}

function postInvoice(db, inv) {
  L.seedChart(db); ensureTaxColumn(db);
  const ref = 'invoice:' + inv.id;
  const posted = postedEntry(db, 'invoice', ref);
  if (inv.status === 'Void') {
    if (posted && !reversed(db, posted.id)) return { action: 'reversed', entry: L.reverseEntry(db, posted.id, { reason: 'Invoice ' + (inv.invoice_number || inv.id) + ' voided', by: 'invoice-sync' }) };
    return { action: 'none' };
  }
  if (ISSUED_SKIP.includes(inv.status) || posted) return { action: 'none' };
  const amount = Math.round((Number(inv.amount) || 0) * 100) / 100;
  if (!(amount > 0)) return { action: 'none' };
  const id = L.postEntry(db, {
    date: dateOf(inv.issue_date || inv.created_at), memo: 'Invoice ' + (inv.invoice_number || inv.id) + ' issued', source: 'invoice', sourceRef: ref, by: 'invoice-sync',
    lines: [{ account: '1100', debit: amount + taxOf(inv) }, { account: '4000', credit: amount }].concat(taxOf(inv) > 0 ? [{ account: '2100', credit: taxOf(inv) }] : [])
  });
  return { action: 'posted', entry: id };
}

function postPayment(db, pay) {
  L.seedChart(db);
  const ref = 'payment:' + pay.id;
  if (postedEntry(db, 'payment', ref)) return { action: 'none' };
  const amount = Math.round((Number(pay.amount) || 0) * 100) / 100;
  if (!(amount > 0)) return { action: 'none' };
  const id = L.postEntry(db, {
    date: dateOf(pay.received_at), memo: 'Payment on invoice ' + pay.invoice_id, source: 'payment', sourceRef: ref, by: 'invoice-sync',
    lines: [{ account: '1000', debit: amount }, { account: '1100', credit: amount }]
  });
  return { action: 'posted', entry: id };
}

// Posts everything that is not yet posted. Safe to run again.
function syncAll(db) {
  L.seedChart(db);
  const out = { invoices_posted: 0, invoices_reversed: 0, payments_posted: 0, errors: [] };
  for (const inv of db.prepare('SELECT * FROM invoices ORDER BY id').all()) {
    try { const r = postInvoice(db, inv); if (r.action === 'posted') out.invoices_posted++; if (r.action === 'reversed') out.invoices_reversed++; }
    catch (e) { out.errors.push('invoice ' + inv.id + ': ' + e.message); }
  }
  for (const pay of db.prepare('SELECT * FROM payments ORDER BY id').all()) {
    try { if (postPayment(db, pay).action === 'posted') out.payments_posted++; }
    catch (e) { out.errors.push('payment ' + pay.id + ': ' + e.message); }
  }
  return out;
}

// Invoices still owed (issued, not void) against the ledger's receivable. The difference should be zero after a sync.
function tieOut(db) {
  L.seedChart(db); ensureTaxColumn(db);
  const invoices = db.prepare("SELECT id, invoice_number, amount, tax_amount, status FROM invoices WHERE status NOT IN ('Draft','Void')").all();
  const paidStmt = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM payments WHERE invoice_id=?');
  let owed = 0;
  const R = require('./receivables');
  for (const inv of invoices) owed += R.invoiceBalance(db, inv.id).owed;
  const ar = L.trialBalance(db).accounts.find(a => a.code === '1100').balance;
  const unpostedInvoices = invoices.filter(inv => !postedEntry(db, 'invoice', 'invoice:' + inv.id) && (Number(inv.amount) || 0) > 0).length;
  const unpostedPayments = db.prepare('SELECT id FROM payments').all().filter(p => !postedEntry(db, 'payment', 'payment:' + p.id)).length;
  const difference = Math.round((owed - ar) * 100) / 100;
  const unposted = invoices.filter(inv => !postedEntry(db, 'invoice', 'invoice:' + inv.id) && (Number(inv.amount) || 0) > 0).map(inv => ({ id: inv.id, invoice_number: inv.invoice_number, amount: Number(inv.amount) || 0, tax_amount: taxOf(inv) }));
  return { unposted, invoices_owed: Math.round(owed * 100) / 100, ledger_receivable: ar, difference, unposted_invoices: unpostedInvoices, unposted_payments: unpostedPayments,
    tied_out: Math.abs(difference) < 0.005 && unpostedInvoices === 0 && unpostedPayments === 0,
    gap: 'Sales tax is posted only on invoices where tax is set. Any other invoice posts its whole amount as revenue.' };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  app.post('/api/admin/ledger/sync', auth, (req, res) => {
    try {
      const out = syncAll(db), ex = require('./expenses').syncRecorded(db);
      res.json({ ok: true, invoices_posted: out.invoices_posted, invoices_reversed: out.invoices_reversed, payments_posted: out.payments_posted, bills_posted: ex.bills_posted, project_costs_posted: ex.project_costs_posted, payroll_posted: ex.payroll_posted, errors: [...out.errors, ...ex.errors], tie_out: tieOut(db), cost_drift: require('./expenses').costDrift(db) });
    }
    catch (e) { res.status(500).json({ error: 'The ledger sync failed: ' + e.message }); }
  });
  app.post('/api/admin/invoices/:id/tax', auth, (req, res) => {
    ensureTaxColumn(db);
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(Number(req.params.id));
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const tax = Number((req.body || {}).tax_amount);
    if (!Number.isFinite(tax) || tax < 0 || tax > 1e7) return res.status(400).json({ error: 'Sales tax must be zero or more.' });
    if (postedEntry(db, 'invoice', 'invoice:' + inv.id)) return res.status(409).json({ error: 'This invoice is already on the ledger. Void it and issue a corrected invoice to change its tax.' });
    db.prepare('UPDATE invoices SET tax_amount=? WHERE id=?').run(Math.round(tax * 100) / 100, inv.id);
    res.json({ ok: true, tax_amount: Math.round(tax * 100) / 100 });
  });
  app.get('/api/admin/receivables/tie-out', auth, (req, res) => res.json(tieOut(db)));
}

module.exports = { postInvoice, postPayment, syncAll, tieOut, mount };
