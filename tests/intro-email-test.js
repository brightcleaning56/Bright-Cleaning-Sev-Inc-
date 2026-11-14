// Checks the contact check and the one-click introduction email (no server needed).
// Run: node tests/intro-email-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const lc = require('../leadclass');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE leads(id INTEGER PRIMARY KEY, kind TEXT, contact_name TEXT, company TEXT, email TEXT, phone TEXT, address TEXT, details TEXT, origin TEXT, intake TEXT, status TEXT DEFAULT 'New', created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
  CREATE TABLE email_log(id INTEGER PRIMARY KEY, to_addr TEXT, subject TEXT, body TEXT, status TEXT, error TEXT, provider TEXT, created_at TEXT);
  CREATE TABLE audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
`);
const full = { kind: 'bid', contact_name: 'Dana Ruiz', company: 'Ruiz Builders', email: 'dana@ruizbuilders.com', phone: '515-555-0100', address: '1200 Grand Ave, Des Moines, IA', details: 'Final clean on a 12-unit building.', origin: 'website' };
db.prepare('INSERT INTO leads(id,kind,contact_name,company,email,phone,address,details,origin) VALUES(1,?,?,?,?,?,?,?,?)').run(...Object.values(full));
db.prepare("INSERT INTO leads(id,kind,contact_name,company,email,phone,address,details,origin) VALUES(2,'bid','Pat','Pat Co','info@patco.com','515-555-0101','1 Main St','x','website')").run();
db.prepare("INSERT INTO leads(id,kind,contact_name,company,email,phone,address,details,origin) VALUES(3,'bid','','Mystery LLC','','','','x','website')").run();

const routes = {};
const app = { get: (p, mw, h) => { routes['GET ' + p] = h; }, post: (p, mw, h) => { routes['POST ' + p] = h; } };
let sent = [];
const mailer = { sendMail: async m => { sent.push(m); return { messageId: 'x' }; } };
lc.mount(app, { db, auth: (q, s, n) => n(), getMailer: () => mailer, logAction: () => {} });

async function run(key, id, body) {
  let out;
  const req = { params: { id: String(id) }, body, user: { email: 'owner@example.com' } };
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; } };
  await routes[key](req, res);
  return out;
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS  ' + name); }

(async () => {
  await check('a complete lead with a person email passes the contact check', async () => {
    const r = await run('GET /api/admin/leads/:id/contact-check', 1);
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.body.complete, true, JSON.stringify(r.body));
    assert.strictEqual(r.body.ready, true);
  });

  await check('a shared company inbox is flagged, not ready', async () => {
    const r = await run('GET /api/admin/leads/:id/contact-check', 2);
    assert.strictEqual(r.body.ready, false);
    assert.ok(r.body.missing.some(m => /shared company inbox/.test(m)), JSON.stringify(r.body.missing));
    assert.ok(r.body.missing.includes('Full name (first and last)'), 'a one-word name is flagged');
  });

  await check('a lead with no name, email, phone or address lists each gap', async () => {
    const r = await run('GET /api/admin/leads/:id/contact-check', 3);
    assert.strictEqual(r.body.complete, false);
    for (const want of ['Contact name', 'Email', 'Phone', 'Site or mailing address']) assert.ok(r.body.missing.includes(want), want);
  });

  await check('the introduction is not sent when the contact is incomplete', async () => {
    const before = sent.length;
    const r = await run('POST /api/admin/leads/:id/intro-email', 3, { confirm: true });
    assert.strictEqual(r.code, 409);
    assert.strictEqual(sent.length, before);
  });

  await check('the introduction needs an explicit confirm', async () => {
    const r = await run('POST /api/admin/leads/:id/intro-email', 1, {});
    assert.strictEqual(r.code, 400);
    assert.strictEqual(sent.length, 0);
  });

  await check('a complete lead gets one introduction, with no price, sent to the contact', async () => {
    const r = await run('POST /api/admin/leads/:id/intro-email', 1, { confirm: true });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, 'dana@ruizbuilders.com');
    assert.ok(!/\$/.test(sent[0].text) && lc.introIsSafe({ subject: sent[0].subject, body: sent[0].text }));
    assert.ok(/One of our people will walk the job/.test(sent[0].text), 'pricing is routed to a person');
    assert.strictEqual(sent[0].automated, true, 'goes through the suppression check');
  });

  await check('a second introduction is refused; the follow-up note is used instead', async () => {
    db.prepare("INSERT INTO email_log(to_addr,subject,body,status,created_at) VALUES('dana@ruizbuilders.com','s','b','sent','now')").run();
    const r = await run('POST /api/admin/leads/:id/intro-email', 1, { confirm: true });
    assert.strictEqual(r.code, 409);
    assert.strictEqual(sent.length, 1);
    const c = await run('GET /api/admin/leads/:id/contact-check', 1);
    assert.strictEqual(c.body.ready, false);
  });

  await check('the price guard refuses text with a dollar amount', async () => {
    assert.strictEqual(lc.introIsSafe({ subject: 'x', body: 'Our rate is $2 per square foot' }), false);
    assert.strictEqual(lc.introIsSafe({ subject: 'x', body: 'We will send a written proposal with one price.' }), true);
  });

  await check('the automatic sweep introduces only complete, never-contacted leads, once', async () => {
    db.prepare("INSERT INTO leads(id,kind,contact_name,company,email,phone,address,details,origin) VALUES(4,'bid','Sam Lee','Lee Homes','sam@leehomes.com','515-555-0102','9 Elm St','Move-out clean for a single-family home.','website')").run();
    const before = sent.length;
    const sweep = lc.startIntroSweep(db, () => mailer, () => true);
    await sweep();
    assert.strictEqual(sent.length, before + 1, 'exactly one new introduction');
    assert.strictEqual(sent[sent.length - 1].to, 'sam@leehomes.com');
    assert.ok(/One of our people will walk the job/.test(sent[sent.length - 1].text));
    await sweep();
    assert.strictEqual(sent.length, before + 1, 'a second run does not email again');
  });

  await check('the sweep does nothing when the switch is off', async () => {
    db.prepare("INSERT INTO leads(id,kind,contact_name,company,email,phone,address,details,origin) VALUES(5,'bid','Ann Cole','Cole Co','ann@colecompany.com','515-555-0103','2 Oak St','Clean.','website')").run();
    const before = sent.length;
    await lc.startIntroSweep(db, () => mailer, () => false)();
    assert.strictEqual(sent.length, before);
  });


  await check('the sweep skips scraped contacts and private people named from fire reports', async () => {
    db.prepare("INSERT INTO leads(id,kind,contact_name,company,email,phone,address,details,origin) VALUES(6,'bid','Salvador Ramos','Homeowner - Recent Fire','sr@example.com','515-555-0104','3300 2nd Ave','Recent house fire, public record.','website')").run();
    db.prepare("INSERT INTO leads(id,kind,contact_name,company,email,phone,address,details,origin) VALUES(7,'bid','Dana Hall','Hall Realty','dana.hall@hallrealty.com','515-555-0105','5 Pine St','Source: weichert.com listing','outbound')").run();
    const before = sent.length;
    await lc.startIntroSweep(db, () => mailer, () => true)();
    const mailed = sent.slice(before).map(m => m.to);
    assert.ok(!mailed.includes('sr@example.com') && !mailed.includes('dana.hall@hallrealty.com'), 'neither lead is emailed automatically: ' + mailed.join(','));
    const r = await run('POST /api/admin/leads/:id/intro-email', 7, { confirm: true });
    assert.strictEqual(r.code, 409);
  });


  console.log(`\n${passed} passed`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
