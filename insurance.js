// Certificate directory: the company's own insurance (general liability, workers' comp, auto, umbrella, bond)
// and subcontractor certificates, with expiry status so an expired policy is caught before a bid or a job.
// Owners and managers only (see the access rules in server.js).
const TYPES = ['general_liability', 'workers_comp', 'auto', 'umbrella', 'bond', 'subcontractor', 'other'];
const DAY = 24 * 60 * 60 * 1000;

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

module.exports = (app, { db, auth, logAction, clean }) => {
  db.exec(`CREATE TABLE IF NOT EXISTS insurance_certificates(
    id INTEGER PRIMARY KEY AUTOINCREMENT, holder TEXT NOT NULL, kind TEXT NOT NULL, carrier TEXT,
    policy_no TEXT, expires_on TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);

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
