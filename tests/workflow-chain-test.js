// Contract-to-project chain: proposal -> sent -> customer approval -> draft contract and planning project -> contract countersigned
// -> readiness -> dispatch approval -> billing handoff refused until the job is completed.
// Starts its own server on a temporary database (port 3999) and always stops it. Mail goes to a local test server that keeps it in memory; no payment is taken.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const PORT = 3999, BASE = `http://127.0.0.1:${PORT}`, SMTP_TEST_PORT = 2799;
const OWNER = 'owner@example.test', OWNER_PW = 'Owner-test-password-123';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-chain-'));
const results = []; const assert = (c, m) => { if (!c) throw new Error(m); };
let child = null, smtp = null;
function stop() { if (child && !child.killed) { try { child.kill(); } catch {} } if (smtp) { try { smtp.close(); } catch {} } }
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
  const { SMTPServer } = require(path.join(ROOT, 'node_modules', 'smtp-server'));
  const mailbox = [];
  smtp = new SMTPServer({
    authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'],
    onAuth(auth, session, cb) { cb(null, { user: auth.username }); },
    onData(stream, session, cb) { let raw = ''; stream.on('data', d => raw += d); stream.on('end', () => { mailbox.push({ to: session.envelope.rcptTo.map(r => r.address), raw }); cb(); }); }
  });
  await new Promise(r => smtp.listen(SMTP_TEST_PORT, '127.0.0.1', r));

  const env = {
    ...process.env, NODE_ENV: 'development', PORT: String(PORT), DATA_DIR: path.join(dir, 'data'), UPLOAD_DIR: path.join(dir, 'uploads'),
    JWT_SECRET: 'workflow-chain-test-secret-0123456789abcdef', ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: bcrypt.hashSync(OWNER_PW, 4),
    PUBLIC_BASE_URL: BASE, DISABLE_SCHEDULER: '1',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_TEST_PORT), SMTP_SECURE: 'false', SMTP_USER: 'test', SMTP_PASS: 'test', FROM_EMAIL: 'info@brightclean.net'
  };
  delete env.STRIPE_SECRET_KEY; delete env.ANTHROPIC_API_KEY;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: 'ignore' });
  await waitHealthy();

  const req = async (method, url, token, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const tvOf = email => {
    const d = new Database(path.join(env.DATA_DIR, 'brightclean.db'), { readonly: true });
    try { const r = d.prepare('SELECT token_ver FROM admin_users WHERE lower(email)=?').get(email.toLowerCase()); if (r) return r.token_ver || 0; const s = d.prepare("SELECT value FROM settings WHERE key='owner_token_ver'").get(); return s ? Number(s.value) || 0 : 0; }
    finally { d.close(); }
  };
  const mint = email => jwt.sign({ role: 'admin', email, tv: tvOf(email), mfa: true }, env.JWT_SECRET, { expiresIn: '1h' });
  const owner = mint(OWNER);
  const mk = await req('POST', '/api/admin/users', owner, { email: 'sales.chain@example.test', name: 'Sales Test', password: 'Sales-test-password-123', role: 'sales' });
  assert(mk.status === 201, 'create sales user ' + mk.status);
  const sales = mint('sales.chain@example.test');

  let est = null, con = null, prj = null;

  await check('1 Proposal: a priced proposal is created for a general contractor', async () => {
    const r = await req('POST', '/api/admin/estimates', owner, {
      customer_name: 'Dana Builder', company: 'Riverside Builders', email: 'dana.builder@example.test', project_name: 'Riverside Lofts final clean',
      site_address: '400 Demo Ave, Testville', scope: 'Final clean of 36,000 SF, three phases', area_sqft: 36000, production_rate: 2000,
      labor_hours: 18, labor_rate: 24, supplies_cost: 400, equipment_cost: 150, overhead_pct: 10, margin_pct: 35, proposal_total: 6200,
      line_items: [{ description: 'Final clean', amount: 6200 }], expires_on: '2027-06-30'
    });
    assert(r.status === 201, 'create ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 220));
    est = r.body.estimate || r.body;
    assert(est.id, 'estimate id');
    assert(r.body.notice && /You entered \$6200\.00/.test(r.body.notice) && /uses \$1661\.85/.test(r.body.notice), 'price notice: ' + r.body.notice);
    assert((r.body.flags || []).some(x => x.level === 'warn' && /Below the typical cleaning price/.test(x.text)), 'per-sq-ft warning shown');
    const back = await req('GET', '/api/admin/estimates/' + est.id, owner); est = back.body.estimate || back.body;
    assert((est.flags || []).some(x => x.level === 'warn' && /Below the typical cleaning price/.test(x.text)), 'GET estimate carries the warning');
    return `proposal ${est.id}, status ${est.status}, proposal_total ${est.proposal_total}, total_cost ${est.total_cost}, margin ${est.margin_pct}`;
  });

  await check('2 Proposal: sent to the customer by email; status becomes Sent', async () => {
    const r = await req('POST', `/api/admin/estimates/${est.id}/send`, owner, {});
    assert(r.status === 200, 'send ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
    const st = await req('GET', `/api/admin/estimates/${est.id}`, owner);
    est = st.body.estimate || st.body;
    assert(est.status === 'Sent', 'status ' + est.status);
    assert(mailbox.some(m => m.to.includes('dana.builder@example.test')), 'proposal email reached the test mailbox');
    return 'emailed to the customer on the local test mailbox; status Sent';
  });

  await check('3 Customer approval needs the signer name and agreement', async () => {
    const noName = await req('POST', `/api/proposal/${est.public_token}/respond`, null, { decision: 'approve', agree: true });
    assert(noName.status === 400, 'no name ' + noName.status);
    const noAgree = await req('POST', `/api/proposal/${est.public_token}/respond`, null, { decision: 'approve', signer_name: 'Dana Builder' });
    assert(noAgree.status === 400, 'no agreement ' + noAgree.status);
    return '400 without name or agreement';
  });

  await check('4 Customer approves: the proposal is Approved and a draft contract and planning project are created', async () => {
    const ok = await req('POST', `/api/proposal/${est.public_token}/respond`, null, { decision: 'approve', signer_name: 'Dana Builder', agree: true });
    assert(ok.status === 200, 'approval ' + ok.status + ' ' + JSON.stringify(ok.body).slice(0, 200));
    const cs = await req('GET', '/api/admin/contracts2', owner);
    const contracts = (cs.body.contracts || []).filter(c => c.estimate_id === est.id);
    assert(contracts.length === 1, 'contract count ' + contracts.length);
    con = contracts[0];
    assert(con.status === 'Draft', 'contract is ' + con.status);
    const ps = await req('GET', '/api/admin/pm/projects', owner);
    const projects = (ps.body.projects || []).filter(p => p.contract_id === con.id);
    assert(projects.length === 1, 'project count ' + projects.length);
    prj = projects[0];
    assert(prj.status === 'Planning', 'project is ' + prj.status);
    return `contract ${con.number || con.id} Draft, project ${prj.id} Planning`;
  });

  await check('5 A second approval is refused and creates no second contract', async () => {
    const again = await req('POST', `/api/proposal/${est.public_token}/respond`, null, { decision: 'approve', signer_name: 'Dana Builder', agree: true });
    assert(again.status === 409, 'second approval ' + again.status);
    const cs = await req('GET', '/api/admin/contracts2', owner);
    assert((cs.body.contracts || []).filter(c => c.estimate_id === est.id).length === 1, 'still one contract');
    return '409; still one contract';
  });

  await check('6 Contract needs its dates before it can be sent for signature; then it is sent', async () => {
    const early = await req('POST', `/api/admin/contracts2/${con.id}/send`, owner, {});
    assert(early.status === 400 && /start date/i.test(early.body.error || ''), 'send without dates ' + early.status);
    const dated = await req('PATCH', `/api/admin/contracts2/${con.id}`, owner, { start_date: '2026-12-01', end_date: '2027-06-30' });
    assert(dated.status === 200, 'add dates ' + dated.status + ' ' + JSON.stringify(dated.body).slice(0, 160));
    const sent = await req('POST', `/api/admin/contracts2/${con.id}/send`, owner, {});
    assert(sent.status === 200, 'send ' + sent.status + ' ' + JSON.stringify(sent.body).slice(0, 160));
    return 'refused without dates; sent after dates added';
  });

  await check('7 Sales cannot countersign; the owner countersigns and the contract becomes Active and the project Contracted', async () => {
    const s = await req('POST', `/api/admin/contracts2/${con.id}/countersign`, sales, { name: 'Sales Test' });
    assert(s.status === 403, 'sales countersign ' + s.status);
    const c = await req('POST', `/api/admin/contracts2/${con.id}/countersign`, owner, { name: 'Test Owner' });
    assert(c.status === 200, 'countersign ' + c.status + ' ' + JSON.stringify(c.body).slice(0, 200));
    const cs = await req('GET', '/api/admin/contracts2', owner);
    const row = (cs.body.contracts || []).find(x => x.id === con.id);
    assert(row && row.status === 'Active', 'contract status ' + (row && row.status));
    const ps = await req('GET', '/api/admin/pm/projects', owner);
    const p = (ps.body.projects || []).find(x => x.id === prj.id);
    assert(p && p.status === 'Contracted', 'project status ' + (p && p.status));
    return `contract Active (${row.signature_status}); project Contracted`;
  });

  await check('8 Dispatch is refused until every readiness item is confirmed', async () => {
    const d = await req('POST', `/api/admin/pm/projects/${prj.id}/approve-dispatch`, owner, {});
    assert(d.status === 409 && /readiness/i.test(d.body.error || ''), 'dispatch early ' + d.status + ' ' + JSON.stringify(d.body).slice(0, 160));
    return '409: ' + d.body.error.slice(0, 120);
  });

  await check('9 All six readiness items are confirmed, then dispatch is approved', async () => {
    for (const key of ['staffing', 'dates', 'access', 'equipment', 'supplies', 'safety']) {
      const r = await req('POST', `/api/admin/pm/projects/${prj.id}/readiness`, owner, { key, note: 'test' });
      assert(r.status === 200, key + ' ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
    }
    const d = await req('POST', `/api/admin/pm/projects/${prj.id}/approve-dispatch`, owner, {});
    assert(d.status === 200, 'dispatch ' + d.status + ' ' + JSON.stringify(d.body).slice(0, 200));
    return '6 of 6 confirmed; dispatch approved';
  });

  await check('10 Sales cannot approve dispatch; billing is refused until the job is completed', async () => {
    const sd = await req('POST', `/api/admin/pm/projects/${prj.id}/approve-dispatch`, sales, {});
    assert(sd.status === 403, 'sales dispatch ' + sd.status);
    const b = await req('POST', `/api/admin/pm/projects/${prj.id}/billing-handoff`, owner, {});
    assert(b.status === 409 && /complete/i.test(b.body.error || ''), 'billing before completion ' + b.status + ' ' + JSON.stringify(b.body).slice(0, 160));
    return `sales 403; billing 409: ${b.body.error.slice(0, 100)}`;
  });

  let taskId = null, invId = null;
  await check('11 Work is scheduled: a one-time visit is added to the project and goes live (dispatch approved)', async () => {
    const r = await req('POST', `/api/admin/pm/projects/${prj.id}/work-orders`, owner, { frequency: 'once', start: '2026-12-02', count: 1 });
    assert(r.status === 201 || r.status === 200, 'work order ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
    const vs = await req('GET', '/api/admin/visits', owner);
    const mine = (vs.body.visits || []).filter(v => v.project_id === prj.id);
    assert(mine.length >= 1, 'visits on project ' + mine.length);
    assert(mine.every(v => v.status === 'Scheduled'), 'statuses ' + mine.map(v => v.status).join(','));
    return `${mine.length} visit(s) Scheduled`;
  });

  await check('12 Project moves to In Progress; then the open task blocks completion', async () => {
    const ip = await req('POST', `/api/admin/pm/projects/${prj.id}/status`, owner, { status: 'In Progress' });
    assert(ip.status === 200, 'In Progress ' + ip.status + ' ' + JSON.stringify(ip.body).slice(0, 200));
    const t = await req('POST', `/api/admin/pm/projects/${prj.id}/tasks`, owner, { title: 'Final clean and punch list', phase: 'Execution', weight: 5 });
    assert(t.status === 201, 'task ' + t.status + ' ' + JSON.stringify(t.body).slice(0, 160));
    taskId = (t.body.task || t.body).id;
    const early = await req('POST', `/api/admin/pm/projects/${prj.id}/status`, owner, { status: 'Completed' });
    assert(early.status === 409 && /task/i.test(early.body.error || ''), 'complete with open task ' + early.status + ' ' + JSON.stringify(early.body).slice(0, 200));
    return 'In Progress; completion blocked by the open task';
  });

  await check('13 Task done and verified by the owner; a quality inspection is signed and passes; the customer signs off', async () => {
    const done = await req('PATCH', `/api/admin/pm/tasks/${taskId}`, owner, { status: 'Done' });
    assert(done.status === 200, 'task done ' + done.status + ' ' + JSON.stringify(done.body).slice(0, 160));
    const ver = await req('PATCH', `/api/admin/pm/tasks/${taskId}`, owner, { status: 'Verified' });
    assert(ver.status === 200, 'task verified ' + ver.status + ' ' + JSON.stringify(ver.body).slice(0, 160));
    const tpls = await req('GET', '/api/admin/qc/templates', owner);
    const tplFor = (tpls.body.templates || []).find(x => x.active) || (tpls.body.templates || [])[0];
    const c = await req('POST', '/api/admin/qc/inspections', owner, { area: 'Riverside Lofts - final walk', date: '2026-12-02', template_id: tplFor.id, itype: 'Internal', project_id: prj.id });
    assert(c.status === 201, 'inspection ' + c.status + ' ' + JSON.stringify(c.body).slice(0, 200));
    invId = (c.body.inspection || c.body).id;
    const cur = await req('GET', `/api/admin/qc/inspections/${invId}`, owner);
    const items = (cur.body.inspection || cur.body).items.map(i => ({ ...i, result: 'Pass', note: '' }));
    const rated = await req('PATCH', `/api/admin/qc/inspections/${invId}`, owner, { items });
    assert(rated.status === 200, 'rate ' + rated.status);
    const signed = await req('POST', `/api/admin/qc/inspections/${invId}/sign`, owner, { name: 'Test Inspector' });
    assert(signed.status === 200, 'sign ' + signed.status + ' ' + JSON.stringify(signed.body).slice(0, 160));
    const so = await req('POST', `/api/admin/pm/projects/${prj.id}/signoff`, owner, { name: 'Dana Builder', title: 'Site manager' });
    assert(so.status === 200, 'sign-off ' + so.status + ' ' + JSON.stringify(so.body).slice(0, 160));
    return `task verified; inspection ${invId} signed; customer sign-off recorded`;
  });

  await check('14 Project completes; the draft billing invoice is created for the contract value and not sent', async () => {
    const q = await req('POST', `/api/admin/pm/projects/${prj.id}/status`, owner, { status: 'Quality Review' });
    assert(q.status === 200, 'Quality Review ' + q.status + ' ' + JSON.stringify(q.body).slice(0, 200));
    const done = await req('POST', `/api/admin/pm/projects/${prj.id}/status`, owner, { status: 'Completed' });
    assert(done.status === 200, 'Completed ' + done.status + ' ' + JSON.stringify(done.body).slice(0, 260));
    const b = await req('POST', `/api/admin/pm/projects/${prj.id}/billing-handoff`, owner, {});
    assert(b.status === 200 || b.status === 201, 'billing ' + b.status + ' ' + JSON.stringify(b.body).slice(0, 200));
    const cv = await req('GET', '/api/admin/contracts2', owner);
    const crow = (cv.body.contracts || []).find(x => x.id === con.id) || {};
    assert(b.body.invoice_id && Number(b.body.amount) === Number(crow.value), 'handoff bills the contract value: billed ' + b.body.amount + ', contract value ' + crow.value);
    const list = await req('GET', '/api/admin/invoices', owner);
    const inv = (list.body.invoices || []).find(x => x.id === b.body.invoice_id);
    assert(inv, 'invoice in the list');
    assert(inv.status === 'Draft', 'invoice status ' + inv.status);
    assert(Number(inv.amount) === Number(est.proposal_total), 'invoice equals the approved proposal total: ' + inv.amount + ' vs ' + est.proposal_total);
    assert(!inv.sent_at, 'not sent');
    const again = await req('POST', `/api/admin/pm/projects/${prj.id}/billing-handoff`, owner, {});
    assert(again.status === 409, 'second handoff ' + again.status);
    return `draft invoice ${inv.invoice_number} for $${inv.amount}, not sent; second handoff refused`;
  });

  await check('15 Completed project cannot be reopened from the status control', async () => {
    const r = await req('POST', `/api/admin/pm/projects/${prj.id}/status`, owner, { status: 'In Progress' });
    assert(r.status === 409, 'reopen ' + r.status);
    return '409: ' + r.body.error.slice(0, 100);
  });

  stop();
  await new Promise(r => setTimeout(r, 500));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL setup -> ' + e.message); stop(); process.exit(1); });
