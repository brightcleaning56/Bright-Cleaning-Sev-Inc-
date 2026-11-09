// Contracts Management Center: numbered contracts with full terms, a private customer signing link
// (typed name + authorization, signer/time/IP recorded), customer decline with reason, owner countersignature
// (only then "Signed" = executed), PDF, amendments (new version supersedes the old once executed), renewals.
// Built-in e-signature; an external provider (Dropbox Sign / DocuSign) can be added later behind the same states.
const crypto = require('crypto'), path = require('path');
const { Doc } = require('./pdf');
const DEFAULT_TERMS = `1. Scope. Bright Cleaning Sev Inc. ("Contractor") will perform the services described in the Scope of Work.
2. Schedule. Work is scheduled with the Customer; changes to dates or access may change the price.
3. Payment. Invoices are due net 30 unless stated otherwise in the Payment Terms.
4. Changes. Work outside the Scope requires a written change order or amendment signed by both parties.
5. Access & safety. Customer provides safe access, water and power. Contractor follows site safety rules.
6. Insurance. Contractor maintains general liability and workers' compensation insurance.
7. Quality. Customer reports concerns within 48 hours; Contractor will re-clean the affected areas at no charge.
8. Termination. Either party may terminate with 30 days' written notice; work performed is billed to the termination date.`;

