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
  db.exec('CREATE TABLE IF NOT EXISTS call_recordings_pending(call_sid TEXT PRIMARY KEY, url TEXT NOT NULL, at TEXT)');
  function attachPendingRecording(sid) { const p = db.prepare('SELECT url FROM call_recordings_pending WHERE call_sid=?').get(sid); if (!p) return; const c = db.prepare('SELECT id FROM calls WHERE provider_sid=?').get(sid); if (!c) return; db.prepare('UPDATE calls SET recording_url=COALESCE(recording_url,?) WHERE id=?').run(p.url, c.id); db.prepare('DELETE FROM call_recordings_pending WHERE call_sid=?').run(sid); }
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
  // Phones to ring: admin setting overrides env. Lenient: pulls every valid US number out of the text ("+1 469-267-8472, 515.303.3024").
  const parsePhones = txt => { const out = []; for (const m of String(txt || '').match(/\+?1?[\s.\-()]*\d{3}[\s.\-()]*\d{3}[\s.\-]*\d{4}/g) || []) { const e = e164(m); if (e && !out.includes(e)) out.push(e); } return out.slice(0, 5); };
  const ringPhones = () => parsePhones(getS('twilio_ring_phones') || process.env.TWILIO_FORWARD_TO);
  const e164 = p => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : ''; };
  const hook = fn => (req, res) => {
    if (!token()) return res.status(503).type('text/plain').send('Phone capture is not set up (TWILIO_AUTH_TOKEN missing).');
    if (!valid(req)) return res.status(403).type('text/plain').send('Invalid signature.');
    { const b = req.body || {}; try { if (/^AC[0-9a-f]{32}$/.test(String(b.AccountSid || '')) && !getS('twilio_account_sid')) setS('twilio_account_sid', b.AccountSid); if (String(b.Direction || '') === 'inbound' && e164(b.To) && !getS('twilio_number')) setS('twilio_number', e164(b.To)); } catch { /* */ } }
    const fail = e => { console.error('twilio webhook:', e && e.message); if (res.headersSent) return; if (/ai-turn/.test(req.path)) return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, one moment.</Say><Redirect method="POST">' + base() + '/api/webhooks/twilio/dial-result?ai=done</Redirect></Response>'); res.status(500).type('text/plain').send('error'); };
    try { Promise.resolve(fn(req, res)).catch(fail); } catch (e) { fail(e); }
  };
  // Call status callback: completed / no-answer / busy / failed / canceled.
  app.post('/api/webhooks/twilio/status', hook((req, res) => {
    const b = req.body || {}, sid = clean(b.CallSid, 64); if (!sid) return res.status(400).send('CallSid required');
    const inbound = String(b.Direction || 'inbound').startsWith('inbound'), other = inbound ? b.From : b.To;
    const st = String(b.CallStatus || ''), outcome = st === 'completed' ? 'Answered' : ['no-answer', 'busy', 'canceled', 'failed'].includes(st) ? 'Missed' : null;
    if (!outcome) return res.type('text/xml').send('<Response/>');
    res.on('finish', () => { try { mergeTranscript(clean(b.CallSid, 64)); attachPendingRecording(clean(b.CallSid, 64)); if (ctx.finalizeAi) ctx.finalizeAi(clean(b.CallSid, 64)); } catch { /* */ } });
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
  // Recording notice (readiness 5.10): callers hear it before they are connected or leave a message. Wording is set by TWILIO_RECORDING_NOTICE.
  const recordingNotice = () => esc(process.env.TWILIO_RECORDING_NOTICE || 'Calls and messages may be recorded for quality and training.');
  const voicemail = () => `<Say voice="Polly.Joanna">${greeting()} ${recordingNotice()}</Say><Record maxLength="180" playBeep="true" transcribe="true" transcribeCallback="${base()}/api/webhooks/twilio/transcription" recordingStatusCallback="${base()}/api/webhooks/twilio/recording"/><Say voice="Polly.Joanna">We did not get a message. Goodbye.</Say>`;
  // ---- Callback ownership: every promised callback / voicemail becomes ONE assigned Follow-up task (owner, due today, High). ----
  try { if (!db.prepare('PRAGMA table_info(calls)').all().some(c => c.name === 'callback_issue_id')) db.exec('ALTER TABLE calls ADD COLUMN callback_issue_id INTEGER'); } catch { /* */ }
  const callbackOwner = () => (getS('callback_owner') || ctx.adminEmail || '').toLowerCase();
  function createCallbackTask(callId, reason) {
    try {
      const c = db.prepare('SELECT * FROM calls WHERE id=?').get(callId); if (!c || c.callback_issue_id) return c && c.callback_issue_id;
      const t = now(), who = c.company || c.contact_name || c.phone || 'caller', owner = callbackOwner();
      const id = db.prepare(`INSERT INTO customer_issues(customer_id,type,title,description,priority,status,assigned_to,due_date,customer_comms,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'Open',?,?,'Not needed',?,?,?)`)
        .run(c.customer_id || null, 'follow_up', `Call back ${who}`.slice(0, 200), `${String(reason || 'Call back').slice(0, 1500)}\n\nPhone: ${c.phone || 'unknown'} · Call #${c.id}${c.provider_sid ? ' (' + c.provider_sid + ')' : ''}`, 'High', owner || null, today(), 'phone system', t, t).lastInsertRowid;
      db.prepare('UPDATE calls SET callback_issue_id=?, follow_up_date=COALESCE(follow_up_date,?) WHERE id=?').run(id, today(), c.id);
      db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run('phone system', 'created callback task', 'issue', id, `for call #${c.id}, assigned to ${owner || 'nobody'}`, t);
      const m = ctx.getMailer && ctx.getMailer(); if (m && owner) m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || ctx.adminEmail, to: owner, subject: `Callback needed today: ${who}`, text: `${reason}\n\nPhone: ${c.phone || 'unknown'}\nOpen Issues in the admin (FUP-${1000 + id}) and mark it resolved once you have called back.` }).catch(() => {});
      return id;
    } catch (e) { console.error('callback task:', e.message); return null; }
  }
  ctx.createCallbackTask = createCallbackTask;
  // Record a call as Voicemail (with why it went there) — the call row may not exist yet.
  function recordVoicemail(b, why) {
    const sid = clean(b.CallSid, 64); if (!sid) return; const cu = matchCustomer(b.From), note = `Voicemail — call back. (Why: ${why}.)`;
    const cur = db.prepare('SELECT id FROM calls WHERE provider_sid=?').get(sid);
    if (cur) db.prepare("UPDATE calls SET outcome='Voicemail', handling='Voicemail', summary=CASE WHEN summary IS NULL OR summary='' THEN ? ELSE summary END, follow_up_date=COALESCE(follow_up_date,?) WHERE id=?").run(note, today(), cur.id);
    else db.prepare(`INSERT INTO calls(direction,phone,contact_name,company,customer_id,outcome,purpose,summary,follow_up_date,created_by,created_at,provider_sid,source,handling) VALUES('Inbound',?,?,?,?,'Voicemail','Other',?,?,'phone system',?,?,'Twilio','Voicemail')`)
      .run(clean(b.From, 40), cu ? clean(cu.name, 150) : clean(b.CallerName, 150), cu ? clean(cu.company, 200) : '', cu ? cu.id : null, note, today(), now(), sid);
    const row = db.prepare('SELECT id FROM calls WHERE provider_sid=?').get(sid); if (row) createCallbackTask(row.id, `Return a voicemail (${why}). Listen to it on the call in the Calls page.`);
  }
  app.post('/api/webhooks/twilio/voice', hook((req, res) => {
    const caller = e164((req.body || {}).From);
    if (aiAnswersNow()) return res.type('text/xml').send(aiStart(req.body || {}, 'answered by AI'));
    const cli = softphone() ? '<Client>office</Client>' : '';
    const num = ringPhones().filter(p => p !== caller).map(p => `<Number>${esc(p)}</Number>`).join('');
    if (!cli && !num) { const ai = ctx.aiTakeover && ctx.aiTakeover(req.body || {}); if (ai) return res.type('text/xml').send(ai); recordVoicemail(req.body || {}, 'no phone is set to ring'); return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${voicemail()}</Response>`); }
    const xml = `<Say voice="Polly.Joanna">${recordingNotice()}</Say>${liveTranscribe()}<Dial timeout="20" record="record-from-answer" recordingStatusCallback="${base()}/api/webhooks/twilio/recording" action="${base()}/api/webhooks/twilio/dial-result">${cli}${num}</Dial>`;
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`);
  }));
  // After the <Dial>: answered → done; otherwise record the outcome now and take a voicemail.
  app.post('/api/webhooks/twilio/dial-result', hook((req, res) => {
    const b = req.body || {}, st = String(b.DialCallStatus || '');
    if (st === 'completed' || st === 'answered') return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    if (!req.query.ai && ctx.aiTakeover) { const x = ctx.aiTakeover(b); if (x) return res.type('text/xml').send(x); }
    recordVoicemail(b, req.query.ai ? 'AI receptionist transferred the caller; no one answered' : 'no one answered' + (ctx.aiWhyNot ? ' — ' + ctx.aiWhyNot() : ''));
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${voicemail()}</Response>`);
  }));
  // Recording + transcription callbacks attach to the call by CallSid.
  app.post('/api/webhooks/twilio/recording', hook((req, res) => {
    const b = req.body || {}, sid = clean(b.CallSid, 64), c = db.prepare('SELECT id FROM calls WHERE provider_sid=?').get(sid);
    const url = String(b.RecordingUrl || ''), testBase = process.env.NODE_ENV !== 'production' && process.env.TWILIO_API_BASE ? process.env.TWILIO_API_BASE.replace(/\/$/, '') + '/' : null;
    if (!/^https:\/\/api\.twilio\.com\//.test(url) && !(testBase && url.startsWith(testBase))) return res.status(400).send('bad recording url');
    if (!c) { if (sid) db.prepare('INSERT OR REPLACE INTO call_recordings_pending(call_sid,url,at) VALUES(?,?,?)').run(sid, url.slice(0, 400), now()); return res.type('text/xml').send('<Response/>'); }
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
    res.json({ receptionist: ctx.aiStatus ? ctx.aiStatus() : null, connected: !!token(), forwarding: ringPhones().length > 0, webhook: base() + '/api/webhooks/twilio/status', voice_url: base() + '/api/webhooks/twilio/voice',
      by_intent: q("SELECT intent k, COUNT(*) n FROM calls WHERE created_at>=? AND intent IS NOT NULL GROUP BY intent ORDER BY n DESC"),
      by_sentiment: q("SELECT sentiment k, COUNT(*) n FROM calls WHERE created_at>=? AND sentiment IS NOT NULL GROUP BY sentiment"),
      missed_30: db.prepare("SELECT COUNT(*) n FROM calls WHERE created_at>=? AND outcome IN ('Missed','Voicemail')").get(from).n,
      total_30: db.prepare("SELECT COUNT(*) n FROM calls WHERE created_at>=?").get(from).n,
      hot_leads: db.prepare("SELECT id, contact_name, company, lead_score, intent, created_at FROM calls WHERE lead_score>=70 AND created_at>=? ORDER BY lead_score DESC LIMIT 10").all(from) });
  });
  // ---- Click-to-call: ring the staff member's phone first, then bridge to the customer from the Twilio number ----
  const roleOf = req => { const e = String((req.user && req.user.email) || '').toLowerCase(), ow = String(process.env.ADMIN_EMAIL || '').toLowerCase(); if (!ow || e === ow) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  app.get('/api/admin/phone/settings', auth, (req, res) => res.json({ connected: !!token(), account_sid: acctSid() ? acctSid().slice(0, 6) + '…' + acctSid().slice(-4) : '', number: twNumber(), callback_owner: callbackOwner(), ai_receptionist: { mode: getS('ai_receptionist_mode') || process.env.AI_RECEPTIONIST || 'off', ai_key: !!process.env.ANTHROPIC_API_KEY, hours: (() => { try { return JSON.parse(getS('ai_receptionist_hours') || ''); } catch { return { days: [1, 2, 3, 4, 5], open: '08:00', close: '17:00' }; } })() }, ring_phone: ringPhones()[0] || '', ring_phones: ringPhones(), ring_source: getS('twilio_ring_phones') ? 'admin' : 'render', render_forward_digits: String(process.env.TWILIO_FORWARD_TO || '').replace(/\D/g, '').length, render_forward_parsed: parsePhones(process.env.TWILIO_FORWARD_TO).map(p => '…' + p.slice(-4)), can_dial: !!(token() && acctSid() && twNumber()), softphone: softphone() }));
  app.put('/api/admin/phone/settings', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only an owner or manager can change phone settings.' });
    const b = req.body || {};
    if (b.account_sid !== undefined) { if (!/^AC[0-9a-f]{32}$/.test(String(b.account_sid))) return res.status(400).json({ error: 'Account SID starts with AC followed by 32 characters (Twilio console home page).' }); setS('twilio_account_sid', b.account_sid); }
    if (b.ai_mode !== undefined) { if (!['off', 'no_answer', 'after_hours', 'always'].includes(b.ai_mode)) return res.status(400).json({ error: 'Choose when the AI receptionist answers.' }); setS('ai_receptionist_mode', b.ai_mode); }
    if (b.ai_hours !== undefined) { const h = b.ai_hours || {}, ok = Array.isArray(h.days) && h.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6) && /^\d{2}:\d{2}$/.test(h.open) && /^\d{2}:\d{2}$/.test(h.close) && h.open < h.close; if (!ok) return res.status(400).json({ error: 'Business hours need days and an open time before the close time.' }); setS('ai_receptionist_hours', JSON.stringify({ days: h.days, open: h.open, close: h.close })); }
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
    if (b.lead_id && app.locals.touchLead) app.locals.touchLead(Number(b.lead_id));
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
    if (b.lead_id && app.locals.touchLead) app.locals.touchLead(Number(b.lead_id));
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
  // ---- Save a caller as a customer (or link to an existing one). Links every unlinked call from that number. ----
  app.post('/api/admin/calls/:id/customer', auth, (req, res) => {
    const c = db.prepare('SELECT * FROM calls WHERE id=?').get(Number(req.params.id)); if (!c) return res.status(404).json({ error: 'Call not found.' });
    const b = req.body || {}, digits = String(c.phone || '').replace(/\D/g, '').slice(-10), phone = e164(c.phone) || clean(c.phone, 40);
    let cu = null, created = false;
    if (b.customer_id) { cu = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(b.customer_id)); if (!cu) return res.status(404).json({ error: 'That customer was not found.' }); }
    else {
      const name = clean(b.name, 150), company = clean(b.company, 200), email = clean(b.email, 254).toLowerCase();
      if (!name && !company) return res.status(400).json({ error: 'Enter the caller’s name (and company if it’s a business).' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address, or leave it blank.' });
      if (digits.length === 10) cu = db.prepare("SELECT * FROM customers WHERE substr(replace(replace(replace(replace(replace(replace(phone,' ',''),'-',''),'(',''),')',''),'.',''),'+',''),-10)=? ORDER BY id LIMIT 1").get(digits);
      const key = email ? 'e:' + email : company ? 'c:' + company.toLowerCase() : digits ? 'p:' + digits : '';
      if (!cu && key) cu = db.prepare('SELECT * FROM customers WHERE match_key=?').get(key);
      if (!cu) {
        if (!key) return res.status(400).json({ error: 'This call has no phone number, so add an email or company.' });
        const t = now(), id = db.prepare('INSERT INTO customers(match_key,name,company,email,phone,source,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(key, name || null, company || null, email || null, phone || null, 'Phone call', clean(b.notes, 2000) || null, t, t).lastInsertRowid;
        cu = db.prepare('SELECT * FROM customers WHERE id=?').get(id); created = true;
        logAction(req, 'created', 'customer', id, `${company || name} from call #${c.id}`);
      } else if (!cu.phone && phone) db.prepare('UPDATE customers SET phone=?, updated_at=? WHERE id=?').run(phone, now(), cu.id);
    }
    const all = digits.length === 10 ? db.prepare('SELECT id, phone FROM calls WHERE customer_id IS NULL').all().filter(x => String(x.phone || '').replace(/\D/g, '').slice(-10) === digits).map(x => x.id) : [];
    const ids = [...new Set([c.id, ...all])];
    const up = db.prepare('UPDATE calls SET customer_id=?, contact_name=COALESCE(NULLIF(contact_name,\'\'),?), company=COALESCE(NULLIF(company,\'\'),?) WHERE id=?');
    for (const id of ids) up.run(cu.id, cu.name || null, cu.company || null, id);
    logAction(req, 'linked calls', 'customer', cu.id, `${ids.length} call(s) from ${phone}`);
    res.status(created ? 201 : 200).json({ customer: cu, created, linked_calls: ids.length });
  });
  // ---- Play a call recording / voicemail inside the admin: the server fetches it from Twilio with the account credentials. ----
  app.get('/api/admin/calls/:id/recording', auth, async (req, res) => {
    const c = db.prepare('SELECT id, recording_url FROM calls WHERE id=?').get(Number(req.params.id)); if (!c || !c.recording_url) return res.status(404).json({ error: 'No recording on this call.' });
    if (!token() || !acctSid()) return res.status(503).json({ error: 'Phone is not connected, so recordings cannot be played.' });
    let u; try { u = new URL(c.recording_url); } catch { return res.status(400).json({ error: 'Bad recording address.' }); }
    const testHost = process.env.NODE_ENV !== 'production' && process.env.TWILIO_API_BASE ? new URL(process.env.TWILIO_API_BASE).host : null;
    if (!(u.protocol === 'https:' && u.host === 'api.twilio.com') && u.host !== testHost) return res.status(400).json({ error: 'Recordings are only played from Twilio.' });
    try {
      const r = await fetch(c.recording_url.replace(/\.(mp3|wav)$/i, '') + '.mp3', { headers: { Authorization: 'Basic ' + Buffer.from(acctSid() + ':' + token()).toString('base64') } });
      if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ error: r.status === 404 ? 'Twilio no longer has this recording (it may have been deleted).' : 'Twilio did not return the recording (' + r.status + ').' });
      const buf = Buffer.from(await r.arrayBuffer());
      res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': `inline; filename="call-${c.id}.mp3"` }).send(buf);
    } catch (e) { res.status(502).json({ error: 'Could not reach Twilio: ' + e.message }); }
  });
  // =====================================================================================================
  // AI RECEPTIONIST — answers calls, talks with the caller (Twilio speech recognition + Claude + neural voice),
  // and acts only through the validated tools below. Falls back to ringing the office / voicemail on any failure.
  // =====================================================================================================
  const { adminEmail, getMailer } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_call_sessions(call_sid TEXT PRIMARY KEY, caller TEXT, customer_id INTEGER, reason TEXT, messages TEXT NOT NULL DEFAULT '[]',
    turns INTEGER DEFAULT 0, silences INTEGER DEFAULT 0, lead_id INTEGER, issue_id INTEGER, callback TEXT, transferred INTEGER DEFAULT 0, status TEXT DEFAULT 'active', error TEXT,
    summary TEXT, started_at TEXT, ended_at TEXT, finalized INTEGER DEFAULT 0)`);
  try { if (!db.prepare('PRAGMA table_info(calls)').all().some(c => c.name === 'handling')) db.exec('ALTER TABLE calls ADD COLUMN handling TEXT'); } catch { /* */ }
  try { if (!db.prepare('PRAGMA table_info(ai_call_sessions)').all().some(c => c.name === 'greeting')) db.exec('ALTER TABLE ai_call_sessions ADD COLUMN greeting TEXT'); } catch { /* */ }
  const aiKey = () => process.env.ANTHROPIC_API_KEY || '';
  const aiMode = () => { const m = getS('ai_receptionist_mode') || process.env.AI_RECEPTIONIST || 'off'; return ['off', 'no_answer', 'after_hours', 'always'].includes(m) ? m : 'off'; };
  const aiHours = () => { try { return JSON.parse(getS('ai_receptionist_hours') || '') } catch { return { days: [1, 2, 3, 4, 5], open: '08:00', close: '17:00' }; } };
  const isOpen = (d = new Date()) => { const h = aiHours(), tz = process.env.BUSINESS_TZ || 'America/Chicago'; const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), hm = `${String(parts.hour).replace('24', '00')}:${parts.minute}`; return h.days.includes(day) && hm >= h.open && hm < h.close; };
  const aiReady = () => !!(aiKey() && token());
  const aiAnswersNow = () => aiReady() && (aiMode() === 'always' || (aiMode() === 'after_hours' && !isOpen()));
  const VOICE = () => process.env.AI_RECEPTIONIST_VOICE || 'Polly.Joanna-Neural';
  const gather = (say, extra = '') => `<Gather input="speech" action="${base()}/api/webhooks/twilio/ai-turn" method="POST" speechTimeout="auto" speechModel="phone_call" language="en-US" actionOnEmptyResult="true"${extra}><Say voice="${VOICE()}">${esc(say)}</Say></Gather>`;
  function aiStart(b, reason) {
    const sid = clean(b.CallSid, 64), caller = e164(b.From) || clean(b.From, 40), cu = matchCustomer(caller);
    const hello = `Thanks for calling Bright Cleaning. This is Bright Clean's virtual assistant, and this call may be recorded and transcribed. ${cu ? 'It looks like you are calling from a number we have on file. ' : ''}How can I help you today?`;
    db.prepare('INSERT OR IGNORE INTO ai_call_sessions(call_sid, caller, customer_id, reason, started_at, greeting) VALUES(?,?,?,?,?,?)').run(sid, caller, cu ? cu.id : null, reason, now(), hello);
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${gather(hello)}<Redirect method="POST">${base()}/api/webhooks/twilio/ai-turn</Redirect></Response>`;
  }
  // When nobody answers and the mode is "no_answer" (or after hours), the AI takes the call instead of voicemail.
  ctx.aiTakeover = (b) => aiReady() && (aiMode() === 'no_answer' || aiMode() === 'always' || (aiMode() === 'after_hours' && !isOpen())) ? aiStart(b, 'no one answered') : null;
  const TOOLS = [
    { name: 'save_caller_details', description: 'Save or update what the caller has told you, as a lead for the Bright Clean team. Call this as soon as you have the caller\'s name and what they need, and again whenever you learn more. Never invent values.',
      input_schema: { type: 'object', properties: { name: { type: 'string' }, company: { type: 'string' }, email: { type: 'string' }, callback_number: { type: 'string' }, service_category: { type: 'string', enum: ['residential', 'commercial', 'construction', 'specialty', 'other'] },
        service_needed: { type: 'string' }, location: { type: 'string' }, square_footage: { type: 'string' }, timing: { type: 'string' }, bid_due_date: { type: 'string', description: 'YYYY-MM-DD if given' }, drawings_available: { type: 'string' }, notes: { type: 'string' } }, required: ['service_needed'] } },
    { name: 'log_complaint', description: 'Record a complaint or service problem from an existing customer so a manager follows up. Only use for problems with work Bright Clean did.',
      input_schema: { type: 'object', properties: { summary: { type: 'string' }, urgent: { type: 'boolean' } }, required: ['summary'] } },
    { name: 'request_callback', description: 'Arrange for a person from Bright Clean to call the caller back (e.g. invoice/billing questions, pricing, scheduling, anything you cannot answer).',
      input_schema: { type: 'object', properties: { reason: { type: 'string' }, preferred_time: { type: 'string' } }, required: ['reason'] } },
    { name: 'transfer_to_human', description: 'Connect the caller to a person now. Use when the caller asks for a person, is upset, or has an emergency.', input_schema: { type: 'object', properties: { reason: { type: 'string' } } } },
    { name: 'end_call', description: 'Say goodbye and end the call once the caller has nothing else.', input_schema: { type: 'object', properties: {} } }];
  const SYSTEM = (sess, cu) => `You are the virtual phone receptionist for Bright Cleaning Sev Inc. ("Bright Clean"), a cleaning company serving residential, commercial/enterprise (janitorial, multifamily common areas, offices), post-construction final cleaning (rough, final, touch-up/punch-list, interior and exterior windows) and specialty services (floor care, power washing, parking lots, valet trash).
