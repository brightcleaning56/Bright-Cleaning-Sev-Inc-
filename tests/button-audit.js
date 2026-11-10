process.env.TZ = process.env.BUSINESS_TZ || 'America/Chicago';
/* Directive Part 4 — button & action inventory.
 * Opens every admin page in jsdom against a real server with seeded records, clicks EVERY visible button on a
 * freshly loaded page, and records the measurable effect. Then opens the first record on each page and clicks
 * every button in that drawer. Writes tests/button-inventory.json.  Run: node tests/button-audit.js
 */
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const PORT = 4300 + Math.floor(Math.random() * 50), B = `http://127.0.0.1:${PORT}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-btn-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VIEWS = ['overview', 'leads', 'customers', 'issues', 'calls', 'emails', 'proposals', 'contracts', 'projects', 'invoices', 'schedule', 'quality', 'documents', 'takeoffs', 'reports', 'scopes', 'activity', 'settings'];

(async () => {
  const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(40).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 10), DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'up'), AUTOBID_SWEEP_MS: '3600000' };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
  const api = async (m, u, j, t) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return r.json().catch(() => ({})); };
  const signIn = require('./mfa-helper')((p, b, t) => api('POST', p, b, t).then(res => ({ data: res })));
  const T = await signIn(OWNER, PW);
  await api('PUT', '/api/admin/approval-rules', { min_margin_pct: 0, max_total: 0, flag_pre_pricing: false, approve_all: false }, T);
  // ---- seed one realistic record on every page ----
  const cu = (await api('POST', '/api/admin/customers', { company: 'Seed Co', name: 'Sam Seed', email: 'sam@seed.test', phone: '515-555-0100' }, T)).id;
  const fd = new FormData(); Object.entries({ contact_name: 'Lea Lead', company: 'Lead Co', email: 'lea@lead.test', phone: '515-555-0101', project_type: 'Office', service: 'Final clean', address: '1 Main', details: 'x', consent: 'on' }).forEach(([k, v]) => fd.append(k, v));
  await fetch(B + '/api/bids', { method: 'POST', body: fd });
  await api('POST', '/api/admin/issues', { type: 'complaint', title: 'Seed complaint', customer_id: cu, priority: 'Normal', customer_comms: 'Needs update' }, T);
  await api('POST', '/api/admin/calls', { contact_name: 'Sam Seed', phone: '515-555-0100', customer_id: cu, purpose: 'Complaint', summary: 'Seed call' }, T);
  const e = (await api('POST', '/api/admin/estimates', { customer_name: 'Sam Seed', company: 'Seed Co', email: 'sam@seed.test', scope: 'Final clean', area_sqft: 10000, use_line_items: 1, line_items: [{ description: 'Clean', amount: 3000 }] }, T)).estimate;
  await api('PATCH', '/api/admin/estimates/' + e.id, { status: 'Sent' }, T);
  await api('POST', `/api/proposal/${e.public_token}/respond`, { decision: 'approve', signer_name: 'Sam Seed', signer_title: 'Owner', agree: true });
  await sleep(300);
  const pj = ((await api('GET', '/api/admin/projects', null, T)).projects || [])[0];
  await api('POST', '/api/admin/invoices', { invoice_number: 'SEED-1', project_id: pj && pj.id, customer_name: 'Sam Seed', company: 'Seed Co', amount: 1500, due_date: '2026-12-31', status: 'Draft' }, T);
  await api('POST', '/api/admin/employees', { name: 'Crew Seed', email: 'crew@seed.test', role: 'Lead', crew: 'A', hourly_rate: 20, max_week_hours: 40 }, T);
  await api('POST', '/api/admin/visits', { title: 'Seed visit', date: require('../bizdate').today(), customer_id: cu }, T);
  const tpl = ((await api('GET', '/api/admin/qc/templates', null, T)).templates || [])[0];
  if (tpl) await api('POST', '/api/admin/qc/inspections', { template_id: tpl.id, area: 'Lobby', date: require('../bizdate').today(), customer_id: cu, crew: 'A' }, T);
  const up = new FormData(); up.append('files', new Blob([Buffer.from('%PDF-1.4\n%seed\n%%EOF')], { type: 'application/pdf' }), 'seed.pdf'); up.append('kind', 'Drawings'); up.append('customer_id', String(cu));
  await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: up });

  const inventory = [];
  async function load(view) {
    const errors = [], calls = [];
    const vc = new VirtualConsole(); vc.on('jsdomError', er => errors.push(er.message));
    const dom = await JSDOM.fromURL(B + '/admin/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(w) { w.localStorage.setItem('bc_admin_token', T); w.fetch = (u, o) => { calls.push(((o && o.method) || 'GET').toUpperCase() + ' ' + String(u).replace(B, '').split('?')[0]); return fetch(new URL(u, B), o); }; w.confirm = () => true; w.prompt = (m, dflt) => dflt || 'Audit test'; w.alert = () => {}; w.open = () => null; w.print = () => {}; w.URL.createObjectURL = () => 'blob:x'; w.scrollTo = () => {}; w.Element.prototype.scrollIntoView = function () {}; w.Element.prototype.scrollTo = function () {}; w.HTMLAnchorElement.prototype.click = function () { calls.push('DOWNLOAD ' + (this.download || this.href)); }; } });
    await sleep(1300);
    const w = dom.window, d = w.document;
    const navBtn = d.querySelector(`#nav [data-view="${view}"]`); if (navBtn) navBtn.click();
    await sleep(1200);
    return { w, d, errors, calls, close: () => w.close() };
  }
  const label = b => (b.innerText || b.textContent || b.getAttribute('aria-label') || b.title || b.value || '').replace(/\s+/g, ' ').trim().slice(0, 50) || '(icon) ' + (b.className || '').slice(0, 30);
  const visible = el => { let n = el; while (n && n.nodeType === 1) { if (n.hidden || n.style.display === 'none' || (n.classList && n.classList.contains('hidden'))) return false; n = n.parentElement; } return !el.disabled; };
  const key = b => [b.id && '#' + b.id, ...Object.keys(b.dataset || {}).map(k => `[data-${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}]`)].filter(Boolean)[0] || null;
  const btnSel = 'button, [role=button], a.btn, [role=tab]';
  function scopeOf(d, view, inDrawer) { return inDrawer ? d.querySelector('#drawerRoot') : (d.querySelector('#v-' + view) || d.body); }
  async function clickAll(view, inDrawer) {
    const first = await load(view);
    let openFirst = null;
    if (inDrawer) { // open the first record on the page
      const opener = first.d.querySelector(`#v-${view} tbody tr [data-rec], #v-${view} [data-det], #v-${view} tbody tr[data-id], #v-${view} [data-call], #v-${view} [data-open], #v-${view} [data-lead], #v-${view} [data-iss], #v-${view} [data-doc], #v-${view} [data-tk], #v-${view} tbody tr`);
      if (!opener) { first.close(); return; }
      openFirst = key(opener) ? `#v-${view} ${key(opener)}` : null;
      opener.click(); await sleep(1300);
      if (!first.d.querySelector('#drawerRoot') || !first.d.querySelector('#drawerRoot').innerHTML.trim()) { first.close(); return; }
    }
    const root = scopeOf(first.d, view, inDrawer);
    const list = [...root.querySelectorAll(btnSel)].filter(visible).map((b, i) => ({ i, label: label(b) }));
    first.close();
    for (const it of list) {
      const s = await load(view);
      if (inDrawer) { const op = openFirst ? s.d.querySelector(openFirst) : s.d.querySelector(`#v-${view} tbody tr`); if (!op) { s.close(); continue; } op.click(); await sleep(1300); }
      const r0 = scopeOf(s.d, view, inDrawer);
      const btn = [...r0.querySelectorAll(btnSel)].filter(visible)[it.i];
      if (!btn) { s.close(); continue; }
      const before = { drawer: (s.d.querySelector('#drawerRoot') || {}).innerHTML || '', view: (s.d.querySelector('#nav .active') || {}).dataset ? s.d.querySelector('#nav .active').dataset.view : '', html: r0.innerHTML.length, toast: [...s.d.querySelectorAll('.toast')].map(x => (x.classList.contains('err') ? 'ERR:' : '') + x.textContent).join(' / '), calls: s.calls.length, errs: s.errors.length };
      try { btn.click(); } catch (er) { s.errors.push('click threw ' + er.message); }
      await sleep(1500);
      const nc = s.calls.slice(before.calls), writes = nc.filter(c => !/^GET /.test(c)), toast = [...s.d.querySelectorAll('.toast')].map(x => (x.classList.contains('err') ? 'ERR:' : '') + x.textContent).join(' / ');
      const drawerNow = (s.d.querySelector('#drawerRoot') || {}).innerHTML || '';
      const viewNow = s.d.querySelector('#nav .active') ? s.d.querySelector('#nav .active').dataset.view : '';
      const effects = [];
      if (writes.length) effects.push('SAVES/ACTS: ' + [...new Set(writes)].slice(0, 3).join(', '));
      if (nc.some(c => /^DOWNLOAD/.test(c))) effects.push('DOWNLOAD');
      if (drawerNow !== before.drawer) effects.push(drawerNow.trim() ? 'OPENS/UPDATES PANEL' : 'CLOSES PANEL');
      if (viewNow !== before.view) effects.push('GOES TO ' + viewNow);
      if (nc.some(c => /^GET /.test(c))) effects.push('LOADS DATA');
      if (toast && toast !== before.toast) effects.push('MESSAGE: ' + toast.slice(before.toast.length).replace(/^ \/ /, '').slice(0, 80));
      if (!effects.length && r0.isConnected && r0.innerHTML.length !== before.html) effects.push('UPDATES PAGE');
      const errs = s.errors.slice(before.errs);
      const isErrToast = /ERR:/.test(toast.slice(before.toast.length));
      const alreadyActive = !effects.length && (btn.classList.contains('active') || btn.classList.contains('on') || btn.getAttribute('aria-selected') === 'true' || btn.getAttribute('aria-pressed') === 'true');
      if (alreadyActive) effects.push('ALREADY SELECTED (no change expected)');
      inventory.push({ page: view, where: inDrawer ? 'record panel' : 'page', button: it.label, effect: effects.join(' | ') || 'NO EFFECT', result: errs.length ? 'ERROR' : !effects.length ? 'DEAD?' : isErrToast ? 'REFUSED (message shown)' : 'WORKS', detail: errs.slice(0, 2).join(' ; ').slice(0, 160) });
      s.close();
    }
  }
  const only = process.argv[2] ? process.argv[2].split(',') : VIEWS;
  for (const v of only) { try { await clickAll(v, false); await clickAll(v, true); } catch (er) { inventory.push({ page: v, where: 'page', button: '(audit)', effect: '', result: 'ERROR', detail: 'audit crashed: ' + er.message }); } fs.writeFileSync(path.join(__dirname, 'button-inventory.json'), JSON.stringify(inventory, null, 1)); process.stdout.write(v + ' '); }
  child.kill();
  fs.writeFileSync(path.join(__dirname, 'button-inventory.json'), JSON.stringify(inventory, null, 1));
  const by = r => inventory.filter(x => x.result === r).length;
  console.log(`\nbuttons clicked: ${inventory.length} | WORKS ${by('WORKS')} | REFUSED ${by('REFUSED (message shown)')} | DEAD? ${by('DEAD?')} | ERROR ${by('ERROR')}`);
  process.exit(0);
})();
