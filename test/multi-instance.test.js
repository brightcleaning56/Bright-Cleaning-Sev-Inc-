import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// Two independent server instances against one real PostgreSQL database (E2E-019: no silent lost updates).
const url = process.env.TEST_DATABASE_URL;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(50); } return fn(); }
async function pair() {
  const { PgStore } = await import('../src/pgstore.js');
  const reset = await new PgStore(url, { listen: false }).init();
  await reset.pool.query('TRUNCATE records, audit, bi_projects, bi_project_links, bi_project_companies, bi_project_phases, bi_project_aliases'); await reset.pool.end();
  return [await new PgStore(url).init(), await new PgStore(url).init()];
}
const end = async (...s) => { for (const x of s) await x.close(); };

test('two servers edit the same record: the second write is rejected as a conflict, the first is kept, nothing is silent', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const [a, b] = await pair();
  try {
    const o = a.put('orgs', { id: 'org1', name: 'Original', status: 'active' }); await a.flushed();
    await until(() => b.get('orgs', 'org1'));                                   // B learns about it by notification
    assert.equal(b.get('orgs', 'org1')?.name, 'Original');
    b.listener.removeAllListeners('notification');                              // make B stale on purpose
    a.put('orgs', { ...a.get('orgs', 'org1'), name: 'Changed by A' }); await a.flushed();
    b.put('orgs', { ...b.get('orgs', 'org1'), name: 'Changed by B (stale)' }); await b.flushed();
    const db = (await a.pool.query("SELECT data->>'name' AS n, version FROM records WHERE collection = 'orgs' AND id = 'org1'")).rows[0];
    assert.equal(db.n, 'Changed by A');                                          // A's change was not overwritten
    assert.equal(b.get('orgs', 'org1').name, 'Changed by A');                   // B reloaded the database copy
    assert.equal(b.conflicts.length, 1); assert.deepEqual([b.conflicts[0].collection, b.conflicts[0].id, b.conflicts[0].op], ['orgs', 'org1', 'update']);
    await b.flushed();
    const audit = (await a.pool.query("SELECT target, detail FROM audit WHERE action = 'write.conflict'")).rows;
    assert.equal(audit.length, 1); assert.equal(audit[0].target, 'orgs/org1');  // recorded for a person to review
    void o;
  } finally { await end(a, b); }
});

test('change notifications keep the other server current: create, update, delete', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const [a, b] = await pair();
  try {
    a.put('permits', { id: 'p1', permitId: 'S1', address: '1 Main St', status: 'Applied' }); await a.flushed();
    assert.ok(await until(() => b.get('permits', 'p1')?.status === 'Applied'));
    a.put('permits', { ...a.get('permits', 'p1'), status: 'Issued' }); await a.flushed();
    assert.ok(await until(() => b.get('permits', 'p1')?.status === 'Issued'));
    b.put('permits', { ...b.get('permits', 'p1'), status: 'Finaled' }); await b.flushed();     // B was current: no conflict
    assert.equal(b.conflicts.length, 0);
    assert.ok(await until(() => a.get('permits', 'p1')?.status === 'Finaled'));
    a.remove('permits', 'p1'); await a.flushed();
    assert.ok(await until(() => !b.get('permits', 'p1')));
  } finally { await end(a, b); }
});

test('one server saving the same record many times in a row never conflicts with itself; stale deletes are refused', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const [a, b] = await pair();
  try {
    for (let i = 0; i < 25; i++) { a.put('orgs', { id: 'o2', name: 'v' + i, status: 'active' }); a.save(); }   // queued back to back
    await a.flushed();
    assert.equal(a.conflicts.length, 0);
    assert.equal((await a.pool.query("SELECT data->>'name' AS n, version FROM records WHERE id = 'o2'")).rows[0].n, 'v24');
    assert.ok(await until(() => b.get('orgs', 'o2')?.name === 'v24'));
    b.listener.removeAllListeners('notification');
    a.put('orgs', { ...a.get('orgs', 'o2'), name: 'kept' }); await a.flushed();
    b.remove('orgs', 'o2'); await b.flushed();                                    // B deletes a version it never saw
    assert.equal((await a.pool.query("SELECT data->>'name' AS n FROM records WHERE id = 'o2'")).rows[0]?.n, 'kept');
    assert.equal(b.conflicts.at(-1).op, 'delete'); assert.equal(b.get('orgs', 'o2').name, 'kept');
  } finally { await end(a, b); }
});

test('a large save (2,000 records with long ids) succeeds and every change reaches the other server', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const [a, b] = await pair();
  try {
    for (let i = 0; i < 2000; i++) a.put('projectLinks', { id: `permit:per_${'x'.repeat(24)}_${i}`, projectId: 'BI-TESTPROJ', kind: 'permit', refId: 'per_' + i });
    await a.flushed();
    assert.equal(a.lastFlushError, null);                                        // regression: 8,000-byte notification limit
    assert.equal((await a.pool.query("SELECT count(*)::int n FROM records WHERE collection = 'projectLinks'")).rows[0].n, 2000);
    assert.ok(await until(() => b.list('projectLinks').length === 2000, 5000), `other server saw ${b.list('projectLinks').length}`);
  } finally { await end(a, b); }
});
