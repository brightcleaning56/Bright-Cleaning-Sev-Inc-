// Quality Control & Inspections: configurable room-by-room templates, weighted scoring, inspector sign-off,
// corrective work orders from failed items, reinspections, customer acceptance, reports and PDF.
// AI can summarize and suggest; it never certifies work as passed (sign-off requires a signed-in person).
const { Doc } = require('./pdf');
const T = (room, items) => items.map(([label, weight = 1, category = 'General']) => ({ room, label, weight, category }));
const BUILTIN = {
  'Construction rough clean': ['construction', [...T('Throughout', [['Debris and trash removed', 3, 'Trash & debris'], ['Floors swept / vacuumed', 2, 'Floors'], ['Labels and stickers removed', 1, 'Glass'], ['Dust removed from ledges and sills', 2, 'Dust']]), ...T('Restrooms', [['Construction dust removed from fixtures', 2, 'Restrooms']])]],
  'Construction final clean': ['construction', [...T('Entry & lobby', [['Floors clean, no residue', 3, 'Floors'], ['Glass and doors streak-free', 2, 'Glass']]), ...T('Offices / rooms', [['Dust-free surfaces, sills and ledges', 3, 'Dust'], ['Light fixtures and vents wiped', 1, 'Dust'], ['Floors clean incl. edges', 3, 'Floors']]), ...T('Restrooms', [['Fixtures, partitions and mirrors spotless', 3, 'Restrooms'], ['Floors and grout clean', 2, 'Floors']]), ...T('Kitchen / breakroom', [['Cabinets inside/out, appliances clean', 2, 'Kitchen']])]],
  'Final touch-up & punch list': ['punchlist', [...T('Punch items', [['All listed punch items addressed', 4, 'Punch list'], ['Fingerprints and smudges removed', 2, 'Glass'], ['Floor touch-ups complete', 2, 'Floors'], ['No new damage or debris', 3, 'Trash & debris']])]],
  'Multifamily common areas': ['common_area', [...T('Hallways', [['Floors vacuumed / mopped', 3, 'Floors'], ['Baseboards and doors wiped', 1, 'Dust']]), ...T('Stairwells & elevators', [['Stairs clean, rails wiped', 2, 'Floors'], ['Elevator cab clean', 2, 'Elevators']]), ...T('Lobby / leasing', [['Presentable, glass clean', 2, 'Glass']]), ...T('Trash rooms', [['Clean and odor-controlled', 3, 'Trash & debris']])]],
  'Apartment unit turnover': ['turnover', [...T('Kitchen', [['Appliances inside and out', 3, 'Kitchen'], ['Cabinets and drawers inside', 2, 'Kitchen']]), ...T('Bathrooms', [['Tub/shower, toilet, vanity sanitized', 3, 'Restrooms']]), ...T('Whole unit', [['Floors cleaned', 3, 'Floors'], ['Baseboards, sills, blinds', 2, 'Dust'], ['Windows inside', 1, 'Glass'], ['Rent-ready overall', 3, 'General']])]],
  'Commercial janitorial': ['janitorial', [...T('Offices', [['Trash and recycling emptied', 2, 'Trash & debris'], ['Desks and surfaces dusted', 2, 'Dust'], ['Floors vacuumed / mopped', 2, 'Floors']]), ...T('Restrooms', [['Sanitized and restocked', 3, 'Restrooms']]), ...T('Breakroom', [['Counters, sinks, appliances clean', 2, 'Kitchen']]), ...T('Entrances', [['Glass doors and mats clean', 1, 'Glass']])]],
  'Interior & exterior windows': ['windows', [...T('Interior glass', [['Streak-free, edges detailed', 3, 'Glass'], ['Sills and tracks wiped', 1, 'Dust']]), ...T('Exterior glass', [['Streak-free, no water spots', 3, 'Glass'], ['Frames and screens clean', 1, 'Glass']])]],
  'Power washing': ['power_wash', [...T('Surfaces', [['Stains and buildup removed', 3, 'Exterior'], ['Even finish, no striping', 2, 'Exterior']]), ...T('Site', [['Runoff and debris cleaned up', 2, 'Trash & debris'], ['No damage to plants or surfaces', 3, 'Damage']])]],
  'Parking lot maintenance': ['parking', [...T('Lot', [['Litter removed', 3, 'Trash & debris'], ['Sweeping complete incl. curbs', 2, 'Exterior'], ['Trash cans emptied', 2, 'Trash & debris']])]],
  'Valet trash': ['valet_trash', [...T('Route', [['All doors serviced on schedule', 3, 'Missed service'], ['No spills in hallways', 2, 'Floors'], ['Compactor area clean', 2, 'Trash & debris']])]]
};
const TYPES = ['Internal', 'Reinspection', 'Customer walkthrough'];

