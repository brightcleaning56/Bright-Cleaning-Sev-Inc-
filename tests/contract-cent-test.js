// Checks the QA item "attempt a one-cent contract mismatch and confirm it is blocked": a contract whose value differs from
// the proposal the client approved by one cent cannot be countersigned; the exact value is not refused for that reason.
// Run: node tests/contract-cent-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const mountContracts = require('../contracts2');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE contracts(id INTEGER PRIMARY KEY, estimate_id INTEGER, company TEXT, title TEXT, value REAL, status TEXT, signature_status TEXT, created_at TEXT, signed_at TEXT);
  CREATE TABLE estimates(id INTEGER PRIMARY KEY, status TEXT, proposal_total REAL, signer_name TEXT, signer_title TEXT, signed_at TEXT, decision_ip TEXT);
  CREATE TABLE admin_users(id INTEGER PRIMARY KEY, email TEXT, role TEXT);
  INSERT INTO estimates(id,status,proposal_total,signer_name,signer_title,signed_at,decision_ip) VALUES(1,'Approved',12345.67,'Pat Client','Owner','2026-11-18T10:00:00Z','10.0.0.1');
  INSERT INTO contracts(id,estimate_id,company,title,value,status,signature_status,created_at) VALUES
    (1,1,'Client Co','Cent off',12345.66,'Draft','Customer signed','2026-11-18T09:00:00Z'),
    (2,1,'Client Co','Exact',12345.67,'Draft','Customer signed','2026-11-18T09:00:00Z');
`);

const routes = {};
const app = { locals: {}, get: (p, ...f) => { routes[p] = f[f.length - 1]; }, post: (p, ...f) => { routes[p] = f[f.length - 1]; }, put: () => {}, patch: () => {}, delete: () => {} };
mountContracts(app, { db, auth: (req, res, next) => next(), logAction: () => {}, clean: v => String(v || ''), adminEmail: 'owner@test.example', getMailer: () => null });

const countersign = routes['/api/admin/contracts2/:id/countersign'];
assert.ok(countersign, 'countersign route mounted');
const call = id => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  try { countersign({ params: { id: String(id) }, body: { name: 'Test Signer' }, user: { email: 'owner@test.example' } }, res); }
  catch (e) { res.body = { thrown: e.message }; }
  return res;
};

const MISMATCH = /no longer matches the proposal/;

const cent = call(1);
assert.strictEqual(cent.code, 409, 'a one-cent difference is refused');
assert.ok(MISMATCH.test(cent.body.error), 'the refusal names the proposal mismatch: ' + JSON.stringify(cent.body));
assert.ok(!db.prepare('SELECT countersigned_at FROM contracts WHERE id=1').get().countersigned_at, 'the refused contract is not executed');
console.log('ok - a contract one cent below the approved proposal is blocked');

const exact = call(2);
assert.ok(!(exact.body && exact.body.error && MISMATCH.test(exact.body.error)), 'the exact value is not refused for a mismatch: ' + JSON.stringify(exact.body));
console.log('ok - the exact approved value passes the mismatch check');

console.log('\nAll contract one-cent checks passed.');
