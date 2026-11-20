// Task budgets and task-level cost (audit G6). A task can have a budget (hours and cost). Approved time and non-labor
// project costs can be assigned to a task. The report splits a project's cost by task; it is a breakdown, never an addition:
//   labor on a task  = approved time on that task (minutes x the pay rate in force at approval)
//   other on a task  = project costs on that task that are not labor (materials, equipment, subcontractors, travel, other)
//   not on a task    = everything else recorded on the project, so the parts always add back to the project's cost.
// Labor project costs made from time entries are not counted again on the task side (the time entry is the source).

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const LB = require('./labor');
const isLabor = c => /labou?r|crew|wage|payroll/i.test(String(c || ''));
const hasCol = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);

function ensureSchema(db) {
  const addCol = (t, c, type) => { if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) && !hasCol(db, t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`); };
  addCol('project_tasks', 'budget_hours', 'REAL');
  addCol('project_tasks', 'budget_cost', 'REAL');
  addCol('project_costs', 'task_id', 'INTEGER');
  addCol('time_entries', 'task_id', 'INTEGER');
  LB.ensureColumns(db);
}

function setBudget(db, projectId, taskId, { hours, cost }, by) {
  ensureSchema(db);
  const t = db.prepare('SELECT id, project_id, title FROM project_tasks WHERE id=?').get(Number(taskId));
  if (!t || t.project_id !== Number(projectId)) throw new Error('That task is not on this project.');
  const h = hours === '' || hours == null ? null : Number(hours), c = cost === '' || cost == null ? null : Number(cost);
  if (h != null && !(h >= 0 && h < 100000)) throw new Error('Budget hours must be zero or more.');
  if (c != null && !(c >= 0 && c < 1e9)) throw new Error('Budget cost must be zero or more.');
  db.prepare('UPDATE project_tasks SET budget_hours=?, budget_cost=? WHERE id=?').run(h, c == null ? null : r2(c), t.id);
  require('./audit').record(db, { actor: by, action: 'set task budget', entity: 'task', entityId: t.id, detail: `hours ${h == null ? 'none' : h}, cost ${c == null ? 'none' : r2(c).toFixed(2)}` });
  return { ok: true };
}

// Assigns an approved or unapproved time entry to a task of the same project.
function assignTime(db, timeId, taskId, by) {
  ensureSchema(db);
  const t = db.prepare('SELECT id, project_id FROM time_entries WHERE id=?').get(Number(timeId));
  if (!t) throw new Error('Time entry not found.');
  const task = db.prepare('SELECT id, project_id FROM project_tasks WHERE id=?').get(Number(taskId));
  if (!task || task.project_id !== t.project_id) throw new Error('The task must be on the same project as the time entry.');
  db.prepare('UPDATE time_entries SET task_id=? WHERE id=?').run(task.id, t.id);
  require('./audit').record(db, { actor: by, action: 'assigned time to task', entity: 'time_entry', entityId: t.id, detail: 'task ' + task.id });
  return { ok: true };
}

function assignCost(db, costId, taskId, by) {
  ensureSchema(db);
  const c = db.prepare('SELECT id, project_id FROM project_costs WHERE id=?').get(Number(costId));
  if (!c) throw new Error('Project cost not found.');
  const task = db.prepare('SELECT id, project_id FROM project_tasks WHERE id=?').get(Number(taskId));
  if (!task || task.project_id !== c.project_id) throw new Error('The task must be on the same project as the cost.');
  db.prepare('UPDATE project_costs SET task_id=? WHERE id=?').run(task.id, c.id);
  require('./audit').record(db, { actor: by, action: 'assigned cost to task', entity: 'project_cost', entityId: c.id, detail: 'task ' + task.id });
  return { ok: true };
}

function taskReport(db, projectId) {
  ensureSchema(db);
  const pid = Number(projectId);
  if (!db.prepare('SELECT id FROM projects WHERE id=?').get(pid)) return null;
  const tasks = db.prepare('SELECT id, title, phase, status, budget_hours, budget_cost FROM project_tasks WHERE project_id=? ORDER BY sort, id').all(pid);
  // Labor comes only from approved time: minutes x the rate in force at approval.
  const timeRows = db.prepare(`SELECT t.id, t.task_id, t.minutes, t.cost_id, t.labor_cost, COALESCE(t.labor_rate, e.hourly_rate) AS rate
    FROM time_entries t JOIN employees e ON e.id=t.employee_id WHERE t.project_id=? AND t.approved_by IS NOT NULL`).all(pid)
    .map(t => ({ ...t, labor: LB.storedCost({ minutes: t.minutes, labor_cost: t.labor_cost, labor_rate: t.rate }) }));
  // A project cost made from a time entry is the same labor, so it is skipped here (the time entry is the source).
  const fromTime = new Set(timeRows.filter(t => t.cost_id).map(t => t.cost_id));
  const costRows = db.prepare('SELECT id, task_id, amount FROM project_costs WHERE project_id=?').all(pid).filter(c => !fromTime.has(c.id));
  const rows = tasks.map(t => {
    const mine = timeRows.filter(x => x.task_id === t.id);
    const labor = r2(mine.reduce((s, x) => s + x.labor, 0));
    const hours = r2(mine.reduce((s, x) => s + (Number(x.minutes) || 0), 0) / 60);
    const other = r2(costRows.filter(c => c.task_id === t.id).reduce((s, c) => s + (Number(c.amount) || 0), 0));
    const actual = r2(labor + other);
    const budget = t.budget_cost == null ? null : r2(t.budget_cost);
    return { task_id: t.id, title: t.title, phase: t.phase, status: t.status,
      budget_hours: t.budget_hours, actual_hours: hours, budget_cost: budget, actual_labor: labor, actual_other: other, actual_cost: actual,
      remaining_budget: budget == null ? null : r2(budget - actual), variance: budget == null ? null : r2(budget - actual), over_budget: budget != null && actual > budget + 0.005 };
  });
  const recorded = r2(timeRows.reduce((s, x) => s + x.labor, 0) + costRows.reduce((s, c) => s + (Number(c.amount) || 0), 0));
  const taskTotal = r2(rows.reduce((s, r) => s + r.actual_cost, 0));
  const notOnTask = r2(recorded - taskTotal);
  return { project_id: pid, tasks: rows,
    totals: { budget_cost: r2(rows.reduce((s, r) => s + (r.budget_cost || 0), 0)), actual_on_tasks: taskTotal },
    not_on_a_task: notOnTask,
    project_recorded_cost: recorded,
    reconciles: Math.abs(recorded - (taskTotal + notOnTask)) < 0.005,
    notes: ['Labor on a task comes from approved time. Project costs made from time entries are not counted again.',
      'A task without a budget shows no variance until a budget is set.',
      notOnTask > 0.005 ? 'Some cost is not assigned to a task. Assign it so task cost is complete.' : 'Everything recorded on this project is assigned to a task.'] };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  ensureSchema(db);
  const run = (res, fn) => { try { res.json(fn()); } catch (e) { res.status(400).json({ error: e.message }); } };
  app.get('/api/admin/projects/:id/task-costs', auth, (req, res) => { const r = taskReport(db, req.params.id); if (!r) return res.status(404).json({ error: 'Project not found.' }); res.json(r); });
  app.post('/api/admin/projects/:pid/tasks/:tid/budget', auth, (req, res) => run(res, () => setBudget(db, req.params.pid, req.params.tid, req.body || {}, req.user && req.user.email)));
  app.post('/api/admin/time-entries/:id/task', auth, (req, res) => run(res, () => assignTime(db, req.params.id, (req.body || {}).task_id, req.user && req.user.email)));
  app.post('/api/admin/project-costs/:id/task', auth, (req, res) => run(res, () => assignCost(db, req.params.id, (req.body || {}).task_id, req.user && req.user.email)));
}

module.exports = { ensureSchema, setBudget, assignTime, assignCost, taskReport, mount };
