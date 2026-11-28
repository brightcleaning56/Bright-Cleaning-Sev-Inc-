// Google Ads and Meta connection checks against mock provider endpoints (no real account is contacted).
// Covers: connect and callback (state is single-use), encrypted token storage, owner-only actions, linking a
// local campaign to a provider campaign, read-only spend sync (idempotent), and disconnect.
// Run: node tests/marketing-providers-test.js
const { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), http = require('http');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function check(name, fn) { try { const ev = await fn(); results.push(1); console.log('PASS  ' + name + (ev ? ' — ' + ev : '')); } catch (e) { results.push(0); console.log('FAIL  ' + name + ' -> ' + e.message); } }

const GOOGLE_TOKEN = 'g-access-SECRET-' + crypto.randomBytes(6).toString('hex');
const GOOGLE_REFRESH = 'g-refresh-SECRET-' + crypto.randomBytes(6).toString('hex');
const META_LONG = 'm-long-SECRET-' + crypto.randomBytes(6).toString('hex');

// Mock provider: token exchange, account lookup, spend reports. Checks the headers Google requires.
function mockProvider() {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const u = new URL(req.url, 'http://x'); hits.push(req.method + ' ' + u.pathname);
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/token') {
        const f = new URLSearchParams(body);
        if (f.get('grant_type') === 'authorization_code' && f.get('code') === 'g-code') return json(200, { access_token: GOOGLE_TOKEN, refresh_token: GOOGLE_REFRESH, expires_in: 3600 });
        if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === GOOGLE_REFRESH) return json(200, { access_token: GOOGLE_TOKEN + '-r', expires_in: 3600 });
        return json(400, { error: 'invalid_grant', error_description: 'bad code' });
      }
      if (u.pathname === '/v21/customers:listAccessibleCustomers') return json(200, { resourceNames: ['customers/1234567890'] });
      if (u.pathname === '/v21/customers/1234567890/googleAds:searchStream') {
        if (!req.headers['developer-token']) return json(401, { error: { message: 'developer token missing' } });
        if (!/cost_micros/.test(JSON.parse(body).query)) return json(400, { error: { message: 'bad query' } });
        return json(200, [{ results: [
          { campaign: { id: '111' }, segments: { date: '2026-11-20' }, metrics: { costMicros: '42500000' } },
          { campaign: { id: '999' }, segments: { date: '2026-11-20' }, metrics: { costMicros: '1000000' } },
        ] }]);
      }
      if (u.pathname === '/v23/oauth/access_token') {
        if (u.searchParams.get('code') === 'm-code') return json(200, { access_token: 'm-short' });
        if (u.searchParams.get('grant_type') === 'fb_exchange_token' && u.searchParams.get('fb_exchange_token') === 'm-short') return json(200, { access_token: META_LONG, expires_in: 5184000 });
        return json(400, { error: { message: 'Invalid code' } });
      }
      if (u.pathname === '/v23/me/adaccounts') return json(200, { data: [{ account_id: '555', name: 'Bright Test Account' }] });
      if (u.pathname === '/v23/act_555/insights') return json(200, { data: [{ campaign_id: '777', date_start: '2026-11-20', spend: '12.34' }] });
      return json(404, { error: { message: 'not mocked: ' + u.pathname } });
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, base: 'http://127.0.0.1:' + srv.address().port, hits })));
}

