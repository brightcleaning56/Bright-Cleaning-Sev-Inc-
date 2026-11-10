// Data integrity report (owner only). The database has no enforced foreign keys, so the app relies on
// checks like this one: it counts records that point at a parent that no longer exists, duplicate customer
// keys, and invoices whose paid amount does not match their payment history.
// It only reads. It never changes data.
module.exports = function mountIntegrity(app, ctx) {
  const { db, auth } = ctx;

  // child table, link column, parent table, label
  const LINKS = [
    ['invoices', 'project_id', 'projects', 'invoice → project'],
    ['invoices', 'customer_id', 'customers', 'invoice → customer'],
    ['payments', 'invoice_id', 'invoices', 'payment → invoice'],
    ['projects', 'contract_id', 'contracts', 'project → contract'],
    ['projects', 'customer_id', 'customers', 'project → customer'],
    ['contracts', 'estimate_id', 'estimates', 'contract → proposal'],
    ['visits', 'project_id', 'projects', 'visit → project'],
    ['inspections', 'project_id', 'projects', 'inspection → project'],
    ['project_tasks', 'project_id', 'projects', 'task → project'],
    ['leads', 'customer_id', 'customers', 'lead → customer'],
  ];

  function run() {
    const checks = [];
    for (const [child, col, parent, label] of LINKS) {
      try {
        const n = db.prepare(`SELECT COUNT(*) n FROM ${child} c WHERE c.${col} IS NOT NULL AND c.${col} <> '' AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.id = c.${col})`).get().n;
        checks.push({ check: 'Orphaned link: ' + label, count: n, ok: n === 0 });
      } catch (e) {
        checks.push({ check: 'Orphaned link: ' + label, count: null, ok: null, note: 'not checked: ' + e.message });
      }
    }
    try {
      const n = db.prepare("SELECT COUNT(*) n FROM (SELECT match_key FROM customers WHERE match_key IS NOT NULL AND match_key <> '' GROUP BY match_key HAVING COUNT(*) > 1)").get().n;
      checks.push({ check: 'Duplicate customer keys', count: n, ok: n === 0 });
    } catch (e) { checks.push({ check: 'Duplicate customer keys', count: null, ok: null, note: e.message }); }
    try {
      const n = db.prepare(`SELECT COUNT(*) n FROM invoices i WHERE ABS(COALESCE(i.paid_amount,0) - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id),0)) > 0.005`).get().n;
      checks.push({ check: 'Invoice paid amount matches payment history', count: n, ok: n === 0, note: n ? 'Invoices recorded before payment history was kept can differ. Review them before relying on collected totals.' : undefined });
    } catch (e) { checks.push({ check: 'Invoice paid amount matches payment history', count: null, ok: null, note: e.message }); }
    try {
      const n = db.prepare('SELECT COUNT(*) n FROM invoices WHERE COALESCE(paid_amount,0) > COALESCE(amount,0) + 0.005').get().n;
      checks.push({ check: 'Invoices paid above their amount', count: n, ok: n === 0 });
    } catch (e) { checks.push({ check: 'Invoices paid above their amount', count: null, ok: null, note: e.message }); }
    const failing = checks.filter(c => c.ok === false).length, unchecked = checks.filter(c => c.ok === null).length;
    return { ok: failing === 0, failing, unchecked, checked_at: new Date().toISOString(), checks };
  }

  app.get('/api/admin/integrity', auth, (req, res) => res.json(run()));
  app.locals.runIntegrityCheck = run;
};
