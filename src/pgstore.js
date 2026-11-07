import crypto from 'node:crypto';
// PostgreSQL persistence. Keeps the Store's synchronous in-memory API (so every module and test
// is unchanged) and writes each change to Postgres in a single transaction per save().
// Single writer: run ONE app instance against a database. Horizontal scaling needs the async
// query refactor described in docs/SCALING.md.
import pg from 'pg';
import { CORE_SCHEMA, CORE_TABLES, writeCoreRows } from './coredb.js';
import { Store } from './store.js';
import { pgTls } from './pgtls.js';
export { pgTls };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  collection text NOT NULL,
  id text NOT NULL,
  org_id text,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS records_org_idx ON records (collection, org_id);
ALTER TABLE records ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  actor text, org_id text, action text NOT NULL, target text, detail jsonb
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit (at DESC);
CREATE TABLE IF NOT EXISTS schema_meta (key text PRIMARY KEY, value text);
INSERT INTO schema_meta VALUES ('version', '1') ON CONFLICT DO NOTHING;
`;


export class PgStore extends Store {
  /** Cross-server lock for scheduled jobs (PostgreSQL advisory lock). During a deploy the old and new servers overlap;
   *  without this both could run the hourly pull or the daily emails. Another server holding the lock = skip, not wait. */
  async withLock(name, fn) {
    const key = [...String('buildintel:' + name)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
      if (!rows[0].ok) return { ran: false, skipped: `another server is running "${name}"` };
      try { return { ran: true, result: await fn() }; } finally { await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {}); }
    } finally { client.release(); }
  }
  constructor(url, { ssl, listen } = {}) {
    super(null);
    this.url = url; this.listen = listen;
    this.tls = pgTls(url, ssl);
    this.pool = new pg.Pool({ connectionString: url, max: 4, ssl: this.tls.ssl });
    // However the pool is closed (close() or a direct pool.end()), stop reloading and drop the change listener first.
    const poolEnd = this.pool.end.bind(this.pool);
    this.pool.end = async (...args) => { this.closed = true; await this.listener?.end().catch(() => {}); return poolEnd(...args); };
    this.queue = Promise.resolve();
    this.lastFlushAt = null;
    this.lastFlushError = null;
    this.kind = 'postgres';
  }

  async init() {
    await this.pool.query(SCHEMA);
    await this.pool.query(CORE_SCHEMA);
    await this.pool.query("UPDATE schema_meta SET value = '4' WHERE key = 'version' AND value::int < 4");
    const { rows } = await this.pool.query('SELECT collection, id, data, version FROM records');
    this.versions = new Map(); this.conflicts = []; this.instanceId = crypto.randomUUID();
    for (const r of rows) if (this.data[r.collection]) { this.data[r.collection][r.id] = r.data; this.versions.set(r.collection + '\u0000' + r.id, Number(r.version)); }
    if (this.listen !== false) await this.#startListening();
    // First start of schema v2 (or a table emptied by hand): copy core records into the relational tables.
    const empty = (await this.pool.query('SELECT count(*)::int AS n FROM bi_projects')).rows[0].n === 0;
    if (empty && Object.keys(this.data.projects || {}).length) {
      const client = await this.pool.connect();
      try { await client.query('BEGIN');
        await writeCoreRows(client, Object.keys(CORE_TABLES).flatMap(c => Object.values(this.data[c] || {}).map(r => [c, r])), []);
        await client.query('COMMIT'); } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    }
    // Permits table out of step with the records (first start of this version, or rebuilt by hand): resync it.
    const pc = (await this.pool.query('SELECT count(*)::int AS n FROM bi_permits')).rows[0].n, pm = Object.keys(this.data.permits || {}).length;
    if (pc !== pm) { await import('./leads.js');                     // registers the derived-value functions
      const client = await this.pool.connect();
      try { await client.query('BEGIN'); await client.query('TRUNCATE bi_permits');
        const all = Object.values(this.data.permits || {}); for (let n = 0; n < all.length; n += 500) await writeCoreRows(client, all.slice(n, n + 500).map(r => ['permits', r]), []);
        await client.query('COMMIT'); } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); } }
    const a = await this.pool.query('SELECT at, actor, org_id, action, target, detail FROM audit ORDER BY id DESC LIMIT 5000');
    this.data.audit = a.rows.reverse().map(x => ({ at: x.at.toISOString(), actor: x.actor, orgId: x.org_id, action: x.action, target: x.target, detail: x.detail }));
    this.dirty.clear(); this.pendingAudit = [];
    return this;
  }

  /** Snapshot pending changes now (so later in-memory edits can't tear a write), flush in order. */
  save() {
    if (!this.dirty.size && !this.pendingAudit.length) return this.queue;
    const puts = []; const dels = []; const corePuts = []; const coreDels = [];
    for (const [key, op] of this.dirty) {
      const [c, id] = key.split('\u0000');
      const rec = this.data[c]?.[id];
      if (op === 'del' || !rec) { dels.push([c, id]); if (CORE_TABLES[c]) coreDels.push([c, id]); }   // versions are assigned in #write (queue order)
      else { puts.push([c, id, Store.isTenant(c) ? rec.orgId : (rec.orgId || null), JSON.stringify(rec)]); if (CORE_TABLES[c]) corePuts.push([c, structuredClone(rec)]); }
    }
    const audits = this.pendingAudit;
    const snapshotKeys = new Map(this.dirty);
    this.dirty.clear(); this.pendingAudit = [];
    this.queue = this.queue.then(() => this.#write(puts, dels, audits, corePuts, coreDels)).catch(err => {
      // Put the work back so the next save retries it; surface the error to readiness + health.
      for (const [k, v] of snapshotKeys) if (!this.dirty.has(k)) this.dirty.set(k, v);
      this.pendingAudit = [...audits, ...this.pendingAudit];
      this.lastFlushError = { at: new Date().toISOString(), message: err.message };
      console.error('postgres flush failed:', err.message);
    });
    return this.queue;
  }

  async #write(puts, dels, audits, corePuts = [], coreDels = []) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Versioned writes: apply only if the database still has the version this server last saw. Versions are read
      // here (not when the save was queued) so this server's own back-to-back saves never conflict with each other.
      const K = (c, i) => c + '\u0000' + i;
      const conflicts = [];
      if (puts.length) {
        const exp = puts.map(p => this.versions.get(K(p[0], p[1])) || 0);
        const { rows } = await client.query(
          `INSERT INTO records (collection, id, org_id, data, updated_at, version)
           SELECT c, i, o, d::jsonb, now(), v FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[]) AS t(c, i, o, d, v)
           ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, org_id = EXCLUDED.org_id, updated_at = now(), version = EXCLUDED.version
           WHERE records.version = EXCLUDED.version - 1
           RETURNING collection, id, version`,
          [puts.map(p => p[0]), puts.map(p => p[1]), puts.map(p => p[2]), puts.map(p => p[3]), exp.map(v => v + 1)]);
        const applied = new Set(rows.map(r => K(r.collection, r.id)));
        puts.forEach((p, n) => applied.has(K(p[0], p[1])) ? null : conflicts.push({ collection: p[0], id: p[1], expected: exp[n], op: 'update' }));
        this._applied = rows.map(r => [r.collection, r.id, Number(r.version)]);
      } else this._applied = [];
      if (dels.length) {
        const exp = dels.map(d => this.versions.get(K(d[0], d[1])) || 0);
        const { rows } = await client.query(
          `DELETE FROM records r USING unnest($1::text[], $2::text[], $3::bigint[]) AS t(c, i, v) WHERE r.collection = t.c AND r.id = t.i AND r.version = t.v RETURNING r.collection, r.id`,
          [dels.map(d => d[0]), dels.map(d => d[1]), exp]);
        const gone = new Set(rows.map(r => K(r.collection, r.id)));
        for (let n = 0; n < dels.length; n++) if (!gone.has(K(dels[n][0], dels[n][1])) && exp[n]) conflicts.push({ collection: dels[n][0], id: dels[n][1], expected: exp[n], op: 'delete' });
        this._deleted = rows.map(r => [r.collection, r.id]);
      } else this._deleted = [];
      // Tell other servers what changed (delivered only if this transaction commits).
      const changed = [...this._applied.map(([c, i, v]) => [c, i, v]), ...this._deleted.map(([c, i]) => [c, i, -1])];
      // PostgreSQL caps a notification at 8,000 bytes: split by size, not by count (long IDs made 150 keys too big).
      let batch = [], size = 0;
      const flushNote = async () => { if (batch.length) await client.query('SELECT pg_notify($1, $2)', ['bi_changes', JSON.stringify({ src: this.instanceId, keys: batch })]); batch = []; size = 0; };
      for (const k of changed) { const len = JSON.stringify(k).length + 1; if (size + len > 7000) await flushNote(); batch.push(k); size += len; }
      await flushNote();
      this._conflicts = conflicts;
      await writeCoreRows(client, corePuts, coreDels);   // relational core tables: same transaction, can't drift
      if (audits.length) {
        await client.query(
          `INSERT INTO audit (at, actor, org_id, action, target, detail)
           SELECT a, b, c, d, e, f::jsonb FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(a, b, c, d, e, f)`,
          [audits.map(x => x.at), audits.map(x => x.actor), audits.map(x => x.orgId), audits.map(x => x.action), audits.map(x => x.target), audits.map(x => JSON.stringify(x.detail ?? null))]);
      }
      await client.query('COMMIT');
      this.lastFlushAt = new Date().toISOString(); this.lastFlushError = null;
      for (const [c, i, v] of this._applied) this.versions.set(K(c, i), v);
      for (const [c, i] of this._deleted) this.versions.delete(K(c, i));
      if (this._conflicts.length) await this.#resolveConflicts(this._conflicts);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  /** Another server changed these records first: the database copy wins, is loaded back, and the conflict is recorded
   *  (never silent). The losing change is described in the audit log so it can be re-applied by a person if needed. */
  async #resolveConflicts(list) {
    await this.#reload(list.map(x => [x.collection, x.id]));
    const at = new Date().toISOString();
    for (const x of list) {
      this.conflicts.push({ ...x, at });
      this.pendingAudit.push({ at, actor: 'system', orgId: null, action: 'write.conflict', target: `${x.collection}/${x.id}`, detail: { expectedVersion: x.expected, op: x.op, resolution: 'database copy kept; local change not applied' } });
    }
    if (this.conflicts.length > 500) this.conflicts = this.conflicts.slice(-500);
    console.error(`write conflict on ${list.length} record(s): database copy kept`, list.slice(0, 5).map(x => x.collection + '/' + x.id).join(', '));
  }
  /** Load the current database copy of these records into memory (or drop them if deleted). */
  async #reload(keys) {
    if (!keys.length || this.closed) return;
    const { rows } = await this.pool.query('SELECT r.collection, r.id, r.data, r.version FROM records r JOIN unnest($1::text[], $2::text[]) AS t(c, i) ON r.collection = t.c AND r.id = t.i',
      [keys.map(k => k[0]), keys.map(k => k[1])]);
    const found = new Set();
    for (const r of rows) { found.add(r.collection + '\u0000' + r.id); if (this.data[r.collection]) { this.data[r.collection][r.id] = r.data; this.versions.set(r.collection + '\u0000' + r.id, Number(r.version)); } }
    for (const [c, i] of keys) if (!found.has(c + '\u0000' + i) && this.data[c]) { delete this.data[c][i]; this.versions.delete(c + '\u0000' + i); }
    this._coreIdx = null; this._linkSeq = null;            // derived caches rebuild on next use
  }
  /** Change notifications from other servers: reload exactly the records they changed. */
  async #startListening() {
    this.listener = new pg.Client({ connectionString: this.url, ssl: this.tls.ssl });
    await this.listener.connect();
    this.listener.connection?.stream?.unref?.();           // don't keep the process alive just for change notifications
    this.listener.on('notification', msg => {
      if (this.closed) return;
      let m; try { m = JSON.parse(msg.payload); } catch { return; }
      if (m.src === this.instanceId) return;
      const stale = m.keys.filter(([c, i, v]) => { const k = c + '\u0000' + i; return !this.dirty.has(k) && (v === -1 ? this.data[c]?.[i] : (this.versions.get(k) || 0) < v); });
      if (stale.length) this.queue = this.queue.then(() => this.#reload(stale.map(([c, i]) => [c, i]))).catch(e => console.error('reload after notification failed', e.message));
      this.notificationsReceived = (this.notificationsReceived || 0) + stale.length;
    });
    this.listener.on('error', e => { console.error('change listener error', e.message); this.listenerError = e.message; });
    await this.listener.query('LISTEN bi_changes');
  }

  async flushed() { this.save(); await this.queue; }
  async close() {
    this.closed = true;                                   // late notifications and queued reloads are ignored from here on
    await this.flushed().catch(() => {});
    await this.queue.catch(() => {});                     // let an in-flight reload finish before the pool closes
    await this.listener?.end().catch(() => {});
    await this.pool.end();
  }

  /** One-time import of the pilot's JSON file into Postgres. */
  async importFrom(jsonStore) {
    for (const c of Store.COLLECTIONS) for (const [id, rec] of Object.entries(jsonStore.data[c] || {})) { this.data[c][id] = rec; this.mark(c, id); }
    this.pendingAudit = [...jsonStore.data.audit]; this.data.audit = [...jsonStore.data.audit];
    await this.flushed();
  }
}
