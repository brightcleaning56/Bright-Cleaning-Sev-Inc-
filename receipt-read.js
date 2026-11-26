// Phase 3: AI reading of a receipt photo or PDF on a bill (docs/EXPENSE_SYSTEM_PLAN.md).
// The AI only suggests. It stores its reading on the bill in ai_read; it never changes the bill's
// vendor, amount, category, job or status, and nothing posts from it. A person confirms every change.
const fs = require('fs');
const path = require('path');
const { receiptPath } = require('./expenses');

const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_BYTES = 20 * 1024 * 1024;

function ensureSchema(db) {
  const cols = db.prepare('PRAGMA table_info(expense_bills)').all().map(c => c.name);
  if (!cols.includes('ai_read')) db.exec('ALTER TABLE expense_bills ADD COLUMN ai_read TEXT');
}

// Turns the stored file into the content block the Messages API expects. Refuses other file types.
function contentBlockFor(name, buf) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } };
  if (IMAGE_TYPES[ext]) return { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data: buf.toString('base64') } };
  throw new Error('AI reading works on a photo (JPG, PNG, GIF or WEBP) or a PDF of the receipt. Attach one of those.');
}

function parseReply(text) {
  const clean = String(text || '').replace(/```json|```/g, '');
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI reply was not in the expected format.');
  try { return JSON.parse(clean.slice(start, end + 1)); } catch { throw new Error('The AI reply was not in the expected format.'); }
}

const money = v => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const text = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Shapes the reply and adds the check a person needs most: does the receipt total match the bill?
function shapeReading(r, bill) {
  const total = money(r.total);
  const lines = (Array.isArray(r.line_items) ? r.line_items : []).slice(0, 60).map(l => ({
    description: text(l.description, 200), amount: money(l.amount), suggested_category: text(l.suggested_category, 60),
  }));
  return {
    vendor: text(r.vendor, 160), date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')) ? r.date : null,
    total, tax: money(r.tax), line_items: lines,
    total_matches_bill: total === null ? null : Math.abs(total - Number(bill.amount)) < 0.01,
    bill_amount: Number(bill.amount),
  };
}

// db: the app database. callFn(messages, system, maxTokens) -> reply text (the AI service).
async function readReceipt({ db, billId, uploadDir, callFn, model }) {
  ensureSchema(db);
  const bill = db.prepare('SELECT id, vendor, amount FROM expense_bills WHERE id=?').get(Number(billId));
  if (!bill) throw new Error('Bill not found.');
  const r = receiptPath(db, Number(billId), uploadDir);
  if (!r) throw new Error('Attach a receipt photo or PDF to this bill first.');
  const size = fs.statSync(r.path).size;
  if (size > MAX_BYTES) throw new Error('This receipt file is over 20 MB. Attach a smaller photo or PDF.');
  const block = contentBlockFor(r.name, fs.readFileSync(r.path));
  const reply = await callFn([{ role: 'user', content: [block, { type: 'text', text:
    `Read this receipt. Return ONLY JSON with keys: "vendor", "date" (YYYY-MM-DD or null), "total" (number), "tax" (number or null), ` +
    `"line_items" (array of {"description","amount","suggested_category"}). Use null for anything you cannot read. Do not guess; leave unclear values null.` }] }],
    'You read receipts for Bright Cleaning Sev Inc. Only report what is printed on the receipt.', 1200);
  const reading = shapeReading(parseReply(reply), bill);
  const stored = { ...reading, model: model || null, at: new Date().toISOString(), status: 'suggestion' };
  db.prepare('UPDATE expense_bills SET ai_read=? WHERE id=?').run(JSON.stringify(stored), bill.id);
  return stored;
}

module.exports = { readReceipt, contentBlockFor, parseReply, shapeReading, ensureSchema };
