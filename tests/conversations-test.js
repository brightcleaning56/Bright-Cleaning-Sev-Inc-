// Shared conversation record: unit checks on an in-memory database (no live data, no network).
const assert = require('assert');
const Database = require('better-sqlite3');
const conv = require('../conversations');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS  ' + name); }
  catch (e) { console.log('FAIL  ' + name + '  -> ' + e.message); process.exitCode = 1; }
}

const db = new Database(':memory:');
conv.ensureTables(db);

check('a customer message creates one customer conversation, email normalised', () => {
  const id = conv.addMessage(db, { kind: 'customer', customerEmail: ' Pat@Example.COM ', subject: 'Visit', role: 'customer', body: 'Can we move Tuesday?' });
  const c = db.prepare('SELECT * FROM conversations').all();
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].customer_email, 'pat@example.com');
  assert.strictEqual(c[0].kind, 'customer');
  assert.ok(id > 0);
});

check('a second message from the same customer joins the same conversation', () => {
  conv.addMessage(db, { kind: 'customer', customerEmail: 'pat@example.com', role: 'customer', body: 'Also, the back door code changed.' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM conversations').get().n, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM conversation_messages').get().n, 2);
});

check('an office reply is outbound and the thread reads oldest first', () => {
  const cid = db.prepare('SELECT id FROM conversations').get().id;
  conv.addMessage(db, { kind: 'customer', customerEmail: 'pat@example.com', role: 'office', senderRef: 'Eric', body: 'Tuesday works.' });
  const t = conv.thread(db, cid);
  assert.deepStrictEqual(t.map(m => m.direction), ['in', 'in', 'out']);
  assert.strictEqual(t[2].sender_role, 'office');
});

check('a crew message and an office reply share one crew conversation', () => {
  conv.addMessage(db, { kind: 'crew', employeeId: 7, role: 'crew', body: 'Out of glass cleaner at site 4.' });
  conv.addMessage(db, { kind: 'crew', employeeId: 7, role: 'office', senderRef: 'Eric', body: 'Ordering now.' });
  const crew = db.prepare("SELECT id FROM conversations WHERE kind='crew'").all();
  assert.strictEqual(crew.length, 1);
  assert.strictEqual(conv.thread(db, crew[0].id).length, 2);
});

check('a customer and a crew thread never share a conversation', () => {
  const kinds = db.prepare('SELECT kind FROM conversations ORDER BY id').all().map(r => r.kind);
  assert.deepStrictEqual(kinds, ['customer', 'crew']);
});

check('empty messages and unknown senders are refused', () => {
  assert.throws(() => conv.addMessage(db, { kind: 'customer', customerEmail: 'a@b.co', role: 'customer', body: '   ' }), /needs text/);
  assert.throws(() => conv.addMessage(db, { kind: 'customer', customerEmail: 'a@b.co', role: 'robot', body: 'x' }), /Unknown sender/);
  assert.throws(() => conv.addMessage(db, { kind: 'customer', role: 'customer', body: 'x' }), /customer email/);
});

check('a repeated message with the same legacy reference is stored once', () => {
  const a = conv.addMessage(db, { kind: 'customer', customerEmail: 'pat@example.com', role: 'customer', body: 'Retry test', legacyRef: 'x:1' });
  const b = conv.addMessage(db, { kind: 'customer', customerEmail: 'pat@example.com', role: 'customer', body: 'Retry test', legacyRef: 'x:1' });
  assert.strictEqual(a, b);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM conversation_messages WHERE legacy_ref='x:1'").get().n, 1);
});

check('backfill copies existing portal and crew messages once, and is safe to rerun', () => {
  const old = new Database(':memory:');
  old.exec(`CREATE TABLE portal_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE portal_message_replies(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, body TEXT NOT NULL, by_user TEXT, created_at TEXT NOT NULL);
    CREATE TABLE crew_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, visit_id INTEGER, direction TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, seen_by_office INTEGER DEFAULT 0, seen_by_crew INTEGER DEFAULT 0);
    INSERT INTO portal_messages(email,subject,body,created_at) VALUES('lee@example.com','Invoice','Question about line 2','2026-11-01');
    INSERT INTO portal_message_replies(message_id,body,by_user,created_at) VALUES(1,'Line 2 is the window add-on.','Eric','2026-11-02');
    INSERT INTO crew_messages(employee_id,visit_id,direction,body,created_at) VALUES(3,9,'crew','Gate code does not work','2026-11-03'),(3,9,'office','Call the manager','2026-11-03');`);
  const fresh = new Database(':memory:');
  conv.ensureTables(fresh);
  // backfill reads from the same database it writes to, so attach the old tables into the new one
  fresh.exec(`ATTACH ':memory:' AS old;`);
  // simplest correct approach for this test: recreate the legacy tables in the fresh database
  fresh.exec(old.prepare("SELECT group_concat(sql, ';') s FROM sqlite_master WHERE type='table' AND name IN ('portal_messages','portal_message_replies','crew_messages')").get().s);
  for (const t of ['portal_messages', 'portal_message_replies', 'crew_messages']) {
    const rows = old.prepare(`SELECT * FROM ${t}`).all();
    for (const r of rows) {
      const cols = Object.keys(r);
      fresh.prepare(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map(c => r[c]));
    }
  }
  const first = conv.backfill(fresh);
  assert.deepStrictEqual(first, { customer: 2, crew: 2 });
  const second = conv.backfill(fresh);
  assert.deepStrictEqual(second, { customer: 0, crew: 0 });
  assert.strictEqual(fresh.prepare('SELECT COUNT(*) n FROM conversation_messages').get().n, 4);
  const cust = fresh.prepare("SELECT id FROM conversations WHERE kind='customer'").get();
  assert.deepStrictEqual(conv.thread(fresh, cust.id).map(m => m.sender_role), ['customer', 'office']);
});

console.log(`\n${passed} checks passed`);
