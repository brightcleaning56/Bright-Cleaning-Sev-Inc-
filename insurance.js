// Certificate directory: the company's own insurance (general liability, workers' comp, auto, umbrella, bond)
// and subcontractor certificates, with expiry status so an expired policy is caught before a bid or a job.
// Owners and managers only (see the access rules in server.js).
const TYPES = ['general_liability', 'workers_comp', 'auto', 'umbrella', 'bond', 'subcontractor', 'other'];
const DAY = 24 * 60 * 60 * 1000;
const INS_LABELS = { general_liability: 'General liability', workers_comp: 'Workers\u2019 comp', auto: 'Auto', umbrella: 'Umbrella', bond: 'Bond', subcontractor: 'Subcontractor', other: 'Other' };

// Days from today until the expiry date (negative once it has passed). Null when there is no date.
function daysUntil(expires, today = new Date()) {
  if (!expires) return null;
  const end = Date.parse(expires + 'T00:00:00Z');
  if (Number.isNaN(end)) return null;
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((end - t) / DAY);
}

// 'expired' | 'expiring' (within 30 days) | 'ok' | 'no_date'
function status(expires, today = new Date()) {
  const d = daysUntil(expires, today);
  if (d === null) return 'no_date';
  if (d < 0) return 'expired';
  if (d <= 30) return 'expiring';
  return 'ok';
}

