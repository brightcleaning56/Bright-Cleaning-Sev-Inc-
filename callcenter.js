// Call & Message Center: groups calls into queues, identifies the caller against customer and lead records, and gives
// the caller's open work (projects, invoices, open issues, open callbacks). Calls are not copied: this reads the calls table.
module.exports = function (app, { db, auth, logAction, clean }) {
  const bizdate = require('./bizdate');
  const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
  const who = req => String((req.user && req.user.email) || '');
  const OUTCOMES = ['Answered', 'Missed', 'Voicemail', 'Transferred', 'Completed', 'Callback requested'];
  const QUEUES = ['Existing customer', 'New lead', 'Returning lead', 'Unknown caller', 'Missed / callbacks'];
  const DAY = 86400000;

  // Callbacks: a missed call stays in Missed / callbacks until someone marks its follow-up done.
  // Calls that are on the work queue are left alone: the queue owns their state.
  function ensureMissedCallbacks() {
    db.prepare(`UPDATE calls SET follow_up_date=? WHERE outcome='Missed' AND follow_up_done=0 AND (follow_up_date IS NULL OR follow_up_date='')
      AND id NOT IN (SELECT ref_id FROM work_items WHERE kind='call' AND ref_type='call' AND ref_id IS NOT NULL)`).run(bizdate.today());
  }

  function directory() {
    const customers = db.prepare('SELECT id, name, company, phone, email FROM customers').all();
    const leads = db.prepare('SELECT id, contact_name, company, phone, email, status, created_at, customer_id FROM leads ORDER BY id DESC').all();
    const custById = new Map(customers.map(c => [c.id, c]));
    const custByPhone = new Map(); for (const c of customers) { const d = digits(c.phone); if (d && !custByPhone.has(d)) custByPhone.set(d, c); }
    const leadById = new Map(leads.map(l => [l.id, l]));
    const leadByPhone = new Map(); for (const l of leads) { const d = digits(l.phone); if (d && !leadByPhone.has(d)) leadByPhone.set(d, l); } // newest lead first
    return { custById, custByPhone, leadById, leadByPhone };
  }

  // Each call gets a queue and a match: the customer or lead it belongs to, or the one its phone number suggests.
  function enrich(calls, dir) {
    const all = db.prepare('SELECT id, phone, created_at FROM calls ORDER BY id').all();
    const priorByDigits = new Map(); // number of earlier calls from the same phone
    const seen = new Map();
    for (const c of all) { const d = digits(c.phone); if (!d) continue; priorByDigits.set(c.id, seen.get(d) || 0); seen.set(d, (seen.get(d) || 0) + 1); }
    return calls.map(c => {
      const d = digits(c.phone);
      let match = null;
      const cu = (c.customer_id && dir.custById.get(c.customer_id)) || null;
      const lead = (c.lead_id && dir.leadById.get(c.lead_id)) || null;
      if (cu) match = { type: 'customer', id: cu.id, name: cu.name, company: cu.company, suggested: false };
      else if (lead && lead.customer_id && dir.custById.get(lead.customer_id)) { const x = dir.custById.get(lead.customer_id); match = { type: 'customer', id: x.id, name: x.name, company: x.company, suggested: false }; }
      else if (lead) match = { type: 'lead', id: lead.id, name: lead.contact_name, company: lead.company, status: lead.status, suggested: false };
      else if (d && dir.custByPhone.has(d)) { const x = dir.custByPhone.get(d); match = { type: 'customer', id: x.id, name: x.name, company: x.company, suggested: true }; }
      else if (d && dir.leadByPhone.has(d)) { const x = dir.leadByPhone.get(d); match = { type: 'lead', id: x.id, name: x.contact_name, company: x.company, status: x.status, suggested: true }; }
      let queue;
      if (c.outcome === 'Missed' && !c.follow_up_done) queue = 'Missed / callbacks';
      else if (match && match.type === 'customer') queue = 'Existing customer';
      else if (match && match.type === 'lead') {
        const leadRow = match.suggested ? dir.leadByPhone.get(d) : lead;
        const earlier = (priorByDigits.get(c.id) || 0) > 0 || (leadRow && leadRow.created_at && Date.parse(leadRow.created_at) < Date.parse(c.created_at) - DAY);
        queue = earlier ? 'Returning lead' : 'New lead';
      } else queue = 'Unknown caller';
      const callbackOpen = !!(c.outcome === 'Missed' && !c.follow_up_done);
      return { ...c, match, queue, callback_open: callbackOpen };
    });
  }

  app.get('/api/admin/calls-center', auth, (req, res) => {
    ensureMissedCallbacks();
    const calls = db.prepare('SELECT * FROM calls ORDER BY id DESC LIMIT 300').all();
    const rows = enrich(calls, directory());
    const counts = Object.fromEntries(QUEUES.map(q => [q, 0]));
    for (const r of rows) counts[r.queue] = (counts[r.queue] || 0) + 1;
    res.json({ calls: rows, queues: QUEUES, queue_counts: counts, outcomes: OUTCOMES });
  });

  // Everything the team needs about the caller, in one response.
  app.get('/api/admin/calls/:id/context', auth, (req, res) => {
    const c = db.prepare('SELECT * FROM calls WHERE id=?').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Call not found.' });
    const dir = directory();
    const row = enrich([c], dir)[0];
    const out = { call: row, match: row.match, customer: null, lead: null };
    // Balances are for owners, managers and office staff. Other roles see the caller's projects and open work, not money.
    const roleCC = (() => { const e = who(req).toLowerCase(), ow = String(process.env.ADMIN_EMAIL || '').toLowerCase(); if (!ow || e === ow) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; })();
    const seeMoney = require('./roles').seesMoney(roleCC);
    const custId = row.match && row.match.type === 'customer' ? row.match.id : null;
    if (custId) {
      const cu = dir.custById.get(custId);
      const projects = db.prepare("SELECT COUNT(*) n FROM projects WHERE customer_id=? AND status NOT IN ('Completed','Closed','Customer accepted','Archived')").get(custId).n;
      const inv = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) balance FROM invoices WHERE customer_id=? AND status NOT IN ('Paid','Void')").get(custId);
      const issues = db.prepare("SELECT COUNT(*) n FROM customer_issues WHERE customer_id=? AND status NOT IN ('Resolved','Verified','Closed')").get(custId).n;
      const callbacks = db.prepare("SELECT COUNT(*) n FROM calls WHERE customer_id=? AND follow_up_done=0 AND follow_up_date IS NOT NULL AND follow_up_date<>''").get(custId).n;
      const lastProject = db.prepare('SELECT name FROM projects WHERE customer_id=? ORDER BY id DESC LIMIT 1').get(custId);
      out.customer = { id: cu.id, name: cu.name, company: cu.company, phone: cu.phone, email: cu.email, active_projects: projects, open_invoices: seeMoney ? inv.n : null, open_balance: seeMoney ? Math.round(db.prepare("SELECT id FROM invoices WHERE customer_id=? AND status NOT IN ('Paid','Void','Draft')").all(custId).reduce((s, r) => s + require('./receivables').invoiceBalance(db, r.id).owed, 0) * 100) / 100 : null, open_tasks: issues + callbacks, open_issues: issues, open_callbacks: callbacks, last_project: lastProject ? lastProject.name : null };
    }
    const leadRef = row.match && row.match.type === 'lead' ? row.match.id : null;
    if (leadRef) {
      const l = dir.leadById.get(leadRef);
      const full = db.prepare('SELECT * FROM leads WHERE id=?').get(l.id) || {};
      out.lead = { id: full.id, contact_name: full.contact_name, company: full.company, phone: full.phone, email: full.email, status: full.status, follow_up_date: full.follow_up_date || null, assigned_to: full.assigned_to || null, created_at: full.created_at };
    }
    res.json(out);
  });

  // Link a call to a lead (for example after creating the lead from an unknown caller).
  app.post('/api/admin/calls/:id/lead', auth, (req, res) => {
    const c = db.prepare('SELECT id FROM calls WHERE id=?').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Call not found.' });
    const l = db.prepare('SELECT id FROM leads WHERE id=?').get(Number((req.body || {}).lead_id));
    if (!l) return res.status(404).json({ error: 'That lead was not found.' });
    db.prepare('UPDATE calls SET lead_id=? WHERE id=?').run(l.id, c.id);
    logAction(req, 'linked call to lead', 'call', c.id, 'lead #' + l.id);
    res.json({ ok: true });
  });
  module.exports.OUTCOMES = OUTCOMES;
};
