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

const DEPTS = ['emails', 'calls', 'leads', 'tasks', 'sent', 'messages', 'inspections', 'invoices'];
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

// A client conversation: needs a reply, waiting on the customer, follow-up date, or answered.
function messageBucket(r, today) {
  if (r.status === 'Closed') return 'closed';
  if (r.needs_reply) return 'new';
  if (r.status === 'Waiting on customer') return 'waiting';
  if (r.follow_up_date) return r.follow_up_date < today ? 'overdue' : r.follow_up_date === today ? 'today' : 'scheduled';
  return 'completed';
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

// Leads. "contact_today" = never contacted and received today; an untouched lead from an earlier day is "overdue".
// Qualified = a site walkthrough or proposal is in progress. Converted = now a customer (or won). Lost/archived = closed.
function leadBucket(row, today, bizDayOf) {
  if (row.stage === 'converted' || row.customer_id || row.status === 'Won') return 'converted';
  if (row.status === 'Lost' || row.status === 'Archived' || row.stage === 'done') return 'closed';
  if (row.stage === 'followup' && validDate(row.follow_up_date)) return dateBucket(row.follow_up_date, today);
  if (row.stage === 'waiting') return 'waiting';
  if (['Site Walkthrough', 'Proposal in Progress', 'Proposal Sent'].includes(row.status)) return 'qualified';
  if (row.stage === 'new') return bizDayOf(row.created_at) === today ? 'contact_today' : 'overdue';
  return 'new';
}

// Business-day date (YYYY-MM-DD) of an ISO timestamp.
const bizDayOf = iso => {
  const d = new Date(iso);
  return isNaN(d) ? '' : new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};

// A missed call is escalated once nobody has returned it within the threshold (minutes; default 60, set MISSED_CALL_ESCALATE_MINUTES).
const ESCALATE_MIN = Number(process.env.MISSED_CALL_ESCALATE_MINUTES) || 60;
function isEscalated(row, nowMs = Date.now(), minutes = ESCALATE_MIN) {
  return MISSED.includes(row.outcome) && !row.handled_at && row.follow_up_done !== 1 && !validDate(row.follow_up_date)
    && row.handling !== 'Waiting' && Date.parse(row.created_at) < nowMs - minutes * 60000;
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
  for (const [t, c] of [['calls', 'assigned_to'], ['calls', 'handled_at'], ['calls', 'handled_by'], ['leads', 'assigned_to'], ['customer_issues', 'assigned_to'], ['inbox_state', 'task_id'], ['inbox_state', 'project_id']]) {
    if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`);
  }
  const today = () => bizToday();

  // ---- Items, sorted into buckets ----
  let viewerFinance = false; // set by the queue routes before they build a list

  function items(dept) {
    const t = today(), now = nowIso();
    if (dept === 'emails') {
      // The state of each email comes from the work engine (one lifecycle for all work). Project links stay on the email's own record.
      const WE = require('./work-engine');
      return db.prepare(`SELECT m.id, m.from_name, m.from_addr, m.subject, m.preview, m.received_at, m.lead_id, m.customer_id,
          (SELECT project_id FROM inbox_state WHERE message_id = m.id) AS project_id
        FROM inbox_messages m
        WHERE m.from_addr NOT LIKE '%@brightclean.net' ORDER BY m.received_at DESC LIMIT 1000`).all().map(r => {
          const st = WE.emailState(db, r.id);
          return {
            dept, id: r.id, title: r.subject || '(no subject)', who: r.from_name || r.from_addr, when: r.received_at,
            assigned_to: st ? st.assigned_to : null, lead_id: r.lead_id, customer_id: r.customer_id, project_id: r.project_id || null,
            due: st && st.follow_up_date ? st.follow_up_date : null,
            bucket: emailBucket(r, st, t, now), note: st ? st.note : null
          };
        });
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
      const WE = require('./work-engine');
      return db.prepare(`SELECT id, direction, phone, contact_name, company, customer_id, lead_id, outcome, handling, summary, follow_up_date, follow_up_done,
          assigned_to, handled_at, created_at FROM calls ORDER BY created_at DESC LIMIT 1000`).all().map(r => {
          // A call with a work item takes its state from the engine; a call without one keeps the rules it always had.
          const st = WE.callState(db, r.id);
          let bucket, due = r.follow_up_date || null, owner = r.assigned_to;
          if (st) {
            due = st.due; owner = st.assigned_to;
            const finished = st.item_status === 'completed' || st.item_status === 'cancelled';
            bucket = finished ? 'completed' : st.item_status === 'waiting' ? 'waiting' : validDate(due) ? dateBucket(due, t) : (MISSED.includes(r.outcome) ? 'missed' : 'new');
          } else bucket = callBucket(r, t);
          return {
            dept, id: r.id, title: `${r.direction || 'Call'} · ${r.outcome || ''}`.trim(), who: r.contact_name || r.company || r.phone || 'Unknown caller',
            when: r.created_at, assigned_to: owner, lead_id: r.lead_id, customer_id: r.customer_id, due: due || null,
            bucket, note: r.summary || '', escalated: bucket === 'missed' && Date.parse(r.created_at) < Date.now() - ESCALATE_MIN * 60000
          };
        });
    }
    if (dept === 'leads') {
      return db.prepare(`SELECT id, kind, contact_name, company, email, phone, status, stage, follow_up_date, follow_up_note, customer_id, assigned_to, created_at
          FROM leads WHERE status <> 'Archived' ORDER BY COALESCE(follow_up_date,'9999'), id DESC LIMIT 1000`).all().map(r => {
          // A lead's next step comes from the work engine when it has one. Converted and closed leads keep their own state.
          const st = require('./work-engine').leadState(db, r.id);
          let bucket = leadBucket(r, t, bizDayOf), due = r.follow_up_date || null;
          if (st && !['converted', 'closed'].includes(bucket)) {
            due = st.due;
            if (st.item_status === 'waiting') bucket = 'waiting';
            else if (validDate(st.due)) bucket = dateBucket(st.due, t);
          }
          return {
            dept, id: r.id, title: r.company || r.contact_name || `Lead #${r.id}`, who: r.contact_name || r.email || r.phone || '', when: r.created_at,
            assigned_to: r.assigned_to, lead_id: r.id, customer_id: r.customer_id, due: due || null,
            bucket, note: r.follow_up_note || '', needs_next_action: r.stage === 'worked' && !r.follow_up_date && !['converted', 'done'].includes(r.stage)
          };
        });
    }
    if (dept === 'invoices') {
      // Unpaid invoices and their follow-up. Owner and manager only (set by the route before this runs).
      if (!viewerFinance) return [];
      const WE = require('./work-engine'), R = require('./receivables');
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invoices'").get()) return [];
      const rows = db.prepare(`SELECT id, invoice_number, customer_name, company, status, due_date, issue_date, created_at FROM invoices WHERE status NOT IN ('Draft') ORDER BY id DESC LIMIT 1000`).all();
      const out = [];
      for (const r of rows) {
        const owed = R.invoiceBalance(db, r.id).owed;
        const finished = !(owed > 0.005) || r.status === 'Void';
        const st = WE.invoiceState(db, r.id);
        // Paid or void invoices need no follow-up: close any open item (the invoice's balance is the source of truth).
        if (finished) { if (st) WE.closeInvoiceWork(db, r.id, finished && r.status === 'Void' ? 'Invoice void' : 'Paid in full', 'system'); continue; }
        const due = (st && st.due) || r.due_date || null;
        const bucket = st && st.item_status === 'waiting' ? 'waiting' : validDate(due) ? dateBucket(due, t) : 'new';
        out.push({ dept, id: r.id, title: `${r.invoice_number || 'Invoice #' + r.id}${r.customer_name || r.company ? ' · ' + (r.customer_name || r.company) : ''}`,
          who: r.company || r.customer_name || '', when: r.created_at, assigned_to: st ? st.assigned_to : null, lead_id: null, customer_id: null,
          due: due || null, bucket, note: `Owed ${owed.toFixed(2)} · ${r.status || ''}`, status: r.status });
      }
      return out;
    }
    if (dept === 'inspections') {
      // Inspections with work left: signing, corrective work, reinspection or customer acceptance. Finished ones are Completed.
      const WE = require('./work-engine');
      return db.prepare(`SELECT id, area, status, date, inspector, itype, customer_id, project_id, score, passed, created_at FROM inspections
          ORDER BY id DESC LIMIT 1000`).all().map(r => {
          const open = WE.INSPECTION_OPEN.includes(r.status);
          const st = open ? WE.inspState(db, r.id) : null;
          const due = (st && st.due) || null, owner = st ? st.assigned_to : null;
          let bucket = !open ? 'completed' : (r.status === 'Corrective action' || r.status === 'Awaiting customer') ? 'waiting'
            : validDate(due) ? dateBucket(due, t) : 'new';
          return { dept, id: r.id, title: r.area || `Inspection #${r.id}`, who: r.itype || '', when: r.created_at, assigned_to: owner,
            lead_id: null, customer_id: r.customer_id || null, due, bucket, note: r.status || '', status: r.status };
        });
    }
    if (dept === 'tasks') {
      // Follow-up tasks that belong to a lead or call are shown on that record, not twice.
      const WE = require('./work-engine');
      return db.prepare(`SELECT i.id, i.type, i.title, i.status, i.priority, i.assigned_to, i.due_date, i.customer_id, i.created_at
          FROM customer_issues i
          WHERE i.id NOT IN (SELECT follow_up_issue_id FROM leads WHERE follow_up_issue_id IS NOT NULL)
            AND i.id NOT IN (SELECT callback_issue_id FROM calls WHERE callback_issue_id IS NOT NULL)
            AND NOT (i.type='follow_up' AND i.title LIKE 'Follow up: %')
          ORDER BY COALESCE(NULLIF(i.due_date,''),'9999'), i.id DESC LIMIT 1000`).all().map(r => {
          // A task's queue state comes from its work item when it has one; the task's own status still decides when it is finished.
          const st = WE.issueState(db, r.id);
          let bucket = taskBucket(r, t), due = r.due_date || null, owner = r.assigned_to;
          if (st && !ISSUE_CLOSED.includes(r.status)) {
            due = st.due || due; owner = st.assigned_to;
            if (st.item_status === 'waiting') bucket = 'waiting';
            else if (validDate(st.due)) bucket = dateBucket(st.due, t);
          }
          return { dept, id: r.id, title: r.title, who: r.type, when: r.created_at, assigned_to: owner, lead_id: null, customer_id: r.customer_id,
            due: due || null, bucket, priority: r.priority };
        });
    }
    if (dept === 'messages') {
      const inbox = require('./clientmsgs').inbox;
      return inbox().map(r => ({
        dept, id: r.key, title: r.company ? r.type + ' · ' + r.company : r.type, who: r.name, when: r.last_at,
        assigned_to: r.owner || null, lead_id: r.key.startsWith('lead:') ? Number(r.key.slice(5)) : null,
        customer_id: r.key.startsWith('cust:') ? Number(r.key.slice(5)) : null, due: r.follow_up_date || null,
        bucket: messageBucket(r, t), note: (r.needs_reply ? 'Needs reply: ' : '') + (r.last_text || '')
      }));
    }
    throw new Error('unknown department');
  }

  // Sort: overdue first, then today, new, waiting, scheduled, then history.
  const ORDER = { overdue: 0, contact_today: 1, today: 1, missed: 2, new: 3, waiting: 4, qualified: 5, scheduled: 6, converted: 7, completed: 8, closed: 9 };
  // Escalated missed calls first, then by bucket, then by due date.
  const sortItems = list => list.sort((a, b) => (b.escalated ? 1 : 0) - (a.escalated ? 1 : 0) || (ORDER[a.bucket] ?? 99) - (ORDER[b.bucket] ?? 99) || String(a.due || '9999').localeCompare(String(b.due || '9999')));

  // Who may see money on the queue: the owner and managers. Set synchronously before the queue is built.
  const financeViewer = req => { const em = String((req.user && req.user.email) || '').toLowerCase(); if (process.env.ADMIN_EMAIL && em === String(process.env.ADMIN_EMAIL).toLowerCase()) return true; const row = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(em); return !!row && ['owner', 'manager'].includes(row.role); };

  app.get('/api/admin/work-queue', auth, (req, res) => {
    const dept = String(req.query.dept || 'tasks');
    viewerFinance = financeViewer(req);
    if (dept === 'invoices' && !viewerFinance) return res.status(403).json({ error: 'Only an owner or manager can see invoices on the work queue.' });
    if (!DEPTS.includes(dept)) return res.status(400).json({ error: 'Unknown department.' });
    const bucket = req.query.bucket ? String(req.query.bucket) : null;
    const assignee = req.query.assigned_to ? String(req.query.assigned_to) : null;
    let list = items(dept);
    if (bucket && bucket !== 'all') list = list.filter(x => x.bucket === bucket);
    const priority = req.query.priority ? String(req.query.priority) : null;
    if (priority && dept === 'tasks') list = list.filter(x => String(x.priority || '').toLowerCase() === priority.toLowerCase());
    if (assignee === 'unassigned') list = list.filter(x => !x.assigned_to);
    else if (assignee) list = list.filter(x => x.assigned_to === assignee);
    res.json({ dept, bucket: bucket || 'all', today: today(), timezone: TZ, items: sortItems(list).slice(0, 500) });
  });

  // Counts for the command center: one number per department and bucket. Counts come from the same rules as the lists.
  function summary() {
    const out = {};
    for (const d of DEPTS) {
      if (d === 'invoices' && !viewerFinance) continue;
      const list = items(d), c = { all: list.length };
      // open: what still needs doing (not completed or closed). The tab count shows this.
      c.open = list.filter(x => !['completed', 'closed'].includes(x.bucket)).length;
      for (const x of list) c[x.bucket] = (c[x.bucket] || 0) + 1;
      c.unassigned = list.filter(x => !x.assigned_to && !['completed', 'closed'].includes(x.bucket)).length;
      out[d] = c;
    }
    return out;
  }
  // Today's schedule: visits on the day, and follow-ups due that day or earlier that are still open.
  app.get('/api/admin/work-queue/schedule', auth, (req, res) => {
    const day = validDate(req.query.date) ? String(req.query.date) : today();
    const visits = db.prepare("SELECT id, title, type, date, start_time, end_time, address, customer_id, lead_id, assigned_to, status FROM visits WHERE date=? AND status NOT IN ('Cancelled') ORDER BY COALESCE(start_time,'99:99'), id").all(day);
    const fuLeads = db.prepare("SELECT id, contact_name, company, follow_up_date, follow_up_note, assigned_to FROM leads WHERE follow_up_date IS NOT NULL AND follow_up_date<>'' AND follow_up_date<=? AND status NOT IN ('Won','Lost','Archived') ORDER BY follow_up_date, id LIMIT 200").all(day);
    // Callbacks due today or earlier, from the call queue (engine state), so a finished or waiting call is not listed twice.
    const fuCalls = items('calls').filter(c => c.bucket !== 'completed' && validDate(c.due) && c.due <= day).sort((a, b) => String(a.due).localeCompare(String(b.due)) || a.id - b.id).slice(0, 200)
      .map(c => ({ id: c.id, company: null, contact_name: c.who, phone: null, follow_up_date: c.due, summary: c.note, assigned_to: c.assigned_to }));
    const fuTasks = db.prepare("SELECT id, title, type, due_date, assigned_to, customer_id FROM customer_issues WHERE due_date IS NOT NULL AND due_date<>'' AND due_date<=? AND status NOT IN ('Resolved','Verified','Closed') ORDER BY due_date, id LIMIT 200").all(day);
    const follow_ups = [
      ...fuLeads.map(l => ({ kind: 'lead', id: l.id, date: l.follow_up_date, who: l.company || l.contact_name || 'Lead #' + l.id, what: l.follow_up_note || 'Lead follow-up', owner: l.assigned_to || null, overdue: l.follow_up_date < day })),
      ...fuCalls.map(c => ({ kind: 'callback', id: c.id, date: c.follow_up_date, who: c.company || c.contact_name || c.phone || 'Caller', what: 'Callback: ' + (c.summary || '').slice(0, 80), owner: c.assigned_to || null, overdue: c.follow_up_date < day })),
      ...fuTasks.map(k => ({ kind: 'task', id: k.id, date: k.due_date, who: k.type, what: k.title, owner: k.assigned_to || null, overdue: k.due_date < day }))
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    res.json({ date: day, appointments: visits, follow_ups });
  });

  // Assistant: suggestions only. Each one is counted from the same rules as the lists and opens that list. Nothing is changed.
  app.get('/api/admin/work-queue/assistant', auth, (req, res) => {
    const c = {};
    for (const d of ['messages', 'tasks', 'leads', 'calls']) { const list = items(d); c[d] = { list, count: (b) => list.filter(x => x.bucket === b).length }; }
    const out = [];
    const msgs = c.messages.count('new');
    if (msgs) out.push({ text: 'Reply to ' + msgs + ' customer message' + (msgs === 1 ? '' : 's') + ' that ' + (msgs === 1 ? 'is' : 'are') + ' waiting for an answer.', count: msgs, dept: 'messages', bucket: 'new' });
    const overdueTasks = c.tasks.count('overdue');
    if (overdueTasks) out.push({ text: overdueTasks + ' task' + (overdueTasks === 1 ? ' is' : 's are') + ' overdue. Complete or reschedule them.', count: overdueTasks, dept: 'tasks', bucket: 'overdue' });
    const untouched = c.leads.list.filter(x => x.needs_next_action || x.bucket === 'new').length;
    if (untouched) out.push({ text: untouched + ' lead' + (untouched === 1 ? ' needs' : 's need') + ' a first contact or a next step.', count: untouched, dept: 'leads', bucket: 'new' });
    const missed = c.calls.count('missed');
    if (missed) out.push({ text: 'Call back ' + missed + ' missed call' + (missed === 1 ? '' : 's') + '.', count: missed, dept: 'calls', bucket: 'missed' });
    const overdueLeads = c.leads.count('overdue');
    if (overdueLeads) out.push({ text: overdueLeads + ' new lead' + (overdueLeads === 1 ? ' has' : 's have') + ' not been contacted since an earlier day.', count: overdueLeads, dept: 'leads', bucket: 'overdue' });
    res.json({ today: today(), suggestions: out, note: 'Suggestions only. Nothing is changed until a person acts on an item.' });
  });

  app.post('/api/admin/work-queue/invoices/:id/work', auth, (req, res) => {
    if (!financeViewer(req)) return res.status(403).json({ error: 'Only an owner or manager can work invoices on the queue.' });
    const b = req.body || {}, who = (req.user && req.user.email) || 'admin';
    try {
      const item = require('./work-engine').applyInvoiceAction(db, Number(req.params.id), b, who);
      logAction(req, `invoice ${String(b.action || '')}`, 'invoice', Number(req.params.id), b.action === 'assign' ? 'assigned ' + (b.assigned_to || 'none') : (b.date || '') + (b.waiting_on ? ' ' + b.waiting_on : ''));
      res.json({ ok: true, item });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/admin/work-queue/summary', auth, (req, res) => { viewerFinance = financeViewer(req); res.json({ today: today(), timezone: TZ, counts: summary() }); });

  // ---- Actions (each one is audited) ----
  // Emails: handle, wait, schedule (follow-up date or snooze), or assign. Opening an email never changes its state.
  app.post('/api/admin/inbox/:id/state', auth, (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare('SELECT id, subject FROM inbox_messages WHERE id=?').get(id);
    if (!m) return res.status(404).json({ error: 'Email not found.' });
    // Every email action goes through the work engine, which enforces the rules: a note to complete, a reason to cancel or reopen,
    // a reason and follow-up date to wait. The engine's history records who did it and when.
    const b = req.body || {};
    const action = clean(b.action, 30);
    const who = (req.user && req.user.email) || 'admin';
    const WE = require('./work-engine');
    try {
      const item = WE.applyEmailAction(db, id, { ...b, action }, who);
      logAction(req, `email ${action}`, 'inbox_message', id, `${m.subject || ''}${item.due_date ? ' → ' + item.due_date : ''}${b.reason || b.note ? ' — ' + clean(b.reason || b.note, 200) : ''}`);
      res.json({ ok: true, status: item.status === 'completed' || item.status === 'cancelled' ? 'completed' : item.status === 'waiting' ? 'waiting' : 'open', item_status: item.status });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Link an email to a lead, customer and/or project. Only records that exist can be linked.
  app.post('/api/admin/inbox/:id/link', auth, (req, res) => {
    const id = Number(req.params.id);
    const m = db.prepare('SELECT id, subject FROM inbox_messages WHERE id=?').get(id);
    if (!m) return res.status(404).json({ error: 'Email not found.' });
    const b = req.body || {};
    const lead = b.lead_id ? Number(b.lead_id) : null, customer = b.customer_id ? Number(b.customer_id) : null, project = b.project_id ? Number(b.project_id) : null;
    if (lead && !db.prepare('SELECT id FROM leads WHERE id=?').get(lead)) return res.status(400).json({ error: 'That lead does not exist.' });
    if (customer && !db.prepare('SELECT id FROM customers WHERE id=?').get(customer)) return res.status(400).json({ error: 'That customer does not exist.' });
    if (project && !db.prepare('SELECT id FROM projects WHERE id=?').get(project)) return res.status(400).json({ error: 'That project does not exist.' });
    if (!lead && !customer && !project) return res.status(400).json({ error: 'Choose a lead, customer or project to link.' });
    const t = nowIso(), who = (req.user && req.user.email) || 'admin';
    if (lead) db.prepare('UPDATE inbox_messages SET lead_id=? WHERE id=?').run(lead, id);
    if (customer) db.prepare('UPDATE inbox_messages SET customer_id=? WHERE id=?').run(customer, id);
    if (project) db.prepare(`INSERT INTO inbox_state(message_id,status,project_id,updated_by,updated_at) VALUES(?,'open',?,?,?)
      ON CONFLICT(message_id) DO UPDATE SET project_id=excluded.project_id, updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(id, project, who, t);
    logAction(req, 'linked email', 'inbox_message', id, [lead && 'lead #' + lead, customer && 'customer #' + customer, project && 'project #' + project].filter(Boolean).join(', '));
    res.json({ ok: true });
  });

  // The conversation with one address: every email received from it and every email we sent to it, oldest first.
  // Attachments are not stored by the inbox sync yet, so they are not included.
  app.get('/api/admin/inbox/:id/thread', auth, (req, res) => {
    const m = db.prepare('SELECT id, from_addr FROM inbox_messages WHERE id=?').get(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'Email not found.' });
    const addr = String(m.from_addr || '').toLowerCase();
    const received = db.prepare('SELECT id, from_name, from_addr, subject, preview, received_at AS at FROM inbox_messages WHERE LOWER(from_addr)=? ORDER BY received_at').all(addr)
      .map(r => ({ kind: 'received', id: r.id, who: r.from_name || r.from_addr, subject: r.subject, text: r.preview, at: r.at }));
    const sent = db.prepare('SELECT id, to_addr, subject, body, status, created_at AS at FROM email_log WHERE LOWER(to_addr)=? ORDER BY created_at').all(addr)
      .map(r => ({ kind: 'sent', id: r.id, who: r.to_addr, subject: r.subject, text: r.body, status: r.status, at: r.at }));
    res.json({ address: addr, messages: [...received, ...sent].sort((a, b) => String(a.at).localeCompare(String(b.at))) });
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

  // Calls: complete (note required), wait (what for, and when to follow up), cancel or reopen (reason), schedule a callback, or assign.
  // Every move goes through the work engine, so the rules and the history are the same as for emails.
  app.post('/api/admin/calls/:id/work', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM calls WHERE id=?').get(id)) return res.status(404).json({ error: 'Call not found.' });
    const b = req.body || {}, action = clean(b.action, 30), who = (req.user && req.user.email) || 'admin';
    try {
      const item = require('./work-engine').applyCallAction(db, id, { ...b, action }, who);
      logAction(req, `call ${action}`, 'call', id, b.date ? `callback ${b.date}` : (b.assigned_to ? `assigned to ${b.assigned_to}` : (b.note || b.reason || '')).slice(0, 200));
      res.json({ ok: true, item });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Leads: assign an owner. Scheduling a lead's next action stays on the existing lead follow-up.
  app.post('/api/admin/leads/:id/assign', auth, (req, res) => {
    const id = Number(req.params.id);
    const l = db.prepare('SELECT id FROM leads WHERE id=?').get(id);
    if (!l) return res.status(404).json({ error: 'Lead not found.' });
    const who = clean((req.body || {}).assigned_to, 120) || null;
    const by = (req.user && req.user.email) || 'admin';
    // The lead's next step moves with it. Checked first, so a refused change leaves the lead as it was.
    try { require('./work-engine').leadReassign(db, id, who, by); }
    catch (e) { return res.status(400).json({ error: 'This lead has an open next step, so it needs an owner. ' + e.message }); }
    db.prepare('UPDATE leads SET assigned_to=?, updated_at=? WHERE id=?').run(who, nowIso(), id);
    require('./leadlog').record(db, id, 'assigned', 'Assigned to ' + (who || 'nobody'), by);
    logAction(req, 'assigned lead', 'lead', id, who || 'unassigned');
    res.json({ ok: true });
  });

  // Tasks: assign, or set the due date (scheduling moves it out of Today).
  app.post('/api/admin/tasks/:id/work', auth, async (req, res) => {
    const id = Number(req.params.id);
    const tk = db.prepare('SELECT id, title, assigned_to FROM customer_issues WHERE id=?').get(id);
    if (!tk) return res.status(404).json({ error: 'Task not found.' });
    const b = { ...(req.body || {}) };
    // Old bulk shape: assigned_to and/or due_date in one request. Each part is one queue action; the date is checked first.
    const steps = b.action ? [clean(b.action, 30)] : [];
    if (!b.action) { if (b.assigned_to !== undefined) steps.push('assign'); if (b.due_date !== undefined) steps.push('schedule'); }
    if (!steps.length) return res.status(400).json({ error: 'Nothing to change.' });
    if (steps.includes('schedule') && !b.action && b.due_date && !validDate(b.due_date)) return res.status(400).json({ error: 'Choose a valid date.' });
    // The assignee must be a person with access to Bright Clean (the same rule as issues).
    let assignee;
    if (steps.includes('assign') || b.action === 'assign') {
      assignee = clean(b.assigned_to, 254).toLowerCase();
      const known = typeof app.locals.issueUsers === 'function' ? app.locals.issueUsers() : [];
      if (assignee && !known.includes(assignee)) return res.status(400).json({ error: 'Assign to someone who has access to Bright Clean.' });
    }
    const who = (req.user && req.user.email) || 'admin', WE = require('./work-engine');
    try {
      for (const action of steps) {
        const body = action === 'schedule' ? { action, date: b.date || b.due_date } : action === 'assign' ? { action, assigned_to: assignee } : { ...b, action };
        res.locals.item = WE.applyIssueAction(db, id, body, who);
        logAction(req, `task ${action}`, 'issue', id, action === 'schedule' ? 'due ' + (b.date || b.due_date) : action === 'assign' ? 'assigned ' + (assignee || 'none') : (b.note || b.reason || b.waiting_on || '').slice(0, 200));
      }
    } catch (e) { return res.status(400).json({ error: e.message }); }
    // Tell the new assignee, as the issue route does (not when unassigned, or when they assign it to themselves).
    const by = String((req.user && req.user.email) || '').toLowerCase();
    if (assignee && assignee !== String(tk.assigned_to || '').toLowerCase() && assignee !== by && typeof app.locals.issueNotify === 'function') {
      await app.locals.issueNotify(assignee, `Assigned to you: ${tk.title}`, `${by || 'Someone'} assigned you a task: ${tk.title}\n\nOpen Bright Clean: https://brightclean.net/admin/#issues`);
    }
    res.json({ ok: true, item: res.locals.item });
  });

  // Conversation with a set of addresses (a customer's contacts, or a lead's email): mail we sent, and replies we received.
  // Replies only arrive when the Outlook inbox is connected; the response says so.
  function conversationFor(addresses) {
    const list = [...new Set(addresses.map(a => String(a || '').trim().toLowerCase()).filter(a => a.includes('@')))];
    if (!list.length) return { addresses: [], inbox_connected: inboxConnected(), messages: [] };
    const q = list.map(() => '?').join(',');
    const sent = db.prepare(`SELECT id, to_addr, subject, body, status, error, created_at AS at FROM email_log WHERE LOWER(to_addr) IN (${q}) ORDER BY created_at DESC LIMIT 500`).all(...list)
      .map(r => ({ kind: 'sent', id: r.id, who: r.to_addr, subject: r.subject, text: r.body, status: r.status, error: r.error, at: r.at }));
    const received = db.prepare(`SELECT id, from_addr, from_name, subject, preview, received_at AS at FROM inbox_messages WHERE LOWER(from_addr) IN (${q}) ORDER BY received_at DESC LIMIT 500`).all(...list)
      .map(r => ({ kind: 'reply', id: r.id, who: r.from_name || r.from_addr, subject: r.subject, text: r.preview, at: r.at }));
    return { addresses: list, inbox_connected: inboxConnected(), messages: [...sent, ...received].sort((a, b) => String(b.at).localeCompare(String(a.at))) };
  }
  function inboxConnected() {
    const r = db.prepare("SELECT value FROM settings WHERE key='m365_token'").get();
    return !!(r && r.value);
  }
  app.get('/api/admin/conversation', auth, (req, res) => {
    const addresses = String(req.query.addresses || '').split(',').slice(0, 20);
    res.json(conversationFor(addresses));
  });
  module.exports.conversationFor = conversationFor;

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
      emails_handled: one("SELECT COUNT(*) n FROM work_items WHERE kind='email' AND status='completed' AND completed_at >= ? AND completed_at < ?", ...win),
      follow_ups_completed: one('SELECT COUNT(*) n FROM calls WHERE follow_up_done=1 AND handled_at >= ? AND handled_at < ?', ...win),
      tasks_completed: one("SELECT COUNT(*) n FROM customer_issues WHERE status IN ('Resolved','Verified','Closed') AND COALESCE(resolved_at,updated_at) >= ? AND COALESCE(resolved_at,updated_at) < ?", ...win),
      activities_rescheduled: one("SELECT COUNT(*) n FROM audit_log WHERE created_at >= ? AND created_at < ? AND (action IN ('email schedule','email snooze','call schedule','updated task schedule'))", ...win),
      overdue_now: (s.emails.overdue || 0) + (s.calls.overdue || 0) + (s.leads.overdue || 0) + (s.tasks.overdue || 0),
      awaiting_customer: (s.emails.waiting || 0) + (s.calls.waiting || 0) + (s.leads.waiting || 0),
      unassigned_open: (s.emails.unassigned || 0) + (s.calls.unassigned || 0) + (s.leads.unassigned || 0) + (s.tasks.unassigned || 0),
      missed_calls_escalated: items('calls').filter(x => x.escalated).length,
      needs_attention_now: (s.emails.new || 0) + (s.calls.new || 0) + (s.calls.missed || 0) + (s.leads.contact_today || 0) + (s.leads.new || 0),
      exceptions: []
    };
    if (report.overdue_now) report.exceptions.push(report.overdue_now + ' item(s) overdue');
    if (report.unassigned_open) report.exceptions.push(report.unassigned_open + ' open item(s) with no owner');
    if (report.missed_calls_escalated) report.exceptions.push(report.missed_calls_escalated + ' missed call(s) not returned within ' + ESCALATE_MIN + ' minutes');
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
module.exports.isEscalated = isEscalated;
module.exports.bizDayOf = bizDayOf;
module.exports.taskBucket = taskBucket;
