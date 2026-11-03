// Takeoff & Estimating engine: server-side pricing from the approved price book (same rules as estimates),
// difficulty factors, mobilization/travel, minimum charge, labor hours/cost and margin check, sanity warnings,
// conversion to a draft estimate (re-pricing a draft in place), and versioning when drawings are revised.
const crypto = require('crypto');
const { resolveLines } = require('./scopes');
const FACTORS = { high_work: ['High work (over 12 ft, lifts/ladders)', 15], occupied: ['Occupied building / work around tenants', 10], after_hours: ['After-hours or weekend work', 15],
  heavy_debris: ['Heavy construction debris', 20], rush: ['Rush schedule (under 72 hours)', 10], restricted: ['Restricted access / long carry distance', 8] };

module.exports = function mountEngine(app, ctx) {
  const { db, auth, logAction, clean } = ctx;
  const cols = db.prepare('PRAGMA table_info(takeoffs)').all().map(c => c.name);
  for (const [c, t] of [['adjustments', "TEXT DEFAULT '{}'"], ['version', 'INTEGER DEFAULT 1'], ['parent_id', 'INTEGER'], ['priced', 'TEXT']]) if (!cols.includes(c)) db.exec(`ALTER TABLE takeoffs ADD COLUMN ${c} ${t}`);
  const now = () => new Date().toISOString(), who = req => (req.user && req.user.email) || null;
  const J = (s, d) => { try { return JSON.parse(s || '') || d; } catch { return d; } };
  const r2 = n => Math.round(n * 100) / 100;
  const get = id => { const t = db.prepare('SELECT * FROM takeoffs WHERE id=?').get(Number(id)); return t && { ...t, lines: J(t.lines, []), adjustments: J(t.adjustments, {}) }; };

  function price(t) {
    const a = t.adjustments || {}, labor = Number(a.labor_rate) || 0;
    const b = { scope_category: t.category, labor_rate: labor, line_items: t.lines.map(l => ({ scope_id: l.scope_id, quantity: l.quantity })) };
    const err = resolveLines(db, b); if (err) return { error: err };
    const lines = b.line_items.map((x, i) => ({ ...x, sheet: t.lines[i].sheet, method: t.lines[i].method, note: t.lines[i].note }));
    const base = r2(lines.reduce((s, l) => s + l.amount, 0)), hours = r2(lines.reduce((s, l) => s + (l.hours || 0), 0));
    const factors = (a.factors || []).filter(k => FACTORS[k]).map(k => ({ key: k, label: FACTORS[k][0], pct: FACTORS[k][1] }))
      .concat((a.custom || []).filter(c => c && c.label && Number(c.pct)).map(c => ({ key: 'custom', label: clean(c.label, 80), pct: Number(c.pct) })));
    const pct = factors.reduce((s, f) => s + f.pct, 0), adj = r2(base * pct / 100);
    const mob = r2(Number(a.mobilization) || 0), travel = r2(Number(a.travel) || 0), sub = r2(base + adj + mob + travel), min = r2(Number(a.minimum) || 0);
    const total = Math.max(sub, min), laborCost = labor > 0 && hours > 0 ? r2(hours * labor * (1 + pct / 100)) : null;
    const margin = laborCost != null && total > 0 ? Math.round((total - laborCost) / total * 1000) / 10 : null, target = Number(a.margin_target) || 30;
    const warnings = [];
    if (!lines.length) warnings.push('No priced lines yet.');
    if (t.stale_note) warnings.push(t.stale_note);
    if (margin != null && margin < target) warnings.push(`Estimated margin ${margin}% is below the ${target}% target.`);
    if (laborCost == null && lines.length) warnings.push(labor > 0 ? 'No production rates on these items, so labor hours and margin cannot be checked.' : 'Enter a loaded labor rate to check labor hours and margin.');
    const sf = Number(t.building_sf) || 0, perSf = sf > 0 ? Math.round(total / sf * 1000) / 1000 : null;
    if (perSf != null && t.category === 'construction' && (perSf < 0.05 || perSf > 3)) warnings.push(`$${perSf}/SF is outside the usual construction-cleaning range ($0.05–$3.00/SF). Check quantities and units.`);
    for (const l of lines) if (sf > 0 && /sf|sq/i.test(l.unit || '') && l.quantity > sf * 1.1) warnings.push(`${l.description}: quantity is more than the building area (${sf.toLocaleString('en-US')} SF).`);
    for (const l of lines) if (l.method !== 'Entered' && !l.sheet) warnings.push(`${l.description}: no source sheet.`);
    return { lines, base, factors, factor_pct: pct, adjustment: adj, mobilization: mob, travel, subtotal: sub, minimum: min, minimum_applied: min > sub, total: r2(total), hours, labor_rate: labor, labor_cost: laborCost, margin_pct: margin, margin_target: target, per_sf: perSf, warnings };
  }

  app.get('/api/admin/takeoffs/:id/price', auth, (req, res) => {
    const t = get(req.params.id); if (!t) return res.status(404).json({ error: 'Takeoff not found.' });
    const p = price(t); if (p.error) return res.status(400).json({ error: p.error });
    res.json({ takeoff: t, price: p, factors: Object.entries(FACTORS).map(([k, [label, pct]]) => ({ key: k, label, pct })) });
  });
  app.put('/api/admin/takeoffs/:id/adjustments', auth, (req, res) => {
    const t = get(req.params.id); if (!t) return res.status(404).json({ error: 'Takeoff not found.' });
    const b = req.body || {}, out = {};
    out.factors = (Array.isArray(b.factors) ? b.factors : []).filter(k => FACTORS[k]);
    out.custom = (Array.isArray(b.custom) ? b.custom : []).slice(0, 10).map(c => ({ label: clean(c && c.label, 80), pct: Number(c && c.pct) })).filter(c => c.label && c.pct);
    if (out.custom.some(c => !(c.pct >= -50 && c.pct <= 100))) return res.status(400).json({ error: 'Custom adjustments must be between -50% and +100%.' });
    for (const k of ['mobilization', 'travel', 'minimum', 'labor_rate', 'margin_target']) { if (b[k] === '' || b[k] == null) continue; const v = Number(String(b[k]).replace(/[$,%]/g, '')); if (!(v >= 0 && v < 1e7)) return res.status(400).json({ error: `${k.replace('_', ' ')} must be a positive number.` }); out[k] = v; }
    if (out.margin_target != null && out.margin_target > 90) return res.status(400).json({ error: 'Margin target must be under 90%.' });
    db.prepare('UPDATE takeoffs SET adjustments=?, updated_at=? WHERE id=?').run(JSON.stringify(out), now(), t.id);
    logAction(req, 'updated pricing', 'takeoff', t.id, `${out.factors.length + out.custom.length} factor(s)`);
    const p = price(get(t.id)); res.json({ price: p.error ? null : p, error: p.error || null });
  });
  // Convert to a draft estimate. A Draft estimate already linked is re-priced in place; anything past Draft needs a proposal revision.
  app.post('/api/admin/takeoffs/:id/estimate', auth, (req, res) => {
    const t = get(req.params.id); if (!t) return res.status(404).json({ error: 'Takeoff not found.' });
    const b = req.body || {};
    if (t.stale_note && !b.acknowledge_stale) return res.status(409).json({ error: `${t.stale_note} Create a new version from the current drawings, or confirm the quantities are still right.`, stale: true });
    const p = price(t); if (p.error) return res.status(400).json({ error: p.error });
    if (!p.lines.length) return res.status(400).json({ error: 'Add at least one priced line before creating an estimate.' });
    const c = t.customer_id ? db.prepare('SELECT * FROM customers WHERE id=?').get(t.customer_id) : null;
    const name = clean(b.customer_name, 150) || (c && (c.name || c.company)) || ''; if (!name) return res.status(400).json({ error: 'Link the takeoff to a customer (or enter the customer name) first.' });
    const items = [...p.lines.map(l => ({ scope_id: l.scope_id, description: l.description, category: l.category, unit: l.unit, quantity: l.quantity, unit_price: l.unit_price, pricing_method: l.pricing_method, hours: l.hours, labor_rate: l.labor_rate, amount: l.amount, sheet: l.sheet })),
      ...p.factors.map(f => ({ description: `Adjustment: ${f.label} (${f.pct > 0 ? '+' : ''}${f.pct}%)`, amount: r2(p.base * f.pct / 100) })),
      ...(p.mobilization ? [{ description: 'Mobilization', amount: p.mobilization }] : []), ...(p.travel ? [{ description: 'Travel', amount: p.travel }] : []),
      ...(p.minimum_applied ? [{ description: `Minimum job charge adjustment (minimum $${p.minimum.toLocaleString('en-US')})`, amount: r2(p.minimum - p.subtotal) }] : [])];
    const doc = t.document_id ? db.prepare('SELECT title, revision FROM documents WHERE id=?').get(t.document_id) : null;
    const scope = [`${t.name}${t.building_sf ? ` — ${Number(t.building_sf).toLocaleString('en-US')} SF` : ''}`, doc ? `Based on drawings: ${doc.title}${doc.revision ? ' (' + doc.revision + ')' : ''}.` : '',
      `Quantities from takeoff #${t.id} v${t.version || 1}; each line lists its source sheet.`].filter(Boolean).join('\n');
    const assumptions = [`Priced from the approved price book on ${now().slice(0, 10)}.`, ...(t.questions ? ['Open questions: ' + String(t.questions).split('\n').filter(Boolean).slice(0, 15).join('; ')] : [])].join('\n');
    const vals = { area_sqft: Number(t.building_sf) || 0, line_items: JSON.stringify(items), line_items_total: p.total, proposal_total: p.total, labor_hours: p.hours, labor_rate: p.labor_rate, labor_cost: p.labor_cost || 0, total_cost: p.labor_cost || 0, margin_pct: p.margin_pct || 0, scope, assumptions };
    const cur = t.estimate_id ? db.prepare('SELECT id, status FROM estimates WHERE id=?').get(t.estimate_id) : null;
    if (cur && cur.status !== 'Draft') return res.status(409).json({ error: `Estimate #${cur.id} is already ${cur.status}. Revise the proposal from Estimates & Proposals instead of overwriting it.`, estimate_id: cur.id });
    let id;
    if (cur) {
      db.prepare(`UPDATE estimates SET ${Object.keys(vals).map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`).run(...Object.values(vals), now(), cur.id); id = cur.id;
    } else {
      id = db.prepare(`INSERT INTO estimates(customer_name,company,email,project_name,site_address,use_line_items,status,public_token,expires_on,scope_category,created_at,updated_at,${Object.keys(vals).join(',')}) VALUES(?,?,?,?,?,1,'Draft',?,?,?,?,?,${Object.keys(vals).map(() => '?').join(',')})`)
        .run(name, (c && c.company) || clean(b.company, 150) || '', (c && c.email) || clean(b.email, 254) || '', t.name, (c && c.address) || '', crypto.randomBytes(24).toString('hex'), new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), t.category, now(), now(), ...Object.values(vals)).lastInsertRowid;
    }
    db.prepare("UPDATE takeoffs SET estimate_id=?, status='Estimated', priced=?, updated_at=? WHERE id=?").run(id, JSON.stringify({ total: p.total, at: now() }), now(), t.id);
    logAction(req, cur ? 're-priced estimate from' : 'created estimate from', 'takeoff', t.id, `estimate #${id} $${p.total.toLocaleString('en-US')}${b.acknowledge_stale ? ' (stale drawings acknowledged)' : ''}`);
    res.status(cur ? 200 : 201).json({ estimate_id: id, total: p.total, updated: !!cur, warnings: p.warnings });
  });
  // New version for revised drawings: copies lines and pricing settings, points at the chosen (current) document.
  app.post('/api/admin/takeoffs/:id/version', auth, (req, res) => {
    const t = get(req.params.id); if (!t) return res.status(404).json({ error: 'Takeoff not found.' });
    let docId = t.document_id;
    if ((req.body || {}).document_id) { const d = db.prepare("SELECT id, status FROM documents WHERE id=?").get(Number(req.body.document_id)); if (!d) return res.status(400).json({ error: 'Document not found.' }); if (d.status && d.status !== 'Current') return res.status(400).json({ error: 'Choose the current revision of the drawings.' }); docId = d.id; }
    else if (t.document_id) { const d = db.prepare('SELECT superseded_by FROM documents WHERE id=?').get(t.document_id); let next = d && d.superseded_by, guard = 0; while (next && guard++ < 20) { docId = next; const n = db.prepare('SELECT superseded_by FROM documents WHERE id=?').get(next); next = n && n.superseded_by; } }
    const v = (t.version || 1) + 1, nm = `${String(t.name).replace(/ v\d+$/, '')} v${v}`;
    const id = db.prepare(`INSERT INTO takeoffs(document_id,project_id,customer_id,name,category,building_sf,lines,questions,status,created_by,created_at,updated_at,adjustments,version,parent_id) VALUES(?,?,?,?,?,?,?,?,'Draft',?,?,?,?,?,?)`)
      .run(docId, t.project_id, t.customer_id, nm, t.category, t.building_sf, JSON.stringify(t.lines), t.questions, who(req), now(), now(), JSON.stringify(t.adjustments), v, t.id).lastInsertRowid;
    logAction(req, 'created version', 'takeoff', id, `${nm} from takeoff #${t.id}`);
    res.status(201).json({ id, version: v, document_id: docId });
  });
  app.locals.takeoffPrice = id => { const t = get(id); return t ? price(t) : null; };
};
