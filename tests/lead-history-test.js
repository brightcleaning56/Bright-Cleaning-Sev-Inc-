// Checks the lead history rules on a small in-memory database. Run: node tests/lead-history-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const leadlog = require('../leadlog');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE leads(id INTEGER PRIMARY KEY, status TEXT, assigned_to TEXT, follow_up_date TEXT, customer_id INTEGER, created_at TEXT, email TEXT);
  CREATE TABLE email_log(id INTEGER PRIMARY KEY, to_addr TEXT, subject TEXT, status TEXT, created_at TEXT);
  CREATE TABLE inbox_messages(id INTEGER PRIMARY KEY, from_addr TEXT, subject TEXT, received_at TEXT, lead_id INTEGER);
  CREATE TABLE calls(id INTEGER PRIMARY KEY, direction TEXT, outcome TEXT, summary TEXT, contact_name TEXT, lead_id INTEGER, created_at TEXT);
  CREATE TABLE estimates(id INTEGER PRIMARY KEY, version INTEGER, status TEXT, proposal_total REAL, created_at TEXT, lead_id INTEGER);
  INSERT INTO leads(id, status, assigned_to, follow_up_date, customer_id, created_at, email) VALUES(1, 'New', NULL, NULL, NULL, '2026-11-01T08:00:00.000Z', 'pat@example.test');
`);
const lead = () => db.prepare('SELECT * FROM leads WHERE id=1').get();
const today = '2026-11-15';
let passed = 0;
const ok = (name) => { passed++; console.log('ok - ' + name); };

// Opening a lead is recorded, but it is not work.
leadlog.record(db, 1, 'viewed', 'Opened by Sam', 'sam@example.test', null, '2026-11-02T09:00:00.000Z');
let t = leadlog.timeline(db, lead(), today);
assert.strictEqual(t.lead.no_work_yet, true); assert.strictEqual(t.lead.last_worked_by, null);
ok('opening a lead is recorded but does not count as work');

// A note by a person counts, and is attributed to them.
leadlog.record(db, 1, 'note', 'Left a voicemail', 'sam@example.test', null, '2026-11-10T14:00:00.000Z');
t = leadlog.timeline(db, lead(), today);
assert.strictEqual(t.lead.no_work_yet, false); assert.strictEqual(t.lead.last_worked_by, 'sam@example.test');
assert.strictEqual(t.lead.days_since_contact, 5);
ok('a note counts as work, is attributed to the person, and shows days since contact');

// History cannot be changed or deleted.
assert.throws(() => db.prepare("UPDATE lead_activity SET summary='rewritten' WHERE lead_id=1").run(), /cannot be changed/);
assert.throws(() => db.prepare('DELETE FROM lead_activity WHERE lead_id=1').run(), /cannot be deleted/);
ok('history entries cannot be changed or deleted');

// Calls and estimates are read from their own records.
db.prepare("INSERT INTO calls VALUES(1,'Outbound','Answered','Asked about walkthrough','Pat',1,'2026-11-12T10:00:00.000Z')").run();
db.prepare("INSERT INTO estimates VALUES(1,1,'Sent',2500,'2026-11-09T10:00:00.000Z',1)").run();
t = leadlog.timeline(db, lead(), today);
assert.ok(t.entries.some(e => e.kind === 'call' && e.source === 'call'));
assert.ok(t.entries.some(e => e.kind === 'estimate' && e.source === 'estimate'));
assert.strictEqual(t.lead.days_since_contact, 3, 'a logged call counts as work');
ok('calls and estimates appear in the history, and a call counts as work');

// Overdue follow-up, shown only while the lead is open.
db.prepare("UPDATE leads SET follow_up_date='2026-11-14' WHERE id=1").run();
t = leadlog.timeline(db, lead(), today);
assert.strictEqual(t.lead.follow_up_overdue, true);
db.prepare("UPDATE leads SET status='Won' WHERE id=1").run();
t = leadlog.timeline(db, lead(), today);
assert.strictEqual(t.lead.follow_up_overdue, false);
ok('an overdue follow-up is flagged while the lead is open, and not once it is won');

// Emails to and from the lead's address appear in the history. Sent mail counts as work; a reply does not.
db.prepare("INSERT INTO email_log VALUES(1,'pat@example.test','Walkthrough times','sent','2026-11-14T09:00:00.000Z')").run();
db.prepare("INSERT INTO inbox_messages VALUES(1,'pat@example.test','Re: Walkthrough times','2026-11-15T07:00:00.000Z',NULL)").run();
t = leadlog.timeline(db, lead(), today);
assert.ok(t.entries.some(e => e.kind === 'email' && /Walkthrough times/.test(e.summary)), 'sent email shown');
assert.ok(t.entries.some(e => e.kind === 'email_in' && /Re: Walkthrough/.test(e.summary)), 'reply shown');
assert.strictEqual(t.lead.last_worked_by, 'Email Center', 'sent email counts as work');
assert.strictEqual(t.lead.days_since_contact, 1, 'the last work is the email sent on Nov 14');
ok('sent and received emails appear in the history; a sent email counts as work, a reply does not');

console.log(`\n${passed} checks passed`);
