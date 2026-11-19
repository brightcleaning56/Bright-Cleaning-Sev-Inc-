const { COMPANY_NAME } = require('./company');
// Proposal follow-ups and customer texts.
// - Every proposal that is sent gets a default follow-up two business days later (email), so nobody has to remember it.
// - Follow-ups are visible on the proposal, can be changed, cancelled or sent now, and are sent automatically when due.
// - A follow-up is skipped (Cancelled) when the proposal was approved, declined, withdrawn or expired before it is due.
// - Texts (SMS) go through Twilio. They are sent only when someone presses Send, or for a follow-up set to text.
// - Automatic texts are OFF by default (setting sms_auto_followups, owner-only switch). Without a recorded opt-in, the
//   system never texts a customer on its own. Staff-chosen texts are unchanged.
module.exports = function (app, { db, auth, logAction, clean, getMailer }) {
  const bizdate = require('./bizdate');
  const ES = require('./emailsuppress');

  db.exec(`
    CREATE TABLE IF NOT EXISTS proposal_followups(id INTEGER PRIMARY KEY AUTOINCREMENT, estimate_id INTEGER NOT NULL, due_date TEXT NOT NULL, channel TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Scheduled', auto INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL, sent_at TEXT, result TEXT);
    CREATE INDEX IF NOT EXISTS idx_proposal_followups_due ON proposal_followups(status, due_date);
    CREATE TABLE IF NOT EXISTS sms_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, estimate_id INTEGER, customer_id INTEGER, to_number TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, provider_sid TEXT, error TEXT, created_by TEXT, created_at TEXT NOT NULL);
  `);

  try { db.exec('ALTER TABLE sms_messages ADD COLUMN lead_id INTEGER'); } catch { /* already there */ }
  const me = req => String((req.user && req.user.email) || '');
  const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
  const estOf = id => db.prepare('SELECT * FROM estimates WHERE id=?').get(Number(id));
  const DECIDED = ['Approved', 'Declined', 'Withdrawn', 'Expired'];
  const proposalUrl = e => `https://brightclean.net/proposal/${e.public_token}`;

  function phoneOf(e) {
    const c = db.prepare("SELECT phone FROM customers WHERE (?<>'' AND lower(email)=lower(?)) OR (?<>'' AND lower(company)=lower(?)) ORDER BY id LIMIT 1").get(e.email || '', e.email || '', e.company || '', e.company || '');
    if (c && c.phone) return c.phone;
    if (e.lead_id) { const l = db.prepare('SELECT phone FROM leads WHERE id=?').get(e.lead_id); if (l && l.phone) return l.phone; }
    return '';
  }
  function normPhone(p) {
    const raw = String(p || ''), d = raw.replace(/\D/g, '');
    if (raw.trim().startsWith('+') && d.length >= 8) return '+' + d;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return '';
  }

  // Proof of text opt-in for a phone number (see sms_consents in intake.js). Unticked, revoked, or unreadable means no.
  const hasSmsConsent = phone => {
    const want = normPhone(phone); if (!want) return false;
    try { return db.prepare('SELECT phone FROM sms_consents WHERE revoked_at IS NULL').all().some(r => normPhone(r.phone) === want); } catch { return false; }
  };

  // ---- Texts (Twilio). Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_SMS_FROM (a Twilio number that can send texts). ----
  const smsConfig = () => ({ sid: process.env.TWILIO_ACCOUNT_SID || '', token: process.env.TWILIO_AUTH_TOKEN || '', from: process.env.TWILIO_SMS_FROM || '', base: (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '') });
  const smsReady = () => { const c = smsConfig(); return !!(c.sid && c.token && c.from); };
  // Automatic texts are off unless the owner has switched them on (default off, see the header).
  const smsAutoOn = () => { try { const r = db.prepare("SELECT value FROM settings WHERE key='sms_auto_followups'").get(); return !!r && r.value === '1'; } catch { return false; } };
  async function sendSms(to, body) {
    const c = smsConfig();
    if (!smsReady()) throw new Error('Texting is not set up yet. The owner needs to add TWILIO_ACCOUNT_SID and TWILIO_SMS_FROM in Render.');
    const dest = normPhone(to);
    if (!dest) throw new Error('No valid phone number on file for this customer.');
    const r = await fetch(`${c.base}/2010-04-01/Accounts/${encodeURIComponent(c.sid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(c.sid + ':' + c.token).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: dest, From: c.from, Body: body }).toString()
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || ('Text not sent (provider status ' + r.status + ')'));
    return j.sid || null;
  }

  // ---- Follow-up sending ----
  const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function defaultMessage(e) {
    return `Hello ${e.customer_name || ''},\n\nThis is ${COMPANY_NAME} following up to make sure our proposal${e.project_name ? ' for ' + e.project_name : ''} reached you. ` +
      'Have you had a chance to look it over? If anything is unclear, or you would like to talk through the scope or price, reply to this message or call us at (515) 303-3024. We are glad to help you decide.\n\nBright Cleaning Sev Inc.';
  }
  function scheduleAuto(estId) {
    const e = estOf(estId); if (!e || DECIDED.includes(e.status)) return;
    if (db.prepare("SELECT id FROM proposal_followups WHERE estimate_id=? AND auto=1 AND status='Scheduled'").get(e.id)) return;
    const channel = isEmail(e.email) ? 'email' : (phoneOf(e) && smsAutoOn() && hasSmsConsent(phoneOf(e)) ? 'sms' : null);
    if (!channel) return;
    db.prepare("INSERT INTO proposal_followups(estimate_id,due_date,channel,message,status,auto,created_by,created_at) VALUES(?,?,?,?,'Scheduled',1,'system',?)")
      .run(e.id, addDays(bizdate.today(), 2), channel, defaultMessage(e), new Date().toISOString());
  }
  // The send route is unchanged; after a successful send, the default follow-up is scheduled.
  app.use((req, res, next) => {
    if (req.method === 'POST') {
      const m = /^\/api\/admin\/estimates\/(\d+)\/send$/.exec(req.path);
      if (m) res.on('finish', () => { if (res.statusCode === 200) { try { scheduleAuto(Number(m[1])); } catch (err) { console.error('follow-up schedule failed', err.message); } } });
    }
    next();
  });

  async function sendFollowup(f, by) {
    const now = new Date().toISOString();
    const done = (status, result) => db.prepare('UPDATE proposal_followups SET status=?, sent_at=?, result=? WHERE id=?').run(status, status === 'Sent' ? now : null, String(result || '').slice(0, 400), f.id);
    const e = estOf(f.estimate_id);
    if (!e) return done('Failed', 'Proposal not found');
    if (DECIDED.includes(e.status)) return done('Cancelled', 'Proposal was ' + e.status.toLowerCase() + ' before this follow-up was due');
    // A text the system would send on its own needs the owner's switch on. Staff pressing Send is a person's decision.
    if (f.channel === 'sms' && f.auto === 1 && by === 'system' && !smsAutoOn()) return done('Cancelled', 'Automatic texts are off (owner setting sms_auto_followups)');
    // An automatic text needs proof the customer opted in to texts. Without it, the text is not sent.
    if (f.channel === 'sms' && f.auto === 1 && by === 'system' && !hasSmsConsent(phoneOf(e))) return done('Cancelled', 'No text consent on file for this phone number');
    try {
      if (f.channel === 'email') {
        if (!isEmail(e.email)) throw new Error('No email address on the proposal');
        if (ES.isSuppressed(db, e.email)) throw new Error('This address has opted out or could not be delivered to');
        await getMailer().sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER, to: e.email, subject: 'Following up: ' + (e.project_name || 'your Bright Cleaning Sev Inc. proposal'), text: f.message + '\n\nReview the proposal: ' + proposalUrl(e) + '\n', automated: true });
      } else {
        await sendSms(phoneOf(e), f.message.slice(0, 480) + ' ' + proposalUrl(e));
      }
      done('Sent', by === 'system' ? 'Sent automatically' : 'Sent by ' + by);
    } catch (err) { done('Failed', err.message); }
  }
  async function runDue() {
    const rows = db.prepare("SELECT * FROM proposal_followups WHERE status='Scheduled' AND due_date<=? ORDER BY id LIMIT 50").all(bizdate.today());
    for (const f of rows) await sendFollowup(f, 'system');
  }
  if (process.env.NODE_ENV !== 'test') setInterval(() => runDue().catch(err => console.error('follow-up run failed', err.message)), 15 * 60 * 1000).unref();

  app.locals.sendSms = (to, body) => sendSms(to, body);
  app.locals.runFollowupsDue = () => runDue();
  app.locals.smsReady = () => smsReady();

  // ---- Routes ----
  app.get('/api/admin/estimates/:id/followups', auth, (req, res) => {
    const e = estOf(req.params.id); if (!e) return res.status(404).json({ error: 'Not found' });
    res.json({
      followups: db.prepare('SELECT * FROM proposal_followups WHERE estimate_id=? ORDER BY due_date, id').all(e.id),
      texts: db.prepare('SELECT id,to_number,body,status,error,created_by,created_at FROM sms_messages WHERE estimate_id=? ORDER BY id DESC LIMIT 30').all(e.id),
      viewed: { count: e.view_count || 0, first: e.viewed_at || null, last: e.last_viewed_at || null },
      status: e.status, email: e.email || '', phone: phoneOf(e), text_ready: smsReady(), sent_at: e.sent_at || null, auto_sms_enabled: smsAutoOn()
    });
  });

  // Owner only: turn automatic texts on or off. Off is the default. Turning it on is a recorded decision.
  app.put('/api/admin/followups/auto-sms', auth, (req, res) => {
    const ow = String(process.env.ADMIN_EMAIL || '').toLowerCase();
    if (!ow || me(req).toLowerCase() !== ow) return res.status(403).json({ error: 'Only the owner can turn automatic texts on or off.' });
    const on = !!(req.body || {}).enabled;
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('sms_auto_followups',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(on ? '1' : '0', new Date().toISOString());
    logAction(req, on ? 'turned on' : 'turned off', 'setting', 0, 'automatic texts for proposal follow-ups');
    res.json({ enabled: on });
  });

  app.post('/api/admin/estimates/:id/followups', auth, (req, res) => {
    const e = estOf(req.params.id); if (!e) return res.status(404).json({ error: 'Not found' });
    if (DECIDED.includes(e.status)) return res.status(409).json({ error: 'This proposal is ' + e.status.toLowerCase() + '. Follow-ups are for proposals still waiting on a decision.' });
    const b = req.body || {};
    const due = String(b.due_date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: 'Pick the date for the follow-up.' });
    const channel = b.channel === 'sms' ? 'sms' : b.channel === 'email' ? 'email' : null;
    if (!channel) return res.status(400).json({ error: 'Choose email or text.' });
    const message = clean(b.message, 1000);
    if (!message || message.length < 5) return res.status(400).json({ error: 'Write the follow-up message.' });
    if (channel === 'email' && !isEmail(e.email)) return res.status(400).json({ error: 'Add the customer email on the proposal first, or schedule a text.' });
    if (channel === 'sms' && !normPhone(phoneOf(e))) return res.status(400).json({ error: 'Add a customer phone number first (on the customer record or the lead).' });
    const r = db.prepare("INSERT INTO proposal_followups(estimate_id,due_date,channel,message,status,auto,created_by,created_at) VALUES(?,?,?,?,'Scheduled',0,?,?)").run(e.id, due, channel, message, me(req), new Date().toISOString());
    logAction(req, 'scheduled follow-up', 'estimate', e.id, due + ' by ' + channel);
    res.status(201).json({ ok: true, id: r.lastInsertRowid });
  });

  app.post('/api/admin/estimates/:id/followups/:fid/cancel', auth, (req, res) => {
    const f = db.prepare('SELECT * FROM proposal_followups WHERE id=? AND estimate_id=?').get(Number(req.params.fid), Number(req.params.id));
    if (!f) return res.status(404).json({ error: 'Not found' });
    if (f.status !== 'Scheduled') return res.status(409).json({ error: 'Only a scheduled follow-up can be cancelled.' });
    db.prepare("UPDATE proposal_followups SET status='Cancelled', result=? WHERE id=?").run('Cancelled by ' + me(req), f.id);
    logAction(req, 'cancelled follow-up', 'estimate', f.estimate_id, 'follow-up ' + f.id);
    res.json({ ok: true });
  });

  app.post('/api/admin/estimates/:id/followups/:fid/send', auth, async (req, res) => {
    const f = db.prepare('SELECT * FROM proposal_followups WHERE id=? AND estimate_id=?').get(Number(req.params.fid), Number(req.params.id));
    if (!f) return res.status(404).json({ error: 'Not found' });
    if (!['Scheduled', 'Failed'].includes(f.status)) return res.status(409).json({ error: 'This follow-up was already ' + f.status.toLowerCase() + '.' });
    await sendFollowup(f, me(req));
    logAction(req, 'sent follow-up now', 'estimate', f.estimate_id, 'follow-up ' + f.id);
    const after = db.prepare('SELECT * FROM proposal_followups WHERE id=?').get(f.id);
    res.json({ ok: after.status === 'Sent', status: after.status, result: after.result });
  });

  // Text a customer or a lead from anywhere (Call & Message Center, customer and lead records). Every text is logged to the
  // customer or lead it belongs to.
  // Owner only: one test email to a chosen address, to confirm delivery and that the sender name is recorded.
  app.post('/api/admin/email/test', auth, async (req, res) => {
    const ow = String(process.env.ADMIN_EMAIL || '').toLowerCase();
    if (!ow || me(req).toLowerCase() !== ow) return res.status(403).json({ error: 'Only the owner can send a test email.' });
    const to = String((req.body || {}).to || '').trim().slice(0, 254);
    if (!isEmail(to)) return res.status(400).json({ error: 'Enter an email address.' });
    try {
      await getMailer().sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER, to, subject: 'Bright Clean test email (sent-by check)', text: 'This is a test email from the Bright Clean admin to confirm the sender name appears. No action needed.', automated: false });
      res.json({ ok: true });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.post('/api/admin/messages/sms', auth, async (req, res) => {
    const b = req.body || {};
    const body = clean(b.body, 600);
    if (!body || body.length < 2) return res.status(400).json({ error: 'Write the text message first.' });
    const cust = b.customer_id ? db.prepare('SELECT * FROM customers WHERE id=?').get(Number(b.customer_id)) : null;
    const lead = b.lead_id ? db.prepare('SELECT * FROM leads WHERE id=?').get(Number(b.lead_id)) : null;
    if (b.customer_id && !cust) return res.status(404).json({ error: 'That customer was not found.' });
    if (b.lead_id && !lead) return res.status(404).json({ error: 'That lead was not found.' });
    const to = normPhone((cust && cust.phone) || (lead && lead.phone) || b.to || '');
    if (!to) return res.status(400).json({ error: 'No phone number on file. Add one on the customer or lead record first.' });
    if (!smsReady()) return res.status(400).json({ error: 'Texting is not set up yet. The owner needs to add TWILIO_ACCOUNT_SID and TWILIO_SMS_FROM in Render.' });
    const now = new Date().toISOString();
    let status = 'Sent', sid = null, error = null;
    try { sid = await sendSms(to, body); } catch (err) { status = 'Failed'; error = err.message; }
    db.prepare('INSERT INTO sms_messages(estimate_id,customer_id,lead_id,to_number,body,status,provider_sid,error,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(null, cust ? cust.id : null, lead ? lead.id : null, to, body, status, sid, error, me(req), now);
    if (lead) { try { require('./leadlog').record(db, lead.id, 'text_out', status === 'Sent' ? 'Text sent: ' + body.slice(0, 120) : 'Text not sent: ' + error, me(req), body, now); } catch { /* history is best effort */ } }
    logAction(req, 'texted ' + (cust ? 'customer' : lead ? 'lead' : 'number'), cust ? 'customer' : lead ? 'lead' : 'call', cust ? cust.id : lead ? lead.id : null, status === 'Sent' ? 'text sent' : 'text failed: ' + error);
    if (status === 'Failed') return res.status(502).json({ error });
    res.json({ ok: true, sid });
  });

  app.post('/api/admin/estimates/:id/sms', auth, async (req, res) => {
    const e = estOf(req.params.id); if (!e) return res.status(404).json({ error: 'Not found' });
    const body = clean((req.body || {}).body, 600);
    if (!body || body.length < 2) return res.status(400).json({ error: 'Write the text message first.' });
    const to = phoneOf(e), now = new Date().toISOString();
    if (!smsReady()) return res.status(400).json({ error: 'Texting is not set up yet. The owner needs to add TWILIO_ACCOUNT_SID and TWILIO_SMS_FROM in Render.' });
    if (!normPhone(to)) return res.status(400).json({ error: 'Add a customer phone number first (on the customer record or the lead).' });
    let status = 'Sent', sid = null, error = null;
    try { sid = await sendSms(to, body); } catch (err) { status = 'Failed'; error = err.message; }
    db.prepare('INSERT INTO sms_messages(estimate_id,customer_id,to_number,body,status,provider_sid,error,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(e.id, null, normPhone(to), body, status, sid, error, me(req), now);
    logAction(req, 'texted customer', 'estimate', e.id, status === 'Sent' ? 'text sent' : 'text failed: ' + error);
    if (status === 'Failed') return res.status(502).json({ error });
    res.json({ ok: true });
  });
};
