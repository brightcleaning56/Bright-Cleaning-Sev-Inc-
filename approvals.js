// Approval levels for proposals. A proposal that trips a rule cannot be emailed, marked Sent, or opened by
// the customer until the owner approves it. Approval is tied to a fingerprint of the price, scope, lines and
// terms, so any later edit voids it automatically.
const crypto = require('crypto');
const DEFAULTS = { min_margin_pct: 15, max_total: 25000, flag_pre_pricing: true, approve_all: false };

let DB = null;
function rules() {
  const r = DB.prepare("SELECT value FROM approval_config WHERE key='rules'").get();
  try { return { ...DEFAULTS, ...(r ? JSON.parse(r.value) : {}) }; } catch { return { ...DEFAULTS }; }
}
function fingerprint(e) {
  return crypto.createHash('sha256').update(JSON.stringify([Number(e.proposal_total), Number(e.total_cost), e.scope, e.line_items, e.terms, e.expires_on, e.email])).digest('hex').slice(0, 24);
}
function actualMargin(e) {
  const price = Number(e.proposal_total) / (1 + Number(e.tax_pct || 0) / 100);
  return price > 0 ? (price - Number(e.total_cost || 0)) / price * 100 : 0;
}
// Returns { blocked, required, reasons[], approval }.
function evaluate(e) {
  const r = rules(), reasons = [];
  if (!(Number(e.proposal_total) > 0)) return { blocked: 'The proposal total is $0. Price it before sending.', required: true, reasons: ['Total is $0'], approval: null };
  const m = actualMargin(e);
  if (Number(e.total_cost) > 0 && m < r.min_margin_pct) reasons.push(`Margin ${m.toFixed(1)}% is below your ${r.min_margin_pct}% minimum`);
  if (r.max_total > 0 && Number(e.proposal_total) > r.max_total) reasons.push(`Total $${Number(e.proposal_total).toLocaleString('en-US', { maximumFractionDigits: 2 })} is above $${Number(r.max_total).toLocaleString('en-US')}`);
  if (r.flag_pre_pricing && e.lead_id) {
    const l = DB.prepare('SELECT intake FROM leads WHERE id=?').get(e.lead_id);
    try { const f = l && l.intake ? JSON.parse(l.intake).flags || [] : []; if (f.length) reasons.push(`The quote request still had ${f.length} "needed before pricing" note${f.length > 1 ? 's' : ''}`); } catch { /* no intake */ }
  }
  if (r.approve_all) reasons.push('Your settings require approval for every proposal');
  const fp = fingerprint(e);
  const last = DB.prepare('SELECT * FROM estimate_approvals WHERE estimate_id=? ORDER BY id DESC LIMIT 1').get(e.id);
  const approval = last ? { ...last, reasons: JSON.parse(last.reasons || '[]'), valid: last.fingerprint === fp } : null;
  return { blocked: null, required: reasons.length > 0, reasons, approval, margin: Math.round(m * 10) / 10 };
}
// Message to show when sending is not allowed yet, or null when it may go out.
function gate(e) {
  const v = evaluate(e);
  if (v.blocked) return v.blocked;
  if (v.required && !(v.approval && v.approval.valid)) {
    const stale = v.approval && !v.approval.valid ? ' It was approved before, but it has been edited since, so it needs approval again.' : '';
    return `This proposal needs owner approval before it goes to the customer: ${v.reasons.join('; ')}.${stale}`;
  }
  return null;
}

