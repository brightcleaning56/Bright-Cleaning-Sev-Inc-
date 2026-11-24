// Vendors and aging reports (audit G12 and G4): a vendor list for bills, receivables aging by how overdue each invoice is,
// and payables aging by the age of each open bill. Aging reads the same balances as the ledger and the tie-out.

const R = require('./receivables');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hasCol = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS vendors(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, contact TEXT, email TEXT, phone TEXT,
    created_at TEXT NOT NULL)`);
}

function ensureVendor(db, name, extra = {}) {
  ensureSchema(db);
  const clean = String(name || '').trim().slice(0, 200);
  if (!clean) throw new Error('A vendor needs a name.');
  const found = db.prepare('SELECT id FROM vendors WHERE name=? COLLATE NOCASE').get(clean);
  if (found) return found.id;
  return db.prepare('INSERT INTO vendors(name,contact,email,phone,created_at) VALUES(?,?,?,?,?)')
    .run(clean, String(extra.contact || '').slice(0, 200) || null, String(extra.email || '').slice(0, 254) || null, String(extra.phone || '').slice(0, 60) || null, new Date().toISOString()).lastInsertRowid;
}

// Age in whole days from a date to the as-of date (negative when the date is later).
const daysBetween = (from, to) => Math.floor((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5);
const BUCKETS = ['current', '1-30', '31-60', '61-90', 'over-90'];
function bucketOf(days) {
  if (days <= 0) return 'current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return 'over-90';
}
const emptyBuckets = () => Object.fromEntries(BUCKETS.map(b => [b, 0]));

// Receivables: what each open invoice still owes, by days past its due date (or its issue date when no due date is set).
function arAging(db, { asOf }) {
  if (!isDate(asOf)) throw new Error('as_of must be a date (YYYY-MM-DD).');
  if (!hasTable(db, 'invoices')) return { as_of: asOf, rows: [], totals: emptyBuckets(), total: 0 };
  const hasDue = hasCol(db, 'invoices', 'due_date');
  const invoices = db.prepare(`SELECT id, invoice_number, customer_name, status, amount, issue_date, created_at${hasDue ? ', due_date' : ''} FROM invoices WHERE status NOT IN ('Draft','Void')`).all();
  const rows = [];
  const totals = emptyBuckets();
  for (const inv of invoices) {
    const owed = R.invoiceBalance(db, inv.id).owed;
    if (!(owed > 0.005)) continue;
    const due = (hasDue && inv.due_date) || (inv.issue_date || String(inv.created_at || '').slice(0, 10) || asOf);
    const days = daysBetween(due, asOf);
    const b = bucketOf(days);
    totals[b] = r2(totals[b] + owed);
    rows.push({ invoice_id: inv.id, invoice_number: inv.invoice_number, customer: inv.customer_name || '', due_date: due, days_past_due: Math.max(0, days), owed: r2(owed), bucket: b });
  }
  const total = r2(Object.values(totals).reduce((s, v) => s + v, 0));
  return { as_of: asOf, rows: rows.sort((a, c) => c.days_past_due - a.days_past_due), totals, total };
}

// Payables: open bills by age from the bill date, grouped by vendor.
function apAging(db, { asOf }) {
  if (!isDate(asOf)) throw new Error('as_of must be a date (YYYY-MM-DD).');
  if (!hasTable(db, 'expense_bills')) return { as_of: asOf, vendors: [], totals: emptyBuckets(), total: 0 };
  const bills = db.prepare("SELECT id, vendor, amount, bill_date FROM expense_bills WHERE status='Open' AND bill_date <= ?").all(asOf);
  const byVendor = new Map();
  const totals = emptyBuckets();
  for (const b of bills) {
    const days = daysBetween(b.bill_date, asOf);
    const bk = bucketOf(days);
    const key = String(b.vendor || '').trim().toLowerCase();
    if (!byVendor.has(key)) byVendor.set(key, { vendor: b.vendor, buckets: emptyBuckets(), total: 0 });
    const v = byVendor.get(key);
    v.buckets[bk] = r2(v.buckets[bk] + Number(b.amount));
    v.total = r2(v.total + Number(b.amount));
    totals[bk] = r2(totals[bk] + Number(b.amount));
  }
  const vendors = [...byVendor.values()].sort((a, c) => c.total - a.total);
  return { as_of: asOf, vendors, totals, total: r2(Object.values(totals).reduce((s, v) => s + v, 0)) };
}

function listVendors(db) {
  ensureSchema(db);
  return { vendors: db.prepare('SELECT * FROM vendors ORDER BY name COLLATE NOCASE').all() };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  ensureSchema(db);
  const run = (res, fn) => { try { res.json(fn()); } catch (e) { res.status(400).json({ error: e.message }); } };
  app.get('/api/admin/vendors', auth, (req, res) => run(res, () => listVendors(db)));
  app.post('/api/admin/vendors', auth, (req, res) => run(res, () => {
    const b = req.body || {};
    const id = ensureVendor(db, b.name, { contact: b.contact, email: b.email, phone: b.phone });
    return { ok: true, id };
  }));
  app.get('/api/admin/ledger/ar-aging', auth, (req, res) => run(res, () => arAging(db, { asOf: String(req.query.as_of || require('./bizdate').today()) })));
  app.get('/api/admin/ledger/ap-aging', auth, (req, res) => run(res, () => apAging(db, { asOf: String(req.query.as_of || require('./bizdate').today()) })));
}

module.exports = { ensureSchema, ensureVendor, arAging, apAging, listVendors, bucketOf, mount };
