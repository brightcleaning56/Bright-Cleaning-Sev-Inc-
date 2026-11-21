// Checks the work lifecycle rules: opening does not complete, start, wait, complete with a note, cancel and reopen with reasons,
// reassign, overdue, no duplicates, history for every change, and that completed and cancelled items leave the active queue.
// Run: node tests/work-engine-test.js
const assert = require('assert');
const Database = require('better-sqlite3');
const W = require('../work-engine');

const db = new Database(':memory:');
W.ensureSchema(db);
const today = require('../bizdate').today();
const yesterday = (() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
const tomorrow = (() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const throws = (fn, re) => assert.throws(fn, re);
const count = (table, where = '1=1', args = []) => db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...args).n;

// 1. Creating an item: one per record while active; opening does not complete it.
const a = W.create(db, { kind: 'email', ref_type: 'inbox', ref_id: 7, title: 'Reply to Pat', assigned_to: 'ana@bc.test', due_date: today, by: 'owner@bc.test' });
assert.ok(a.created, 'first create makes the item');
const again = W.create(db, { kind: 'email', ref_type: 'inbox', ref_id: 7, title: 'Reply to Pat', by: 'owner@bc.test' });
assert.strictEqual(again.id, a.id, 'creating the same record again returns the same item');
assert.strictEqual(again.created, false);
assert.strictEqual(count('work_items', "kind='email' AND ref_id=7"), 1, 'no duplicate row');
assert.strictEqual(W.get(db, a.id).status, 'open', 'a new item is open');
assert.ok(W.queue(db, { assigned_to: 'ana@bc.test' }).some(x => x.id === a.id), 'open item is in the queue');
console.log('ok - one item per record; a new item is open and in the queue');

// 2. Start moves it to In progress; still in the queue.
W.act(db, a.id, 'start', {}, 'ana@bc.test');
assert.strictEqual(W.get(db, a.id).status, 'in_progress');
assert.ok(W.queue(db, { assigned_to: 'ana@bc.test' }).some(x => x.id === a.id), 'in progress stays in the queue');
console.log('ok - starting work sets In progress and keeps it in the queue');

// 3. Completing needs a note; with a note it leaves the queue but stays in history.
throws(() => W.act(db, a.id, 'complete', {}, 'ana@bc.test'), /completion note/);
throws(() => W.act(db, a.id, 'complete', { note: '   ' }, 'ana@bc.test'), /completion note/);
assert.strictEqual(W.get(db, a.id).status, 'in_progress', 'a refused completion changes nothing');
W.act(db, a.id, 'complete', { note: 'Replied with the window quote' }, 'ana@bc.test');
let it = W.get(db, a.id);
assert.strictEqual(it.status, 'completed');
assert.strictEqual(it.completion_note, 'Replied with the window quote');
assert.ok(!W.queue(db, { assigned_to: 'ana@bc.test' }).some(x => x.id === a.id), 'completed item leaves the active queue');
assert.ok(it.history.some(h => h.action === 'completed' && h.by === 'ana@bc.test'), 'completion is in history with who');
console.log('ok - completing needs a note; completed items leave the queue and stay in history');

// 4. Reopening needs a reason and returns the item to the queue.
throws(() => W.act(db, a.id, 'reopen', {}, 'ana@bc.test'), /a reason/);
W.act(db, a.id, 'reopen', { reason: 'Customer replied with a new question' }, 'owner@bc.test');
it = W.get(db, a.id);
assert.strictEqual(it.status, 'open');
assert.strictEqual(it.reopen_reason, 'Customer replied with a new question');
assert.ok(W.queue(db, { assigned_to: 'ana@bc.test' }).some(x => x.id === a.id), 'reopened item is back in the queue');
assert.ok(it.history.some(h => h.action === 'reopened' && /new question/.test(h.detail)), 'reopen reason is in history');
console.log('ok - reopen needs a reason, returns to the queue, and the reason is kept');

// 5. Waiting needs what it waits on and the follow-up date; it stays visible with that date.
throws(() => W.act(db, a.id, 'wait', { waiting_on: 'Customer' }, 'ana@bc.test'), /follow-up date/);
throws(() => W.act(db, a.id, 'wait', { next_follow_up: tomorrow }, 'ana@bc.test'), /what it is waiting on/);
W.act(db, a.id, 'wait', { waiting_on: 'Customer to confirm the site access', next_follow_up: tomorrow }, 'ana@bc.test');
it = W.get(db, a.id);
assert.strictEqual(it.status, 'waiting');
assert.strictEqual(it.next_follow_up, tomorrow);
assert.ok(W.queue(db, { assigned_to: 'ana@bc.test' }).some(x => x.id === a.id && x.status === 'waiting'), 'waiting stays visible in the queue');
console.log('ok - waiting needs the dependency and follow-up date, and stays visible');

// 6. Cancelling needs a reason; the item leaves the queue and stays in history.
throws(() => W.act(db, a.id, 'cancel', {}, 'owner@bc.test'), /a reason/);
W.act(db, a.id, 'cancel', { reason: 'Duplicate of the earlier email' }, 'owner@bc.test');
it = W.get(db, a.id);
assert.strictEqual(it.status, 'cancelled');
assert.ok(!W.queue(db, { assigned_to: 'ana@bc.test' }).some(x => x.id === a.id), 'cancelled item leaves the queue');
assert.ok(it.history.some(h => h.action === 'cancelled' && /Duplicate/.test(h.detail)), 'cancel reason is in history');
throws(() => W.act(db, a.id, 'start', {}, 'ana@bc.test'), /cannot be changed this way/);
console.log('ok - cancelling needs a reason; cancelled items leave the queue and stay in history');

// 7. Reassigning moves the item between two people's queues, and says who it was and is now.
const b = W.create(db, { kind: 'call', ref_type: 'call', ref_id: 3, title: 'Call back Lee', assigned_to: 'ana@bc.test', due_date: today, by: 'owner@bc.test' });
throws(() => W.act(db, b.id, 'reassign', { assigned_to: 'ana@bc.test' }, 'owner@bc.test'), /already assigned/);
W.act(db, b.id, 'reassign', { assigned_to: 'ben@bc.test' }, 'owner@bc.test');
assert.ok(!W.queue(db, { assigned_to: 'ana@bc.test' }).some(x => x.id === b.id), 'leaves the old person’s queue');
assert.ok(W.queue(db, { assigned_to: 'ben@bc.test' }).some(x => x.id === b.id), 'appears in the new person’s queue');
assert.ok(W.get(db, b.id).history.some(h => h.action === 'reassigned' && /ana@bc\.test → ben@bc\.test/.test(h.detail)), 'history names both people');
console.log('ok - reassigning moves the item between queues and records both people');

// 8. Overdue items are flagged until resolved; due today is not overdue.
const c = W.create(db, { kind: 'invoice', ref_type: 'invoice', ref_id: 9, title: 'Collect balance', assigned_to: 'ana@bc.test', due_date: yesterday, by: 'owner@bc.test' });
const late = W.queue(db, { assigned_to: 'ana@bc.test' }).find(x => x.id === c.id);
assert.ok(late && late.overdue === true, 'past due is overdue');
const d = W.create(db, { kind: 'issue', ref_type: 'issue', ref_id: 4, title: 'Check the restroom', assigned_to: 'ana@bc.test', due_date: today, by: 'owner@bc.test' });
assert.strictEqual(W.queue(db, { assigned_to: 'ana@bc.test' }).find(x => x.id === d.id).overdue, false, 'due today is not overdue');
W.act(db, c.id, 'complete', { note: 'Paid in full by card' }, 'ana@bc.test');
assert.ok(!W.queue(db, { assigned_to: 'ana@bc.test' }).some(x => x.id === c.id), 'resolved overdue item leaves the queue');
console.log('ok - overdue is flagged until resolved; due today is not overdue');

// 9. Validation: unknown kinds, bad dates and priorities are refused; edits keep history.
throws(() => W.create(db, { kind: 'mystery', title: 'x' }), /Unknown kind/);
throws(() => W.create(db, { kind: 'other', title: '' }), /needs a title/);
throws(() => W.create(db, { kind: 'other', title: 'x', due_date: '2026-13-40' }), /real date/);
throws(() => W.create(db, { kind: 'other', title: 'x', priority: 'huge' }), /valid priority/);
const e = W.create(db, { kind: 'maintenance', title: 'Replace vacuum belt', by: 'owner@bc.test' });
W.act(db, e.id, 'edit', { title: 'Replace the vacuum belt on van 2', priority: 'high' }, 'owner@bc.test');
assert.strictEqual(W.get(db, e.id).title, 'Replace the vacuum belt on van 2');
assert.ok(W.get(db, e.id).history.some(h => h.action === 'edited'), 'the edit is in history');
throws(() => W.act(db, e.id, 'edit', {}, 'owner@bc.test'), /Nothing to save/);
console.log('ok - validation refuses bad input; edits are saved and recorded');

// 10. Every change has a history row with who and when.
for (const x of [a, b, c, d, e]) {
  const h = W.get(db, x.id).history;
  assert.ok(h.length >= 1 && h.every(row => row.at && row.action), 'every item has dated history');
}
console.log('ok - every item keeps dated history');

console.log('\nAll work-engine checks passed.');
