import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { hashPassword } from '../src/security.js';
import { PLATFORM_ROLES } from '../src/admin/rbac.js';
import { totp } from '../src/admin/mfa.js';
import { aiAllowance } from '../src/entitlements.js';

const PW = 'correct horse battery 1';
// A stand-in city open-data API (Socrata shape) so "retry" pulls real records through the real adapter.
const cityApi = async url => ({ ok: true, status: 200, json: async () => String(url).includes('$select=count') ? [{ count: '1' }] : [
  { permit_num: 'R-1', permit_type_desc: 'New', description: 'New commercial office building', original_address1: '9 Lake St', issue_date: new Date().toISOString(), status_current: 'Issued', total_job_valuation: '2500000', latitude: '30.27', longitude: '-97.74' }] });
async function world(t) {
  const store = new Store(null);
  const bc = store.put('orgs', { slug: 'bc', name: 'Bright Clean', status: 'active', settings: {}, subscription: { plan: 'internal', status: 'active' } });
  const sub = store.put('orgs', { slug: 'sp', name: 'Sparky Electric', kind: 'subscriber', trades: ['electrical'], territories: ['TX'], status: 'active', settings: {}, subscription: { plan: 'trial', status: 'trialing', trialEndsAt: new Date(Date.now() + 3 * 864e5).toISOString() } });
  const user = (email, orgId, extra = {}) => store.put('users', { email, orgId, role: 'owner', passwordHash: hashPassword(PW), ...extra });
  const ids = { owner: user('eric@bc.test', bc.id, { role: 'platform_owner' }).id, staff: user('ops@bc.test', bc.id, { role: 'member' }).id, sub: user('own@sparky.test', sub.id).id };
  const src = store.put('sources', { key: 'austin-test', name: 'Austin permits (test)', city: 'Austin', state: 'TX', adapter: 'socrata', enabled: false, method: 'api', agency: 'City of Austin Development Services', jurisdiction: 'austin-tx', url: 'https://data.example.gov', termsUrl: 'https://data.example.gov/terms', refreshCadence: 'hourly',
    authorization: { commercialReuse: true, redistribution: true, reviewedBy: 'eric@bc.test', reviewedAt: '2026-10-01', evidence: 'Open data terms snapshot 2026-10-01' },
    adapterConfig: { domain: 'data.example.gov', dataset: 'abcd-1234', fields: { permitId: 'permit_num', permitType: 'permit_type_desc', description: 'description', address: 'original_address1', issuedDate: 'issue_date', status: 'status_current', valuation: 'total_job_valuation', lat: 'latitude', lng: 'longitude' }, dateField: 'issue_date' } });
  const noTerms = store.put('sources', { key: 'unreviewed', name: 'Unreviewed feed', state: 'TX', adapter: 'socrata', enabled: false });
  const srv = createServer(store, { fetchImpl: cityApi }).listen(0); await new Promise(r => srv.once('listening', r)); t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: m === 'GET' || b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const login = async (e, code) => (await call('POST', '/api/login', { email: e, password: PW, code })).body.token;
  return { store, sub, src, noTerms, ids, call, login };
}

const ROUTES = [['GET', '/api/admin/subscriptions', 'admin.billing.read'], ['POST', '/api/admin/subscriptions/X/adjust', 'admin.billing.manage'], ['GET', '/api/admin/sources', 'admin.source.manage'],
  ['POST', '/api/admin/sources/X/enabled', 'admin.source.manage'], ['POST', '/api/admin/sources/X/retry', 'admin.source.manage'], ['POST', '/api/admin/sources/X/resync', 'admin.source.manage'],
  ['GET', '/api/admin/ai/usage', 'admin.ai.manage'], ['POST', '/api/admin/ai/X/limit', 'admin.ai.manage'], ['POST', '/api/admin/users/X/mfa-reset', 'admin.security.manage']];

