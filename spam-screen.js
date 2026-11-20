// Screens inbound messages that are not requests for cleaning services (vendor pitches, paid-program offers,
// SEO and lead-generation sales, and cold outreach with a "15-minute call" ask). A message that trips the screen
// never becomes a lead, never reaches the client portal, never notifies staff, and never gets an automatic reply.
// It is kept in blocked_intake, where the owner can review it in the admin API.
// Rule-based on purpose: no AI call, and every block can be explained from the words in the message.
//
// Decision:
//  - Any STRONG signal blocks (for example "AI labs", "per accepted hour", "won't reach out again").
//  - Two or more MODERATE signals block.
//  - One MODERATE signal blocks when the text has no cleaning or service words at all.
// Real requests such as "final clean for a 40-unit building, bid due Dec 3" trip nothing.

const STRONG = [
  /\bai (labs?|companies|training|models?|developers?|data)\b/i,
  /\bfirst[- ]person (video|footage|recordings?)\b/i,
  /\b(training|licens\w*|sell|buy|purchas\w*)\s+(your\s+|our\s+)?(video|footage|data|recordings?)\b/i,
  /\baccepted hours?\b/i,
  /\b(seo|backlinks?|domain authority|guest posts?|lead generation services?|link building|google rankings?|web design services?)\b/i,
  /\b(crypto(currency)?|bitcoin|forex|nft)\b/i,
  /\bwe won'?t (reach out|contact|follow up|email)( you)? (again|anymore)\b/i,
  /\bopen to (a |an )?\d+[- ]?minute call\b/i,
  /\bif (it'?s|it is) not a (fit|match)\b.{0,80}\b(won'?t|will not) (reach|contact|email|follow)/i
];

const MODERATE = [
  /\$\s?\d[\d,.]*\s*(per|a|\/)\s*(accepted\s+)?(hour|hr|month|week|day|worker|person|visit)\b/i,
  /\b(paying|pays|earn|earns|earning)\s+(businesses|companies|you|your (crew|team|company)|\$)/i,
  /\b(pays|paid)\s+(you\s+)?(monthly|each month|every month)\b/i,
  /\b(nothing changes for your|the program covers|you decide which (tasks|jobs))\b/i,
  /\b(reply here|reply to this|email me at|tell me and we)\b/i,
  /\b(passive income|revenue[- ]share|revenue share|partnership opportunit\w*)\b/i
];

const SERVICE_WORDS = /\b(clean\w*|janitor\w*|bids?|quotes?|estimates?|proposals?|walk-?through|projects?|buildings?|propert(y|ies)|units?|offices?|construction|windows?|carpets?|floors?|move[- ]?(in|out)|turnovers?|schedul\w*|prices?|pricing|services?|sanitiz\w*|restrooms?|apartments?|crews?|power ?wash\w*|rough|final|punch)\b/i;

function textOf(fields) {
  return Object.entries(fields || {})
    .filter(([k, v]) => v != null && typeof v !== 'object' && !/^(email|phone|website_url|consent|sms_consent)$/i.test(k))
    .map(([, v]) => String(v))
    .join(' \n ');
}

function screen(fields) {
  const t = textOf(fields);
  const reasons = [];
  for (const re of STRONG) { const m = t.match(re); if (m) reasons.push('Matches "' + m[0].trim() + '"'); }
  const moderate = [];
  for (const re of MODERATE) { const m = t.match(re); if (m) moderate.push(m[0].trim()); }
  const serviceWords = SERVICE_WORDS.test(t);
  if (moderate.length >= 2) reasons.push('Several paid-program or sales phrases: ' + moderate.slice(0, 3).map(s => '"' + s + '"').join(', '));
  else if (moderate.length === 1 && !serviceWords) reasons.push('Sales phrase with no cleaning or service request: "' + moderate[0] + '"');
  return { blocked: reasons.length > 0, reasons };
}

// Stores the blocked attempt for owner review. Never shown in the lead list or the client portal.
let ensured = new WeakSet();
function ensureTable(db) {
  if (ensured.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS blocked_intake(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT, name TEXT, email TEXT, phone TEXT, excerpt TEXT, reasons TEXT, created_at TEXT)`);
  ensured.add(db);
}

function logBlocked(db, source, fields, verdict) {
  ensureTable(db);
  const at = new Date().toISOString();
  const excerpt = textOf(fields).slice(0, 500);
  db.prepare('INSERT INTO blocked_intake(source,name,email,phone,excerpt,reasons,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(source, String(fields.name || fields.contact_name || '').slice(0, 150), String(fields.email || '').slice(0, 254),
      String(fields.phone || '').slice(0, 60), excerpt, JSON.stringify(verdict.reasons), at);
  try {
    db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)")
      .run('system', 'blocked non-service message', 'intake', null, source + ': ' + verdict.reasons[0], at);
  } catch { /* audit table may be absent in tests */ }
}

// Route helper: returns true when the message was blocked (and already logged), so the caller stops before saving.
function refuseIfSpam(db, source, fields) {
  const verdict = screen(fields);
  if (!verdict.blocked) return false;
  logBlocked(db, source, fields, verdict);
  return true;
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  app.get('/api/admin/blocked-intake', auth, (req, res) => {
    ensureTable(db);
    const rows = db.prepare('SELECT id,source,name,email,phone,excerpt,reasons,created_at FROM blocked_intake ORDER BY id DESC LIMIT 200').all()
      .map(r => ({ ...r, reasons: JSON.parse(r.reasons || '[]') }));
    res.json({ items: rows, count: rows.length });
  });
}

module.exports = { screen, refuseIfSpam, logBlocked, mount, STRONG, MODERATE };
