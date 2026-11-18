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
  ['decided_at', 'TEXT'], ['decision_ip', 'TEXT'], ['decision_agent', 'TEXT'], ['unit_condition', 'TEXT'],
  ['windows_interior_panes', 'REAL DEFAULT 0'], ['windows_interior_rate', 'REAL DEFAULT 0'],
  ['windows_exterior_panes', 'REAL DEFAULT 0'], ['windows_exterior_rate', 'REAL DEFAULT 0'], ['windows_cost', 'REAL DEFAULT 0'],
  ['archived_at', 'TEXT'], ['archived_by', 'TEXT'], ['weekly_hours', 'REAL DEFAULT 0']
];

// Unit condition charge added on top of every deep clean line (price book: Light $40, Moderate $60, Heavy $80).
const CONDITION_CHARGE = { Light: 40, Moderate: 60, Heavy: 80 };
function lineItemsOf(b) {
  const arr = Array.isArray(b.line_items) ? b.line_items : (() => { try { return JSON.parse(b.line_items || '[]'); } catch { return []; } })();
  const out = arr.slice(0, 100).map(x => {
    const item = { description: String(x.description || '').trim().slice(0, 500), amount: num(x.amount) };
    // Lines priced from the scope library keep a snapshot of the rates they were priced at.
    if (x.scope_id) Object.assign(item, {
      scope_id: Math.trunc(num(x.scope_id)), category: String(x.category || '').slice(0, 30), unit: String(x.unit || '').slice(0, 30),
      quantity: num(x.quantity), unit_price: x.unit_price == null ? null : num(x.unit_price), production_rate: num(x.production_rate),
      pricing_method: String(x.pricing_method || '').slice(0, 20), hours: num(x.hours), labor_rate: num(x.labor_rate)
    });
    return item;
  });
  const level = Object.keys(CONDITION_CHARGE).find(k => k.toLowerCase() === String(b.unit_condition || '').toLowerCase());
  const isDeep = out.some(i => /deep/i.test(i.description) && !/add-on/i.test(i.description));
  const label = level ? `Unit condition add-on – ${level}` : '';
  if (level && isDeep && !out.some(i => i.description === label)) out.push({ description: label, amount: CONDITION_CHARGE[level] });
  return out;
}

// Overtime: hours a crew works in a week beyond 40 are paid at 1.5x. The quote adds the extra half-time premium.
const OVERTIME_AFTER = 40;
const OVERTIME_MULTIPLIER = 1.5;

// Overtime is counted per person per week. `hours` are crew man-hours for the whole job, `weekly` is the crew's
// man-hours on this job in one week (0 = the whole job falls in one week, the conservative default), `crew` the headcount.
// Each person's hours in a week are weekly / crew. Returns overtime man-hours across all weeks.
function overtimeManHours(hours, weekly, crew) {
  if (!(hours > 0)) return 0;
  const wk = weekly > 0 ? Math.min(hours, weekly) : hours;
  const fullWeeks = Math.floor(hours / wk + 1e-9);
  const rest = Math.max(0, hours - fullWeeks * wk);
  const over = man => crew * Math.max(0, man / crew - OVERTIME_AFTER);
  return fullWeeks * over(wk) + over(rest);
}

function estimateMath(b) {
  const visits = Math.max(1, num(b.visits) || 1);
  const sqft = num(b.area_sqft), rate = num(b.production_rate);
  const scopeHours = lineItemsOf(b).reduce((t, i) => t + (i.scope_id ? i.hours : 0), 0);
  const perVisit = num(b.labor_hours) || (sqft && rate ? sqft / rate : 0) || scopeHours;
  const hours = perVisit * visits;
  const crew = Math.max(1, num(b.crew_size) || 1);
  const overtimeHours = overtimeManHours(hours, num(b.weekly_hours), crew);
  const labor = hours * num(b.labor_rate) + overtimeHours * num(b.labor_rate) * (OVERTIME_MULTIPLIER - 1);
  const windowsTotal = windowsCharge(b);
  const direct = labor + num(b.supplies_cost) + num(b.equipment_cost) + num(b.other_cost)
    + num(b.travel_cost) * visits + num(b.mobilization_cost) + num(b.subcontractor_cost) + num(b.disposal_cost)
    + num(b.windows_cost);
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
  price += windowsTotal; // windows are always added, even when line items are the price
  // The unit-condition add-on is a price-book amount. Line-item pricing already includes it; cost pricing adds it here.
  if (!useItems) price += conditionTotal(items);
  const minimum = num(b.minimum_charge);
  const minimumApplied = !useItems && minimum > 0 && price < minimum;
  if (minimumApplied) price = minimum;
  const total = price * (1 + num(b.tax_pct) / 100);
  const crewHoursPerDay = Math.max(1, num(b.crew_size) || 1) * (num(b.shift_hours) || 8);
  return {
    labor_hours: round2(hours), overtime_hours: round2(overtimeHours), labor_cost: round2(labor), total_cost: round2(cost),
    proposal_total: round2(total), crew_days: round2(hours / crewHoursPerDay),
    line_items_total: round2(itemsTotal), minimum_applied: minimumApplied, used_line_items: useItems,
    windows_total: round2(windowsTotal),
    breakdown: { direct: round2(direct), insurance: round2(insurance), contingency: round2(contingency), overhead: round2(overhead), price: round2(price) }
  };
}

