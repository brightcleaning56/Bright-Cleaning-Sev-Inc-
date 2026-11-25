// Reports: profit & loss from real records (invoices issued vs recorded actual costs), project profitability,
// A/R aging, labor (hours, cost, overtime, approval), custom date ranges, PDF export and scheduled email summaries.
// Every figure states its basis; nothing is estimated or filled in.
const { Doc } = require('./pdf');

module.exports = function mountReports2(app, ctx) {
  const { db, auth, logAction, clean, adminEmail, getMailer } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS report_schedules(id INTEGER PRIMARY KEY AUTOINCREMENT, frequency TEXT NOT NULL, recipients TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    last_sent TEXT, created_by TEXT, created_at TEXT NOT NULL);`);
  const now = () => new Date().toISOString(), today = () => require('./bizdate').today();
  const who = req => (req.user && req.user.email) || null;
  const roleOf = req => { const e = String(who(req) || '').toLowerCase(); if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const has = (t) => { try { db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get(); return true; } catch { return false; } };
  const range = q => {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    let from = iso.test(q.from || '') ? q.from : null, to = iso.test(q.to || '') ? q.to : null;
    if (!from) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 2); from = d.toISOString().slice(0, 10); }
    if (!to) to = today();
    if (to < from) [from, to] = [to, from];
    return { from, to };
  };
  const daysBetween = (a, b) => Math.floor((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);

  // The ledger's figures for a period (the books of record). Revenue is invoices less credit notes; costs are job costs
  // and approved labor posted to the ledger (5xxx); operating expenses are vendor bills and unassigned payroll (6xxx).
  // Posts anything not yet on the ledger (idempotent), so a report never lags behind the records it is built from.
  function catchUpLedger() {
    try { require('./invoice-ledger').syncAll(db); require('./expenses').syncRecorded(db); }
    catch (e) { console.error('ledger catch-up for reports failed:', e.message); }
  }
  function ledgerPeriod(from, to) {
    catchUpLedger();
    const net = where => Number(db.prepare(`SELECT COALESCE(SUM(l.debit_cents - l.credit_cents),0) v FROM ledger_lines l JOIN ledger_entries e ON e.id=l.entry_id WHERE ${where} AND e.entry_date BETWEEN ? AND ?`).get(from, to).v) / 100;
    const byCat = {};
    for (const a of db.prepare(`SELECT a.name, COALESCE(SUM(l.debit_cents - l.credit_cents),0) v FROM ledger_lines l JOIN ledger_entries e ON e.id=l.entry_id JOIN ledger_accounts a ON a.code=l.account_code WHERE l.account_code LIKE '5%' AND e.entry_date BETWEEN ? AND ? GROUP BY a.code, a.name ORDER BY a.code`).all(from, to)) {
      const v = r2(Number(a.v) / 100); if (v) byCat[a.name] = v;
    }
    return { invoiced: r2(-net("l.account_code='4000'") - net("l.account_code='4900'")), discounts: r2(net("l.account_code='4900'")),
      collected: r2(net("l.account_code='1000' AND e.source IN ('payment','refund')")), costs: r2(net("l.account_code LIKE '5%'")), operating: r2(net("l.account_code LIKE '6%'")), byCat };
  }
  function finance({ from, to, project_id }) {
    // Invoices count in the month they were issued (or sent), not the month they were created.
    const bz = require('./bizdate');
    const inv = db.prepare(`SELECT i.*, p.name project_name FROM invoices i LEFT JOIN projects p ON p.id=i.project_id WHERE i.status NOT IN ('Draft','Void')`).all().filter(i => { const d = bz.invoiceDay(i); return d >= from && d <= to && (!project_id || i.project_id === project_id); });
    let invoiced = r2(inv.reduce((s, i) => s + (i.amount || 0), 0)), collected = r2(inv.reduce((s, i) => s + Math.min(i.paid_amount || 0, i.amount || 0), 0));
    let costRows = has('project_costs') ? db.prepare(`SELECT c.*, p.name project_name FROM project_costs c LEFT JOIN projects p ON p.id=c.project_id WHERE c.cost_date BETWEEN ? AND ?`).all(from, to) : [];
    if (project_id) costRows = costRows.filter(c => c.project_id === project_id);
    const byCat = {}; for (const c of costRows) byCat[c.category] = r2((byCat[c.category] || 0) + c.amount);
    // Approved time that is not tied to a project (so it was not posted as a project cost) still costs money.
    let unposted = 0; if (has('time_entries')) unposted = r2(db.prepare(`SELECT COALESCE(SUM(COALESCE(t.labor_cost, t.minutes/60.0*COALESCE(t.labor_rate, e.hourly_rate))),0) v FROM time_entries t JOIN employees e ON e.id=t.employee_id WHERE t.approved_by IS NOT NULL AND t.cost_id IS NULL AND t.clock_in >= ? AND t.clock_in < ?`).get(...require('./bizdate').window(from, to)).v);
    if (unposted && !project_id) byCat['Labor (not tied to a project)'] = unposted;
    let costs = r2(Object.values(byCat).reduce((s, v) => s + v, 0));
    const LG = (!project_id && has('ledger_lines')) ? ledgerPeriod(from, to) : null;
    if (LG) { invoiced = LG.invoiced; collected = LG.collected; costs = LG.costs; for (const k of Object.keys(byCat)) delete byCat[k]; Object.assign(byCat, LG.byCat); }
    // Project profitability: everything recorded against each project, all time (projects span periods).
    const projects = has('project_costs') ? db.prepare(`SELECT p.id, p.name, p.status, p.company, p.customer_name, COALESCE(k.value,0) contract,
        (SELECT COALESCE(SUM(amount),0) FROM invoices WHERE project_id=p.id AND status NOT IN ('Draft','Void')) invoiced,
        (SELECT COALESCE(SUM(MIN(paid_amount,amount)),0) FROM invoices WHERE project_id=p.id AND status NOT IN ('Draft','Void')) collected,
        (SELECT COALESCE(SUM(amount),0) FROM project_costs WHERE project_id=p.id) cost,
        (SELECT COALESCE(SUM(amount),0) FROM project_costs WHERE project_id=p.id AND category='Labor') labor,
        (SELECT COALESCE(SUM(amount),0) FROM project_costs WHERE project_id=p.id AND category LIKE 'Material%') materials
      FROM projects p LEFT JOIN contracts k ON k.id=p.contract_id WHERE p.status<>'Archived' ORDER BY p.id DESC`).all().map(p => ({ ...p, other_cost: r2(p.cost - p.labor - p.materials), pending: require('./job-cost').pendingFor(db, p.id), profit: p.cost > 0 ? r2(p.invoiced - p.cost) : null, margin: p.cost > 0 && p.invoiced > 0 ? Math.round((p.invoiced - p.cost) / p.invoiced * 1000) / 10 : null })) : [];
    const checks = [];
    if (project_id) checks.push('Showing one project only. Overhead and labor not tied to a project are left out, so this is not the whole company.');
    const noCost = projects.filter(p => p.invoiced > 0 && p.cost === 0); if (noCost.length) checks.push(`${noCost.length} invoiced project(s) have no recorded costs, so their profit is not shown: ${noCost.slice(0, 5).map(p => p.name || '#' + p.id).join(', ')}.`);
    const noProj = inv.filter(i => !i.project_id).length; if (noProj) checks.push(`${noProj} invoice(s) in this period are not linked to a project.`);
    // Reconciliation: say what does not add up, so the report never looks complete when it is not.
    if (costs > 0 && invoiced === 0) checks.push(`Costs of $${costs.toFixed(2)} are recorded in this period, but no invoice counts as revenue. Revenue may be missing: check drafts and invoices not yet issued.`);
    const drafts = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount),0) v FROM invoices WHERE status='Draft'").get();
    if (drafts.n) checks.push(`${drafts.n} draft invoice(s) worth $${Number(drafts.v).toFixed(2)} are not counted as revenue until they are issued.`);
    const unlinked = costRows.filter(c => !c.project_id).length; if (unlinked) checks.push(`${unlinked} cost entr${unlinked === 1 ? 'y is' : 'ies are'} not linked to a project, so project profit may be overstated.`);
    if (has('time_entries')) { const pend = db.prepare("SELECT COUNT(*) n FROM time_entries WHERE approved_by IS NULL AND clock_out IS NOT NULL AND clock_in >= ? AND clock_in < ?").get(...require('./bizdate').window(from, to)).n; if (pend) checks.push(`${pend} time entr${pend === 1 ? 'y is' : 'ies are'} not approved yet, so that labor is not in the costs.`); }
    return { from, to, invoiced, collected, costs, cost_by_category: byCat, gross_profit: r2(invoiced - costs), margin: invoiced > 0 ? Math.round((invoiced - costs) / invoiced * 1000) / 10 : null,
      source: LG ? 'ledger' : 'records', operating_expenses: LG ? LG.operating : null, net_profit: LG ? r2(invoiced - costs - LG.operating) : null, credit_notes: LG ? LG.discounts : null,
      basis: LG ? 'Figures are read from the ledger, the books of record, for this period. Revenue = invoices issued less credit notes. Costs = job costs and approved labor posted to the ledger. Operating expenses = vendor bills and unassigned payroll, which are not job costs. Collected = cash received from customers less refunds. Project profitability below uses invoices and project costs recorded to date.' : 'Revenue = invoices issued in the period (not drafts or void). Costs = actual costs recorded on projects in the period plus approved labor not tied to a project. Collected = amount paid on the invoices issued in the period.',
      invoices: inv.length, projects, project_id: project_id || null, checks };
  }
  function aging() {
    const t = today();
    const open = db.prepare(`SELECT i.*, p.name project_name FROM invoices i LEFT JOIN projects p ON p.id=i.project_id WHERE i.status NOT IN ('Draft','Void','Paid')`).all()
      .map(i => { const bal = r2(require('./receivables').invoiceBalance(db, i.id).owed), late = i.due_date ? daysBetween(i.due_date, t) : 0; return { id: i.id, number: i.invoice_number, customer: i.company || i.customer_name || '—', project: i.project_name, due_date: i.due_date, balance: bal, days_late: Math.max(0, late),
        bucket: !i.due_date || late <= 0 ? 'Current' : late <= 30 ? '1–30' : late <= 60 ? '31–60' : late <= 90 ? '61–90' : '90+' }; }).filter(i => i.balance > 0.005);
    const B = ['Current', '1–30', '31–60', '61–90', '90+'], buckets = Object.fromEntries(B.map(b => [b, r2(open.filter(i => i.bucket === b).reduce((s, i) => s + i.balance, 0))]));
    const byCust = {}; for (const i of open) { const c = byCust[i.customer] = byCust[i.customer] || { customer: i.customer, total: 0, ...Object.fromEntries(B.map(b => [b, 0])) }; c.total = r2(c.total + i.balance); c[i.bucket] = r2(c[i.bucket] + i.balance); }
    return { as_of: t, total: r2(open.reduce((s, i) => s + i.balance, 0)), buckets, customers: Object.values(byCust).sort((a, b) => b.total - a.total), invoices: open.sort((a, b) => b.days_late - a.days_late) };
  }
  function labor({ from, to }) {
    if (!has('time_entries')) return { from, to, employees: [], projects: [], totals: { hours: 0, cost: 0, pending_hours: 0, overtime_hours: 0 } };
    const rows = db.prepare(`SELECT t.*, e.name, COALESCE(t.labor_rate, e.hourly_rate) AS hourly_rate, e.max_week_hours, p.name project_name FROM time_entries t JOIN employees e ON e.id=t.employee_id LEFT JOIN projects p ON p.id=t.project_id WHERE t.clock_out IS NOT NULL AND t.clock_in >= ? AND t.clock_in < ?`).all(...require('./bizdate').window(from, to));
    const wk = d => { const x = new Date(d.slice(0, 10) + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
    const emp = {}, proj = {}, weeks = {};
    for (const t of rows) {
      const h = (t.minutes || 0) / 60, c = h * (t.hourly_rate || 0);
      const e = emp[t.employee_id] = emp[t.employee_id] || { name: t.name, hours: 0, cost: 0, approved_hours: 0, pending_hours: 0, overtime_hours: 0 };
      e.hours += h; e.cost += c; if (t.approved_by) e.approved_hours += h; else e.pending_hours += h;
      const k = `${t.employee_id}|${wk(t.clock_in)}`; weeks[k] = weeks[k] || { emp: t.employee_id, h: 0, max: t.max_week_hours || 40 }; weeks[k].h += h;
      const pk = t.project_name || 'Not tied to a project'; const p = proj[pk] = proj[pk] || { project: pk, hours: 0, cost: 0 }; p.hours += h; p.cost += c;
    }
    for (const w of Object.values(weeks)) if (w.h > w.max) emp[w.emp].overtime_hours += w.h - w.max;
    const E = Object.values(emp).map(e => ({ ...e, hours: r2(e.hours), cost: r2(e.cost), approved_hours: r2(e.approved_hours), pending_hours: r2(e.pending_hours), overtime_hours: r2(e.overtime_hours) })).sort((a, b) => b.hours - a.hours);
    return { from, to, employees: E, projects: Object.values(proj).map(p => ({ ...p, hours: r2(p.hours), cost: r2(p.cost) })).sort((a, b) => b.hours - a.hours),
      totals: { hours: r2(E.reduce((s, e) => s + e.hours, 0)), cost: r2(E.reduce((s, e) => s + e.cost, 0)), pending_hours: r2(E.reduce((s, e) => s + e.pending_hours, 0)), overtime_hours: r2(E.reduce((s, e) => s + e.overtime_hours, 0)) },
      basis: 'From crew check-in/out and manager time entries. Cost = hours × each employee\'s hourly rate. Overtime = hours above each employee\'s weekly limit, per week.' };
  }

  // Revenue and costs by month, using the same rules as finance(). The period totals are returned too, so the
  // screen can check that the months add up to them.
  // Month-by-month figures from the ledger, using the same definitions as ledgerPeriod().
  function monthlyLedger(from, to) {
    const bump = {};
    for (const r of db.prepare(`SELECT substr(e.entry_date,1,7) m, a.code, COALESCE(SUM(l.debit_cents),0) dr, COALESCE(SUM(l.credit_cents),0) cr FROM ledger_lines l JOIN ledger_entries e ON e.id=l.entry_id JOIN ledger_accounts a ON a.code=l.account_code WHERE e.entry_date BETWEEN ? AND ? AND (a.code IN ('4000','4900') OR a.code LIKE '5%') GROUP BY m, a.code`).all(from, to)) {
      const m = bump[r.m] = bump[r.m] || { month: r.m, revenue: 0, costs: 0 };
      if (r.code === '4000') m.revenue = r2(m.revenue + (r.cr - r.dr) / 100);
      else if (r.code === '4900') m.revenue = r2(m.revenue - (r.dr - r.cr) / 100);
      else m.costs = r2(m.costs + (r.dr - r.cr) / 100);
    }
    const all = Object.values(bump).sort((a, b) => a.month.localeCompare(b.month));
    return { from, to, project_id: null, months: all.slice(-36), revenue: r2(all.reduce((s, m) => s + m.revenue, 0)), costs: r2(all.reduce((s, m) => s + m.costs, 0)), source: 'ledger' };
  }
  function monthly({ from, to, project_id }) {
    if (!project_id && has('ledger_lines')) return monthlyLedger(from, to);
    const bz = require('./bizdate');
    const months = {};
    const bump = (m, k, v) => { months[m] = months[m] || { month: m, revenue: 0, costs: 0 }; months[m][k] = r2(months[m][k] + v); };
    for (const i of db.prepare(`SELECT i.* FROM invoices i WHERE i.status NOT IN ('Draft','Void')`).all()) {
      if (project_id && i.project_id !== project_id) continue; const d = bz.invoiceDay(i); if (d >= from && d <= to) bump(String(d).slice(0, 7), 'revenue', i.amount || 0);
    }
    if (has('project_costs')) for (const c of db.prepare('SELECT amount, cost_date, project_id FROM project_costs WHERE cost_date BETWEEN ? AND ?').all(from, to).filter(c => !project_id || c.project_id === project_id)) bump(String(c.cost_date).slice(0, 7), 'costs', c.amount || 0);
    if (has('time_entries') && !project_id) for (const t of db.prepare(`SELECT t.clock_in, t.minutes, COALESCE(t.labor_rate, e.hourly_rate) AS hourly_rate FROM time_entries t JOIN employees e ON e.id=t.employee_id WHERE t.approved_by IS NOT NULL AND t.cost_id IS NULL AND t.clock_in >= ? AND t.clock_in < ?`).all(...bz.window(from, to))) bump(String(t.clock_in).slice(0, 7), 'costs', (t.minutes / 60) * (t.hourly_rate || 0));
    const all = Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
    const revenue = r2(all.reduce((s, m) => s + m.revenue, 0)), costs = r2(all.reduce((s, m) => s + m.costs, 0));
    return { from, to, project_id: project_id || null, months: all.slice(-36), revenue, costs };
  }
  app.get('/api/admin/reports/monthly', auth, (req, res) => res.json(monthly({ ...range(req.query), project_id: Number(req.query.project_id) || null })));
  app.get('/api/admin/reports/finance', auth, (req, res) => res.json(finance({ ...range(req.query), project_id: Number(req.query.project_id) || null })));
  app.get('/api/admin/reports/aging', auth, (req, res) => res.json(aging()));
  app.get('/api/admin/reports/labor', auth, (req, res) => res.json(labor(range(req.query))));
  const money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  app.get('/api/admin/reports/pdf', auth, (req, res) => {
    const rg = range(req.query), f = finance(rg), a = aging(), l = labor(rg), d = new Doc();
    d.box(0, 742, 612, 50, '0.06 0.15 0.26'); d.y = 762; d.text('BRIGHT CLEANING SEV INC.  -  BUSINESS REPORT', { size: 13, bold: true, color: '1 1 1' }); d.y = 712;
    d.heading(`${rg.from} to ${rg.to}`, 14); d.para(`Prepared ${today()} by ${who(req) || ''}`);
    d.heading('Profit & loss', 12);
    d.table([{ label: 'Item', w: 70 }, { label: 'Amount', w: 30, align: 'right' }], [['Invoiced (revenue)', money(f.invoiced)], ['Collected on those invoices', money(f.collected)], ...Object.entries(f.cost_by_category).map(([k, v]) => ['Cost: ' + k, money(v)]), ['Total recorded costs', money(f.costs)], ['Gross profit', money(f.gross_profit)], ['Gross margin', f.margin == null ? '-' : f.margin + '%'], ...(f.operating_expenses != null ? [['Operating expenses (bills, unassigned payroll)', money(f.operating_expenses)], ['Net profit', money(f.net_profit)]] : [])]);
    d.para(f.basis, { size: 8 }); for (const c of f.checks) d.para('Note: ' + c, { size: 8 });
    d.heading('Accounts receivable aging', 12);
    d.table([{ label: 'Bucket', w: 60 }, { label: 'Balance', w: 40, align: 'right' }], [...Object.entries(a.buckets).map(([k, v]) => [k === 'Current' ? 'Current (not yet due)' : k + ' days past due', money(v)]), ['Total open', money(a.total)]]);
    if (a.customers.length) d.table([{ label: 'Customer', w: 50 }, { label: 'Open', w: 25, align: 'right' }, { label: '61+ days', w: 25, align: 'right' }], a.customers.slice(0, 15).map(c => [c.customer, money(c.total), money((c['61–90'] || 0) + (c['90+'] || 0))]));
    d.heading('Labor', 12);
    d.para(`${l.totals.hours} hours, ${money(l.totals.cost)} labor cost, ${l.totals.overtime_hours} overtime hours, ${l.totals.pending_hours} hours awaiting approval.`);
    if (l.employees.length) d.table([{ label: 'Employee', w: 40 }, { label: 'Hours', w: 20, align: 'right' }, { label: 'Overtime', w: 20, align: 'right' }, { label: 'Cost', w: 20, align: 'right' }], l.employees.slice(0, 20).map(e => [e.name, e.hours, e.overtime_hours, money(e.cost)]));
    const pp = f.projects.filter(p => p.invoiced || p.cost); if (pp.length) { d.heading('Project profitability (all recorded to date)', 12); d.table([{ label: 'Project', w: 40 }, { label: 'Invoiced', w: 20, align: 'right' }, { label: 'Cost', w: 20, align: 'right' }, { label: 'Margin', w: 20, align: 'right' }], pp.slice(0, 20).map(p => [p.name || '#' + p.id, money(p.invoiced), money(p.cost), p.margin == null ? 'no costs' : p.margin + '%'])); }
    d.footer(`Bright Cleaning Sev Inc. - business report ${rg.from} to ${rg.to}`);
    logAction(req, 'exported report PDF', 'report', 0, `${rg.from} to ${rg.to}`);
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="bright-clean-report-${rg.from}-to-${rg.to}.pdf"`); res.send(d.toBuffer());
  });

  // ---------- Scheduled report emails ----------
  function summaryText(rg) {
    const f = finance(rg), a = aging(), l = labor(rg);
    return [`Bright Clean business summary, ${rg.from} to ${rg.to}`, '', `Invoiced: ${money(f.invoiced)}   Collected on those: ${money(f.collected)}`, `Recorded costs: ${money(f.costs)}   Gross profit: ${money(f.gross_profit)}${f.margin != null ? ` (${f.margin}%)` : ''}`,
      `Open receivables: ${money(a.total)} — 61–90 days: ${money(a.buckets['61–90'])}, 90+ days: ${money(a.buckets['90+'])}`, `Labor: ${l.totals.hours} h, ${money(l.totals.cost)}, overtime ${l.totals.overtime_hours} h, awaiting approval ${l.totals.pending_hours} h`,
      ...(f.checks.length ? ['', 'Data checks:', ...f.checks.map(c => '- ' + c)] : []), '', `Full report and PDF: ${process.env.PUBLIC_URL || 'https://brightclean.net'}/admin/#reports`, '', f.basis].join('\n');
  }
  async function send(sch, rg) {
    const m = getMailer && getMailer(); if (!m) throw new Error('Email is not set up, so reports cannot be emailed.');
    const text = summaryText(rg), sent = [], failed = [];
    for (const to of sch.recipients.split(',').map(s => s.trim()).filter(Boolean)) {
      try { await m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || adminEmail, to, subject: `Bright Clean ${sch.frequency.toLowerCase()} report: ${rg.from} to ${rg.to}`, text }); sent.push(to); }
      catch (e) { failed.push(`${to}: ${e.message}`); }
    }
    if (sent.length) db.prepare('UPDATE report_schedules SET last_sent=? WHERE id=?').run(now(), sch.id);
    if (!sent.length) throw new Error('The report email could not be sent: ' + failed.join('; '));
    return { sent, failed };
  }
  const periodFor = (freq, d = new Date()) => {
    if (freq === 'Weekly') { const e = new Date(d); e.setDate(e.getDate() - 1); const s = new Date(e); s.setDate(s.getDate() - 6); return { from: s.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10) }; }
    const s = new Date(d.getFullYear(), d.getMonth() - 1, 1), e = new Date(d.getFullYear(), d.getMonth(), 0); return { from: s.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10) };
  };
  app.get('/api/admin/reports/schedules', auth, (req, res) => res.json({ schedules: db.prepare('SELECT * FROM report_schedules ORDER BY id').all(), email_ready: !!(getMailer && getMailer()) }));
  app.post('/api/admin/reports/schedules', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only owners and managers can schedule reports.' });
    const b = req.body || {}, freq = ['Weekly', 'Monthly'].includes(b.frequency) ? b.frequency : null; if (!freq) return res.status(400).json({ error: 'Choose weekly or monthly.' });
    const rec = String(b.recipients || '').split(',').map(s => clean(s, 254).toLowerCase()).filter(Boolean);
    if (!rec.length || rec.some(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) return res.status(400).json({ error: 'Enter one or more valid email addresses, separated by commas.' });
    const id = db.prepare('INSERT INTO report_schedules(frequency,recipients,created_by,created_at) VALUES(?,?,?,?)').run(freq, rec.join(', '), who(req), now()).lastInsertRowid;
    logAction(req, 'scheduled report', 'report', id, `${freq} to ${rec.join(', ')}`);
    res.status(201).json({ id });
  });
  app.delete('/api/admin/reports/schedules/:id', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only owners and managers can change scheduled reports.' });
    db.prepare('DELETE FROM report_schedules WHERE id=?').run(Number(req.params.id)); logAction(req, 'removed scheduled report', 'report', Number(req.params.id), ''); res.json({ ok: true });
  });
  app.post('/api/admin/reports/schedules/:id/send', auth, async (req, res) => {
    const s = db.prepare('SELECT * FROM report_schedules WHERE id=?').get(Number(req.params.id)); if (!s) return res.status(404).json({ error: 'Schedule not found.' });
    try { const rg = periodFor(s.frequency); const r = await send(s, rg); logAction(req, 'sent report now', 'report', s.id, r.sent.join(', ')); res.json({ ok: true, period: rg, ...r }); } catch (e) { res.status(502).json({ error: e.message }); }
  });
  // Hourly check: weekly reports go out Monday after 7:00, monthly on the 1st after 7:00 (server time), once per period.
  const sweep = async () => {
    const d = new Date(); if (d.getHours() < 7) return;
    for (const s of db.prepare('SELECT * FROM report_schedules WHERE active=1').all()) {
      const due = s.frequency === 'Weekly' ? d.getDay() === 1 : d.getDate() === 1; if (!due) continue;
      if (s.last_sent && s.last_sent.slice(0, 10) === d.toISOString().slice(0, 10)) continue;
      try { await send(s, periodFor(s.frequency, d)); } catch (e) { console.error('scheduled report failed:', e.message); }
    }
  };
  if (process.env.NODE_ENV !== 'test') setInterval(() => sweep().catch(() => {}), Number(process.env.REPORT_SWEEP_MS) || 3600000).unref();
  app.locals.reportSweep = sweep;
};
