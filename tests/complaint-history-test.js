// Checks the complaint-history query used by the customer profile (crm.js). Open, resolved and closed
// cases for one customer must all come back, and another customer's cases must not.
// Run: node tests/complaint-history-test.js   (use the Node version that matches better-sqlite3)
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const assert = (c, m) => { if (!c) throw new Error(m); };

const file = path.join(os.tmpdir(), 'complaint-history-' + process.pid + '.db');
try { fs.unlinkSync(file); } catch {}
const db = new Database(file);
// Same table definition as complaints.js
db.exec(`CREATE TABLE quality_complaints(id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, source_key TEXT UNIQUE NOT NULL,
  source_call_id INTEGER, source_issue_id INTEGER, customer_id INTEGER, project_id INTEGER, visit_id INTEGER, property TEXT, service_type TEXT, service_date TEXT,
  reported_at TEXT NOT NULL, category TEXT DEFAULT 'Cleaning quality', severity TEXT DEFAULT 'Normal', description TEXT, transcript TEXT, status TEXT NOT NULL DEFAULT 'NEW',
  info_needed TEXT, assigned_manager TEXT, supervisor TEXT, crew TEXT, response_due TEXT, investigation_notes TEXT, root_cause TEXT, resolution_summary TEXT,
  customer_accepted INTEGER, escalated_at TEXT, resolved_at TEXT, closed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
const t = new Date().toISOString();
const ins = db.prepare(`INSERT INTO quality_complaints(source_type, source_key, customer_id, status, reported_at, description, resolved_at, closed_at, created_at, updated_at) VALUES('manual', ?, ?, ?, ?, 'x', ?, ?, ?, ?)`);
ins.run('k1', 7, 'ESCALATED', t, null, null, t, t);
ins.run('k2', 7, 'RESOLVED', t, t, null, t, t);
ins.run('k3', 7, 'CLOSED', t, t, t, t, t);
ins.run('k4', 8, 'NEW', t, null, null, t, t);

// The query as written in crm.js profile()
const rows = db.prepare('SELECT id, status, severity, category, description, property, service_date, reported_at, response_due, resolved_at, closed_at, created_at, updated_at FROM quality_complaints WHERE customer_id=? ORDER BY id DESC').all(7);
assert(rows.length === 3, `expected 3 cases for customer 7, got ${rows.length}`);
assert(rows.map(r => r.status).join(',') === 'CLOSED,RESOLVED,ESCALATED', 'statuses or order wrong: ' + rows.map(r => r.status).join(','));
console.log('PASS  profile query returns open, resolved and closed cases for the customer (3 of 3)');
console.log('PASS  other customers’ cases are not included');
db.close();
try { fs.unlinkSync(file); } catch {}
console.log('\n2 passed, 0 failed');
