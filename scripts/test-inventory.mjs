// Writes docs/TEST-INVENTORY.md: every automated test by file (evidence for the acceptance report).
import fs from 'node:fs';
const files = fs.readdirSync('test').filter(f => f.endsWith('.test.js')).sort();
// Guard: no test may silently disappear. Compare with the previous inventory before overwriting it.
const prevNames = fs.existsSync('docs/TEST-INVENTORY.md') ? [...fs.readFileSync('docs/TEST-INVENTORY.md', 'utf8').matchAll(/^- (.+)$/gm)].map(m => m[1]) : [];
const nowNames = files.flatMap(f => [...fs.readFileSync('test/' + f, 'utf8').matchAll(/^test\('([^']+)'/gm)].map(m => m[1]));
const removed = prevNames.filter(n => !nowNames.includes(n));
if (removed.length && !process.argv.includes('--allow-removals')) {
  console.error(`ERROR: ${removed.length} test(s) disappeared since the last inventory:\n` + removed.map(n => '  - ' + n).join('\n') + '\nRestore them, or rerun with --allow-removals if the removal is intended.');
  process.exit(1);
}
let out = '# Automated test inventory\n\nGenerated from the test files. Run: `npm test` (set TEST_DATABASE_URL for the Postgres tests).\n';
let n = 0;
for (const f of files) {
  const names = [...fs.readFileSync('test/' + f, 'utf8').matchAll(/^test\('([^']+)'/gm)].map(m => m[1]);
  n += names.length; out += `\n## ${f} (${names.length})\n` + names.map(x => `- ${x}`).join('\n') + '\n';
}
fs.writeFileSync('docs/TEST-INVENTORY.md', out.replace('\n\nGenerated', `\n\n**${n} tests.** Generated`));
// Keep the acceptance document's test count in step with the actual suite.
// Tests that need PostgreSQL declare a skip on TEST_DATABASE_URL; count them so the docs state the real number.
const dbTests = files.flatMap(f => [...fs.readFileSync('test/' + f, 'utf8').matchAll(/^test\('([^']+)'[^\n]*TEST_DATABASE_URL/gm)].map(m => m[1]));
const acc = 'docs/ACCEPTANCE.md';
if (fs.existsSync(acc)) fs.writeFileSync(acc, fs.readFileSync(acc, 'utf8')
  .replace(/Evidence sources: \d+ automated tests/, `Evidence sources: ${n} automated tests`)
  .replace(/Without `TEST_DATABASE_URL`, \d+ PostgreSQL integration tests are skipped \(all others run\); with a test database all pass\./,
    `Without \`TEST_DATABASE_URL\`, ${dbTests.length} PostgreSQL integration tests are skipped (all others run, and none need the database driver installed); with a test database all ${n} run. CI runs with PostgreSQL and fails if any test is skipped.`));
console.log(`${dbTests.length} need PostgreSQL:`, dbTests.map(t => t.slice(0, 50)).join(' | '));
console.log(n, 'tests listed');
