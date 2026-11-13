// HTTP checks for archiving proposals and contracts, on a temporary database with a stub sign-in.
// Archived records stay on record, are read-only while archived, and can be restored. No mail is sent.
// Run: node tests/archive-test.js   (use the Node version that matches the installed better-sqlite3)
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const express = require(path.join(ROOT, 'node_modules', 'express'));
process.env.ADMIN_EMAIL = 'owner@example.com';
const estimating = require(path.join(ROOT, 'estimating'));
const results = []; const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { const ev = await fn(); results.push({ name, status: 'PASS', evidence: ev }); console.log('PASS  ' + name); }
  catch (e) { results.push({ name, status: 'FAIL', evidence: e.message }); console.log('FAIL  ' + name + '  -> ' + e.message); }
}

const file = path.join(os.tmpdir(), 'archive-routes-' + process.pid + '.db');
try { fs.unlinkSync(file); } catch {}
const db = new Database(file);
db.exec(`CREATE TABLE IF NOT EXISTS admin_users(id INTEGER PRIMARY KEY, email TEXT UNIQUE, role TEXT);
  CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS estimates(id INTEGER PRIMARY KEY AUTOINCREMENT,lead_id INTEGER,customer_name TEXT NOT NULL,company TEXT,email TEXT,project_name TEXT,site_address TEXT,scope TEXT NOT NULL,area_sqft REAL DEFAULT 0,production_rate REAL DEFAULT 0,labor_hours REAL DEFAULT 0,labor_rate REAL DEFAULT 0,labor_cost REAL DEFAULT 0,supplies_cost REAL DEFAULT 0,equipment_cost REAL DEFAULT 0,other_cost REAL DEFAULT 0,overhead_pct REAL DEFAULT 0,margin_pct REAL DEFAULT 0,tax_pct REAL DEFAULT 0,total_cost REAL DEFAULT 0,proposal_total REAL DEFAULT 0,line_items TEXT,terms TEXT,status TEXT DEFAULT 'Draft',public_token TEXT UNIQUE,expires_on TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER, estimate_id INTEGER, customer_id INTEGER, customer_name TEXT, company TEXT, name TEXT, site_address TEXT, status TEXT, progress REAL DEFAULT 0, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS contracts(id INTEGER PRIMARY KEY AUTOINCREMENT,estimate_id INTEGER,customer_name TEXT,company TEXT,title TEXT,scope TEXT,start_date TEXT,end_date TEXT,value REAL DEFAULT 0,status TEXT DEFAULT 'Draft',signature_status TEXT DEFAULT 'Not sent',created_at TEXT NOT NULL);`);
estimating.migrate(db); // adds archived_at / archived_by to estimates
db.prepare("INSERT INTO admin_users(email,role) VALUES('mgr@example.com','manager'),('sales@example.com','sales')").run();
const now = new Date().toISOString();
db.prepare(`INSERT INTO estimates(customer_name,scope,status,proposal_total,created_at,updated_at) VALUES('ZZ TEST','Test scope','Approved',2000,?,?)`).run(now, now);

const app = express(); app.use(express.json());
// Stub sign-in: the Bearer value is the email itself. Real sign-in is covered by run-tests.js.
const auth = (req, res, next) => { const e = (req.headers.authorization || '').replace(/^Bearer /, ''); if (!e) return res.status(401).json({ error: 'Authentication required' }); req.user = { email: e }; next(); };
const logAction = (req, action, entity, id, details) => db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run(req.user.email, action, entity, id, details, new Date().toISOString());
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 500);
const ctx = { db, auth, logAction, clean, num: v => Number(v) || 0, required: () => null, estimateMath: () => ({}), uploadDir: os.tmpdir(), bcrypt: null, adminEmail: 'owner@example.com', adminHash: null, getMailer: () => null };
require(path.join(ROOT, 'estimate-archive.js'))(app, { db, auth, logAction });
require(path.join(ROOT, 'contracts2.js'))(app, ctx); // adds the contract archive columns
db.prepare(`INSERT INTO contracts(customer_name,title,scope,value,status,signature_status,created_at,updated_at) VALUES('ZZ TEST','Live flow','Scope',2000,'Active','Signed',?,?)`).run(now, now);

const server = app.listen(0, '127.0.0.1');
let base = '';
const call = async (method, url, who, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + who }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
};