module.exports = function mountApprovals(app, ctx) {
  const { db, auth, logAction, clean, adminEmail } = ctx;
  DB = db;
  db.exec(`CREATE TABLE IF NOT EXISTS approval_config(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS estimate_approvals(id INTEGER PRIMARY KEY AUTOINCREMENT, estimate_id INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      reasons TEXT, note TEXT, approved_by TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS approvals_est ON estimate_approvals(estimate_id);`);
  const roleOf = req => { const e = String((req.user && req.user.email) || '').toLowerCase(); if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner'; try { const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return r ? r.role : 'staff'; } catch { return 'staff'; } };
  const isOwner = req => roleOf(req) === 'owner';
  const canApprove = req => ['owner', 'manager'].includes(roleOf(req));

  app.get('/api/admin/approval-rules', auth, (req, res) => res.json({ rules: rules(), can_change: isOwner(req) }));
  app.put('/api/admin/approval-rules', auth, (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ error: 'Only the owner can change approval rules.' });
    const b = req.body || {}, cur = rules(), next = { ...cur }, errs = [];
    if ('min_margin_pct' in b) { const v = Number(b.min_margin_pct); if (!Number.isFinite(v) || v < 0 || v > 90) errs.push('Minimum margin must be between 0 and 90%.'); else next.min_margin_pct = v; }
    if ('max_total' in b) { const v = Number(b.max_total); if (!Number.isFinite(v) || v < 0 || v > 1e8) errs.push('Total limit must be a positive amount (0 turns it off).'); else next.max_total = v; }
    for (const k of ['flag_pre_pricing', 'approve_all']) if (k in b) next[k] = !!b[k];
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    db.prepare("INSERT INTO approval_config(key,value,updated_at) VALUES('rules',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(JSON.stringify(next), new Date().toISOString());
    const changed = Object.keys(next).filter(k => next[k] !== cur[k]);
    if (changed.length) logAction(req, 'changed approval rules', 'approval', 0, changed.map(k => `${k}: ${cur[k]} → ${next[k]}`).join(', '));
    res.json({ rules: next });
  });

  app.get('/api/admin/estimates/:id/approval', auth, (req, res) => {
    const e = db.prepare('SELECT * FROM estimates WHERE id=?').get(Number(req.params.id));
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json({ ...evaluate(e), can_approve: canApprove(req), role: roleOf(req) });
  });
  app.post('/api/admin/estimates/:id/approve', auth, (req, res) => {
    if (!canApprove(req)) return res.status(403).json({ error: 'Only an owner or manager can approve proposals. Use "request approval" instead.' });
    const e = db.prepare('SELECT * FROM estimates WHERE id=?').get(Number(req.params.id));
    if (!e) return res.status(404).json({ error: 'Not found' });
    const v = evaluate(e);
    if (v.blocked) return res.status(400).json({ error: v.blocked });
    if (!v.required) return res.status(400).json({ error: 'This proposal does not need approval.' });
    if (v.approval && v.approval.valid) return res.json({ ok: true, approval: v.approval });
    const t = new Date().toISOString(), note = clean(req.body && req.body.note, 1000);
    db.prepare('INSERT INTO estimate_approvals(estimate_id,fingerprint,reasons,note,approved_by,created_at) VALUES(?,?,?,?,?,?)').run(e.id, fingerprint(e), JSON.stringify(v.reasons), note, (req.user && req.user.email) || null, t);
    logAction(req, 'approved for sending', 'estimate', e.id, v.reasons.join('; ') + (note ? ' — ' + note : ''));
    res.json({ ok: true, approval: evaluate(e).approval });
  });

  // Staff: ask the owner to approve. Creates a task for the owner and emails them.
  app.post('/api/admin/estimates/:id/request-approval', auth, async (req, res) => {
    const e = db.prepare('SELECT * FROM estimates WHERE id=?').get(Number(req.params.id)); if (!e) return res.status(404).json({ error: 'Not found' });
    const v = evaluate(e); if (!v.required) return res.status(400).json({ error: 'This proposal does not need approval.' });
    const t = new Date().toISOString(), title = `Approve proposal #${e.id} – ${e.project_name || e.customer_name}`;
    try { db.prepare(`INSERT INTO customer_issues(type,category,title,description,priority,status,assigned_to,required_action,customer_comms,created_by,created_at,updated_at) VALUES('task','Sales',?,?,'High','Open',?,?, 'Not needed',?,?,?)`)
      .run(title, v.reasons.join('; '), adminEmail || null, 'Open Estimates & proposals, review and click Approve.', (req.user && req.user.email) || null, t, t); } catch { /* issues table optional */ }
    const m = ctx.getMailer && ctx.getMailer();
    if (m && adminEmail) { try { await m.sendMail({ from: process.env.FROM_EMAIL || adminEmail, to: adminEmail, subject: title, text: `${(req.user && req.user.email) || 'A team member'} asked you to approve proposal #${e.id} for ${e.customer_name}.\nReasons: ${v.reasons.join('; ')}\nTotal: $${Number(e.proposal_total).toLocaleString('en-US')}\n\nOpen Bright Clean admin → Estimates & proposals to approve it.` }); } catch { /* email optional */ } }
    logAction(req, 'requested approval', 'estimate', e.id, v.reasons.join('; '));
    res.json({ ok: true });
  });

  app.get('/api/admin/approvals/pending', auth, (req, res) => {
    const rows = db.prepare("SELECT * FROM estimates WHERE status IN ('Draft','Ready')").all()
      .map(e => ({ e, v: evaluate(e) })).filter(x => !x.v.blocked && x.v.required && !(x.v.approval && x.v.approval.valid));
    res.json({ pending: rows.map(x => ({ id: x.e.id, customer_name: x.e.customer_name, project_name: x.e.project_name, proposal_total: x.e.proposal_total, reasons: x.v.reasons })) });
  });
};
module.exports.gate = gate;
module.exports.pendingCount = () => DB ? DB.prepare("SELECT * FROM estimates WHERE status IN ('Draft','Ready')").all().map(evaluate).filter(v => !v.blocked && v.required && !(v.approval && v.approval.valid)).length : 0;
module.exports.evaluate = evaluate;
