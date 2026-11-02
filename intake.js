// Service-specific quote intake. One schema drives the public form and the server validation.
// "Before pricing" flags are fixed, explainable rules (not AI) that say what is still needed.
const COMMON_FREQ = ['One-time', 'Daily', '5 days per week', '3 days per week', 'Weekly', 'Every 2 weeks', 'Monthly', 'Quarterly', 'Not sure yet'];

const SERVICES = {
  multifamily: {
    title: 'Multifamily common areas', category: 'multifamily', blurb: 'Apartments, common areas, recurring service',
    fields: [
      { name: 'property_name', label: 'Property name', type: 'text' },
      { name: 'buildings', label: 'Number of buildings', type: 'number', required: true, min: 1 },
      { name: 'units', label: 'Total units', type: 'number', required: true, min: 1 },
      { name: 'floors', label: 'Floors per building (highest)', type: 'number', min: 1 },
      { name: 'common_areas', label: 'Common areas to include', type: 'multi', required: true, options: ['Hallways and corridors', 'Stairwells', 'Elevators', 'Lobby / leasing office', 'Clubhouse', 'Fitness center', 'Laundry rooms', 'Trash rooms', 'Pool area'] },
      { name: 'elevators', label: 'How many elevators?', type: 'number', min: 1, show_if: { field: 'common_areas', has: 'Elevators' } },
      { name: 'frequency', label: 'Cleaning frequency', type: 'select', required: true, options: COMMON_FREQ },
      { name: 'occupancy', label: 'Property status', type: 'select', options: ['Occupied', 'Lease-up / partly occupied', 'New / vacant'] },
      { name: 'extras', label: 'Also interested in', type: 'multi', options: ['Unit turnover cleaning', 'Valet trash', 'Parking lot pickup'] },
      { name: 'valet_doors', label: 'Doors for valet trash', type: 'number', min: 1, show_if: { field: 'extras', has: 'Valet trash' } },
      { name: 'start_date', label: 'Desired start date', type: 'date' }
    ]
  },
  construction_final: {
    title: 'Construction final clean', category: 'construction', blurb: 'New builds, renovations, punch list, windows',
    fields: [
      { name: 'gc_company', label: 'General contractor', type: 'text', required: true },
      { name: 'project_manager', label: 'Project manager', type: 'text' },
      { name: 'building_type', label: 'Building type', type: 'select', required: true, options: ['Office', 'Retail', 'Multifamily', 'Healthcare', 'Education', 'Industrial / warehouse', 'Hospitality', 'Government', 'Other'] },
      { name: 'square_footage', label: 'Building square footage', type: 'number', required: true, min: 100 },
      { name: 'floors', label: 'Number of floors', type: 'number', min: 1 },
      { name: 'phases', label: 'Cleaning phases', type: 'multi', required: true, options: ['Rough clean', 'Final clean', 'Touch-up / punch list'] },
      { name: 'windows', label: 'Window cleaning', type: 'select', required: true, options: ['Interior only', 'Interior and exterior', 'No windows', 'Not sure'] },
      { name: 'exterior_height', label: 'Exterior glass height', type: 'select', options: ['Ground level only', '2–3 stories', '4+ stories (lift or rope access)'], show_if: { field: 'windows', is: 'Interior and exterior' } },
      { name: 'restrooms', label: 'Number of restrooms', type: 'number', min: 0 },
      { name: 'plans', label: 'Drawings and specifications', type: 'select', required: true, options: ['Uploading them now', 'Will send them later', 'No drawings available'] },
      { name: 'bid_due_date', label: 'Bid due date', type: 'date' },
      { name: 'completion_date', label: 'Owner walkthrough / turnover date', type: 'date' },
      { name: 'site_access', label: 'Site access and requirements', type: 'textarea' }
    ]
  },
  janitorial: {
    title: 'Commercial janitorial', category: 'janitorial', blurb: 'Offices and facilities, recurring service',
    fields: [
      { name: 'facility_type', label: 'Facility type', type: 'select', required: true, options: ['Office', 'Medical office', 'Retail', 'Industrial / warehouse', 'School / education', 'Government', 'Other'] },
      { name: 'square_footage', label: 'Cleanable square footage', type: 'number', required: true, min: 100 },
      { name: 'floors', label: 'Floors', type: 'number', min: 1 },
      { name: 'restrooms', label: 'Restrooms', type: 'number', min: 0 },
      { name: 'breakrooms', label: 'Breakrooms / kitchens', type: 'number', min: 0 },
      { name: 'floor_types', label: 'Floor types', type: 'multi', options: ['Carpet', 'VCT', 'LVT / vinyl plank', 'Tile', 'Sealed concrete', 'Wood'] },
      { name: 'frequency', label: 'Frequency', type: 'select', required: true, options: COMMON_FREQ },
      { name: 'shift', label: 'Preferred time', type: 'select', options: ['After hours', 'Daytime', 'Overnight', 'Flexible'] },
      { name: 'supplies', label: 'Restroom paper and soap', type: 'select', options: ['Bright Clean supplies them', 'We supply them', 'Discuss'] },
      { name: 'day_porter', label: 'Day porter needed?', type: 'yesno' },
      { name: 'start_date', label: 'Desired start date', type: 'date' }
    ]
  },
  windows: {
    title: 'Window cleaning', category: 'construction', blurb: 'Interior and exterior glass',
    fields: [
      { name: 'stories', label: 'Building height', type: 'select', required: true, options: ['1 story', '2–3 stories', '4+ stories'] },
      { name: 'sides', label: 'Which sides?', type: 'select', required: true, options: ['Interior', 'Exterior', 'Both'] },
      { name: 'panes', label: 'Approximate number of panes', type: 'number', min: 1 },
      { name: 'access', label: 'Access', type: 'select', options: ['Ground / ladder', 'Lift needed', 'Rope access', 'Not sure'] },
      { name: 'hard_water', label: 'Hard-water stains or construction residue?', type: 'yesno' },
      { name: 'frequency', label: 'Frequency', type: 'select', options: COMMON_FREQ }
    ]
  },
  power_washing: {
    title: 'Power washing', category: 'specialty', blurb: 'Sidewalks, facades, dumpster pads',
    fields: [
      { name: 'surfaces', label: 'Surfaces', type: 'multi', required: true, options: ['Sidewalks', 'Building facade', 'Parking garage', 'Dumpster pads', 'Drive-thru', 'Other'] },
      { name: 'area_sqft', label: 'Approximate area (sq ft)', type: 'number', min: 1 },
      { name: 'condition', label: 'Condition', type: 'select', required: true, options: ['Light dirt', 'Moderate', 'Heavy staining', 'Gum / oil stains'] },
      { name: 'water_access', label: 'Water access on site?', type: 'yesno' },
      { name: 'frequency', label: 'Frequency', type: 'select', options: COMMON_FREQ }
    ]
  },
  parking: {
    title: 'Parking lot maintenance', category: 'specialty', blurb: 'Litter pickup and lot upkeep',
    fields: [
      { name: 'lot_size', label: 'Lot size (acres or number of spaces)', type: 'text', required: true },
      { name: 'services', label: 'Services', type: 'multi', required: true, options: ['Litter pickup', 'Blowing / sweeping', 'Dumpster area cleanup', 'Curb lines'] },
      { name: 'frequency', label: 'Frequency', type: 'select', required: true, options: COMMON_FREQ },
      { name: 'time_window', label: 'Preferred time', type: 'select', options: ['Early morning', 'Daytime', 'Evening', 'Flexible'] }
    ]
  },
  unit_turnover: {
    title: 'Unit turnover', category: 'multifamily', blurb: 'Move-out cleaning for apartments',
    fields: [
      { name: 'property_name', label: 'Property name', type: 'text' },
      { name: 'unit_types', label: 'Unit types', type: 'multi', required: true, options: ['Studio', '1 bedroom', '2 bedroom', '3+ bedroom'] },
      { name: 'avg_sqft', label: 'Average unit size (sq ft)', type: 'number', min: 100 },
      { name: 'turns_per_month', label: 'Turns per month', type: 'number', required: true, min: 1 },
      { name: 'condition', label: 'Typical condition at move-out', type: 'select', required: true, options: ['Light', 'Average', 'Heavy'] },
      { name: 'includes', label: 'Include', type: 'multi', options: ['Inside appliances', 'Interior windows', 'Carpet extraction', 'Wall spot cleaning'] },
      { name: 'notice', label: 'Usual notice before a turn', type: 'select', options: ['Same day', '1–2 days', '3+ days'] }
    ]
  }
};

