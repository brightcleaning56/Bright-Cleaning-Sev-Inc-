// Marketing module checks: real server on a temporary database, owner/manager/staff roles, public intake attribution,
// spend import, and the lifecycle-event chain (in-process). Run: node tests/marketing-test.js
const { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) { try { const ev = await fn(); results.push({ name, status: 'PASS' }); console.log('PASS  ' + name + (ev ? ' — ' + ev : '')); } catch (e) { results.push({ name, status: 'FAIL' }); console.log('FAIL  ' + name + ' -> ' + e.message); } }

// ---------- In-process: attribution and lifecycle chain ----------
function inProcess() {
  const mk = require('../marketing');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE leads(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, contact_name TEXT, status TEXT, created_at TEXT);
    CREATE TABLE estimates(id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER);
    CREATE TABLE contracts(id INTEGER PRIMARY KEY AUTOINCREMENT, estimate_id INTEGER);
    CREATE TABLE projects(id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER);
    CREATE TABLE invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER);`);
  mk.migrate(db);
  const t = new Date().toISOString();
  db.prepare("INSERT INTO leads(id,kind,contact_name,status,created_at) VALUES(1,'bid','Pat','New',?)").run(t);
  db.prepare("INSERT INTO leads(id,kind,contact_name,status,created_at) VALUES(2,'bid','Sam','New',?)").run(t);
  db.prepare("INSERT INTO marketing_campaigns(id,name,channel,created_at,updated_at) VALUES(1,'Spring','google_ads',?,?)").run(t, t);
  db.prepare("INSERT INTO marketing_campaigns(id,name,channel,created_at,updated_at) VALUES(2,'Fall','meta_ads',?,?)").run(t, t);
  db.prepare("INSERT INTO estimates(id,lead_id) VALUES(10,1)").run();
  db.prepare("INSERT INTO contracts(id,estimate_id) VALUES(20,10)").run();
  db.prepare("INSERT INTO projects(id,contract_id) VALUES(30,20)").run();
  db.prepare("INSERT INTO invoices(id,project_id) VALUES(40,30)").run();
  db.prepare("INSERT INTO invoices(id,project_id) VALUES(41,NULL)").run();

  // First touch is kept; latest moves; touchpoints append.
  assert(mk.recordTouch(db, 1, { utm_source: 'google', utm_campaign: 'Spring', campaign_id: 1, landing_path: '/commercial-cleaning.html', referrer: 'https://www.google.com/search?q=x' }, '2026-11-01T10:00:00.000Z'), 'first touch not recorded');
  mk.recordTouch(db, 1, { utm_source: 'meta', utm_campaign: 'Fall', campaign_id: 2, landing_path: '/faq.html' }, '2026-11-05T10:00:00.000Z');
  const a = db.prepare('SELECT * FROM marketing_attribution WHERE lead_id=1').get();
  assert(a.first_source === 'google' && a.first_campaign_id === 1 && a.first_landing_path === '/commercial-cleaning.html', 'first touch changed: ' + JSON.stringify(a));
  assert(a.latest_source === 'meta' && a.latest_campaign_id === 2, 'latest touch did not move');
  assert(a.first_referrer === 'www.google.com', 'referrer should be host only, got ' + a.first_referrer);
  assert(db.prepare('SELECT COUNT(*) n FROM marketing_touchpoints WHERE lead_id=1').get().n === 2, 'touchpoints not appended');
  // Unsafe or unknown values are dropped, not stored.
  mk.recordTouch(db, 2, { utm_source: 'google', campaign_id: 999, landing_path: 'https://evil.example/x', referrer: 'not a url' });
  const b = db.prepare('SELECT * FROM marketing_attribution WHERE lead_id=2').get();
  assert(b.first_campaign_id === null && b.first_landing_path === null && b.first_referrer === null, 'unsafe values were stored: ' + JSON.stringify(b));
  // Declined consent and no-signal touches are not recorded.
  assert(!mk.recordTouch(db, 2, { utm_source: 'x', consent: 'declined' }), 'declined consent was recorded');
  assert(!mk.recordTouch(db, 2, { landing_path: '/faq.html' }), 'a touch with no campaign signal was recorded');
  // Lifecycle: a payment on an invoice linked to lead 1 resolves; an unlinked invoice goes to the exception list; duplicates are ignored.
  const r1 = mk.emitLifecycle(db, 'payment_received', { leadId: mk.leadForInvoice(db, 40), sourceModule: 'payments', sourceRecordId: 'stripe:cs_1', valueAmount: 500, occurredAt: t });
  assert(r1.ok && r1.inserted && !r1.unresolved, 'linked payment not stored');
  assert(mk.leadForContract(db, 20) === 1 && mk.leadForEstimate(db, 10) === 1, 'contract and estimate should resolve to lead 1');
  const rc = mk.emitLifecycle(db, 'contract_created', { leadId: mk.leadForEstimate(db, 10), sourceModule: 'contracts', sourceRecordId: 'contract:20', occurredAt: t });
  assert(rc.ok && rc.inserted && !rc.unresolved, 'contract_created not stored');
  const r2 = mk.emitLifecycle(db, 'payment_received', { leadId: mk.leadForInvoice(db, 40), sourceModule: 'payments', sourceRecordId: 'stripe:cs_1', valueAmount: 500, occurredAt: t });
  assert(!r2.inserted, 'duplicate delivery was stored twice');
  const r3 = mk.emitLifecycle(db, 'payment_received', { leadId: mk.leadForInvoice(db, 41), sourceModule: 'payments', sourceRecordId: 'manual:41', valueAmount: 90, occurredAt: t });
  assert(r3.ok && r3.unresolved, 'unlinked invoice should be an unresolved event');
  assert(db.prepare('SELECT COUNT(*) n FROM marketing_events WHERE lead_id IS NULL').get().n === 1, 'unresolved event not in the exception list');
  assert(db.prepare("SELECT campaign_id FROM marketing_events WHERE lead_id=1").get().campaign_id === 1, 'event should carry the first-touch campaign');
  assert(!mk.emitLifecycle(db, 'invoice_made_up', { leadId: 1, sourceModule: 'x', sourceRecordId: '1' }).ok, 'unknown event type was accepted');
  // Intake attribution never throws into the caller.
  assert(mk.recordIntake(db, 999, '{not json') === false, 'bad attribution should be contained');
  // Deleting a lead removes its attribution, but keeps lifecycle events for audit (they become unresolved).
  db.prepare('DELETE FROM leads WHERE id=1').run();
  assert(db.prepare('SELECT COUNT(*) n FROM marketing_attribution WHERE lead_id=1').get().n === 0, 'attribution should be removed with the lead');
  assert(db.prepare("SELECT COUNT(*) n FROM marketing_events WHERE source_record_id='stripe:cs_1' AND lead_id IS NULL").get().n === 1, 'event should be kept and unresolved after the lead is deleted');
  db.close();
  return 'attribution and lifecycle chain';
}

(async () => {
  const PORT = 4600 + Math.floor(Math.random() * 50), B = 'http://127.0.0.1:' + PORT;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mkt-'));
  const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 8),
    DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'up'), PUBLIC_BASE_URL: 'https://brightclean.net', TWILIO_FORWARD_TO: '+15155550199', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_NUMBER: '+15153033024', TWILIO_AUTH_TOKEN: 'tw-mkt-token', FROM_EMAIL: 'info@brightclean.net', NOTIFY_EMAIL: 'info@brightclean.net' };
  delete env.SMTP_HOST; delete env.POSTMARK_TOKEN;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
  const api = async (m, u, j, t) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  let failed = 0;
  try {
    await check('In-process: attribution and lifecycle chain', async () => inProcess());
    const signIn = require('./mfa-helper')((p, b, t) => api('POST', p, b, t));
    const T = await signIn(OWNER, PW);
    const mgrEmail = 'marketing.manager@brightclean.test', stfEmail = 'marketing.staff@brightclean.test', PWS = 'staff-temp-password-1234';
    assert((await api('POST', '/api/admin/users', { email: mgrEmail, name: 'Marketing Manager', password: PWS, role: 'manager' }, T)).status < 300, 'create manager');
    assert((await api('POST', '/api/admin/users', { email: stfEmail, name: 'Office Staff', password: PWS, role: 'staff' }, T)).status < 300, 'create staff');
    const M = await signIn(mgrEmail, PWS), S = await signIn(stfEmail, PWS);

    let campaignId = null;
    await check('Owner: creates a draft campaign (no status or approval supplied)', async () => {
      const r = await api('POST', '/api/admin/marketing/campaigns', { name: 'Spring commercial', channel: 'google_ads', service_label: 'Commercial cleaning', budget_amount: 0, budget_period: 'monthly', landing_path: '/commercial-cleaning.html' }, T);
      assert(r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.data));
      assert(r.data.campaign.status === 'draft' && r.data.campaign.approval_status === 'not_required', 'wrong initial state');
      campaignId = r.data.campaign.id; return 'draft #' + campaignId;
    });
    await check('Status cannot be set through the edit route', async () => {
      const r = await api('PATCH', '/api/admin/marketing/campaigns/' + campaignId, { status: 'active' }, T);
      assert(r.status === 400, 'got ' + r.status);
      return '400 with the status-action message';
    });
    await check('Activation is refused before approval and budget', async () => {
      const r = await api('POST', '/api/admin/marketing/campaigns/' + campaignId + '/status', { status: 'active' }, T);
      assert(r.status === 409, 'got ' + r.status);
      return '409';
    });
    await check('Owner: budget, approval, then activation (internal status only)', async () => {
      assert((await api('POST', '/api/admin/marketing/campaigns/' + campaignId + '/budget', { budget_amount: 600 }, T)).status === 200, 'budget');
      assert((await api('POST', '/api/admin/marketing/campaigns/' + campaignId + '/approve', {}, T)).status === 200, 'approve');
      const r = await api('POST', '/api/admin/marketing/campaigns/' + campaignId + '/status', { status: 'active' }, T);
      assert(r.status === 200 && r.data.campaign.status === 'active', 'activate got ' + r.status);
      assert(/No ad account was changed/.test(r.data.note), 'note should state no ad account changed');
      return 'active, internal only';
    });
    await check('Manager: can create and read, but cannot approve, change budget or import spend', async () => {
      assert((await api('GET', '/api/admin/marketing/summary', null, M)).status === 200, 'summary for manager');
      assert((await api('POST', '/api/admin/marketing/campaigns', { name: 'Manager draft', channel: 'organic' }, M)).status === 201, 'manager create');
      assert((await api('POST', '/api/admin/marketing/campaigns/' + campaignId + '/approve', {}, M)).status === 403, 'manager approve not refused');
      assert((await api('POST', '/api/admin/marketing/campaigns/' + campaignId + '/budget', { budget_amount: 9999 }, M)).status === 403, 'manager budget not refused');
      assert((await api('POST', '/api/admin/marketing/spend/import', { provider: 'google_ads', rows: [] }, M)).status === 403, 'manager spend import not refused');
      return 'owner-only actions refused';
    });
    await check('Office staff: refused on every marketing route checked', async () => {
      const routes = [['GET', '/api/admin/marketing/summary'], ['GET', '/api/admin/marketing/campaigns'], ['GET', '/api/admin/marketing/leads'], ['POST', '/api/admin/marketing/campaigns'], ['GET', '/api/admin/marketing/events/exceptions']];
      for (const [m, u] of routes) { const r = await api(m, u, m === 'POST' ? { name: 'x', channel: 'organic' } : null, S); assert(r.status === 403, m + ' ' + u + ' got ' + r.status); }
      return routes.length + ' routes refused';
    });
    await check('The public events endpoint no longer exists', async () => {
      const r = await api('POST', '/api/admin/marketing/events', { event_type: 'payment_received', lead_id: 1, value_amount: 1 }, T);
      assert(r.status === 404, 'got ' + r.status);
      return '404';
    });
    await check('Campaign list is paged and reports totals', async () => {
      const r = await api('GET', '/api/admin/marketing/campaigns?limit=1&offset=0', null, T);
      assert(r.status === 200 && r.data.campaigns.length === 1 && r.data.total >= 2 && r.data.limit === 1, 'paging wrong');
      return 'total ' + r.data.total;
    });

    // Public intake with campaign attribution
    const form = (o) => new URLSearchParams(o).toString();
    const post = (body) => fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    await check('Inquiry from a campaign link records first and latest touch', async () => {
      const attr = JSON.stringify({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'Spring commercial', campaign_id: campaignId, landing_path: '/commercial-cleaning.html', referrer: 'https://www.google.com/', first: { utm_source: 'google', utm_campaign: 'Spring commercial', campaign_id: campaignId, landing_path: '/commercial-cleaning.html' } });
      const r = await post(form({ name: 'Campaign Lead', email: 'campaign.lead@example.test', message: 'Need a quote for an office', attr_json: attr }));
      assert(r.status === 201, 'intake got ' + r.status);
      const list = await api('GET', '/api/admin/marketing/leads?limit=200', null, T);
      const row = list.data.leads.find(l => l.contact_name === 'Campaign Lead');
      assert(row, 'lead not in attribution list');
      assert(row.first_campaign_id === campaignId && row.first_source === 'google', 'first touch missing: ' + JSON.stringify(row));
      return 'lead #' + row.id + ' attributed';
    });
    await check('A second lead from another campaign is attributed to that campaign, not the first', async () => {
      const other = await api('POST', '/api/admin/marketing/campaigns', { name: 'Second channel', channel: 'meta_ads' }, T);
      const r = await post(form({ name: 'Campaign Lead Two', email: 'second.lead@example.test', message: 'Second visit', attr_json: JSON.stringify({ utm_source: 'meta', utm_campaign: 'Second channel', campaign_id: other.data.campaign.id, landing_path: '/faq.html' }) }));
      assert(r.status === 201, 'second intake got ' + r.status);
      const list = await api('GET', '/api/admin/marketing/leads?limit=200', null, T);
      const row = list.data.leads.find(l => l.contact_name === 'Campaign Lead Two');
      assert(row && row.first_campaign_id === other.data.campaign.id && row.first_source === 'meta', 'second lead attribution wrong');
      const detail = await api('GET', '/api/admin/marketing/leads/' + row.id + '/attribution', null, T);
      assert(detail.status === 200 && detail.data.touchpoints.length === 1 && detail.data.attribution.first_campaign_id === other.data.campaign.id, 'attribution detail wrong');
      return 'lead #' + row.id + ' to ' + 'Second channel';
    });
    await check('Declined consent: intake succeeds and nothing is attributed', async () => {
      const r = await post(form({ name: 'No Track', email: 'no.track@example.test', message: 'Please do not track me', attr_json: JSON.stringify({ utm_source: 'google', utm_campaign: 'Spring commercial', consent: 'declined' }) }));
      assert(r.status === 201, 'intake got ' + r.status);
      const list = await api('GET', '/api/admin/marketing/leads?limit=200', null, T);
      assert(!list.data.leads.some(l => l.contact_name === 'No Track'), 'declined visitor was attributed');
      return 'lead saved, not attributed';
    });
    await check('Intake with a malformed attribution value still saves the lead', async () => {
      const r = await post(form({ name: 'Bad Attr', email: 'bad.attr@example.test', message: 'Bad attribution data', attr_json: '{oops' }));
      assert(r.status === 201, 'intake got ' + r.status);
      return 'lead saved';
    });

    await check('Spend import: inserts once, re-import is ignored', async () => {
      const rows = [{ campaign_id: campaignId, spend_date: '2026-11-10', amount: 42.5, provider_record_id: 'g-1001' }, { campaign_id: campaignId, spend_date: '2026-11-11', amount: 18, provider_record_id: 'g-1002' }];
      const first = await api('POST', '/api/admin/marketing/spend/import', { provider: 'google_ads', rows }, T);
      assert(first.status === 200 && first.data.inserted === 2, 'first import ' + JSON.stringify(first.data));
      const again = await api('POST', '/api/admin/marketing/spend/import', { provider: 'google_ads', rows }, T);
      assert(again.data.inserted === 0 && again.data.duplicates_ignored === 2, 'second import counted twice');
      return 'inserted 2, re-import 0';
    });
    await check('Spend import: an unknown campaign refuses the whole batch', async () => {
      const r = await api('POST', '/api/admin/marketing/spend/import', { provider: 'google_ads', rows: [{ campaign_id: campaignId, spend_date: '2026-11-12', amount: 5, provider_record_id: 'g-2001' }, { campaign_id: 99999, spend_date: '2026-11-12', amount: 5, provider_record_id: 'g-2002' }] }, T);
      assert(r.status === 400 && /Nothing was imported/.test(r.data.error), 'got ' + r.status);
      const s = await api('GET', '/api/admin/marketing/summary', null, T);
      assert(s.data.spend === 60.5, 'partial import leaked: spend ' + s.data.spend);
      return 'refused, spend still 60.50';
    });
    await check('Spend import: a row without a provider record ID is refused', async () => {
      const r = await api('POST', '/api/admin/marketing/spend/import', { provider: 'google_ads', rows: [{ campaign_id: campaignId, spend_date: '2026-11-12', amount: 5 }] }, T);
      assert(r.status === 400, 'got ' + r.status);
      return '400';
    });
    await check('Spend import: a missing or blank amount is refused, never recorded as zero', async () => {
      const before = (await api('GET', '/api/admin/marketing/summary', null, T)).data.spend;
      for (const amount of [null, '', undefined]) {
        const r = await api('POST', '/api/admin/marketing/spend/import', { provider: 'google_ads', rows: [{ campaign_id: campaignId, spend_date: '2026-11-13', amount, provider_record_id: 'BLANK-' + String(amount) }] }, T);
        assert(r.status === 400, 'amount ' + String(amount) + ' got ' + r.status);
      }
      const after = (await api('GET', '/api/admin/marketing/summary', null, T)).data.spend;
      assert(after === before, 'spend changed after refused rows');
      return 'refused';
    });
    await check('Budget: a missing budget is refused, not saved as zero', async () => {
      const r = await api('POST', `/api/admin/marketing/campaigns/${campaignId}/budget`, {}, T);
      assert(r.status === 400, 'got ' + r.status);
      return '400';
    });
    await check('Summary reports spend and qualified leads with their definitions, and no revenue figure', async () => {
      const r = await api('GET', '/api/admin/marketing/summary', null, T);
      assert(r.status === 200 && r.data.financials === 'not_reconciled', 'financials flag');
      assert(Number.isInteger(r.data.crm_leads) && r.data.crm_leads >= r.data.attributed_leads, 'CRM lead count must include attributed leads');
      assert(r.data.unattributed_leads === r.data.crm_leads - r.data.attributed_leads, 'unattributed = CRM - attributed');
      assert(!('revenue' in r.data) && !('profit' in r.data) && !('roi' in r.data), 'revenue-like field present');
      assert(r.data.definitions.qualified_leads.length > 10, 'definition missing');
      return 'spend ' + r.data.spend;
    });
    await check('Content: draft saved; only the owner can approve; nothing is published', async () => {
      const r = await api('POST', '/api/admin/marketing/content', { title: 'Spring offer', body: 'Commercial cleaning for offices.', channel: 'facebook', campaign_id: campaignId }, T);
      assert(r.status === 201 && r.data.content.status === 'draft', 'create');
      const id = r.data.content.id;
      assert((await api('POST', '/api/admin/marketing/content/' + id + '/approve', {}, M)).status === 403, 'manager approve not refused');
      const ok = await api('POST', '/api/admin/marketing/content/' + id + '/approve', {}, T);
      assert(ok.status === 200 && ok.data.content.status === 'approved', 'owner approve');
      return 'approved by owner, not published';
    });
    await check('Owner-only exceptions list is reachable by the owner', async () => {
      const r = await api('GET', '/api/admin/marketing/events/exceptions', null, T);
      assert(r.status === 200 && Array.isArray(r.data.events), 'got ' + r.status);
      return r.data.events.length + ' unresolved';
    });
    await check('Connections list is metadata only and empty in this release', async () => {
      const r = await api('GET', '/api/admin/marketing/connections', null, T);
      assert(r.status === 200 && Array.isArray(r.data.connections) && r.data.connections.length === 0, 'connections');
      return '0 connections';
    });
    await check('Marketing page is served only to signed-in admins', async () => {
      const anon = await fetch(B + '/admin/marketing');
      assert(anon.status === 401, 'anonymous got ' + anon.status);
      return '401 when signed out';
    });
    await check('Marketing UI file is not a public static file', async () => {
      const r = await fetch(B + '/admin-private/marketing.html');
      assert(r.status === 404, 'private file served: ' + r.status);
      return '404';
    });
  } catch (e) {
    failed++; console.log('FAIL  setup -> ' + e.message); console.log(log.slice(-800));
  } finally {
    child.kill();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { }
  }
  failed += results.filter(r => r.status === 'FAIL').length;
  console.log(`\n${results.filter(r => r.status === 'PASS').length}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
