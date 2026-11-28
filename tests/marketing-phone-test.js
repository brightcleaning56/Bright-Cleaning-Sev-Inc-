// Phone intake: a call answered by the AI receptionist creates a lead whose first touch is the phone.
// Runs the real server; Twilio webhooks are sent with valid signatures; the AI model is a local stand-in
// (ANTHROPIC_API_URL) that asks for save_caller_details once and then finishes the turn. No real call or AI is used.
// Run: node tests/marketing-phone-test.js
const { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), http = require('http');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const results = [];
async function check(name, fn) { try { const ev = await fn(); results.push(1); console.log('PASS  ' + name + (ev ? ' — ' + ev : '')); } catch (e) { results.push(0); console.log('FAIL  ' + name + ' -> ' + e.message); } }

const TOKEN = 'tw-phone-test-token-0123456789';
const PUBLIC = 'https://brightclean.net';
const CALLER = '+15155550144';
const CALL_SID = 'CA' + crypto.randomBytes(16).toString('hex');

// Stand-in for the AI model: first request asks to save the caller; after the tool result it finishes the turn.
function mockAnthropic() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const j = JSON.parse(body || '{}'); seen.push(req.url);
      const last = (j.messages || [])[(j.messages || []).length - 1] || {};
      const hasResult = Array.isArray(last.content) && last.content.some(c => c && c.type === 'tool_result');
      const out = hasResult
        ? { content: [{ type: 'text', text: 'Thanks, Pat. A team member will follow up with you shortly.' }], stop_reason: 'end_turn' }
        : { content: [{ type: 'text', text: 'Let me note that for you.' }, { type: 'tool_use', id: 'tu_save_1', name: 'save_caller_details', input: { name: 'Pat Caller', service_needed: 'Office cleaning, about 3000 sq ft', callback_number: '515-555-0144', email: 'pat.caller@example.test', service_category: 'commercial' } }], stop_reason: 'tool_use' };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, base: 'http://127.0.0.1:' + srv.address().port, seen })));
}

// Twilio's signature: HMAC-SHA1 over the full URL plus the sorted form parameters.
function twilioSig(url, params) {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha1', TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
}

(async () => {
  const ai = await mockAnthropic();
  const PORT = 5700 + Math.floor(Math.random() * 50), B = 'http://127.0.0.1:' + PORT;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-phone-'));
  const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 8),
    DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'up'), PUBLIC_BASE_URL: PUBLIC, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FORWARD_TO: '+15155550199', TWILIO_NUMBER: '+15153033024', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
    ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_API_URL: ai.base, FROM_EMAIL: 'info@brightclean.test', NOTIFY_EMAIL: 'info@brightclean.test' };
  delete env.SMTP_HOST; delete env.POSTMARK_TOKEN;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
  const api = async (m, u, j, t) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  const hook = async (route, params) => {
    const body = new URLSearchParams(params).toString();
    const r = await fetch(B + route, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSig(PUBLIC + route, params) }, body });
    return { status: r.status, text: await r.text() };
  };
  const dbRead = () => new Database(path.join(work, 'data', 'brightclean.db'), { readonly: true });
  try {
    const signIn = require('./mfa-helper')((p, b, t) => api('POST', p, b, t));
    const T = await signIn(OWNER, PW);
    await check('AI receptionist set to answer always (owner)', async () => {
      const r = await api('PUT', '/api/admin/phone/settings', { ai_mode: 'always' }, T);
      assert(r.status === 200, 'settings refused: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 120));
    });
    await check('Unsigned Twilio webhook is refused', async () => {
      const r = await fetch(B + '/api/webhooks/twilio/voice', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'From=%2B15155550144&CallSid=' + CALL_SID });
      assert(r.status === 403, 'got ' + r.status);
    });
    await check('Incoming call is answered by the AI receptionist', async () => {
      const r = await hook('/api/webhooks/twilio/voice', { From: CALLER, To: '+15153033024', CallSid: CALL_SID, AccountSid: 'AC' + 'a'.repeat(32), Direction: 'inbound' });
      assert(r.status === 200 && /ai-turn/.test(r.text), 'no AI greeting: ' + r.status + ' ' + r.text.slice(0, 160));
    });
    await check('Caller speaks: the AI saves their details and a lead is created from the phone call', async () => {
      const r = await hook('/api/webhooks/twilio/ai-turn', { CallSid: CALL_SID, From: CALLER, SpeechResult: 'Hi, this is Pat Caller. I need office cleaning for about 3000 square feet. My number is 515-555-0144.' });
      assert(r.status === 200, 'ai turn failed: ' + r.status + ' ' + r.text.slice(0, 160));
      assert(ai.seen.length >= 2, 'the AI model was not asked twice: ' + ai.seen.length);
      const db = dbRead();
      const lead = db.prepare("SELECT id, origin, contact_name, phone, service FROM leads WHERE origin='inbound_call' ORDER BY id DESC LIMIT 1").get();
      const attr = lead && db.prepare('SELECT first_source, first_medium FROM marketing_attribution WHERE lead_id=?').get(lead.id);
      db.close();
      assert(lead, 'no phone lead was created');
      assert(lead.contact_name === 'Pat Caller' && /5155550144$/.test(String(lead.phone).replace(/\D/g, '')), JSON.stringify(lead));
      assert(attr && attr.first_source === 'phone' && attr.first_medium === 'call', 'phone source not recorded: ' + JSON.stringify(attr));
      return 'lead #' + lead.id + ', source phone';
    });
    await check('The call session is linked to the lead', async () => {
      const db = dbRead();
      const s = db.prepare('SELECT lead_id FROM ai_call_sessions WHERE call_sid=?').get(CALL_SID);
      db.close();
      assert(s && s.lead_id, 'session not linked');
    });
    await check('A second call from the same number updates the lead instead of duplicating it', async () => {
      const sid2 = 'CA' + crypto.randomBytes(16).toString('hex');
      await hook('/api/webhooks/twilio/voice', { From: CALLER, To: '+15153033024', CallSid: sid2, Direction: 'inbound' });
      await hook('/api/webhooks/twilio/ai-turn', { CallSid: sid2, From: CALLER, SpeechResult: 'Calling again about the same office.' });
      const db = dbRead();
      const n = db.prepare("SELECT COUNT(*) n FROM leads WHERE origin='inbound_call'").get().n;
      db.close();
      assert(n === 1, 'duplicate phone leads: ' + n);
    });
  } catch (e) {
    console.log('FAIL  setup -> ' + e.message); results.push(0);
  } finally {
    child.kill(); ai.srv.close();
    const failed = results.filter(x => x === 0).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    if (failed) { console.log('---- server log (tail) ----\n' + log.slice(-1500)); process.exit(1); }
    process.exit(0);
  }
})();
