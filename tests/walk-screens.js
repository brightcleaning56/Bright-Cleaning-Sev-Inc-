// Walks every admin view in jsdom against a seeded server and lists the visible buttons on each view,
// and the buttons in the record panel of the first record. Flags views with no actions.
// Run: node tests/walk-screens.js
process.env.TZ = process.env.BUSINESS_TZ || 'America/Chicago';
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const PORT = 4400 + Math.floor(Math.random() * 50), B = `http://127.0.0.1:${PORT}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-walk-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VIEWS = ['overview', 'leads', 'customers', 'issues', 'calls', 'emails', 'proposals', 'contracts', 'projects', 'invoices', 'schedule', 'quality', 'documents', 'takeoffs', 'reports', 'scopes', 'activity', 'settings'];
const txt = b => (b.innerText || b.textContent || b.getAttribute('aria-label') || b.title || '').replace(/\s+/g, ' ').trim();

(async () => {
  const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(40).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 10), DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'uploads') };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
    const api = async (m, u, j, t) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return r.json().catch(() => ({})); };
    const T = await require('./mfa-helper')((p, b, t) => api('POST', p, b, t).then(res => ({ data: res })))(OWNER, PW);
    // Seed one realistic record per area.
    const cu = (await api('POST', '/api/admin/customers', { company: 'Seed Co', name: 'Sam Seed', email: 'sam@seed.test', phone: '515-555-0100' }, T)).id;
    const fd = new FormData(); Object.entries({ contact_name: 'Lea Lead', company: 'Lead Co', email: 'lea@lead.test', phone: '515-555-0101', project_type: 'Office', service: 'Final clean', address: '1 Main', details: 'x', consent: 'on' }).forEach(([k, v]) => fd.append(k, v));
    await fetch(B + '/api/bids', { method: 'POST', body: fd });
    await api('POST', '/api/admin/issues', { type: 'complaint', title: 'Seed complaint', customer_id: cu, priority: 'Normal', customer_comms: 'Needs update' }, T);
    await api('POST', '/api/admin/calls', { contact_name: 'Sam Seed', phone: '515-555-0100', customer_id: cu, purpose: 'Complaint', summary: 'Seed call' }, T);
    const e = (await api('POST', '/api/admin/estimates', { customer_name: 'Sam Seed', company: 'Seed Co', email: 'sam@seed.test', scope: 'Final clean', area_sqft: 10000, use_line_items: 1, line_items: [{ description: 'Clean', amount: 3000 }] }, T)).estimate;
    await api('PATCH', '/api/admin/estimates/' + e.id, { status: 'Sent' }, T);
    await api('POST', '/api/admin/employees', { name: 'Crew Seed', email: 'crew@seed.test', role: 'Lead', crew: 'A', hourly_rate: 20, max_week_hours: 40 }, T);
    await api('POST', '/api/admin/visits', { title: 'Seed visit', date: require('../bizdate').today(), customer_id: cu }, T);
    // Customer approves the proposal (creates a project), then an invoice and an uploaded drawing.
    await api('POST', `/api/proposal/${e.public_token}/respond`, { decision: 'approve', signer_name: 'Sam Seed', signer_title: 'Owner', agree: true });
    await sleep(300);
    const pj = ((await api('GET', '/api/admin/projects', null, T)).projects || [])[0];
    await api('POST', '/api/admin/invoices', { invoice_number: 'SEED-1', project_id: pj && pj.id, customer_name: 'Sam Seed', company: 'Seed Co', amount: 1500, due_date: '2026-12-31', status: 'Draft' }, T);
    const up = new FormData(); up.append('files', new Blob([Buffer.from('%PDF-1.4\n%seed\n%%EOF')], { type: 'application/pdf' }), 'seed.pdf'); up.append('kind', 'Drawings'); up.append('customer_id', String(cu));
    await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: up });

    const rows = [];
    for (const view of VIEWS) {
      const errors = [];
      const vc = new VirtualConsole(); vc.on('jsdomError', er => errors.push(er.message));
      const dom = await JSDOM.fromURL(B + '/admin/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
        beforeParse(w) { w.fetch = (u, o = {}) => fetch(new URL(u, B), { ...o, headers: { ...(o.headers || {}), Authorization: 'Bearer ' + T } }); w.confirm = () => true; w.prompt = () => 'x'; w.alert = () => {}; w.open = () => null; w.scrollTo = () => {}; w.URL.createObjectURL = () => 'blob:x'; } });
      await sleep(1300);
      const d = dom.window.document;
      const nav = d.querySelector(`#nav [data-view="${view}"]`); if (nav) nav.click();
      await sleep(1200);
      const scope = d.querySelector('#v-' + view) || d.body;
      const labels = [...scope.querySelectorAll('button, [role=button], a.btn, [role=tab]')].map(txt).filter(Boolean);
      // Open the first record (if any) and list the buttons in its panel.
      let drawer = [];
      const firstRow = [...scope.querySelectorAll('tbody tr, [data-cust], [data-lead], .crow, [data-proj], [data-inv], [data-contract], [data-call], [data-issue], [data-doc]')].find(r => !/^\s*(No |Nothing|Every)/i.test(r.textContent.trim()) && r.textContent.trim().length > 0 && !r.closest('.kpis, .kpi'));
      let opened = [];
      if (firstRow) {
        const before = new Set([...d.body.querySelectorAll('button, [role=button], a.btn')].map(txt));
        firstRow.click(); await sleep(1500);
        const dr = d.querySelector('#drawerRoot');
        if (dr && dr.innerHTML.trim()) drawer = [...dr.querySelectorAll('button, [role=button], a.btn')].map(txt).filter(Boolean);
        // Pages that open in place (customer, lead, estimate pages): the buttons that appeared after the click.
        opened = [...d.body.querySelectorAll('button, [role=button], a.btn')].map(txt).filter(l => l && !before.has(l));
        if (!drawer.length) drawer = opened;
      }
      rows.push({ view, navFound: !!nav, active: d.querySelector('#nav .active') ? d.querySelector('#nav .active').dataset.view : '', count: labels.length, labels: [...new Set(labels)], drawer: [...new Set(drawer)], errors: errors.slice(0, 2) });
      dom.window.close();
    }
    for (const r of rows) console.log(`${r.view.padEnd(12)} nav=${r.navFound ? 'y' : 'N'} active=${r.active || '-'} actions=${r.count}  ${r.labels.slice(0, 12).join(' | ')}${r.errors.length ? '  ERR ' + r.errors.join(' ; ') : ''}`);
    console.log('--- record panels ---');
    for (const r of rows) if (r.drawer.length) console.log(`${r.view.padEnd(12)} panel actions=${r.drawer.length}: ${r.drawer.slice(0, 20).join(' | ')}`);
    fs.writeFileSync(path.join(ROOT, 'tests', 'walk-screens.json'), JSON.stringify(rows, null, 1));
  } finally { child.kill(); }
})().catch(e => { console.error('walk error', e); process.exit(1); });
