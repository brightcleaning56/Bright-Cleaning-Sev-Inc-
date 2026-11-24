// Who created each proposal. Sales staff see the proposals they created or were assigned on the work queue;
// owners and managers see every proposal, and can filter by person. Proposals saved before this was recorded
// have no creator, so only owners and managers see them until they are assigned.
module.exports = function mountEstimateOwner(app, { db, auth }) {
  try { db.exec('ALTER TABLE estimates ADD COLUMN created_by TEXT'); } catch (e) { /* column already exists */ }
  // A proposal always belongs to a lead, so "From lead #" is never blank. A proposal saved without one gets a lead:
  // the lead with the same email if there is one, otherwise a new lead. Saved as origin 'manual', so the automatic
  // first email never goes to it.
  // The lead for a proposal: the lead with the same email (or the same name and company when there is no email), else a new one.
  const findOrCreateLead = b => {
    const name = String(b.customer_name || '').trim();
    if (!name) return null;
    const email = String(b.email || '').trim().toLowerCase();
    let row = email
      ? db.prepare('SELECT id FROM leads WHERE lower(email)=? ORDER BY id DESC LIMIT 1').get(email)
      : db.prepare("SELECT id FROM leads WHERE lower(contact_name)=lower(?) AND lower(COALESCE(company,''))=lower(?) AND (email IS NULL OR email='') ORDER BY id DESC LIMIT 1").get(name, String(b.company || '').trim());
    if (!row) {
      const t = new Date().toISOString();
      const info = db.prepare("INSERT INTO leads(kind,status,contact_name,company,email,address,project_name,details,created_at,updated_at,origin) VALUES('bid','Proposal in Progress',?,?,?,?,?,?,?,?,'manual')")
        .run(name.slice(0, 200), String(b.company || '').trim().slice(0, 200), email, String(b.site_address || '').slice(0, 300), String(b.project_name || '').slice(0, 200), 'Created from a proposal', t, t);
      row = { id: info.lastInsertRowid };
    }
    return row.id;
  };
  // A proposal always belongs to a lead, so "From lead #" is never blank. A proposal saved without one gets a lead.
  const ensureLead = (req, res, next) => {
    try {
      const b = req.body || {};
      if (!Number(b.lead_id) && req.params && req.params.id) {
        const cur = db.prepare('SELECT lead_id FROM estimates WHERE id=?').get(Number(req.params.id));
        if (cur && cur.lead_id) b.lead_id = cur.lead_id;
      }
      if (!Number(b.lead_id)) { const id = findOrCreateLead(b); if (id) b.lead_id = id; }
    } catch (e) { /* the proposal still saves; the lead can be linked by hand */ }
    { const lid = Number((req.body || {}).lead_id); if (lid) { const l = db.prepare('SELECT status FROM leads WHERE id=?').get(lid); if (l && l.status === 'Archived') return res.status(409).json({ error: 'This lead is archived. Open the customer or start a new lead before writing a proposal.' }); if (l && l.status === 'Lost') return res.status(409).json({ error: 'This lead was lost. Reopen the lead, or start a new one, before writing a proposal.' }); } }
    next();
  };
  // The form asks for the lead as soon as a customer is named, so "From lead #" fills in before the first save.
  app.post('/api/admin/proposal-lead', auth, (req, res) => {
    try {
      const id = findOrCreateLead(req.body || {});
      if (!id) return res.status(400).json({ error: 'Enter the customer name first.' });
      res.json({ lead_id: id });
    } catch (e) { res.status(500).json({ error: 'The lead could not be created: ' + e.message }); }
  });
  // Edits go through the existing update handler (admin-ext), which saves lead_id from the request.
  app.put('/api/admin/estimates/:id', auth, ensureLead, (req, res, next) => next());
  // Runs before the create handler: once the proposal is saved, record who created it.
  app.post('/api/admin/estimates', auth, ensureLead, (req, res, next) => {
    const email = String((req.user && req.user.email) || '').toLowerCase();
    const json = res.json.bind(res);
    res.json = body => {
      try {
        if (body && body.estimate && body.estimate.id) {
          db.prepare('UPDATE estimates SET created_by=? WHERE id=? AND created_by IS NULL').run(email || null, body.estimate.id);
        }
      } catch (e) { /* the proposal is already saved; the creator is best-effort */ }
      return json(body);
    };
    next();
  });
};