const visible = (f, a) => !f.show_if || (f.show_if.has ? [].concat(a[f.show_if.field] || []).includes(f.show_if.has) : a[f.show_if.field] === f.show_if.is);

// Returns { answers, errors } with only visible, known fields, cleaned and typed.
function validate(service, raw) {
  const def = SERVICES[service];
  if (!def) return { errors: ['Choose a service.'] };
  const answers = {}, errors = [];
  const str = v => String(Array.isArray(v) ? v[0] : (v ?? '')).trim().slice(0, 2000);
  // First pass: collect select/multi answers so show_if can be evaluated.
  for (const f of def.fields) {
    let v = raw[f.name];
    if (f.type === 'multi') { v = [].concat(v || []).map(x => String(x).trim()).filter(x => f.options.includes(x)); if (v.length) answers[f.name] = v; }
    else if (f.type === 'select') { v = str(v); if (v) { if (!f.options.includes(v)) errors.push(`${f.label}: choose one of the listed options.`); else answers[f.name] = v; } }
    else if (f.type === 'yesno') { v = str(v); if (v) { if (!['Yes', 'No'].includes(v)) errors.push(`${f.label}: answer yes or no.`); else answers[f.name] = v; } }
  }
  for (const f of def.fields) {
    if (!visible(f, answers)) { delete answers[f.name]; continue; }
    if (['multi', 'select', 'yesno'].includes(f.type)) { if (f.required && !answers[f.name]) errors.push(`${f.label} is required.`); continue; }
    const v = str(raw[f.name]);
    if (!v) { if (f.required) errors.push(`${f.label} is required.`); continue; }
    if (f.type === 'number') {
      const n = Number(v.replace(/,/g, ''));
      if (!Number.isFinite(n) || n < (f.min ?? 0) || n > 1e8) { errors.push(`${f.label} must be a number${f.min ? ' of at least ' + f.min : ''}.`); continue; }
      answers[f.name] = n;
    } else if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { errors.push(`${f.label} must be a date.`); continue; }
      answers[f.name] = v;
    } else answers[f.name] = v;
  }
  return { answers, errors };
}

