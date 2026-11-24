// Checks tasks (issues) on the work engine: queue actions follow the rules and keep the task's own status in step,
// finished tasks leave the queue, reopening needs a reason, and changes made on the Issues screen reach the queue item.
// Run: node tests/task-queue-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const W = require('../work-engine');

const db = new Database(':memory:');
db.exec(`CREATE TABLE customer_issues(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Open',
  priority TEXT NOT NULL DEFAULT 'Normal', assigned_to TEXT, due_date TEXT, resolution TEXT, resolved_at TEXT, verified_by TEXT, verified_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
// The calls table: a task can be linked to a callback call, so the engine reads it when a task changes.
db.exec('CREATE TABLE calls(id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT, phone TEXT, summary TEXT, outcome TEXT, created_at TEXT, follow_up_date TEXT, follow_up_done INTEGER DEFAULT 0, handled_at TEXT, handled_by TEXT, handling TEXT, assigned_to TEXT, callback_issue_id INTEGER);');
const now = new Date().toISOString();
db.prepare(`INSERT INTO customer_issues(id,type,title,status,assigned_to,due_date,created_at,updated_at) VALUES
  (1,'task','Replace hallway bulbs','Open','ana@bc.test','2026-12-02',?,?),
  (2,'task','Order mop heads','Open',NULL,NULL,?,?),
  (3,'task','Old finished job','Resolved','ben@bc.test',NULL,?,?)`).run(now, now, now, now, now, now);

// Rules: a note, a reason and a date are required before anything is written
assert.throws(() => W.applyIssueAction(db, 1, { action: 'complete' }, 'ana@bc.test'), /completion note/);
assert.throws(() => W.applyIssueAction(db, 1, { action: 'cancel' }, 'ana@bc.test'), /reason/);
assert.throws(() => W.applyIssueAction(db, 1, { action: 'wait', waiting_on: 'Parts' }, 'ana@bc.test'), /follow-up date/);
assert.throws(() => W.applyIssueAction(db, 1, { action: 'schedule', date: '2026-02-31' }, 'ana@bc.test'), /due date/);
assert.strictEqual(W.issueState(db, 1), null, 'refused actions leave no work item behind');
assert.throws(() => W.applyIssueAction(db, 3, { action: 'schedule', date: '2026-12-05' }, 'ana@bc.test'), /Reopen it first/, 'a resolved task is not re-dated');
assert.throws(() => W.applyIssueAction(db, 3, { action: 'reopen' }, 'ana@bc.test'), /reason/);
assert.throws(() => W.applyIssueAction(db, 2, { action: 'reopen', reason: 'x' }, 'ana@bc.test'), /not finished/);

// Waiting keeps its date on the task and the item
W.applyIssueAction(db, 1, { action: 'wait', waiting_on: 'Supplier delivery', date: '2026-12-09' }, 'ana@bc.test');
let row = db.prepare('SELECT status, due_date FROM customer_issues WHERE id=1').get();
assert.strictEqual(row.status, 'Waiting on customer');
assert.strictEqual(row.due_date, '2026-12-09');
assert.strictEqual(W.issueState(db, 1).item_status, 'waiting');
assert.strictEqual(W.issueState(db, 1).due, '2026-12-09');

// Completing needs a note; the task's resolution and resolved time are set; it leaves the open queue
const done = W.applyIssueAction(db, 1, { action: 'complete', note: 'Bulbs replaced on level 2' }, 'ana@bc.test');
row = db.prepare('SELECT status, resolution, resolved_at FROM customer_issues WHERE id=1').get();
assert.strictEqual(row.status, 'Resolved');
assert.strictEqual(row.resolution, 'Bulbs replaced on level 2');
assert.ok(row.resolved_at);
assert.strictEqual(done.status, 'completed');
assert.ok(done.history.some(h => h.action === 'completed' && h.by === 'ana@bc.test'), 'completion is in the history');
assert.throws(() => W.applyIssueAction(db, 1, { action: 'complete', note: 'again' }, 'ana@bc.test'), /already resolved/);

// Reopen needs a reason; the task goes back to Open and the item keeps its history
assert.throws(() => W.applyIssueAction(db, 1, { action: 'reopen' }, 'ana@bc.test'), /reason/);
W.applyIssueAction(db, 1, { action: 'reopen', reason: 'Two bulbs still out' }, 'ana@bc.test');
row = db.prepare('SELECT status, resolved_at FROM customer_issues WHERE id=1').get();
assert.strictEqual(row.status, 'Open');
assert.strictEqual(row.resolved_at, null);
assert.strictEqual(W.issueState(db, 1).item_status, 'open');

// Assign (including to nobody) and schedule update the task and the item
W.applyIssueAction(db, 2, { action: 'assign', assigned_to: 'ben@bc.test' }, 'ana@bc.test');
assert.strictEqual(db.prepare('SELECT assigned_to FROM customer_issues WHERE id=2').get().assigned_to, 'ben@bc.test');
assert.strictEqual(W.issueState(db, 2).assigned_to, 'ben@bc.test');
W.applyIssueAction(db, 2, { action: 'assign', assigned_to: null }, 'ana@bc.test');
assert.strictEqual(W.issueState(db, 2).assigned_to, null, 'a task can be left with no owner');
W.applyIssueAction(db, 2, { action: 'schedule', date: '2026-12-07' }, 'ana@bc.test');
assert.strictEqual(db.prepare('SELECT due_date FROM customer_issues WHERE id=2').get().due_date, '2026-12-07');
assert.strictEqual(W.issueState(db, 2).due, '2026-12-07');

// Cancel with a reason closes the task and keeps the reason
W.applyIssueAction(db, 2, { action: 'cancel', reason: 'Supplier stopped making them' }, 'ana@bc.test');
row = db.prepare('SELECT status, resolution FROM customer_issues WHERE id=2').get();
assert.strictEqual(row.status, 'Closed');
assert.match(row.resolution, /Supplier stopped/);
assert.strictEqual(W.issueState(db, 2), null, 'a cancelled task leaves the queue');

// Changes made on the Issues screen reach the item
db.prepare("UPDATE customer_issues SET status='Open', resolved_at=NULL WHERE id=2").run();
W.syncIssueFromScreen(db, 2, 'owner@bc.test');
assert.ok(W.issueState(db, 2) && W.issueState(db, 2).item_status === 'open', 'reopened on the screen: the cancelled item is reopened and open again');
db.prepare("UPDATE customer_issues SET assigned_to='cy@bc.test', due_date='2026-12-12' WHERE id=1").run();
W.syncIssueFromScreen(db, 1, 'owner@bc.test');
assert.strictEqual(W.issueState(db, 1).assigned_to, 'cy@bc.test', 'owner change on the screen moves the item');
assert.strictEqual(W.issueState(db, 1).due, '2026-12-12', 'date change on the screen moves the item');
db.prepare("UPDATE customer_issues SET status='Verified', resolution='Checked by Ana' WHERE id=1").run();
W.syncIssueFromScreen(db, 1, 'owner@bc.test');
assert.strictEqual(W.issueState(db, 1), null, 'resolved on the screen leaves the queue');
const last = db.prepare("SELECT id FROM work_items WHERE kind='issue' AND ref_id=1 ORDER BY id DESC LIMIT 1").get();
assert.ok(W.get(db, last.id).history.some(h => h.action === 'completed'), 'completion from the screen is in history');

console.log('All task queue checks passed.');
