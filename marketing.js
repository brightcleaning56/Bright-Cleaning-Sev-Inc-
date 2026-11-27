'use strict';
// Bright Clean Marketing & Growth module.
// Leads stay in the existing leads table (leads.id is canonical). Marketing keeps attribution
// (first touch, latest touch, touchpoints) and campaign/spend records, and receives lifecycle
// outcomes from the canonical handlers. Marketing never sets lead status and never writes
// invoices, payments or ledger entries. Provider OAuth and ad/post publishing are NOT implemented here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_FILE = path.join(__dirname, 'marketing-schema.sql');
const CHANNELS = ['google_ads', 'meta_ads', 'google_business_profile', 'facebook', 'instagram', 'email', 'organic', 'referral', 'other'];
const BUDGET_PERIODS = ['daily', 'weekly', 'monthly', 'lifetime'];
const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'ended'];
const CONTENT_STATUSES = ['draft', 'approved'];
const EVENT_TYPES = ['contract_created', 'payment_received', 'refund_issued', 'lead_lost', 'lead_qualified', 'proposal_sent', 'proposal_approved', 'project_completed', 'invoice_issued'];
// Lead statuses that count as qualified (a lead has been worked past intake). Shown on every report with this definition.
const QUALIFIED_STATUSES = ['Site Walkthrough', 'Proposal in Progress', 'Proposal Sent', 'Won'];

function migrate(db) {
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

// Trims, strips control characters and caps length. Used for every attribution and marketing text field.
function text(v, max = 200) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null;
}
function positiveId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? Math.round(n * 100) / 100 : null;
}
function isDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
}
// Landing paths must stay on this site: a path that starts with a single slash.
function landingPath(v) {
  const s = text(v, 300);
  return s && s.startsWith('/') && !s.startsWith('//') ? s : null;
}
// Referrers are reduced to the host name only, so full URLs with query strings are never stored.
function referrerHost(v) {
  const s = text(v, 500);
  if (!s) return null;
  try { return new URL(s).hostname.slice(0, 200) || null; } catch { return null; }
}

// ---------- Attribution (first touch immutable, latest touch separate, every touch appended) ----------
// touch: { utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, landing_path, referrer, consent }
// Returns true when something was recorded. Never throws to the caller's intake path.
// Turns one browser touch into safe, length-limited columns. Campaign IDs are kept only when they exist.
function normalizeTouch(db, touch) {
  const campaignId = positiveId(touch.campaign_id);
  const validCampaign = campaignId && db.prepare('SELECT id FROM marketing_campaigns WHERE id=?').get(campaignId) ? campaignId : null;
  return {
    source: text(touch.utm_source, 120), medium: text(touch.utm_medium, 120), campaign: text(touch.utm_campaign, 200),
    content: text(touch.utm_content, 200), term: text(touch.utm_term, 200), campaign_id: validCampaign,
    landing_path: landingPath(touch.landing_path), referrer: referrerHost(touch.referrer),
  };
}
const hasSignal = t => !!(t && (t.source || t.campaign || t.campaign_id || t.medium));

// touch: the touch on the page where the lead was created, optionally with touch.first (the first campaign touch this browser session).
function recordTouch(db, leadId, touch, at = new Date().toISOString()) {
  const id = positiveId(leadId);
  if (!id || !touch || typeof touch !== 'object') return false;
  if (touch.consent === 'declined') return false;
  if (!db.prepare('SELECT id FROM leads WHERE id=?').get(id)) return false;
  const t = normalizeTouch(db, touch);
  // A touch with no signal (direct visit with no campaign data) is not attribution.
  if (!hasSignal(t)) return false;
  const f = touch.first && typeof touch.first === 'object' && hasSignal(normalizeTouch(db, touch.first)) ? normalizeTouch(db, touch.first) : t;
  const consent = ['granted', 'declined', 'unknown'].includes(touch.consent) ? touch.consent : 'unknown';
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM marketing_attribution WHERE lead_id=?').get(id);
    if (!existing) {
      db.prepare(`INSERT INTO marketing_attribution(lead_id,first_source,first_medium,first_campaign,first_campaign_id,first_content,first_term,first_landing_path,first_referrer,first_touch_at,
        latest_source,latest_medium,latest_campaign,latest_campaign_id,latest_content,latest_term,latest_landing_path,latest_referrer,latest_touch_at,consent_state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, f.source, f.medium, f.campaign, f.campaign_id, f.content, f.term, f.landing_path, f.referrer, at,
          t.source, t.medium, t.campaign, t.campaign_id, t.content, t.term, t.landing_path, t.referrer, at, consent, at, at);
    } else {
      // First-touch columns are never updated. Only the latest-touch columns move.
      db.prepare(`UPDATE marketing_attribution SET latest_source=?,latest_medium=?,latest_campaign=?,latest_campaign_id=?,latest_content=?,latest_term=?,latest_landing_path=?,latest_referrer=?,latest_touch_at=?,consent_state=?,updated_at=? WHERE lead_id=?`)
        .run(t.source, t.medium, t.campaign, t.campaign_id, t.content, t.term, t.landing_path, t.referrer, at, consent, at, id);
    }
    db.prepare(`INSERT INTO marketing_touchpoints(lead_id,campaign_id,event_type,source,medium,campaign_name,content,term,landing_path,referrer,occurred_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, t.campaign_id, 'lead_intake', t.source, t.medium, t.campaign, t.content, t.term, t.landing_path, t.referrer, at, '{}');
    return true;
  })();
}

