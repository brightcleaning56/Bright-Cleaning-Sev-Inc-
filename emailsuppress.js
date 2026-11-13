// Email suppression: addresses that must not get automated email, and the reply tracking that feeds it.
// - Every automated send (reminders, bid questions, AI follow-ups) passes through gate() first.
// - A bounce, a staff-recorded opt-out, or an inbound reply (Outlook inbox sync) adds the address here.
// - A reply that says "stop" / "unsubscribe" is an opt-out; "not interested" is a decline; any other reply pauses automation.
// - Staff can add or remove entries; removing one is limited to owner and manager and is audited.
// Human-started emails (a staff member writing to a customer) are not blocked here; the UI shows the flag instead.

const REASONS = ['opted_out', 'declined', 'replied', 'bounced'];
const OPT_OUT = /\b(unsubscribe|remove me|take me off|take me off (the|your) list|stop (emailing|email|contacting|calling|messaging|sending)|do not (email|contact|message)|don'?t (email|contact|message)|leave me alone|no more (emails|email|messages))\b/i;
const DECLINE = /\b(not interested|no thanks|no,? thank you|we('re| are) (all set|good|covered)|we decline|decline(d)?|went with (another|someone else)|not (a )?fit for us|pass on this)\b/i;
const OWN_DOMAIN = /@brightclean\.net$/i;

function ensure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS email_suppression(
    address TEXT PRIMARY KEY, reason TEXT NOT NULL, source TEXT, detail TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`);
}

const norm = a => String(a || '').trim().toLowerCase().slice(0, 254);

function classify(text) {
  const t = String(text || '');
  if (OPT_OUT.test(t)) return 'opted_out';
  if (DECLINE.test(t)) return 'declined';
  return 'replied';
}

function isSuppressed(db, address) {
  const a = norm(address);
  if (!a) return null;
  return db.prepare('SELECT address, reason, source, created_at FROM email_suppression WHERE address=?').get(a) || null;
}

// Adds or upgrades an address. A stronger reason is never replaced by a weaker one (opted_out beats replied).
const RANK = { replied: 1, bounced: 2, declined: 3, opted_out: 4 };
function suppress(db, address, reason, source, detail, by) {
  ensure(db);
  const a = norm(address);
  if (!a || !REASONS.includes(reason)) return false;
  const now = new Date().toISOString();
  const cur = db.prepare('SELECT reason FROM email_suppression WHERE address=?').get(a);
  if (cur && (RANK[cur.reason] || 0) >= (RANK[reason] || 0)) {
    db.prepare('UPDATE email_suppression SET updated_at=?, detail=? WHERE address=?').run(now, String(detail || '').slice(0, 500), a);
    return false;
  }
  db.prepare(`INSERT INTO email_suppression(address,reason,source,detail,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(address) DO UPDATE SET reason=excluded.reason, source=excluded.source, detail=excluded.detail, updated_at=excluded.updated_at, created_by=excluded.created_by`)
    .run(a, reason, String(source || '').slice(0, 60), String(detail || '').slice(0, 500), now, now, String(by || '').slice(0, 254));
  return true;
}

// Called for every new inbound message. Our own mailbox is ignored so our sends never suppress anyone.
function onInbound(db, fromAddress, subject, preview) {
  const a = norm(fromAddress);
  if (!a || OWN_DOMAIN.test(a)) return null;
  const reason = classify(`${subject || ''} ${preview || ''}`);
  suppress(db, a, reason, 'reply', String(subject || '').slice(0, 200), 'inbox');
  return reason;
}

// Returns { blocked: true, reason } when an automated message must not be sent.
function gate(db, message) {
  if (!message || !message.automated) return { blocked: false };
  const to = [].concat(message.to || '').join(',').split(',').map(norm).filter(Boolean);
  // Job inboxes (careers@, hr@) never receive automated sales email, whatever the lead says.
  for (const a of to) if (require('./leadclass').JOB_INBOX.test(a.split('@')[0])) return { blocked: true, reason: 'job_inbox', address: a };
  for (const a of to) {
    const s = isSuppressed(db, a);
    if (s) return { blocked: true, reason: s.reason, address: a };
  }
  return { blocked: false };
}

const LABEL = { opted_out: 'Asked not to be emailed', declined: 'Declined', replied: 'Replied (automated email paused)', bounced: 'Email bounced' };

function mount(app, ctx) {
  const { db, auth, logAction, adminEmail } = ctx;
  ensure(db);
  const roleOf = req => {
    const e = String((req.user && req.user.email) || '').toLowerCase(), ow = String(adminEmail || '').toLowerCase();
    if (!ow || e === ow) return 'owner';
    const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e);
    return (r && r.role) || 'staff';
  };
  app.get('/api/admin/email-suppression', auth, (req, res) => {
    const rows = db.prepare('SELECT address, reason, source, detail, created_at, updated_at, created_by FROM email_suppression ORDER BY updated_at DESC LIMIT 500').all();
    res.json({ addresses: rows.map(r => ({ ...r, label: LABEL[r.reason] || r.reason })) });
  });
  app.post('/api/admin/email-suppression', auth, (req, res) => {
    const address = norm((req.body || {}).email), reason = String((req.body || {}).reason || 'opted_out');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!REASONS.includes(reason)) return res.status(400).json({ error: 'Choose a reason: opted_out, declined, replied or bounced.' });
    const by = (req.user && req.user.email) || '';
    suppress(db, address, reason, 'staff', String((req.body || {}).detail || 'Recorded by staff'), by);
    logAction(req, 'email suppressed', 'email', 0, `${address}: ${reason}`);
    res.status(201).json({ ok: true });
  });
  app.delete('/api/admin/email-suppression/:address', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only owners and managers can remove an email block.' });
    const address = norm(decodeURIComponent(req.params.address));
    const row = isSuppressed(db, address);
    if (!row) return res.status(404).json({ error: 'That address is not blocked.' });
    db.prepare('DELETE FROM email_suppression WHERE address=?').run(address);
    logAction(req, 'email unblocked', 'email', 0, `${address} (was ${row.reason})`);
    res.json({ ok: true });
  });
}

module.exports = { ensure, classify, isSuppressed, suppress, onInbound, gate, mount, REASONS };