// What Bright Clean still needs before it can price the job responsibly.
function flags(service, a, fileCount) {
  const out = [];
  const add = (code, text) => out.push({ code, text });
  if (service === 'construction_final') {
    if (a.plans === 'Uploading them now' && !fileCount) add('plans', 'Customer said drawings were attached, but no files came through. Ask for the drawing package.');
    else if (a.plans !== 'Uploading them now') add('plans', 'Drawings and specifications are needed before pricing a final clean.');
    if (a.exterior_height === '4+ stories (lift or rope access)') add('site_visit', 'Exterior glass above 3 stories: site visit needed to plan lift or rope access.');
    if (a.windows === 'Not sure') add('clarify', 'Confirm whether window cleaning is in scope.');
    if (a.square_footage >= 50000) add('site_visit', 'Large project: schedule a walkthrough before pricing.');
  }
  if (service === 'janitorial') add('site_visit', 'Recurring janitorial: walkthrough recommended to confirm areas and frequency.');
  if (service === 'multifamily') add('site_visit', 'Recurring common-area service: walkthrough recommended.');
  if (service === 'windows') {
    if (!a.panes) add('count', 'Pane count missing: ask for a count or photos of each elevation.');
    if (['Lift needed', 'Rope access', 'Not sure'].includes(a.access) || a.stories === '4+ stories') add('site_visit', 'Access needs a site visit (height or equipment).');
  }
  if (service === 'power_washing') {
    if (!a.area_sqft) add('measure', 'Area not given: measure on site or ask for dimensions.');
    if (['Heavy staining', 'Gum / oil stains'].includes(a.condition) && !fileCount) add('photos', 'Heavy staining: ask for photos before pricing.');
    if (a.water_access === 'No') add('clarify', 'No water on site: plan for water supply.');
  }
  if (service === 'parking' && !/\d/.test(a.lot_size || '')) add('measure', 'Lot size unclear: confirm acres or number of spaces.');
  if (service === 'unit_turnover' && a.condition === 'Heavy' && !fileCount) add('photos', 'Heavy move-out condition: ask for photos of a typical unit.');
  return out;
}

function summary(service, a) {
  const def = SERVICES[service];
  return def.fields.filter(f => a[f.name] !== undefined).map(f => `${f.label}: ${[].concat(a[f.name]).join(', ')}`).join('\n');
}