// Called by public intake after the lead row exists. Errors are contained so intake always succeeds.
function recordIntake(db, leadId, rawAttribution) {
  try {
    let touch = rawAttribution;
    if (typeof touch === 'string') touch = touch ? JSON.parse(touch.slice(0, 4000)) : null;
    return recordTouch(db, leadId, touch);
  } catch (err) {
    console.error('marketing attribution skipped:', err.message);
    return false;
  }
}

// ---------- Lifecycle events from canonical handlers ----------
// Resolves the original lead through verified joins. Returns null when the chain is not unambiguous.
function leadForEstimate(db, estimateId) {
  const r = db.prepare('SELECT lead_id FROM estimates WHERE id=?').get(positiveId(estimateId));
  return r && positiveId(r.lead_id);
}
function leadForContract(db, contractId) {
  const c = db.prepare('SELECT estimate_id FROM contracts WHERE id=?').get(positiveId(contractId));
  return c && c.estimate_id ? leadForEstimate(db, c.estimate_id) : null;
}
function leadForInvoice(db, invoiceId) {
  const inv = db.prepare('SELECT project_id FROM invoices WHERE id=?').get(positiveId(invoiceId));
  if (!inv || !inv.project_id) return null;
  const p = db.prepare('SELECT contract_id FROM projects WHERE id=?').get(positiveId(inv.project_id));
  return p && p.contract_id ? leadForContract(db, p.contract_id) : null;
}

