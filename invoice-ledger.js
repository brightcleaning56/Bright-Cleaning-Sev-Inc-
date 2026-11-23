// Posts invoices and payments to Bright Clean's own ledger (Phase 4 of the accounting plan), and ties receivables out.
// Rules:
//  - An issued invoice: Dr Accounts receivable / Cr Cleaning service revenue, for the invoice amount.
//  - A payment: Dr Cash / Cr Accounts receivable.
//  - A voided invoice that was posted is reversed (reversing entry), never edited.
//  - Drafts post nothing. Each invoice and payment posts once (keyed by its id); running the sync again posts nothing new.
// Sales tax: optional per invoice (tax_amount). Where it is set, tax posts to 2100 and revenue stays the invoice amount.
// Where it is not set, the invoice amount is posted as revenue, as before.

const L = require('./ledger');
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

const ISSUED_SKIP = ['Draft'];
const dateOf = s => String(s || new Date().toISOString()).slice(0, 10);

// Iowa state sales tax on janitorial and building cleaning for nonresidential customers is 6% (Iowa Code 423.2). Cleaning tied to new
// construction or remodeling, and residential cleaning paid by the occupant, are exempt. The rate is a setting; local option taxes are not included.
function taxRatePct(db) {
  try { const r = db.prepare("SELECT value FROM settings WHERE key='sales_tax_rate_pct'").get(); const v = Number(r && r.value); return v >= 0 && v <= 20 ? v : 6; }
  catch { return 6; }
}

// Sales tax per invoice is optional. The column is added on first use; zero means the invoice amount is the whole amount, as before.
function ensureTaxColumn(db) {
  const cols = db.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
  if (!cols.includes('tax_amount')) db.exec('ALTER TABLE invoices ADD COLUMN tax_amount REAL DEFAULT 0');
// Revenue timing (decision): 'arrears' (default) = work already done, revenue on issue; 'advance' = paid ahead, held as a customer deposit until earned.
  if (!cols.includes('billing_kind')) db.exec("ALTER TABLE invoices ADD COLUMN billing_kind TEXT DEFAULT 'arrears'");
  if (!cols.includes('tax_exempt_reason')) db.exec('ALTER TABLE invoices ADD COLUMN tax_exempt_reason TEXT');
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
    lines: [{ account: '1100', debit: amount + taxOf(inv) }, { account: inv.billing_kind === 'advance' ? '2200' : '4000', credit: amount }].concat(taxOf(inv) > 0 ? [{ account: '2100', credit: taxOf(inv) }] : [])
  });
  return { action: 'posted', entry: id };
}

function postPayment(db, pay) {
  L.seedChart(db);
  const ref = 'payment:' + pay.id;
  if (postedEntry(db, 'payment', ref)) return { action: 'none' };
  // Held, not posted: the invoice is missing, a draft, or void. It posts on a later run once the invoice is issued.
  const inv = db.prepare('SELECT status FROM invoices WHERE id=?').get(pay.invoice_id);
  if (!inv) return { action: 'held', reason: 'No invoice with number ' + pay.invoice_id + ' exists, so the payment is held.' };
  if (['Draft', 'Void'].includes(inv.status)) return { action: 'held', reason: 'Invoice ' + pay.invoice_id + ' is ' + inv.status + ', so the payment is held until it is issued.' };
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
  const out = { invoices_posted: 0, invoices_reversed: 0, payments_posted: 0, payments_held: [], errors: [] };
  for (const inv of db.prepare('SELECT * FROM invoices ORDER BY id').all()) {
    try { const r = postInvoice(db, inv); if (r.action === 'posted') out.invoices_posted++; if (r.action === 'reversed') out.invoices_reversed++; }
    catch (e) { out.errors.push('invoice ' + inv.id + ': ' + e.message); }
  }
  for (const pay of db.prepare('SELECT * FROM payments ORDER BY id').all()) {
    try { const r = postPayment(db, pay); if (r.action === 'posted') out.payments_posted++; if (r.action === 'held') out.payments_held.push({ payment_id: pay.id, invoice_id: pay.invoice_id, amount: pay.amount, reason: r.reason }); }
    catch (e) { out.errors.push('payment ' + pay.id + ': ' + e.message); }
  }
  return out;
}