module.exports = function mountIntake(app, ctx) {
  const { db, upload, clean, isEmail, notify, logLead, getOps, path, fs } = ctx;
  const cols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  for (const [c, t] of [['intake', 'TEXT'], ['service_key', 'TEXT']]) if (!cols.includes(c)) db.exec(`ALTER TABLE leads ADD COLUMN ${c} ${t}`);

  app.get('/api/quote-schema', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ services: Object.fromEntries(Object.entries(SERVICES).map(([k, v]) => [k, { title: v.title, blurb: v.blurb, fields: v.fields }])) });
  });

  app.post('/api/quotes', upload.array('documents', 8), (req, res) => {
    const b = req.body || {};
    const discard = () => { for (const f of (req.files || [])) { try { fs.unlinkSync(f.path); } catch { /* ignore */ } } };
    if (String(b.website_url || '').trim()) { discard(); return res.status(400).json({ error: 'Unable to process request.' }); }
    const errs = [];
    if (!String(b.contact_name || '').trim()) errs.push('Your name is required.');
    if (!isEmail(b.email)) errs.push('Enter a valid email address.');
    if (!String(b.phone || '').trim()) errs.push('Phone is required.');
    if (!String(b.address || '').trim()) errs.push('Service address is required.');
    if (!b.consent) errs.push('Please agree to be contacted about this request.');
    const service = String(b.service_key || '');
    const v = validate(service, b);
    if (v.errors) errs.push(...v.errors);
    if (errs.length) { discard(); return res.status(400).json({ error: errs.join(' '), errors: errs }); }

    // Double-submit guard: same email and service within 10 minutes returns the first request.
    const since = new Date(Date.now() - 10 * 60e3).toISOString();
    const dup = db.prepare(`SELECT id FROM leads WHERE kind='bid' AND lower(email)=lower(?) AND service_key=? AND created_at>=?`).get(clean(b.email, 254), service, since);
    if (dup) { discard(); return res.status(200).json({ message: 'We already have this request. Thank you.', id: dup.id, duplicate: true }); }

    const def = SERVICES[service], a = v.answers;
    const files = (req.files || []).map(f => ({ name: f.originalname, url: '/api/files/' + path.basename(f.filename) }));
    const fl = flags(service, a, files.length);
    const details = [summary(service, a), b.notes && 'Notes: ' + clean(b.notes, 4000)].filter(Boolean).join('\n\n');
    const now = new Date().toISOString();
    const info = db.prepare(`INSERT INTO leads(kind,contact_name,company,email,phone,project_name,project_type,service,address,square_footage,bid_due_date,start_date,frequency,details,files,created_at,intake,service_key)
      VALUES('bid',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      clean(b.contact_name, 150), clean(b.company, 200), clean(b.email, 254), clean(b.phone, 60),
      clean(a.property_name || b.project_name || '', 200), def.title, def.title, clean(b.address, 500),
      a.square_footage ? String(a.square_footage) : (a.area_sqft ? String(a.area_sqft) : ''), a.bid_due_date || '', a.start_date || '', a.frequency || '',
      details, JSON.stringify(files), now, JSON.stringify({ service, category: def.category, answers: a, flags: fl, version: 1 }), service);
    logLead('quote request (' + def.title + ')', info.lastInsertRowid, clean(b.contact_name));
    const ops = getOps();
    if (ops) ops.upsertCustomer({ name: b.contact_name, company: b.company, email: b.email, phone: b.phone, address: b.address }, 'quote request');
    notify(`New quote request: ${def.title}`, `${clean(b.contact_name)} (${clean(b.company)})\n${clean(b.email)} · ${clean(b.phone)}\n${clean(b.address)}\n\n${details}\n\nBefore pricing:\n${fl.map(x => '- ' + x.text).join('\n') || '- Nothing flagged'}`, process.env.NOTIFY_EMAIL);
    notify('We received your Bright Clean quote request', `Thank you. We received your ${def.title.toLowerCase()} request and will follow up within one business day.`, clean(b.email, 254));
    res.status(201).json({ message: 'Thank you. Your request has been received.', id: info.lastInsertRowid });
  });
};
module.exports.SERVICES = SERVICES;
module.exports.validate = validate;
module.exports.flags = flags;
