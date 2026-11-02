// Customer notes, complaints, tasks and follow-ups. Internal only: no public route reads this table.
const TYPES = { note: 'Note', complaint: 'Complaint', task: 'Task', follow_up: 'Follow-up' };
const CATEGORIES = ['Quality', 'Schedule', 'Billing', 'Safety', 'Damage', 'Staff conduct', 'Site access', 'Scope change', 'Sales', 'Other'];
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
const STATUSES = ['Open', 'In progress', 'Resolved', 'Closed'];
const COMMS = ['Not needed', 'Needs update', 'Customer informed'];

module.exports = function mountIssues(app, ctx) {
  const { db, auth, logAction, clean, adminEmail } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS customer_issues(
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, type TEXT NOT NULL, category TEXT, title TEXT NOT NULL, description TEXT,
    property TEXT, priority TEXT NOT NULL DEFAULT 'Normal', status TEXT NOT NULL DEFAULT 'Open', assigned_to TEXT, due_date TEXT,
    required_action TEXT, resolution TEXT, customer_comms TEXT NOT NULL DEFAULT 'Not needed', created_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT);
    CREATE INDEX IF NOT EXISTS issues_customer ON customer_issues(customer_id);
    CREATE INDEX IF NOT EXISTS issues_status ON customer_issues(status);`);

  const now = () => new Date().toISOString();
  const today = () => now().slice(0, 10);
  const users = () => {
    const rows = db.prepare('SELECT email FROM admin_users').all().map(r => r.email.toLowerCase());
    return [...new Set([...(adminEmail ? [adminEmail.toLowerCase()] : []), ...rows])];
  };
  const isOpen = s => s === 'Open' || s === 'In progress';

  function validate(b, cur) {
    const out = {}, errs = [];
    const pick = (k, list, label) => { if (k in b) { if (!list.includes(b[k])) errs.push(`Choose a valid ${label}.`); else out[k] = b[k]; } };
    if (!cur || 'type' in b) { if (!TYPES[b.type]) errs.push('Choose a type: note, complaint, task or follow-up.'); else out.type = b.type; }
    if (!cur || 'title' in b) { const t = clean(b.title, 200); if (!t) errs.push('A short title is required.'); else out.title = t; }
    pick('category', ['', ...CATEGORIES], 'category'); pick('priority', PRIORITIES, 'priority');
    pick('status', STATUSES, 'status'); pick('customer_comms', COMMS, 'customer update status');
    for (const k of ['description', 'property', 'required_action', 'resolution']) if (k in b) out[k] = clean(b[k], 5000);
    if ('due_date' in b) { const d = clean(b.due_date, 10); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) errs.push('Due date must be a date.'); else out.due_date = d || null; }
    if ('assigned_to' in b) { const a = clean(b.assigned_to, 254).toLowerCase(); if (a && !users().includes(a)) errs.push('Assign to someone who has access to Bright Clean.'); else out.assigned_to = a || null; }
    if ('customer_id' in b) {
      const id = b.customer_id === '' || b.customer_id == null ? null : Number(b.customer_id);
      if (id !== null && !db.prepare('SELECT 1 FROM customers WHERE id=?').get(id)) errs.push('That customer was not found.');
      else out.customer_id = id;
    }
    const merged = { ...(cur || {}), ...out };
    if (!isOpen(merged.status || 'Open') && ['complaint', 'task'].includes(merged.type) && !String(merged.resolution || '').trim())
      errs.push(`Describe how this ${TYPES[merged.type].toLowerCase()} was resolved before closing it.`);
    if (merged.type === 'complaint' && !isOpen(merged.status || 'Open') && merged.customer_comms === 'Needs update')
      errs.push('Update the customer (or mark "Not needed") before closing a complaint.');
    return { out, errs, merged };
  }

  const decorate = r => ({ ...r, overdue: isOpen(r.status) && !!r.due_date && r.due_date < today() });
  const SELECT = `SELECT i.*, c.name customer_name, c.company customer_company, c.email customer_email FROM customer_issues i LEFT JOIN customers c ON c.id=i.customer_id`;

  app.get('/api/admin/issues', auth, (req, res) => {
    const where = [], args = [];
    if (req.query.customer_id) { where.push('i.customer_id=?'); args.push(Number(req.query.customer_id)); }
    if (TYPES[req.query.type]) { where.push('i.type=?'); args.push(req.query.type); }
    const st = req.query.status || 'open';
    if (st === 'open') where.push("i.status IN ('Open','In progress')");
    else if (st === 'overdue') { where.push("i.status IN ('Open','In progress') AND i.due_date IS NOT NULL AND i.due_date<>'' AND i.due_date<?"); args.push(today()); }
    else if (st === 'done') where.push("i.status IN ('Resolved','Closed')");
    if (req.query.assigned === 'me' && req.user && req.user.email) { where.push('lower(i.assigned_to)=?'); args.push(req.user.email.toLowerCase()); }
    const rows = db.prepare(`${SELECT}${where.length ? ' WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE WHEN i.status IN ('Open','In progress') THEN 0 ELSE 1 END, CASE i.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Normal' THEN 2 ELSE 3 END,
      COALESCE(NULLIF(i.due_date,''),'9999') , i.id DESC LIMIT 500`).all(...args).map(decorate);
    const counts = db.prepare(`SELECT
      SUM(status IN ('Open','In progress')) open, SUM(status IN ('Open','In progress') AND type='complaint') open_complaints,
      SUM(status IN ('Open','In progress') AND due_date IS NOT NULL AND due_date<>'' AND due_date<?) overdue,
      SUM(status IN ('Open','In progress') AND priority='Urgent') urgent FROM customer_issues`).get(today());
    res.json({ issues: rows, counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v || 0])),
      options: { types: TYPES, categories: CATEGORIES, priorities: PRIORITIES, statuses: STATUSES, comms: COMMS, users: users() } });
  });

  app.post('/api/admin/issues', auth, (req, res) => {
    const b = { status: 'Open', priority: 'Normal', customer_comms: 'Not needed', ...(req.body || {}) };
    if (b.type === 'note' && !('status' in (req.body || {}))) b.status = 'Closed';
    const { out, errs } = validate(b, null);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const t = now(), cols = Object.keys(out);
    const info = db.prepare(`INSERT INTO customer_issues(${cols.join(',')},created_by,created_at,updated_at,resolved_at) VALUES(${cols.map(() => '?').join(',')},?,?,?,?)`)
      .run(...cols.map(c => out[c]), (req.user && req.user.email) || null, t, t, isOpen(out.status) ? null : t);
    logAction(req, 'created', TYPES[out.type].toLowerCase(), info.lastInsertRowid, out.title);
    res.status(201).json({ issue: decorate(db.prepare(`${SELECT} WHERE i.id=?`).get(info.lastInsertRowid)) });
  });

  app.patch('/api/admin/issues/:id', auth, (req, res) => {
    const cur = db.prepare('SELECT * FROM customer_issues WHERE id=?').get(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Item not found.' });
    const { out, errs, merged } = validate(req.body || {}, cur);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const cols = Object.keys(out);
    if (!cols.length) return res.json({ issue: decorate(db.prepare(`${SELECT} WHERE i.id=?`).get(cur.id)) });
    const closing = isOpen(cur.status) && !isOpen(merged.status), reopening = !isOpen(cur.status) && isOpen(merged.status);
    db.prepare(`UPDATE customer_issues SET ${cols.map(c => c + '=?').join(',')}, updated_at=?${closing ? ', resolved_at=?' : reopening ? ', resolved_at=NULL' : ''} WHERE id=?`)
      .run(...cols.map(c => out[c]), now(), ...(closing ? [now()] : []), cur.id);
    const label = TYPES[merged.type].toLowerCase();
    if (closing) logAction(req, 'resolved', label, cur.id, `${merged.title}: ${clean(merged.resolution, 200)}`);
    else if (reopening) logAction(req, 'reopened', label, cur.id, merged.title);
    else logAction(req, 'updated', label, cur.id, cols.filter(c => String(out[c] ?? '') !== String(cur[c] ?? '')).join(', ') || merged.title);
    res.json({ issue: decorate(db.prepare(`${SELECT} WHERE i.id=?`).get(cur.id)) });
  });

  // Only plain notes can be deleted; complaints, tasks and follow-ups are closed so the history stays.
  app.delete('/api/admin/issues/:id', auth, (req, res) => {
    const cur = db.prepare('SELECT * FROM customer_issues WHERE id=?').get(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Item not found.' });
    if (cur.type !== 'note') return res.status(400).json({ error: 'Complaints, tasks and follow-ups are closed, not deleted, so their history is kept.' });
    db.prepare('DELETE FROM customer_issues WHERE id=?').run(cur.id);
    logAction(req, 'deleted', 'note', cur.id, cur.title);
    res.json({ ok: true });
  });
};
module.exports.TYPES = TYPES;
