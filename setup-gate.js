// New company copies must save their own labor rates and margins before the first quote.
// Only copies made with the setup script set COMPANY_SETUP_PENDING=on, so the live site is not affected.
// Saving the labor assumptions page (owner or manager) sets labor_confirmed.
const MESSAGE = "Before the first quote, open Settings and save this company's labor rates and margins.";
function quoteBlocked(db, env = process.env) {
  if (env.COMPANY_SETUP_PENDING !== 'on') return false;
  try { const r = db.prepare("SELECT value FROM settings WHERE key='labor_confirmed'").get(); return !(r && r.value === '1'); }
  catch (e) { return true; }
}
module.exports = { quoteBlocked, MESSAGE };
