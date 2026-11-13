// Module workflows the main suite did not cover: subscriptions and billing runs, crew, visits, time and labor approval, and role limits.
// Starts its own server on a temporary database (port 3997) and always stops it. No mail is sent.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
const PORT = 3997, BASE = `http://127.0.0.1:${PORT}`;
const OWNER = 'owner@example.test', OWNER_PW = 'Owner-test-password-123';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-modules-'));
const results = []; const assert = (c, m) => { if (!c) throw new Error(m); };
let child = null;
function stop() { if (child && !child.killed) { try { child.kill(); } catch {} } }
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(1); });

async function check(name, fn) {
  try { const ev = await fn(); results.push({ name, status: 'PASS', evidence: ev }); console.log('PASS  ' + name + (ev ? '  (' + ev + ')' : '')); }
  catch (e) { results.push({ name, status: 'FAIL', evidence: e.message }); console.log('FAIL  ' + name + '  -> ' + e.message); }
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

(async () => {
  const env = {
    ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_DIR: path.join(dir, 'data'), UPLOAD_DIR: path.join(dir, 'uploads'),
    JWT_SECRET: 'workflow-modules-test-secret-0123456789abcdef', ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: bcrypt.hashSync(OWNER_PW, 4),
    PUBLIC_BASE_URL: BASE, DISABLE_SCHEDULER: '1'
  };
  delete env.SMTP_HOST; delete env.SMTP_USER; delete env.STRIPE_SECRET_KEY; delete env.ANTHROPIC_API_KEY;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: 'ignore' });
  let exited = false; child.on('exit', () => { exited = true; });
  await waitHealthy();

  const req = async (method, url, token, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const login = async (email, pw) => { const r = await req('POST', '/api/admin/login', null, { email, password: pw }); return r.body.token || null; };

  // Owners and managers are asked for a two-step code at sign-in. This test mints a session token that has already passed that step,
  // signed with the test secret (the same way the server does after a correct code). Password sign-in itself is covered by run-tests.js.
  const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  // Same token-version rule the server uses (admin_users.token_ver, or the owner setting when there is no row).
  const tvOf = email => {
    const d = new Database(path.join(env.DATA_DIR, 'brightclean.db'), { readonly: true });
    try {
      const r = d.prepare('SELECT token_ver FROM admin_users WHERE lower(email)=?').get(email.toLowerCase());
      if (r) return r.token_ver || 0;
      const s = d.prepare("SELECT value FROM settings WHERE key='owner_token_ver'").get();
      return s ? Number(s.value) || 0 : 0;
    } finally { d.close(); }
  };
  const mint = email => jwt.sign({ role: 'admin', email, tv: tvOf(email), mfa: true }, env.JWT_SECRET, { expiresIn: '1h' });
  const owner = mint(OWNER);
  const mk = await req('POST', '/api/admin/users', owner, { email: 'sales.wf@example.test', name: 'Sales Test', password: 'Sales-test-password-123', role: 'sales' });
  assert(mk.status === 201, 'create sales user ' + mk.status + ' ' + JSON.stringify(mk.body).slice(0, 120));
  const sales = mint('sales.wf@example.test');

  // The owner account has no two-step sign-in on this temporary server, so manager-level checks use the owner token.
  await check('Subscriptions: a valid plan is created; bad price and bad dates are refused', async () => {
    const ok = await req('POST', '/api/admin/subscriptions', owner, { customer_name: 'Riverside Apartments', company: 'Riverside LLC', email: 'pm@riverside.example.test', plan_type: 'Apartment', frequency: 'Monthly', monthly_amount: 450, start_date: '2026-10-01', visits_per_month: 4, service: 'Common areas' });
    assert(ok.status === 201 && ok.body.id, 'create ' + ok.status);
    const bad1 = await req('POST', '/api/admin/subscriptions', owner, { customer_name: 'X', monthly_amount: 0, start_date: '2026-10-01' });
    assert(bad1.status === 400, 'zero price refused ' + bad1.status);
    const bad2 = await req('POST', '/api/admin/subscriptions', owner, { customer_name: 'X', monthly_amount: 100, start_date: '2026-10-05', end_date: '2026-10-01' });
    assert(bad2.status === 400, 'end before start refused ' + bad2.status);
    const bad3 = await req('POST', '/api/admin/subscriptions', owner, { customer_name: 'X', monthly_amount: 100, start_date: '2026-10-01', visits_per_month: 40 });
    assert(bad3.status === 400, 'too many visits refused ' + bad3.status);
    return `id ${ok.body.id}; 3 bad inputs refused`;
  });

  await check('Subscriptions: sales cannot set up a subscription (managers and owners only)', async () => {
    const r = await req('POST', '/api/admin/subscriptions', sales, { customer_name: 'Blocked', monthly_amount: 100, start_date: '2026-10-01' });
    assert(r.status === 403, 'expected 403, got ' + r.status);
    return '403';
  });

  let runId = null;
  await check('Billing run: creates one draft invoice per active subscription and skips a repeat run', async () => {
    const first = await req('POST', '/api/admin/subscriptions/bill-run', owner, { period: '2026-11' });
    assert(first.status === 200, 'bill-run ' + first.status + ' ' + JSON.stringify(first.body).slice(0, 200));
    const created = first.body.created || (first.body.result && first.body.result.created) || [];
    assert(created.length === 1, 'created ' + created.length + ' ' + JSON.stringify(first.body).slice(0, 300));
    assert(created[0].amount === 450, 'amount ' + created[0].amount);
    runId = created[0].invoice_id;
    const second = await req('POST', '/api/admin/subscriptions/bill-run', owner, { period: '2026-11' });
    const skipped = second.body.skipped || (second.body.result && second.body.result.skipped) || [];
    const again = second.body.created || (second.body.result && second.body.result.created) || [];
    assert(again.length === 0 && skipped.length === 1, 'repeat run should skip: ' + JSON.stringify(second.body).slice(0, 300));
    return `invoice ${created[0].invoice_number} for $450; repeat run skipped`;
  });

  await check('Billing run: sales cannot run billing; a bad period is refused', async () => {
    const s = await req('POST', '/api/admin/subscriptions/bill-run', sales, { period: '2026-12' });
    assert(s.status === 403, 'sales ' + s.status);
    const b = await req('POST', '/api/admin/subscriptions/bill-run', owner, { period: '2026/13' });
    assert(b.status === 400, 'bad period ' + b.status);
    return '403 for sales; 400 for bad period';
  });

  let empId = null;
  await check('Crew: an employee is added; duplicate email and bad rate are refused', async () => {
    const ok = await req('POST', '/api/admin/employees', owner, { name: 'Test Crew Lead', email: 'crew.lead@example.test', role: 'Crew Lead', hourly_rate: 22, work_days: '1,2,3,4,5', day_start: '07:00', day_end: '15:30' });
    assert(ok.status === 201 && ok.body.employee && ok.body.employee.id, 'create ' + ok.status + ' ' + JSON.stringify(ok.body).slice(0, 200));
    empId = ok.body.employee.id;
    const dup = await req('POST', '/api/admin/employees', owner, { name: 'Another', email: 'crew.lead@example.test' });
    assert(dup.status === 409, 'duplicate ' + dup.status);
    const rate = await req('POST', '/api/admin/employees', owner, { name: 'Bad Rate', hourly_rate: 5000 });
    assert(rate.status === 400, 'bad rate ' + rate.status);
    return `employee ${empId}`;
  });

  let visitId = null;
  await check('Visits: a site visit is scheduled; an end time before the start is refused', async () => {
    const ok = await req('POST', '/api/admin/visits', owner, { title: 'Walkthrough: Riverside', date: '2026-11-20', start_time: '09:00', end_time: '11:00', type: 'Site visit' });
    assert(ok.status === 201 && ok.body.visit && ok.body.visit.id, 'create ' + ok.status + ' ' + JSON.stringify(ok.body).slice(0, 200));
    visitId = ok.body.visit.id;
    const bad = await req('POST', '/api/admin/visits', owner, { title: 'Backwards', date: '2026-11-20', start_time: '11:00', end_time: '09:00' });
    assert(bad.status === 400, 'backwards times ' + bad.status);
    return `visit ${visitId}`;
  });

  let timeId = null;
  await check('Time: a clock entry is recorded and approving it prices the labor', async () => {
    const t = await req('POST', '/api/admin/time', owner, { employee_id: empId, clock_in: '2026-11-18T07:00:00-06:00', clock_out: '2026-11-18T11:00:00-06:00', visit_id: visitId, note: 'Test shift' });
    assert(t.status === 201 && t.body.id, 'entry ' + t.status + ' ' + JSON.stringify(t.body).slice(0, 200));
    timeId = t.body.id;
    const a = await req('POST', `/api/admin/time/${timeId}/approve`, owner, {});
    assert(a.status === 200 && a.body.ok === true, 'approve ' + a.status + ' ' + JSON.stringify(a.body).slice(0, 200));
    assert(a.body.cost === 88, '4 h x $22 should be $88, got ' + a.body.cost);
    assert(a.body.posted === false, 'no project, so nothing posted to a project');
    return `4 h x $22 = $${a.body.cost}; not posted (no project on this entry)`;
  });

  await check('Time: approving twice is refused; sales cannot approve time', async () => {
    const again = await req('POST', `/api/admin/time/${timeId}/approve`, owner, {});
    assert(again.status === 409, 'second approval ' + again.status);
    const t2 = await req('POST', '/api/admin/time', owner, { employee_id: empId, clock_in: '2026-11-19T07:00:00-06:00', clock_out: '2026-11-19T08:00:00-06:00' });
    const s = await req('POST', `/api/admin/time/${t2.body.id}/approve`, sales, {});
    assert(s.status === 403, 'sales approval ' + s.status);
    return '409 twice; 403 for sales';
  });

  await check('Time: an entry longer than 16 hours or ending before it starts is refused', async () => {
    const long = await req('POST', '/api/admin/time', owner, { employee_id: empId, clock_in: '2026-11-17T00:00:00Z', clock_out: '2026-11-17T20:00:00Z' });
    assert(long.status === 400, 'long ' + long.status);
    const back = await req('POST', '/api/admin/time', owner, { employee_id: empId, clock_in: '2026-11-17T10:00:00Z', clock_out: '2026-11-17T09:00:00Z' });
    assert(back.status === 400, 'backwards ' + back.status);
    return '400 for both';
  });

  await check('Lists: subscriptions, crew, visits and time entries show the records just created', async () => {
    const subs = await req('GET', '/api/admin/subscriptions', owner);
    const emps = await req('GET', '/api/admin/employees', owner);
    const vis = await req('GET', '/api/admin/visits', owner);
    const tm = await req('GET', '/api/admin/time?from=2026-11-01&to=2026-11-30', owner);
    const count = (r, key) => ((r.body && r.body[key]) || []).length;
    assert(count(subs, 'subscriptions') >= 1, 'subscriptions list ' + JSON.stringify(subs.body).slice(0, 120));
    assert(count(emps, 'employees') >= 1, 'employees list');
    assert(count(vis, 'visits') >= 1, 'visits list');
    assert(count(tm, 'entries') >= 1, 'time list ' + JSON.stringify(tm.body).slice(0, 120));
    return 'lists return the new records';
  });

  stop();
  await new Promise(r => setTimeout(r, 500));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL setup -> ' + e.message); stop(); process.exit(1); });
