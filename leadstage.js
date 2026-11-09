// Lead stages and follow-ups. A lead is in exactly one stage:
//   new        nobody has touched it yet
//   worked     someone added a note, changed the status, called it, or sent a reply
//   waiting    questions or a reply have gone to the customer; waiting for them
//   followup   a follow-up date is set; hidden from the open list until that date, and a task is created in Issues & tasks
//   converted  it is now a customer (still linked to its quotes)
//   done       won, lost or archived
// Stage changes are made by the system at each action, so nobody has to remember to update them.
const FOLLOW_ROLES = ['owner', 'manager', 'staff', 'sales'];

module.exports = function (app, { db, auth, logAction, clean, roleOf, ops }) {
  const cols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  for (const [c, t] of [['stage', "TEXT NOT NULL DEFAULT 'new'"], ['follow_up_date', 'TEXT'], ['follow_up_note', 'TEXT'], ['follow_up_issue_id', 'INTEGER'], ['customer_id', 'INTEGER'], ['intake', 'TEXT']]) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE leads ADD COLUMN ${c} ${t}`);
  }
  // Where each lead came from. 'website' = they filled in a form; 'inbound_call' = they called us; 'portal' = a customer
  // sent it from the client portal; 'outbound' = staff added this contact to reach out to. The AI uses this to write the right email.
  if (!db.prepare('PRAGMA table_info(leads)').all().some(c => c.name === 'origin')) db.exec('ALTER TABLE leads ADD COLUMN origin TEXT');
  db.exec(`CREATE TRIGGER IF NOT EXISTS leads_origin_set AFTER INSERT ON leads WHEN NEW.origin IS NULL BEGIN
    UPDATE leads SET origin = CASE
      WHEN NEW.details LIKE 'Source: Phone call%' THEN 'inbound_call'
      WHEN NEW.details LIKE 'Source: client portal%' THEN 'portal'
      WHEN NEW.intake IS NOT NULL THEN 'website'
      ELSE 'outbound' END WHERE id = NEW.id;
  END`);
  // Leads from before this change: same rules.
  db.exec(`UPDATE leads SET origin = CASE
      WHEN details LIKE 'Source: Phone call%' THEN 'inbound_call'
      WHEN details LIKE 'Source: client portal%' THEN 'portal'
      WHEN intake IS NOT NULL THEN 'website'
      ELSE 'outbound' END WHERE origin IS NULL`);

  // Contact-form messages were filed as 'added by staff' before origins were set on insert. The audit log records each one.
  try { db.exec("UPDATE leads SET origin='website' WHERE origin='outbound' AND id IN (SELECT entity_id FROM audit_log WHERE entity='contact message' AND action='received')"); } catch { /* audit log not present yet */ }

  // One-time backfill for leads that existed before stages: anything touched is "worked", closed ones are "done".
  if (!cols.includes('stage')) {
    db.exec(`UPDATE leads SET stage = CASE
      WHEN status IN ('Won','Lost','Archived') THEN 'done'
      WHEN status <> 'New' OR (notes IS NOT NULL AND notes <> '') THEN 'worked'
      ELSE 'new' END`);
  }

  const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));

  // Recalculates a lead's stage from its state (used after notes, status, bulk or follow-up changes).
  const recompute = id => db.prepare(`UPDATE leads SET stage = CASE
      WHEN status IN ('Won','Lost','Archived') THEN 'done'
      WHEN customer_id IS NOT NULL THEN 'converted'
      WHEN follow_up_date IS NOT NULL AND follow_up_date <> '' THEN 'followup'
      WHEN stage = 'waiting' THEN 'waiting'
      ELSE 'worked' END WHERE id=?`).run(Number(id));
  // Marks a lead as waiting on the customer (a reply or questions were emailed).
  const setWaiting = id => db.prepare(`UPDATE leads SET stage = 'waiting' WHERE id=? AND stage NOT IN ('done','followup')`).run(Number(id));
  app.locals.recomputeLeadStage = recompute;
  app.locals.setLeadWaiting = setWaiting;

  // One place that sets a follow-up: the lead leaves the open list until the date, and one task shows in Issues & tasks.
  // Any earlier follow-up task for this lead is closed, so there is never more than one.
  const scheduleFollowUp = (lead, date, note, who) => {
    const t = new Date().toISOString();
    if (lead.follow_up_issue_id) db.prepare("UPDATE customer_issues SET status='Closed', resolved_at=?, updated_at=? WHERE id=?").run(t, t, lead.follow_up_issue_id);
    const title = `Follow up: ${lead.contact_name || lead.company || 'lead #' + lead.id}`.slice(0, 200);
    const issueId = db.prepare("INSERT INTO customer_issues(type,title,description,priority,status,due_date,customer_comms,created_by,created_at,updated_at) VALUES('follow_up',?,?,?,?,?,?,?,?,?)")
      .run(title, `${note}\nLead #${lead.id}${lead.email ? ' · ' + lead.email : ''}${lead.phone ? ' · ' + lead.phone : ''}`, 'Normal', 'Open', date, 'Not needed', who || 'admin', t, t).lastInsertRowid;
    db.prepare('UPDATE leads SET follow_up_date=?, follow_up_note=?, follow_up_issue_id=?, updated_at=? WHERE id=?').run(date, note, issueId, t, lead.id);
    recompute(lead.id);
    return issueId;
  };
  // One place that clears a follow-up: the lead returns to its normal stage and its task is closed.
  const clearFollowUp = lead => {
    const t = new Date().toISOString();
    if (lead.follow_up_issue_id) db.prepare("UPDATE customer_issues SET status='Closed', resolved_at=?, updated_at=? WHERE id=?").run(t, t, lead.follow_up_issue_id);
    db.prepare('UPDATE leads SET follow_up_date=NULL, follow_up_note=NULL, follow_up_issue_id=NULL, updated_at=? WHERE id=?').run(t, lead.id);
    recompute(lead.id);
  };

  // Any call, reply or callback touches the lead ("new" becomes "worked"). A follow-up date from a call uses the same
  // follow-up as the lead drawer, so it hides the lead and creates the task.
  const touchLead = (id, followUp, note, who) => {
    const n = Number(id); if (!n) return;
    const t = new Date().toISOString();
    db.prepare("UPDATE leads SET stage = CASE WHEN stage = 'new' THEN 'worked' ELSE stage END, updated_at=? WHERE id=? AND status NOT IN ('Won','Lost','Archived')").run(t, n);
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(n);
    if (lead && validDate(followUp) && lead.follow_up_date !== followUp) scheduleFollowUp(lead, followUp, clean(note, 300) || 'Follow up after a call', who);
    else recompute(n);
  };
  // Clearing a call's follow-up clears the lead's follow-up too, but only when it is the same date (so a later follow-up is kept).
  const clearIfSameDate = (id, date) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(Number(id));
    if (lead && lead.follow_up_date && lead.follow_up_date === date) clearFollowUp(lead);
  };
  app.locals.touchLead = touchLead;
  app.locals.clearLeadFollowUpIfSameDate = clearIfSameDate;

  // Turn a lead into a customer. The customer is matched on email or company first, so the same business is never listed twice.
  // The lead keeps its quote history and stays linked; it moves to "converted" and leaves the open list.
  app.post('/api/admin/leads/:id/convert', auth, (req, res) => {
    if (!FOLLOW_ROLES.includes(roleOf(req.user && req.user.email))) return res.status(403).json({ error: 'Your role cannot convert leads.' });
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    if (lead.customer_id) return res.json({ ok: true, customer_id: lead.customer_id, already: true });
    if (!ops || !ops.upsertCustomer) return res.status(500).json({ error: 'Customer records are not available right now.' });
    const cid = ops.upsertCustomer({ name: lead.contact_name, company: lead.company, email: lead.email, phone: lead.phone, address: lead.address }, 'converted lead #' + lead.id);
    if (!cid) return res.status(400).json({ error: 'Add a name, company, email or phone to the lead before converting it.' });
    db.prepare('UPDATE leads SET customer_id=?, updated_at=? WHERE id=?').run(cid, new Date().toISOString(), lead.id);
    recompute(lead.id);
    logAction(req, 'converted lead to customer', 'lead', lead.id, `customer #${cid}`);
    res.json({ ok: true, customer_id: cid });
  });

  // Set a follow-up from the lead drawer.
  app.post('/api/admin/leads/:id/follow-up', auth, (req, res) => {
    if (!FOLLOW_ROLES.includes(roleOf(req.user && req.user.email))) return res.status(403).json({ error: 'Your role cannot schedule follow-ups.' });
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    const b = req.body || {};
    if (!validDate(b.date)) return res.status(400).json({ error: 'Choose a follow-up date.' });
    const note = clean(b.note, 500) || 'Follow up on this lead';
    const issueId = scheduleFollowUp(lead, b.date, note, (req.user && req.user.email) || 'admin');
    logAction(req, 'scheduled follow-up', 'lead', lead.id, `${b.date}: ${note}`);
    res.json({ ok: true, issue_id: issueId });
  });

  // Clear a follow-up from the lead drawer.
  app.delete('/api/admin/leads/:id/follow-up', auth, (req, res) => {
    if (!FOLLOW_ROLES.includes(roleOf(req.user && req.user.email))) return res.status(403).json({ error: 'Your role cannot change follow-ups.' });
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    clearFollowUp(lead);
    logAction(req, 'cleared follow-up', 'lead', lead.id, '');
    res.json({ ok: true });
  });
};