test('phase 4 permission matrix: every new route × every platform role; company users denied', async (t) => {
  const w = await world(t);
  const cu = await w.login('own@sparky.test');
  for (const [m, p] of ROUTES) assert.equal((await w.call(m, p, {}, cu)).status, 403);
  for (const role of Object.keys(PLATFORM_ROLES).filter(r => r !== 'platform_owner')) {
    const u = w.store.get('users', w.ids.staff); u.platformRoles = [role]; w.store.put('users', u);
    const tok = await w.login('ops@bc.test');
    for (const [m, p, perm] of ROUTES) { const st = (await w.call(m, p, {}, tok)).status, ok = PLATFORM_ROLES[role].permissions.includes(perm);
      if (ok) assert.notEqual(st, 403, `${role} → ${m} ${p}`); else assert.equal(st, 403, `${role} must be denied ${m} ${p}`); }
  }
});

test('workflow 11: manual plan changes grant access but never a payment state; revenue stays unavailable', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test');
  const adj = b => w.call('POST', `/api/admin/subscriptions/${w.sub.id}/adjust`, b, owner);
  assert.equal((await adj({ action: 'extend_trial', days: 14, reason: 'Pilot customer needs more time' })).status, 428);
  await w.call('POST', '/api/admin/step-up', { password: PW }, owner);
  const ext = await adj({ action: 'extend_trial', days: 14, reason: 'Pilot customer needs more time' });
  assert.ok(Date.parse(ext.body.subscription.trialEndsAt) > Date.now() + 16 * 864e5);
  assert.equal((await adj({ action: 'set_plan', plan: 'publisher_pro', reason: 'wrong line test' })).status, 400);     // publisher plan on a subscriber
  const set = await adj({ action: 'set_plan', plan: 'professional', reason: 'Comped for the Bright Clean pilot' });
  assert.equal(set.body.subscription.plan, 'professional'); assert.match(set.body.subscription.paymentState, /none — manual/);
  const list = (await w.call('GET', '/api/admin/subscriptions', undefined, owner)).body;
  assert.equal(list.revenue.value, null); assert.match(list.revenue.unavailable, /Stripe not connected/); assert.equal(list.stripe, 'not connected');
  assert.ok(list.catalog.every(c => /proposed/.test(c.priceStatus)));
  assert.equal(w.store.data.audit.filter(a => a.action === 'admin.billing.adjust').length, 2);
});

test('data sources: unreviewed terms cannot run; resume → retry pulls real records → import history → resync archives', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test');
  const blocked = await w.call('POST', `/api/admin/sources/${w.noTerms.id}/enabled`, { enabled: true, reason: 'turn it on' }, owner);
  assert.match(blocked.body.error, /commercial reuse not confirmed.*no named reviewer/);          // the collector's exact rule, listed
  const listed = (await w.call('GET', '/api/admin/sources', undefined, owner)).body.items;
  assert.deepEqual(listed.map(x => [x.key, x.authorized]).sort(), [['austin-test', true], ['unreviewed', false]]);
  assert.equal((await w.call('POST', `/api/admin/sources/${w.src.id}/retry`, { reason: 'try it' }, owner)).status, 409);       // paused
  assert.equal((await w.call('POST', `/api/admin/sources/${w.src.id}/enabled`, { enabled: true, reason: 'Terms reviewed; start Austin feed' }, owner)).status, 200);
  const r = await w.call('POST', `/api/admin/sources/${w.src.id}/retry`, { reason: 'Pull now after enabling' }, owner);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.result.inserted, 1); assert.equal(r.body.newProjects, 1);
  const d = (await w.call('GET', `/api/admin/sources/${w.src.id}`, undefined, owner)).body;
  assert.deepEqual([d.records.active, d.importRuns[0].status, d.importRuns[0].inserted], [1, 'ok', 1]); assert.match(d.freshness, /^fresh/);
  const again = await w.call('POST', `/api/admin/sources/${w.src.id}/retry`, { reason: 'Second pull to confirm no duplicates' }, owner);
  assert.deepEqual([again.body.result.inserted, again.body.newProjects], [0, 0]);                       // retry is idempotent: no duplicate records
  assert.equal((await w.call('GET', `/api/admin/sources/${w.src.id}`, undefined, owner)).body.records.active, 1);
  assert.equal((await w.call('POST', `/api/admin/sources/${w.src.id}/resync`, { reason: 'Field mapping changed' }, owner)).status, 428);
  await w.call('POST', '/api/admin/step-up', { password: PW }, owner);
  assert.equal((await w.call('POST', `/api/admin/sources/${w.src.id}/resync`, { reason: 'Field mapping changed' }, owner)).body.archived, 1);
});

