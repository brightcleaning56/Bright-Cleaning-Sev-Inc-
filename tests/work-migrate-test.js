// Checks that the old email queue states carry over to the work engine: completed, waiting and open-with-date,
// that the carried-over item keeps its history, and that running the carry-over again changes nothing.
// Run: node tests/work-migrate-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const W = require('../work-engine');

const db = new Database(':memory:');
db.exec(`CREATE TABLE inbox_messages(id INTEGER PRIMARY KEY, subject TEXT, from_addr TEXT, received_at TEXT);
  CREATE TABLE inbox_state(message_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open', follow_up_date TEXT, snooze_until TEXT, assigned_to TEXT, note TEXT, updated_by TEXT, updated_at TEXT NOT NULL, project_id TEXT, task_id TEXT);`);
db.prepare("INSERT INTO inbox_messages VALUES(1,'Quote for hallways','a@x.test','2026-11-20T10:00:00Z'),(2,'Old thread','b@x.test','2026-11-19T10:00:00Z'),(3,'Chase invoice','c@x.test','2026-11-18T10:00:00Z'),(4,'No state','d@x.test','2026-11-17T10:00:00Z')").run();
db.prepare("INSERT INTO inbox_state(message_id,status,follow_up_date,assigned_to,note,updated_at) VALUES(1,'completed',NULL,'ana@bc.test','Sent the quote','2026-11-20T11:00:00Z'),(2,'waiting','2026-11-25',NULL,NULL,'2026-11-19T11:00:00Z'),(3,'open','2026-11-27','ben@bc.test',NULL,'2026-11-18T11:00:00Z')").run();

const n1 = W.migrateEmailState(db);
assert.strictEqual(n1, 3, 'three legacy states carried over');
const e1 = W.emailItemOf(db, 1), e2 = W.emailItemOf(db, 2), e3 = W.emailItemOf(db, 3), e4 = W.emailItemOf(db, 4);
assert.strictEqual(W.get(db, e1.id).status, 'completed');
assert.strictEqual(W.get(db, e1.id).completion_note, 'Sent the quote');
assert.strictEqual(W.get(db, e1.id).assigned_to, 'ana@bc.test');
assert.strictEqual(W.get(db, e2.id).status, 'waiting');
assert.strictEqual(W.get(db, e2.id).next_follow_up, '2026-11-25');
assert.strictEqual(W.get(db, e3.id).status, 'open');
assert.strictEqual(W.get(db, e3.id).due_date, '2026-11-27');
assert.strictEqual(W.get(db, e3.id).assigned_to, 'ben@bc.test');
assert.strictEqual(e4, undefined, 'a message with no legacy state gets no item yet');
assert.ok(W.get(db, e1.id).history.some(h => h.by === 'migration'), 'carried-over items say they came from the migration');
console.log('ok - completed, waiting and open-with-date states carry over with their people and dates');

const again = W.migrateEmailState(db);
assert.strictEqual(again, 0, 'running it again carries nothing over');
assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM work_items WHERE kind='email'").get().n, 3, 'no duplicate items');
console.log('ok - running it again changes nothing');

const st = W.emailState(db, 1);
assert.deepStrictEqual([st.status, st.assigned_to, st.note], ['completed', 'ana@bc.test', 'Sent the quote'], 'the queue reads the engine state');
console.log('ok - the queue view of an email comes from the engine');
console.log('\nAll email carry-over checks passed.');
