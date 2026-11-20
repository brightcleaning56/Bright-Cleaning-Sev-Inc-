// Checks the ledger exports: CSV escaping, formula protection, journal and trial balance contents.
// Run: node tests/exports-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const L = require('../ledger');
const X = require('../exports');

const db = new Database(':memory:');
L.seedChart(db);
L.postEntry(db, { date: '2026-11-20', memo: 'Invoice 1, Waco Place, "final" clean', source: 'invoice', sourceRef: 'invoice:1', lines: [{ account: '1100', debit: 50000 }, { account: '4000', credit: 50000 }] });
L.postEntry(db, { date: '2026-11-21', memo: '=HYPERLINK("x")', source: 'payment', sourceRef: 'payment:1', lines: [{ account: '1000', debit: 25000 }, { account: '1100', credit: 25000 }] });

// Cells with commas, quotes or formulas are safe to open in a spreadsheet.
assert.strictEqual(X.cell('plain'), 'plain');
assert.strictEqual(X.cell('a,b'), '"a,b"');
assert.strictEqual(X.cell('say "hi"'), '"say ""hi"""');
assert.strictEqual(X.cell('=1+1'), "'=1+1");
assert.strictEqual(X.cell('-5'), "'-5");
console.log('ok - CSV cells are quoted and formula-like text is neutralised');

// Journal: a header, one row per line, and the quoted memo survives.
const j = X.journalCsv(db);
const lines = j.trim().split('\r\n');
assert.strictEqual(lines[0], 'entry_id,date,memo,source,source_ref,account,account_name,debit,credit');
assert.strictEqual(lines.length, 5, 'four lines plus the header');
assert.ok(lines[1].includes('"Invoice 1, Waco Place, ""final"" clean"'), 'quoted memo: ' + lines[1]);
assert.ok(lines.some(l => l.includes("'=HYPERLINK")), 'formula memo neutralised');
const onlyNov21 = X.journalCsv(db, { from: '2026-11-21', to: '2026-11-21' }).trim().split('\r\n');
assert.strictEqual(onlyNov21.length, 3, 'date range keeps only that day (header plus two lines)');
console.log('ok - journal export has the header, quoted memos, and date ranges');

// Trial balance: balances and says so; totals match.
const tb = X.trialBalanceCsv(db).trim().split('\r\n');
assert.strictEqual(tb[0], 'account,name,type,debit,credit,balance');
assert.ok(tb[tb.length - 1].endsWith('balanced'), 'totals line says balanced');
console.log('ok - trial balance export balances');

// Sales tax: nothing posted yet, and the summary says so.
const st = X.salesTaxSummary(db);
assert.strictEqual(st.sales_tax_payable, 0);
assert.ok(/not posted yet/.test(st.note));
console.log('ok - sales tax summary reports the gap honestly');

console.log('\nAll export checks passed.');
