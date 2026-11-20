// Exports from Bright Clean's ledger (Phase 8 of the accounting plan): the journal and the trial balance as CSV,
// plus a sales tax summary. Exports only read; they change nothing.
// CSV cells that start with = + - @ get a leading apostrophe, so a spreadsheet cannot run them as formulas.

const L = require('./ledger');

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csv = rows => rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';

function journalCsv(db, { from = null, to = null } = {}) {
  if (from && !isDate(from)) throw new Error('from must be a date (YYYY-MM-DD).');
  if (to && !isDate(to)) throw new Error('to must be a date (YYYY-MM-DD).');
  const conds = [], args = [];
  if (from) { conds.push('e.entry_date >= ?'); args.push(from); }
  if (to) { conds.push('e.entry_date <= ?'); args.push(to); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT e.id entry_id, e.entry_date, e.memo, e.source, e.source_ref, l.account_code, a.name account_name, l.debit_cents, l.credit_cents
    FROM ledger_entries e JOIN ledger_lines l ON l.entry_id=e.id JOIN ledger_accounts a ON a.code=l.account_code
    ${where} ORDER BY e.entry_date, e.id, l.id`).all(...args);
  const out = [['entry_id', 'date', 'memo', 'source', 'source_ref', 'account', 'account_name', 'debit', 'credit']];
  for (const r of rows) out.push([r.entry_id, r.entry_date, r.memo, r.source, r.source_ref || '', r.account_code, r.account_name, (r.debit_cents / 100).toFixed(2), (r.credit_cents / 100).toFixed(2)]);
  return csv(out);
}

function trialBalanceCsv(db, { asOf = null } = {}) {
  const tb = L.trialBalance(db, { asOf });
  const out = [['account', 'name', 'type', 'debit', 'credit', 'balance']];
  for (const a of tb.accounts) out.push([a.code, a.name, a.type, a.debit.toFixed(2), a.credit.toFixed(2), a.balance.toFixed(2)]);
  out.push(['', 'Totals', '', tb.total_debit.toFixed(2), tb.total_credit.toFixed(2), tb.balanced ? 'balanced' : 'NOT BALANCED']);
  return csv(out);
}

// Sales tax: the payable account (2100), as posted. Tax is posted only where an invoice has tax set.
function salesTaxSummary(db, { asOf = null } = {}) {
  const acct = L.trialBalance(db, { asOf }).accounts.find(a => a.code === '2100');
  return {
    as_of: asOf, sales_tax_payable: r2(acct ? acct.balance : 0),
    note: 'Sales tax is posted only on invoices where tax is set. Invoices without tax set post their whole amount as revenue.'
  };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  L.seedChart(db);
  const send = (res, name, body) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send(body); };
  const fail = (res, e) => res.status(400).json({ error: e.message });
  app.get('/api/admin/ledger/export/journal.csv', auth, (req, res) => { try { send(res, 'journal.csv', journalCsv(db, { from: req.query.from || null, to: req.query.to || null })); } catch (e) { fail(res, e); } });
  app.get('/api/admin/ledger/export/trial-balance.csv', auth, (req, res) => { try { send(res, 'trial-balance.csv', trialBalanceCsv(db, { asOf: req.query.as_of || null })); } catch (e) { fail(res, e); } });
  app.get('/api/admin/ledger/sales-tax', auth, (req, res) => { try { res.json(salesTaxSummary(db, { asOf: req.query.as_of || null })); } catch (e) { fail(res, e); } });
}

module.exports = { journalCsv, trialBalanceCsv, salesTaxSummary, cell, mount };
