// Checks that a project's status follows its work: contract, readiness, dispatch, start, tasks, and the completion checks.
// Run: node tests/project-status-test.js
const assert = require('assert');
const { deriveStatus, nextSteps } = require('../projectstatus');

// completeReasons: null when completion is allowed (no open tasks, sign-off, signed passing inspection, no corrective work).
const base = { status: 'Planning', executed: false, readiness: false, dispatchApproved: false, started: false, tasksTotal: 0, tasksOpen: 0, completeReasons: 'customer sign-off is missing' };
const at = o => ({ ...base, ...o });
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS  ' + name); };

check('no signed contract: Planning, and the next step is the signature', () => {
  assert.strictEqual(deriveStatus(at({})), 'Planning');
  assert.ok(nextSteps(at({})).some(s => /signed/.test(s)));
});
check('signed contract, readiness not done: Contracted', () => {
  assert.strictEqual(deriveStatus(at({ executed: true })), 'Contracted');
});
check('signed, ready, dispatch approved: Ready to mobilize', () => {
  assert.strictEqual(deriveStatus(at({ executed: true, readiness: true, dispatchApproved: true })), 'Ready to mobilize');
});
check('work started (first check-in or start date): In Progress', () => {
  assert.strictEqual(deriveStatus(at({ executed: true, readiness: true, dispatchApproved: true, started: true, tasksTotal: 3, tasksOpen: 2 })), 'In Progress');
});
check('started and every task done, completion checks not yet met: Quality Review', () => {
  assert.strictEqual(deriveStatus(at({ executed: true, started: true, tasksTotal: 3, tasksOpen: 0 })), 'Quality Review');
});
check('every completion check met on finished work: Completed', () => {
  assert.strictEqual(deriveStatus(at({ executed: true, started: true, tasksTotal: 3, tasksOpen: 0, completeReasons: null })), 'Completed');
});
check('finished work without a passing inspection stays in Quality Review, and says why', () => {
  const f = at({ executed: true, started: true, tasksTotal: 3, tasksOpen: 0, completeReasons: 'a signed, passing quality inspection is required' });
  assert.strictEqual(deriveStatus(f), 'Quality Review');
  assert.ok(nextSteps(f).includes('a signed, passing quality inspection is required'), JSON.stringify(nextSteps(f)));
});
check('a hold stays a hold until someone resumes it', () => {
  assert.strictEqual(deriveStatus(at({ status: 'On Hold', executed: true, started: true })), 'On Hold');
});
check('an archived project stays archived', () => {
  assert.strictEqual(deriveStatus(at({ status: 'Archived', executed: true, started: true, tasksOpen: 4 })), 'Archived');
});
check('a project already completed stays completed, even if a later check would not pass', () => {
  assert.strictEqual(deriveStatus(at({ status: 'Completed', executed: true, started: true, completeReasons: 'a signed, passing quality inspection is required' })), 'Completed');
});
check('next steps name the open tasks in plain words', () => {
  const s = nextSteps(at({ executed: true, readiness: true, dispatchApproved: true, started: true, tasksTotal: 3, tasksOpen: 2 }));
  assert.ok(s.includes('Finish 2 open tasks'), JSON.stringify(s));
});

console.log(`\n${passed} passed`);
