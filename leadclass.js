// Lead classification: what kind of work the lead is (segment), what they are asking for (intent),
// whose address it is (a person, a company inbox, or a job inbox), and what the system may do about it.
// Rule-based on purpose: it works without the AI service, and every answer can be explained from the words in the lead.
// Nothing here sends email. It returns a draft and a permitted action; staff or an explicit setting decide what goes out.

const JOB_INBOX = /^(careers?|jobs?|job-?apply|hr|human-?resources|hiring|recruit\w*|employment|apply|applications?)$/i;
const ROLE_INBOX = /^(info|hello|contact|admin|office|billing|accounts?|accounting|sales|support|webmaster|no-?reply|donotreply|marketing|estimating|bids?|bidding|general|mail|team|service|services|reception|inquiries|inquiry)$/i;
const SEGMENTS = ['post_construction', 'multifamily', 'single_family', 'residential', 'construction', 'commercial', 'unknown'];
const SEGMENT_LABEL = {
  post_construction: 'Post-construction cleaning', multifamily: 'Multifamily', single_family: 'Single-family',
  residential: 'Residential', construction: 'Construction (new build, general contractor)', commercial: 'Commercial', unknown: 'Not clear yet'
};
const INTENT_LABEL = { bidder_list: 'Asks to be added to a bidder / vendor list', bid_request: 'Asks for a bid, quote or walkthrough', inquiry: 'General inquiry or introduction', job_application: 'Job application (not a sales lead)' };
const COMPANY = { name: 'Bright Clean', phone: '+1 (515) 303-3024', email: 'info@brightclean.net', city: 'Des Moines, Iowa' };

const SEGMENT_RULES = [
  ['post_construction', /post[\s-]?construction|construction clean|final clean|rough[\s-]?in clean|rough clean|punch[\s-]?list|touch[\s-]?up clean|make[\s-]?ready|turnover clean|builder clean/i],
  ['multifamily', /multi[\s-]?family|apartment|property manag|unit turn|\bunits?\b|condo|senior living|affordable housing|\bhoa\b/i],
  ['single_family', /single[\s-]?family|\bhouse\b|homeowner|home owner|townhome|single[\s-]?home/i],
  ['residential', /residential|\bhome clean|house clean|maid/i],
  ['construction', /general contractor|\bGC\b|construction|builder|contractor|subcontract|developer|development/i],
  ['commercial', /commercial|office|janitorial|retail|medical|clinic|school|warehouse|facility|restaurant|church|bank/i]
];
const INTENT_RULES = [
  ['bidder_list', /bidder list|bid list|vendor (list|registration|application|form)|pre-?qualif|subcontractor (list|registration|application)|add (us|me|my company|our company|our firm) to|become (a |an )?(approved |preferred |qualified )?(vendor|subcontractor)|approved vendor|preferred vendor|qualified vendor/i],
  ['bid_request', /\bbids?\b|\bquotes?\b|\bestimates?\b|proposal|\brfp\b|\brfq\b|pricing|\bprice\b|walk-?through|site visit/i]
];

function text(l) {
  return [l.company, l.project_name, l.project_type, l.service, l.details, l.intake, l.contact_name].filter(Boolean).join(' \n ');
}

function segmentOf(l) {
  const t = text(l);
  for (const [seg, re] of SEGMENT_RULES) if (re.test(t)) return seg;
  return 'unknown';
}

function intentOf(l) {
  if (l.kind === 'career') return 'job_application';
  const t = text(l);
  for (const [intent, re] of INTENT_RULES) if (re.test(t)) return intent;
  return 'inquiry';
}

function localPart(address) { return String(address || '').trim().toLowerCase().split('@')[0] || ''; }

function recipientOf(address) {
  const a = String(address || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) return { address: a, type: 'missing' };
  const lp = localPart(a);
  if (JOB_INBOX.test(lp)) return { address: a, type: 'job_inbox' };
  if (ROLE_INBOX.test(lp)) return { address: a, type: 'company_inbox' };
  return { address: a, type: 'person' };
}

