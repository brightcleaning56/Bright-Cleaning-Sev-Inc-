// Checks receipt files on bills (audit G11): attach, keep the original name, download only when the file exists, audit trail.
// Run: node tests/receipt-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const L = require('../ledger');
const E = require('../expenses');

const db = new Database(':memory:');
db.exec(`CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);`);
L.seedChart(db);
const billId = E.createBill(db, { vendor: 'Glass Co', description: 'Squeegees', amount: 80, bill_date: '2026-11-26' }, 'staff@test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-receipts-'));
const stored = 'a1b2c3-receipt.pdf';
fs.writeFileSync(path.join(dir, stored), 'receipt contents');

assert.strictEqual(E.receiptPath(db, billId, dir), null, 'no receipt yet');
const r = E.attachReceipt(db, { billId, file: { filename: stored, originalname: 'Glass Co invoice 0042.pdf' }, by: 'owner@test', uploadDir: dir });
assert.strictEqual(r.receipt, 'Glass Co invoice 0042.pdf', 'the original name is kept');
const got = E.receiptPath(db, billId, dir);
assert.strictEqual(got.path, path.join(dir, stored), 'the stored file is found');
assert.strictEqual(got.name, 'Glass Co invoice 0042.pdf', 'download uses the original name');
console.log('ok - receipt attached; the original name is kept and the file can be downloaded');

// The reference the bill already had is kept; the file is added alongside it.
const billRef = E.createBill(db, { vendor: 'Mop Co', description: 'Mops', amount: 40, bill_date: '2026-11-26', receipt_ref: 'paper-receipt-7' }, 'staff@test');
E.attachReceipt(db, { billId: billRef, file: { filename: stored, originalname: 'scan.pdf' }, by: 'owner@test', uploadDir: dir });
assert.strictEqual(db.prepare('SELECT receipt_ref FROM expense_bills WHERE id=?').get(billRef).receipt_ref, 'paper-receipt-7', 'an existing reference is not overwritten');
console.log('ok - an existing receipt reference is kept');

// A stored file that has gone missing is reported as no receipt; a bad or missing file is refused.
fs.unlinkSync(path.join(dir, stored));
assert.strictEqual(E.receiptPath(db, billId, dir), null, 'a missing file is not offered');
assert.throws(() => E.attachReceipt(db, { billId, file: null, by: 'owner@test', uploadDir: dir }), /Choose a receipt file/);
assert.throws(() => E.attachReceipt(db, { billId: 9999, file: { filename: 'x', originalname: 'x' }, by: 'owner@test', uploadDir: dir }), /Bill not found/);
console.log('ok - a missing file is not offered; bad attaches are refused');

// The attach is in the audit trail.
const ev = db.prepare("SELECT action FROM accounting_audit_events").all().map(x => x.action);
assert.ok(ev.includes('attached receipt'), 'attaching is recorded');
console.log('ok - attaching a receipt is in the audit trail');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\nAll receipt checks passed.');
