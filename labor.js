// Labor cost of an approved time entry, with overtime (decision: overtime goes into the job the employee is working on).
//  - Hours are regular up to the weekly threshold (setting overtime_after_hours, default 40), then overtime at 1.5 times the rate.
//  - The week runs Monday to Sunday. Entries are counted in clock-in order, so the split does not depend on the order of approval.
//  - The cost is worked out once, at approval, and stored on the entry (labor_cost). Later rate changes do not change it.
// Burden is separate (expenses.js), and is off until the owner sets a rate.

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const OT_MULTIPLIER = 1.5;

function ensureColumns(db) {
  const cols = db.prepare('PRAGMA table_info(time_entries)').all().map(c => c.name);
  if (!cols.length) return;
  for (const [c, t] of [['labor_rate', 'REAL'], ['labor_cost', 'REAL'], ['overtime_minutes', 'INTEGER']]) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE time_entries ADD COLUMN ${c} ${t}`);
  }
}

function thresholdHours(db) {
  try { const r = db.prepare("SELECT value FROM settings WHERE key='overtime_after_hours'").get(); const v = Number(r && r.value); return v > 0 && v <= 168 ? v : 40; }
  catch { return 40; }
}

// Monday of the week containing the date (YYYY-MM-DD), as YYYY-MM-DD.
function weekStart(date) {
  const d = new Date(date + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

// Splits one entry's minutes into regular and overtime, and returns its cost.
// entry: { id, employee_id, clock_in, minutes, rate }. The entries counted before it are approved entries for the same employee
// in the same week, clocked in earlier (or the same time with a lower id).
function costOf(db, entry) {
  ensureColumns(db);
  const minutes = Number(entry.minutes) || 0;
  const rate = Number(entry.rate) || 0;
  const day = String(entry.clock_in || '').slice(0, 10);
  const threshold = thresholdHours(db) * 60;
  let before = 0;
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const start = weekStart(day);
    const end = new Date(start + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 7);
    const next = end.toISOString().slice(0, 10);
    const prior = db.prepare(`SELECT COALESCE(SUM(minutes),0) m FROM time_entries
      WHERE employee_id=? AND approved_by IS NOT NULL AND id<>?
        AND clock_in >= ? AND clock_in < ?
        AND (clock_in < ? OR (clock_in = ? AND id < ?))`).get(entry.employee_id, entry.id || 0, start, next, entry.clock_in, entry.clock_in, entry.id || 0);
    before = Number(prior.m) || 0;
  }
  const regular = Math.max(0, Math.min(minutes, threshold - before));
  const overtime = minutes - regular;
  const cost = r2(regular / 60 * rate + overtime / 60 * rate * OT_MULTIPLIER);
  return { cost, regular_minutes: regular, overtime_minutes: overtime };
}

// The cost to use for a stored time entry: the stored cost when there is one, else minutes at the rate in force.
function storedCost(t) {
  if (t.labor_cost != null) return Number(t.labor_cost) || 0;
  return (Number(t.minutes) || 0) / 60 * (Number(t.labor_rate != null ? t.labor_rate : t.hourly_rate) || 0);
}

module.exports = { ensureColumns, costOf, storedCost, weekStart, thresholdHours, OT_MULTIPLIER };
