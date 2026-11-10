/* Postmark sending: runs the real server against a local fake of Postmark's API and checks
 * that notifications go through Postmark with the right token, sender, stream and recipients,
 * and that a Postmark error is reported, not swallowed as success. */
const http = require('http'), { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) { try { const ev = await fn(); results.push({ name, status: 'PASS', evidence: ev }); console.log('PASS  ' + name); } catch (e) { results.push({ name, status: 'FAIL', evidence: e.message }); console.log('FAIL  ' + name + ' -> ' + e.message); } }
(async () => {
  const got = []; let failNext = false;
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      got.push({ url: req.url, token: req.headers['x-postmark-server-token'], body: JSON.parse(b || '{}') });
      if (failNext) { failNext = false; res.writeHead(422, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ErrorCode: 406, Message: 'You tried to send to recipient(s) that have been marked as inactive.' })); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ErrorCode: 0, Message: 'OK', MessageID: crypto.randomUUID() }));
    });
  }).listen(0);
  const FAKE = 'http://127.0.0.1:' + fake.address().port;
  const PORT = 4300 + Math.floor(Math.random() * 50), B = 'http://127.0.0.1:' + PORT;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pm-'));
  const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 8),
    DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'up'), POSTMARK_TOKEN: 'test-server-token', POSTMARK_API_URL: FAKE, FROM_EMAIL: 'Bright Clean <info@brightclean.net>', NOTIFY_EMAIL: 'info@brightclean.net', PUBLIC_BASE_URL: 'https://brightclean.net' };
  delete env.SMTP_HOST; delete env.SMTP_USER; delete env.SMTP_PASS;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
  const api = async (m, u, j, t) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  const signIn = require('./mfa-helper')((p, b, t) => api('POST', p, b, t));
  const T = await signIn(OWNER, PW);

  await check('Settings and Command Center report email as set up via Postmark', async () => {
    const s = (await api('GET', '/api/admin/settings', null, T)).data;
    const c = (await api('GET', '/api/admin/command-center', null, T)).data.modules.email;
    assert(s.email_configured === true && c.connected && /Postmark/.test(c.status), JSON.stringify([s.email_configured, c]));
    return `email_configured true; Command Center: "${c.status}"`;
  });
  await check('Contact form sends owner notice and customer confirmation through Postmark', async () => {
    const n0 = got.length;
    await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Pat Test', email: 'pat@customer.test', message: 'Need a quote' }) });
    for (let i = 0; i < 30 && got.length < n0 + 2; i++) await sleep(100);
    const msgs = got.slice(n0);
    const owner = msgs.find(m => m.body.To === 'info@brightclean.net'), cust = msgs.find(m => m.body.To === 'pat@customer.test');
    assert(msgs.length === 2 && owner && cust && msgs.every(m => m.url === '/email' && m.token === 'test-server-token' && m.body.From === 'Bright Clean <info@brightclean.net>' && m.body.MessageStream === 'outbound' && m.body.TextBody), JSON.stringify(msgs));
    return `2 API calls to /email with the server token, From "Bright Clean <info@brightclean.net>", stream outbound: "${owner.body.Subject}" and "${cust.body.Subject}"`;
  });
  await check('Proposal email goes through Postmark; a Postmark rejection is reported as an error', async () => {
    await api('PUT', '/api/admin/approval-rules', { min_margin_pct: 0, max_total: 0, flag_pre_pricing: false }, T);
    const e = (await api('POST', '/api/admin/estimates', { customer_name: 'Lee', email: 'lee@customer.test', scope: 'Final clean', area_sqft: 10000, production_rate: 400, labor_rate: 30, margin_pct: 30 }, T)).data.estimate;
    const ok = await api('POST', `/api/admin/estimates/${e.id}/send`, null, T);
    const sent = got[got.length - 1];
    failNext = true;
    const bad = await api('POST', `/api/admin/estimates/${e.id}/send`, null, T);
    assert(ok.status === 200 && sent.body.To === 'lee@customer.test' && /proposal\//.test(sent.body.TextBody) && bad.status === 422 && bad.data.recipient_rejected === true && /Postmark 422/.test(bad.data.error || JSON.stringify(bad.data)), JSON.stringify([ok, bad]));
    return `send 200 (link in body); a refused recipient -> ${bad.status} recipient_rejected "${(bad.data.error || '').slice(0, 90)}"`;
  });
  child.kill(); fake.close();
  fs.writeFileSync(path.join(__dirname, 'postmark-results.json'), JSON.stringify({ run_at: new Date().toISOString(), results }, null, 2));
  console.log(`${results.filter(r => r.status === 'PASS').length}/${results.length} passed`);
  process.exit(results.every(r => r.status === 'PASS') ? 0 : 1);
})();