module.exports = function mountQC(app, ctx) {
  const { db, auth, logAction, clean, adminEmail } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS qc_templates(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, service TEXT, items TEXT NOT NULL, threshold REAL DEFAULT 85, active INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0, updated_by TEXT, updated_at TEXT);`);
  const icols = db.prepare('PRAGMA table_info(inspections)').all().map(c => c.name);
  for (const [c, t] of [['property_id', 'INTEGER'], ['visit_id', 'INTEGER'], ['crew', 'TEXT'], ['template_id', 'INTEGER'], ['itype', "TEXT DEFAULT 'Internal'"], ['status', "TEXT DEFAULT 'Completed'"], ['parent_id', 'INTEGER'],
    ['threshold', 'REAL'], ['signed_by', 'TEXT'], ['signed_name', 'TEXT'], ['signed_at', 'TEXT'], ['accepted_by', 'TEXT'], ['accepted_title', 'TEXT'], ['accepted_at', 'TEXT'], ['accept_notes', 'TEXT'], ['ai_summary', 'TEXT']])
    if (!icols.includes(c)) db.exec(`ALTER TABLE inspections ADD COLUMN ${c} ${t}`);
  for (const [tbl, c] of [['documents', 'inspection_id'], ['customer_issues', 'inspection_id'], ['customer_issues', 'inspection_item']]) { try { if (!db.prepare(`PRAGMA table_info(${tbl})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${c} ${c === 'inspection_item' ? 'TEXT' : 'INTEGER'}`); } catch { /* */ } }
  const now = () => new Date().toISOString(), today = () => require('./bizdate').today();
  for (const [name, [service, items]] of Object.entries(BUILTIN)) if (!db.prepare('SELECT 1 FROM qc_templates WHERE name=?').get(name)) db.prepare('INSERT INTO qc_templates(name,service,items,builtin,updated_at) VALUES(?,?,?,1,?)').run(name, service, JSON.stringify(items), now());
  const who = req => (req.user && req.user.email) || null;
  const roleOf = req => { const e = String(who(req) || '').toLowerCase(); if (!adminEmail || e === adminEmail.toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  const J = (s, d) => { try { return JSON.parse(s || '') || d; } catch { return d; } };
  const tpl = id => { const t = db.prepare('SELECT * FROM qc_templates WHERE id=?').get(Number(id)); return t && { ...t, items: J(t.items, []) }; };
  const number = r => `QC-${String(r.date || '').slice(0, 4) || '2026'}-${1000 + r.id}`;
  // Weighted score: passed weight / (passed + failed weight). N/A items do not count.
  function score(items, threshold) {
    const rated = items.filter(i => i.result === 'Pass' || i.result === 'Fail');
    const tot = rated.reduce((s, i) => s + (Number(i.weight) || 1), 0), ok = rated.filter(i => i.result === 'Pass').reduce((s, i) => s + (Number(i.weight) || 1), 0);
    const sc = tot ? Math.round(ok / tot * 1000) / 10 : null;
    return { score: sc, passed: sc == null ? null : (sc >= (threshold || 85) && !items.some(i => i.result === 'Fail' && (Number(i.weight) || 1) >= 4) ? 1 : 0) };
  }
  const get = id => { const r = db.prepare(`SELECT i.*, p.name project_name, c.company customer_company, c.name customer_name, pr.name property_name FROM inspections i LEFT JOIN projects p ON p.id=i.project_id LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN customer_properties pr ON pr.id=i.property_id WHERE i.id=?`).get(Number(id)); return r && { ...r, items: J(r.items, []), number: number(r) }; };

  // ---------- Templates ----------
  app.get('/api/admin/qc/templates', auth, (req, res) => res.json({ templates: db.prepare('SELECT * FROM qc_templates ORDER BY active DESC, name').all().map(t => ({ ...t, items: J(t.items, []) })) }));
  app.put('/api/admin/qc/templates/:id', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only owners and managers can change inspection templates.' });
    const t = tpl(req.params.id); if (!t) return res.status(404).json({ error: 'Template not found.' });
    const b = req.body || {}, items = (Array.isArray(b.items) ? b.items : []).map(i => ({ room: clean(i.room, 80) || 'General', label: clean(i.label, 200), weight: Math.min(5, Math.max(1, Number(i.weight) || 1)), category: clean(i.category, 60) || 'General' })).filter(i => i.label);
    if (!items.length) return res.status(400).json({ error: 'A template needs at least one item.' });
    const th = b.threshold == null ? t.threshold : Number(b.threshold); if (!(th >= 50 && th <= 100)) return res.status(400).json({ error: 'Pass mark must be between 50 and 100.' });
    db.prepare('UPDATE qc_templates SET items=?, threshold=?, active=?, updated_by=?, updated_at=? WHERE id=?').run(JSON.stringify(items), th, b.active === false ? 0 : 1, who(req), now(), t.id);
    logAction(req, 'updated', 'inspection template', t.id, `${t.name}: ${items.length} items, pass mark ${th}%`);
    res.json({ template: tpl(t.id) });
  });
  app.post('/api/admin/qc/templates', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only owners and managers can add inspection templates.' });
    const name = clean((req.body || {}).name, 120); if (!name) return res.status(400).json({ error: 'Name the template.' });
    if (db.prepare('SELECT 1 FROM qc_templates WHERE lower(name)=lower(?)').get(name)) return res.status(409).json({ error: 'A template with that name exists.' });
    const id = db.prepare('INSERT INTO qc_templates(name,service,items,updated_by,updated_at) VALUES(?,?,?,?,?)').run(name, clean(req.body.service, 40), JSON.stringify([{ room: 'General', label: 'Area clean', weight: 1, category: 'General' }]), who(req), now()).lastInsertRowid;
    res.status(201).json({ template: tpl(id) });
  });

  // ---------- Inspections ----------
  function validate(b, cur) {
    const out = {}, errs = [];
    const ref = (k, table, label) => { if (k in b) { const v = b[k] === '' || b[k] == null ? null : Number(b[k]); if (v !== null && !db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(v)) errs.push(`That ${label} was not found.`); else out[k] = v; } };
    ref('customer_id', 'customers', 'customer'); ref('project_id', 'projects', 'project'); ref('property_id', 'customer_properties', 'property'); ref('visit_id', 'visits', 'job');
    if (!cur || 'area' in b) { const a = clean(b.area, 200); if (!a) errs.push('Enter the site or area inspected.'); else out.area = a; }
    if (!cur || 'date' in b) { if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) errs.push('Choose the inspection date.'); else out.date = b.date; }
    for (const k of ['crew', 'notes', 'inspector']) if (k in b) out[k] = clean(b[k], k === 'notes' ? 4000 : 200);
    if ('itype' in b) out.itype = TYPES.includes(b.itype) ? b.itype : 'Internal';
    let th = cur ? cur.threshold : null;
    if ('template_id' in b) { const t = b.template_id ? tpl(b.template_id) : null; if (b.template_id && !t) errs.push('Template not found.'); else { out.template_id = t ? t.id : null; out.template = t ? t.name : null; th = t ? t.threshold : th; out.threshold = th; } }
    if (!cur || 'items' in b) {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 120).map(i => ({ room: clean(i && i.room, 80) || 'General', label: clean(i && i.label, 200), weight: Math.min(5, Math.max(1, Number(i && i.weight) || 1)), category: clean(i && i.category, 60) || 'General',
        result: ['Pass', 'Fail', 'N/A', ''].includes(i && i.result) ? i.result : '', note: clean(i && i.note, 500), photo_ids: Array.isArray(i && i.photo_ids) ? i.photo_ids.map(Number).filter(Boolean).slice(0, 10) : [] })).filter(i => i.label);
      if (!items.length) errs.push('Add at least one checklist item.');
      if (items.some(i => i.result === 'Fail' && !i.note)) errs.push('Every failed item needs a comment so the crew knows what to fix.');
      out.items = JSON.stringify(items); Object.assign(out, score(items, th || 85));
    }
    return { out, errs };
  }
  app.post('/api/admin/qc/inspections', auth, (req, res) => {
    const b = { ...(req.body || {}) };
    if (b.template_id && !b.items) { const t = tpl(b.template_id); if (t) b.items = t.items; }
    const { out, errs } = validate(b, null); if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    out.status = 'In progress'; out.inspector = out.inspector || who(req);
    const c = Object.keys(out), t = now();
    const id = db.prepare(`INSERT INTO inspections(${c.join(',')},created_by,created_at,updated_at) VALUES(${c.map(() => '?').join(',')},?,?,?)`).run(...c.map(k => out[k]), who(req), t, t).lastInsertRowid;
    logAction(req, 'started', 'inspection', id, `${out.area}${out.template ? ' (' + out.template + ')' : ''}`);
    res.status(201).json({ inspection: get(id) });
  });
  app.patch('/api/admin/qc/inspections/:id', auth, (req, res) => {
    const cur = get(req.params.id); if (!cur) return res.status(404).json({ error: 'Inspection not found.' });
    if (cur.signed_at) return res.status(409).json({ error: 'This inspection is signed and locked. Start a reinspection to record new results.' });
    const { out, errs } = validate(req.body || {}, cur); if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const c = Object.keys(out); if (c.length) db.prepare(`UPDATE inspections SET ${c.map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`).run(...c.map(k => out[k]), now(), cur.id);
    res.json({ inspection: get(cur.id) });
  });
  // Inspector sign-off: a signed-in person types their name. Locks the results. AI can never do this.
  app.post('/api/admin/qc/inspections/:id/sign', auth, (req, res) => {
    const cur = get(req.params.id); if (!cur) return res.status(404).json({ error: 'Inspection not found.' });
    if (cur.signed_at) return res.status(409).json({ error: 'Already signed.' });
    const name = clean((req.body || {}).name, 120); if (name.length < 2) return res.status(400).json({ error: 'Type your full name to sign the inspection.' });
    const open = cur.items.filter(i => !i.result).length; if (open) return res.status(400).json({ error: `${open} item(s) have no result. Mark each item Pass, Fail or N/A before signing.` });
    if (cur.items.some(i => i.result === 'Fail' && !i.note)) return res.status(400).json({ error: 'Every failed item needs a comment.' });
    const fails = cur.items.filter(i => i.result === 'Fail').length, st = fails ? 'Corrective action' : (cur.itype === 'Customer walkthrough' ? 'Awaiting customer' : 'Completed');
    db.prepare('UPDATE inspections SET signed_by=?, signed_name=?, signed_at=?, status=?, updated_at=? WHERE id=?').run(who(req), name, now(), st, now(), cur.id);
    // A passing reinspection closes the original.
    if (cur.parent_id && !fails) db.prepare("UPDATE inspections SET status='Closed', updated_at=? WHERE id=?").run(now(), cur.parent_id);
    logAction(req, 'signed', 'inspection', cur.id, `${number(cur)} ${cur.area}: ${cur.score == null ? '—' : cur.score + '%'} ${cur.passed ? 'PASS' : 'FAIL'} (${name})`);
    res.json({ inspection: get(cur.id) });
  });
  // Corrective work orders: one task per failed item, linked back to the inspection.
  app.post('/api/admin/qc/inspections/:id/corrective', auth, (req, res) => {
    const cur = get(req.params.id); if (!cur) return res.status(404).json({ error: 'Inspection not found.' });
    if (!cur.signed_at) return res.status(409).json({ error: 'Sign the inspection before creating corrective work orders.' });
    const b = req.body || {}, due = clean(b.due_date, 10) || new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
    const failed = cur.items.map((i, n) => ({ ...i, n })).filter(i => i.result === 'Fail' && (!Array.isArray(b.items) || b.items.includes(i.n)));
    if (!failed.length) return res.status(400).json({ error: 'There are no failed items to correct.' });
    const ids = [];
    for (const i of failed) {
      const key = `${cur.id}:${i.n}`;
      if (db.prepare('SELECT 1 FROM customer_issues WHERE inspection_id=? AND inspection_item=?').get(cur.id, String(i.n))) continue;
      ids.push(db.prepare(`INSERT INTO customer_issues(customer_id,project_id,property_id,type,category,title,description,required_action,priority,status,assigned_to,due_date,source,customer_comms,inspection_id,inspection_item,created_by,created_at,updated_at)
        VALUES(?,?,?,'task','Cleaning quality',?,?,?,?,'Open',?,?,'Inspection','Not needed',?,?,?,?,?)`).run(cur.customer_id || null, cur.project_id || null, cur.property_id || null, `Corrective: ${i.label} – ${i.room}`.slice(0, 200),
        `Failed in ${number(cur)} (${cur.area}, ${cur.date}). Inspector note: ${i.note}`, clean(b.required_action, 500) || `Re-clean: ${i.label}. Take before and after photos.`, i.weight >= 3 ? 'High' : (['Low', 'Normal', 'High', 'Urgent'].includes(b.priority) ? b.priority : 'Normal'),
        clean(b.assigned_to, 200) || null, due, cur.id, String(i.n), who(req), now(), now()).lastInsertRowid);
      void key;
    }
    db.prepare("UPDATE inspections SET status='Corrective action', updated_at=? WHERE id=?").run(now(), cur.id);
    logAction(req, 'created corrective work orders', 'inspection', cur.id, `${number(cur)}: ${ids.length}`);
    res.status(201).json({ created: ids.length, ids });
  });
  // Reinspection: only the failed items, linked to the original.
  app.post('/api/admin/qc/inspections/:id/reinspect', auth, (req, res) => {
    const cur = get(req.params.id); if (!cur) return res.status(404).json({ error: 'Inspection not found.' });
    const failed = cur.items.filter(i => i.result === 'Fail'); if (!failed.length) return res.status(400).json({ error: 'Nothing failed, so no reinspection is needed.' });
    const open = db.prepare("SELECT COUNT(*) n FROM customer_issues WHERE inspection_id=? AND status NOT IN ('Resolved','Verified','Closed')").get(cur.id).n;
    const t = now(), id = db.prepare(`INSERT INTO inspections(project_id,customer_id,property_id,visit_id,crew,area,inspector,date,template,template_id,threshold,items,score,passed,itype,status,parent_id,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'Reinspection','In progress',?,?,?,?)`).run(cur.project_id, cur.customer_id, cur.property_id, cur.visit_id, cur.crew, cur.area, who(req), today(), cur.template, cur.template_id, cur.threshold,
      JSON.stringify(failed.map(i => ({ ...i, result: '', note: '', photo_ids: [] }))), cur.id, who(req), t, t).lastInsertRowid;
    db.prepare("UPDATE inspections SET status='Reinspection due', updated_at=? WHERE id=?").run(t, cur.id);
    logAction(req, 'started reinspection', 'inspection', id, `of ${number(cur)} (${failed.length} item(s))${open ? `; ${open} corrective task(s) still open` : ''}`);
    res.status(201).json({ inspection: get(id), open_corrective: open });
  });
  // Customer acceptance on a walkthrough: records who accepted; if linked to a project, records the project sign-off.
  app.post('/api/admin/qc/inspections/:id/accept', auth, (req, res) => {
    const cur = get(req.params.id); if (!cur) return res.status(404).json({ error: 'Inspection not found.' });
    if (cur.itype !== 'Customer walkthrough') return res.status(400).json({ error: 'Customer acceptance is recorded on a customer walkthrough.' });
    if (!cur.signed_at) return res.status(409).json({ error: 'Sign the walkthrough first.' });
    const b = req.body || {}, name = clean(b.name, 120); if (name.length < 2) return res.status(400).json({ error: "Enter the customer representative's name." });
    const outstanding = cur.items.filter(i => i.result === 'Fail').map(i => `${i.room}: ${i.label}`);
    if (outstanding.length && !b.with_exceptions) return res.status(409).json({ error: `${outstanding.length} deficiency(ies) are still open. Record acceptance "with exceptions" to list them, or fix them first.`, outstanding });
    db.prepare("UPDATE inspections SET accepted_by=?, accepted_title=?, accepted_at=?, accept_notes=?, status=?, updated_at=? WHERE id=?").run(name, clean(b.title, 120), now(), outstanding.length ? 'Accepted with exceptions: ' + outstanding.join('; ') : null, outstanding.length ? 'Accepted with exceptions' : 'Customer accepted', now(), cur.id);
    if (cur.project_id && !outstanding.length) { try { db.prepare('UPDATE projects SET signoff_name=COALESCE(signoff_name,?), signoff_title=COALESCE(signoff_title,?), signoff_at=COALESCE(signoff_at,?) WHERE id=?').run(name, clean(b.title, 120), now(), cur.project_id); } catch { /* */ } }
    logAction(req, 'recorded customer acceptance', 'inspection', cur.id, `${number(cur)}: ${name}${outstanding.length ? ' (with exceptions)' : ''}`);
    res.json({ inspection: get(cur.id) });
  });

  app.get('/api/admin/qc/inspections/:id', auth, (req, res) => {
    const r = get(req.params.id); if (!r) return res.status(404).json({ error: 'Inspection not found.' });
    let photos = []; try { photos = db.prepare('SELECT id,title,file_name,file_url,created_at FROM documents WHERE inspection_id=? ORDER BY id').all(r.id); } catch { /* */ }
    res.json({ inspection: r, photos, corrective: db.prepare('SELECT id,title,status,assigned_to,due_date,resolved_at,verified_by FROM customer_issues WHERE inspection_id=? ORDER BY id').all(r.id),
      reinspections: db.prepare('SELECT id,date,score,passed,status FROM inspections WHERE parent_id=? ORDER BY id').all(r.id), history: db.prepare("SELECT * FROM audit_log WHERE entity='inspection' AND entity_id=? ORDER BY id DESC").all(r.id) });
  });
  app.get('/api/admin/qc/inspections/:id/pdf', auth, (req, res) => {
    const r = get(req.params.id); if (!r) return res.status(404).json({ error: 'Inspection not found.' });
    const d = new Doc();
    d.box(0, 742, 612, 50, '0.06 0.15 0.26'); d.y = 762; d.text('BRIGHT CLEANING SEV INC.  -  QUALITY INSPECTION', { size: 13, bold: true, color: '1 1 1' }); d.y = 712;
    d.heading(`${number(r)}  ${r.area}`, 14); d.para(`${r.customer_company || r.customer_name || ''}${r.project_name ? '  |  ' + r.project_name : ''}  |  ${r.date}  |  ${r.itype || 'Internal'}${r.template ? '  |  ' + r.template : ''}`);
    d.para(`Score: ${r.score == null ? '-' : r.score + '%'} (pass mark ${r.threshold || 85}%)  -  Result: ${r.passed == null ? '-' : r.passed ? 'PASSED' : 'FAILED'}  -  Status: ${r.status || ''}`, { bold: true });
    d.table([{ label: 'Area', w: 18 }, { label: 'Item', w: 42 }, { label: 'Wt', w: 6, align: 'right' }, { label: 'Result', w: 10 }, { label: 'Comment', w: 30 }], r.items.map(i => [i.room, i.label, i.weight, i.result || '-', i.note || '']));
    if (r.notes) { d.heading('Notes', 11); d.para(r.notes); }
    d.heading('Sign-off', 11); d.para(r.signed_at ? `Inspected and signed by ${r.signed_name} (${r.signed_by}) on ${r.signed_at.slice(0, 16).replace('T', ' ')} UTC.` : 'Not signed yet.');
    if (r.accepted_at) d.para(`Customer acceptance: ${r.accepted_by}${r.accepted_title ? ', ' + r.accepted_title : ''} on ${r.accepted_at.slice(0, 10)}.${r.accept_notes ? ' ' + r.accept_notes : ''}`);
    d.footer(`Bright Cleaning Sev Inc. - ${number(r)}`);
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${number(r)}.pdf"`); res.send(d.toBuffer());
  });

  // ---------- Dashboard & reports ----------
  app.get('/api/admin/qc/dashboard', auth, (req, res) => {
    const from = clean(req.query.from, 10) || new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10), to = clean(req.query.to, 10) || today();
    const rows = db.prepare(`SELECT i.*, p.name project_name, c.company customer_company, c.name customer_name, pr.name property_name FROM inspections i LEFT JOIN projects p ON p.id=i.project_id LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN customer_properties pr ON pr.id=i.property_id WHERE i.date BETWEEN ? AND ? ORDER BY i.date DESC, i.id DESC`).all(from, to).map(r => ({ ...r, items: J(r.items, []), number: number(r) }));
    const signed = rows.filter(r => r.signed_at || r.score != null && !r.status), scored = rows.filter(r => r.score != null);
    const deficiencies = {}; const repeats = {};
    for (const r of rows) for (const i of r.items) if (i.result === 'Fail') { deficiencies[i.category || 'General'] = (deficiencies[i.category || 'General'] || 0) + 1; const k = `${r.customer_company || r.customer_name || r.area}|${i.label}`; repeats[k] = (repeats[k] || 0) + 1; }
    const weeks = {}; for (const r of scored) { const d = new Date(r.date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); const k = d.toISOString().slice(0, 10); (weeks[k] = weeks[k] || []).push(r.score); }
    const corr = db.prepare("SELECT status, created_at, resolved_at FROM customer_issues WHERE inspection_id IS NOT NULL").all();
    const closed = corr.filter(c => c.resolved_at), days = closed.length ? Math.round(closed.reduce((s, c) => s + (Date.parse(c.resolved_at) - Date.parse(c.created_at)) / 864e5, 0) / closed.length * 10) / 10 : null;
    const byProject = {}; for (const r of scored.filter(x => x.project_id)) { const p = byProject[r.project_id] = byProject[r.project_id] || { project: r.project_name, n: 0, sum: 0, failed: 0 }; p.n++; p.sum += r.score; if (r.passed === 0) p.failed++; }
    res.json({ from, to, inspections: rows,
      kpis: { completed: signed.length, avg: scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length * 10) / 10 : null, failed: scored.filter(r => r.passed === 0).length, passed: scored.filter(r => r.passed === 1).length,
        pending: rows.filter(r => r.status === 'In progress').length, corrective_open: corr.filter(c => !['Resolved', 'Verified', 'Closed'].includes(c.status)).length, reinspections_due: rows.filter(r => r.status === 'Reinspection due' || r.status === 'Corrective action').length,
        acceptance_pending: rows.filter(r => r.status === 'Awaiting customer').length, corrective_avg_days: days },
      trend: Object.entries(weeks).sort().map(([w, s]) => ({ week: w, avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length * 10) / 10, n: s.length })),
      deficiencies: Object.entries(deficiencies).sort((a, b) => b[1] - a[1]).map(([category, n]) => ({ category, n })),
      repeat_failures: Object.entries(repeats).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ where: k.split('|')[0], item: k.split('|')[1], n })),
      by_project: Object.values(byProject).map(p => ({ project: p.project, inspections: p.n, avg: Math.round(p.sum / p.n * 10) / 10, failed: p.failed })) });
  });
  app.get('/api/admin/qc/report', auth, (req, res) => {
    const by = ['customer', 'property', 'project', 'service', 'crew', 'inspector', 'category'].includes(req.query.by) ? req.query.by : 'customer';
    const from = clean(req.query.from, 10) || '2000-01-01', to = clean(req.query.to, 10) || today();
    const rows = db.prepare(`SELECT i.*, p.name project_name, c.company customer_company, c.name customer_name, pr.name property_name, t.service FROM inspections i LEFT JOIN projects p ON p.id=i.project_id LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN customer_properties pr ON pr.id=i.property_id LEFT JOIN qc_templates t ON t.id=i.template_id WHERE i.date BETWEEN ? AND ? AND i.score IS NOT NULL`).all(from, to);
    const g = {};
    for (const r of rows) {
      const items = J(r.items, []);
      const keys = by === 'category' ? [...new Set(items.filter(i => i.result === 'Fail').map(i => i.category || 'General'))] : [({ customer: r.customer_company || r.customer_name, property: r.property_name, project: r.project_name, service: r.service || r.template, crew: r.crew, inspector: r.signed_name || r.inspector })[by] || 'Not set'];
      for (const k of keys) { const x = g[k] = g[k] || { key: k, inspections: 0, sum: 0, failed: 0, failed_items: 0 }; x.inspections++; x.sum += r.score; if (r.passed === 0) x.failed++; x.failed_items += items.filter(i => i.result === 'Fail' && (by !== 'category' || (i.category || 'General') === k)).length; }
    }
    res.json({ by, from, to, rows: Object.values(g).map(x => ({ ...x, avg: Math.round(x.sum / x.inspections * 10) / 10, sum: undefined })).sort((a, b) => a.avg - b.avg) });
  });
  app.locals.qcNumber = number;
};
