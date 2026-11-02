// Bright Clean cleaning scope library: editable service standards per category.
// Production rates and prices are left blank on purpose until the owner enters real numbers.
const CATEGORIES = {
  construction: 'Construction cleaning',
  multifamily: 'Multifamily',
  janitorial: 'Commercial janitorial',
  specialty: 'Specialty services'
};
const PRICING = { per_unit: 'Per unit', hourly: 'Hourly (labor)', lump_sum: 'Lump sum' };

// [category, name, unit, frequency, description, included, exclusions, quality standard, equipment]
const SEED = [
  ['construction', 'Rough construction clean', 'SF', 'Per phase', 'Interim clean during construction to remove loose debris and heavy dust so trades can continue.', 'Loose debris bagged or moved to on-site dumpster; floors swept; accessible horizontal surfaces dusted.', 'Dumpster supply and haul-off; hazardous materials; detail cleaning.', 'Floors free of loose debris; pathways clear.', 'Push brooms, dust pans, contractor bags, shop vac'],
  ['construction', 'Initial debris and dust removal', 'SF', 'Once', 'First pass after trades finish an area, before detail cleaning.', 'Bulk debris removal, top-down dusting of accessible surfaces, floor sweep.', 'Debris haul-off beyond bagged trash.', 'No visible bulk debris; dust removed from reachable surfaces.', 'HEPA vacuums, brooms, ladders'],
  ['construction', 'Final construction clean (detail)', 'SF', 'Once', 'Detailed clean for owner turnover.', 'All surfaces dust-free top to bottom; fixtures, cabinets inside and out, doors and hardware, labels and stickers removed, floors cleaned to finish type.', 'Paint, adhesive or grout haze removal requiring specialty work; exterior glass above ground floor unless listed.', 'Ready for owner walkthrough: no dust, debris, labels or smudges.', 'HEPA vacuums, microfiber, scrapers, ladders'],
  ['construction', 'Interior window and glass cleaning', 'Each (pane)', 'Once', 'Interior glass, including storefront and partitions.', 'Glass both sides where interior, labels removed, frames wiped.', 'Hard-water stain removal; rope access.', 'Streak-free, no labels or residue.', 'Squeegees, scrapers, extension poles'],
  ['construction', 'Exterior window cleaning', 'Each (pane)', 'Once', 'Exterior glass reachable from ground, ladder or lift as listed.', 'Exterior glass, frames and sills.', 'Lift rental unless listed; rope access; screen repair.', 'Streak-free; frames free of construction residue.', 'Water-fed poles, ladders, lift (if listed)'],
  ['construction', 'Glass partitions', 'Each', 'Once', 'Interior glass walls and partitions.', 'Both sides, frames and tracks.', 'Film or tint removal.', 'Streak-free; no fingerprints.', 'Squeegees, microfiber'],
  ['construction', 'Frames, tracks and sills', 'LF', 'Once', 'Window and door frames, tracks and sills.', 'Vacuum and wipe tracks; sills and frames detailed.', 'Repair of damaged tracks.', 'Tracks free of debris; frames dust-free.', 'Crevice tools, detail brushes'],
  ['construction', 'Restroom detail cleaning', 'Fixture', 'Once', 'Detailed clean of new restroom fixtures and finishes.', 'Toilets, urinals, sinks, partitions, mirrors, dispensers, tile and grout surfaces.', 'Grout haze or sealer removal.', 'Fixtures and partitions spotless; mirrors streak-free.', 'Non-scratch pads, disinfectant'],
  ['construction', 'Kitchen and breakroom cleaning', 'Each (room)', 'Once', 'New kitchens and breakrooms.', 'Cabinets inside and out, counters, sinks, appliances inside and out, backsplashes.', 'Appliance protective film removal if adhered by heat.', 'Food-contact surfaces clean; appliances free of film and dust.', 'Microfiber, stainless cleaner'],
  ['construction', 'Doors, frames, trim and hardware', 'Each (door)', 'Once', 'Doors and trim detail.', 'Both faces, edges, frames, hardware, kick plates.', 'Paint touch-up.', 'No dust, labels or smudges.', 'Microfiber, ladders'],
  ['construction', 'Floor cleaning by finish type', 'SF', 'Once', 'Floors cleaned per finish: sealed concrete, VCT, LVT, tile, carpet, wood.', 'Sweep/vacuum and wet clean appropriate to finish.', 'Stripping, refinishing, carpet extraction unless listed.', 'Floors free of dust, residue and haze.', 'Auto-scrubber, mops, vacuums'],
  ['construction', 'Stairwells and elevators', 'Each (stair/cab)', 'Once', 'Stair runs, landings, rails and elevator cabs.', 'Treads, risers, rails, landings; elevator walls, doors, tracks and floor.', 'Elevator pit and shaft cleaning.', 'No dust on treads, rails or cab surfaces.', 'Vacuums, microfiber'],
  ['construction', 'High and low dusting', 'SF', 'Once', 'Dusting above reach and at floor level.', 'Ledges, vents, light fixtures, baseboards, outlet covers.', 'Ductwork interior cleaning; work above lift height unless listed.', 'No visible dust high or low.', 'Extension dusters, lift (if listed)'],
  ['construction', 'Punch-list and final touch-up clean', 'Visit', 'As needed', 'Return visits after trades complete punch items.', 'Re-clean of areas disturbed by trades, as listed.', 'Damage caused by others beyond normal touch-up.', 'Areas restored to final-clean standard.', 'Detail kit'],
  ['construction', 'Construction debris handling', 'Load', 'As needed', 'Moving construction debris to on-site container.', 'Bagging and carrying debris to the dumpster.', 'Dumpster supply, hauling and disposal fees unless listed.', 'Work areas clear of debris.', 'Carts, contractor bags'],

  ['multifamily', 'Apartment unit turnover', 'Unit', 'Per turn', 'Move-out cleaning for vacant units.', 'Kitchen, appliances, cabinets, bathrooms, floors, baseboards, interior windows, closets, fixtures.', 'Carpet extraction, wall washing, painting, pest treatment.', 'Rent-ready: passes property inspection checklist.', 'Detail kit, vacuum'],
  ['multifamily', 'Vacant-unit cleaning', 'Unit', 'Per request', 'Light clean of vacant units for showings.', 'Dusting, floors, kitchen and bath wipe-down.', 'Deep turnover work.', 'Show-ready appearance.', 'Detail kit'],
  ['multifamily', 'Occupied-unit cleaning', 'Unit', 'Per request', 'Cleaning in occupied units with resident coordination.', 'As listed per request.', 'Personal items handling.', 'Per agreed checklist.', 'Detail kit'],
  ['multifamily', 'Hallways and corridors', 'SF', 'Recurring', 'Common corridor cleaning.', 'Vacuum or mop, spot-clean walls and doors, dust rails and ledges.', 'Carpet extraction unless listed.', 'Clean, odor-free corridors.', 'Vacuums, mops'],
  ['multifamily', 'Stairwells', 'Floor', 'Recurring', 'Stairwell cleaning by floor.', 'Treads, landings, rails.', 'Stair repairs.', 'Free of debris and dust.', 'Vacuums, mops'],
  ['multifamily', 'Elevators', 'Cab', 'Recurring', 'Elevator cab cleaning.', 'Walls, doors, tracks, floor, buttons.', 'Mechanical areas.', 'Cab spotless and odor-free.', 'Microfiber, track vac'],
  ['multifamily', 'Lobbies and leasing offices', 'SF', 'Recurring', 'Front-of-house areas.', 'Floors, glass, furniture dusting, trash.', 'Upholstery cleaning unless listed.', 'Presentation-ready daily.', 'Vacuums, glass kit'],
  ['multifamily', 'Clubhouses', 'SF', 'Recurring', 'Resident clubhouse cleaning.', 'Floors, kitchens, restrooms, furniture.', 'Event cleanup unless listed.', 'Clean and stocked.', 'Detail kit'],
  ['multifamily', 'Fitness centers', 'SF', 'Recurring', 'Fitness room cleaning.', 'Equipment wipe-down, mirrors, floors, trash.', 'Equipment repair.', 'Equipment sanitized; mirrors streak-free.', 'Disinfectant, microfiber'],
  ['multifamily', 'Laundry rooms', 'Each', 'Recurring', 'Common laundry rooms.', 'Machine exteriors, counters, floors, lint areas, trash.', 'Machine repairs.', 'Clean and lint-free.', 'Detail kit'],
  ['multifamily', 'Trash rooms', 'Each', 'Recurring', 'Trash and recycling rooms.', 'Floor cleaning, spill cleanup, odor control.', 'Chute cleaning unless listed.', 'Odor controlled; floors clean.', 'Degreaser, mops'],
  ['multifamily', 'Parking lot pickup', 'Acre', 'Recurring', 'Litter pickup in parking areas.', 'Litter and debris collection.', 'Sweeping by machine unless listed.', 'Lot free of litter.', 'Litter pickers, bags'],
  ['multifamily', 'Valet trash', 'Door', 'Per night', 'Doorstep trash collection.', 'Collection on scheduled nights to compactor or dumpster.', 'Bulk items; hazardous waste.', 'All set-out bags collected on schedule.', 'Carts, bags'],
  ['multifamily', 'Recurring common-area cleaning', 'Visit', 'Recurring', 'Bundled common-area service.', 'Areas and tasks per schedule.', 'Items not listed in schedule.', 'Per agreed checklist and inspection.', 'Detail kit'],

  ['janitorial', 'Daily office cleaning', 'SF', 'Daily', 'Routine cleaning of occupied office space.', 'Trash and recycling, dusting, vacuuming, hard-floor mopping, kitchen wipe-down.', 'High dusting above 8 ft; carpet extraction; windows.', 'Per daily checklist; passes inspection.', 'Backpack vacuums, mops'],
  ['janitorial', 'Periodic cleaning', 'SF', 'Weekly / monthly', 'Periodic tasks on a set schedule.', 'Detail dusting, baseboards, vents, deeper restroom work.', 'Floor refinishing unless listed.', 'Per periodic task list.', 'Detail kit'],
  ['janitorial', 'Restroom sanitation', 'Fixture', 'Daily', 'Restroom cleaning and disinfection.', 'Fixtures, partitions, mirrors, floors, restocking.', 'Plumbing repairs.', 'Sanitized, stocked, odor-free.', 'Disinfectant, mops'],
  ['janitorial', 'Office and conference rooms', 'Each (room)', 'Daily', 'Offices and conference rooms.', 'Trash, desks and tables, chairs, floors.', 'Moving heavy furniture; papers on desks.', 'Tidy and dust-free.', 'Vacuums, microfiber'],
  ['janitorial', 'Breakrooms', 'Each (room)', 'Daily', 'Breakroom cleaning.', 'Counters, sinks, appliance exteriors, tables, floors, trash.', 'Refrigerator clean-outs unless listed.', 'Food areas clean and sanitized.', 'Disinfectant, microfiber'],
  ['janitorial', 'Floor maintenance', 'SF', 'Periodic', 'Hard-floor care programs.', 'Scrub, buff or burnish per schedule.', 'Strip and refinish unless listed.', 'Even gloss, no buildup.', 'Auto-scrubber, burnisher'],
  ['janitorial', 'Carpet cleaning', 'SF', 'Periodic', 'Carpet extraction.', 'Pre-treat, hot-water extraction.', 'Permanent stain removal guarantee; carpet repair.', 'Visibly cleaner; dries per schedule.', 'Extractor'],
  ['janitorial', 'Interior glass', 'Each (pane)', 'Weekly', 'Interior glass and entry doors.', 'Glass, frames, door glass.', 'Exterior windows.', 'Streak-free, no fingerprints.', 'Glass kit'],
  ['janitorial', 'Supply replenishment', 'Visit', 'Daily', 'Restocking consumables.', 'Paper, soap, liners from client or supplied stock as agreed.', 'Supply cost unless included in pricing.', 'No dispensers empty.', 'Supply cart'],
  ['janitorial', 'Day porter service', 'Hour', 'Daily', 'On-site porter during business hours.', 'Restroom checks, spills, trash, lobby upkeep.', 'Tasks outside agreed schedule.', 'Areas maintained throughout the day.', 'Porter cart'],
  ['janitorial', 'Quality inspections', 'Visit', 'Monthly', 'Supervisor inspections with written scores.', 'Walkthrough, scorecard, corrective actions.', '—', 'Scores recorded; issues closed promptly.', 'Inspection checklist'],

  ['specialty', 'Power washing', 'SF', 'Per request', 'Exterior pressure washing.', 'Sidewalks, facades, dumpster pads or structures as listed.', 'Graffiti removal, sealing, oil-stain treatment unless listed.', 'Even, clean surface; runoff handled per site rules.', 'Pressure washer, surface cleaner'],
  ['specialty', 'Parking lot maintenance', 'Acre', 'Recurring', 'Parking area upkeep.', 'Litter pickup, debris removal, curb lines.', 'Striping, sealing, snow removal.', 'Lot clean at each visit.', 'Litter pickers, blower']
];

