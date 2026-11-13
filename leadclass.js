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

// The reply draft. No prices. Only asks for what is missing.
function draftFor(l, seg, intent) {
  const co = l.company || 'your company';
  const hi = firstName(l) ? `Hello ${firstName(l)},` : 'Hello,';
  const intro = `This is ${COMPANY.name}, a commercial cleaning company in ${COMPANY.city}.`;
  const sign = `\n\nBright Clean Team\n${COMPANY.name} Sev Inc.\n${COMPANY.phone}\n${COMPANY.email}`;
  if (seg === 'post_construction' && intent === 'bidder_list') {
    return {
      subject: `Bright Clean: bidder list and current projects for ${co}`,
      body: `${hi}\n\n${intro} We do post-construction cleaning for general contractors: rough-in, final clean, touch-up and punch list, and make-ready for multifamily and senior living.\n\nWe would like to be added to ${co}'s bidder list for post-construction cleaning. Could you tell us:\n1. How do you add a cleaning subcontractor to your bid list, and is there a registration form or prequalification packet?\n2. Do you have projects in construction or starting soon that need cleaning phases? If so, please send the project name, city, cleaning phases (rough, final, punch) and the bid due date, and we will bid on them.\n3. Who should we send bids to?\n\nWe can send our insurance certificate, licenses, safety program and references on request.${sign}`
    };
  }
  if (seg === 'post_construction') {
    return {
      subject: `Bright Clean: post-construction cleaning for ${co}`,
      body: `${hi}\n\n${intro} We do post-construction cleaning for general contractors and developers.\n\nDo you have projects that need rough, final, touch-up or make-ready cleaning? Please send the project name, address, phases needed and the target dates, and we will schedule a walkthrough and send a proposal. We can also send our insurance and licensing on request.${sign}`
    };
  }
  const area = { multifamily: 'multifamily common areas and unit turnovers', single_family: 'single-family homes', residential: 'residential cleaning', construction: 'construction cleaning', commercial: 'commercial cleaning' }[seg] || 'commercial and residential cleaning';
  return {
    subject: `Bright Clean: cleaning services for ${co}`,
    body: `${hi}\n\n${intro} We provide ${area}.\n\n${intent === 'bid_request' ? 'Thanks for the request. To put together a price we need: the project name and address, the scope (for example the number of units or square footage), the cleaning frequency or phases, and the bid due date. We can also set up a walkthrough.' : 'We would like to learn about your projects and what you need cleaned. A short call or a walkthrough would be a good first step.'}${sign}`
  };
}

function classify(l) {
  const seg = segmentOf(l), intent = intentOf(l), recipient = recipientOf(l.email);
  const perm = permittedAction(l, seg, intent, recipient);
  const notes = [];
  if (seg === 'unknown') notes.push('No segment words found. Ask the contact what kind of work they do.');
  if (intent === 'bidder_list') notes.push('Bidder-list request: answer the process question and ask for current projects to bid on.');
  const draft = intent === 'job_application' ? null : draftFor(l, seg, intent);
  return { segment: seg, segment_label: SEGMENT_LABEL[seg], intent, intent_label: INTENT_LABEL[intent], recipient, action: perm.action, action_why: perm.why, notes, draft };
}

function mount(app, ctx) {
  const { db, auth } = ctx;
  app.get('/api/admin/leads/:id/classification', auth, (req, res) => {
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(Number(req.params.id));
    if (!l) return res.status(404).json({ error: 'Lead not found.' });
    res.json(classify(l));
  });
}

module.exports = { classify, segmentOf, intentOf, recipientOf, permittedAction, draftFor, JOB_INBOX, SEGMENTS, mount };
