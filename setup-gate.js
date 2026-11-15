// New company copies must save their own labor rates and margins before the first quote.
// Only copies made with the setup script set COMPANY_SETUP_PENDING=on, so the live site is not affected.
// Saving the labor assumptions page (owner or manager) sets labor_confirmed.
// The gate is a database trigger, so every route that creates an estimate is covered (manual estimates,
// takeoffs, AI drafts, auto-bid drafts, bid revisions and duplicates), not only one route.
const MESSAGE = 'Before the first quote, open Settings and save the labor rates and margins for this company.';
const TRIGGER = 'quote_gate_estimates';

function pending(db, env = process.env) {
  if (env.COMPANY_SETUP_PENDING !== 'on') return false;
  try { const r = db.prepare("SELECT value FROM settings WHERE key='labor_confirmed'").get(); return !(r && r.value === '1'); }
  catch (e) { return true; }
}

function quoteBlocked(db, env = process.env) { return pending(db, env); }

// Adds the trigger while labor is unconfirmed, and removes it once confirmed.
function sync(db, env = process.env) {
  try {
    if (pending(db, env)) db.exec(`CREATE TRIGGER IF NOT EXISTS ${TRIGGER} BEFORE INSERT ON estimates BEGIN SELECT RAISE(ABORT, '${MESSAGE}'); END;`);
    else db.exec(`DROP TRIGGER IF EXISTS ${TRIGGER};`);
  } catch (e) { /* estimates table not created yet; the next sync will add the trigger */ }
}

module.exports = { quoteBlocked, sync, MESSAGE, TRIGGER };
