// Issues & Tasks: complaints, service requests, incidents, employee tasks, follow-ups and internal notes.
// Internal only: no public route reads these tables.
const TYPES = { complaint: 'Complaint', service_request: 'Service request', incident: 'Incident', task: 'Task', follow_up: 'Follow-up', note: 'Note' };
const PREFIX = { complaint: 'ISS', service_request: 'REQ', incident: 'INC', task: 'TSK', follow_up: 'FUP', note: 'NOTE' };
const LEGACY_CATEGORIES = ['Quality', 'Schedule', 'Billing', 'Safety', 'Damage', 'Staff conduct', 'Site access', 'Scope change', 'Sales', 'Other'];
const DEFAULT_CATEGORIES = ['Cleaning quality', 'Missed service', 'Schedule', 'Billing / payment', 'Safety', 'Damage / incident', 'Staff conduct', 'Site access', 'Scope change', 'Supplies / equipment', 'Inspection', 'Sales', 'General'];
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
const STATUSES = ['Open', 'In progress', 'Investigating', 'Waiting on customer', 'Resolved', 'Verified', 'Closed'];
const DONE = ['Resolved', 'Verified', 'Closed'];
const SOURCES = ['Phone call', 'Email', 'Website', 'Inspection', 'Employee', 'Customer in person', 'Text message'];
const COMMS = ['Not needed', 'Needs update', 'Customer informed'];
const RECUR = ['', 'daily', 'weekly', 'biweekly', 'monthly'];

