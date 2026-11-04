// Estimates, customer proposals and general-contractor bids: dashboard, versions/revisions, withdrawal,
// PDF output, detail with history, and financial safety flags. Proposal approval is never treated as payment.
const { Doc } = require('./pdf');

module.exports = function mountBids(app, ctx) {
  const { db, auth, logAction, clean } = ctx;
  const cols = db.prepare('PRAGMA table_info(estimates)').all().map(c => c.name);
  for (const [c, t] of [['version', 'INTEGER DEFAULT 1'], ['root_id', 'INTEGER'], ['parent_id', 'INTEGER'], ['superseded_by', 'INTEGER'], ['withdrawn_at', 'TEXT'], ['withdrawn_reason', 'TEXT'],
    ['signer_name', 'TEXT'], ['signer_title', 'TEXT'], ['signed_at', 'TEXT'], ['decline_reason', 'TEXT'], ['assumptions', 'TEXT'], ['exclusions', 'TEXT'], ['internal_notes', 'TEXT'],
    ['bid_type', "TEXT DEFAULT 'proposal'"], ['gc_name', 'TEXT'], ['bid_due_date', 'TEXT'], ['bid_result', 'TEXT']])
    if (!cols.includes(c)) db.exec(`ALTER TABLE estimates ADD COLUMN ${c} ${t}`);
  const now = () => new Date().toISOString(), today = () => require('./bizdate').today();
  const get = id => db.prepare('SELECT * FROM estimates WHERE id=?').get(Number(id));
  const number = e => `P-${String(e.created_at || '').slice(0, 4) || '2026'}-${String(1000 + e.id)}`;
  const gate = e => { try { return require('./approvals').gate(e); } catch { return null; } };

  // Financial safety flags: things a manager should look at before relying on or sending the number.
  function flags(e) {
    const f = [], area = Number(e.area_sqft) || 0, total = Number(e.proposal_total) || 0, cost = Number(e.total_cost) || 0;
    if (total <= 0) f.push({ level: 'block', text: 'Total is $0. A proposal cannot be sent at $0.' });
    if (area > 0 && total > 0 && total / area > 5) f.push({ level: 'warn', text: `Unusually high: $${(total / area).toFixed(2)} per sq ft (typical cleaning is $0.05–$2.50).` });
    if (area > 0 && total > 0 && total / area < 0.02) f.push({ level: 'warn', text: `Unusually low: $${(total / area).toFixed(3)} per sq ft.` });
    if (Number(e.labor_hours) > 3000 * (Number(e.visits) || 1)) f.push({ level: 'warn', text: `${Math.round(e.labor_hours).toLocaleString()} labor hours looks too high. Check the production rate (sq ft per labor hour), not price per sq ft.` });
    if (!area && !(Number(e.use_line_items) && Number(e.line_items_total) > 0) && !String(e.line_items || '').includes('qty')) f.push({ level: 'warn', text: 'Missing quantities: no square footage or line items.' });
    if (cost > 0 && total > 0) { const m = (total - cost) / total * 100; if (m < 15) f.push({ level: 'warn', text: `Low margin: ${m.toFixed(1)}% (below 15%).` }); }
    if (Number(e.use_line_items) && Number(e.line_items_total) > 0 && total > 0 && Math.abs(Number(e.line_items_total) - total) / total > 0.5) f.push({ level: 'warn', text: `Totals don't line up: line items $${Number(e.line_items_total).toFixed(2)} vs proposal $${total.toFixed(2)}.` });
    if (['Sent', 'Viewed'].includes(e.status) && e.expires_on && e.expires_on < today()) f.push({ level: 'info', text: `Expired on ${e.expires_on}.` });
    if (!e.scope_category) f.push({ level: 'info', text: 'No service category set (reports will show "Not categorized").' });
    return f;
  }
  // Lifecycle stage: Draft → Internal review → Approved for sending → Sent → Viewed → Accepted/Declined → Contract → Project
  function stage(e) {
    const contract = db.prepare('SELECT id, signature_status FROM contracts WHERE estimate_id=? ORDER BY id DESC').get(e.id);
    const project = contract && db.prepare('SELECT id FROM projects WHERE contract_id=?').get(contract.id);
    if (e.status === 'Withdrawn') return 'Withdrawn';
    if (e.status === 'Superseded') return 'Superseded';
    if (project) return 'Project planning';
    if (contract) return 'Contract';
    if (e.status === 'Approved') return 'Accepted';
    if (e.status === 'Declined') return 'Declined';
    if (e.status === 'Expired') return 'Expired';
    if (e.status === 'Viewed') return 'Viewed';
    if (e.status === 'Sent') return 'Sent';
    if (gate(e)) return 'Internal review';
    return e.status === 'Ready' ? 'Approved for sending' : 'Draft';
  }
  const STEPS = ['Draft', 'Internal review', 'Approved for sending', 'Sent', 'Viewed', 'Accepted', 'Contract', 'Project planning'];
  const decorate = e => ({ ...e, number: number(e), stage: stage(e), flags: flags(e), internal_notes: e.internal_notes });

  app.get('/api/admin/bids/dashboard', auth, (req, res) => {
    const all = db.prepare('SELECT * FROM estimates').all();
    const live = all.filter(e => !['Superseded', 'Withdrawn'].includes(e.status));
    const sum = (a, f) => Math.round(a.reduce((t, x) => t + (Number(f(x)) || 0), 0) * 100) / 100;
    const in7 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const drafts = live.filter(e => ['Draft', 'Ready'].includes(e.status));
    const review = drafts.filter(e => !!gate(e));
    const waiting = live.filter(e => ['Sent', 'Viewed'].includes(e.status));
    const approved = live.filter(e => e.status === 'Approved'), declined = live.filter(e => e.status === 'Declined');
    const expiring = waiting.filter(e => e.expires_on && e.expires_on >= today() && e.expires_on <= in7);
    const signed = db.prepare("SELECT COALESCE(SUM(value),0) v, COUNT(*) n FROM contracts WHERE signature_status IN ('Signed','Executed','Fully signed')").get();
    const costed = approved.filter(e => Number(e.total_cost) > 0);
    const decided = approved.length + declined.length;
    res.json({
      drafts: { n: drafts.length, v: sum(drafts, e => e.proposal_total), week: drafts.filter(e => e.created_at >= new Date(Date.now() - 7 * 864e5).toISOString()).length },
      review: { n: review.length, v: sum(review, e => e.proposal_total) },
      waiting: { n: waiting.length, v: sum(waiting, e => e.proposal_total) },
      approved: { n: approved.length, v: sum(approved, e => e.proposal_total) },
      declined: { n: declined.length, v: sum(declined, e => e.proposal_total) },
      expiring: { n: expiring.length, v: sum(expiring, e => e.proposal_total) },
      proposed_value: sum(live.filter(e => ['Sent', 'Viewed', 'Approved', 'Declined'].includes(e.status)), e => e.proposal_total),
      contracted_value: signed.v, contracted_n: signed.n,
      projected_gp: { v: sum(costed, e => e.proposal_total - e.total_cost), of: approved.length, costed: costed.length, pct: costed.length ? Math.round(sum(costed, e => e.proposal_total - e.total_cost) / sum(costed, e => e.proposal_total) * 1000) / 10 : null },
      win: { rate: decided ? Math.round(approved.length / decided * 1000) / 10 : null, won: approved.length, decided },
      note: 'Approved proposals are not revenue. Revenue is recorded when invoices are paid.'
    });
  });

  app.get('/api/admin/bids', auth, (req, res) => {
    const view = req.query.view || 'all';
    let where = "WHERE e.status NOT IN ('Superseded')";
    if (view === 'estimates') where += " AND e.status IN ('Draft','Ready') AND COALESCE(e.bid_type,'proposal')<>'gc_bid'";
    else if (view === 'proposals') where += " AND e.status NOT IN ('Draft','Ready') AND COALESCE(e.bid_type,'proposal')<>'gc_bid'";
    else if (view === 'bids') where += " AND e.bid_type='gc_bid'";
    const rows = db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM estimates v WHERE COALESCE(v.root_id,v.id)=COALESCE(e.root_id,e.id)) versions FROM estimates e ${where} ORDER BY e.id DESC LIMIT 1000`).all().map(decorate);
    res.json({ estimates: rows, steps: STEPS });
  });

  app.get('/api/admin/bids/:id', auth, (req, res) => {
    const e = get(req.params.id); if (!e) return res.status(404).json({ error: 'Not found.' });
    const root = e.root_id || e.id;
    const versions = db.prepare('SELECT id, version, status, proposal_total, created_at, sent_at, decided_at, withdrawn_at FROM estimates WHERE id=? OR root_id=? ORDER BY version').all(root, root).map(v => ({ ...v, number: number({ ...v }) }));
    let comms = []; if (e.email) try { comms = db.prepare('SELECT id,to_addr,subject,status,created_at FROM email_log WHERE lower(to_addr) LIKE ? ORDER BY id DESC LIMIT 50').all('%' + String(e.email).toLowerCase() + '%'); } catch { /* */ }
    const history = db.prepare(`SELECT * FROM audit_log WHERE entity IN ('estimate','proposal') AND entity_id IN (${versions.map(v => v.id).join(',') || 0}) ORDER BY id DESC LIMIT 150`).all();
    const contract = db.prepare('SELECT * FROM contracts WHERE estimate_id=? ORDER BY id DESC').get(e.id);
    let docs = [], takeoffs = [];
    try { docs = db.prepare('SELECT id,title,kind,revision,file_name,file_url,created_at FROM documents WHERE (lead_id IS NOT NULL AND lead_id=?) ORDER BY id DESC').all(e.lead_id || -1); } catch { /* */ }
    try { takeoffs = db.prepare('SELECT id,name title,category,building_sf,status,document_id,created_at FROM takeoffs WHERE estimate_id=? ORDER BY id DESC').all(e.id); } catch { /* */ }
    res.json({ estimate: decorate(e), versions, communications: comms, history, contract, documents: docs, takeoffs, steps: STEPS, approval: gate(e) || null });
  });

  // Internal-only fields (assumptions/exclusions are customer-facing; internal notes never leave the admin).
  app.patch('/api/admin/bids/:id', auth, (req, res) => {
    const e = get(req.params.id); if (!e) return res.status(404).json({ error: 'Not found.' });
    const b = req.body || {}, set = {};
    for (const k of ['assumptions', 'exclusions', 'internal_notes']) if (k in b) set[k] = clean(b[k], 6000);
    if ('bid_type' in b) set.bid_type = b.bid_type === 'gc_bid' ? 'gc_bid' : 'proposal';
    for (const k of ['gc_name', 'bid_result']) if (k in b) set[k] = clean(b[k], 200);
    if ('bid_due_date' in b) { const d = clean(b.bid_due_date, 10); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Bid due date must be a date.' }); set.bid_due_date = d || null; }
    const keys = Object.keys(set); if (!keys.length) return res.json({ ok: true });
    if (['assumptions', 'exclusions'].some(k => k in set) && ['Sent', 'Viewed', 'Approved'].includes(e.status)) return res.status(409).json({ error: 'This proposal was already sent. Use Revise to change customer-facing terms, so the sent version stays on record.' });
    db.prepare(`UPDATE estimates SET ${keys.map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`).run(...keys.map(k => set[k]), now(), e.id);
    logAction(req, 'updated', 'estimate', e.id, keys.join(', '));
    res.json({ ok: true });
  });

  // Revise: copy into a new version. The sent version is kept unchanged and marked superseded.
  app.post('/api/admin/bids/:id/revise', auth, (req, res) => {
    const e = get(req.params.id); if (!e) return res.status(404).json({ error: 'Not found.' });
    if (!['Sent', 'Viewed', 'Declined', 'Expired', 'Approved'].includes(e.status)) return res.status(400).json({ error: 'Only a sent, declined or expired proposal needs a revision. Edit the draft directly.' });
    if (e.superseded_by) return res.status(409).json({ error: `Already revised: see version ${get(e.superseded_by)?.version}.` });
    if (e.status === 'Approved' && db.prepare('SELECT 1 FROM contracts WHERE estimate_id=?').get(e.id)) return res.status(409).json({ error: 'This proposal already has a contract. Change the contract with an amendment instead.' });
    const skip = new Set(['id', 'public_token', 'status', 'sent_at', 'viewed_at', 'last_viewed_at', 'view_count', 'decided_at', 'decision_ip', 'decision_agent', 'created_at', 'updated_at', 'version', 'root_id', 'parent_id', 'superseded_by', 'withdrawn_at', 'withdrawn_reason', 'signer_name', 'signer_title', 'signed_at', 'decline_reason', 'approved_by', 'approved_at', 'approval_fingerprint', 'approval_note']);
    skip.add('expires_on');
    const keep = db.prepare('PRAGMA table_info(estimates)').all().map(c => c.name).filter(c => !skip.has(c));
    const t = now(), root = e.root_id || e.id, exp = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const nid = db.prepare(`INSERT INTO estimates(${keep.join(',')},status,version,root_id,parent_id,public_token,expires_on,created_at,updated_at) VALUES(${keep.map(() => '?').join(',')},'Draft',?,?,?,?,?,?,?)`)
      .run(...keep.map(k => e[k]), (e.version || 1) + 1, root, e.id, require('crypto').randomBytes(24).toString('hex'), exp, t, t).lastInsertRowid;
    db.prepare("UPDATE estimates SET status='Superseded', superseded_by=?, updated_at=? WHERE id=?").run(nid, t, e.id);
    logAction(req, 'revised', 'estimate', e.id, `${number(e)} v${e.version || 1} → v${(e.version || 1) + 1} (#${nid}); old version kept as superseded`);
    res.status(201).json({ id: nid, version: (e.version || 1) + 1 });
  });

  app.post('/api/admin/bids/:id/withdraw', auth, (req, res) => {
    const e = get(req.params.id); if (!e) return res.status(404).json({ error: 'Not found.' });
    if (!['Sent', 'Viewed', 'Ready', 'Draft'].includes(e.status)) return res.status(400).json({ error: `A ${e.status.toLowerCase()} proposal cannot be withdrawn.` });
    const reason = clean((req.body || {}).reason, 500); if (!reason) return res.status(400).json({ error: 'Give a reason for withdrawing.' });
    db.prepare("UPDATE estimates SET status='Withdrawn', withdrawn_at=?, withdrawn_reason=?, updated_at=? WHERE id=?").run(now(), reason, now(), e.id);
    logAction(req, 'withdrew', 'estimate', e.id, `${number(e)}: ${reason}`);
    res.json({ ok: true });
  });

  // PDF of the customer-facing proposal (no internal costs, margins or notes).
  function proposalPdf(e) {
    const d = new Doc(), money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    d.box(0, 742, 612, 50, '0.06 0.15 0.26'); d.y = 768; d.text('BRIGHT CLEANING SEV INC.', { size: 15, bold: true, color: '1 1 1' }); d.text('PROPOSAL', { size: 15, bold: true, color: '1 1 1', align: 'right' }); d.y = 752;
    d.text('Office 515-329-5889  |  Eric Moore, Owner: 469-267-8472  |  info@brightclean.net  |  brightclean.net', { size: 8, color: '0.8 0.88 0.95' }); d.y = 718;
    d.text(`${number(e)}  v${e.version || 1}`, { size: 11, bold: true }); d.text(`Date: ${String(e.sent_at || e.created_at).slice(0, 10)}${e.expires_on ? `   Valid until: ${e.expires_on}` : ''}`, { size: 9, align: 'right' }); d.y -= 22;
    d.heading('Prepared for', 11); d.para([e.company, e.customer_name, e.email, e.site_address].filter(Boolean).join('\n'));
    if (e.project_name) { d.heading('Project', 11); d.para(e.project_name); }
    d.heading('Scope of work', 11); d.para(e.scope || '');
    let items = []; try { items = JSON.parse(e.line_items || '[]'); } catch { /* none */ }
    if (Array.isArray(items) && items.length && Number(e.use_line_items)) {
      d.heading('Pricing', 11);
      d.table([{ label: 'Item', w: 50 }, { label: 'Qty', w: 12, align: 'right' }, { label: 'Unit', w: 10 }, { label: 'Rate', w: 14, align: 'right' }, { label: 'Amount', w: 16, align: 'right' }],
        items.map(i => { const q = Number(i.quantity || i.qty || 0), r = Number(i.unit_price || i.rate || 0); return [i.description || i.name || '', q ? q.toLocaleString() : '', q ? (i.unit || '') : '', r ? money(r) : '', money(i.amount != null ? i.amount : q * r)]; }));
    }
    const taxPct = Number(e.tax_pct) || 0;
    if (taxPct > 0) { const sub = Math.round(Number(e.proposal_total) / (1 + taxPct / 100) * 100) / 100;
      d.gap(4); d.text('Subtotal before tax', { size: 10 }); d.text(money(sub), { size: 10, align: 'right' }); d.y -= 15;
      d.text(`Tax (${taxPct}%)`, { size: 10 }); d.text(money(Math.round((Number(e.proposal_total) - sub) * 100) / 100), { size: 10, align: 'right' }); d.y -= 17; }
    d.gap(4); d.text('Total', { size: 13, bold: true }); d.text(money(e.proposal_total), { size: 13, bold: true, align: 'right' }); d.y -= 22;
    if (e.assumptions) { d.heading('Assumptions', 11); d.para(e.assumptions); }
    if (e.exclusions) { d.heading('Exclusions', 11); d.para(e.exclusions); }
    if (e.terms) { d.heading('Terms', 11); d.para(e.terms, { size: 9 }); }
    d.heading('Acceptance', 11);
    if (e.signed_at) d.para(`Accepted electronically by ${e.signer_name}${e.signer_title ? ', ' + e.signer_title : ''} on ${String(e.signed_at).slice(0, 16).replace('T', ' ')} UTC.`);
    else { d.gap(18); d.rule('0.3 0.3 0.3'); d.para('Authorized signature / name / title / date', { size: 8 }); }
    d.footer(`Bright Cleaning Sev Inc. - ${number(e)} v${e.version || 1} - Office 515-329-5889 - Eric Moore (Owner) 469-267-8472`);
    return d.toBuffer();
  }
  app.get('/api/admin/bids/:id/pdf', auth, (req, res) => {
    const e = get(req.params.id); if (!e) return res.status(404).json({ error: 'Not found.' });
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${number(e)}-v${e.version || 1}.pdf"`);
    res.send(proposalPdf(e));
  });
  app.get('/api/proposal/:token/pdf', (req, res) => {
    const e = db.prepare('SELECT * FROM estimates WHERE public_token=?').get(clean(req.params.token, 100));
    if (!e || ['Draft', 'Ready'].includes(e.status)) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${number(e)}.pdf"`);
    res.send(proposalPdf(e));
  });
  app.locals.proposalNumber = number;
  return { flags, stage, number };
};
