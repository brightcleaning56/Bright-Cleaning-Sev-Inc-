// Window cleaning on estimates: panes x price per pane, added to the calculated price,
// with window labor and supplies counted as a direct cost. Run: node tests/windows-math-test.js
const assert = require('assert');
const { estimateMath } = require('../estimating');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }

const base = { labor_hours: 10, labor_rate: 24, overhead_pct: 10, margin_pct: 35 };
// Without windows: cost = 240 x 1.10 = 264; price = 264 / 0.65 = 406.15
// Windows: 40 interior x $12 = 480; 20 exterior x $15 = 300; windows total 780.
// Window labor & supplies cost $100 is a direct cost: cost = 340 x 1.10 = 374; price = 374 / 0.65 = 575.38, plus 780 = 1355.38.

check('no windows leaves the calculated price unchanged', () => {
  const m = estimateMath(base);
  assert.strictEqual(m.windows_total, 0);
  assert.strictEqual(m.proposal_total, 406.15);
});

check('window panes are added on top of the calculated price', () => {
  const m = estimateMath({ ...base, windows_interior_panes: 40, windows_interior_rate: 12, windows_exterior_panes: 20, windows_exterior_rate: 15 });
  assert.strictEqual(m.windows_total, 780);
  assert.strictEqual(m.proposal_total, 1186.15);
});

check('window labor and supplies cost counts against margin', () => {
  const m = estimateMath({ ...base, windows_interior_panes: 40, windows_interior_rate: 12, windows_exterior_panes: 20, windows_exterior_rate: 15, windows_cost: 100 });
  assert.strictEqual(m.total_cost, 374);
  assert.strictEqual(m.proposal_total, 1355.38);
});

check('windows are added even when typed line items are the price', () => {
  const m = estimateMath({ ...base, use_line_items: 1, line_items: [{ description: 'Lump sum clean', amount: 1000 }], windows_interior_panes: 40, windows_interior_rate: 12 });
  assert.strictEqual(m.proposal_total, 1480);
});

console.log(`\n${passed} passed`);
