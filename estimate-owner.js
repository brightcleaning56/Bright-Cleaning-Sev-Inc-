// Who created each proposal. Sales staff see the proposals they created or were assigned on the work queue;
// owners and managers see every proposal, and can filter by person. Proposals saved before this was recorded
// have no creator, so only owners and managers see them until they are assigned.
module.exports = function mountEstimateOwner(app, { db, auth }) {
  try { db.exec('ALTER TABLE estimates ADD COLUMN created_by TEXT'); } catch (e) { /* column already exists */ }
  // Runs before the create handler: once the proposal is saved, record who created it.
  app.post('/api/admin/estimates', auth, (req, res, next) => {
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
