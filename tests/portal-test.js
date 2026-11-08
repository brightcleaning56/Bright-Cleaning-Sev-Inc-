// Tests the client portal backend against an in-memory database and a fake mailer.
const path = require('path');
const root = process.argv[2];
process.env.JWT_SECRET = 'test-secret-for-portal-tests-only-0123456789';
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
const db = new Database(':memory:');
db.exec(`
CREATE TABLE estimates(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, project_name TEXT, status TEXT, proposal_total REAL, public_token TEXT, created_at TEXT, lead_id INTEGER, customer_name TEXT, company TEXT, site_address TEXT, scope TEXT, area_sqft REAL, line_items TEXT, terms TEXT, tax_pct REAL, expires_on TEXT, decided_at TEXT, decline_reason TEXT, signer_name TEXT, signer_title TEXT, signed_at TEXT, updated_at TEXT, decision_ip TEXT, decision_agent TEXT, line_items_total REAL, use_line_items INTEGER);
CREATE TABLE contracts(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, title TEXT, value REAL, status TEXT, signature_status TEXT, public_token TEXT, created_at TEXT, signed_at TEXT, customer_name TEXT, company TEXT);
CREATE TABLE invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, invoice_number TEXT, amount REAL, paid_amount REAL DEFAULT 0, due_date TEXT, status TEXT, created_at TEXT);
CREATE TABLE customers(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT);
CREATE TABLE leads(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, kind TEXT, status TEXT, contact_name TEXT, company TEXT, phone TEXT, address TEXT, service TEXT, project_name TEXT, details TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE projects(id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER, name TEXT, status TEXT, progress REAL, site_address TEXT);
CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, type TEXT, date TEXT, start_time TEXT, end_time TEXT, address TEXT, status TEXT, project_id INTEGER);
CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
`);
const todayIso = new Date().toISOString().slice(0, 10);
const EMAIL = 'client@example.com';
db.prepare("INSERT INTO leads(email) VALUES(?)").run(EMAIL);
db.prepare("INSERT INTO estimates(email,project_name,status,proposal_total,public_token,created_at) VALUES(?,?,?,?,?,?)").run(EMAIL, 'Office cleaning', 'Sent', 1200, 'tok-est-1', '2026-11-01T10:00:00Z');
db.prepare("INSERT INTO estimates(email,project_name,status,proposal_total,public_token,created_at) VALUES(?,?,?,?,?,?)").run(EMAIL, 'Old draft', 'Draft', 500, 'tok-est-draft', '2026-11-01T10:00:00Z');
db.prepare("INSERT INTO contracts(email,title,value,status,signature_status,public_token,created_at) VALUES(?,?,?,?,?,?,?)").run(EMAIL, 'Office contract', 9000, 'Review', 'Sent', 'tok-con-1', '2026-11-02T10:00:00Z');
db.prepare("INSERT INTO contracts(email,title,value,status,signature_status,public_token,created_at,signed_at) VALUES(?,?,?,?,?,?,?,?)").run(EMAIL, 'Signed contract', 5000, 'Active', 'Signed', 'tok-con-2', '2026-10-01T10:00:00Z', '2026-10-02T10:00:00Z');
db.prepare("INSERT INTO invoices(email,invoice_number,amount,paid_amount,due_date,status,created_at) VALUES(?,?,?,?,?,?,?)").run(EMAIL, 'BC-2026-0007', 300, 0, '2026-11-20', 'Sent', '2026-11-03T10:00:00Z');
db.prepare("INSERT INTO invoices(email,invoice_number,amount,paid_amount,status,created_at) VALUES(?,?,?,?,?,?)").run(EMAIL, 'BC-2026-0008', 999, 0, 'Draft', '2026-11-03T10:00:00Z');
db.prepare("INSERT INTO projects(contract_id,name,status,progress,site_address) VALUES(?,?,?,?,?)").run(2, 'Signed job', 'In Progress', 40, '1 Main St');
db.prepare("INSERT INTO visits(title,type,date,start_time,end_time,address,status,project_id) VALUES(?,?,?,?,?,?,?,?)").run('Weekly clean', 'Cleaning phase', todayIso, '08:00', '10:00', '1 Main St', 'Scheduled', 1);
db.prepare("INSERT INTO visits(title,type,date,start_time,end_time,address,status,project_id) VALUES(?,?,?,?,?,?,?,?)").run('Tentative visit', 'Cleaning phase', todayIso, '13:00', '14:00', '1 Main St', 'Tentative', 1);
db.prepare("INSERT INTO visits(title,type,date,start_time,end_time,address,status,project_id) VALUES(?,?,?,?,?,?,?,?)").run('Finished clean', 'Cleaning phase', todayIso, '07:00', '08:00', '1 Main St', 'Done', 1);

