// Equipment and facility maintenance: vans, vacuums, machines and facility items on a service interval.
// Each record keeps its last service date and its next due date. Items that are due join the work queue
// (department "maintenance"), where they can be assigned, scheduled or marked serviced. Owners, managers and
// supervisors change them; everyone with admin access can read them.
const { today: bizToday } = require('./bizdate');

const CATEGORIES = ['Van', 'Vacuum', 'Machine', 'Facility', 'Other'];
const WRITERS = ['owner', 'manager', 'supervisor'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar date: the text must read back unchanged (so 2026-02-31 is refused, not rolled over).
const validDate = s => ISO.test(String(s || '')) && !isNaN(Date.parse(s)) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// Pure: the date a service interval later, as YYYY-MM-DD (UTC arithmetic on calendar dates, so no time zone drift).
function addDays(date, days) {
  const d = new Date(String(date) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

// Pure: the bucket of a record on the queue, from its next due date alone.
function bucketFor(nextDue, today) {
  if (!validDate(nextDue)) return 'new';
  if (nextDue > today) return 'scheduled';
  if (nextDue === today) return 'today';
  return 'overdue';
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_items(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Other',
    location TEXT, interval_days INTEGER NOT NULL DEFAULT 90, last_service_date TEXT, next_due TEXT,
    assigned_to TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT)`);
}

const getItem = (db, id) => db.prepare('SELECT * FROM maintenance_items WHERE id=?').get(Number(id));

function createItem(db, b, now = new Date().toISOString()) {
  const name = String(b.name || '').trim();
  if (!name) throw new Error('Name the equipment or facility item.');
  const category = CATEGORIES.includes(b.category) ? b.category : 'Other';
  const interval = Math.round(Number(b.interval_days));
  if (!(interval >= 1 && interval <= 3650)) throw new Error('The service interval must be between 1 and 3650 days.');
  const last = b.last_service_date ? String(b.last_service_date) : null;
  if (last && !validDate(last)) throw new Error('The last service date is not a valid date.');
  const next = last ? addDays(last, interval) : (b.next_due && validDate(b.next_due) ? String(b.next_due) : null);
  const info = db.prepare(`INSERT INTO maintenance_items(name,category,location,interval_days,last_service_date,next_due,notes,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,1,?,?)`).run(name, category, String(b.location || '').trim() || null, interval, last, next,
    String(b.notes || '').trim() || null, now, now);
  return getItem(db, info.lastInsertRowid);
}

// One queue action on a record: assign, schedule (set the due date) or serviced (service done today, the next due date moves on).
function applyMaintenanceAction(db, id, b, who, today = bizToday(), now = new Date().toISOString()) {
  const item = getItem(db, id);
  if (!item || !item.active) throw new Error('That equipment is not on the list.');
  const action = String(b.action || '');
  if (action === 'assign') {
    const to = String(b.assigned_to || '').trim().toLowerCase() || null;
    db.prepare('UPDATE maintenance_items SET assigned_to=?, updated_at=? WHERE id=?').run(to, now, item.id);
  } else if (action === 'schedule') {
    if (!validDate(b.date)) throw new Error('Pick a real due date.');
    db.prepare('UPDATE maintenance_items SET next_due=?, updated_at=? WHERE id=?').run(String(b.date), now, item.id);
  } else if (action === 'serviced') {
    const date = b.date ? String(b.date) : today;
    if (!validDate(date)) throw new Error('The service date is not a valid date.');
    db.prepare('UPDATE maintenance_items SET last_service_date=?, next_due=?, updated_at=? WHERE id=?')
      .run(date, addDays(date, item.interval_days), now, item.id);
  } else {
    throw new Error('Unknown maintenance action.');
  }
  return getItem(db, item.id);
}

// Rows for the work queue, in the same shape as the other departments.
function queueRows(db, today) {
  ensureTable(db);
  return db.prepare('SELECT * FROM maintenance_items WHERE active=1 ORDER BY next_due IS NULL, next_due, id').all().map(r => ({
    dept: 'maintenance', id: r.id, title: `${r.name} · ${r.category}`, who: r.location || '', when: r.created_at,
    assigned_to: r.assigned_to || null, lead_id: null, customer_id: null, due: r.next_due || null,
    bucket: bucketFor(r.next_due, today), note: r.notes || '', status: r.next_due ? 'due' : 'no date',
  }));
}

function roleOf(db, req) {
  const em = String((req.user && req.user.email) || '').toLowerCase(), ow = String(process.env.ADMIN_EMAIL || '').toLowerCase();
  if (!ow || em === ow) return 'owner';
  return ((db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(em)) || {}).role || 'staff';
}

function mount(app, { db, auth, logAction }) {
  ensureTable(db);
  const writerOnly = (req, res, next) => (WRITERS.includes(roleOf(db, req)) ? next() : res.status(403).json({ error: 'Only an owner, manager or supervisor can change maintenance records.' }));
  app.get('/api/admin/maintenance', auth, (req, res) => {
    res.json({ items: db.prepare('SELECT * FROM maintenance_items WHERE active=1 ORDER BY next_due IS NULL, next_due, id').all(), categories: CATEGORIES });
  });
  app.post('/api/admin/maintenance', auth, writerOnly, (req, res) => {
    try {
      const item = createItem(db, req.body || {});
      logAction(req, 'added', 'maintenance', item.id, item.name);
      res.json({ ok: true, item });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/maintenance/:id/work', auth, writerOnly, (req, res) => {
    const who = (req.user && req.user.email) || 'admin';
    try {
      const item = applyMaintenanceAction(db, req.params.id, req.body || {}, who);
      logAction(req, `maintenance ${String((req.body || {}).action || '')}`, 'maintenance', item.id, item.name);
      res.json({ ok: true, item });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = mount;
module.exports.CATEGORIES = CATEGORIES;
module.exports.addDays = addDays;
module.exports.bucketFor = bucketFor;
module.exports.ensureTable = ensureTable;
module.exports.createItem = createItem;
module.exports.applyMaintenanceAction = applyMaintenanceAction;
module.exports.queueRows = queueRows;
