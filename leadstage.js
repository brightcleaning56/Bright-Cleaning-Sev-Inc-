// Lead stages and follow-ups. A lead is in exactly one stage:
//   new        nobody has touched it yet
//   worked     someone added a note, changed the status, or sent a reply
//   waiting    questions or a reply have gone to the customer; waiting for them
//   followup   a follow-up date is set; hidden from the open list until that date, and a task is created in Issues & tasks
//   done       won, lost or archived
// Stage changes are made by the system at each action, so nobody has to remember to update them.
const FOLLOW_ROLES = ['owner', 'manager', 'staff', 'sales'];

module.exports = function (app, { db, auth, logAction, clean, roleOf, who }) {
  const cols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  for (const [c, t] of [['stage', "TEXT NOT NULL DEFAULT 'new'"], ['follow_up_date', 'TEXT'], ['follow_up_note', 'TEXT'], ['follow_up_issue_id', 'INTEGER']]) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE leads ADD COLUMN ${c} ${t}`);
  }
  // One-time backfill for leads that existed before stages: anything touched is "worked", closed ones are "done".
  if (!cols.includes('stage')) {
    db.exec(`UPDATE leads SET stage = CASE
      WHEN status IN ('Won','Lost','Archived') THEN 'done'
      WHEN status <> 'New' OR (notes IS NOT NULL AND notes <> '') THEN 'worked'
      ELSE 'new' END`);
  }

  // Recalculates a lead's stage from its state (used after notes, status, bulk or follow-up changes).
  const recompute = id => db.prepare(`UPDATE leads SET stage = CASE
      WHEN status IN ('Won','Lost','Archived') THEN 'done'
      WHEN follow_up_date IS NOT NULL AND follow_up_date <> '' THEN 'followup'
      WHEN stage = 'waiting' THEN 'waiting'
      ELSE 'worked' END WHERE id=?`).run(Number(id));
  // Marks a lead as waiting on the customer (a reply or questions were emailed).
  const setWaiting = id => db.prepare(`UPDATE leads SET stage = 'waiting' WHERE id=? AND stage NOT IN ('done','followup')`).run(Number(id));
  app.locals.recomputeLeadStage = recompute;
  app.locals.setLeadWaiting = setWaiting;

  const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));

  // Set a follow-up: the lead leaves the open list until that date, and a task appears in Issues & tasks.
  app.post('/api/admin/leads/:id/follow-up', auth, (req, res) => {
    if (!FOLLOW_ROLES.includes(roleOf(req.user && req.user.email))) return res.status(403).json({ error: 'Your role cannot schedule follow-ups.' });
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    const b = req.body || {};
    if (!validDate(b.date)) return res.status(400).json({ error: 'Choose a follow-up date.' });
    const note = clean(b.note, 500) || 'Follow up on this lead';
    const t = new Date().toISOString();
    // Replace any earlier follow-up task for this lead.
    if (lead.follow_up_issue_id) db.prepare("UPDATE customer_issues SET status='Closed', resolved_at=?, updated_at=? WHERE id=?").run(t, t, lead.follow_up_issue_id);
    const who_ = (req.user && req.user.email) || 'admin';
    const title = `Follow up: ${lead.contact_name || lead.company || 'lead #' + lead.id}`.slice(0, 200);
    const issueId = db.prepare("INSERT INTO customer_issues(type,title,description,priority,status,due_date,customer_comms,created_by,created_at,updated_at) VALUES('follow_up',?,?,?,?,?,?,?,?,?)")
      .run(title, `${note}\nLead #${lead.id}${lead.email ? ' · ' + lead.email : ''}${lead.phone ? ' · ' + lead.phone : ''}`, 'Normal', 'Open', b.date, 'Not needed', who_, t, t).lastInsertRowid;
    db.prepare('UPDATE leads SET follow_up_date=?, follow_up_note=?, follow_up_issue_id=?, updated_at=? WHERE id=?').run(b.date, note, issueId, t, lead.id);
    recompute(lead.id);
    logAction(req, 'scheduled follow-up', 'lead', lead.id, `${b.date}: ${note}`);
    res.json({ ok: true, issue_id: issueId });
  });

  // Clear a follow-up: the lead returns to its normal stage and the task is closed.
  app.delete('/api/admin/leads/:id/follow-up', auth, (req, res) => {
    if (!FOLLOW_ROLES.includes(roleOf(req.user && req.user.email))) return res.status(403).json({ error: 'Your role cannot change follow-ups.' });
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    const t = new Date().toISOString();
    if (lead.follow_up_issue_id) db.prepare("UPDATE customer_issues SET status='Closed', resolved_at=?, updated_at=? WHERE id=?").run(t, t, lead.follow_up_issue_id);
    db.prepare('UPDATE leads SET follow_up_date=NULL, follow_up_note=NULL, follow_up_issue_id=NULL, updated_at=? WHERE id=?').run(t, lead.id);
    recompute(lead.id);
    logAction(req, 'cleared follow-up', 'lead', lead.id, '');
    res.json({ ok: true });
  });
};
