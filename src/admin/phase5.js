// Super Admin Phase 5: security incidents, job history and backups, health center, scoped expiring exports.
// Nothing here estimates a value. A check that cannot be measured says so.
import crypto from 'node:crypto';
import { adminAudit, hasPerm } from './rbac.js';

const fail = (code, error) => ({ ok: false, code, error });
const now = () => new Date().toISOString();
const text = (v, max) => String(v ?? '').trim().slice(0, max);

// ---------- incidents ----------
export const SEVERITIES = ['low', 'medium', 'high', 'critical'];
export const INCIDENT_STATUSES = ['open', 'monitoring', 'resolved'];
const INC_NEXT = { open: ['monitoring', 'resolved'], monitoring: ['open', 'resolved'], resolved: [] };

export function createIncident(store, ctx, { title, severity, summary }) {
  const t = text(title, 200);
  if (t.length < 5) return fail(400, 'title is required (5+ characters)');
  if (!SEVERITIES.includes(severity)) return fail(400, `severity must be one of ${SEVERITIES.join(', ')}`);
  const inc = store.put('incidents', { title: t, severity, status: 'open', summary: text(summary, 4000),
    openedBy: ctx.user.email, timeline: [{ at: now(), by: ctx.user.email, status: 'open', message: text(summary, 4000) || 'opened' }] });
  adminAudit(store, ctx, { action: 'admin.incident.open', target: inc.id, detail: { severity } });
  return { ok: true, incident: inc };
}

export function updateIncident(store, ctx, id, { status, message }) {
  const inc = store.get('incidents', id); if (!inc) return fail(404, 'incident not found');
  if (!INCIDENT_STATUSES.includes(status)) return fail(400, `status must be one of ${INCIDENT_STATUSES.join(', ')}`);
  if (!(INC_NEXT[inc.status] || []).includes(status) && status !== inc.status) return fail(409, `an ${inc.status} incident cannot move to ${status}`);
  const m = text(message, 4000);
  if (m.length < 5) return fail(400, 'a message is required (5+ characters)');
  const before = inc.status;
  inc.status = status; inc.updatedAt = now();
  inc.timeline = [...(inc.timeline || []), { at: now(), by: ctx.user.email, status, message: m }];
  store.put('incidents', inc);
  adminAudit(store, ctx, { action: 'admin.incident.update', target: id, before: { status: before }, after: { status }, reason: m });
  return { ok: true, incident: inc };
}

export const listIncidents = store => ({ ok: true, items: store.list('incidents').map(i => ({ id: i.id, title: i.title, severity: i.severity, status: i.status, openedBy: i.openedBy, createdAt: i.createdAt, updatedAt: i.updatedAt || i.createdAt })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) });

// ---------- job history, integrations, backups ----------
export function jobsOverview(store) {
  const jobs = store.list('jobs').slice(-200).reverse();
  const byStatus = jobs.reduce((m, j) => ((m[j.status || 'unknown'] = (m[j.status || 'unknown'] || 0) + 1), m), {});
  const integrations = store.list('sources').map(s => ({ id: s.id, name: s.name, enabled: !!s.enabled, lastSuccessAt: s.lastSuccessAt || null, lastError: s.lastError || null, lastFailureAt: s.lastFailureAt || null }));
  const backups = store.list('jobs', j => /backup/i.test(j.type || '')).slice(-1)[0] || null;
  return { ok: true, recent: jobs.slice(0, 50), counts: byStatus, integrations, lastBackup: backups ? { at: backups.createdAt, status: backups.status || null } : null,
    lastBackupNote: backups ? null : 'no backup job recorded yet; backups are not measured until one runs' };
}

// ---------- health center: every check is measured or labelled ----------
export function healthCenter(store, config, { storageKind = 'unknown', storageError = null } = {}) {
  const check = (key, label, state, detail) => ({ key, label, state, detail }); // state: ok | attention | not_connected | unmeasured
  const enabled = store.list('sources').filter(s => s.enabled).length;
  return { ok: true, asOf: now(), checks: [
    check('storage', 'Database storage', storageError ? 'attention' : 'ok', storageError ? `error: ${storageError}` : `storage: ${storageKind}`),
    check('email', 'Email sending', config.emailMode === 'live' && config.postmarkToken ? 'ok' : 'not_connected',
      config.emailMode === 'live' ? (config.postmarkToken ? 'live mode with a token (setting, not a delivery measurement)' : 'live mode selected but no Postmark token') : 'dry-run (setting; no message has been delivered)'),
    check('payments', 'Stripe payments', config.stripeSecret ? 'ok' : 'not_connected', config.stripeSecret ? 'secret key set (not a test charge)' : 'not connected'),
    check('ai', 'AI analysis', config.anthropicKey ? 'ok' : 'not_connected', config.anthropicKey ? 'key set' : 'ANTHROPIC_API_KEY not set'),
    check('secrets', 'App secret', config.appSecret && config.appSecret.length >= 32 ? 'ok' : 'attention', config.appSecret && config.appSecret.length >= 32 ? 'set' : 'APP_SECRET missing or under 32 characters'),
    check('backup_key', 'Backup encryption key', config.backupKey ? 'ok' : 'attention', config.backupKey ? 'set' : 'BACKUP_KEY not set; encrypted backups cannot run'),
    check('sources', 'Enabled data sources', enabled ? 'ok' : 'attention', `${enabled} enabled`),
    check('last_backup', 'Last backup run', store.list('jobs', j => /backup/i.test(j.type || '')).length ? 'ok' : 'unmeasured', store.list('jobs', j => /backup/i.test(j.type || '')).length ? 'recorded' : 'no backup job recorded yet'),
  ] };
}

