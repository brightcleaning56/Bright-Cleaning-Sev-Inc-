// Lead classification: segment, intent, recipient type and permitted action, plus reply drafts. Rules only; no mail is sent.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'leadclass'));
const ES = require(path.join(ROOT, 'emailsuppress'));
const results = []; const assert = (c, m) => { if (!c) throw new Error(m); };
function check(name, fn) {
  try { const ev = fn(); results.push({ name, status: 'PASS', evidence: ev }); console.log('PASS  ' + name); }
  catch (e) { results.push({ name, status: 'FAIL', evidence: e.message }); console.log('FAIL  ' + name + '  -> ' + e.message); }
}

const NELSON = { kind: 'bid', contact_name: '', company: 'Nelson Construction & Development', email: 'careers@nelsonconstruct.com', origin: 'website',
  details: 'Multifamily and senior living post-construction cleaning and make-ready' };

check('Segment: post-construction GC is not mistaken for multifamily or construction', () => {
  assert(C.segmentOf(NELSON) === 'post_construction', 'nelson got ' + C.segmentOf(NELSON));
  assert(C.segmentOf({ company: 'Ridge Builders', details: 'New construction, final clean for a new office' }) === 'post_construction', 'final clean');
  assert(C.segmentOf({ details: 'Need touch-up and punch list cleaning' }) === 'post_construction', 'punch list');
  return 'post-construction wording wins over multifamily and construction';
});

check('Segment: each type is recognised', () => {
  const cases = [
    [{ details: 'Weekly cleaning of 120 units at an apartment community' }, 'multifamily'],
    [{ details: 'Single-family home, cleaning every two weeks' }, 'single_family'],
    [{ details: 'House cleaning for our townhome' }, 'single_family'],
    [{ details: 'Residential maid service, one-time' }, 'residential'],
    [{ details: 'General contractor building a new warehouse' }, 'construction'],
    [{ details: 'Janitorial for our office building, 40,000 sq ft' }, 'commercial'],
    [{ details: 'Hello, I have a question' }, 'unknown']
  ];
  for (const [l, want] of cases) assert(C.segmentOf(l) === want, `${l.details} -> ${C.segmentOf(l)}, wanted ${want}`);
  return `${cases.length} segment cases`;
});

check('Intent: a bidder-list request is told apart from a bid request and a general inquiry', () => {
  assert(C.intentOf({ details: 'Please add us to your bidder list for post-construction cleaning' }) === 'bidder_list', 'bidder list');
  assert(C.intentOf({ details: 'Vendor registration form for subcontractors?' }) === 'bidder_list', 'vendor registration');
  assert(C.intentOf({ details: 'Can you send a bid for the Terrell hospital project?' }) === 'bid_request', 'bid');
  assert(C.intentOf({ details: 'Hi, who do I talk to about your services?' }) === 'inquiry', 'inquiry');
  assert(C.intentOf({ kind: 'career', details: 'Janitor position' }) === 'job_application', 'career');
  return 'bidder_list / bid_request / inquiry / job_application';
});

check('Recipient: a job inbox is never treated as a sales contact', () => {
  assert(C.recipientOf('careers@nelsonconstruct.com').type === 'job_inbox', 'careers');
  assert(C.recipientOf('hr@acme.com').type === 'job_inbox', 'hr');
  assert(C.recipientOf('info@acme.com').type === 'company_inbox', 'info');
  assert(C.recipientOf('kim.bid@acme.com').type === 'person', 'person');
  assert(C.recipientOf('not-an-address').type === 'missing', 'missing');
  return 'job / company / person / missing';
});

check('Action: Nelson (job inbox) needs a real contact and sends nothing', () => {
  const r = C.classify(NELSON);
  assert(r.action === 'needs_contact', 'action ' + r.action);
  assert(r.intent !== 'job_application', 'a GC is not a job applicant');
  return 'needs_contact';
});

check('Action: staff-added contacts are reviewed, never sent automatically', () => {
  const r = C.classify({ contact_name: 'Kim Bid', company: 'Acme GC', email: 'kim@acmegc.com', origin: 'outbound', details: 'post-construction cleaning' });
  assert(r.action === 'draft_for_review', 'action ' + r.action);
  return 'draft_for_review';
});

check('Action: a person who asked us directly can get a reply after review', () => {
  const r = C.classify({ contact_name: 'Lee Customer', company: 'Lee Homes', email: 'lee@leehomes.com', origin: 'website', kind: 'inquiry', details: 'Do you clean single-family homes?' });
  assert(r.action === 'reply_allowed', 'action ' + r.action);
  return 'reply_allowed';
});

check('Draft: bidder-list reply asks for the process and for current projects, with no prices', () => {
  const r = C.classify({ contact_name: 'Kim Bid', company: 'Acme GC', email: 'kim@acmegc.com', origin: 'outbound', details: 'Please add us to your bidder list for post-construction cleaning' });
  assert(r.draft && /bidder list/i.test(r.draft.body), 'asks for bidder list');
  assert(/projects/i.test(r.draft.body) && /bid/i.test(r.draft.body), 'asks about projects to bid on');
  assert(!/\$\s?\d/.test(r.draft.body), 'no prices');
  assert(/Hello Kim/.test(r.draft.body), 'uses first name');
  return 'bidder-list draft is complete and has no prices';
});

check('Draft: no draft is written for a job applicant', () => {
  const r = C.classify({ kind: 'career', contact_name: 'Sam', email: 'sam@example.com', details: 'Janitor position' });
  assert(r.draft === null, 'no draft');
  return 'job applicants get no sales draft';
});

check('Gate: automated email to a job inbox is blocked', () => {
  const g = ES.gate({ prepare: () => ({ get: () => null }) }, { to: 'careers@nelsonconstruct.com', automated: true });
  assert(g.blocked === true && g.reason === 'job_inbox', 'blocked ' + JSON.stringify(g));
  return 'job_inbox blocked';
});

const failed = results.filter(r => r.status === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