(async () => {
  if (!server.listening) await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await check('migration adds archive columns to estimates and contracts', () => {
    const ecols = db.prepare('PRAGMA table_info(estimates)').all().map(c => c.name);
    const ccols = db.prepare('PRAGMA table_info(contracts)').all().map(c => c.name);
    assert(ecols.includes('archived_at') && ecols.includes('archived_by'), 'estimates missing archive columns');
    return 'estimates columns present; contracts columns added at mount';
  });

  await check('sales staff cannot archive a proposal', async () => {
    const r = await call('POST', '/api/admin/estimates/1/archive', 'sales@example.com', {});
    assert(r.status === 403, 'expected 403, got ' + r.status);
    return r.status;
  });

  await check('manager archives an approved proposal and it is logged', async () => {
    const r = await call('POST', '/api/admin/estimates/1/archive', 'mgr@example.com', { archive: true });
    assert(r.status === 200 && r.body.archived === true, 'archive failed: ' + r.status);
    const row = db.prepare('SELECT archived_at, archived_by, status FROM estimates WHERE id=1').get();
    assert(row.archived_at && row.archived_by === 'mgr@example.com', 'archive columns not set');
    assert(row.status === 'Approved', 'archiving must not change the proposal status');
    const log = db.prepare("SELECT action FROM audit_log WHERE entity='estimate' AND entity_id=1 AND action='archived'").get();
    assert(log, 'no audit entry');
    return 'archived_at set, status still Approved, audit logged';
  });

  await check('manager restores the proposal', async () => {
    const r = await call('POST', '/api/admin/estimates/1/archive', 'mgr@example.com', { archive: false });
    assert(r.status === 200 && r.body.archived === false, 'restore failed');
    const row = db.prepare('SELECT archived_at FROM estimates WHERE id=1').get();
    assert(row.archived_at === null, 'archived_at not cleared');
    return 'restored';
  });

  await check('sales staff cannot archive a contract', async () => {
    const r = await call('POST', '/api/admin/contracts2/1/archive', 'sales@example.com', {});
    assert(r.status === 403, 'expected 403, got ' + r.status);
    return r.status;
  });

  await check('manager archives a signed contract; it leaves the contract KPIs', async () => {
    const before = await call('GET', '/api/admin/contracts2', 'mgr@example.com');
    const executedBefore = before.body.kpis.executed;
    const r = await call('POST', '/api/admin/contracts2/1/archive', 'mgr@example.com', { archive: true });
    assert(r.status === 200 && r.body.archived === true, 'archive failed: ' + r.status);
    const after = await call('GET', '/api/admin/contracts2', 'mgr@example.com');
    assert(after.body.kpis.executed === executedBefore - 1, 'executed KPI did not drop by one');
    return `executed ${executedBefore} -> ${after.body.kpis.executed}`;
  });

  await check('archived contract is read-only (edit refused)', async () => {
    const r = await call('PATCH', '/api/admin/contracts2/1', 'mgr@example.com', { title: 'Changed' });
    assert(r.status === 409, 'expected 409, got ' + r.status);
    return r.status;
  });

  await check('archived contract cannot be sent, countersigned, amended or renewed', async () => {
    const archived = await call('POST', '/api/admin/contracts2/1/archive', 'mgr@example.com', { archive: true });
    assert(archived.status === 200, 'could not archive for this check');
    const out = [];
    for (const [route, body] of [['send', {}], ['countersign', { name: 'Test Signer' }], ['amend', { reason: 'x' }], ['renew', {}]]) {
      const r = await call('POST', '/api/admin/contracts2/1/' + route, 'mgr@example.com', body);
      assert(r.status === 409, route + ' expected 409, got ' + r.status);
      out.push(route + ' 409');
    }
    return out.join(', ');
  });

  await check('manager restores the contract and it returns to the KPIs', async () => {
    const r = await call('POST', '/api/admin/contracts2/1/archive', 'mgr@example.com', { archive: false });
    assert(r.status === 200, 'restore failed');
    const row = db.prepare('SELECT archived_at, title FROM contracts WHERE id=1').get();
    assert(row.archived_at === null && row.title === 'Live flow', 'restore did not clear archive');
    return 'restored';
  });

  server.close();
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  try { db.close(); fs.unlinkSync(file); } catch {}
  process.exitCode = failed ? 1 : 0;
})();
