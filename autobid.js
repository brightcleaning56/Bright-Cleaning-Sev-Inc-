// Auto-bid: turns a quote request (or an AI drawing takeoff) into a priced DRAFT estimate using the price book.
// Drafts are never sent automatically: approval rules and the owner still decide what goes to the customer.
module.exports = function mountAutobid(app, ctx) {
  const { db, auth, logAction } = ctx;
  const now = () => new Date().toISOString();
  if (!db.prepare('PRAGMA table_info(leads)').all().some(c => c.name === 'auto_estimate_id')) db.exec('ALTER TABLE leads ADD COLUMN auto_estimate_id INTEGER');
  db.exec('CREATE TABLE IF NOT EXISTS ai_settings(key TEXT PRIMARY KEY, value TEXT)');
  const on = (k, d) => { const r = db.prepare('SELECT value FROM ai_settings WHERE key=?').get(k); return r ? r.value === '1' : d; };
  const item = (cat, prefix) => db.prepare("SELECT * FROM scope_items WHERE active=1 AND category=? AND name LIKE ? AND unit_price IS NOT NULL ORDER BY id LIMIT 1").get(cat, prefix + '%');
  const SIZE = { 'Studio': 'Studio / 1 Bath', '1 bedroom': '1 Bed / 1 Bath', '2 bedroom': '2 Bed / 2 Bath', '3+ bedroom': '3 Bed / 2 Bath' };

  // Returns { category, lines:[{scope_id, quantity, note}], assumptions:[], missing:[] } or null when the price book cannot price it.
  function plan(service, a) {
    const assumptions = [], missing = [];
    if (service === 'construction_final') {
      if (!(a.square_footage > 0)) return { missing: ['Building square footage'] };
      const ph = [].concat(a.phases || []);
      const want = new Set();
      if (ph.includes('Rough clean')) want.add('Clean #1');
      if (ph.includes('Final clean')) { want.add('Clean #2'); want.add('Clean #3'); }
      if (ph.includes('Touch-up / punch list')) { want.add('Clean #3'); assumptions.push('Touch-up / punch list included in Clean #3.'); }
      if (!want.size) want.add('Clean #3');
      const lines = [...want].sort().map(p => { const it = item('construction', p); return it ? { scope_id: it.id, quantity: a.square_footage } : null; }).filter(Boolean);
      if (!lines.length) return { missing: ['Construction prices (import the price book)'] };
      if (a.windows && a.windows !== 'No windows') missing.push('Window cleaning is not in the price book yet: add a window line or price it separately');
      if (a.plans !== 'Uploading them now') missing.push('Drawings to confirm the square footage');
      return { category: 'construction', lines, assumptions, missing };
    }
    if (service === 'unit_turnover') {
      const types = [].concat(a.unit_types || []).filter(t => SIZE[t]);
      if (!types.length || !(a.turns_per_month > 0)) return { missing: ['Unit types and turns per month'] };
      const per = Math.floor(a.turns_per_month / types.length), extra = a.turns_per_month - per * types.length;
      const lines = types.map((t, i) => { const it = item('multifamily', 'Move-in / move-out clean – ' + SIZE[t]); const q = per + (i === 0 ? extra : 0); return it && q > 0 ? { scope_id: it.id, quantity: q } : null; }).filter(Boolean);
      if (types.length > 1) assumptions.push(`${a.turns_per_month} turns per month split evenly across ${types.join(', ')}; confirm the actual mix.`);
      if (a.condition === 'Heavy') assumptions.push('Heavy move-out condition: price may need an adjustment after photos.');
      return lines.length ? { category: 'multifamily', lines, assumptions, missing } : { missing: ['Move-out prices (import the price book)'] };
    }
    if (service === 'multifamily') return { missing: ['Number of hallways per building and stairwell count (needed to price common areas)'] };
    return null; // janitorial, windows, power washing, parking: no per-unit prices in the book yet
  }

  function draftFromLead(l) {
    let ik; try { ik = JSON.parse(l.intake || 'null'); } catch { ik = null; }
    if (!ik || !ik.service) return null;
    const p = plan(ik.service, ik.answers || {});
    if (!p || !p.lines || !p.lines.length) return { skipped: true, missing: p ? p.missing : ['No price-book pricing for this service yet'] };
    const items = p.lines.map(x => { const s = db.prepare('SELECT * FROM scope_items WHERE id=?').get(x.scope_id); const amt = Math.round(x.quantity * s.unit_price * 100) / 100;
      return { scope_id: s.id, description: `${s.name} (${Number(x.quantity).toLocaleString('en-US')} ${s.unit})`, category: s.category, unit: s.unit, quantity: x.quantity, unit_price: s.unit_price, production_rate: s.production_rate || 0, pricing_method: s.pricing_method, hours: 0, labor_rate: 0, amount: amt }; });
    const total = Math.round(items.reduce((t, i) => t + i.amount, 0) * 100) / 100;
    const scope = [`${l.service || l.project_type || 'Cleaning'} for ${l.project_name || l.company || l.contact_name}${l.address ? ' at ' + l.address : ''}.`,
      'Drafted automatically from the customer\'s quote request using the Bright Clean price book. Review before sending.',
      ...(p.assumptions.length ? ['Assumptions: ' + p.assumptions.join(' ')] : []), ...(p.missing.length ? ['Still needed: ' + p.missing.join('; ')] : [])].join('\n\n');
    const t = now();
    const exp = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const info = db.prepare(`INSERT INTO estimates(lead_id,customer_name,company,email,project_name,site_address,scope,area_sqft,line_items,line_items_total,use_line_items,proposal_total,status,public_token,expires_on,created_at,updated_at,scope_category)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,?,'Draft',?,?,?,?,?)`).run(l.id, l.contact_name || l.company || 'Customer', l.company || '', l.email || '', l.project_name || l.service || '', l.address || '', scope,
      Number(l.square_footage) || 0, JSON.stringify(items), total, total, require('crypto').randomBytes(24).toString('hex'), exp, t, t, p.category);
    db.prepare('UPDATE leads SET auto_estimate_id=? WHERE id=?').run(info.lastInsertRowid, l.id);
    db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES('automation','drafted','estimate',?,?,?)").run(info.lastInsertRowid, `from lead #${l.id}: $${total.toLocaleString('en-US')}`, t);
    return { estimate_id: info.lastInsertRowid, total, missing: p.missing };
  }

  function sweep() {
    if (!on('auto_draft_estimates', true)) return;
    const rows = db.prepare(`SELECT * FROM leads WHERE intake IS NOT NULL AND auto_estimate_id IS NULL AND created_at>=? ORDER BY id LIMIT 10`).all(new Date(Date.now() - 14 * 864e5).toISOString());
    for (const l of rows) {
      try { const r = draftFromLead(l); if (!r || r.skipped) db.prepare('UPDATE leads SET auto_estimate_id=0 WHERE id=?').run(l.id); }
      catch (e) { db.prepare('UPDATE leads SET auto_estimate_id=0 WHERE id=?').run(l.id); console.error('auto-bid failed', l.id, e.message); }
    }
  }
  const timer = setInterval(sweep, Number(process.env.AUTOBID_SWEEP_MS) || 30000); timer.unref(); setTimeout(sweep, 2000).unref();

  app.post('/api/admin/leads/:id/draft-estimate', auth, (req, res) => {
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(Number(req.params.id)); if (!l) return res.status(404).json({ error: 'Lead not found.' });
    if (l.auto_estimate_id) { const e = db.prepare('SELECT id FROM estimates WHERE id=?').get(l.auto_estimate_id); if (e) return res.json({ estimate_id: e.id, existing: true }); }
    const r = draftFromLead(l);
    if (!r) return res.status(400).json({ error: 'This lead has no structured quote answers to price. Build the estimate manually.' });
    if (r.skipped) return res.status(400).json({ error: 'Not enough to price automatically: ' + r.missing.join('; ') });
    logAction(req, 'drafted', 'estimate', r.estimate_id, `from lead #${l.id}`);
    res.status(201).json(r);
  });
  app.get('/api/admin/automation/ai-settings', auth, (req, res) => res.json({ auto_draft_estimates: on('auto_draft_estimates', true), auto_request_info: on('auto_request_info', true) }));
  app.put('/api/admin/automation/ai-settings', auth, (req, res) => {
    for (const k of ['auto_draft_estimates', 'auto_request_info']) if (k in (req.body || {})) db.prepare('INSERT INTO ai_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, req.body[k] ? '1' : '0');
    logAction(req, 'changed', 'automation settings', 0, JSON.stringify(req.body || {}).slice(0, 200));
    res.json({ auto_draft_estimates: on('auto_draft_estimates', true), auto_request_info: on('auto_request_info', true) });
  });
  return { sweep, draftFromLead };
};
