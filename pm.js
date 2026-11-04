// Project Management Center: work plans per cleaning service, weighted tasks with verification, readiness and
// dispatch approval, actual costs vs budget, work orders, customer sign-off, completion certificate and billing handoff.
const { Doc } = require('./pdf');

const SERVICES = {
  construction: { label: 'Construction rough & final clean', recurring: false, plan: [['Pre-start walkthrough & site access', 'Planning', 5], ['Staffing & equipment plan confirmed', 'Planning', 5], ['Rough clean (Clean #1)', 'Execution', 25], ['Final clean (Clean #2)', 'Execution', 30], ['Touch-up / punch clean (Clean #3)', 'Execution', 15], ['Quality inspection', 'Quality', 10], ['Customer walkthrough & sign-off', 'Acceptance', 10]] },
  punchlist: { label: 'Final touch-up & punch list', recurring: false, plan: [['Receive punch list & photos', 'Planning', 10], ['Touch-up cleaning by area', 'Execution', 50], ['Re-inspect punch items', 'Quality', 20], ['Customer sign-off', 'Acceptance', 20]] },
  windows: { label: 'Interior & exterior window cleaning', recurring: false, plan: [['Lift / ladder & safety plan', 'Planning', 10], ['Interior glass', 'Execution', 30], ['Exterior glass', 'Execution', 35], ['Frames, sills & tracks', 'Execution', 10], ['Quality check & photos', 'Quality', 15]] },
  turnover: { label: 'Multifamily unit turnover', recurring: true, plan: [['Receive unit list & access', 'Planning', 10], ['Move-out cleans completed', 'Execution', 60], ['Unit inspections', 'Quality', 20], ['Property manager sign-off', 'Acceptance', 10]] },
  common_area: { label: 'Apartment common-area cleaning', recurring: true, plan: [['Route & area checklist set', 'Planning', 15], ['Recurring service running', 'Execution', 60], ['Monthly quality inspection', 'Quality', 25]] },
  janitorial: { label: 'Commercial recurring janitorial', recurring: true, plan: [['Site walk & checklist by area', 'Planning', 10], ['Keys, alarm codes & supply closet', 'Planning', 10], ['Recurring service running', 'Execution', 55], ['Monthly quality inspection', 'Quality', 25]] },
  power_wash: { label: 'Power washing', recurring: false, plan: [['Water source & runoff plan', 'Planning', 15], ['Pre-treat & wash surfaces', 'Execution', 55], ['Rinse & site cleanup', 'Execution', 15], ['Photos & customer check', 'Quality', 15]] },
  parking: { label: 'Parking lot maintenance', recurring: true, plan: [['Lot map & schedule set', 'Planning', 15], ['Sweeping / litter service running', 'Execution', 60], ['Monthly lot inspection', 'Quality', 25]] },
  valet_trash: { label: 'Valet trash', recurring: true, plan: [['Building list, door times & compactor access', 'Planning', 20], ['Nightly route running', 'Execution', 60], ['Missed-pickup review', 'Quality', 20]] }
};
const READY = [['staffing', 'Staffing confirmed'], ['dates', 'Dates confirmed with customer'], ['access', 'Site access arranged'], ['equipment', 'Equipment ready'], ['supplies', 'Supplies ready'], ['safety', 'Site safety / orientation done']];
const ACTIVE = ['Ready to mobilize', 'Mobilization', 'In Progress', 'Quality Review', 'Completed'];
const COST_CATS = ['Labor', 'Supplies', 'Equipment', 'Subcontractor', 'Travel', 'Disposal', 'Other'];

