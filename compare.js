// Reconciles the existing Reports figures with the ledger for the same period (audit G16). Read only.
// The existing side uses the same definitions as the finance report (invoices by issue day, paid amount stored on each invoice,
// project costs by cost date, approved time not tied to a project). The ledger side uses posted entries in the same dates.
// Each difference is listed with the reason, so the owner can decide which basis the reports should use.

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

function existingFigures(db, from, to) {
  const inv = hasTable(db, 'invoices') ? db.prepare(`SELECT amount, paid_amount, COALESCE(issue_date, substr(created_at,1,10)) AS day FROM invoices WHERE status NOT IN ('Draft','Void')`).all()
    .filter(i => i.day >= from && i.day <= to) : [];
  const invoiced = r2(inv.reduce((s, i) => s + (Number(i.amount) || 0), 0));
  const collected = r2(inv.reduce((s, i) => s + Math.min(Number(i.paid_amount) || 0, Number(i.amount) || 0), 0));
  const costs = hasTable(db, 'project_costs') ? db.prepare('SELECT COALESCE(SUM(amount),0) v FROM project_costs WHERE cost_date BETWEEN ? AND ?').get(from, to).v : 0;
  const unposted = (hasTable(db, 'time_entries') && hasTable(db, 'employees')) ? db.prepare(`SELECT COALESCE(SUM(t.minutes/60.0*COALESCE(t.labor_rate, e.hourly_rate)),0) v FROM time_entries t JOIN employees e ON e.id=t.employee_id
    WHERE t.approved_by IS NOT NULL AND t.cost_id IS NULL AND t.clock_in >= ? AND t.clock_in < ?`).get(from, to + 'T99').v : 0;
  return { invoiced, collected: r2(collected), costs: r2(Number(costs) + Number(unposted)) };
}

function ledgerFigures(db, from, to) {
  const sumWhere = (sql, args) => Number(db.prepare(sql).get(...args).v) || 0;
  const revenue = sumWhere(`SELECT COALESCE(SUM(l.credit_cents - l.debit_cents),0) v FROM ledger_lines l JOIN ledger_entries e ON e.id=l.entry_id WHERE l.account_code='4000' AND e.entry_date BETWEEN ? AND ?`, [from, to]) / 100;
  const discounts = sumWhere(`SELECT COALESCE(SUM(l.debit_cents - l.credit_cents),0) v FROM ledger_lines l JOIN ledger_entries e ON e.id=l.entry_id WHERE l.account_code='4900' AND e.entry_date BETWEEN ? AND ?`, [from, to]) / 100;
  const cashIn = sumWhere(`SELECT COALESCE(SUM(l.debit_cents - l.credit_cents),0) v FROM ledger_lines l JOIN ledger_entries e ON e.id=l.entry_id WHERE l.account_code='1000' AND e.source='payment' AND e.entry_date BETWEEN ? AND ?`, [from, to]) / 100;
  const costs = sumWhere(`SELECT COALESCE(SUM(l.debit_cents - l.credit_cents),0) v FROM ledger_lines l JOIN ledger_entries e ON e.id=l.entry_id WHERE l.account_code LIKE '5%' AND e.entry_date BETWEEN ? AND ?`, [from, to]) / 100;
  const bills = sumWhere(`SELECT COALESCE(SUM(l.debit_cents - l.credit_cents),0) v FROM ledger_lines l JOIN ledger_entries e ON e.id=l.entry_id WHERE l.account_code IN ('6000','6100') AND e.entry_date BETWEEN ? AND ?`, [from, to]) / 100;
  return { invoiced: r2(revenue), discounts: r2(discounts), collected: r2(cashIn), costs: r2(costs), operating: r2(bills) };
}

function compare(db, { from, to }) {
  if (!isDate(from) || !isDate(to)) throw new Error('from and to must be real dates (YYYY-MM-DD).');
  if (from > to) throw new Error('from must be on or before to.');
  const ex = existingFigures(db, from, to), lg = ledgerFigures(db, from, to);
  const row = (metric, existing, ledger, why) => ({ metric, existing, ledger, difference: r2(ledger - existing), agrees: Math.abs(ledger - existing) < 0.005, why });
  const rows = [
    row('Invoiced (revenue)', ex.invoiced, lg.invoiced, 'Existing counts invoice amounts by issue day, excluding tax. The ledger posts the same amounts, except voided and tax-bearing invoices, which the ledger books to tax payable.'),
    row('Collected', ex.collected, lg.collected, 'Existing uses the paid amount stored on each invoice. The ledger uses payment entries. They differ when a payment was recorded but the invoice paid amount was not updated, or when a payment is not yet on the ledger.'),
    row('Costs', ex.costs, lg.costs, 'Existing counts project costs by cost date plus approved time not on a project. The ledger counts job costs (5xxx). Unassigned payroll (6100) and vendor bills (6000) are operating expenses on the ledger, so they are not in this line; burden appears only when the owner sets a rate.'),
  ];
  return { from, to, rows,
    not_in_existing_reports: [
      { metric: 'Discounts and customer credits', amount: lg.discounts, note: 'Credit notes reduce revenue on the ledger. Existing reports do not show them.' },
      { metric: 'Operating expenses (bills)', amount: lg.operating, note: 'Vendor bills are operating expenses on the ledger. Existing job cost does not include them.' }],
    agrees_overall: rows.every(r => r.agrees),
    decision: 'Once the owner chooses the basis (see docs/ACCOUNTING_SPEC.md), the Reports page should read the ledger figures.' };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  app.get('/api/admin/ledger/compare', auth, (req, res) => {
    try { res.json(compare(db, { from: String(req.query.from || ''), to: String(req.query.to || '') })); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { compare, existingFigures, ledgerFigures, mount };
