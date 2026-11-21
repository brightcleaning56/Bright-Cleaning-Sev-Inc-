// Drives the admin page in jsdom and saves the Company profile form (Settings > General) and a contact edit,
// then reads the server back. Run: node tests/ui-edit-check.js
process.env.TZ = process.env.BUSINESS_TZ || 'America/Chicago';
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.join(__dirname, '..');
const PORT = 4600 + Math.floor(Math.random() * 50), B = `http://127.0.0.1:${PORT}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-uiedit-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
const out = [];
const check = (what, ok, detail = '') => { out.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`); };

(async () => {
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(40).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 10), DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'uploads'), DISABLE_SCHEDULER: '1', DOTENV_CONFIG_PATH: '/nonexistent', PUBLIC_BASE_URL: 'https://brightclean.net' };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
    const api = async (m, u, j, t) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return { s: r.status, d: await r.json().catch(() => ({})) }; };
    const T = await require('./mfa-helper')((p, b, t) => api('POST', p, b, t).then(res => ({ data: res.d })))(OWNER, PW);
    const cu = (await api('POST', '/api/admin/customers', { company: 'UI Co', name: 'Uma UI', email: 'uma@ui.test', phone: '515-555-0700' }, T)).d.id;
    await api('POST', `/api/admin/customers/${cu}/contacts`, { name: 'Ken Contact', title: 'Mgr', email: 'ken@ui.test', phone: '515-555-0701' }, T);

    const open = async view => {
      const vc = new VirtualConsole(); const errors = []; vc.on('jsdomError', e => errors.push(e.message));
      const dom = await JSDOM.fromURL(B + '/admin/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
        beforeParse(w) { w.fetch = (u, o = {}) => fetch(new URL(u, B), { ...o, headers: { ...(o.headers || {}), Authorization: 'Bearer ' + T } }); w.confirm = () => true; w.prompt = () => 'x'; w.alert = () => {}; w.open = () => null; w.scrollTo = () => {}; w.URL.createObjectURL = () => 'blob:x'; } });
      await sleep(1300);
      const nav = dom.window.document.querySelector(`#nav [data-view="${view}"]`); if (nav) nav.click();
      await sleep(1200);
      return { dom, d: dom.window.document, w: dom.window, errors };
    };

    // 1. Company profile form: type a new phone and email, press Save profile.
    let p = await open('settings');
    const bizPhone = p.d.querySelector('#bizPhone'), bizEmail = p.d.querySelector('#bizEmail'), bizForm = p.d.querySelector('#bizForm');
    check('Company profile form is on the Settings page', !!bizForm && !!bizPhone);
    if (bizPhone) {
      bizPhone.value = '515-555-0810';
      bizEmail.value = 'office@ui.test';
      bizForm.dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
      await sleep(1200);
      const g = await api('GET', '/api/admin/settings', null, T);
      check('Company profile phone saves from the form', g.d.business && g.d.business.main_phone === '515-555-0810', g.d.business && g.d.business.main_phone);
      check('Company profile email saves from the form', g.d.business && g.d.business.primary_email === 'office@ui.test', g.d.business && g.d.business.primary_email);
      check('Company profile shows the saved phone after save', p.d.querySelector('#bizPhone').value === '515-555-0810', p.d.querySelector('#bizPhone').value);
    }
    p.dom.window.close();

    // 2. Customer page: Contacts tab, Edit contact.
    const cp = await open('customers');
    const row = cp.d.querySelector(`[data-cust="${cu}"]`);
    if (row) row.click();
    await sleep(3000);
    const contactsTab = [...cp.d.querySelectorAll('button, [role=tab], [data-gotab]')].find(b => /^Contacts/.test((b.textContent || '').trim()));
    if (contactsTab) contactsTab.click();
    await sleep(900);
    const editBtn = cp.d.querySelector('[data-ctedit]');
    check('Contacts list has an Edit button', !!editBtn);
    if (editBtn) {
      editBtn.click();
      await sleep(900);
      const form = cp.d.querySelector('.drawer form, #drawerRoot form, form');
      const nameIn = cp.d.querySelector('#drawerRoot input[name="name"]') || cp.d.querySelector('input[name="name"]');
      if (nameIn) {
        nameIn.value = 'Ken Renamed';
        cp.d.querySelector('#drawerRoot input[name="phone"]').value = '515-555-0820';
        cp.d.querySelector('#drawerRoot input[name="email"]').value = 'ken2@ui.test';
        cp.d.querySelector('#genSave').click();
        await sleep(1300);
        const prof = await api('GET', `/api/admin/customers/${cu}/profile`, null, T);
        const k = (prof.d.contacts || []).find(x => x.name === 'Ken Renamed');
        check('Contact edit saves from the form', !!k && k.phone === '515-555-0820' && k.email === 'ken2@ui.test', JSON.stringify(k && { name: k.name, phone: k.phone, email: k.email }));
      } else check('Contact edit form opens', false, 'no name field found');
    }
    check('Customer page loaded without script errors', cp.errors.length === 0, cp.errors.slice(0, 2).join(' ; '));
    cp.dom.window.close();
  } finally {
    child.kill();
    const bad = out.filter(x => !x).length;
    console.log(`\n${out.length - bad}/${out.length} UI edit checks passed`);
  }
})().catch(e => { console.error('ui edit check error', e); process.exit(1); });
