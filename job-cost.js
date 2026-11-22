// Job costing for one project (Phase 3 of the accounting plan). Read-only: it reports, it posts nothing.
// Actual cost = recorded project costs (labor posted from approved time, plus materials, equipment, subcontractors, travel, other)
//             + approved time not yet posted to a cost (hours x the employee's hourly rate).
// The same split reports2.js uses, so labor is never counted twice.
// Projected = the estimate's cost and price. Actual gross profit is shown beside it, never mixed into it.
// Known gaps, shown in the report and not hidden: labor burden is added only when the owner sets a burden rate; no revenue-recognition policy yet, so earned revenue is not calculated.

// Category words people type -> the ledger cost account they belong to (Phase 4 posts to these).
const CATEGORY_ACCOUNT = [
  [/labou?r|crew|wage|payroll/i, '5000', 'Direct labor'],
  [/material|suppl|consumable|chemical|paper|soap/i, '5100', 'Materials and supplies'],
  [/equipment|rental|rent|machine|lift|tool/i, '5200', 'Equipment and rentals'],
  [/subcontract|sub\b|vendor|outside/i, '5300', 'Subcontractors'],
  [/travel|mileage|disposal|haul|dump|dumpster|fuel|mobiliz/i, '5400', 'Travel and disposal']
];
function accountFor(category) {
  for (const [re, code, name] of CATEGORY_ACCOUNT) if (re.test(String(category || ''))) return { code, name };
  // A cost on a project is a job cost even when its category is general (Other): it stays with the job, not in overhead.
  return { code: '5900', name: 'Other job costs' };
}
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const LB = require('./labor');
const hasCol = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

