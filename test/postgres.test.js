// Integration test against a real PostgreSQL. Runs when TEST_DATABASE_URL is set (CI sets it).
import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCycle } from '../src/autopilot.js';
import { world, authorize, DALLAS_ROWS, stubFetch } from './_fixtures.js';

const url = process.env.TEST_DATABASE_URL;

test('postgres: full cycle persists, reloads identically, deletes propagate, audit stored', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const { PgStore } = await import('../src/pgstore.js');
  const reset = await new PgStore(url).init();
  await reset.pool.query('TRUNCATE records, audit'); await reset.pool.end();

  const pgs = await new PgStore(url).init();
  const w = world();
  await pgs.importFrom(w.store);                       // seed with the fixture world
  authorize(pgs, 'dallas-socrata');
  const org = pgs.list('orgs')[0];
  await runCycle(pgs, { fetchImpl: stubFetch([['dallasopendata.com', () => ({ body: DALLAS_ROWS })]]) });
  pgs.put('sessions', { id: 'temp', userId: 'x', expiresAt: '2020-01-01' }); pgs.save();
  pgs.remove('sessions', 'temp');
  await pgs.flushed();
  assert.equal(pgs.lastFlushError, null);

  const again = await new PgStore(url).init();
  assert.equal(again.checksum(), pgs.checksum()); // every record round-trips exactly
  assert.equal(again.tlist('bids', org.id)[0].status, 'pending_approval');
  assert.equal(again.list('permits').length, 2);
  assert.equal(again.get('sessions', 'temp'), null);
  const { rows } = await again.pool.query("SELECT count(*)::int AS n FROM audit WHERE action = 'bid.pending_approval'");
  assert.equal(rows[0].n, 1);
  // tenant column populated for SQL reporting
  const t = await again.pool.query("SELECT count(*)::int AS n FROM records WHERE collection = 'bids' AND org_id = $1", [org.id]);
  assert.equal(t.rows[0].n, 1);
  await pgs.close(); await again.pool.end();
});

test('postgres: a failed write is retried, not lost', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const { PgStore } = await import('../src/pgstore.js');
  const pgs = await new PgStore(url).init();
  const realConnect = pgs.pool.connect.bind(pgs.pool);
  let fail = true;
  pgs.pool.connect = async () => { if (fail) { fail = false; throw new Error('connection reset'); } return realConnect(); };
  pgs.put('companies', { id: 'retry-co', name: 'Retry Co', normName: 'retryco' });
  await pgs.flushed();
  assert.match(pgs.lastFlushError.message, /connection reset/);
  assert.ok(pgs.dirty.has('companies\u0000retry-co'));
  await pgs.flushed();
  assert.equal(pgs.lastFlushError, null);
  const again = await new PgStore(url).init();
  assert.equal(again.get('companies', 'retry-co').name, 'Retry Co');
  await pgs.close(); await again.pool.end();
});

test('two servers (deploy overlap): a scheduled job runs on only one; the lock frees afterwards', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' }, async () => {
  const { PgStore } = await import('../src/pgstore.js');
  const a = await new PgStore(process.env.TEST_DATABASE_URL).init(), b = await new PgStore(process.env.TEST_DATABASE_URL).init();
  let release; const gate = new Promise(r => { release = r; });
  const runA = a.withLock('cycle', async () => { await gate; return 'A ran'; });
  await new Promise(r => setTimeout(r, 50));
  const tryB = await b.withLock('cycle', async () => 'B ran');
  assert.equal(tryB.ran, false); assert.match(tryB.skipped, /another server/);
  assert.equal((await b.withLock('daily', async () => 'daily ok')).ran, true);   // different jobs don't block each other
  release(); assert.deepEqual(await runA, { ran: true, result: 'A ran' });
  assert.deepEqual(await b.withLock('cycle', async () => 'B ran'), { ran: true, result: 'B ran' });
  await Promise.all([a.pool.end(), b.pool.end()]);
});
