// Archive / restore a proposal. Archived proposals stay on record but leave Command Center and Reports totals.
// Owners and managers only. Archiving does not change the proposal status, so contract and project links are unaffected.
module.exports = function mountEstimateArchive(app, { db, auth, logAction }) {
  app.post('/api/admin/estimates/:id/archive', auth, (req, res) => {
    const em = String((req.user && req.user.email) || '').toLowerCase(), ow = String(process.env.ADMIN_EMAIL || '').toLowerCase();
    const role = !ow || em === ow ? 'owner' : ((db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(em) || {}).role || 'staff');
    if (!['owner', 'manager'].includes(role)) return res.status(403).json({ error: 'Only an owner or manager can archive proposals.' });
    const e = db.prepare('SELECT * FROM estimates WHERE id=?').get(Number(req.params.id));
    if (!e) return res.status(404).json({ error: 'Not found' });
    const archive = (req.body || {}).archive !== false;
    const t = new Date().toISOString();
    db.prepare('UPDATE estimates SET archived_at=?, archived_by=?, updated_at=? WHERE id=?').run(archive ? t : null, archive ? em : null, t, e.id);
    logAction(req, archive ? 'archived' : 'restored', 'estimate', e.id, `${e.project_name || e.customer_name || 'Proposal'} (${e.status})`);
    res.json({ ok: true, archived: archive });
  });
};
