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

const KINDS = ['email', 'call', 'lead', 'project_task', 'issue', 'inspection', 'estimate', 'invoice', 'maintenance', 'message', 'other'];
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
  reassign: { from: ['open', 'in_progress', 'waiting'], to: null, needs: [] },
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
  CREATE INDEX IF NOT EXISTS work_item_events_item ON work_item_events(item_id);
  CREATE TABLE IF NOT EXISTS do_not_call(digits TEXT PRIMARY KEY, reason TEXT, by TEXT, at TEXT);`);
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
    if (to === it.assigned_to) throw new Error(to ? 'This item is already assigned to that person.' : 'This item has no owner already.');
    next.assigned_to = to;
    events.push(['reassigned', `${it.assigned_to || 'no one'} → ${to || 'no one'}`]);
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
  try { migrateLeadState(db); } catch (e) { console.error('work engine: lead next-step carry-over failed:', e.message); }
  try { migrateInspectionState(db); } catch (e) { console.error('work engine: inspection carry-over failed:', e.message); }
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
  else if (action === 'do_not_call') {
    // Finishes the call and blocks its number: later calls from it go to the Do not call list, not the queue.
    if (!r(body.reason)) throw new Error('To mark do not call, add the reason.');
    out = act(db, id, 'complete', { note: 'Do not call: ' + r(body.reason) }, by);
    const row = db.prepare('SELECT phone FROM calls WHERE id=?').get(Number(callId));
    const dn = String((row && row.phone) || '').replace(/\D/g, '').slice(-10);
    if (dn) db.prepare('INSERT INTO do_not_call(digits,reason,by,at) VALUES(?,?,?,?) ON CONFLICT(digits) DO UPDATE SET reason=excluded.reason, by=excluded.by, at=excluded.at').run(dn, r(body.reason).slice(0, 500), by, nowIso());
  }
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
  callbackToIssue(db, callId, out, by);
  return get(db, id);
}

// A callback task (customer_issues) and the call it came from stay one step. Finishing or cancelling the call closes its callback;
// reopening the call reopens it. The other direction is issueCallSync, called when the callback is saved on the Issues screen.
function callbackToIssue(db, callId, it, by) {
  if (!hasTable(db, 'customer_issues')) return;
  const c = db.prepare('SELECT callback_issue_id FROM calls WHERE id=?').get(Number(callId));
  if (!c || !c.callback_issue_id) return;
  const x = issueRow(db, c.callback_issue_id);
  if (!x) return;
  const at = nowIso(), done = ISSUE_DONE.includes(x.status);
  if (it.status === 'completed' && !done) db.prepare("UPDATE customer_issues SET status='Resolved', resolution=?, resolved_at=?, updated_at=? WHERE id=?").run(r(it.completion_note) || 'Callback completed', at, at, x.id);
  else if (it.status === 'cancelled' && !done) db.prepare("UPDATE customer_issues SET status='Closed', resolution=?, resolved_at=?, updated_at=? WHERE id=?").run('Cancelled: ' + (it.cancel_reason || 'no reason given'), at, at, x.id);
  else if (ACTIVE.includes(it.status) && done) db.prepare("UPDATE customer_issues SET status='Open', resolved_at=NULL, verified_by=NULL, verified_at=NULL, updated_at=? WHERE id=?").run(at, x.id);
  else return;
  syncIssueFromScreen(db, x.id, by);
}

// The callback was resolved, closed or reopened on the Issues screen: the call's work item follows it.
function issueCallSync(db, issueId, by) {
  const c = db.prepare('SELECT id FROM calls WHERE callback_issue_id=?').get(Number(issueId));
  if (!c) return;
  const x = issueRow(db, issueId);
  if (!x) return;
  const id = ensureCallItem(db, c.id, by), cur = get(db, id);
  if (ISSUE_DONE.includes(x.status) && ACTIVE.includes(cur.status)) mirrorCall(db, c.id, act(db, id, 'complete', { note: r(x.resolution) || 'Callback resolved on the Issues screen' }, by), by, nowIso());
  else if (!ISSUE_DONE.includes(x.status) && TERMINAL.includes(cur.status)) mirrorCall(db, c.id, act(db, id, 'reopen', { reason: 'Callback reopened on the Issues screen' }, by), by, nowIso());
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

// ---- Lead next steps, on the engine ----
// A lead's next step is one work item (kind 'lead', ref_type 'lead', ref_id = the lead). Its due date is the follow-up date.
// A finished step stays in history; the next step is a new item. The lead's own stage and status are not work items.
const activeLeadItem = (db, leadId) => db.prepare(`SELECT * FROM work_items WHERE kind='lead' AND ref_type='lead' AND ref_id=? AND status IN ('open','in_progress','waiting') ORDER BY id DESC LIMIT 1`).get(Number(leadId));

// The active next step, creating it when the lead has none.
function leadNextStep(db, leadId, by) {
  ensureSchema(db);
  const cur = activeLeadItem(db, leadId);
  if (cur) return cur.id;
  const l = db.prepare('SELECT id, contact_name, company, assigned_to FROM leads WHERE id=?').get(Number(leadId));
  if (!l) throw new Error('Lead not found.');
  return create(db, { kind: 'lead', ref_type: 'lead', ref_id: l.id, title: `Next step: ${l.company || l.contact_name || 'lead #' + l.id}`.slice(0, 300), assigned_to: l.assigned_to || null, by }).id;
}

// Sets the next step's date (a new step if the last one is finished). Called by every follow-up setter on the lead.
function leadSchedule(db, leadId, date, by) {
  if (!isDate(date)) throw new Error('Choose a follow-up date.');
  const id = leadNextStep(db, leadId, by);
  const it = get(db, id);
  if (it.due_date !== date) act(db, id, 'edit', { due_date: date }, by);
  return get(db, id);
}

// Finishes the active next step with a note. Throws when the lead has no open step.
function leadComplete(db, leadId, note, by) {
  const cur = activeLeadItem(db, leadId);
  if (!cur) throw new Error('This lead has no open next step.');
  return act(db, cur.id, 'complete', { note }, by);
}

// Puts the active next step on hold until the customer answers, with its follow-up date.
function leadWait(db, leadId, waitingOn, date, by) {
  if (!r(waitingOn)) throw new Error('To put this on hold, add what it is waiting on.');
  if (!isDate(date)) throw new Error('Choose the follow-up date for the wait (YYYY-MM-DD).');
  const id = leadNextStep(db, leadId, by);
  const it = get(db, id);
  if (it.status === 'waiting') throw new Error('This next step is already waiting. Change its date instead.');
  act(db, id, 'wait', { waiting_on: waitingOn, next_follow_up: date }, by);
  return act(db, id, 'edit', { due_date: date }, by);
}

// Cancels the active next step (clearing a lead's follow-up). Quietly does nothing when there is none.
function leadCancel(db, leadId, reason, by) {
  const cur = activeLeadItem(db, leadId);
  if (!cur) return null;
  return act(db, cur.id, 'cancel', { reason: reason || 'Next step cleared' }, by);
}

// Moves the active next step to another owner, when there is one.
function leadReassign(db, leadId, who, by) {
  const cur = activeLeadItem(db, leadId);
  if (!cur || (cur.assigned_to || null) === (who || null)) return null;
  return act(db, cur.id, 'reassign', { assigned_to: who || '' }, by);
}

// The queue's view of a lead's next step, or null when it has none.
function leadState(db, leadId) {
  const it = activeLeadItem(db, leadId);
  if (!it) return null;
  return { item_id: it.id, item_status: it.status, due: it.due_date || null, assigned_to: it.assigned_to };
}

// Carries existing lead follow-ups onto the engine, once. Leads that already have an active step are skipped.
function migrateLeadState(db) {
  ensureSchema(db);
  if (!hasTable(db, 'leads')) return 0;
  const rows = db.prepare(`SELECT id, follow_up_date, stage, assigned_to FROM leads WHERE follow_up_date IS NOT NULL AND follow_up_date<>'' AND status NOT IN ('Won','Lost','Archived')
    AND id NOT IN (SELECT ref_id FROM work_items WHERE kind='lead' AND ref_type='lead' AND ref_id IS NOT NULL AND status IN ('open','in_progress','waiting'))`).all();
  for (const l of rows) {
    if (!isDate(l.follow_up_date)) continue;
    leadSchedule(db, l.id, l.follow_up_date, 'migration');
  }
  return rows.length;
}

// ---- Tasks (issues) on the engine ----
// Each task (a row in customer_issues) has one work item (kind 'issue', ref_type 'issue', ref_id = the task) for its queue state.
// The task keeps its own status, resolution and verification. Queue actions update both; changes made on the Issues screen are
// carried to the item by syncIssueFromScreen, so the two agree.
const ISSUE_DONE = ['Resolved', 'Verified', 'Closed'];
const issueActive = (db, id) => db.prepare(`SELECT * FROM work_items WHERE kind='issue' AND ref_type='issue' AND ref_id=? AND status IN ('open','in_progress','waiting') ORDER BY id DESC LIMIT 1`).get(Number(id));
const issueLatest = (db, id) => db.prepare(`SELECT * FROM work_items WHERE kind='issue' AND ref_type='issue' AND ref_id=? ORDER BY id DESC LIMIT 1`).get(Number(id));
const issueRow = (db, id) => db.prepare('SELECT * FROM customer_issues WHERE id=?').get(Number(id));

function issueNextItem(db, x, by) {
  const cur = issueActive(db, x.id);
  if (cur) return cur.id;
  return create(db, { kind: 'issue', ref_type: 'issue', ref_id: x.id, title: String(x.title || 'Task').slice(0, 300), assigned_to: x.assigned_to || null, due_date: isDate(x.due_date) ? x.due_date : null, by }).id;
}

// The queue's view of a task's work item, or null when it has none.
function issueState(db, id) {
  const it = issueActive(db, id);
  if (!it) return null;
  return { item_id: it.id, item_status: it.status, due: it.due_date || null, assigned_to: it.assigned_to };
}

// One queue action on a task. Required fields are checked before anything is written.
function applyIssueAction(db, taskId, body = {}, by = null) {
  ensureSchema(db);
  const x = issueRow(db, taskId);
  if (!x) throw new Error('Task not found.');
  const raw = String(body.action || '');
  const action = raw === 'waiting' ? 'wait' : raw; // the screen's name for the same action
  const done = ISSUE_DONE.includes(x.status);
  const at = nowIso();
  let itemId = null;
  const needOpen = () => { if (done) throw new Error('This task is resolved. Reopen it first.'); };
  if (action === 'complete') {
    if (done) throw new Error('This task is already resolved.');
    if (!r(body.note)) throw new Error('To complete this task, add a completion note.');
    itemId = issueNextItem(db, x, by);
    act(db, itemId, 'complete', { note: body.note }, by);
    db.prepare("UPDATE customer_issues SET status='Resolved', resolution=?, resolved_at=?, updated_at=? WHERE id=?").run(r(body.note).slice(0, 4000), at, at, x.id);
    issueCallSync(db, x.id, by);
  } else if (action === 'cancel') {
    if (done) throw new Error('This task is already resolved.');
    if (!r(body.reason)) throw new Error('To cancel this task, add a reason.');
    itemId = issueNextItem(db, x, by);
    act(db, itemId, 'cancel', { reason: body.reason }, by);
    db.prepare("UPDATE customer_issues SET status='Closed', resolution=?, resolved_at=?, updated_at=? WHERE id=?").run(('Cancelled: ' + r(body.reason)).slice(0, 4000), at, at, x.id);
    issueCallSync(db, x.id, by);
  } else if (action === 'reopen') {
    if (!done) throw new Error('This task is not finished, so it cannot be reopened.');
    if (!r(body.reason)) throw new Error('To reopen this task, add a reason.');
    const last = issueLatest(db, x.id);
    if (last && (last.status === 'completed' || last.status === 'cancelled')) { act(db, last.id, 'reopen', { reason: body.reason }, by); itemId = last.id; }
    db.prepare("UPDATE customer_issues SET status='Open', resolved_at=NULL, verified_by=NULL, verified_at=NULL, updated_at=? WHERE id=?").run(at, x.id);
    issueCallSync(db, x.id, by);
  } else if (action === 'wait') {
    needOpen();
    if (!r(body.waiting_on)) throw new Error('To put this on hold, add what it is waiting on.');
    if (!isDate(body.date)) throw new Error('Choose the follow-up date for the wait (YYYY-MM-DD).');
    itemId = issueNextItem(db, x, by);
    act(db, itemId, 'wait', { waiting_on: body.waiting_on, next_follow_up: body.date }, by);
    act(db, itemId, 'edit', { due_date: body.date }, by);
    db.prepare("UPDATE customer_issues SET status='Waiting on customer', due_date=?, updated_at=? WHERE id=?").run(body.date, at, x.id);
  } else if (action === 'schedule') {
    needOpen();
    if (!isDate(body.date)) throw new Error('Choose a valid due date.');
    itemId = issueNextItem(db, x, by);
    act(db, itemId, 'edit', { due_date: body.date }, by);
    db.prepare('UPDATE customer_issues SET due_date=?, updated_at=? WHERE id=?').run(body.date, at, x.id);
  } else if (action === 'assign') {
    needOpen();
    const to = r(body.assigned_to) ? String(body.assigned_to).trim().toLowerCase() : null;
    if (to === (x.assigned_to || null)) return get(db, issueNextItem(db, x, by));
    itemId = issueNextItem(db, x, by);
    act(db, itemId, 'reassign', { assigned_to: to }, by);
    db.prepare('UPDATE customer_issues SET assigned_to=?, updated_at=? WHERE id=?').run(to, at, x.id);
  } else throw new Error('Unknown task action.');
  const latest = itemId ? itemId : (issueLatest(db, x.id) || {}).id;
  return latest ? get(db, latest) : null;
}

// Carries a change made on the Issues screen to the task's work item. Called after the task is saved.
function syncIssueFromScreen(db, taskId, by) {
  ensureSchema(db);
  const x = issueRow(db, taskId);
  if (!x) return;
  const cur = issueActive(db, x.id);
  if (ISSUE_DONE.includes(x.status)) {
    if (cur) act(db, cur.id, 'complete', { note: r(x.resolution) || 'Resolved on the Issues screen' }, by);
    return;
  }
  const last = issueLatest(db, x.id);
  if (last && (last.status === 'completed' || last.status === 'cancelled')) act(db, last.id, 'reopen', { reason: 'Reopened on the Issues screen' }, by);
  const now = issueActive(db, x.id);
  if (!now) return;
  if ((now.assigned_to || null) !== (x.assigned_to || null)) act(db, now.id, 'reassign', { assigned_to: x.assigned_to || null }, by);
  const due = isDate(x.due_date) ? x.due_date : null;
  if ((now.due_date || null) !== due) act(db, now.id, 'edit', { due_date: due }, by);
}

// ---- Inspections (QC) on the engine ----
// Each inspection with work left has one work item (kind 'inspection', ref_type 'inspection', ref_id = the inspection).
// The inspection keeps its own status: signing, reinspection, acceptance and cancellation happen on the inspection, and the
// item follows them (syncInspection). The queue can only assign an item and set its date, never sign or accept.
const INSPECTION_OPEN = ['In progress', 'Corrective action', 'Reinspection due', 'Awaiting customer'];
const inspActive = (db, id) => db.prepare("SELECT * FROM work_items WHERE kind='inspection' AND ref_type='inspection' AND ref_id=? AND status IN ('open','in_progress','waiting') ORDER BY id DESC LIMIT 1").get(Number(id));
const inspLatest = (db, id) => db.prepare("SELECT * FROM work_items WHERE kind='inspection' AND ref_type='inspection' AND ref_id=? ORDER BY id DESC LIMIT 1").get(Number(id));

// Brings the inspection's work item into step with the inspection's status. Returns the item, or null when there is none.
function syncInspection(db, inspectionId, by = null) {
  ensureSchema(db);
  const x = db.prepare('SELECT * FROM inspections WHERE id=?').get(Number(inspectionId));
  if (!x) return null;
  const cur = inspActive(db, x.id);
  if (INSPECTION_OPEN.includes(x.status)) {
    if (cur) return get(db, cur.id);
    const last = inspLatest(db, x.id);
    if (last && (last.status === 'completed' || last.status === 'cancelled')) {
      act(db, last.id, 'reopen', { reason: 'Status is now ' + x.status }, by);
      return get(db, last.id);
    }
    const id = create(db, { kind: 'inspection', ref_type: 'inspection', ref_id: x.id, title: ('Inspection: ' + (x.area || 'area #' + x.id)).slice(0, 300), detail: x.status, by }).id;
    return get(db, id);
  }
  if (!cur) return null;
  if (x.status === 'Cancelled') return act(db, cur.id, 'cancel', { reason: 'Inspection cancelled' }, by);
  return act(db, cur.id, 'complete', { note: 'Inspection ' + String(x.status).toLowerCase() }, by);
}

// The queue's view of an inspection's work item, or null when it has none.
function inspState(db, id) {
  const it = inspActive(db, id);
  if (!it) return null;
  return { item_id: it.id, item_status: it.status, due: it.due_date || null, assigned_to: it.assigned_to };
}

// A queue action on an inspection: assign it, or set when it should be done. Nothing else can be done from the queue.
function applyInspectionAction(db, inspectionId, body = {}, by = null) {
  ensureSchema(db);
  const x = db.prepare('SELECT * FROM inspections WHERE id=?').get(Number(inspectionId));
  if (!x) throw new Error('Inspection not found.');
  if (!INSPECTION_OPEN.includes(x.status)) throw new Error('This inspection is ' + String(x.status).toLowerCase() + '. Its work is finished.');
  const item = syncInspection(db, x.id, by);
  const action = String(body.action || '');
  if (action === 'assign') {
    const to = r(body.assigned_to) ? String(body.assigned_to).trim().toLowerCase() : null;
    if (to === (item.assigned_to || null)) return get(db, item.id);
    return act(db, item.id, 'reassign', { assigned_to: to }, by);
  }
  if (action === 'schedule') {
    if (!isDate(body.date)) throw new Error('Choose a valid date.');
    return act(db, item.id, 'edit', { due_date: body.date }, by);
  }
  throw new Error('Unknown inspection action.');
}

// Carries open inspections onto the engine, once. Safe to run again: inspections that already have an open item are skipped.
function migrateInspectionState(db) {
  ensureSchema(db);
  if (!hasTable(db, 'inspections')) return 0;
  let n = 0;
  for (const x of db.prepare('SELECT id, status FROM inspections').all()) {
    if (!INSPECTION_OPEN.includes(x.status) || inspActive(db, x.id)) continue;
    syncInspection(db, x.id, 'migration');
    n++;
  }
  return n;
}

// ---- Invoice follow-up on the engine ----
// An unpaid invoice has at most one open work item (kind 'invoice', ref_type 'invoice', ref_id = the invoice). The item holds
// who follows the invoice up, the follow-up date and any promise to pay. Money is never changed from the queue: payments,
// refunds and credits stay on the invoice and its ledger. The invoice's balance decides whether it still needs work.
const INVOICE_OPEN_STATUSES = ['Sent', 'Approved', 'Partial', 'Overdue', 'Past due', 'Unpaid', 'Pending'];
const invActive = (db, id) => db.prepare("SELECT * FROM work_items WHERE kind='invoice' AND ref_type='invoice' AND ref_id=? AND status IN ('open','in_progress','waiting') ORDER BY id DESC LIMIT 1").get(Number(id));

// The queue's view of an invoice's follow-up item, or null when it has none.
function invoiceState(db, id) {
  const it = invActive(db, id);
  if (!it) return null;
  return { item_id: it.id, item_status: it.status, due: it.due_date || null, assigned_to: it.assigned_to };
}

// Finishes the item of an invoice that no longer needs work (paid in full, or void). Returns the item or null.
function closeInvoiceWork(db, invoiceId, reason, by = null) {
  const cur = invActive(db, invoiceId);
  if (!cur) return null;
  return act(db, cur.id, 'complete', { note: reason || 'Nothing left to collect' }, by);
}

// A queue action on an invoice's follow-up: assign, set the follow-up date, or record a promise to pay with a date.
function applyInvoiceAction(db, invoiceId, body = {}, by = null) {
  ensureSchema(db);
  const inv = db.prepare('SELECT id, status FROM invoices WHERE id=?').get(Number(invoiceId));
  if (!inv) throw new Error('Invoice not found.');
  const { owed } = require('./receivables').invoiceBalance(db, inv.id);
  if (inv.status === 'Void' || inv.status === 'Draft' || !(owed > 0.005)) throw new Error('This invoice has nothing left to collect.');
  const action = String(body.action || '');
  // Check what was asked before anything is written.
  if (action === 'schedule' && !isDate(body.date)) throw new Error('Choose a valid follow-up date.');
  if (action === 'wait') {
    if (!r(body.waiting_on)) throw new Error('To record a promise to pay, add who promised and what.');
    if (!isDate(body.date)) throw new Error('Choose the date the payment is promised for (YYYY-MM-DD).');
  }
  if (!['assign', 'schedule', 'wait'].includes(action)) throw new Error('Unknown invoice action.');
  let cur = invActive(db, inv.id);
  if (!cur) {
    const i2 = db.prepare('SELECT invoice_number, customer_name FROM invoices WHERE id=?').get(inv.id);
    const id = create(db, { kind: 'invoice', ref_type: 'invoice', ref_id: inv.id, title: `Collect: invoice ${i2.invoice_number || '#' + inv.id}${i2.customer_name ? ' · ' + i2.customer_name : ''}`.slice(0, 300), by }).id;
    cur = get(db, id);
  }
  if (action === 'assign') {
    const to = r(body.assigned_to) ? String(body.assigned_to).trim().toLowerCase() : null;
    if (to === (cur.assigned_to || null)) return get(db, cur.id);
    return act(db, cur.id, 'reassign', { assigned_to: to }, by);
  }
  if (action === 'schedule') {
    if (!isDate(body.date)) throw new Error('Choose a valid follow-up date.');
    return act(db, cur.id, 'edit', { due_date: body.date }, by);
  }
  if (action === 'wait') {
    if (!r(body.waiting_on)) throw new Error('To record a promise to pay, add who promised and what.');
    if (!isDate(body.date)) throw new Error('Choose the date the payment is promised for (YYYY-MM-DD).');
    act(db, cur.id, 'wait', { waiting_on: body.waiting_on, next_follow_up: body.date }, by);
    return act(db, cur.id, 'edit', { due_date: body.date }, by);
  }
  throw new Error('Unknown invoice action.');
}

// ---- Client conversations on the engine ----
// A conversation (texts, portal messages and emails with one customer or lead) has at most one open work item
// (kind 'message', ref_type 'conversation', detail = the conversation key). The conversation keeps its own status, owner
// and follow-up date in conversation_state; queue actions write both, and changes made on the conversation screen are
// carried over by syncConversation.
const CONV_STATES = ['Open', 'Waiting on customer', 'Closed'];
const convActive = (db, key) => db.prepare("SELECT * FROM work_items WHERE kind='message' AND ref_type='conversation' AND detail=? AND status IN ('open','in_progress','waiting') ORDER BY id DESC LIMIT 1").get(String(key));
const convLatest = (db, key) => db.prepare("SELECT * FROM work_items WHERE kind='message' AND ref_type='conversation' AND detail=? ORDER BY id DESC LIMIT 1").get(String(key));

// The queue's view of a conversation's work item, or null when it has none.
function convState(db, key) {
  const it = convActive(db, key);
  if (!it) return null;
  return { item_id: it.id, item_status: it.status, due: it.due_date || null, assigned_to: it.assigned_to, updated_at: it.updated_at };
}

function convEnsureItem(db, key, by) {
  const cur = convActive(db, key);
  if (cur) return cur.id;
  return create(db, { kind: 'message', ref_type: 'conversation', ref_id: null, title: ('Conversation: ' + String(key)).slice(0, 300), detail: String(key), by }).id;
}

function convRow(db, key) {
  return db.prepare('SELECT * FROM conversation_state WHERE key=?').get(String(key));
}

function convSave(db, key, patch) {
  const cur = convRow(db, key) || { status: 'Open', owner: null, follow_up_date: null, last_read_at: null };
  const next = { ...cur, ...patch };
  db.prepare('INSERT INTO conversation_state(key,status,owner,follow_up_date,last_read_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status, owner=excluded.owner, follow_up_date=excluded.follow_up_date, updated_at=excluded.updated_at')
    .run(String(key), next.status, next.owner || null, next.follow_up_date || null, next.last_read_at || null, nowIso());
}

// One queue action on a conversation. Required details are checked before anything is written.
function applyConversationAction(db, key, body = {}, by = null) {
  ensureSchema(db);
  const action = String(body.action || '');
  const k = String(key);
  if (!['assign', 'schedule', 'wait', 'close', 'reopen'].includes(action)) throw new Error('Unknown conversation action.');
  if (action === 'schedule' && !isDate(body.date)) throw new Error('Choose a valid follow-up date.');
  if (action === 'wait') {
    if (!r(body.waiting_on)) throw new Error('To wait on the customer, say what they owe you.');
    if (!isDate(body.date)) throw new Error('Choose the follow-up date (YYYY-MM-DD).');
  }
  if (action === 'close' && !r(body.note)) throw new Error('To close this conversation, add a note saying how it ended.');
  if (action === 'reopen' && !r(body.reason)) throw new Error('To reopen this conversation, add a reason.');
  if (action === 'assign' && body.assigned_to !== undefined && body.assigned_to !== null && body.assigned_to !== '' && !r(body.assigned_to)) throw new Error('Choose who to assign it to.');
  const saved = convRow(db, k);
  if (['assign', 'schedule', 'wait'].includes(action) && saved && saved.status === 'Closed') throw new Error('This conversation is closed. Reopen it first.');
  if (action === 'wait') { const pre = convActive(db, k); if (pre && pre.status === 'waiting') throw new Error('This conversation is already waiting on the customer. Change its date instead.'); }
  const finished = (convLatest(db, k) || {}).status;
  if (action === 'reopen' && !['completed', 'cancelled'].includes(finished)) throw new Error('This conversation is not closed, so it cannot be reopened.');

  if (action === 'assign') {
    const to = r(body.assigned_to) ? String(body.assigned_to).trim().toLowerCase() : null;
    const id = convEnsureItem(db, k, by);
    convSave(db, k, { owner: to });
    const it = get(db, id);
    if ((it.assigned_to || null) !== to) act(db, id, 'reassign', { assigned_to: to }, by);
  } else if (action === 'schedule') {
    const id = convEnsureItem(db, k, by);
    convSave(db, k, { follow_up_date: body.date });
    act(db, id, 'edit', { due_date: body.date }, by);
  } else if (action === 'wait') {
    const id = convEnsureItem(db, k, by);
    convSave(db, k, { status: 'Waiting on customer', follow_up_date: body.date });
    act(db, id, 'wait', { waiting_on: body.waiting_on, next_follow_up: body.date }, by);
    act(db, id, 'edit', { due_date: body.date }, by);
  } else if (action === 'close') {
    convSave(db, k, { status: 'Closed', follow_up_date: null });
    const cur = convActive(db, k);
    if (cur) act(db, cur.id, 'complete', { note: body.note }, by);
  } else if (action === 'reopen') {
    convSave(db, k, { status: 'Open' });
    const last = convLatest(db, k);
    if (last) act(db, last.id, 'reopen', { reason: body.reason }, by);
  }
  const latest = convLatest(db, k);
  return latest ? get(db, latest.id) : null;
}

// A new customer text or email, or a text that did not arrive: the conversation needs attention now. A closed or waiting
// conversation opens again, and its item is due today, not on the date it was waiting for. A reply never stays hidden.
function conversationNeedsAttention(db, key, by = null) {
  ensureSchema(db);
  const k = String(key);
  const st = convRow(db, k);
  if (st && st.status !== 'Open') convSave(db, k, { status: 'Open', follow_up_date: null });
  let cur = convActive(db, k);
  if (!cur) {
    const last = convLatest(db, k);
    if (last && ['completed', 'cancelled'].includes(last.status)) act(db, last.id, 'reopen', { reason: 'New message on the conversation' }, by);
    else if (!last) convEnsureItem(db, k, by);
    cur = convActive(db, k);
  }
  if (!cur) return null;
  if (cur.due_date) act(db, cur.id, 'edit', { due_date: null }, by);
  if (cur.status === 'waiting') act(db, cur.id, 'start', {}, by);
  return get(db, cur.id);
}

// Carries a change made on the conversation screen to its work item. Called after the conversation is saved.
function syncConversation(db, key, by = null) {
  ensureSchema(db);
  const st = convRow(db, key);
  if (!st) return null;
  const cur = convActive(db, key);
  const last = convLatest(db, key);
  if (st.status === 'Closed') {
    if (cur) return act(db, cur.id, 'complete', { note: 'Closed on the conversation screen' }, by);
    return null;
  }
  if (last && (last.status === 'completed' || last.status === 'cancelled')) {
    act(db, last.id, 'reopen', { reason: 'Reopened on the conversation screen' }, by);
  }
  const now = convActive(db, key);
  if (!now) return null;
  if ((now.assigned_to || null) !== (st.owner || null)) act(db, now.id, 'reassign', { assigned_to: st.owner || null }, by);
  const due = isDate(st.follow_up_date) ? st.follow_up_date : null;
  if ((now.due_date || null) !== due) act(db, now.id, 'edit', { due_date: due }, by);
  return get(db, now.id);
}

// ---- Estimates (proposals) on the engine ----
// An open estimate (Draft, Ready, Sent, Viewed) can have one open work item (kind 'estimate', ref_type 'estimate', ref_id).
// The item holds who follows the estimate up and the follow-up date. The estimate keeps its own status: sending, the
// customer's answer and archiving happen on the estimate. The queue never prices, sends or approves anything.
const ESTIMATE_OPEN = ['Draft', 'Ready', 'Sent', 'Viewed'];
const estActive = (db, id) => db.prepare("SELECT * FROM work_items WHERE kind='estimate' AND ref_type='estimate' AND ref_id=? AND status IN ('open','in_progress','waiting') ORDER BY id DESC LIMIT 1").get(Number(id));

// The queue's view of an estimate's follow-up item, or null when it has none.
function estState(db, id) {
  const it = estActive(db, id);
  if (!it) return null;
  return { item_id: it.id, item_status: it.status, due: it.due_date || null, assigned_to: it.assigned_to };
}

// Finishes the item of an estimate that is no longer open (approved, declined, archived or superseded).
function closeEstimateWork(db, id, reason, by = null) {
  const cur = estActive(db, id);
  if (!cur) return null;
  return act(db, cur.id, 'complete', { note: reason || 'No longer open' }, by);
}

// One queue action on an estimate: assign, set the follow-up date, or record that we are waiting on the customer until a date.
function applyEstimateAction(db, estimateId, body = {}, by = null) {
  ensureSchema(db);
  const e = db.prepare('SELECT id, status, customer_name, company, project_name FROM estimates WHERE id=?').get(Number(estimateId));
  if (!e) throw new Error('Estimate not found.');
  const action = String(body.action || '');
  if (!['assign', 'schedule', 'wait'].includes(action)) throw new Error('Unknown estimate action.');
  if (!ESTIMATE_OPEN.includes(e.status)) throw new Error('This estimate is ' + String(e.status).toLowerCase() + ', so there is nothing to follow up.');
  if (action === 'schedule' && !isDate(body.date)) throw new Error('Choose a valid follow-up date.');
  if (action === 'wait') {
    if (!r(body.waiting_on)) throw new Error('To wait on the customer, say what they are deciding.');
    if (!isDate(body.date)) throw new Error('Choose the follow-up date (YYYY-MM-DD).');
  }
  const pre = estActive(db, e.id);
  if (action === 'wait' && pre && pre.status === 'waiting') throw new Error('This proposal is already waiting on the customer. Change its date instead.');
  let cur = pre;
  if (!cur) {
    const id = create(db, { kind: 'estimate', ref_type: 'estimate', ref_id: e.id, title: `Proposal #${e.id} · ${e.project_name || e.customer_name || e.company || 'estimate'}`.slice(0, 300), by }).id;
    cur = get(db, id);
  }
  if (action === 'assign') {
    const to = r(body.assigned_to) ? String(body.assigned_to).trim().toLowerCase() : null;
    if (to === (cur.assigned_to || null)) return get(db, cur.id);
    return act(db, cur.id, 'reassign', { assigned_to: to }, by);
  }
  if (action === 'schedule') return act(db, cur.id, 'edit', { due_date: body.date }, by);
  act(db, cur.id, 'wait', { waiting_on: body.waiting_on, next_follow_up: body.date }, by);
  return act(db, cur.id, 'edit', { due_date: body.date }, by);
}