// Who may receive a sales email, and whether it can go automatically.
function permittedAction(l, seg, intent, recipient) {
  if (intent === 'job_application') return { action: 'none', why: 'Job applicants are not sales leads. Route to hiring, never a sales email.' };
  if (recipient.type === 'missing') return { action: 'needs_contact', why: 'No usable email address. Find the estimating or project contact first.' };
  if (recipient.type === 'job_inbox') return { action: 'needs_contact', why: 'This is a job inbox (careers, HR). Do not send sales email there. Find the estimating or preconstruction contact.' };
  const staffAdded = ['manual', 'import', 'outbound'].includes(l.origin) || !l.origin;
  if (recipient.type === 'company_inbox') return { action: 'draft_for_review', why: 'This is a shared company inbox. Confirm the right person before anything is sent.' };
  if (staffAdded) return { action: 'draft_for_review', why: 'Staff added this contact. Review the draft before it is sent; nothing is sent automatically.' };
  return { action: 'reply_allowed', why: 'The lead asked us directly. A reply can go out after staff review.' };
}

function firstName(l) { return String(l.contact_name || '').trim().split(/\s+/)[0] || ''; }

// Outreach runs in two stages, and this only drafts the note. Nothing here sends email.
//  - First note ("intro"): who we are, what we clean, how we work, how we can help with their project, and what we need to know.
//  - Follow-up ("follow_up"): sent after a first note went out to this address. Asks to be added to their bidder list for future
//    projects and construction cleaning on single-family homes, commercial buildings and multifamily properties.
const CO_PROFILE = 'We are a cleaning company in Des Moines, Iowa. We clean single-family homes, apartment and multifamily properties, and commercial buildings, and we handle construction cleanup: rough, final and touch-up cleaning after a build or renovation.';
const PRICING_LINE = 'We do not send prices by email. One of our people will walk the job with you and send a written proposal with one price.';
const HOW_WE_WORK = 'We start with a walkthrough, then send one written proposal with one price, so there are no surprises. Once you approve, we schedule the work, and our crew checks it against a written checklist before we call it done.';

// The reply draft. No prices. Only asks for what is missing.
function draftFor(l, seg, intent, stage = 'intro') {
  const co = l.company || 'your company';
  const hi = firstName(l) ? `Hello ${firstName(l)},` : 'Hello,';
  const intro = `This is ${COMPANY.name}. ${CO_PROFILE}`;
  const sign = `\n\nBright Clean Team\n${COMPANY.name} Sev Inc.\n${COMPANY.phone}\n${COMPANY.email}`;
  if (seg === 'post_construction' && intent === 'bidder_list') {
    return {
      subject: `Bright Clean: bidder list and current projects for ${co}`,
      body: `${hi}\n\n${intro} We do post-construction cleaning for general contractors: rough-in, final clean, touch-up and punch list, and make-ready for multifamily and senior living.\n\nWe would like to be added to ${co}'s bidder list for post-construction cleaning. Could you tell us:\n1. How do you add a cleaning subcontractor to your bid list, and is there a registration form or prequalification packet?\n2. Do you have current or upcoming projects that need cleaning, and when are they due?\n3. Who should we contact for bid invitations?\n\nThank you for your time.${sign}`
    };
  }
  if (stage === 'follow_up' || intent === 'bidder_list') {
    return {
      subject: `Bright Clean: bidder list for ${co}`,
      body: `${hi}\n\nWe reached out recently about cleaning services. ${CO_PROFILE}\n\nWe would like to be added to your bidder list for upcoming projects, and for any construction cleaning you need on single-family homes, commercial buildings or multifamily properties.\n\nCould you tell us:\n1. How do you add a cleaning vendor to your list, and is there a registration form or prequalification packet?\n2. Which upcoming projects will need cleaning, and when are they due?\n3. Who should we contact about bid invitations?\n\nThank you for your time.${sign}`
    };
  }
  if (seg === 'post_construction') {
    return {
      subject: `Bright Clean: post-construction cleaning for ${co}`,
      body: `${hi}\n\n${intro} We do post-construction cleaning for general contractors and developers. ${HOW_WE_WORK} ${PRICING_LINE}\n\nDo you have projects that need rough, final, touch-up or make-ready cleaning? Please send the project name, address, phases needed and the target dates, and we will schedule a walkthrough and send a proposal. We can also send our insurance and licensing on request.${sign}`
    };
  }
  const area = { multifamily: 'apartment and multifamily properties, including common areas and unit turnovers', single_family: 'single-family homes, including move-in, move-out and recurring cleaning', residential: 'residential cleaning', construction: 'construction cleanup', commercial: 'commercial cleaning' }[seg] || 'single-family homes, multifamily properties and commercial buildings';
  const ask = intent === 'bid_request'
    ? 'Thanks for the request. To put together a price we need: the project name and address, the scope (for example the number of units or square footage), the cleaning frequency or phases, and the bid due date. We can also set up a walkthrough.'
    : 'We would like to learn about your project and what you need cleaned. Would a short call or a walkthrough work for you?';
  return {
    subject: `Bright Clean: cleaning services for ${co}`,
    body: `${hi}\n\n${intro} For you, that means ${area}. ${HOW_WE_WORK} ${PRICING_LINE}\n\n${ask}${sign}`
  };
}