function conditionTotal(items) {
  return items.filter(i => /^Unit condition add-on/.test(i.description)).reduce((s, i) => s + i.amount, 0);
}

// Window cleaning, priced per pane and added to the calculated price.
// Interior and exterior panes each have their own price per pane. Labor and supplies for the
// windows go in windows_cost, which counts as a direct cost so the margin is calculated correctly.
function windowsCharge(b) {
  return num(b.windows_interior_panes) * num(b.windows_interior_rate) + num(b.windows_exterior_panes) * num(b.windows_exterior_rate);
}

// Values for the V5 columns, ready for an UPDATE.
function extraValues(b, m) {
  return {
    visits: Math.max(1, num(b.visits) || 1), crew_size: Math.max(1, num(b.crew_size) || 1), shift_hours: num(b.shift_hours) || 8,
    travel_cost: num(b.travel_cost), mobilization_cost: num(b.mobilization_cost), subcontractor_cost: num(b.subcontractor_cost),
    disposal_cost: num(b.disposal_cost), insurance_pct: num(b.insurance_pct), contingency_pct: num(b.contingency_pct),
    minimum_charge: num(b.minimum_charge), use_line_items: m.used_line_items ? 1 : 0, crew_days: m.crew_days,
    line_items_total: m.line_items_total, template_key: String(b.template_key || '').slice(0, 60) || null,
    scope_category: ['construction', 'multifamily', 'janitorial', 'specialty'].includes(b.scope_category) ? b.scope_category : null,
    unit_condition: ['Light', 'Moderate', 'Heavy'].includes(b.unit_condition) ? b.unit_condition : null,
    windows_interior_panes: num(b.windows_interior_panes), windows_interior_rate: num(b.windows_interior_rate),
    windows_exterior_panes: num(b.windows_exterior_panes), windows_exterior_rate: num(b.windows_exterior_rate),
    windows_cost: num(b.windows_cost), weekly_hours: num(b.weekly_hours)
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

// Labor rate for a new estimate when none is entered: the saved productive labor cost (cost per billable hour).
// Falls back to the planning value (30) if the labor settings cannot be read.
function laborDefaultRate(db) {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='labor_assumptions'").get();
    const v = r ? JSON.parse(r.value) : {};
    const n = Number(v.productive_labor_hour_cost ?? 30);
    return Number.isFinite(n) && n >= 0 ? n : 30;
  } catch { return 30; }
}

// A proposal that would go out at $0, or with labor hours but no labor rate, cannot be sent.
function sendBlock(e) {
  if (!e) return null;
  const usesItems = !!e.use_line_items && e.use_line_items !== '0' && e.use_line_items !== 'false' && Number(e.line_items_total) > 0;
  if (usesItems) return null;
  if (!(Number(e.proposal_total) > 0)) return 'This proposal totals $0. Enter a labor rate and labor hours (or line-item prices) before sending.';
  if (Number(e.labor_hours) > 0 && !(Number(e.labor_rate) > 0)) return 'Enter a labor rate before sending. Without it, the labor on this proposal is priced at $0.';
  return null;
}

module.exports = { estimateMath, saveExtras, migrate, lineItemsOf, num, overtimeManHours, laborDefaultRate, sendBlock };
