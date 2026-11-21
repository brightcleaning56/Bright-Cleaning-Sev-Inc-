// One work lifecycle for every kind of work item: email, call, lead follow-up, project task, issue, inspection item,
// estimate or approval, invoice follow-up and maintenance requests.
//
// Rules (from the Bright Clean operating spec):
//   - Opening an item does not change it. Starting work moves it to In progress.
//   - Completing needs a note. Completed items leave the active queue and stay in history.
//   - Cancelling needs a reason. Cancelled items leave the queue and stay in history.
//   - Reopening needs a reason, and returns the item to the active queue.
//   - Waiting needs what it is waiting on and the next follow-up date; it stays visible until then.
//   - Reassigning updates the owner; the old and new employee's queues both change.
//   - An item is one record per (kind, ref_type, ref_id) while it is active: creating it again returns the same item.
//   - Every change writes a history row with who, when, what changed and why.
//
// This module owns the lifecycle. Each module keeps its own records and asks this module to move the work.

const KINDS = ['email', 'call', 'lead', 'project_task', 'issue', 'inspection', 'estimate', 'invoice', 'maintenance', 'other'];
const ACTIVE = ['open', 'in_progress', 'waiting'];
const TERMINAL = ['completed', 'cancelled'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// action -> { from: states it may start from, to: resulting state, needs: fields that must be filled }
const ACTIONS = {
  start:    { from: ['open', 'waiting'], to: 'in_progress', needs: [] },
  wait:     { from: ['open', 'in_progress'], to: 'waiting', needs: ['waiting_on', 'next_follow_up'] },
  complete: { from: ['open', 'in_progress', 'waiting'], to: 'completed', needs: ['note'] },
  cancel:   { from: ['open', 'in_progress', 'waiting'], to: 'cancelled', needs: ['reason'] },
  reopen:   { from: ['completed', 'cancelled'], to: 'open', needs: ['reason'] },
  reassign: { from: ['open', 'in_progress', 'waiting'], to: null, needs: ['assigned_to'] },
  edit:     { from: ['open', 'in_progress', 'waiting'], to: null, needs: [] }
};

const r = v => (v == null ? null : String(v).trim() || null);
const isDate = s => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; };
const nowIso = () => new Date().toISOString();
const today = () => require('./bizdate').today();

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS work_items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL, ref_type TEXT, ref_id INTEGER,
    title TEXT NOT NULL, detail TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'normal',
    assigned_to TEXT, due_date TEXT,
    waiting_on TEXT, next_follow_up TEXT,
    completion_note TEXT, cancel_reason TEXT, reopen_reason TEXT,
    created_by TEXT, created_at TEXT NOT NULL,
    updated_by TEXT, updated_at TEXT NOT NULL,
    completed_at TEXT, cancelled_at TEXT);
  CREATE INDEX IF NOT EXISTS work_items_active ON work_items(status, assigned_to);
  CREATE INDEX IF NOT EXISTS work_items_ref ON work_items(kind, ref_type, ref_id);
  CREATE TABLE IF NOT EXISTS work_item_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES work_items(id),
    at TEXT NOT NULL, by TEXT,
    action TEXT NOT NULL, from_status TEXT, to_status TEXT,
    detail TEXT);
  CREATE INDEX IF NOT EXISTS work_item_events_item ON work_item_events(item_id);`);
}

function history(db, itemId, { action, from, to, by, detail }) {
  db.prepare('INSERT INTO work_item_events(item_id,at,by,action,from_status,to_status,detail) VALUES(?,?,?,?,?,?,?)')
    .run(itemId, nowIso(), by || null, action, from || null, to || null, detail ? String(detail).slice(0, 1000) : null);
}

// Creates a work item, or returns the active one for the same record (no duplicates).
function create(db, { kind, ref_type = null, ref_id = null, title, detail = null, assigned_to = null, due_date = null, priority = 'normal', by = null }) {
  ensureSchema(db);
  if (!KINDS.includes(kind)) throw new Error('Unknown kind of work: ' + kind);
  const t = r(title);
  if (!t) throw new Error('A work item needs a title.');
  if (due_date && !isDate(due_date)) throw new Error('Due date must be a real date (YYYY-MM-DD).');
  if (!PRIORITIES.includes(priority)) throw new Error('Choose a valid priority.');
  if (ref_id != null) {
    const existing = db.prepare(`SELECT id FROM work_items WHERE kind=? AND ref_type IS ? AND ref_id=? AND status IN ('open','in_progress','waiting') ORDER BY id LIMIT 1`).get(kind, ref_type, Number(ref_id));
    if (existing) return { id: existing.id, created: false };
  }
  const at = nowIso();
  const id = db.prepare(`INSERT INTO work_items(kind,ref_type,ref_id,title,detail,status,priority,assigned_to,due_date,created_by,created_at,updated_by,updated_at)
    VALUES(?,?,?,?,?,'open',?,?,?,?,?,?,?)`).run(kind, ref_type, ref_id == null ? null : Number(ref_id), t.slice(0, 300), r(detail), priority, r(assigned_to), due_date || null, by, at, by, at).lastInsertRowid;
  history(db, id, { action: 'created', to: 'open', by, detail: t });
  return { id: Number(id), created: true };
}

// Moves an item along the lifecycle. Returns the updated item. Throws an Error with a plain message when the move is not allowed.
function act(db, itemId, action, body = {}, by = null) {
  ensureSchema(db);
  const rule = ACTIONS[action];
  if (!rule) throw new Error('Unknown action: ' + action);
  const it = db.prepare('SELECT * FROM work_items WHERE id=?').get(Number(itemId));
  if (!it) throw new Error('Work item not found.');
  if (!rule.from.includes(it.status)) {
    throw new Error(`This item is ${it.status.replace('_', ' ')}, so it cannot be ${action === 'reopen' ? 'reopened' : action === 'reassign' ? 'reassigned' : 'changed this way'}.`);
  }
  // Required fields for this action.
  const missing = rule.needs.filter(f => {
    if (f === 'note') return !r(body.note);
    if (f === 'reason') return !r(body.reason);
    if (f === 'waiting_on') return !r(body.waiting_on);
    if (f === 'next_follow_up') return !isDate(body.next_follow_up);
    if (f === 'assigned_to') return !r(body.assigned_to);
    return false;
  });
  if (missing.length) {
    const label = { note: 'a completion note', reason: 'a reason', waiting_on: 'what it is waiting on', next_follow_up: 'the next follow-up date (YYYY-MM-DD)', assigned_to: 'who it is assigned to' };
    throw new Error('To ' + (action === 'complete' ? 'complete' : action === 'cancel' ? 'cancel' : action === 'reopen' ? 'reopen' : action === 'wait' ? 'put this on hold' : action === 'reassign' ? 'reassign' : 'save') + ' this item, add ' + missing.map(f => label[f]).join(' and ') + '.');
  }
  if (body.priority !== undefined && body.priority !== null && !PRIORITIES.includes(body.priority)) throw new Error('Choose a valid priority.');
  if (body.due_date !== undefined && body.due_date !== null && body.due_date !== '' && !isDate(body.due_date)) throw new Error('Due date must be a real date (YYYY-MM-DD).');
  const at = nowIso();
  const next = { ...it };
  const events = [];
  if (action === 'edit') {
    if (body.title !== undefined) { const t = r(body.title); if (!t) throw new Error('A work item needs a title.'); next.title = t.slice(0, 300); events.push(['edited', 'title']); }
    if (body.detail !== undefined) { next.detail = r(body.detail); events.push(['edited', 'detail']); }
    if (body.due_date !== undefined) { next.due_date = body.due_date || null; events.push(['edited', 'due date']); }
    if (body.priority !== undefined) { next.priority = body.priority; events.push(['edited', 'priority']); }
    if (!events.length) throw new Error('Nothing to save.');
  }
  if (action === 'reassign') {
    const to = r(body.assigned_to);
    if (to === it.assigned_to) throw new Error('This item is already assigned to that person.');
    next.assigned_to = to;
    events.push(['reassigned', `${it.assigned_to || 'no one'} → ${to}`]);
  }
  if (action === 'start') { next.status = 'in_progress'; events.push(['started', null]); }
  if (action === 'wait') { next.status = 'waiting'; next.waiting_on = r(body.waiting_on); next.next_follow_up = body.next_follow_up; next.due_date = it.due_date; events.push(['waiting', `${next.waiting_on}, follow up ${next.next_follow_up}`]); }
  if (action === 'complete') { next.status = 'completed'; next.completion_note = r(body.note).slice(0, 2000); next.completed_at = at; events.push(['completed', next.completion_note]); }
  if (action === 'cancel') { next.status = 'cancelled'; next.cancel_reason = r(body.reason).slice(0, 1000); next.cancelled_at = at; events.push(['cancelled', next.cancel_reason]); }
  if (action === 'reopen') { next.status = 'open'; next.reopen_reason = r(body.reason).slice(0, 1000); next.completed_at = null; next.cancelled_at = null; events.push(['reopened', next.reopen_reason]); }
  next.updated_by = by; next.updated_at = at;
  db.transaction(() => {
    db.prepare(`UPDATE work_items SET title=?, detail=?, status=?, priority=?, assigned_to=?, due_date=?, waiting_on=?, next_follow_up=?,
      completion_note=?, cancel_reason=?, reopen_reason=?, completed_at=?, cancelled_at=?, updated_by=?, updated_at=? WHERE id=?`)
      .run(next.title, next.detail, next.status, next.priority, next.assigned_to, next.due_date, next.waiting_on, next.next_follow_up,
        next.completion_note, next.cancel_reason, next.reopen_reason, next.completed_at, next.cancelled_at, by, at, it.id);
    for (const [a, d] of events) history(db, it.id, { action: a, from: it.status, to: next.status, by, detail: d });
  })();
  return get(db, it.id);
}

function get(db, itemId) {
  ensureSchema(db);
  const it = db.prepare('SELECT * FROM work_items WHERE id=?').get(Number(itemId));
  if (!it) return null;
  return { ...it, overdue: ACTIVE.includes(it.status) && !!it.due_date && it.due_date < today(), history: db.prepare('SELECT * FROM work_item_events WHERE item_id=? ORDER BY id').all(it.id) };
}

// The active queue for one person (or everyone). Waiting items show with their follow-up date; completed and cancelled items are excluded.
function queue(db, { assigned_to = null } = {}) {
  ensureSchema(db);
  const rows = db.prepare(`SELECT * FROM work_items WHERE status IN ('open','in_progress','waiting') AND (? IS NULL OR assigned_to=?) ORDER BY
    CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date, id`).all(assigned_to, assigned_to);
  const t = today();
  return rows.map(x => ({ ...x, overdue: !!x.due_date && x.due_date < t, due_today: x.due_date === t }));
}

function mount(app, { db, auth }) {
  ensureSchema(db);
  const who = req => (req.user && req.user.email) || 'admin';
  app.get('/api/admin/work-items', auth, (req, res) => {
    const assigned = r(req.query.assigned_to);
    res.json({ items: queue(db, { assigned_to: assigned }), kinds: KINDS });
  });
  app.get('/api/admin/work-items/:id', auth, (req, res) => {
    const it = get(db, req.params.id);
    if (!it) return res.status(404).json({ error: 'Work item not found.' });
    res.json({ item: it });
  });
  app.post('/api/admin/work-items', auth, (req, res) => {
    try { const x = create(db, { ...(req.body || {}), by: who(req) }); res.status(x.created ? 201 : 200).json({ ok: true, id: x.id, created: x.created, item: get(db, x.id) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/work-items/:id/:action', auth, (req, res) => {
    try { res.json({ ok: true, item: act(db, req.params.id, req.params.action, req.body || {}, who(req)) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { KINDS, ACTIVE, TERMINAL, ACTIONS, ensureSchema, create, act, get, queue, mount };
