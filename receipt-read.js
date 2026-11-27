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
  const bill = db.prepare('SELECT id, vendor, amount, ai_read FROM expense_bills WHERE id=?').get(Number(billId));
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
  const prev = parseStored(bill.ai_read);
  // Keep an earlier category suggestion; a new reading does not discard it.
  const stored = { ...reading, model: model || null, at: new Date().toISOString(), status: 'suggestion', ...(prev.category_suggestion ? { category_suggestion: prev.category_suggestion } : {}) };
  db.prepare('UPDATE expense_bills SET ai_read=? WHERE id=?').run(JSON.stringify(stored), bill.id);
  return stored;
}

// Category suggestions (Phase 3). The AI picks from the bookkeeping list below. It is stored next to the
// receipt reading as a suggestion; the bill's category changes only when a person applies it.
// These match the job-cost accounts (job-cost.js CATEGORY_ACCOUNT): a job receipt must land in a job cost account.
// Insurance, rent of space, utilities and software are overhead, not job cost, so they are not offered here.
const CATEGORIES = ['Materials', 'Equipment', 'Travel or fuel', 'Subcontractor', 'Other'];
function parseStored(s) { try { return s ? JSON.parse(s) || {} : {}; } catch { return {}; } }
async function suggestCategory({ db, billId, uploadDir, callFn, model }) {
  ensureSchema(db);
  const bill = db.prepare('SELECT id, ai_read FROM expense_bills WHERE id=?').get(Number(billId));
  if (!bill) throw new Error('Bill not found.');
  const r = receiptPath(db, Number(billId), uploadDir);
  if (!r) throw new Error('Attach a receipt photo or PDF to this bill first.');
  const size = fs.statSync(r.path).size;
  if (size > MAX_BYTES) throw new Error('This receipt file is over 20 MB. Attach a smaller photo or PDF.');
  const block = contentBlockFor(r.name, fs.readFileSync(r.path));
  const reply = await callFn([{ role: 'user', content: [block, { type: 'text', text:
    `Suggest the expense category for this receipt. Return ONLY JSON: {"category": one of ${JSON.stringify(CATEGORIES)}, "confidence": a number from 0 to 1, "reason": a short phrase}. ` +
    `If you are not sure, use "Other" with a low confidence.` }] }],
    'You categorize business expenses for Bright Cleaning Sev Inc. Use only what the receipt shows.', 400);
  const p = parseReply(reply);
  const category = CATEGORIES.includes(p.category) ? p.category : 'Other';
  const confidence = Math.round(Math.max(0, Math.min(1, Number(p.confidence) || 0)) * 100) / 100;
  const sugg = { category, confidence, reason: text(p.reason, 200), model: model || null, at: new Date().toISOString(), status: 'suggestion' };
  db.prepare('UPDATE expense_bills SET ai_read=? WHERE id=?').run(JSON.stringify({ ...parseStored(bill.ai_read), category_suggestion: sugg }), bill.id);
  return sugg;
}

// Auto-fill for a new upload: one AI call reads the receipt and suggests its category, before any bill exists.
// Returns only what the receipt shows; missing fields come back null. Nothing is saved here.
async function autoFill({ name, buf, callFn, model }) {
  if (buf.length > MAX_BYTES) throw new Error('This receipt file is over 20 MB. Attach a smaller photo or PDF.');
  const block = contentBlockFor(name, buf);
  const reply = await callFn([{ role: 'user', content: [block, { type: 'text', text:
    `Fill in the expense bill from this receipt. The file is named "${text(name, 200)}". Return ONLY JSON with keys: ` +
    `"vendor" (the store or company), "date" (YYYY-MM-DD or null), "total" (number, the amount paid), ` +
    `"category" (one of ${JSON.stringify(CATEGORIES)}), "confidence" (0 to 1), "reason" (short phrase). ` +
    `Use null for anything not printed on the receipt. Do not guess.` }] }],
    'You read receipts for Bright Cleaning Sev Inc. Only report what is printed on the receipt.', 500);
  const p = parseReply(reply);
  const category = CATEGORIES.includes(p.category) ? p.category : 'Other';
  const confidence = Math.round(Math.max(0, Math.min(1, Number(p.confidence) || 0)) * 100) / 100;
  return {
    vendor: text(p.vendor, 160) || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? p.date : null,
    total: money(p.total),
    category, confidence, reason: text(p.reason, 200), model: model || null, at: new Date().toISOString(), status: 'suggestion',
  };
}

module.exports = { readReceipt, suggestCategory, autoFill, CATEGORIES, contentBlockFor, parseReply, shapeReading, ensureSchema };