test('workflow 13 (partial): AI limits can only lower the plan allowance, and the analyzer enforces them; cost/accuracy stay unavailable', async (t) => {
  const w = await world(t);
  const owner = await w.login('eric@bc.test');
  w.sub.subscription = { plan: 'growth', status: 'active' }; w.store.put('orgs', w.sub);
  assert.equal(aiAllowance(w.store.get('orgs', w.sub.id)), 50);
  assert.equal((await w.call('POST', `/api/admin/ai/${w.sub.id}/limit`, { limit: 5, reason: 'Unusual volume; investigating' }, owner)).body.allowance, 5);
  assert.equal(aiAllowance(w.store.get('orgs', w.sub.id)), 5);
  assert.equal((await w.call('POST', `/api/admin/ai/${w.sub.id}/limit`, { limit: 500, reason: 'raise above plan' }, owner)).body.allowance, 50);   // cannot exceed plan
  const u = (await w.call('GET', '/api/admin/ai/usage', undefined, owner)).body;
  assert.equal(u.cost.value, null); assert.match(u.accuracy.unavailable, /BLOCKED/);
});

test('MFA: enroll with a real code; sign-in and step-up need it; wrong and reused codes refused; reset signs the user out', async (t) => {
  const w = await world(t);
  let owner = await w.login('eric@bc.test');
  const setup = (await w.call('POST', '/api/admin/mfa/setup', {}, owner)).body;
  assert.match(setup.uri, /^otpauth:\/\/totp\/BUILDINTEL:/);
  assert.equal((await w.call('POST', '/api/admin/mfa/enable', { code: '000000' }, owner)).status, 400);
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await w.call('POST', '/api/admin/mfa/enable', { code: totp(setup.secret, step) }, owner)).status, 200);
  assert.ok(!JSON.stringify(w.store.get('users', w.ids.owner)).includes(setup.secret));                // stored sealed, not in plain text
  const noCode = await w.call('POST', '/api/login', { email: 'eric@bc.test', password: PW });
  assert.deepEqual([noCode.status, noCode.body.mfaRequired], [401, true]);
  assert.equal((await w.call('POST', '/api/login', { email: 'eric@bc.test', password: PW, code: totp(setup.secret, step) })).status, 401);   // the enrolment code again: replay refused
  // Step-up on the session that existed before enrolment now needs the code as well (each code usable once, in order).
  assert.equal((await w.call('POST', '/api/admin/step-up', { password: PW }, owner)).status, 401);
  assert.equal((await w.call('POST', '/api/admin/step-up', { password: PW, code: totp(setup.secret, step) }, owner)).status, 401);       // already used
  assert.equal((await w.call('POST', '/api/admin/step-up', { password: PW, code: totp(setup.secret, step + 1) }, owner)).status, 200);
  assert.equal((await w.call('POST', '/api/login', { email: 'eric@bc.test', password: PW, code: totp(setup.secret, step + 1) })).status, 401);   // used by step-up
  // A security admin (the owner) resets a lost authenticator for another staff member.
  const s2 = w.store.get('users', w.ids.staff); s2.platformRoles = ['verification_reviewer']; w.store.put('users', s2);
  const ops = await w.login('ops@bc.test'); const ss = (await w.call('POST', '/api/admin/mfa/setup', {}, ops)).body;
  assert.equal((await w.call('POST', '/api/admin/mfa/enable', { code: totp(ss.secret) }, ops)).status, 200);
  assert.equal(await w.login('ops@bc.test'), undefined);                                                // now needs a code
  const reset = await w.call('POST', `/api/admin/users/${w.ids.staff}/mfa-reset`, { reason: 'Lost phone; identity confirmed by video call' }, owner);
  assert.deepEqual([reset.status, reset.body.sessionsRevoked >= 1], [200, true]);
  assert.equal((await w.call('GET', '/api/admin/me', undefined, ops)).status, 401);                     // signed out everywhere
  assert.equal(w.store.data.audit.filter(a => a.action === 'admin.mfa.enable').length, 2);
  assert.ok(await w.login('ops@bc.test'));                                                              // can sign in and enroll again
});
