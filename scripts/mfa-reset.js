// Turns two-step sign-in off for one account, for use when the phone with the authenticator app is lost.
// Run on the server (for example in the Render shell), with the same DATA_DIR the app uses:
//   node scripts/mfa-reset.js person@example.com
// The account then signs in with its password alone, and can turn two-step sign-in back on from Settings → Security.
const path = require('path'), fs = require('fs');
const Database = require('better-sqlite3');
const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) { console.error('Usage: node scripts/mfa-reset.js person@example.com'); process.exit(2); }
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const file = path.join(dataDir, 'brightclean.db');
if (!fs.existsSync(file)) { console.error('No database found at ' + file); process.exit(1); }
const db = new Database(file);
try {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mfa_factors'").get();
  if (!table) { console.log('Two-step sign-in has never been set up on this server.'); process.exit(0); }
  const r = db.prepare('DELETE FROM mfa_factors WHERE email=?').run(email);
  db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run('server reset script', 'two-step sign-in reset', 'account', 0, email, new Date().toISOString());
  console.log(r.changes ? `Two-step sign-in turned off for ${email}.` : `No two-step sign-in was set up for ${email}.`);
} finally { db.close(); }
