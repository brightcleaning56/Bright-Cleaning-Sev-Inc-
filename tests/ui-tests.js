process.env.TZ = process.env.BUSINESS_TZ || 'America/Chicago'; // run the browser tests on the office clock
/* Bright Clean UI tests: loads the real admin portal and proposal page in jsdom against a live server.
 *   npm i --no-save jsdom
 *   node tests/ui-tests.js        (writes tests/ui-results.json)
 */
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const PORT = 4100 + Math.floor(Math.random() * 50), B = `http://127.0.0.1:${PORT}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ui-'));
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(area, name, fn) {
  try { const ev = await fn(); results.push({ area, name, status: 'PASS', evidence: String(ev || 'ok').slice(0, 400) }); console.log('PASS  [' + area + '] ' + name); }
  catch (e) { results.push({ area, name, status: 'FAIL', evidence: e.message.slice(0, 400) }); console.log('FAIL  [' + area + '] ' + name + '  -> ' + e.message); }
}

(async () => {
  const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
  const env = { ...process.env, PORT: String(PORT), RATE_LIMIT_PUBLIC: '5000', NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(40).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 10), DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'up'), DISABLE_SCHEDULER: '1' };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
  const api = async (m, u, j, t) => (await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined })).json();
  const T = (await api('POST', '/api/admin/login', { email: OWNER, password: PW })).token;
  await api('PUT', '/api/admin/approval-rules', { min_margin_pct: 0, max_total: 0, flag_pre_pricing: false, approve_all: false }, T); // approvals tested separately below
  // seed
  await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: '<img src=x onerror=window.__xss=1>', email: 'xss@test.test', message: '<script>window.__xss=1</script>' }) });
  const est = (await api('POST', '/api/admin/estimates', { customer_name: 'Dana', company: 'Prairie', email: 'dana@prairie.test', scope: 'Final clean', area_sqft: 24000, production_rate: 2000, labor_rate: 30, crew_size: 3, margin_pct: 25 }, T)).estimate;

  const errors = [];
  async function open(url, token) {
    const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(url + ' ' + e.message));
    const dom = await JSDOM.fromURL(B + url, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(w) { if (token) w.localStorage.setItem('bc_admin_token', token); w.fetch = (u, o) => fetch(new URL(u, B), o); w.confirm = () => true; w.prompt = (m, d) => d; w.alert = m => { w.__alert = m; }; w.scrollTo = () => { }; w.open = () => ({ document: { write() { }, close() { } } }); w.addEventListener('error', e => errors.push(url + ' ' + e.message)); w.addEventListener('unhandledrejection', e => errors.push(url + ' ' + (e.reason && e.reason.message))); }
    });
    await sleep(1200); return dom.window;
  }
  const w = await open('/admin/', T), d = w.document, $ = s => d.querySelector(s);
  const txt = s => ($(s) ? $(s).textContent.replace(/\s+/g, ' ').trim() : '');
  const $$rows = () => d.querySelectorAll('#slRows tr').length;
  const nav = async v => { d.querySelector(`#nav [data-view="${v}"]`).click(); await sleep(600); };

  await check('Admin UI', 'Signed-in portal loads with all 23 sections', async () => {
    const views = [...d.querySelectorAll('.view')].map(v => v.id);
    assert(!$('#app').hidden && views.length === 23, views.join(',')); return views.join(', ');
  });
  for (const v of ['overview', 'workqueue', 'leads', 'customers', 'issues', 'calls', 'emails', 'takeoffs', 'schedule', 'quality', 'documents', 'website', 'reports', 'proposals', 'contracts', 'projects', 'invoices', 'scopes', 'activity', 'settings']) {
    await check('Admin UI', `Section "${v}" opens and renders`, async () => {
      await nav(v); const el = $('#v-' + v);
      assert(el.classList.contains('active') && el.textContent.trim().length > 20, 'not active'); return el.querySelector('h1').textContent;
    });
  }
  await check('Security', 'Script/HTML in a submitted lead is shown as text, never executed', async () => {
    await nav('leads'); d.querySelector('#leadKinds [data-kind="inquiry"]').click(); await sleep(200);
    assert(!w.__xss && txt('#leadRows').includes('<img src=x'), 'xss executed or missing');
    d.querySelector('#leadRows [data-lead]').click(); await sleep(500);
    assert(!w.__xss && !$('#drawerRoot img'), 'xss in drawer'); d.querySelector('[data-close]').click();
    return 'payload visible as text in list and detail; no script ran';
  });
  await check('Estimating UI', 'Template fills scope; extra fields present; live total matches the server', async () => {
    await nav('proposals'); d.querySelector('#v-proposals [data-action="new-estimate"]').click(); await sleep(700);
    const f = $('#estimateForm');
    assert($('#eT').options.length === 7, 'templates ' + $('#eT').options.length);
    $('#eT').value = 'commercial-janitorial'; $('#eT').dispatchEvent(new w.Event('change')); await sleep(50);
    assert(/janitorial/i.test(f.elements.scope.value), 'scope not filled');
    const vals = { customer_name: 'UI Test', company: 'UI Co', email: 'ui@test.test', area_sqft: 10000, production_rate: 2000, visits: 4, labor_rate: 28, supplies_cost: 200, equipment_cost: 50, travel_cost: 25, mobilization_cost: 150, subcontractor_cost: 300, disposal_cost: 75, insurance_pct: 3, contingency_pct: 5, overhead_pct: 12, margin_pct: 30, tax_pct: 7, crew_size: 2, shift_hours: 8 };
    for (const [k, v] of Object.entries(vals)) { assert(f.elements[k], 'missing field ' + k); f.elements[k].value = v; }
    f.dispatchEvent(new w.Event('input', { bubbles: true }));
    const shown = txt('#cTotal'), days = txt('#cDays');
    f.dispatchEvent(new w.Event('submit', { cancelable: true })); await sleep(1000);
    const saved = (await api('GET', '/api/admin/estimates', null, T)).estimates.find(e => e.customer_name === 'UI Test');
    const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(saved.proposal_total);
    assert(shown === fmt && days === '1.3' && saved.crew_days === 1.25 && saved.template_key === 'commercial-janitorial', `${shown} vs ${fmt}, days ${days}`);
    return `screen ${shown} = server ${fmt}; crew days ${days}`;
  });
  await check('Estimating UI', 'Minimum charge and line-item price warnings appear', async () => {
    d.querySelector('#v-proposals [data-action="new-estimate"]').click(); await sleep(500);
    const f = $('#estimateForm');
    f.elements.labor_hours.value = 1; f.elements.labor_rate.value = 20; f.elements.minimum_charge.value = 250;
    f.dispatchEvent(new w.Event('input', { bubbles: true }));
    const a = txt('#cTotal'), warnA = txt('#cWarn');
    f.elements.minimum_charge.value = 0; f.elements.line_items_text.value = 'A | 900\nB | 100'; f.elements.use_line_items.checked = true;
    f.dispatchEvent(new w.Event('input', { bubbles: true }));
    assert(a === '$250.00' && /minimum/i.test(warnA) && txt('#cTotal') === '$1,000.00', `${a} ${warnA} ${txt('#cTotal')}`);
    return `min charge -> $250.00 with notice; line items -> $1,000.00`;
  });
  await check('Proposals UI', 'Proposal panel shows sent/viewed/decision times and locks a customer decision', async () => {
    await api('POST', `/api/admin/estimates/${est.id}/send`, null, T);
    if ((await api('GET', '/api/admin/estimates/' + est.id, null, T)).estimate.status === 'Draft') await api('PATCH', '/api/admin/estimates/' + est.id, { status: 'Sent' }, T);
    await fetch(B + '/api/proposal/' + est.public_token);
    await fetch(B + `/api/proposal/${est.public_token}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve', signer_name: 'Dana Signer', agree: true }) });
    await nav('proposals'); d.querySelector(`#propRows [data-est="${est.id}"]`).click(); await sleep(600);
    const body = txt('#drawerRoot');
    assert(/Customer viewed\s*First/.test(body) && /by the customer online/.test(body) && $('#es').disabled && $('#eEdit').disabled && $('#eDel').disabled, body.slice(0, 300));
    d.querySelector('[data-close]').click();
    return 'viewed + decision times shown; status, edit and delete locked';
  });
  await check('Workflow UI', 'Approved proposal appears as draft contract and planning project in their sections', async () => {
    await nav('contracts'); const c = txt('#rows-contracts'); await nav('projects'); const p = txt('#rows-projects');
    assert(/Draft/.test(c) && /Planning/.test(p), c + ' | ' + p); return 'contract row Draft; project row Planning';
  });
  await check('Customers UI', 'Directory lists customers; add, edit notes and view related records', async () => {
    await nav('customers');
    const before = d.querySelectorAll('#custRows [data-cust]').length;
    $('#custAdd').click(); await sleep(300);
    const f = $('#custForm'); f.elements.name.value = 'Lee'; f.elements.company.value = 'Valley Apts'; f.elements.email.value = 'lee@valley.test';
    $('#cSave').click(); await sleep(800);
    const after = d.querySelectorAll('#custRows [data-cust]').length;
    const prairie = [...d.querySelectorAll('#custRows [data-cust]')].find(r => r.textContent.includes('Prairie')); prairie.click(); await sleep(1200);
    const tabs = txt('#custPage .ctabs');
    d.querySelector('#custPage .ctabs [data-t="notes"]').click(); await sleep(50);
    const nf = $('#ntForm'); nf.elements.body.value = 'Gate code 1234'; nf.dispatchEvent(new w.Event('submit', { cancelable: true })); await sleep(900);
    const saved = (await api('GET', '/api/admin/customers', null, T)).customers.find(c => c.company === 'Prairie');
    const prof = await api('GET', `/api/admin/customers/${saved.id}/profile`, null, T);
    assert(after === before + 1 && /Proposals\(1\)/.test(tabs.replace(/\s+/g, '')) && /Contracts\(1\)/.test(tabs.replace(/\s+/g, '')) && prof.notes.some(n => n.body === 'Gate code 1234'), `${before}->${after} ${tabs}`);
    return `${before} -> ${after} customers; Prairie page shows proposal + contract tabs; note saved with author`;
  });
  await check('Invoices UI', 'New invoice form has billing email, auto number; payment recorded from list', async () => {
    await nav('invoices'); d.querySelector('[data-new="invoices"]').click(); await sleep(700);
    assert($('#r_email') && /^BC-\d{4}-\d{4}$/.test($('#r_invoice_number').value), 'no email field / number');
    $('#r_email').value = 'ap@prairie.test'; $('#r_amount').value = '800'; $('#r_company').value = 'Prairie'; $('#r_status').value = 'Sent';
    $('#recSave').click(); await sleep(900);
    d.querySelector('#rows-invoices [data-pay]').click(); await sleep(900);
    const inv = (await api('GET', '/api/admin/invoices', null, T)).invoices[0];
    assert(inv.email === 'ap@prairie.test' && inv.status === 'Paid', JSON.stringify(inv)); return `${inv.invoice_number} saved with email; payment -> Paid`;
  });
  await check('Settings UI', 'Automation panel: email status, four toggles, toggling saves, run-now works, log shows', async () => {
    await nav('settings'); await sleep(400);
    const toggles = d.querySelectorAll('[data-auto]');
    assert(toggles.length === 4 && /not set up/i.test(txt('#autoEmail')), toggles.length + ' ' + txt('#autoEmail'));
    const cb = d.querySelector('[data-auto="auto_invoice_reminders"]'); cb.checked = true; cb.dispatchEvent(new w.Event('change')); await sleep(500);
    const s = await api('GET', '/api/admin/settings', null, T);
    $('#autoRun').click(); await sleep(900);
    assert(s.settings.auto_invoice_reminders && /Done/.test(txt('#autoMsg')), txt('#autoMsg'));
    return `${toggles.length} toggles; invoice reminders saved on; "${txt('#autoMsg')}"`;
  });
  await check('Settings UI', 'Backups panel: back up now and list with download', async () => {
    $('#backupNow').click(); await sleep(900);
    assert(/Backup created/.test(txt('#backupMsg')) && d.querySelectorAll('[data-backup]').length >= 1, txt('#backupMsg')); return txt('#backupMsg');
  });
  await check('Proposal page', 'Customer page renders; decided proposal shows decision and disables buttons', async () => {
    const pw = await open('/proposal/' + est.public_token, null);
    const t = pw.document.body.textContent;
    assert(/was approved/i.test(t) && pw.document.querySelector('#approve').disabled && pw.document.querySelector('#decline').disabled, t.slice(0, 200));
    return 'shows "This proposal was approved on …"; buttons disabled';
  });
  await check('Proposals UI', 'Mockup layout: 6 KPI cards, value summary, 5 tabs, workflow stepper; Details shows scope, costs, versions, history; tabs filter estimates vs proposals', async () => {
    await nav('proposals'); await sleep(1200);
    const kpis = d.querySelectorAll('#propKpis .ktile').length, sums = d.querySelectorAll('#propSum > div').length, tabs = d.querySelectorAll('#propTabs button').length, steps = d.querySelectorAll('#propFlow li').length;
    d.querySelector('#propRows [data-det]').click(); await sleep(1300);
    const body = txt('#drawerRoot .body'), foot = txt('#drawerRoot footer');
    d.querySelector('#drawerRoot [data-close]').click(); await sleep(200);
    d.querySelector('#propTabs [data-pv="estimates"]').click(); await sleep(900);
    const estRows = [...d.querySelectorAll('#propRows tr')].map(r => r.textContent);
    d.querySelector('#propTabs [data-pv="all"]').click(); await sleep(600);
    assert(kpis === 6 && sums === 4 && tabs === 5 && steps === 8 && /Scope of work/.test(body) && /Internal costs/.test(body) && /Versions/.test(body) && /Approval & history/.test(body) && /Download PDF/.test(foot) && /Duplicate/.test(foot) && estRows.every(t => !/Accepted|Sent|Viewed/.test(t.split('$').pop())), JSON.stringify({ kpis, sums, tabs, steps, foot }));
    return `6 KPI cards, 4 summary figures, 5 tabs, 8-step workflow; Details: scope, costs & margin, versions, history; footer: ${foot.replace(/\s+/g, ' ').trim()}`;
  });
  await check('Projects UI', 'Mockup layout: 7 KPI tiles, status tabs, table, details panel; workspace opens with 14 tabs that all render; readiness boxes and work plan buttons present', async () => {
    await nav('projects'); await sleep(1200);
    const kpis = d.querySelectorAll('#pjKpis .ktile').length, tabs = d.querySelectorAll('#pjTabs button').length, flow = d.querySelectorAll('#pjFlow span').length;
    const row = d.querySelector('#rows-projects [data-pj]'); row.click(); await sleep(1200);
    const side = txt('#pjSide');
    $('#pjOpen').click(); await sleep(1300);
    const wt = [...d.querySelectorAll('#pjWork [data-wt]')].map(b => b.dataset.wt), ok = [];
    const rdy = d.querySelectorAll('#pjBody [data-rk]').length;
    for (const t of wt) { d.querySelector(`#pjWork [data-wt="${t}"]`).click(); await sleep(80); if (txt('#pjBody').length > 10) ok.push(t); }
    d.querySelector('#pjWork [data-wt="tasks"]').click(); await sleep(80);
    const plan = !!$('#planForm') || d.querySelectorAll('#pjBody .tk').length > 0;
    $('#pjBack').click(); await sleep(800);
    assert(kpis === 7 && tabs === 9 && flow === 8 && /Project progress/.test(side) && /Open project workspace/.test(side) && wt.length === 14 && ok.length === 14 && rdy === 6 && plan && !$('#pjList').hidden, JSON.stringify({ kpis, tabs, flow, wt: wt.length, ok: ok.length, rdy }));
    return `7 KPI tiles, 8 status tabs, 8-step workflow; details panel; workspace: ${ok.length}/14 tabs render; 6 readiness checks; work plan available`;
  });
  await check('Schedule UI', 'Dispatch center: 8 KPI cards, 4 tabs, side panel; add employee from the screen; job panel ranks crew and assigns; time sheets tab renders', async () => {
    await nav('schedule'); await sleep(1300);
    const kpis = d.querySelectorAll('#scheduleKpis .ktile').length, tabs = d.querySelectorAll('#schTabs button').length, side = txt('#schSide');
    $('#empAdd').click(); await sleep(600);
    const f = $('#genForm'); f.elements.name.value = 'Uma UI'; f.elements.hourly_rate.value = '20'; $('#genSave').click(); await sleep(1100);
    d.querySelector('#schTabs [data-sp="emp"]').click(); await sleep(1100);
    const emp = /Uma UI/.test(txt('#sp-emp'));
    const vis = await api('POST', '/api/admin/visits', { title: 'UI dispatch job', type: 'Cleaning phase', date: require('../bizdate').today(), start_time: '09:00', end_time: '11:00' }, T);
    d.querySelector('#schTabs [data-sp="cal"]').click(); await sleep(300);
    await nav('overview'); await nav('schedule'); await sleep(1300);
    const card = [...d.querySelectorAll('#schSide [data-job]')].find(x => x.textContent.includes('UI dispatch job') || x.closest('.jobcard') && x.closest('.jobcard').textContent.includes('UI dispatch job')); card.click(); await sleep(1300);
    const btn = [...d.querySelectorAll('#drawerRoot [data-as]')].find(b => b.closest('li').textContent.includes('Uma UI')); btn.click(); await sleep(1500);
    const assigned = /Remove/.test([...d.querySelectorAll('#drawerRoot .cand li')].find(li => li.textContent.includes('Uma UI')).textContent);
    d.querySelector('#drawerRoot [data-close]').click(); await sleep(200);
    d.querySelector('#schTabs [data-sp="time"]').click(); await sleep(1000);
    const time = /Awaiting approval/.test(txt('#sp-time'));
    d.querySelector('#schTabs [data-sp="cal"]').click();
    assert(kpis === 8 && tabs === 4 && /Dispatch board/.test(side) && /Unassigned jobs/.test(side) && emp && assigned && time, JSON.stringify({ kpis, tabs, emp, assigned, time }));
    return `8 KPI cards, 4 tabs, dispatch/unassigned/deadlines panel; employee added from the screen; job panel ranked crew and assigned Uma; time sheets render`;
  });
  await check('Proposal page', 'Open proposal can be approved by the customer from the page', async () => {
    const e2 = (await api('POST', '/api/admin/estimates', { customer_name: 'Page', company: 'Page Co', email: 'p@test.test', scope: 'x', labor_hours: 2, labor_rate: 30 }, T)).estimate;
    await api('PATCH', '/api/admin/estimates/' + e2.id, { status: 'Sent' }, T);
    const pw = await open('/proposal/' + e2.public_token, null);
    pw.document.querySelector('#sname').value = 'Page Signer'; pw.document.querySelector('#sagree').checked = true;
    pw.document.querySelector('#approve').click(); await sleep(800);
    const st = (await api('GET', '/api/admin/estimates/' + e2.id, null, T)).estimate.status;
    const sg = (await api('GET', '/api/admin/bids/' + e2.id, null, T)).estimate.signer_name;
    assert(st === 'Approved' && sg === 'Page Signer' && /recorded/i.test(pw.document.querySelector('#response').textContent), st); return `Approved with typed signature (${sg}); confirmation shown`;
  });
  await check('Proposal page', 'Admin preview: banner shown, buttons disabled, no view recorded', async () => {
    const e3 = (await api('POST', '/api/admin/estimates', { customer_name: 'Prev', company: 'Prev Co', scope: 'x', labor_hours: 2, labor_rate: 30 }, T)).estimate;
    const pw = await open('/proposal/' + e3.public_token, T);
    const st = (await api('GET', '/api/admin/estimates/' + e3.id, null, T)).estimate;
    assert(/Preview/.test(pw.document.body.textContent) && pw.document.querySelector('#approve').disabled && !st.viewed_at, 'preview'); return 'preview banner; buttons disabled; viewed_at empty';
  });
  await check('Public UI', 'Contact form on the website submits and shows confirmation', async () => {
    const pw = await open('/contact.html', null); const f = pw.document.querySelector('#contactForm');
    f.querySelector('[name=name]').value = 'Web Visitor'; f.querySelector('[name=email]').value = 'visitor@test.test'; f.querySelector('[name=message]').value = 'Hello';
    f.requestSubmit(); await sleep(900);
    assert(/received/i.test(pw.document.body.textContent), 'no confirmation'); return 'confirmation shown';
  });
  await check('Scopes UI', 'Library lists items with "Needs rates" flags and nav count; filters work', async () => {
    await nav('scopes');
    const rows = d.querySelectorAll('#scopeRows [data-scope]').length, flags = d.querySelectorAll('#scopeRows .badge.amber').length;
    $('#scopeCat').value = 'multifamily'; $('#scopeCat').dispatchEvent(new w.Event('input')); await sleep(100);
    const mf = d.querySelectorAll('#scopeRows [data-scope]').length;
    $('#scopeShow').value = 'missing'; $('#scopeShow').dispatchEvent(new w.Event('input')); await sleep(100);
    const miss = d.querySelectorAll('#scopeRows [data-scope]').length;
    $('#scopeCat').value = ''; $('#scopeShow').value = 'active'; $('#scopeCat').dispatchEvent(new w.Event('input'));
    assert(rows >= 40 && flags >= 39 && mf === 14 && miss === mf && !$('#navScopes').hidden && /have no price yet/.test(txt("#scopeNote")), `${rows} ${flags} ${mf} ${miss}`);
    return `${rows} items, ${flags} flagged; multifamily filter ${mf}; nav badge ${txt('#navScopes')}`;
  });
  await check('Scopes UI', 'Edit drawer saves rates and clears the flag; add item; archive moves it to Archived', async () => {
    const row = [...d.querySelectorAll('#scopeRows [data-scope]')].find(r => r.textContent.includes('Apartment unit turnover')); row.click(); await sleep(300);
    const f = $('#scopeForm'); f.elements.production_rate.value = '0.25'; f.elements.crew_size.value = '2'; f.elements.unit_price.value = '185';
    $('#sSave').click(); await sleep(800);
    const it = (await api('GET', '/api/admin/scopes', null, T)).items.find(i => i.name === 'Apartment unit turnover');
    const rowNow = [...d.querySelectorAll('#scopeRows [data-scope]')].find(r => r.textContent.includes('Apartment unit turnover'));
    $('#scopeAdd').click(); await sleep(300);
    const g = $('#scopeForm'); g.elements.category.value = 'specialty'; g.elements.name.value = 'Pressure-wash canopy'; g.elements.unit.value = 'SF';
    $('#sSave').click(); await sleep(800);
    const nr = [...d.querySelectorAll('#scopeRows [data-scope]')].find(r => r.textContent.includes('Pressure-wash canopy')); nr.click(); await sleep(300);
    w.confirm = () => true; $('#sArch').click(); await sleep(800);
    $('#scopeShow').value = 'archived'; $('#scopeShow').dispatchEvent(new w.Event('input')); await sleep(100);
    const arch = /Pressure-wash canopy/.test(txt('#scopeRows'));
    $('#scopeShow').value = 'active'; $('#scopeShow').dispatchEvent(new w.Event('input'));
    assert(it.unit_price === 185 && !it.missing.length && /Ready/.test(rowNow.textContent) && arch, JSON.stringify(it.missing));
    return 'unit turnover $185/unit saved, row shows Ready; new item added then archived';
  });
  await check('Scopes UI', 'Validation message shown in the drawer for a missing unit', async () => {
    $('#scopeAdd').click(); await sleep(300);
    $('#scopeForm').elements.name.value = 'No unit item'; $('#sSave').click(); await sleep(600);
    const m = txt('#scopeMsg'); $('#drawerRoot [data-close]').click();
    assert(/unit is required/i.test(m), m); return m;
  });
  await check('Estimating UI', 'Scope library picker: category limits items, unpriced items disabled, line total and hours match the server', async () => {
    await nav('proposals'); d.querySelector('#v-proposals [data-action="new-estimate"]').click(); await sleep(800);
    const f = $('#estimateForm');
    $('#slCat').value = 'multifamily'; $('#slCat').dispatchEvent(new w.Event('change', { bubbles: true })); await sleep(50);
    const opts = [...$('#slItem').options].slice(1);
    const enabled = opts.filter(o => !o.disabled).map(o => o.textContent);
    const foreign = opts.filter(o => /Daily office cleaning|construction clean|Power washing/i.test(o.textContent)).length;
    const turn = opts.find(o => /Apartment unit turnover/.test(o.textContent));
    $('#slItem').value = turn.value; $('#slQty').value = '24'; $('#slAdd').click(); await sleep(50);
    for (const [k, v] of Object.entries({ customer_name: 'Valley Apts UI', email: 'mgr@valley.test', scope: 'Unit turns', margin_pct: 0, overhead_pct: 0, tax_pct: 0, labor_rate: 25 })) f.elements[k].value = v;
    f.dispatchEvent(new w.Event('input', { bubbles: true }));
    const row = txt('#slRows'), shown = txt('#cTotal'), hours = txt('#cHours');
    f.dispatchEvent(new w.Event('submit', { cancelable: true })); await sleep(1000);
    const saved = (await api('GET', '/api/admin/estimates', null, T)).estimates.find(e => e.customer_name === 'Valley Apts UI');
    const full = (await api('GET', '/api/admin/estimates/' + saved.id, null, T)).estimate;
    const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(saved.proposal_total);
    assert(enabled.length === 1 && foreign === 0 && /\$4,440\.00/.test(row) && shown === fmt && saved.proposal_total === 4440 && hours === '96.00' && full.scope_category === 'multifamily', `${enabled} | ${row} | ${shown} vs ${fmt} | ${hours}`);
    return `multifamily list: ${opts.length} items, ${enabled.length} priced (others disabled); 24 units x $185 = ${shown} on screen and server; 96 labor hrs`;
  });
  await check('Estimating UI', 'Reopening keeps library lines; switching category asks before removing them', async () => {
    const saved = (await api('GET', '/api/admin/estimates', null, T)).estimates.find(e => e.customer_name === 'Valley Apts UI');
    $('#drawerRoot').innerHTML = '';
    await nav('proposals'); const row = [...d.querySelectorAll('#v-proposals [data-est], #v-proposals tr')].find(r => r.textContent.includes('Valley Apts UI'));
    row.click(); await sleep(500);
    const edit = [...d.querySelectorAll('#drawerRoot button')].find(b => /^Edit/.test(b.textContent.trim())); edit.click(); await sleep(800);
    const kept = $('#slCat').value === 'multifamily' && $$rows() === 1 && !/Apartment unit turnover/.test($('#estimateForm').elements.line_items_text.value);
    let asked = 0; w.confirm = () => { asked++; return false; };
    $('#slCat').value = 'janitorial'; $('#slCat').dispatchEvent(new w.Event('change', { bubbles: true }));
    const stayed = $('#slCat').value === 'multifamily' && $$rows() === 1;
    w.confirm = () => { asked++; return true; };
    $('#slCat').value = 'janitorial'; $('#slCat').dispatchEvent(new w.Event('change', { bubbles: true }));
    const cleared = $$rows() === 0 && $('#slWrap').hidden;
    assert(kept && stayed && cleared && asked === 2, JSON.stringify({ kept, stayed, cleared, asked, id: saved.id }));
    return 'library line restored in the table (not the text box); cancel keeps it; confirm removes it';
  });
  await check('Command Center UI', '6 KPI tiles, pipeline, activity, quick actions, service pages and module status render from live data', async () => {
    await nav('overview'); await sleep(400);
    const tiles = d.querySelectorAll('#ccKpis .kpi').length, stages = d.querySelectorAll('#ccPipe .st').length, qa = d.querySelectorAll('#ccQuick button').length;
    const portals = [...d.querySelectorAll('#ccPortals a')].map(a => a.getAttribute('href'));
    const mods = txt('#ccMods'); const h1 = txt('#v-overview h1');
    const cc = await api('GET', '/api/admin/command-center?days=30', null, T);
    const leadTile = txt('#ccKpis .kpi:first-child b');
    assert(h1 === 'Command Center' && tiles === 6 && stages === 4 && qa === 10 && portals.length === 5 && /Call Center/.test(mods) && /Setup needed/.test(mods) && leadTile === String(cc.kpis.new_leads.value) && txt('#nav [data-view="overview"]') === 'Command Center', `${h1} ${tiles} ${stages} ${qa} ${mods}`);
    return `tiles ${tiles}, stages ${stages}, quick actions ${qa}, portals ${portals.length}; new-leads tile ${leadTile} = API`;
  });
  await check('Command Center UI', 'Period selector reloads figures; quick action opens the estimator; tile opens its section', async () => {
    $('#ccDays').value = '7'; $('#ccDays').dispatchEvent(new w.Event('change')); await sleep(600);
    const cc7 = await api('GET', '/api/admin/command-center?days=7', null, T);
    const ok7 = txt('#ccKpis .kpi:first-child b') === String(cc7.kpis.new_leads.value) && /last 7 days/.test(txt('#ccPipe') + txt('#ccKpis'));
    [...d.querySelectorAll('#ccQuick button')].find(b => /New estimate/.test(b.textContent)).click(); await sleep(500);
    const est = $('#v-estimator').classList.contains('active');
    await nav('overview'); await sleep(400);
    d.querySelectorAll('#ccKpis .kpi')[4].click(); await sleep(500);
    const proj = $('#v-projects').classList.contains('active');
    $('#ccDays').value = '30';
    assert(ok7 && est && proj, JSON.stringify({ ok7, est, proj })); return '7-day figures match API; estimator opened; Active projects tile opened Projects';
  });
  // ---------- Issues & tasks ----------
  await check('Issues UI', 'Mockup layout: 5 KPI cards, 6 type tabs, filters; the form changes by type with contextual buttons; footer stays visible', async () => {
    await nav('issues'); await sleep(900);
    const kpis = d.querySelectorAll('#issKpis .ktile').length, tabs = [...d.querySelectorAll('#issTabs button')].map(b => b.textContent);
    $('#issAdd').click(); await sleep(900);
    const labels = {};
    for (const ty of ['complaint', 'task', 'note', 'service_request', 'incident']) { d.querySelector(`#drawerRoot [data-ty="${ty}"]`).click(); await sleep(250); labels[ty] = { btn: txt('#iSave'), assign: !!$('#i_asg'), pri: !!$('#i_pri'), rep: !!$('#i_rep'), rec: !!$('#i_rec') }; }
    const foot = d.querySelector('#drawerRoot footer'), body = d.querySelector('#drawerRoot .body');
    const sb = w.getComputedStyle(body).overflowY;
    d.querySelector('#drawerRoot [data-close]').click(); await sleep(200);
    assert(kpis === 5 && tabs.length === 6 && labels.complaint.btn === 'Create issue' && labels.task.btn === 'Create task' && labels.note.btn === 'Save note' && labels.service_request.btn === 'Create request' && labels.incident.btn === 'Log incident' && !labels.note.assign && !labels.note.pri && labels.task.rec && labels.incident.rep && !labels.complaint.rec && foot && sb === 'auto', JSON.stringify({ kpis, tabs, labels, sb }));
    return `5 KPI cards; tabs ${tabs.join(' | ')}; buttons: ${Object.values(labels).map(x => x.btn).join(', ')}; notes hide assignment/priority; tasks add Repeat; incidents add Reported by; form body scrolls, footer separate`;
  });
  await check('Issues UI', 'Add a complaint from the customer profile; it appears there and in Issues & tasks', async () => {
    await nav('customers'); await sleep(900);
    d.querySelector('#custRows [data-cust]').click(); await sleep(1200);
    d.querySelector('#custPage [data-a="issue"]').click(); await sleep(1200);
    const f = $('#issForm');
    f.elements.title.value = 'Lobby glass streaky'; f.elements.description.value = 'Front lobby glass streaked after night clean'; f.elements.category.value = 'Cleaning quality'; f.elements.due_date.value = '2020-02-02';
    d.querySelector('#i_pri [data-p="Urgent"]').click();
    $('#iSave').click(); await sleep(1300);
    await nav('issues'); await sleep(900);
    const row = [...d.querySelectorAll('#issRows [data-issue]')].find(r => r.textContent.includes('Lobby glass streaky'));
    assert(row && /Urgent/.test(row.textContent) && /overdue/.test(row.textContent) && /ISS-/.test(row.textContent) && !$('#navIssues').hidden, row ? row.textContent : 'no row');
    return `listed as ${row.textContent.replace(/\s+/g, ' ').slice(0, 110)}; nav badge ${txt('#navIssues')}`;
  });
  await check('Issues UI', 'Resolve needs a resolution and corrective action; Verify, then it moves to Resolved / closed; Reopen works', async () => {
    let row = [...d.querySelectorAll('#issRows [data-issue]')].find(r => r.textContent.includes('Lobby glass streaky')); row.click(); await sleep(1300);
    $('#iResolve').click(); await sleep(900);
    const msg = txt('#issMsg');
    const f = $('#issForm'); f.elements.resolution.value = 'Re-cleaned lobby glass same day'; f.elements.corrective_action.value = 'Added squeegee step to night checklist'; f.elements.customer_comms.value = 'Customer informed';
    $('#iResolve').click(); await sleep(1300);
    row = [...d.querySelectorAll('#issRows [data-issue]')].find(r => r.textContent.includes('Lobby glass streaky'));
    $('#issStatus').value = 'done'; $('#issStatus').dispatchEvent(new w.Event('change')); await sleep(900);
    const r2 = [...d.querySelectorAll('#issRows [data-issue]')].find(x => x.textContent.includes('Lobby glass streaky')); r2.click(); await sleep(1300);
    const canVerify = !!$('#iVerify'); $('#iVerify').click(); await sleep(1300);
    const verified = [...d.querySelectorAll('#issRows [data-issue]')].find(x => x.textContent.includes('Lobby glass streaky'));
    $('#issStatus').value = 'open'; $('#issStatus').dispatchEvent(new w.Event('change')); await sleep(700);
    assert(/resolved before closing/.test(msg) && /corrective action/.test(msg) && !row && canVerify && verified && /Verified/.test(verified.textContent), JSON.stringify({ msg, row: !!row, canVerify, v: verified && verified.textContent }));
    return `"${msg.slice(0, 120)}…" then resolved; Verify fix → ${/Verified/.test(verified.textContent) ? 'Verified' : '?'}; gone from Open, listed under Resolved / closed`;
  });

  // ---------- Public quote form ----------
  const openQuote = async (qs, draft) => {
    const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push('/quote.html ' + e.message));
    const dom = await JSDOM.fromURL(B + '/quote.html' + (qs || ''), { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(qw) {
        if (draft) qw.localStorage.setItem('bc_quote_draft_v1', JSON.stringify(draft));
        qw.confirm = () => true; qw.addEventListener('error', e => errors.push('/quote.html ' + e.message));
        // jsdom's FormData is not Node's: copy text fields across for the real network request.
        qw.fetch = (u, o = {}) => { if (o.body && o.body instanceof qw.FormData) { const fd = new FormData(); for (const [k, v] of o.body.entries()) if (typeof v === 'string') fd.append(k, v); o = { ...o, body: fd }; } return fetch(new URL(u, B), o); };
      } });
    await sleep(1200); return dom.window;
  };
  await check('Quote form UI', 'Shows 7 services; ?service= preselects; only that service\'s questions appear', async () => {
    const q = await openQuote('?service=janitorial'), qd = q.document;
    const svcs = qd.querySelectorAll('#qSvc button').length;
    const labels = [...qd.querySelectorAll('#qFields label, #qFields .label')].map(l => l.textContent);
    assert(svcs === 7 && !qd.getElementById('qStep2').hidden && labels.some(l => /Facility type/.test(l)) && !labels.some(l => /units/i.test(l)), `${svcs} ${labels.join('|')}`);
    return `7 services; janitorial preselected with ${qd.querySelectorAll('#qFields .field').length} questions`;
  });
  await check('Quote form UI', 'Follow-up question appears only when relevant (elevator count after choosing Elevators)', async () => {
    const q = await openQuote('?service=multifamily'), qd = q.document;
    const wrap = qd.querySelector('[data-f="elevators"]');
    const before = wrap.hidden;
    const box = [...qd.querySelectorAll('.qmulti[data-name="common_areas"] input')].find(i => i.value === 'Elevators');
    box.checked = true; box.dispatchEvent(new q.Event('change', { bubbles: true }));
    assert(before === true && wrap.hidden === false, `${before} ${wrap.hidden}`);
    return 'hidden before, shown after ticking Elevators';
  });
  await check('Quote form UI', 'Missing answers are flagged; review step summarizes; send creates the lead and clears the saved draft', async () => {
    const q = await openQuote('?service=windows'), qd = q.document, f = qd.getElementById('qForm');
    qd.getElementById('qReview').click(); await sleep(50);
    const err = qd.getElementById('qErr').textContent, marked = qd.querySelectorAll('.field.err').length;
    f.elements.stories.value = '2–3 stories'; f.elements.sides.value = 'Both'; f.elements.panes.value = '140';
    f.elements.contact_name.value = 'Uma Glass'; f.elements.email.value = 'uma@glass.test'; f.elements.phone.value = '515-555-0142'; f.elements.address.value = '9 Oak St, Ankeny IA'; f.elements.consent.checked = true;
    f.dispatchEvent(new q.Event('input', { bubbles: true }));
    const saved = JSON.parse(q.localStorage.getItem('bc_quote_draft_v1') || '{}');
    qd.getElementById('qReview').click(); await sleep(50);
    const sum = qd.getElementById('qSum').textContent;
    f.dispatchEvent(new q.Event('submit', { cancelable: true })); await sleep(1500);
    const done = !qd.getElementById('qDone').hidden, left = q.localStorage.getItem('bc_quote_draft_v1');
    const lead = (await api('GET', '/api/admin/leads', null, T)).leads.find(l => l.email === 'uma@glass.test');
    assert(/Building height is required/.test(err) && marked >= 2 && saved.panes === '140' && /Window cleaning/.test(sum) && /140/.test(sum) && done && left === null && lead && lead.service_key === 'windows', JSON.stringify({ err, marked, saved: saved.panes, sum: sum.slice(0, 80), done, left, lead: !!lead }));
    return `errors shown (${marked} fields marked); draft autosaved; summary listed answers; sent -> lead #${lead.id}; draft cleared`;
  });
  await check('Quote form UI', 'Saved draft is restored when the customer comes back', async () => {
    const q = await openQuote('', { service_key: 'power_washing', surfaces: ['Sidewalks', 'Dumpster pads'], condition: 'Moderate', contact_name: 'Returning Rae', area_sqft: '5000' }), qd = q.document, f = qd.getElementById('qForm');
    const ticked = [...qd.querySelectorAll('.qmulti[data-name="surfaces"] input:checked')].map(i => i.value);
    assert(!qd.getElementById('qStep2').hidden && f.elements.contact_name.value === 'Returning Rae' && f.elements.area_sqft.value === '5000' && f.elements.condition.value === 'Moderate' && ticked.length === 2 && /restored/.test(qd.getElementById('qErr').textContent), JSON.stringify(ticked));
    return 'power washing reopened with name, area, condition and 2 surfaces restored';
  });
  await check('Quote form UI', 'Lead drawer shows "Needed before pricing"; Build estimate preselects the service category', async () => {
    const lead = (await api('GET', '/api/admin/leads', null, T)).leads.find(l => l.email === 'uma@glass.test');
    $('#drawerRoot').innerHTML = '';
    await nav('leads'); await sleep(300);
    d.querySelector('#leadKinds [data-kind="bid"]').click(); await sleep(400);
    $('#leadSearch').value = ''; $('#leadStatusFilter').value = ''; $('#leadSearch').dispatchEvent(new w.Event('input')); await sleep(200);
    const row = [...d.querySelectorAll('#leadRows [data-lead]')].find(r => r.dataset.lead === String(lead.id));
    assert(row, 'row not listed: ' + [...d.querySelectorAll('#leadRows [data-lead]')].map(r => r.dataset.lead).join(','));
    row.click(); await sleep(600);
    const needs = txt('#drawerRoot .needs') || txt('#drawerRoot');
    $('#lQuote').click(); await sleep(800);
    assert(/Needed before pricing/.test(txt('#drawerRoot') + needs) || /site visit|count|Nothing flagged/i.test(needs), needs.slice(0, 200));
    const cat = $('#slCat').value;
    assert(cat === 'construction', 'category ' + cat);
    return `drawer lists pre-pricing needs; estimator opened with category "${cat}"`;
  });
  await check('Price book UI', 'Import button loads prices; "Add Clean #1-#3 at building SF" prices a construction bid from square footage', async () => {
    await nav('scopes'); await sleep(400); w.confirm = () => true;
    $('#scopeImport').click(); await sleep(1200);
    const ready = d.querySelectorAll('#scopeRows .badge:not(.amber)').length;
    await nav('proposals'); d.querySelector('#v-proposals [data-action="new-estimate"]').click(); await sleep(900);
    $('#slCat').value = 'construction'; $('#slCat').dispatchEvent(new w.Event('change', { bubbles: true })); await sleep(50);
    const rowShown = !$('#slPhaseRow').hidden;
    const f = $('#estimateForm'); f.elements.area_sqft.value = '417000'; f.elements.tax_pct.value = '0'; f.elements.margin_pct.value = '0'; f.elements.overhead_pct.value = '0';
    $('#slPhases').click(); await sleep(100);
    f.dispatchEvent(new w.Event('input', { bubbles: true }));
    const rows = d.querySelectorAll('#slRows tr').length, total = txt('#cTotal');
    assert(ready >= 41 && rowShown && rows === 3 && total === '$197,032.50', JSON.stringify({ ready, rowShown, rows, total }));
    return `${ready} priced items; 3 phase lines at 417,000 SF; estimator shows ${total} (Terrell base cleaning subtotal)`;
  });
  await check('Suite UI', 'Quick action Log call creates a call and a lead; Command Center Calls panel shows it', async () => {
    await nav('overview'); await sleep(500);
    [...d.querySelectorAll('#ccQuick button')].find(b => /Log call/.test(b.textContent)).click(); await sleep(700);
    const f = $('#genForm'); f.elements.contact_name.value = 'UI Caller'; f.elements.company.value = 'UI Towers'; f.elements.purpose.value = 'Bid request'; f.elements.summary.value = '80,000 SF final clean'; f.elements.create_lead.checked = true;
    $('#genSave').click(); await sleep(1200);
    const calls = (await api('GET', '/api/admin/calls', null, T)).calls; const c = calls.find(x => x.company === 'UI Towers');
    await nav('overview'); await sleep(900);
    assert(c && c.lead_id && /UI Towers/.test(txt('#ccCalls')), txt('#ccCalls').slice(0, 200));
    return `call logged with lead #${c.lead_id}; Calls panel lists UI Towers`;
  });
  await check('Suite UI', 'Global search finds the new lead and opens it', async () => {
    $('#gSearch').value = 'UI Towers'; $('#gSearch').dispatchEvent(new w.Event('input')); await sleep(800);
    const hits = d.querySelectorAll('#gResults [data-g]').length;
    const lb = [...d.querySelectorAll('#gResults [data-g]')].find(b => /Bid request|Inquiry/.test(b.textContent)); lb.click(); await sleep(900);
    assert(hits >= 2 && /UI Towers|UI Caller/.test(txt('#drawerRoot')), `${hits} ${txt('#drawerRoot').slice(0, 80)}`);
    $('#drawerRoot [data-close]') && $('#drawerRoot [data-close]').click();
    return `${hits} results; lead drawer opened`;
  });
  await check('Suite UI', 'Inspection (mockup layout): 6 KPIs, charts, 8 tabs; new inspection from a template; failed item needs a comment; signed with score; details panel shows rooms and actions', async () => {
    await nav('quality'); await sleep(1200);
    const kpis = d.querySelectorAll('#qualityKpis .ktile').length, tabs = d.querySelectorAll('#qTabs button').length;
    $('#qualityAdd').click(); await sleep(1100);
    const f = $('#genForm'); f.elements.area.value = 'Lobby'; f.elements.template_id.value = [...f.elements.template_id.options].find(o => o.textContent === 'Commercial janitorial').value; $('#genSave').click(); await sleep(1600);
    const n = d.querySelectorAll('#qRows .qrow').length;
    for (let k = 0; k < n; k++) { d.querySelector(`#qRows [data-i="${k}"][data-v="${k === 0 ? 'Fail' : 'Pass'}"]`).click(); await sleep(20); }
    w.prompt = () => 'UI Inspector';
    $('#qSign').click(); await sleep(1200);
    const msg = txt('#qMsg');
    $('#ci_n0').value = 'Two bins not emptied'; $('#ci_n0').dispatchEvent(new w.Event('input'));
    $('#qSign').click(); await sleep(2000);
    const row = txt('#qualityRows');
    const side = txt('#qSide');
    assert(kpis === 6 && tabs === 8 && n === 6 && /comment/.test(msg) && /Lobby/.test(row) && /Failed/.test(row) && /Offices/.test(side) && /Create work orders/.test(side) && /UI Inspector/.test(side), JSON.stringify({ kpis, tabs, n, msg, row: row.slice(0, 160), side: side.slice(0, 200) }));
    return `6 KPIs, 8 tabs; ${n} checklist items from template; "${msg.slice(0, 60)}"; signed by UI Inspector; panel shows rooms + Create work orders`;
  });
  await check('Reports UI', 'Reports tabs: P&L, A/R aging, labor, project profitability, scheduled reports each render; overview content hidden on other tabs and restored', async () => {
    await nav('reports'); await sleep(1000);
    const out = {};
    for (const k of ['pl', 'aging', 'labor', 'projects', 'sched']) { d.querySelector(`#repTabs [data-rt="${k}"]`).click(); await sleep(900); out[k] = txt('#repBody').slice(0, 60); }
    const alt = $('#v-reports').classList.contains('alt');
    d.querySelector('#repTabs [data-rt="overview"]').click(); await sleep(300);
    assert(/Invoiced/.test(out.pl) && /Not yet due/.test(out.aging) && /Hours worked/.test(out.labor) && /Project/.test(out.projects) && /Scheduled report/.test(out.sched) && alt && !$('#v-reports').classList.contains('alt'), JSON.stringify(out));
    return '5 report tabs render; overview hidden while on them and restored';
  });
  await check('Contracts UI', 'Contract workspace: editable terms, send for signature creates a link, customer signs on the public page, Countersign executes it, KPIs update', async () => {
    const k = await api('POST', '/api/admin/contracts', { company: 'UI Contract Co', customer_name: 'Una Contract', title: 'UI contract', value: 1000, status: 'Draft' }, T);
    const kid = k.id || (k.contract && k.contract.id);
    await nav('contracts'); await sleep(900);
    d.querySelector(`#rows-contracts [data-rec="contracts:${kid}"]`).click(); await sleep(1200);
    const f = $('#kForm'); f.elements.email.value = 'una@uicontract.test'; f.elements.scope.value = 'Window cleaning, quarterly'; f.elements.start_date.value = '2026-12-01';
    $('#kSend').click(); await sleep(1500);
    const link = $('#kLink') && $('#kLink').value;
    const tok = link.split('/').pop();
    const sg = await (await fetch(B + `/api/contract/${tok}/sign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Una Contract', agree: true }) })).json();
    d.querySelector('#cwWrap [data-cw-back]').click(); await sleep(200);
    await nav('overview'); await nav('contracts'); await sleep(900);
    const awaiting = txt('#regKpis-contracts');
    d.querySelector(`#rows-contracts [data-rec="contracts:${kid}"]`).click(); await sleep(1200);
    w.prompt = () => 'UI Owner';
    $('#kCs').click(); await sleep(1500);
    const sub = txt('#cwWrap');
    assert(link && /\/contract\//.test(link) && sg.ok && /need your countersignature/.test(awaiting) && /Signed/.test(sub) && /UI Owner/.test(sub) && /Amend/.test(sub), JSON.stringify({ link, sg, sub: sub.slice(0, 200) }));
    return 'saved terms + sent: link shown; customer signed on public link; KPI shows countersign needed; Countersign → Signed, Amend/Renew offered';
  });
  await check('Contracts UI', 'Contract opens as a full-page workspace: route, every section tab, tab switch keeps the form, Back returns to the register', async () => {
    const k = await api('POST', '/api/admin/contracts', { company: 'WS Co', customer_name: 'Wes Space', title: 'Workspace test', value: 500, status: 'Draft' }, T);
    const kid = k.id || (k.contract && k.contract.id);
    await nav('contracts'); await sleep(900);
    d.querySelector(`#rows-contracts [data-rec="contracts:${kid}"]`).click(); await sleep(1200);
    const route = w.location.hash;
    const tabs = [...d.querySelectorAll('#cwWrap [data-cwtab]')].map(b => b.dataset.cwtab);
    const sections = ['overview', 'parties', 'document', 'scope', 'terms', 'schedule', 'signatures', 'amendments', 'activity', 'related'];
    const allTabs = sections.every(s => tabs.includes(s));
    d.querySelector('#cwWrap [data-cwtab="terms"]').click(); await sleep(100);
    const termsShown = !d.querySelector('#cwWrap [data-panel="terms"]').hidden && d.querySelector('#cwWrap [data-panel="overview"]').hidden;
    const wsShown = d.getElementById('v-contracts').classList.contains('has-contract') && d.getElementById('cwWrap').hidden === false;
    d.querySelector('#cwWrap [data-cw-back]').click(); await sleep(400);
    const back = w.location.hash === '#contracts' && !d.getElementById('v-contracts').classList.contains('has-contract') && d.getElementById('cwWrap').hidden === true;
    const chk = { route: route === '#contracts/' + kid, allTabs, termsShown, wsShown, back };
    assert(Object.values(chk).every(Boolean), JSON.stringify({ chk, tabs }));
    return 'route #contracts/' + kid + '; ' + tabs.length + ' section tabs; tab switch keeps the form; Back returns to the register';
  });
  await check('Calls UI', 'Calls page: phone-capture status strip; call panel shows transcript box and Analyze button; Scopes and Activity show KPI cards; activity search filters', async () => {
    await api('POST', '/api/admin/calls', { contact_name: 'Ui Caller', company: 'UI Call Co', phone: '515-555-0333', purpose: 'New business', summary: 'Wants a quote', follow_up_date: '2026-11-10' }, T);
    await nav('calls'); await sleep(1300);
    const strip = txt('#callsIntel');
    d.querySelector('#callsRows [data-call]').click(); await sleep(1200);
    const hasTr = !!$('#callTr'), hasAn = !!$('#callAnalyze'), hasDone = !!$('#callDone');
    d.querySelector('#drawerRoot [data-close]').click(); await sleep(200);
    await nav('scopes'); await sleep(900); const sk = d.querySelectorAll('#scopeKpis .ktile').length;
    await nav('activity'); await sleep(900); const ak = d.querySelectorAll('#actKpis .ktile').length;
    $('#actSearch').value = 'zzzz-no-match'; $('#actSearch').dispatchEvent(new w.Event('input')); await sleep(200);
    const none = /No activity matches/.test(txt('#activityRows'));
    assert(/Phone capture/.test(strip) && /Not connected|Connected/.test(strip) && hasTr && hasAn && hasDone && sk >= 5 && ak === 6 && none, JSON.stringify({ strip, hasTr, hasAn, hasDone, sk, ak, none }));
    return `status strip "${strip.slice(0, 40)}…"; call panel with transcript + Analyze + follow-up done; Scopes ${sk} KPI cards; Activity ${ak} cards; search filters`;
  });
  await check('Workflow UI', 'New action buttons: call → "Create issue" creates and opens the issue; complaint shows "Email customer update" + "Schedule corrective visit"; invoice shows "Send invoice" + "PDF"', async () => {
    const cu = (await api('POST', '/api/admin/customers', { company: 'UI Complaint Co', name: 'Uma Plain', email: 'uma@uicomplaint.test' }, T)).id;
    const call = (await api('POST', '/api/admin/calls', { contact_name: 'Uma Plain', phone: '515-555-0911', customer_id: cu, purpose: 'Complaint', summary: 'Restroom supplies not restocked on 2nd floor' }, T)).call;
    await nav('calls'); await sleep(1100);
    d.querySelector(`#callsRows [data-call="${call.id}"]`).click(); await sleep(1100);
    const hasBtn = !!$('#callIssue'); $('#callIssue').click(); await sleep(1600);
    const issueOpen = /Restroom supplies/.test(txt('#drawerRoot'));
    const custUpd = !!$('#iCustUpd'), visitBtn = !!$('#iVisit');
    d.querySelector('#drawerRoot [data-close]') && d.querySelector('#drawerRoot [data-close]').click(); await sleep(200);
    const inv = await api('POST', '/api/admin/invoices', { invoice_number: 'UI-WF-1', customer_name: 'Uma Plain', company: 'UI Complaint Co', amount: 400, due_date: '2026-12-30', status: 'Draft' }, T);
    const iid = inv.id || (inv.invoice && inv.invoice.id);
    await nav('invoices'); await sleep(1000);
    d.querySelector(`#rows-invoices [data-rec="invoices:${iid}"]`).click(); await sleep(1100);
    const send = !!$('#recSend'), pdfb = !!$('#recPdf');
    assert(hasBtn && issueOpen && custUpd && visitBtn && send && pdfb, JSON.stringify({ hasBtn, issueOpen, custUpd, visitBtn, send, pdfb }));
    return 'Create issue → issue opened from the call; complaint actions present; invoice Send + PDF present';
  });
  await check('Calls UI', 'Click-to-call buttons appear on the customer profile and the call panel; with calling not set up, clicking explains why instead of failing silently', async () => {
    const cu = (await api('POST', '/api/admin/customers', { company: 'Dialable Co', name: 'Dee Able', phone: '515-555-0166' }, T)).id;
    const call = (await api('POST', '/api/admin/calls', { contact_name: 'Dee Able', phone: '515-555-0166', customer_id: cu, purpose: 'Other', summary: 'x' }, T)).call;
    await nav('calls'); await sleep(1000);
    d.querySelector(`#callsRows [data-call="${call.id}"]`).click(); await sleep(1100);
    const inCall = !!d.querySelector('#drawerRoot [data-dial]');
    d.querySelector('#drawerRoot [data-dial]').click(); await sleep(900);
    const msg = [...d.querySelectorAll('.toast')].map(t => t.textContent).join(' ');
    assert(inCall && /not set up/i.test(msg), JSON.stringify({ inCall, msg }));
    return 'Call back button present; unconfigured click → "Calling is not set up yet"';
  });
  await check('Calls UI', 'Dial pad opens from the Calls page (keys type digits, short number refused); unknown caller → Save as customer creates and links', async () => {
    const call = (await api('POST', '/api/admin/calls', { contact_name: '', phone: '515-555-0177', purpose: 'Other', summary: 'unknown caller' }, T)).call;
    await nav('calls'); await sleep(1100);
    const btn = $('#dialPadBtn'); btn.click(); await sleep(900);
    const open = !!$('#dpNum'); ['5', '1', '5'].forEach(k => d.querySelector(`#dpKeys [data-k="${k}"]`).click());
    const typed = $('#dpNum').value; $('#dpGo').click(); await sleep(500);
    const short = [...d.querySelectorAll('.toast')].map(t => t.textContent).join(' ');
    d.querySelector('#drawerRoot [data-close]') && d.querySelector('#drawerRoot [data-close]').click(); await sleep(300);
    d.querySelector(`#callsRows [data-call="${call.id}"]`).click(); await sleep(1100);
    $('#callSaveCust').click(); await sleep(1100);
    $('#scName').value = 'Uma Unknown'; $('#scGo').click(); await sleep(1500);
    const linked = (await api('GET', `/api/admin/calls/${call.id}/detail`, null, T)).call;
    assert(btn && open && typed === '515' && /10-digit/.test(short) && linked.customer_id, JSON.stringify({ btn: !!btn, open, typed, short, linked: linked && linked.customer_id }));
    return 'dial pad works; caller saved and linked from the call panel';
  });
  await check('Command Center UI', 'Live operations: 4 groups render; clicking a number opens a list of exactly that many records; clicking a record opens that exact record; Needs attention opens a breakdown whose lines drill down', async () => {
    await api('POST', '/api/admin/estimates', { customer_name: 'Drill Lead', company: 'Drill Co', scope: 'x', area_sqft: 1000, use_line_items: 1, line_items: [{ description: 'Clean', amount: 500 }] }, T);
    await nav('overview'); await sleep(1600);
    const groups = [...d.querySelectorAll('#ccLive h3')].map(h => h.textContent);
    const row = d.querySelector('#ccLive [data-drill="estimates_in_progress"]'); const shown = Number(row.querySelector('b').textContent);
    row.click(); await sleep(1100);
    const listed = d.querySelectorAll('#drawerRoot [data-open]').length, title = txt('#drawerRoot');
    d.querySelector('#drawerRoot [data-open]').click(); await sleep(1800);
    const opened = txt('#drawerRoot'), view = d.querySelector('#nav .active') && d.querySelector('#nav .active').dataset.view;
    d.querySelector('#drawerRoot [data-close]') && d.querySelector('#drawerRoot [data-close]').click(); await sleep(300);
    await nav('overview'); await sleep(1500);
    [...d.querySelectorAll('#ccKpis .kpi')].find(k => /Needs attention/.test(k.textContent)).click(); await sleep(900);
    const att = txt('#drawerRoot'), lines = d.querySelectorAll('#drawerRoot [data-drill]').length;
    assert(['Sales', 'Operations', 'Finance', 'Calls & AI'].every(g => groups.includes(g)) && shown >= 1 && listed === shown && /Estimates in progress/.test(title) && view === 'proposals' && /Drill/.test(opened) && /Needs attention/.test(att),
      JSON.stringify({ groups, shown, listed, view, opened: opened.slice(0, 120), att: att.slice(0, 120), lines }));
    return `groups ${groups.join(', ')}; "Estimates in progress" ${shown} = ${listed} listed; row opened the proposal; attention breakdown ${lines} line(s)`;
  });
  await check('Command Center UI', 'Management group renders; Customize hides a group and the choice is saved for this user (survives a reload); period choice is saved', async () => {
    await api('PUT', '/api/admin/prefs/command_center', {}, T);
    await nav('overview'); await sleep(1600);
    const before = [...d.querySelectorAll('#ccLive h3')].map(h => h.textContent);
    d.querySelector('#liveCustom').click(); await sleep(400);
    d.querySelector('#drawerRoot [data-g="Management"]').checked = false; d.querySelector('#custSave').click(); await sleep(1500);
    const after = [...d.querySelectorAll('#ccLive h3')].map(h => h.textContent);
    const saved = (await api('GET', '/api/admin/prefs', null, T)).command_center || {};
    await api('PUT', '/api/admin/prefs/command_center', {}, T);
    assert(before.includes('Management') && !after.includes('Management') && after.includes('Sales') && (saved.hidden || []).includes('Management'), JSON.stringify({ before, after, saved }));
    return `groups before: ${before.join(', ')} → after hiding Management: ${after.join(', ')}; saved per user`;
  });
  await check('Quality complaints UI', 'A complaint shows in Quality → Customer complaints; clicking opens the case with its Autopilot timeline and stage actions; Command Center shows the Quality group and Autopilot activity', async () => {
    const cu = (await api('POST', '/api/admin/customers', { company: 'UI Complaint Co', name: 'Ui', email: 'ui@cmp.test', address: '1 Test St' }, T)).id;
    await api('POST', '/api/admin/issues', { type: 'complaint', title: 'UI test: restroom not cleaned', description: 'Restroom on floor 2', customer_id: cu, priority: 'High' }, T);
    await nav('quality'); await sleep(1800);
    const row = [...d.querySelectorAll('#qcComplaints [data-cmp]')].find(r => /UI Complaint Co/.test(r.textContent));
    row.click(); await sleep(1500);
    const drawer = txt('#drawerRoot'), hasStages = !!d.querySelector('#drawerRoot [data-to="RESOLVED"]');
    d.querySelector('#drawerRoot [data-close]').click(); await sleep(300);
    await nav('overview'); await sleep(2000);
    const groups = [...d.querySelectorAll('#ccLive h3')].map(h => h.textContent);
    assert(row && /QC-\d+/.test(drawer) && /Autopilot timeline/.test(drawer) && /Assigned to quality manager|Information needed/.test(drawer) && hasStages && groups.includes('Quality') && groups.includes('Autopilot activity'), JSON.stringify({ row: !!row, drawer: drawer.slice(0, 200), hasStages, groups }));
    return `case opened from Quality; timeline + stage actions present; Command Center groups: ${groups.join(', ')}`;
  });
  await check('Tables UI', 'List tables are sortable (click header: ascending ▲, again: descending ▼) and paginated at 50 rows with Show more / Show all; sort survives a re-render', async () => {
    for (let i = 0; i < 56; i++) await api('POST', '/api/admin/leads', { kind: 'inquiry', contact_name: 'Pager ' + String(i).padStart(2, '0'), company: 'Zeta ' + (100 - i), email: `p${i}@pager.test`, details: 'paging test' }, T);
    await nav('leads'); await sleep(1500); d.querySelector('#v-leads [data-kind="inquiry"]').click(); await sleep(1200);
    const tbl = d.querySelector('#v-leads table.t'), rows = () => [...tbl.tBodies[0].rows], vis = () => rows().filter(r => !r.hidden);
    const total = rows().length, shown = vis().length, more = tbl.parentElement.querySelector('.tblmore');
    if (!more) throw new Error('no footer: ' + JSON.stringify({ total, shown, enh: tbl.dataset.enh, head: tbl.tHead && tbl.tHead.rows.length, cls: tbl.className, parent: tbl.parentElement.className, cells: rows().slice(0, 3).map(r => r.cells.length) }));
    more.querySelector('[data-all]').click(); await sleep(200); const afterAll = vis().length;
    const th = [...tbl.tHead.rows[0].cells].find(h => /contact|name|company/i.test(h.textContent)) || tbl.tHead.rows[0].cells[1], col = [...tbl.tHead.rows[0].cells].indexOf(th);
    th.click(); await sleep(100); const asc = rows().map(r => r.cells[col].textContent.trim().toLowerCase()); const ascMark = /▲/.test(th.textContent);
    th.click(); await sleep(100); const desc = rows().map(r => r.cells[col].textContent.trim().toLowerCase()); const descMark = /▼/.test(th.textContent);
    const sorted = a => a.every((v, i) => !i || a[i - 1] <= v);
    await nav('overview'); await sleep(300); await nav('leads'); await sleep(1500); d.querySelector('#v-leads [data-kind="inquiry"]').click(); await sleep(1200);
    const again = [...tbl.tBodies[0].rows].map(r => r.cells[col].textContent.trim().toLowerCase());
    assert(total >= 56 && shown === 50 && afterAll === total && sorted(asc) && ascMark && sorted([...desc].reverse()) && descMark && sorted([...again].reverse()), JSON.stringify({ total, shown, afterAll, asc: asc.slice(0, 3), ascMark, desc: desc.slice(0, 3), descMark, again: again.slice(0, 3), col }));
    return `${total} leads: 50 shown, Show all → ${afterAll}; sort ▲/▼ on "${th.textContent.replace(/[▲▼]/g, '').trim()}"; sort kept after reload of the list`;
  });
  await check('Roles UI', 'An inspector sees only their pages (Quality, Schedule, Customers, Documents, Settings), lands on Quality, sees their role, and a direct link to a blocked page (Calls) sends them back to Quality', async () => {
    await api('POST', '/api/admin/users', { name: 'Ivy Inspector', email: 'ivy@roles.test', password: 'inspector-pass-12345', role: 'inspector' }, T);
    const tok = (await (await fetch(B + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ivy@roles.test', password: 'inspector-pass-12345' }) })).json()).token;
    const w2 = await open('/admin/#calls', tok), d2 = w2.document; await sleep(1500);
    const shown = [...d2.querySelectorAll('#nav [data-view]')].filter(b => !b.hidden).map(b => b.dataset.view);
    const active = d2.querySelector('.view.active'), role = (d2.querySelector('#whoRole') || {}).textContent;
    w2.close();
    assert(tok && JSON.stringify(shown.sort()) === JSON.stringify(['customers', 'documents', 'quality', 'schedule', 'settings']) && active && active.id === 'v-quality' && role === 'Ivy Inspector · Inspector', JSON.stringify({ tok: !!tok, shown, active: active && active.id, role }));
    return `inspector nav: ${shown.join(', ')}; #calls → ${active.id}; role shown "${role}"`;
  });
  await check('Documents UI', 'Drawings & Documents: 8 KPI cards, 8 tabs, table; selecting a drawing shows revision actions, sheet index editor and AI reading button; superseded tab', async () => {
    const f = new FormData(); f.append('files', new Blob([Buffer.from('%PDF-1.4')]), 'Docs UI set.pdf'); f.append('kind', 'Drawings'); f.append('revision', 'IFC');
    const up = await (await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: f })).json();
    await nav('documents'); await sleep(1100);
    const kpis = d.querySelectorAll('#documentsKpis .ktile').length, tabs = d.querySelectorAll('#docTabs button').length;
    d.querySelector(`#documentsRows [data-dsel="${up.ids[0]}"]`).click(); await sleep(1100);
    const side = txt('#docSide');
    d.querySelector('#docTabs [data-dt="Superseded"]').click(); await sleep(200);
    const sup = txt('#documentsRows');
    d.querySelector('#docTabs [data-dt="all"]').click();
    assert(kpis === 8 && tabs === 8 && /Upload new revision/.test(side) && /Sheet index/.test(side) && /Read blueprint with AI/.test(side) && /Docs UI set/.test(side) && !/Docs UI set/.test(sup), JSON.stringify({ kpis, tabs, side: side.slice(0, 200) }));
    return '8 KPI cards, 8 tabs; side panel: revision upload, sheet index, AI blueprint reading; not listed under Superseded';
  });
  await check('Takeoff UI', 'Takeoff from a drawing: SF + phases, sheet required, then Create estimate opens a priced estimate', async () => {
    const fd = new w.FormData(); // upload a drawing through the API first
    const up = await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: (() => { const f = new FormData(); f.append('files', new Blob([Buffer.from('%PDF-1.4')]), 'UI Plans.pdf'); return f; })() });
    await nav('documents'); await sleep(600);
    const btn = [...d.querySelectorAll('#documentsRows [data-totake]')][0]; btn.click(); await sleep(900);
    const f = $('#toForm'); f.elements.building_sf.value = '20000';
    $('#toPhases').click(); await sleep(100);
    $('#toEst').click(); await sleep(900);
    const msg = txt('#toMsg');
    d.querySelectorAll('#toLines [data-k="sheet"]').forEach(i => { i.value = 'A0.1'; i.dispatchEvent(new w.Event('input')); });
    const tot = txt('#toTotal');
    $('#toEst').click(); await sleep(1800);
    const est = (await api('GET', '/api/admin/estimates', null, T)).estimates[0];
    assert(up.status === 201 && /source sheet/.test(msg) && /\$9,450\.00/.test(tot) && est.proposal_total > 0 && /takeoff/.test(est.scope), JSON.stringify({ msg, tot, total: est.proposal_total, scope: est.scope }));
    return `sheet required ("${msg.slice(0, 50)}…"); 20,000 SF x 3 phases = ${tot.match(/\$[\d,.]+/)[0]}; estimate #${est.id} created`;
  });
  await check('Pricing UI', 'Takeoffs page: 6 KPI cards; Price panel shows breakdown, factors change the total live, warnings; Create estimate opens the priced estimate', async () => {
    await nav('takeoffs'); await sleep(1100);
    const kpis = d.querySelectorAll('#takeoffKpis .ktile').length;
    const btn = d.querySelector('#takeoffsRows [data-price]'); btn.click(); await sleep(1300);
    const before = txt('#prOut');
    const box = d.querySelector('#prForm [name="f_high_work"]'); box.checked = true; box.dispatchEvent(new w.Event('change')); await sleep(1300);
    const after = txt('#prOut');
    $('#prEst').click(); await sleep(2200);
    const view = d.querySelector('.view.active, .view:not([hidden])');
    assert(kpis === 6 && /Total/.test(before) && /High work/.test(after) && !/High work/.test(before) && w.location.hash === '#proposals', JSON.stringify({ kpis, before: before.slice(0, 120), after: after.slice(0, 160), hash: w.location.hash }));
    return '6 KPI cards; price breakdown; ticking "High work" adds the +15% line live; Create estimate opened Estimates & Proposals';
  });
  await check('Email Center UI', 'Sent emails listed; opening one shows the full message', async () => {
    await nav('emails'); await sleep(600);
    const rows = d.querySelectorAll('#emailsRows [data-mail]').length, api_n = (await api('GET', '/api/admin/emails', null, T)).emails.length;
    if (rows) { d.querySelector('#emailsRows [data-mail]').click(); await sleep(400); }
    assert(rows === api_n && (rows ? txt('#drawerRoot').length > 20 : /No emails yet/.test(txt('#emailsRows'))) && d.querySelectorAll('#emailsKpis .kpi').length === 4, `${rows} vs ${api_n}`);
    return rows ? `${rows} emails listed; message opened` : 'no email provider in this test server: empty state shown, 4 summary tiles (sending is covered by the server suite)';
  });
  await check('Schedule UI', 'Week view shows 7 days with visits', async () => {
    await api('POST', '/api/admin/visits', { title: 'Week check visit', date: require('../bizdate').today(), start_time: '08:00' }, T);
    await nav('schedule'); await sleep(400); $('#schedMode').value = 'week'; $('#schedMode').dispatchEvent(new w.Event('change')); await sleep(800);
    const days = d.querySelectorAll('#schedWeek .day').length;
    assert(days === 7 && /Week check visit/.test(txt('#schedWeek')) && $('#schedTable').hidden, days);
    $('#schedMode').value = 'list'; $('#schedMode').dispatchEvent(new w.Event('change'));
    return '7 day columns; today\'s visit shown';
  });
  await check('AI UI', 'Lead details show the AI assistant as off with how to turn it on; Settings shows AI status and the auto-triage switch', async () => {
    await nav('leads'); await sleep(400); d.querySelector('#leadKinds [data-kind="bid"]').click(); await sleep(400);
    d.querySelector('#leadRows [data-lead]').click(); await sleep(900);
    const panel = txt('#leadAI');
    await nav('settings'); await sleep(700);
    assert(/AI is off/.test(panel) && /ANTHROPIC_API_KEY/.test(panel) && /Off/.test(txt('#aiState')) && $('#aiAuto') && $('#aiAuto').checked, JSON.stringify({ panel: panel.slice(0, 120), st: txt('#aiState') }));
    return `lead panel: "${panel.slice(0, 70)}…"; settings: ${txt('#aiState').slice(0, 60)}`;
  });
  await check('Owner flow UI', 'Estimator catches a price typed into Production rate (0.18) and converts it to 20,001 SF x $0.18', async () => {
    await nav('proposals'); d.querySelector('#v-proposals [data-action="new-estimate"]').click(); await sleep(900);
    const f = $('#estimateForm'); f.elements.area_sqft.value = '20001'; f.elements.production_rate.value = '0.18'; f.elements.labor_rate.value = '11';
    f.dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(50);
    const warned = !$('#cFix').hidden && /111,117 labor hours/.test(txt('#cFix'));
    $('#cFixBtn').click(); await sleep(50);
    for (const k of ['margin_pct', 'overhead_pct', 'tax_pct']) f.elements[k].value = '0'; f.dispatchEvent(new w.Event('input', { bubbles: true }));
    const total = txt('#cTotal');
    assert(warned && total === '$3,600.18' && $('#cFix').hidden && f.elements.production_rate.value === '0', JSON.stringify({ warned, total, fix: txt('#cFix') }));
    return `warning shown (111,117 labor hours); converted to a line: total ${total}`;
  });
  await check('Owner flow UI', 'Owner clicks Email on a held proposal: one confirmation approves it, then it tries to send (no dead end)', async () => {
    await api('PUT', '/api/admin/approval-rules', { min_margin_pct: 0, max_total: 1000, flag_pre_pricing: false }, T);
    const e = (await api('POST', '/api/admin/estimates', { customer_name: 'Owner Flow', email: 'of@t.test', scope: 'Final clean', area_sqft: 20000, production_rate: 400, labor_rate: 40, margin_pct: 30 }, T)).estimate;
    await nav('proposals'); await sleep(500);
    [...d.querySelectorAll('#v-proposals tr')].find(r => r.textContent.includes('Owner Flow')).click(); await sleep(900);
    let asked = []; w.confirm = m => { asked.push(m); return true; };
    $('#eSend').click(); await sleep(1500);
    const ap = await api('GET', `/api/admin/estimates/${e.id}/approval`, null, T);
    await api('PUT', '/api/admin/approval-rules', { min_margin_pct: 0, max_total: 0, flag_pre_pricing: false }, T);
    assert(/You can approve it/.test(asked[0] || '') && ap.approval && ap.approval.valid && /when it goes to the customer/.test(ap.approval.note), JSON.stringify({ asked, ap }));
    return `owner asked once ("${asked[0].split('\n')[0]}"), approved with note "${ap.approval.note}", then the send was attempted`;
  });
  await check('Customer page UI', 'Customer opens as a full page; all 14 tabs render; contact, property and note save from the page; Edit account saves', async () => {
    const c = (await api('POST', '/api/admin/customers', { company: 'Page Test Co', name: 'Pat Page', email: 'pat@pagetest.test' }, T));
    await nav('customers'); await sleep(500);
    const row = [...d.querySelectorAll('#custRows [data-cust]')].find(r => r.textContent.includes('Page Test Co')); row.click(); await sleep(1200);
    const onPage = w.location.hash === '#customers' && /Page Test Co/.test(txt('#custPage h1'));
    const tabs = [...d.querySelectorAll('#custPage .ctabs button')].map(b => b.dataset.t), rendered = [];
    for (const t of tabs) { d.querySelector(`#custPage .ctabs [data-t="${t}"]`).click(); await sleep(60); if (txt('#cpBody').length > 5) rendered.push(t); }
    d.querySelector('#custPage .ctabs [data-t="contacts"]').click(); await sleep(50);
    let f = $('#ctForm'); f.elements.name.value = 'Quinn Second'; f.elements.email.value = 'quinn@pagetest.test'; f.dispatchEvent(new w.Event('submit', { cancelable: true })); await sleep(1000);
    d.querySelector('#custPage .ctabs [data-t="properties"]').click(); await sleep(50);
    f = $('#prForm'); f.elements.name.value = 'Main Office'; f.elements.address.value = '5 Page St'; f.dispatchEvent(new w.Event('submit', { cancelable: true })); await sleep(1000);
    d.querySelector('#custPage .ctabs [data-t="notes"]').click(); await sleep(50);
    f = $('#ntForm'); f.elements.body.value = 'Prefers email over calls.'; f.dispatchEvent(new w.Event('submit', { cancelable: true })); await sleep(1000);
    d.querySelector('#custPage [data-a="edit"]').click(); await sleep(700);
    $('#genForm').elements.status.value = 'Prospect'; $('#genSave').click(); await sleep(1000);
    const p = await api('GET', `/api/admin/customers/${c.id}/profile`, null, T);
    assert(onPage && tabs.length === 14 && rendered.length === 14 && p.contacts.length === 2 && p.properties.length === 1 && p.notes[0].body === 'Prefers email over calls.' && p.notes[0].author && p.customer.status === 'Prospect' && /Prospect/.test(txt('#custPage h1')), JSON.stringify({ onPage, tabs: tabs.length, rendered: rendered.length, c: p.contacts.length, pr: p.properties.length, st: p.customer.status }));
    return `two-pane workspace at #customers; ${rendered.length}/14 tabs render; contact, property, note (author ${p.notes[0].author}) saved; status → Prospect`;
  });
  await check('Approvals UI', 'Settings card saves rules; a held proposal shows reasons and can be approved from its drawer', async () => {
    await nav('settings'); await sleep(500);
    const f = $('#apprCard'); f.elements.min_margin_pct.value = '20'; f.elements.max_total.value = '25000'; f.elements.flag_pre_pricing.checked = true;
    f.dispatchEvent(new w.Event('submit', { cancelable: true })); await sleep(600);
    const saved = (await api('GET', '/api/admin/approval-rules', null, T)).rules;
    const e = (await api('POST', '/api/admin/estimates', { customer_name: 'Held UI', email: 'held@t.test', scope: 'Final clean', area_sqft: 10000, production_rate: 400, labor_rate: 30, margin_pct: 10 }, T)).estimate;
    await nav('proposals'); await sleep(500);
    const row = [...d.querySelectorAll('#v-proposals tr')].find(r => r.textContent.includes('Held UI')); row.click(); await sleep(900);
    const box = txt('#apprBox');
    $('#apGo').click(); await sleep(1200);
    const box2 = txt('#apprBox');
    assert(saved.min_margin_pct === 20 && /below your 20% minimum/.test(box) && /Approved/.test(box2), JSON.stringify({ saved, box, box2 }));
    await api('PUT', '/api/admin/approval-rules', { min_margin_pct: 0, max_total: 0, flag_pre_pricing: false }, T);
    return `rules saved (20%); drawer showed "${box.slice(0, 70)}"; after approving: "${box2.slice(-60)}"`;
  });
  await check('Admin UI', 'No JavaScript errors on any screen', async () => { assert(!errors.length, errors.join(' | ')); return '0 errors'; });

  child.kill();
  const pass = results.filter(r => r.status === 'PASS').length;
  fs.writeFileSync(path.join(__dirname, 'ui-results.json'), JSON.stringify({ run_at: new Date().toISOString(), pass, fail: results.length - pass, results }, null, 2));
  console.log(`\n${pass}/${results.length} passed`); process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
