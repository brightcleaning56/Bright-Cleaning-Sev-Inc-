// Financial statements read from Bright Clean's ledger (Phase 6 of the accounting plan).
// Nothing here stores figures; every number is calculated from posted entries, so the reports always agree with each other.
//  - Profit and loss: revenue (4xxx), cost of services (5xxx), gross profit, operating expenses (6xxx), net profit.
//  - Balance sheet: assets (1xxx) = liabilities (2xxx) + equity (3xxx) + earnings to date. The check must be zero.
//  - Cash movements: what came into and went out of cash, grouped by the kind of entry that moved it.

const L = require('./ledger');

const money = c => Math.round(c) / 100;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// Sums each account's debits and credits, for entries dated within [from, to] (either bound may be null).
function sums(db, { from = null, to = null } = {}) {
  // Only lines of entries dated inside the range count. Every account still appears, with zero, when it has no such lines.
  const conds = [], args = [];
  if (from) { conds.push('entry_date >= ?'); args.push(from); }
  if (to) { conds.push('entry_date <= ?'); args.push(to); }
  const dated = conds.length ? ' AND l.entry_id IN (SELECT id FROM ledger_entries WHERE ' + conds.join(' AND ') + ')' : '';
  return db.prepare(`
    SELECT a.code, a.name, a.type, COALESCE(SUM(l.debit_cents),0) dr, COALESCE(SUM(l.credit_cents),0) cr
    FROM ledger_accounts a
    LEFT JOIN ledger_lines l ON l.account_code=a.code${dated}
    GROUP BY a.code, a.name, a.type ORDER BY a.code`).all(...args);
}

// Natural balance: credits minus debits for income, debits minus credits for everything else.
const naturalOf = r => (r.type === 'revenue' || r.type === 'liability' || r.type === 'equity') ? r.cr - r.dr : r.dr - r.cr;

function profitAndLoss(db, { from, to } = {}) {
  if (from && !isDate(from)) throw new Error('from must be a date (YYYY-MM-DD).');
  if (to && !isDate(to)) throw new Error('to must be a date (YYYY-MM-DD).');
  const rows = sums(db, { from, to });
  const pick = (test) => rows.filter(test).map(r => ({ code: r.code, name: r.name, amount: money(naturalOf(r)) })).filter(x => x.amount !== 0);
  const total = list => Math.round(list.reduce((s, x) => s + x.amount * 100, 0)) / 100;
  const revenue = pick(r => r.type === 'revenue');
  const costOfServices = pick(r => r.type === 'expense' && r.code.startsWith('5'));
  const operating = pick(r => r.type === 'expense' && !r.code.startsWith('5'));
  const rev = total(revenue), cos = total(costOfServices), opx = total(operating);
  return {
    from: from || null, to: to || null,
    revenue, revenue_total: rev,
    cost_of_services: costOfServices, cost_of_services_total: cos,
    gross_profit: Math.round((rev - cos) * 100) / 100,
    gross_margin_pct: rev > 0 ? Math.round((rev - cos) / rev * 10000) / 100 : null,
    operating_expenses: operating, operating_expenses_total: opx,
    net_profit: Math.round((rev - cos - opx) * 100) / 100,
    notes: ['Revenue is the invoice amount; sales tax is not separated yet.', 'Labor burden and overtime are not in the costs yet.']
  };
}

function balanceSheet(db, { asOf = null } = {}) {
  if (asOf && !isDate(asOf)) throw new Error('as_of must be a date (YYYY-MM-DD).');
  const rows = sums(db, { to: asOf });
  const group = t => rows.filter(r => r.type === t).map(r => ({ code: r.code, name: r.name, amount: money(naturalOf(r)) })).filter(x => x.amount !== 0);
  const total = list => Math.round(list.reduce((s, x) => s + x.amount * 100, 0)) / 100;
  const assets = group('asset'), liabilities = group('liability'), equity = group('equity');
  const earnings = Math.round(rows.filter(r => r.type === 'revenue' || r.type === 'expense').reduce((s, r) => s + naturalOf(r) * (r.type === 'revenue' ? 1 : -1), 0)) / 100;
  const A = total(assets), Lb = total(liabilities), E = total(equity);
  const check = Math.round((A - (Lb + E + earnings)) * 100) / 100;
  return { as_of: asOf || null, assets, assets_total: A, liabilities, liabilities_total: Lb, equity, equity_total: E,
    earnings_to_date: earnings, liabilities_and_equity_total: Math.round((Lb + E + earnings) * 100) / 100, balances: check === 0, difference: check };
}

// Cash in and out, grouped by the kind of entry (invoice payment, bill payment, and so on).
function cashMovements(db, { from, to } = {}) {
  if (from && !isDate(from)) throw new Error('from must be a date (YYYY-MM-DD).');
  if (to && !isDate(to)) throw new Error('to must be a date (YYYY-MM-DD).');
  const where = ['l.account_code=\'1000\''], args = [];
  if (from) { where.push('e.entry_date >= ?'); args.push(from); }
  if (to) { where.push('e.entry_date <= ?'); args.push(to); }
  const rows = db.prepare(`SELECT e.source, COALESCE(SUM(l.debit_cents),0) inn, COALESCE(SUM(l.credit_cents),0) out
    FROM ledger_lines l JOIN ledger_entries e ON e.id=l.entry_id WHERE ${where.join(' AND ')} GROUP BY e.source ORDER BY e.source`).all(...args);
  const groups = rows.map(r => ({ source: r.source, in: money(r.inn), out: money(r.out), net: money(r.inn - r.out) }));
  const totalIn = money(rows.reduce((s, r) => s + r.inn, 0)), totalOut = money(rows.reduce((s, r) => s + r.out, 0));
  return { from: from || null, to: to || null, groups, cash_in: totalIn, cash_out: totalOut, net_cash: Math.round((totalIn - totalOut) * 100) / 100 };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  L.seedChart(db);
  const ok = (res, fn) => { try { res.json(fn()); } catch (e) { res.status(400).json({ error: e.message }); } };
  app.get('/api/admin/ledger/pnl', auth, (req, res) => ok(res, () => profitAndLoss(db, { from: req.query.from || null, to: req.query.to || null })));
  app.get('/api/admin/ledger/balance-sheet', auth, (req, res) => ok(res, () => balanceSheet(db, { asOf: req.query.as_of || null })));
  app.get('/api/admin/ledger/cash', auth, (req, res) => ok(res, () => cashMovements(db, { from: req.query.from || null, to: req.query.to || null })));
}

module.exports = { profitAndLoss, balanceSheet, cashMovements, mount };
