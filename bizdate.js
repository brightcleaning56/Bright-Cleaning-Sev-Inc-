// Business-local calendar date (YYYY-MM-DD). Due dates, "today", overdue and aging must follow the company's
// clock (Central time by default), not UTC — otherwise everything ages a day early every evening.
const TZ = process.env.BUSINESS_TZ || 'America/Chicago';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
exports.TZ = TZ;
exports.today = (d = new Date()) => fmt.format(d);
// UTC instant at which a business-local calendar day starts (handles daylight saving).
function offsetMin(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - d.getTime()) / 60000;
}
exports.startUTC = ds => { const g = new Date(ds + 'T00:00:00Z'); let t = g.getTime() - offsetMin(g) * 60000; t = g.getTime() - offsetMin(new Date(t)) * 60000; return new Date(t).toISOString(); };
// [from, to] business dates → [startISO, endISO) for filtering ISO timestamps.
exports.window = (from, to) => { const n = new Date(to + 'T12:00:00Z'); n.setUTCDate(n.getUTCDate() + 1); return [exports.startUTC(from), exports.startUTC(n.toISOString().slice(0, 10))]; };
