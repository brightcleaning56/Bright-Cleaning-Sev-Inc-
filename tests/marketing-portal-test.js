// Customer portal decisions record marketing events once per proposal (approve and decline).
// In-process, against an in-memory database with the real portal and marketing code. Run: node tests/marketing-portal-test.js
const path = require('path');
const root = path.resolve(__dirname, '..');
process.env.JWT_SECRET = 'test-secret-for-marketing-portal-tests-0123456789';
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
const crypto2 = require('crypto');
const db = new Database(':memory:');
db.exec(`
CREATE TABLE estimates(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, project_name TEXT, status TEXT, proposal_total REAL, public_token TEXT, created_at TEXT, lead_id INTEGER, customer_name TEXT, company TEXT, site_address TEXT, scope TEXT, area_sqft REAL, line_items TEXT, terms TEXT, tax_pct REAL, expires_on TEXT, decided_at TEXT, decline_reason TEXT, signer_name TEXT, signer_title TEXT, signed_at TEXT, updated_at TEXT, decision_ip TEXT, decision_agent TEXT, line_items_total REAL, use_line_items INTEGER);
CREATE TABLE leads(id INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT, email TEXT, kind TEXT, status TEXT, contact_name TEXT, company TEXT, phone TEXT, address TEXT, service TEXT, project_name TEXT, details TEXT, created_at TEXT, updated_at TEXT, stage TEXT, customer_id INTEGER);
CREATE TABLE customers(id INTEGER PRIMARY KEY AUTOINCREMENT, match_key TEXT UNIQUE, name TEXT, company TEXT, email TEXT, phone TEXT, address TEXT, source TEXT, notes TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
CREATE TABLE contracts(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, email TEXT, title TEXT, value REAL, status TEXT, signature_status TEXT, public_token TEXT, created_at TEXT, signed_at TEXT, customer_name TEXT, company TEXT);
CREATE TABLE invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, email TEXT, invoice_number TEXT, amount REAL, paid_amount REAL DEFAULT 0, due_date TEXT, status TEXT, created_at TEXT);
CREATE TABLE projects(id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER, customer_id INTEGER, name TEXT, status TEXT, progress REAL, site_address TEXT);
CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, type TEXT, date TEXT, start_time TEXT, end_time TEXT, address TEXT, status TEXT, project_id INTEGER);
CREATE TABLE inspections(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, project_id INTEGER, date TEXT, area TEXT, score REAL, passed INTEGER, status TEXT, itype TEXT, signed_name TEXT, signed_at TEXT);
CREATE TABLE documents(id INTEGER PRIMARY KEY AUTOINCREMENT, estimate_id INTEGER, title TEXT, kind TEXT, file_name TEXT, file_url TEXT, size INTEGER, uploaded_by TEXT, created_at TEXT, status TEXT, version INTEGER);
CREATE TABLE payments(id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, amount REAL DEFAULT 0, status TEXT, created_at TEXT);
`);
db.exec("ALTER TABLE estimates ADD COLUMN selected_option_id INTEGER");
const EMAIL = 'portal.decision@example.com';
db.prepare("INSERT INTO leads(id,email,status,kind,contact_name,created_at,updated_at) VALUES(1,?,'Proposal Sent','bid','Pat Client','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')").run(EMAIL);
db.prepare("INSERT INTO leads(id,email,status,kind,contact_name,created_at,updated_at) VALUES(2,?,'Proposal Sent','bid','Sam Client','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')").run(EMAIL);
db.prepare("INSERT INTO estimates(id,email,project_name,status,proposal_total,public_token,created_at,lead_id,customer_name) VALUES(1,?,'Office approve','Sent',1200,'tok-approve','2026-11-01T10:00:00Z',1,'Pat Client')").run(EMAIL);
db.prepare("INSERT INTO estimates(id,email,project_name,status,proposal_total,public_token,created_at,lead_id,customer_name) VALUES(2,?,'Office decline','Sent',800,'tok-decline','2026-11-01T10:00:00Z',2,'Sam Client')").run(EMAIL);

