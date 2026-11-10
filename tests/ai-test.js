/* AI layer against a local fake of the Anthropic Messages API (and Postmark for replies). */
const http = require('http'), { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ROOT = path.join(__dirname, '..'); const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) { try { const ev = await fn(); results.push({ name, status: 'PASS', evidence: ev }); console.log('PASS  ' + name); } catch (e) { results.push({ name, status: 'FAIL', evidence: e.message }); console.log('FAIL  ' + name + ' -> ' + e.message); } }
(async () => {
  const seen = []; let failNext = false; const mails = [];
  const fake = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const j = JSON.parse(b || '{}');
    if (req.url === '/email') { mails.push(j); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ErrorCode: 0, MessageID: 'x' })); }
    seen.push({ url: req.url, key: req.headers['x-api-key'], ver: req.headers['anthropic-version'], body: j });
    if (failNext) { failNext = false; res.writeHead(529, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Overloaded' } })); }
    if (Array.isArray(j.tools) && /virtual phone receptionist/.test(j.system || '')) {
      const last = j.messages[j.messages.length - 1], said = typeof last.content === 'string' ? last.content.toLowerCase() : '';
      const tool = (name, input, text) => ({ content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2), name, input }], stop_reason: 'tool_use' });
      let out;
      if (Array.isArray(last.content) && last.content[0] && last.content[0].type === 'tool_result') out = { content: [{ type: 'text', text: /Ending/.test(last.content[0].content) ? 'Thanks for calling Bright Clean. Goodbye!' : 'Got it, thank you. Someone from Bright Clean will follow up today. May I have your name?' }] };
      else if (said.includes('quote')) out = tool('save_caller_details', { service_category: 'construction', service_needed: 'Final clean for a 40,000 square foot clinic', location: 'Ankeny, Iowa', square_footage: '40,000', bid_due_date: '2026-12-10', drawings_available: 'yes, can email' });
      else if (said.includes('dana')) out = tool('save_caller_details', { name: 'Dana Ruiz', company: 'Ridge Builders', email: 'dana@ridge.test', service_needed: 'Final clean for a 40,000 square foot clinic' });
      else if (said.includes('person')) out = tool('transfer_to_human', { reason: 'caller asked for a person' });
      else if (said.includes('lobby')) out = tool('log_complaint', { summary: 'Lobby glass streaked and trash not emptied after last night', urgent: false });
      else if (said.includes("that's all")) out = tool('end_call', {});
      else out = { content: [{ type: 'text', text: 'How can I help you today?' }] };
      seen.push({ url: req.url, receptionist: true, model: j.model, tools: j.tools.map(t => t.name) });
      if (failNext) { failNext = false; res.writeHead(529, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Overloaded' } })); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
    }
    const content = JSON.stringify(j.messages[0].content);
    let out;
    if (content.includes('Approved Bright Clean price book')) { const ids = [...content.matchAll(/id[^0-9]{1,6}(\d+)/g)].map(m => Number(m[1])); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ project_name: 'Riverside Office final clean', scope_category: 'construction', area_sqft: 24000, lines: [{ scope_id: ids[0], quantity: 24000, basis: '24,000 sq ft stated' }, { scope_id: 999999, quantity: 5, basis: 'bogus' }], assumptions: ['Power and water on site'], exclusions: ['Exterior windows'], questions: ['How many floors?'] }) }] })); }
    if (content.includes('Company records')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ content: [{ type: 'text', text: 'For the period shown, 1 invoice is unpaid (sum of unpaid invoice balances).' }] })); }
    if (content.includes('BLUEPRINT READING')) out = { sheets: [{ sheet: 'G0.1', title: 'Cover', discipline: 'General' }, { sheet: 'A1.1', title: 'Level 1 plan', discipline: 'Architectural' }], building_sf: 24000, building_sf_sheet: 'G0.1', floors: 2, floors_sheet: 'G0.1',
      rooms: [{ number: '101', name: 'Lobby', area_sf: 1200, floor_finish: 'Terrazzo', sheet: 'A1.1', confidence: 'High' }, { number: '102', name: 'Open office', area_sf: 9000, floor_finish: 'Carpet tile', sheet: 'A1.1', confidence: 'Medium' }, { number: '103', name: 'Guessed room', area_sf: 500 }],
      counts: [{ item: 'Restrooms', quantity: 6, sheet: 'A1.1', confidence: 'High' }], finishes: [{ finish: 'Terrazzo', areas: 'Lobby', sheet: 'A6.1' }], cleaning_notes: [{ note: '24 ft atrium glass', sheet: 'A3.1' }, { note: 'no sheet note' }], questions: ['Is level 2 tenant space in scope?'] };
    else if (content.includes('"type":"document"')) out = { sheets: [{ sheet: 'G0.1', title: 'Code plan', revision: 'IFC' }, { sheet: 'A1.1', title: 'Level 1 plan' }], building_sf: 136600, building_sf_sheet: 'G0.1', quantities: [{ item: 'Restrooms', quantity: 28, sheet: 'A6.1', method: 'From schedule', confidence: 'High', note: 'toilet room schedule' }], questions: ['Exterior glass quantity is not shown on the A-sheets.'] };
    else if (content.includes('CALL ANALYSIS')) out = { summary: 'Pat from Phone Match Co wants a final clean quote for 20,000 SF next month.', intent: 'New bid request', sentiment: 'Positive', urgency: 'High', lead_score: 82, score_reasons: ['Defined scope', 'Near-term timeline'], details: { service: 'Final clean', square_feet: 20000, site_address: '', timeline: 'next month', budget: '' }, action_items: [{ task: 'Send final clean quote', owner: 'Estimator', due: '2026-11-06' }, { task: '', owner: 'x' }], follow_up_date: '2026-11-05', reply_draft: 'Hi Pat, thanks for calling...', risks: [] };
    else if (content.includes('Phone call notes')) out = { contact_name: 'Dana Ruiz', company: 'Ridge Builders', phone: '515-555-0100', email: '', purpose: 'Bid request', service: 'Final clean', square_footage: '80,000', deadline: 'December walkthrough', summary: 'GC needs final clean for 80,000 SF building.', follow_up: 'Request drawings' };
    else out = { summary: 'Ridge Builders needs a construction final clean for an 80,000 SF office.', category: 'construction', priority: 'High', missing: ['Drawing set', 'Site access details'], next_step: 'Request drawings and schedule a walkthrough.', reply_subject: 'Your final cleaning request', reply_body: 'Thank you for contacting Bright Clean. Could you send the drawing set?' };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(out) + '\n```' }] }));
  }); }).listen(0);
  const FAKE = 'http://127.0.0.1:' + fake.address().port;
  const PORT = 4400 + Math.floor(Math.random() * 50), B = 'http://127.0.0.1:' + PORT;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ai-')); const OWNER = 'owner@brightclean.test', PW = 'owner-password-1234';
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'staging', JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await bcrypt.hash(PW, 8),
    DATA_DIR: path.join(work, 'data'), UPLOAD_DIR: path.join(work, 'up'), ANTHROPIC_API_KEY: 'test-ai-key', ANTHROPIC_API_URL: FAKE, TWILIO_AUTH_TOKEN: 'tw-ai-token', PUBLIC_BASE_URL: 'https://brightclean.net', TWILIO_FORWARD_TO: '+15155550199', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_NUMBER: '+15153033024', ANTHROPIC_MODEL: 'test-model', AI_SWEEP_MS: '400',
    POSTMARK_TOKEN: 'pm', POSTMARK_API_URL: FAKE, FROM_EMAIL: 'info@brightclean.net', NOTIFY_EMAIL: 'info@brightclean.net' };
  delete env.SMTP_HOST;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/health')).ok) break; } catch { } await sleep(150); }
  const api = async (m, u, j, t) => { const r = await fetch(B + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: j ? JSON.stringify(j) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  const signIn = require('./mfa-helper')((p, b, t) => api('POST', p, b, t));
  const T = await signIn(OWNER, PW);
  let leadId;
  await check('AI status on; new lead triaged automatically in the background (no click)', async () => {
    const st = (await api('GET', '/api/admin/ai/status', null, T)).data;
    const fd = new FormData(); Object.entries({ contact_name: 'Dana Ruiz', company: 'Ridge Builders', email: 'dana@ridge.test', phone: '515-555-0100', address: '1 Main, Ankeny IA', consent: 'yes', service_key: 'construction_final', gc_company: 'Ridge Builders', building_type: 'Office', square_footage: '80000', phases: 'Final clean', windows: 'Interior only', plans: 'Will send them later' }).forEach(([k, v]) => fd.append(k, v));
    const q = await (await fetch(B + '/api/quotes', { method: 'POST', body: fd })).json(); leadId = q.id;
    let ai = null; for (let i = 0; i < 30 && !ai; i++) { await sleep(300); const l = (await api('GET', '/api/admin/leads/' + leadId, null, T)).data.lead; ai = l.ai ? JSON.parse(l.ai) : null; }
    const req = seen.find(s => !JSON.stringify(s.body).includes('"type":"document"'));
    assert(st.enabled && st.model === 'test-model' && ai && ai.category === 'construction' && ai.missing.length === 2 && req.key === 'test-ai-key' && req.ver === '2023-06-01' && req.body.model === 'test-model' && /Never state a price/.test(req.body.system), JSON.stringify({ st, ai }));
    return `lead #${leadId} analyzed automatically: "${ai.summary}" · ${ai.priority} · missing ${ai.missing.join(', ')}; request used key, API version and model; system prompt forbids prices`;
  });
  await check('Missing information: the AI emails the customer its questions automatically, once (no prices)', async () => {
    let l; for (let i = 0; i < 20; i++) { l = (await api('GET', '/api/admin/leads/' + leadId, null, T)).data.lead; if (JSON.parse(l.ai || '{}').info_requested_at) break; await sleep(300); }
    const ai = JSON.parse(l.ai), sent = mails.filter(m => m.To === 'dana@ridge.test' && m.Subject === ai.reply_subject);
    const log = (await api('GET', '/api/admin/audit-log', null, T)).data.events.find(e => e.action === 'requested information' && e.entity_id === leadId);
    await sleep(1200);
    const again = mails.filter(m => m.To === 'dana@ridge.test' && m.Subject === ai.reply_subject).length;
    assert(ai.info_requested_at && sent.length === 1 && again === 1 && !/\$\d/.test(sent[0].TextBody) && l.status === 'In Review' && log, JSON.stringify({ ai, n: sent.length, again }));
    return `questions emailed to dana@ridge.test ("${sent[0].Subject}"), once; lead moved to In Review; logged as automation`;
  });
  await check('Reply draft is sent only on click; replies with prices are refused', async () => {
    const m0 = mails.length;
    const bad = await api('POST', `/api/admin/leads/${leadId}/reply`, { subject: 'Quote', body: 'It will be $5,000.' }, T);
    const ok = await api('POST', `/api/admin/leads/${leadId}/reply`, { subject: 'Your final cleaning request', body: 'Thank you. Could you send the drawing set?' }, T);
    const sent = mails.slice(m0).filter(m => m.Subject === 'Your final cleaning request' && /drawing set/.test(m.TextBody)); const lead = (await api('GET', '/api/admin/leads/' + leadId, null, T)).data.lead;
    const logged = (await api('GET', '/api/admin/emails', null, T)).data.emails.some(e => e.subject === 'Your final cleaning request' && e.to_addr === 'dana@ridge.test');
    assert(m0 >= 0 && bad.status === 400 && /prices/.test(bad.data.error) && ok.status === 200 && sent.length === 1 && sent[0].To === 'dana@ridge.test' && lead.status === 'In Review' && logged, JSON.stringify([bad.data, ok.data, sent.length]));
    return 'price in reply 400; approved reply sent to dana@ridge.test, lead moved to In Review, reply appears in Email Center';
  });
  await check('Call notes -> structured fields', async () => {
    const r = await api('POST', '/api/admin/ai/calls/extract', { notes: 'Dana from Ridge called, 80k sf office final clean, Dec walkthrough, 515-555-0100' }, T);
    assert(r.status === 200 && r.data.fields.purpose === 'Bid request' && r.data.fields.company === 'Ridge Builders', JSON.stringify(r.data));
    return `purpose ${r.data.fields.purpose}; ${r.data.fields.company}; ${r.data.fields.square_footage} SF; next: ${r.data.fields.follow_up}`;
  });
  await check('AI blueprint reading: sheets, rooms with areas/finishes, counts, cleaning notes; findings without a sheet are dropped; sheet index filled; takeoff draft flags room-vs-building mismatch', async () => {
    const fd = new FormData(); fd.append('files', new Blob([Buffer.from('%PDF-1.4\n% bp\n')], { type: 'application/pdf' }), 'bp-set.pdf'); fd.append('kind', 'Drawings'); fd.append('revision', 'IFC');
    const up = await (await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd })).json();
    const r = await api('POST', `/api/admin/ai/documents/${up.ids[0]}/blueprint`, null, T);
    const d = (await api('GET', '/api/admin/docs/' + up.ids[0], null, T)).data.document;
    const tk = await api('POST', `/api/admin/docs/${up.ids[0]}/takeoff`, null, T);
    const t = (await api('GET', '/api/admin/takeoffs', null, T)).data.takeoffs.find(x => x.id === tk.data.takeoff_id);
    const bp = r.data.blueprint;
    assert(r.status === 200 && bp.rooms.length === 2 && !bp.rooms.some(x => x.name === 'Guessed room') && bp.cleaning_notes.length === 1 && bp.dropped_without_sheet === 2 && bp.building_sf === 24000 && d.blueprint_status === 'Analyzed' && d.sheets.length === 2 && d.sheets[0].source === 'AI' && tk.status === 201 && t && t.building_sf === 24000 && /Room areas add up to 10,200 SF/.test(t.questions) && /Lobby: 1200 SF, Terrazzo \(sheet A1.1, High\)/.test(t.questions), JSON.stringify({ bp, d: d.blueprint_status, tk: tk.data, q: t && t.questions }));
    return `${bp.sheets.length} sheets, ${bp.rooms.length} rooms (1 without sheet dropped), ${bp.counts.length} count, 1 note kept / 1 dropped; sheet index filled from AI; takeoff #${tk.data.takeoff_id} 24,000 SF flags rooms 10,200 SF vs building`;
  });
  await check('AI takeoff reads a PDF drawing set: sheet index, building SF with source sheet, questions; drafts a priced takeoff', async () => {
    await api('POST', '/api/admin/scopes/import-pricebook', {}, T);
    const fd = new FormData(); fd.append('files', new Blob([Buffer.from('%PDF-1.4 fake drawing set')]), 'DMCS Drawings.pdf'); fd.append('kind', 'Drawings');
    const up = await (await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd })).json();
    const r = await api('POST', `/api/admin/ai/documents/${up.ids[0]}/takeoff`, null, T);
    const doc = (await api('GET', '/api/admin/documents', null, T)).data.documents.find(d => d.id === up.ids[0]);
    const t = (await api('GET', '/api/admin/takeoffs', null, T)).data.takeoffs.find(x => x.id === r.data.takeoff_id);
    const sent = seen.find(s => JSON.stringify(s.body).includes('"type":"document"'));
    const block = sent.body.messages[0].content[0];
    assert(r.status === 200 && doc.analysis_status === 'Analyzed' && t.building_sf === 136600 && t.lines.length === 3 && t.lines.every(l => l.sheet === 'G0.1' && l.method === 'From schedule') && /Exterior glass/.test(t.questions) && /Restrooms: 28 \(sheet A6.1/.test(t.questions) && block.source.media_type === 'application/pdf' && block.source.data.length > 10, JSON.stringify({ t, s: doc.analysis_status }));
    const est = (await api('GET', '/api/admin/estimates/' + r.data.estimate_id, null, T)).data.estimate;
    assert(est && est.status === 'Draft' && est.proposal_total === Math.round(136600 * (0.18375 + 0.13125 + 0.1575) * 100) / 100, JSON.stringify(est && est.proposal_total));
    return `PDF sent as a document block; draft estimate #${est.id} $${est.proposal_total.toLocaleString()} created automatically; ${r.data.analysis.sheets.length} sheets indexed; 136,600 SF from G0.1; takeoff #${t.id} drafted with Clean #1–#3 and GC questions; status Analyzed`;
  });
  await check('AI outage is reported, logged as an AI failure (not an email failure), and the document is marked Failed', async () => {
    const fd = new FormData(); fd.append('files', new Blob([Buffer.from('%PDF-1.4 x')]), 'Set2.pdf');
    const up = await (await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd })).json();
    failNext = true; const r = await api('POST', `/api/admin/ai/documents/${up.ids[0]}/takeoff`, null, T);
    const doc = (await api('GET', '/api/admin/documents', null, T)).data.documents.find(d => d.id === up.ids[0]);
    const cc = (await api('GET', '/api/admin/command-center', null, T)).data;
    assert(r.status === 502 && /Overloaded/.test(r.data.error) && doc.analysis_status === 'Failed' && cc.kpis.attention.parts.failed_emails_7_days === 0 && cc.modules.blueprint.connected, JSON.stringify([r, doc.analysis_status, cc.kpis.attention.parts]));
    return `502 "${r.data.error}"; document Failed; email-failure count unaffected; Command Center shows AI on`;
  });
  await check('AI estimate from a description uses only price-book items and server pricing; unknown items dropped; questions kept', async () => {
    const short = await api('POST', '/api/admin/ai/estimates/generate', { description: 'clean it' }, T);
    const r = await api('POST', '/api/admin/ai/estimates/generate', { description: 'Final construction clean for Riverside Office, 24,000 sq ft, two stories, owner wants it done before Dec 1.', company: 'Indigo Construction', email: 'pm@indigo.test' }, T);
    if (r.status !== 201) throw new Error('generate: ' + r.status + ' ' + JSON.stringify(r.data));
    const g = await api('GET', '/api/admin/estimates/' + r.data.id, null, T); const e = g.data.estimate || g.data;
    const items = typeof e.line_items === 'string' ? JSON.parse(e.line_items) : e.line_items;
    const it = (await api('GET', '/api/admin/scopes', null, T)).data;
    const book = (it.items || it.scopes || []).find(x => x.id === items[0].scope_id);
    assert(short.status === 400 && r.status === 201 && r.data.created && e.status === 'Draft' && items.length === 1 && items[0].quantity === 24000 && Math.abs(items[0].amount - 24000 * items[0].unit_price) < 0.01 && (!book || book.unit_price === items[0].unit_price) && /Exterior windows/.test(e.exclusions) && r.data.questions.includes('How many floors?'), JSON.stringify({ r: r.data, items }));
    return `draft #${r.data.id} $${r.data.total.toLocaleString()} (24,000 sq ft × $${items[0].unit_price} from the price book); bogus item dropped; question kept; vague description 400`;
  });
  await check('AI report assistant answers from the actual records (period, figures, data notes sent; nothing invented)', async () => {
    const r = await api('POST', '/api/admin/ai/reports/ask', { question: 'Which customers owe us money?' }, T);
    const sent = seen.filter(x => JSON.stringify(x.body).includes('Company records')).pop();
    const facts = JSON.parse(sent.body.messages[0].content.match(/\{[\s\S]*\}\n\nManager/)[0].replace(/\n\nManager$/, ''));
    const empty = await api('POST', '/api/admin/ai/reports/ask', { question: '' }, T);
    assert(r.status === 200 && /unpaid/.test(r.data.answer) && r.data.period.start && facts.executive && facts.unpaid_invoices && facts.data_notes.length && /ONLY these records/.test(sent.body.messages[0].content) && empty.status === 400, JSON.stringify(r.data));
    return `answer: "${r.data.answer}"; AI received executive figures, ${facts.unpaid_invoices.length} unpaid invoices, ${facts.data_notes.length} data notes; empty question 400`;
  });
  await check('AI call analysis: needs a real transcript; returns intent, sentiment, lead score, action items (empty dropped), follow-up and reply draft; stored on the call', async () => {
    const c = (await api('POST', '/api/admin/calls', { contact_name: 'Pat Phone', company: 'Phone Match Co', phone: '515-555-0177', purpose: 'New business', summary: 'short' }, T)).data.call;
    const short = await api('POST', `/api/admin/ai/calls/${c.id}/analyze`, {}, T);
    const r = await api('POST', `/api/admin/ai/calls/${c.id}/analyze`, { transcript: 'Hi this is Pat from Phone Match Co. We have a 20,000 square foot office build-out finishing next month and need a final clean quote. Can someone call me back this week?' }, T);
    const d = (await api('GET', `/api/admin/calls/${c.id}/detail`, null, T)).data.call;
    assert(short.status === 400 && r.status === 200 && r.data.ai.intent === 'New bid request' && r.data.ai.lead_score === 82 && r.data.ai.action_items.length === 1 && r.data.ai.details.square_feet === 20000 && d.ai && d.intent === 'New bid request' && d.lead_score === 82 && /20,000 square foot/.test(d.transcript), JSON.stringify({ short: short.status, r: r.data, d: d && d.intent }));
    return `short notes 400; ${r.data.ai.intent}, ${r.data.ai.sentiment}, score ${r.data.ai.lead_score}, ${r.data.ai.action_items.length} action item, follow-up ${r.data.ai.follow_up_date}; saved on call`;
  });
  await check('Turning automatic triage off stops background analysis', async () => {
    await api('PUT', '/api/admin/ai/settings', { auto_triage: false }, T);
    const n0 = seen.length;
    await (await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'No AI', email: 'n@t.test', message: 'hello' }) })).json();
    await sleep(1500);
    assert(seen.length === n0, `${seen.length} vs ${n0}`);
    return 'no AI calls made for the new inquiry while automatic triage is off';
  });
  await check('AI receptionist: answers, talks, saves a lead (updated not duplicated), transfers on request, logs a complaint for an existing customer, ends politely, falls back on AI outage, handles silence; call shows Handling AI with the conversation', async () => {
    const base = 'https://brightclean.net';
    const sign = (p, prm) => crypto.createHmac('sha1', 'tw-ai-token').update(base + p + Object.keys(prm).sort().map(k => k + prm[k]).join('')).digest('base64');
    const post = (p, prm) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(p, prm) }, body: new URLSearchParams(prm) }).then(r => r.text());
    const off = await post('/api/webhooks/twilio/voice', { CallSid: 'CAoff' + 'a'.repeat(27), From: '+15155550301', To: '+15153033024', Direction: 'inbound' });
    const set = await api('PUT', '/api/admin/phone/settings', { ai_mode: 'always' }, T);
    const sid = 'CAai1' + 'a'.repeat(27), from = '+15155550302', turn = (said, extra = {}) => post('/api/webhooks/twilio/ai-turn', { CallSid: sid, From: from, SpeechResult: said, ...extra });
    const hello = await post('/api/webhooks/twilio/voice', { CallSid: sid, From: from, To: '+15153033024', Direction: 'inbound' });
    const t1 = await turn('Hi, I need a quote for a final clean on a 40,000 square foot clinic in Ankeny, bids due December 10');
    const t2 = await turn('This is Dana Ruiz with Ridge Builders, dana@ridge.test');
    const t2dup = await turn('This is Dana Ruiz with Ridge Builders, dana@ridge.test');
    const t3 = await turn("That's all, thanks");
    await post('/api/webhooks/twilio/status', { CallSid: sid, CallStatus: 'completed', Direction: 'inbound', From: from, To: '+15153033024', CallDuration: '96' }); await sleep(300);
    const calls = (await api('GET', '/api/admin/calls', null, T)).data.calls, c = calls.find(x => x.provider_sid === sid);
    const leads = (await api('GET', '/api/admin/leads', null, T)).data.leads.filter(l => /Ridge Builders/.test(l.company || '') && /AI receptionist/.test(l.details || ''));
    // transfer
    const sid2 = 'CAai2' + 'a'.repeat(27);
    await post('/api/webhooks/twilio/voice', { CallSid: sid2, From: '+15155550303', To: '+15153033024', Direction: 'inbound' });
    const tx = await post('/api/webhooks/twilio/ai-turn', { CallSid: sid2, From: '+15155550303', SpeechResult: 'Can I talk to a person please' });
    // complaint from an existing customer
    const cu = (await api('POST', '/api/admin/customers', { company: 'Lobby Co', name: 'Lou', phone: '515-555-0304', email: 'lou@lobby.test' }, T)).data.id;
    const sid3 = 'CAai3' + 'a'.repeat(27);
    await post('/api/webhooks/twilio/voice', { CallSid: sid3, From: '+15155550304', To: '+15153033024', Direction: 'inbound' });
    await post('/api/webhooks/twilio/ai-turn', { CallSid: sid3, From: '+15155550304', SpeechResult: 'The lobby glass is streaky and trash was not emptied' });
    await post('/api/webhooks/twilio/status', { CallSid: sid3, CallStatus: 'completed', Direction: 'inbound', From: '+15155550304', To: '+15153033024', CallDuration: '40' }); await sleep(300);
    const c3 = (await api('GET', '/api/admin/calls', null, T)).data.calls.find(x => x.provider_sid === sid3);
    // outage → fallback
    const sid4 = 'CAai4' + 'a'.repeat(27);
    await post('/api/webhooks/twilio/voice', { CallSid: sid4, From: '+15155550305', To: '+15153033024', Direction: 'inbound' });
    failNext = true; const fb = await post('/api/webhooks/twilio/ai-turn', { CallSid: sid4, From: '+15155550305', SpeechResult: 'Hello?' });
    // silence twice
    const sid5 = 'CAai5' + 'a'.repeat(27);
    await post('/api/webhooks/twilio/voice', { CallSid: sid5, From: '+15155550306', To: '+15153033024', Direction: 'inbound' });
    const s1 = await post('/api/webhooks/twilio/ai-turn', { CallSid: sid5, From: '+15155550306', SpeechResult: '' }), s2 = await post('/api/webhooks/twilio/ai-turn', { CallSid: sid5, From: '+15155550306', SpeechResult: '' });
    // no_answer mode: office phones first, AI only if unanswered
    await api('PUT', '/api/admin/phone/settings', { ai_mode: 'no_answer' }, T);
    const na = await post('/api/webhooks/twilio/voice', { CallSid: 'CAai6' + 'a'.repeat(27), From: '+15155550307', To: '+15153033024', Direction: 'inbound' });
    const naMissed = await post('/api/webhooks/twilio/dial-result', { CallSid: 'CAai6' + 'a'.repeat(27), From: '+15155550307', DialCallStatus: 'no-answer' });
    const fromAi = await post('/api/webhooks/twilio/dial-result?ai=done', { CallSid: sid2, From: '+15155550303', DialCallStatus: 'no-answer' });
    await api('PUT', '/api/admin/phone/settings', { ai_mode: 'off' }, T);
    const bad = await api('PUT', '/api/admin/phone/settings', { ai_mode: 'sometimes' }, T);
    const issues = (await api('GET', '/api/admin/issues', null, T)).data; const iss = (issues.items || issues.issues || []).find(i => i.customer_id === cu);
    const rcpt = seen.filter(x => x.receptionist);
    const chk = { offNoAi: !off.includes('ai-turn'), set: set.status === 200, helloVA: hello.includes('virtual assistant'), helloRec: hello.includes('may be recorded'), helloGather: hello.includes('<Gather input="speech"'), voice: /Polly\.[A-Za-z]+-Neural/.test(hello),
      t1Gather: t1.includes('<Gather'), t1Name: /May I have your name/.test(t1), t3Bye: t3.includes('Goodbye') && t3.includes('<Hangup/>'),
      oneLead: leads.length === 1, leadName: leads[0] && leads[0].contact_name === 'Dana Ruiz', leadDue: leads[0] && leads[0].bid_due_date === '2026-12-10', leadKind: leads[0] && leads[0].kind === 'bid',
      callAI: c && c.handling === 'AI', callLead: c && leads[0] && c.lead_id === leads[0].id, callTr: c && /AI receptionist conversation/.test(c.transcript) && /Caller: Hi, I need a quote/.test(c.transcript), callFU: c && !!c.follow_up_date,
      tx: tx.includes('connect you') && tx.includes('<Number>+15155550199</Number>') && tx.includes('ai=done'),
      c3: c3 && c3.handling === 'AI' && c3.customer_id === cu && !!c3.issue_id, iss: iss && iss.priority === 'High', fb: fb.includes('<Dial') && fb.includes('+15155550199'),
      s1: /catch that/.test(s1), s2: /call you back/.test(s2) && s2.includes('<Hangup/>'), naFirst: !na.includes('ai-turn') && na.includes('<Number>'), naMissed: naMissed.includes('virtual assistant'), fromAi: !fromAi.includes('virtual assistant'),
      bad: bad.status === 400, tools: rcpt.every(x => x.tools.join() === 'save_caller_details,log_complaint,request_callback,transfer_to_human,end_call') };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | na=' + na.slice(0, 160) + ' | naMissed=' + naMissed.slice(0, 160) + ' | fromAi=' + fromAi.slice(0, 120) + ' | s1=' + s1.slice(0, 100));
    return `AI answered, saved 1 lead (Dana Ruiz, construction, bid due 2026-12-10), transferred, logged a complaint, ended politely, fell back on outage, handled silence; call shows Handling AI`;
  });

  await check('Receptionist visibility: missed call with AI off is labelled Voicemail and says why; Calls status shows the mode; admin text test answers with the real prompt/tools and saves nothing', async () => {
    const base = 'https://brightclean.net';
    const sign = (p, prm) => crypto.createHmac('sha1', 'tw-ai-token').update(base + p + Object.keys(prm).sort().map(k => k + prm[k]).join('')).digest('base64');
    const post = (p, prm) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(p, prm) }, body: new URLSearchParams(prm) }).then(r => r.text());
    await api('PUT', '/api/admin/phone/settings', { ai_mode: 'off' }, T);
    const sid = 'CAvmw' + 'a'.repeat(27);
    await post('/api/webhooks/twilio/voice', { CallSid: sid, From: '+15155550401', To: '+15153033024', Direction: 'inbound' });
    const vm = await post('/api/webhooks/twilio/dial-result', { CallSid: sid, From: '+15155550401', DialCallStatus: 'no-answer' });
    await post('/api/webhooks/twilio/status', { CallSid: sid, CallStatus: 'completed', Direction: 'inbound', From: '+15155550401', To: '+15153033024', CallDuration: '31' }); await sleep(200);
    const c = (await api('GET', '/api/admin/calls', null, T)).data.calls.find(x => x.provider_sid === sid);
    const intelOff = (await api('GET', '/api/admin/calls-intel', null, T)).data.receptionist;
    await api('PUT', '/api/admin/phone/settings', { ai_mode: 'no_answer' }, T);
    const intelOn = (await api('GET', '/api/admin/calls-intel', null, T)).data.receptionist;
    const leadsBefore = (await api('GET', '/api/admin/leads', null, T)).data.leads.length;
    const tst = await api('POST', '/api/admin/ai-receptionist/test', { messages: [{ role: 'caller', text: 'Hi, I need a quote for a final clean on a 40,000 square foot clinic' }] }, T);
    const leadsAfter = (await api('GET', '/api/admin/leads', null, T)).data.leads.length;
    const staff = await api('POST', '/api/admin/ai-receptionist/test', { messages: [] }, T);
    await api('PUT', '/api/admin/phone/settings', { ai_mode: 'off' }, T);
    const chk = { vmPrompt: /leave your name/i.test(vm), outcome: c && c.outcome === 'Voicemail', handling: c && c.handling === 'Voicemail', why: c && /AI receptionist is off/.test(c.summary || ''), off: intelOff && intelOff.mode === 'off' && !intelOff.answering_now, on: intelOn && intelOn.mode === 'no_answer' && intelOn.answering_now && intelOn.key,
      reply: tst.status === 200 && /name/i.test(tst.data.reply), actions: tst.status === 200 && tst.data.actions.some(a => a.action === 'save_caller_details'), nothingSaved: leadsAfter === leadsBefore, empty: staff.status === 400 };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ c: c && [c.outcome, c.handling, c.summary], intelOff, intelOn, tst: tst.data }));
    return `voicemail labelled with reason "${(c.summary || '').slice(0, 80)}"; status off→on; test reply "${tst.data.reply.slice(0, 60)}" + would ${tst.data.actions.map(a => a.action).join(', ')}; nothing saved`;
  });

  await check('Receptionist call records: greeting (with recording notice) is in the transcript; caller who hangs up during the greeting → Missed + callback today; call that ends mid-conversation → follow-up noting missing details', async () => {
    const base = 'https://brightclean.net';
    const sign = (p, prm) => crypto.createHmac('sha1', 'tw-ai-token').update(base + p + Object.keys(prm).sort().map(k => k + prm[k]).join('')).digest('base64');
    const post = (p, prm) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(p, prm) }, body: new URLSearchParams(prm) }).then(r => r.text());
    await api('PUT', '/api/admin/phone/settings', { ai_mode: 'always' }, T);
    const done = async (sid, from) => { await post('/api/webhooks/twilio/status', { CallSid: sid, CallStatus: 'completed', Direction: 'inbound', From: from, To: '+15153033024', CallDuration: '20' }); await sleep(250); return (await api('GET', '/api/admin/calls', null, T)).data.calls.find(x => x.provider_sid === sid); };
    const h = 'CAhang' + 'a'.repeat(26); await post('/api/webhooks/twilio/voice', { CallSid: h, From: '+17015550101', To: '+15153033024', Direction: 'inbound' });
    const hung = await done(h, '+17015550101');
    const m = 'CAmid' + 'a'.repeat(27); await post('/api/webhooks/twilio/voice', { CallSid: m, From: '+15155550601', To: '+15153033024', Direction: 'inbound' });
    await post('/api/webhooks/twilio/ai-turn', { CallSid: m, From: '+15155550601', SpeechResult: 'Hi, I need a quote for office cleaning' });
    const mid = await done(m, '+15155550601');
    await api('PUT', '/api/admin/phone/settings', { ai_mode: 'off' }, T);
    const chk = { greet: hung && /may be recorded/.test(hung.transcript || '') && /^\[AI receptionist conversation\]\nAI receptionist: Thanks for calling/.test(hung.transcript || ''), hungMissed: hung && hung.outcome === 'Missed', hungCb: hung && /hung up during the AI greeting/.test(hung.summary || '') && !!hung.follow_up_date,
      midNote: mid && /ended before the AI finished/.test(mid.summary || '') && !!mid.follow_up_date, midLead: mid && !!mid.lead_id };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ hung: hung && [hung.outcome, hung.summary, (hung.transcript || '').slice(0, 160)], mid: mid && [mid.summary, mid.lead_id] }));
    return 'greeting recorded; hang-up → Missed + callback; unfinished call → follow-up note';
  });

  await check('Callback ownership + repeat callers: hang-up and AI-promised callbacks each create ONE assigned Follow-up task (owner, due today, High) linked to the call; a repeat caller updates the open lead instead of creating another', async () => {
    const base = 'https://brightclean.net';
    const sign = (p, prm) => crypto.createHmac('sha1', 'tw-ai-token').update(base + p + Object.keys(prm).sort().map(k => k + prm[k]).join('')).digest('base64');
    const post = (p, prm) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(p, prm) }, body: new URLSearchParams(prm) }).then(r => r.text());
    await api('PUT', '/api/admin/phone/settings', { ai_mode: 'always' }, T);
    const done = async (sid, from) => { await post('/api/webhooks/twilio/status', { CallSid: sid, CallStatus: 'completed', Direction: 'inbound', From: from, To: '+15153033024', CallDuration: '20' }); await sleep(250); return (await api('GET', '/api/admin/calls', null, T)).data.calls.find(x => x.provider_sid === sid); };
    const h = 'CAcbk' + 'a'.repeat(27); await post('/api/webhooks/twilio/voice', { CallSid: h, From: '+17015550202', To: '+15153033024', Direction: 'inbound' }); const hung = await done(h, '+17015550202');
    await post('/api/webhooks/twilio/status', { CallSid: h, CallStatus: 'completed', Direction: 'inbound', From: '+17015550202', To: '+15153033024', CallDuration: '20' }); await sleep(200);
    const issues = (await api('GET', '/api/admin/issues', null, T)).data, list = issues.items || issues.issues || [];
    const task = list.find(i => i.id === hung.callback_issue_id), dupTasks = list.filter(i => /Call back/.test(i.title) && /\+17015550202/.test(i.description || '')).length;
    // repeat caller: two separate calls from the same number → one lead
    const r1 = 'CArep1' + 'a'.repeat(26), r2 = 'CArep2' + 'a'.repeat(26), from = '+15155550777';
    await post('/api/webhooks/twilio/voice', { CallSid: r1, From: from, To: '+15153033024', Direction: 'inbound' }); await post('/api/webhooks/twilio/ai-turn', { CallSid: r1, From: from, SpeechResult: 'I need a quote for an office' }); await done(r1, from);
    await post('/api/webhooks/twilio/voice', { CallSid: r2, From: from, To: '+15153033024', Direction: 'inbound' }); await post('/api/webhooks/twilio/ai-turn', { CallSid: r2, From: from, SpeechResult: 'Calling back about my quote for an office' }); const c2 = await done(r2, from);
    const leads = (await api('GET', '/api/admin/leads', null, T)).data.leads.filter(l => String(l.phone || '').endsWith('5550777'));
    await api('PUT', '/api/admin/phone/settings', { ai_mode: 'off' }, T);
    const chk = { task: task && task.type === 'follow_up' && task.assigned_to === OWNER && task.priority === 'High' && !!task.due_date && task.status === 'Open', once: dupTasks === 1, oneLead: leads.length === 1, calledAgain: leads[0] && /Called again/.test(leads[0].details || ''), linked: c2 && c2.lead_id === (leads[0] && leads[0].id) };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ task, dupTasks, leads: leads.map(l => [l.id, (l.details || '').slice(-80)]), c2: c2 && c2.lead_id }));
    return `hang-up → FUP task for ${task.assigned_to} due ${task.due_date} (created once); repeat caller → 1 lead, "Called again" noted`;
  });

  await check('AI receptionist complaint → exactly ONE Quality complaint case (source: AI phone call), linked to the customer and the call with its transcript; a repeated webhook does not create a second case', async () => {
    const base = 'https://brightclean.net';
    const sign = (p, prm) => crypto.createHmac('sha1', 'tw-ai-token').update(base + p + Object.keys(prm).sort().map(k => k + prm[k]).join('')).digest('base64');
    const post = (p, prm) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(p, prm) }, body: new URLSearchParams(prm) }).then(r => r.text());
    await api('PUT', '/api/admin/phone/settings', { ai_mode: 'always' }, T);
    const cu = (await api('POST', '/api/admin/customers', { company: 'Boulevard Office', name: 'Bo', phone: '515-555-0911', email: 'bo@blvd.test', address: '1144 Boulevard, Walker, IA' }, T)).data.id;
    const sid = 'CAqc' + 'a'.repeat(28), from = '+15155550911';
    await post('/api/webhooks/twilio/voice', { CallSid: sid, From: from, To: '+15153033024', Direction: 'inbound' });
    await post('/api/webhooks/twilio/ai-turn', { CallSid: sid, From: from, SpeechResult: 'The lobby was not cleaned last night and the trash is still there' });
    await post('/api/webhooks/twilio/ai-turn', { CallSid: sid, From: from, SpeechResult: 'The lobby was not cleaned last night and the trash is still there' }); // Twilio retry
    await post('/api/webhooks/twilio/status', { CallSid: sid, CallStatus: 'completed', Direction: 'inbound', From: from, To: '+15153033024', CallDuration: '50' }); await sleep(400);
    const call = (await api('GET', '/api/admin/calls', null, T)).data.calls.find(x => x.provider_sid === sid);
    const cases = (await api('GET', '/api/admin/quality/complaints', null, T)).data.complaints.filter(c => c.customer_id === cu);
    const det = cases[0] && (await api('GET', `/api/admin/quality/complaints/${cases[0].id}`, null, T)).data;
    await api('PUT', '/api/admin/phone/settings', { ai_mode: 'off' }, T);
    const chk = { one: cases.length === 1, source: cases[0] && cases[0].source_type === 'AI phone call', call: det && det.call && det.call.id === call.id, transcript: det && /lobby was not cleaned/.test(det.complaint.transcript || ''), callStays: call && call.handling === 'AI', manager: det && !!det.complaint.assigned_manager };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ n: cases.length, c: cases[0], call: call && [call.id, call.issue_id, call.handling], det: det && { call: det.call, tr: (det.complaint.transcript || '').slice(0, 120) } }).slice(0, 1200));
    return `${cases[0].number} from the AI call; call #${call.id} stays in Calls (Handled by AI) and is linked; transcript attached; retry did not duplicate`;
  });

  await check('Lead source: the AI is told where each lead came from and gets every saved field (contact form, staff-added, quote form)', async () => {
    const cf = await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Web Contact', email: 'web.contact@ai.test', phone: '515-555-0199', message: 'Do you clean after water restoration? Our third floor is done.' }), redirect: 'manual' });
    assert(cf.status < 400, 'contact form status ' + cf.status);
    const pat = await api('POST', '/api/admin/leads', { contact_name: 'Pat Builder', company: 'Build Co', email: 'pat.build@ai.test', phone: '515-555-0123', details: 'Two-story office, final clean' }, T);
    const leads = (await api('GET', '/api/admin/leads', null, T)).data.leads || [];
    const webId = (leads.find(l => l.email === 'web.contact@ai.test') || {}).id;
    const patId = (leads.find(l => l.email === 'pat.build@ai.test') || {}).id;
    assert(webId && patId, 'leads not found: ' + JSON.stringify({ webId, patId, pat: pat.status }));
    const web = leads.find(l => l.id === webId), staff = leads.find(l => l.id === patId);
    assert(web.origin === 'website' && staff.origin === 'manual', 'origins: ' + JSON.stringify({ web: web.origin, staff: staff.origin }));
    const triage = async id => { const r = await api('POST', `/api/admin/ai/leads/${id}/triage`, null, T); assert(r.status === 200, 'triage ' + r.status); };
    await triage(webId); await triage(patId);
    const promptFor = mark => { const s = [...seen].reverse().find(x => x.body && JSON.stringify(x.body).includes(mark)); return s ? JSON.stringify(s.body) : ''; };
    const webPrompt = promptFor('web.contact@ai.test'), staffPrompt = promptFor('pat.build@ai.test');
    const chk = {
      contactLabel: webPrompt.includes('Where this lead came from: Website contact form message'),
      contactMessage: webPrompt.includes('Do you clean after water restoration'),
      contactNotStaff: !webPrompt.includes('did NOT contact us'),
      contactStatus: webPrompt.includes('status: New'),
      staffLabel: staffPrompt.includes('Added by Bright Clean staff'),
      staffRule: staffPrompt.includes('did NOT contact us'),
      staffDetails: staffPrompt.includes('Two-story office, final clean')
    };
    assert(Object.values(chk).every(Boolean), JSON.stringify({ chk, webId, patId }));
    return 'contact-form lead told it wrote to us (not outreach), with its message and status; staff-added lead told to reach out; every saved field reaches the prompt';
  });

  child.kill(); fake.close();
  fs.writeFileSync(path.join(__dirname, 'ai-results.json'), JSON.stringify({ run_at: new Date().toISOString(), results }, null, 2));
  console.log(`${results.filter(r => r.status === 'PASS').length}/${results.length} passed`); process.exit(results.every(r => r.status === 'PASS') ? 0 : 1);
})();
