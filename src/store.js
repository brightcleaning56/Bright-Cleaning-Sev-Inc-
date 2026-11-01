'use strict';

const fs = require('fs');
const path = require('path');
const { newId } = require('./util');

// Platform-wide records (no tenant owner). Public permit data, source registry,
// platform-wide unsubscribe list (honoured for every sender), and system jobs.
const GLOBAL = ['orgs', 'permits', 'sources', 'suppressions', 'jobs'];

// Tenant-private records. Every read and write MUST carry an orgId.
const TENANT = ['opportunities', 'bids', 'proposals', 'contacts', 'audit'];

/**
 * File-backed JSON store with atomic writes. Designed for the pilot. The
 * interface (orgId-scoped queries) is intentionally the same one a PostgreSQL
 * implementation would expose, so it can be swapped without touching domain code.
 */
class Store {
  constructor(file) {
    this.file = file || null;
    this.collections = {};
    for (const name of [...GLOBAL, ...TENANT]) this.collections[name] = [];
    this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const name of Object.keys(this.collections)) {
      const rows = raw && raw.collections ? raw.collections[name] : undefined;
      this.collections[name] = Array.isArray(rows) ? rows : [];
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, collections: this.collections }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _rows(name) {
    if (!(name in this.collections)) throw new Error(`Unknown collection: ${name}`);
    return this.collections[name];
  }

  _requireScope(name, orgId) {
    if (GLOBAL.includes(name)) return;
    if (!orgId) throw new Error(`orgId is required to access tenant collection "${name}"`);
  }

  list(name, orgId, predicate = () => true) {
    this._requireScope(name, orgId);
    const tenant = TENANT.includes(name);
    return this._rows(name).filter((r) => (!tenant || r.orgId === orgId) && predicate(r));
  }

  get(name, orgId, recordId) {
    return this.list(name, orgId, (r) => r.id === recordId)[0] || null;
  }

  /**
   * PRIVILEGED: reads tenant rows across every organisation. Use only for
   * platform-wide duties such as honouring an unsubscribe request.
   */
  listAllTenants(name, predicate = () => true) {
    if (!TENANT.includes(name)) throw new Error(`listAllTenants is only for tenant collections`);
    return this._rows(name).filter(predicate);
  }

  insert(name, record) {
    this._requireScope(name, record.orgId);
    const now = new Date().toISOString();
    const row = { id: record.id || newId(name), ...record, createdAt: now, updatedAt: now };
    this._rows(name).push(row);
    this.save();
    return row;
  }

  update(name, orgId, recordId, patch) {
    const row = this.get(name, orgId, recordId);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return row;
  }

  // Global-only convenience: insert or replace a row keyed by `key`.
  upsertGlobal(name, key, keyField, record) {
    if (!GLOBAL.includes(name)) throw new Error(`upsertGlobal only supports global collections`);
    const rows = this._rows(name);
    const idx = rows.findIndex((r) => r[keyField] === key);
    if (idx === -1) return this.insert(name, record);
    rows[idx] = { ...rows[idx], ...record, updatedAt: new Date().toISOString() };
    this.save();
    return rows[idx];
  }
}

function audit(store, orgId, actor, action, entityId, detail) {
  return store.insert('audit', {
    orgId,
    actor,
    action,
    entityId: entityId || null,
    detail: detail || null,
  });
}

module.exports = { Store, audit, GLOBAL, TENANT };