You are speaking on a live phone call: keep every reply to one or two short, natural sentences and ask one question at a time. No lists, no markdown.
Goals: understand what the caller needs, collect the details the team needs, save them with save_caller_details, and tell the caller someone from Bright Clean will follow up.
- Residential/commercial: ask the address or city, type of property, approximate size, how often or when, and a good callback number and email.
- Construction: ask the project name and location, approximate square footage, construction stage, when final cleaning is needed, any bid due date, whether drawings are available, and site access.
- Complaints from existing customers: get what happened and where, log it with log_complaint, apologize, and say a manager will follow up.
- Invoice, billing, account or pricing questions: do NOT discuss amounts or account details; use request_callback.
- If they ask for a person, are upset, or there is an emergency: use transfer_to_human.
Rules: never state or estimate prices, never promise dates, availability or crews, never approve or change contracts, never invent insurance, licenses or certifications. If unsure, say a team member will confirm. Do not read back personal or account information.
Caller ID: ${cu ? `matches existing customer "${(cu.company || cu.name || '').replace(/"/g, '')}" (do not confirm account details; you may say you see they have worked with us)` : 'not a known customer'}. Caller number: ${sess.caller || 'unknown'}.
Business hours: ${isOpen() ? 'open now' : 'currently closed'}.`;
  async function claudeTurn(messages, sys) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), Number(process.env.AI_RECEPTIONIST_TIMEOUT_MS || 9000));
    try {
      const r = await fetch((process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', { method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': aiKey(), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.AI_RECEPTIONIST_MODEL || 'claude-haiku-5-5', max_tokens: 400, system: sys, tools: TOOLS, messages }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('AI ' + r.status + ': ' + ((j.error && j.error.message) || 'error')); return j;
    } finally { clearTimeout(timer); }
  }
  const str = (v, n) => clean(typeof v === 'string' ? v : '', n);
  function runTool(sess, name, inp) {
    inp = inp && typeof inp === 'object' ? inp : {};
    if (name === 'save_caller_details') {
      const cat = ['residential', 'commercial', 'construction', 'specialty', 'other'].includes(inp.service_category) ? inp.service_category : 'other';
      const em = str(inp.email, 254).toLowerCase(), email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) ? em : null, due = /^\d{4}-\d{2}-\d{2}$/.test(String(inp.bid_due_date || '')) ? inp.bid_due_date : null;
      const phone = e164(inp.callback_number) || sess.caller || null;
      const details = [`Phone call with Bright Clean's AI receptionist.`, inp.service_needed && `Needs: ${str(inp.service_needed, 500)}`, inp.timing && `Timing: ${str(inp.timing, 200)}`, inp.drawings_available && `Drawings: ${str(inp.drawings_available, 200)}`, inp.notes && `Notes: ${str(inp.notes, 1500)}`].filter(Boolean).join('\n');
      const f = { contact_name: str(inp.name, 150) || null, company: str(inp.company, 200) || null, email, phone, service: str(inp.service_needed, 200) || null, project_type: cat, address: str(inp.location, 300) || null, square_footage: str(inp.square_footage, 40) || null, bid_due_date: due, details };
      if (sess.lead_id) { const keep = Object.entries(f).filter(([, v]) => v); db.prepare(`UPDATE leads SET ${keep.map(([k]) => k + '=?').join(',')} WHERE id=?`).run(...keep.map(([, v]) => v), sess.lead_id); return 'Saved (updated the lead).'; }
      { const d10 = String(phone || '').replace(/\D/g, '').slice(-10), cutoff = new Date(Date.now() - 60 * 864e5).toISOString();
        const open = d10.length === 10 ? db.prepare("SELECT id, phone, details FROM leads WHERE kind IN ('bid','inquiry') AND status NOT IN ('Won','Lost','Archived') AND created_at>=? ORDER BY id DESC").all(cutoff).find(l => String(l.phone || '').replace(/\D/g, '').slice(-10) === d10) : null;
        if (open) { const keep = Object.entries(f).filter(([k, v]) => v && k !== 'details'); if (keep.length) db.prepare(`UPDATE leads SET ${keep.map(([k]) => k + '=?').join(',')} WHERE id=?`).run(...keep.map(([, v]) => v), open.id);
          db.prepare('UPDATE leads SET details=? WHERE id=?').run(String(open.details || '') + `\n\nCalled again ${today()} (AI receptionist): ` + details.replace(/^Phone call with Bright Clean's AI receptionist\.\n?/, ''), open.id);
          db.prepare('UPDATE ai_call_sessions SET lead_id=? WHERE call_sid=?').run(open.id, sess.call_sid); sess.lead_id = open.id; return 'This caller already has an open request; it was updated (no duplicate).'; } }
      const id = db.prepare(`INSERT INTO leads(kind,contact_name,company,email,phone,service,project_type,address,square_footage,bid_due_date,details,status,created_at,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,'New',?,'inbound_call')`)
        .run(cat === 'construction' ? 'bid' : 'inquiry', f.contact_name, f.company, f.email, f.phone, f.service, f.project_type, f.address, f.square_footage, f.bid_due_date, f.details, now()).lastInsertRowid;
      db.prepare('UPDATE ai_call_sessions SET lead_id=? WHERE call_sid=?').run(id, sess.call_sid); sess.lead_id = id;
      db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run('AI receptionist', 'created', 'lead', id, `from call ${sess.call_sid}`, now());
      return 'Saved as a new lead.';
    }
    if (name === 'log_complaint') {
      if (!sess.customer_id) { runTool(sess, 'request_callback', { reason: 'Complaint: ' + str(inp.summary, 400) }); return 'Caller is not a known customer, so a callback was arranged instead.'; }
      if (sess.issue_id) return 'Already logged.';
      const t = now(), id = db.prepare(`INSERT INTO customer_issues(customer_id,type,title,description,priority,status,customer_comms,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'Open','Needs update','AI receptionist',?,?)`)
        .run(sess.customer_id, 'complaint', ('Phone complaint: ' + str(inp.summary, 150)).slice(0, 200), str(inp.summary, 2000) + `\n\nTaken by the AI receptionist from ${sess.caller}.`, inp.urgent ? 'Urgent' : 'High', t, t).lastInsertRowid;
      db.prepare('UPDATE ai_call_sessions SET issue_id=? WHERE call_sid=?').run(id, sess.call_sid); sess.issue_id = id;
      try { const mk = app.locals.createComplaintCase; if (mk) mk({ source_type: 'AI phone call', source_key: 'issue:' + id, issue_id: id, customer_id: sess.customer_id, description: str(inp.summary, 2000), severity: inp.urgent ? 'Urgent' : 'High', actor: 'AI receptionist' }); } catch (e) { console.error('complaint case:', e.message); }
      db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run('AI receptionist', 'created', 'complaint', id, `from call ${sess.call_sid}`, t);
      const m = getMailer && getMailer(), to = process.env.NOTIFY_EMAIL || adminEmail;
      if (m && to) m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || adminEmail, to, subject: `${inp.urgent ? 'URGENT ' : ''}Complaint by phone: ${str(inp.summary, 80)}`, text: `The AI receptionist logged a complaint from ${sess.caller}:\n\n${str(inp.summary, 2000)}\n\nOpen Issues in the admin to follow up.` }).catch(() => {});
      return 'Complaint logged as a quality case and the quality manager notified.';
    }
    if (name === 'request_callback') { const cb = [str(inp.reason, 300), inp.preferred_time && 'Preferred: ' + str(inp.preferred_time, 100)].filter(Boolean).join(' — '); sess.callback = sess.callback ? sess.callback + ' | ' + cb : cb; db.prepare('UPDATE ai_call_sessions SET callback=? WHERE call_sid=?').run(sess.callback, sess.call_sid); return 'Callback arranged for today.'; }
    return 'Unknown action.';
  }
  const sayHangup = t => `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${VOICE()}">${esc(t)}</Say><Hangup/></Response>`;
  const transferXml = sess => { db.prepare("UPDATE ai_call_sessions SET transferred=1 WHERE call_sid=?").run(sess.call_sid); const nums = ringPhones().filter(p => p !== sess.caller).map(p => `<Number>${esc(p)}</Number>`).join(''); const cli = softphone() ? '<Client>office</Client>' : '';
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${VOICE()}">One moment while I connect you.</Say>${cli || nums ? `<Dial timeout="20" record="record-from-answer" recordingStatusCallback="${base()}/api/webhooks/twilio/recording" action="${base()}/api/webhooks/twilio/dial-result?ai=done">${cli}${nums}</Dial>` : `<Say voice="${VOICE()}">No one is available right now. Please leave a message after the tone.</Say><Record maxLength="180" playBeep="true" transcribe="true" transcribeCallback="${base()}/api/webhooks/twilio/transcription" recordingStatusCallback="${base()}/api/webhooks/twilio/recording"/>`}</Response>`; };
  app.post('/api/webhooks/twilio/ai-turn', hook(async (req, res) => {
    const b = req.body || {}, sid = clean(b.CallSid, 64);
    let sess = db.prepare('SELECT * FROM ai_call_sessions WHERE call_sid=?').get(sid);
    if (!sess) { db.prepare('INSERT OR IGNORE INTO ai_call_sessions(call_sid, caller, reason, started_at) VALUES(?,?,?,?)').run(sid, e164(b.From) || clean(b.From, 40), 'resumed', now()); sess = db.prepare('SELECT * FROM ai_call_sessions WHERE call_sid=?').get(sid); }
    const msgs = JSON.parse(sess.messages || '[]'), heard = String(b.SpeechResult || '').trim().slice(0, 1000);
    if (!heard) {
      const s = (sess.silences || 0) + 1; db.prepare('UPDATE ai_call_sessions SET silences=? WHERE call_sid=?').run(s, sid);
      if (s >= 2) { runTool(sess, 'request_callback', { reason: 'Caller was silent / line dropped during AI call' }); return res.type('text/xml').send(sayHangup("I'm having trouble hearing you, so someone from Bright Clean will call you back shortly. Goodbye.")); }
      return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${gather("Sorry, I didn't catch that. How can I help you?")}<Redirect method="POST">${base()}/api/webhooks/twilio/ai-turn</Redirect></Response>`);
    }
    if ((sess.turns || 0) >= Number(process.env.AI_RECEPTIONIST_MAX_TURNS || 16)) { runTool(sess, 'request_callback', { reason: 'Long call — continue with a person' }); return res.type('text/xml').send(sayHangup('Thank you. I have everything noted, and someone from Bright Clean will call you back shortly. Goodbye.')); }
    msgs.push({ role: 'user', content: heard });
    const cu = sess.customer_id ? db.prepare('SELECT id, name, company FROM customers WHERE id=?').get(sess.customer_id) : null;
    let say = '', action = null;
    try {
      for (let round = 0; round < 3; round++) {
        const j = await claudeTurn(msgs, SYSTEM(sess, cu)), content = j.content || [];
        msgs.push({ role: 'assistant', content });
        say = content.filter(c => c.type === 'text').map(c => c.text).join(' ').trim();
        const uses = content.filter(c => c.type === 'tool_use'); if (!uses.length) break;
        const results = [];
        for (const u of uses) {
          if (u.name === 'transfer_to_human') { action = 'transfer'; results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Transferring now.' }); continue; }
          if (u.name === 'end_call') { action = 'end'; results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Ending call.' }); continue; }
          let out; try { out = runTool(sess, u.name, u.input); } catch (e) { out = 'Could not save: ' + e.message; }
          results.push({ type: 'tool_result', tool_use_id: u.id, content: out });
        }
        msgs.push({ role: 'user', content: results });
        if (action) break;
      }
    } catch (e) {
      db.prepare("UPDATE ai_call_sessions SET messages=?, error=?, status='fallback' WHERE call_sid=?").run(JSON.stringify(msgs).slice(0, 200000), String(e.message).slice(0, 300), sid);
      logAction({ user: { email: 'AI receptionist' } }, 'AI receptionist fell back', 'call', 0, `${sid}: ${String(e.message).slice(0, 200)}`);
      return res.type('text/xml').send(transferXml(sess));
    }
    db.prepare('UPDATE ai_call_sessions SET messages=?, turns=turns+1 WHERE call_sid=?').run(JSON.stringify(msgs).slice(0, 200000), sid);
    if (action === 'transfer') return res.type('text/xml').send(transferXml(sess));
    if (action === 'end') return res.type('text/xml').send(sayHangup(say || 'Thank you for calling Bright Clean. Goodbye.'));
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${gather(say || 'How else can I help?')}<Redirect method="POST">${base()}/api/webhooks/twilio/ai-turn</Redirect></Response>`);
  }));
  // When the call ends: attach the AI conversation, links and follow-up to the call record (once).
  ctx.finalizeAi = function finalizeAi(sid) {
    const sess = db.prepare('SELECT * FROM ai_call_sessions WHERE call_sid=? AND finalized=0').get(sid); if (!sess) return;
    const c = db.prepare('SELECT * FROM calls WHERE provider_sid=?').get(sid); if (!c) return;
    const msgs = JSON.parse(sess.messages || '[]'), lines = sess.greeting ? [`AI receptionist: ${sess.greeting}`] : [];
    for (const m of msgs) { if (typeof m.content === 'string') lines.push(`Caller: ${m.content}`); else for (const p of m.content || []) { if (p.type === 'text' && p.text.trim()) lines.push(`AI receptionist: ${p.text.trim()}`); if (p.type === 'tool_use') lines.push(`[action: ${p.name}]`); } }
    const ld = sess.lead_id ? db.prepare('SELECT contact_name, company, service FROM leads WHERE id=?').get(sess.lead_id) : null;
    const heard = msgs.filter(m => typeof m.content === 'string').length, lastAi = [...msgs].reverse().find(m => m.role === 'assistant'), endedByAi = lastAi && Array.isArray(lastAi.content) && lastAi.content.some(p => p.type === 'tool_use' && ['end_call', 'transfer_to_human'].includes(p.name));
    if (!heard && !sess.transferred) { sess.callback = sess.callback || 'Caller hung up during the AI greeting before saying anything — call back.'; }
    else if (!endedByAi && !sess.transferred && !sess.error) { sess.callback = (sess.callback ? sess.callback + ' | ' : '') + 'Call ended before the AI finished (details may be missing) — follow up.'; }
    const summary = [ld ? `New inquiry: ${[ld.contact_name, ld.company].filter(Boolean).join(', ')} — ${ld.service || ''}` : '', sess.issue_id ? `Complaint logged (issue #${sess.issue_id}).` : '', sess.callback ? `Callback: ${sess.callback}` : '', sess.transferred ? 'Transferred to a person.' : '', sess.error ? `AI fallback: ${sess.error}` : ''].filter(Boolean).join(' ') || 'AI receptionist call.';
    const prev = String(c.transcript || '');
    db.prepare(`UPDATE calls SET handling='AI', lead_id=COALESCE(lead_id,?), customer_id=COALESCE(customer_id,?), contact_name=COALESCE(NULLIF(contact_name,''),?), company=COALESCE(NULLIF(company,''),?), purpose=CASE WHEN ? THEN 'Complaint' WHEN ? THEN 'New work' ELSE purpose END,
      summary=?, follow_up_date=CASE WHEN ? THEN COALESCE(follow_up_date,?) ELSE follow_up_date END, issue_id=COALESCE(issue_id,?), transcript=? WHERE id=?`)
      .run(sess.lead_id, sess.customer_id, ld && ld.contact_name, ld && ld.company, sess.issue_id ? 1 : 0, sess.lead_id ? 1 : 0, summary.slice(0, 1000), sess.callback || sess.lead_id ? 1 : 0, today(), sess.issue_id, ((prev ? prev + '\n\n' : '') + '[AI receptionist conversation]\n' + lines.join('\n')).slice(0, 60000), c.id);
    if (!heard && !sess.transferred) db.prepare("UPDATE calls SET outcome='Missed' WHERE id=?").run(c.id);
    if (sess.callback) createCallbackTask(c.id, `AI receptionist: ${sess.callback}`);
    db.prepare("UPDATE ai_call_sessions SET finalized=1, status=CASE WHEN status='active' THEN 'completed' ELSE status END, summary=?, ended_at=? WHERE call_sid=?").run(summary.slice(0, 1000), now(), sid);
  };
  ctx.aiWhyNot = () => !aiKey() ? 'AI receptionist needs ANTHROPIC_API_KEY in Render' : !token() ? 'phone not connected' : aiMode() === 'off' ? 'AI receptionist is off (Settings → Phone)' : aiMode() === 'after_hours' && isOpen() ? 'AI receptionist only answers after hours' : 'AI receptionist was available';
  ctx.aiStatus = () => ({ mode: aiMode(), ready: aiReady(), key: !!aiKey(), open_now: isOpen(), answering_now: aiReady() && aiMode() !== 'off' && !(aiMode() === 'after_hours' && isOpen()), why: ctx.aiWhyNot() });
  // Text test of the receptionist: same prompt, tools and model, but nothing is saved.
  app.post('/api/admin/ai-receptionist/test', auth, async (req, res) => {
    if (!aiKey()) return res.status(503).json({ error: 'AI is off: add ANTHROPIC_API_KEY in Render.' });
    const hist = Array.isArray((req.body || {}).messages) ? req.body.messages.slice(-20) : [], msgs = [];
    for (const m of hist) { const t = String(m.text || '').slice(0, 600); if (t) msgs.push({ role: m.role === 'ai' ? 'assistant' : 'user', content: t }); }
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'Type what the caller says.' });
    const fake = { caller: '+15555550100', call_sid: 'TEST' }, actions = [];
    try {
      let say = '';
      for (let round = 0; round < 3; round++) {
        const j = await claudeTurn(msgs, SYSTEM(fake, null) + '\nTHIS IS A TEST FROM THE ADMIN: actions are simulated and nothing is saved.'), content = j.content || [];
        msgs.push({ role: 'assistant', content }); say = content.filter(c => c.type === 'text').map(c => c.text).join(' ').trim();
        const uses = content.filter(c => c.type === 'tool_use'); if (!uses.length) break;
        msgs.push({ role: 'user', content: uses.map(u => { actions.push({ action: u.name, details: u.input }); return { type: 'tool_result', tool_use_id: u.id, content: u.name === 'end_call' ? 'Ending call.' : u.name === 'transfer_to_human' ? 'Transferring now.' : 'Done (test — not saved).' }; }) });
        if (uses.some(u => ['end_call', 'transfer_to_human'].includes(u.name))) { if (!say) say = uses.some(u => u.name === 'transfer_to_human') ? 'One moment while I connect you.' : 'Thank you for calling Bright Clean. Goodbye.'; break; }
      }
      res.json({ reply: say || '(no reply)', actions });
    } catch (e) { res.status(502).json({ error: 'The AI did not answer: ' + e.message + '. On a real call this would fall back to ringing your phones.' }); }
  });
  // ---- Real health check: each part is exercised, not just "a key exists". ----
  app.get('/api/admin/phone/health', auth, async (req, res) => {
    const out = [], api = (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, ''), basic = 'Basic ' + Buffer.from(acctSid() + ':' + token()).toString('base64');
    const add = (key, label, status, detail, ms) => out.push({ key, label, status, detail, ms });
    const timed = async fn => { const t0 = Date.now(); try { return { ok: true, v: await fn(), ms: Date.now() - t0 }; } catch (e) { return { ok: false, e: e.message, ms: Date.now() - t0 }; } };
    if (!token() || !acctSid()) add('twilio_auth', 'Twilio sign-in', 'fail', 'TWILIO_AUTH_TOKEN or account SID missing');
    else { const r = await timed(async () => { const x = await fetch(`${api}/2010-04-01/Accounts/${acctSid()}.json`, { headers: { Authorization: basic } }); if (!x.ok) throw new Error('Twilio answered ' + x.status); return x.json(); }); add('twilio_auth', 'Twilio sign-in', r.ok ? 'pass' : 'fail', r.ok ? `account ${r.v.status || 'ok'}` : r.e, r.ms);
      const n = await timed(async () => { const x = await fetch(`${api}/2010-04-01/Accounts/${acctSid()}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(twNumber())}`, { headers: { Authorization: basic } }); if (!x.ok) throw new Error('Twilio answered ' + x.status); return x.json(); });
      const num = n.ok && (n.v.incoming_phone_numbers || [])[0], want = `${base()}/api/webhooks/twilio/voice`;
      add('number_routing', `Number ${twNumber() || '(not set)'} routes calls here`, !n.ok ? 'fail' : !num ? 'fail' : num.voice_url === want ? 'pass' : 'fail', !n.ok ? n.e : !num ? 'number not found on this Twilio account' : num.voice_url === want ? 'voice webhook correct' + (num.status_callback ? '; call status reported' : '; call-status callback not set (missed-call outcomes less precise)') : `voice webhook is ${num.voice_url || 'empty'}; should be ${want}`, n.ms); }
    if (!aiKey()) add('ai_model', 'AI model answers', 'fail', 'ANTHROPIC_API_KEY missing');
    else { const r = await timed(async () => { const x = await fetch((process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': aiKey(), 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: process.env.AI_RECEPTIONIST_MODEL || 'claude-haiku-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'Reply OK' }] }) }); if (!x.ok) throw new Error('AI answered ' + x.status); return x.json(); });
      add('ai_model', 'AI model answers', r.ok ? (r.ms > 4000 ? 'warn' : 'pass') : 'fail', r.ok ? `${process.env.AI_RECEPTIONIST_MODEL || 'claude-haiku-5-5'} replied in ${r.ms} ms${r.ms > 4000 ? ' (slow: callers will hear a pause)' : ''}` : r.e, r.ms); }
    add('ring_phones', 'Phones to ring / transfer to', ringPhones().length ? 'pass' : softphone() ? 'warn' : 'fail', ringPhones().length ? `${ringPhones().length} phone(s)${softphone() ? ' + browser phone' : ''}` : softphone() ? 'browser phone only' : 'none — transfers and fallback go straight to voicemail');
    add('receptionist', 'AI receptionist mode', aiMode() === 'off' ? 'warn' : 'pass', ({ off: 'Off', no_answer: 'answers when no one picks up', after_hours: 'answers after hours', always: 'answers every call' })[aiMode()]);
    add('fallback', 'Fallback if AI fails', 'pass', 'AI error or 9 s timeout → rings your phones → voicemail (built in)');
    add('callback_owner', 'Callbacks assigned to', callbackOwner() ? 'pass' : 'fail', callbackOwner() || 'nobody');
    const wk = new Date(Date.now() - 7 * 864e5).toISOString(), st = db.prepare("SELECT COUNT(*) n, SUM(status='fallback') fb FROM ai_call_sessions WHERE started_at>=?").get(wk);
    add('recent', 'AI calls in the last 7 days', st.fb ? 'warn' : 'pass', `${st.n || 0} answered, ${st.fb || 0} fell back`);
    const overall = out.some(x => x.status === 'fail') ? 'fail' : out.some(x => x.status === 'warn') ? 'warn' : 'pass';
    logAction(req, 'ran phone health check', 'phone settings', 0, overall);
    res.json({ overall, checked_at: now(), checks: out });
  });
  app.put('/api/admin/phone/callback-owner', auth, (req, res) => {
    const e = String((req.body || {}).email || '').trim().toLowerCase(), em = String((req.user && req.user.email) || '').toLowerCase(), ow = String(ctx.adminEmail || '').toLowerCase();
    const role = !ow || em === ow ? 'owner' : ((db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(em) || {}).role || 'staff');
    if (!['owner', 'manager'].includes(role)) return res.status(403).json({ error: 'Only an owner or manager can change who gets callbacks.' });
    if (e !== ow && !db.prepare('SELECT 1 FROM admin_users WHERE lower(email)=?').get(e)) return res.status(400).json({ error: 'Choose someone who has access to the admin.' });
    setS('callback_owner', e); logAction(req, 'set callback owner', 'phone settings', 0, e); res.json({ ok: true, owner: e });
  });
  // Columns for automatic callbacks on leads.
  { const lc = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name); for (const [c, t] of [['callback_requested', 'INTEGER NOT NULL DEFAULT 0'], ['last_callback_at', 'TEXT'], ['callback_calls', 'INTEGER NOT NULL DEFAULT 0']]) if (!lc.includes(c)) db.exec(`ALTER TABLE leads ADD COLUMN ${c} ${t}`); }
  const roleOfEmail = e => { const em = String(e || '').toLowerCase(); if (process.env.ADMIN_EMAIL && em === String(process.env.ADMIN_EMAIL).toLowerCase()) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(em); return r ? r.role : 'staff'; };
  // ---- Automatic callbacks for leads who asked for one. OFF until the owner enables it AND confirms the legal review. ----
  // A lead is only called when someone has marked it "Call back requested". The caller hears a disclosure (automated assistant,
  // recorded call), and presses 1 to be connected to the team. Calls stay inside business hours and under a daily limit.
  const OB_KEY = 'outbound_callbacks';
  const obDefaults = { enabled: false, legal_review_confirmed: false, daily_limit: 10, start_hour: 9, end_hour: 17 };
  const obGet = () => { try { return { ...obDefaults, ...(JSON.parse(getS(OB_KEY) || '{}')) }; } catch { return { ...obDefaults }; } };
  const localHour = () => { try { return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: process.env.BUSINESS_TZ || 'America/Chicago' }).format(new Date())) % 24; } catch { return new Date().getHours(); } };
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };
  const obSentToday = () => (db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='outbound callback placed' AND created_at>=?").get(startOfToday()) || {}).n || 0;

  // Places one call per eligible lead, up to the daily limit. Returns what happened, so it can be tested and shown to the owner.
  async function runOutboundSweep() {
    const s = obGet();
    if (!s.enabled || !s.legal_review_confirmed) return { skipped: 'off' };
    const h = localHour();
    if (h < s.start_hour || h >= s.end_hour) return { skipped: 'outside business hours' };
    if (!token() || !acctSid() || !twNumber()) return { skipped: 'phone provider not connected' };
    const remaining = Math.max(0, s.daily_limit - obSentToday());
    if (!remaining) return { skipped: 'daily limit reached' };
    const day = new Date(Date.now() - 86400000).toISOString();
    const leads = db.prepare("SELECT id, phone FROM leads WHERE callback_requested=1 AND phone IS NOT NULL AND phone<>'' AND stage NOT IN ('done','converted') AND (follow_up_date IS NULL OR follow_up_date='' OR follow_up_date<=?) AND (last_callback_at IS NULL OR last_callback_at<?) ORDER BY id LIMIT ?").all(today(), day, remaining);
    const placed = [];
    const api = (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
    for (const l of leads) {
      const to = e164(l.phone); if (!to) continue;
      try {
        const r = await fetch(`${api}/2010-04-01/Accounts/${acctSid()}/Calls.json`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(acctSid() + ':' + token()).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: to, From: twNumber(), Url: `${base()}/api/webhooks/twilio/outbound?lead=${l.id}`, StatusCallback: `${base()}/api/webhooks/twilio/status`, Timeout: '25' }) });
        if (!r.ok) continue;
        const t = new Date().toISOString();
        db.prepare('UPDATE leads SET last_callback_at=?, callback_calls=COALESCE(callback_calls,0)+1 WHERE id=?').run(t, l.id);
        db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES('automation','outbound callback placed','lead',?,?,?)").run(l.id, to, t);
        placed.push(l.id);
        if (app.locals.touchLead) app.locals.touchLead(l.id);
      } catch (e) { console.error('outbound callback failed:', e.message); }
    }
    return { placed: placed.length };
  }
  app.locals.runOutboundSweep = runOutboundSweep;
  if (!process.env.DISABLE_SCHEDULER) setInterval(() => { runOutboundSweep().catch(() => {}); }, 5 * 60 * 1000).unref?.();

  // What the caller hears when the call is answered (signed like every Twilio webhook).
  app.post('/api/webhooks/twilio/outbound', hook((req, res) => {
    const lead = Number(req.query.lead) || 0;
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${req.query.test ? '<Say voice="Polly.Joanna">This is a test call from Bright Clean. This is an automated assistant. This call may be recorded. You can hang up now. Goodbye.</Say>' : ''}${req.query.test ? '' : '<Gather numDigits="1" timeout="8" action="${base()}/api/webhooks/twilio/outbound-press?lead=${lead}" method="POST"><Say voice="Polly.Joanna">Hello. This is an automated assistant calling for Bright Clean. This call may be recorded. You asked us to call you back. Press 1 to be connected to our team now, or hang up and we will follow up.</Say></Gather><Say voice="Polly.Joanna">Thank you. Our team will follow up with you. Goodbye.</Say>'}</Response>`);
  }));
  // Caller pressed a key: 1 connects to the team's phones; anything else ends the call politely.
  app.post('/api/webhooks/twilio/outbound-press', hook((req, res) => {
    const lead = Number(req.query.lead) || 0, phones = ringPhones();
    if (String((req.body || {}).Digits || '') === '1' && (phones.length || softphone())) {
      // Rings the phones to ring and the browser phone (admin open in a browser) so someone can answer.
      const num = phones.map(p => `<Number>${esc(p)}</Number>`).join('') + (softphone() ? '<Client>office</Client>' : '');
      if (lead) db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES('automation','callback connected','lead',?,?,?)").run(lead, 'caller pressed 1', new Date().toISOString());
      return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Connecting you now.</Say><Dial callerId="${esc(twNumber())}" timeout="25">${num}</Dial></Response>`);
    }
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Thank you. Our team will follow up. Goodbye.</Say></Response>');
  }));

  // Settings: owners only. Turning it on requires the legal-review confirmation.
  app.get('/api/admin/outbound-callbacks', auth, (req, res) => {
    if (roleOfEmail(req.user && req.user.email) !== 'owner') return res.status(403).json({ error: 'Only the owner can change automatic callbacks.' });
    res.json({ settings: obGet(), sent_today: obSentToday(), defaults: obDefaults });
  });
  app.put('/api/admin/outbound-callbacks', auth, (req, res) => {
    if (roleOfEmail(req.user && req.user.email) !== 'owner') return res.status(403).json({ error: 'Only the owner can change automatic callbacks.' });
    const b = req.body || {}, cur = obGet(), next = { ...cur };
    if (b.daily_limit !== undefined) { const v = Number(b.daily_limit); if (!Number.isInteger(v) || v < 0 || v > 50) return res.status(400).json({ error: 'Daily limit must be a whole number from 0 to 50.' }); next.daily_limit = v; }
    if (b.start_hour !== undefined) { const v = Number(b.start_hour); if (!Number.isInteger(v) || v < 0 || v > 23) return res.status(400).json({ error: 'Start hour must be 0 to 23.' }); next.start_hour = v; }
    if (b.end_hour !== undefined) { const v = Number(b.end_hour); if (!Number.isInteger(v) || v < 1 || v > 24) return res.status(400).json({ error: 'End hour must be 1 to 24.' }); next.end_hour = v; }
    if (b.legal_review_confirmed !== undefined) next.legal_review_confirmed = !!b.legal_review_confirmed;
    if (b.enabled !== undefined) next.enabled = !!b.enabled;
    if (next.enabled && !next.legal_review_confirmed) return res.status(400).json({ error: 'Confirm the legal review before turning automatic callbacks on.' });
    if (next.start_hour >= next.end_hour) return res.status(400).json({ error: 'The window must end after it starts.' });
    setS(OB_KEY, JSON.stringify(next));
    logAction(req, 'changed automatic callbacks', 'settings', 0, JSON.stringify(next));
    res.json({ ok: true, settings: next });
  });
  // Mark or unmark a lead as "Call back requested" (staff can do this; the automatic calls only go to marked leads).
  app.post('/api/admin/leads/:id/callback-request', auth, (req, res) => {
    const id = Number(req.params.id);
    const x = db.prepare('UPDATE leads SET callback_requested=? WHERE id=?').run(req.body && req.body.requested ? 1 : 0, id);
    if (!x.changes) return res.status(404).json({ error: 'Lead not found.' });
    logAction(req, req.body && req.body.requested ? 'marked call back requested' : 'cleared call back request', 'lead', id, '');
    res.json({ ok: true });
  });
  // ---- One-time test call (owner only). Places a single call to a number the owner types, with the automated-assistant
  // disclosure, so the call and its audio can be checked. It does not turn on automatic callbacks, and it is logged.
  app.post('/api/admin/test-call', auth, async (req, res) => {
    if (roleOfEmail(req.user && req.user.email) !== 'owner') return res.status(403).json({ error: 'Only the owner can place a test call.' });
    const to = e164((req.body || {}).to);
    if (!to) return res.status(400).json({ error: 'Enter a US phone number with area code.' });
    if (!token() || !acctSid() || !twNumber()) return res.status(503).json({ error: 'The phone provider is not connected.' });
    const api = (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
    try {
      const r = await fetch(`${api}/2010-04-01/Accounts/${acctSid()}/Calls.json`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(acctSid() + ':' + token()).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: twNumber(), Url: `${base()}/api/webhooks/twilio/outbound?test=1`, StatusCallback: `${base()}/api/webhooks/twilio/status`, Timeout: '25' }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: 'The call could not be placed: ' + (j.message || r.status) });
      logAction(req, 'placed test call', 'phone', 0, to);
      res.json({ ok: true, sid: j.sid || null, to });
    } catch (e) { res.status(502).json({ error: 'The call could not be placed: ' + e.message }); }
  });
  { const cc = db.prepare('PRAGMA table_info(calls)').all().map(c => c.name); if (!cc.includes('transcript_sid')) db.exec('ALTER TABLE calls ADD COLUMN transcript_sid TEXT'); }
  // ---- Transcribe a saved recording on request. Works even when live transcription missed the call. ----
  // Asks Twilio to transcribe the call's recording, then fills in the call's transcript when Twilio has the text.
  const recordingSidOf = url => { const m = /\/Recordings\/(RE[0-9a-f]{32})/i.exec(String(url || '')); return m ? m[1] : null; };
  const twApi = (path, init = {}) => {
    const api = (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
    return fetch(`${api}/2010-04-01/Accounts/${acctSid()}${path}`, { ...init, headers: { Authorization: 'Basic ' + Buffer.from(acctSid() + ':' + token()).toString('base64'), ...(init.headers || {}) } });
  };
  // Twilio only creates transcripts while a call is being recorded, so this fetches the transcript Twilio already made
  // for the recording (if it made one). It cannot create one after the fact.
  app.post('/api/admin/calls/:id/transcribe', auth, async (req, res) => {
    const c = db.prepare('SELECT id, recording_url, transcript FROM calls WHERE id=?').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Call not found.' });
    if (c.transcript) return res.json({ ok: true, transcript: c.transcript, already: true });
    const rs = recordingSidOf(c.recording_url);
    if (!rs) return res.status(400).json({ error: 'This call has no recording.' });
    if (!token() || !acctSid()) return res.status(503).json({ error: 'The phone provider is not connected.' });
    try {
      const r = await twApi(`/Recordings/${encodeURIComponent(rs)}/Transcriptions.json`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: 'Twilio could not be checked: ' + (j.message || r.status) });
      const list = Array.isArray(j.transcriptions) ? j.transcriptions : [];
      if (!list.length) return res.status(409).json({ error: 'Twilio has no transcript for this recording. Live transcription was not running on this call, and Twilio cannot make one afterwards.' });
      const t = list.find(x => x.status === 'completed') || list[0];
      db.prepare('UPDATE calls SET transcript_sid=? WHERE id=?').run(String(t.sid || ''), c.id);
      res.json({ ok: true, status: t.status || 'unknown', transcription_sid: t.sid || null });
    } catch (e) { res.status(502).json({ error: 'Twilio could not be reached: ' + e.message }); }
  });
  // Checks on the transcription; when Twilio has the text, it is saved to the call.
  app.get('/api/admin/calls/:id/transcribe-status', auth, async (req, res) => {
    const c = db.prepare('SELECT id, transcript, transcript_sid FROM calls WHERE id=?').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Call not found.' });
    if (c.transcript) return res.json({ status: 'completed', transcript: c.transcript });
    if (!c.transcript_sid) return res.json({ status: 'not-started' });
    try {
      const r = await twApi(`/Transcriptions/${encodeURIComponent(c.transcript_sid)}.json`);
      const j = await r.json().catch(() => ({}));
      if (j.status === 'completed' && j.transcription_text) {
        const text = String(j.transcription_text).replace(/\s+/g, ' ').trim().slice(0, 20000);
        db.prepare('UPDATE calls SET transcript=? WHERE id=?').run(text, c.id);
        return res.json({ status: 'completed', transcript: text });
      }
      res.json({ status: j.status || 'in-progress' });
    } catch (e) { res.status(502).json({ error: 'Twilio could not be reached: ' + e.message }); }
  });
};