module.exports = (app, { db, auth, logAction, clean, adminEmail, getMailer }) => {
  db.exec(`CREATE TABLE IF NOT EXISTS insurance_certificates(
    id INTEGER PRIMARY KEY AUTOINCREMENT, holder TEXT NOT NULL, kind TEXT NOT NULL, carrier TEXT,
    policy_no TEXT, expires_on TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  try { db.exec('ALTER TABLE insurance_certificates ADD COLUMN alerted_status TEXT'); } catch (e) { /* column already exists */ }

  // Emails the owner once for each certificate that becomes expiring or expired (not again until the status changes).
  async function checkExpiry() {
    const today = new Date();
    const rows = db.prepare('SELECT * FROM insurance_certificates WHERE expires_on IS NOT NULL').all();
    const due = rows.map(r => ({ r, st: status(r.expires_on, today) }))
      .filter(x => (x.st === 'expiring' || x.st === 'expired') && x.r.alerted_status !== x.st);
    if (!due.length) return { checked: rows.length, sent: 0 };
    const to = String(process.env.NOTIFY_EMAIL || adminEmail || '');
    const m = getMailer && getMailer();
    if (!m || !to) return { checked: rows.length, sent: 0, skipped: !to ? 'no recipient configured' : 'email not configured' };
    const lines = due.map(({ r, st }) => (st === 'expired' ? 'EXPIRED: ' : 'Expires within 30 days: ') + r.holder + ' (' + (INS_LABELS[r.kind] || r.kind) + ') until ' + r.expires_on + (r.carrier ? ' · ' + r.carrier : ''));
    try {
      await m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || adminEmail, to,
        subject: 'Insurance: ' + due.length + ' certificate' + (due.length === 1 ? '' : 's') + ' need attention',
        text: lines.join('\n') + '\n\nReview them in the admin portal under Insurance.' });
    } catch (e) { return { checked: rows.length, sent: 0, error: e.message }; }
    const upd = db.prepare('UPDATE insurance_certificates SET alerted_status=? WHERE id=?');
    for (const { r, st } of due) upd.run(st, r.id);
    return { checked: rows.length, sent: due.length };
  }

  app.post('/api/admin/insurance/check-expiry', auth, async (req, res) => {
    const out = await checkExpiry();
    logAction(req, 'checked', 'insurance', null, 'expiry check: ' + (out.sent || 0) + ' alert(s) sent');
    res.json(out);
  });

  if (!process.env.DISABLE_SCHEDULER) {
    const timer = setInterval(() => { checkExpiry().catch(e => console.error('insurance check:', e.message)); }, Number(process.env.INSURANCE_SWEEP_MS || 6 * 60 * 60 * 1000));
    timer.unref && timer.unref();
    setTimeout(() => { checkExpiry().catch(() => {}); }, 120000).unref?.();
  }

  // ---- Certificates attached to an estimate or proposal, and the insurance a client requires ----
  try { db.exec('ALTER TABLE estimates ADD COLUMN required_insurance TEXT'); } catch (e) { /* already there */ }
  db.exec('CREATE TABLE IF NOT EXISTS estimate_certificates(estimate_id INTEGER NOT NULL, certificate_id INTEGER NOT NULL, PRIMARY KEY(estimate_id, certificate_id))');
  const KIND_LABEL = { general_liability: 'General liability', workers_comp: 'Workers comp', auto: 'Auto', umbrella: 'Umbrella', bond: 'Bond', subcontractor: 'Subcontractor', other: 'Other' };
  const requiredOf = est => { try { const v = JSON.parse((est && est.required_insurance) || '[]'); return Array.isArray(v) ? v.filter(t => TYPES.includes(t)) : []; } catch { return []; } };
  const attachedOf = id => db.prepare('SELECT c.* FROM estimate_certificates ec JOIN insurance_certificates c ON c.id = ec.certificate_id WHERE ec.estimate_id=? ORDER BY c.expires_on IS NULL, c.expires_on').all(id).map(r => ({ ...r, status: status(r.expires_on) }));
  // Requirements the attached certificates do not meet. A certificate counts only when it has an expiry date and is not expired.
  const gapsFor = id => {
    const est = db.prepare('SELECT required_insurance FROM estimates WHERE id=?').get(id);
    if (!est) return [];
    const good = attachedOf(id).filter(c => c.status === 'ok' || c.status === 'expiring');
    return requiredOf(est).filter(t => !good.some(c => c.kind === t)).map(t => KIND_LABEL[t] || t);
  };
  module.exports.requirementGaps = id => gapsFor(Number(id));
  module.exports.attachedFor = id => attachedOf(Number(id));
  module.exports.KIND_LABEL = KIND_LABEL;

  app.get('/api/admin/estimates/:id/insurance', auth, (req, res) => {
    const id = Number(req.params.id);
    const est = db.prepare('SELECT id, required_insurance FROM estimates WHERE id=?').get(id);
    if (!est) return res.status(404).json({ error: 'Estimate not found.' });
    res.json({ required: requiredOf(est), attached: attachedOf(id), missing: gapsFor(id) });
  });
  app.put('/api/admin/estimates/:id/insurance', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM estimates WHERE id=?').get(id)) return res.status(404).json({ error: 'Estimate not found.' });
    const want = [...new Set(Array.isArray((req.body || {}).required) ? req.body.required : [])];
    const bad = want.filter(t => !TYPES.includes(t));
    if (bad.length) return res.status(400).json({ error: 'Unknown insurance type: ' + bad.join(', ') + '.' });
    db.prepare('UPDATE estimates SET required_insurance=? WHERE id=?').run(JSON.stringify(want), id);
    logAction(req, 'set insurance requirements', 'estimate', id, want.join(', ') || 'none');
    res.json({ ok: true, missing: gapsFor(id) });
  });
  app.post('/api/admin/estimates/:id/insurance/:certId', auth, (req, res) => {
    const id = Number(req.params.id), cid = Number(req.params.certId);
    if (!db.prepare('SELECT id FROM estimates WHERE id=?').get(id)) return res.status(404).json({ error: 'Estimate not found.' });
    if (!db.prepare('SELECT id FROM insurance_certificates WHERE id=?').get(cid)) return res.status(404).json({ error: 'Certificate not found.' });
    db.prepare('INSERT OR IGNORE INTO estimate_certificates(estimate_id, certificate_id) VALUES(?,?)').run(id, cid);
    logAction(req, 'attached certificate', 'estimate', id, 'certificate #' + cid);
    res.json({ ok: true, missing: gapsFor(id) });
  });
  app.delete('/api/admin/estimates/:id/insurance/:certId', auth, (req, res) => {
    const id = Number(req.params.id), cid = Number(req.params.certId);
    db.prepare('DELETE FROM estimate_certificates WHERE estimate_id=? AND certificate_id=?').run(id, cid);
    logAction(req, 'removed certificate', 'estimate', id, 'certificate #' + cid);
    res.json({ ok: true, missing: gapsFor(id) });
  });

  app.get('/api/admin/insurance', auth, (req, res) => {
    const rows = db.prepare('SELECT * FROM insurance_certificates ORDER BY expires_on IS NULL, expires_on, holder').all();
    res.json(rows.map(r => ({ ...r, status: status(r.expires_on) })));
  });

  app.post('/api/admin/insurance', auth, (req, res) => {
    const b = req.body || {};
    const holder = clean(b.holder, 200), kind = String(b.kind || '');
    const expires = b.expires_on ? String(b.expires_on).slice(0, 10) : '';
    if (!holder) return res.status(400).json({ error: 'Name the policy holder or subcontractor.' });
    if (!TYPES.includes(kind)) return res.status(400).json({ error: 'Choose a certificate type: ' + TYPES.join(', ') + '.' });
    if (expires && (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(expires + 'T00:00:00Z')))) {
      return res.status(400).json({ error: 'The expiry date must be a valid date (YYYY-MM-DD).' });
    }
    const now = new Date().toISOString();
    const info = db.prepare('INSERT INTO insurance_certificates(holder,kind,carrier,policy_no,expires_on,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(holder, kind, clean(b.carrier, 200), clean(b.policy_no, 100), expires || null, clean(b.notes, 1000), now, now);
    logAction(req, 'added', 'insurance', info.lastInsertRowid, `${holder} ${kind}`);
    res.json({ ok: true, id: info.lastInsertRowid });
  });

  app.delete('/api/admin/insurance/:id', auth, (req, res) => {
    const r = db.prepare('SELECT * FROM insurance_certificates WHERE id=?').get(Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'Certificate not found.' });
    db.prepare('DELETE FROM insurance_certificates WHERE id=?').run(r.id);
    logAction(req, 'removed', 'insurance', r.id, `${r.holder} ${r.kind}`);
    res.json({ ok: true });
  });
};
module.exports.status = status;
module.exports.daysUntil = daysUntil;
module.exports.TYPES = TYPES;
