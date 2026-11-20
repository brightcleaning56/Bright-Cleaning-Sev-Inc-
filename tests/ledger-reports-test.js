// Checks the financial statements read from the ledger: profit and loss, balance sheet, cash movements, date ranges.
// Run: node tests/ledger-reports-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const R = require('../ledger-reports');

const db = new Database(':memory:');
L.seedChart(db);
// The audit's worked example, posted as the modules would post it.
L.postEntry(db, { date: '2026-11-20', memo: 'Invoice 1', source: 'invoice', sourceRef: 'invoice:1', lines: [{ account: '1100', debit: 50000 }, { account: '4000', credit: 50000 }] });
L.postEntry(db, { date: '2026-11-21', memo: 'Payment', source: 'payment', sourceRef: 'payment:1', lines: [{ account: '1000', debit: 25000 }, { account: '1100', credit: 25000 }] });
L.postEntry(db, { date: '2026-11-22', memo: 'Job labor', source: 'project-cost', sourceRef: 'project-cost:1', lines: [{ account: '5000', debit: 12000 }, { account: '2300', credit: 12000 }] });
L.postEntry(db, { date: '2026-11-22', memo: 'Job materials and equipment', source: 'project-cost', sourceRef: 'project-cost:2', lines: [{ account: '5100', debit: 2000 }, { account: '5200', debit: 1000 }, { account: '5300', debit: 3000 }, { account: '5400', debit: 1000 }, { account: '2000', credit: 7000 }] });

// Profit and loss for the whole period.
const pl = R.profitAndLoss(db);
assert.strictEqual(pl.revenue_total, 50000, 'revenue');
assert.strictEqual(pl.cost_of_services_total, 19000, 'cost of services');
assert.strictEqual(pl.gross_profit, 31000, 'gross profit 31,000');
assert.strictEqual(pl.gross_margin_pct, 62, 'gross margin 62%');
assert.strictEqual(pl.operating_expenses_total, 0, 'no operating expenses in this example');
assert.strictEqual(pl.net_profit, 31000, 'net profit');
console.log('ok - P&L: revenue 50,000, cost of services 19,000, gross profit 31,000 (62%)');

// The same statement for only the day the costs were posted shows the cost without the revenue.
const day = R.profitAndLoss(db, { from: '2026-11-22', to: '2026-11-22' });
assert.strictEqual(day.revenue_total, 0);
assert.strictEqual(day.net_profit, -19000, 'date range counts only lines dated in the range');
console.log('ok - P&L for one day counts only that day');

// Balance sheet balances at the end of the period and at a date in the middle.
const bs = R.balanceSheet(db, { asOf: '2026-11-30' });
assert.strictEqual(bs.assets_total, 50000, 'assets = cash 25,000 + receivable 25,000');
assert.strictEqual(bs.liabilities_total, 19000, 'liabilities = payables 7,000 + accrued payroll 12,000');
assert.strictEqual(bs.earnings_to_date, 31000, 'earnings to date');
assert.strictEqual(bs.balances, true, 'assets = liabilities + equity + earnings');
const mid = R.balanceSheet(db, { asOf: '2026-11-21' });
assert.strictEqual(mid.assets_total, 50000, 'mid-period: cash 25,000 + receivable 25,000');
assert.strictEqual(mid.earnings_to_date, 50000, 'mid-period: costs not yet posted');
assert.strictEqual(mid.balances, true, 'mid-period balance sheet balances');
console.log('ok - balance sheet balances at period end and mid-period');

// Cash movements.
const cash = R.cashMovements(db);
assert.strictEqual(cash.cash_in, 25000);
assert.strictEqual(cash.cash_out, 0);
assert.strictEqual(cash.groups.find(g => g.source === 'payment').in, 25000, 'cash in grouped by source');
console.log('ok - cash movements grouped by source');

// Bad dates are refused.
assert.throws(() => R.profitAndLoss(db, { from: '2026-02-30' }), /from must be a date/);
assert.throws(() => R.balanceSheet(db, { asOf: 'yesterday' }), /as_of must be a date/);
console.log('ok - bad dates are refused');

console.log('\nAll ledger report checks passed.');