(async () => {
  const mock = await mockProvider();
  // A port range that other local servers do not use, so the health check cannot reach a different server.
  const PORT = 5400 + Math.floor(Math.random() * 50), B = 'http://127.0.0.1:' + PORT;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-prov-'));
  const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 8),
    DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'up'), PUBLIC_BASE_URL: 'https://brightclean.net', TWILIO_FORWARD_TO: '+15155550199', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_NUMBER: '+15153033024', TWILIO_AUTH_TOKEN: 'tw-prov-token', FROM_EMAIL: 'info@brightclean.net', NOTIFY_EMAIL: 'info@brightclean.net',
    MARKETING_TOKEN_KEY: crypto.randomBytes(24).toString('hex'),
    GOOGLE_ADS_CLIENT_ID: 'google-client-id.test', GOOGLE_ADS_CLIENT_SECRET: 'google-client-secret', GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token-test',
    GOOGLE_ADS_AUTHORIZE_URL: mock.base + '/authorize', GOOGLE_ADS_TOKEN_URL: mock.base + '/token', GOOGLE_ADS_API_BASE: mock.base + '/v21',
    META_APP_ID: 'meta-app-id-test', META_APP_SECRET: 'meta-app-secret', META_AUTHORIZE_URL: mock.base + '/authorize-meta', META_API_BASE: mock.base + '/v23' };
  delete env.SMTP_HOST; delete env.POSTMARK_TOKEN;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
  const api = async (m, u, j, t) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  let stateOf = {};
  try {
    const signIn = require('./mfa-helper')((p, b, t) => api('POST', p, b, t));
    const T = await signIn(OWNER, PW);
    const mgr = 'providers.manager@brightclean.test', PWM = 'manager-temp-password-1234';
    assert((await api('POST', '/api/admin/users', { email: mgr, name: 'Manager', password: PWM, role: 'manager' }, T)).status < 300, 'create manager');
    const M = await signIn(mgr, PWM);

    await check('Status: both providers configured, nothing connected, no secrets shown', async () => {
      const r = await api('GET', '/api/admin/marketing/providers', null, T);
      assert(r.status === 200, 'got ' + r.status);
      assert(r.data.providers.every(p => p.configured && !p.connected), 'expected configured and not connected');
      assert(!JSON.stringify(r.data).includes('secret'), 'a secret value leaked into the status');
      return r.data.providers.map(p => p.provider).join(', ');
    });
    let gCampaign = null, mCampaign = null;
    await check('Owner creates a Google Ads and a Meta campaign to link', async () => {
      const g = await api('POST', '/api/admin/marketing/campaigns', { name: 'Google spring', channel: 'google_ads', budget_amount: 0 }, T);
      const m = await api('POST', '/api/admin/marketing/campaigns', { name: 'Meta spring', channel: 'meta_ads', budget_amount: 0 }, T);
      assert(g.status === 201 && m.status === 201, 'create failed');
      gCampaign = g.data.campaign.id; mCampaign = m.data.campaign.id; return `#${gCampaign}, #${mCampaign}`;
    });
    await check('Manager cannot start a provider connection', async () => {
      const r = await api('POST', '/api/admin/marketing/providers/google_ads/connect', {}, M);
      assert(r.status === 403, 'got ' + r.status);
    });
    await check('Connect returns a sign-in link with a one-time state and no token', async () => {
      const r = await api('POST', '/api/admin/marketing/providers/google_ads/connect', {}, T);
      assert(r.status === 200, 'got ' + r.status + ' ' + JSON.stringify(r.data));
      const u = new URL(r.data.url);
      assert(u.searchParams.get('client_id') === 'google-client-id.test', 'client id missing');
      assert(u.searchParams.get('access_type') === 'offline' && u.searchParams.get('scope').includes('adwords'), 'offline adwords scope missing');
      assert(u.searchParams.get('redirect_uri') === 'https://brightclean.net/api/marketing/providers/google_ads/callback', 'redirect uri: ' + u.searchParams.get('redirect_uri'));
      stateOf.google = u.searchParams.get('state'); assert(stateOf.google && stateOf.google.length >= 40, 'state too short');
    });
    await check('Callback with a wrong state is refused', async () => {
      const r = await fetch(B + '/api/marketing/providers/google_ads/callback?code=g-code&state=not-a-real-state', { redirect: 'manual' });
      assert(r.status === 400, 'got ' + r.status);
    });
    await check('Callback with the right state stores the connection and returns to Marketing', async () => {
      const r = await fetch(B + `/api/marketing/providers/google_ads/callback?code=g-code&state=${stateOf.google}`, { redirect: 'manual' });
      assert(r.status === 302, 'got ' + r.status);
      assert((r.headers.get('location') || '').includes('/admin/marketing?provider=google_ads&result=connected'), 'location ' + r.headers.get('location'));
      const again = await fetch(B + `/api/marketing/providers/google_ads/callback?code=g-code&state=${stateOf.google}`, { redirect: 'manual' });
      assert(again.status === 400, 'state was reusable: ' + again.status);
    });
    await check('Status shows the account; the token is not in any response', async () => {
      const r = await api('GET', '/api/admin/marketing/providers', null, T);
      const g = r.data.providers.find(p => p.provider === 'google_ads');
      assert(g.connected && g.account_label === 'Google Ads customer 1234567890', 'not connected: ' + JSON.stringify(g));
      assert(!JSON.stringify(r.data).includes(GOOGLE_TOKEN) && !JSON.stringify(r.data).includes(GOOGLE_REFRESH), 'token leaked to the browser');
      return g.account_label;
    });
    await check('Token is stored encrypted, not as readable text', async () => {
      const db = new Database(path.join(work, 'data', 'brightclean.db'), { readonly: true });
      const rowRaw = db.prepare("SELECT token_ciphertext FROM marketing_connections WHERE provider='google_ads'").get();
      db.close();
      assert(rowRaw && rowRaw.token_ciphertext, 'no stored token');
      assert(!rowRaw.token_ciphertext.includes(GOOGLE_TOKEN) && !rowRaw.token_ciphertext.includes(GOOGLE_REFRESH), 'token stored in readable form');
    });
    await check('Owner links a local campaign to provider campaign 111', async () => {
      const bad = await api('POST', `/api/admin/marketing/campaigns/${mCampaign}/link`, { provider: 'google_ads', provider_campaign_id: '111' }, T);
      assert(bad.status === 400, 'channel mismatch was accepted: ' + bad.status);
      const r = await api('POST', `/api/admin/marketing/campaigns/${gCampaign}/link`, { provider: 'google_ads', provider_campaign_id: '111' }, T);
      assert(r.status === 200 && r.data.campaign.provider_campaign_id === '111', 'got ' + r.status);
    });
    await check('Manager cannot run a sync', async () => {
      const r = await api('POST', '/api/admin/marketing/providers/google_ads/sync', {}, M);
      assert(r.status === 403, 'got ' + r.status);
    });
    let firstSpend = null;
    await check('Google sync writes matched spend only, and unmatched rows are reported', async () => {
      const r = await api('POST', '/api/admin/marketing/providers/google_ads/sync', {}, T);
      assert(r.status === 200, 'got ' + r.status + ' ' + JSON.stringify(r.data));
      assert(r.data.rows_read === 2 && r.data.rows_written === 1 && r.data.provider_campaigns_not_linked === 1, JSON.stringify(r.data));
      const s = await api('GET', '/api/admin/marketing/summary', null, T); firstSpend = s.data.spend;
      assert(firstSpend === 42.5, 'spend should be 42.50, got ' + firstSpend);
      return '$' + firstSpend;
    });
    await check('Running the Google sync again does not double the spend', async () => {
      const r = await api('POST', '/api/admin/marketing/providers/google_ads/sync', {}, T);
      assert(r.status === 200, 'got ' + r.status);
      const s = await api('GET', '/api/admin/marketing/summary', null, T);
      assert(s.data.spend === firstSpend, 'spend changed on re-sync: ' + s.data.spend);
    });
    await check('Meta: connect, callback and account lookup', async () => {
      const c = await api('POST', '/api/admin/marketing/providers/meta_ads/connect', {}, T);
      assert(c.status === 200, 'got ' + c.status);
      stateOf.meta = new URL(c.data.url).searchParams.get('state');
      const r = await fetch(B + `/api/marketing/providers/meta_ads/callback?code=m-code&state=${stateOf.meta}`, { redirect: 'manual' });
      assert(r.status === 302 && (r.headers.get('location') || '').includes('result=connected'), 'callback: ' + r.status + ' ' + r.headers.get('location'));
      const s = await api('GET', '/api/admin/marketing/providers', null, T);
      const m = s.data.providers.find(p => p.provider === 'meta_ads');
      assert(m.connected && m.account_external_id === 'act_555' && m.account_label === 'Bright Test Account', JSON.stringify(m));
      assert(!JSON.stringify(s.data).includes(META_LONG), 'meta token leaked');
    });
    await check('Meta sync adds its spend on top of Google, without duplicates', async () => {
      const link = await api('POST', `/api/admin/marketing/campaigns/${mCampaign}/link`, { provider: 'meta_ads', provider_campaign_id: '777' }, T);
      assert(link.status === 200, 'link failed ' + link.status);
      const r = await api('POST', '/api/admin/marketing/providers/meta_ads/sync', {}, T);
      assert(r.status === 200 && r.data.rows_written === 1, JSON.stringify(r.data));
      const again = await api('POST', '/api/admin/marketing/providers/meta_ads/sync', {}, T);
      assert(again.status === 200, 'second sync failed');
      const s = await api('GET', '/api/admin/marketing/summary', null, T);
      assert(Math.abs(s.data.spend - 54.84) < 0.001, 'expected 54.84, got ' + s.data.spend);
      return '$' + s.data.spend;
    });
    await check('Disconnect removes the token; sync then refuses', async () => {
      const d = await api('POST', '/api/admin/marketing/providers/google_ads/disconnect', {}, T);
      assert(d.status === 200 && d.data.connected === false, 'disconnect failed');
      const r = await api('POST', '/api/admin/marketing/providers/google_ads/sync', {}, T);
      assert(r.status === 502 && /not connected/.test(r.data.error || ''), 'got ' + r.status + ' ' + JSON.stringify(r.data));
    });
    await check('A failed sign-in is shown on the status even before a connection exists', async () => {
      const c = await api('POST', '/api/admin/marketing/providers/google_ads/connect', {}, T);
      const st = new URL(c.data.url).searchParams.get('state');
      const r = await fetch(B + `/api/marketing/providers/google_ads/callback?error=access_denied&state=${st}`, { redirect: 'manual' });
      assert(r.status === 302 && (r.headers.get('location') || '').includes('result=refused'), 'callback: ' + r.status);
      const s = await api('GET', '/api/admin/marketing/providers', null, T);
      const g = s.data.providers.find(p => p.provider === 'google_ads');
      assert(!g.connected && /cancelled or refused/.test(g.last_error || ''), 'error not shown: ' + JSON.stringify(g));
    });
    await check('Google refresh path is used when an access token has expired', async () => {
      const c = await api('POST', '/api/admin/marketing/providers/google_ads/connect', {}, T);
      const st = new URL(c.data.url).searchParams.get('state');
      await fetch(B + `/api/marketing/providers/google_ads/callback?code=g-code&state=${st}`, { redirect: 'manual' });
      const db = new Database(path.join(work, 'data', 'brightclean.db'));
      db.prepare("UPDATE marketing_connections SET token_expires_at='2000-01-01T00:00:00.000Z' WHERE provider='google_ads'").run();
      db.close();
      const r = await api('POST', '/api/admin/marketing/providers/google_ads/sync', {}, T);
      assert(r.status === 200, 'sync after expiry failed: ' + r.status + ' ' + JSON.stringify(r.data));
      assert(mock.hits.some(h => h === 'POST /token'), 'no refresh request was sent');
    });
    await check('Provider calls only read: no write endpoint was used', async () => {
      const writes = mock.hits.filter(h => /^POST /.test(h) && !/searchStream|\/token$/.test(h));
      assert(writes.length === 0, 'unexpected write calls: ' + writes.join(', '));
    });
  } catch (e) {
    console.log('FAIL  setup -> ' + e.message); results.push(0);
  } finally {
    child.kill(); mock.srv.close();
    const failed = results.filter(x => x === 0).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    if (failed) { console.log('---- server log (tail) ----\n' + log.slice(-1500)); process.exit(1); }
    process.exit(0);
  }
})();