// True when this number asked us not to call. Compares the last 10 digits, so +1, dashes and spaces all match.
function isDoNotCall(db, phone) {
  const dn = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!dn) return false;
  try { return !!db.prepare('SELECT 1 FROM do_not_call WHERE digits=?').get(dn); }
  catch { return false; } // table not created yet: nothing is blocked, and nothing crashes the call path
}

module.exports = { isDoNotCall, KINDS, ACTIVE, TERMINAL, ACTIONS, ensureSchema, create, act, get, queue, mount, callbackToIssue, issueCallSync, emailItemOf, ensureEmailItem, emailState, applyEmailAction, migrateEmailState, callItemOf, ensureCallItem, callState, applyCallAction, migrateCallState, seedCallItem, activeLeadItem, leadNextStep, leadSchedule, leadComplete, leadWait, leadCancel, leadReassign, leadState, migrateLeadState, issueState, applyIssueAction, syncIssueFromScreen, syncInspection, inspState, applyInspectionAction, migrateInspectionState, INSPECTION_OPEN, invoiceState, closeInvoiceWork, applyInvoiceAction, INVOICE_OPEN_STATUSES, convState, applyConversationAction, syncConversation, conversationNeedsAttention, CONV_STATES, estState, applyEstimateAction, closeEstimateWork, ESTIMATE_OPEN };
