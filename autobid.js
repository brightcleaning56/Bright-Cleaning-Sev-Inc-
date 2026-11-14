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
      if (!(a.square_footage > 0)) return { missing: ['What is the building square footage (gross sq ft)?'] };
      const ph = [].concat(a.phases || []);
      const want = new Set();
      if (ph.includes('Rough clean')) want.add('Clean #1');
      if (ph.includes('Final clean')) { want.add('Clean #2'); want.add('Clean #3'); }
      if (ph.includes('Touch-up / punch list')) { want.add('Clean #3'); assumptions.push('Touch-up / punch list included in Clean #3.'); }
      if (!want.size) return { missing: ['Which cleaning phases do you want: rough clean, final clean, or touch-up / punch list?'] };
      const lines = [...want].sort().map(p => { const it = item('construction', p); return it ? { scope_id: it.id, quantity: a.square_footage } : null; }).filter(Boolean);
      if (!lines.length) return { missing: ['Construction prices (import the price book)'] };
      if (a.windows && a.windows !== 'No windows') {
        if (!(Number(a.window_count) > 0)) return { missing: ['How many windows are there, approximately (interior and exterior)?'] };
        missing.push('Window cleaning price is not set in Cleaning Scopes (owner to price it)');
      }
      if (a.plans !== 'Uploading them now') missing.push('Drawings to confirm the square footage');
      return { category: 'construction', lines, assumptions, missing };
    }
    if (service === 'unit_turnover') {
      const types = [].concat(a.unit_types || []).filter(t => SIZE[t]);
      if (!types.length || !(a.turns_per_month > 0)) return { missing: ['Which unit types, and how many move-outs or turns per month?'] };
      const per = Math.floor(a.turns_per_month / types.length), extra = a.turns_per_month - per * types.length;
      const lines = types.map((t, i) => { const it = item('multifamily', 'Move-in / move-out clean – ' + SIZE[t]); const q = per + (i === 0 ? extra : 0); return it && q > 0 ? { scope_id: it.id, quantity: q } : null; }).filter(Boolean);
      if (types.length > 1) assumptions.push(`${a.turns_per_month} turns per month split evenly across ${types.join(', ')}; confirm the actual mix.`);
      if (a.condition === 'Heavy') assumptions.push('Heavy move-out condition: price may need an adjustment after photos.');
      return lines.length ? { category: 'multifamily', lines, assumptions, missing } : { missing: ['Move-out prices (import the price book)'] };
    }
    // Visits per month from the customer's frequency (stated as an assumption on the draft).
    const VPM = { 'Daily': 21.7, '5 days per week': 21.7, '3 days per week': 13, 'Weekly': 4.33, 'Every 2 weeks': 2.17, 'Monthly': 1, 'Quarterly': 1 / 3, 'One-time': 1 };
    const anyItem = (cat, prefix) => db.prepare("SELECT * FROM scope_items WHERE active=1 AND category=? AND name LIKE ? ORDER BY id LIMIT 1").get(cat, prefix + '%');
    const r2 = n => Math.round(n * 100) / 100;
    if (service === 'multifamily') {
      const f = a.frequency, v = VPM[f]; if (!v) return { missing: ['How often do you need this cleaned (the frequency)?'] };
      const areas = [].concat(a.common_areas || []), lines = [];
      const add = (name, qtyPerVisit, why) => { if (!(qtyPerVisit > 0)) { missing.push(why); return; } const it = item('multifamily', name); if (!it) { missing.push(`Set the price for "${name}" in Cleaning Scopes`); return; } lines.push({ scope_id: it.id, quantity: r2(qtyPerVisit * v) }); };
      if (areas.includes('Hallways and corridors')) add('Hallways and corridors', Number(a.hallway_sqft), 'What is the total hallway and corridor square footage?');
      if (areas.includes('Stairwells')) add('Stairwells', Number(a.stairwells) * (Number(a.floors) || 0), 'How many stairwells, and how many floors do they serve?');
      if (areas.includes('Elevators')) add('Elevators', Number(a.elevators), 'How many elevator cabs are there?');
      for (const [ans, name] of [['Lobby / leasing office', 'Lobbies and leasing offices'], ['Clubhouse', 'Clubhouses'], ['Fitness center', 'Fitness centers']]) if (areas.includes(ans)) missing.push(`${ans} square footage (walkthrough) to price "${name}"`);
      for (const [ans, name] of [['Laundry rooms', 'Laundry rooms'], ['Trash rooms', 'Trash rooms']]) if (areas.includes(ans)) missing.push(`Number of ${ans.toLowerCase()} to price "${name}"`);
      if ([].concat(a.extras || []).includes('Valet trash')) { const it = item('multifamily', 'Valet trash'); if (!it) missing.push('Set the price for "Valet trash" in Cleaning Scopes'); else if (Number(a.valet_doors) > 0) lines.push({ scope_id: it.id, quantity: r2(Number(a.valet_doors) * 21.7) }); else missing.push('Number of valet trash doors'); if (it) assumptions.push('Valet trash priced at 5 nights per week (21.7 nights/month).'); }
      assumptions.push(`Recurring monthly price: ${f} = ${r2(v)} visits per month.`);
      return lines.length ? { category: 'multifamily', lines, assumptions, missing, recurring: 'month' } : { missing };
    }
    if (service === 'janitorial') {
      const sf = Number(a.square_footage), f = a.frequency, v = VPM[f];
      if (!(sf > 0)) return { missing: ['What is the square footage to be cleaned?'] };
      if (!v) return { missing: ['How often do you need this cleaned (the frequency)?'] };
      const lines = [], base = anyItem('janitorial', 'Daily office cleaning');
      if (!base) return { missing: ['Add "Daily office cleaning" to Cleaning Scopes'] };
      if (!(base.unit_price > 0)) missing.push('Set the price per SF per visit for "Daily office cleaning" in Cleaning Scopes'); else lines.push({ scope_id: base.id, quantity: r2(sf * v) });
      if (Number(a.breakrooms) > 0) { const it = item('janitorial', 'Breakrooms'); if (it) lines.push({ scope_id: it.id, quantity: r2(Number(a.breakrooms) * v) }); else missing.push('Set the price for "Breakrooms" in Cleaning Scopes'); }
      if (Number(a.restrooms) > 0) missing.push(`Fixture count for the ${a.restrooms} restroom(s) to price "Restroom sanitation" (priced per fixture)`);
      // Staffing from the company production rate (SF per labor hour) on the price-book item.
      let staffing = null;
      if (base.production_rate > 0) {
        const hrs = sf / base.production_rate, shift = a.shift === 'Daytime' ? 8 : 4;
        staffing = { hours_per_visit: r2(hrs), crew_size: Math.max(1, Math.ceil(hrs / shift)), shift_hours: shift, monthly_hours: r2(hrs * v) };
        assumptions.push(`Staffing: ${sf.toLocaleString('en-US')} SF ÷ ${base.production_rate.toLocaleString('en-US')} SF/hr = ${staffing.hours_per_visit} labor hours per visit → ${staffing.crew_size} cleaner(s) on a ${shift}-hour ${a.shift === 'Daytime' ? 'day' : 'evening'} shift; about ${staffing.monthly_hours} labor hours per month.`);
      } else missing.push('Set the production rate (SF per labor hour) for "Daily office cleaning" to calculate staffing');
      if (a.day_porter === 'Yes' || a.day_porter === true) missing.push('Day porter hours per day');
      assumptions.push(`Recurring monthly price: ${f} = ${r2(v)} visits per month.`);
      return lines.length ? { category: 'janitorial', lines, assumptions, missing, staffing, recurring: 'month' } : { missing, staffing };
    }
    return null; // windows, power washing, parking: no per-unit prices in the book yet
  }

  // Asks the contact (GC, GM or property contact) the open questions, once per question set. Never prices with a guess.
  function askContact(l, missing) {
    const questions = (missing || []).filter(q => /\?\s*$/.test(q));
    if (!questions.length || !on('auto_ask_contact', true)) return false;
    if (!l.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(l.email)) return false;
    if (/\btest\b/i.test(`${l.contact_name || ''} ${l.company || ''}`)) return false; // never email test submissions
    const m = ctx.getMailer && ctx.getMailer(); if (!m) return false;
    const sig = require('crypto').createHash('sha1').update(questions.join('|')).digest('hex');
    const key = 'bidq:' + l.id, prev = db.prepare('SELECT value FROM ai_settings WHERE key=?').get(key);
    if (prev && prev.value === sig) return false; // already asked these exact questions
    const first = (l.contact_name || '').trim().split(/\s+/)[0] || 'there';
    const text = `Hello ${first},\n\n${['manual', 'import', 'outbound'].includes(l.origin) ? 'This is Bright Clean, a commercial cleaning company in Des Moines. We would like to learn about your projects and what you need cleaned' + (l.company ? ' at ' + l.company : '') + '.' : 'Thank you for your request for ' + (l.project_name || l.service || 'cleaning services') + (l.address ? ' at ' + l.address : '') + '.'} To prepare an accurate price, we need a few details:\n\n${questions.map(q => '- ' + q).join('\n')}\n\nReply to this email with the answers, or with any drawings or photos that show the areas. We will prepare the price once we have them.\n\nThank you,\nBright Cleaning Sev Inc.`;
    const t = now();
    Promise.resolve(m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || 'info@brightclean.net', to: l.email, subject: `A few questions before we price your project`, text, automated: true }))
      .then(r => {
        if (r && r.suppressed) return; // blocked address: nothing was asked
        db.prepare('INSERT INTO ai_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, sig);
        db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES('automation','asked contact for bid details','lead',?,?,?)").run(l.id, questions.join(' | ').slice(0, 900), t);
        if (app.locals.setLeadWaiting) app.locals.setLeadWaiting(l.id);
      })
      .catch(e => console.error('bid questions not sent', l.id, e.message));
    return true;
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
      ...(p.recurring ? [`Pricing is per month (recurring service).`] : []),
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
      try { const r = draftFromLead(l); if (!r || r.skipped) { db.prepare('UPDATE leads SET auto_estimate_id=0 WHERE id=?').run(l.id); if (r && r.skipped) askContact(l, r.missing); } }
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
