const { COMPANY_NAME } = require('./company');
// Scheduling & Dispatch: employees, skills, time off, crew assignment with conflict and overtime checks,
// dispatch confirmation and notifications, holidays/skips for recurring work, time tracking with labor cost,
// and a private mobile crew page (per-employee secure link) for check-in/out, photos, checklist and incidents.
const crypto = require('crypto');
const jwt = require('jsonwebtoken'), bcrypt = require('bcryptjs');
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
  try { db.exec('ALTER TABLE time_entries ADD COLUMN labor_rate REAL'); } catch { /* exists */ }
  require('./labor').ensureColumns(db);
  const vcols = db.prepare('PRAGMA table_info(visits)').all().map(c => c.name);
  for (const [c, t] of [['dispatched_at', 'TEXT'], ['dispatched_by', 'TEXT'], ['arrived_at', 'TEXT'], ['departed_at', 'TEXT'], ['completed_at', 'TEXT'], ['priority', "TEXT DEFAULT 'Normal'"],
    ['crew_needed', 'INTEGER'], ['instructions', 'TEXT'], ['equipment', 'TEXT'], ['checklist', "TEXT DEFAULT '[]'"], ['skip_reason', 'TEXT'], ['moved_from', 'TEXT'],
    ['review_status', 'TEXT'], ['submitted_at', 'TEXT'], ['review_note', 'TEXT'], ['reviewed_by', 'TEXT'], ['reviewed_at', 'TEXT'], ['tracking_token', 'TEXT'], ['on_my_way_at', 'TEXT'], ['rooms', 'TEXT'], ['customer_requests', 'TEXT'], ['late_alert_at', 'TEXT'], ['arrived_lat', 'REAL'], ['arrived_lng', 'REAL'], ['arrived_accuracy', 'REAL']])
    if (!vcols.includes(c)) db.exec(`ALTER TABLE visits ADD COLUMN ${c} ${t}`);
  // Photos are tied to a job; the column is added at startup so a job with no photos yet can still be checked
  try { if (!db.prepare('PRAGMA table_info(documents)').all().some(c => c.name === 'visit_id')) db.exec('ALTER TABLE documents ADD COLUMN visit_id INTEGER'); } catch { /* documents table created elsewhere */ }
  // Messages between the office and one crew member (optionally about one job)
  db.exec(`CREATE TABLE IF NOT EXISTS visit_breaks(id INTEGER PRIMARY KEY AUTOINCREMENT, visit_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, start_at TEXT NOT NULL, end_at TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS visit_notes(id INTEGER PRIMARY KEY AUTOINCREMENT, visit_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS crew_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, visit_id INTEGER, direction TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, seen_by_office INTEGER DEFAULT 0, seen_by_crew INTEGER DEFAULT 0)`);
  const now = () => new Date().toISOString(), today = () => require('./bizdate').today();
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
    const open = onboardingGate(emp);
    if (open.length) block.push(`${emp.name} needs onboarding first: ${open.slice(0, 3).join('; ')}${open.length > 3 ? ' and more' : ''}`);
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
  // The crew link is a login for that cleaner's clock-in page: only operations roles may see it.
  for (const col of ['pin_hash TEXT', 'pin_set_at TEXT', 'last_login_at TEXT', 'crew_session_v INTEGER DEFAULT 0']) { try { db.exec('ALTER TABLE employees ADD COLUMN ' + col); } catch { /* already there */ } }
  // Device time (when the phone recorded it) and sync time (when the server received it), plus a flag when they were not trusted.
  for (const col of ['device_clock_in TEXT', 'device_clock_out TEXT', 'synced_at TEXT', 'time_flag TEXT']) { try { db.exec('ALTER TABLE time_entries ADD COLUMN ' + col); } catch { /* already there */ } }
  const empPublic = (e, withLink = false) => ({ ...e, token: undefined, pin_hash: undefined, crew_link: withLink && e.token ? `/crew/${e.token}` : null });

  // ---------- Employees ----------
  app.get('/api/admin/employees', auth, (req, res) => {
    const canLink = require('./roles').canRunOperations(roleOf(req));
    const money = require('./roles').seesMoney(roleOf(req));
    const d = clean(req.query.date, 10) || today();
    const list = db.prepare('SELECT * FROM employees ORDER BY active DESC, name').all().map(e => {
      const off = db.prepare('SELECT * FROM employee_timeoff WHERE employee_id=? AND start_date<=? AND end_date>=?').get(e.id, d, d);
      const jobs = db.prepare("SELECT COUNT(*) n FROM visit_crew c JOIN visits v ON v.id=c.visit_id WHERE c.employee_id=? AND v.date=? AND v.status NOT IN ('Cancelled','Skipped')").get(e.id, d).n;
      const ws = weekStart(d), hrs = db.prepare("SELECT v.start_time, v.end_time FROM visit_crew c JOIN visits v ON v.id=c.visit_id WHERE c.employee_id=? AND v.date BETWEEN ? AND ? AND v.status NOT IN ('Cancelled','Skipped')").all(e.id, ws, addDays(ws, 6)).reduce((t, x) => t + visitMins(x), 0) / 60;
      const dow = new Date(d + 'T12:00:00Z').getUTCDay() || 7;
      const pub = { ...empPublic(e, canLink) }; if (!money) for (const k of Object.keys(PAY_DEFAULTS)) delete pub[k];
      return { ...pub, off: off ? off.reason || 'Time off' : null, jobs_on_date: jobs, week_hours: Math.round(hrs * 10) / 10, available: !!e.active && !off && String(e.work_days || '').split(',').map(Number).includes(dow) };
    });
    res.json({ employees: list, roles: ROLES, timeoff: db.prepare('SELECT t.*, e.name FROM employee_timeoff t JOIN employees e ON e.id=t.employee_id WHERE t.end_date>=? ORDER BY t.start_date').all(addDays(d, -30)), holidays: db.prepare('SELECT * FROM company_holidays WHERE date>=? ORDER BY date').all(addDays(d, -30)) });
  });
  try { db.exec('ALTER TABLE employees ADD COLUMN payroll_id TEXT'); } catch { /* already added */ }
  db.exec('CREATE TABLE IF NOT EXISTS crew_actions(client_id TEXT PRIMARY KEY, employee_id INTEGER, action TEXT, visit_id INTEGER, created_at TEXT)');
  function empValidate(b, cur) {
    const out = {}, errs = [];
    if (!cur || 'name' in b) { const n = clean(b.name, 120); if (!n) errs.push('Enter the employee name.'); else out.name = n; }
    for (const k of ['phone', 'crew', 'skills']) if (k in b) out[k] = clean(b[k], 300);
    if ('payroll_id' in b) out.payroll_id = clean(b.payroll_id, 40) || null; // the file number the payroll provider uses for this person
    if ('email' in b) { const e = clean(b.email, 254).toLowerCase(); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) errs.push('Enter a valid email.'); else out.email = e; }
    if ('role' in b) out.role = ROLES.includes(b.role) ? b.role : 'Cleaner';
    for (const k of ['hourly_rate', 'max_week_hours']) if (k in b && b[k] !== '') { const v = Number(b[k]); if (!(v >= 0 && v < 1000)) errs.push(`${k === 'hourly_rate' ? 'Hourly rate' : 'Weekly hour limit'} must be a number.`); else out[k] = v; }
    for (const k of ['day_start', 'day_end']) if (k in b) { if (b[k] && mins(b[k]) == null) errs.push('Times must look like 07:00.'); else out[k] = b[k] || null; }
    if ('work_days' in b) out.work_days = String(b.work_days).split(',').map(Number).filter(n => n >= 1 && n <= 7).join(',');
    if ('active' in b) out.active = b.active ? 1 : 0;
    return { out, errs };
  }
  // Pay and payroll fields: a change to one of them is refused unless the signed-in role may make it.
  const PAY_DEFAULTS = { hourly_rate: 0, max_week_hours: 40, payroll_id: null };
  const PAY_LABEL = { hourly_rate: 'hourly pay rate', max_week_hours: 'weekly hour limit', payroll_id: 'payroll file number' };
  function payRefusal(req, out, cur) {
    const R = require('./roles'), role = roleOf(req);
    for (const k of Object.keys(PAY_DEFAULTS)) {
      if (!(k in out)) continue;
      const was = cur ? cur[k] : PAY_DEFAULTS[k];
      if (String(out[k] ?? '') !== String(was ?? '') && !R.canEditEmployeeField(role, k)) {
        return `Only an ${R.PAY_FIELD_ROLES[k].join(' or ')} can change the ${PAY_LABEL[k]}.`;
      }
    }
    return null;
  }
  app.post('/api/admin/employees', auth, (req, res) => {
    const { out, errs } = empValidate(req.body || {}, null); if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const refused = payRefusal(req, out, null); if (refused) return res.status(403).json({ error: refused });
    if (out.email && db.prepare('SELECT 1 FROM employees WHERE lower(email)=?').get(out.email)) return res.status(409).json({ error: 'An employee with that email already exists.' });
    const c = Object.keys(out), t = now();
    const id = db.prepare(`INSERT INTO employees(${c.join(',')},token,created_at,updated_at) VALUES(${c.map(() => '?').join(',')},?,?,?)`).run(...c.map(k => out[k]), crypto.randomBytes(18).toString('hex'), t, t).lastInsertRowid;
    logAction(req, 'added', 'employee', id, out.name);
    res.status(201).json({ employee: empPublic(getEmp(id)) });
  });
  app.patch('/api/admin/employees/:id', auth, (req, res) => {
    const e = getEmp(req.params.id); if (!e) return res.status(404).json({ error: 'Employee not found.' });
    const { out, errs } = empValidate(req.body || {}, e); if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    // Crew access (a new link, or taking someone off the crew) is for operations managers only.
    if (((req.body || {}).new_link || 'active' in out) && !require('./roles').canRunOperations(roleOf(req))) return res.status(403).json({ error: 'Only an operations manager can change crew access.' });
    const refused = payRefusal(req, out, e); if (refused) return res.status(403).json({ error: refused });
    if ((req.body || {}).new_link) out.token = crypto.randomBytes(18).toString('hex');
    // A new link, or taking the person off the crew, ends their signed-in crew sessions.
    if (out.token || ('active' in out && !out.active)) out.crew_session_v = (e.crew_session_v || 0) + 1;
    const c = Object.keys(out); if (!c.length) return res.json({ ok: true });
    db.prepare(`UPDATE employees SET ${c.map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`).run(...c.map(k => out[k]), now(), e.id);
    const payChanged = Object.keys(PAY_DEFAULTS).filter(k => k in out && String(out[k] ?? '') !== String(e[k] ?? ''));
    logAction(req, out.token ? 'reset crew link for' : 'updated', 'employee', e.id, e.name + (payChanged.length ? ` (changed: ${payChanged.map(k => PAY_LABEL[k] + ' ' + (e[k] ?? '–') + ' → ' + (out[k] ?? '–')).join('; ')})` : ''));
    res.json({ employee: empPublic(getEmp(e.id)) });
  });
  // The crew link is only shown to owners/managers (it grants access to the crew page).
  app.get('/api/admin/employees/:id/link', auth, (req, res) => {
    if (!require('./roles').canRunOperations(roleOf(req))) return res.status(403).json({ error: 'Only owners, managers and supervisors can see crew links.' });
    const e = getEmp(req.params.id); if (!e) return res.status(404).json({ error: 'Employee not found.' });
    res.json({ url: `/crew/${e.token}` });
  });
  // ---------- Onboarding checklist ----------
  // Each item is a fact an office person confirms (paperwork on file, training done). The checklist tracks progress; it does not block dispatch.
  const ONBOARD = [
    ['contact', 'Contact details and emergency contact on file'],
    ['eligibility', 'Work eligibility form on file'],
    ['tax', 'Tax withholding form on file'],
    ['background', 'Background check completed (optional: only where your policy requires it; does not block dispatch)'],
    ['safety', 'Safety orientation and site rules'],
    ['chemicals', 'Chemical and SDS training'],
    ['equipment', 'Equipment and uniform issued'],
    ['crewlink', 'Crew page link sent and tested on their phone'],
  ];
  db.exec('CREATE TABLE IF NOT EXISTS employee_onboarding(employee_id INTEGER NOT NULL, item_key TEXT NOT NULL, done_at TEXT NOT NULL, done_by TEXT, PRIMARY KEY(employee_id, item_key))');
  const onboardingOf = empId => {
    const done = new Map(db.prepare('SELECT item_key, done_at, done_by FROM employee_onboarding WHERE employee_id=?').all(empId).map(r => [r.item_key, r]));
    const e = getEmp(empId);
    const items = ONBOARD.map(([key, label]) => ({ key, label, done: done.has(key), done_at: done.has(key) ? done.get(key).done_at : null, done_by: done.has(key) ? done.get(key).done_by : null }));
    // The payroll file number is recorded on the employee record, so it counts as done when it is set.
    items.push({ key: 'payroll', label: 'Payroll file number set (ADP)', done: !!(e && e.payroll_id), auto: true, done_at: null, done_by: null });
    return { items, done: items.filter(i => i.done).length, total: items.length, ready: items.filter(i => i.key !== 'background').every(i => i.done) };
  };
  // Dispatch gate: required items must be done before an employee can be assigned to a job. The background check is optional.
  // It applies to employees added on or after ONBOARD_FROM, and to anyone whose checklist has been started.
  // Employees already on the team before that date are not blocked until someone starts their checklist.
  // The cutoff can be moved for test servers only (ONBOARD_FROM); production uses the owner's date.
  const ONBOARD_FROM = process.env.ONBOARD_FROM || '2026-11-16T00:00:00.000Z';
  const onboardingGate = emp => {
    const started = db.prepare('SELECT 1 FROM employee_onboarding WHERE employee_id=? LIMIT 1').get(emp.id);
    if (!(String(emp.created_at || '') >= ONBOARD_FROM || started)) return [];
    return onboardingOf(emp.id).items.filter(i => i.key !== 'background' && !i.done).map(i => i.label);
  };
  app.get('/api/admin/employees/:id/onboarding', auth, (req, res) => {
    if (!require('./roles').canRunOperations(roleOf(req))) return res.status(403).json({ error: 'Only owners, managers and supervisors can see onboarding.' });
    const e = getEmp(req.params.id); if (!e) return res.status(404).json({ error: 'Employee not found.' });
    res.json({ employee: { id: e.id, name: e.name }, ...onboardingOf(e.id) });
  });
  app.post('/api/admin/employees/:id/onboarding/:key', auth, (req, res) => {
    if (!require('./roles').canRunOperations(roleOf(req))) return res.status(403).json({ error: 'Only owners, managers and supervisors can change onboarding.' });
    const e = getEmp(req.params.id); if (!e) return res.status(404).json({ error: 'Employee not found.' });
    const key = String(req.params.key || '');
    if (!ONBOARD.some(([k]) => k === key)) return res.status(400).json({ error: 'Unknown onboarding item.' });
    const done = !!(req.body || {}).done;
    if (done) db.prepare('INSERT OR REPLACE INTO employee_onboarding(employee_id,item_key,done_at,done_by) VALUES(?,?,?,?)').run(e.id, key, now(), who(req));
    else db.prepare('DELETE FROM employee_onboarding WHERE employee_id=? AND item_key=?').run(e.id, key);
    logAction(req, done ? 'onboarding done' : 'onboarding reopened', 'employee', e.id, `${e.name}: ${key}`);
    res.json(onboardingOf(e.id));
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
    if (b.remove) {
      db.prepare('DELETE FROM visit_crew WHERE visit_id=? AND employee_id=?').run(v.id, e.id);
      logAction(req, 'unassigned', 'visit', v.id, `${e.name} from ${v.title} ${v.date}`);
      // Someone already sent the job should hear that it is off their list, not find it gone
      if (v.dispatched_at) await reachCrew(e, `Removed from job: ${v.title} ${v.date}`, `You've been taken off ${v.title} on ${v.date} ${v.start_time || ''}. Please don't go unless the office confirms.\nSign in any time to see your jobs: ${SIGNIN_URL}`, `Bright Clean: you've been taken off ${v.title} ${v.date}. Sign in any time to see your jobs: ${SIGNIN_URL}`);
      return res.json({ crew: crewOf(v.id) });
    }
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
    if (v.dispatched_at) { const how = await reachCrew(e, `Job update: ${v.title} ${v.date}`, `You've been added to ${v.title} on ${v.date} ${v.start_time || ''}.\nAddress: ${v.address || ''}\nYour job: ${process.env.PUBLIC_URL || 'https://brightclean.net'}/crew/${e.token}\nSign in any time: ${SIGNIN_URL}`, `Bright Clean: you've been added to ${v.title} ${v.date}. Your job: ${process.env.PUBLIC_URL || 'https://brightclean.net'}/crew/${e.token} Sign in any time: ${SIGNIN_URL}`); if (how) db.prepare('UPDATE visit_crew SET notified_at=? WHERE visit_id=? AND employee_id=?').run(now(), v.id, e.id); }
    res.json({ crew: crewOf(v.id), warnings: c.warn });
  });
  // Reaches a crew member: email first, then text if they have no email. Returns how, or null.
  const reachCrew = async (e, subject, text, smsText) => {
    if (e.email && await notify(e.email, subject, text)) return 'email';
    if (e.phone && app.locals.smsReady && app.locals.smsReady() && app.locals.sendSms) { try { await app.locals.sendSms(e.phone, smsText); return 'text'; } catch (err) { console.error('crew text failed:', err.message); } }
    return null;
  };
  const SIGNIN_URL = (process.env.PUBLIC_URL || 'https://brightclean.net') + '/crew';
  // Move / skip / dispatch
  app.post('/api/admin/dispatch/visits/:id/move', auth, (req, res) => {
    const v = getVisit(req.params.id); if (!v) return res.status(404).json({ error: 'Job not found.' });
    const b = req.body || {}, d = clean(b.date, 10) || v.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Enter a valid date.' });
    if (db.prepare('SELECT 1 FROM company_holidays WHERE date=?').get(d) && !b.allow_holiday) return res.status(409).json({ error: `${d} is a company holiday. Confirm to schedule anyway.`, holiday: true });
    const nv = { ...v, date: d, start_time: clean(b.start_time, 5) || v.start_time, end_time: clean(b.end_time, 5) || v.end_time };
    const problems = crewOf(v.id).map(x => ({ id: x.id, name: x.name, ...check(getEmp(x.id), nv) })).filter(x => x.block.length);
    if (problems.length && !b.drop_conflicting) return res.status(409).json({ error: 'Crew conflicts at the new time: ' + problems.map(p => p.block.join('; ')).join('; ') + '.', conflicts: problems });
    for (const p of problems) db.prepare('DELETE FROM visit_crew WHERE visit_id=? AND employee_id=?').run(v.id, p.id);
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
    if (!require('./roles').canRunOperations(roleOf(req))) return res.status(403).json({ error: 'Only an owner, manager or supervisor can dispatch crews.' });
    const crew = crewOf(v.id); if (!crew.length) return res.status(409).json({ error: 'Assign at least one crew member before dispatching.' });
    if (v.status === 'Tentative') return res.status(409).json({ error: 'This work order is still tentative: the project needs dispatch approval first.' });
    if (v.project_id) { const p = db.prepare('SELECT status, dispatch_approved_by FROM projects WHERE id=?').get(v.project_id); if (p && !p.dispatch_approved_by && p.status === 'Planning') return res.status(409).json({ error: 'The project is still in Planning: approve dispatch on the project first.' }); }
    // Assignments are checked when made; time off or a new clash added since then must stop the dispatch, not just show on the board.
    const clashes = crew.map(c => ({ name: c.name, ...check(getEmp(c.id), v) })).filter(x => x.block.length);
    if (clashes.length) return res.status(409).json({ error: 'Cannot dispatch: ' + clashes.map(p => `${p.name}: ${p.block.join('; ')}`).join(' | ') + '. Remove or replace that crew member first.', conflicts: clashes });
    db.prepare('UPDATE visits SET dispatched_at=?, dispatched_by=?, updated_at=? WHERE id=?').run(now(), who(req), now(), v.id);
    let sent = 0;
    const notReached = [];
    for (const c of crew) {
      const e = getEmp(c.id);
      const how = await reachCrew(e, `Dispatched: ${v.title} ${v.date}`, `You're scheduled for ${v.title} on ${v.date} ${v.start_time || ''}–${v.end_time || ''}.\nAddress: ${v.address || ''}\nCrew: ${crew.map(x => x.name).join(', ')}\nYour job, directions and check-in: ${process.env.PUBLIC_URL || 'https://brightclean.net'}/crew/${e.token}\nSign in any time to see your jobs: ${SIGNIN_URL} (phone or email and your PIN).`, `Bright Clean: you're scheduled ${v.title} ${v.date} ${v.start_time || ''}. Your job: ${(process.env.PUBLIC_URL || 'https://brightclean.net')}/crew/${e.token} Sign in any time: ${SIGNIN_URL}`);
      if (how) sent++; else notReached.push(e.name);
    }
    await clientNote(v, `Scheduled: ${v.title} ${v.date}`, `Your job is scheduled for ${v.date}${v.start_time ? ' at ' + v.start_time : ''}. Crew on the job: ${crew.length}.`);
    logAction(req, 'dispatched', 'visit', v.id, `${v.title} ${v.date}: ${crew.length} crew, ${sent} notified`);
    res.json({ ok: true, notified: sent, crew: crew.length, not_reached: notReached });
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'Dates must look like 2026-11-14.' });
    // A clock-in belongs to the business day it happens on (Central time), not the UTC day: an evening shift must not move to tomorrow.
    const [winStart, winEnd] = require('./bizdate').window(from, to);
    const rows = db.prepare(`SELECT t.*, e.name, COALESCE(t.labor_rate, e.hourly_rate) AS hourly_rate, v.title visit_title, p.name project_name FROM time_entries t JOIN employees e ON e.id=t.employee_id LEFT JOIN visits v ON v.id=t.visit_id LEFT JOIN projects p ON p.id=t.project_id
      WHERE t.clock_in >= ? AND t.clock_in < ? ORDER BY t.clock_in DESC`).all(winStart, winEnd).map(t => ({ ...t, cost: Math.round(require('./labor').storedCost(t) * 100) / 100 }));
    res.json({ entries: rows, totals: { minutes: rows.reduce((s, t) => s + (t.minutes || 0), 0), cost: Math.round(rows.reduce((s, t) => s + t.cost, 0) * 100) / 100, open: rows.filter(t => !t.clock_out).length, unapproved: rows.filter(t => t.clock_out && !t.approved_by).length } });
  });
  app.post('/api/admin/time', auth, (req, res) => {
    const b = req.body || {}, e = getEmp(b.employee_id); if (!e) return res.status(400).json({ error: 'Choose an employee.' });
    if (isNaN(Date.parse(b.clock_in)) || isNaN(Date.parse(b.clock_out)) || Date.parse(b.clock_out) <= Date.parse(b.clock_in)) return res.status(400).json({ error: 'Enter a start and an end time (end after start).' });
    if ((Date.parse(b.clock_out) - Date.parse(b.clock_in)) > 16 * 3600000) return res.status(400).json({ error: 'A single entry cannot be longer than 16 hours.' });
    // One person cannot be on two entries at once: an entry that overlaps an existing one (or a running clock) is refused.
    { const sIso = new Date(b.clock_in).toISOString(), eIso = new Date(b.clock_out).toISOString();
      const clash = db.prepare('SELECT id, clock_in, clock_out FROM time_entries WHERE employee_id=? AND clock_in < ? AND (clock_out IS NULL OR clock_out > ?) LIMIT 1').get(e.id, eIso, sIso);
      if (clash) return res.status(409).json({ error: `${e.name} already has time from ${clash.clock_in.slice(0, 16).replace('T', ' ')}${clash.clock_out ? ' to ' + clash.clock_out.slice(0, 16).replace('T', ' ') : ' (still clocked in)'}. Change the times so they do not overlap.` }); }
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
    let costId = null; const lc = require('./labor').costOf(db, { id: t.id, employee_id: t.employee_id, clock_in: t.clock_in, minutes: t.minutes, rate: t.hourly_rate }); const cost = lc.cost;
    // The cost is dated on the business day of the shift (company time zone), not the UTC day.
    if (t.project_id && cost > 0) { try { costId = db.prepare("INSERT INTO project_costs(project_id,category,description,amount,cost_date,entered_by,created_at) VALUES(?,'Labor',?,?,?,?,?)").run(t.project_id, `Time: ${t.name} ${(t.minutes / 60).toFixed(2)} h`, cost, require('./bizdate').today(new Date(t.clock_in)), who(req), now()).lastInsertRowid; } catch { /* projects module absent */ } }
    try { db.exec('ALTER TABLE time_entries ADD COLUMN labor_rate REAL'); } catch { /* column already exists */ }
    db.prepare('UPDATE time_entries SET approved_by=?, approved_at=?, cost_id=?, labor_rate=?, labor_cost=?, overtime_minutes=? WHERE id=?').run(who(req), now(), costId, Number(t.hourly_rate) || 0, cost, lc.overtime_minutes, t.id);
    logAction(req, 'approved time', 'employee', t.employee_id, `${t.name}: ${(t.minutes / 60).toFixed(2)} h${costId ? `, $${cost} labor posted to project` : ''}`);
    res.json({ ok: true, cost, posted: !!costId });
  });

  // ---------- Crew page (per-employee private link) ----------
  const crewAuth = (req, res) => {
    // A personal link (/crew/<token>) or a signed-in crew session (token 'me').
    const isMe = !req.params.token || req.params.token === 'me';
    const e = isMe ? crewBearer(req) : db.prepare('SELECT * FROM employees WHERE token=? AND active=1').get(clean(req.params.token, 80));
    if (!e) { res.status(isMe ? 401 : 404).json({ error: isMe ? 'Sign in to see your jobs.' : 'This link is not valid. Ask your supervisor for a new one.' }); return null; }
    return e;
  };
  const assigned = (e, vid) => db.prepare('SELECT v.* FROM visit_crew c JOIN visits v ON v.id=c.visit_id WHERE c.employee_id=? AND v.id=?').get(e.id, Number(vid));
  const crewGet = (req, res) => {
    const e = crewAuth(req, res); if (!e) return;
    const d = clean(req.query.date, 10) || today();
    const jobs = db.prepare("SELECT v.* FROM visit_crew c JOIN visits v ON v.id=c.visit_id WHERE c.employee_id=? AND (v.date BETWEEN ? AND ? OR v.id IN (SELECT visit_id FROM time_entries WHERE employee_id=? AND clock_out IS NULL)) AND v.status NOT IN ('Cancelled','Skipped','Tentative') ORDER BY v.date, v.start_time").all(e.id, d, addDays(d, 30), e.id);
    const open = db.prepare('SELECT * FROM time_entries WHERE employee_id=? AND clock_out IS NULL ORDER BY id DESC').get(e.id);
    res.json({ employee: { name: e.name, role: e.role, crew: e.crew }, date: d, clocked_in: open ? { visit_id: open.visit_id, since: open.clock_in } : null,
      jobs: jobs.map(v => {
        const site = v.project_id ? J((db.prepare('SELECT site_info FROM projects WHERE id=?').get(v.project_id) || {}).site_info, {}) : {};
        // Access details only for crew on today's or tomorrow's jobs; never billing or pricing.
        const near = v.date <= addDays(today(), 1);
        return { id: v.id, dispatched: !!v.dispatched_at, review_status: v.review_status || null, review_note: v.review_note || null, on_my_way_at: v.on_my_way_at || null, ...siteTime(v, e.id), on_break: !!db.prepare('SELECT 1 FROM visit_breaks WHERE visit_id=? AND employee_id=? AND end_at IS NULL').get(v.id, e.id), notes: db.prepare('SELECT id, body, created_at FROM visit_notes WHERE visit_id=? ORDER BY id DESC LIMIT 10').all(v.id).reverse(), title: v.title, date: v.date, start_time: v.start_time, end_time: v.end_time, address: v.address, status: v.status, instructions: v.instructions || '', equipment: v.equipment || '', rooms: v.rooms || '', customer_requests: v.customer_requests || '', checklist: J(v.checklist, []),
          crew: crewOf(v.id).map(x => x.name), access: near ? (site.access || '') : 'Shown the day before the job.', site_contact: near ? (site.contact || '') : '', safety: site.safety || '', arrived_at: v.arrived_at, completed_at: v.completed_at };
      }) });
  };
  app.get('/api/crew/:token', crewGet);
  app.get('/api/crew/me', crewGet);
  // ---- Crew sign-in: phone or email plus a PIN, so crew can see their jobs at any time, not only through the link ----
  const crewSecret = () => (process.env.JWT_SECRET || 'bright-clean-dev') + ':crew';
  const crewCookie = req => { const m = /(?:^|;\s*)bc_crew=([^;]*)/.exec(String(req.headers.cookie || '')); if (!m) return ''; try { return decodeURIComponent(m[1]); } catch { return ''; } };
  const crewBearer = req => {
    const h = String(req.headers.authorization || '').replace(/^Bearer /, '') || crewCookie(req);
    if (!h) return null;
    let p; try { p = jwt.verify(h, crewSecret()); } catch { return null; }
    if (!p || p.kind !== 'crew') return null;
    const e = db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(p.emp);
    // A session is good only while it matches the employee's current session version (bumped on PIN reset, link reset or deactivation).
    if (!e || typeof p.v !== 'number' || p.v !== (e.crew_session_v || 0)) return null;
    return e;
  };
  // Failed PIN tries are counted per employee (or per normalized login when no employee matches), so
  // writing the phone number another way does not reset the count. Five failures lock for 15 minutes.
  // Kept in the database, so a restart or a second process cannot reset a lock.
  db.exec('CREATE TABLE IF NOT EXISTS crew_login_fails(key TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, until_ms INTEGER NOT NULL DEFAULT 0)');
  const failGet = key => db.prepare('SELECT n, until_ms AS until FROM crew_login_fails WHERE key=?').get(key) || { n: 0, until: 0 };
  const failSet = (key, n, until) => db.prepare('INSERT INTO crew_login_fails(key,n,until_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET n=excluded.n, until_ms=excluded.until_ms').run(key, n, until);
  const failClear = key => db.prepare('DELETE FROM crew_login_fails WHERE key=?').run(key);
  const LOCK_TRIES = 5, LOCK_MS = 15 * 60000;
  const CREW_SESSION = (Number(process.env.CREW_SESSION_DAYS) || 7) + 'd';
  app.post('/api/crew/login', (req, res) => {
    const raw = clean((req.body || {}).login, 120).toLowerCase(), pin = String((req.body || {}).pin || '').trim();
    let e = null;
    if (raw.includes('@')) e = db.prepare('SELECT * FROM employees WHERE lower(email)=? AND active=1').get(raw);
    else { const d = raw.replace(/\D/g, '').slice(-10); if (d.length === 10) e = db.prepare("SELECT * FROM employees WHERE active=1 AND substr(replace(replace(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''),'.',''),'+',''),-10)=? ORDER BY id LIMIT 1").get(d) || null; }
    const key = e ? 'emp:' + e.id : 'login:' + (raw.includes('@') ? raw : raw.replace(/\D/g, '').slice(-10));
    const f = failGet(key);
    if (f.until > Date.now()) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes, then try again.' });
    if (!e || !e.pin_hash || !pin || !bcrypt.compareSync(pin, e.pin_hash)) {
      const n = f.n + 1;
      failSet(key, n, n >= LOCK_TRIES ? Date.now() + LOCK_MS : 0);
      return res.status(401).json({ error: 'That phone or email and PIN do not match. Ask your supervisor if you need a PIN.' });
    }
    failClear(key);
    db.prepare('UPDATE employees SET last_login_at=? WHERE id=?').run(now(), e.id);
    const sess = jwt.sign({ kind: 'crew', emp: e.id, v: e.crew_session_v || 0 }, crewSecret(), { expiresIn: CREW_SESSION });
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
    res.append('Set-Cookie', `bc_crew=${encodeURIComponent(sess)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${(Number(process.env.CREW_SESSION_DAYS) || 7) * 86400}${secure ? '; Secure' : ''}`);
    res.json({ ok: true, employee: { name: e.name } });
  });
  // Signing out clears the sign-in cookie on this phone.
  app.post('/api/crew/logout', (req, res) => { res.append('Set-Cookie', 'bc_crew=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); res.json({ ok: true }); });
  // Owner or manager sets (or resets) a crew member's PIN. The PIN itself is never shown again.
  // A reset ends every signed-in crew session for that person.
  app.post('/api/admin/employees/:id/crew-pin', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only an owner or manager can set crew PINs.' });
    const e = getEmp(req.params.id); if (!e) return res.status(404).json({ error: 'Employee not found.' });
    const pin = String((req.body || {}).pin || '').trim();
    if (!/^\d{6,8}$/.test(pin)) return res.status(400).json({ error: 'The PIN is 6 to 8 digits.' });
    db.prepare('UPDATE employees SET pin_hash=?, pin_set_at=?, crew_session_v=COALESCE(crew_session_v,0)+1 WHERE id=?').run(bcrypt.hashSync(pin, 10), now(), e.id);
    logAction(req, 'set crew PIN', 'employee', e.id, e.name);
    res.json({ ok: true, login: e.phone || e.email || '' });
  });
  // Device time for an offline action: trusted when it is no more than 24 hours old and at most 5 minutes ahead of the server.
  const DEVICE_MAX_AGE_MS = 24 * 3600000, DEVICE_SKEW_MS = 5 * 60000;
  function actionTime(raw, serverIso) {
    if (raw == null || raw === '') return { at: serverIso, device: null, flag: null };
    const d = Date.parse(raw), s = Date.parse(serverIso);
    if (isNaN(d)) return { at: serverIso, device: null, flag: 'unreadable device time; server time used' };
    const device = new Date(d).toISOString();
    if (d > s + DEVICE_SKEW_MS || d < s - DEVICE_MAX_AGE_MS) return { at: serverIso, device, flag: 'device time outside the 24 h window; server time used' };
    return { at: device, device, flag: null };
  }
  const crewAction = async (req, res, next) => {
    if (req.params.action === 'photos') return next(); // photo uploads have their own route below (was unreachable: D-22)
    const e = crewAuth(req, res); if (!e) return;
    const v = assigned(e, req.params.vid); if (!v) return res.status(404).json({ error: 'This job is not assigned to you.' });
    const a = req.params.action, t = now();
    // Offline changes carry a client_id. A repeat of an action that already went through is answered, not applied again.
    const cid = clean((req.body || {}).client_id, 80);
    if (cid) {
      if (db.prepare('SELECT 1 FROM crew_actions WHERE client_id=?').get(cid)) return res.json({ ok: true, duplicate: true });
      const sendOnce = res.json.bind(res);
      res.json = body => { if (res.statusCode < 300) { try { db.prepare('INSERT OR IGNORE INTO crew_actions(client_id,employee_id,action,visit_id,created_at) VALUES(?,?,?,?,?)').run(cid, e.id, a, v.id, t); } catch { /* recorded best effort */ } } return sendOnce(body); };
    }
    // Closed jobs take no more field actions. An incident is still accepted, so a safety report is never refused.
    if (['Cancelled', 'Skipped', 'Done'].includes(v.status) && a !== 'incident') {
      const why = v.status === 'Done' ? 'already complete' : v.status === 'Skipped' ? 'skipped' : 'cancelled';
      return res.status(409).json({ error: `This job is ${why}, so nothing more can be recorded on it. Ask the office if you think this is wrong.` });
    }
    // Offline actions carry the time the phone recorded. That time is the action time when it is within a day of the
    // server clock and not in the future; otherwise the server time is used. Both are kept (device and sync time).
    const ev = actionTime(req.body && req.body.device_at, t), et = ev.at;
    // Closes an open time entry at the action time, never before its check-in.
    const closeAt = entry => {
      const early = Date.parse(et) < Date.parse(entry.clock_in);
      const when = early ? t : et, flag = early ? 'device time before check-in; server time used' : ev.flag;
      const m = closeEntry(entry, when, 'crew');
      db.prepare('UPDATE time_entries SET device_clock_out=?, synced_at=?, time_flag=COALESCE(?, time_flag) WHERE id=?').run(ev.device, t, flag, entry.id);
      return { m, when };
    };
    if (a === 'checkin') {
      if (['Tentative', 'Cancelled', 'Skipped'].includes(v.status)) return res.status(409).json({ error: v.status === 'Tentative' ? 'This job is still tentative. Dispatch has to confirm it before you check in.' : `This job is ${v.status.toLowerCase()}. Check in is not available.` });
      if (db.prepare('SELECT 1 FROM time_entries WHERE employee_id=? AND clock_out IS NULL').get(e.id)) return res.status(409).json({ error: 'You are already checked in. Check out of the other job first.' });
      db.prepare('INSERT INTO time_entries(employee_id,visit_id,project_id,clock_in,source,created_at,device_clock_in,synced_at,time_flag) VALUES(?,?,?,?,?,?,?,?,?)').run(e.id, v.id, v.project_id, et, 'crew', t, ev.device, t, ev.flag);
      db.prepare("UPDATE visits SET arrived_at=COALESCE(arrived_at,?), status=CASE WHEN status IN ('Scheduled','Tentative') THEN 'In progress' ELSE status END, updated_at=? WHERE id=?").run(et, t, v.id);
      db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(e.name, 'checked in', 'visit', v.id, v.title + (ev.flag ? ` (${ev.flag})` : ''), t);
      if (!v.arrived_at) await clientNote(v, `${v.title}: crew arrived`, 'The crew has arrived and started the job.');
      // Where the phone was at check-in (only if the crew allowed location). Recorded, not checked against the address.
      if (!v.arrived_at && Number.isFinite(Number(req.body.lat)) && Number.isFinite(Number(req.body.lng))) db.prepare('UPDATE visits SET arrived_lat=?, arrived_lng=?, arrived_accuracy=? WHERE id=?').run(Number(req.body.lat), Number(req.body.lng), Number(req.body.accuracy) || null, v.id);
      return res.json({ ok: true });
    }
    if (a === 'checkout') {
      const open = db.prepare('SELECT * FROM time_entries WHERE employee_id=? AND visit_id=? AND clock_out IS NULL').get(e.id, v.id);
      if (!open) return res.status(409).json({ error: 'You are not checked in to this job.' });
      const { m, when } = closeAt(open);
      db.prepare('UPDATE visits SET departed_at=?, updated_at=? WHERE id=?').run(when, t, v.id);
      // A break still running at check-out ends now, so it does not count past the time on site.
      db.prepare('UPDATE visit_breaks SET end_at=? WHERE visit_id=? AND employee_id=? AND end_at IS NULL').run(when, v.id, e.id);
      db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(e.name, 'checked out', 'visit', v.id, `${v.title}: ${(m / 60).toFixed(2)} h${ev.flag ? ` (${ev.flag})` : ''}`, t);
      return res.json({ ok: true, minutes: m });
    }
    if (a === 'checklist') {
      const list = J(v.checklist, []), i = Number((req.body || {}).index);
      if (!list[i]) return res.status(400).json({ error: 'Unknown checklist item.' });
      list[i] = { ...list[i], done: !!req.body.done, by: e.name, at: et };
      db.prepare('UPDATE visits SET checklist=?, updated_at=? WHERE id=?').run(JSON.stringify(list), t, v.id);
      return res.json({ checklist: list });
    }
    if (a === 'submit') {
      // Sending the job to the office: every checklist item done, and the evidence on file (before and after photos)
      const list = J(v.checklist, []), left = list.filter(x => !x.done).length;
      if (left) return res.status(409).json({ error: `${left} checklist item(s) are not done yet.` });
      try { if (!db.prepare('PRAGMA table_info(documents)').all().some(c => c.name === 'visit_id')) db.exec('ALTER TABLE documents ADD COLUMN visit_id INTEGER'); } catch { /* column added with the first photo */ }
      const titles = db.prepare("SELECT title FROM documents WHERE visit_id=? AND kind='Photos'").all(v.id).map(x => x.title || '');
      if (!titles.some(x => /^Before –/.test(x))) return res.status(409).json({ error: 'Add at least one BEFORE photo before submitting.' });
      if (!titles.some(x => /^After –/.test(x))) return res.status(409).json({ error: 'Add at least one AFTER photo before submitting.' });
      db.prepare("UPDATE visits SET review_status='Submitted', submitted_at=?, review_note=NULL, updated_at=? WHERE id=?").run(t, t, v.id);
      db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(e.name, 'submitted for review', 'visit', v.id, v.title, t);
      if (adminEmail) await notify(adminEmail, `Job ready for review: ${v.title}`, `${e.name} submitted ${v.title} (${v.date}) for review.\nOpen: https://brightclean.net/admin/#schedule`);
      return res.json({ ok: true, review_status: 'Submitted' });
    }
    if (a === 'complete') {
      const list = J(v.checklist, []), left = list.filter(x => !x.done).length;
      if (left) return res.status(409).json({ error: `${left} checklist item(s) are not done yet.` });
      if (v.type === 'Corrective work') { let n = 0; try { n = db.prepare("SELECT COUNT(*) n FROM documents WHERE visit_id=? AND kind='Photos' AND title LIKE 'After –%'").get(v.id).n; } catch { n = 0; } if (!n) return res.status(409).json({ error: 'Take at least one AFTER photo of the corrected area before completing this job.' }); }
      if (v.review_status !== 'Approved') return res.status(409).json({ error: v.review_status === 'Submitted' ? 'Waiting for the office to approve this job.' : 'Submit the job for review before completing it.' });
      const open = db.prepare('SELECT * FROM time_entries WHERE employee_id=? AND visit_id=? AND clock_out IS NULL').get(e.id, v.id);
      const doneAt = open ? closeAt(open).when : et;
      db.prepare("UPDATE visits SET status='Done', completed_at=?, departed_at=COALESCE(departed_at,?), updated_at=? WHERE id=?").run(doneAt, doneAt, t, v.id);
      db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(e.name, 'completed', 'visit', v.id, v.title, t);
      await clientNote(v, `${v.title}: complete`, 'The job is complete. Photos and the completion record are on your tracking page.');
      try { if (app.locals.onVisitDone) app.locals.onVisitDone(v.id, e.name); } catch (err) { console.error('visit done hook:', err.message); }
      return res.json({ ok: true });
    }
    if (a === 'notes') return noteAdd(req, res);
    if (a === 'break') {
      const open = db.prepare('SELECT * FROM visit_breaks WHERE visit_id=? AND employee_id=? AND end_at IS NULL').get(v.id, e.id);
      if (open) db.prepare('UPDATE visit_breaks SET end_at=? WHERE id=?').run(et, open.id);
      else db.prepare('INSERT INTO visit_breaks(visit_id,employee_id,start_at) VALUES(?,?,?)').run(v.id, e.id, et);
      return res.json({ ok: true, on_break: !open });
    }
    if (a === 'onmyway') {
      if (!v.on_my_way_at) {
        db.prepare('UPDATE visits SET on_my_way_at=?, updated_at=? WHERE id=?').run(et, t, v.id);
        await clientNote(v, `${v.title}: crew on the way`, `The crew is on the way to ${v.address || 'your site'}.`);
      }
      return res.json({ ok: true });
    }
    if (a === 'incident') {
      const title = clean((req.body || {}).title, 200), desc = clean(req.body.description, 3000);
      if (!title) return res.status(400).json({ error: 'Describe what happened in a few words.' });
      const id = db.prepare("INSERT INTO customer_issues(customer_id,project_id,type,category,title,description,priority,status,source,reported_by,customer_comms,created_by,created_at,updated_at) VALUES(?,?,'incident',?,?,?,?,'Open','Employee',?,'Not needed',?,?,?)")
        .run(v.customer_id || null, v.project_id || null, ['Safety', 'Damage / incident', 'Equipment', 'Customer request', 'Other'].includes(req.body.category) ? req.body.category : 'Other', title, `${desc}\n\nReported from job: ${v.title} (${v.date})`, ['Low', 'Normal', 'High', 'Urgent'].includes(req.body.priority) ? req.body.priority : 'High', e.name, 'crew: ' + e.name, t, t).lastInsertRowid;
      db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)").run(e.name, 'reported', 'incident', id, title, t);
      if (adminEmail) await notify(adminEmail, `Incident reported by ${e.name}: ${title}`, `Category: ${['Safety', 'Damage / incident', 'Equipment', 'Customer request', 'Other'].includes(req.body.category) ? req.body.category : 'Other'}\n${desc}\nJob: ${v.title} ${v.date}\nOpen: https://brightclean.net/admin/#issues`);
      return res.status(201).json({ id });
    }
    res.status(404).json({ error: 'Unknown action.' });
  };
  app.post('/api/crew/:token/jobs/:vid/:action', crewAction);
  app.post('/api/crew/me/jobs/:vid/:action', crewAction);

  // ---------- Crew messages (office <-> crew member) ----------
  const msgGet = (req, res) => {
    const e = crewAuth(req, res); if (!e) return;
    const conv = require('./conversations');
    const rows = conv.crewThread(db, e.id, 100);
    conv.markReadByCrew(db, e.id);
    res.json({ messages: rows });
  };
  const msgPost = async (req, res) => {
    const e = crewAuth(req, res); if (!e) return;
    const body = clean((req.body || {}).body, 1000);
    if (!body) return res.status(400).json({ error: 'Write a message first.' });
    let vid = null;
    if (req.body.visit_id) { const v = assigned(e, req.body.visit_id); if (!v) return res.status(404).json({ error: 'This job is not assigned to you.' }); vid = v.id; }
    const t = now();
    const id = db.prepare("INSERT INTO crew_messages(employee_id,visit_id,direction,body,created_at,seen_by_office,seen_by_crew) VALUES(?,?,'crew',?,?,0,1)").run(e.id, vid, body, t).lastInsertRowid;
    require('./conversations').mirror(db, { kind: 'crew', employeeId: e.id, role: 'crew', senderRef: String(e.id), body, visitId: vid, legacyRef: 'crew:' + id });
    if (adminEmail) await notify(adminEmail, `Message from ${e.name}`, `${body}\n\nReply in the admin: https://brightclean.net/admin/#schedule`);
    res.status(201).json({ id });
  };
  app.get(['/api/crew/:token/messages', '/api/crew/me/messages'], msgGet);
  app.post(['/api/crew/:token/messages', '/api/crew/me/messages'], msgPost);

  // Office side: the list of crew conversations, one thread, and a reply
  app.get('/api/admin/crew-messages', auth, (req, res) => {
    if (!require('./roles').canRunOperations(roleOf(req))) return res.status(403).json({ error: 'Only owners, managers and supervisors can read crew messages.' });
    const threads = require('./conversations').crewThreads(db);
    res.json({ threads });
  });
  app.get('/api/admin/crew-messages/:eid', auth, (req, res) => {
    if (!require('./roles').canRunOperations(roleOf(req))) return res.status(403).json({ error: 'Only owners, managers and supervisors can read crew messages.' });
    const e = getEmp(req.params.eid); if (!e) return res.status(404).json({ error: 'Employee not found.' });
    const conv = require('./conversations');
    const messages = conv.crewThread(db, e.id, 100);
    conv.markReadByOffice(db, e.id);
    res.json({ employee: { id: e.id, name: e.name }, messages });
  });
  app.post('/api/admin/crew-messages/:eid', auth, async (req, res) => {
    if (!require('./roles').canRunOperations(roleOf(req))) return res.status(403).json({ error: 'Only owners, managers and supervisors can message crew.' });
    const e = getEmp(req.params.eid); if (!e) return res.status(404).json({ error: 'Employee not found.' });
    const body = clean((req.body || {}).body, 1000);
    if (!body) return res.status(400).json({ error: 'Write a message first.' });
    const vid = req.body.visit_id ? Number(req.body.visit_id) || null : null;
    const cmId = db.prepare("INSERT INTO crew_messages(employee_id,visit_id,direction,body,created_at,seen_by_office,seen_by_crew) VALUES(?,?,'office',?,?,1,0)").run(e.id, vid, body, now()).lastInsertRowid;
    require('./conversations').mirror(db, { kind: 'crew', employeeId: e.id, role: 'office', senderRef: 'office', body, visitId: vid, legacyRef: 'crew:' + cmId });
    const how = await reachCrew(e, 'Message from the Bright Clean office', `${body}\n\nReply or see your jobs: ${SIGNIN_URL}`, `Bright Clean office: ${body.slice(0, 120)} Sign in: ${SIGNIN_URL}`);
    logAction(req, 'messaged crew', 'employee', e.id, body.slice(0, 80));
    res.status(201).json({ ok: true, reached: how });
  });

  // Office review of a submitted job: approve (crew may then complete it) or return it with what to fix
  app.post('/api/admin/visits/:id/review', auth, async (req, res) => {
    if (!require('./roles').canRunOperations(roleOf(req))) return res.status(403).json({ error: 'Only owners, managers and supervisors can review jobs.' });
    const v = getVisit(req.params.id); if (!v) return res.status(404).json({ error: 'Job not found.' });
    const decision = (req.body || {}).decision;
    if (!['approve', 'return'].includes(decision)) return res.status(400).json({ error: 'Choose approve or return.' });
    if (v.review_status !== 'Submitted') return res.status(409).json({ error: 'This job is not waiting for review.' });
    const note = clean((req.body || {}).note, 500);
    if (decision === 'return' && !note) return res.status(400).json({ error: 'Say what needs fixing before returning the job.' });
    const t = now(), status = decision === 'approve' ? 'Approved' : 'Returned';
    db.prepare('UPDATE visits SET review_status=?, review_note=?, reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=?').run(status, decision === 'approve' ? null : note, who(req), t, t, v.id);
    logAction(req, decision === 'approve' ? 'approved job' : 'returned job', 'visit', v.id, `${v.title}${note ? ': ' + note : ''}`);
    const text = decision === 'approve' ? `${v.title} (${v.date}) was approved. You can mark it complete now.` : `${v.title} (${v.date}) needs changes before it can be approved: ${note}`;
    for (const c of crewOf(v.id)) await reachCrew(getEmp(c.id), `Job ${decision === 'approve' ? 'approved' : 'returned'}: ${v.title} ${v.date}`, `${text}\nOpen your job: ${SIGNIN_URL}`, text.slice(0, 300));
    res.json({ ok: true, review_status: status });
  });
  // Photos taken on a job (Before / After / Issue), so the office can check them before approving
  app.get('/api/admin/visits/:id/photos', auth, (req, res) => {
    const v = getVisit(req.params.id); if (!v) return res.status(404).json({ error: 'Job not found.' });
    let photos = []; try { photos = db.prepare("SELECT id, title, file_name, file_url, created_at, uploaded_by FROM documents WHERE visit_id=? AND kind='Photos' ORDER BY id").all(v.id); } catch { photos = []; }
    const notes = db.prepare('SELECT n.id, n.body, n.created_at, e.name AS by FROM visit_notes n JOIN employees e ON e.id=n.employee_id WHERE n.visit_id=? ORDER BY n.id').all(v.id);
    const arrival = v.arrived_lat != null ? { lat: v.arrived_lat, lng: v.arrived_lng, accuracy: v.arrived_accuracy, map: `https://www.google.com/maps?q=${v.arrived_lat},${v.arrived_lng}` } : null;
    res.json({ photos, notes, track_url: trackUrl(v), client_email: (clientOf(v) || {}).email || null, time: siteTime(v, null), money: jobMoney(v), arrival });
  });
  // ---------- Client job tracking: every job has a private link the client can follow, no sign-up needed ----------
  const trackToken = v => {
    if (v.tracking_token) return v.tracking_token;
    const tok = crypto.randomBytes(18).toString('base64url');
    db.prepare('UPDATE visits SET tracking_token=? WHERE id=?').run(tok, v.id); v.tracking_token = tok; return tok;
  };
  const clientOf = v => {
    let c = v.customer_id ? db.prepare('SELECT name, company, email FROM customers WHERE id=?').get(v.customer_id) : null;
    if (!c && v.project_id) { const p = db.prepare('SELECT customer_id FROM projects WHERE id=?').get(v.project_id); if (p && p.customer_id) c = db.prepare('SELECT name, company, email FROM customers WHERE id=?').get(p.customer_id) || null; }
    return c || null;
  };
  const trackUrl = v => (process.env.PUBLIC_URL || 'https://brightclean.net') + '/track/' + trackToken(v);
  const trackStatus = v => v.status === 'Cancelled' ? 'Cancelled' : (v.completed_at || v.status === 'Done') ? 'Done' : v.arrived_at ? 'In progress' : v.on_my_way_at ? 'On the way' : 'Scheduled';
  // Plain update to the client with their tracking link. Quietly skipped when no client email is on file.
  const clientNote = async (v, subject, line) => {
    const c = clientOf(v); if (!c || !c.email) return false;
    return notify(c.email, subject, `${line}\n\nFollow ${v.title} here: ${trackUrl(v)}\n\n${COMPANY_NAME}`);
  };
  const trackView = v => {
    const c = clientOf(v), status = trackStatus(v);
    const showPhotos = status === 'Done' || v.review_status === 'Approved';
    const photos = showPhotos ? db.prepare("SELECT id, title FROM documents WHERE visit_id=? AND kind='Photos' ORDER BY id").all(v.id) : [];
    return { title: v.title, date: v.date, start_time: v.start_time, end_time: v.end_time, address: v.address || '', client: c ? (c.company || c.name || '') : '',
      status, crew_count: crewOf(v.id).length,
      steps: [{ label: 'Scheduled', at: v.dispatched_at || null }, { label: 'Crew on the way', at: v.on_my_way_at || null }, { label: 'Crew arrived', at: v.arrived_at || null }, { label: 'Completed', at: v.completed_at || null }],
      photos: photos.map(p => ({ id: p.id, title: p.title, url: `/api/track/${v.tracking_token}/photos/${p.id}` })) };
  };
  const byTrack = tok => db.prepare('SELECT * FROM visits WHERE tracking_token=?').get(String(tok || '').slice(0, 80));
  app.get('/api/track/:token', (req, res) => {
    const v = byTrack(req.params.token); if (!v) return res.status(404).json({ error: 'This tracking link is not valid.' });
    res.set('Cache-Control', 'no-store').json(trackView(v));
  });
  app.get('/api/track/:token/photos/:photoId', (req, res) => {
    const v = byTrack(req.params.token); if (!v) return res.status(404).end();
    if (!(trackStatus(v) === 'Done' || v.review_status === 'Approved')) return res.status(404).end();
    const doc = db.prepare("SELECT * FROM documents WHERE id=? AND visit_id=? AND kind='Photos'").get(Number(req.params.photoId), v.id);
    if (!doc) return res.status(404).end();
    const p = require('path').join(uploadDir || require('path').join(process.cwd(), 'uploads'), require('path').basename(doc.file_url || ''));
    if (!require('fs').existsSync(p)) return res.status(404).end();
    res.sendFile(p);
  });
  app.get('/track/:token', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'track.html')));
  // Office: resend the client their tracking link (or copy it when there is no email on file)
  app.post('/api/admin/visits/:id/send-tracking', auth, async (req, res) => {
    const v = getVisit(req.params.id); if (!v) return res.status(404).json({ error: 'Job not found.' });
    const c = clientOf(v), link = trackUrl(v);
    if (!c || !c.email) return res.status(409).json({ error: 'No client email on file for this job. Copy the link and send it yourself.', link });
    const sent = await notify(c.email, `Track ${v.title} ${v.date}`, `Here is the progress page for ${v.title} on ${v.date}. It shows when the crew is on the way, when they arrive, and the photos when the job is done.\n\n${link}\n\n${COMPANY_NAME}`);
    res.json({ sent: !!sent, link });
  });
  // Time on site: from arrival to finish (or now), minus the breaks taken. Breaks are per crew member.
  const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
  const breakMinutes = (vid, eid) => db.prepare('SELECT start_at, end_at FROM visit_breaks WHERE visit_id=? AND (? IS NULL OR employee_id=?)').all(vid, eid == null ? null : eid, eid == null ? null : eid)
    .reduce((t, b) => t + minutesBetween(b.start_at, b.end_at || now()), 0);
  const siteTime = (v, eid) => {
    if (!v.arrived_at) return { on_site_minutes: 0, break_minutes: 0 };
    const end = v.departed_at || v.completed_at || now();
    const br = breakMinutes(v.id, eid);
    return { on_site_minutes: Math.max(0, minutesBetween(v.arrived_at, end) - br), break_minutes: br };
  };
  // Labor cost of a job from the same time entries and hourly rates payroll uses, plus what the project has invoiced.
  const jobMoney = v => {
    const rows = db.prepare('SELECT t.id, t.employee_id, t.clock_in, t.clock_out, t.minutes, t.labor_cost, COALESCE(t.labor_rate, e.hourly_rate) AS hourly_rate FROM time_entries t JOIN employees e ON e.id=t.employee_id WHERE t.visit_id=?').all(v.id);
    let mins = 0, cost = 0;
    for (const r of rows) { const m = r.clock_out ? minutesBetween(r.clock_in, r.clock_out) : Number(r.minutes || 0); mins += m; cost += r.labor_cost != null ? Number(r.labor_cost) : require('./labor').costOf(db, { id: r.id, employee_id: r.employee_id, clock_in: r.clock_in, minutes: m, rate: r.hourly_rate }).cost; }
    let invoiced = 0;
    if (v.project_id) { try { invoiced = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM invoices WHERE project_id=? AND status NOT IN ('Draft','Void')").get(v.project_id).s || 0; } catch { invoiced = 0; } }
    return { hours: Math.round(mins / 6) / 10, labor_cost: Math.round(cost * 100) / 100, project_invoiced: Math.round(invoiced * 100) / 100, has_project: !!v.project_id };
  };
  // Remove one photo from a job (office only). Only photos attached to that job can be removed.
  app.delete('/api/admin/visits/:id/photos/:photoId', auth, (req, res) => {
    if (!require('./roles').canRunOperations(roleOf(req))) return res.status(403).json({ error: 'Only owners, managers and supervisors can remove job photos.' });
    const v = getVisit(req.params.id); if (!v) return res.status(404).json({ error: 'Job not found.' });
    const doc = db.prepare("SELECT * FROM documents WHERE id=? AND visit_id=? AND kind='Photos'").get(Number(req.params.photoId), v.id);
    if (!doc) return res.status(404).json({ error: 'Photo not found on this job.' });
    db.prepare('DELETE FROM documents WHERE id=?').run(doc.id);
    try { const p = require('path').join(uploadDir || require('path').join(process.cwd(), 'uploads'), require('path').basename(doc.file_url || '')); if (require('fs').existsSync(p)) require('fs').unlinkSync(p); } catch { /* file already gone */ }
    logAction(req, 'removed job photo', 'visit', v.id, `${doc.title || 'photo'}`);
    res.json({ ok: true });
  });
  // Crew notes on a job: what was done, anything that happened. The office sees them on the job.
  const noteAdd = async (req, res) => {
    const e = crewAuth(req, res); if (!e) return;
    const v = assigned(e, req.params.vid); if (!v) return res.status(404).json({ error: 'This job is not assigned to you.' });
    const body = clean((req.body || {}).body, 2000);
    if (!body) return res.status(400).json({ error: 'Write a note first.' });
    // Saved on the job itself: the office reads it in the job record when reviewing the job. Nothing is emailed or messaged.
    const id = db.prepare('INSERT INTO visit_notes(visit_id,employee_id,body,created_at) VALUES(?,?,?,?)').run(v.id, e.id, body, now()).lastInsertRowid;
    res.status(201).json({ id });
  };
  // Crew photo upload (before/after): stored as project/visit documents.
  try {
    const multer = require('multer'), path = require('path'), fs = require('fs');
    const dir = uploadDir || path.join(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'));
    const up = multer({ storage: multer.diskStorage({ destination: (r, f, cb) => { fs.mkdirSync(dir, { recursive: true }); cb(null, dir); }, filename: (r, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + (path.extname(f.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg')) }),
      limits: { fileSize: 12 * 1024 * 1024, files: 6 }, fileFilter: (r, f, cb) => cb(null, /^image\//.test(f.mimetype)) });
    app.post(['/api/crew/:token/jobs/:vid/photos', '/api/crew/me/jobs/:vid/photos'], (req, res, next) => { const e = crewAuth(req, res); if (!e) return; const v = assigned(e, req.params.vid); if (!v) return res.status(404).json({ error: 'This job is not assigned to you.' }); if (['Cancelled', 'Skipped', 'Done'].includes(v.status)) return res.status(409).json({ error: `This job is ${v.status === 'Done' ? 'already complete' : v.status.toLowerCase()}, so photos can no longer be added to it.` }); req.crewEmp = e; req.crewVisit = v; next(); }, up.array('photos', 6), require('./filecheck').verifyUploads, (req, res) => {
      const files = req.files || []; if (!files.length) return res.status(400).json({ error: 'Choose at least one photo.' });
      const stage = ['Before', 'During', 'After', 'Issue'].includes(req.body.stage) ? req.body.stage : 'After', t = now();
      try { if (!db.prepare('PRAGMA table_info(documents)').all().some(c => c.name === 'visit_id')) db.exec('ALTER TABLE documents ADD COLUMN visit_id INTEGER'); } catch { /* */ }
      const ids = files.map(f => db.prepare('INSERT INTO documents(project_id,customer_id,title,kind,file_name,file_url,size,uploaded_by,created_at,visit_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(req.crewVisit.project_id || null, req.crewVisit.customer_id || null, `${stage} – ${req.crewVisit.title} ${req.crewVisit.date}`, 'Photos', f.originalname, '/api/files/' + path.basename(f.path), f.size, 'crew: ' + req.crewEmp.name, t, req.crewVisit.id).lastInsertRowid);
      res.status(201).json({ ids });
    });
  } catch (err) { console.error('crew photo upload disabled:', err.message); }
  app.get('/crew', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'crew.html')));
  app.get('/crew/:token', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'crew.html')));
  // Office alert when a dispatched job has not started 15 minutes after its start time. Once per job.
  const lateSweep = async () => {
    if (!adminEmail) return;
    const bd = require('./bizdate');
    const d = bd.today();
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: bd.TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
    const nowMin = Number(p.hour) * 60 + Number(p.minute);
    const rows = db.prepare("SELECT * FROM visits WHERE date=? AND dispatched_at IS NOT NULL AND arrived_at IS NULL AND late_alert_at IS NULL AND start_time IS NOT NULL AND status NOT IN ('Cancelled','Skipped','Done')").all(d);
    for (const v of rows) {
      const [h, m] = String(v.start_time).split(':').map(Number);
      if (!(nowMin > h * 60 + m + 15)) continue;
      db.prepare('UPDATE visits SET late_alert_at=? WHERE id=?').run(now(), v.id);
      await notify(adminEmail, `Late start: ${v.title} ${v.date}`, `${v.title} was due to start at ${v.start_time} at ${v.address || 'the site'}, and no crew has checked in yet.\nCrew: ${crewOf(v.id).map(x => x.name).join(', ') || 'none'}\n\nOpen the schedule: https://brightclean.net/admin/#schedule`);
    }
  };
  app.locals.lateSweep = lateSweep;
  if (!process.env.DISABLE_SCHEDULER) { const lt = setInterval(() => lateSweep().catch(err => console.error('late sweep:', err.message)), 5 * 60 * 1000); lt.unref(); }
  if (!process.env.DISABLE_SCHEDULER) { const ce = setInterval(() => { try { require('./conversations').crewEscalationSweep(db); } catch (err) { console.error('crew escalation:', err.message); } }, 5 * 60 * 1000); ce.unref(); }
  app.locals.schedCheck = (empId, visitId) => check(getEmp(empId), getVisit(visitId));
};
