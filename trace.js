// Document trace for accountants (read only). Starting from any estimate, contract, project, invoice or subscription,
// it follows the links and shows the whole chain with the money at each step, and where each piece sits on the ledger:
//   estimate (proposal) -> contract(s) and amendments/renewals -> project -> invoices -> payments
//   subscription -> its invoices (billed monthly) ; ledger entries for each invoice, payment and job cost.
// It changes nothing. Gaps and differences are listed, not hidden.

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hasCol = (db, t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);
const all = (db, sql, args) => db.prepare(sql).all(...args);
const one = (db, sql, args) => db.prepare(sql).get(...args);
const marks = list => list.map(() => '?').join(',');

// Works out the set of ids that make up the chain, starting from one document.
function chainFor(db, kind, id) {
  const c = { estimates: new Set(), contracts: new Set(), projects: new Set(), invoices: new Set(), subscriptions: new Set() };
  const hasSub = hasTable(db, 'subscriptions'), hasInv = hasTable(db, 'invoices');
  const addEstimate = eid => { if (eid) c.estimates.add(Number(eid)); };
  const start = {
    estimate: () => { const e = one(db, 'SELECT id FROM estimates WHERE id=?', [id]); if (!e) return false; addEstimate(e.id); return true; },
    contract: () => { const k = one(db, 'SELECT id, estimate_id FROM contracts WHERE id=?', [id]); if (!k) return false; c.contracts.add(k.id); addEstimate(k.estimate_id); return true; },
    project: () => { const p = one(db, 'SELECT id, contract_id, estimate_id FROM projects WHERE id=?', [id]); if (!p) return false; c.projects.add(p.id); addEstimate(p.estimate_id); if (p.contract_id) c.contracts.add(Number(p.contract_id)); return true; },
    invoice: () => { if (!hasInv) return false; const i = one(db, 'SELECT id, project_id, subscription_id FROM invoices WHERE id=?', [id]); if (!i) return false; c.invoices.add(i.id); if (i.project_id) c.projects.add(Number(i.project_id)); if (i.subscription_id) c.subscriptions.add(Number(i.subscription_id)); return true; },
    subscription: () => { if (!hasSub) return false; const s = one(db, 'SELECT id, project_id FROM subscriptions WHERE id=?', [id]); if (!s) return false; c.subscriptions.add(s.id); if (s.project_id) c.projects.add(Number(s.project_id)); return true; }
  }[kind];
  if (!start || !start()) return null;
  // Widen: contracts <-> estimates, projects <-> contracts/estimates, and so on, until nothing new appears.
  for (let pass = 0; pass < 4; pass++) {
    const before = JSON.stringify([...c.estimates, ...c.contracts, ...c.projects, ...c.invoices, ...c.subscriptions].sort());
    if (c.estimates.size) for (const r of all(db, `SELECT id FROM contracts WHERE estimate_id IN (${marks([...c.estimates])})`, [...c.estimates])) c.contracts.add(r.id);
    if (c.contracts.size) {
      for (const r of all(db, `SELECT id, estimate_id FROM contracts WHERE id IN (${marks([...c.contracts])})`, [...c.contracts])) addEstimate(r.estimate_id);
      for (const r of all(db, `SELECT id FROM contracts WHERE renewed_from IN (${marks([...c.contracts])}) OR parent_id IN (${marks([...c.contracts])})`, [...c.contracts, ...c.contracts])) c.contracts.add(r.id);
      for (const r of all(db, `SELECT id FROM projects WHERE contract_id IN (${marks([...c.contracts])})`, [...c.contracts])) c.projects.add(r.id);
    }
    if (c.estimates.size) for (const r of all(db, `SELECT id FROM projects WHERE estimate_id IN (${marks([...c.estimates])})`, [...c.estimates])) c.projects.add(r.id);
    if (c.projects.size) {
      for (const r of all(db, `SELECT id, contract_id, estimate_id FROM projects WHERE id IN (${marks([...c.projects])})`, [...c.projects])) { addEstimate(r.estimate_id); if (r.contract_id) c.contracts.add(Number(r.contract_id)); }
      if (hasInv) for (const r of all(db, `SELECT id, subscription_id FROM invoices WHERE project_id IN (${marks([...c.projects])})`, [...c.projects])) { c.invoices.add(r.id); if (r.subscription_id) c.subscriptions.add(Number(r.subscription_id)); }
      if (hasSub) for (const r of all(db, `SELECT id FROM subscriptions WHERE project_id IN (${marks([...c.projects])})`, [...c.projects])) c.subscriptions.add(r.id);
    }
    if (c.subscriptions.size && hasInv) for (const r of all(db, `SELECT id, project_id FROM invoices WHERE subscription_id IN (${marks([...c.subscriptions])})`, [...c.subscriptions])) { c.invoices.add(r.id); if (r.project_id) c.projects.add(Number(r.project_id)); }
    if (JSON.stringify([...c.estimates, ...c.contracts, ...c.projects, ...c.invoices, ...c.subscriptions].sort()) === before) break;
  }
  return c;
}

