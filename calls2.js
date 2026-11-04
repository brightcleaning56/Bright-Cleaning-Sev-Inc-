// Phone-provider capture (Twilio). Off until TWILIO_AUTH_TOKEN is set. Every webhook is verified with Twilio's
// X-Twilio-Signature (HMAC-SHA1 of the full URL + sorted POST params) so nobody can inject fake calls.
// Inbound/missed calls are logged automatically (matched to a customer by phone); recordings and transcripts
// are attached when Twilio sends them, and missed calls get a follow-up for today.
const crypto = require('crypto');
module.exports = function mountCalls(app, ctx) {
  const { db, auth, logAction, clean } = ctx;
  const cols = db.prepare('PRAGMA table_info(calls)').all().map(c => c.name);
  for (const [c, t] of [['transcript', 'TEXT'], ['ai', 'TEXT'], ['sentiment', 'TEXT'], ['intent', 'TEXT'], ['lead_score', 'INTEGER'], ['analyzed_at', 'TEXT'], ['duration_s', 'INTEGER'], ['recording_url', 'TEXT'], ['provider_sid', 'TEXT'], ['source', "TEXT DEFAULT 'Manual'"]])
    if (!cols.includes(c)) db.exec(`ALTER TABLE calls ADD COLUMN ${c} ${t}`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS calls_provider_sid ON calls(provider_sid) WHERE provider_sid IS NOT NULL');
  const token = () => process.env.TWILIO_AUTH_TOKEN || '';
  const base = () => (process.env.PUBLIC_BASE_URL || 'https://brightclean.net').replace(/\/$/, '');
  const today = () => require('./bizdate').today(), now = () => new Date().toISOString();
  function valid(req) {
    const sig = String(req.headers['x-twilio-signature'] || ''); if (!sig || !token()) return false;
    const url = base() + req.originalUrl, b = req.body || {};
    const data = url + Object.keys(b).sort().map(k => k + b[k]).join('');
    const exp = crypto.createHmac('sha1', token()).update(Buffer.from(data, 'utf8')).digest('base64');
    return exp.length === sig.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(sig));
  }
  const digits = p => String(p || '').replace(/\D/g, '').slice(-10);
  function matchCustomer(phone) {
    const d = digits(phone); if (d.length < 10) return null;
    // Link only when exactly one customer has this number; a shared line (e.g. a GC's main office) stays unlinked for a person to assign.
    const m = db.prepare("SELECT id, name, company FROM customers WHERE phone IS NOT NULL AND replace(replace(replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')',''),'.',''),'+1','') LIKE ?").all('%' + d);
    return m.length === 1 ? m[0] : null;
  }
  const hook = fn => (req, res) => {
    if (!token()) return res.status(503).type('text/plain').send('Phone capture is not set up (TWILIO_AUTH_TOKEN missing).');
    if (!valid(req)) return res.status(403).type('text/plain').send('Invalid signature.');
    try { fn(req, res); } catch (e) { console.error('twilio webhook:', e.message); res.status(500).type('text/plain').send('error'); }
  };
  // Call status callback: completed / no-answer / busy / failed / canceled.
  app.post('/api/webhooks/twilio/status', hook((req, res) => {
    const b = req.body || {}, sid = clean(b.CallSid, 64); if (!sid) return res.status(400).send('CallSid required');
    const inbound = String(b.Direction || 'inbound').startsWith('inbound'), other = inbound ? b.From : b.To;
    const st = String(b.CallStatus || ''), outcome = st === 'completed' ? 'Answered' : ['no-answer', 'busy', 'canceled', 'failed'].includes(st) ? 'Missed' : null;
    if (!outcome) return res.type('text/xml').send('<Response/>');
    const cu = matchCustomer(other), dur = Math.max(0, Math.trunc(Number(b.CallDuration) || 0));
    const cur = db.prepare('SELECT id FROM calls WHERE provider_sid=?').get(sid);
    if (cur) db.prepare("UPDATE calls SET outcome=CASE WHEN outcome IN ('Missed','Voicemail') THEN outcome ELSE ? END, duration_s=? WHERE id=?").run(outcome, dur, cur.id);
    else {
      const id = db.prepare(`INSERT INTO calls(direction,phone,contact_name,company,customer_id,outcome,purpose,summary,follow_up_date,created_by,created_at,duration_s,provider_sid,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'Twilio')`)
        .run(inbound ? 'Inbound' : 'Outbound', clean(other, 40), cu ? clean(cu.name, 150) : clean(b.CallerName, 150), cu ? clean(cu.company, 200) : '', cu ? cu.id : null, outcome, 'Other',
          outcome === 'Missed' ? 'Missed call — call back.' : '', outcome === 'Missed' && inbound ? today() : null, 'phone system', now(), dur, sid).lastInsertRowid;
      db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run('phone system', 'captured', 'call', id, `${outcome} ${inbound ? 'from' : 'to'} ${clean(other, 40)}${cu ? ' (' + (cu.company || cu.name) + ')' : ''}`, now());
    }
    res.type('text/xml').send('<Response/>');
  }));
  // Inbound call handling (the number's "A call comes in" webhook): ring the office phone (TWILIO_FORWARD_TO) for 20 s,
  // recording answered calls; if nobody answers (or no forward number is set) take a transcribed voicemail.
  const esc = x => String(x).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const greeting = () => esc(process.env.TWILIO_GREETING || 'Thanks for calling Bright Cleaning. We are with a customer right now. Please leave your name, number and how we can help, and we will call you back shortly.');
  const voicemail = () => `<Say voice="Polly.Joanna">${greeting()}</Say><Record maxLength="180" playBeep="true" transcribe="true" transcribeCallback="${base()}/api/webhooks/twilio/transcription" recordingStatusCallback="${base()}/api/webhooks/twilio/recording"/><Say voice="Polly.Joanna">We did not get a message. Goodbye.</Say>`;
  app.post('/api/webhooks/twilio/voice', hook((req, res) => {
    const fwd = String(process.env.TWILIO_FORWARD_TO || '').replace(/[^\d+]/g, '');
    const xml = /^\+?\d{10,15}$/.test(fwd)
      ? `<Dial timeout="20" record="record-from-answer" recordingStatusCallback="${base()}/api/webhooks/twilio/recording" action="${base()}/api/webhooks/twilio/dial-result">${esc(fwd)}</Dial>`
      : voicemail();
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`);
  }));
  // After the <Dial>: answered → done; otherwise record the outcome now and take a voicemail.
  app.post('/api/webhooks/twilio/dial-result', hook((req, res) => {
    const b = req.body || {}, st = String(b.DialCallStatus || '');
    if (st === 'completed' || st === 'answered') return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    const sid = clean(b.CallSid, 64), cu = matchCustomer(b.From);
    if (sid) {
      const cur = db.prepare('SELECT id FROM calls WHERE provider_sid=?').get(sid);
      if (cur) db.prepare("UPDATE calls SET outcome='Voicemail', follow_up_date=COALESCE(follow_up_date,?) WHERE id=?").run(today(), cur.id);
      else db.prepare(`INSERT INTO calls(direction,phone,contact_name,company,customer_id,outcome,purpose,summary,follow_up_date,created_by,created_at,provider_sid,source) VALUES('Inbound',?,?,?,?,'Voicemail','Other','Voicemail — call back.',?,'phone system',?,?,'Twilio')`)
        .run(clean(b.From, 40), cu ? clean(cu.name, 150) : clean(b.CallerName, 150), cu ? clean(cu.company, 200) : '', cu ? cu.id : null, today(), now(), sid);
    }
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${voicemail()}</Response>`);
  }));
  // Recording + transcription callbacks attach to the call by CallSid.
  app.post('/api/webhooks/twilio/recording', hook((req, res) => {
    const b = req.body || {}, c = db.prepare('SELECT id FROM calls WHERE provider_sid=?').get(clean(b.CallSid, 64)); if (!c) return res.status(404).send('unknown call');
    const url = String(b.RecordingUrl || ''); if (!/^https:\/\/api\.twilio\.com\//.test(url)) return res.status(400).send('bad recording url');
    db.prepare('UPDATE calls SET recording_url=? WHERE id=?').run(url.slice(0, 400), c.id); res.type('text/xml').send('<Response/>');
  }));
  app.post('/api/webhooks/twilio/transcription', hook((req, res) => {
    const b = req.body || {}, c = db.prepare('SELECT id FROM calls WHERE provider_sid=?').get(clean(b.CallSid, 64)); if (!c) return res.status(404).send('unknown call');
    db.prepare('UPDATE calls SET transcript=? WHERE id=?').run(String(b.TranscriptionText || '').slice(0, 60000), c.id); res.type('text/xml').send('<Response/>');
  }));
  app.get('/api/admin/calls/:id/detail', auth, (req, res) => {
    const c = db.prepare('SELECT c.*, cu.company customer_company, cu.name customer_name FROM calls c LEFT JOIN customers cu ON cu.id=c.customer_id WHERE c.id=?').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Call not found.' });
    let ai = null; try { ai = JSON.parse(c.ai || 'null'); } catch { /* */ }
    res.json({ call: { ...c, ai }, history: db.prepare("SELECT * FROM audit_log WHERE entity='call' AND entity_id=? ORDER BY id DESC LIMIT 50").all(c.id) });
  });
  app.patch('/api/admin/calls/:id/transcript', auth, (req, res) => {
    const c = db.prepare('SELECT id FROM calls WHERE id=?').get(Number(req.params.id)); if (!c) return res.status(404).json({ error: 'Call not found.' });
    db.prepare('UPDATE calls SET transcript=? WHERE id=?').run(String((req.body || {}).transcript || '').slice(0, 60000), c.id);
    logAction(req, 'updated transcript', 'call', c.id, ''); res.json({ ok: true });
  });
  app.get('/api/admin/calls-intel', auth, (req, res) => {
    const from = new Date(Date.now() - 30 * 864e5).toISOString(), q = sql => db.prepare(sql).all(from);
    res.json({ connected: !!token(), forwarding: !!String(process.env.TWILIO_FORWARD_TO || '').replace(/\D/g, ''), webhook: base() + '/api/webhooks/twilio/status', voice_url: base() + '/api/webhooks/twilio/voice',
      by_intent: q("SELECT intent k, COUNT(*) n FROM calls WHERE created_at>=? AND intent IS NOT NULL GROUP BY intent ORDER BY n DESC"),
      by_sentiment: q("SELECT sentiment k, COUNT(*) n FROM calls WHERE created_at>=? AND sentiment IS NOT NULL GROUP BY sentiment"),
      missed_30: db.prepare("SELECT COUNT(*) n FROM calls WHERE created_at>=? AND outcome IN ('Missed','Voicemail')").get(from).n,
      total_30: db.prepare("SELECT COUNT(*) n FROM calls WHERE created_at>=?").get(from).n,
      hot_leads: db.prepare("SELECT id, contact_name, company, lead_score, intent, created_at FROM calls WHERE lead_score>=70 AND created_at>=? ORDER BY lead_score DESC LIMIT 10").all(from) });
  });
};
