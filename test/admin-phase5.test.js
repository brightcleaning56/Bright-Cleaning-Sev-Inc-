import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { createIncident, updateIncident, listIncidents, createExport, downloadExport, csvCell, healthCenter, jobsOverview } from '../src/admin/phase5.js';

const owner = { email: 'owner@bc.test', role: 'platform_owner' };
const agent = { email: 'agent@bc.test', platformRoles: ['support_agent'] };
const ctxOf = user => ({ user, requestId: 'r1' });
const reason = 'quarterly review of company accounts';

test('incidents open with a severity and move only along allowed steps, each step recorded', () => {
  const store = new Store(null);
  assert.equal(createIncident(store, ctxOf(owner), { title: 'x', severity: 'high' }).code, 400);
  assert.equal(createIncident(store, ctxOf(owner), { title: 'Login spike from one IP', severity: 'urgent' }).code, 400);
  const { incident } = createIncident(store, ctxOf(owner), { title: 'Login spike from one IP', severity: 'high', summary: 'Many failed sign-ins.' });
  assert.equal(incident.status, 'open');
  assert.equal(incident.timeline.length, 1);
  assert.equal(updateIncident(store, ctxOf(owner), incident.id, { status: 'monitoring', message: 'Blocked the address.' }).ok, true);
  assert.equal(updateIncident(store, ctxOf(owner), incident.id, { status: 'resolved', message: 'Address stayed blocked.' }).ok, true);
  assert.equal(updateIncident(store, ctxOf(owner), incident.id, { status: 'open', message: 'Reopened for review.' }).code, 409, 'resolved is final');
  assert.equal(store.get('incidents', incident.id).timeline.length, 3, 'every step recorded');
  assert.equal(listIncidents(store).items[0].status, 'resolved');
});

test('an export needs the dataset permission and a reason; a support agent cannot export the audit log', () => {
  const store = new Store(null);
  assert.equal(createExport(store, ctxOf(agent), { dataset: 'audit_recent', reason }).code, 403);
  assert.equal(createExport(store, ctxOf(owner), { dataset: 'nope', reason }).code, 400);
  assert.equal(createExport(store, ctxOf(owner), { dataset: 'companies', reason: 'no' }).code, 400, 'reason required');
  const r = createExport(store, ctxOf(owner), { dataset: 'companies', reason });
  assert.equal(r.ok, true);
  assert.ok(r.token && r.token.length > 20, 'a one-time token is returned');
  assert.ok(!JSON.stringify(store.get('exports', r.export.id)).includes(r.token), 'only a hash of the token is stored');
});

test('downloads need the creator, the right token, and a live export; expired ones are refused', () => {
  const store = new Store(null);
  const { export: e, token } = createExport(store, ctxOf(owner), { dataset: 'companies', reason }) ;
  assert.equal(downloadExport(store, ctxOf(agent), e.id, token).code, 403, 'a different person cannot download');
  assert.equal(downloadExport(store, ctxOf(owner), e.id, 'wrong-token').code, 403);
  const ok = downloadExport(store, ctxOf(owner), e.id, token);
  assert.equal(ok.ok, true);
  assert.ok(ok.csv.startsWith('id,name,status,type,createdAt'));
  const rec = store.get('exports', e.id); rec.expiresAt = '2020-01-01T00:00:00Z'; store.put('exports', rec);
  assert.equal(downloadExport(store, ctxOf(owner), e.id, token).code, 410, 'expired exports are refused');
});

test('CSV cells are escaped and spreadsheet formulas are neutralised', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.ok(csvCell('=1+1').startsWith("'"), 'formula is prefixed');
  assert.ok(csvCell('+SUM(A1)').startsWith("'"));
});

test('the health center labels what is not connected or not measured instead of calling it healthy', () => {
  const store = new Store(null);
  const cfg = { emailMode: 'dry-run', stripeSecret: '', anthropicKey: '', appSecret: 'x'.repeat(40), backupKey: '' };
  const h = healthCenter(store, cfg, { storageKind: 'postgres' });
  const by = Object.fromEntries(h.checks.map(c => [c.key, c]));
  assert.equal(by.email.state, 'not_connected');
  assert.match(by.email.detail, /no message has been delivered/);
  assert.equal(by.payments.state, 'not_connected');
  assert.equal(by.ai.state, 'not_connected');
  assert.equal(by.backup_key.state, 'attention');
  assert.equal(by.last_backup.state, 'unmeasured');
  assert.equal(by.storage.state, 'ok');
});

test('jobs overview reports counts and the last backup, or says none has run', () => {
  const store = new Store(null);
  store.put('jobs', { type: 'collect', status: 'ok' });
  store.put('jobs', { type: 'collect', status: 'failed', error: 'HTTP 503' });
  const j = jobsOverview(store);
  assert.equal(j.counts.ok, 1);
  assert.equal(j.counts.failed, 1);
  assert.equal(j.lastBackup, null);
  assert.match(j.lastBackupNote, /not measured/);
});

test('over HTTP: export creation and download are permission-gated end to end', async t => {
  const store = new Store(null);
  const bc = store.put('orgs', { slug: 'bc', name: 'Bright Clean', status: 'active', settings: {}, subscription: { plan: 'internal', status: 'active' } });
  store.put('users', { email: 'owner@bc.test', orgId: bc.id, role: 'platform_owner', passwordHash: hashPassword('correct horse battery 1') });
  const srv = createServer(store).listen(0); await new Promise(r => srv.once('listening', r)); t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const tok = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@bc.test', password: 'correct horse battery 1' }) })).json()).token;
  const H = { 'content-type': 'application/json', authorization: 'Bearer ' + tok };
  const made = await fetch(base + '/api/admin/exports', { method: 'POST', headers: H, body: JSON.stringify({ dataset: 'companies', reason }) });
  assert.equal(made.status, 200);
  const { export: e, token } = await made.json();
  const dl = await fetch(base + `/api/admin/exports/${e.id}/download?token=${encodeURIComponent(token)}`, { headers: { authorization: 'Bearer ' + tok } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-type'), /text\/csv/);
  assert.match(await dl.text(), /^id,name,status,type,createdAt/);
  const bad = await fetch(base + `/api/admin/exports/${e.id}/download?token=nope`, { headers: { authorization: 'Bearer ' + tok } });
  assert.equal(bad.status, 403);
  assert.equal((await fetch(base + '/api/admin/health')).status, 401, 'health needs a sign-in');
});