function classify(l, stage = 'intro') {
  const seg = segmentOf(l), intent = intentOf(l), recipient = recipientOf(l.email);
  const perm = permittedAction(l, seg, intent, recipient);
  const notes = [];
  if (seg === 'unknown') notes.push('No segment words found. Ask the contact what kind of work they do.');
  if (intent === 'bidder_list') notes.push('Bidder-list request: answer the process question and ask for current projects to bid on.');
  const draft = intent === 'job_application' ? null : draftFor(l, seg, intent, stage);
  return { segment: seg, segment_label: SEGMENT_LABEL[seg], intent, intent_label: INTENT_LABEL[intent], recipient, action: perm.action, action_why: perm.why, notes, draft };
}

// A first email needs a real person to write to, and the job's address. Anything missing is listed for staff.
const CONTACT_FIELDS = [['contact_name', 'Contact name'], ['company', 'Company'], ['email', 'Email'], ['phone', 'Phone'], ['address', 'Site or mailing address']];
function contactCheck(l) {
  const missing = CONTACT_FIELDS.filter(([k]) => !String(l[k] || '').trim()).map(([, label]) => label);
  if ((l.contact_name || '').trim() && (l.contact_name || '').trim().split(/\s+/).length < 2) missing.push('Full name (first and last)');
  const rec = recipientOf(l.email);
  if (l.email && rec.type === 'job_inbox') missing.push('A person to write to (this is a job inbox)');
  else if (l.email && rec.type === 'company_inbox') missing.push('A person to write to (this is a shared company inbox)');
  return { complete: missing.length === 0, missing, recipient_type: rec.type };
}

// The first email must never mention a price. The check is a backstop; the template itself has no numbers.
function introIsSafe(draft) {
  return !!draft && !/\$\s?\d|\b\d[\d,]*(\.\d+)?\s?(\/|per)\s?(sq|sf|hour|hr|visit|month|unit)/i.test(draft.body + ' ' + draft.subject);
}

// Automatic introductions. The first email to a complete lead is always the introduction (never a follow-up),
// and a lead that has been contacted at all is never sent one again by this sweep. Owners can switch it off with the
// setting "auto_intro_email" (Settings > Automation). Limits: only leads from the last 14 days, at most 10 sends per run.
const INTRO_WINDOW_DAYS = 14, INTRO_MAX_PER_RUN = 10;
// A lead that has had an introduction is never introduced again (checked in the audit log too, so it holds even if mail logging is off).
const introAlready = (db, id) => !!db.prepare("SELECT 1 FROM audit_log WHERE entity='lead' AND entity_id=? AND action='sent introduction email'").get(id);
async function sendIntro(db, mailer, l) {
  const c = contactCheck(l);
  if (!c.complete || c.recipient_type !== 'person') return { sent: false, reason: 'contact incomplete' };
  if (db.prepare("SELECT COUNT(*) n FROM email_log WHERE lower(to_addr)=lower(?) AND status='sent'").get(l.email).n > 0 || introAlready(db, l.id)) return { sent: false, reason: 'already contacted' };
  const draft = draftFor(l, segmentOf(l), intentOf(l), 'intro');
  if (!introIsSafe(draft)) return { sent: false, reason: 'price guard' };
  try {
    const r = await mailer.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || 'info@brightclean.net', to: l.email, subject: draft.subject, text: draft.body, automated: true });
    if (r && r.suppressed) return { sent: false, reason: 'blocked: ' + r.reason };
    db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run('automation', 'sent introduction email', 'lead', l.id, draft.subject, new Date().toISOString());
    return { sent: true, subject: draft.subject };
  } catch (e) { return { sent: false, reason: e.message }; }
}
function startIntroSweep(db, getMailer, isOn) {
  let busy = false;
  const sweep = async () => {
    if (busy || !isOn()) return;
    busy = true;
    try {
      const m = getMailer && getMailer(); if (!m) return;
      const since = new Date(Date.now() - INTRO_WINDOW_DAYS * 864e5).toISOString();
      const rows = db.prepare("SELECT * FROM leads WHERE status IN ('New','In Review') AND email IS NOT NULL AND email<>'' AND created_at>=? ORDER BY id LIMIT 100").all(since);
      let n = 0;
      for (const l of rows) {
        if (n >= INTRO_MAX_PER_RUN) break;
        if (/\btest\b/i.test(`${l.contact_name || ''} ${l.company || ''}`)) continue;
        if ((await sendIntro(db, m, l)).sent) n++;
      }
    } catch (e) { console.error('intro sweep failed:', e.message); }
    finally { busy = false; }
  };
  const t = setInterval(sweep, Number(process.env.INTRO_SWEEP_MS) || 600000);
  t.unref();
  return sweep;
}