// One canonical emitter per transition. Duplicate deliveries are ignored by idempotency key.
// Unresolved chains are stored with lead_id NULL and appear in the exception list.
function emitLifecycle(db, eventType, { leadId = null, sourceModule, sourceRecordId, valueAmount = null, currency = 'USD', occurredAt, payload = {} }) {
  try {
    if (!EVENT_TYPES.includes(eventType)) return { ok: false, reason: 'unsupported event' };
    const lead = positiveId(leadId);
    const srcId = text(sourceRecordId, 120) || '';
    const key = `${eventType}:${sourceModule}:${srcId}`;
    const at = occurredAt || new Date().toISOString();
    let campaignId = null;
    if (lead) {
      const a = db.prepare('SELECT first_campaign_id FROM marketing_attribution WHERE lead_id=?').get(lead);
      campaignId = a ? a.first_campaign_id || null : null;
    }
    const r = db.prepare(`INSERT OR IGNORE INTO marketing_events(campaign_id,lead_id,event_type,source_module,source_record_id,idempotency_key,value_amount,currency,payload_json,occurred_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(campaignId, lead, eventType, text(sourceModule, 40) || 'unknown', srcId || null, key,
      money(valueAmount), text(currency, 3) || 'USD', JSON.stringify(payload || {}), at, new Date().toISOString());
    return { ok: true, inserted: r.changes > 0, unresolved: !lead };
  } catch (err) {
    console.error('marketing lifecycle event skipped:', eventType, err.message);
    return { ok: false, reason: err.message };
  }
}

// ---------- Routes ----------
function mount(app, ctx) {
  const { db, auth, logAction, clean = (v, n = 500) => String(v == null ? '' : v).slice(0, n) } = ctx;
  const now = () => new Date().toISOString();
  // Role limits (owner-only actions and the owner/manager group) are enforced once, in server.js ROLE_RULES.
  const audit = (req, action, entity, id, details = {}) => {
    const actor = (req.user && (req.user.email || req.user.id)) || 'admin';
    db.prepare('INSERT INTO marketing_audit(actor,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(String(actor), action, entity, id || null, JSON.stringify(details), now());
    if (typeof logAction === 'function') { try { logAction(req, action, 'marketing ' + entity, id || null, JSON.stringify(details).slice(0, 500)); } catch { /* audit side-channel only */ } }
  };
  const page = (q) => ({ limit: Math.min(Math.max(Number(q.limit) || 50, 1), 200), offset: Math.max(Number(q.offset) || 0, 0) });
  const handle = (res, fn) => { try { fn(); } catch (e) { console.error('marketing:', e.message); res.status(500).json({ error: 'Marketing request failed.' }); } };
  const campaignOr404 = (id) => db.prepare('SELECT * FROM marketing_campaigns WHERE id=?').get(id);

  // The page shell is served only to signed-in admins. Its data comes from the API above, which is also signed-in only.
  app.get('/admin/marketing', auth, (req, res) => res.sendFile(path.join(__dirname, 'admin-private', 'marketing.html')));
  app.get('/api/admin/marketing/summary', auth, (req, res) => handle(res, () => {
    const campaigns = db.prepare("SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) active FROM marketing_campaigns").get();
    const attributed = db.prepare('SELECT COUNT(*) n FROM marketing_attribution').get().n;
    const qualified = db.prepare(`SELECT COUNT(*) n FROM marketing_attribution a JOIN leads l ON l.id=a.lead_id WHERE l.status IN (${QUALIFIED_STATUSES.map(() => '?').join(',')})`).get(...QUALIFIED_STATUSES).n;
    const spend = db.prepare('SELECT COALESCE(SUM(amount),0) amount FROM marketing_spend').get().amount;
    res.json({
      campaigns, attributed_leads: attributed, qualified_leads: qualified, spend,
      definitions: { qualified_leads: 'Attributed leads whose lead status is ' + QUALIFIED_STATUSES.join(', ') + '.', spend: 'Imported provider spend (not yet reconciled to provider invoices).' },
      financials: 'not_reconciled',
    });
  }));

  app.get('/api/admin/marketing/campaigns', auth, (req, res) => handle(res, () => {
    const p = page(req.query);
    const total = db.prepare('SELECT COUNT(*) n FROM marketing_campaigns').get().n;
    const rows = db.prepare(`SELECT c.*, (SELECT COUNT(DISTINCT a.lead_id) FROM marketing_attribution a WHERE a.first_campaign_id=c.id) attributed_leads,
      (SELECT COALESCE(SUM(s.amount),0) FROM marketing_spend s WHERE s.campaign_id=c.id) spend
      FROM marketing_campaigns c ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(p.limit, p.offset);
    res.json({ campaigns: rows, total, limit: p.limit, offset: p.offset });
  }));

  app.get('/api/admin/marketing/campaigns/:id', auth, (req, res) => handle(res, () => {
    const c = campaignOr404(positiveId(req.params.id));
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign: c });
  }));

  app.post('/api/admin/marketing/campaigns', auth, (req, res) => handle(res, () => {
    const b = req.body || {};
    const name = text(b.name, 160);
    if (!name) return res.status(400).json({ error: 'Campaign name is required' });
    if (!CHANNELS.includes(b.channel)) return res.status(400).json({ error: 'Unsupported channel' });
    const budget = money(b.budget_amount == null ? 0 : b.budget_amount);
    if (budget === null) return res.status(400).json({ error: 'Budget must be a non-negative number' });
    const period = BUDGET_PERIODS.includes(b.budget_period) ? b.budget_period : 'monthly';
    if (b.starts_at && !isDate(b.starts_at)) return res.status(400).json({ error: 'Start date must be YYYY-MM-DD' });
    if (b.ends_at && !isDate(b.ends_at)) return res.status(400).json({ error: 'End date must be YYYY-MM-DD' });
    const locations = Array.isArray(b.target_locations) ? b.target_locations.map(x => text(x, 100)).filter(Boolean).slice(0, 30) : [];
    const t = now();
    // Campaigns are always created as drafts with no approval. Status and budget changes go through the owner-only routes.
    const r = db.prepare(`INSERT INTO marketing_campaigns(name,channel,objective,service_key,service_label,target_locations,audience,landing_path,budget_amount,budget_period,status,starts_at,ends_at,owner_email,approval_status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,'not_required',?,?)`)
      .run(name, b.channel, text(b.objective, 60) || 'lead_generation', text(b.service_key, 80), text(b.service_label, 160), JSON.stringify(locations),
        text(b.audience, 1000), landingPath(b.landing_path), budget, period, b.starts_at || null, b.ends_at || null, text((req.user || {}).email, 254), t, t);
    audit(req, 'created', 'campaign', r.lastInsertRowid, { channel: b.channel });
    res.status(201).json({ campaign: campaignOr404(r.lastInsertRowid) });
  }));

  // Editable details only. Status, approval and budget have their own owner-only routes below.
  app.patch('/api/admin/marketing/campaigns/:id', auth, (req, res) => handle(res, () => {
    const id = positiveId(req.params.id);
    const c = id && campaignOr404(id);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const b = req.body || {};
    if ('status' in b || 'approval_status' in b || 'budget_amount' in b) return res.status(400).json({ error: 'Use the status, approval or budget actions for those fields.' });
    const sets = [], vals = [];
    const fields = { name: 160, objective: 60, service_key: 80, service_label: 160, audience: 1000, landing_path: 300 };
    for (const [k, max] of Object.entries(fields)) {
      if (b[k] === undefined) continue;
      sets.push(`${k}=?`); vals.push(k === 'landing_path' ? landingPath(b[k]) : text(b[k], max));
    }
    if (b.budget_period !== undefined) { if (!BUDGET_PERIODS.includes(b.budget_period)) return res.status(400).json({ error: 'Unsupported budget period' }); sets.push('budget_period=?'); vals.push(b.budget_period); }
    if (b.starts_at !== undefined) { if (b.starts_at && !isDate(b.starts_at)) return res.status(400).json({ error: 'Start date must be YYYY-MM-DD' }); sets.push('starts_at=?'); vals.push(b.starts_at || null); }
    if (b.ends_at !== undefined) { if (b.ends_at && !isDate(b.ends_at)) return res.status(400).json({ error: 'End date must be YYYY-MM-DD' }); sets.push('ends_at=?'); vals.push(b.ends_at || null); }
    if (b.target_locations !== undefined) { sets.push('target_locations=?'); vals.push(JSON.stringify(Array.isArray(b.target_locations) ? b.target_locations.map(x => text(x, 100)).filter(Boolean).slice(0, 30) : [])); }
    if (!sets.length) return res.status(400).json({ error: 'No editable fields supplied' });
    sets.push('updated_at=?'); vals.push(now());
    db.prepare(`UPDATE marketing_campaigns SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
    audit(req, 'updated', 'campaign', id, { fields: sets.map(s => s.split('=')[0]) });
    res.json({ campaign: campaignOr404(id) });
  }));

  // Owner only: changing the budget. Budget changes are recorded with the old and new values.
  app.post('/api/admin/marketing/campaigns/:id/budget', auth, (req, res) => handle(res, () => {
    const id = positiveId(req.params.id);
    const c = id && campaignOr404(id);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const amount = money((req.body || {}).budget_amount);
    if (amount === null) return res.status(400).json({ error: 'Budget must be a non-negative number' });
    db.prepare('UPDATE marketing_campaigns SET budget_amount=?, updated_at=? WHERE id=?').run(amount, now(), id);
    audit(req, 'budget changed', 'campaign', id, { from: c.budget_amount, to: amount });
    res.json({ campaign: campaignOr404(id) });
  }));

  // Owner only: approval is required before a campaign can be activated.
  app.post('/api/admin/marketing/campaigns/:id/approve', auth, (req, res) => handle(res, () => {
    const id = positiveId(req.params.id);
    if (!id || !campaignOr404(id)) return res.status(404).json({ error: 'Campaign not found' });
    db.prepare("UPDATE marketing_campaigns SET approval_status='approved', updated_at=? WHERE id=?").run(now(), id);
    audit(req, 'approved', 'campaign', id, {});
    res.json({ campaign: campaignOr404(id) });
  }));

  // Owner only. This sets Bright Clean's internal status. It does not start, pause or change any ad account.
  app.post('/api/admin/marketing/campaigns/:id/status', auth, (req, res) => handle(res, () => {
    const id = positiveId(req.params.id);
    const c = id && campaignOr404(id);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const next = (req.body || {}).status;
    if (!CAMPAIGN_STATUSES.includes(next)) return res.status(400).json({ error: 'Unsupported status' });
    if (next === 'active' && (c.approval_status !== 'approved' || !(c.budget_amount > 0))) {
      return res.status(409).json({ error: 'A campaign needs approval and a budget above zero before it can be activated.' });
    }
    db.prepare('UPDATE marketing_campaigns SET status=?, updated_at=? WHERE id=?').run(next, now(), id);
    audit(req, 'status changed', 'campaign', id, { from: c.status, to: next });
    res.json({ campaign: campaignOr404(id), note: 'Internal status only. No ad account was changed.' });
  }));

  app.get('/api/admin/marketing/leads', auth, (req, res) => handle(res, () => {
    const p = page(req.query);
    const total = db.prepare('SELECT COUNT(*) n FROM marketing_attribution').get().n;
    const rows = db.prepare(`SELECT l.id, l.kind, l.contact_name, l.company, l.status, l.origin, l.created_at,
        a.first_source, a.first_medium, a.first_campaign, a.first_campaign_id, a.first_touch_at,
        a.latest_source, a.latest_campaign, a.latest_campaign_id, a.latest_touch_at
      FROM marketing_attribution a JOIN leads l ON l.id=a.lead_id ORDER BY l.created_at DESC LIMIT ? OFFSET ?`).all(p.limit, p.offset);
    res.json({ leads: rows, total, limit: p.limit, offset: p.offset });
  }));

  // Attribution detail for one lead (for the Lead Portal detail panel). Contact fields are not included.
  app.get('/api/admin/marketing/leads/:id/attribution', auth, (req, res) => handle(res, () => {
    const id = positiveId(req.params.id);
    const a = id && db.prepare('SELECT * FROM marketing_attribution WHERE lead_id=?').get(id);
    if (!a) return res.status(404).json({ error: 'No attribution recorded for this lead' });
    const touches = db.prepare('SELECT event_type,source,medium,campaign_name,landing_path,referrer,occurred_at FROM marketing_touchpoints WHERE lead_id=? ORDER BY occurred_at, id').all(id);
    res.json({ attribution: a, touchpoints: touches, model: a.attribution_model });
  }));

  app.get('/api/admin/marketing/campaigns/:id/metrics', auth, (req, res) => handle(res, () => {
    const id = positiveId(req.params.id);
    const c = id && campaignOr404(id);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const spend = db.prepare('SELECT COALESCE(SUM(amount),0) amount FROM marketing_spend WHERE campaign_id=?').get(id).amount;
    const attributed = db.prepare('SELECT COUNT(DISTINCT lead_id) n FROM marketing_attribution WHERE first_campaign_id=?').get(id).n;
    const statuses = db.prepare('SELECT l.status, COUNT(DISTINCT l.id) count FROM marketing_attribution a JOIN leads l ON l.id=a.lead_id WHERE a.first_campaign_id=? GROUP BY l.status').all(id);
    res.json({ campaign: c, spend, attributed_leads: attributed, statuses, attribution_model: 'first_touch', financials: 'not_reconciled' });
  }));

  app.get('/api/admin/marketing/content', auth, (req, res) => handle(res, () => {
    const p = page(req.query);
    res.json({ content: db.prepare('SELECT * FROM marketing_content ORDER BY COALESCE(scheduled_at,created_at) DESC LIMIT ? OFFSET ?').all(p.limit, p.offset) });
  }));

  app.post('/api/admin/marketing/content', auth, (req, res) => handle(res, () => {
    const b = req.body || {};
    const title = text(b.title, 180), body = clean(b.body, 20000).trim();
    if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });
    const campaignId = b.campaign_id == null || b.campaign_id === '' ? null : positiveId(b.campaign_id);
    if (b.campaign_id && (!campaignId || !campaignOr404(campaignId))) return res.status(400).json({ error: 'Campaign not found' });
    if (b.scheduled_at && Number.isNaN(Date.parse(b.scheduled_at))) return res.status(400).json({ error: 'Scheduled time is not a valid date' });
    const t = now();
    const r = db.prepare('INSERT INTO marketing_content(campaign_id,title,content_type,channel,body,status,scheduled_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(campaignId, title, text(b.content_type, 50) || 'social_post', text(b.channel, 50) || 'facebook', body, 'draft', b.scheduled_at || null, text((req.user || {}).email, 254), t, t);
    audit(req, 'created', 'content', r.lastInsertRowid, {});
    res.status(201).json({ content: db.prepare('SELECT * FROM marketing_content WHERE id=?').get(r.lastInsertRowid) });
  }));

  // Owner only: approval of content. Nothing is published from here; publishing is not built.
  app.post('/api/admin/marketing/content/:id/approve', auth, (req, res) => handle(res, () => {
    const id = positiveId(req.params.id);
    if (!id || !db.prepare('SELECT id FROM marketing_content WHERE id=?').get(id)) return res.status(404).json({ error: 'Content not found' });
    db.prepare("UPDATE marketing_content SET status='approved', approved_by=?, updated_at=? WHERE id=?").run(text((req.user || {}).email, 254), now(), id);
    audit(req, 'approved', 'content', id, {});
    res.json({ content: db.prepare('SELECT * FROM marketing_content WHERE id=?').get(id) });
  }));

  // Spend import. Each row must name an existing campaign. Re-importing the same row is ignored (idempotent).
  app.post('/api/admin/marketing/spend/import', auth, (req, res) => handle(res, () => {
    const b = req.body || {};
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (!rows.length || rows.length > 1000) return res.status(400).json({ error: 'Provide 1 to 1000 spend rows' });
    const provider = text(b.provider, 40);
    if (!provider) return res.status(400).json({ error: 'Provider is required' });
    const batch = text(b.import_batch, 100) || crypto.randomBytes(6).toString('hex');
    const insert = db.prepare('INSERT OR IGNORE INTO marketing_spend(campaign_id,provider,spend_date,amount,currency,provider_record_id,import_batch,created_at) VALUES(?,?,?,?,?,?,?,?)');
    let inserted = 0;
    // Every row is checked before anything is written, so one bad row imports nothing.
    const checked = [];
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i] || {};
      const campaignId = positiveId(x.campaign_id);
      const amount = money(x.amount);
      let problem = null;
      if (!campaignId || !campaignOr404(campaignId)) problem = 'campaign not found';
      else if (amount === null) problem = 'amount must be a non-negative number';
      else if (!isDate(x.spend_date)) problem = 'date must be YYYY-MM-DD';
      // The provider record ID is what makes a re-import safe. Without it, SQLite would not treat the row as a duplicate.
      const recordId = text(x.provider_record_id, 180);
      if (!problem && !recordId) problem = 'provider record ID is required so re-imports are not counted twice';
      if (problem) return res.status(400).json({ error: `Row ${i + 1}: ${problem}. Nothing was imported.` });
      checked.push({ campaignId, amount, date: x.spend_date, currency: text(x.currency, 3) || 'USD', recordId });
    }
    db.transaction(() => {
      for (const r of checked) inserted += insert.run(r.campaignId, provider, r.date, r.amount, r.currency, r.recordId, batch, now()).changes;
    })();
    audit(req, 'imported', 'spend', null, { provider, rows: rows.length, inserted });
    res.json({ received: rows.length, inserted, duplicates_ignored: rows.length - inserted, import_batch: batch });
  }));

  // Owner only: unresolved lifecycle events. These are never attached to a lead by guessing.
  app.get('/api/admin/marketing/events/exceptions', auth, (req, res) => handle(res, () => {
    const p = page(req.query);
    res.json({ events: db.prepare('SELECT id,event_type,source_module,source_record_id,value_amount,occurred_at FROM marketing_events WHERE lead_id IS NULL ORDER BY id DESC LIMIT ? OFFSET ?').all(p.limit, p.offset) });
  }));

  // Connection metadata only. No provider is connected in this release, so the list is empty.
  app.get('/api/admin/marketing/connections', auth, (req, res) => handle(res, () => {
    res.json({ connections: db.prepare('SELECT id,provider,account_label,status,last_sync_at,last_error FROM marketing_connections ORDER BY provider').all() });
  }));
}

module.exports = mount;
module.exports.migrate = migrate;
module.exports.recordTouch = recordTouch;
module.exports.recordIntake = recordIntake;
module.exports.emitLifecycle = emitLifecycle;
module.exports.leadForEstimate = leadForEstimate;
module.exports.leadForContract = leadForContract;
module.exports.leadForInvoice = leadForInvoice;
module.exports.CHANNELS = CHANNELS;
module.exports.EVENT_TYPES = EVENT_TYPES;