module.exports = function mountScopes(app, ctx) {
  const { db, auth, logAction, clean } = ctx;
  const now = () => new Date().toISOString();

  db.exec(`CREATE TABLE IF NOT EXISTS scope_items(
    id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, name TEXT NOT NULL, description TEXT, unit TEXT NOT NULL,
    production_rate REAL, crew_size REAL, labor_notes TEXT, equipment TEXT, materials TEXT, frequency TEXT,
    quality_standard TEXT, included TEXT, exclusions TEXT, pricing_method TEXT NOT NULL DEFAULT 'per_unit', unit_price REAL,
    active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(category, name));`);
  if (!db.prepare('SELECT COUNT(*) n FROM scope_items').get().n) {
    const ins = db.prepare(`INSERT OR IGNORE INTO scope_items(category,name,unit,frequency,description,included,exclusions,quality_standard,equipment,sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => SEED.forEach((s, i) => ins.run(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], i, now(), now())))();
  }

  const TEXT = ['name', 'description', 'unit', 'labor_notes', 'equipment', 'materials', 'frequency', 'quality_standard', 'included', 'exclusions'];
  const numOrNull = v => (v === '' || v === null || v === undefined) ? null : Number(v);
  function validate(b, partial) {
    const out = {}; const errs = [];
    if (!partial || 'category' in b) { if (!CATEGORIES[b.category]) errs.push('Choose a valid category.'); else out.category = b.category; }
    if (!partial || 'name' in b) { const n = clean(b.name, 120); if (!n) errs.push('Name is required.'); else out.name = n; }
    if (!partial || 'unit' in b) { const u = clean(b.unit, 30); if (!u) errs.push('Measurement unit is required.'); else out.unit = u; }
    for (const k of TEXT) if (k in b && !['name', 'unit'].includes(k)) out[k] = clean(b[k], 2000);
    for (const k of ['production_rate', 'crew_size', 'unit_price']) if (k in b) {
      const v = numOrNull(b[k]);
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > 1e7)) errs.push(`${k.replace('_', ' ')} must be a positive number or blank.`);
      else out[k] = v;
    }
    if ('pricing_method' in b) { if (!PRICING[b.pricing_method]) errs.push('Choose a valid pricing method.'); else out.pricing_method = b.pricing_method; }
    if ('active' in b) out.active = b.active ? 1 : 0;
    return { out, errs };
  }
  const missing = s => [s.production_rate == null && 'production rate', s.unit_price == null && s.pricing_method !== 'hourly' && 'price', s.crew_size == null && 'crew size'].filter(Boolean);
  const decorate = s => ({ ...s, missing: missing(s) });

  app.get('/api/admin/scopes', auth, (req, res) => {
    const items = db.prepare('SELECT * FROM scope_items ORDER BY category, sort, name').all().map(decorate);
    const active = items.filter(i => i.active);
    res.json({ categories: CATEGORIES, pricing: PRICING, items,
      summary: { total: active.length, needs_rates: active.filter(i => i.missing.length).length } });
  });

  app.post('/api/admin/scopes', auth, (req, res) => {
    const { out, errs } = validate(req.body || {}, false);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    if (db.prepare('SELECT 1 FROM scope_items WHERE category=? AND name=?').get(out.category, out.name)) return res.status(409).json({ error: 'A scope item with this name already exists in that category.' });
    const sort = (db.prepare('SELECT MAX(sort) m FROM scope_items WHERE category=?').get(out.category).m ?? -1) + 1;
    const cols = Object.keys(out);
    const info = db.prepare(`INSERT INTO scope_items(${cols.join(',')},sort,created_at,updated_at) VALUES(${cols.map(() => '?').join(',')},?,?,?)`).run(...cols.map(c => out[c]), sort, now(), now());
    logAction(req, 'created', 'scope item', info.lastInsertRowid, out.name);
    res.status(201).json({ item: decorate(db.prepare('SELECT * FROM scope_items WHERE id=?').get(info.lastInsertRowid)) });
  });

  app.patch('/api/admin/scopes/:id', auth, (req, res) => {
    const cur = db.prepare('SELECT * FROM scope_items WHERE id=?').get(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Scope item not found.' });
    const { out, errs } = validate(req.body || {}, true);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const cat = out.category || cur.category, name = out.name || cur.name;
    if (db.prepare('SELECT 1 FROM scope_items WHERE category=? AND name=? AND id<>?').get(cat, name, cur.id)) return res.status(409).json({ error: 'Another item in that category already has this name.' });
    const cols = Object.keys(out);
    if (cols.length) db.prepare(`UPDATE scope_items SET ${cols.map(c => c + '=?').join(',')}, updated_at=? WHERE id=?`).run(...cols.map(c => out[c]), now(), cur.id);
    const changed = cols.filter(c => String(out[c] ?? '') !== String(cur[c] ?? ''));
    if (changed.length) logAction(req, 'updated', 'scope item', cur.id, `${name}: ${changed.join(', ')}`);
    res.json({ item: decorate(db.prepare('SELECT * FROM scope_items WHERE id=?').get(cur.id)) });
  });

  // Items are archived, not deleted, so past estimates that referenced them stay explainable.
  app.delete('/api/admin/scopes/:id', auth, (req, res) => {
    const cur = db.prepare('SELECT * FROM scope_items WHERE id=?').get(Number(req.params.id));
    if (!cur) return res.status(404).json({ error: 'Scope item not found.' });
    db.prepare('UPDATE scope_items SET active=0, updated_at=? WHERE id=?').run(now(), cur.id);
    logAction(req, 'archived', 'scope item', cur.id, cur.name);
    res.json({ ok: true });
  });
};
module.exports.CATEGORIES = CATEGORIES;

// Re-prices every scope-library line on an estimate from the library itself (amounts sent by the
// browser are ignored) and enforces that every line belongs to the estimate's service category.
// Returns an error message, or null when the body is valid. Rewrites body.line_items in place.
module.exports.resolveLines = function resolveLines(db, b) {
  let arr = b.line_items;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr || '[]'); } catch { arr = []; } }
  if (!Array.isArray(arr)) return null;
  const scoped = arr.filter(x => x && x.scope_id);
  if (b.scope_category && !CATEGORIES[b.scope_category]) return 'Choose a valid service category.';
  if (!scoped.length) { b.line_items = arr; return null; }
  if (!CATEGORIES[b.scope_category]) return 'Choose the service category before adding items from the scope library.';
  const round = n => Math.round(n * 100) / 100;
  const out = [];
  for (const x of arr) {
    if (!x || !x.scope_id) { out.push(x); continue; }
    const s = db.prepare('SELECT * FROM scope_items WHERE id=?').get(Number(x.scope_id));
    if (!s || !s.active) return 'A scope item on this estimate no longer exists or was archived. Remove it and add it again.';
    if (s.category !== b.scope_category) return `"${s.name}" is a ${CATEGORIES[s.category].toLowerCase()} item. This estimate is ${CATEGORIES[b.scope_category].toLowerCase()}, so it can only use items from that category.`;
    const qty = Number(x.quantity);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e8) return `Enter a quantity above zero for "${s.name}".`;
    if (s.production_rate == null || s.production_rate <= 0) return `"${s.name}" has no production rate yet. Add it under Cleaning scopes first.`;
    const hours = qty / s.production_rate;
    let amount, laborRate = 0;
    if (s.pricing_method === 'hourly') {
      laborRate = Number(b.labor_rate) || 0;
      if (laborRate <= 0) return `"${s.name}" is priced hourly. Enter the loaded labor rate on the estimate first.`;
      amount = hours * laborRate;
    } else {
      if (s.unit_price == null) return `"${s.name}" has no price yet. Add it under Cleaning scopes first.`;
      amount = s.pricing_method === 'lump_sum' ? s.unit_price : qty * s.unit_price;
    }
    const q = Number.isInteger(qty) ? qty.toLocaleString('en-US') : String(round(qty));
    out.push({ scope_id: s.id, description: `${s.name} (${q} ${s.unit})`, category: s.category, unit: s.unit, quantity: qty,
      unit_price: s.unit_price, production_rate: s.production_rate, pricing_method: s.pricing_method,
      hours: round(hours), labor_rate: laborRate, amount: round(amount) });
  }
  b.line_items = out;
  return null;
};