// Invoices still owed (issued, not void) against the ledger's receivable. The difference should be zero after a sync.
function tieOut(db) {
  L.seedChart(db); ensureTaxColumn(db);
  const invoices = db.prepare("SELECT id, invoice_number, amount, tax_amount, billing_kind, status FROM invoices WHERE status NOT IN ('Draft','Void')").all();
  const paidStmt = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM payments WHERE invoice_id=?');
  let owed = 0;
  const R = require('./receivables');
  for (const inv of invoices) owed += R.invoiceBalance(db, inv.id).owed;
  const ar = L.trialBalance(db).accounts.find(a => a.code === '1100').balance;
  const unpostedInvoices = invoices.filter(inv => !postedEntry(db, 'invoice', 'invoice:' + inv.id) && (Number(inv.amount) || 0) > 0).length;
  const unpostedPayments = db.prepare('SELECT id FROM payments').all().filter(p => !postedEntry(db, 'payment', 'payment:' + p.id)).length;
  const difference = Math.round((owed - ar) * 100) / 100;
  const unposted = invoices.filter(inv => !postedEntry(db, 'invoice', 'invoice:' + inv.id) && (Number(inv.amount) || 0) > 0).map(inv => ({ id: inv.id, invoice_number: inv.invoice_number, amount: Number(inv.amount) || 0, tax_amount: taxOf(inv), billing_kind: inv.billing_kind || 'arrears' }));
  return { unposted, invoices_owed: Math.round(owed * 100) / 100, ledger_receivable: ar, difference, unposted_invoices: unpostedInvoices, unposted_payments: unpostedPayments,
    tied_out: Math.abs(difference) < 0.005 && unpostedInvoices === 0 && unpostedPayments === 0,
    gap: 'Sales tax is posted only on invoices where tax is set. Any other invoice posts its whole amount as revenue.' };
}

