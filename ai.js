// Bright Clean AI layer (Anthropic Messages API). Dormant until ANTHROPIC_API_KEY is set in Render.
// Rules: the AI drafts and extracts; it never sends email, prices work or commits to anything by itself.
// Every AI run is recorded in automation_log so the owner can see what it did.
const fs = require('fs');

module.exports = function mountAI(app, ctx) {
  const { db, auth, logAction, clean, path, uploadDir, getMailer, isEmail } = ctx;
  const key = () => process.env.ANTHROPIC_API_KEY || '';
  const model = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const apiUrl = () => (process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
  const now = () => new Date().toISOString();
  const cols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  if (!cols.includes('ai')) db.exec('ALTER TABLE leads ADD COLUMN ai TEXT');
  const dcols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
  if (!dcols.includes('analysis')) db.exec('ALTER TABLE documents ADD COLUMN analysis TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS ai_settings(key TEXT PRIMARY KEY, value TEXT)`);
  const setting = (k, d) => { const r = db.prepare('SELECT value FROM ai_settings WHERE key=?').get(k); return r ? r.value === '1' : d; };
  const logRun = (kind, ref, status, detail) => {
    try { db.prepare('INSERT INTO automation_log(kind,ref_id,stage,sent_to,status,detail,created_at) VALUES(?,?,?,?,?,?,?)').run(kind, ref, 'ai', null, status, String(detail || '').slice(0, 500), now()); } catch { /* table shape differs: ignore */ }
  };

  const COMPANY = `You work for Bright Cleaning Sev Inc. (Bright Clean), a commercial cleaning company: construction final cleaning (rough, final, touch-up/punch, FF&E turnover), interior and exterior window cleaning, commercial janitorial, multifamily common areas, unit turnovers, power washing, parking lot upkeep and valet trash. Phone 515-329-5889, info@brightclean.net, brightclean.net.
Never invent prices, rates, availability, insurance, licenses, certifications or contract promises. Never state a price. If something is unknown, say it will be confirmed.`;

  async function call(messages, system, maxTokens = 1500) {
    if (!key()) { const e = new Error('AI is off: add ANTHROPIC_API_KEY in Render to turn it on.'); e.code = 'AI_OFF'; throw e; }
    const r = await fetch(apiUrl(), { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model(), max_tokens: maxTokens, system, messages }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`AI request failed (${r.status}): ${(j.error && j.error.message) || 'unknown error'}`);
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    return text;
  }
  function parseJSON(text) {
    const m = String(text).replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('The AI reply was not in the expected format.');
    return JSON.parse(m[0]);
  }

  // ---------- Lead triage + reply draft ----------
  async function triageLead(id) {
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(id);
    if (!l) throw new Error('Lead not found.');
    const facts = ['kind', 'contact_name', 'company', 'email', 'phone', 'project_name', 'project_type', 'service', 'address', 'square_footage', 'bid_due_date', 'start_date', 'frequency', 'details']
      .filter(k => l[k]).map(k => `${k}: ${String(l[k]).slice(0, 3000)}`).join('\n');
    const text = await call([{ role: 'user', content: `New website/phone lead:\n${facts}\n\nReturn ONLY JSON with keys:
"summary" (2 sentences), "category" (one of construction, multifamily, janitorial, windows, power_washing, parking, unit_turnover, other),
"priority" (High/Normal/Low with bid deadlines or large projects High), "missing" (array of short items still needed before pricing, e.g. drawings, square footage, site visit),
"next_step" (one sentence for the Bright Clean team), "reply_subject", "reply_body" (a short, friendly reply to the customer from Bright Clean that thanks them, confirms what we understood, asks only for the missing items, and promises follow-up. No prices.)` }], COMPANY, 1200);
    const ai = parseJSON(text);
    const out = { summary: clean(ai.summary, 600), category: clean(ai.category, 40), priority: clean(ai.priority, 10), missing: (Array.isArray(ai.missing) ? ai.missing : []).slice(0, 10).map(x => clean(x, 160)),
      next_step: clean(ai.next_step, 300), reply_subject: clean(ai.reply_subject, 160), reply_body: clean(ai.reply_body, 4000), model: model(), at: now() };
    db.prepare('UPDATE leads SET ai=? WHERE id=?').run(JSON.stringify(out), id);
    logRun('ai_lead_triage', id, 'ok', out.summary);
    return out;
  }

  // ---------- Call notes -> structured fields ----------
  async function extractCall(notes) {
    const text = await call([{ role: 'user', content: `Phone call notes taken by Bright Clean staff:\n"""${String(notes).slice(0, 6000)}"""\n\nReturn ONLY JSON: "contact_name","company","phone","email","purpose" (one of New business, Bid request, Existing customer, Complaint, Invoice question, Pricing question, Other),"service","square_footage","deadline","summary" (1-2 sentences),"follow_up" (what to do next). Use "" for unknown values; do not guess.` }], COMPANY, 800);
    return parseJSON(text);
  }

  // ---------- Drawing set -> takeoff draft ----------
  async function takeoffFromDocument(docId) {
    const d = db.prepare('SELECT * FROM documents WHERE id=?').get(docId);
    if (!d) throw new Error('Document not found.');
    const file = path.join(uploadDir, path.basename(d.file_url));
    if (!/\.pdf$/i.test(d.file_name || '') || !fs.existsSync(file)) throw new Error('AI takeoff reads PDF drawing sets. Upload the drawings as a PDF.');
    const size = fs.statSync(file).size;
    if (size > 30 * 1024 * 1024) throw new Error('This PDF is over 30 MB. Split the set (for example architectural sheets only) and try again.');
    db.prepare("UPDATE documents SET analysis_status='Analyzing' WHERE id=?").run(docId);
    try {
      const data = fs.readFileSync(file).toString('base64');
      const text = await call([{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
        { type: 'text', text: `You are doing a cleaning takeoff from this construction drawing set. Read every page.
Return ONLY JSON with:
"sheets": [{"sheet":"A1.1","title":"...","revision":"..."}] for every sheet you can identify,
"building_sf": total building area if stated on a code/area plan or schedule, else null,
"building_sf_sheet": sheet where you read it,
"quantities": [{"item":"Restrooms|Patient rooms|Floors|Interior windows|Exterior windows|Stairwells|Elevators|Corridors|Other: ...","quantity":number,"sheet":"A2.1","method":"From schedule|Measured|Inferred","confidence":"High|Medium|Low","note":"how you got it"}],
"questions": [short questions for the general contractor about missing or conflicting information].
Only report numbers you can trace to a sheet. Never invent quantities; leave them out and add a question instead.` }] }], COMPANY, 4000);
      const r = parseJSON(text);
      const analysis = { sheets: (r.sheets || []).slice(0, 400), building_sf: Number(r.building_sf) > 0 ? Number(r.building_sf) : null, building_sf_sheet: clean(r.building_sf_sheet, 40),
        quantities: (r.quantities || []).slice(0, 200).map(q => ({ item: clean(q.item, 120), quantity: Number(q.quantity) || 0, sheet: clean(q.sheet, 40), method: clean(q.method, 20), confidence: clean(q.confidence, 10), note: clean(q.note, 300) })).filter(q => q.quantity > 0),
        questions: (r.questions || []).slice(0, 40).map(q => clean(q, 300)), model: model(), at: now() };
      db.prepare("UPDATE documents SET analysis=?, analysis_status='Analyzed' WHERE id=?").run(JSON.stringify(analysis), docId);
      // Create a takeoff draft: building SF and the base construction phases, plus the questions.
      const ph = ['Clean #1', 'Clean #2', 'Clean #3'].map(p => db.prepare("SELECT id FROM scope_items WHERE active=1 AND category='construction' AND name LIKE ? AND unit_price IS NOT NULL").get(p + '%')).filter(Boolean);
      const lines = analysis.building_sf ? ph.map(p => ({ scope_id: p.id, quantity: analysis.building_sf, sheet: analysis.building_sf_sheet || 'see sheet index', method: 'From schedule', note: 'AI-read building area' })) : [];
      const qs = [...analysis.questions, ...analysis.quantities.map(q => `Check ${q.item}: ${q.quantity} (sheet ${q.sheet}, ${q.method}, ${q.confidence} confidence)`)].join('\n');
      const t = db.prepare(`INSERT INTO takeoffs(document_id,customer_id,project_id,name,category,building_sf,lines,questions,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'Draft','AI',?,?)`)
        .run(d.id, d.customer_id, d.project_id, `AI takeoff – ${d.title}`, 'construction', analysis.building_sf, JSON.stringify(lines), qs.slice(0, 5000), now(), now());
      logRun('ai_takeoff', docId, 'ok', `${analysis.sheets.length} sheets, ${analysis.quantities.length} quantities, takeoff #${t.lastInsertRowid}`);
      let estimateId = null;
      if (lines.length) {
        const items = lines.map(x => { const sc = db.prepare('SELECT * FROM scope_items WHERE id=?').get(x.scope_id); return { scope_id: sc.id, description: `${sc.name} (${Number(x.quantity).toLocaleString('en-US')} ${sc.unit})`, category: sc.category, unit: sc.unit, quantity: x.quantity, unit_price: sc.unit_price, production_rate: sc.production_rate || 0, pricing_method: sc.pricing_method, hours: 0, labor_rate: 0, amount: Math.round(x.quantity * sc.unit_price * 100) / 100 }; });
        const total = Math.round(items.reduce((a, i) => a + i.amount, 0) * 100) / 100, c = d.customer_id ? db.prepare('SELECT * FROM customers WHERE id=?').get(d.customer_id) : null;
        const info = db.prepare(`INSERT INTO estimates(customer_name,company,email,project_name,site_address,scope,area_sqft,line_items,line_items_total,use_line_items,proposal_total,status,public_token,expires_on,created_at,updated_at,scope_category) VALUES(?,?,?,?,?,?,?,?,?,1,?,'Draft',?,?,?,?,'construction')`)
          .run((c && (c.name || c.company)) || d.title, (c && c.company) || '', (c && c.email) || '', d.title, (c && c.address) || '', `Construction cleaning, Clean #1–#3, from AI takeoff of ${d.title}${d.revision ? ' (Rev ' + d.revision + ')' : ''}. Building area ${analysis.building_sf.toLocaleString('en-US')} SF read from sheet ${analysis.building_sf_sheet || 'index'}. Review the takeoff and questions before sending.`,
            analysis.building_sf, JSON.stringify(items), total, total, require('crypto').randomBytes(24).toString('hex'), new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), now(), now());
        estimateId = info.lastInsertRowid;
        db.prepare("UPDATE takeoffs SET estimate_id=?, status='Estimated' WHERE id=?").run(estimateId, t.lastInsertRowid);
      }
      return { analysis, takeoff_id: t.lastInsertRowid, estimate_id: estimateId };
    } catch (e) {
      db.prepare("UPDATE documents SET analysis_status='Failed' WHERE id=?").run(docId);
      logRun('ai_takeoff', docId, 'failed', e.message);
      throw e;
    }
  }

  // ---------- Routes ----------
  const fail = (res, e) => res.status(e.code === 'AI_OFF' ? 503 : 502).json({ error: e.message, ai_off: e.code === 'AI_OFF' });
  app.get('/api/admin/ai/status', auth, (req, res) => res.json({ enabled: !!key(), model: model(), auto_triage: setting('auto_triage', true), auto_request_info: setting('auto_request_info', true), auto_draft_estimates: setting('auto_draft_estimates', true) }));
  app.put('/api/admin/ai/settings', auth, (req, res) => {
    for (const k of ['auto_triage', 'auto_request_info', 'auto_draft_estimates']) if (k in (req.body || {})) db.prepare("INSERT INTO ai_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, req.body[k] ? '1' : '0');
    logAction(req, 'changed', 'ai settings', 0, `auto_triage ${!!req.body.auto_triage}`);
    res.json({ enabled: !!key(), model: model(), auto_triage: setting('auto_triage', true), auto_request_info: setting('auto_request_info', true), auto_draft_estimates: setting('auto_draft_estimates', true) });
  });
  app.post('/api/admin/ai/leads/:id/triage', auth, async (req, res) => {
    try { const ai = await triageLead(Number(req.params.id)); logAction(req, 'ran AI triage', 'lead', Number(req.params.id), ai.summary.slice(0, 120)); res.json({ ai }); }
    catch (e) { if (e.code !== 'AI_OFF') logRun('ai_lead_triage', Number(req.params.id), 'failed', e.message); fail(res, e); }
  });
  app.post('/api/admin/ai/calls/extract', auth, async (req, res) => {
    try { res.json({ fields: await extractCall(String((req.body || {}).notes || '')) }); } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/ai/documents/:id/takeoff', auth, async (req, res) => {
    try { const r = await takeoffFromDocument(Number(req.params.id)); logAction(req, 'ran AI takeoff', 'document', Number(req.params.id), `takeoff #${r.takeoff_id}`); res.json(r); }
    catch (e) { fail(res, e); }
  });
  // AI report assistant: answers management questions from the actual report figures only.
  app.post('/api/admin/ai/reports/ask', auth, async (req, res) => {
    const question = clean((req.body || {}).question, 500);
    if (!question) return res.status(400).json({ error: 'Type a question.' });
    if (!app.locals.bcReport) return res.status(500).json({ error: 'Reports are not available.' });
    const r = app.locals.bcReport(req.body.months);
    const owing = db.prepare(`SELECT invoice_number, COALESCE(NULLIF(company,''),customer_name) customer, amount, paid_amount, due_date, status FROM invoices WHERE status<>'Void' AND paid_amount<amount ORDER BY due_date LIMIT 25`).all();
    const openProps = db.prepare(`SELECT id, COALESCE(NULLIF(company,''),customer_name) customer, project_name, proposal_total, status, sent_at, viewed_at, expires_on FROM estimates WHERE status IN ('Draft','Ready','Sent','Viewed') ORDER BY id DESC LIMIT 25`).all();
    const facts = { period: r.period, executive: r.executive, win: r.win, flow: r.flow, operations: r.ops, receivables: r.receivables, by_service: r.by_service, pipeline: r.pipeline, top_customers: r.top_customers, unpaid_invoices: owing, open_proposals: openProps, data_notes: r.data_issues.map(x => x.text) };
    try {
      const answer = await call([{ role: 'user', content: `Company records (JSON, authoritative):\n${JSON.stringify(facts)}\n\nManager's question: ${question}\n\nAnswer using ONLY these records. State the reporting period, explain how each figure was calculated (which records were added up), and say plainly when the records are missing or too small to answer. Keep approved proposals, signed contracts, invoices and cash collected separate. Never estimate or invent numbers. Plain text, short paragraphs or a short list.` }],
        'You are the reporting assistant for Bright Cleaning Sev Inc. You answer only from the records provided.', 1200);
      logAction(req, 'asked AI', 'report', 0, question.slice(0, 200));
      res.json({ answer, period: r.period });
    } catch (e) { fail(res, e); }
  });

  // Human-approved reply: the owner reviews the AI draft (or writes one) and clicks Send.
  app.post('/api/admin/leads/:id/reply', auth, async (req, res) => {
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(Number(req.params.id));
    if (!l) return res.status(404).json({ error: 'Lead not found.' });
    const subject = clean((req.body || {}).subject, 200), body = clean((req.body || {}).body, 8000);
    if (!l.email || !isEmail(l.email)) return res.status(400).json({ error: 'This lead has no valid email address.' });
    if (!subject || !body) return res.status(400).json({ error: 'Write a subject and a message.' });
    if (/\$\s?\d/.test(body)) return res.status(400).json({ error: 'Replies from here cannot include prices. Send pricing through a proposal so approval rules apply.' });
    const mailer = getMailer();
    if (!mailer) return res.status(503).json({ error: 'Email is not set up yet, so the reply could not be sent.' });
    try { await mailer.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || 'info@brightclean.net', to: l.email, subject, text: body }); }
    catch (e) { return res.status(502).json({ error: 'Email could not be sent: ' + e.message }); }
    if (l.status === 'New') db.prepare("UPDATE leads SET status='In Review' WHERE id=?").run(l.id);
    logAction(req, 'replied to', 'lead', l.id, subject);
    res.json({ ok: true });
  });

  // Automatic information request: when the AI finds missing information, it emails the customer its
  // reply draft (questions only, never prices). Once per lead; can be turned off in Settings.
  async function maybeRequestInfo(id, ai) {
    if (!ai || !ai.missing || !ai.missing.length || !setting('auto_request_info', true)) return;
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(id);
    if (!l || !l.email || !isEmail(l.email) || /^test\b|\btest\b/i.test(`${l.contact_name} ${l.company}`)) return;
    if (/\$\s?\d/.test(ai.reply_body || '') || !ai.reply_subject || !ai.reply_body) return;
    const m = getMailer(); if (!m) return;
    try {
      await m.sendMail({ from: process.env.FROM_EMAIL || 'info@brightclean.net', to: l.email, subject: ai.reply_subject, text: ai.reply_body });
      const cur = JSON.parse(db.prepare('SELECT ai FROM leads WHERE id=?').get(id).ai || '{}'); cur.info_requested_at = now();
      db.prepare("UPDATE leads SET ai=?, status=CASE WHEN status='New' THEN 'In Review' ELSE status END WHERE id=?").run(JSON.stringify(cur), id);
      db.prepare("INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES('automation','requested information','lead',?,?,?)").run(id, ai.missing.join('; ').slice(0, 300), now());
      logRun('ai_info_request', id, 'ok', l.email);
    } catch (e) { logRun('ai_info_request', id, 'failed', e.message); }
  }

  // ---------- Automation: triage new leads in the background ----------
  let busy = false;
  async function sweep() {
    if (busy || !key() || !setting('auto_triage', true)) return;
    busy = true;
    try {
      const since = new Date(Date.now() - 7 * 864e5).toISOString();
      const rows = db.prepare(`SELECT id FROM leads WHERE ai IS NULL AND kind IN ('bid','inquiry') AND created_at>=? ORDER BY id LIMIT 5`).all(since);
      for (const r of rows) { try { const ai = await triageLead(r.id); await maybeRequestInfo(r.id, ai); } catch (e) { logRun('ai_lead_triage', r.id, 'failed', e.message); db.prepare('UPDATE leads SET ai=? WHERE id=?').run(JSON.stringify({ error: e.message, at: now() }), r.id); } }
    } finally { busy = false; }
  }
  const timer = setInterval(sweep, Number(process.env.AI_SWEEP_MS) || 60000); timer.unref();
  setTimeout(sweep, 3000).unref();
  return { triageLead, sweep, maybeRequestInfo };
};
