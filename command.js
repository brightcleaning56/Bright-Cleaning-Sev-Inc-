// Bright Clean Command Center: real figures only. Modules that need an outside account report
// "not connected" with what is required, instead of showing sample data.
module.exports = function mountCommand(app, ctx) {
  const { db, auth } = ctx;

  db.exec(`CREATE TABLE IF NOT EXISTS payments(
    id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, amount REAL NOT NULL, note TEXT,
    received_at TEXT NOT NULL, recorded_by TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS payments_received ON payments(received_at);`);

  const iso = d => d.toISOString();
  const pct = (cur, prev) => prev > 0 ? Math.round((cur - prev) / prev * 100) : null;
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  app.get('/api/admin/command-center', auth, (req, res) => {
    const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const now = new Date();
    const from = iso(new Date(now - days * 864e5)), prevFrom = iso(new Date(now - 2 * days * 864e5));
    const monthStart = iso(new Date(now.getFullYear(), now.getMonth(), 1));
    const today = iso(now).slice(0, 10);

    const leadsIn = (a, b) => one(`SELECT COUNT(*) n FROM leads WHERE kind IN ('bid','inquiry') AND created_at>=? AND created_at<?`, a, b).n;
    const sentIn = (a, b) => one(`SELECT COUNT(*) n, COALESCE(SUM(proposal_total),0) v FROM estimates WHERE sent_at>=? AND sent_at<?`, a, b);
    const wonIn = (a, b) => one(`SELECT COUNT(*) n, COALESCE(SUM(proposal_total),0) v FROM estimates WHERE status='Approved' AND COALESCE(decided_at,updated_at)>=? AND COALESCE(decided_at,updated_at)<?`, a, b);
    const nowIso = iso(now);
    const leads = leadsIn(from, nowIso), leadsPrev = leadsIn(prevFrom, from);
    const sent = sentIn(from, nowIso), sentPrev = sentIn(prevFrom, from);
    const won = wonIn(from, nowIso), wonPrev = wonIn(prevFrom, from);
    const collectedMonth = one(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE received_at>=?`, monthStart).v;
    const activeProjects = one(`SELECT COUNT(*) n FROM projects WHERE status NOT IN ('Completed','On Hold','Cancelled')`).n;

    const overdueInvoices = one(`SELECT COUNT(*) n FROM invoices WHERE status NOT IN ('Paid','Void','Draft') AND due_date<>'' AND due_date IS NOT NULL AND due_date<? AND paid_amount<amount`, today).n;
    const lateProjects = one(`SELECT COUNT(*) n FROM projects WHERE status NOT IN ('Completed','On Hold','Cancelled') AND due_date<>'' AND due_date IS NOT NULL AND due_date<?`, today).n;
    const staleLeads = one(`SELECT COUNT(*) n FROM leads WHERE kind IN ('bid','inquiry') AND status='New' AND created_at<?`, iso(new Date(now - 2 * 864e5))).n;
    const failedEmails = one(`SELECT COUNT(*) n FROM automation_log WHERE status='failed' AND created_at>=?`, iso(new Date(now - 7 * 864e5))).n;

    const pipeline = [
      { stage: 'Open bid requests', ...one(`SELECT COUNT(*) n, 0 v FROM leads WHERE kind='bid' AND status NOT IN ('Won','Lost','Archived')`), valued: false },
      { stage: 'Estimates in progress', ...one(`SELECT COUNT(*) n, COALESCE(SUM(proposal_total),0) v FROM estimates WHERE status IN ('Draft','Ready')`), valued: true },
      { stage: 'Proposals with customers', ...one(`SELECT COUNT(*) n, COALESCE(SUM(proposal_total),0) v FROM estimates WHERE status IN ('Sent','Viewed')`), valued: true },
      { stage: `Won (last ${days} days)`, n: won.n, v: won.v, valued: true }
    ];

    const scopes = one(`SELECT COUNT(*) total, SUM(production_rate IS NULL OR (unit_price IS NULL AND pricing_method<>'hourly') OR crew_size IS NULL) missing FROM scope_items WHERE active=1`);
    const emailReady = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    const aiKey = !!process.env.ANTHROPIC_API_KEY;

    res.json({
      days,
      kpis: {
        new_leads: { value: leads, change: pct(leads, leadsPrev) },
        proposals_sent: { value: sent.n, amount: sent.v, change: pct(sent.n, sentPrev.n) },
        won: { value: won.n, amount: won.v, change: pct(won.n, wonPrev.n) },
        collected_month: { value: collectedMonth },
        active_projects: { value: activeProjects },
        attention: { value: overdueInvoices + lateProjects + staleLeads + failedEmails,
          parts: { overdue_invoices: overdueInvoices, late_projects: lateProjects, leads_waiting_2_days: staleLeads, failed_emails_7_days: failedEmails } }
      },
      pipeline,
      activity: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 6').all(),
      modules: {
        email: { connected: emailReady, label: 'Email', status: emailReady ? 'Sending enabled (outgoing only)' : 'Not set up',
          needs: emailReady ? 'Inbox inside Bright Clean needs a Microsoft 365 app registration.' : 'Turn on Authenticated SMTP for info@brightclean.net and add SMTP_PASS in Render. The full inbox needs a Microsoft 365 app registration.' },
        calls: { connected: false, label: 'Call Center', status: 'Not connected', needs: 'A business phone provider with an API (for example Twilio, RingCentral or OpenPhone) and a call-recording disclosure policy.' },
        blueprint: { connected: false, label: 'Blueprint AI', status: aiKey ? 'Key present, module not built yet' : 'Not connected', needs: 'An Anthropic API key in Render, then the blueprint pilot on one real drawing package.' },
        scopes: { connected: scopes.total > 0 && !scopes.missing, label: 'Cleaning scopes', status: scopes.missing ? `${scopes.missing} of ${scopes.total} items need rates` : 'All items priced', needs: scopes.missing ? 'Enter your production rates, crew sizes and prices under Cleaning scopes.' : '' }
      }
    });
  });
};