function mount(app, ctx) {
  const { db, auth, getMailer, logAction } = ctx;
  const introOn = () => { const r = db.prepare("SELECT value FROM ai_settings WHERE key='auto_intro_email'").get(); return r ? r.value === '1' : true; };
  if (process.env.INTRO_SWEEP_MS !== '0') startIntroSweep(db, getMailer, introOn);
  const leadOf = id => db.prepare('SELECT * FROM leads WHERE id=?').get(Number(id));
  const priorSends = email => email ? db.prepare("SELECT COUNT(*) n FROM email_log WHERE lower(to_addr)=lower(?) AND status='sent'").get(email).n : 0;

  app.get('/api/admin/leads/:id/classification', auth, (req, res) => {
    const l = leadOf(req.params.id);
    if (!l) return res.status(404).json({ error: 'Lead not found.' });
    // First note if nothing has been sent to this address; otherwise a follow-up. Drafts only.
    const sent = priorSends(l.email);
    res.json({ ...classify(l, sent > 0 ? 'follow_up' : 'intro'), stage: sent > 0 ? 'follow_up' : 'intro', prior_sends: sent });
  });

  // Is this lead ready for a first email? Says what is missing, so staff can fill it in.
  app.get('/api/admin/leads/:id/contact-check', auth, (req, res) => {
    const l = leadOf(req.params.id);
    if (!l) return res.status(404).json({ error: 'Lead not found.' });
    const c = contactCheck(l), sent = priorSends(l.email);
    res.json({ ...c, prior_sends: sent, ready: c.complete && c.recipient_type === 'person' && sent === 0 });
  });

  // One introduction email, sent only when a person clicks Send and the contact is complete. No prices in it.
  app.post('/api/admin/leads/:id/intro-email', auth, async (req, res) => {
    const l = leadOf(req.params.id);
    if (!l) return res.status(404).json({ error: 'Lead not found.' });
    if (!(req.body && req.body.confirm === true)) return res.status(400).json({ error: 'Confirm the send first.' });
    const c = contactCheck(l);
    if (!c.complete) return res.status(409).json({ error: `Add the missing details first: ${c.missing.join(', ')}.`, missing: c.missing });
    if (c.recipient_type !== 'person') return res.status(409).json({ error: 'Send only to a person, not a shared or job inbox.' });
    if (priorSends(l.email) > 0 || introAlready(db, l.id)) return res.status(409).json({ error: 'This contact was already introduced. Use the follow-up note instead.' });
    const m = getMailer && getMailer();
    if (!m) return res.status(503).json({ error: 'Email is not set up, so nothing was sent.' });
    const draft = draftFor(l, segmentOf(l), intentOf(l), 'intro');
    if (!introIsSafe(draft)) return res.status(409).json({ error: 'The introduction text mentions a price, so it was not sent. A person should write that note.' });
    try {
      const r = await m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || 'info@brightclean.net', to: l.email, subject: draft.subject, text: draft.body, automated: true });
      if (r && r.suppressed) return res.status(409).json({ error: `Not sent: this address is blocked (${r.reason}).` });
      db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run(req.user?.email || 'admin', 'sent introduction email', 'lead', l.id, draft.subject, new Date().toISOString());
      res.json({ ok: true, subject: draft.subject });
    } catch (e) {
      res.status(502).json({ error: 'The email could not be sent: ' + e.message });
    }
  });
}

module.exports = { classify, segmentOf, intentOf, recipientOf, permittedAction, draftFor, contactCheck, introIsSafe, sendIntro, startIntroSweep, JOB_INBOX, SEGMENTS, mount };