module.exports = function mountPM(app, ctx) {
  const { db, auth, logAction, clean, adminEmail } = ctx;
  const cols = db.prepare('PRAGMA table_info(projects)').all().map(c => c.name);
  for (const [c, t] of [['customer_id', 'INTEGER'], ['property_id', 'INTEGER'], ['estimate_id', 'INTEGER'], ['service', 'TEXT'], ['frequency', 'TEXT'], ['budget', 'REAL DEFAULT 0'],
    ['actual_start', 'TEXT'], ['actual_end', 'TEXT'], ['readiness', "TEXT DEFAULT '{}'"], ['dispatch_approved_by', 'TEXT'], ['dispatch_approved_at', 'TEXT'], ['contract_waiver', 'TEXT'],
    ['site_info', "TEXT DEFAULT '{}'"], ['hold_reason', 'TEXT'], ['signoff_name', 'TEXT'], ['signoff_title', 'TEXT'], ['signoff_at', 'TEXT'], ['signoff_waiver', 'TEXT'], ['billing_invoice_id', 'INTEGER'], ['updated_at', 'TEXT']])
    if (!cols.includes(c)) db.exec(`ALTER TABLE projects ADD COLUMN ${c} ${t}`);
  db.exec(`CREATE TABLE IF NOT EXISTS project_tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, title TEXT NOT NULL, phase TEXT, weight REAL NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'Open', assigned_to TEXT, due_date TEXT, done_at TEXT, done_by TEXT, verified_at TEXT, verified_by TEXT, source TEXT DEFAULT 'manual', approved INTEGER NOT NULL DEFAULT 1, sort INTEGER DEFAULT 0, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ptasks_p ON project_tasks(project_id);
    CREATE TABLE IF NOT EXISTS project_costs(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, category TEXT NOT NULL, description TEXT, amount REAL NOT NULL, cost_date TEXT, entered_by TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS pcosts_p ON project_costs(project_id);
    CREATE TABLE IF NOT EXISTS project_updates(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'Update', body TEXT NOT NULL, author TEXT, created_at TEXT NOT NULL);`);
  const now = () => new Date().toISOString(), today = () => require('./bizdate').today();
  const who = req => (req.user && req.user.email) || null;
  const roleOf = req => { const e = String(who(req) || '').toLowerCase(); if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  const get = id => db.prepare('SELECT * FROM projects WHERE id=?').get(Number(id));
  const J = (s, d) => { try { return JSON.parse(s || '') || d; } catch { return d; } };
  const number = p => `PJT-${String(p.created_at || '').slice(0, 4) || '2026'}-${1000 + p.id}`;
  const contractOf = p => p.contract_id ? db.prepare('SELECT * FROM contracts WHERE id=?').get(p.contract_id) : null;
  const executed = k => !!k && ['Signed', 'Executed', 'Fully signed'].includes(k.signature_status);

  // Progress comes from tasks: verified tasks count fully, done-but-unverified count half. Manual % only when there are no tasks.
  function progressOf(pid) {
    const t = db.prepare('SELECT weight, status FROM project_tasks WHERE project_id=? AND approved=1').all(pid);
    const total = t.reduce((s, x) => s + x.weight, 0);
    if (!total) return null;
    const got = t.reduce((s, x) => s + (x.status === 'Verified' ? x.weight : x.status === 'Done' ? x.weight / 2 : 0), 0);
    return Math.round(got / total * 100);
  }
  const syncProgress = pid => { const p = progressOf(pid); if (p != null) db.prepare('UPDATE projects SET progress=?, updated_at=? WHERE id=?').run(p, now(), pid); return p; };
  function costs(pid) { const r = db.prepare('SELECT category, SUM(amount) v FROM project_costs WHERE project_id=? GROUP BY category').all(pid); return { total: Math.round(r.reduce((s, x) => s + x.v, 0) * 100) / 100, by: Object.fromEntries(r.map(x => [x.category, Math.round(x.v * 100) / 100])) }; }
  function readinessOf(p) { const r = J(p.readiness, {}); const missing = READY.filter(([k]) => !(r[k] && r[k].by)).map(([, l]) => l); return { items: READY.map(([k, l]) => ({ key: k, label: l, ...(r[k] || {}) })), missing, complete: !missing.length }; }
  // Why a project may not move to an operational status yet (null when allowed).
  function guard(p, to) {
    if (!ACTIVE.includes(to) || ACTIVE.includes(p.status)) {
      if (to === 'Completed') return completeBlock(p);
      return null;
    }
    const k = contractOf(p), why = [];
    if (!executed(k) && !p.contract_waiver) why.push(k ? `the contract is signed (it is currently "${k.signature_status || 'Not sent'}")` : 'there is an executed contract');
    const r = readinessOf(p); if (!r.complete) why.push('readiness is confirmed (still needed: ' + r.missing.join(', ') + ')');
    if (!p.dispatch_approved_by) why.push('an owner or manager approves dispatch');
    if (to === 'Completed') { const c = completeBlock(p); if (c) why.push(c); }
    return why.length ? `This project stays in Planning until ${why.join('; ')}.` : null;
  }
  function completeBlock(p) {
    const open = db.prepare("SELECT COUNT(*) n FROM project_tasks WHERE project_id=? AND approved=1 AND status='Open'").get(p.id).n;
    const why = [];
    if (open) why.push(`${open} task(s) are still open`);
    if (!p.signoff_name && !p.signoff_waiver) why.push('customer sign-off (or a recorded reason it is not needed) is missing');
    return why.length ? why.join('; ') : null;
  }
  app.locals.projectHasTasks = id => !!db.prepare('SELECT 1 FROM project_tasks WHERE project_id=? AND approved=1').get(id);
  app.locals.projectGuard = (id, to) => { const p = get(id); return p ? guard(p, to) : null; };

  function summary(p) {
    const k = contractOf(p), c = costs(p.id), r = readinessOf(p);
    const behind = ['In Progress', 'Mobilization', 'Ready to mobilize'].includes(p.status) && ((p.due_date && p.due_date < today() && (p.progress || 0) < 100) || !!db.prepare("SELECT 1 FROM project_tasks WHERE project_id=? AND status='Open' AND due_date IS NOT NULL AND due_date<>'' AND due_date<?").get(p.id, today()));
    return { ...p, number: number(p), service_label: (SERVICES[p.service] || {}).label || null, contract: k ? { id: k.id, title: k.title, value: k.value, signature_status: k.signature_status, status: k.status } : null,
      contract_value: k ? Number(k.value) || 0 : 0, actual_cost: c.total, cost_by: c.by, readiness_complete: r.complete, readiness_missing: r.missing, behind,
      awaiting_approval: p.status === 'Planning' && r.complete && (executed(k) || !!p.contract_waiver) && !p.dispatch_approved_by,
      tasks_open: db.prepare("SELECT COUNT(*) n FROM project_tasks WHERE project_id=? AND approved=1 AND status='Open'").get(p.id).n,
      tasks_review: db.prepare('SELECT COUNT(*) n FROM project_tasks WHERE project_id=? AND approved=0').get(p.id).n };
  }

  app.get('/api/admin/pm/projects', auth, (req, res) => {
    // Link projects created from approved proposals to their estimate, customer and service (once).
    const SVC = { construction: 'construction', janitorial: 'janitorial', windows: 'windows' };
    for (const p of db.prepare('SELECT p.id, p.estimate_id, p.service, p.customer_id, p.company, c.estimate_id ce FROM projects p LEFT JOIN contracts c ON c.id=p.contract_id WHERE p.estimate_id IS NULL OR p.customer_id IS NULL').all()) {
      const eid = p.estimate_id || p.ce, e = eid && db.prepare('SELECT scope_category, email, company FROM estimates WHERE id=?').get(eid);
      const cu = !p.customer_id && db.prepare('SELECT id FROM customers WHERE (company<>\'\' AND lower(company)=lower(?)) OR (email<>\'\' AND lower(email)=lower(?))').get(p.company || (e && e.company) || '', (e && e.email) || '');
      db.prepare('UPDATE projects SET estimate_id=COALESCE(estimate_id,?), service=COALESCE(service,?), customer_id=COALESCE(customer_id,?) WHERE id=?').run(eid || null, (e && SVC[e.scope_category]) || null, (cu && cu.id) || null, p.id);
    }
    const list = db.prepare('SELECT * FROM projects ORDER BY id DESC').all().map(summary);
    const month = today().slice(0, 7);
    const sum = (a, f) => Math.round(a.reduce((t, x) => t + (Number(f(x)) || 0), 0) * 100) / 100;
    const live = list.filter(p => p.status !== 'Archived');
    res.json({ projects: list, services: Object.fromEntries(Object.entries(SERVICES).map(([k, v]) => [k, v.label])), cost_categories: COST_CATS,
      kpis: { active: live.filter(p => ['In Progress', 'Mobilization', 'Ready to mobilize', 'Quality Review'].includes(p.status)).length, kickoff: live.filter(p => p.status === 'Planning').length,
        awaiting_approval: live.filter(p => p.awaiting_approval).length, behind: live.filter(p => p.behind).length, on_hold: live.filter(p => p.status === 'On Hold').length,
        completed_month: live.filter(p => p.status === 'Completed' && String(p.actual_end || p.updated_at || '').slice(0, 7) === month).length,
        contracted: sum(live, p => p.contract_value), budget: sum(live, p => p.budget), actual_cost: sum(live, p => p.actual_cost),
        gross_profit: sum(live.filter(p => p.actual_cost > 0), p => p.contract_value - p.actual_cost) } });
  });

  app.get('/api/admin/pm/projects/:id', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    const s = summary(p), est = p.estimate_id ? db.prepare('SELECT id, project_name, scope, scope_category, proposal_total, labor_hours, total_cost, version, assumptions, exclusions, status, signer_name, signed_at FROM estimates WHERE id=?').get(p.estimate_id)
      : (s.contract && db.prepare('SELECT id, project_name, scope, scope_category, proposal_total, labor_hours, total_cost, version, assumptions, exclusions, status, signer_name, signed_at FROM estimates WHERE id=(SELECT estimate_id FROM contracts WHERE id=?)').get(s.contract.id));
    const q = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };
    res.json({ project: s, estimate: est || null, readiness: readinessOf(p), site: J(p.site_info, {}),
      tasks: db.prepare('SELECT * FROM project_tasks WHERE project_id=? ORDER BY approved DESC, sort, id').all(p.id), costs: db.prepare('SELECT * FROM project_costs WHERE project_id=? ORDER BY cost_date DESC, id DESC').all(p.id),
      updates: db.prepare('SELECT * FROM project_updates WHERE project_id=? ORDER BY id DESC').all(p.id), visits: q('SELECT * FROM visits WHERE project_id=? ORDER BY date, start_time', p.id),
      documents: q('SELECT id,title,kind,revision,file_name,file_url,created_at FROM documents WHERE project_id=? ORDER BY id DESC', p.id), inspections: q('SELECT id,area,date,score,passed,inspector FROM inspections WHERE project_id=? ORDER BY date DESC', p.id),
      issues: q("SELECT id,type,title,priority,status,due_date FROM customer_issues WHERE project_id=? ORDER BY id DESC", p.id), invoices: q('SELECT id,invoice_number,amount,paid_amount,status,due_date FROM invoices WHERE project_id=? ORDER BY id DESC', p.id),
      activity: db.prepare(`SELECT * FROM audit_log WHERE (entity='project' AND entity_id=?) OR (entity IN ('project task','project cost') AND details LIKE ?) ORDER BY id DESC LIMIT 200`).all(p.id, `%${number(p)}%`),
      services: Object.fromEntries(Object.entries(SERVICES).map(([k, v]) => [k, v.label])), cost_categories: COST_CATS, guard_next: guard(p, 'In Progress') });
  });

  app.patch('/api/admin/pm/projects/:id', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    const b = req.body || {}, set = {};
    if ('service' in b) { if (b.service && !SERVICES[b.service]) return res.status(400).json({ error: 'Choose a valid service.' }); set.service = b.service || null; }
    for (const k of ['frequency', 'hold_reason', 'contract_waiver', 'signoff_waiver', 'manager', 'site_address', 'name']) if (k in b) set[k] = clean(b[k], 1000);
    for (const k of ['start_date', 'due_date', 'actual_start', 'actual_end']) if (k in b) { const d = clean(b[k], 10); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Dates must be dates.' }); set[k] = d || null; }
    if ('budget' in b) { const v = Number(b.budget); if (!(v >= 0)) return res.status(400).json({ error: 'Budget must be a number.' }); set.budget = v; }
    if ('site_info' in b) set.site_info = JSON.stringify(Object.fromEntries(Object.entries(b.site_info || {}).map(([k, v]) => [clean(k, 40), clean(v, 2000)])));
    if ('contract_waiver' in set && set.contract_waiver && roleOf(req) !== 'owner') return res.status(403).json({ error: 'Only an owner can start work without an executed contract.' });
    const keys = Object.keys(set); if (!keys.length) return res.json({ ok: true });
    db.prepare(`UPDATE projects SET ${keys.map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`).run(...keys.map(k => set[k]), now(), p.id);
    logAction(req, 'updated', 'project', p.id, `${number(p)}: ${keys.join(', ')}`);
    res.json({ ok: true });
  });

  // Readiness: each item is confirmed by a person with a timestamp.
  app.post('/api/admin/pm/projects/:id/readiness', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    const k = (req.body || {}).key, item = READY.find(([x]) => x === k); if (!item) return res.status(400).json({ error: 'Unknown readiness item.' });
    const r = J(p.readiness, {});
    if ((req.body || {}).confirmed === false) delete r[k]; else r[k] = { by: who(req), at: now(), note: clean((req.body || {}).note, 300) };
    db.prepare('UPDATE projects SET readiness=?, dispatch_approved_by=CASE WHEN ? THEN NULL ELSE dispatch_approved_by END, updated_at=? WHERE id=?').run(JSON.stringify(r), (req.body || {}).confirmed === false ? 1 : 0, now(), p.id);
    logAction(req, (req.body || {}).confirmed === false ? 'unconfirmed' : 'confirmed', 'project', p.id, `${number(p)}: ${item[1]}`);
    res.json({ readiness: readinessOf(get(p.id)) });
  });
  app.post('/api/admin/pm/projects/:id/approve-dispatch', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only an owner or manager can approve dispatch.' });
    const k = contractOf(p), r = readinessOf(p), why = [];
    if (!executed(k) && !p.contract_waiver) why.push('the contract is not executed');
    if (!r.complete) why.push('readiness is incomplete: ' + r.missing.join(', '));
    if (why.length) return res.status(409).json({ error: 'Cannot approve dispatch yet: ' + why.join('; ') + '.' });
    db.prepare("UPDATE projects SET dispatch_approved_by=?, dispatch_approved_at=?, status=CASE WHEN status='Planning' THEN 'Ready to mobilize' ELSE status END, updated_at=? WHERE id=?").run(who(req), now(), now(), p.id);
    db.prepare("UPDATE visits SET status='Scheduled' WHERE project_id=? AND status='Tentative'").run(p.id);
    logAction(req, 'approved dispatch', 'project', p.id, number(p));
    res.json({ ok: true, project: summary(get(p.id)) });
  });

  // Work plan from the service template (idempotent: only when the project has no tasks yet).
  app.post('/api/admin/pm/projects/:id/plan', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    const svc = SERVICES[(req.body || {}).service || p.service]; if (!svc) return res.status(400).json({ error: 'Set the cleaning service first.' });
    if (db.prepare('SELECT 1 FROM project_tasks WHERE project_id=?').get(p.id)) return res.status(409).json({ error: 'This project already has a work plan. Add or edit tasks instead.' });
    const t = now(); let i = 0;
    for (const [title, phase, w] of svc.plan) db.prepare('INSERT INTO project_tasks(project_id,title,phase,weight,source,approved,sort,created_at) VALUES(?,?,?,?,?,1,?,?)').run(p.id, title, phase, w, 'template', i++, t);
    if (!p.service) db.prepare('UPDATE projects SET service=? WHERE id=?').run((req.body || {}).service, p.id);
    syncProgress(p.id);
    logAction(req, 'created work plan', 'project', p.id, `${number(p)}: ${svc.label}, ${svc.plan.length} tasks`);
    res.status(201).json({ tasks: svc.plan.length });
  });
  // Work orders: tentative visits from the frequency; they become Scheduled only after dispatch approval.
  app.post('/api/admin/pm/projects/:id/work-orders', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    const b = req.body || {}, freq = b.frequency || p.frequency, start = clean(b.start || p.start_date || today(), 10), count = Math.min(60, Math.max(1, Number(b.count) || 4));
    const step = { daily: 1, weekly: 7, biweekly: 14, monthly: 30, once: 0 }[freq];
    if (step == null) return res.status(400).json({ error: 'Choose a frequency: once, daily, weekly, biweekly or monthly.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return res.status(400).json({ error: 'Start date must be a date.' });
    const n = step ? count : 1, ids = [], status = p.dispatch_approved_by ? 'Scheduled' : 'Tentative', title = `${(SERVICES[p.service] || {}).label || 'Service'} – ${p.name || number(p)}`;
    for (let i = 0; i < n; i++) {
      const d = new Date(start + 'T12:00:00Z'); if (freq === 'monthly') d.setUTCMonth(d.getUTCMonth() + i); else d.setUTCDate(d.getUTCDate() + i * step);
      const ds = d.toISOString().slice(0, 10);
      if (db.prepare('SELECT 1 FROM visits WHERE project_id=? AND date=? AND type=?').get(p.id, ds, 'Work order')) continue;
      ids.push(db.prepare("INSERT INTO visits(title,type,date,start_time,end_time,project_id,customer_id,address,assigned_to,status,notes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(title, 'Work order', ds, clean(b.start_time, 5) || '08:00', clean(b.end_time, 5) || '16:00', p.id, p.customer_id || null, p.site_address || '', clean(b.assigned_to, 200) || p.manager || '', status, `From ${number(p)} work plan`, who(req), now(), now()).lastInsertRowid);
    }
    if (b.frequency) db.prepare('UPDATE projects SET frequency=? WHERE id=?').run(freq, p.id);
    logAction(req, 'generated work orders', 'project', p.id, `${number(p)}: ${ids.length} ${freq} (${status})`);
    res.status(201).json({ created: ids.length, status });
  });

  // Tasks
  app.post('/api/admin/pm/projects/:id/tasks', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    const b = req.body || {}, title = clean(b.title, 200); if (!title) return res.status(400).json({ error: 'Name the task.' });
    const w = b.weight == null || b.weight === '' ? 5 : Number(b.weight); if (!(w > 0 && w <= 100)) return res.status(400).json({ error: 'Weight must be between 1 and 100.' });
    const id = db.prepare('INSERT INTO project_tasks(project_id,title,phase,weight,assigned_to,due_date,source,approved,sort,created_at) VALUES(?,?,?,?,?,?,?,1,?,?)').run(p.id, title, clean(b.phase, 40) || 'Execution', w, clean(b.assigned_to, 200), clean(b.due_date, 10) || null, 'manual', 999, now()).lastInsertRowid;
    syncProgress(p.id); logAction(req, 'added', 'project task', id, `${number(p)}: ${title}`);
    res.status(201).json({ id });
  });
  app.patch('/api/admin/pm/tasks/:tid', auth, (req, res) => {
    const t = db.prepare('SELECT * FROM project_tasks WHERE id=?').get(Number(req.params.tid)); if (!t) return res.status(404).json({ error: 'Task not found.' });
    const p = get(t.project_id), b = req.body || {}, set = {};
    if ('approved' in b) { set.approved = b.approved ? 1 : 0; }
    if ('status' in b) {
      if (!['Open', 'Done', 'Verified'].includes(b.status)) return res.status(400).json({ error: 'Status must be Open, Done or Verified.' });
      if (!t.approved && !set.approved) return res.status(409).json({ error: 'Review and accept this AI-suggested task before working on it.' });
      if (b.status === 'Verified') { if (t.status === 'Open') return res.status(409).json({ error: 'Mark the task done before verifying it.' }); if (t.done_by && t.done_by === who(req) && roleOf(req) === 'staff') return res.status(403).json({ error: 'Someone other than the person who did the work must verify it.' }); set.verified_by = who(req); set.verified_at = now(); }
      if (b.status === 'Done') { set.done_by = who(req); set.done_at = now(); set.verified_by = null; set.verified_at = null; }
      if (b.status === 'Open') { set.done_by = null; set.done_at = null; set.verified_by = null; set.verified_at = null; }
      set.status = b.status;
    }
    for (const k of ['title', 'phase', 'assigned_to']) if (k in b) set[k] = clean(b[k], 200);
    if ('due_date' in b) set.due_date = clean(b.due_date, 10) || null;
    if ('weight' in b) { const w = Number(b.weight); if (!(w > 0 && w <= 100)) return res.status(400).json({ error: 'Weight must be between 1 and 100.' }); set.weight = w; }
    const keys = Object.keys(set); if (!keys.length) return res.json({ ok: true });
    db.prepare(`UPDATE project_tasks SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => set[k]), t.id);
    const prog = syncProgress(t.project_id);
    logAction(req, set.status ? 'marked ' + set.status.toLowerCase() : 'updated', 'project task', t.id, `${number(p)}: ${t.title}`);
    res.json({ ok: true, progress: prog });
  });
  app.delete('/api/admin/pm/tasks/:tid', auth, (req, res) => {
    const t = db.prepare('SELECT * FROM project_tasks WHERE id=?').get(Number(req.params.tid)); if (!t) return res.status(404).json({ error: 'Task not found.' });
    if (t.status === 'Verified') return res.status(409).json({ error: 'Verified work stays on record.' });
    db.prepare('DELETE FROM project_tasks WHERE id=?').run(t.id); syncProgress(t.project_id);
    logAction(req, 'removed', 'project task', t.id, `${number(get(t.project_id))}: ${t.title}`);
    res.json({ ok: true });
  });

  // Actual costs (recorded expenses, never estimates)
  app.post('/api/admin/pm/projects/:id/costs', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    const b = req.body || {}, amt = Number(String(b.amount ?? '').replace(/[$,]/g, ''));
    if (!COST_CATS.includes(b.category)) return res.status(400).json({ error: 'Choose a cost category.' });
    if (!(amt > 0 && amt < 1e8)) return res.status(400).json({ error: 'Enter the amount spent.' });
    const id = db.prepare('INSERT INTO project_costs(project_id,category,description,amount,cost_date,entered_by,created_at) VALUES(?,?,?,?,?,?,?)').run(p.id, b.category, clean(b.description, 300), Math.round(amt * 100) / 100, clean(b.cost_date, 10) || today(), who(req), now()).lastInsertRowid;
    logAction(req, 'recorded', 'project cost', id, `${number(p)}: ${b.category} $${amt.toFixed(2)}`);
    res.status(201).json({ id, costs: costs(p.id) });
  });
  app.post('/api/admin/pm/projects/:id/updates', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    const body = clean((req.body || {}).body, 5000); if (!body) return res.status(400).json({ error: 'Write the update first.' });
    const kind = ['Update', 'Customer communication', 'Site note', 'Risk'].includes((req.body || {}).kind) ? req.body.kind : 'Update';
    const id = db.prepare('INSERT INTO project_updates(project_id,kind,body,author,created_at) VALUES(?,?,?,?,?)').run(p.id, kind, body, who(req), now()).lastInsertRowid;
    logAction(req, 'logged ' + kind.toLowerCase(), 'project', p.id, `${number(p)}: ${body.slice(0, 150)}`);
    res.status(201).json({ id });
  });

  // Status changes go through the same guard as the register route.
  app.post('/api/admin/pm/projects/:id/status', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    const to = (req.body || {}).status, ok = ['Planning', 'Ready to mobilize', 'In Progress', 'Quality Review', 'On Hold', 'Completed', 'Archived'];
    if (!ok.includes(to)) return res.status(400).json({ error: 'Choose a valid status.' });
    const g = guard(p, to); if (g) return res.status(409).json({ error: g });
    if (to === 'On Hold' && !clean((req.body || {}).reason, 500) && !p.hold_reason) return res.status(400).json({ error: 'Give a reason for putting the project on hold.' });
    const extra = to === 'In Progress' && !p.actual_start ? ', actual_start=?' : to === 'Completed' ? ', actual_end=?' : '';
    db.prepare(`UPDATE projects SET status=?, hold_reason=COALESCE(?,hold_reason), updated_at=?${extra} WHERE id=?`).run(to, to === 'On Hold' ? clean(req.body.reason, 500) || null : null, now(), ...(extra ? [today()] : []), p.id);
    logAction(req, 'moved to ' + to, 'project', p.id, number(p));
    res.json({ ok: true, project: summary(get(p.id)) });
  });
  // Customer sign-off and completion; billing handoff creates a DRAFT invoice for the unbilled contract value.
  app.post('/api/admin/pm/projects/:id/signoff', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    const name = clean((req.body || {}).name, 120); if (name.length < 2) return res.status(400).json({ error: 'Enter the name of the customer representative who accepted the work.' });
    db.prepare('UPDATE projects SET signoff_name=?, signoff_title=?, signoff_at=?, updated_at=? WHERE id=?').run(name, clean(req.body.title, 120), now(), now(), p.id);
    logAction(req, 'recorded customer sign-off', 'project', p.id, `${number(p)}: ${name}`);
    res.json({ ok: true });
  });
  app.post('/api/admin/pm/projects/:id/billing-handoff', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    if (p.status !== 'Completed') return res.status(409).json({ error: 'Complete the project before handing it to billing.' });
    if (p.billing_invoice_id && db.prepare('SELECT 1 FROM invoices WHERE id=?').get(p.billing_invoice_id)) return res.status(409).json({ error: 'A billing draft already exists for this project.', invoice_id: p.billing_invoice_id });
    const k = contractOf(p), billed = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM invoices WHERE project_id=? AND status<>'Void'").get(p.id).v;
    const due = Math.round(((k ? Number(k.value) : 0) - billed) * 100) / 100;
    if (!(due > 0)) return res.status(409).json({ error: k ? 'The contract value is already fully invoiced.' : 'There is no contract value to bill. Create the invoice manually.' });
    const y = new Date().getFullYear(), mx = db.prepare('SELECT invoice_number FROM invoices WHERE invoice_number LIKE ?').all(`BC-${y}-%`).reduce((m, r) => Math.max(m, Number(String(r.invoice_number).split('-')[2]) || 0), 0);
    const cust = p.customer_id ? db.prepare('SELECT * FROM customers WHERE id=?').get(p.customer_id) : null;
    const id = db.prepare("INSERT INTO invoices(invoice_number,project_id,customer_name,company,email,amount,paid_amount,due_date,status,created_at) VALUES(?,?,?,?,?,?,0,?,'Draft',?)")
      .run(`BC-${y}-${String(mx + 1).padStart(4, '0')}`, p.id, p.customer_name || (cust && cust.name) || '', p.company || (cust && cust.company) || '', (cust && cust.email) || '', due, new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), now()).lastInsertRowid;
    db.prepare('UPDATE projects SET billing_invoice_id=? WHERE id=?').run(id, p.id);
    logAction(req, 'handed off to billing', 'project', p.id, `${number(p)}: draft invoice #${id} for $${due.toFixed(2)} (not sent)`);
    res.status(201).json({ invoice_id: id, amount: due });
  });
  app.get('/api/admin/pm/projects/:id/certificate', auth, (req, res) => {
    const p = get(req.params.id); if (!p) return res.status(404).json({ error: 'Project not found.' });
    if (p.status !== 'Completed') return res.status(409).json({ error: 'The certificate is available once the project is completed.' });
    const d = new Doc(), tasks = db.prepare("SELECT title, phase, verified_by, verified_at FROM project_tasks WHERE project_id=? AND approved=1 ORDER BY sort, id").all(p.id);
    d.box(0, 742, 612, 50, '0.06 0.15 0.26'); d.y = 762; d.text('BRIGHT CLEANING SEV INC.  -  CERTIFICATE OF COMPLETION', { size: 13, bold: true, color: '1 1 1' }); d.y = 712;
    d.heading(p.name || number(p), 15); d.para(`${number(p)}  |  ${p.company || p.customer_name || ''}  |  ${p.site_address || ''}`);
    d.para(`Service: ${(SERVICES[p.service] || {}).label || 'Cleaning services'}   Started: ${p.actual_start || p.start_date || '-'}   Completed: ${p.actual_end || today()}`);
    d.heading('Work completed', 11); d.table([{ label: 'Task', w: 55 }, { label: 'Phase', w: 15 }, { label: 'Verified by', w: 30 }], tasks.map(t => [t.title, t.phase || '', t.verified_by ? `${t.verified_by} (${String(t.verified_at).slice(0, 10)})` : 'Done']));
    d.heading('Customer acceptance', 11);
    d.para(p.signoff_name ? `Accepted by ${p.signoff_name}${p.signoff_title ? ', ' + p.signoff_title : ''} on ${String(p.signoff_at).slice(0, 10)}.` : `Customer sign-off not required: ${p.signoff_waiver}`);
    d.footer(`Bright Cleaning Sev Inc. - ${number(p)} completion certificate`);
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${number(p)}-completion.pdf"`); res.send(d.toBuffer());
  });
  app.locals.pmProjects = { SERVICES, summary, number, syncProgress };
};
