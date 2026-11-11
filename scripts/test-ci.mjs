// CI test runner. Fails if: the environment is incomplete, an inventoried test disappeared, any test fails (the test
// process's own exit code is used — no shell pipe can hide it), or any test is skipped (CI must have PostgreSQL).
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
const run = (args, label) => { const r = spawnSync(process.execPath, args, { stdio: 'inherit' }); if (r.status !== 0) { console.error(`\ntest-ci: ${label} failed`); process.exit(r.status || 1); } };
run(['scripts/doctor.mjs', '--db'], 'environment check');
run(['scripts/test-inventory.mjs'], 'test inventory guard');
const files = fs.readdirSync('test').filter(f => f.endsWith('.test.js')).sort().map(f => 'test/' + f);
// One file at a time: several files share the test database, and the PostgreSQL test truncates its tables, so parallel
// runs could block each other and hang.
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', d => { out += d; process.stdout.write(d); });
child.stderr.on('data', d => { out += d; process.stderr.write(d); });
child.on('close', code => {
  fs.mkdirSync('test-results', { recursive: true }); fs.writeFileSync('test-results/test-ci.log', out);
  const num = k => Number((out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] || 0);
  const summary = `tests ${num('tests')}, passed ${num('pass')}, failed ${num('fail')}, skipped ${num('skipped')}, cancelled ${num('cancelled')}`;
  if (code !== 0 || num('fail') || num('cancelled')) { console.error(`\ntest-ci: FAILED (${summary}; exit code ${code})`); process.exit(code || 1); }
  if (num('skipped')) { console.error(`\ntest-ci: FAILED — ${num('skipped')} test(s) skipped (${summary}). CI must run every test.`); process.exit(1); }
  if (!num('tests')) { console.error('\ntest-ci: FAILED — no tests ran'); process.exit(1); }
  console.log(`\ntest-ci: PASSED (${summary})`);
});
