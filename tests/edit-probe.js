// Probes whether edits save and show up when read back: company profile, customer account, contacts, estimate, proposal.
// Starts its own server on a temporary database. Run: node tests/edit-probe.js
process.env.TZ = process.env.BUSINESS_TZ || 'America/Chicago';
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ROOT = path.join(__dirname, '..');
const PORT = 4500 + Math.floor(Math.random() * 50), B = `http://127.0.0.1:${PORT}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-edit-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
const results = [];
const check = (area, what, ok, detail = '') => { results.push({ area, what, ok, detail }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${area}: ${what}${detail ? ' — ' + detail : ''}`); };

(async () => {
  const { SMTPServer } = require('smtp-server');
  const SMTP_PORT = 2800 + Math.floor(Math.random() * 50);
  const smtp = new SMTPServer({ authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], onAuth(a, s, cb) { cb(null, { user: a.username }); }, onData(stream, s, cb) { stream.resume(); stream.on('end', cb); } });
  await new Promise(r => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(40).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 10), DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'uploads'), SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: 'false', SMTP_USER: 'walk', SMTP_PASS: 'walk', FROM_EMAIL: 'walk@brightclean.test', DISABLE_SCHEDULER: '1', DOTENV_CONFIG_PATH: '/nonexistent', PUBLIC_BASE_URL: 'https://brightclean.net', RATE_LIMIT_PUBLIC: '5000', INTAKE_RATE_LIMIT: '5000' };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
    const api = async (m, u, j, t = T) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return { s: r.status, d: await r.json().catch(() => ({})) }; };
    var T = await require('./mfa-helper')((p, b, t) => api('POST', p, b, t).then(res => ({ data: res.d })))(OWNER, PW);
    await fetch(B + '/api/admin/company/w9', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T }, body: JSON.stringify({ file: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 test w-9').toString('base64') }) }); // the company W-9 goes with every invoice email

    // Company profile (Settings > General)
    let r = await api('PUT', '/api/admin/business-profile', { company_name: 'Bright Clean Test', primary_email: 'office@brightclean.test', main_phone: '515-555-0199', business_hours: '8-5' });
    check('Company profile', 'save returns 200', r.s === 200, r.s + ' ' + JSON.stringify(r.d).slice(0, 120));
    r = await api('GET', '/api/admin/settings');
    check('Company profile', 'phone change reads back', r.d.business && r.d.business.main_phone === '515-555-0199', JSON.stringify(r.d.business));
    check('Company profile', 'email change reads back', r.d.business && r.d.business.primary_email === 'office@brightclean.test');
    r = await api('PUT', '/api/admin/business-profile', { main_phone: '515-555-0200' });
    r = await api('GET', '/api/admin/settings');
    check('Company profile', 'second phone change reads back', r.d.business.main_phone === '515-555-0200', r.d.business.main_phone);

    // Customer
    const cr = await api('POST', '/api/admin/customers', { company: 'Edit Co', name: 'Pat Edit', email: 'pat@edit.test', phone: '515-555-0300', address: '1 Old St' });
    const cid = cr.d.id || (cr.d.customer && cr.d.customer.id);
    check('Customer', 'create returns id', !!cid, JSON.stringify(cr.d).slice(0, 120));
    r = await api('PATCH', '/api/admin/customers/' + cid, { phone: '515-555-0301', address: '2 New St', name: 'Pat Changed' });
    let prof = await api('GET', '/api/admin/customers/' + cid + '/profile');
    const cust = prof.d.customer || {};
    check('Customer', 'phone, address and name change read back (drawer save)', cust.phone === '515-555-0301' && cust.address === '2 New St' && cust.name === 'Pat Changed', JSON.stringify({ phone: cust.phone, address: cust.address, name: cust.name }));
    r = await api('PATCH', '/api/admin/customers/' + cid + '/account', { phone: '515-555-0302', tax_id: '12-3456789', company: 'Edit Co Renamed' });
    prof = await api('GET', '/api/admin/customers/' + cid + '/profile');
    check('Customer', 'account edit (Edit account) reads back', prof.d.customer.phone === '515-555-0302' && prof.d.customer.tax_id === '12-3456789' && prof.d.customer.company === 'Edit Co Renamed', JSON.stringify({ phone: prof.d.customer.phone, tax: prof.d.customer.tax_id, company: prof.d.customer.company }));
    r = await api('PATCH', '/api/admin/customers/' + cid + '/account', { email: 'newpat@edit.test' });
    prof = await api('GET', '/api/admin/customers/' + cid + '/profile');
    check('Customer', 'email change through account edit', prof.d.customer.email === 'newpat@edit.test', r.s + ' ' + prof.d.customer.email);

    // Contacts
    const ct = await api('POST', `/api/admin/customers/${cid}/contacts`, { name: 'Sam Contact', title: 'Manager', email: 'sam@edit.test', phone: '515-555-0400' });
    const kid = ct.d.id || (ct.d.contact && ct.d.contact.id);
    check('Contacts', 'create contact', !!kid, JSON.stringify(ct.d).slice(0, 120));
    if (kid) {
      r = await api('PATCH', `/api/admin/customers/${cid}/contacts/${kid}`, { name: 'Sam Renamed', phone: '515-555-0401', email: 'sam2@edit.test', title: 'Director' });
      prof = await api('GET', '/api/admin/customers/' + cid + '/profile');
      const k = (prof.d.contacts || []).find(x => x.id === kid) || {};
      check('Contacts', 'contact edit reads back (name, phone, email, title)', k.name === 'Sam Renamed' && k.phone === '515-555-0401' && k.email === 'sam2@edit.test' && k.title === 'Director', r.s + ' ' + JSON.stringify(k).slice(0, 160));
    }

    // Estimate and proposal
    const er = await api('POST', '/api/admin/estimates', { customer_name: 'Pat Edit', company: 'Edit Co', email: 'pat@edit.test', scope: 'Office clean', labor_hours: 2, labor_rate: 20, margin_pct: 40 });
    const est = er.d.estimate; const eid = est && est.id;
    check('Estimate', 'create estimate', !!eid, JSON.stringify(er.d).slice(0, 120));
    if (eid) {
      r = await api('PUT', '/api/admin/estimates/' + eid, { ...est, scope: 'Office clean, plus windows', labor_hours: 4, margin_pct: 35, customer_name: 'Pat Renamed', company: 'Edit Co' });
      let g = await api('GET', '/api/admin/estimates/' + eid);
      const ge = g.d.estimate || g.d;
      check('Estimate', 'scope, hours and margin edits save (PUT)', r.s === 200, r.s + ' ' + JSON.stringify(r.d).slice(0, 160));
      check('Estimate', 'edited scope reads back', ge.scope === 'Office clean, plus windows', String(ge.scope));
      check('Estimate', 'edited labor hours read back', Number(ge.labor_hours) === 4, String(ge.labor_hours));
      check('Estimate', 'edited margin reads back', Number(ge.margin_pct) === 35, String(ge.margin_pct));
      check('Estimate', 'edited customer name reads back', ge.customer_name === 'Pat Renamed', String(ge.customer_name));
      // Proposal (the customer-facing page) must show the same figures.
      const tok = ge.public_token;
      await api('POST', `/api/admin/estimates/${eid}/send`, null);
      const pv = await api('GET', '/api/proposal/' + tok, null, null);
      const p = pv.d.proposal || pv.d.estimate || pv.d;
      check('Proposal', 'customer proposal page shows the edited scope', p && p.scope === 'Office clean, plus windows', String(p && p.scope));
      check('Proposal', 'customer proposal page shows the edited customer name', p && p.customer_name === 'Pat Renamed', String(p && p.customer_name));
      check('Proposal', 'customer proposal total matches the estimate', p && Number(p.proposal_total) === Number(ge.proposal_total), `${p && p.proposal_total} vs ${ge.proposal_total}`);
      // Edit after sending: the line-item and expiry rules apply, but scope and hours should still be allowed as a new version
      r = await api('PUT', '/api/admin/estimates/' + eid, { ...ge, labor_hours: 6, scope: 'Office clean, windows and carpets' });
      const newId = r.d.estimate && r.d.estimate.id;
      check('Estimate', 'edit after sending saves as a new draft', r.s === 200 && newId && newId !== eid && r.d.revised_from === eid, r.s + ' ' + JSON.stringify(r.d).slice(0, 160));
      const oldG = await api('GET', '/api/admin/estimates/' + eid);
      check('Estimate', 'sent version is kept as Superseded', (oldG.d.estimate || oldG.d).status === 'Superseded', String((oldG.d.estimate || oldG.d).status));
      const newG = await api('GET', '/api/admin/estimates/' + newId);
      const ng = newG.d.estimate || newG.d;
      check('Estimate', 'new draft reads back the edited hours and scope', Number(ng.labor_hours) === 6 && ng.scope === 'Office clean, windows and carpets' && ng.status === 'Draft', `${ng.labor_hours} / ${ng.status}`);
      const sendNew = await api('POST', `/api/admin/estimates/${newId}/send`, null);
      const pn = await api('GET', '/api/proposal/' + ng.public_token, null, null);
      check('Proposal', 'new draft is sent and its link shows the edited scope', sendNew.s === 200 && pn.d.proposal && pn.d.proposal.scope === 'Office clean, windows and carpets', sendNew.s + ' ' + String(pn.d.proposal && pn.d.proposal.scope));
      const oldLink = await api('GET', '/api/proposal/' + tok, null, null);
      check('Proposal', 'old link no longer shows the superseded offer as current', !(oldLink.d.proposal && oldLink.d.proposal.status === 'Sent') || oldLink.s !== 200, oldLink.s + ' ' + String(oldLink.d.proposal && oldLink.d.proposal.status));
    }
    // Other records: each edit should read back.
    const readBack = async (label, createPath, createBody, patchPath, patchBody, getPath, pick, expect) => {
      const c = await api('POST', createPath, createBody);
      const rid = (c.d && (c.d.id || (c.d.lead && c.d.lead.id) || (c.d.employee && c.d.employee.id) || (c.d.issue && c.d.issue.id) || (c.d.visit && c.d.visit.id) || (c.d.scope && c.d.scope.id) || (c.d.item && c.d.item.id) || (c.d.invoice && c.d.invoice.id))) || null;
      if (!rid) return check('Sweep', label + ': create', false, JSON.stringify(c.d).slice(0, 140));
      const p = await api('PATCH', patchPath.replace(':id', rid), patchBody(rid));
      const g = await api('GET', getPath.replace(':id', rid));
      const got = pick(g.d);
      check('Sweep', label, p.s < 300 && expect(got), `patch ${p.s}; ${JSON.stringify(got).slice(0, 120)}`);
    };
    await readBack('lead: phone and notes edit', '/api/admin/leads', { contact_name: 'Lee Lead', company: 'Lead Co', email: 'lee@lead.test', phone: '515-555-0500', project_type: 'Office', service: 'Final clean' },
      '/api/admin/leads/:id', () => ({ phone: '515-555-0501', notes: 'Call after 3' }), '/api/admin/leads/:id', d => d.lead || d, x => x.phone === '515-555-0501' && x.notes === 'Call after 3');
    await readBack('employee: phone and rate edit', '/api/admin/employees', { name: 'Ana Crew', email: 'ana@crew.test', role: 'Lead', crew: 'A', hourly_rate: 20, max_week_hours: 40 },
      '/api/admin/employees/:id', () => ({ phone: '515-555-0600', hourly_rate: 21 }), '/api/admin/employees', d => (d.employees || []).find(x => x.name === 'Ana Crew') || {}, x => x.phone === '515-555-0600' && Number(x.hourly_rate) === 21);
    await readBack('issue: title and priority edit', '/api/admin/issues', { type: 'complaint', title: 'Old title', customer_id: 1, priority: 'Normal', customer_comms: 'Needs update' },
      '/api/admin/issues/:id', () => ({ title: 'New title', priority: 'High' }), '/api/admin/issues/:id', d => d.issue || d, x => x.title === 'New title' && x.priority === 'High');
    await readBack('scope: price edit', '/api/admin/scopes', { name: 'Test scope', unit: 'sq ft', unit_price: 1.5, category: 'janitorial' },
      '/api/admin/scopes/:id', () => ({ unit_price: 2.25 }), '/api/admin/scopes', d => (d.scopes || d.items || []).find(x => x.name === 'Test scope') || {}, x => Number(x.unit_price) === 2.25);
    await readBack('invoice (draft): amount and due date edit', '/api/admin/invoices', { invoice_number: 'EDIT-1', customer_name: 'Pat Edit', company: 'Edit Co', amount: 100, due_date: '2026-12-31', status: 'Draft' },
      '/api/admin/invoices/:id', () => ({ amount: 150, due_date: '2027-01-15' }), '/api/admin/invoices', d => (d.invoices || []).find(x => x.invoice_number === 'EDIT-1') || {}, x => Number(x.amount) === 150 && x.due_date === '2027-01-15');
  } finally {
    child.kill(); smtp.close();
    const bad = results.filter(x => !x.ok);
    console.log(`\n${results.length - bad.length}/${results.length} edit checks passed`);
    fs.writeFileSync(path.join(ROOT, 'tests', 'edit-probe.json'), JSON.stringify(results, null, 1));
  }
})().catch(e => { console.error('probe error', e); process.exit(1); });
