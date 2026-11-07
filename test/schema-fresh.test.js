// Regression: the store must initialize on an EMPTY database. The core schema once ran an ALTER
// on bi_project_phases before creating that table, so every fresh install failed at startup.
// This runs the real PgStore.init() against a brand-new, empty schema.
import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PgStore } from '../src/pgstore.js';

const url = process.env.TEST_DATABASE_URL;

test('the store initializes on an empty database and the phases table has its seq column', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  const schema = 'bi_fresh_' + crypto.randomBytes(6).toString('hex');
  let store = null;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = url + (url.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent(`-c search_path=${schema}`);
    store = await new PgStore(scoped, { listen: false }).init();
    const { rows } = await admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'bi_project_phases'`, [schema]);
    assert.ok(rows.some((r) => r.column_name === 'seq'), 'bi_project_phases has the seq column');
  } finally {
    if (store && store.pool) await store.pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
