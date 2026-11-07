import { config } from './config.js';
import { Store } from './store.js';
import { openStore } from './open-store.js';
import { runCycle } from './autopilot.js';
import { readiness } from './readiness.js';
import { bootstrap, backupAndVerify } from './server.js';

const cmd = process.argv[2];
if (cmd === 'migrate-to-pg') {
  if (!config.databaseUrl) { console.error('set DATABASE_URL'); process.exit(1); }
  const src = new Store(config.dataFile);
  const { PgStore } = await import('./pgstore.js');
  const pgs = await new PgStore(config.databaseUrl).init();
  const before = Store.COLLECTIONS.reduce((n, c) => n + Object.keys(src.data[c]).length, 0);
  await pgs.importFrom(src);
  const check = await new PgStore(config.databaseUrl).init();
  const after = Store.COLLECTIONS.reduce((n, c) => n + Object.keys(check.data[c]).length, 0);
  console.log(`migrated ${before} records; postgres now holds ${after}; checksums ${src.checksum() === check.checksum() ? 'MATCH' : 'DIFFER (audit history order may differ; record counts above)'}`);
  await pgs.close(); await check.pool.end(); process.exit(0);
}
const store = await openStore();
bootstrap(store);

if (cmd === 'readiness') {
  const r = readiness(store);
  console.log(`\nBUILDINTEL readiness: ${r.verdict}  (${r.passed}/${r.total} gates)  pilot-ready: ${r.pilotReady}\n`);
  for (const g of r.gates) console.log(`${g.status === 'pass' ? 'PASS ' : g.status === 'fail' ? 'FAIL ' : 'OWNER'}  ${g.name}\n       ${g.evidence}\n       owner: ${g.owner}`);
} else if (cmd === 'cycle') {
  console.log(JSON.stringify(await runCycle(store), null, 2));
} else if (cmd === 'backup' || cmd === 'restore-test') {
  console.log(JSON.stringify(await backupAndVerify(store), null, 2));
} else {
  console.log('usage: node src/cli.js readiness|cycle|backup|restore-test|migrate-to-pg');
}
if (store.close) await store.close();
