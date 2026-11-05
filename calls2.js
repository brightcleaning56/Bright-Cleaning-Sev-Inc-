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
  // Phone settings (not secrets): account SID and the Twilio number. Env vars win; otherwise the owner sets them, or they are
  // learned from Twilio's own signed webhooks.
  db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  const getS = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : ''; };
  const setS = (k, v) => db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(k, v, now());
  const acctSid = () => process.env.TWILIO_ACCOUNT_SID || getS('twilio_account_sid');
  const twNumber = () => process.env.TWILIO_NUMBER || getS('twilio_number');
  // Live call transcription (Twilio Real-Time Transcription). Final utterances are stored per call SID and merged into
  // calls.transcript, labelled by speaker. Off with TWILIO_TRANSCRIBE=off.
  db.exec('CREATE TABLE IF NOT EXISTS call_transcript_parts(id INTEGER PRIMARY KEY AUTOINCREMENT, call_sid TEXT NOT NULL, seq INTEGER, track TEXT, text TEXT, at TEXT, UNIQUE(call_sid, seq))');
  const transcribeOn = () => String(process.env.TWILIO_TRANSCRIBE || 'on').toLowerCase() !== 'off';
  const liveTranscribe = () => transcribeOn() ? `<Start><Transcription statusCallbackUrl="${base()}/api/webhooks/twilio/live-transcript" track="both_tracks" languageCode="en-US" partialResults="false"/></Start>` : '';
  function mergeTranscript(sid) {
    const c = db.prepare('SELECT id, direction, transcript FROM calls WHERE provider_sid=?').get(sid); if (!c) return;
    const parts = db.prepare('SELECT track, text FROM call_transcript_parts WHERE call_sid=? ORDER BY seq, id').all(sid); if (!parts.length) return;
    // inbound_track = audio coming into this call leg. Inbound calls: that is the customer. Outbound legs (our phone/browser): that is us.
    const who = t => (t === 'inbound_track') === (c.direction === 'Inbound') ? 'Customer' : 'Bright Clean';
    const lines = []; for (const p of parts) { const w = who(p.track); if (lines.length && lines[lines.length - 1].w === w) lines[lines.length - 1].t += ' ' + p.text; else lines.push({ w, t: p.text }); }
    const live = lines.map(l => `${l.w}: ${l.t}`).join('\n');
    const prev = String(c.transcript || ''), cut = prev.indexOf('[Live transcript]');
    const manual = (cut >= 0 ? prev.slice(0, cut) : prev).trim();
    db.prepare('UPDATE calls SET transcript=? WHERE id=?').run(((manual ? manual + '\n\n' : '') + '[Live transcript]\n' + live).slice(0, 60000), c.id);
  }
  const softphone = () => !!(process.env.TWILIO_API_KEY && process.env.TWILIO_API_SECRET && acctSid() && twNumber());
  // Phones to ring: admin setting overrides env. Lenient: pulls every valid US number out of the text ("+1 469-267-8472, 515.329.5889").
  const parsePhones = txt => { const out = []; for (const m of String(txt || '').match(/\+?1?[\s.\-()]*\d{3}[\s.\-()]*\d{3}[\s.\-]*\d{4}/g) || []) { const e = e164(m); if (e && !out.includes(e)) out.push(e); } return out.slice(0, 5); };
  const ringPhones = () => parsePhones(getS('twilio_ring_phones') || process.env.TWILIO_FORWARD_TO);
  const e164 = p => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : ''; };
  const hook = fn => (req, res) => {
    if (!token()) return res.status(503).type('text/plain').send('Phone capture is not set up (TWILIO_AUTH_TOKEN missing).');
    if (!valid(req)) return res.status(403).type('text/plain').send('Invalid signature.');
    { const b = req.body || {}; try { if (/^AC[0-9a-f]{32}$/.test(String(b.AccountSid || '')) && !getS('twilio_account_sid')) setS('twilio_account_sid', b.AccountSid); if (String(b.Direction || '') === 'inbound' && e164(b.To) && !getS('twilio_number')) setS('twilio_number', e164(b.To)); } catch { /* */ } }
    try { fn(req, res); } catch (e) { console.error('twilio webhook:', e.message); res.status(500).type('text/plain').send('error'); }
  };
  // Call status callback: completed / no-answer / busy / failed / canceled.
  app.post('/api/webhooks/twilio/status', hook((req, res) => {
    const b = req.body || {}, sid = clean(b.CallSid, 64); if (!sid) return res.status(400).send('CallSid required');
    const inbound = String(b.Direction || 'inbound').startsWith('inbound'), other = inbound ? b.From : b.To;
    const st = String(b.CallStatus || ''), outcome = st === 'completed' ? 'Answered' : ['no-answer', 'busy', 'canceled', 'failed'].includes(st) ? 'Missed' : null;
    if (!outcome) return res.type('text/xml').send('<Response/>');
    res.on('finish', () => { try { mergeTranscript(clean(b.CallSid, 64)); } catch { /* */ } });
    const cu = matchCustomer(other), dur = Math.max(0, Math.trunc(Number(b.CallDuration) || 0));
    const cur = db.prepare('SELECT id FROM calls WHERE provider_sid=?').get(sid);
    if (cur) db.prepare("UPDATE calls SET outcome=CASE WHEN outcome IN ('Missed','Voicemail','No answer','Busy') THEN outcome WHEN outcome IN ('Answered') AND source IN ('Click-to-call','Browser') THEN outcome WHEN source IN ('Click-to-call','Browser') AND ?='Missed' THEN 'Missed' WHEN source IN ('Click-to-call','Browser') THEN outcome ELSE ? END, duration_s=CASE WHEN source IN ('Click-to-call','Browser') AND duration_s IS NOT NULL THEN duration_s ELSE ? END WHERE id=?").run(outcome, outcome, dur, cur.id);
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
    const caller = e164((req.body || {}).From);
    const cli = softphone() ? '<Client>office</Client>' : '';
    const num = ringPhones().filter(p => p !== caller).map(p => `<Number>${esc(p)}</Number>`).join('');
    const xml = (cli || num)
      ? `${liveTranscribe()}<Dial timeout="20" record="record-from-answer" recordingStatusCallback="${base()}/api/webhooks/twilio/recording" action="${base()}/api/webhooks/twilio/dial-result">${cli}${num}</Dial>`
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
    res.json({ connected: !!token(), forwarding: ringPhones().length > 0, webhook: base() + '/api/webhooks/twilio/status', voice_url: base() + '/api/webhooks/twilio/voice',
      by_intent: q("SELECT intent k, COUNT(*) n FROM calls WHERE created_at>=? AND intent IS NOT NULL GROUP BY intent ORDER BY n DESC"),
      by_sentiment: q("SELECT sentiment k, COUNT(*) n FROM calls WHERE created_at>=? AND sentiment IS NOT NULL GROUP BY sentiment"),
      missed_30: db.prepare("SELECT COUNT(*) n FROM calls WHERE created_at>=? AND outcome IN ('Missed','Voicemail')").get(from).n,
      total_30: db.prepare("SELECT COUNT(*) n FROM calls WHERE created_at>=?").get(from).n,
      hot_leads: db.prepare("SELECT id, contact_name, company, lead_score, intent, created_at FROM calls WHERE lead_score>=70 AND created_at>=? ORDER BY lead_score DESC LIMIT 10").all(from) });
  });
  // ---- Click-to-call: ring the staff member's phone first, then bridge to the customer from the Twilio number ----
  const roleOf = req => { const e = String((req.user && req.user.email) || '').toLowerCase(), ow = String(process.env.ADMIN_EMAIL || '').toLowerCase(); if (!ow || e === ow) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  app.get('/api/admin/phone/settings', auth, (req, res) => res.json({ connected: !!token(), account_sid: acctSid() ? acctSid().slice(0, 6) + '…' + acctSid().slice(-4) : '', number: twNumber(), ring_phone: ringPhones()[0] || '', ring_phones: ringPhones(), ring_source: getS('twilio_ring_phones') ? 'admin' : 'render', render_forward_digits: String(process.env.TWILIO_FORWARD_TO || '').replace(/\D/g, '').length, render_forward_parsed: parsePhones(process.env.TWILIO_FORWARD_TO).map(p => '…' + p.slice(-4)), can_dial: !!(token() && acctSid() && twNumber()), softphone: softphone() }));
  app.put('/api/admin/phone/settings', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only an owner or manager can change phone settings.' });
    const b = req.body || {};
    if (b.account_sid !== undefined) { if (!/^AC[0-9a-f]{32}$/.test(String(b.account_sid))) return res.status(400).json({ error: 'Account SID starts with AC followed by 32 characters (Twilio console home page).' }); setS('twilio_account_sid', b.account_sid); }
    if (b.ring_phones !== undefined) { const ph = parsePhones(b.ring_phones); if (!ph.length && String(b.ring_phones).trim()) return res.status(400).json({ error: 'Enter at least one 10-digit US phone number (separate several with commas).' }); setS('twilio_ring_phones', ph.join(', ')); }
    if (b.number !== undefined) { if (!e164(b.number)) return res.status(400).json({ error: 'Enter the Twilio number as a 10-digit US number.' }); setS('twilio_number', e164(b.number)); }
    logAction(req, 'changed', 'phone settings', 0, `number ${twNumber()}`);
    res.json({ ok: true, number: twNumber(), can_dial: !!(token() && acctSid() && twNumber()) });
  });
  app.post('/api/admin/calls/dial', auth, async (req, res) => {
    const b = req.body || {}, to = e164(b.to), agent = (process.env.NODE_ENV !== 'production' && e164(b.agent)) || ringPhones()[0]; // production always rings the configured phone (no caller-chosen numbers)
    if (!token() || !acctSid() || !twNumber()) return res.status(503).json({ error: 'Calling is not set up yet (needs the Twilio token, account SID and number).' });
    if (!to) return res.status(400).json({ error: 'Enter a valid 10-digit US phone number to call.' });
    if (!agent) return res.status(400).json({ error: 'No phone to ring for you. Set the ring phone in Settings → Phone.' });
    if (to === agent) return res.status(400).json({ error: 'That is the same phone that would ring for you.' });
    const cu = b.customer_id ? db.prepare('SELECT id, name, company FROM customers WHERE id=?').get(Number(b.customer_id)) : matchCustomer(to);
    const who = (req.user && req.user.email) || 'staff';
    const id = db.prepare(`INSERT INTO calls(direction,phone,contact_name,company,customer_id,lead_id,outcome,purpose,summary,created_by,created_at,source) VALUES('Outbound',?,?,?,?,?,'Dialing','Other',?,?,?,'Click-to-call')`)
      .run(to, cu ? clean(cu.name, 150) : clean(b.name, 150), cu ? clean(cu.company, 200) : '', cu ? cu.id : null, b.lead_id ? Number(b.lead_id) : null, clean(b.note, 500) || '', who, now()).lastInsertRowid;
    try {
      const api = (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
      const r = await fetch(`${api}/2010-04-01/Accounts/${acctSid()}/Calls.json`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(acctSid() + ':' + token()).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: agent, From: twNumber(), Url: `${base()}/api/webhooks/twilio/bridge?call=${id}`, StatusCallback: `${base()}/api/webhooks/twilio/status`, Timeout: '25' }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.sid) throw new Error(j.message || ('Twilio error ' + r.status));
      db.prepare('UPDATE calls SET provider_sid=? WHERE id=?').run(j.sid, id);
      logAction(req, 'started call', 'call', id, `to ${to}${cu ? ' (' + (cu.company || cu.name) + ')' : ''}, ringing ${agent.slice(0, -4).replace(/\d/g, '•') + agent.slice(-4)}`);
      res.status(201).json({ ok: true, call_id: id, ringing: agent.slice(-4), message: `Your phone ending ${agent.slice(-4)} is ringing. Answer it to be connected.` });
    } catch (e) {
      db.prepare("UPDATE calls SET outcome='Failed', summary=? WHERE id=?").run('Could not start call: ' + String(e.message).slice(0, 200), id);
      logAction(req, 'call FAILED', 'call', id, String(e.message).slice(0, 200));
      res.status(502).json({ error: 'The call could not be started: ' + e.message });
    }
  });
  // Twilio fetches this when the staff member answers: announce, then dial the customer from the business number (recorded).
  app.post('/api/webhooks/twilio/bridge', hook((req, res) => {
    const c = db.prepare('SELECT * FROM calls WHERE id=?').get(Number(req.query.call));
    if (!c || c.direction !== 'Outbound' || !e164(c.phone)) return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Sorry, this call could not be connected.</Say><Hangup/></Response>');
    db.prepare("UPDATE calls SET outcome=CASE WHEN outcome='Dialing' THEN 'Connecting' ELSE outcome END WHERE id=?").run(c.id);
    const name = c.company || c.contact_name;
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Connecting your call${name ? ' to ' + esc(name) : ''}.</Say>${liveTranscribe()}<Dial callerId="${esc(twNumber())}" timeout="30" record="record-from-answer" recordingStatusCallback="${base()}/api/webhooks/twilio/recording" action="${base()}/api/webhooks/twilio/bridge-result?call=${c.id}">${esc(e164(c.phone))}</Dial></Response>`);
  }));
  // Customer leg outcome: answered → Answered; otherwise No answer / Busy with a follow-up for today.
  app.post('/api/webhooks/twilio/bridge-result', hook((req, res) => {
    const c = db.prepare('SELECT id FROM calls WHERE id=?').get(Number(req.query.call)), st = String((req.body || {}).DialCallStatus || '');
    if (c) {
      if (st === 'completed' || st === 'answered') db.prepare("UPDATE calls SET outcome='Answered', duration_s=? WHERE id=?").run(Math.max(0, Math.trunc(Number((req.body || {}).DialCallDuration) || 0)), c.id);
      else db.prepare("UPDATE calls SET outcome=?, follow_up_date=COALESCE(follow_up_date,?), summary=CASE WHEN summary='' OR summary IS NULL THEN ? ELSE summary END WHERE id=?").run(st === 'busy' ? 'Busy' : 'No answer', today(), 'Customer did not answer — try again.', c.id);
    }
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  }));
  // ---- In-browser phone (Twilio Voice SDK). Needs TWILIO_API_KEY + TWILIO_API_SECRET (a Standard API key). ----
  async function appSid() {
    let a = process.env.TWILIO_TWIML_APP_SID || getS('twilio_twiml_app_sid'); if (a) return a;
    const api = (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
    const r = await fetch(`${api}/2010-04-01/Accounts/${acctSid()}/Applications.json`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(process.env.TWILIO_API_KEY + ':' + process.env.TWILIO_API_SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ FriendlyName: 'Bright Clean admin phone', VoiceUrl: `${base()}/api/webhooks/twilio/client-voice`, VoiceMethod: 'POST' }) });
    const j = await r.json().catch(() => ({})); if (!r.ok || !j.sid) throw new Error(j.message || ('Twilio error ' + r.status));
    setS('twilio_twiml_app_sid', j.sid); return j.sid;
  }
  app.get('/api/admin/voice/token', auth, async (req, res) => {
    if (!token()) return res.status(503).json({ error: 'Phone is not connected.' });
    if (!softphone()) return res.status(503).json({ error: 'The browser phone needs a Twilio API key (TWILIO_API_KEY and TWILIO_API_SECRET in Render).', missing: true });
    try {
      const app_sid = await appSid(), t = Math.floor(Date.now() / 1000);
      const jwt = require('jsonwebtoken').sign({ jti: `${process.env.TWILIO_API_KEY}-${t}`, iss: process.env.TWILIO_API_KEY, sub: acctSid(), nbf: t - 5, exp: t + 3600,
        grants: { identity: 'office', voice: { incoming: { allow: true }, outgoing: { application_sid: app_sid } } } }, process.env.TWILIO_API_SECRET, { algorithm: 'HS256', header: { typ: 'JWT', cty: 'twilio-fpa;v=1' } });
      res.json({ token: jwt, identity: 'office', ttl: 3600, number: twNumber() });
    } catch (e) { res.status(502).json({ error: 'Could not prepare the browser phone: ' + e.message }); }
  });
  // Before a browser call: create the call record (so it is logged against the customer) and hand back its id.
  app.post('/api/admin/calls/browser-start', auth, (req, res) => {
    const b = req.body || {}, to = e164(b.to); if (!to) return res.status(400).json({ error: 'Enter a valid 10-digit US phone number to call.' });
    if (twNumber() && to === e164(twNumber())) return res.status(400).json({ error: 'That is the business number itself.' });
    const cu = b.customer_id ? db.prepare('SELECT id, name, company FROM customers WHERE id=?').get(Number(b.customer_id)) : matchCustomer(to);
    const id = db.prepare(`INSERT INTO calls(direction,phone,contact_name,company,customer_id,lead_id,outcome,purpose,summary,created_by,created_at,source) VALUES('Outbound',?,?,?,?,?,'Dialing','Other','',?,?,'Browser')`)
      .run(to, cu ? clean(cu.name, 150) : clean(b.name, 150), cu ? clean(cu.company, 200) : '', cu ? cu.id : null, b.lead_id ? Number(b.lead_id) : null, (req.user && req.user.email) || 'staff', now()).lastInsertRowid;
    logAction(req, 'started browser call', 'call', id, `to ${to}${cu ? ' (' + (cu.company || cu.name) + ')' : ''}`);
    res.status(201).json({ call_id: id, to });
  });
  // Twilio calls this (signed) when the browser places a call: dial the customer from the business number, recorded.
  app.post('/api/webhooks/twilio/client-voice', hook((req, res) => {
    const b = req.body || {}, c = b.call_id ? db.prepare('SELECT * FROM calls WHERE id=?').get(Number(b.call_id)) : null;
    const to = e164(c ? c.phone : b.To);
    if (!to || !String(b.From || '').startsWith('client:')) return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">This call could not be placed.</Say></Response>');
    if (c && b.CallSid) db.prepare('UPDATE calls SET provider_sid=COALESCE(provider_sid,?) WHERE id=?').run(clean(b.CallSid, 64), c.id);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${liveTranscribe()}<Dial callerId="${esc(twNumber())}" timeout="30" record="record-from-answer" recordingStatusCallback="${base()}/api/webhooks/twilio/recording"${c ? ` action="${base()}/api/webhooks/twilio/bridge-result?call=${c.id}"` : ''}>${esc(to)}</Dial></Response>`);
  }));
  app.post('/api/webhooks/twilio/live-transcript', hook((req, res) => {
    const b = req.body || {}, sid = clean(b.CallSid, 64);
    if (sid && b.TranscriptionEvent === 'transcription-content' && String(b.Final || 'true') !== 'false') {
      let d = {}; try { d = JSON.parse(b.TranscriptionData || '{}'); } catch { /* */ }
      const text = String(d.transcript || '').replace(/\s+/g, ' ').trim();
      if (text) { db.prepare('INSERT OR IGNORE INTO call_transcript_parts(call_sid, seq, track, text, at) VALUES(?,?,?,?,?)').run(sid, Math.trunc(Number(b.SequenceId) || Date.now()), clean(b.Track, 30), text.slice(0, 2000), now()); mergeTranscript(sid); }
    }
    if (sid && b.TranscriptionEvent === 'transcription-stopped') mergeTranscript(sid);
    res.type('text/xml').send('<Response/>');
  }));
};
