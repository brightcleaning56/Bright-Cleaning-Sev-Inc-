// Lead history: who worked a lead, what happened, and when. It is append-only: the database refuses to
// change or delete a history entry, so nobody can quietly rewrite it.
//
// Recorded here: received, viewed, notes, emails, meetings, status changes, assignments, follow-ups, conversion.
// Read from their own records (not copied): calls (calls.lead_id) and estimates (estimates.lead_id).
//
// Accountability rule: opening a lead ('viewed') is recorded but is NOT counted as work. Only the meaningful kinds
// below count toward "last worked" and "days since contact".
const MEANINGFUL = ['note', 'email', 'meeting', 'status', 'follow_up', 'call', 'estimate', 'converted'];
const READY = new WeakSet();

function init(db) {
  if (READY.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS lead_activity(
    id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL,
    detail TEXT, actor TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS lead_activity_lead ON lead_activity(lead_id, created_at);
    CREATE TRIGGER IF NOT EXISTS lead_activity_no_update BEFORE UPDATE ON lead_activity BEGIN SELECT RAISE(ABORT, 'Lead history cannot be changed.'); END;
    CREATE TRIGGER IF NOT EXISTS lead_activity_no_delete BEFORE DELETE ON lead_activity BEGIN SELECT RAISE(ABORT, 'Lead history cannot be deleted.'); END;`);
  READY.add(db);
}

// Records one entry. actor is the signed-in person's email, or 'System'.
function record(db, leadId, kind, summary, actor, detail, at) {
  init(db);
  if (!Number(leadId)) return;
  db.prepare('INSERT INTO lead_activity(lead_id, kind, summary, detail, actor, created_at) VALUES(?,?,?,?,?,?)')
    .run(Number(leadId), kind, String(summary || '').slice(0, 500), detail ? String(detail).slice(0, 2000) : null, actor || 'System', at || new Date().toISOString());
}

// The full history of a lead, oldest first, with the summary fields the screen needs.
function timeline(db, lead, today) {
  init(db);
  const recorded = db.prepare('SELECT id, kind, summary, detail, actor, created_at FROM lead_activity WHERE lead_id=? ORDER BY created_at, id').all(lead.id)
    .map(r => ({ ...r, source: 'history' }));
  const calls = db.prepare("SELECT id, direction, outcome, summary, contact_name, created_at FROM calls WHERE lead_id=?").all(lead.id)
    .map(c => ({ id: 'call-' + c.id, kind: 'call', summary: `${c.direction || ''} call: ${c.outcome || 'logged'}`.trim(), detail: c.summary || null, actor: 'Call log', created_at: c.created_at, source: 'call' }));
  const estimates = db.prepare('SELECT id, version, status, proposal_total, created_at FROM estimates WHERE lead_id=?').all(lead.id)
    .map(e => ({ id: 'estimate-' + e.id, kind: 'estimate', summary: `Estimate #${e.id} (${e.status || 'draft'}) $${Number(e.proposal_total || 0).toFixed(2)}`, detail: null, actor: 'Estimates', created_at: e.created_at, source: 'estimate' }));
  const entries = [...recorded, ...calls, ...estimates].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const meaningful = entries.filter(e => MEANINGFUL.includes(e.kind));
  const last = meaningful[meaningful.length - 1] || null;
  const lastAt = last ? last.created_at : null;
  const days = lastAt ? Math.floor((Date.parse(today + 'T23:59:59Z') - Date.parse(lastAt)) / 86400000) : null;
  const open = !['Won', 'Lost', 'Archived', 'converted'].includes(lead.status) && !lead.customer_id;
  const overdue = !!(open && lead.follow_up_date && lead.follow_up_date < today);
  return {
    lead: {
      id: lead.id, status: lead.status, assigned_to: lead.assigned_to || null,
      follow_up_date: lead.follow_up_date || null, follow_up_overdue: overdue,
      last_activity_at: lastAt, last_worked_by: last ? last.actor : null, days_since_contact: days,
      no_work_yet: !last
    },
    entries
  };
}

// Mounts the lead history routes. touchLead (from leadstage) creates follow-up tasks in Today's Work.
function mount(app, { db, auth, roleOf, touchLead, logAction }) {
  init(db);
  const today = () => require('./bizdate').today();
  const who = req => (req.user && req.user.email) || 'Unknown';

  app.get('/api/admin/leads/:id/activity', auth, (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    // Opening the lead is recorded once per person per hour; it is not counted as work.
    const recent = db.prepare("SELECT 1 FROM lead_activity WHERE lead_id=? AND kind='viewed' AND actor=? AND created_at > ? LIMIT 1").get(lead.id, who(req), new Date(Date.now() - 3600000).toISOString());
    if (!recent) record(db, lead.id, 'viewed', `Opened by ${who(req)}`, who(req));
    if (!db.prepare("SELECT 1 FROM lead_activity WHERE lead_id=? AND kind='received' LIMIT 1").get(lead.id)) record(db, lead.id, 'received', 'Lead received', 'System', null, lead.created_at);
    res.json(timeline(db, lead, today()));
  });

  // Manual entries: a note, an email you sent, or a meeting. Each is stamped with who wrote it and when.
  app.post('/api/admin/leads/:id/activity', auth, (req, res) => {
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(Number(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    const b = req.body || {};
    const kind = ['note', 'email', 'meeting'].includes(b.kind) ? b.kind : null;
    const summary = String(b.summary || '').trim();
    if (!kind) return res.status(400).json({ error: 'Choose what this is: a note, an email or a meeting.' });
    if (summary.length < 3) return res.status(400).json({ error: 'Describe what happened (a few words).' });
    record(db, lead.id, kind, summary.slice(0, 500), who(req), b.detail ? String(b.detail) : null);
    if (b.follow_up_date && /^\d{4}-\d{2}-\d{2}$/.test(b.follow_up_date) && touchLead) touchLead(lead.id, b.follow_up_date, 'Next step: ' + summary.slice(0, 200), who(req));
    logAction && logAction(req, 'logged ' + kind, 'lead', lead.id, summary.slice(0, 200));
    res.json(timeline(db, db.prepare('SELECT * FROM leads WHERE id=?').get(lead.id), today()));
  });
}

module.exports = { mount, record, timeline, MEANINGFUL };