db.exec(`CREATE TABLE inspections(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, project_id INTEGER, date TEXT, area TEXT, score REAL, passed INTEGER, status TEXT, itype TEXT, signed_name TEXT, signed_at TEXT);`);
db.prepare("INSERT INTO customers(email) VALUES(?)").run(EMAIL);
db.prepare("INSERT INTO inspections(customer_id,project_id,date,area,score,passed,status,itype,signed_name,signed_at) VALUES(1,1,?,?,?,?,?,?,?,?)").run('2026-11-05', 'Lobby', 92, 1, 'Completed', 'Final', 'Eric Moore', '2026-11-05T12:00:00Z');
db.prepare("INSERT INTO inspections(customer_id,project_id,date,area,score,passed,status,itype,signed_name,signed_at) VALUES(2,NULL,?,?,?,?,?,?,?,?)").run('2026-11-06', 'Other', 50, 0, 'Completed', 'Final', 'Someone', '2026-11-06T12:00:00Z');
const crypto2 = require('crypto');
const SECRET2 = process.env.JWT_SECRET + ':client-portal';
function sign(p) { const body = Buffer.from(JSON.stringify(p)).toString('base64url'); return body + '.' + crypto2.createHmac('sha256', SECRET2).update(body).digest('base64url'); }
const routes = {};
const app = { locals: {}, get: (p, ...f) => { routes['GET ' + p] = f[f.length - 1]; }, post: (p, ...f) => { routes['POST ' + p] = f[f.length - 1]; }, put: (p, ...f) => { routes['PUT ' + p] = f[f.length - 1]; }, patch: (p, ...f) => { routes['PATCH ' + p] = f[f.length - 1]; } };
const staffAuth = (req, res, next) => next();
const sent = [];
const mailer = { sendMail: async m => { sent.push(m); return { messageId: 'x' }; } };
require(path.join(root, 'portal.js'))(app, { db, getMailer: () => mailer, auth: staffAuth });

function call(key, body = {}, headers = {}, ip = '10.0.0.1') {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { body, headers, ip: typeof ip === 'string' ? ip : '10.0.0.1', query: {}, params: typeof ip === 'object' && ip ? ip : {} };
  const out = routes[key](req, res);
  return Promise.resolve(out).then(() => ({ code: res.code, body: res.body }));
}

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); } }

