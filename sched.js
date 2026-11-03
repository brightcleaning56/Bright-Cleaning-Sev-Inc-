// Scheduling & Dispatch: employees, skills, time off, crew assignment with conflict and overtime checks,
// dispatch confirmation and notifications, holidays/skips for recurring work, time tracking with labor cost,
// and a private mobile crew page (per-employee secure link) for check-in/out, photos, checklist and incidents.
const crypto = require('crypto');
const ROLES = ['Cleaner', 'Lead', 'Supervisor', 'Window tech', 'Driver', 'Inspector'];

module.exports = function mountSched(app, ctx) {
  const { db, auth, logAction, clean, adminEmail, uploadDir } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS employees(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT, role TEXT DEFAULT 'Cleaner', crew TEXT,
      skills TEXT, hourly_rate REAL DEFAULT 0, max_week_hours REAL DEFAULT 40, work_days TEXT DEFAULT '1,2,3,4,5', day_start TEXT DEFAULT '07:00', day_end TEXT DEFAULT '17:00',
      active INTEGER NOT NULL DEFAULT 1, token TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS employee_timeoff(id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, reason TEXT, created_by TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS company_holidays(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL UNIQUE, name TEXT);
    CREATE TABLE IF NOT EXISTS visit_crew(visit_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, override_reason TEXT, assigned_by TEXT, assigned_at TEXT NOT NULL, notified_at TEXT, PRIMARY KEY(visit_id, employee_id));
    CREATE TABLE IF NOT EXISTS time_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, visit_id INTEGER, project_id INTEGER, clock_in TEXT NOT NULL, clock_out TEXT,
      minutes INTEGER, source TEXT DEFAULT 'crew', note TEXT, approved_by TEXT, approved_at TEXT, cost_id INTEGER, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS te_emp ON time_entries(employee_id);`);
  const vcols = db.prepare('PRAGMA table_info(visits)').all().map(c => c.name);
  for (const [c, t] of [['dispatched_at', 'TEXT'], ['dispatched_by', 'TEXT'], ['arrived_at', 'TEXT'], ['departed_at', 'TEXT'], ['completed_at', 'TEXT'], ['priority', "TEXT DEFAULT 'Normal'"],
    ['crew_needed', 'INTEGER'], ['instructions', 'TEXT'], ['equipment', 'TEXT'], ['checklist', "TEXT DEFAULT '[]'"], ['skip_reason', 'TEXT'], ['moved_from', 'TEXT']])
    if (!vcols.includes(c)) db.exec(`ALTER TABLE visits ADD COLUMN ${c} ${t}`);
  const now = () => new Date().toISOString(), today = () => now().slice(0, 10);
  const who = req => (req.user && req.user.email) || null;
  const roleOf = req => { const e = String(who(req) || '').toLowerCase(); if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  const J = (s, d) => { try { return JSON.parse(s || '') || d; } catch { return d; } };
  const mins = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const visitMins = v => { const a = mins(v.start_time), b = mins(v.end_time); return a != null && b != null && b > a ? b - a : 240; };
  const weekStart = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const getEmp = id => db.prepare('SELECT * FROM employees WHERE id=?').get(Number(id));
  const getVisit = id => db.prepare('SELECT * FROM visits WHERE id=?').get(Number(id));
  const crewOf = vid => db.prepare('SELECT e.id, e.name, e.role, e.crew, e.phone, e.email, c.override_reason, c.notified_at FROM visit_crew c JOIN employees e ON e.id=c.employee_id WHERE c.visit_id=? ORDER BY e.name').all(vid);
  const notify = async (to, subject, text) => { const m = ctx.getMailer && ctx.getMailer(); if (!m || !to) return false; try { await m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || adminEmail, to, subject, text }); return true; } catch (e) { console.error('dispatch email failed:', e.message); return false; } };

  // Why an employee cannot take this visit (hard blocks) and soft warnings (overtime needs a reason).
  function check(emp, v) {
    const block = [], warn = [];
    if (!emp.active) block.push(`${emp.name} is inactive`);
    const off = db.prepare('SELECT * FROM employee_timeoff WHERE employee_id=? AND start_date<=? AND end_date>=?').get(emp.id, v.date, v.date);
    if (off) block.push(`${emp.name} is off on ${v.date}${off.reason ? ' (' + off.reason + ')' : ''}`);
    const a1 = mins(v.start_time), b1 = mins(v.end_time) ?? (a1 != null ? a1 + 240 : null);
    for (const o of db.prepare("SELECT v.* FROM visit_crew c JOIN visits v ON v.id=c.visit_id WHERE c.employee_id=? AND v.date=? AND v.id<>? AND v.status NOT IN ('Cancelled','Skipped')").all(emp.id, v.date, v.id)) {
      const a2 = mins(o.start_time), b2 = mins(o.end_time) ?? (a2 != null ? a2 + 240 : null);
      if (a1 == null || a2 == null) warn.push(`${emp.name} also has "${o.title}" that day (no set time): check the timing`);
      else if (a1 < b2 && a2 < b1) block.push(`${emp.name} is already on "${o.title}" ${o.start_time || ''}–${o.end_time || ''}`);
    }
    const dow = new Date(v.date + 'T12:00:00Z').getUTCDay() || 7;
    if (!String(emp.work_days || '').split(',').map(Number).includes(dow)) warn.push(`${v.date} is outside ${emp.name}'s usual work days`);
    if (a1 != null && (a1 < mins(emp.day_start) || (b1 != null && b1 > mins(emp.day_end)))) warn.push(`outside ${emp.name}'s usual hours (${emp.day_start}–${emp.day_end})`);
    const ws = weekStart(v.date), we = addDays(ws, 6);
    const booked = db.prepare("SELECT v.start_time, v.end_time FROM visit_crew c JOIN visits v ON v.id=c.visit_id WHERE c.employee_id=? AND v.date BETWEEN ? AND ? AND v.id<>? AND v.status NOT IN ('Cancelled','Skipped')").all(emp.id, ws, we, v.id).reduce((t, x) => t + visitMins(x), 0);
    const total = (booked + visitMins(v)) / 60;
    if (total > (emp.max_week_hours || 40)) warn.push(`overtime: ${total.toFixed(1)} h scheduled that week (limit ${emp.max_week_hours || 40} h)`);
    return { block, warn, week_hours: Math.round(total * 10) / 10 };
  }
  const empPublic = e => ({ ...e, token: undefined, crew_link: e.token ? `/crew/${e.token}` : null });

  // ---------- Employees ----------
  app.get('/api/admin/employees', auth, (req, res) => {
    const d = clean(req.query.date, 10) || today();
    const list = db.prepare('SELECT * FROM employees ORDER BY active DESC, name').all().map(e => {
      const off = db.prepare('SELECT * FROM employee_timeoff WHERE employee_id=? AND start_date<=? AND end_date>=?').get(e.id, d, d);
      const jobs = db.prepare("SELECT COUNT(*) n FROM visit_crew c JOIN visits v ON v.id=c.visit_id WHERE c.employee_id=? AND v.date=? AND v.status NOT IN ('Cancelled','Skipped')").get(e.id, d).n;
      const ws = weekStart(d), hrs = db.prepare("SELECT v.start_time, v.end_time FROM visit_crew c JOIN visits v ON v.id=c.visit_id WHERE c.employee_id=? AND v.date BETWEEN ? AND ? AND v.status NOT IN ('Cancelled','Skipped')").all(e.id, ws, addDays(ws, 6)).reduce((t, x) => t + visitMins(x), 0) / 60;
      const dow = new Date(d + 'T12:00:00Z').getUTCDay() || 7;
      return { ...empPublic(e), off: off ? off.reason || 'Time off' : null, jobs_on_date: jobs, week_hours: Math.round(hrs * 10) / 10, available: !!e.active && !off && String(e.work_days || '').split(',').map(Number).includes(dow) };
    });
    res.json({ employees: list, roles: ROLES, timeoff: db.prepare('SELECT t.*, e.name FROM employee_timeoff t JOIN employees e ON e.id=t.employee_id WHERE t.end_date>=? ORDER BY t.start_date').all(addDays(d, -30)), holidays: db.prepare('SELECT * FROM company_holidays WHERE date>=? ORDER BY date').all(addDays(d, -30)) });
  });
  function empValidate(b, cur) {
    const out = {}, errs = [];
    if (!cur || 'name' in b) { const n = clean(b.name, 120); if (!n) errs.push('Enter the employee name.'); else out.name = n; }
    for (const k of ['phone', 'crew', 'skills']) if (k in b) out[k] = clean(b[k], 300);
    if ('email' in b) { const e = clean(b.email, 254).toLowerCase(); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) errs.push('Enter a valid email.'); else out.email = e; }
    if ('role' in b) out.role = ROLES.includes(b.role) ? b.role : 'Cleaner';
    for (const k of ['hourly_rate', 'max_week_hours']) if (k in b && b[k] !== '') { const v = Number(b[k]); if (!(v >= 0 && v < 1000)) errs.push(`${k === 'hourly_rate' ? 'Hourly rate' : 'Weekly hour limit'} must be a number.`); else out[k] = v; }
    for (const k of ['day_start', 'day_end']) if (k in b) { if (b[k] && mins(b[k]) == null) errs.push('Times must look like 07:00.'); else out[k] = b[k] || null; }
    if ('work_days' in b) out.work_days = String(b.work_days).split(',').map(Number).filter(n => n >= 1 && n <= 7).join(',');
    if ('active' in b) out.active = b.active ? 1 : 0;
    return { out, errs };
  }
  app.post('/api/admin/employees', auth, (req, res) => {
    const { out, errs } = empValidate(req.body || {}, null); if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    if (out.email && db.prepare('SELECT 1 FROM employees WHERE lower(email)=?').get(out.email)) return res.status(409).json({ error: 'An employee with that email already exists.' });
    const c = Object.keys(out), t = now();
    const id = db.prepare(`INSERT INTO employees(${c.join(',')},token,created_at,updated_at) VALUES(${c.map(() => '?').join(',')},?,?,?)`).run(...c.map(k => out[k]), crypto.randomBytes(18).toString('hex'), t, t).lastInsertRowid;
    logAction(req, 'added', 'employee', id, out.name);
    res.status(201).json({ employee: empPublic(getEmp(id)) });
  });
  app.patch('/api/admin/employees/:id', auth, (req, res) => {
    const e = getEmp(req.params.id); if (!e) return res.status(404).json({ error: 'Employee not found.' });
    const { out, errs } = empValidate(req.body || {}, e); if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    if ((req.body || {}).new_link) out.token = crypto.randomBytes(18).toString('hex');
    const c = Object.keys(out); if (!c.length) return res.json({ ok: true });
    db.prepare(`UPDATE employees SET ${c.map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`).run(...c.map(k => out[k]), now(), e.id);
    logAction(req, out.token ? 'reset crew link for' : 'updated', 'employee', e.id, e.name);
    res.json({ employee: empPublic(getEmp(e.id)) });
  });
  // The crew link is only shown to owners/managers (it grants access to the crew page).
  app.get('/api/admin/employees/:id/link', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only owners and managers can see crew links.' });
    const e = getEmp(req.params.id); if (!e) return res.status(404).json({ error: 'Employee not found.' });
    res.json({ url: `/crew/${e.token}` });
  });
  app.post('/api/admin/employees/:id/timeoff', auth, (req, res) => {
    const e = getEmp(req.params.id); if (!e) return res.status(404).json({ error: 'Employee not found.' });
    const s = clean((req.body || {}).start_date, 10), en = clean(req.body.end_date, 10) || s;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(en) || en < s) return res.status(400).json({ error: 'Enter a valid date range.' });
    const clash = db.prepare("SELECT v.title, v.date FROM visit_crew c JOIN visits v ON v.id=c.visit_id WHERE c.employee_id=? AND v.date BETWEEN ? AND ? AND v.status NOT IN ('Cancelled','Skipped','Done')").all(e.id, s, en);
    const id = db.prepare('INSERT INTO employee_timeoff(employee_id,start_date,end_date,reason,created_by,created_at) VALUES(?,?,?,?,?,?)').run(e.id, s, en, clean(req.body.reason, 200), who(req), now()).lastInsertRowid;
    logAction(req, 'recorded time off', 'employee', e.id, `${e.name}: ${s} to ${en}`);
    res.status(201).json({ id, needs_reassignment: clash });
  });
  app.post('/api/admin/holidays', auth, (req, res) => {
    const d = clean((req.body || {}).date, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Enter a date.' });
    db.prepare('INSERT OR REPLACE INTO company_holidays(date,name) VALUES(?,?)').run(d, clean(req.body.name, 80) || 'Holiday');
    const affected = db.prepare("SELECT id, title FROM visits WHERE date=? AND status IN ('Tentative','Scheduled')").all(d);
    logAction(req, 'added holiday', 'settings', 0, d);
    res.status(201).json({ ok: true, affected });
  });

  // ---------- Crew assignment ----------
  app.get('/api/admin/dispatch/visits/:id/candidates', auth, (req, res) => {
    const v = getVisit(req.params.id); if (!v) return res.status(404).json({ error: 'Job not found.' });
    const need = String(v.equipment || '').toLowerCase();
    const list = db.prepare('SELECT * FROM employees WHERE active=1').all().map(e => {
      const c = check(e, v), skillHit = need && String(e.skills || '').toLowerCase().split(',').some(s => s.trim() && need.includes(s.trim()));
      return { id: e.id, name: e.name, role: e.role, crew: e.crew, skills: e.skills, ...c, assigned: !!db.prepare('SELECT 1 FROM visit_crew WHERE visit_id=? AND employee_id=?').get(v.id, e.id),
        score: (c.block.length ? -100 : 0) - c.warn.length * 10 - c.week_hours + (skillHit ? 15 : 0) + (['Lead', 'Supervisor'].includes(e.role) ? 2 : 0) };
    }).sort((a, b) => b.score - a.score);
    res.json({ candidates: list, recommended: list.filter(x => !x.block.length && !x.assigned).slice(0, Math.max(1, v.crew_needed || v.crew_size || 1)).map(x => x.id),
      basis: 'Ranked by availability, conflicts, time off, weekly hours (lowest first) and skills matching the job equipment. A manager confirms every assignment.' });
  });
  app.post('/api/admin/dispatch/visits/:id/crew', auth, async (req, res) => {
    const v = getVisit(req.params.id); if (!v) return res.status(404).json({ error: 'Job not found.' });
    const b = req.body || {}, e = getEmp(b.employee_id); if (!e) return res.status(400).json({ error: 'Choose an employee.' });
    if (b.remove) { db.prepare('DELETE FROM visit_crew WHERE visit_id=? AND employee_id=?').run(v.id, e.id); logAction(req, 'unassigned', 'visit', v.id, `${e.name} from ${v.title} ${v.date}`); return res.json({ crew: crewOf(v.id) }); }
    const c = check(e, v);
    if (c.block.length) return res.status(409).json({ error: 'Cannot assign: ' + c.block.join('; ') + '.', block: c.block });
    const reason = clean(b.override_reason, 300);
    if (c.warn.some(w => /^overtime/.test(w))) {
      if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: `This creates ${c.warn.find(w => /^overtime/.test(w))}. Only an owner or manager can approve overtime.` });
      if (!reason) return res.status(409).json({ error: `This creates ${c.warn.find(w => /^overtime/.test(w))}. Give a reason to approve the overtime.`, needs_override: true });
    }
    db.prepare('INSERT OR REPLACE INTO visit_crew(visit_id,employee_id,override_reason,assigned_by,assigned_at) VALUES(?,?,?,?,?)').run(v.id, e.id, reason || null, who(req), now());
    db.prepare('UPDATE visits SET assigned_to=?, updated_at=? WHERE id=?').run(crewOf(v.id).map(x => x.name).join(', '), now(), v.id);
    logAction(req, 'assigned', 'visit', v.id, `${e.name} to ${v.title} ${v.date}${reason ? ' (override: ' + reason + ')' : ''}`);
    if (v.dispatched_at && e.email && await notify(e.email, `Job update: ${v.title} ${v.date}`, `You've been added to ${v.title} on ${v.date} ${v.start_time || ''}.\nAddress: ${v.address || ''}\nOpen your schedule: ${process.env.PUBLIC_URL || 'https://brightclean.net'}/crew/${e.token}`))
      db.prepare('UPDATE visit_crew SET notified_at=? WHERE visit_id=? AND employee_id=?').run(now(), v.id, e.id);
    res.json({ crew: crewOf(v.id), warnings: c.warn });
  });
  // Move / skip / dispatch
  app.post('/api/admin/dispatch/visits/:id/move', auth, (req, res) => {
    const v = getVisit(req.params.id); if (!v) return res.status(404).json({ error: 'Job not found.' });
    const b = req.body || {}, d = clean(b.date, 10) || v.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Enter a valid date.' });
    if (db.prepare('SELECT 1 FROM company_holidays WHERE date=?').get(d) && !b.allow_holiday) return res.status(409).json({ error: `${d} is a company holiday. Confirm to schedule anyway.`, holiday: true });
    const nv = { ...v, date: d, start_time: clean(b.start_time, 5) || v.start_time, end_time: clean(b.end_time, 5) || v.end_time };
    const problems = crewOf(v.id).map(x => ({ name: x.name, ...check(getEmp(x.id), nv) })).filter(x => x.block.length);
    if (problems.length && !b.drop_conflicting) return res.status(409).json({ error: 'Crew conflicts at the new time: ' + problems.map(p => p.block.join('; ')).join('; ') + '.', conflicts: problems });
    for (const p of problems) db.prepare('DELETE FROM visit_crew c WHERE visit_id=? AND employee_id=(SELECT id FROM employees WHERE name=?)').run(v.id, p.name);
    db.prepare('UPDATE visits SET date=?, start_time=?, end_time=?, moved_from=COALESCE(moved_from,?), updated_at=? WHERE id=?').run(nv.date, nv.start_time, nv.end_time, `${v.date} ${v.start_time || ''}`, now(), v.id);
    logAction(req, 'rescheduled', 'visit', v.id, `${v.title}: ${v.date} ${v.start_time || ''} → ${nv.date} ${nv.start_time || ''}`);
    res.json({ ok: true, dropped: problems.map(p => p.name) });
  });
  app.post('/api/admin/dispatch/visits/:id/skip', auth, (req, res) => {
    const v = getVisit(req.params.id); if (!v) return res.status(404).json({ error: 'Job not found.' });
    const r = clean((req.body || {}).reason, 300); if (!r) return res.status(400).json({ error: 'Give a reason for skipping this visit.' });
    db.prepare("UPDATE visits SET status='Skipped', skip_reason=?, updated_at=? WHERE id=?").run(r, now(), v.id);
    logAction(req, 'skipped', 'visit', v.id, `${v.title} ${v.date}: ${r}`);
    res.json({ ok: true });
  });
  app.post('/api/admin/dispatch/visits/:id/dispatch', auth, async (req, res) => {
    const v = getVisit(req.params.id); if (!v) return res.status(404).json({ error: 'Job not found.' });
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only an owner or manager can dispatch crews.' });
    const crew = crewOf(v.id); if (!crew.length) return res.status(409).json({ error: 'Assign at least one crew member before dispatching.' });
    if (v.status === 'Tentative') return res.status(409).json({ error: 'This work order is still tentative: the project needs dispatch approval first.' });
    if (v.project_id) { const p = db.prepare('SELECT status, dispatch_approved_by FROM projects WHERE id=?').get(v.project_id); if (p && !p.dispatch_approved_by && p.status === 'Planning') return res.status(409).json({ error: 'The project is still in Planning: approve dispatch on the project first.' }); }
    db.prepare('UPDATE visits SET dispatched_at=?, dispatched_by=?, updated_at=? WHERE id=?').run(now(), who(req), now(), v.id);
    let sent = 0;
    for (const c of crew) { const e = getEmp(c.id); if (e.email && await notify(e.email, `Dispatched: ${v.title} ${v.date}`, `You're scheduled for ${v.title} on ${v.date} ${v.start_time || ''}–${v.end_time || ''}.\nAddress: ${v.address || ''}\nCrew: ${crew.map(x => x.name).join(', ')}\nYour schedule, directions and check-in: ${process.env.PUBLIC_URL || 'https://brightclean.net'}/crew/${e.token}`)) { sent++; db.prepare('UPDATE visit_crew SET notified_at=? WHERE visit_id=? AND employee_id=?').run(now(), v.id, e.id); } }
    logAction(req, 'dispatched', 'visit', v.id, `${v.title} ${v.date}: ${crew.length} crew, ${sent} notified`);
    res.json({ ok: true, notified: sent, crew: crew.length });
  });

  // ---------- Board / dashboard ----------
  app.get('/api/admin/dispatch/board', auth, (req, res) => {
    const d = clean(req.query.date, 10) || today(), ws = weekStart(d), we = addDays(ws, 6);
    const rows = db.prepare(`SELECT v.*, c.company customer_company, c.name customer_name, p.name project_name FROM visits v LEFT JOIN customers c ON c.id=v.customer_id LEFT JOIN projects p ON p.id=v.project_id WHERE v.date BETWEEN ? AND ? ORDER BY v.date, v.start_time`).all(addDays(ws, -7), addDays(we, 35));
    const withCrew = rows.map(v => ({ ...v, crew: crewOf(v.id), checklist: J(v.checklist, []) }));
    const live = x => !['Cancelled', 'Skipped'].includes(x.status);
    const day = withCrew.filter(v => v.date === d && live(v)), week = withCrew.filter(v => v.date >= ws && v.date <= we && live(v));
    const conflicts = [];
    for (const v of week) for (const c of v.crew) { const e = getEmp(c.id); if (e) { const k = check(e, v); if (k.block.length) conflicts.push({ visit_id: v.id, title: v.title, date: v.date, problem: k.block.join('; ') }); } }
    const emps = db.prepare('SELECT * FROM employees WHERE active=1').all(), dow = new Date(d + 'T12:00:00Z').getUTCDay() || 7;
    const avail = emps.filter(e => String(e.work_days || '').split(',').map(Number).includes(dow) && !db.prepare('SELECT 1 FROM employee_timeoff WHERE employee_id=? AND start_date<=? AND end_date>=?').get(e.id, d, d)).length;
    const deadlines = db.prepare("SELECT id, name, due_date, status FROM projects WHERE due_date IS NOT NULL AND due_date<>'' AND due_date>=? AND status NOT IN ('Completed','Archived') ORDER BY due_date LIMIT 8").all(d);
    res.json({ date: d, week_start: ws, visits: withCrew,
      kpis: { today: day.length, week: week.length, dispatched_crews: new Set(day.filter(v => v.dispatched_at).flatMap(v => v.crew.map(c => c.crew || c.name))).size, unassigned: week.filter(v => !v.crew.length && v.status !== 'Done').length,
        available: avail, staff: emps.length, overdue: withCrew.filter(v => v.date < d && ['Scheduled', 'Tentative', 'In progress'].includes(v.status)).length, completed_today: day.filter(v => v.status === 'Done').length,
        in_progress: day.filter(v => v.status === 'In progress').length, conflicts: conflicts.length },
      conflicts, deadlines, holidays: db.prepare('SELECT * FROM company_holidays WHERE date BETWEEN ? AND ?').all(addDays(ws, -7), addDays(we, 35)) });
  });

  // ---------- Time tracking ----------
  function closeEntry(t, out, source) {
    const m = Math.max(0, Math.round((Date.parse(out) - Date.parse(t.clock_in)) / 60000));
    db.prepare('UPDATE time_entries SET clock_out=?, minutes=?, source=COALESCE(source,?) WHERE id=?').run(out, m, source, t.id);
    return m;
  }
  app.get('/api/admin/time', auth, (req, res) => {
    const from = clean(req.query.from, 10) || addDays(today(), -14), to = clean(req.query.to, 10) || today();
    const rows = db.prepare(`SELECT t.*, e.name, e.hourly_rate, v.title visit_title, p.name project_name FROM time_entries t JOIN employees e ON e.id=t.employee_id LEFT JOIN visits v ON v.id=t.visit_id LEFT JOIN projects p ON p.id=t.project_id
      WHERE substr(t.clock_in,1,10) BETWEEN ? AND ? ORDER BY t.clock_in DESC`).all(from, to).map(t => ({ ...t, cost: t.minutes ? Math.round(t.minutes / 60 * (t.hourly_rate || 0) * 100) / 100 : 0 }));
    res.json({ entries: rows, totals: { minutes: rows.reduce((s, t) => s + (t.minutes || 0), 0), cost: Math.round(rows.reduce((s, t) => s + t.cost, 0) * 100) / 100, open: rows.filter(t => !t.clock_out).length, unapproved: rows.filter(t => t.clock_out && !t.approved_by).length } });
  });
  app.post('/api/admin/time', auth, (req, res) => {
    const b = req.body || {}, e = getEmp(b.employee_id); if (!e) return res.status(400).json({ error: 'Choose an employee.' });
    if (isNaN(Date.parse(b.clock_in)) || isNaN(Date.parse(b.clock_out)) || Date.parse(b.clock_out) <= Date.parse(b.clock_in)) return res.status(400).json({ error: 'Enter a start and an end time (end after start).' });
    if ((Date.parse(b.clock_out) - Date.parse(b.clock_in)) > 16 * 3600000) return res.status(400).json({ error: 'A single entry cannot be longer than 16 hours.' });
    const v = b.visit_id ? getVisit(b.visit_id) : null;
    const id = db.prepare('INSERT INTO time_entries(employee_id,visit_id,project_id,clock_in,clock_out,minutes,source,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(e.id, v ? v.id : null, v ? v.project_id : (b.project_id || null), new Date(b.clock_in).toISOString(), new Date(b.clock_out).toISOString(), Math.round((Date.parse(b.clock_out) - Date.parse(b.clock_in)) / 60000), 'manager', clean(b.note, 300), now()).lastInsertRowid;
    logAction(req, 'entered time', 'employee', e.id, `${e.name}: ${b.clock_in} – ${b.clock_out}`);
    res.status(201).json({ id });
  });
  // Approving time posts the labor cost to the project (actual cost, not an estimate).
  app.post('/api/admin/time/:id/approve', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only an owner or manager can approve time.' });
    const t = db.prepare('SELECT t.*, e.name, e.hourly_rate FROM time_entries t JOIN employees e ON e.id=t.employee_id WHERE t.id=?').get(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'Entry not found.' });
    if (!t.clock_out) return res.status(409).json({ error: 'The employee is still clocked in.' });
    if (t.approved_by) return res.status(409).json({ error: 'Already approved.' });
    let costId = null; const cost = Math.round(t.minutes / 60 * (t.hourly_rate || 0) * 100) / 100;
    if (t.project_id && cost > 0) { try { costId = db.prepare("INSERT INTO project_costs(project_id,category,description,amount,cost_date,entered_by,created_at) VALUES(?,'Labor',?,?,?,?,?)").run(t.project_id, `Time: ${t.name} ${(t.minutes / 60).toFixed(2)} h`, cost, t.clock_in.slice(0, 10), who(req), now()).lastInsertRowid; } catch { /* projects module absent */ } }
    db.prepare('UPDATE time_entries SET approved_by=?, approved_at=?, cost_id=? WHERE id=?').run(who(req), now(), costId, t.id);
    logAction(req, 'approved time', 'employee', t.employee_id, `${t.name}: ${(t.minutes / 60).toFixed(2)} h${costId ? `, $${cost} labor posted to project` : ''}`);
    res.json({ ok: true, cost, posted: !!costId });
  });

  // ---------- Crew page (per-employee private link) ----------
  const crewAuth = (req, res) => { const e = db.prepare('SELECT * FROM employees WHERE token=? AND active=1').get(clean(req.params.token, 80)); if (!e) { res.status(404).json({ error: 'This link is not valid. Ask your supervisor for a new one.' }); return null; } return e; };
  const assigned = (e, vid) => db.prepare('SELECT v.* FROM visit_crew c JOIN visits v ON v.id=c.visit_id WHERE c.employee_id=? AND v.id=?').get(e.id, Number(vid));
  app.get('/api/crew/:token', (req, res) => {
    const e = crewAuth(req, res); if (!e) return;
    const d = clean(req.query.date, 10) || today();
    const jobs = db.prepare("SELECT v.* FROM visit_crew c JOIN visits v ON v.id=c.visit_id WHERE c.employee_id=? AND v.date BETWEEN ? AND ? AND v.status NOT IN ('Cancelled','Skipped') AND v.dispatched_at IS NOT NULL ORDER BY v.date, v.start_time").all(e.id, d, addDays(d, 6));
    const open = db.prepare('SELECT * FROM time_entries WHERE employee_id=? AND clock_out IS NULL ORDER BY id DESC').get(e.id);
    res.json({ employee: { name: e.name, role: e.role, crew: e.crew }, date: d, clocked_in: open ? { visit_id: open.visit_id, since: open.clock_in } : null,
      jobs: jobs.map(v => {
        const site = v.project_id ? J((db.prepare('SELECT site_info FROM projects WHERE id=?').get(v.project_id) || {}).site_info, {}) : {};
        // Access details only for crew on today's or tomorrow's jobs; never billing or pricing.
        const near = v.date <= addDays(today(), 1);
        return { id: v.id, title: v.title, date: v.date, start_time: v.start_time, end_time: v.end_time, address: v.address, status: v.status, instructions: v.instructions || '', equipment: v.equipment || '', checklist: J(v.checklist, []),
          crew: crewOf(v.id).map(x => x.name), access: near ? (site.access || '') : 'Shown the day before the job.', site_contact: near ? (site.contact || '') : '', safety: site.safety || '', arrived_at: v.arrived_at, completed_at: v.completed_at };
      }) });
  });
  app.post('/api/crew/:token/jobs/:vid/:action', async (req, res) => {
    const e = crewAuth(req, res); if (!e) return;
    const v = assigned(e, req.params.vid); if (!v) return res.status(404).json({ error: 'This job is not assigned to you.' });
    const a = req.params.action, t = now();
    if (a === 'checkin') {
      if (db.prepare('SELECT 1 FROM time_entries WHERE employee_id=? AND clock_out IS NULL').get(e.id)) return res.status(409).json({ error: 'You are already checked in. Check out of the other job first.' });
      db.prepare('INSERT INTO time_entries(employee_id,visit_id,project_id,clock_in,source,created_at) VALUES(?,?,?,?,?,?)').run(e.id, v.id, v.project_id, t, 'crew', t);
      db.prepare("UPDATE visits SET arrived_at=COALESCE(arrived_at,?), status=CASE WHEN status IN ('Scheduled','Tentative') THEN 'In progress' ELSE status END, updated_at=? WHERE id=?").run(t, t, v.id);
      db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(e.name, 'checked in', 'visit', v.id, v.title, t);
      return res.json({ ok: true });
    }
    if (a === 'checkout') {
      const open = db.prepare('SELECT * FROM time_entries WHERE employee_id=? AND visit_id=? AND clock_out IS NULL').get(e.id, v.id);
      if (!open) return res.status(409).json({ error: 'You are not checked in to this job.' });
      const m = closeEntry(open, t, 'crew');
      db.prepare('UPDATE visits SET departed_at=?, updated_at=? WHERE id=?').run(t, t, v.id);
      db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(e.name, 'checked out', 'visit', v.id, `${v.title}: ${(m / 60).toFixed(2)} h`, t);
      return res.json({ ok: true, minutes: m });
    }
    if (a === 'checklist') {
      const list = J(v.checklist, []), i = Number((req.body || {}).index);
      if (!list[i]) return res.status(400).json({ error: 'Unknown checklist item.' });
      list[i] = { ...list[i], done: !!req.body.done, by: e.name, at: t };
      db.prepare('UPDATE visits SET checklist=?, updated_at=? WHERE id=?').run(JSON.stringify(list), t, v.id);
      return res.json({ checklist: list });
    }
    if (a === 'complete') {
      const list = J(v.checklist, []), left = list.filter(x => !x.done).length;
      if (left) return res.status(409).json({ error: `${left} checklist item(s) are not done yet.` });
      const open = db.prepare('SELECT * FROM time_entries WHERE employee_id=? AND visit_id=? AND clock_out IS NULL').get(e.id, v.id); if (open) closeEntry(open, t, 'crew');
      db.prepare("UPDATE visits SET status='Done', completed_at=?, departed_at=COALESCE(departed_at,?), updated_at=? WHERE id=?").run(t, t, t, v.id);
      db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(e.name, 'completed', 'visit', v.id, v.title, t);
      return res.json({ ok: true });
    }
    if (a === 'incident') {
      const title = clean((req.body || {}).title, 200), desc = clean(req.body.description, 3000);
      if (!title) return res.status(400).json({ error: 'Describe what happened in a few words.' });
      const id = db.prepare("INSERT INTO customer_issues(customer_id,project_id,type,category,title,description,priority,status,source,reported_by,customer_comms,created_by,created_at,updated_at) VALUES(?,?,'incident','Damage / incident',?,?,?,'Open','Employee',?,'Not needed',?,?,?)")
        .run(v.customer_id || null, v.project_id || null, title, `${desc}\n\nReported from job: ${v.title} (${v.date})`, ['Low', 'Normal', 'High', 'Urgent'].includes(req.body.priority) ? req.body.priority : 'High', e.name, 'crew: ' + e.name, t, t).lastInsertRowid;
      db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(e.name, 'reported', 'incident', id, title, t);
      if (adminEmail) await notify(adminEmail, `Incident reported by ${e.name}: ${title}`, `${desc}\nJob: ${v.title} ${v.date}\nOpen: https://brightclean.net/admin/#issues`);
      return res.status(201).json({ id });
    }
    res.status(404).json({ error: 'Unknown action.' });
  });
  // Crew photo upload (before/after): stored as project/visit documents.
  try {
    const multer = require('multer'), path = require('path'), fs = require('fs');
    const dir = uploadDir || path.join(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
    const up = multer({ storage: multer.diskStorage({ destination: (r, f, cb) => { fs.mkdirSync(dir, { recursive: true }); cb(null, dir); }, filename: (r, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + (path.extname(f.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg')) }),
      limits: { fileSize: 12 * 1024 * 1024, files: 6 }, fileFilter: (r, f, cb) => cb(null, /^image\//.test(f.mimetype)) });
    app.post('/api/crew/:token/jobs/:vid/photos', (req, res, next) => { const e = crewAuth(req, res); if (!e) return; const v = assigned(e, req.params.vid); if (!v) return res.status(404).json({ error: 'This job is not assigned to you.' }); req.crewEmp = e; req.crewVisit = v; next(); }, up.array('photos', 6), (req, res) => {
      const files = req.files || []; if (!files.length) return res.status(400).json({ error: 'Choose at least one photo.' });
      const stage = ['Before', 'After', 'Issue'].includes(req.body.stage) ? req.body.stage : 'After', t = now();
      const ids = files.map(f => db.prepare('INSERT INTO documents(project_id,customer_id,title,kind,file_name,file_url,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(req.crewVisit.project_id || null, req.crewVisit.customer_id || null, `${stage} – ${req.crewVisit.title} ${req.crewVisit.date}`, 'Photos', f.originalname, '/api/files/' + path.basename(f.path), f.size, 'crew: ' + req.crewEmp.name, t).lastInsertRowid);
      res.status(201).json({ ids });
    });
  } catch (err) { console.error('crew photo upload disabled:', err.message); }
  app.get('/crew/:token', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'crew.html')));
  app.locals.schedCheck = (empId, visitId) => check(getEmp(empId), getVisit(visitId));
};
