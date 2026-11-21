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
  try { migrateEmailState(db); } catch (e) { console.error('work engine: email queue carry-over failed:', e.message); }
  try { migrateCallState(db); } catch (e) { console.error('work engine: call queue carry-over failed:', e.message); }
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

// ---- Email queue, on the engine ----
// One work item per email (kind 'email', ref_type 'inbox', ref_id = the message). The item is reused when it is reopened.
const emailItemOf = (db, messageId) => db.prepare(`SELECT * FROM work_items WHERE kind='email' AND ref_type='inbox' AND ref_id=? ORDER BY id DESC LIMIT 1`).get(Number(messageId));

function ensureEmailItem(db, messageId, by) {
  const cur = emailItemOf(db, messageId);
  if (cur) return cur.id;
  const m = db.prepare('SELECT subject FROM inbox_messages WHERE id=?').get(Number(messageId));
  if (!m) throw new Error('Email not found.');
  return create(db, { kind: 'email', ref_type: 'inbox', ref_id: Number(messageId), title: m.subject || '(no subject)', by }).id;
}

// The queue's view of an email: the same shape the queue has always used for its buckets.
function emailState(db, messageId) {
  const it = emailItemOf(db, messageId);
  if (!it) return null;
  const done = it.status === 'completed' || it.status === 'cancelled';
  return {
    status: done ? 'completed' : it.status === 'waiting' ? 'waiting' : 'open',
    follow_up_date: it.status === 'waiting' ? (it.next_follow_up || it.due_date || null) : (it.due_date || null),
    snooze_until: null, assigned_to: it.assigned_to, note: it.completion_note || it.cancel_reason || null,
    item_id: it.id, item_status: it.status
  };
}

// Applies one email action from the queue screen through the engine. Returns the updated item.
function applyEmailAction(db, messageId, body = {}, by = null) {
  ensureSchema(db);
  const id = ensureEmailItem(db, messageId, by);
  const it = get(db, id);
  const finished = TERMINAL.includes(it.status);
  const action = String(body.action || '');
  if (action === 'handle') return act(db, id, 'complete', { note: body.note }, by);
  if (action === 'waiting') return act(db, id, 'wait', { waiting_on: body.waiting_on || body.note, next_follow_up: body.date }, by);
  if (action === 'cancel') return act(db, id, 'cancel', { reason: body.reason }, by);
  if (action === 'reopen') return act(db, id, 'reopen', { reason: body.reason || body.note }, by);
  if (action === 'assign') {
    if (!String(body.assigned_to || '').trim()) throw new Error('Choose who to assign it to.');
    return act(db, id, 'reassign', { assigned_to: body.assigned_to }, by);
  }
  if (action === 'schedule' || action === 'snooze') {
    if (finished) throw new Error('This email is finished. Reopen it, with a reason, before changing its date.');
    const date = action === 'schedule' ? body.date : (body.until ? require('./bizdate').today(new Date(body.until)) : null);
    if (action === 'snooze' && !date) throw new Error('Choose when to bring it back.');
    return act(db, id, 'edit', { due_date: date }, by);
  }
  throw new Error('Unknown email action.');
}

// Carries the old email queue states (inbox_state) onto the engine, once. Safe to run again: messages that already have an item are skipped.
function migrateEmailState(db) {
  ensureSchema(db);
  const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!has('inbox_state') || !has('inbox_messages')) return 0;
  let n = 0;
  for (const s of db.prepare('SELECT * FROM inbox_state').all()) {
    if (emailItemOf(db, s.message_id)) continue;
    const m = db.prepare('SELECT subject FROM inbox_messages WHERE id=?').get(s.message_id);
    if (!m) continue;
    const id = create(db, { kind: 'email', ref_type: 'inbox', ref_id: s.message_id, title: m.subject || '(no subject)', by: 'migration' }).id;
    if (s.assigned_to) act(db, id, 'reassign', { assigned_to: s.assigned_to }, 'migration');
    if (s.status === 'completed') act(db, id, 'complete', { note: s.note || 'Completed before the work engine.' }, 'migration');
    else if (s.status === 'waiting') act(db, id, 'wait', { waiting_on: 'Carried over from the email queue', next_follow_up: isDate(s.follow_up_date) ? s.follow_up_date : today() }, 'migration');
    else if (isDate(s.follow_up_date)) act(db, id, 'edit', { due_date: s.follow_up_date }, 'migration');
    n++;
  }
  return n;
}

// ---- Call queue, on the engine ----
// One work item per call (kind 'call', ref_type 'call', ref_id = the call). A call with no item still uses its own fields,
// so nothing is lost before it is first touched; the first action seeds the item from those fields.
// The calls table is kept in step after each action (follow_up_done, handled_at, follow_up_date, handling, assigned_to), so the
// screens that still read those columns (callbacks due, command centre, call drawer) agree with the queue.
const callItemOf = (db, callId) => db.prepare(`SELECT * FROM work_items WHERE kind='call' AND ref_type='call' AND ref_id=? ORDER BY id DESC LIMIT 1`).get(Number(callId));
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

