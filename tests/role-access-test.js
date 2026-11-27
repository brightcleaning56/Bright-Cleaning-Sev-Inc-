// Checks that office staff are refused the bill, receipt-AI and monthly-bill routes, and the owner is not.
// Runs the real server on a temporary database, creates a staff user through the owner's own route, and signs in as them.
// Run: node tests/role-access-test.js
const { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) { try { const ev = await fn(); results.push({ name, status: 'PASS', evidence: ev }); console.log('PASS  ' + name); } catch (e) { results.push({ name, status: 'FAIL', evidence: e.message }); console.log('FAIL  ' + name + ' -> ' + e.message); } }

(async () => {
  const PORT = 4500 + Math.floor(Math.random() * 50), B = 'http://127.0.0.1:' + PORT;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-role-'));
  const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
  const STAFF = 'office.staff@brightclean.test', STAFF_PW = 'staff-temp-password-1234';
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 8),
    DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'up'), PUBLIC_BASE_URL: 'https://brightclean.net', TWILIO_FORWARD_TO: '+15155550199', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_NUMBER: '+15153033024', TWILIO_AUTH_TOKEN: 'tw-role-token', FROM_EMAIL: 'info@brightclean.net', NOTIFY_EMAIL: 'info@brightclean.net' };
  delete env.SMTP_HOST; delete env.POSTMARK_TOKEN;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
  const api = async (m, u, j, t) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  let failed = 0;
  try {
    const signIn = require('./mfa-helper')((p, b, t) => api('POST', p, b, t));
    const T = await signIn(OWNER, PW);
    const made = await api('POST', '/api/admin/users', { email: STAFF, name: 'Office Staff', password: STAFF_PW, role: 'staff' }, T);
    assert(made.status === 200 || made.status === 201, 'create staff user ' + made.status + ' ' + JSON.stringify(made.data));
    const S = await signIn(STAFF, STAFF_PW);

    const refused = async (label, method, url, body) => check(label, async () => {
      const r = await api(method, url, body, S);
      assert(r.status === 403, `expected 403 for staff, got ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
      assert(/owners? (and|or) managers?|only an owner|limited to owners/i.test(String(r.data.error || '')), 'refused by another rule: ' + JSON.stringify(r.data).slice(0, 160));
      return '403 for office staff, with the owner-and-manager message';
    });
    await refused('Staff: reading the bill list is refused', 'GET', '/api/admin/expenses');
    await refused('Staff: creating a bill is refused', 'POST', '/api/admin/expenses', { vendor: 'X', amount: 5, bill_date: '2026-11-26' });
    await refused('Staff: uploading a receipt to a bill with AI is refused', 'POST', '/api/admin/ai/expenses/intake', {});
    await refused('Staff: AI read of a bill receipt is refused', 'POST', '/api/admin/ai/expenses/1/read-receipt', {});
    await refused('Staff: AI category suggestion is refused', 'POST', '/api/admin/ai/expenses/1/suggest-category', {});
    await refused('Staff: reading the monthly bills is refused', 'GET', '/api/admin/recurring-bills');
    await refused('Staff: creating a monthly bill is refused', 'POST', '/api/admin/recurring-bills', { vendor: 'X', amount: 5, day_of_month: 5 });
    await refused('Staff: stopping a monthly bill is refused', 'POST', '/api/admin/recurring-bills/1/stop', {});

    await check('Owner: the monthly bill list is allowed', async () => {
      const r = await api('GET', '/api/admin/recurring-bills', null, T);
      assert(r.status === 200, 'owner got ' + r.status);
      return '200 for the owner';
    });
    await check('Owner: the bill list is allowed', async () => {
      const r = await api('GET', '/api/admin/expenses', null, T);
      assert(r.status === 200, 'owner got ' + r.status);
      return '200 for the owner';
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