function jobCostReport(db, projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(Number(projectId));
  if (!p) return null;
  // Recorded costs, grouped by the ledger account they belong to.
  const costs = hasTable(db, 'project_costs') ? db.prepare('SELECT category, amount FROM project_costs WHERE project_id=?').all(p.id) : [];
  const byAccount = {};
  for (const c of costs) {
    const a = accountFor(c.category);
    byAccount[a.code] = byAccount[a.code] || { code: a.code, name: a.name, amount: 0 };
    byAccount[a.code].amount += Number(c.amount) || 0;
  }
  // Approved time that has not been posted to a cost yet (cost_id is empty).
  let unposted = 0, unpostedMinutes = 0;
  if (hasTable(db, 'time_entries') && hasTable(db, 'employees')) {
    LB.ensureColumns(db);
    const rows = db.prepare(`SELECT t.minutes, t.labor_cost, ${db.prepare('PRAGMA table_info(time_entries)').all().some(c => c.name === 'labor_rate') ? 'COALESCE(t.labor_rate, e.hourly_rate)' : 'e.hourly_rate'} AS hourly_rate FROM time_entries t JOIN employees e ON e.id=t.employee_id
      WHERE t.project_id=? AND t.approved_by IS NOT NULL AND t.cost_id IS NULL`).all(p.id);
    for (const t of rows) { unpostedMinutes += Number(t.minutes) || 0; unposted += LB.storedCost(t); }
  }
  if (unposted) {
    byAccount['5000'] = byAccount['5000'] || { code: '5000', name: 'Direct labor', amount: 0 };
    byAccount['5000'].amount += unposted;
  }
  const lines = Object.values(byAccount).map(l => ({ ...l, amount: r2(l.amount) })).sort((a, b) => a.code.localeCompare(b.code));
  const actualCost = r2(lines.reduce((s, l) => s + l.amount, 0));

  // Contract value: the contract on the project, when one is linked.
  let contractValue = null, contractNote = null;
  if (p.contract_id && hasTable(db, 'contracts')) {
    const k = db.prepare('SELECT value, kind, status FROM contracts WHERE id=?').get(p.contract_id);
    if (k) { contractValue = r2(k.value); if ((k.kind || 'Contract') !== 'Contract') contractNote = 'Linked contract is a ' + k.kind.toLowerCase() + ', not the original.'; }
  }
  // Projected: the estimate the project came from.
  let budgetCost = null, budgetPrice = null, budgetHours = null, budgetNote = null;
  if (p.estimate_id && hasTable(db, 'estimates')) {
    const e = db.prepare('SELECT proposal_total, total_cost, labor_hours FROM estimates WHERE id=?').get(p.estimate_id);
    if (e) { budgetCost = r2(e.total_cost); budgetPrice = r2(e.proposal_total); budgetHours = Number(e.labor_hours) || 0; }
  } else budgetNote = 'No estimate is linked to this project, so there is no projected cost.';

  // Overhead allocated to the job at the estimate's overhead rate (audit G7). Shown beside the cost, not posted.
  let overheadPct = 0;
  if (p.estimate_id && hasTable(db, 'estimates') && hasCol(db, 'estimates', 'overhead_pct')) {
    const e = db.prepare('SELECT overhead_pct FROM estimates WHERE id=?').get(p.estimate_id);
    overheadPct = e ? Number(e.overhead_pct) || 0 : 0;
  }
  const allocatedOverhead = r2(actualCost * overheadPct / 100);
  // Burden rate (zero until the owner sets it), and what the project has invoiced and collected (issued invoices only, not drafts or voids).
  let burdenRate = 0;
  try { const r = db.prepare("SELECT value FROM settings WHERE key='ledger_burden_pct'").get(); burdenRate = Number(r && r.value) || 0; } catch { /* no settings yet */ }
  let invoicedTotal = null, collectedTotal = null;
  if (hasTable(db, 'invoices')) {
    const t = db.prepare(`SELECT COALESCE(SUM(amount + COALESCE(tax_amount,0)),0) inv, COALESCE(SUM(COALESCE(paid_amount,0)),0) paid
      FROM invoices WHERE project_id=? AND status NOT IN ('Draft','Void')`).get(p.id);
    invoicedTotal = r2(t.inv); collectedTotal = r2(t.paid);
  }
  const price = contractValue != null ? contractValue : budgetPrice;
  const priceSource = contractValue != null ? 'contract' : (budgetPrice != null ? 'estimate (no contract linked)' : null);
  return {
    project_id: p.id, project: p.name, customer: p.customer_name, company: p.company,
    projected: { price: budgetPrice, cost: budgetCost, labor_hours: budgetHours, gross_profit: budgetPrice != null && budgetCost != null ? r2(budgetPrice - budgetCost) : null,
      gross_margin_pct: budgetPrice > 0 && budgetCost != null ? r2((budgetPrice - budgetCost) / budgetPrice * 100) : null, note: budgetNote },
    // Contract-basis figures: the full contract value less actual cost. This is NOT earned profit (no revenue-recognition policy is approved yet),
    // so it is named for what it is. Earned revenue is not calculated here.
    actual: { contract_basis_value: price, contract_basis_source: priceSource, cost: actualCost,
      contract_basis_profit: price != null ? r2(price - actualCost) : null,
      contract_basis_margin_pct: price > 0 ? r2((price - actualCost) / price * 100) : null,
      overhead_rate_pct: overheadPct, allocated_overhead: allocatedOverhead, contract_basis_profit_after_overhead: price != null ? r2(price - actualCost - allocatedOverhead) : null,
      earned_revenue: null, earned_revenue_note: 'Not calculated: the revenue-recognition policy (percent complete or milestone) is not approved yet.',
      invoiced: invoicedTotal, collected: collectedTotal,
      unposted_labor: r2(unposted), unposted_labor_hours: r2(unpostedMinutes / 60), contract_note: contractNote },
    cost_by_account: lines,
    gaps: [
      burdenRate > 0 ? null : 'Labor burden is not added: the owner has not set a burden rate (Rates and thresholds).',
      'Overtime is included: approved hours over the weekly threshold are costed at 1.5 times the rate when the time is approved.',
      'Task-level budgets and cost are on the task costs report for this project.',
      'Overhead is allocated at the estimate rate on actual cost, shown separately, and is not posted.',
      'Earned revenue is not calculated yet (revenue-recognition policy pending). Contract-basis figures are not earned profit.'
    ].filter(Boolean)
  };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  app.get('/api/admin/projects/:id/job-cost', auth, (req, res) => {
    const r = jobCostReport(db, req.params.id);
    if (!r) return res.status(404).json({ error: 'Project not found.' });
    res.json(r);
  });
}

module.exports = { jobCostReport, accountFor, CATEGORY_ACCOUNT, mount };
