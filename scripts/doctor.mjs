// Preflight: is this environment able to run BUILDINTEL and its full test suite? Clear messages instead of confusing
// test failures (e.g. "pdfjs-dist not installed" rather than three failing plan-room tests).
//   node scripts/doctor.mjs            check runtime + dependencies
//   node scripts/doctor.mjs --db       also require TEST_DATABASE_URL to reach PostgreSQL
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const problems = [], ok = [];
const [maj, min] = process.versions.node.split('.').map(Number);
const [wantMaj, wantMin] = pkg.engines.node.replace(/[^\d.]/g, '').split('.').map(Number);
(maj > wantMaj || (maj === wantMaj && min >= wantMin)) ? ok.push(`Node ${process.versions.node} (needs ${pkg.engines.node})`) : problems.push(`Node ${process.versions.node} is too old: needs ${pkg.engines.node}`);
for (const [name, want] of Object.entries(pkg.dependencies)) {
  try { const v = JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version; ok.push(`${name} ${v}`);
    if (/^\d/.test(want) && v !== want) problems.push(`${name} is ${v} but package.json pins ${want}: run "npm ci"`); }
  catch { problems.push(`${name} is not installed: run "npm ci" (installs exactly what package-lock.json lists)`); }
}
if (process.argv.includes('--db')) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) problems.push('TEST_DATABASE_URL is not set: the PostgreSQL integration tests would be skipped');
  else { try { const pg = (await import('pg')).default; const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 }); await c.connect();
    const v = (await c.query('SHOW server_version')).rows[0].server_version; await c.end(); ok.push(`PostgreSQL ${v} reachable`); }
    catch (e) { problems.push(`TEST_DATABASE_URL does not reach PostgreSQL: ${e.message}`); } }
}
for (const x of ok) console.log('  ok   ' + x);
for (const x of problems) console.error('  FAIL ' + x);
if (problems.length) { console.error(`\ndoctor: ${problems.length} problem(s) — fix these before trusting test results.`); process.exit(1); }
console.log('\ndoctor: environment ready.');