function entriesFor(db, refs) {
  if (!hasTable(db, 'ledger_entries') || !refs.length) return [];
  return all(db, `SELECT e.id, e.entry_date, e.memo, e.source, e.source_ref, e.reverses_id FROM ledger_entries e WHERE e.source_ref IN (${marks(refs)}) ORDER BY e.id`, refs);
}

function traceDocument(db, kind, id) {
  const c = chainFor(db, kind, Number(id));
  if (!c) return null;
  const ids = (set) => [...set].sort((a, b) => a - b);
  const estimates = all(db, `SELECT id, project_name, customer_name, status, proposal_total, total_cost, labor_hours FROM estimates WHERE id IN (${marks(ids(c.estimates)) || 'NULL'})`, ids(c.estimates));
  const contracts = c.contracts.size ? all(db, `SELECT id, estimate_id, kind, status, signature_status, value, renewed_from, parent_id FROM contracts WHERE id IN (${marks(ids(c.contracts))})`, ids(c.contracts)) : [];
  const projects = c.projects.size ? all(db, `SELECT id, name, contract_id, estimate_id, status FROM projects WHERE id IN (${marks(ids(c.projects))})`, ids(c.projects)) : [];
  const subscriptions = (hasTable(db, 'subscriptions') && c.subscriptions.size) ? all(db, `SELECT id, project_id, customer_name, service, monthly_amount, status, start_date, end_date FROM subscriptions WHERE id IN (${marks(ids(c.subscriptions))})`, ids(c.subscriptions)) : [];
  const invoices = (hasTable(db, 'invoices') && c.invoices.size) ? all(db, `SELECT id, invoice_number, project_id, subscription_id, billing_period, amount, ${hasCol(db, 'invoices', 'tax_amount') ? 'tax_amount' : '0 AS tax_amount'}, status, due_date FROM invoices WHERE id IN (${marks(ids(c.invoices))})`, ids(c.invoices)) : [];
  const payments = (hasTable(db, 'payments') && invoices.length) ? all(db, `SELECT id, invoice_id, amount, received_at FROM payments WHERE invoice_id IN (${marks(invoices.map(i => i.id))}) ORDER BY id`, invoices.map(i => i.id)) : [];
  const paidOf = iid => r2(payments.filter(p => p.invoice_id === iid).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const ledgerRefs = [...invoices.map(i => 'invoice:' + i.id), ...payments.map(p => 'payment:' + p.id), ...(hasTable(db, 'project_costs') && projects.length ? all(db, `SELECT id FROM project_costs WHERE project_id IN (${marks(projects.map(p => p.id))})`, projects.map(p => p.id)).map(x => 'project-cost:' + x.id) : [])];
  const ledger = entriesFor(db, ledgerRefs);
  // Figures and the differences an accountant would ask about.
  const sumOf = (list, f) => r2(list.reduce((s, x) => s + (Number(f(x)) || 0), 0));
  const contractValue = require('./contract-value').summary(contracts).value; // same rule as the reports
  const projectInvoices = invoices.filter(i => !i.subscription_id);
  const subInvoices = invoices.filter(i => i.subscription_id);
  const invoiced = sumOf(projectInvoices, i => i.amount), invoicedTax = sumOf(projectInvoices, i => i.tax_amount);
  const subInvoiced = sumOf(subInvoices, i => i.amount), paid = sumOf(payments, p => p.amount);
  const estimateTotal = sumOf(estimates.slice(0, 1), e => e.proposal_total);
  const estimateCost = sumOf(estimates.slice(0, 1), e => e.total_cost);
  const notes = [];
  if (estimates.length && contracts.length) {
    const cv = contracts.find(k => (k.kind || 'Contract') === 'Contract');
    if (cv && Math.abs((Number(cv.value) || 0) - estimateTotal) > 0.005) notes.push(`The contract value (${r2(cv.value).toFixed(2)}) differs from the estimate's proposal total (${estimateTotal.toFixed(2)}).`);
  }
  if (contracts.some(k => k.kind === 'Amendment')) notes.push('Amendments are in the chain. Each signed amendment adds its value to the contract value.');
  if (contracts.some(k => k.kind === 'Renewal')) notes.push('Renewals are in the chain and are counted in contracted value once they are signed.');
  if (invoices.length && contracts.length && invoiced > 0 && projectInvoices.length) {
    const cv = sumOf(contracts.filter(k => (k.kind || 'Contract') === 'Contract' && k.signature_status && ['Signed', 'Executed', 'Fully signed'].includes(k.signature_status)), k => k.value);
    if (cv && Math.abs(cv - invoiced) > 0.005) notes.push(`Project invoices total ${invoiced.toFixed(2)} against a signed contract of ${cv.toFixed(2)}. Billing is not complete or differs from the contract.`);
  }
  if (subInvoices.length) notes.push('Subscription invoices are billed each period. They are shown separately from project invoices.');
  if (invoices.some(i => !ledger.some(e => e.source_ref === 'invoice:' + i.id && !e.reverses_id))) notes.push('Some invoices are not on the ledger yet (run the ledger sync after you have checked them).');
  if (payments.some(p => !invoices.some(i => i.id === p.invoice_id))) notes.push('Some payments in this chain point to invoices outside it.');
  return {
    start: { kind, id: Number(id) },
    estimates: estimates.map(e => ({ ...e, proposal_total: r2(e.proposal_total), total_cost: r2(e.total_cost) })),
    contracts, projects, subscriptions,
    invoices: invoices.map(i => ({ ...i, amount: r2(i.amount), tax_amount: r2(i.tax_amount), paid: paidOf(i.id), balance: r2((Number(i.amount) || 0) + (Number(i.tax_amount) || 0) - paidOf(i.id)), on_ledger: ledger.some(e => e.source_ref === 'invoice:' + i.id && !e.reverses_id) })),
    payments,
    ledger_entries: ledger,
    figures: { estimate_proposal_total: estimateTotal, estimate_cost: estimateCost, contract_value: contractValue, project_invoiced: invoiced, project_sales_tax: invoicedTax,
      subscription_invoiced: subInvoiced, paid, owed: r2(invoiced + invoicedTax + subInvoiced - paid) },
    notes
  };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  app.get('/api/admin/accounting/trace', auth, (req, res) => {
    const kind = String(req.query.kind || ''), id = Number(req.query.id);
    if (!['estimate', 'contract', 'project', 'invoice', 'subscription'].includes(kind)) return res.status(400).json({ error: 'Choose estimate, contract, project, invoice or subscription.' });
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Enter the number of the document.' });
    const t = traceDocument(db, kind, id);
    if (!t) return res.status(404).json({ error: 'No ' + kind + ' with that number.' });
    res.json(t);
  });
}

module.exports = { traceDocument, chainFor, mount };