(async () => {
  // 1. Unknown email gets the same answer and nothing is sent
  const unk = await call('POST /api/portal/request', { email: 'nobody@example.com' }, {}, '10.1.0.1');
  check('unknown email: same generic answer', unk.code === 200 && unk.body.ok && /on file/.test(unk.body.message));
  check('unknown email: no mail sent', sent.length === 0, sent.length);

  // 2. Known email gets one link
  const known = await call('POST /api/portal/request', { email: EMAIL }, {}, '10.1.0.2');
  check('known email: generic answer', known.code === 200 && known.body.ok);
  check('known email: one sign-in mail sent', sent.length === 1 && sent[0].to === EMAIL && /sign-in link/.test(sent[0].subject), sent.map(m => m.subject));
  const linkMatch = sent[0] && sent[0].text.match(/portal\.html#([A-Za-z0-9_-]+)/);
  const token = linkMatch ? linkMatch[1] : null;
  check('link contains a one-time token', !!token);

  // 3. A second request within a minute sends nothing more
  await call('POST /api/portal/request', { email: EMAIL }, {}, '10.1.0.3');
  check('cooldown: no second mail within a minute', sent.length === 1, sent.length);

  // 4. Verify: bad token refused; good token gives a session; reuse refused
  const bad = await call('POST /api/portal/verify', { token: 'not-a-token' });
  check('bad token refused', bad.code === 401, bad);
  const good = await call('POST /api/portal/verify', { token });
  check('good token gives a session', good.code === 200 && good.body.session && good.body.email === EMAIL, good);
  const again = await call('POST /api/portal/verify', { token });
  check('token works only once', again.code === 401, again);

  // 5. Records: only this customer's, drafts and tentative visits hidden
  const session = good.body.session;
  const me = await call('GET /api/portal/me', {}, { authorization: 'Bearer ' + session });
  const d = me.body;
  check('me: signed in returns 200', me.code === 200, me);
  check('me: proposals exclude drafts', d.proposals.length === 1 && d.proposals[0].title === 'Office cleaning', d.proposals);
  check('me: contract link only while unsigned', d.contracts.some(c => c.link === '/contract/tok-con-1') && d.contracts.some(c => c.link === null), d.contracts);
  check('me: invoices exclude drafts', d.invoices.length === 1 && d.invoices[0].number === 'BC-2026-0007' && d.invoices[0].balance === 300, d.invoices);
  check('me: projects listed', d.projects.length === 1 && d.projects[0].name === 'Signed job', d.projects);
  check('me: tentative visit hidden, scheduled and done shown', d.visits.length === 2 && !d.visits.some(v => v.title === 'Tentative visit'), d.visits);
  check('me: activity has proposal, contract, invoice and completed service', ['Proposal', 'Contract', 'Invoice', 'Service completed'].every(k => d.activity.some(a => a.text.indexOf(k) === 0)), d.activity);
  check('me: activity is newest first', d.activity.every((a, i, arr) => i === 0 || String(arr[i - 1].at) >= String(a.at)), d.activity.map(a => a.at));

  // 6. Sessions: none, tampered, or from another email are refused
  const none = await call('GET /api/portal/me', {}, {});
  check('me: no session refused', none.code === 401, none);
  const tampered = await call('GET /api/portal/me', {}, { authorization: 'Bearer ' + session.slice(0, -2) + 'xx' });
  check('me: tampered session refused', tampered.code === 401, tampered);
  const other = await call('GET /api/portal/me', {}, { authorization: 'Bearer ' + 'eyJlbWFpbCI6ImZvb0BiYXIuY29tIn0.AAAA' });
  check('me: forged session refused', other.code === 401, other);

  // 7. Rate limit per address: the sixth request from one address in ten minutes is refused
  let limited = null;
  for (let i = 0; i < 7; i++) { const r = await call('POST /api/portal/request', { email: 'spam' + i + '@example.com' }, {}, '10.9.9.9'); if (r.code === 429) { limited = r; break; } }
  check('rate limit: sixth request refused', limited && limited.code === 429, limited);

  // 8. Service request from the portal: signed-in only, needs a service and details, becomes a bid lead on the customer's email
  const rsNone = await call('POST /api/portal/request-service', { service: 'Commercial janitorial', details: 'Weekly office cleaning.' });
  check('service request: signed-out refused', rsNone.code === 401, rsNone);
  const rsEmpty = await call('POST /api/portal/request-service', { service: '', details: 'x' }, { authorization: 'Bearer ' + session }, '10.5.5.5');
  check('service request: missing service refused', rsEmpty.code === 400, rsEmpty);
  const rsShort = await call('POST /api/portal/request-service', { service: 'Commercial janitorial', details: 'hi' }, { authorization: 'Bearer ' + session }, '10.5.5.5');
  check('service request: too-short details refused', rsShort.code === 400, rsShort);
  const sentBefore = sent.length;
  const rsOk = await call('POST /api/portal/request-service', { service: 'Commercial janitorial', details: 'Weekly office cleaning, about 3,000 sq ft, two restrooms.', address: '5 Office Way', company: 'Test Office', phone: '515-555-0100', contact_name: 'Pat' }, { authorization: 'Bearer ' + session }, '10.5.5.5');
  check('service request: accepted', rsOk.code === 201 && rsOk.body.ok && rsOk.body.id, rsOk);
  const lead = rsOk.body && db.prepare('SELECT * FROM leads WHERE id=?').get(rsOk.body.id);
  check('service request: lead is a bid on the customer email', lead && lead.kind === 'bid' && lead.status === 'New' && lead.email === EMAIL && lead.service === 'Commercial janitorial' && /client portal/.test(lead.details), lead);
  check('service request: staff notice and customer acknowledgment sent', sent.length === sentBefore + 2 && sent.slice(-2).some(m => m.to === EMAIL) && sent.slice(-2).some(m => m.subject.indexOf('New service request') === 0), sent.slice(-2).map(m => m.to + ' ' + m.subject));
  const rsMany = [];
  for (let i = 0; i < 3; i++) rsMany.push(await call('POST /api/portal/request-service', { service: 'Power washing', details: 'Back patio, about 400 sq ft of concrete.' }, { authorization: 'Bearer ' + session }, '10.5.5.5'));
  check('service request: limited after three in five minutes', rsMany[2].code === 429 || rsMany[1].code === 429 || rsMany[0].code === 429, rsMany.map(r => r.code));

  // 9. Messages from the portal: signed-in only, saved to the account, sent to the office, limited
  const msgNone = await call('POST /api/portal/messages', { body: 'Hello there' });
  check('message: signed-out refused', msgNone.code === 401, msgNone);
  const msgShort = await call('POST /api/portal/messages', { body: 'hi' }, { authorization: 'Bearer ' + session }, '10.6.6.6');
  check('message: too short refused', msgShort.code === 400, msgShort);
  const sentM = sent.length;
  const msgOk = await call('POST /api/portal/messages', { subject: 'Schedule change', body: 'Can we move Tuesday to Wednesday?' }, { authorization: 'Bearer ' + session }, '10.6.6.6');
  check('message: accepted and saved', msgOk.code === 201 && msgOk.body.ok, msgOk);
  check('message: office notice and customer acknowledgment sent', sent.length === sentM + 2 && sent.slice(-2).some(m => m.to === EMAIL), sent.slice(-2).map(m => m.to));
  for (let i = 0; i < 4; i++) await call('POST /api/portal/messages', { body: 'Another message here' }, { authorization: 'Bearer ' + session }, '10.6.6.6');
  const msgLimited = await call('POST /api/portal/messages', { body: 'One more message' }, { authorization: 'Bearer ' + session }, '10.6.6.6');
  check('message: limited after five in an hour', msgLimited.code === 429, msgLimited);
  // 10. The data the pages show: properties and requests belong to this customer
  const me2 = await call('GET /api/portal/me', {}, { authorization: 'Bearer ' + session });
  check('me: messages listed on the account', me2.body.messages.length >= 1 && me2.body.messages.some(m => m.subject === 'Schedule change'), me2.body.messages);
  check('me: properties come from the customer\'s own records', Array.isArray(me2.body.properties) && me2.body.properties.some(p => p.address === '1 Main St'), me2.body.properties);
  check('me: service requests listed', Array.isArray(me2.body.requests) && me2.body.requests.length >= 1, me2.body.requests);

  // 10b. Staff replies: saved to the conversation, emailed to the customer, and shown to them
  const msgId = db.prepare('SELECT id FROM portal_messages ORDER BY id DESC LIMIT 1').get().id;
  const sentR = sent.length;
  const rp = await call('POST /api/admin/portal-messages/:id/reply', { body: 'We have moved Tuesday to Wednesday. See you then.' }, {}, { id: String(msgId) });
  check('staff reply: saved', rp.code === 201 && rp.body.ok, rp);
  check('staff reply: emailed to the customer', rp.body.emailed === true && sent.length === sentR + 1 && sent[sent.length - 1].to === EMAIL, sent.slice(-1).map(m => m.to));
  const staffList = await call('GET /api/admin/portal-messages', {}, {});
  check('staff: sees the message with its reply', staffList.body.messages.some(m => m.id === msgId && m.replies.length === 1), staffList.body);
  const fresh = sign({ email: EMAIL, iat: Date.now(), exp: Date.now() + 3600000 });
  const meR = await call('GET /api/portal/me', {}, { authorization: 'Bearer ' + fresh });
  check('customer: sees the reply in the conversation', meR.code === 200 && meR.body.messages.some(m => m.replies && m.replies.some(r => /Wednesday/.test(r.body))), meR.body.messages);
  // Turn off message emails: the reply is still saved, but not emailed
  await call('PUT /api/portal/profile', { notify: { schedule: true, proposals: true, invoices: true, projects: true, messages: false } }, { authorization: 'Bearer ' + fresh });
  const sentQ = sent.length;
  const rp2 = await call('POST /api/admin/portal-messages/:id/reply', { body: 'A second reply, not emailed.' }, {}, { id: String(msgId) });
  check('staff reply: not emailed when the customer turned message emails off', rp2.code === 201 && rp2.body.emailed === false && sent.length === sentQ, { body: rp2.body, n: sent.length - sentQ });

  const insp = await call('GET /api/portal/me', {}, { authorization: 'Bearer ' + session });
  check('quality: only this customer signed inspections are shown', insp.body.inspections && insp.body.inspections.length === 1 && insp.body.inspections[0].score === 92 && insp.body.inspections[0].passed === true, insp.body.inspections);
  // 10b. Proposals: the customer sees their own proposals with detail, and can approve, decline or ask for changes
  const pm = await call('GET /api/portal/me', {}, { authorization: 'Bearer ' + session });
  const p1 = (pm.body.proposals || []).find(p => p.id === 1);
  check('proposals: own proposal listed with number, detail and PDF link', p1 && p1.number === 'P-2026-1001' && p1.actionable === true && p1.pdf === '/api/proposal/tok-est-1/pdf' && p1.title === 'Office cleaning', p1);
  check('proposals: drafts are not shown to the customer', !(pm.body.proposals || []).some(p => p.id === 2), pm.body.proposals);
  db.prepare("INSERT INTO estimates(id,email,project_name,status,proposal_total,public_token,created_at,expires_on) VALUES(?,?,?,?,?,?,?,?)").run(4, 'other@example.com', 'Not yours', 'Sent', 99, 'tok-other', '2026-11-01T10:00:00Z', null);
  db.prepare("INSERT INTO estimates(id,email,project_name,status,proposal_total,public_token,created_at,expires_on) VALUES(?,?,?,?,?,?,?,?)").run(5, EMAIL, 'Changes wanted', 'Sent', 700, 'tok-est-5', '2026-11-02T10:00:00Z', null);
  db.prepare("INSERT INTO estimates(id,email,project_name,status,proposal_total,public_token,created_at,expires_on) VALUES(?,?,?,?,?,?,?,?)").run(6, EMAIL, 'Old quote', 'Sent', 800, 'tok-est-6', '2025-01-01T10:00:00Z', '2025-02-01');
  const pmx = await call('GET /api/portal/me', {}, { authorization: 'Bearer ' + session });
  const p6 = (pmx.body.proposals || []).find(p => p.id === 6);
  check('proposals: past expiry shows as Expired and is not actionable', p6 && p6.status === 'Expired' && p6.actionable === false, p6);
  const noName = await call('POST /api/portal/proposals/:id/respond', { decision: 'approve', agree: true, signer_name: 'A' }, { authorization: 'Bearer ' + session }, { id: '1' });
  check('approve: a typed name and the authorization tick are required', noName.code === 400, noName);
  const otherP = await call('POST /api/portal/proposals/:id/respond', { decision: 'approve', agree: true, signer_name: 'Pat Client' }, { authorization: 'Bearer ' + session }, { id: '4' });
  check('approve: another customer\'s proposal is not found', otherP.code === 404, otherP);
  const expRes = await call('POST /api/portal/proposals/:id/respond', { decision: 'approve', agree: true, signer_name: 'Pat Client' }, { authorization: 'Bearer ' + session }, { id: '6' });
  check('approve: an expired proposal is refused', expRes.code === 410, expRes);
  const ok1 = await call('POST /api/portal/proposals/:id/respond', { decision: 'approve', agree: true, signer_name: 'Pat Client', signer_title: 'Owner' }, { authorization: 'Bearer ' + session }, { id: '1' });
  const st1 = db.prepare('SELECT status, signer_name FROM estimates WHERE id=1').get();
  check('approve: recorded with the signer name', ok1.code === 200 && ok1.body.status === 'Approved' && st1.status === 'Approved' && st1.signer_name === 'Pat Client', { ok1, st1 });
  const decideAgain = await call('POST /api/portal/proposals/:id/respond', { decision: 'decline' }, { authorization: 'Bearer ' + session }, { id: '1' });
  check('decide once: a second decision is refused', decideAgain.code === 409, decideAgain);
  const ch1 = await call('POST /api/portal/proposals/:id/changes', { body: 'Add the second restroom.' }, { authorization: 'Bearer ' + session }, { id: '1' });
  check('changes: refused on an approved proposal', ch1.code === 409, ch1);
  const chShort = await call('POST /api/portal/proposals/:id/changes', { body: 'no' }, { authorization: 'Bearer ' + session }, { id: '5' });
  check('changes: a short request is refused', chShort.code === 400, chShort);
  const ch5 = await call('POST /api/portal/proposals/:id/changes', { body: 'Please add weekly window cleaning.' }, { authorization: 'Bearer ' + session }, { id: '5' });
  const chMsg = db.prepare("SELECT subject, body FROM portal_messages WHERE subject LIKE 'Change request: P-2026-1005%' ORDER BY id DESC LIMIT 1").get();
  check('changes: sent to the office as a message on the proposal number', ch5.code === 201 && chMsg && /weekly window/.test(chMsg.body), { ch5, chMsg });
  const dec5 = await call('POST /api/portal/proposals/:id/respond', { decision: 'decline', reason: 'Too costly this year' }, { authorization: 'Bearer ' + session }, { id: '5' });
  const st5 = db.prepare('SELECT status, decline_reason FROM estimates WHERE id=5').get();
  check('decline: recorded with the reason', dec5.code === 200 && st5.status === 'Declined' && st5.decline_reason === 'Too costly this year', { dec5, st5 });

  // 11. Account settings: saved to the account; sign out everywhere ends existing sessions
  const prNone = await call('PUT /api/portal/profile', { name: 'Pat' });
  check('profile: signed-out refused', prNone.code === 401, prNone);
  const prOk = await call('PUT /api/portal/profile', { name: 'Pat Client', company: 'Client Co', phone: '515-555-0199', notify: { schedule: false, proposals: true, invoices: true, projects: true, messages: true } }, { authorization: 'Bearer ' + session });
  check('profile: saved', prOk.code === 200, prOk);
  const me3 = await call('GET /api/portal/me', {}, { authorization: 'Bearer ' + session });
  check('profile: saved details come back on the account', me3.body.profile.name === 'Pat Client' && me3.body.profile.company === 'Client Co' && me3.body.profile.notify.schedule === false, me3.body.profile);
  const so = await call('POST /api/portal/sign-out-everywhere', {}, { authorization: 'Bearer ' + session });
  check('sign out everywhere: accepted', so.code === 200, so);
  await new Promise(r => setTimeout(r, 1200));
  const after = await call('GET /api/portal/me', {}, { authorization: 'Bearer ' + session });
  check('sign out everywhere: the old session stops working', after.code === 401, after);
  const newLink = await call('POST /api/portal/request', { email: EMAIL }, {}, '10.7.7.7');
  check('sign out everywhere: a new sign-in link still works', newLink.code === 200, newLink);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
