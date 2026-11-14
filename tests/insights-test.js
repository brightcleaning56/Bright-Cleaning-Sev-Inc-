// Checks the insights suggestions with a known set of decided proposals (no server needed).
// Run: node tests/insights-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const mount = require('../insights');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE leads(id INTEGER PRIMARY KEY, origin TEXT, created_at TEXT);
  CREATE TABLE estimates(id INTEGER PRIMARY KEY, lead_id INTEGER, status TEXT, scope_category TEXT, proposal_total REAL, sent_at TEXT, decided_at TEXT, archived_at TEXT);
  CREATE TABLE admin_users(email TEXT, role TEXT);
`);
const day = n => new Date(Date.UTC(2026, 10, 1 + n)).toISOString();
let eid = 0;
function proposal(status, category, total, source) {
  eid++;
  db.prepare('INSERT INTO estimates(id,lead_id,status,scope_category,proposal_total,sent_at,decided_at) VALUES(?,?,?,?,?,?,?)')
    .run(eid, null, status, category, total, day(0), status === 'Sent' ? null : day(3));
}
// Construction: 5 decided, all won.
for (let i = 0; i < 5; i++) proposal('Approved', 'construction', 30000);
// Janitorial: 5 decided, 1 won.
proposal('Approved', 'janitorial', 3000); for (let i = 0; i < 4; i++) proposal('Declined', 'janitorial', 3000);
// Specialty: only 2 decided, so it must not be compared.
proposal('Declined', 'specialty', 900); proposal('Declined', 'specialty', 900);
// Open proposals do not count as decided.
proposal('Sent', 'construction', 30000);

let handler;
mount({ get: (path, mw, h) => { if (path === '/api/admin/insights') handler = h; } }, { db, auth: (req, res, next) => next(), adminEmail: 'owner@example.com' });

function call(email, role) {
  let out;
  const req = { user: { email }, query: { months: '12' } };
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  if (role) db.prepare('INSERT INTO admin_users(email,role) VALUES(?,?)').run(email, role);
  handler(req, res);
  return out;
}

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS  ' + name); }

check('owner gets the decided count, overall win rate and by-service groups', () => {
  const r = call('owner@example.com');
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.decided, 12);
  assert.strictEqual(r.body.won, 6);
  assert.strictEqual(r.body.overall_win_rate, 50);
  assert.strictEqual(r.body.open, 1);
  const construction = r.body.by_service.find(g => g.name === 'construction');
  assert.deepStrictEqual([construction.decided, construction.won, construction.win_rate], [5, 5, 100]);
});

check('a group that wins well above the overall rate gets a keep suggestion', () => {
  const r = call('owner@example.com');
  assert.ok(r.body.suggestions.some(s => s.kind === 'keep' && /construction \(service\)/.test(s.text)), JSON.stringify(r.body.suggestions));
});

check('a group that wins well below the overall rate gets a review suggestion', () => {
  const r = call('owner@example.com');
  assert.ok(r.body.suggestions.some(s => s.kind === 'review' && /janitorial \(service\)/.test(s.text)), JSON.stringify(r.body.suggestions));
});

check('a group with fewer than 5 decided proposals is not compared', () => {
  const r = call('owner@example.com');
  assert.ok(!r.body.suggestions.some(s => /specialty/.test(s.text)), 'specialty must not be compared');
});

check('a manager gets the same figures; a staff member is refused', () => {
  const m = call('manager@example.com', 'manager');
  assert.strictEqual(m.code, 200);
  const s = call('staff@example.com', 'staff');
  assert.strictEqual(s.code, 403);
});

check('every response says nothing is changed automatically', () => {
  assert.ok(/Nothing is changed automatically/.test(call('owner@example.com').body.note));
});

console.log(`\n${passed} passed`);
