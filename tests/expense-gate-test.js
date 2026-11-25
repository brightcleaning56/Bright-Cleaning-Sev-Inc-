// Checks the server's permission rule for bills: approving, paying, voiding, and changing a split are owner/manager only.
// Reads the rule straight from server.js so the test fails if the rule is loosened.
// Run: node tests/expense-gate-test.js
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const line = src.split('\n').find(l => l.includes("'Bills, splits and payments are limited to owners and managers.'"));
if (!line) { console.error('FAIL  the bill permission rule was not found in server.js'); process.exit(1); }
const rule = eval('(' + line.trim().replace(/,$/, '') + ')');
const allowed = (method, url) => rule.m.test(method) && rule.p.test(url);
const roleOk = role => rule.roles.includes(role);
const checks = [
  ['PUT', '/api/admin/expenses/7/splits', 'splits are gated'],
  ['POST', '/api/admin/expenses/7/approve', 'approve is gated'],
  ['POST', '/api/admin/expenses/7/pay', 'pay is gated'],
  ['POST', '/api/admin/expenses/7/void', 'void is gated'],
  ['GET', '/api/admin/expenses/close', 'the weekly close list is gated'],
  ['POST', '/api/admin/expenses/close/approve', 'the batch approval is gated'],
];
let failed = 0;
for (const [m, u, name] of checks) {
  if (allowed(m, u)) console.log('PASS  ' + name);
  else { failed++; console.log('FAIL  ' + name + ' (' + m + ' ' + u + ' is not covered)'); }
}
if (!roleOk('owner') || !roleOk('manager') || roleOk('staff')) { failed++; console.log('FAIL  only owner and manager are allowed'); }
else console.log('PASS  only owner and manager are allowed');
if (failed) process.exit(1);
console.log('expense gate: all checks passed');
