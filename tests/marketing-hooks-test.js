// Route-level checks for the marketing hooks that run inside existing routes:
// lead qualified and lost (database trigger, through the lead PATCH route), and attribution of webhook leads.
// Run: node tests/marketing-hooks-test.js
const { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function check(name, fn) { try { const ev = await fn(); results.push(1); console.log('PASS  ' + name + (ev ? ' — ' + ev : '')); } catch (e) { results.push(0); console.log('FAIL  ' + name + ' -> ' + e.message); } }

(async () => {
  const PORT = 5600 + Math.floor(Math.random() * 50), B = 'http://127.0.0.1:' + PORT;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hooks-'));
  const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 8),
    DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'up'), PUBLIC_BASE_URL: 'https://brightclean.net', TWILIO_FORWARD_TO: '+15155550199', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_NUMBER: '+15153033024', TWILIO_AUTH_TOKEN: 'tw-hooks-token', FROM_EMAIL: 'info@brightclean.net', NOTIFY_EMAIL: 'info@brightclean.net' };
  delete env.SMTP_HOST; delete env.POSTMARK_TOKEN;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
  const api = async (m, u, j, t, extra = {}) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...extra }, body: j ? JSON.stringify(j) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  const dbRead = () => new Database(path.join(work, 'data', 'brightclean.db'), { readonly: true });
  try {
    const signIn = require('./mfa-helper')((p, b, t) => api('POST', p, b, t));
    const T = await signIn(OWNER, PW);

    let leadId = null, keyValue = null;
    await check('Partner webhook: a new lead is created and its source is recorded', async () => {
      const k = await api('POST', '/api/admin/api-keys', { name: 'Hooks test partner' }, T);
      assert(k.status === 201 && k.data.key, 'key not created: ' + k.status);
      keyValue = k.data.key;
      const r = await api('POST', '/api/integrations/leads', { name: 'Webhook Pat', email: 'webhook.pat@example.test', service: 'Office cleaning', source: 'partner-site', utm_campaign: 'Partner spring', details: 'Please call me.' }, null, { 'x-api-key': keyValue });
      assert(r.status === 201 && r.data.id, 'webhook intake failed: ' + r.status + ' ' + JSON.stringify(r.data));
      leadId = r.data.id; return 'lead #' + leadId;
    });
    await check('Partner webhook: the lead carries the sending source and campaign', async () => {
      const db = dbRead();
      const a = db.prepare('SELECT first_source, first_campaign, first_medium FROM marketing_attribution WHERE lead_id=?').get(leadId);
      db.close();
      assert(a, 'no attribution recorded for the webhook lead');
      assert(a.first_source === 'partner-site' && a.first_campaign === 'Partner spring' && a.first_medium === 'webhook', JSON.stringify(a));
      return a.first_source + ' / ' + a.first_campaign;
    });
    await check('Webhook without a key is refused (401)', async () => {
      const r = await api('POST', '/api/integrations/leads', { name: 'No Key', email: 'nokey@example.test', service: 'x' }, null);
      assert(r.status === 401, 'got ' + r.status);
    });
    await check('Lead moved to Site Walkthrough is counted as qualified, once', async () => {
      const p1 = await api('PATCH', '/api/admin/leads/' + leadId, { status: 'Site Walkthrough' }, T);
      assert(p1.status === 200, 'status change refused: ' + p1.status + ' ' + JSON.stringify(p1.data));
      const p2 = await api('PATCH', '/api/admin/leads/' + leadId, { status: 'Proposal in Progress' }, T);
      assert(p2.status === 200, 'second status change refused: ' + p2.status);
      const db = dbRead();
      const n = db.prepare("SELECT COUNT(*) n FROM marketing_events WHERE lead_id=? AND event_type='lead_qualified'").get(leadId).n;
      db.close();
      assert(n === 1, 'qualified recorded ' + n + ' times');
    });
    await check('Lead marked Lost is recorded once, even when set again', async () => {
      await api('PATCH', '/api/admin/leads/' + leadId, { status: 'Lost' }, T);
      await api('PATCH', '/api/admin/leads/' + leadId, { status: 'Lost' }, T);
      const db = dbRead();
      const n = db.prepare("SELECT COUNT(*) n FROM marketing_events WHERE lead_id=? AND event_type='lead_lost'").get(leadId).n;
      db.close();
      assert(n === 1, 'lost recorded ' + n + ' times');
    });
    // Proposal approved (offline, owner records the customer's approval) is recorded once for the lead.
    let approvalLead = null, estimateId = null;
    await check('Approval: a second lead and a proposal for it can be created', async () => {
      const r = await api('POST', '/api/integrations/leads', { name: 'Approval Pat', email: 'approval.pat@example.test', service: 'Office cleaning', source: 'partner-site' }, null, { 'x-api-key': keyValue });
      assert(r.status === 201 && r.data.id, 'lead not created: ' + r.status);
      approvalLead = r.data.id;
      const e = await api('POST', '/api/admin/estimates', { lead_id: approvalLead, customer_name: 'Approval Pat', email: 'approval.pat@example.test', project_name: 'Office approval test', proposal_total: 500, scope: 'Office cleaning, weekly' }, T);
      assert(e.status < 300 && e.data.estimate && e.data.estimate.id, 'proposal not created: ' + e.status + ' ' + JSON.stringify(e.data).slice(0, 160));
      estimateId = e.data.estimate.id; return 'proposal #' + estimateId;
    });
    await check('Approval: recording the customer approval records one proposal-approved event for the lead', async () => {
      const r = await api('POST', `/api/admin/estimates/${estimateId}/record-approval`, { note: 'Signed paper copy received from the customer' }, T);
      assert(r.status === 200, 'approval refused: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 160));
      const again = await api('POST', `/api/admin/estimates/${estimateId}/record-approval`, { note: 'Signed paper copy received from the customer' }, T);
      assert(again.status === 200, 'repeat approval refused: ' + again.status);
      const db = dbRead();
      const n = db.prepare("SELECT COUNT(*) n FROM marketing_events WHERE event_type='proposal_approved' AND source_record_id=? AND lead_id=?").get('estimate:' + estimateId, approvalLead).n;
      db.close();
      assert(n === 1, 'proposal approved recorded ' + n + ' times');
    });
    await check('Lost lead still shows its attribution and source in the lead list', async () => {
      const r = await api('GET', '/api/admin/marketing/leads?limit=200', null, T);
      const row = (r.data.leads || []).find(l => l.id === leadId);
      assert(row && row.first_source === 'partner-site', 'lead missing from attribution list');
    });
  } catch (e) {
    console.log('FAIL  setup -> ' + e.message); results.push(0);
  } finally {
    child.kill();
    const failed = results.filter(x => x === 0).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    if (failed) { console.log('---- server log (tail) ----\n' + log.slice(-1500)); process.exit(1); }
    process.exit(0);
  }
})();
