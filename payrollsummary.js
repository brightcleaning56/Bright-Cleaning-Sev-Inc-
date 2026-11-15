// Turns finished shifts into pay totals per employee, for review before the provider (ADP) runs payroll.
// Regular hours up to 40 in a work week, overtime above it at 1.5 times the rate. A work week runs Monday to Sunday (assumed;
// confirm the week ADP uses). Only APPROVED shifts are paid; unapproved shifts are counted so they can be seen and fixed.
// This is gross pay only. Taxes and deductions are calculated by the payroll provider.
const WEEK_HOURS = 40, OT_MULT = 1.5;
const round2 = n => Math.round(n * 100) / 100;

// The Monday that starts the week a calendar day (YYYY-MM-DD) falls in.
function mondayOf(day) {
  const d = new Date(day + 'T12:00:00Z');
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// shifts: [{ employee_id, name, payroll_id, rate, day, minutes, approved }]
function totals(shifts) {
  const byWeek = {}, unapproved = {};
  for (const s of shifts) {
    if (!s.approved) { unapproved[s.employee_id] = (unapproved[s.employee_id] || 0) + 1; continue; }
    const k = s.employee_id + '|' + mondayOf(s.day);
    if (!byWeek[k]) byWeek[k] = { ...s, minutes: 0 };
    byWeek[k].minutes += Number(s.minutes) || 0;
  }
  const out = {};
  for (const w of Object.values(byWeek)) {
    const hours = w.minutes / 60;
    const r = out[w.employee_id] || (out[w.employee_id] = { employee_id: w.employee_id, name: w.name, payroll_id: w.payroll_id || '', rate: Number(w.rate) || 0, reg: 0, ot: 0 });
    r.reg += Math.min(hours, WEEK_HOURS);
    r.ot += Math.max(0, hours - WEEK_HOURS);
  }
  // A person with only unapproved shifts still gets a row, so the gap is visible.
  for (const id of Object.keys(unapproved)) if (!out[id]) {
    const s = shifts.find(x => String(x.employee_id) === id);
    out[id] = { employee_id: s.employee_id, name: s.name, payroll_id: s.payroll_id || '', rate: Number(s.rate) || 0, reg: 0, ot: 0 };
  }
  return Object.values(out).map(r => {
    const reg = round2(r.reg), ot = round2(r.ot);
    return { ...r, reg, ot, gross: round2(reg * r.rate + ot * r.rate * OT_MULT), unapproved: unapproved[r.employee_id] || 0 };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = { totals, mondayOf, WEEK_HOURS, OT_MULT };
