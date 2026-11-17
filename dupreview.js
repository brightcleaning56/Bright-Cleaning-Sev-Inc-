// Possible duplicate bids: the office decides. Merging adds the new details and files to the lead; creating a new lead
// makes a separate lead from the same bid. Nothing happens to a lead until someone presses one of these.
// Same schema as server.js. Used by the list and by the website's repeat-bid path, so the table exists before either writes.
const SCHEMA = "CREATE TABLE IF NOT EXISTS duplicate_reviews(id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, payload TEXT NOT NULL, files TEXT, status TEXT NOT NULL DEFAULT 'open', result_lead_id INTEGER, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT)";
const ensureTable = db => db.exec(SCHEMA);
module.exports = function (app, { db, auth, logAction, clean }) {
  const who = req => String((req.user && req.user.email) || '');
  const safeList = s => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const open = r => {
    let p = {}; try { p = JSON.parse(r.payload || '{}'); } catch { p = {}; }
    const lead = db.prepare('SELECT id, contact_name, company, project_name, address, status FROM leads WHERE id=?').get(r.lead_id) || null;
    return { id: r.id, created_at: r.created_at, status: r.status, lead, bid: { contact_name: p.contact_name || '', company: p.company || '', email: p.email || '', phone: p.phone || '', project_name: p.project_name || '', address: p.address || '', service: p.service || '', details: p.details || '' }, files: safeList(r.files) };
  };
  app.get('/api/admin/duplicate-reviews', auth, (req, res) => {
    // Owner-facing list. If the query itself fails, say why (the error text, not the stack) so it can be fixed.
    let rows;
    try {
      // Same schema as server.js. Creating it here too means the list works even if the table was not there at startup.
      ensureTable(db);
      rows = db.prepare("SELECT * FROM duplicate_reviews WHERE status='open' ORDER BY id DESC LIMIT 200").all();
    }
    catch (err) { console.error('duplicate-reviews query failed:', err.stack || err.message); return res.status(500).json({ error: 'Repeat bids could not be loaded.', detail: String(err.message || err).slice(0, 300) }); }
    res.json({ reviews: rows.map(r => { try { return open(r); } catch (err) { console.error('duplicate review ' + r.id + ' could not be shown:', err.message); return { id: r.id, created_at: r.created_at, status: r.status, lead: null, bid: { contact_name: '', company: '', email: '', phone: '', project_name: '', address: '', service: '', details: '' }, files: [] }; } }) });
  });
  app.post('/api/admin/duplicate-reviews/:id/merge', auth, (req, res) => {
    const r = db.prepare("SELECT * FROM duplicate_reviews WHERE id=? AND status='open'").get(Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'That review is already decided or does not exist.' });
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(r.lead_id);
    if (!lead) return res.status(404).json({ error: 'The lead for this bid no longer exists. Create a new lead instead.' });
    let p = {}; try { p = JSON.parse(r.payload || '{}'); } catch { p = {}; }
    let fl = []; try { fl = JSON.parse(lead.files || '[]'); } catch { fl = []; }
    let newFiles = []; try { newFiles = JSON.parse(r.files || '[]'); } catch { newFiles = []; }
    const t = new Date().toISOString();
    db.prepare('UPDATE leads SET files=?, details=?, updated_at=? WHERE id=?').run(JSON.stringify(fl.concat(newFiles)), clean((lead.details || '') + '\n\n[Repeat bid merged ' + t.slice(0, 16).replace('T', ' ') + ' UTC] ' + (p.details || ''), 20000), t, lead.id);
    db.prepare("UPDATE duplicate_reviews SET status='merged', result_lead_id=?, decided_at=?, decided_by=? WHERE id=?").run(lead.id, t, who(req), r.id);
    logAction(req, 'merged repeat bid', 'lead', lead.id, 'review #' + r.id);
    res.json({ ok: true, lead_id: lead.id });
  });
  app.post('/api/admin/duplicate-reviews/:id/new-lead', auth, (req, res) => {
    const r = db.prepare("SELECT * FROM duplicate_reviews WHERE id=? AND status='open'").get(Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'That review is already decided or does not exist.' });
    let p = {}; try { p = JSON.parse(r.payload || '{}'); } catch { p = {}; }
    const t = new Date().toISOString();
    const id = db.prepare("INSERT INTO leads(kind,contact_name,company,email,phone,project_name,address,details,files,status,created_at,updated_at) VALUES('bid',?,?,?,?,?,?,?,?,'New',?,?)")
      .run(clean(p.contact_name, 150), clean(p.company, 200), clean(p.email, 254), clean(p.phone, 60), clean(p.project_name, 200), clean(p.address, 300), clean(p.details, 20000), r.files || '[]', t, t).lastInsertRowid;
    db.prepare("UPDATE duplicate_reviews SET status='new_lead', result_lead_id=?, decided_at=?, decided_by=? WHERE id=?").run(id, t, who(req), r.id);
    logAction(req, 'created lead from repeat bid', 'lead', id, 'review #' + r.id);
    res.json({ ok: true, lead_id: id });
  });
};
module.exports.ensureTable = ensureTable;