module.exports = function mountContracts(app, ctx) {
  const { db, auth, logAction, clean, adminEmail, getMailer } = ctx;
  const cols = db.prepare('PRAGMA table_info(contracts)').all().map(c => c.name);
  for (const [c, t] of [['customer_id', 'INTEGER'], ['project_id', 'INTEGER'], ['email', 'TEXT'], ['terms', 'TEXT'], ['payment_terms', 'TEXT'], ['billing', 'TEXT'], ['auto_renew', 'INTEGER DEFAULT 0'], ['notice_days', 'INTEGER DEFAULT 30'],
    ['public_token', 'TEXT'], ['sent_at', 'TEXT'], ['viewed_at', 'TEXT'], ['signer_name', 'TEXT'], ['signer_title', 'TEXT'], ['signed_at', 'TEXT'], ['signed_ip', 'TEXT'], ['decline_reason', 'TEXT'],
    ['countersigned_by', 'TEXT'], ['countersigned_at', 'TEXT'], ['version', 'INTEGER DEFAULT 1'], ['parent_id', 'INTEGER'], ['superseded_by', 'INTEGER'], ['kind', "TEXT DEFAULT 'Contract'"], ['renewed_from', 'INTEGER'], ['updated_at', 'TEXT']])
    if (!cols.includes(c)) db.exec(`ALTER TABLE contracts ADD COLUMN ${c} ${t}`);
  const now = () => new Date().toISOString(), today = () => require('./bizdate').today();
  const who = req => (req.user && req.user.email) || null;
  const roleOf = req => { const e = String(who(req) || '').toLowerCase(); if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  const number = k => `C-${String(k.created_at || '').slice(0, 4) || '2026'}-${1000 + k.id}${k.version > 1 ? '-v' + k.version : ''}`;
  const get = id => { const k = db.prepare('SELECT * FROM contracts WHERE id=?').get(Number(id)); if (!k) return k; const src = k.estimate_id ? db.prepare('SELECT status FROM estimates WHERE id=?').get(k.estimate_id) : null; return { ...k, number: number(k), proposal_status: src ? src.status : null }; };
  const base = () => process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || 'https://brightclean.net';
  // A signed contract is the job. Contracts made without a proposal had no project, so create one when none is linked.
  const ensureProject = k => {
    if (db.prepare('SELECT id FROM projects WHERE contract_id=?').get(k.id)) return false;
    const site = k.estimate_id ? ((db.prepare('SELECT site_address FROM estimates WHERE id=?').get(k.estimate_id) || {}).site_address || null) : null;
    const status = ['Signed', 'Executed', 'Fully signed'].includes(k.signature_status) ? 'Contracted' : 'Planning';
    const pid = db.prepare("INSERT INTO projects(contract_id,estimate_id,customer_id,customer_name,company,name,site_address,status,progress,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)").run(k.id, k.estimate_id || null, k.customer_id || null, k.customer_name || null, k.company || null, k.title || 'Commercial cleaning services', site, status, now()).lastInsertRowid;
    db.prepare('UPDATE contracts SET project_id=COALESCE(project_id,?) WHERE id=?').run(pid, k.id);
    return true;
  };
  // One-time repair for signed contracts that were executed before this rule existed. Safe to run on every start.
  try { for (const row of db.prepare("SELECT * FROM contracts WHERE status='Active' AND signature_status IN ('Signed','Executed','Fully signed')").all()) ensureProject(row); } catch (e) { console.error('Contract-to-project repair failed:', e.message); }
  const locked = k => ['Customer signed', 'Signed'].includes(k.signature_status);
  const executed = k => ['Signed', 'Executed', 'Fully signed'].includes(k.signature_status);
  const fill = k => { // pull customer email/scope from the linked proposal once
    if (k.estimate_id && (!k.email || !k.scope)) { const e = db.prepare('SELECT email, scope, company, customer_name FROM estimates WHERE id=?').get(k.estimate_id); if (e) db.prepare('UPDATE contracts SET email=COALESCE(email,?), scope=COALESCE(NULLIF(scope,\'\'),?) WHERE id=?').run(e.email || null, e.scope || null, k.id); }
    return get(k.id);
  };
  async function mail(to, subject, text) {
    const m = getMailer && getMailer(); if (!m || !to) return false;
    try { await m.sendMail({ from: process.env.FROM_EMAIL || adminEmail, to, subject, text }); return true; } catch (e) { console.error('contract email failed:', e.message); return false; }
  }

  app.get('/api/admin/contracts2', auth, (req, res) => {
    const rows = db.prepare(`SELECT k.*, p.name project_name FROM contracts k LEFT JOIN projects p ON p.id=k.project_id ORDER BY k.id DESC`).all().map(k => ({ ...k, number: number(k), public_token: undefined }));
    const live = rows.filter(k => !['Closed', 'Superseded'].includes(k.status)), sum = a => Math.round(a.reduce((s, k) => s + (Number(k.value) || 0), 0) * 100) / 100;
    const in60 = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
    res.json({ contracts: rows, kpis: { executed: live.filter(executed).length, executed_value: sum(live.filter(executed)), awaiting_customer: live.filter(k => ['Sent', 'Viewed'].includes(k.signature_status)).length,
      awaiting_countersign: live.filter(k => k.signature_status === 'Customer signed').length, declined: live.filter(k => k.signature_status === 'Declined').length, drafts: live.filter(k => !k.signature_status || k.signature_status === 'Not sent').length,
      renewals_60: live.filter(k => executed(k) && k.end_date && k.end_date >= today() && k.end_date <= in60).length, expired: live.filter(k => executed(k) && k.end_date && k.end_date < today()).length } });
  });
  app.get('/api/admin/contracts2/:id', auth, (req, res) => {
    let k = get(req.params.id); if (!k) return res.status(404).json({ error: 'Contract not found.' }); k = fill(k);
    const versions = db.prepare('SELECT id, version, status, signature_status, value, created_at FROM contracts WHERE id=? OR parent_id=? OR id=? ORDER BY version').all(k.parent_id || k.id, k.parent_id || k.id, k.parent_id || k.id);
    let docs = []; try { docs = db.prepare('SELECT id,title,kind,file_name,file_url,created_at FROM documents WHERE project_id=? ORDER BY id DESC LIMIT 20').all(k.project_id || -1); } catch { /* */ }
    res.json({ contract: { ...k, link: k.public_token ? `${base()}/contract/${k.public_token}` : null }, default_terms: DEFAULT_TERMS, versions, documents: docs,
      history: db.prepare("SELECT * FROM audit_log WHERE entity='contract' AND entity_id=? ORDER BY id DESC LIMIT 100").all(k.id) });
  });
  app.patch('/api/admin/contracts2/:id', auth, (req, res) => {
    const k = get(req.params.id); if (!k) return res.status(404).json({ error: 'Contract not found.' });
    if (locked(k)) return res.status(409).json({ error: 'This contract has been signed. Changes need an amendment.' });
    const b = req.body || {}, set = {};
    for (const [f, n] of [['title', 200], ['scope', 20000], ['terms', 20000], ['payment_terms', 500], ['billing', 100], ['customer_name', 150], ['company', 150]]) if (f in b) set[f] = clean(b[f], n);
    if ('email' in b) { const e = clean(b.email, 254).toLowerCase(); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'Enter a valid customer email.' }); set.email = e; }
    for (const f of ['start_date', 'end_date']) if (f in b) { const d = clean(b[f], 10); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Dates must be dates.' }); set[f] = d || null; }
    if ((set.start_date || k.start_date) && (set.end_date || k.end_date) && (set.end_date || k.end_date) < (set.start_date || k.start_date)) return res.status(400).json({ error: 'The end date is before the start date.' });
    if ('value' in b) { const v = Number(String(b.value).replace(/[$,]/g, '')); if (!(v >= 0 && v < 1e9)) return res.status(400).json({ error: 'Contract value must be a number.' }); set.value = v; }
    if ('auto_renew' in b) set.auto_renew = b.auto_renew ? 1 : 0;
    if ('notice_days' in b) { const n = Math.trunc(Number(b.notice_days)); if (!(n >= 0 && n <= 365)) return res.status(400).json({ error: 'Notice days must be 0–365.' }); set.notice_days = n; }
    const c = Object.keys(set); if (!c.length) return res.json({ ok: true });
    // Editing a sent contract voids the outstanding link (the customer must get the updated version).
    if (['Sent', 'Viewed', 'Declined'].includes(k.signature_status)) { set.signature_status = 'Not sent'; set.public_token = null; c.push('signature_status', 'public_token'); }
    db.prepare(`UPDATE contracts SET ${c.map(f => f + '=?').join(',')}, updated_at=? WHERE id=?`).run(...c.map(f => set[f]), now(), k.id);
    logAction(req, 'edited', 'contract', k.id, `${k.number}: ${Object.keys(set).filter(f => f !== 'public_token').join(', ')}${set.public_token === null ? ' (signing link voided)' : ''}`);
    res.json({ contract: get(k.id) });
  });
  app.post('/api/admin/contracts2/:id/send', auth, async (req, res) => {
    let k = get(req.params.id); if (!k) return res.status(404).json({ error: 'Contract not found.' }); k = fill(k);
    if (locked(k)) return res.status(409).json({ error: 'This contract is already signed.' });
    if (k.status === 'Superseded' || k.status === 'Closed') return res.status(409).json({ error: `This contract is ${k.status.toLowerCase()}.` });
    const miss = [!k.email && 'customer email', !(k.value > 0) && 'contract value', !k.scope && 'scope of work', !k.start_date && 'start date'].filter(Boolean);
    if (miss.length) return res.status(400).json({ error: 'Before sending, add: ' + miss.join(', ') + '.' });
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare("UPDATE contracts SET public_token=?, terms=COALESCE(NULLIF(terms,''),?), signature_status='Sent', status=CASE WHEN status='Draft' THEN 'Review' ELSE status END, sent_at=?, decline_reason=NULL, updated_at=? WHERE id=?").run(token, DEFAULT_TERMS, now(), now(), k.id);
    const link = `${base()}/contract/${token}`;
    const sent = await mail(k.email, `Contract for signature: ${k.title || k.number}`, `Hello ${k.customer_name || ''},\n\nPlease review and sign the contract for ${k.title || 'your project'} (${k.number}).\n\nReview and sign: ${link}\n\nThank you,\nBright Cleaning Sev Inc.`);
    logAction(req, 'sent for signature', 'contract', k.id, `${k.number} to ${k.email}${sent ? '' : ' (email not delivered — share the link)'}`);
    res.json({ ok: true, link, emailed: sent });
  });
  app.post('/api/admin/contracts2/:id/countersign', auth, (req, res) => {
    const k = get(req.params.id); if (!k) return res.status(404).json({ error: 'Contract not found.' });
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only an owner or manager can countersign contracts.' });
    // A client's online proposal approval only stands for the original contract; amendments and renewals need their own signature.
    const approvedOnline = k.proposal_status === 'Approved' && !k.parent_id && (k.kind || 'Contract') === 'Contract';
    if (k.signature_status !== 'Customer signed' && !approvedOnline) return res.status(409).json({ error: 'The customer has not approved or signed this contract yet.' });
    const name = clean((req.body || {}).name, 120); if (name.length < 2) return res.status(400).json({ error: 'Type your full name to countersign.' });
    db.prepare("UPDATE contracts SET signature_status='Signed', status='Active', countersigned_by=?, countersigned_at=?, updated_at=? WHERE id=?").run(`${name} (${who(req)})`, now(), now(), k.id);
    if (k.parent_id) { db.prepare("UPDATE contracts SET status='Superseded', superseded_by=? WHERE (id=? OR parent_id=?) AND id<>? AND status<>'Closed'").run(k.id, k.parent_id, k.parent_id, k.id); db.prepare('UPDATE projects SET contract_id=? WHERE contract_id IN (SELECT id FROM contracts WHERE (id=? OR parent_id=?) AND id<>?)').run(k.id, k.parent_id, k.parent_id, k.id); }
    // Office sign-off creates the job if the contract has none, then moves it to Contracted (it can now be scheduled).
    ensureProject(k);
    db.prepare("UPDATE projects SET status=CASE WHEN status='Planning' THEN 'Contracted' ELSE status END, updated_at=? WHERE contract_id=?").run(now(), k.id);
    // Visits planned before sign-off go live now, so staff and the customer portal see them.
    db.prepare("UPDATE visits SET status='Scheduled', updated_at=? WHERE status='Tentative' AND project_id IN (SELECT id FROM projects WHERE contract_id=?)").run(now(), k.id);
    logAction(req, 'countersigned', 'contract', k.id, `${k.number} by ${name} — executed`);
    res.json({ contract: get(k.id) });
  });
  app.post('/api/admin/contracts2/:id/amend', auth, (req, res) => {
    const k = get(req.params.id); if (!k) return res.status(404).json({ error: 'Contract not found.' });
    if (!executed(k)) return res.status(409).json({ error: 'Only an executed contract can be amended. Edit the draft instead.' });
    const reason = clean((req.body || {}).reason, 500); if (!reason) return res.status(400).json({ error: 'Describe what the amendment changes.' });
    const root = k.parent_id || k.id; const lastV = db.prepare('SELECT id, version FROM contracts WHERE id=? OR parent_id=? ORDER BY version DESC, id DESC LIMIT 1').get(root, root); if (lastV && lastV.id !== k.id) return res.status(409).json({ error: `Version ${lastV.version} of this contract is newer. Amend that version (or finish its open draft) instead.` }); const v = (db.prepare('SELECT MAX(version) v FROM contracts WHERE id=? OR parent_id=?').get(root, root).v || 1) + 1;
    const id = db.prepare(`INSERT INTO contracts(estimate_id,customer_id,project_id,customer_name,company,email,title,scope,terms,payment_terms,billing,start_date,end_date,value,auto_renew,notice_days,status,signature_status,kind,version,parent_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Draft','Not sent','Amendment',?,?,?,?)`).run(k.estimate_id, k.customer_id, k.project_id, k.customer_name, k.company, k.email, k.title, `${k.scope || ''}\n\nAmendment ${v - 1}: ${reason}`, k.terms, k.payment_terms, k.billing, k.start_date, k.end_date, k.value, k.auto_renew, k.notice_days, v, root, now(), now()).lastInsertRowid;
    logAction(req, 'drafted amendment', 'contract', id, `${number(get(id))} amends ${k.number}: ${reason}`);
    res.status(201).json({ id });
  });
  app.post('/api/admin/contracts2/:id/renew', auth, (req, res) => {
    const k = get(req.params.id); if (!k) return res.status(404).json({ error: 'Contract not found.' });
    if (!executed(k) || !k.end_date || !k.start_date) return res.status(409).json({ error: 'Only an executed contract with start and end dates can be renewed.' });
    if (db.prepare('SELECT 1 FROM contracts WHERE renewed_from=?').get(k.id)) return res.status(409).json({ error: 'A renewal already exists for this contract.' });
    const span = Date.parse(k.end_date) - Date.parse(k.start_date), s = new Date(Date.parse(k.end_date) + 864e5).toISOString().slice(0, 10), e = new Date(Date.parse(s) + span).toISOString().slice(0, 10);
    const pct = Number((req.body || {}).increase_pct) || 0; if (!(pct >= -20 && pct <= 50)) return res.status(400).json({ error: 'Price change must be between -20% and +50%.' });
    const id = db.prepare(`INSERT INTO contracts(estimate_id,customer_id,project_id,customer_name,company,email,title,scope,terms,payment_terms,billing,start_date,end_date,value,auto_renew,notice_days,status,signature_status,kind,renewed_from,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Draft','Not sent','Renewal',?,?,?)`).run(k.estimate_id, k.customer_id, k.project_id, k.customer_name, k.company, k.email, `${k.title || 'Contract'} (renewal)`, k.scope, k.terms, k.payment_terms, k.billing, s, e, Math.round(k.value * (1 + pct / 100) * 100) / 100, k.auto_renew, k.notice_days, k.id, now(), now()).lastInsertRowid;
    logAction(req, 'drafted renewal', 'contract', id, `renews ${k.number}: ${s} to ${e}${pct ? `, ${pct > 0 ? '+' : ''}${pct}%` : ''}`);
    res.status(201).json({ id, start_date: s, end_date: e });
  });
  function pdf(k) {
    const d = new Doc();
    d.box(0, 742, 612, 50, '0.06 0.15 0.26'); d.y = 762; d.text(`BRIGHT CLEANING SEV INC.  -  ${(k.kind || 'Contract').toUpperCase()}`, { size: 13, bold: true, color: '1 1 1' }); d.y = 712;
    d.heading(`${k.title || 'Services contract'}`, 15); d.para(`${k.number}  |  ${k.company || k.customer_name || ''}  |  Term ${k.start_date || '-'} to ${k.end_date || '-'}`);
    d.para(`Contract value: $${Number(k.value || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}${k.payment_terms ? '   Payment terms: ' + k.payment_terms : ''}${k.billing ? '   Billing: ' + k.billing : ''}`, { bold: true });
    d.heading('Scope of work', 11); d.para(k.scope || '-');
    d.heading('Terms and conditions', 11); for (const line of String(k.terms || DEFAULT_TERMS).split('\n')) d.para(line);
    if (k.auto_renew) d.para(`Renews automatically unless either party gives ${k.notice_days || 30} days' written notice before the end date.`);
    d.heading('Signatures', 11);
    d.para(k.signed_at ? `Customer: ${k.signer_name}${k.signer_title ? ', ' + k.signer_title : ''} — signed electronically ${k.signed_at.slice(0, 16).replace('T', ' ')} UTC (IP ${k.signed_ip || 'n/a'})` : 'Customer: not signed');
    d.para(k.countersigned_at ? `Bright Cleaning Sev Inc.: ${k.countersigned_by} — ${k.countersigned_at.slice(0, 16).replace('T', ' ')} UTC` : 'Bright Cleaning Sev Inc.: not countersigned');
    d.footer(`Bright Cleaning Sev Inc. - ${k.number} - Office +1 (515) 303-3024 - Eric Moore (Owner) 469-267-8472`);
    return d.toBuffer();
  }
  app.get('/api/admin/contracts2/:id/pdf', auth, (req, res) => {
    const k = get(req.params.id); if (!k) return res.status(404).json({ error: 'Contract not found.' });
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${k.number}.pdf"`); res.send(pdf(k));
  });

  // ---------- Customer signing (public, by private link) ----------
  const byToken = t => { const k = db.prepare('SELECT * FROM contracts WHERE public_token=?').get(clean(t, 80)); return k && { ...k, number: number(k) }; };
  const pub = k => ({ number: k.number, title: k.title, kind: k.kind, company: k.company, customer_name: k.customer_name, scope: k.scope, terms: k.terms || DEFAULT_TERMS, payment_terms: k.payment_terms, billing: k.billing,
    start_date: k.start_date, end_date: k.end_date, value: k.value, auto_renew: !!k.auto_renew, notice_days: k.notice_days, signature_status: k.signature_status, signer_name: k.signer_name, signed_at: k.signed_at, countersigned_at: k.countersigned_at, decline_reason: k.decline_reason });
  app.get('/api/contract/:token', (req, res) => {
    const k = byToken(req.params.token); if (!k) return res.status(404).json({ error: 'This contract link is not valid or was replaced. Ask Bright Clean for the current link.' });
    if (k.status === 'Superseded') return res.status(410).json({ error: 'This contract was replaced by a newer version.' });
    if (k.signature_status === 'Sent') { db.prepare("UPDATE contracts SET signature_status='Viewed', viewed_at=? WHERE id=?").run(now(), k.id); db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run('customer', 'viewed', 'contract', k.id, k.number, now()); k.signature_status = 'Viewed'; }
    res.json({ contract: pub(k) });
  });
  app.get('/api/contract/:token/pdf', (req, res) => {
    const k = byToken(req.params.token); if (!k) return res.status(404).json({ error: 'Not found.' });
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${k.number}.pdf"`); res.send(pdf(k));
  });
  app.post('/api/contract/:token/sign', async (req, res) => {
    const k = byToken(req.params.token); if (!k) return res.status(404).json({ error: 'This contract link is not valid.' });
    if (!['Sent', 'Viewed'].includes(k.signature_status)) return res.status(409).json({ error: k.signature_status === 'Declined' ? 'This contract was declined. Contact Bright Clean for an updated version.' : 'This contract can no longer be signed from this link.' });
    const b = req.body || {}, name = clean(b.name, 120);
    if (name.length < 3 || !/\s/.test(name)) return res.status(400).json({ error: 'Type your full name (first and last) to sign.' });
    if (b.agree !== true) return res.status(400).json({ error: 'Confirm that you are authorized to sign for your company.' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 60);
    db.prepare("UPDATE contracts SET signature_status='Customer signed', signer_name=?, signer_title=?, signed_at=?, signed_ip=?, updated_at=? WHERE id=?").run(name, clean(b.title, 120), now(), ip, now(), k.id);
    db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run('customer: ' + name, 'signed', 'contract', k.id, `${k.number} from ${ip}`, now());
    if (adminEmail) await mail(adminEmail, `Contract signed by customer: ${k.title || k.number}`, `${name} signed ${k.number}. Countersign it in the admin to execute it: ${base()}/admin/#contracts`);
    res.json({ ok: true });
  });
  app.post('/api/contract/:token/decline', async (req, res) => {
    const k = byToken(req.params.token); if (!k) return res.status(404).json({ error: 'This contract link is not valid.' });
    if (!['Sent', 'Viewed'].includes(k.signature_status)) return res.status(409).json({ error: 'This contract can no longer be declined from this link.' });
    const reason = clean((req.body || {}).reason, 1000); if (reason.length < 3) return res.status(400).json({ error: 'Please tell us why, so we can fix it.' });
    db.prepare("UPDATE contracts SET signature_status='Declined', decline_reason=?, updated_at=? WHERE id=?").run(reason, now(), k.id);
    db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run('customer', 'declined', 'contract', k.id, `${k.number}: ${reason}`, now());
    if (adminEmail) await mail(adminEmail, `Contract declined: ${k.title || k.number}`, `Reason: ${reason}`);
    res.json({ ok: true });
  });
  app.get('/contract/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contract.html')));
};
