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
    const today = require('./bizdate').today(now);

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
    const iss = one(`SELECT SUM(type='complaint') complaints, SUM(due_date IS NOT NULL AND due_date<>'' AND due_date<?) overdue FROM customer_issues WHERE status NOT IN ('Resolved','Verified','Closed')`, today);
    const openComplaints = iss.complaints || 0, overdueItems = iss.overdue || 0;
    const awaitingApproval = require('./approvals').pendingCount();
    const failedEmails = one(`SELECT COUNT(*) n FROM automation_log WHERE status='failed' AND kind NOT LIKE 'ai_%' AND created_at>=?`, iso(new Date(now - 7 * 864e5))).n;

    const pipeline = [
      { stage: 'Open bid requests', ...one(`SELECT COUNT(*) n, 0 v FROM leads WHERE kind='bid' AND status NOT IN ('Won','Lost','Archived')`), valued: false },
      { stage: 'Estimates in progress', ...one(`SELECT COUNT(*) n, COALESCE(SUM(proposal_total),0) v FROM estimates WHERE status IN ('Draft','Ready')`), valued: true },
      { stage: 'Proposals with customers', ...one(`SELECT COUNT(*) n, COALESCE(SUM(proposal_total),0) v FROM estimates WHERE status IN ('Sent','Viewed')`), valued: true },
      { stage: `Won (last ${days} days)`, n: won.n, v: won.v, valued: true }
    ];

    const scopes = one(`SELECT COUNT(*) total, SUM(CASE WHEN pricing_method='hourly' THEN (production_rate IS NULL OR production_rate<=0) ELSE unit_price IS NULL END) missing FROM scope_items WHERE active=1`);
    const viaPostmark = !!process.env.POSTMARK_TOKEN;
    const emailReady = viaPostmark || !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    const aiKey = !!process.env.ANTHROPIC_API_KEY;

    res.json({
      days,
      kpis: {
        new_leads: { value: leads, change: pct(leads, leadsPrev) },
        proposals_sent: { value: sent.n, amount: sent.v, change: pct(sent.n, sentPrev.n) },
        won: { value: won.n, amount: won.v, change: pct(won.n, wonPrev.n) },
        collected_month: { value: collectedMonth },
        active_projects: { value: activeProjects },
        attention: { value: overdueInvoices + lateProjects + staleLeads + failedEmails + openComplaints + overdueItems + awaitingApproval,
          parts: { awaiting_approval: awaitingApproval, open_complaints: openComplaints, overdue_tasks: overdueItems, overdue_invoices: overdueInvoices, late_projects: lateProjects, leads_waiting_2_days: staleLeads, failed_emails_7_days: failedEmails } }
      },
      pipeline,
      activity: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 6').all(),
      modules: {
        email: { connected: emailReady, label: 'Email', status: emailReady ? `Sending enabled via ${viaPostmark ? 'Postmark' : 'Microsoft 365'} (outgoing only)` : 'Not set up',
          needs: emailReady ? 'Inbox inside Bright Clean needs a Microsoft 365 app registration.' : 'Add POSTMARK_TOKEN in Render (Postmark server API token). The full inbox needs a Microsoft 365 app registration.' },
        calls: process.env.TWILIO_AUTH_TOKEN ? { connected: true, label: 'Call Center', status: 'Connected (Twilio): calls ring your phones, log, record and transcribe automatically', needs: '' } : { connected: false, label: 'Call Center', status: 'Not connected', needs: 'Add TWILIO_AUTH_TOKEN in Render and point the Twilio number at /api/webhooks/twilio/voice.' },
        blueprint: { connected: aiKey, label: 'AI (takeoff & leads)', status: aiKey ? 'On: leads are triaged automatically; AI takeoff runs from Drawings' : 'Off', needs: aiKey ? '' : 'Add ANTHROPIC_API_KEY in Render to turn on AI lead triage, reply drafts, call notes and drawing takeoff.' },
        scopes: { connected: scopes.total > 0 && !scopes.missing, label: 'Cleaning scopes', status: scopes.missing ? `${scopes.total - scopes.missing} of ${scopes.total} items priced` : 'All items priced', needs: scopes.missing ? `${scopes.missing} items have no price yet. Price or archive them under Cleaning scopes; import the price book for your standard rates.` : '' }
      }
    });
  });

  // ---- Live metrics with drill-down. Each metric is defined ONCE; the same WHERE builds the count and the list,
  // so the number on the card always matches the records behind it. ----
  const bd = () => require('./bizdate').today(), addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const since = days => new Date(Date.now() - days * 864e5).toISOString();
  const OPEN_ISSUE = "status NOT IN ('Resolved','Verified','Closed')";
  const M = [
    // Sales
    { key: 'new_leads', group: 'Sales', label: 'New leads', table: 'leads', where: d => ["kind IN ('bid','inquiry') AND created_at>=?", [since(d)]], title: "COALESCE(company,contact_name,'Lead')", sub: "COALESCE(service,project_name,status)", date: 'created_at', view: 'leads', open: 'lead', period: true },
    { key: 'uncontacted_leads', group: 'Sales', label: 'Leads not contacted (2+ days)', table: 'leads', where: () => ["kind IN ('bid','inquiry') AND status='New' AND created_at<?", [since(2)]], title: "COALESCE(company,contact_name,'Lead')", sub: "COALESCE(phone,email,'')", date: 'created_at', view: 'leads', open: 'lead', alert: true },
    { key: 'bids_due_7', group: 'Sales', label: 'Bids due in 7 days', table: 'leads', where: () => ["kind='bid' AND bid_due_date>=? AND bid_due_date<=? AND status NOT IN ('Won','Lost','Archived','Proposal Sent')", [bd(), addDays(bd(), 7)]], title: "COALESCE(project_name,company,'Bid')", sub: "'Due '||bid_due_date", date: 'bid_due_date', view: 'leads', open: 'lead', alert: true },
    { key: 'estimates_in_progress', group: 'Sales', label: 'Estimates in progress', table: 'estimates', where: () => ["status IN ('Draft','Ready')", []], title: "COALESCE(project_name,company,customer_name)", sub: "status", amount: 'proposal_total', date: 'created_at', view: 'proposals', open: 'estimate' },
    { key: 'proposals_awaiting', group: 'Sales', label: 'Proposals awaiting the customer', table: 'estimates', where: () => ["status IN ('Sent','Viewed')", []], title: "COALESCE(project_name,company,customer_name)", sub: "status", amount: 'proposal_total', date: 'sent_at', view: 'proposals', open: 'estimate' },
    { key: 'contracts_unsigned', group: 'Sales', label: 'Contracts not yet signed', table: 'contracts', where: () => ["COALESCE(signature_status,'Not sent')<>'Signed' AND status NOT IN ('Closed','Cancelled','Void','Archived')", []], title: "COALESCE(title,company,customer_name)", sub: "COALESCE(signature_status,'Not sent')", amount: 'value', date: 'created_at', view: 'contracts', open: 'contract' },
    // Operations
    { key: 'jobs_today', group: 'Operations', label: 'Jobs today', table: 'visits', where: () => ["date=? AND COALESCE(status,'') NOT IN ('Cancelled')", [bd()]], title: 'title', sub: "COALESCE(start_time,'')||CASE WHEN dispatched_at IS NULL THEN ' · not dispatched' ELSE ' · dispatched' END", date: 'date', view: 'schedule' },
    { key: 'not_dispatched', group: 'Operations', label: 'Jobs next 2 days not dispatched', table: 'visits', where: () => ["date>=? AND date<=? AND dispatched_at IS NULL AND COALESCE(status,'') NOT IN ('Cancelled','Completed')", [bd(), addDays(bd(), 2)]], title: 'title', sub: "date||' '||COALESCE(start_time,'')", date: 'date', view: 'schedule', alert: true },
    { key: 'failed_inspections', group: 'Operations', label: 'Failed inspections (period)', table: 'inspections', where: d => ["passed=0 AND COALESCE(date,created_at)>=?", [since(d).slice(0, 10)]], title: 'area', sub: "'Score '||COALESCE(score,'—')", date: 'date', view: 'quality', alert: true, period: true },
    { key: 'overdue_tasks', group: 'Operations', label: 'Overdue tasks & issues', table: 'customer_issues', where: () => [OPEN_ISSUE + " AND due_date IS NOT NULL AND due_date<>'' AND due_date<?", [bd()]], title: 'title', sub: "'Due '||due_date||' · '||priority", date: 'due_date', view: 'issues', open: 'issue', alert: true },
    { key: 'open_complaints', group: 'Operations', label: 'Open complaints', table: 'customer_issues', where: () => [OPEN_ISSUE + " AND type='complaint'", []], title: 'title', sub: "priority||' · '||status", date: 'created_at', view: 'issues', open: 'issue', alert: true },
    { key: 'late_projects', group: 'Operations', label: 'Late projects', table: 'projects', where: () => ["status NOT IN ('Completed','On Hold','Cancelled','Archived') AND due_date IS NOT NULL AND due_date<>'' AND due_date<?", [bd()]], title: "COALESCE(name,company)", sub: "'Due '||due_date||' · '||status", date: 'due_date', view: 'projects', open: 'project', alert: true },
    // Finance
    { key: 'outstanding', group: 'Finance', label: 'Outstanding invoices', table: 'invoices', where: () => ["status NOT IN ('Paid','Void','Draft') AND COALESCE(paid_amount,0)<amount", []], title: "invoice_number||' · '||COALESCE(company,customer_name,'')", sub: "'Due '||COALESCE(due_date,'—')", amount: 'amount-COALESCE(paid_amount,0)', date: 'due_date', view: 'invoices', open: 'invoice' },
    { key: 'overdue_invoices', group: 'Finance', label: 'Overdue invoices', table: 'invoices', where: () => ["status NOT IN ('Paid','Void','Draft') AND COALESCE(paid_amount,0)<amount AND due_date IS NOT NULL AND due_date<>'' AND due_date<?", [bd()]], title: "invoice_number||' · '||COALESCE(company,customer_name,'')", sub: "'Due '||due_date", amount: 'amount-COALESCE(paid_amount,0)', date: 'due_date', view: 'invoices', open: 'invoice', alert: true },
    { key: 'collected', group: 'Finance', label: 'Collected (period)', table: 'payments p JOIN invoices i ON i.id=p.invoice_id LEFT JOIN projects pr ON pr.id=i.project_id', where: (d, q) => q && q.service ? ["p.received_at>=? AND COALESCE(NULLIF(pr.service,''),'Unassigned')=?", [since(d).slice(0, 10), String(q.service).slice(0, 80)]] : ["p.received_at>=?", [since(d).slice(0, 10)]], title: "i.invoice_number||' · '||COALESCE(i.company,i.customer_name,'')", sub: "'Payment '||p.received_at", amount: 'p.amount', date: 'p.received_at', id: 'i.id', view: 'invoices', open: 'invoice', period: true },
    { key: 'unbilled', group: 'Finance', label: 'Completed work not invoiced', table: 'projects', where: () => ["status='Completed' AND NOT EXISTS (SELECT 1 FROM invoices x WHERE x.project_id=projects.id AND x.status<>'Void')", []], title: "COALESCE(name,company)", sub: "'Completed · no invoice'", date: 'created_at', view: 'projects', open: 'project', alert: true },
    // Calls & AI
    // Management
    { key: 'won_value', group: 'Management', label: 'Won value (period)', table: 'estimates', where: d => ["status='Approved' AND COALESCE(decided_at,updated_at)>=?", [since(d)]], title: "COALESCE(project_name,company,customer_name)", sub: "'Approved '||substr(COALESCE(decided_at,updated_at),1,10)", amount: 'proposal_total', date: 'COALESCE(decided_at,updated_at)', view: 'proposals', open: 'estimate', period: true },
    { key: 'over_budget', group: 'Management', label: 'Projects over budget', table: 'projects', where: () => ["COALESCE(budget,0)>0 AND (SELECT COALESCE(SUM(amount),0) FROM project_costs c WHERE c.project_id=projects.id)>budget", []], title: "COALESCE(name,company)", sub: "'Costs '||printf('%.0f',(SELECT COALESCE(SUM(amount),0) FROM project_costs c WHERE c.project_id=projects.id))||' vs budget '||printf('%.0f',budget)", amount: "(SELECT COALESCE(SUM(amount),0) FROM project_costs c WHERE c.project_id=projects.id)-budget", date: 'created_at', view: 'projects', open: 'project', alert: true },
    { key: 'time_unapproved', group: 'Management', label: 'Crew time awaiting approval', table: 'time_entries t LEFT JOIN employees e ON e.id=t.employee_id', where: () => ["t.clock_out IS NOT NULL AND t.approved_at IS NULL", []], title: "COALESCE(e.name,'Employee')", sub: "printf('%.2f h · ',COALESCE(t.minutes,0)/60.0)||substr(t.clock_in,1,10)", date: 't.clock_in', id: 't.id', view: 'schedule', alert: true },
    { key: 'inspections_passed', group: 'Management', label: 'Inspections passed (period)', table: 'inspections', where: d => ["passed=1 AND COALESCE(date,created_at)>=?", [since(d).slice(0, 10)]], title: 'area', sub: "'Score '||COALESCE(score,'—')", date: 'date', view: 'quality', period: true },
    { key: 'calls', group: 'Calls & AI', label: 'Calls (period)', table: 'calls', where: d => ["created_at>=?", [since(d)]], title: "COALESCE(NULLIF(company,''),NULLIF(contact_name,''),phone)", sub: "direction||' · '||COALESCE(outcome,'')", date: 'created_at', view: 'calls', open: 'call', period: true },
    { key: 'ai_calls', group: 'Calls & AI', label: 'Answered by AI (period)', table: 'calls', where: d => ["handling='AI' AND created_at>=?", [since(d)]], title: "COALESCE(NULLIF(company,''),NULLIF(contact_name,''),phone)", sub: "COALESCE(summary,'')", date: 'created_at', view: 'calls', open: 'call', period: true },
    { key: 'voicemails', group: 'Calls & AI', label: 'Voicemails (period)', table: 'calls', where: d => ["outcome='Voicemail' AND created_at>=?", [since(d)]], title: "COALESCE(NULLIF(company,''),NULLIF(contact_name,''),phone)", sub: "COALESCE(summary,'')", date: 'created_at', view: 'calls', open: 'call', period: true },
    { key: 'missed', group: 'Calls & AI', label: 'Missed calls (period)', table: 'calls', where: d => ["outcome IN ('Missed','No answer','Busy') AND created_at>=?", [since(d)]], title: "COALESCE(NULLIF(company,''),NULLIF(contact_name,''),phone)", sub: 'outcome', date: 'created_at', view: 'calls', open: 'call', period: true },
    { key: 'callbacks_due', group: 'Calls & AI', label: 'Callbacks due', table: 'calls', where: () => ["follow_up_date IS NOT NULL AND follow_up_date<=? AND COALESCE(follow_up_done,0)=0", [bd()]], title: "COALESCE(NULLIF(company,''),NULLIF(contact_name,''),phone)", sub: "'Due '||follow_up_date||' · '||COALESCE(outcome,'')", date: 'follow_up_date', view: 'calls', open: 'call', alert: true },
    { key: 'ai_leads', group: 'Calls & AI', label: 'Leads created by AI (period)', table: 'leads', where: d => ["details LIKE 'Phone call with Bright Clean''s AI receptionist%' AND created_at>=?", [since(d)]], title: "COALESCE(company,contact_name,'Lead')", sub: "COALESCE(service,'')", date: 'created_at', view: 'leads', open: 'lead', period: true },
    { key: 'ai_fallbacks', group: 'Calls & AI', label: 'AI calls that fell back', table: 'ai_call_sessions s LEFT JOIN calls c ON c.provider_sid=s.call_sid', where: d => ["s.status='fallback' AND s.started_at>=?", [since(d)]], title: "COALESCE(c.phone,s.caller)", sub: "COALESCE(s.error,'')", date: 's.started_at', id: 'c.id', view: 'calls', open: 'call', alert: true, period: true }
  ];
  const daysOf = q => [1, 7, 30, 90, 365].includes(Number(q.days)) ? Number(q.days) : 30;
  const run = (m, d, list, q) => {
    const [w, p] = m.where(d, q), idc = m.id || (m.table.split(' ')[0] + '.id').replace(/^([a-z_]+)\.id$/, '$1.id');
    const base = `FROM ${m.table} WHERE ${w}`;
    if (!list) { const r = db.prepare(`SELECT COUNT(*) n${m.amount ? `, COALESCE(SUM(${m.amount}),0) v` : ''} ${base}`).get(...p); return { n: r.n, v: m.amount ? Math.round(r.v * 100) / 100 : null }; }
    return db.prepare(`SELECT ${m.id || idc} id, ${m.title} title, ${m.sub} sub${m.amount ? `, ${m.amount} amount` : ''}, ${m.date} date ${base} ORDER BY ${m.date} DESC LIMIT 200`).all(...p);
  };
  app.get('/api/admin/command-center/metrics', auth, (req, res) => {
    const d = daysOf(req.query), out = [];
    for (const m of M) { try { const r = run(m, d, false); out.push({ key: m.key, group: m.group, label: m.label, count: r.n, amount: r.v, alert: !!m.alert && r.n > 0, period: !!m.period, view: m.view }); } catch (e) { out.push({ key: m.key, group: m.group, label: m.label, error: 'Not available: ' + e.message.slice(0, 80) }); } }
    res.json({ days: d, as_of: new Date().toISOString(), today: bd(), metrics: out });
  });
  app.get('/api/admin/command-center/drill/:key', auth, (req, res) => {
    const m = M.find(x => x.key === req.params.key); if (!m) return res.status(404).json({ error: 'Unknown metric.' });
    const d = daysOf(req.query);
    try { const rows = run(m, d, true, req.query), c = run(m, d, false, req.query); res.json({ key: m.key, label: m.label + (req.query.service && m.key === 'collected' ? ' — ' + String(req.query.service).slice(0, 80) : ''), group: m.group, days: d, count: c.n, amount: c.v, view: m.view, open: m.open || null, rows }); }
    catch (e) { res.status(500).json({ error: 'This list is not available: ' + e.message }); }
  });
  // Collected by service line (period): each bar drills into the matching payments.
  app.get('/api/admin/command-center/divisions', auth, (req, res) => {
    const d = daysOf(req.query);
    try { res.json({ days: d, rows: db.prepare(`SELECT COALESCE(NULLIF(pr.service,''),'Unassigned') service, COUNT(*) n, ROUND(SUM(p.amount),2) collected FROM payments p JOIN invoices i ON i.id=p.invoice_id LEFT JOIN projects pr ON pr.id=i.project_id WHERE p.received_at>=? GROUP BY 1 ORDER BY 3 DESC`).all(since(d).slice(0, 10)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- Personal preferences (per signed-in user; never business data) ----
  db.exec('CREATE TABLE IF NOT EXISTS user_prefs(email TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at TEXT, PRIMARY KEY(email, key))');
  const me = req => String((req.user && req.user.email) || '').toLowerCase();
  const PREF_KEYS = ['command_center', 'calls_filters', 'leads_filters'];
  app.get('/api/admin/prefs', auth, (req, res) => { const out = {}; for (const r of db.prepare('SELECT key, value FROM user_prefs WHERE email=?').all(me(req))) { try { out[r.key] = JSON.parse(r.value); } catch { /* */ } } res.json(out); });
  app.put('/api/admin/prefs/:key', auth, (req, res) => {
    if (!PREF_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'Unknown preference.' });
    const v = JSON.stringify(req.body || {}); if (v.length > 4000) return res.status(400).json({ error: 'Preference too large.' });
    db.prepare('INSERT INTO user_prefs(email,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(email,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(me(req), req.params.key, v, new Date().toISOString());
    res.json({ ok: true });
  });

  // ---- Live updates: a server-sent event stream fed by the activity log (written on every business change). ----
  // Clients receive only "what kind of record changed" (no details), then reload from the authoritative API.
  const crypto = require('crypto'), tickets = new Map(), clients = new Set();
  let lastId = (db.prepare('SELECT MAX(id) m FROM audit_log').get() || {}).m || 0;
  // Also watch key tables directly so changes made outside the admin (website forms, customer decisions, webhooks) are pushed too.
  const WATCH = [['lead', 'SELECT MAX(id) m FROM leads'], ['call', 'SELECT MAX(id) m FROM calls'], ['estimate', 'SELECT MAX(updated_at) m FROM estimates'], ['issue', 'SELECT MAX(updated_at) m FROM customer_issues'], ['payment', 'SELECT MAX(id) m FROM payments'], ['visit', 'SELECT MAX(updated_at) m FROM visits']];
  const marks = {}; for (const [k, q] of WATCH) { try { marks[k] = (db.prepare(q).get() || {}).m; } catch { marks[k] = undefined; } }
  app.post('/api/admin/events/ticket', auth, (req, res) => { const t = crypto.randomBytes(24).toString('hex'); tickets.set(t, { email: me(req), exp: Date.now() + 60000 }); res.json({ ticket: t }); });
  app.get('/api/admin/events', (req, res) => {
    const tk = tickets.get(String(req.query.ticket || '')); if (!tk || tk.exp < Date.now()) return res.status(401).end();
    tickets.delete(String(req.query.ticket));
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders && res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ last: lastId })}\n\n`);
    const c = { res }; clients.add(c); req.on('close', () => clients.delete(c));
  });
  const tick = () => {
    try {
      const rows = db.prepare('SELECT id, entity, action, entity_id FROM audit_log WHERE id>? ORDER BY id LIMIT 200').all(lastId);
      const evs = rows.map(r => ({ id: r.id, entity: r.entity, action: r.action, entity_id: r.entity_id }));
      if (rows.length) lastId = rows[rows.length - 1].id;
      for (const [k, q] of WATCH) { let v; try { v = (db.prepare(q).get() || {}).m; } catch { continue; } if (v != null && v !== marks[k]) { if (marks[k] !== undefined) evs.push({ entity: k, action: 'changed' }); marks[k] = v; } }
      if (evs.length) { const msg = `event: change\ndata: ${JSON.stringify(evs)}\n\n`; for (const c of clients) { try { c.res.write(msg); } catch { clients.delete(c); } } }
      for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
    } catch { /* table may be busy; next tick */ }
  };
  const t1 = setInterval(tick, Number(process.env.EVENTS_POLL_MS || 1500)), t2 = setInterval(() => { for (const c of clients) { try { c.res.write(': keep-alive\n\n'); } catch { clients.delete(c); } } }, 25000);
  t1.unref && t1.unref(); t2.unref && t2.unref();
};
