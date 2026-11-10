import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Platform-level collections (shared intelligence + platform admin).
const GLOBAL = ['orgs', 'users', 'sessions', 'sources', 'permits', 'companies', 'contacts',
  'suppression', 'privacyRequests', 'jobs', 'messages', 'bidRequests', 'submissions', 'contracts', 'licenses', 'signals', 'invitations', 'documents',
  'projects', 'projectLinks', 'projectCompanies', 'projectPhases', 'projectAliases', 'reviewQueue',
  'drawingSets', 'drawingSheets', 'drawingRevisions', 'documentText', 'publications', 'adminNotes', 'supportCases', 'incidents', 'exports', 'inquiries', 'rfis'];
// Tenant collections: every record carries orgId and every access must supply it.
const TENANT = ['rateCards', 'opportunities', 'proposals', 'bids', 'credentials', 'tracked', 'savedSearches', 'analyses', 'estimates', 'prequal', 'measurements'];

export const newId = (p = '') => p + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
export const now = () => new Date().toISOString();

export class Store {
  constructor(file = null) {
    this.file = file;
    this.data = { audit: [] };
    this.dirty = new Map();      // "collection\u0000id" -> 'put' | 'del'  (consumed by durable backends)
    this.pendingAudit = [];
    for (const c of [...GLOBAL, ...TENANT]) this.data[c] = {};
    if (file && fs.existsSync(file)) this.load(fs.readFileSync(file, 'utf8'));
  }

  mark(c, id, op = 'put') { this.dirty.set(c + '\u0000' + id, op); }
  static get COLLECTIONS() { return [...GLOBAL, ...TENANT]; }
  static isTenant(c) { return TENANT.includes(c); }

  load(json) {
    const parsed = JSON.parse(json);
    for (const k of Object.keys(this.data)) if (parsed[k]) this.data[k] = parsed[k];
  }

  serialize() { return JSON.stringify(this.data); }
  // Canonical (key-order independent) so a JSON file and its Postgres copy compare equal.
  // Covers records only; audit history is append-only and stored separately.
  checksum() {
    const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
    const records = Object.fromEntries(Store.COLLECTIONS.map(c => [c, this.data[c]]));
    return crypto.createHash('sha256').update(JSON.stringify(canon(records))).digest('hex');
  }

  save() {
    this.dirty.clear(); this.pendingAudit = [];
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, this.serialize());
    fs.renameSync(tmp, this.file); // atomic replace
  }

  #assertGlobal(c) { if (!GLOBAL.includes(c)) throw new Error(`not a global collection: ${c}`); }
  #assertTenant(c, orgId) {
    if (!TENANT.includes(c)) throw new Error(`not a tenant collection: ${c}`);
    if (!orgId) throw new Error(`tenant isolation: orgId required for ${c}`);
  }

  /** Run a scheduled job at most once across all servers. Single-process storage just runs it. */
  async withLock(name, fn) { return { ran: true, result: await fn() }; }

  // ---- global ----
  put(c, rec) {
    this.#assertGlobal(c);
    rec.id ||= newId(c.slice(0, 3) + '_');
    rec.createdAt ||= now();
    rec.updatedAt = now();
    this.data[c][rec.id] = rec;
    this.mark(c, rec.id);
    return rec;
  }
  get(c, id) { this.#assertGlobal(c); return this.data[c][id] || null; }
  list(c, fn = () => true) { this.#assertGlobal(c); return Object.values(this.data[c]).filter(fn); }
  remove(c, id) { this.#assertGlobal(c); delete this.data[c][id]; this.mark(c, id, 'del'); }

  // ---- tenant-scoped ----
  tput(c, orgId, rec) {
    this.#assertTenant(c, orgId);
    if (rec.orgId && rec.orgId !== orgId) throw new Error('tenant isolation: cross-org write blocked');
    rec.orgId = orgId;
    rec.id ||= newId(c.slice(0, 3) + '_');
    rec.createdAt ||= now();
    rec.updatedAt = now();
    this.data[c][rec.id] = rec;
    this.mark(c, rec.id);
    return rec;
  }
  tget(c, orgId, id) {
    this.#assertTenant(c, orgId);
    const r = this.data[c][id];
    return r && r.orgId === orgId ? r : null;
  }
  tlist(c, orgId, fn = () => true) {
    this.#assertTenant(c, orgId);
    return Object.values(this.data[c]).filter(r => r.orgId === orgId && fn(r));
  }

  // Privileged, named cross-tenant operation: an unsubscribe must reach every tenant.
  // Kept narrow on purpose instead of loosening tenant scoping elsewhere.
  suppressEverywhere(email, reason, source) {
    const key = email.trim().toLowerCase();
    this.data.suppression[key] = { id: key, email: key, reason, source, createdAt: now() };
    this.mark('suppression', key);
    for (const c of Object.values(this.data.contacts)) {
      if ((c.email || '').toLowerCase() === key) { c.status = 'opted_out'; c.updatedAt = now(); this.mark('contacts', c.id); }
    }
    this.audit({ actor: 'system', action: 'suppression.add', target: key, detail: { reason, source } });
  }
  // Privileged, named lookup for inbound email routing: a reply arrives with only a bid id.
  findBidAnyTenant(bidId) { const b = this.data.bids[bidId]; return b || null; }

  isSuppressed(email) { return !!this.data.suppression[(email || '').trim().toLowerCase()]; }

  audit({ actor, orgId = null, action, target = null, detail = null }) {
    const ev = { at: now(), actor, orgId, action, target, detail };
    this.data.audit.push(ev);
    this.pendingAudit.push(ev);
    if (this.data.audit.length > 50000) this.data.audit.splice(0, 10000);
  }
}
