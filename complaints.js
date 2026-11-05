// Quality complaint cases (Quality & Inspections → Customer Complaints) + Autopilot foundation (event/action log with
// owners, evidence and policy). A complaint from any source (AI call, call→issue, manual issue, website) becomes ONE case,
// keyed by its source so retries never duplicate. The AI/system coordinates; people own corrective work, approvals and closure.
module.exports = function mountComplaints(app, ctx) {
  const { db, auth, logAction, clean, adminEmail, getMailer } = ctx;
  const now = () => new Date().toISOString(), today = () => require('./bizdate').today();
  db.exec(`CREATE TABLE IF NOT EXISTS quality_complaints(id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, source_key TEXT UNIQUE NOT NULL,
      source_call_id INTEGER, source_issue_id INTEGER, customer_id INTEGER, project_id INTEGER, visit_id INTEGER, property TEXT, service_type TEXT, service_date TEXT,
      reported_at TEXT NOT NULL, category TEXT DEFAULT 'Cleaning quality', severity TEXT DEFAULT 'Normal', description TEXT, transcript TEXT, status TEXT NOT NULL DEFAULT 'NEW',
      info_needed TEXT, assigned_manager TEXT, supervisor TEXT, crew TEXT, response_due TEXT, investigation_notes TEXT, root_cause TEXT, resolution_summary TEXT,
      customer_accepted INTEGER, escalated_at TEXT, resolved_at TEXT, closed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS qc_cmp_status ON quality_complaints(status); CREATE INDEX IF NOT EXISTS qc_cmp_customer ON quality_complaints(customer_id);
    CREATE TABLE IF NOT EXISTS quality_complaint_history(id INTEGER PRIMARY KEY AUTOINCREMENT, complaint_id INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, prev TEXT, next TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quality_complaint_actions(id INTEGER PRIMARY KEY AUTOINCREMENT, complaint_id INTEGER NOT NULL, action_type TEXT NOT NULL, description TEXT, ref_type TEXT, ref_id INTEGER,
      assigned_to TEXT, due_at TEXT, status TEXT NOT NULL DEFAULT 'Open', completed_at TEXT, notes TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quality_complaint_comms(id INTEGER PRIMARY KEY AUTOINCREMENT, complaint_id INTEGER NOT NULL, channel TEXT, direction TEXT, message TEXT, accepted INTEGER, actor TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_actions(id INTEGER PRIMARY KEY AUTOINCREMENT, workflow TEXT NOT NULL, ref_type TEXT, ref_id INTEGER, step TEXT NOT NULL, decided_by TEXT NOT NULL,
      status TEXT NOT NULL, owner TEXT, due_at TEXT, evidence TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
    CREATE INDEX IF NOT EXISTS ops_actions_ref ON ops_actions(ref_type, ref_id);`);
  const number = c => `QC-${1000 + c.id}`;
  const STAGES = ['NEW', 'TRIAGE', 'ASSIGNED', 'INVESTIGATING', 'CORRECTIVE_ACTION', 'REINSPECTION', 'CUSTOMER_CONFIRMATION', 'RESOLVED', 'CLOSED'];
  const SIDE = ['INFO_NEEDED', 'ON_HOLD', 'ESCALATED'];
  const LABEL = { NEW: 'New', TRIAGE: 'Triage', ASSIGNED: 'Assigned', INVESTIGATING: 'Investigating', CORRECTIVE_ACTION: 'Corrective action', REINSPECTION: 'Reinspection', CUSTOMER_CONFIRMATION: 'Customer confirmation', RESOLVED: 'Resolved', CLOSED: 'Closed', INFO_NEEDED: 'Information needed', ON_HOLD: 'On hold', ESCALATED: 'Escalated' };
  const OPEN = "status NOT IN ('RESOLVED','CLOSED')";
  const RESPONSE_HOURS = { Urgent: 4, High: 24, Normal: 48, Low: 72 };
  const setting = (k, d) => { try { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; } catch { return d; } };
  const qualityManager = () => (setting('quality_manager', '') || adminEmail || '').toLowerCase();
  const roleOf = req => { const e = String((req.user && req.user.email) || '').toLowerCase(), ow = String(adminEmail || '').toLowerCase(); if (!ow || e === ow) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  const manager = req => ['owner', 'manager'].includes(roleOf(req));
  const who = req => (req && req.user && req.user.email) || 'Autopilot';
  const hist = (id, actor, action, prev, next) => db.prepare('INSERT INTO quality_complaint_history(complaint_id,actor,action,prev,next,created_at) VALUES(?,?,?,?,?,?)').run(id, actor, action, prev == null ? null : String(prev), next == null ? null : String(next), now());
  const op = (refId, step, decided_by, status, evidence, owner, due) => db.prepare('INSERT INTO ops_actions(workflow,ref_type,ref_id,step,decided_by,status,owner,due_at,evidence,created_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('complaint-to-resolution', 'complaint', refId, step, decided_by, status, owner || null, due || null, evidence ? String(evidence).slice(0, 1000) : null, now(), status === 'done' ? now() : null);
  const mail = async (to, subject, text, refId) => { const m = getMailer && getMailer(); if (!m || !to) { op(refId, 'Notify ' + (to || 'nobody'), 'policy', 'failed', !to ? 'no recipient configured' : 'email not configured'); return false; }
    try { await m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || adminEmail, to, subject, text }); op(refId, `Notified ${to}`, 'policy', 'done', subject); return true; } catch (e) { op(refId, `Notify ${to}`, 'policy', 'failed', e.message); return false; } };
  const getC = id => db.prepare('SELECT * FROM quality_complaints WHERE id=?').get(id);

  // ---------------- create (idempotent by source) ----------------
  function createCase(src) {
    const key = String(src.source_key || ''); if (!key) return null;
    const ex = db.prepare('SELECT * FROM quality_complaints WHERE source_key=?').get(key); if (ex) return ex;
    const t = now(), sev = ['Urgent', 'High', 'Normal', 'Low'].includes(src.severity) ? src.severity : 'High';
    const id = db.prepare(`INSERT INTO quality_complaints(source_type,source_key,source_call_id,source_issue_id,customer_id,property,service_date,reported_at,category,severity,description,transcript,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'NEW',?,?)`).run(src.source_type || 'manual', key, src.call_id || null, src.issue_id || null, src.customer_id || null, src.property || null, src.service_date || null, src.reported_at || t,
      src.category || 'Cleaning quality', sev, String(src.description || '').slice(0, 4000), src.transcript ? String(src.transcript).slice(0, 20000) : null, t, t).lastInsertRowid;
    hist(id, src.actor || 'Autopilot', 'created', null, `from ${src.source_type}`);
    op(id, `Created complaint case QC-${1000 + id} from ${src.source_type}`, 'policy', 'done', String(src.description || '').slice(0, 300));
    autopilot(id);
    return getC(id);
  }
  // Autopilot: retrieve facts from the system (never invent), assign per policy, notify, request approval for corrective work.
  function autopilot(id) {
    const c = getC(id), missing = [];
    if (!c.customer_id) missing.push('customer (caller not matched to a customer)');
    let visit = null;
    if (c.customer_id) visit = db.prepare(`SELECT * FROM visits WHERE customer_id=? AND date<=? AND COALESCE(status,'')<>'Cancelled' ORDER BY date DESC, id DESC LIMIT 1`).get(c.customer_id, c.service_date || today());
    if (visit) {
      const crew = db.prepare('SELECT e.name FROM visit_crew vc JOIN employees e ON e.id=vc.employee_id WHERE vc.visit_id=?').all(visit.id).map(r => r.name);
      db.prepare('UPDATE quality_complaints SET visit_id=?, project_id=COALESCE(project_id,?), service_date=COALESCE(service_date,?), property=COALESCE(property,?), crew=? WHERE id=?')
        .run(visit.id, visit.project_id || null, visit.date, visit.address || null, crew.join(', ') || null, id);
      op(id, `Identified original job: visit #${visit.id} on ${visit.date}`, 'AI/system', 'done', `${visit.title}${visit.address ? ' · ' + visit.address : ''}`);
      op(id, crew.length ? `Identified crew: ${crew.join(', ')}` : 'No crew recorded on the original job', 'AI/system', crew.length ? 'done' : 'blocked', crew.length ? `visit #${visit.id}` : 'crew assignment missing on visit');
      if (!crew.length) missing.push('crew on the original job');
    } else { op(id, 'Original job not found in the schedule', 'AI/system', 'blocked', c.customer_id ? 'no past visit for this customer' : 'no customer'); missing.push('original job / service date'); }
    const c2 = getC(id);
    if (!c2.property) { const cu = c2.customer_id ? db.prepare('SELECT address FROM customers WHERE id=?').get(c2.customer_id) : null; if (cu && cu.address) db.prepare('UPDATE quality_complaints SET property=? WHERE id=?').run(cu.address, id); else missing.push('property / service location'); }
    if (c2.customer_id) { const insp = db.prepare("SELECT id, area, date, score FROM inspections WHERE customer_id=? AND passed=0 AND COALESCE(date,created_at)>=? ORDER BY id DESC LIMIT 1").get(c2.customer_id, new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10));
      op(id, insp ? `Found a failed inspection in the last 14 days (#${insp.id}, ${insp.area})` : 'No failed inspection in the last 14 days', 'AI/system', 'done', insp ? `score ${insp.score}` : ''); }
    const mgr = qualityManager(), due = new Date(Date.now() + (RESPONSE_HOURS[c.severity] || 24) * 3600e3).toISOString();
    db.prepare("UPDATE quality_complaints SET assigned_manager=?, response_due=?, info_needed=?, status=?, updated_at=? WHERE id=?").run(mgr || null, due, missing.length ? missing.join('; ') : null, missing.length ? 'INFO_NEEDED' : (mgr ? 'ASSIGNED' : 'TRIAGE'), now(), id);
    hist(id, 'Autopilot', 'status', 'NEW', missing.length ? 'INFO_NEEDED' : (mgr ? 'ASSIGNED' : 'TRIAGE'));
    op(id, mgr ? `Assigned to quality manager ${mgr}` : 'No quality manager configured', 'policy', mgr ? 'done' : 'blocked', `response due ${due.slice(0, 16).replace('T', ' ')} UTC (${c.severity})`, mgr, due);
    if (missing.length) op(id, `Information needed: ${missing.join('; ')}`, 'AI/system', 'blocked', 'Manager to confirm; nothing was guessed', mgr, due);
    op(id, 'Schedule corrective cleaning', 'policy', 'needs_approval', 'Corrective work requires a manager decision (policy). No refund or credit is created automatically.', mgr, due);
    mail(mgr, `New complaint ${number({ id })}: ${String(c.description || '').slice(0, 60)}`, `${c.description}\n\nSeverity: ${c.severity}. Respond by ${due.slice(0, 16).replace('T', ' ')} UTC.${missing.length ? '\nInformation needed: ' + missing.join('; ') : ''}\nOpen Quality & Inspections → Customer complaints → ${number({ id })}.`, id);
  }
  app.locals.createComplaintCase = createCase;
  // Every complaint issue (any source) gets a case; runs often and on demand, idempotent by source key.
  function sync() {
    try {
      const rows = db.prepare("SELECT i.* FROM customer_issues i WHERE i.type='complaint' AND NOT EXISTS (SELECT 1 FROM quality_complaints q WHERE q.source_key='issue:'||i.id) ORDER BY i.id LIMIT 50").all();
      for (const i of rows) {
        const call = (() => { try { return db.prepare('SELECT id, transcript, provider_sid FROM calls WHERE issue_id=? ORDER BY id LIMIT 1').get(i.id); } catch { return null; } })();
        createCase({ source_type: call ? (i.created_by === 'AI receptionist' ? 'AI phone call' : 'phone call') : 'issue', source_key: 'issue:' + i.id, issue_id: i.id, call_id: call ? call.id : null, customer_id: i.customer_id, property: i.property, description: [i.title, i.description].filter(Boolean).join('\n\n'), transcript: call ? call.transcript : null, severity: i.priority === 'Urgent' ? 'Urgent' : i.priority === 'High' ? 'High' : 'Normal', actor: i.created_by || 'Autopilot' });
      }
      // calls answered by the AI after the case was created: attach transcript + call link
      db.prepare("UPDATE quality_complaints SET source_call_id=(SELECT c.id FROM calls c WHERE c.issue_id=quality_complaints.source_issue_id ORDER BY c.id LIMIT 1), transcript=COALESCE(transcript,(SELECT c.transcript FROM calls c WHERE c.issue_id=quality_complaints.source_issue_id ORDER BY c.id LIMIT 1)) WHERE source_call_id IS NULL AND source_issue_id IS NOT NULL").run();
      // escalation: overdue response
      for (const c of db.prepare(`SELECT * FROM quality_complaints WHERE ${OPEN} AND escalated_at IS NULL AND response_due<? AND status IN ('NEW','TRIAGE','ASSIGNED','INFO_NEEDED')`).all(now())) {
        db.prepare("UPDATE quality_complaints SET status='ESCALATED', escalated_at=?, updated_at=? WHERE id=?").run(now(), now(), c.id); hist(c.id, 'Autopilot', 'status', c.status, 'ESCALATED');
        op(c.id, 'Escalated: response deadline passed', 'policy', 'done', `was ${LABEL[c.status]}, due ${c.response_due}`, adminEmail);
        mail(String(process.env.NOTIFY_EMAIL || adminEmail || ''), `Escalated complaint ${number(c)} (response overdue)`, `${c.description}\n\nAssigned to ${c.assigned_manager || 'nobody'}; response was due ${c.response_due}.`, c.id);
      }
    } catch (e) { console.error('complaint sync:', e.message); }
  }
  const timer = setInterval(sync, Number(process.env.COMPLAINT_SYNC_MS || 20000)); timer.unref && timer.unref(); setTimeout(sync, 1500).unref?.();
  ctx.syncComplaints = sync;

  // ---------------- read ----------------
  const view = c => c && ({ ...c, number: number(c), status_label: LABEL[c.status] || c.status, overdue: !!(c.response_due && c.response_due < now() && !['RESOLVED', 'CLOSED'].includes(c.status)) });
  app.get('/api/admin/quality/complaints', auth, (req, res) => {
    sync(); const w = [], a = [], q = req.query;
    if (q.status === 'open') w.push("q.status NOT IN ('RESOLVED','CLOSED')"); else if (q.status && (STAGES.includes(q.status) || SIDE.includes(q.status))) { w.push('q.status=?'); a.push(q.status); }
    if (q.customer_id) { w.push('q.customer_id=?'); a.push(Number(q.customer_id)); }
    if (q.call_id) { w.push('q.source_call_id=?'); a.push(Number(q.call_id)); }
    const rows = db.prepare(`SELECT q.*, cu.company customer_company, cu.name customer_name FROM quality_complaints q LEFT JOIN customers cu ON cu.id=q.customer_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY q.id DESC LIMIT 500`).all(...a);
    res.json({ complaints: rows.map(view), stages: STAGES, side: SIDE, labels: LABEL });
  });
  app.get('/api/admin/quality/complaints/:id', auth, (req, res) => {
    const c = getC(Number(req.params.id)); if (!c) return res.status(404).json({ error: 'Complaint not found.' });
    const cu = c.customer_id ? db.prepare('SELECT id, company, name, phone, email, address FROM customers WHERE id=?').get(c.customer_id) : null;
    const call = c.source_call_id ? db.prepare('SELECT id, phone, created_at, outcome, handling, duration_s FROM calls WHERE id=?').get(c.source_call_id) : null;
    const visit = c.visit_id ? db.prepare('SELECT id, title, date, address, status FROM visits WHERE id=?').get(c.visit_id) : null;
    const repeat = c.customer_id ? db.prepare('SELECT COUNT(*) n FROM quality_complaints WHERE customer_id=? AND id<>?').get(c.customer_id, c.id).n : 0;
    const inspections = c.customer_id ? db.prepare('SELECT id, area, date, passed, score FROM inspections WHERE customer_id=? ORDER BY id DESC LIMIT 10').all(c.customer_id) : [];
    res.json({ complaint: view(c), customer: cu, call, original_visit: visit, repeat_complaints: repeat, inspections,
      actions: db.prepare('SELECT * FROM quality_complaint_actions WHERE complaint_id=? ORDER BY id').all(c.id),
      comms: db.prepare('SELECT * FROM quality_complaint_comms WHERE complaint_id=? ORDER BY id').all(c.id),
      history: db.prepare('SELECT * FROM quality_complaint_history WHERE complaint_id=? ORDER BY id').all(c.id),
      autopilot: db.prepare("SELECT * FROM ops_actions WHERE ref_type='complaint' AND ref_id=? ORDER BY id").all(c.id) });
  });

  // ---------------- workflow ----------------
  const block = (res, msg) => res.status(409).json({ error: msg });
  app.post('/api/admin/quality/complaints/:id/stage', auth, (req, res) => {
    const c = getC(Number(req.params.id)); if (!c) return res.status(404).json({ error: 'Complaint not found.' });
    if (!manager(req)) return res.status(403).json({ error: 'Only an owner or manager can move a complaint between stages.' });
    const b = req.body || {}, to = String(b.to || ''); if (!STAGES.includes(to) && !SIDE.includes(to)) return res.status(400).json({ error: 'Unknown stage.' });
    const set = {};
    if (b.assigned_manager !== undefined) { const m = clean(b.assigned_manager, 254).toLowerCase(); if (m && m !== String(adminEmail).toLowerCase() && !db.prepare('SELECT 1 FROM admin_users WHERE lower(email)=?').get(m)) return res.status(400).json({ error: 'Assign someone who has access to the admin.' }); set.assigned_manager = m || null; }
    for (const f of ['investigation_notes', 'root_cause', 'resolution_summary', 'supervisor', 'property', 'service_date', 'category', 'severity', 'info_needed']) if (b[f] !== undefined) set[f] = clean(b[f], 4000) || null;
    const nc = { ...c, ...set };
    if (to === 'ASSIGNED' && !nc.assigned_manager) return block(res, 'Choose the manager responsible before assigning.');
    if (to === 'CORRECTIVE_ACTION' && !String(nc.root_cause || '').trim()) return block(res, 'Record the root cause (what went wrong) before corrective action.');
    if (to === 'REINSPECTION' && !db.prepare("SELECT 1 FROM quality_complaint_actions WHERE complaint_id=? AND action_type='corrective_visit'").get(c.id)) return block(res, 'Schedule the corrective cleaning before reinspection.');
    if (to === 'CUSTOMER_CONFIRMATION' && nc.category === 'Cleaning quality' && !db.prepare("SELECT 1 FROM quality_complaint_actions qa JOIN inspections i ON i.id=qa.ref_id WHERE qa.complaint_id=? AND qa.action_type='reinspection' AND i.passed=1").get(c.id)) return block(res, 'A passed reinspection is required before customer confirmation.');
    if (to === 'RESOLVED') { if (!String(nc.resolution_summary || '').trim()) return block(res, 'Write the resolution summary before resolving.'); if (!db.prepare('SELECT 1 FROM quality_complaint_comms WHERE complaint_id=? AND accepted=1').get(c.id) && !b.override_reason) return block(res, 'Record the customer accepting the resolution first (or give an owner override reason).'); if (b.override_reason && roleOf(req) !== 'owner') return block(res, 'Only the owner can resolve without customer confirmation.'); }
    if (to === 'CLOSED' && c.status !== 'RESOLVED') return block(res, 'Only a resolved complaint can be closed.');
    if (['INFO_NEEDED', 'ON_HOLD', 'ESCALATED'].includes(to) && !clean(b.note, 1000)) return block(res, 'Add a note explaining why.');
    const t = now(); set.status = to; set.updated_at = t; if (to === 'RESOLVED') set.resolved_at = t; if (to === 'CLOSED') set.closed_at = t; if (to === 'ESCALATED') set.escalated_at = c.escalated_at || t;
    db.prepare(`UPDATE quality_complaints SET ${Object.keys(set).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(set), c.id);
    hist(c.id, who(req), 'status', c.status, to); if (b.note) hist(c.id, who(req), 'note', null, clean(b.note, 1000)); if (b.override_reason) hist(c.id, who(req), 'resolved without customer confirmation', null, clean(b.override_reason, 500));
    for (const f of Object.keys(set)) if (!['status', 'updated_at', 'resolved_at', 'closed_at', 'escalated_at'].includes(f) && String(c[f] || '') !== String(set[f] || '')) hist(c.id, who(req), f, c[f], set[f]);
    if (to === 'ESCALATED') mail(String(process.env.NOTIFY_EMAIL || adminEmail || ''), `Escalated complaint ${number(c)}`, `${who(req)} escalated: ${clean(b.note, 1000)}`, c.id);
    if (c.source_issue_id && ['RESOLVED', 'CLOSED'].includes(to)) { try { db.prepare("UPDATE customer_issues SET status=?, resolution=COALESCE(resolution,?), updated_at=? WHERE id=?").run(to === 'CLOSED' ? 'Closed' : 'Resolved', nc.resolution_summary, t, c.source_issue_id); } catch { /* */ } }
    logAction(req, `complaint ${LABEL[to].toLowerCase()}`, 'complaint', c.id, `${number(c)}: ${LABEL[c.status]} → ${LABEL[to]}`);
    res.json({ complaint: view(getC(c.id)) });
  });
  app.post('/api/admin/quality/complaints/:id/notes', auth, (req, res) => {
    const c = getC(Number(req.params.id)); if (!c) return res.status(404).json({ error: 'Complaint not found.' });
    const text = clean((req.body || {}).text, 4000); if (!text) return res.status(400).json({ error: 'Write the note first.' });
    db.prepare('UPDATE quality_complaints SET investigation_notes=TRIM(COALESCE(investigation_notes,\'\')||char(10)||?), updated_at=? WHERE id=?').run(`${today()} ${who(req)}: ${text}`, now(), c.id);
    hist(c.id, who(req), 'investigation note', null, text); res.json({ ok: true });
  });
  // Corrective cleaning = a real scheduled visit with crew (manager decision; no money moves).
  app.post('/api/admin/quality/complaints/:id/corrective', auth, (req, res) => {
    const c = getC(Number(req.params.id)); if (!c) return res.status(404).json({ error: 'Complaint not found.' });
    if (!manager(req)) return res.status(403).json({ error: 'Only an owner or manager can schedule corrective work.' });
    if (!String(c.root_cause || '').trim()) return block(res, 'Record the root cause before scheduling corrective work.');
    const b = req.body || {}; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return res.status(400).json({ error: 'Choose the date for the corrective cleaning.' });
    const ids = (Array.isArray(b.employee_ids) ? b.employee_ids : []).map(Number).filter(n => n > 0 && db.prepare('SELECT 1 FROM employees WHERE id=?').get(n));
    const t = now(), vid = db.prepare(`INSERT INTO visits(title,type,date,start_time,end_time,address,customer_id,project_id,notes,status,created_by,created_at,updated_at,issue_id) VALUES(?,?,?,?,?,?,?,?,?,'Scheduled',?,?,?,?)`)
      .run(`Corrective cleaning: ${number(c)}`, 'Corrective work', b.date, /^\d{2}:\d{2}$/.test(b.start_time || '') ? b.start_time : null, null, c.property || null, c.customer_id || null, c.project_id || null, `${clean(b.instructions, 2000) || ''}\n\nComplaint ${number(c)}: ${String(c.description || '').slice(0, 500)}\nRoot cause: ${c.root_cause}`.trim(), who(req), t, t, c.source_issue_id || null).lastInsertRowid;
    for (const e of ids) db.prepare('INSERT OR IGNORE INTO visit_crew(visit_id,employee_id,assigned_by,assigned_at) VALUES(?,?,?,?)').run(vid, e, who(req), t);
    db.prepare('INSERT INTO quality_complaint_actions(complaint_id,action_type,description,ref_type,ref_id,assigned_to,due_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(c.id, 'corrective_visit', `Corrective cleaning on ${b.date}`, 'visit', vid, ids.length ? ids.join(',') : null, b.date, 'Scheduled', t);
    if (!['CORRECTIVE_ACTION'].includes(c.status)) { db.prepare("UPDATE quality_complaints SET status='CORRECTIVE_ACTION', updated_at=? WHERE id=?").run(t, c.id); hist(c.id, who(req), 'status', c.status, 'CORRECTIVE_ACTION'); }
    db.prepare("UPDATE ops_actions SET status='done', resolved_at=?, evidence=COALESCE(evidence,'')||? WHERE ref_type='complaint' AND ref_id=? AND step='Schedule corrective cleaning' AND status='needs_approval'").run(t, ` → approved by ${who(req)}: visit #${vid}`, c.id);
    op(c.id, `Corrective cleaning scheduled: visit #${vid} on ${b.date}${ids.length ? ` with ${ids.length} crew` : ' (crew not yet assigned)'}`, 'person', 'done', who(req), null, b.date);
    op(c.id, 'Reinspection after corrective cleaning', 'policy', 'needs_approval', 'Supervisor inspects the affected area after the visit', c.assigned_manager, b.date);
    hist(c.id, who(req), 'corrective visit', null, `visit #${vid} ${b.date}`); logAction(req, 'scheduled corrective cleaning', 'complaint', c.id, `${number(c)}: visit #${vid}`);
    res.status(201).json({ visit_id: vid, complaint: view(getC(c.id)) });
  });
  // Reinspection: link a QC inspection of the affected area. Failed → back to corrective action (+ notify).
  app.post('/api/admin/quality/complaints/:id/reinspection', auth, (req, res) => {
    const c = getC(Number(req.params.id)); if (!c) return res.status(404).json({ error: 'Complaint not found.' });
    if (!manager(req)) return res.status(403).json({ error: 'Only an owner or manager can record reinspections.' });
    const insp = db.prepare('SELECT * FROM inspections WHERE id=?').get(Number((req.body || {}).inspection_id)); if (!insp) return res.status(404).json({ error: 'Inspection not found.' });
    if (!insp.signed_at) return block(res, 'The inspection must be completed and signed first.');
    const t = now(), passed = insp.passed === 1;
    db.prepare('INSERT INTO quality_complaint_actions(complaint_id,action_type,description,ref_type,ref_id,status,completed_at,notes,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(c.id, 'reinspection', `Reinspection #${insp.id} ${passed ? 'passed' : 'FAILED'}`, 'inspection', insp.id, passed ? 'Passed' : 'Failed', t, `score ${insp.score}`, t);
    const to = passed ? 'CUSTOMER_CONFIRMATION' : 'CORRECTIVE_ACTION';
    db.prepare('UPDATE quality_complaints SET status=?, updated_at=? WHERE id=?').run(to, t, c.id); hist(c.id, who(req), 'reinspection', null, passed ? 'passed' : 'failed'); hist(c.id, who(req), 'status', c.status, to);
    db.prepare("UPDATE ops_actions SET status='done', resolved_at=? WHERE ref_type='complaint' AND ref_id=? AND step='Reinspection after corrective cleaning' AND status='needs_approval'").run(t, c.id);
    op(c.id, passed ? `Reinspection #${insp.id} passed → customer confirmation` : `Reinspection #${insp.id} FAILED → corrective action reopened`, 'policy', passed ? 'done' : 'failed', `score ${insp.score}`);
    if (!passed) mail(String(process.env.NOTIFY_EMAIL || adminEmail || ''), `Reinspection failed: complaint ${number(c)}`, `Inspection #${insp.id} (${insp.area}) failed with score ${insp.score}. The corrective action has been reopened.`, c.id);
    res.json({ passed, complaint: view(getC(c.id)) });
  });
  // Customer contact + confirmation. Rejected → reopened (corrective action) + management notified.
  app.post('/api/admin/quality/complaints/:id/customer-contact', auth, (req, res) => {
    const c = getC(Number(req.params.id)); if (!c) return res.status(404).json({ error: 'Complaint not found.' });
    const b = req.body || {}, msg = clean(b.message, 2000); if (!msg) return res.status(400).json({ error: 'Write what was communicated.' });
    const accepted = b.accepted === true ? 1 : b.accepted === false ? 0 : null, t = now();
    db.prepare('INSERT INTO quality_complaint_comms(complaint_id,channel,direction,message,accepted,actor,created_at) VALUES(?,?,?,?,?,?,?)').run(c.id, ['phone', 'email', 'in person', 'text'].includes(b.channel) ? b.channel : 'phone', 'outbound', msg, accepted, who(req), t);
    hist(c.id, who(req), 'customer contact', null, accepted === 1 ? 'accepted resolution' : accepted === 0 ? 'REJECTED resolution' : 'update');
    if (accepted === 1) db.prepare('UPDATE quality_complaints SET customer_accepted=1, updated_at=? WHERE id=?').run(t, c.id);
    if (accepted === 0) { db.prepare("UPDATE quality_complaints SET customer_accepted=0, status='CORRECTIVE_ACTION', updated_at=? WHERE id=?").run(t, c.id); hist(c.id, who(req), 'status', c.status, 'CORRECTIVE_ACTION'); op(c.id, 'Customer rejected the resolution → reopened', 'policy', 'failed', msg.slice(0, 200)); mail(String(process.env.NOTIFY_EMAIL || adminEmail || ''), `Customer rejected resolution: ${number(c)}`, msg, c.id); }
    res.status(201).json({ complaint: view(getC(c.id)) });
  });
  // Autopilot activity feed + approvals queue (Command Center).
  app.get('/api/admin/autopilot/activity', auth, (req, res) => {
    sync();
    res.json({ recent: db.prepare("SELECT a.*, q.id complaint_id FROM ops_actions a LEFT JOIN quality_complaints q ON a.ref_type='complaint' AND q.id=a.ref_id ORDER BY a.id DESC LIMIT 40").all().map(a => ({ ...a, ref_number: a.ref_type === 'complaint' ? `QC-${1000 + a.ref_id}` : null })),
      awaiting: db.prepare("SELECT * FROM ops_actions WHERE status='needs_approval' ORDER BY id DESC LIMIT 50").all().map(a => ({ ...a, ref_number: `QC-${1000 + a.ref_id}` })),
      exceptions: db.prepare("SELECT * FROM ops_actions WHERE status IN ('blocked','failed') AND resolved_at IS NULL AND created_at>=? ORDER BY id DESC LIMIT 50").all(new Date(Date.now() - 14 * 864e5).toISOString()).map(a => ({ ...a, ref_number: `QC-${1000 + a.ref_id}` })) });
  });
  app.put('/api/admin/quality/settings', auth, (req, res) => {
    if (roleOf(req) !== 'owner' && roleOf(req) !== 'manager') return res.status(403).json({ error: 'Only an owner or manager can change quality settings.' });
    const m = clean((req.body || {}).quality_manager, 254).toLowerCase();
    if (m && m !== String(adminEmail).toLowerCase() && !db.prepare('SELECT 1 FROM admin_users WHERE lower(email)=?').get(m)) return res.status(400).json({ error: 'Choose someone who has access to the admin.' });
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('quality_manager',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(m, now());
    logAction(req, 'set quality manager', 'settings', 0, m); res.json({ ok: true, quality_manager: m });
  });
  app.get('/api/admin/quality/settings', auth, (req, res) => res.json({ quality_manager: qualityManager() }));
};
