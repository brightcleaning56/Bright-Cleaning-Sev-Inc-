// Run against a COPY of the live database before turning CORE_READS on:
//   DATABASE_URL=postgres://...staging-copy... node scripts/core-parity.mjs
//   (or DATA_FILE=./data/buildintel.json for JSON storage)
// It links projects in memory and compares the old and new reads for every account. It never saves records;
// with PostgreSQL, opening the store creates the core tables if they are missing (schema v2 is additive).
// Exit code 0 = no permit lost or added; 1 = differences that must be explained before switching.
import { openStore } from '../src/open-store.js';
import { backfillCore } from '../src/core.js';
import { parityReport } from '../src/parity.js';

const store = await openStore();
store.save = () => Promise.resolve();                  // read-only run
const b = backfillCore(store, { full: true });
console.log(`core: ${b.projects} projects, ${b.newLinks} links built in memory, ${b.openReview} need review`);
const r = parityReport(store);
for (const x of r.rows) {
  console.log(`\n${x.org}: ${x.ok ? 'OK' : 'DIFFERENCES'}`);
  console.log(`  groups ${x.groups.before} → ${x.groups.after} (identical ${x.groups.identical}, joined ${x.groups.joined}, split ${x.groups.split}, not yet linked ${x.groups.notYetLinked})`);
  console.log(`  permits ${x.permits.before} → ${x.permits.after}${x.permits.missing.length ? ' MISSING ' + x.permits.missing.join(',') : ''}${x.permits.extra.length ? ' EXTRA ' + x.permits.extra.join(',') : ''}`);
  console.log(`  value ${x.value.before} → ${x.value.after} · command center ${x.commandCenter.activeSitesBefore} → ${x.commandCenter.activeProjectsAfter} · map ${x.map.pointsBefore} → ${x.map.pointsAfter}`);
  for (const e of x.groups.examples) console.log('   ', JSON.stringify(e));
}
console.log(`\n${r.ok ? 'PASS' : 'FAIL'}: ${r.accounts} account(s) checked`);
process.exit(r.ok ? 0 : 1);
