// Unified daily work queue. It does not copy or hide records: it reads the existing emails, calls, leads and tasks,
// and sorts each one into a view by its next action and date. Full history stays in each module.
//
// Buckets (the same names for every department):
//   new        needs a first look or a next action
//   missed     missed call that still needs action (calls only)
//   today      due today
//   overdue    due before today and not finished
//   waiting    waiting on the customer or a third party
//   scheduled  due after today; stays out of Today until its date
//   completed  finished (emails handled, calls handled, tasks resolved)
//   closed     lead lost, archived or converted
// Dates use the business time zone (BUSINESS_TZ), via bizdate.js.
const { today: bizToday, TZ } = require('./bizdate');

const DEPTS = ['emails', 'calls', 'leads', 'tasks', 'sent'];
const MISSED = ['Missed', 'Voicemail', 'No answer', 'No-answer'];
const ISSUE_CLOSED = ['Resolved', 'Verified', 'Closed'];
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
const nowIso = () => new Date().toISOString();

// Pure: decides the bucket for one item from its own dates and states. Exported for tests.
function dateBucket(due, today) {
  if (!validDate(due)) return null;
  if (due > today) return 'scheduled';
  if (due === today) return 'today';
  return 'overdue';
}

// [start, end) of a business day in the business time zone, as UTC ISO strings.
function dayBounds(d, tz = TZ) {
  const probe = new Date(d + 'T12:00:00Z');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(probe).map(x => [x.type, x.value]));
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - probe.getTime();
  const start = Date.parse(d + 'T00:00:00Z') - offset;
  return [new Date(start).toISOString(), new Date(start + 86400000).toISOString()];
}

function emailBucket(row, state, today, now) {
  if (state && state.status === 'completed') return 'completed';
  if (state && state.status === 'waiting') return 'waiting';
  if (state && state.snooze_until && state.snooze_until > now) return 'scheduled';
  if (state && validDate(state.follow_up_date)) return dateBucket(state.follow_up_date, today);
  return 'new';
}

function callBucket(row, today) {
  if (row.follow_up_done === 1 || row.handled_at) return 'completed';
  if (validDate(row.follow_up_date)) return dateBucket(row.follow_up_date, today);
  if (row.handling === 'Waiting') return 'waiting';
  if (MISSED.includes(row.outcome)) return 'missed';
  return 'new';
}

function leadBucket(row, today) {
  if (row.customer_id && row.stage === 'converted') return 'closed';
  if (row.stage === 'converted' || row.stage === 'done' || ['Won', 'Lost', 'Archived'].includes(row.status)) return 'closed';
  if (row.stage === 'followup' && validDate(row.follow_up_date)) return dateBucket(row.follow_up_date, today);
  if (row.stage === 'waiting') return 'waiting';
  return 'new';
}

function taskBucket(row, today) {
  if (ISSUE_CLOSED.includes(row.status)) return 'completed';
  if (validDate(row.due_date)) return dateBucket(row.due_date, today);
  return 'new';
}

