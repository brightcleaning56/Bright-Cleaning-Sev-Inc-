// Phase 3 review help for bills, without AI. Nothing here sends a receipt or a bill anywhere.
// - suggestFor: a category and job from the same vendor's earlier approved bills (the most common one).
// - flagsFor: things a person should look at before approving: a possible duplicate, an amount well above the vendor's usual,
//   a receipt over the threshold with no photo or PDF, a crew receipt with no job, and a job that would go over its budget.
// The AI reading of receipt photos waits for the owner's decision (plan decision A).

const MISSING_RECEIPT_OVER = 75; // bills at or above this need a receipt on file
const UNUSUAL_FACTOR = 2;        // more than twice the vendor's usual amount
const MIN_HISTORY = 3;           // how many earlier bills before the usual amount counts

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const hasCol = (db, t, c) => hasTable(db, t) && db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const median = xs => { const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mostCommon = xs => {
  const count = new Map();
  for (const x of xs) if (x !== null && x !== undefined && x !== '') count.set(x, (count.get(x) || 0) + 1);
  let best = null, n = 0;
  for (const [k, v] of count) if (v > n) { best = k; n = v; }
  return best;
};

function history(db, b) {
  return db.prepare("SELECT category, project_id, amount FROM expense_bills WHERE lower(trim(vendor))=lower(trim(?)) AND id<>? AND approved_by IS NOT NULL AND status<>'Void' ORDER BY id DESC LIMIT 20")
    .all(String(b.vendor || ''), Number(b.id) || 0);
}

// The category and job this vendor's earlier approved bills most often used. Null when there is no history.
function suggestFor(db, b) {
  const rows = history(db, b);
  if (!rows.length) return null;
  const category = mostCommon(rows.map(r => r.category));
  const project_id = mostCommon(rows.map(r => r.project_id));
  let project_name = null;
  if (project_id && hasTable(db, 'projects')) { const p = db.prepare('SELECT name FROM projects WHERE id=?').get(project_id); project_name = p ? p.name : null; }
  return { category, project_id, project_name, basis: rows.length };
}

function flagsFor(db, b) {
  const flags = [];
  const id = Number(b.id) || 0;
  // A bill that looks like another one (the same check used when it was entered).
  const vendor = String(b.vendor || '').trim().toLowerCase(), amount = r2(b.amount), date = String(b.bill_date || ''), ref = String(b.receipt_ref || '').trim();
  const dup = db.prepare(`SELECT id FROM expense_bills WHERE status<>'Void' AND id<>? AND ((lower(vendor)=? AND ROUND(amount,2)=? AND bill_date=?) OR (?<>'' AND receipt_ref=?)) ORDER BY id DESC LIMIT 1`)
    .get(id, vendor, amount, date, ref, ref);
  if (dup) flags.push({ code: 'duplicate', text: `Looks like bill #${dup.id} (same vendor and amount on the same date, or the same receipt reference).` });
  // An amount well above what this vendor usually charges.
  const past = history(db, b).map(r => Number(r.amount)).filter(x => x > 0);
  if (past.length >= MIN_HISTORY) {
    const usual = median(past);
    if (amount > UNUSUAL_FACTOR * usual) flags.push({ code: 'unusual_amount', text: `$${amount.toFixed(2)} is more than ${UNUSUAL_FACTOR} times this vendor's usual $${usual.toFixed(2)}.` });
  }
  // A receipt over the threshold with nothing attached.
  if (amount >= MISSING_RECEIPT_OVER && !b.receipt_file) flags.push({ code: 'missing_receipt', text: `No receipt photo or PDF is attached (bills of $${MISSING_RECEIPT_OVER} or more need one).` });
  // A crew receipt with no job: the office picks a job or confirms it is overhead.
  if (b.source === 'crew' && !b.project_id) flags.push({ code: 'no_job', text: 'Sent by the crew with no job. Pick a job or confirm it is overhead before approving.' });
  // A job that would go over its budget once this bill is counted.
  if (b.project_id && hasCol(db, 'projects', 'budget') && hasTable(db, 'project_costs')) {
    const p = db.prepare('SELECT budget FROM projects WHERE id=?').get(Number(b.project_id));
    const budget = p ? Number(p.budget) || 0 : 0;
    if (budget > 0) {
      const spent = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM project_costs WHERE project_id=?').get(Number(b.project_id)).t;
      const withThis = r2(spent + (b.approved_by ? 0 : amount));
      if (withThis > budget) flags.push({ code: 'over_budget', text: `With this bill the job would be at $${withThis.toFixed(2)} against a $${budget.toFixed(2)} budget.` });
    }
  }
  return flags;
}

// What the close screen shows for one bill: the suggestion and the flags.
function reviewFor(db, b) {
  return { suggestion: suggestFor(db, b), flags: flagsFor(db, b) };
}

module.exports = { suggestFor, flagsFor, reviewFor, MISSING_RECEIPT_OVER, UNUSUAL_FACTOR, MIN_HISTORY };