module.exports = function mountIssues(app, ctx) {
  const { db, auth, logAction, clean, adminEmail } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS customer_issues(
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, type TEXT NOT NULL, category TEXT, title TEXT NOT NULL, description TEXT,
    property TEXT, priority TEXT NOT NULL DEFAULT 'Normal', status TEXT NOT NULL DEFAULT 'Open', assigned_to TEXT, due_date TEXT,
    required_action TEXT, resolution TEXT, customer_comms TEXT NOT NULL DEFAULT 'Not needed', created_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT);
    CREATE INDEX IF NOT EXISTS issues_customer ON customer_issues(customer_id);
    CREATE INDEX IF NOT EXISTS issues_status ON customer_issues(status);
    CREATE TABLE IF NOT EXISTS issue_comments(id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, body TEXT NOT NULL, author TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS issue_comments_i ON issue_comments(issue_id);
    CREATE TABLE IF NOT EXISTS issue_config(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const cols = db.prepare('PRAGMA table_info(customer_issues)').all().map(c => c.name);
  for (const [c, t] of [['contact_id', 'INTEGER'], ['property_id', 'INTEGER'], ['project_id', 'INTEGER'], ['work_order', 'TEXT'], ['source', 'TEXT'], ['reported_by', 'TEXT'],
    ['reminder_at', 'TEXT'], ['reminded_at', 'TEXT'], ['corrective_action', 'TEXT'], ['verified_by', 'TEXT'], ['verified_at', 'TEXT'], ['verification_note', 'TEXT'],
    ['escalated', 'INTEGER NOT NULL DEFAULT 0'], ['escalated_at', 'TEXT'], ['recurrence', "TEXT DEFAULT ''"], ['recurred_to', 'INTEGER'], ['parent_id', 'INTEGER']])
    if (!cols.includes(c)) db.exec(`ALTER TABLE customer_issues ADD COLUMN ${c} ${t}`);
  try { if (!db.prepare('PRAGMA table_info(documents)').all().some(c => c.name === 'issue_id')) db.exec('ALTER TABLE documents ADD COLUMN issue_id INTEGER'); } catch { /* documents table created by suite */ }

  const now = () => new Date().toISOString();
  const today = () => require('./bizdate').today();
  const who = req => ((req.user && req.user.email) || '').toLowerCase() || null;
  const users = () => [...new Set([...(adminEmail ? [adminEmail.toLowerCase()] : []), ...db.prepare('SELECT email FROM admin_users').all().map(r => r.email.toLowerCase())])];
  const roleOf = email => { const e = String(email || '').toLowerCase(); if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  const isOpen = s => !DONE.includes(s);
  const categories = () => { const r = db.prepare("SELECT value FROM issue_config WHERE key='categories'").get(); try { const v = r && JSON.parse(r.value); if (Array.isArray(v) && v.length) return v; } catch { /* default */ } return DEFAULT_CATEGORIES; };
  const OPEN_SQL = `status NOT IN ('Resolved','Verified','Closed')`;
  const number = r => `${PREFIX[r.type] || 'ISS'}-${1000 + r.id}`;
  const notify = async (to, subject, text) => {
    const m = ctx.getMailer && ctx.getMailer(); if (!m || !to) return false;
    try { await m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || adminEmail, to, subject, text }); return true; } catch (e) { console.error('issue email failed:', e.message); return false; }
  };

  function validate(b, cur) {
    const out = {}, errs = [];
    const pick = (k, list, label) => { if (k in b) { if (!list.includes(b[k])) errs.push(`Choose a valid ${label}.`); else out[k] = b[k]; } };
    if (!cur || 'type' in b) { if (!TYPES[b.type]) errs.push('Choose a type: complaint, service request, incident, task, follow-up or note.'); else out.type = b.type; }
    if (!cur || 'title' in b) { const t = clean(b.title, 200); if (!t) errs.push('A short title is required.'); else out.title = t; }
    pick('category', ['', ...categories(), ...LEGACY_CATEGORIES], 'category'); pick('priority', PRIORITIES, 'priority');
    pick('status', STATUSES, 'status'); pick('customer_comms', COMMS, 'customer update status');
    pick('source', ['', ...SOURCES], 'source'); pick('recurrence', RECUR, 'repeat setting');
    for (const k of ['description', 'property', 'required_action', 'resolution', 'corrective_action', 'verification_note']) if (k in b) out[k] = clean(b[k], 5000);
    for (const k of ['work_order', 'reported_by']) if (k in b) out[k] = clean(b[k], 120);
    if ('due_date' in b) { const d = clean(b.due_date, 10); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) errs.push('Due date must be a date.'); else out.due_date = d || null; }
    if ('reminder_at' in b) { const d = clean(b.reminder_at, 25); if (d && isNaN(Date.parse(d))) errs.push('Reminder must be a date and time.'); else { out.reminder_at = d ? new Date(d).toISOString() : null; out.reminded_at = null; } }
    if ('assigned_to' in b) { const a = clean(b.assigned_to, 254).toLowerCase(); if (a && !users().includes(a)) errs.push('Assign to someone who has access to Bright Clean.'); else out.assigned_to = a || null; }
    const ref = (k, table, label) => { if (k in b) { const id = b[k] === '' || b[k] == null ? null : Number(b[k]); if (id !== null && !db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) errs.push(`That ${label} was not found.`); else out[k] = id; } };
    ref('customer_id', 'customers', 'customer'); ref('contact_id', 'customer_contacts', 'contact'); ref('property_id', 'customer_properties', 'property'); ref('project_id', 'projects', 'project');
    const merged = { ...(cur || {}), ...out };
    // Linked records must belong to the chosen customer.
    if (merged.contact_id && merged.customer_id) { const k = db.prepare('SELECT customer_id FROM customer_contacts WHERE id=?').get(merged.contact_id); if (k && k.customer_id !== merged.customer_id) errs.push('That contact belongs to a different customer.'); }
    if (merged.property_id && merged.customer_id) { const p = db.prepare('SELECT customer_id, name FROM customer_properties WHERE id=?').get(merged.property_id); if (p && p.customer_id !== merged.customer_id) errs.push('That property belongs to a different customer.'); else if (p && !('property' in b)) out.property = p.name; }
    const st = merged.status || 'Open', label = (TYPES[merged.type] || 'item').toLowerCase();
    if (!isOpen(st) && merged.type !== 'note' && !String(merged.resolution || '').trim()) errs.push(`Describe how this ${label} was resolved before closing it.`);
    if (!isOpen(st) && ['complaint', 'incident'].includes(merged.type) && !String(merged.corrective_action || '').trim()) errs.push(`Record the corrective action before closing this ${label}.`);
    if (['Verified', 'Closed'].includes(st) && ['complaint', 'incident'].includes(merged.type) && !(merged.verified_by || out.verified_by)) errs.push(`A ${label} must be verified before it is closed.`);
    if (['complaint', 'service_request'].includes(merged.type) && !isOpen(st) && merged.customer_comms === 'Needs update') errs.push('Update the customer (or mark "Not needed") before closing.');
    return { out, errs, merged };
  }

  const SELECT = `SELECT i.*, c.name customer_name, c.company customer_company, c.email customer_email, k.name contact_name, k.phone contact_phone, p.name property_name, p.address property_address, j.name project_name
    FROM customer_issues i LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN customer_contacts k ON k.id=i.contact_id LEFT JOIN customer_properties p ON p.id=i.property_id LEFT JOIN projects j ON j.id=i.project_id`;
  const decorate = r => r && ({ ...r, number: number(r), overdue: isOpen(r.status) && !!r.due_date && r.due_date < today(), due_today: isOpen(r.status) && r.due_date === today() });
  const getOne = id => decorate(db.prepare(`${SELECT} WHERE i.id=?`).get(id));
  const options = () => ({ types: TYPES, categories: categories(), priorities: PRIORITIES, statuses: STATUSES, sources: SOURCES, comms: COMMS, recurrence: RECUR, users: users() });

  app.get('/api/admin/issues', auth, (req, res) => {
    const where = [], args = [], q = req.query;
    if (q.customer_id) { where.push('i.customer_id=?'); args.push(Number(q.customer_id)); }
    if (q.property_id) { where.push('i.property_id=?'); args.push(Number(q.property_id)); }
    if (q.project_id) { where.push('i.project_id=?'); args.push(Number(q.project_id)); }
    if (q.group === 'issues') where.push("i.type='complaint'"); else if (q.group === 'tasks') where.push("i.type IN ('task','follow_up')");
    else if (q.group === 'notes') where.push("i.type='note'"); else if (q.group === 'requests') where.push("i.type='service_request'"); else if (q.group === 'incidents') where.push("i.type='incident'");
    if (TYPES[q.type]) { where.push('i.type=?'); args.push(q.type); }
    for (const [k, col] of [['category', 'category'], ['priority', 'priority'], ['source', 'source']]) if (q[k]) { where.push(`i.${col}=?`); args.push(q[k]); }
    if (q.assigned === 'me' && who(req)) { where.push('lower(i.assigned_to)=?'); args.push(who(req)); }
    else if (q.assigned === 'none') where.push("(i.assigned_to IS NULL OR i.assigned_to='')");
    else if (q.assigned) { where.push('lower(i.assigned_to)=?'); args.push(String(q.assigned).toLowerCase()); }
    const st = q.status || 'open';
    if (st === 'open') where.push(`i.${OPEN_SQL}`);
    else if (st === 'overdue') { where.push(`i.${OPEN_SQL} AND i.due_date IS NOT NULL AND i.due_date<>'' AND i.due_date<?`); args.push(today()); }
    else if (st === 'today') { where.push(`i.${OPEN_SQL} AND i.due_date=?`); args.push(today()); }
    else if (st === 'done') where.push("i.status IN ('Resolved','Verified','Closed')");
    else if (STATUSES.includes(st)) { where.push('i.status=?'); args.push(st); }
    if (q.q) { where.push("(i.title LIKE ? OR c.company LIKE ? OR c.name LIKE ? OR i.property LIKE ? OR p.name LIKE ? OR i.work_order LIKE ?)"); const like = `%${clean(q.q, 80)}%`; args.push(like, like, like, like, like, like); }
    const rows = db.prepare(`${SELECT}${where.length ? ' WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE WHEN i.${OPEN_SQL} THEN 0 ELSE 1 END, CASE i.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Normal' THEN 2 ELSE 3 END,
      COALESCE(NULLIF(i.due_date,''),'9999'), i.id DESC LIMIT 1000`).all(...args).map(decorate);
    const month = today().slice(0, 7) + '-01';
    const k = db.prepare(`SELECT SUM(${OPEN_SQL}) open, SUM(${OPEN_SQL} AND type='complaint') open_complaints, SUM(${OPEN_SQL} AND priority IN ('High','Urgent')) high,
      SUM(${OPEN_SQL} AND priority='Urgent') urgent, SUM(${OPEN_SQL} AND due_date=?) due_today, SUM(${OPEN_SQL} AND due_date IS NOT NULL AND due_date<>'' AND due_date<?) overdue,
      SUM(status IN ('Resolved','Verified','Closed') AND COALESCE(resolved_at,updated_at)>=?) resolved_month, SUM(${OPEN_SQL} AND escalated=1) escalated,
      COUNT(*) all_n, SUM(type='complaint') n_issues, SUM(type IN ('task','follow_up')) n_tasks, SUM(type='note') n_notes, SUM(type='service_request') n_requests, SUM(type='incident') n_incidents FROM customer_issues`).get(today(), today(), month);
    res.json({ issues: rows, counts: Object.fromEntries(Object.entries(k).map(([a, v]) => [a, v || 0])), options: options() });
  });

  app.get('/api/admin/issues/:id', auth, (req, res) => {
    const it = getOne(Number(req.params.id)); if (!it) return res.status(404).json({ error: 'Item not found.' });
    let files = []; try { files = db.prepare('SELECT id,title,file_name,file_url,size,uploaded_by,created_at FROM documents WHERE issue_id=? ORDER BY id').all(it.id); } catch { /* */ }
    const label = (TYPES[it.type] || '').toLowerCase();
    res.json({ issue: it, comments: db.prepare('SELECT * FROM issue_comments WHERE issue_id=? ORDER BY id').all(it.id), files,
      history: db.prepare("SELECT * FROM audit_log WHERE entity=? AND entity_id=? ORDER BY id DESC LIMIT 100").all(label, it.id), options: options() });
  });

  async function afterChange(req, before, after) {
    // Assignment / reassignment notification
    if (after.assigned_to && after.assigned_to !== (before && before.assigned_to) && after.assigned_to !== who(req)) {
      await notify(after.assigned_to, `Assigned to you: ${after.number} ${after.title}`, `${who(req) || 'Someone'} assigned you ${TYPES[after.type]} ${after.number}: ${after.title}\nPriority: ${after.priority}${after.due_date ? `\nDue: ${after.due_date}` : ''}\n\nOpen Bright Clean: https://brightclean.net/admin/#issues`);
      logAction(req, before && before.assigned_to ? 'reassigned' : 'assigned', TYPES[after.type].toLowerCase(), after.id, `to ${after.assigned_to}${before && before.assigned_to ? ` (was ${before.assigned_to})` : ''}`);
    }
    // Escalation: email management once
    if (after.escalated && !(before && before.escalated)) {
      db.prepare('UPDATE customer_issues SET escalated_at=? WHERE id=?').run(now(), after.id);
      const mgmt = users().filter(u => ['owner', 'manager'].includes(roleOf(u)));
      for (const m of mgmt) await notify(m, `Escalated: ${after.number} ${after.title}`, `${who(req) || 'Someone'} escalated ${TYPES[after.type]} ${after.number} to management.\nCustomer: ${after.customer_company || after.customer_name || '—'}\nPriority: ${after.priority}\n${after.description || ''}`);
      logAction(req, 'escalated', TYPES[after.type].toLowerCase(), after.id, `to management (${mgmt.length} notified)`);
    }
    // New urgent complaint / incident: notify owner
    if (!before && ['complaint', 'incident'].includes(after.type) && after.priority === 'Urgent' && adminEmail && adminEmail.toLowerCase() !== who(req))
      await notify(adminEmail, `Urgent ${TYPES[after.type].toLowerCase()}: ${after.title}`, `${after.number} was logged as Urgent by ${who(req)}.\n${after.description || ''}`);
    // Recurring task: when completed, create the next occurrence
    if (before && isOpen(before.status) && !isOpen(after.status) && after.recurrence && !after.recurred_to) {
      const d = new Date((after.due_date || today()) + 'T12:00:00Z');
      ({ daily: () => d.setUTCDate(d.getUTCDate() + 1), weekly: () => d.setUTCDate(d.getUTCDate() + 7), biweekly: () => d.setUTCDate(d.getUTCDate() + 14), monthly: () => d.setUTCMonth(d.getUTCMonth() + 1) })[after.recurrence]();
      const t = now(), copy = ['customer_id', 'contact_id', 'property_id', 'project_id', 'type', 'category', 'title', 'description', 'property', 'priority', 'assigned_to', 'required_action', 'source', 'work_order', 'recurrence'];
      const nid = db.prepare(`INSERT INTO customer_issues(${copy.join(',')},status,due_date,parent_id,customer_comms,created_by,created_at,updated_at) VALUES(${copy.map(() => '?').join(',')},'Open',?,?,'Not needed',?,?,?)`)
        .run(...copy.map(c => after[c] ?? null), d.toISOString().slice(0, 10), after.id, 'system (repeat)', t, t).lastInsertRowid;
      db.prepare('UPDATE customer_issues SET recurred_to=? WHERE id=?').run(nid, after.id);
      logAction(req, 'created', TYPES[after.type].toLowerCase(), nid, `next ${after.recurrence} occurrence of ${after.number}, due ${d.toISOString().slice(0, 10)}`);
    }
  }

  app.post('/api/admin/issues', auth, async (req, res) => {
    const b = { status: 'Open', priority: 'Normal', customer_comms: 'Not needed', ...(req.body || {}) };
    if (b.type === 'note' && !('status' in (req.body || {}))) b.status = 'Closed';
    if (b.type === 'complaint' && !('customer_comms' in (req.body || {}))) b.customer_comms = 'Needs update';
    const { out, errs } = validate(b, null);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    if (b.escalate) out.escalated = 1;
    // Duplicate guard: same customer + same title still open within 10 minutes
    const dup = out.customer_id && db.prepare(`SELECT id FROM customer_issues WHERE customer_id=? AND lower(title)=lower(?) AND ${OPEN_SQL} AND created_at>?`).get(out.customer_id, out.title, new Date(Date.now() - 600000).toISOString());
    if (dup) return res.status(409).json({ error: `This looks like a duplicate of ${number({ ...dup, type: out.type })}, created a few minutes ago.`, id: dup.id });
    const t = now(), c2 = Object.keys(out);
    const info = db.prepare(`INSERT INTO customer_issues(${c2.join(',')},created_by,created_at,updated_at,resolved_at) VALUES(${c2.map(() => '?').join(',')},?,?,?,?)`)
      .run(...c2.map(c => out[c]), who(req), t, t, isOpen(out.status) ? null : t);
    const it = getOne(info.lastInsertRowid);
    logAction(req, 'created', TYPES[it.type].toLowerCase(), it.id, `${it.number}: ${it.title}`);
    await afterChange(req, null, it);
    res.status(201).json({ issue: getOne(it.id) });
  });

  // ---- Complaint workflow actions (audit MF-01..MF-03) ----
  for (const [tbl, c, t] of [['calls', 'issue_id', 'INTEGER'], ['visits', 'issue_id', 'INTEGER'], ['issue_comments', 'customer_facing', 'INTEGER DEFAULT 0']]) {
    try { if (!db.prepare(`PRAGMA table_info(${tbl})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${c} ${t}`); } catch { /* table created by another module */ }
  }
  // MF-01: turn a logged call into an issue (complaint by default) without retyping it.
  app.post('/api/admin/calls/:id/issue', auth, async (req, res) => {
    const call = db.prepare('SELECT * FROM calls WHERE id=?').get(Number(req.params.id)); if (!call) return res.status(404).json({ error: 'Call not found.' });
    if (call.issue_id) return res.status(409).json({ error: 'An issue was already created from this call.', id: call.issue_id });
    const r = req.body || {}, summary = String(call.summary || call.transcript || '').trim();
    if (!call.customer_id && !r.customer_id) return res.status(400).json({ error: 'Link this call to a customer first (complaints are tracked per customer).' });
    const b = { type: TYPES[r.type] ? r.type : 'complaint', status: 'Open', priority: r.priority || (call.purpose === 'Complaint' ? 'High' : 'Normal'), customer_id: r.customer_id || call.customer_id,
      title: clean(r.title, 200) || `Phone ${call.purpose === 'Complaint' ? 'complaint' : 'request'}: ${summary.slice(0, 70) || (call.company || call.contact_name || call.phone)}`,
      description: `${summary}\n\nFrom ${call.direction.toLowerCase()} call ${call.created_at.slice(0, 16).replace('T', ' ')} UTC${call.contact_name ? ' with ' + call.contact_name : ''}${call.phone ? ' (' + call.phone + ')' : ''}.`,
      source: 'Phone call', reported_by: call.contact_name || null, assigned_to: r.assigned_to || null, category: r.category || null };
    if (b.type === 'complaint') b.customer_comms = 'Needs update';
    for (const k of Object.keys(b)) if (b[k] == null || b[k] === '') delete b[k];
    const { out, errs } = validate(b, null); if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const t = now(), c2 = Object.keys(out);
    const info = db.prepare(`INSERT INTO customer_issues(${c2.join(',')},created_by,created_at,updated_at,resolved_at) VALUES(${c2.map(() => '?').join(',')},?,?,?,?)`).run(...c2.map(c => out[c]), who(req), t, t, null);
    db.prepare('UPDATE calls SET issue_id=? WHERE id=?').run(info.lastInsertRowid, call.id);
    const it = getOne(info.lastInsertRowid);
    logAction(req, 'created', TYPES[it.type].toLowerCase(), it.id, `${it.number} from call #${call.id}`);
    await afterChange(req, null, it);
    res.status(201).json({ issue: it });
  });
  // MF-02: send the customer an update (only the typed message — internal notes are never included) and record it.
  app.post('/api/admin/issues/:id/customer-update', auth, async (req, res) => {
    const it = getOne(Number(req.params.id)); if (!it) return res.status(404).json({ error: 'Item not found.' });
    const msg = String((req.body || {}).message || '').trim().slice(0, 5000); if (msg.length < 10) return res.status(400).json({ error: 'Write the message to the customer (at least a sentence).' });
    const k = it.contact_id ? db.prepare('SELECT name, email FROM customer_contacts WHERE id=?').get(it.contact_id) : null, cu = it.customer_id ? db.prepare('SELECT name, company, email FROM customers WHERE id=?').get(it.customer_id) : null;
    const to = (k && k.email) || (cu && cu.email); if (!to) return res.status(400).json({ error: 'No email on file for this customer or contact. Add one, or call them and mark the update as done.' });
    const m = ctx.getMailer && ctx.getMailer(); if (!m) return res.status(503).json({ error: 'Email is not set up, so the update was not sent.' });
    try { await m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || adminEmail, to, subject: `Update on your ${TYPES[it.type].toLowerCase()} ${it.number}: ${it.title}`, text: `${msg}\n\nBright Cleaning Sev Inc.\nOffice +1 (515) 303-3024 · Eric Moore (Owner) 469-267-8472` }); }
    catch (e) { logAction(req, 'customer update FAILED', TYPES[it.type].toLowerCase(), it.id, `${to}: ${e.message}`); return res.status(502).json({ error: 'The email could not be sent: ' + e.message + '. Nothing was marked as sent.' }); }
    db.prepare('INSERT INTO issue_comments(issue_id, body, author, created_at, customer_facing) VALUES(?,?,?,?,1)').run(it.id, `Emailed to customer (${to}):\n${msg}`, who(req), now());
    db.prepare("UPDATE customer_issues SET customer_comms='Customer informed', updated_at=? WHERE id=?").run(now(), it.id);
    logAction(req, 'emailed customer update', TYPES[it.type].toLowerCase(), it.id, `${it.number} to ${to}`);
    res.json({ ok: true, to, issue: getOne(it.id) });
  });
  // MF-03: schedule the corrective visit from the issue (shows on the dispatch board; crew conflicts are checked when crew is assigned).
  app.post('/api/admin/issues/:id/schedule-visit', auth, (req, res) => {
    const it = getOne(Number(req.params.id)); if (!it) return res.status(404).json({ error: 'Item not found.' });
    const b = req.body || {}, isD = x => /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')), isT = x => !x || /^\d{2}:\d{2}$/.test(String(x));
    if (!isD(b.date)) return res.status(400).json({ error: 'Choose the visit date.' });
    if (!isT(b.start_time) || !isT(b.end_time) || (b.start_time && b.end_time && b.end_time <= b.start_time)) return res.status(400).json({ error: 'Check the start and end times.' });
    const t = now(), vid = db.prepare(`INSERT INTO visits(title,type,date,start_time,end_time,address,customer_id,project_id,notes,status,created_by,created_at,updated_at,issue_id) VALUES(?,?,?,?,?,?,?,?,?,'Scheduled',?,?,?,?)`)
      .run(clean(b.title, 200) || `Corrective work: ${it.number} ${it.title}`.slice(0, 200), 'Corrective work', b.date, b.start_time || null, b.end_time || null, clean(b.address, 300) || it.property || null, it.customer_id || null, it.project_id || null, `For ${it.number}. ${clean(b.notes, 1000) || ''}`.trim(), who(req), t, t, it.id).lastInsertRowid;
    if (it.status === 'Open') db.prepare("UPDATE customer_issues SET status='In progress', updated_at=? WHERE id=?").run(t, it.id);
    if (!String(it.corrective_action || '').trim()) db.prepare('UPDATE customer_issues SET corrective_action=?, updated_at=? WHERE id=?').run(`Corrective visit on ${b.date}${b.start_time ? ' ' + b.start_time : ''} (visit #${vid}).`, t, it.id);
    db.prepare('INSERT INTO issue_comments(issue_id, body, author, created_at) VALUES(?,?,?,?)').run(it.id, `Corrective visit scheduled for ${b.date}${b.start_time ? ' ' + b.start_time : ''} (visit #${vid}).`, who(req), t);
    logAction(req, 'scheduled corrective visit', TYPES[it.type].toLowerCase(), it.id, `${it.number}: visit #${vid} on ${b.date}`);
    res.status(201).json({ visit_id: vid, issue: getOne(it.id) });
  });

  app.patch('/api/admin/issues/:id', auth, async (req, res) => {
    const cur = getOne(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Item not found.' });
    const b = { ...(req.body || {}) };
    if (b.verify) { // verification records who verified and when
      if (!String(cur.resolution || b.resolution || '').trim()) return res.status(400).json({ error: 'Resolve the item before verifying it.' });
      if (cur.verified_by && who(req) === cur.verified_by) return res.json({ issue: cur });
      b.verified_by = who(req); if (!b.status || b.status === 'Resolved' || b.status === cur.status) b.status = 'Verified';
    }
    const { out, errs, merged } = validate(b, cur);
    if (b.verify) { out.verified_by = who(req); out.verified_at = now(); }
    if ('escalate' in b) out.escalated = b.escalate ? 1 : 0;
    if (errs.length && !(b.verify && errs.every(e => /verified before/.test(e)))) return res.status(400).json({ error: errs.join(' ') });
    const c2 = Object.keys(out);
    if (!c2.length) return res.json({ issue: cur });
    const closing = isOpen(cur.status) && !isOpen(merged.status), reopening = !isOpen(cur.status) && isOpen(merged.status);
    if (reopening) { out.verified_by = null; out.verified_at = null; }
    const c3 = Object.keys(out);
    db.prepare(`UPDATE customer_issues SET ${c3.map(c => c + '=?').join(',')}, updated_at=?${closing ? ', resolved_at=?' : reopening ? ', resolved_at=NULL' : ''} WHERE id=?`)
      .run(...c3.map(c => out[c]), now(), ...(closing ? [now()] : []), cur.id);
    const label = TYPES[merged.type].toLowerCase(), after = getOne(cur.id);
    if (b.verify) logAction(req, 'verified', label, cur.id, `${after.number}${b.verification_note ? ': ' + clean(b.verification_note, 200) : ''}`);
    else if (closing) logAction(req, 'resolved', label, cur.id, `${after.number} ${merged.title}: ${clean(merged.resolution, 200)}`);
    else if (reopening) logAction(req, 'reopened', label, cur.id, `${after.number} ${merged.title}`);
    else { const ch = c3.filter(c => !['assigned_to', 'escalated', 'reminded_at'].includes(c) && String(out[c] ?? '') !== String(cur[c] ?? '')); if (ch.length) logAction(req, 'updated', label, cur.id, ch.map(c => `${c}: "${String(cur[c] ?? '').slice(0, 60)}" → "${String(out[c] ?? '').slice(0, 60)}"`).join('; ').slice(0, 1500)); }
    await afterChange(req, cur, after);
    res.json({ issue: getOne(cur.id) });
  });

  app.post('/api/admin/issues/:id/comments', auth, async (req, res) => {
    const it = getOne(Number(req.params.id)); if (!it) return res.status(404).json({ error: 'Item not found.' });
    const body = clean((req.body || {}).body, 4000); if (!body) return res.status(400).json({ error: 'Write a comment first.' });
    const id = db.prepare('INSERT INTO issue_comments(issue_id,body,author,created_at) VALUES(?,?,?,?)').run(it.id, body, who(req), now()).lastInsertRowid;
    db.prepare('UPDATE customer_issues SET updated_at=? WHERE id=?').run(now(), it.id);
    logAction(req, 'commented on', TYPES[it.type].toLowerCase(), it.id, body.slice(0, 200));
    if (it.assigned_to && it.assigned_to !== who(req)) await notify(it.assigned_to, `New comment on ${it.number}`, `${who(req)}: ${body}\n\nhttps://brightclean.net/admin/#issues`);
    res.status(201).json({ comment: db.prepare('SELECT * FROM issue_comments WHERE id=?').get(id) });
  });

  // Configurable categories (owners and managers)
  app.put('/api/admin/issues/config', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(who(req)))) return res.status(403).json({ error: 'Only owners and managers can change categories.' });
    const list = [...new Set((Array.isArray((req.body || {}).categories) ? req.body.categories : []).map(x => clean(x, 60)).filter(Boolean))];
    if (list.length < 2) return res.status(400).json({ error: 'Keep at least two categories.' });
    db.prepare("INSERT INTO issue_config(key,value) VALUES('categories',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(list));
    logAction(req, 'updated', 'settings', 0, 'issue categories: ' + list.join(', ').slice(0, 300));
    res.json({ categories: list });
  });

  // Only plain notes can be deleted; everything else is closed so its history stays.
  app.delete('/api/admin/issues/:id', auth, (req, res) => {
    const cur = db.prepare('SELECT * FROM customer_issues WHERE id=?').get(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Item not found.' });
    if (cur.type !== 'note') return res.status(400).json({ error: 'Complaints, tasks, requests and incidents are closed, not deleted, so their history is kept.' });
    if (cur.created_by !== who(req) && roleOf(who(req)) !== 'owner') return res.status(403).json({ error: 'Only the author or an owner can delete a note.' });
    db.prepare('DELETE FROM customer_issues WHERE id=?').run(cur.id);
    db.prepare('DELETE FROM issue_comments WHERE issue_id=?').run(cur.id);
    logAction(req, 'deleted', 'note', cur.id, cur.title);
    res.json({ ok: true });
  });

  // Reminders: email the assignee when a reminder time passes (once per reminder).
  const sweep = async () => {
    try {
      const due = db.prepare(`${SELECT} WHERE i.reminder_at IS NOT NULL AND i.reminder_at<=? AND i.reminded_at IS NULL AND i.${OPEN_SQL}`).all(now()).map(decorate);
      for (const it of due) {
        const to = it.assigned_to || (adminEmail || '').toLowerCase();
        await notify(to, `Reminder: ${it.number} ${it.title}`, `Reminder for ${TYPES[it.type]} ${it.number}: ${it.title}${it.due_date ? `\nDue: ${it.due_date}` : ''}\n\nhttps://brightclean.net/admin/#issues`);
        db.prepare('UPDATE customer_issues SET reminded_at=? WHERE id=?').run(now(), it.id);
        db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run('system', 'sent reminder', TYPES[it.type].toLowerCase(), it.id, `to ${to}`, now());
      }
    } catch (e) { console.error('issue reminder sweep', e.message); }
  };
  setInterval(sweep, Number(process.env.ISSUE_SWEEP_MS) || 60000).unref();
  app.locals.issueSweep = sweep;
  app.post('/api/admin/issues/run-reminders', auth, async (req, res) => { await sweep(); res.json({ ok: true }); });
};
