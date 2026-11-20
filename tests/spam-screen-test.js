// Checks the inbound message screen: vendor pitches are blocked, real service requests are not.
// Run: node tests/spam-screen-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const ss = require('../spam-screen');

// The message that prompted this screen, verbatim (name, email, message as the website form would send them).
const ASHFORD = {
  name: 'James Ashford',
  email: 'james.ashford@atriumlicensing.com',
  phone: '',
  message: `Hi Gui,

AI labs building robots are paying businesses each month for first-person video of their people at work like floor care, window cleaning and sanitation. The rate is $10 per accepted hour, roughly $1,600 per worker per month on full shifts.

Nothing changes for your crew: they wear a light headset and work as usual. The program covers the equipment and the training, and pays monthly on accepted hours. You decide which tasks get recorded.

Open to a 15-minute call to see what this could come to for Bright Clean? Reply here or email james.ashford@atriumlicensing.com. If it's not a fit, tell me and we won't reach out again.

James Ashford
Atrium Licensing`
};

const cases = [
  ['the reported pitch is blocked', ASHFORD, true],
  ['SEO sales pitch is blocked', { name: 'Dana', message: 'We can get your site to page one. Our SEO services include backlinks and guest posts.' }, true],
  ['crypto investment pitch is blocked', { name: 'Sam', message: 'Earn passive income with our crypto signals program. Reply here.' }, true],
  ['two paid-program phrases with no service words are blocked', { name: 'Lee', message: 'Get paid $25 per hour for your spare time. Reply here and we will set it up.' }, true],
  ['real final-clean request is allowed', { name: 'Dana Ruiz', company: 'Ruiz Builders', email: 'dana@ruizbuilders.com', message: 'We need a final clean and window cleaning for a 40-unit building in Ankeny. Bid due Dec 3.' }, false],
  ['short real question is allowed', { name: 'Pat', message: 'Do you clean carpets after a move-out?' }, false],
  ['builder asking about a walkthrough is allowed', { name: 'Kim', message: 'Can we set up a walkthrough for our office build-out? Rough clean and punch list.' }, false],
  ['single money mention in a real request is allowed', { name: 'Chris', message: 'Our budget is $5,000 per month for janitorial service at the warehouse.' }, false],
  ['empty-ish greeting is allowed', { name: 'Hi', message: 'Hello, are you open?' }, false]
];

for (const [label, fields, expected] of cases) {
  const v = ss.screen(fields);
  assert.strictEqual(v.blocked, expected, `${label}: expected blocked=${expected}, got reasons ${JSON.stringify(v.reasons)}`);
  console.log('ok -', label);
}

// The reported message gives a readable reason for staff.
const why = ss.screen(ASHFORD).reasons.join(' | ');
assert.ok(/accepted hour|AI labs|won't reach out/i.test(why), 'reason names a concrete phrase: ' + why);
console.log('ok - reason for the reported pitch:', why.slice(0, 120));

// Blocked attempts are stored for the owner, and refuseIfSpam stops the save.
const db = new Database(':memory:');
db.exec(`CREATE TABLE leads(id INTEGER PRIMARY KEY, details TEXT);
  CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);`);
assert.strictEqual(ss.refuseIfSpam(db, 'website inquiry', ASHFORD), true, 'refuseIfSpam blocks the reported pitch');
assert.strictEqual(ss.refuseIfSpam(db, 'website inquiry', cases[4][1]), false, 'refuseIfSpam lets a real request through');
const logged = db.prepare('SELECT source, name, email, reasons FROM blocked_intake').all();
assert.strictEqual(logged.length, 1, 'one blocked row');
assert.strictEqual(logged[0].source, 'website inquiry');
assert.strictEqual(logged[0].email, 'james.ashford@atriumlicensing.com');
assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM leads').get().n, 0, 'no lead was created');
console.log('ok - blocked attempt is logged and no lead row is written');

// The owner list route returns the logged attempts.
const routes = {};
ss.mount({ get: (p, mw, h) => { routes[p] = h; } }, { db, auth: (q, s, n) => n() });
let out;
routes['/api/admin/blocked-intake']({}, { json: b => { out = b; } });
assert.strictEqual(out.count, 1);
assert.deepStrictEqual(out.items[0].reasons.length > 0, true);
console.log('ok - owner list returns the blocked attempt');

console.log('\nAll spam-screen checks passed.');
