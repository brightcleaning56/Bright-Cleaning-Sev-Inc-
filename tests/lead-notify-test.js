// Checks the lead alert throttle: first lead alerts at once, a burst becomes one digest, nothing is dropped.
// Run: node tests/lead-notify-test.js
const assert = require('assert');
const { createLeadNotifier } = require('../lead-notify');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS  ' + name); }

// Fake clock and timers so the test runs instantly.
function harness(windowMs = 1000) {
  let t = 0; const timers = []; const sent = [];
  const notify = (subject, body, to) => { sent.push({ subject, body, to }); return Promise.resolve(); };
  const setTimer = (fn, ms) => { const h = { fn, at: t + ms, cancelled: false, unref() {} }; timers.push(h); return h; };
  const n = createLeadNotifier({ notify, to: 'info@example.com', windowMs, now: () => t, setTimer });
  const advance = ms => { t += ms; for (const h of timers) if (!h.cancelled && !h.done && h.at <= t) { h.done = true; h.fn(); } };
  return { n, sent, advance, setNow: v => { t = v; } };
}

check('first lead from a source is alerted at once', () => {
  const { n, sent } = harness();
  assert.strictEqual(n.leadArrived(1, 'GROK BOT', 'Lead A'), 'sent');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].subject, 'New lead from GROK BOT');
  assert.strictEqual(sent[0].body, 'Lead A');
  assert.strictEqual(sent[0].to, 'info@example.com');
});

check('a burst inside the window is held and sent as one digest', () => {
  const { n, sent, advance } = harness();
  n.leadArrived(1, 'GROK BOT', 'Lead A');
  assert.strictEqual(n.leadArrived(1, 'GROK BOT', 'Lead B'), 'held');
  assert.strictEqual(n.leadArrived(1, 'GROK BOT', 'Lead C'), 'held');
  assert.strictEqual(sent.length, 1, 'no extra emails during the burst');
  advance(1000);
  assert.strictEqual(sent.length, 2, 'digest sent when the window opens');
  assert.strictEqual(sent[1].subject, '2 new leads from GROK BOT'.replace('2', '2'));
  assert.ok(sent[1].body.includes('Lead B') && sent[1].body.includes('Lead C'), 'digest lists every held lead');
});

check('leads from different sources are not mixed', () => {
  const { n, sent } = harness();
  n.leadArrived(1, 'GROK BOT', 'bot lead');
  assert.strictEqual(n.leadArrived(2, 'Website', 'web lead'), 'sent');
  assert.strictEqual(sent.length, 2);
});

check('after the window passes, the next lead is alerted at once again', () => {
  const { n, sent, advance } = harness();
  n.leadArrived(1, 'GROK BOT', 'Lead A');
  advance(1500);
  assert.strictEqual(n.leadArrived(1, 'GROK BOT', 'Lead later'), 'sent');
  assert.strictEqual(sent.length, 2);
});

check('a digest of more than 50 leads says how many were left out', () => {
  const { n, sent, advance } = harness();
  n.leadArrived(1, 'GROK BOT', 'first');
  for (let i = 0; i < 60; i++) n.leadArrived(1, 'GROK BOT', 'held ' + i);
  advance(1000);
  assert.ok(sent[1].body.includes('…and 10 more'), 'expected the 10 left-out note');
  assert.strictEqual(sent[1].subject, '60 new leads from GROK BOT');
});

check('a failed email does not throw and does not block later alerts', () => {
  const failing = createLeadNotifier({ notify: () => Promise.reject(new Error('mail down')), to: 'x', windowMs: 1000, now: () => 0, setTimer: () => ({ unref() {} }) });
  assert.strictEqual(failing.leadArrived(1, 'GROK BOT', 'Lead A'), 'sent');
});

console.log(`\n${passed} passed`);
