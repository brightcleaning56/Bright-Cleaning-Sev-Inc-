// Module workflows: quality inspections, takeoffs, reports, and the contract and project lists.
// Starts its own server on a temporary database (port 3998) and always stops it. No mail is sent.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const PORT = 3998, BASE = `http://127.0.0.1:${PORT}`;
const OWNER = 'owner@example.test', OWNER_PW = 'Owner-test-password-123';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-modules2-'));
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
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 500)); }
  throw new Error('server did not start');
}

(async () => {
  const env = {
    ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_DIR: path.join(dir, 'data'), UPLOAD_DIR: path.join(dir, 'uploads'),
    JWT_SECRET: 'workflow-modules2-test-secret-0123456789abcdef', ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: bcrypt.hashSync(OWNER_PW, 4),
    PUBLIC_BASE_URL: BASE, DISABLE_SCHEDULER: '1'
  };
  delete env.SMTP_HOST; delete env.SMTP_USER; delete env.STRIPE_SECRET_KEY; delete env.ANTHROPIC_API_KEY;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: 'ignore' });
  await waitHealthy();

  const req = async (method, url, token, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  // Mint a session that has passed two-step sign-in (same claims the server issues). Token version is read the way the server reads it.
  const tvOf = email => {
    const d = new Database(path.join(env.DATA_DIR, 'brightclean.db'), { readonly: true });
    try { const r = d.prepare('SELECT token_ver FROM admin_users WHERE lower(email)=?').get(email.toLowerCase()); if (r) return r.token_ver || 0; const s = d.prepare("SELECT value FROM settings WHERE key='owner_token_ver'").get(); return s ? Number(s.value) || 0 : 0; }
    finally { d.close(); }
  };
  const mint = email => jwt.sign({ role: 'admin', email, tv: tvOf(email), mfa: true }, env.JWT_SECRET, { expiresIn: '1h' });
  const owner = mint(OWNER);
  const mk = await req('POST', '/api/admin/users', owner, { email: 'sales.wf2@example.test', name: 'Sales Test', password: 'Sales-test-password-123', role: 'sales' });
  assert(mk.status === 201, 'create sales user ' + mk.status);
  const sales = mint('sales.wf2@example.test');

  // ---- Quality inspections
  let tplId = null, insp = null, insp2 = null;
  await check('Inspections: a built-in template is available to start from', async () => {
    const t = await req('GET', '/api/admin/qc/templates', owner);
    const list = (t.body && t.body.templates) || [];
    assert(list.length >= 1, 'no templates');
    const active = list.find(x => x.active) || list[0];
    tplId = active.id;
    assert(Array.isArray(active.items) && active.items.length > 0, 'template has items');
    return `${list.length} templates; using "${active.name}" (${active.items.length} items)`;
  });

  await check('Inspections: started from a template, the items are blank and signing is blocked until each is rated', async () => {
    const c = await req('POST', '/api/admin/qc/inspections', owner, { area: 'Riverside lobby', date: '2026-11-10', template_id: tplId, itype: 'Internal' });
    assert(c.status === 201, 'create ' + c.status + ' ' + JSON.stringify(c.body).slice(0, 200));
    insp = c.body.inspection || c.body;
    assert(insp.id, 'inspection id');
    const sign = await req('POST', `/api/admin/qc/inspections/${insp.id}/sign`, owner, { name: 'Test Inspector' });
    assert(sign.status === 400 && /no result/.test(sign.body.error || ''), 'sign with blank items ' + sign.status + ' ' + JSON.stringify(sign.body).slice(0, 160));
    return `inspection ${insp.id}; signing refused until items are rated`;
  });

  await check('Inspections: a failed item needs a comment; rated items score and the walkthrough can be signed once', async () => {
    const cur = await req('GET', `/api/admin/qc/inspections/${insp.id}`, owner);
    const items = (cur.body.inspection || cur.body).items;
    assert(Array.isArray(items) && items.length > 0, 'items present');
    const noNote = items.map((i, n) => ({ ...i, result: n === 0 ? 'Fail' : 'Pass', note: '' }));
    const bad = await req('PATCH', `/api/admin/qc/inspections/${insp.id}`, owner, { items: noNote });
    assert(bad.status === 400 && /comment/i.test(bad.body.error || ''), 'fail without comment ' + bad.status);
    const rated = items.map((i, n) => ({ ...i, result: n === 0 ? 'Fail' : 'Pass', note: n === 0 ? 'Missed glass streak' : '' }));
    const ok = await req('PATCH', `/api/admin/qc/inspections/${insp.id}`, owner, { items: rated });
    assert(ok.status === 200, 'rated ' + ok.status + ' ' + JSON.stringify(ok.body).slice(0, 160));
    const signed = await req('POST', `/api/admin/qc/inspections/${insp.id}/sign`, owner, { name: 'Test Inspector' });
    assert(signed.status === 200, 'sign ' + signed.status + ' ' + JSON.stringify(signed.body).slice(0, 160));
    const again = await req('POST', `/api/admin/qc/inspections/${insp.id}/sign`, owner, { name: 'Test Inspector' });
    assert(again.status === 409, 'second sign ' + again.status);
    const locked = await req('PATCH', `/api/admin/qc/inspections/${insp.id}`, owner, { notes: 'after sign' });
    assert(locked.status === 409, 'edit after sign ' + locked.status);
    const after = await req('GET', `/api/admin/qc/inspections/${insp.id}`, owner);
    const row = after.body.inspection || after.body;
    return `failed item needs comment; signed; second sign and later edits refused; status ${row.status}, score ${row.score}`;
  });

  await check('Inspections: a customer walkthrough cannot be accepted until it is signed; sales cannot cancel', async () => {
    const c = await req('POST', '/api/admin/qc/inspections', owner, { area: 'Riverside suite 2', date: '2026-11-10', template_id: tplId, itype: 'Customer walkthrough' });
    assert(c.status === 201, 'create walkthrough ' + c.status);
    insp2 = c.body.inspection || c.body;
    const early = await req('POST', `/api/admin/qc/inspections/${insp2.id}/accept`, owner, { name: 'Pat Client' });
    assert(early.status === 409, 'accept before sign ' + early.status);
    const cancelSales = await req('PATCH', `/api/admin/qc/inspections/${insp2.id}`, sales, { status: 'Cancelled' });
    assert(cancelSales.status === 403, 'sales cancel ' + cancelSales.status);
    return '409 before signing; 403 for sales cancel';
  });

  // ---- Takeoffs
  let toId = null;
  await check('Takeoffs: a takeoff is created; missing name, bad category and bad area are refused', async () => {
    const ok = await req('POST', '/api/admin/takeoffs', owner, { name: 'Riverside drawing set rev B', category: 'multifamily', building_sf: 52000 });
    assert(ok.status === 201, 'create ' + ok.status + ' ' + JSON.stringify(ok.body).slice(0, 200));
    toId = (ok.body.takeoff || ok.body).id;
    assert(toId, 'takeoff id');
    const noName = await req('POST', '/api/admin/takeoffs', owner, { category: 'multifamily' });
    assert(noName.status === 400, 'no name ' + noName.status);
    const badCat = await req('POST', '/api/admin/takeoffs', owner, { name: 'X', category: 'nonsense' });
    assert(badCat.status === 400, 'bad category ' + badCat.status);
    const badSf = await req('POST', '/api/admin/takeoffs', owner, { name: 'X', category: 'janitorial', building_sf: -5 });
    assert(badSf.status === 400, 'negative area ' + badSf.status);
    return `takeoff ${toId}; 3 bad inputs refused`;
  });

  await check('Takeoffs: pricing either returns a total or says why it cannot price yet (no quantities entered)', async () => {
    const p = await req('GET', `/api/admin/takeoffs/${toId}/price`, owner);
    if (p.status === 200) { const pr = p.body.price || {}; assert(typeof pr.total === 'number', 'total is a number'); if (pr.total === 0) assert((pr.warnings || []).some(w => /No priced lines/.test(w)), 'a $0 price must carry a warning'); return 'priced $' + pr.total + (pr.total === 0 ? ' with warning: no priced lines yet' : ''); }
    assert(p.status === 400 && (p.body.error || '').length > 0, 'expected a reason, got ' + p.status);
    return 'not priced yet: ' + p.body.error.slice(0, 120);
  });

  // ---- Reports
  await check('Reports: finance, labor and aging return data for an owner', async () => {
    for (const u of ['/api/admin/reports/finance', '/api/admin/reports/labor', '/api/admin/reports/aging']) {
      const r = await req('GET', u, owner);
      assert(r.status === 200 && r.body && typeof r.body === 'object', u + ' ' + r.status);
    }
    return 'finance, labor, aging all 200';
  });

  await check('Reports: CSV export downloads; sales cannot see finance reports', async () => {
    const csv = await fetch(BASE + '/api/admin/reports/export.csv', { headers: { Authorization: 'Bearer ' + owner } });
    assert(csv.status === 200, 'csv ' + csv.status);
    assert(/text\/csv/i.test(csv.headers.get('content-type') || ''), 'csv type ' + csv.headers.get('content-type'));
    const s = await req('GET', '/api/admin/reports/finance', sales);
    assert(s.status === 403, 'sales finance ' + s.status);
    return 'csv 200; sales 403 on finance';
  });

  // ---- Contracts and projects (lists and guards; creating them needs an approved proposal, covered in run-tests.js)
  await check('Contracts and projects: lists load; actions on a missing record return 404; sales are refused project dispatch', async () => {
    const c = await req('GET', '/api/admin/contracts2', owner);
    const p = await req('GET', '/api/admin/pm/projects', owner);
    assert(c.status === 200 && p.status === 200, `lists ${c.status} ${p.status}`);
    const miss = await req('GET', '/api/admin/contracts2/999999', owner);
    assert(miss.status === 404, 'missing contract ' + miss.status);
    const pm = await req('GET', '/api/admin/pm/projects/999999', owner);
    assert(pm.status === 404, 'missing project ' + pm.status);
    const disp = await req('POST', '/api/admin/pm/projects/999999/approve-dispatch', sales, {});
    assert(disp.status === 403 || disp.status === 404, 'sales dispatch ' + disp.status);
    return 'lists 200; missing records 404; sales dispatch refused';
  });

  stop();
  await new Promise(r => setTimeout(r, 500));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL setup -> ' + e.message); stop(); process.exit(1); });
