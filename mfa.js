// Two-step sign-in (authenticator app codes) for admin accounts.
// Each person turns it on for their own account from Settings → Security. Once on, signing in needs the password
// and a current 6-digit code. Owners and managers must have it on: until they do, the server only lets them use
// the set-up routes (see MFA_OPEN in server.js), and they cannot turn it off. Staff may turn it on or off.
// Enrollment is per account, stored in mfa_factors. The shared secret is never returned after setup is confirmed.
const totp = require('./totp');

function mountMfa(app, ctx) {
  const { db, auth, jwt, rateLimit, signToken, logAction, clean } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS mfa_factors(email TEXT PRIMARY KEY, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT, enabled_at TEXT)`);
  const lower = e => String(e || '').toLowerCase();
  const factor = email => db.prepare('SELECT * FROM mfa_factors WHERE email=?').get(lower(email));
  const who = req => lower(req.user && req.user.email);
  const audit = (email, action, details) => {
    try { db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run(email, action, 'account', 0, details || '', new Date().toISOString()); } catch { /* best effort */ }
  };

  // Signed-in user: see status, set up, confirm, turn off.
  app.get('/api/admin/mfa', auth, (req, res) => {
    const email = who(req), f = factor(email);
    res.json({ enabled: !!(f && f.enabled), setup_pending: !!(f && !f.enabled), enabled_at: f && f.enabled ? f.enabled_at : null, required: !!(ctx.required && ctx.required(email)) });
  });
  app.post('/api/admin/mfa/setup', auth, (req, res) => {
    const email = who(req), f = factor(email);
    if (f && f.enabled) return res.status(409).json({ error: 'Two-step sign-in is already on. Turn it off first to set up a new device.' });
    // A set-up already in progress keeps its key, so a key the person has already added to their app stays valid.
    if (f && f.secret) return res.json({ secret: f.secret, otpauth_uri: totp.otpauthUri(f.secret, email) });
    const secret = totp.newSecret(), now = new Date().toISOString();
    db.prepare('INSERT INTO mfa_factors(email,secret,enabled,created_at) VALUES(?,?,0,?) ON CONFLICT(email) DO UPDATE SET secret=excluded.secret, enabled=0, created_at=excluded.created_at, enabled_at=NULL').run(email, secret, now);
    res.json({ secret, otpauth_uri: totp.otpauthUri(secret, email) });
  });
  // Cancelling a set-up that is not yet on throws its key away, so the next Start gives a fresh key.
  app.post('/api/admin/mfa/cancel', auth, (req, res) => {
    const email = who(req), f = factor(email);
    if (f && !f.enabled) db.prepare('DELETE FROM mfa_factors WHERE email=?').run(email);
    res.json({ ok: true });
  });
  app.post('/api/admin/mfa/enable', auth, (req, res) => {
    const email = who(req), f = factor(email);
    if (!f) return res.status(409).json({ error: 'Start the set-up first.' });
    if (f.enabled) return res.status(409).json({ error: 'Two-step sign-in is already on.' });
    if (!totp.verify(f.secret, (req.body || {}).code)) return res.status(400).json({ error: 'That code is not right. Check the time on your phone and try again.' });
    db.prepare('UPDATE mfa_factors SET enabled=1, enabled_at=? WHERE email=?').run(new Date().toISOString(), email);
    audit(email, 'two-step sign-in turned on', '');
    // A fresh token that has passed the code check, so the session can use the whole app now.
    res.json({ ok: true, token: signToken(email, true) });
  });
  app.post('/api/admin/mfa/disable', auth, (req, res) => {
    const email = who(req), f = factor(email);
    if (ctx.required && ctx.required(email)) return res.status(409).json({ error: 'Two-step sign-in is required for your role, so it cannot be turned off.' });
    if (!f || !f.enabled) return res.status(409).json({ error: 'Two-step sign-in is not on.' });
    if (!totp.verify(f.secret, (req.body || {}).code)) return res.status(400).json({ error: 'Enter a current code from your app to turn two-step sign-in off.' });
    db.prepare('DELETE FROM mfa_factors WHERE email=?').run(email);
    audit(email, 'two-step sign-in turned off', '');
    res.json({ ok: true });
  });

  // Second step of sign-in. Needs the short-lived challenge token from /api/admin/login.
  app.post('/api/admin/login/mfa', rateLimit({ windowMs: 15 * 60 * 1000, max: 12 }), (req, res) => {
    const bad = () => res.status(401).json({ error: 'Sign-in did not complete. Start again with your password.' });
    let p;
    try { p = jwt.verify(String((req.body || {}).mfa_token || ''), process.env.JWT_SECRET); } catch { return bad(); }
    if (!p || p.purpose !== 'mfa') return bad();
    const f = factor(p.email);
    if (!f || !f.enabled) return bad();
    if (!totp.verify(f.secret, (req.body || {}).code)) { audit(lower(p.email), 'two-step sign-in failed', 'wrong code'); return res.status(401).json({ error: 'That code is not right. Check the time on your phone and try again.' }); }
    const email = lower(p.email), row = db.prepare('SELECT * FROM admin_users WHERE email=?').get(email), now = new Date().toISOString();
    if (row) db.prepare('UPDATE admin_users SET last_login_at=? WHERE id=?').run(now, row.id);
    audit(email, 'signed in', 'with two-step code');
    res.json({ token: signToken(email, true), email });
  });
}

// Used by sign-in: is a factor on for this account?
mountMfa.enabledFor = (db, email) => { try { const f = db.prepare('SELECT enabled FROM mfa_factors WHERE email=?').get(String(email || '').toLowerCase()); return !!(f && f.enabled); } catch { return false; } };
mountMfa.challenge = email => require('jsonwebtoken').sign({ purpose: 'mfa', email: String(email).toLowerCase() }, process.env.JWT_SECRET, { expiresIn: '5m' });
module.exports = mountMfa;