// Advance billing. The deposit is the posted amount less what has been earned. Earning posts Dr 2200 deposits / Cr 4000 revenue.
function depositOf(db, invoiceId) {
  const inv = db.prepare('SELECT id, amount, billing_kind FROM invoices WHERE id=?').get(Number(invoiceId));
  if (!inv) throw new Error('Invoice not found.');
  const posted = postedEntry(db, 'invoice', 'invoice:' + inv.id);
  const deposited = posted && inv.billing_kind === 'advance' ? Number(inv.amount) || 0 : 0;
  const earned = Number(db.prepare("SELECT COALESCE(SUM(l.debit_cents),0) v FROM ledger_lines l JOIN ledger_entries e ON e.id=l.entry_id WHERE e.source='earned' AND e.source_ref LIKE ? AND l.account_code='2200'").get('earned:' + inv.id + ':%').v) / 100;
  return { invoice_id: inv.id, billing_kind: inv.billing_kind || 'arrears', posted: !!posted, deposited: r2(deposited), earned: r2(earned), remaining: r2(deposited - earned) };
}
function earnDeposit(db, { invoiceId, amount, date, note, by }) {
  const d = depositOf(db, invoiceId);
  const amt = r2(amount);
  if (d.billing_kind !== 'advance') throw new Error('Only an advance invoice has a deposit to earn.');
  if (!d.posted) throw new Error('The invoice is not on the ledger yet, so there is no deposit to earn.');
  if (!(amt > 0)) throw new Error('Enter the amount earned, above zero.');
  if (amt > d.remaining + 0.005) throw new Error(`Only ${d.remaining.toFixed(2)} of the deposit is left to earn.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('Enter the date the work was done (YYYY-MM-DD).');
  const id = L.postEntry(db, { date, memo: 'Earned from deposit on invoice ' + d.invoice_id + (note ? ': ' + String(note).slice(0, 120) : ''), source: 'earned', sourceRef: 'earned:' + d.invoice_id + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8), by: by || 'receivables',
    lines: [{ account: '2200', debit: amt }, { account: '4000', credit: amt }] });
  require('./audit').record(db, { actor: by, action: 'earned deposit', entity: 'invoice', entityId: d.invoice_id, detail: amt.toFixed(2) + ' earned ' + date });
  return id;
}

// The whole ledger sync: invoices, payments, bills, job costs, unassigned payroll and burden. Safe to run again.
function runSync(db, by) {
  const out = syncAll(db);
  const ex = require('./expenses').syncRecorded(db);
  const result = { invoices_posted: out.invoices_posted, invoices_reversed: out.invoices_reversed, payments_posted: out.payments_posted, payments_held: out.payments_held,
    bills_posted: ex.bills_posted, project_costs_posted: ex.project_costs_posted, payroll_posted: ex.payroll_posted, burden_posted: ex.burden_posted || 0, errors: [...out.errors, ...ex.errors] };
  require('./audit').record(db, { actor: by, action: by === 'automatic' ? 'automatic ledger sync' : 'ran ledger sync', entity: 'ledger',
    detail: `invoices ${result.invoices_posted}, payments ${result.payments_posted}, held ${result.payments_held.length}, bills ${result.bills_posted}, job costs ${result.project_costs_posted}, payroll ${result.payroll_posted}, burden ${result.burden_posted}` });
  return result;
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  app.post('/api/admin/ledger/sync', auth, (req, res) => {
    try { res.json({ ok: true, ...runSync(db, req.user && req.user.email) }); }
    catch (e) { res.status(500).json({ error: 'The ledger sync failed: ' + e.message }); }
  });
  // Automatic posting (decision: the ledger posts on its own). Every 15 minutes by default; LEDGER_AUTO_SYNC_MS=0 turns it off.
  const every = Number(process.env.LEDGER_AUTO_SYNC_MS);
  const interval = every === 0 ? 0 : (every > 0 ? every : 15 * 60 * 1000);
  let busy = false;
  if (interval) {
    const tick = () => { if (busy) return; busy = true; try { runSync(db, 'automatic'); } catch (e) { console.error('automatic ledger sync failed:', e.message); } finally { busy = false; } };
    const t = setInterval(tick, interval); t.unref();
  }
  app.post('/api/admin/invoices/:id/tax', auth, (req, res) => {
    ensureTaxColumn(db);
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(Number(req.params.id));
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const body = req.body || {};
    const exemptReason = String(body.tax_exempt_reason || '').trim().slice(0, 300);
    const tax = exemptReason ? 0 : (body.tax_amount === undefined ? taxOf(inv) : Number(body.tax_amount));
    if (!Number.isFinite(tax) || tax < 0 || tax > 1e7) return res.status(400).json({ error: 'Sales tax must be zero or more.' });
    const kind = body.billing_kind === undefined ? (inv.billing_kind || 'arrears') : String(body.billing_kind);
    if (!['arrears', 'advance'].includes(kind)) return res.status(400).json({ error: 'Billing must be arrears (work done) or advance (paid ahead).' });
    if (postedEntry(db, 'invoice', 'invoice:' + inv.id)) return res.status(409).json({ error: 'This invoice is already on the ledger. Void it and issue a corrected invoice to change its tax or billing.' });
    db.prepare('UPDATE invoices SET tax_amount=?, billing_kind=?, tax_exempt_reason=? WHERE id=?').run(Math.round(tax * 100) / 100, kind, exemptReason || null, inv.id);
    require('./audit').record(db, { actor: req.user && req.user.email, action: 'set sales tax', entity: 'invoice', entityId: inv.id, detail: 'sales tax ' + (Math.round(tax * 100) / 100).toFixed(2) + ' (was ' + Number(inv.tax_amount || 0).toFixed(2) + ')' });
    res.json({ ok: true, tax_amount: Math.round(tax * 100) / 100 });
  });
  // Advance billing: how much of an invoice is still held as a deposit, and earning part of it as work is done.
  app.get('/api/admin/invoices/:id/tax-suggestion', auth, (req, res) => {
    ensureTaxColumn(db);
    const inv = db.prepare('SELECT id, amount, tax_exempt_reason FROM invoices WHERE id=?').get(Number(req.params.id));
    if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
    const rate = taxRatePct(db);
    res.json({ rate_pct: rate, suggested: Math.round((Number(inv.amount) || 0) * rate) / 100, exempt_reason: inv.tax_exempt_reason || null,
      note: 'Iowa state rate for nonresidential janitorial and building cleaning. Not charged on cleaning tied to new construction or remodeling, or on residential cleaning paid by the occupant. Local option taxes are not included.' });
  });
  app.get('/api/admin/invoices/:id/deposit', auth, (req, res) => { try { res.json(depositOf(db, req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); } });
  app.post('/api/admin/invoices/:id/earn', auth, (req, res) => {
    try { res.status(201).json({ ok: true, entry: earnDeposit(db, { invoiceId: req.params.id, amount: (req.body || {}).amount, date: (req.body || {}).date, note: (req.body || {}).note, by: req.user && req.user.email }) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  // Remove a payment that is NOT on the ledger (held, for example a test row with no invoice). Owner only, reason required.
  // A payment that is on the ledger must be reversed instead, so the books keep a record.
  app.delete('/api/admin/payments/:id', auth, (req, res) => {
    const p = db.prepare('SELECT * FROM payments WHERE id=?').get(Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'Payment not found.' });
    if (postedEntry(db, 'payment', 'payment:' + p.id)) {
      // Refused attempts are kept in the audit trail too, so a try to remove a posted payment is visible.
      require('./audit').record(db, { actor: req.user && req.user.email, action: 'refused payment removal', entity: 'payment', entityId: p.id, detail: `${Number(p.amount).toFixed(2)} for invoice ${p.invoice_id}: payment is on the ledger, reversal required` });
      return res.status(409).json({ error: 'This payment is on the ledger. Reverse its entry instead.' });
    }
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) return res.status(400).json({ error: 'Give the reason for removing this payment.' });
    // Take the payment back off the invoice too, so its paid amount and status match the payments that remain.
    db.transaction(() => {
      db.prepare('DELETE FROM payments WHERE id=?').run(p.id);
      const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(p.invoice_id);
      if (!inv) return;
      const paid = Math.max(0, Math.round((Number(inv.paid_amount || 0) - Number(p.amount || 0)) * 100) / 100);
      const billed = Math.round((Number(inv.amount || 0) + Number(inv.tax_amount || 0)) * 100) / 100;
      let status = inv.status;
      if (paid <= 0.005 && ['Paid', 'Partially Paid'].includes(status)) status = 'Sent';
      else if (status === 'Paid' && paid < billed - 0.005) status = 'Partially Paid';
      db.prepare('UPDATE invoices SET paid_amount=?, status=? WHERE id=?').run(paid, status, inv.id);
    })();
    require('./audit').record(db, { actor: req.user && req.user.email, action: 'deleted unposted payment', entity: 'payment', entityId: p.id, detail: `${Number(p.amount).toFixed(2)} for invoice ${p.invoice_id}: ${reason}` });
    res.json({ ok: true });
  });
  app.get('/api/admin/receivables/tie-out', auth, (req, res) => res.json(tieOut(db)));
}

module.exports = { postInvoice, postPayment, syncAll, runSync, tieOut, depositOf, earnDeposit, mount };
