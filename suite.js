// Operations suite: global search, manual leads, call log, schedule, quality inspections, reports,
// and the project drawing/document library. Everything here is internal (admin auth on every route).
module.exports = function mountSuite(app, ctx) {
  const { db, auth, logAction, clean, upload, path, fs, getOps, isEmail } = ctx;
  const now = () => new Date().toISOString();
  const today = () => require('./bizdate').today();
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const isTime = v => /^\d{2}:\d{2}$/.test(String(v || ''));
  const pick = (v, list, dflt) => list.includes(v) ? v : dflt;

  db.exec(`
  CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT NOT NULL DEFAULT 'Inbound', phone TEXT, contact_name TEXT, company TEXT,
    customer_id INTEGER, lead_id INTEGER, outcome TEXT NOT NULL DEFAULT 'Answered', purpose TEXT NOT NULL DEFAULT 'New business', summary TEXT,
    follow_up_date TEXT, follow_up_done INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS visits(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'Site visit', date TEXT NOT NULL,
    start_time TEXT, end_time TEXT, address TEXT, customer_id INTEGER, project_id INTEGER, lead_id INTEGER, assigned_to TEXT, crew_size INTEGER,
    notes TEXT, status TEXT NOT NULL DEFAULT 'Scheduled', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS inspections(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, customer_id INTEGER, area TEXT NOT NULL, inspector TEXT,
    date TEXT NOT NULL, template TEXT, items TEXT NOT NULL, score REAL, passed INTEGER, notes TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, customer_id INTEGER, lead_id INTEGER, title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'Drawings', revision TEXT, file_name TEXT, file_url TEXT NOT NULL, size INTEGER, analysis_status TEXT NOT NULL DEFAULT 'Not analyzed',
    uploaded_by TEXT, created_at TEXT NOT NULL);`);

  const exists = (table, id) => id == null || !!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id);
  const idOrNull = v => (v === '' || v == null) ? null : Number(v);
  const who = req => (req.user && req.user.email) || null;

  // ---------- Global search ----------
  app.get('/api/admin/search', auth, (req, res) => {
    const q = clean(req.query.q, 100);
    if (q.length < 2) return res.json({ results: [] });
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
    const run = (sql, map) => db.prepare(sql).all(...Array((sql.match(/\?/g) || []).length).fill(like)).map(map);
    const E = " ESCAPE '\\'";
    const results = [
      ...run(`SELECT id,contact_name,company,email,kind,status FROM leads WHERE contact_name LIKE ?${E} OR company LIKE ?${E} OR email LIKE ?${E} OR project_name LIKE ?${E} OR phone LIKE ?${E} ORDER BY id DESC LIMIT 8`,
        r => ({ type: 'lead', id: r.id, title: r.company || r.contact_name, sub: `${r.kind === 'bid' ? 'Bid request' : 'Inquiry'} · ${r.status} · ${r.email || ''}` })),
      ...run(`SELECT id,name,company,email FROM customers WHERE name LIKE ?${E} OR company LIKE ?${E} OR email LIKE ?${E} OR phone LIKE ?${E} ORDER BY id DESC LIMIT 8`,
        r => ({ type: 'customer', id: r.id, title: r.company || r.name, sub: `Customer · ${r.email || ''}` })),
      ...run(`SELECT id,customer_name,project_name,status,proposal_total FROM estimates WHERE customer_name LIKE ?${E} OR company LIKE ?${E} OR project_name LIKE ?${E} ORDER BY id DESC LIMIT 8`,
        r => ({ type: 'estimate', id: r.id, title: r.project_name || r.customer_name, sub: `Proposal #${r.id} · ${r.status} · $${Number(r.proposal_total || 0).toLocaleString('en-US')}` })),
      ...run(`SELECT id,name,customer_name,status FROM projects WHERE name LIKE ?${E} OR customer_name LIKE ?${E} OR site_address LIKE ?${E} ORDER BY id DESC LIMIT 8`,
        r => ({ type: 'project', id: r.id, title: r.name || r.customer_name, sub: `Project · ${r.status}` })),
      ...run(`SELECT id,invoice_number,customer_name,status FROM invoices WHERE invoice_number LIKE ?${E} OR customer_name LIKE ?${E} OR company LIKE ?${E} ORDER BY id DESC LIMIT 8`,
        r => ({ type: 'invoice', id: r.id, title: r.invoice_number, sub: `Invoice · ${r.customer_name || ''} · ${r.status}` })),
      ...run(`SELECT id,title,status,type FROM customer_issues WHERE title LIKE ?${E} OR description LIKE ?${E} ORDER BY id DESC LIMIT 6`,
        r => ({ type: 'issue', id: r.id, title: r.title, sub: `${r.type} · ${r.status}` })),
      ...run(`SELECT id,title,kind,revision FROM documents WHERE title LIKE ?${E} OR file_name LIKE ?${E} ORDER BY id DESC LIMIT 6`,
        r => ({ type: 'document', id: r.id, title: r.title, sub: `${r.kind}${r.revision ? ' · Rev ' + r.revision : ''}` })),
      ...run(`SELECT id,contact_name,company,phone,summary FROM calls WHERE contact_name LIKE ?${E} OR company LIKE ?${E} OR phone LIKE ?${E} OR summary LIKE ?${E} ORDER BY id DESC LIMIT 6`,
        r => ({ type: 'call', id: r.id, title: r.company || r.contact_name || r.phone, sub: `Call · ${(r.summary || '').slice(0, 60)}` }))
    ];
    res.json({ results });
  });

  // ---------- Manual lead entry (phone, walk-in, referral) ----------
  app.post('/api/admin/leads', auth, (req, res) => {
    const b = req.body || {}, errs = [];
    const kind = pick(b.kind, ['bid', 'inquiry'], 'bid');
    if (!clean(b.contact_name, 150) && !clean(b.company, 200)) errs.push('Enter a contact name or company.');
    if (b.email && !isEmail(b.email)) errs.push('Enter a valid email address.');
    if (!b.email && !clean(b.phone, 60)) errs.push('Enter an email or a phone number.');
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const origin = ['website', 'inbound_call', 'portal', 'api', 'manual', 'import'].includes(b.origin) ? b.origin : 'manual';
    // The label follows how the lead came in, so a lead we added is never labelled as a phone call.
    const sourceLabel = { website: 'Website form', inbound_call: 'Phone call', portal: 'Client portal' }[origin];
    const source = sourceLabel || clean(b.source, 60) || 'Added by our team';
    const info = db.prepare(`INSERT INTO leads(kind,contact_name,company,email,phone,project_name,service,address,square_footage,bid_due_date,details,created_at,origin)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(kind, clean(b.contact_name, 150), clean(b.company, 200), clean(b.email, 254), clean(b.phone, 60),
      clean(b.project_name, 200), clean(b.service, 120), clean(b.address, 500), clean(b.square_footage, 40), isDate(b.bid_due_date) ? b.bid_due_date : '',
      `Source: ${source}\n${clean(b.details, 4000)}`.trim(), now(), origin);
    logAction(req, 'created', 'lead', info.lastInsertRowid, `${source}: ${clean(b.company || b.contact_name, 200)}`);
    const ops = getOps(); if (ops && (b.email || b.company)) ops.upsertCustomer({ name: b.contact_name, company: b.company, email: b.email, phone: b.phone, address: b.address }, source.toLowerCase());
    res.status(201).json({ id: info.lastInsertRowid });
  });

  // ---------- Call log ----------
  const CALL = { direction: ['Inbound', 'Outbound'], outcome: ['Answered', 'Missed', 'Voicemail', 'Callback requested'],
    purpose: ['New business', 'Bid request', 'Existing customer', 'Complaint', 'Invoice question', 'Pricing question', 'Other'] };
  const callRow = id => db.prepare(`SELECT c.*, cu.company customer_company, cu.name customer_name FROM calls c LEFT JOIN customers cu ON cu.id=c.customer_id WHERE c.id=?`).get(id);
  app.get('/api/admin/calls', auth, (req, res) => {
    const since = new Date(require('./bizdate').startUTC(today())); // start of the business day (Central), not UTC midnight
    const rows = db.prepare(`SELECT c.*, cu.company customer_company, cu.name customer_name FROM calls c LEFT JOIN customers cu ON cu.id=c.customer_id ORDER BY c.id DESC LIMIT 300`).all();
    const t = db.prepare(`SELECT COUNT(*) total, SUM(outcome='Answered') answered, SUM(outcome IN ('Missed','Voicemail')) missed FROM calls WHERE created_at>=?`).get(since.toISOString());
    const fu = db.prepare(`SELECT COUNT(*) n FROM calls WHERE follow_up_done=0 AND follow_up_date IS NOT NULL AND follow_up_date<>'' AND follow_up_date<=?`).get(today()).n;
    res.json({ calls: rows, today: { total: t.total || 0, answered: t.answered || 0, missed: t.missed || 0 }, follow_ups_due: fu, options: CALL });
  });
  app.post('/api/admin/calls', auth, (req, res) => {
    const b = req.body || {}, errs = [];
    if (!clean(b.phone, 40) && !clean(b.contact_name, 150)) errs.push('Enter the phone number or the caller name.');
    if (b.follow_up_date && !isDate(b.follow_up_date)) errs.push('Follow-up date must be a date.');
    const cid = idOrNull(b.customer_id); if (!exists('customers', cid)) errs.push('That customer was not found.');
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    let leadId = null;
    const purpose = pick(b.purpose, CALL.purpose, 'Other');
    if (b.create_lead && ['New business', 'Bid request', 'Pricing question'].includes(purpose)) {
      leadId = db.prepare(`INSERT INTO leads(kind,contact_name,company,email,phone,details,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(purpose === 'Bid request' ? 'bid' : 'inquiry', clean(b.contact_name, 150), clean(b.company, 200), clean(b.email, 254), clean(b.phone, 60), `Source: Phone call\n${clean(b.summary, 4000)}`, now()).lastInsertRowid;
      logAction(req, 'created', 'lead', leadId, 'from phone call');
    }
    const info = db.prepare(`INSERT INTO calls(direction,phone,contact_name,company,customer_id,lead_id,outcome,purpose,summary,follow_up_date,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(pick(b.direction, CALL.direction, 'Inbound'), clean(b.phone, 40), clean(b.contact_name, 150), clean(b.company, 200), cid, leadId,
      pick(b.outcome, CALL.outcome, 'Answered'), purpose, clean(b.summary, 4000), isDate(b.follow_up_date) ? b.follow_up_date : null, who(req), now());
    { const digits = String(b.phone || '').replace(/\D/g, '').slice(-10);
      const target = leadId || (digits.length === 10 ? (db.prepare(`SELECT id FROM leads WHERE status NOT IN ('Won','Lost','Archived') AND substr(replace(replace(replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')',''),'+',''),'.',''), -10) = ? ORDER BY id DESC LIMIT 1`).get(digits) || {}).id : null);
      if (target && app.locals.touchLead) app.locals.touchLead(target, isDate(b.follow_up_date) ? b.follow_up_date : null, b.summary, who(req)); }
    logAction(req, 'logged', 'call', info.lastInsertRowid, `${purpose}: ${clean(b.company || b.contact_name || b.phone, 200)}`);
    res.status(201).json({ call: callRow(info.lastInsertRowid), lead_id: leadId });
  });
  app.patch('/api/admin/calls/:id', auth, (req, res) => {
    const cur = callRow(Number(req.params.id)); if (!cur) return res.status(404).json({ error: 'Call not found.' });
    const b = req.body || {}, set = {};
    if ('follow_up_done' in b) set.follow_up_done = b.follow_up_done ? 1 : 0;
    if ('summary' in b) set.summary = clean(b.summary, 4000);
    if ('follow_up_date' in b) { if (b.follow_up_date && !isDate(b.follow_up_date)) return res.status(400).json({ error: 'Follow-up date must be a date.' }); set.follow_up_date = b.follow_up_date || null; }
    if ('outcome' in b) set.outcome = pick(b.outcome, CALL.outcome, cur.outcome);
    const cols = Object.keys(set);
    if (cols.length) db.prepare(`UPDATE calls SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`).run(...cols.map(c => set[c]), cur.id);
    if (cur.lead_id && app.locals.touchLead && ('follow_up_date' in b || 'outcome' in b)) app.locals.touchLead(cur.lead_id, set.follow_up_date, cur.summary, who(req));
    if (cur.lead_id && app.locals.clearLeadFollowUpIfSameDate && 'follow_up_date' in b && !b.follow_up_date && cur.follow_up_date) app.locals.clearLeadFollowUpIfSameDate(cur.lead_id, cur.follow_up_date);
    logAction(req, 'updated', 'call', cur.id, cols.join(', '));
    res.json({ call: callRow(cur.id) });
  });

  // ---------- Schedule: site visits, walkthroughs, cleaning phases ----------
  const VISIT = { type: ['Site visit', 'Walkthrough', 'Cleaning phase', 'Inspection', 'Punch list', 'Work order', 'Other'], status: ['Tentative', 'Scheduled', 'In progress', 'Done', 'Cancelled'] };
  function visitValidate(b, cur) {
    const out = {}, errs = [];
    if (!cur || 'title' in b) { const t = clean(b.title, 200); if (!t) errs.push('A title is required.'); else out.title = t; }
    if (!cur || 'date' in b) { if (!isDate(b.date)) errs.push('Choose a date.'); else out.date = b.date; }
    for (const k of ['start_time', 'end_time']) if (k in b) { if (b[k] && !isTime(b[k])) errs.push('Times must be like 08:30.'); else out[k] = b[k] || null; }
    if (out.start_time && out.end_time && out.end_time <= out.start_time) errs.push('End time must be after the start time.');
    if ('type' in b) out.type = pick(b.type, VISIT.type, 'Site visit');
    if ('status' in b) out.status = pick(b.status, VISIT.status, 'Scheduled');
    for (const k of ['address', 'notes', 'assigned_to']) if (k in b) out[k] = clean(b[k], 2000);
    for (const k of ['instructions', 'equipment']) if (k in b) out[k] = clean(b[k], 3000);
    if ('priority' in b) out.priority = ['Low', 'Normal', 'High', 'Urgent'].includes(b.priority) ? b.priority : 'Normal';
    if ('crew_needed' in b) { const n = b.crew_needed === '' || b.crew_needed == null ? null : Math.trunc(Number(b.crew_needed)); if (n !== null && !(n >= 1 && n <= 50)) errs.push('Crew needed must be 1 to 50.'); else out.crew_needed = n; }
    if ('checklist' in b) { let l; try { l = typeof b.checklist === 'string' ? JSON.parse(b.checklist) : b.checklist; } catch { l = null; } if (!Array.isArray(l)) errs.push('Checklist must be a list.'); else out.checklist = JSON.stringify(l.slice(0, 60).map(x => ({ text: clean(x.text || x.title || '', 200), done: !!x.done, by: x.by || null, at: x.at || null })).filter(x => x.text)); }
    if ('crew_size' in b) out.crew_size = b.crew_size === '' || b.crew_size == null ? null : Math.max(0, Math.min(500, Math.trunc(Number(b.crew_size) || 0)));
    for (const [k, t] of [['customer_id', 'customers'], ['project_id', 'projects'], ['lead_id', 'leads']]) if (k in b) { const v = idOrNull(b[k]); if (!exists(t, v)) errs.push(`That ${t.slice(0, -1)} was not found.`); else out[k] = v; }
    return { out, errs };
  }
  app.get('/api/admin/visits', auth, (req, res) => {
    const from = isDate(req.query.from) ? req.query.from : today(), to = isDate(req.query.to) ? req.query.to : '9999-12-31';
    const rows = db.prepare(`SELECT v.*, c.company customer_company, c.name customer_name, p.name project_name FROM visits v LEFT JOIN customers c ON c.id=v.customer_id LEFT JOIN projects p ON p.id=v.project_id
      WHERE v.date>=? AND v.date<=? ORDER BY v.date, COALESCE(v.start_time,'99:99')`).all(from, to);
    const due = db.prepare(`SELECT id,name,customer_name,due_date,status FROM projects WHERE due_date>=? AND due_date<=? AND status NOT IN ('Completed','On Hold')`).all(from, to);
    res.json({ visits: rows, project_due: due, options: VISIT });
  });
  app.post('/api/admin/visits', auth, (req, res) => {
    const { out, errs } = visitValidate(req.body || {}, null);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const cols = Object.keys(out), t = now();
    const info = db.prepare(`INSERT INTO visits(${cols.join(',')},created_by,created_at,updated_at) VALUES(${cols.map(() => '?').join(',')},?,?,?)`).run(...cols.map(c => out[c]), who(req), t, t);
    logAction(req, 'scheduled', 'visit', info.lastInsertRowid, `${out.title} on ${out.date}`);
    res.status(201).json({ visit: db.prepare('SELECT * FROM visits WHERE id=?').get(info.lastInsertRowid) });
  });
  app.patch('/api/admin/visits/:id', auth, (req, res) => {
    const cur = db.prepare('SELECT * FROM visits WHERE id=?').get(Number(req.params.id)); if (!cur) return res.status(404).json({ error: 'Not found.' });
    const { out, errs } = visitValidate({ start_time: cur.start_time, end_time: cur.end_time, ...req.body }, cur);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const cols = Object.keys(out);
    db.prepare(`UPDATE visits SET ${cols.map(c => c + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map(c => out[c]), now(), cur.id);
    logAction(req, out.status && out.status !== cur.status ? out.status.toLowerCase() : 'updated', 'visit', cur.id, cur.title);
    res.json({ visit: db.prepare('SELECT * FROM visits WHERE id=?').get(cur.id) });
  });

  // ---------- Quality inspections ----------
  const TEMPLATES = {
    'Construction final clean': ['Floors clean, no dust or residue', 'Glass and mirrors streak-free, labels removed', 'Restroom fixtures and partitions spotless', 'Doors, frames and hardware wiped', 'Cabinets and counters clean inside and out', 'High and low dusting complete', 'Light fixtures, vents and diffusers clean', 'No debris, tape or stickers left'],
    'Janitorial service': ['Trash and recycling emptied', 'Restrooms sanitized and stocked', 'Floors vacuumed / mopped', 'Breakroom counters and sinks clean', 'Dusting of reachable surfaces', 'Entry glass clean'],
    'Multifamily common areas': ['Hallways vacuumed / mopped', 'Stairwells clean', 'Elevator cab clean', 'Lobby / leasing office presentable', 'Trash rooms odor-controlled', 'Doors and rails wiped'],
    'Unit turnover': ['Kitchen and appliances inside and out', 'Bathrooms sanitized', 'Cabinets and drawers inside', 'Floors cleaned', 'Baseboards and sills', 'Windows inside', 'Rent-ready overall']
  };
  function scoreItems(items) {
    const rated = items.filter(i => i.result === 'Pass' || i.result === 'Fail');
    const score = rated.length ? Math.round(rated.filter(i => i.result === 'Pass').length / rated.length * 1000) / 10 : null;
    return { score, passed: rated.length ? (items.some(i => i.result === 'Fail') ? 0 : 1) : null };
  }
  function inspValidate(b, cur) {
    const out = {}, errs = [];
    if (!cur || 'area' in b) { const a = clean(b.area, 200); if (!a) errs.push('Enter the area or room inspected.'); else out.area = a; }
    if (!cur || 'date' in b) { if (!isDate(b.date)) errs.push('Choose the inspection date.'); else out.date = b.date; }
    if ('inspector' in b) out.inspector = clean(b.inspector, 120);
    if ('notes' in b) out.notes = clean(b.notes, 4000);
    if ('template' in b) out.template = TEMPLATES[b.template] ? b.template : null;
    for (const [k, t] of [['customer_id', 'customers'], ['project_id', 'projects']]) if (k in b) { const v = idOrNull(b[k]); if (!exists(t, v)) errs.push(`That ${t.slice(0, -1)} was not found.`); else out[k] = v; }
    if (!cur || 'items' in b) {
      const arr = Array.isArray(b.items) ? b.items : [];
      const items = arr.slice(0, 60).map(i => ({ label: clean(i && i.label, 200), result: pick(i && i.result, ['Pass', 'Fail', 'N/A', ''], ''), note: clean(i && i.note, 500) })).filter(i => i.label);
      if (!items.length) errs.push('Add at least one checklist item.');
      if (items.some(i => i.result === 'Fail' && !i.note)) errs.push('Add a note to every failed item so the crew knows what to fix.');
      out.items = JSON.stringify(items); Object.assign(out, scoreItems(items));
    }
    return { out, errs };
  }
  const inspRow = r => r && ({ ...r, items: JSON.parse(r.items || '[]') });
  app.get('/api/admin/inspections', auth, (req, res) => {
    const rows = db.prepare(`SELECT i.*, p.name project_name, c.company customer_company, c.name customer_name FROM inspections i LEFT JOIN projects p ON p.id=i.project_id LEFT JOIN customers c ON c.id=i.customer_id ORDER BY i.date DESC, i.id DESC LIMIT 300`).all().map(inspRow);
    const avg = db.prepare(`SELECT ROUND(AVG(score),1) a, COUNT(*) n, SUM(passed=0) failed FROM inspections WHERE date>=?`).get(new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10));
    res.json({ inspections: rows, templates: TEMPLATES, summary: { average_score_90d: avg.a, count_90d: avg.n || 0, failed_90d: avg.failed || 0 } });
  });
  app.post('/api/admin/inspections', auth, (req, res) => {
    const { out, errs } = inspValidate(req.body || {}, null);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const cols = Object.keys(out), t = now();
    const info = db.prepare(`INSERT INTO inspections(${cols.join(',')},created_by,created_at,updated_at) VALUES(${cols.map(() => '?').join(',')},?,?,?)`).run(...cols.map(c => out[c]), who(req), t, t);
    logAction(req, 'recorded', 'inspection', info.lastInsertRowid, `${out.area}: ${out.score == null ? 'not scored' : out.score + '%'}`);
    res.status(201).json({ inspection: inspRow(db.prepare('SELECT * FROM inspections WHERE id=?').get(info.lastInsertRowid)) });
  });
  app.patch('/api/admin/inspections/:id', auth, (req, res) => {
    const cur = db.prepare('SELECT * FROM inspections WHERE id=?').get(Number(req.params.id)); if (!cur) return res.status(404).json({ error: 'Not found.' });
    const { out, errs } = inspValidate(req.body || {}, cur);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const cols = Object.keys(out);
    if (cols.length) db.prepare(`UPDATE inspections SET ${cols.map(c => c + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map(c => out[c]), now(), cur.id);
    logAction(req, 'updated', 'inspection', cur.id, cur.area);
    res.json({ inspection: inspRow(db.prepare('SELECT * FROM inspections WHERE id=?').get(cur.id)) });
  });

  // ---------- Reports ----------
  function buildReport(monthsIn) {
    const months = Math.min(24, Math.max(3, Number(monthsIn) || 12));
    const keys = []; const d = new Date(); d.setDate(1);
    for (let i = months - 1; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); keys.push(x.toISOString().slice(0, 7)); }
    const start = keys[0] + '-01';
    const byMonth = (sql) => { const m = Object.fromEntries(db.prepare(sql).all(start).map(r => [r.m, r])); return keys.map(k => m[k] || { m: k, n: 0, v: 0 }); };
    const leads = byMonth(`SELECT substr(created_at,1,7) m, COUNT(*) n, 0 v FROM leads WHERE kind IN ('bid','inquiry') AND created_at>=? GROUP BY m`);
    const sent = byMonth(`SELECT substr(sent_at,1,7) m, COUNT(*) n, COALESCE(SUM(proposal_total),0) v FROM estimates WHERE sent_at>=? GROUP BY m`);
    const won = byMonth(`SELECT substr(COALESCE(decided_at,updated_at),1,7) m, COUNT(*) n, COALESCE(SUM(proposal_total),0) v FROM estimates WHERE status='Approved' AND COALESCE(decided_at,updated_at)>=? GROUP BY m`);
    const collected = byMonth(`SELECT substr(received_at,1,7) m, COUNT(*) n, COALESCE(SUM(amount),0) v FROM payments WHERE received_at>=? GROUP BY m`);
    const decided = db.prepare(`SELECT SUM(status='Approved') w, SUM(status='Declined') l, COALESCE(SUM(CASE WHEN status='Approved' THEN proposal_total END),0) wv FROM estimates WHERE COALESCE(decided_at,updated_at)>=? AND status IN ('Approved','Declined')`).get(start);
    const byService = db.prepare(`SELECT COALESCE(scope_category,'unspecified') k, COUNT(*) n, ROUND(AVG(proposal_total),2) avg, COALESCE(SUM(proposal_total),0) total FROM estimates WHERE status='Approved' AND COALESCE(decided_at,updated_at)>=? GROUP BY k ORDER BY total DESC`).all(start);
    const pipeline = db.prepare(`SELECT status k, COUNT(*) n, COALESCE(SUM(proposal_total),0) v FROM estimates GROUP BY status`).all();
    const topCustomers = db.prepare(`SELECT COALESCE(NULLIF(company,''),customer_name) k, COUNT(*) n, COALESCE(SUM(amount),0) billed, COALESCE(SUM(paid_amount),0) paid FROM invoices GROUP BY k ORDER BY billed DESC LIMIT 8`).all();
    const w = decided.w || 0, l = decided.l || 0;
    const one = (sql, ...a) => { try { return db.prepare(sql).get(...a) || {}; } catch { return {}; } };
    const all = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };
    const calls = byMonth(`SELECT substr(created_at,1,7) m, COUNT(*) n, SUM(outcome IN ('Missed','Voicemail')) v FROM calls WHERE created_at>=? GROUP BY m`);
    const billed = byMonth(`SELECT substr(created_at,1,7) m, COUNT(*) n, COALESCE(SUM(amount),0) v FROM invoices WHERE created_at>=? AND status<>'Void' GROUP BY m`);
    const quality = byMonth(`SELECT substr(date,1,7) m, COUNT(*) n, ROUND(AVG(score),1) v FROM inspections WHERE date>=? GROUP BY m`);
    // Start-to-finish flow for the period: every stage a job passes through.
    const flow = [
      ['Calls logged', one(`SELECT COUNT(*) n FROM calls WHERE created_at>=?`, start).n],
      ['Leads & quote requests', one(`SELECT COUNT(*) n FROM leads WHERE kind IN ('bid','inquiry') AND created_at>=?`, start).n],
      ['Estimates drafted automatically', one(`SELECT COUNT(*) n FROM leads WHERE auto_estimate_id>0 AND created_at>=?`, start).n],
      ['Estimates created', one(`SELECT COUNT(*) n FROM estimates WHERE created_at>=?`, start).n],
      ['Proposals sent', one(`SELECT COUNT(*) n FROM estimates WHERE sent_at>=?`, start).n],
      ['Viewed by customer', one(`SELECT COUNT(*) n FROM estimates WHERE viewed_at>=?`, start).n],
      ['Approved (won)', w],
      ['Contracts', one(`SELECT COUNT(*) n FROM contracts WHERE created_at>=?`, start).n],
      ['Projects', one(`SELECT COUNT(*) n FROM projects WHERE created_at>=?`, start).n],
      ['Site visits & phases scheduled', one(`SELECT COUNT(*) n FROM visits WHERE created_at>=?`, start).n],
      ['Inspections', one(`SELECT COUNT(*) n FROM inspections WHERE created_at>=?`, start).n],
      ['Invoices issued', one(`SELECT COUNT(*) n FROM invoices WHERE created_at>=? AND status<>'Void'`, start).n],
      ['Invoices paid in full', one(`SELECT COUNT(*) n FROM invoices WHERE created_at>=? AND status='Paid'`, start).n]
    ].map(([k, n]) => ({ k, n: n || 0 }));
    const today = new Date().toISOString().slice(0, 10);
    const recv = one(`SELECT COALESCE(SUM(amount),0) billed, COALESCE(SUM(paid_amount),0) paid, COALESCE(SUM(CASE WHEN paid_amount<amount THEN amount-paid_amount END),0) outstanding,
      COALESCE(SUM(CASE WHEN paid_amount<amount AND due_date<>'' AND due_date<? THEN amount-paid_amount END),0) overdue, SUM(CASE WHEN paid_amount<amount AND due_date<>'' AND due_date<? THEN 1 END) overdue_n FROM invoices WHERE status<>'Void'`, today, today);
    const ops = {
      projects_active: one(`SELECT COUNT(*) n FROM projects WHERE status NOT IN ('Completed','On Hold')`).n || 0,
      projects_completed: one(`SELECT COUNT(*) n FROM projects WHERE status='Completed'`).n || 0,
      visits_done: one(`SELECT COUNT(*) n FROM visits WHERE status='Done' AND date>=?`, start).n || 0,
      visits_upcoming: one(`SELECT COUNT(*) n FROM visits WHERE status='Scheduled' AND date>=?`, today).n || 0,
      inspections: one(`SELECT COUNT(*) n, ROUND(AVG(score),1) avg, SUM(passed=0) failed FROM inspections WHERE date>=?`, start),
      complaints: one(`SELECT COUNT(*) n, SUM(status IN ('Resolved','Verified','Closed')) resolved, ROUND(AVG(CASE WHEN status IN ('Resolved','Verified','Closed') THEN julianday(updated_at)-julianday(created_at) END),1) days FROM customer_issues WHERE type='complaint' AND created_at>=?`, start),
      tasks_open: one(`SELECT COUNT(*) n FROM customer_issues WHERE type IN ('task','follow_up') AND status NOT IN ('Resolved','Verified','Closed')`).n || 0,
      tasks_overdue: one(`SELECT COUNT(*) n FROM customer_issues WHERE status NOT IN ('Resolved','Verified','Closed') AND due_date<>'' AND due_date<?`, today).n || 0,
      calls: one(`SELECT COUNT(*) n, SUM(outcome IN ('Missed','Voicemail')) missed, SUM(lead_id IS NOT NULL) to_leads FROM calls WHERE created_at>=?`, start)
    };
    const automation = {
      ai_triaged: one(`SELECT COUNT(*) n FROM automation_log WHERE kind='ai_lead_triage' AND status='ok' AND created_at>=?`, start).n || 0,
      ai_info_requests: one(`SELECT COUNT(*) n FROM automation_log WHERE kind='ai_info_request' AND status='ok' AND created_at>=?`, start).n || 0,
      ai_takeoffs: one(`SELECT COUNT(*) n FROM automation_log WHERE kind='ai_takeoff' AND status='ok' AND created_at>=?`, start).n || 0,
      ai_failures: one(`SELECT COUNT(*) n FROM automation_log WHERE kind LIKE 'ai_%' AND status='failed' AND created_at>=?`, start).n || 0,
      auto_estimates: one(`SELECT COUNT(*) n FROM audit_log WHERE actor='automation' AND action='drafted' AND created_at>=?`, start).n || 0,
      reminders: one(`SELECT COUNT(*) n FROM automation_log WHERE kind NOT LIKE 'ai_%' AND status='sent' AND created_at>=?`, start).n || 0,
      emails_sent: one(`SELECT COUNT(*) n FROM email_log WHERE status='sent' AND created_at>=?`, start).n || 0,
      emails_failed: one(`SELECT COUNT(*) n FROM email_log WHERE status='failed' AND created_at>=?`, start).n || 0,
      approvals: one(`SELECT COUNT(*) n FROM estimate_approvals WHERE created_at>=?`, start).n || 0
    };
    const leadServices = all(`SELECT COALESCE(json_extract(intake,'$.service'), CASE kind WHEN 'bid' THEN 'bid (no form)' ELSE kind END) k, COUNT(*) n, SUM(auto_estimate_id>0) drafted FROM leads WHERE kind IN ('bid','inquiry') AND created_at>=? GROUP BY k ORDER BY n DESC`, start);
    // Executive figures: each financial stage is its own measure. An approved proposal is not a contract,
    // a contract is not an invoice, and an invoice is not cash.
    const approved = one(`SELECT COUNT(*) n, COALESCE(SUM(proposal_total),0) v, SUM(CASE WHEN total_cost>0 THEN proposal_total-total_cost END) gp, SUM(total_cost>0) costed FROM estimates WHERE status='Approved' AND COALESCE(decided_at,updated_at)>=?`, start);
    const signed = one(`SELECT COUNT(*) n, COALESCE(SUM(value),0) v FROM contracts WHERE signature_status IN ('Signed','Executed','Fully signed') AND created_at>=?`, start);
    const unsigned = one(`SELECT COUNT(*) n, COALESCE(SUM(value),0) v FROM contracts WHERE COALESCE(signature_status,'Not sent') NOT IN ('Signed','Executed','Fully signed') AND status<>'Cancelled'`);
    const invoiced = one(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) v FROM invoices WHERE status<>'Void' AND created_at>=?`, start);
    const cash = one(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) v FROM payments WHERE received_at>=?`, start);
    const executive = {
      approved_proposals: { value: approved.v, count: approved.n || 0 },
      signed_contracts: { value: signed.v, count: signed.n || 0 },
      unsigned_contracts: { value: unsigned.v, count: unsigned.n || 0 },
      invoiced: { value: invoiced.v, count: invoiced.n || 0 },
      collected: { value: cash.v, count: cash.n || 0 },
      outstanding: { value: recv.outstanding, count: one(`SELECT COUNT(*) n FROM invoices WHERE status<>'Void' AND paid_amount<amount`).n || 0 },
      overdue: { value: recv.overdue, count: recv.overdue_n || 0 },
      active_projects: ops.projects_active, completed_projects: ops.projects_completed,
      est_gross_profit: { value: approved.gp == null ? null : Math.round(approved.gp * 100) / 100, based_on: approved.costed || 0, of: approved.n || 0, note: 'Estimate: approved proposal price minus estimated cost. Not recorded profit.' },
      actual_gross_profit: { value: null, note: 'No job costs are recorded yet (labor time, supplies and expenses), so actual profit cannot be calculated.' }
    };
    const decidedN = w + l;
    const win = { rate: decidedN ? Math.round(w / decidedN * 1000) / 10 : null, won: w, lost: l, sample: decidedN,
      definition: 'Won ÷ (won + lost) for proposals the customer decided in this period. Proposals still waiting are not counted.', small_sample: decidedN < 5 };
    // Data integrity: things that make a figure incomplete or need a decision.
    const issues = [];
    const uncat = all(`SELECT id, project_name, customer_name, proposal_total FROM estimates WHERE (scope_category IS NULL OR scope_category='') AND status IN ('Sent','Viewed','Approved') ORDER BY id DESC LIMIT 20`);
    if (uncat.length) issues.push({ level: 'review', text: `${uncat.length} sent or approved proposal(s) have no service category, so service reports show them as "Not categorized".`, ids: uncat.map(x => x.id), kind: 'estimate' });
    const apNoContract = all(`SELECT e.id FROM estimates e WHERE e.status='Approved' AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.estimate_id=e.id)`);
    if (apNoContract.length) issues.push({ level: 'review', text: `${apNoContract.length} approved proposal(s) have no contract yet.`, ids: apNoContract.map(x => x.id), kind: 'estimate' });
    if (unsigned.n) issues.push({ level: 'info', text: `${unsigned.n} contract(s) worth ${'$' + Number(unsigned.v).toLocaleString('en-US', { minimumFractionDigits: 2 })} are not signed, so they are not counted as signed contract value.` });
    const projNoInv = one(`SELECT COUNT(*) n FROM projects p WHERE p.status IN ('In Progress','Completed','Quality Review') AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.project_id=p.id)`).n;
    if (projNoInv) issues.push({ level: 'review', text: `${projNoInv} project(s) in progress or completed have no invoice.` });
    const huge = all(`SELECT id, proposal_total, labor_hours FROM estimates WHERE labor_hours>3000*COALESCE(visits,1) OR (proposal_total>0 AND area_sqft>0 AND proposal_total/area_sqft>25)`);
    if (huge.length) issues.push({ level: 'warning', text: `${huge.length} estimate(s) look unusual (very high labor hours or price per square foot). Check them before relying on totals.`, ids: huge.map(x => x.id), kind: 'estimate' });
    if (!executive.collected.count && executive.approved_proposals.count) issues.push({ level: 'info', text: 'No payments are recorded for this period. Approved work is not cash until a payment is recorded on an invoice.' });
    issues.push({ level: 'info', text: 'Not tracked yet: labor hours worked, crew utilization, supplies and expenses. Actual profit and productivity need time tracking and expense entry.' });
    return { period: { start, end: new Date().toISOString().slice(0, 10), months }, months: keys, leads, sent, won, collected, calls, billed, quality, flow, receivables: recv, ops, automation, lead_services: leadServices, executive, win, data_issues: issues,
      win_rate: win.rate, won_count: w, lost_count: l, won_value: decided.wv, avg_won: w ? Math.round(decided.wv / w * 100) / 100 : null, by_service: byService, pipeline, top_customers: topCustomers };
  }
  app.locals.bcReport = buildReport;
  app.get('/api/admin/reports', auth, (req, res) => res.json(buildReport(req.query.months)));
  app.get('/api/admin/reports/export.csv', auth, (req, res) => {
    const r = buildReport(req.query.months), q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Bright Clean report', `${r.period.start} to ${r.period.end}`], [], ['Measure', 'Value', 'Count'],
      ['Approved proposal value', r.executive.approved_proposals.value, r.executive.approved_proposals.count], ['Signed contract value', r.executive.signed_contracts.value, r.executive.signed_contracts.count],
      ['Invoiced', r.executive.invoiced.value, r.executive.invoiced.count], ['Cash collected', r.executive.collected.value, r.executive.collected.count],
      ['Outstanding', r.executive.outstanding.value, r.executive.outstanding.count], ['Overdue', r.executive.overdue.value, r.executive.overdue.count],
      ['Win rate %', r.win.rate ?? '', `${r.win.won} won of ${r.win.sample} decided`], [], ['Stage', 'Count'], ...r.flow.map(f => [f.k, f.n]), [],
      ['Month', 'Calls', 'Leads', 'Proposals sent', 'Won', 'Won value', 'Billed', 'Collected', 'Inspection avg'],
      ...r.months.map((m, i) => [m, r.calls[i].n, r.leads[i].n, r.sent[i].n, r.won[i].n, r.won[i].v, r.billed[i].v, r.collected[i].v, r.quality[i].n ? r.quality[i].v : '']), [],
      ['Data notes'], ...r.data_issues.map(x => [x.level, x.text])];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bright-clean-report-${r.period.end}.csv"`);
    res.send(rows.map(x => x.map(q).join(',')).join('\n'));
  });

  // ---------- Takeoffs: quantities from drawings, each with its source ----------
  db.exec(`CREATE TABLE IF NOT EXISTS takeoffs(id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER, project_id INTEGER, customer_id INTEGER,
    name TEXT NOT NULL, category TEXT NOT NULL, building_sf REAL, lines TEXT NOT NULL DEFAULT '[]', questions TEXT, estimate_id INTEGER,
    status TEXT NOT NULL DEFAULT 'Draft', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_log(id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, subject TEXT, body TEXT, status TEXT NOT NULL, error TEXT, provider TEXT, created_at TEXT NOT NULL);`);
  const METHODS = ['Measured', 'From schedule', 'Entered', 'Inferred'];
  const CATS = ['construction', 'multifamily', 'janitorial', 'specialty'];
  function takeoffValidate(b, cur) {
    const out = {}, errs = [];
    if (!cur || 'name' in b) { const n = clean(b.name, 200); if (!n) errs.push('Name the takeoff (for example the project and drawing set).'); else out.name = n; }
    if (!cur || 'category' in b) { if (!CATS.includes(b.category)) errs.push('Choose the service category.'); else out.category = b.category; }
    if ('building_sf' in b) { const v = b.building_sf === '' || b.building_sf == null ? null : Number(String(b.building_sf).replace(/,/g, '')); if (v !== null && !(v > 0 && v < 1e8)) errs.push('Building square footage must be a positive number.'); else out.building_sf = v; }
    if ('questions' in b) out.questions = clean(b.questions, 5000);
    if ('status' in b) out.status = pick(b.status, ['Draft', 'Reviewed', 'Estimated'], 'Draft');
    for (const [k, t] of [['document_id', 'documents'], ['project_id', 'projects'], ['customer_id', 'customers']]) if (k in b) { const v = idOrNull(b[k]); if (!exists(t, v)) errs.push(`That ${t.slice(0, -1)} was not found.`); else out[k] = v; }
    if ('lines' in b) {
      const cat = out.category || (cur && cur.category);
      const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 200).map(l => ({ scope_id: Number(l && l.scope_id), quantity: Number(String(l && l.quantity).replace(/,/g, '')),
        sheet: clean(l && l.sheet, 60), method: pick(l && l.method, METHODS, 'Entered'), note: clean(l && l.note, 300) }));
      for (const l of lines) {
        const sc = db.prepare('SELECT name, category, active FROM scope_items WHERE id=?').get(l.scope_id);
        if (!sc || !sc.active) { errs.push('A takeoff line refers to a scope item that no longer exists.'); break; }
        if (sc.category !== cat) { errs.push(`"${sc.name}" is not a ${cat} item.`); break; }
        if (!(l.quantity > 0)) { errs.push(`Enter a quantity for "${sc.name}".`); break; }
        if (l.method !== 'Entered' && !l.sheet) { errs.push(`"${sc.name}" is marked ${l.method.toLowerCase()} but has no source sheet. Add the sheet number (for example A1.1).`); break; }
      }
      out.lines = JSON.stringify(lines);
    }
    return { out, errs };
  }
  const tRow = r => r && ({ ...r, lines: JSON.parse(r.lines || '[]') });
  app.get('/api/admin/takeoffs', auth, (req, res) => {
    const rows = db.prepare(`SELECT t.*, d.title document_title, d.revision document_revision, c.company customer_company, c.name customer_name FROM takeoffs t
      LEFT JOIN documents d ON d.id=t.document_id LEFT JOIN customers c ON c.id=t.customer_id ORDER BY t.id DESC LIMIT 300`).all().map(tRow);
    res.json({ takeoffs: rows, methods: METHODS });
  });
  app.post('/api/admin/takeoffs', auth, (req, res) => {
    const { out, errs } = takeoffValidate({ lines: [], ...(req.body || {}) }, null);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const cols = Object.keys(out), t = now();
    const info = db.prepare(`INSERT INTO takeoffs(${cols.join(',')},created_by,created_at,updated_at) VALUES(${cols.map(() => '?').join(',')},?,?,?)`).run(...cols.map(c => out[c]), who(req), t, t);
    logAction(req, 'created', 'takeoff', info.lastInsertRowid, out.name);
    res.status(201).json({ takeoff: tRow(db.prepare('SELECT * FROM takeoffs WHERE id=?').get(info.lastInsertRowid)) });
  });
  app.patch('/api/admin/takeoffs/:id', auth, (req, res) => {
    const cur = db.prepare('SELECT * FROM takeoffs WHERE id=?').get(Number(req.params.id)); if (!cur) return res.status(404).json({ error: 'Not found.' });
    const b = { ...(req.body || {}) };
    if ('category' in b && b.category !== cur.category && !('lines' in b)) b.lines = [];
    const { out, errs } = takeoffValidate(b, cur);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const cols = Object.keys(out);
    if (cols.length) db.prepare(`UPDATE takeoffs SET ${cols.map(c => c + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map(c => out[c]), now(), cur.id);
    logAction(req, 'updated', 'takeoff', cur.id, cols.join(', '));
    res.json({ takeoff: tRow(db.prepare('SELECT * FROM takeoffs WHERE id=?').get(cur.id)) });
  });

  app.post('/api/admin/takeoffs/:id/link', auth, (req, res) => {
    const cur = db.prepare('SELECT * FROM takeoffs WHERE id=?').get(Number(req.params.id)); if (!cur) return res.status(404).json({ error: 'Not found.' });
    const eid = Number(req.body && req.body.estimate_id);
    if (!db.prepare('SELECT 1 FROM estimates WHERE id=?').get(eid)) return res.status(400).json({ error: 'That estimate was not found.' });
    db.prepare("UPDATE takeoffs SET estimate_id=?, status='Estimated', updated_at=? WHERE id=?").run(eid, now(), cur.id);
    logAction(req, 'priced', 'takeoff', cur.id, 'estimate #' + eid);
    res.json({ ok: true });
  });

  // ---------- Email Center: every email the system sends ----------
  app.get('/api/admin/emails', auth, (req, res) => {
    const rows = db.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 500').all();
    const s = db.prepare(`SELECT COUNT(*) n, SUM(status='sent') sent, SUM(status='failed') failed FROM email_log WHERE created_at>=?`).get(new Date(Date.now() - 30 * 864e5).toISOString());
    res.json({ emails: rows, summary: { sent_30d: s.sent || 0, failed_30d: s.failed || 0, total_30d: s.n || 0 } });
  });

  // ---------- Drawing and document library ----------
  const KINDS = ['Drawings', 'Specifications', 'Addendum', 'Finish schedule', 'Photos', 'Proposal', 'Contract', 'Other'];
  app.get('/api/admin/documents', auth, (req, res) => {
    const where = [], args = [];
    for (const k of ['project_id', 'customer_id', 'lead_id']) if (req.query[k]) { where.push(`d.${k}=?`); args.push(Number(req.query[k])); }
    const rows = db.prepare(`SELECT d.*, p.name project_name, c.company customer_company, c.name customer_name FROM documents d LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN customers c ON c.id=d.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.id DESC LIMIT 500`).all(...args);
    res.json({ documents: rows, kinds: KINDS, ai_ready: !!process.env.ANTHROPIC_API_KEY });
  });
  app.post('/api/admin/documents', auth, upload.array('files', 8), (req, res) => {
    const b = req.body || {}, files = req.files || [];
    const discard = () => files.forEach(f => { try { fs.unlinkSync(f.path); } catch { /* ignore */ } });
    const errs = [];
    if (!files.length) errs.push('Choose at least one file to upload.');
    const pid = idOrNull(b.project_id), cid = idOrNull(b.customer_id), lid = idOrNull(b.lead_id), iid = idOrNull(b.issue_id), qid = idOrNull(b.inspection_id);
    const eid = idOrNull(b.estimate_id); if (!exists('estimates', eid)) errs.push('The linked proposal was not found.');
    let cidX = cid; if (eid && !cidX) { const e = db.prepare('SELECT company, email FROM estimates WHERE id=?').get(eid); const m = e && db.prepare("SELECT id FROM customers WHERE (?<>'' AND lower(company)=lower(?)) OR (?<>'' AND lower(email)=lower(?)) ORDER BY id LIMIT 1").get(e.company || '', e.company || '', e.email || '', e.email || ''); cidX = m ? m.id : null; }
    if (!exists('projects', pid) || !exists('customers', cid) || !exists('leads', lid) || !exists('customer_issues', iid) || !exists('inspections', qid)) errs.push('The linked project, customer, lead or item was not found.');
    if (errs.length) { discard(); return res.status(400).json({ error: errs.join(' ') }); }
    const kind = pick(b.kind, KINDS, 'Drawings'), t = now(), ids = [];
    for (const f of files) {
      const title = clean(b.title, 200) && files.length === 1 ? clean(b.title, 200) : f.originalname;
      ids.push(db.prepare(`INSERT INTO documents(project_id,customer_id,lead_id,issue_id,inspection_id,title,kind,revision,file_name,file_url,size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(pid, cidX, lid, iid, qid, title, kind, clean(b.revision, 40), f.originalname, '/api/files/' + path.basename(f.filename), f.size, who(req), t).lastInsertRowid);
      if (eid) { try { db.prepare('UPDATE documents SET estimate_id=? WHERE id=?').run(eid, ids[ids.length - 1]); } catch { /* column added by docs2 */ } }
    }
    logAction(req, 'uploaded', 'document', ids[0], `${ids.length} file(s): ${kind}`);
    res.status(201).json({ ids });
  });
  app.patch('/api/admin/documents/:id', auth, (req, res) => {
    const cur = db.prepare('SELECT * FROM documents WHERE id=?').get(Number(req.params.id)); if (!cur) return res.status(404).json({ error: 'Not found.' });
    const b = req.body || {}, set = {};
    if ('title' in b) { const t = clean(b.title, 200); if (!t) return res.status(400).json({ error: 'A title is required.' }); set.title = t; }
    if ('kind' in b) set.kind = pick(b.kind, KINDS, cur.kind);
    if ('revision' in b) set.revision = clean(b.revision, 40);
    for (const [k, t] of [['customer_id', 'customers'], ['project_id', 'projects']]) if (k in b) { const v = idOrNull(b[k]); if (!exists(t, v)) return res.status(400).json({ error: `That ${t.slice(0, -1)} was not found.` }); set[k] = v; }
    const cols = Object.keys(set);
    if (cols.length) db.prepare(`UPDATE documents SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`).run(...cols.map(c => set[c]), cur.id);
    logAction(req, 'updated', 'document', cur.id, cols.join(', '));
    res.json({ document: db.prepare('SELECT * FROM documents WHERE id=?').get(cur.id) });
  });
};
