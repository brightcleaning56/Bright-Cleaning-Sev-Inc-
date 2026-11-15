// Turns finished shifts into payroll totals per employee: regular hours up to 40 in a work week, overtime above 40.
// A work week runs Monday to Sunday (assumed; confirm the week ADP uses). Only shifts inside the period are counted.
const WEEK_HOURS = 40;
const round2 = n => Math.round(n * 100) / 100;

// The Monday that starts the week a calendar day (YYYY-MM-DD) falls in.
function mondayOf(day) {
  const d = new Date(day + 'T12:00:00Z');
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// shifts: [{ employee_id, name, payroll_id, rate, day, minutes }]
function totals(shifts) {
  const byWeek = {};
  for (const s of shifts) {
    const k = s.employee_id + '|' + mondayOf(s.day);
    if (!byWeek[k]) byWeek[k] = { ...s, minutes: 0 };
    byWeek[k].minutes += Number(s.minutes) || 0;
  }
  const out = {};
  for (const w of Object.values(byWeek)) {
    const hours = w.minutes / 60;
    const r = out[w.employee_id] || (out[w.employee_id] = { employee_id: w.employee_id, name: w.name, payroll_id: w.payroll_id || '', rate: w.rate, reg: 0, ot: 0 });
    r.reg += Math.min(hours, WEEK_HOURS);
    r.ot += Math.max(0, hours - WEEK_HOURS);
  }
  return Object.values(out).map(r => ({ ...r, reg: round2(r.reg), ot: round2(r.ot) })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = { totals, mondayOf, WEEK_HOURS };
