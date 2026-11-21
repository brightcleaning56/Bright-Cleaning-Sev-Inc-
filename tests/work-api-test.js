// Checks the work-item API on a real server: create, duplicate protection, the lifecycle rules as HTTP results, and the queue.
// Run: node tests/work-api-test.js
process.env.TZ = process.env.BUSINESS_TZ || 'America/Chicago';
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ROOT = path.join(__dirname, '..');
const PORT = 4800 + Math.floor(Math.random() * 50), B = `http://127.0.0.1:${PORT}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-work-api-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
let passed = 0, failed = 0;
const check = (what, ok, detail = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`); };

(async () => {
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(40).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 10), DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'uploads'), DISABLE_SCHEDULER: '1', DOTENV_CONFIG_PATH: '/nonexistent', PUBLIC_BASE_URL: 'https://brightclean.net' };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
    const api = async (m, u, j, t) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return { s: r.status, d: await r.json().catch(() => ({})) }; };
    const T = await require('./mfa-helper')((p, b, t) => api('POST', p, b, t).then(res => ({ data: res.d })))(OWNER, PW);

    const c = await api('POST', '/api/admin/work-items', { kind: 'maintenance', title: 'Replace vacuum belt', assigned_to: 'crew@bc.test' }, T);
    check('Create a work item', c.s === 201 && c.d.item && c.d.item.status === 'open', c.s + ' ' + JSON.stringify(c.d).slice(0, 100));
    const id = c.d.id;
    const dup = await api('POST', '/api/admin/work-items', { kind: 'maintenance', ref_type: 'van', ref_id: 2, title: 'Fix van 2' }, T);
    const dup2 = await api('POST', '/api/admin/work-items', { kind: 'maintenance', ref_type: 'van', ref_id: 2, title: 'Fix van 2 again' }, T);
    check('Second create for the same record returns the same item (200, not 201)', dup.s === 201 && dup2.s === 200 && dup2.d.id === dup.d.id, `${dup.s} then ${dup2.s}`);
    const noNote = await api('POST', `/api/admin/work-items/${id}/complete`, {}, T);
    check('Complete without a note is refused (400, explained)', noNote.s === 400 && /completion note/.test(noNote.d.error || ''), noNote.s + ' ' + noNote.d.error);
    const q1 = await api('GET', '/api/admin/work-items?assigned_to=crew@bc.test', null, T);
    check('Item is in the crew member’s queue before completion', (q1.d.items || []).some(x => x.id === id), '');
    const done = await api('POST', `/api/admin/work-items/${id}/complete`, { note: 'Belt replaced, tested' }, T);
    check('Complete with a note works', done.s === 200 && done.d.item.status === 'completed', done.s);
    const q2 = await api('GET', '/api/admin/work-items?assigned_to=crew@bc.test', null, T);
    check('Completed item has left the queue', !(q2.d.items || []).some(x => x.id === id));
    const got = await api('GET', `/api/admin/work-items/${id}`, null, T);
    check('Completed item keeps its history with who did it', got.s === 200 && got.d.item.history.some(h => h.action === 'completed' && h.by === OWNER), '');
    const badDate = await api('POST', '/api/admin/work-items', { kind: 'other', title: 'x', due_date: '2026-02-31' }, T);
    check('Impossible due date is refused', badDate.s === 400, badDate.s);
    const unknown = await api('POST', `/api/admin/work-items/${id}/explode`, {}, T);
    check('Unknown action is refused', unknown.s === 400, unknown.s);
    const noAuth = await api('GET', '/api/admin/work-items', null, null);
    check('Work items need a signed-in user', noAuth.s === 401, noAuth.s);
  } finally {
    child.kill();
    console.log(`\n${passed}/${passed + failed} work-item API checks passed`);
    if (failed) process.exitCode = 1;
  }
})().catch(e => { console.error('work api test error', e); process.exit(1); });
