// Phase 3: AI reading of a receipt. The AI suggests and stores a reading; it never changes the bill.
// Uses a stub in place of the AI service, so no network or key is needed.
// Run: node tests/receipt-read-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const L = require('../ledger');
const E = require('../expenses');
const R = require('../receipt-read');

const db = new Database(':memory:');
db.exec(`CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);`);
L.seedChart(db);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-read-'));

function bill(amount, file) {
  const id = E.createBill(db, { vendor: 'Glass Co', description: 'Squeegees', amount, bill_date: '2026-11-26' }, 'staff@test');
  if (file) {
    fs.writeFileSync(path.join(dir, file.stored), file.bytes);
    E.attachReceipt(db, { billId: id, file: { filename: file.stored, originalname: file.name }, by: 'owner@test', uploadDir: dir });
  }
  return id;
}

const reply = obj => async () => JSON.stringify(obj);

(async () => {
  // 1. A PDF receipt is read; the stored reading matches the bill and the bill itself is untouched.
  const b1 = bill(80, { stored: 'r1.pdf', name: 'Glass Co invoice.pdf', bytes: Buffer.from('%PDF-1.4 fake') });
  const before = db.prepare('SELECT vendor, amount, category, status FROM expense_bills WHERE id=?').get(b1);
  let sent = null;
  const got = await R.readReceipt({ db, billId: b1, uploadDir: dir, model: 'stub', callFn: async (messages) => {
    sent = messages; return JSON.stringify({ vendor: 'Glass Co', date: '2026-11-25', total: '$80.00', tax: 4.5, line_items: [{ description: 'Squeegee', amount: 80, suggested_category: 'Supplies' }] });
  } });
  assert.strictEqual(sent[0].content[0].type, 'document', 'a PDF is sent as a document');
  assert.strictEqual(got.total, 80, 'total is read');
  assert.strictEqual(got.total_matches_bill, true, 'a matching total is marked as matching');
  assert.strictEqual(got.status, 'suggestion', 'the reading is a suggestion');
  const after = db.prepare('SELECT vendor, amount, category, status, ai_read FROM expense_bills WHERE id=?').get(b1);
  assert.strictEqual(after.amount, before.amount, 'the bill amount is not changed');
  assert.strictEqual(after.status, before.status, 'the bill status is not changed');
  assert.ok(JSON.parse(after.ai_read).line_items.length === 1, 'the reading is stored on the bill');
  console.log('ok - a PDF receipt is read and stored as a suggestion; the bill is untouched');

  // 2. A total that differs from the bill is flagged for a person to check.
  const b2 = bill(75, { stored: 'r2.jpg', name: 'photo.jpg', bytes: Buffer.from([0xff, 0xd8, 0xff]) });
  const r2 = await R.readReceipt({ db, billId: b2, uploadDir: dir, callFn: reply({ vendor: 'Glass Co', total: 80, line_items: [] }) });
  assert.strictEqual(r2.total_matches_bill, false, 'a different total is flagged');
  console.log('ok - a total that differs from the bill is flagged');

  // 3. Unreadable or unsupported files are refused without calling the AI.
  const b3 = bill(20, { stored: 'r3.txt', name: 'notes.txt', bytes: Buffer.from('hello') });
  let called = false;
  await assert.rejects(R.readReceipt({ db, billId: b3, uploadDir: dir, callFn: async () => { called = true; return '{}'; } }), /photo .* or a PDF/);
  assert.strictEqual(called, false, 'the AI is not called for an unsupported file');
  console.log('ok - an unsupported file type is refused before the AI is called');

  // 4. No receipt attached: a clear message, no call.
  const b4 = bill(10, null);
  await assert.rejects(R.readReceipt({ db, billId: b4, uploadDir: dir, callFn: reply({}) }), /Attach a receipt/);
  console.log('ok - a bill with no receipt is refused');

  // 5. A reply that is not JSON is an error, and nothing is stored.
  const b5 = bill(30, { stored: 'r5.png', name: 'r5.png', bytes: Buffer.from([0x89, 0x50]) });
  await assert.rejects(R.readReceipt({ db, billId: b5, uploadDir: dir, callFn: async () => 'Sorry, I cannot read this.' }), /not in the expected format/);
  assert.strictEqual(db.prepare('SELECT ai_read FROM expense_bills WHERE id=?').get(b5).ai_read, null, 'a failed reading stores nothing');
  console.log('ok - a reply that is not JSON stores nothing');

  console.log('receipt read (AI suggestion): all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
