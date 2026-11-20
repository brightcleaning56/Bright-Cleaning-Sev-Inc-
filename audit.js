// Accounting audit events (audit G15): who did what to the books, when, and why. Written by the accounting actions
// (sync, reversal, period close, reconciliation, sales tax change). Append only; there is no edit or delete route.
const r = s => String(s == null ? '' : s);

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS accounting_audit_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
    entity TEXT, entity_id TEXT, detail TEXT)`);
}

function record(db, { actor, action, entity = null, entityId = null, detail = null }) {
  ensureSchema(db);
  db.prepare('INSERT INTO accounting_audit_events(at,actor,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)')
    .run(new Date().toISOString(), r(actor).slice(0, 200) || 'system', r(action).slice(0, 120), r(entity) || null, entityId == null ? null : r(entityId), r(detail).slice(0, 500) || null);
}

function list(db, limit = 200) {
  ensureSchema(db);
  return db.prepare('SELECT * FROM accounting_audit_events ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(Number(limit) || 200, 1), 1000));
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  ensureSchema(db);
  app.get('/api/admin/ledger/audit', auth, (req, res) => res.json({ events: list(db, req.query.limit) }));
}

module.exports = { ensureSchema, record, list, mount };