// Marketing tables and triggers exist as they do on the server.
require(path.join(root, 'marketing')).migrate(db);

let SESSION = null;
const routes = {};
const app = { locals: {}, get: (p, ...f) => { routes['GET ' + p] = f[f.length - 1]; }, post: (p, ...f) => { routes['POST ' + p] = f[f.length - 1]; }, put: (p, ...f) => { routes['PUT ' + p] = f[f.length - 1]; }, patch: (p, ...f) => { routes['PATCH ' + p] = f[f.length - 1]; } };
const staffAuth = (req, res, next) => next();
const sent = [];
const mailer = { sendMail: async m => { sent.push(m); return { messageId: 'x' }; } };
require(path.join(root, 'proposal-options.js'))(app, { db, auth: staffAuth, logAction: () => {}, clean: v => v });
require(path.join(root, 'portal.js'))(app, { db, getMailer: () => mailer, auth: staffAuth, uploadDir: require('os').tmpdir() });

function call(key, body, headers, params) {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { body: body || {}, headers: headers || {}, ip: '10.0.0.1', query: {}, params: params || {} };
  const out = routes[key](req, res);
  return Promise.resolve(out).then(() => ({ code: res.code, body: res.body }));
}

db.prepare("INSERT INTO customers(id,match_key,email,name) VALUES(1,'portal-decision',?,'Pat Client')").run(EMAIL);

let pass = 0, fail = 0;
async function check(name, fn) { try { const ev = await fn(); pass++; console.log('PASS  ' + name + (ev ? ' — ' + ev : '')); } catch (e) { fail++; console.log('FAIL  ' + name + ' -> ' + e.message); } }
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  // Sign in the way a customer does: a one-time link by email, then the session it gives.
  await call('POST /api/portal/request', { email: EMAIL }, {}, null);
  const m = sent[0] && sent[0].text.match(/portal\.html#([A-Za-z0-9_-]+)/);
  const v = m ? await call('POST /api/portal/verify', { token: m[1] }) : null;
  SESSION = v && v.body && v.body.session;
  assert(SESSION, 'portal sign-in did not produce a session');
  await check('Customer approves: one proposal-approved event for the lead', async () => {
    const r = await call('POST /api/portal/proposals/:id/respond', { decision: 'approve', signer_name: 'Pat Client', agree: true }, { authorization: 'Bearer ' + SESSION }, { id: '1' });
    assert(r.code === 200, 'approve refused: ' + r.code + ' ' + JSON.stringify(r.body).slice(0, 160));
    const n = db.prepare("SELECT COUNT(*) n FROM marketing_events WHERE event_type='proposal_approved' AND lead_id=1 AND source_record_id='estimate:1'").get().n;
    assert(n === 1, 'approved recorded ' + n + ' times');
    return 'events 1';
  });
  await check('Approving again is refused and records nothing more', async () => {
    const r = await call('POST /api/portal/proposals/:id/respond', { decision: 'approve', signer_name: 'Pat Client', agree: true }, { authorization: 'Bearer ' + SESSION }, { id: '1' });
    assert(r.code === 409, 'got ' + r.code);
    const n = db.prepare("SELECT COUNT(*) n FROM marketing_events WHERE source_record_id='estimate:1'").get().n;
    assert(n === 1, 'events ' + n);
  });
  await check('Customer declines: one proposal-declined event for the lead', async () => {
    const r = await call('POST /api/portal/proposals/:id/respond', { decision: 'decline', reason: 'Price is too high for this year' }, { authorization: 'Bearer ' + SESSION }, { id: '2' });
    assert(r.code === 200, 'decline refused: ' + r.code + ' ' + JSON.stringify(r.body).slice(0, 160));
    const n = db.prepare("SELECT COUNT(*) n FROM marketing_events WHERE event_type='proposal_declined' AND lead_id=2 AND source_record_id='estimate:2'").get().n;
    assert(n === 1, 'declined recorded ' + n + ' times');
  });
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