// Creates the item for a call and carries over what the call already records.
function seedCallItem(db, row, by) {
  const title = `${row.direction || 'Call'} · ${row.outcome || ''}`.trim().slice(0, 300) || 'Call';
  const id = create(db, { kind: 'call', ref_type: 'call', ref_id: row.id, title, detail: row.summary || null, by }).id;
  if (row.assigned_to) act(db, id, 'reassign', { assigned_to: row.assigned_to }, by);
  if (row.follow_up_done === 1 || row.handled_at) act(db, id, 'complete', { note: 'Completed before the work engine.' }, by);
  else if (row.handling === 'Waiting') act(db, id, 'wait', { waiting_on: 'Carried over from the call queue', next_follow_up: isDate(row.follow_up_date) ? row.follow_up_date : today() }, by);
  else if (isDate(row.follow_up_date)) act(db, id, 'edit', { due_date: row.follow_up_date }, by);
  return id;
}

function ensureCallItem(db, callId, by) {
  const cur = callItemOf(db, callId);
  if (cur) return cur.id;
  const row = db.prepare('SELECT * FROM calls WHERE id=?').get(Number(callId));
  if (!row) throw new Error('Call not found.');
  return seedCallItem(db, row, by);
}

// The queue's view of a call, or null when the call has no item yet (the caller then uses the call's own fields).
function callState(db, callId) {
  const it = callItemOf(db, callId);
  if (!it) return null;
  return {
    item_id: it.id, item_status: it.status, assigned_to: it.assigned_to, note: it.completion_note || it.cancel_reason || null,
    due: it.status === 'waiting' ? (it.next_follow_up || it.due_date || null) : (it.due_date || null)
  };
}

// Keeps the calls table in step with the engine item.
function mirrorCall(db, callId, it, by, at) {
  if (!hasTable(db, 'calls')) return;
  const prev = db.prepare('SELECT handling FROM calls WHERE id=?').get(Number(callId));
  if (!prev) return;
  const done = it.status === 'completed' || it.status === 'cancelled';
  const waiting = it.status === 'waiting';
  const due = waiting ? it.next_follow_up : it.due_date;
  const cleared = prev.handling === 'Waiting' || prev.handling === 'Callback';
  const handling = waiting ? 'Waiting' : (!done && due) ? 'Callback' : (cleared ? null : prev.handling);
  db.prepare(`UPDATE calls SET follow_up_done=?, handled_at=?, handled_by=?, follow_up_date=?, handling=?, assigned_to=? WHERE id=?`)
    .run(done ? 1 : 0, it.status === 'completed' ? at : null, it.status === 'completed' ? by : null, done ? null : (due || null), handling, it.assigned_to || null, Number(callId));
}

// Applies one call action from the queue (or the call drawer) through the engine. Returns the updated item.
function applyCallAction(db, callId, body = {}, by = null) {
  ensureSchema(db);
  const id = ensureCallItem(db, callId, by);
  const action = String(body.action || '');
  let out;
  if (action === 'handle' || action === 'complete') out = act(db, id, 'complete', { note: body.note }, by);
  else if (action === 'waiting' || action === 'wait') out = act(db, id, 'wait', { waiting_on: body.waiting_on || body.note, next_follow_up: body.date }, by);
  else if (action === 'cancel') out = act(db, id, 'cancel', { reason: body.reason }, by);
  else if (action === 'reopen') out = act(db, id, 'reopen', { reason: body.reason || body.note }, by);
  else if (action === 'assign') {
    if (!r(body.assigned_to)) throw new Error('Choose who to assign it to.');
    out = act(db, id, 'reassign', { assigned_to: body.assigned_to }, by);
  } else if (action === 'schedule') {
    if (!isDate(body.date)) throw new Error('Choose a valid callback date.');
    out = act(db, id, 'edit', { due_date: body.date }, by);
    // A callback can also name its owner in the same step.
    if (r(body.assigned_to) && r(body.assigned_to) !== out.assigned_to) out = act(db, id, 'reassign', { assigned_to: body.assigned_to }, by);
  } else throw new Error('Unknown call action.');
  mirrorCall(db, callId, out, by, nowIso());
  return get(db, id);
}

// Carries the existing call follow-ups onto the engine, once. Calls that already have an item are skipped.
function migrateCallState(db) {
  ensureSchema(db);
  if (!hasTable(db, 'calls')) return 0;
  const rows = db.prepare(`SELECT * FROM calls WHERE (handled_at IS NOT NULL OR follow_up_done=1 OR (follow_up_date IS NOT NULL AND follow_up_date<>'')
      OR handling='Waiting' OR (assigned_to IS NOT NULL AND assigned_to<>''))
      AND id NOT IN (SELECT ref_id FROM work_items WHERE kind='call' AND ref_type='call' AND ref_id IS NOT NULL)`).all();
  for (const row of rows) seedCallItem(db, row, 'migration');
  return rows.length;
}

module.exports = { KINDS, ACTIVE, TERMINAL, ACTIONS, ensureSchema, create, act, get, queue, mount, emailItemOf, ensureEmailItem, emailState, applyEmailAction, migrateEmailState, callItemOf, ensureCallItem, callState, applyCallAction, migrateCallState, seedCallItem };