module.exports = function (app, { db, auth, logAction, clean }) {
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_state(message_id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open', follow_up_date TEXT,
    snooze_until TEXT, assigned_to TEXT, note TEXT, updated_by TEXT, updated_at TEXT NOT NULL)`);
  for (const [t, c] of [['calls', 'assigned_to'], ['calls', 'handled_at'], ['calls', 'handled_by'], ['leads', 'assigned_to'], ['customer_issues', 'assigned_to'], ['inbox_state', 'task_id']]) {
    if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`);
  }
  const today = () => bizToday();

  // ---- Items, sorted into buckets ----
  function items(dept) {
    const t = today(), now = nowIso();
    if (dept === 'emails') {
      return db.prepare(`SELECT m.id, m.from_name, m.from_addr, m.subject, m.preview, m.received_at, m.lead_id, m.customer_id,
          s.status AS state, s.follow_up_date, s.snooze_until, s.assigned_to, s.note, s.updated_at AS state_at
        FROM inbox_messages m LEFT JOIN inbox_state s ON s.message_id = m.id
        WHERE m.from_addr NOT LIKE '%@brightclean.net' ORDER BY m.received_at DESC LIMIT 1000`).all().map(r => ({
          dept, id: r.id, title: r.subject || '(no subject)', who: r.from_name || r.from_addr, when: r.received_at,
          assigned_to: r.assigned_to, lead_id: r.lead_id, customer_id: r.customer_id, due: r.follow_up_date || (r.snooze_until ? r.snooze_until.slice(0, 10) : null),
          bucket: emailBucket(r, r.state ? { status: r.state, follow_up_date: r.follow_up_date, snooze_until: r.snooze_until } : null, t, now), note: r.note,
          link: `/api/admin/inbox?lead_id=${r.lead_id || ''}`
        }));
    }
    if (dept === 'sent') {
      // Outgoing emails. A reply from the same address after sending means the email is answered.
      return db.prepare(`SELECT e.id, e.to_addr, e.subject, e.status, e.error, e.created_at,
          (SELECT MIN(m.received_at) FROM inbox_messages m WHERE LOWER(m.from_addr) = LOWER(e.to_addr) AND m.received_at > e.created_at) AS replied_at
        FROM email_log e ORDER BY e.created_at DESC LIMIT 1000`).all().map(r => ({
          dept, id: r.id, title: r.subject || '(no subject)', who: r.to_addr || '', when: r.created_at,
          assigned_to: null, lead_id: null, customer_id: null, due: null,
          bucket: r.status === 'failed' ? 'new' : r.replied_at ? 'completed' : 'waiting',
          note: r.status === 'failed' ? (r.error || 'Not delivered') : r.replied_at ? 'Replied' : 'Awaiting reply'
        }));
    }
    if (dept === 'calls') {
      return db.prepare(`SELECT id, direction, phone, contact_name, company, customer_id, lead_id, outcome, handling, summary, follow_up_date, follow_up_done,
          assigned_to, handled_at, created_at FROM calls ORDER BY created_at DESC LIMIT 1000`).all().map(r => ({
          dept, id: r.id, title: `${r.direction || 'Call'} · ${r.outcome || ''}`.trim(), who: r.contact_name || r.company || r.phone || 'Unknown caller',
          when: r.created_at, assigned_to: r.assigned_to, lead_id: r.lead_id, customer_id: r.customer_id, due: r.follow_up_date || null,
          bucket: callBucket(r, t), note: r.summary || ''
        }));
    }
    if (dept === 'leads') {
      return db.prepare(`SELECT id, kind, contact_name, company, email, phone, status, stage, follow_up_date, follow_up_note, customer_id, assigned_to, created_at
          FROM leads WHERE status <> 'Archived' ORDER BY COALESCE(follow_up_date,'9999'), id DESC LIMIT 1000`).all().map(r => ({
          dept, id: r.id, title: r.company || r.contact_name || `Lead #${r.id}`, who: r.contact_name || r.email || r.phone || '', when: r.created_at,
          assigned_to: r.assigned_to, lead_id: r.id, customer_id: r.customer_id, due: r.follow_up_date || null,
          bucket: leadBucket(r, t), note: r.follow_up_note || '', needs_next_action: r.stage === 'worked' && !r.follow_up_date
        }));
    }
    if (dept === 'tasks') {
      // Follow-up tasks that belong to a lead or call are shown on that record, not twice.
      return db.prepare(`SELECT i.id, i.type, i.title, i.status, i.priority, i.assigned_to, i.due_date, i.customer_id, i.created_at
          FROM customer_issues i
          WHERE i.id NOT IN (SELECT follow_up_issue_id FROM leads WHERE follow_up_issue_id IS NOT NULL)
            AND i.id NOT IN (SELECT callback_issue_id FROM calls WHERE callback_issue_id IS NOT NULL)
          ORDER BY COALESCE(NULLIF(i.due_date,''),'9999'), i.id DESC LIMIT 1000`).all().map(r => ({
          dept, id: r.id, title: r.title, who: r.type, when: r.created_at, assigned_to: r.assigned_to, lead_id: null, customer_id: r.customer_id,
          due: r.due_date || null, bucket: taskBucket(r, t), priority: r.priority
        }));
    }
    throw new Error('unknown department');
  }

  // Sort: overdue first, then today, new, waiting, scheduled, then history.
  const ORDER = { overdue: 0, today: 1, missed: 2, new: 3, waiting: 4, scheduled: 5, completed: 6, closed: 7 };
  const sortItems = list => list.sort((a, b) => (ORDER[a.bucket] ?? 9) - (ORDER[b.bucket] ?? 9) || String(a.due || '9999').localeCompare(String(b.due || '9999')));

  app.get('/api/admin/work-queue', auth, (req, res) => {
    const dept = String(req.query.dept || 'tasks');
    if (!DEPTS.includes(dept)) return res.status(400).json({ error: 'Unknown department.' });
    const bucket = req.query.bucket ? String(req.query.bucket) : null;
    const assignee = req.query.assigned_to ? String(req.query.assigned_to) : null;
    let list = items(dept);
    if (bucket && bucket !== 'all') list = list.filter(x => x.bucket === bucket);
    if (assignee === 'unassigned') list = list.filter(x => !x.assigned_to);
    else if (assignee) list = list.filter(x => x.assigned_to === assignee);
    res.json({ dept, bucket: bucket || 'all', today: today(), timezone: TZ, items: sortItems(list).slice(0, 500) });
  });

  // Counts for the command center: one number per department and bucket. Counts come from the same rules as the lists.
  function summary() {
    const out = {};
    for (const d of DEPTS) {
      const list = items(d), c = { all: list.length };
      for (const x of list) c[x.bucket] = (c[x.bucket] || 0) + 1;
      c.unassigned = list.filter(x => !x.assigned_to && !['completed', 'closed'].includes(x.bucket)).length;
      out[d] = c;
    }
    return out;
  }
  app.get('/api/admin/work-queue/summary', auth, (req, res) => res.json({ today: today(), timezone: TZ, counts: summary() }));

  // ---- Actions (each one is audited) ----
  // Emails: handle, wait, schedule (follow-up date or snooze), or assign. Opening an email never changes its state.
  app.post('/api/admin/inbox/:id/state', auth, (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare('SELECT id, subject FROM inbox_messages WHERE id=?').get(id);
    if (!m) return res.status(404).json({ error: 'Email not found.' });
    const b = req.body || {};
    const action = clean(b.action, 30);
    const cur = db.prepare('SELECT * FROM inbox_state WHERE message_id=?').get(id) || { status: 'open' };
    const t = nowIso(), who = (req.user && req.user.email) || 'admin';
    const next = { ...cur, message_id: id };
    if (action === 'handle') { next.status = 'completed'; next.follow_up_date = null; next.snooze_until = null; }
    else if (action === 'waiting') { next.status = 'waiting'; }
    else if (action === 'reopen') { next.status = 'open'; next.snooze_until = null; }
    else if (action === 'schedule') {
      if (!validDate(b.date)) return res.status(400).json({ error: 'Choose a valid follow-up date.' });
      next.status = 'open'; next.follow_up_date = b.date; next.snooze_until = null;
    }
    else if (action === 'snooze') {
      const until = String(b.until || '');
      if (!until || isNaN(Date.parse(until))) return res.status(400).json({ error: 'Choose when to bring it back.' });
      next.status = 'open'; next.snooze_until = new Date(until).toISOString();
    }
    else if (action === 'assign') { next.assigned_to = clean(b.assigned_to, 120) || null; }
    else return res.status(400).json({ error: 'Unknown email action.' });
    if (b.note !== undefined) next.note = clean(b.note, 500) || null;
    next.updated_by = who; next.updated_at = t;
    db.prepare(`INSERT INTO inbox_state(message_id,status,follow_up_date,snooze_until,assigned_to,note,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(message_id) DO UPDATE SET status=excluded.status, follow_up_date=excluded.follow_up_date, snooze_until=excluded.snooze_until,
      assigned_to=excluded.assigned_to, note=excluded.note, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(id, next.status, next.follow_up_date || null, next.snooze_until || null, next.assigned_to || null, next.note || null, who, t);
    logAction(req, `email ${action}`, 'inbox_message', id, `${m.subject || ''}${next.follow_up_date ? ' → ' + next.follow_up_date : ''}${next.snooze_until ? ' → snoozed until ' + next.snooze_until : ''}`);
    res.json({ ok: true, status: next.status });
  });

  // Create a task from an email. Pressing it again returns the same open task (no duplicates).
  app.post('/api/admin/inbox/:id/task', auth, (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare('SELECT * FROM inbox_messages WHERE id=?').get(id);
    if (!m) return res.status(404).json({ error: 'Email not found.' });
    const st = db.prepare('SELECT * FROM inbox_state WHERE message_id=?').get(id);
    if (st && st.task_id) {
      const open = db.prepare("SELECT id FROM customer_issues WHERE id=? AND status NOT IN ('Resolved','Verified','Closed')").get(st.task_id);
      if (open) return res.json({ ok: true, task_id: open.id, existing: true });
    }
    const b = req.body || {}, t = nowIso(), who = (req.user && req.user.email) || 'admin';
    const due = validDate(b.due_date) ? b.due_date : null;
    const title = clean(`Reply: ${m.subject || m.from_name || m.from_addr}`, 200);
    const tid = db.prepare("INSERT INTO customer_issues(type,title,description,priority,status,assigned_to,due_date,customer_comms,created_by,created_at,updated_at,customer_id) VALUES('task',?,?,?,?,?,?,?,?,?,?,?)")
      .run(title, clean(`From email from ${m.from_name || ''} <${m.from_addr || ''}>\n${m.preview || ''}`, 1500), 'Normal', 'Open', clean(b.assigned_to, 120) || null, due, 'Not needed', who, t, t, m.customer_id || null).lastInsertRowid;
    db.prepare(`INSERT INTO inbox_state(message_id,status,task_id,updated_by,updated_at) VALUES(?,'open',?,?,?)
      ON CONFLICT(message_id) DO UPDATE SET task_id=excluded.task_id, updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(id, tid, who, t);
    logAction(req, 'created task from email', 'inbox_message', id, `task #${tid}`);
    res.json({ ok: true, task_id: tid, existing: false });
  });

  // Calls: handle the call, or schedule a callback (leaves Today, shows in Scheduled until its date), or assign.
  app.post('/api/admin/calls/:id/work', auth, (req, res) => {
    const id = Number(req.params.id);
    const c = db.prepare('SELECT id, contact_name, phone FROM calls WHERE id=?').get(id);
    if (!c) return res.status(404).json({ error: 'Call not found.' });
    const b = req.body || {}, action = clean(b.action, 30), who = (req.user && req.user.email) || 'admin', t = nowIso();
    if (action === 'handle') {
      db.prepare('UPDATE calls SET follow_up_done=1, handled_at=?, handled_by=?, follow_up_date=NULL WHERE id=?').run(t, who, id);
    } else if (action === 'schedule') {
      if (!validDate(b.date)) return res.status(400).json({ error: 'Choose a valid callback date.' });
      db.prepare('UPDATE calls SET follow_up_date=?, follow_up_done=0, handled_at=NULL, handled_by=?, handling=?, assigned_to=COALESCE(?,assigned_to) WHERE id=?')
        .run(b.date, who, 'Callback', clean(b.assigned_to, 120) || null, id);
    } else if (action === 'waiting') {
      db.prepare("UPDATE calls SET handling='Waiting' WHERE id=?").run(id);
    } else if (action === 'assign') {
      db.prepare('UPDATE calls SET assigned_to=? WHERE id=?').run(clean(b.assigned_to, 120) || null, id);
    } else return res.status(400).json({ error: 'Unknown call action.' });
    logAction(req, `call ${action}`, 'call', id, b.date ? `callback ${b.date}` : (b.assigned_to ? `assigned to ${b.assigned_to}` : ''));
    res.json({ ok: true });
  });

  // Leads: assign an owner. Scheduling a lead's next action stays on the existing lead follow-up.
  app.post('/api/admin/leads/:id/assign', auth, (req, res) => {
    const id = Number(req.params.id);
    const l = db.prepare('SELECT id FROM leads WHERE id=?').get(id);
    if (!l) return res.status(404).json({ error: 'Lead not found.' });
    const who = clean((req.body || {}).assigned_to, 120) || null;
    db.prepare('UPDATE leads SET assigned_to=?, updated_at=? WHERE id=?').run(who, nowIso(), id);
    logAction(req, 'assigned lead', 'lead', id, who || 'unassigned');
    res.json({ ok: true });
  });

  // Tasks: assign, or set the due date (scheduling moves it out of Today).
  app.post('/api/admin/tasks/:id/work', auth, (req, res) => {
    const id = Number(req.params.id);
    const tk = db.prepare('SELECT id FROM customer_issues WHERE id=?').get(id);
    if (!tk) return res.status(404).json({ error: 'Task not found.' });
    const b = req.body || {}, t = nowIso();
    if (b.assigned_to !== undefined) db.prepare('UPDATE customer_issues SET assigned_to=?, updated_at=? WHERE id=?').run(clean(b.assigned_to, 120) || null, t, id);
    if (b.due_date !== undefined) {
      if (b.due_date && !validDate(b.due_date)) return res.status(400).json({ error: 'Choose a valid date.' });
      db.prepare('UPDATE customer_issues SET due_date=?, updated_at=? WHERE id=?').run(b.due_date || null, t, id);
    }
    logAction(req, 'updated task schedule', 'issue', id, `${b.due_date ? 'due ' + b.due_date : ''} ${b.assigned_to !== undefined ? 'assigned ' + (b.assigned_to || 'none') : ''}`.trim());
    res.json({ ok: true });
  });

  // ---- End-of-day closeout for one business day (business time zone, not UTC) ----
  app.get('/api/admin/closeout', auth, (req, res) => {
    const d = String(req.query.date || today());
    if (!validDate(d)) return res.status(400).json({ error: 'Choose a valid date.' });
    const [from, to] = dayBounds(d);
    const win = [from, to];
    const one = (sql, ...a) => (db.prepare(sql).get(...a) || {}).n || 0;
    const t = today();
    const s = summary();
    const report = {
      date: d, timezone: TZ,
      new_leads_received: one('SELECT COUNT(*) n FROM leads WHERE created_at >= ? AND created_at < ?', ...win),
      calls_handled: one('SELECT COUNT(*) n FROM calls WHERE handled_at >= ? AND handled_at < ?', ...win),
      emails_handled: one("SELECT COUNT(*) n FROM inbox_state WHERE status='completed' AND updated_at >= ? AND updated_at < ?", ...win),
      follow_ups_completed: one('SELECT COUNT(*) n FROM calls WHERE follow_up_done=1 AND handled_at >= ? AND handled_at < ?', ...win),
      tasks_completed: one("SELECT COUNT(*) n FROM customer_issues WHERE status IN ('Resolved','Verified','Closed') AND COALESCE(resolved_at,updated_at) >= ? AND COALESCE(resolved_at,updated_at) < ?", ...win),
      activities_rescheduled: one("SELECT COUNT(*) n FROM audit_log WHERE created_at >= ? AND created_at < ? AND (action IN ('email schedule','email snooze','call schedule','updated task schedule'))", ...win),
      overdue_now: (s.emails.overdue || 0) + (s.calls.overdue || 0) + (s.leads.overdue || 0) + (s.tasks.overdue || 0),
      awaiting_customer: (s.emails.waiting || 0) + (s.calls.waiting || 0) + (s.leads.waiting || 0),
      unassigned_open: (s.emails.unassigned || 0) + (s.calls.unassigned || 0) + (s.leads.unassigned || 0) + (s.tasks.unassigned || 0),
      needs_attention_now: (s.emails.new || 0) + (s.calls.new || 0) + (s.calls.missed || 0) + (s.leads.new || 0),
      exceptions: []
    };
    if (report.overdue_now) report.exceptions.push(report.overdue_now + ' item(s) overdue');
    if (report.unassigned_open) report.exceptions.push(report.unassigned_open + ' open item(s) with no owner');
    if (d === t && report.calls_handled === 0) report.exceptions.push('No calls handled yet today');
    if (d < t) report.note = 'Past day: overdue and needs-attention counts show the current state, not the state on that day.';
    res.json(report);
  });

  return { summary, items, dateBucket };
};

module.exports.dateBucket = dateBucket;
module.exports.emailBucket = emailBucket;
module.exports.callBucket = callBucket;
module.exports.leadBucket = leadBucket;
module.exports.taskBucket = taskBucket;
