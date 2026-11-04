// Drawings & Documents: revision control (new revision supersedes the old one, history kept), sheet index,
// archive instead of delete, library dashboard, and takeoff drafts from an AI blueprint reading.
const path = require('path'), fs = require('fs');
const DISCIPLINES = ['General', 'Architectural', 'Interior', 'Structural', 'Mechanical', 'Electrical', 'Plumbing', 'Civil', 'Landscape', 'Fire', 'Other'];
const discOf = s => ({ G: 'General', A: 'Architectural', I: 'Interior', S: 'Structural', M: 'Mechanical', E: 'Electrical', P: 'Plumbing', C: 'Civil', L: 'Landscape', F: 'Fire' })[String(s || '').trim().charAt(0).toUpperCase()] || 'Other';

module.exports = function mountDocs(app, ctx) {
  const { db, auth, logAction, clean, adminEmail, upload, uploadDir } = ctx;
  const cols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
  for (const [c, t] of [['estimate_id', 'INTEGER'], ['status', "TEXT DEFAULT 'Current'"], ['version', 'INTEGER DEFAULT 1'], ['supersedes_id', 'INTEGER'], ['superseded_by', 'INTEGER'], ['superseded_at', 'TEXT'], ['sheets', "TEXT DEFAULT '[]'"],
    ['blueprint', 'TEXT'], ['blueprint_status', 'TEXT'], ['tags', 'TEXT'], ['notes', 'TEXT'], ['archived_by', 'TEXT'], ['archived_at', 'TEXT']])
    if (!cols.includes(c)) db.exec(`ALTER TABLE documents ADD COLUMN ${c} ${t}`);
  try { if (!db.prepare('PRAGMA table_info(takeoffs)').all().some(c => c.name === 'stale_note')) db.exec('ALTER TABLE takeoffs ADD COLUMN stale_note TEXT'); } catch { /* takeoffs absent */ }
  const now = () => new Date().toISOString();
  const who = req => (req.user && req.user.email) || null;
  const roleOf = req => { const e = String(who(req) || '').toLowerCase(); if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  const J = (s, d) => { try { return JSON.parse(s || '') || d; } catch { return d; } };
  const get = id => { const d = db.prepare(`SELECT d.*, p.name project_name, c.company customer_company, c.name customer_name FROM documents d LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN customers c ON c.id=d.customer_id WHERE d.id=?`).get(Number(id)); return d && { ...d, sheets: J(d.sheets, []), blueprint: J(d.blueprint, null), analysis: J(d.analysis, null) }; };
  const chain = d => { const list = []; let cur = d, guard = 0; while (cur && cur.supersedes_id && guard++ < 50) { cur = db.prepare('SELECT id,title,revision,version,status,file_name,created_at,uploaded_by FROM documents WHERE id=?').get(cur.supersedes_id); if (cur) list.push(cur); } return list; };

  app.get('/api/admin/estimates/:id/files', auth, (req, res) => {
    res.json({ files: db.prepare("SELECT id, title, kind, file_name, file_url, size, uploaded_by, created_at FROM documents WHERE estimate_id=? AND COALESCE(status,'Current')<>'Archived' ORDER BY id DESC").all(Number(req.params.id)) });
  });
  app.get('/api/admin/docs/library', auth, (req, res) => {
    const rows = db.prepare(`SELECT d.id,d.title,d.kind,d.revision,d.version,d.status,d.file_name,d.file_url,d.size,d.project_id,d.customer_id,d.lead_id,d.issue_id,d.inspection_id,d.uploaded_by,d.created_at,d.analysis_status,d.blueprint_status,d.sheets,d.supersedes_id,d.superseded_by,d.tags,
      p.name project_name, c.company customer_company, c.name customer_name FROM documents d LEFT JOIN projects p ON p.id=d.project_id LEFT JOIN customers c ON c.id=d.customer_id ORDER BY d.id DESC LIMIT 1000`).all()
      .map(d => ({ ...d, sheet_count: J(d.sheets, []).length, sheets: undefined }));
    const live = rows.filter(d => d.status !== 'Archived');
    const bp = db.prepare("SELECT blueprint FROM documents WHERE blueprint IS NOT NULL AND status='Current'").all();
    res.json({ documents: rows, disciplines: DISCIPLINES, ai_ready: !!process.env.ANTHROPIC_API_KEY,
      kpis: { files: live.length, drawing_sets: live.filter(d => d.kind === 'Drawings' && d.status === 'Current').length, superseded: rows.filter(d => d.status === 'Superseded').length,
        analyzed: live.filter(d => d.blueprint_status === 'Analyzed' || d.analysis_status === 'Analyzed').length, awaiting: live.filter(d => d.kind === 'Drawings' && d.status === 'Current' && d.blueprint_status !== 'Analyzed' && d.analysis_status !== 'Analyzed' && /\.pdf$/i.test(d.file_name || '')).length,
        sheets: live.filter(d => d.status === 'Current').reduce((s, d) => s + d.sheet_count, 0), open_questions: bp.reduce((s, r) => s + (J(r.blueprint, {}).questions || []).length, 0),
        storage_mb: Math.round(live.reduce((s, d) => s + (d.size || 0), 0) / 1048576 * 10) / 10 } });
  });
  app.get('/api/admin/docs/:id', auth, (req, res) => {
    const d = get(req.params.id); if (!d) return res.status(404).json({ error: 'Document not found.' });
    let takeoffs = []; try { takeoffs = db.prepare('SELECT id,name,status,building_sf,stale_note,created_at FROM takeoffs WHERE document_id=? ORDER BY id DESC').all(d.id); } catch { /* */ }
    const newer = d.superseded_by ? db.prepare('SELECT id,title,revision,version FROM documents WHERE id=?').get(d.superseded_by) : null;
    res.json({ document: d, history: chain(d), newer, takeoffs, activity: db.prepare("SELECT * FROM audit_log WHERE entity='document' AND entity_id=? ORDER BY id DESC LIMIT 50").all(d.id) });
  });
  // New revision: uploads one file that supersedes this document. Links, type and sheet index carry over.
  app.post('/api/admin/docs/:id/revision', auth, upload.single('file'), (req, res) => {
    const d = get(req.params.id), f = req.file;
    const drop = () => { if (f) try { fs.unlinkSync(f.path); } catch { /* */ } };
    if (!d) { drop(); return res.status(404).json({ error: 'Document not found.' }); }
    if (d.status !== 'Current') { drop(); return res.status(409).json({ error: 'Only the current revision can be revised.' }); }
    if (!f) return res.status(400).json({ error: 'Choose the revised file.' });
    const rev = clean((req.body || {}).revision, 40); if (!rev) { drop(); return res.status(400).json({ error: 'Enter the revision label (e.g. Rev 2, Addendum 1, IFC).' }); }
    if (rev === d.revision) { drop(); return res.status(400).json({ error: `This document is already "${rev}". Use the new revision label.` }); }
    const t = now();
    const id = db.prepare(`INSERT INTO documents(project_id,customer_id,lead_id,issue_id,inspection_id,title,kind,revision,file_name,file_url,size,uploaded_by,created_at,status,version,supersedes_id,sheets,tags,notes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'Current',?,?,?,?,?)`).run(d.project_id, d.customer_id, d.lead_id, d.issue_id, d.inspection_id, clean(req.body.title, 200) || d.title, d.kind, rev, f.originalname,
      '/api/files/' + path.basename(f.filename), f.size, who(req), t, (d.version || 1) + 1, d.id, JSON.stringify(d.sheets.map(s => ({ ...s, revision: s.revision }))), d.tags, clean(req.body.notes, 2000) || null).lastInsertRowid;
    db.prepare("UPDATE documents SET status='Superseded', superseded_by=?, superseded_at=? WHERE id=?").run(id, t, d.id);
    let stale = 0; try { stale = db.prepare("UPDATE takeoffs SET stale_note=? WHERE document_id=? AND status<>'Converted'").run(`Drawings revised to ${rev} on ${t.slice(0, 10)}: recheck quantities.`, d.id).changes; } catch { /* */ }
    logAction(req, 'uploaded revision', 'document', id, `${d.title}: ${d.revision || 'v' + (d.version || 1)} → ${rev}${stale ? `; ${stale} takeoff(s) flagged` : ''}`);
    res.status(201).json({ id, superseded: d.id, takeoffs_flagged: stale });
  });
  // Sheet index (manual or confirmed from AI): each sheet has a number, title, discipline and revision.
  app.put('/api/admin/docs/:id/sheets', auth, (req, res) => {
    const d = get(req.params.id); if (!d) return res.status(404).json({ error: 'Document not found.' });
    const list = (Array.isArray((req.body || {}).sheets) ? req.body.sheets : []).slice(0, 600).map(s => ({ sheet: clean(s.sheet, 30), title: clean(s.title, 200), discipline: DISCIPLINES.includes(s.discipline) ? s.discipline : discOf(s.sheet), revision: clean(s.revision, 30) || d.revision || '', source: s.source === 'AI' ? 'AI' : 'Manual' })).filter(s => s.sheet);
    const dup = list.map(s => s.sheet.toUpperCase()).find((s, i, a) => a.indexOf(s) !== i); if (dup) return res.status(400).json({ error: `Sheet ${dup} is listed twice.` });
    db.prepare('UPDATE documents SET sheets=? WHERE id=?').run(JSON.stringify(list), d.id);
    logAction(req, 'updated sheet index', 'document', d.id, `${list.length} sheet(s)`);
    res.json({ sheets: list });
  });
  app.patch('/api/admin/docs/:id', auth, (req, res) => {
    const d = get(req.params.id); if (!d) return res.status(404).json({ error: 'Document not found.' });
    const b = req.body || {}, set = {};
    for (const k of ['tags', 'notes']) if (k in b) set[k] = clean(b[k], k === 'notes' ? 4000 : 300);
    if (b.archive === true) { if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only owners and managers can archive documents.' }); set.status = 'Archived'; set.archived_by = who(req); set.archived_at = now(); }
    if (b.archive === false && d.status === 'Archived') { set.status = d.superseded_by ? 'Superseded' : 'Current'; set.archived_by = null; set.archived_at = null; }
    const c = Object.keys(set); if (!c.length) return res.json({ ok: true });
    db.prepare(`UPDATE documents SET ${c.map(k => k + '=?').join(',')} WHERE id=?`).run(...c.map(k => set[k]), d.id);
    logAction(req, set.status === 'Archived' ? 'archived' : set.status ? 'restored' : 'updated', 'document', d.id, d.title);
    res.json({ document: get(d.id) });
  });
  // Takeoff draft from the blueprint reading: building area and room areas with their source sheets; nothing priced without a person.
  app.post('/api/admin/docs/:id/takeoff', auth, (req, res) => {
    const d = get(req.params.id); if (!d) return res.status(404).json({ error: 'Document not found.' });
    const bp = d.blueprint; if (!bp) return res.status(409).json({ error: 'Run the AI blueprint reading first.' });
    if (d.status !== 'Current') return res.status(409).json({ error: 'This revision is superseded. Use the current revision.' });
    const rooms = (bp.rooms || []).filter(r => r.area_sf > 0), roomSf = Math.round(rooms.reduce((s, r) => s + r.area_sf, 0));
    const sf = bp.building_sf || null;
    const ph = ['Clean #1', 'Clean #2', 'Clean #3'].map(p => db.prepare("SELECT id FROM scope_items WHERE active=1 AND category='construction' AND name LIKE ? AND unit_price IS NOT NULL").get(p + '%')).filter(Boolean);
    const lines = sf ? ph.map(p => ({ scope_id: p.id, quantity: sf, sheet: bp.building_sf_sheet || 'see sheet index', method: 'From schedule', note: 'AI-read building area (verify)' })) : [];
    const qs = [...(bp.questions || []), ...(sf && roomSf && Math.abs(roomSf - sf) / sf > 0.15 ? [`Room areas add up to ${roomSf.toLocaleString('en-US')} SF but the stated building area is ${sf.toLocaleString('en-US')} SF. Confirm which to price.`] : []),
      ...rooms.slice(0, 60).map(r => `${r.number ? r.number + ' ' : ''}${r.name}: ${r.area_sf} SF${r.floor_finish ? ', ' + r.floor_finish : ''} (sheet ${r.sheet}, ${r.confidence})`)].join('\n');
    const id = db.prepare(`INSERT INTO takeoffs(document_id,customer_id,project_id,name,category,building_sf,lines,questions,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'Draft',?,?,?)`)
      .run(d.id, d.customer_id, d.project_id, `Blueprint takeoff – ${d.title} ${d.revision || ''}`.trim(), 'construction', sf || roomSf || null, JSON.stringify(lines), qs.slice(0, 8000), who(req), now(), now()).lastInsertRowid;
    logAction(req, 'created takeoff from blueprint', 'document', d.id, `takeoff #${id}, ${sf || roomSf || 0} SF`);
    res.status(201).json({ takeoff_id: id, building_sf: sf, room_sf: roomSf, lines: lines.length });
  });
  app.locals.docDiscipline = discOf;
};
