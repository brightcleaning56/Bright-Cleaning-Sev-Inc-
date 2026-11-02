// Bright Clean estimating model (V5).
// Shared by the server routes. The admin screen mirrors this math for its live preview.
//
// Labor hours  = override hours, or area / production rate, or the hours of scope-library lines,
//                per visit, times visits
// Direct cost  = labor + supplies + equipment + other + travel per visit x visits
//                + mobilization + subcontractor + disposal
// Insurance    = direct x insurance/compliance %
// Contingency  = (direct + insurance) x contingency %
// Overhead     = (direct + insurance + contingency) x overhead %
// Price        = total cost / (1 - gross margin %), never below the minimum job charge,
//                or the line-item total when "use line items as price" is chosen
// Total        = price + sales tax
// Crew days    = labor hours / (crew size x shift hours)

const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
const round2 = n => Math.round(n * 100) / 100;

// Extra columns added in V5. Defaults keep older estimates' math unchanged.
const EXTRA_COLUMNS = [
  ['visits', 'REAL DEFAULT 1'], ['crew_size', 'REAL DEFAULT 1'], ['shift_hours', 'REAL DEFAULT 8'],
  ['travel_cost', 'REAL DEFAULT 0'], ['mobilization_cost', 'REAL DEFAULT 0'], ['subcontractor_cost', 'REAL DEFAULT 0'],
  ['disposal_cost', 'REAL DEFAULT 0'], ['insurance_pct', 'REAL DEFAULT 0'], ['contingency_pct', 'REAL DEFAULT 0'],
  ['minimum_charge', 'REAL DEFAULT 0'], ['use_line_items', 'INTEGER DEFAULT 0'], ['crew_days', 'REAL DEFAULT 0'],
  ['line_items_total', 'REAL DEFAULT 0'], ['template_key', 'TEXT'], ['scope_category', 'TEXT'],
  ['sent_at', 'TEXT'], ['viewed_at', 'TEXT'], ['last_viewed_at', 'TEXT'], ['view_count', 'INTEGER DEFAULT 0'],
  ['decided_at', 'TEXT'], ['decision_ip', 'TEXT'], ['decision_agent', 'TEXT']
];

function lineItemsOf(b) {
  const arr = Array.isArray(b.line_items) ? b.line_items : (() => { try { return JSON.parse(b.line_items || '[]'); } catch { return []; } })();
  return arr.slice(0, 100).map(x => {
    const item = { description: String(x.description || '').trim().slice(0, 500), amount: num(x.amount) };
    // Lines priced from the scope library keep a snapshot of the rates they were priced at.
    if (x.scope_id) Object.assign(item, {
      scope_id: Math.trunc(num(x.scope_id)), category: String(x.category || '').slice(0, 30), unit: String(x.unit || '').slice(0, 30),
      quantity: num(x.quantity), unit_price: x.unit_price == null ? null : num(x.unit_price), production_rate: num(x.production_rate),
      pricing_method: String(x.pricing_method || '').slice(0, 20), hours: num(x.hours), labor_rate: num(x.labor_rate)
    });
    return item;
  });
}

function estimateMath(b) {
  const visits = Math.max(1, num(b.visits) || 1);
  const sqft = num(b.area_sqft), rate = num(b.production_rate);
  const scopeHours = lineItemsOf(b).reduce((t, i) => t + (i.scope_id ? i.hours : 0), 0);
  const perVisit = num(b.labor_hours) || (sqft && rate ? sqft / rate : 0) || scopeHours;
  const hours = perVisit * visits;
  const labor = hours * num(b.labor_rate);
  const direct = labor + num(b.supplies_cost) + num(b.equipment_cost) + num(b.other_cost)
    + num(b.travel_cost) * visits + num(b.mobilization_cost) + num(b.subcontractor_cost) + num(b.disposal_cost);
  const insurance = direct * num(b.insurance_pct) / 100;
  const contingency = (direct + insurance) * num(b.contingency_pct) / 100;
  const overhead = (direct + insurance + contingency) * num(b.overhead_pct) / 100;
  const cost = direct + insurance + contingency + overhead;
  const margin = Math.min(num(b.margin_pct), 90);
  let price = cost / (1 - margin / 100);
  const items = lineItemsOf(b);
  const itemsTotal = items.reduce((s, i) => s + i.amount, 0);
  const useItems = !!(b.use_line_items && b.use_line_items !== '0' && b.use_line_items !== 'false') && itemsTotal > 0;
  if (useItems) price = itemsTotal;
  const minimum = num(b.minimum_charge);
  const minimumApplied = !useItems && minimum > 0 && price < minimum;
  if (minimumApplied) price = minimum;
  const total = price * (1 + num(b.tax_pct) / 100);
  const crewHoursPerDay = Math.max(1, num(b.crew_size) || 1) * (num(b.shift_hours) || 8);
  return {
    labor_hours: round2(hours), labor_cost: round2(labor), total_cost: round2(cost),
    proposal_total: round2(total), crew_days: round2(hours / crewHoursPerDay),
    line_items_total: round2(itemsTotal), minimum_applied: minimumApplied, used_line_items: useItems,
    breakdown: { direct: round2(direct), insurance: round2(insurance), contingency: round2(contingency), overhead: round2(overhead), price: round2(price) }
  };
}

// Values for the V5 columns, ready for an UPDATE.
function extraValues(b, m) {
  return {
    visits: Math.max(1, num(b.visits) || 1), crew_size: Math.max(1, num(b.crew_size) || 1), shift_hours: num(b.shift_hours) || 8,
    travel_cost: num(b.travel_cost), mobilization_cost: num(b.mobilization_cost), subcontractor_cost: num(b.subcontractor_cost),
    disposal_cost: num(b.disposal_cost), insurance_pct: num(b.insurance_pct), contingency_pct: num(b.contingency_pct),
    minimum_charge: num(b.minimum_charge), use_line_items: m.used_line_items ? 1 : 0, crew_days: m.crew_days,
    line_items_total: m.line_items_total, template_key: String(b.template_key || '').slice(0, 60) || null,
    scope_category: ['construction', 'multifamily', 'janitorial', 'specialty'].includes(b.scope_category) ? b.scope_category : null
  };
}

function saveExtras(db, id, b, m) {
  const v = extraValues(b, m);
  const keys = Object.keys(v);
  db.prepare(`UPDATE estimates SET ${keys.map(k => k + '=@' + k).join(',')} WHERE id=@id`).run({ ...v, id });
}

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(estimates)').all().map(c => c.name);
  for (const [c, t] of EXTRA_COLUMNS) if (!cols.includes(c)) db.exec(`ALTER TABLE estimates ADD COLUMN ${c} ${t}`);
}

module.exports = { estimateMath, saveExtras, migrate, lineItemsOf, num };
