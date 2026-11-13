// Lead intake for other sources (partner sites, ad landing pages, Zapier, a CRM, a phone tool).
// Owners create API keys in Settings. A key is shown once, stored only as a hash, and can be revoked at any time.
// Other systems send leads to POST /api/integrations/leads with the key in the X-API-Key header (or as a Bearer token).
// Every lead records which key sent it, so you always know where a lead came from.
const crypto = require('crypto');

const { createLeadNotifier } = require('./lead-notify');

module.exports = function (app, { db, auth, logAction, clean, isEmail, notify }) {
  // Bursts from one source send one digest instead of one email per lead. Every lead is still saved.
  const leadNotifier = createLeadNotifier({ notify, to: process.env.NOTIFY_EMAIL });
  db.exec(`CREATE TABLE IF NOT EXISTS api_keys(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, created_by TEXT, last_used_at TEXT, revoked_at TEXT)`);
  const sha = k => crypto.createHash('sha256').update(String(k)).digest('hex');
  const now = () => new Date().toISOString();

  app.get('/api/admin/api-keys', auth, (req, res) =>
    res.json({ keys: db.prepare('SELECT id,name,prefix,created_at,created_by,last_used_at,revoked_at FROM api_keys ORDER BY id DESC').all() }));

  // Creates a key. The full key is returned ONCE here and never shown again.
  app.post('/api/admin/api-keys', auth, (req, res) => {
    const name = clean((req.body || {}).name, 80);
    if (!name) return res.status(400).json({ error: 'Give the key a name, for example "Partner website" or "Zapier".' });
    const key = 'bc_live_' + crypto.randomBytes(24).toString('base64url');
    const id = db.prepare('INSERT INTO api_keys(name,prefix,key_hash,created_at,created_by) VALUES(?,?,?,?,?)')
      .run(name, key.slice(0, 12), sha(key), now(), req.user && req.user.email).lastInsertRowid;
    logAction(req, 'created API key', 'api_key', id, name);
    res.status(201).json({ id, name, prefix: key.slice(0, 12), key });
  });

  // Revokes a key immediately. Its history (and the leads it sent) stays.
  app.post('/api/admin/api-keys/:id(\\d+)/revoke', auth, (req, res) => {
    const row = db.prepare('SELECT * FROM api_keys WHERE id=?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Key not found.' });
    if (row.revoked_at) return res.json({ ok: true, already: true });
    db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=?').run(now(), row.id);
    logAction(req, 'revoked API key', 'api_key', row.id, row.name);
    res.json({ ok: true });
  });

  // Intake: other sources send a lead here.
  app.post('/api/integrations/leads', (req, res) => {
    const raw = String(req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer /i, '') || '').trim();
    const key = raw && db.prepare('SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL').get(sha(raw));
    if (!key) return res.status(401).json({ error: 'Invalid or revoked API key.' });
    const b = req.body || {};
    const name = clean(b.name || b.contact_name, 150), email = clean(b.email, 254), phone = clean(b.phone, 60);
    const company = clean(b.company, 200), project = clean(b.project_name || b.project, 200), service = clean(b.service, 300);
    const details = clean(b.details || b.message || b.notes, 5000), source = clean(b.source, 80);
    if (!name && !email && !phone) return res.status(400).json({ error: 'Send at least a name, an email or a phone number.' });
    if (email && !isEmail(email)) return res.status(400).json({ error: 'That email address is not valid.' });
    const label = 'API: ' + key.name + (source ? ' · ' + source : '');
    const id = db.prepare("INSERT INTO leads(kind,contact_name,company,email,phone,project_name,service,details,status,intake,created_at,origin) VALUES('inquiry',?,?,?,?,?,?,?,'New',?,?,'api')")
      .run(name, company, email, phone, project, service, details, label, now()).lastInsertRowid;
    db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now(), key.id);
    logAction({ user: { email: 'api:' + key.name } }, 'received lead', 'lead', id, label);
    if (notify) leadNotifier.leadArrived(key.id, key.name, `${name || 'Unnamed'}${company ? ' · ' + company : ''}\n${email ? 'Email: ' + email + '\n' : ''}${phone ? 'Phone: ' + phone + '\n' : ''}${project ? 'Project: ' + project + '\n' : ''}${details ? '\n' + details : ''}\n\nSource: ${label}`);
    res.status(201).json({ ok: true, id });
  });
};