// ---------- scoped, expiring exports ----------
export const EXPORT_DATASETS = {
  companies: { perm: 'admin.company.read', label: 'Companies (no contact details, no notes)', columns: ['id', 'name', 'status', 'type', 'createdAt'],
    rows: store => store.list('orgs', o => o.subscription?.plan !== 'internal').map(o => ({ id: o.id, name: o.name, status: o.status, type: o.kind === 'buyer' ? 'publisher' : 'subscriber', createdAt: o.createdAt })) },
  support_cases: { perm: 'admin.support.manage', label: 'Support cases (metadata only, no notes)', columns: ['id', 'subject', 'status', 'priority', 'companyId', 'createdAt', 'updatedAt'],
    rows: store => store.list('supportCases').map(c => ({ id: c.id, subject: c.subject, status: c.status, priority: c.priority, companyId: c.companyId, createdAt: c.createdAt, updatedAt: c.updatedAt })) },
  audit_recent: { perm: 'admin.audit.read', label: 'Audit log (latest 1,000 entries)', columns: ['at', 'actor', 'orgId', 'action', 'target'],
    rows: store => store.data.audit.slice(-1000).reverse().map(e => ({ at: e.at, actor: e.actor, orgId: e.orgId, action: e.action, target: e.target })) },
};
const MAX_ROWS = 5000;
const TTL_MS = 24 * 3600e3;

export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function createExport(store, ctx, { dataset, reason }) {
  const d = EXPORT_DATASETS[dataset];
  if (!d) return fail(400, `dataset must be one of ${Object.keys(EXPORT_DATASETS).join(', ')}`);
  if (!hasPerm(ctx.user, d.perm)) return fail(403, `this export needs ${d.perm}`);
  if (text(reason, 500).length < 5) return fail(400, 'a reason is required (5+ characters)');
  const rows = d.rows(store);
  if (rows.length > MAX_ROWS) return fail(400, `this export has ${rows.length} rows; the limit is ${MAX_ROWS}. Narrow it first.`);
  const token = crypto.randomBytes(24).toString('base64url');
  const rec = store.put('exports', { dataset, label: d.label, reason: text(reason, 500), createdBy: ctx.user.email, rowCount: rows.length,
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(), tokenHash: crypto.createHash('sha256').update(token).digest('hex'), downloadedAt: null,
    csv: [d.columns.join(','), ...rows.map(r => d.columns.map(c => csvCell(r[c])).join(','))].join('\n') + '\n' });
  adminAudit(store, ctx, { action: 'admin.export.create', target: rec.id, reason: text(reason, 500), detail: { dataset, rows: rows.length } });
  return { ok: true, export: { id: rec.id, dataset, label: d.label, rowCount: rows.length, expiresAt: rec.expiresAt }, token };
}

export function downloadExport(store, ctx, id, token) {
  const rec = store.get('exports', id); if (!rec) return fail(404, 'export not found');
  if (rec.createdBy !== ctx.user.email) return fail(403, 'only the person who created this export can download it');
  if (!hasPerm(ctx.user, EXPORT_DATASETS[rec.dataset]?.perm)) return fail(403, 'permission for this export has been removed');
  if (Date.now() > Date.parse(rec.expiresAt)) return fail(410, 'this export has expired; create a new one');
  if (crypto.createHash('sha256').update(String(token || '')).digest('hex') !== rec.tokenHash) return fail(403, 'invalid download token');
  rec.downloadedAt = rec.downloadedAt || now();
  store.put('exports', rec);
  adminAudit(store, ctx, { action: 'admin.export.download', target: id, detail: { dataset: rec.dataset, rows: rec.rowCount } });
  return { ok: true, csv: rec.csv, filename: `${rec.dataset}-${id}.csv` };
}

export const listExports = (store, ctx) => ({ ok: true, items: store.list('exports', e => e.createdBy === ctx.user.email)
  .map(e => ({ id: e.id, dataset: e.dataset, label: e.label, rowCount: e.rowCount, createdAt: e.createdAt, expiresAt: e.expiresAt, expired: Date.now() > Date.parse(e.expiresAt) }))
  .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) });
