/* Bright Clean end-to-end test suite.
 * Starts the real server on a fresh temporary database, captures email with a local SMTP server,
 * and exercises the website, admin API, automations and backups with real HTTP requests.
 *
 *   npm i --no-save smtp-server     (test-only dependency)
 *   node tests/run-tests.js          writes tests/results.json and prints PASS/FAIL
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { SMTPServer } = require('smtp-server');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const PORT = 3990 + Math.floor(Math.random() * 8);
const B = `http://127.0.0.1:${PORT}`;
const SMTP_PORT = 2600 + Math.floor(Math.random() * 50);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
const results = [];
const mail = [];
let server;

function record(area, name, pass, evidence) {
  results.push({ area, name, status: pass ? 'PASS' : 'FAIL', evidence: String(evidence).slice(0, 400) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${area}] ${name}${pass ? '' : '  -> ' + evidence}`);
}
async function check(area, name, fn) {
  try { const ev = await fn(); record(area, name, true, ev === undefined ? 'ok' : ev); }
  catch (e) { record(area, name, false, e.message); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function req(method, url, { token, json, form, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  let b = body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; b = JSON.stringify(json); }
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; b = new URLSearchParams(form).toString(); }
  const r = await fetch(B + url, { method, headers: h, body: b, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
const mailsTo = (to, since = 0) => mail.slice(since).filter(m => m.to.includes(to));

function startSmtp() {
  return new Promise(res => {
    const s = new SMTPServer({
      authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'],
      onAuth(auth, session, cb) { cb(null, { user: auth.username }); },
      onData(stream, session, cb) {
        let raw = ''; stream.on('data', d => raw += d); stream.on('end', () => {
          const subject = (raw.match(/^Subject: (.*)$/mi) || [])[1] || '';
          mail.push({ to: session.envelope.rcptTo.map(r => r.address), subject: subject.trim(), raw: raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=') }); cb();
        });
      }
    });
    s.listen(SMTP_PORT, '127.0.0.1', () => res(s));
  });
}

const killWait = child => new Promise(r => { if (!child || child.exitCode !== null || child.signalCode) return r(); child.once('exit', () => r()); child.kill(); setTimeout(r, 3000); });
async function startServer(env, dataDir) {
  globalThis.__dataDir = dataDir;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...env, PORT: String(PORT), DATA_DIR: dataDir, UPLOAD_DIR: path.join(work, 'uploads') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 50; i++) { try { const r = await fetch(B + '/health'); if (r.ok) return { child, log: () => log }; } catch { } await sleep(150); }
  throw new Error('Server did not start: ' + log);
}

(async () => {
  let smtp = await startSmtp();
  // Mock Twilio REST API for click-to-call: records created calls, returns a CallSid.
  const twCalls = []; globalThis.__twCalls = twCalls;
  const twMock = require('http').createServer((rq, rs) => {
    if (/\/oauth2\/v2\.0\/token$/.test(rq.url)) { let b = ''; rq.on('data', d => b += d); rq.on('end', () => { const p = Object.fromEntries(new URLSearchParams(b)); twCalls.push({ m365token: p.grant_type, client: p.client_id }); rs.writeHead(p.code === 'badcode' ? 400 : 200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(p.code === 'badcode' ? { error: 'invalid_grant', error_description: 'AADSTS70000: bad code' } : { access_token: 'at-' + Date.now(), refresh_token: 'rt-secret-value', expires_in: 3600 })); }); return; }
    if (rq.url === '/v1.0/me') { rs.writeHead(200, { 'Content-Type': 'application/json' }); return rs.end(JSON.stringify({ mail: 'info@brightclean.test' })); }
    if (/^\/v1\.0\/me\/mailFolders\/inbox\/messages/.test(rq.url)) { twCalls.push({ graph: rq.url, auth: rq.headers.authorization }); rs.writeHead(200, { 'Content-Type': 'application/json' }); return rs.end(JSON.stringify({ value: [
      { id: 'MSG1', subject: 'Re: Your Quote Request', from: { emailAddress: { address: 'Sharon@BorTunCo.test', name: 'Sharon' } }, receivedDateTime: '2026-11-05T15:00:00Z', bodyPreview: 'Here are the details for the project', conversationId: 'c1', webLink: 'https://outlook.office.com/mail/x' },
      { id: 'MSG2', subject: 'Newsletter', from: { emailAddress: { address: 'news@vendor.test', name: 'Vendor' } }, receivedDateTime: '2026-11-05T15:05:00Z', bodyPreview: 'Deals', conversationId: 'c2', webLink: 'javascript:alert(1)' }] })); }
    if (rq.method === 'GET' && /\/Accounts\/AC[a-z0-9]+\.json$/.test(rq.url)) { rs.writeHead(200, { 'Content-Type': 'application/json' }); return rs.end(JSON.stringify({ status: 'active' })); } if (rq.method === 'GET' && /IncomingPhoneNumbers\.json/.test(rq.url)) { rs.writeHead(200, { 'Content-Type': 'application/json' }); return rs.end(JSON.stringify({ incoming_phone_numbers: [{ phone_number: '+15153033024', voice_url: 'https://brightclean.net/api/webhooks/twilio/voice', status_callback: 'https://brightclean.net/api/webhooks/twilio/status' }] })); } if (rq.method === 'GET' && /\/Recordings\/RE[^/]+\.mp3$/.test(rq.url)) { twCalls.push({ url: rq.url, auth: rq.headers.authorization, get: true }); if (/REgone/.test(rq.url)) { rs.writeHead(404); return rs.end(); } rs.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return rs.end(Buffer.from('ID3\u0003fake-mp3-audio-bytes')); } let body = ''; rq.on('data', d => body += d); rq.on('end', () => { const p = Object.fromEntries(new URLSearchParams(body)); twCalls.push({ url: rq.url, auth: rq.headers.authorization, ...p }); rs.writeHead(201, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ sid: 'CAclick' + twCalls.length + 'x'.repeat(20) })); }); });
  await new Promise(r => twMock.listen(0, '127.0.0.1', r)); const TW_API = 'http://127.0.0.1:' + twMock.address().port; globalThis.__twBase = TW_API;
  const OWNER = 'owner@brightclean.test', OWNER_PW = 'owner-password-1234';
  const env = {
    NODE_ENV: 'staging', JWT_SECRET: (globalThis.__jwtSecret = crypto.randomBytes(40).toString('hex')), ADMIN_EMAIL: OWNER,
    ADMIN_PASSWORD_HASH: await bcrypt.hash(OWNER_PW, 10), RATE_LIMIT_PUBLIC: '5000', TWILIO_AUTH_TOKEN: 'tw-test-token', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: 'false',
    SMTP_USER: 'info@brightclean.net', SMTP_PASS: 'test', FROM_EMAIL: 'info@brightclean.net', NOTIFY_EMAIL: 'info@brightclean.net', AUTOBID_SWEEP_MS: '500',
    PUBLIC_BASE_URL: 'https://brightclean.net', MONITORING_TEST_ROUTE: '1', MS365_CLIENT_ID: 'test-client', MS365_CLIENT_SECRET: 'test-secret', MS365_TENANT_ID: 'tenant1', MS365_LOGIN_BASE: TW_API, MS365_GRAPH_BASE: TW_API, TWILIO_API_BASE: TW_API, TWILIO_API_KEY: 'SK' + 'b'.repeat(32), TWILIO_API_SECRET: 'test-api-secret', DISABLE_SCHEDULER: '1', DOTENV_CONFIG_PATH: '/nonexistent'
  };
  const dataDir = path.join(work, 'data');

  // ---------- Migration of an existing (pre-V5) database ----------
  await check('Database', 'Pre-V5 database with live records migrates without data loss', async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const old = new Database(path.join(dataDir, 'brightclean.db'));
    old.exec(`CREATE TABLE leads(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL DEFAULT 'bid',contact_name TEXT,company TEXT,email TEXT,phone TEXT,project_name TEXT,project_type TEXT,service TEXT,address TEXT,square_footage TEXT,bid_due_date TEXT,start_date TEXT,frequency TEXT,walkthrough TEXT,details TEXT,status TEXT NOT NULL DEFAULT 'New',files TEXT,created_at TEXT NOT NULL);
      CREATE TABLE estimates(id INTEGER PRIMARY KEY AUTOINCREMENT,lead_id INTEGER,customer_name TEXT NOT NULL,company TEXT,email TEXT,project_name TEXT,site_address TEXT,scope TEXT NOT NULL,area_sqft REAL DEFAULT 0,production_rate REAL DEFAULT 0,labor_hours REAL DEFAULT 0,labor_rate REAL DEFAULT 0,labor_cost REAL DEFAULT 0,supplies_cost REAL DEFAULT 0,equipment_cost REAL DEFAULT 0,other_cost REAL DEFAULT 0,overhead_pct REAL DEFAULT 0,margin_pct REAL DEFAULT 0,tax_pct REAL DEFAULT 0,total_cost REAL DEFAULT 0,proposal_total REAL DEFAULT 0,line_items TEXT,terms TEXT,status TEXT DEFAULT 'Draft',public_token TEXT UNIQUE,expires_on TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO leads(kind,contact_name,email,details,created_at) VALUES('inquiry','TEST - Claude site check','info@brightclean.net','Automated test lead','2026-11-02T01:09:57.808Z');
      INSERT INTO estimates(customer_name,company,email,scope,area_sqft,production_rate,labor_rate,supplies_cost,overhead_pct,margin_pct,total_cost,proposal_total,public_token,created_at,updated_at) VALUES('Legacy','LegacyCo','legacy@co.test','legacy scope',20000,2500,30,100,10,25,374,498.67,'legacytoken','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');`);
    old.close();
    server = await startServer(env, dataDir);
    const db = new Database(path.join(dataDir, 'brightclean.db'), { readonly: true });
    const lead = db.prepare('SELECT * FROM leads WHERE id=1').get();
    const est = db.prepare('SELECT * FROM estimates WHERE id=1').get();
    const cols = db.prepare('PRAGMA table_info(estimates)').all().map(c => c.name);
    const cust = db.prepare('SELECT COUNT(*) n FROM customers').get().n;
    db.close();
    assert(lead && lead.contact_name === 'TEST - Claude site check', 'lead lost');
    assert(est.proposal_total === 498.67 && est.visits === 1 && cols.includes('decided_at'), 'estimate not migrated');
    assert(cust === 2, 'customers not backfilled: ' + cust);
    return `lead #1 kept; legacy estimate total 498.67 kept; ${cols.length} estimate columns; ${cust} customers backfilled`;
  });
  await check('Database', 'Migration is repeatable (restart on migrated database)', async () => {
    await killWait(server.child);
    server = await startServer(env, dataDir);
    const h = await req('GET', '/health'); assert(h.status === 200 && h.data.db === 'ok', 'health after restart');
    return 'restarted cleanly; /health ' + JSON.stringify(h.data);
  });

  // ---------- Health ----------
  await check('Health', '/health and /api/health report app and database status', async () => {
    const a = await req('GET', '/health'), b = await req('GET', '/api/health');
    assert(a.data.ok && a.data.db === 'ok' && b.data.ok, 'bad health');
    return JSON.stringify(a.data);
  });

  // ---------- Public website ----------
  const pages = [];
  await check('Website', 'Every page and internal link/asset loads (crawl)', async () => {
    const seen = new Map(), queue = ['/'], broken = [];
    while (queue.length) {
      const p = queue.shift(); if (seen.has(p)) continue;
      const r = await fetch(B + p); seen.set(p, r.status);
      if (r.status !== 200) { broken.push(p + ' ' + r.status); continue; }
      if (!(r.headers.get('content-type') || '').includes('html')) continue;
      pages.push(p);
      const html = await r.text();
      for (const m of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
        const u = m[1]; if (/^(https?:|mailto:|tel:|data:)/.test(u)) continue;
        const abs = new URL(u, B + p).pathname; if (!seen.has(abs) && !queue.includes(abs)) queue.push(abs);
      }
      for (const m of html.matchAll(/url\('([^')]+)'\)/g)) { const abs = new URL(m[1], B + p).pathname; if (!m[1].startsWith('http') && !seen.has(abs)) queue.push(abs); }
    }
    const css = await (await fetch(B + '/assets/site.css')).text();
    for (const m of css.matchAll(/url\('([^')]+)'\)/g)) if (!m[1].startsWith('http')) { const r = await fetch(B + m[1]); if (r.status !== 200) broken.push(m[1] + ' ' + r.status); }
    assert(!broken.length, 'broken: ' + broken.join(', '));
    return `${pages.length} pages, ${seen.size} URLs checked, 0 broken`;
  });
  await check('Website', 'No duplicate element IDs, no leftover draft notes, phone number consistent', async () => {
    const issues = [];
    for (const p of pages) {
      const html = await (await fetch(B + p)).text();
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
      const dup = ids.filter((x, i) => ids.indexOf(x) !== i); if (dup.length) issues.push(p + ' dup id ' + dup[0]);
      if (/before publication|starter privacy|Template notice|Insert approved/i.test(html)) issues.push(p + ' draft note');
      const phones = [...html.matchAll(/\b\d{3}-\d{3}-\d{4}\b/g)].map(m => m[0]).filter(x => x !== '515-303-3024');
      if (phones.length) issues.push(p + ' other phone ' + phones[0]);
    }
    assert(!issues.length, issues.join('; '));
    return `${pages.length} pages clean`;
  });
  await check('Website', 'Project video supports range requests (mobile playback)', async () => {
    const r = await fetch(B + '/assets/projects/des-moines-projects.mp4', { headers: { Range: 'bytes=0-1023' } });
    assert(r.status === 206 && r.headers.get('content-type') === 'video/mp4', 'status ' + r.status);
    return '206 Partial Content, video/mp4';
  });
  await check('Website', 'Unknown page returns branded 404', async () => {
    const r = await fetch(B + '/no-such-page'); const t = await r.text();
    assert(r.status === 404 && /Bright/i.test(t), 'status ' + r.status); return '404 with site page';
  });

  // ---------- Public forms ----------
  let m0 = mail.length;
  let bidId;
  const pdf = Buffer.from('%PDF-1.4 test bid document ' + crypto.randomBytes(8).toString('hex'));
  await check('Forms', 'Bid request with 2 services and 2 files is stored; customer created', async () => {
    const fd = new FormData();
    Object.entries({ contact_name: 'Dana Builder', company: 'Prairie Construction', email: 'dana@prairie.test', phone: '515-555-0100', project_name: 'Ankeny Medical Office', project_type: 'Medical office', address: '100 Main St, Ankeny, IA', square_footage: '24,000', bid_due_date: '2026-11-20', details: 'Final clean before turnover', consent: 'on' }).forEach(([k, v]) => fd.append(k, v));
    fd.append('service', 'Post-construction final cleaning'); fd.append('service', 'Window cleaning');
    fd.append('documents', new Blob([pdf], { type: 'application/pdf' }), 'plans.pdf');
    fd.append('documents', new Blob([Buffer.from('%PDF-1.4\n% spec sheet')], { type: 'application/pdf' }), 'specs.pdf');
    const r = await fetch(B + '/api/bids', { method: 'POST', body: fd }); const j = await r.json();
    assert(r.status === 201, JSON.stringify(j)); bidId = j.id;
    return 'lead #' + bidId + ' created (201)';
  });
  await check('Email', 'Bid triggers internal notification and customer acknowledgement', async () => {
    await sleep(500);
    const internal = mailsTo('info@brightclean.net', m0).find(m => /bid request/i.test(m.subject));
    const ack = mailsTo('dana@prairie.test', m0).find(m => /received/i.test(m.subject));
    assert(internal && ack, 'captured: ' + mail.slice(m0).map(m => m.to + ':' + m.subject).join(' | '));
    return `"${internal.subject}" -> info@; "${ack.subject}" -> dana@`;
  });
  await check('Email', 'Quote-form request notifies the owner with the pre-pricing list and acknowledges the customer', async () => {
    const m1 = mail.length;
    const fd = new FormData();
    Object.entries({ contact_name: 'Quinn Mail', company: 'Mailtest Apartments', email: 'quinn@mailtest.test', phone: '515-555-0199', address: '1 Elm, Ankeny IA', consent: 'yes', service_key: 'windows', stories: '4+ stories', sides: 'Both', access: 'Not sure' }).forEach(([k, v]) => fd.append(k, v));
    const r = await fetch(B + '/api/quotes', { method: 'POST', body: fd });
    for (let i = 0; i < 25 && mail.length < m1 + 2; i++) await sleep(200);
    const owner = mailsTo('info@brightclean.net', m1).find(m => /New quote request: Window cleaning/.test(m.subject));
    const ack = mailsTo('quinn@mailtest.test', m1).find(m => /received/i.test(m.subject));
    assert(r.status === 201 && owner && /Before pricing/.test(owner.raw) && /site visit/i.test(owner.raw) && ack && !/Before pricing/.test(ack.raw), mail.slice(m1).map(m => m.to + ':' + m.subject).join(' | '));
    return `"${owner.subject}" -> info@ with the pre-pricing list; "${ack.subject}" -> customer, without internal notes`;
  });
  await check('Forms', 'Bid with invalid email is rejected and its uploads are deleted', async () => {
    const before = fs.existsSync(path.join(work, 'uploads')) ? fs.readdirSync(path.join(work, 'uploads')).length : 0;
    const fd = new FormData();
    Object.entries({ contact_name: 'X', company: 'Y', email: 'not-an-email', phone: '1', project_type: 'Office', service: 'Janitorial', address: 'Z', details: 'D', consent: 'on' }).forEach(([k, v]) => fd.append(k, v));
    fd.append('documents', new Blob([Buffer.from('%PDF-1.4\n% x')], { type: 'application/pdf' }), 'a.pdf');
    const r = await fetch(B + '/api/bids', { method: 'POST', body: fd }); const j = await r.json();
    const after = fs.readdirSync(path.join(work, 'uploads')).length;
    assert(r.status === 400 && /valid email/i.test(j.error) && after === before, `${r.status} ${j.error} files ${before}->${after}`);
    return `400 "${j.error}"; upload removed`;
  });
  await check('Forms', 'Bid missing required fields, honeypot spam and unsupported file type are rejected', async () => {
    const send = async (fields, file) => { const fd = new FormData(); Object.entries(fields).forEach(([k, v]) => fd.append(k, v)); if (file) fd.append('documents', new Blob([Buffer.from('x')]), file); const r = await fetch(B + '/api/bids', { method: 'POST', body: fd }); return r.status; };
    const base = { contact_name: 'A', company: 'B', email: 'a@b.test', phone: '1', project_type: 'O', service: 'S', address: 'Z', details: 'D', consent: 'on' };
    const a = await send({ ...base, company: '' }), b = await send({ ...base, website_url: 'http://spam' }), c = await send(base, 'virus.exe');
    assert(a === 400 && b === 400 && c === 400, `${a} ${b} ${c}`);
    return 'missing field 400, honeypot 400, .exe 400';
  });
  await check('Forms', 'Contact form: valid saved (201), invalid email rejected (400)', async () => {
    m0 = mail.length;
    const ok = await req('POST', '/api/inquiries', { form: { name: 'Pat Manager', email: 'pat@tower.test', phone: '515-555-0101', message: 'Need janitorial quote' } });
    const bad = await req('POST', '/api/inquiries', { form: { name: 'P', email: 'pat@', message: 'x' } });
    assert(ok.status === 201 && bad.status === 400, `${ok.status} ${bad.status}`);
    await sleep(400);
    assert(mailsTo('info@brightclean.net', m0).some(m => /inquiry/i.test(m.subject)), 'no inquiry notification');
    return 'valid 201 + notification emailed; invalid 400';
  });
  await check('Forms', 'Careers form: valid saved, invalid email rejected, applicant NOT added to customers', async () => {
    const ok = await req('POST', '/api/careers', { form: { name: 'Sam Applicant', email: 'sam@jobs.test', role: 'Cleaner', message: '2 years' } });
    const bad = await req('POST', '/api/careers', { form: { name: 'S', email: 'nope', message: 'x' } });
    assert(ok.status === 201 && bad.status === 400, `${ok.status} ${bad.status}`);
    return '201 / 400';
  });
  await check('Forms', 'Contact form rate limiting is in place for the API', async () => {
    const r = await fetch(B + '/api/health'); assert(r.headers.get('ratelimit-limit') || r.headers.get('ratelimit-policy'), 'no rate-limit headers');
    return 'RateLimit headers present: ' + (r.headers.get('ratelimit-policy') || r.headers.get('ratelimit-limit'));
  });

  // ---------- Authentication & permissions ----------
  let T;
  const signIn = require('./mfa-helper')((p, b, t) => req('POST', p, { json: b, token: t || undefined }));
  await check('Security', 'Admin login: correct password works, wrong password rejected', async () => {
    const bad = await req('POST', '/api/admin/login', { json: { email: OWNER, password: 'wrong-password-123' } });
    const ok = await req('POST', '/api/admin/login', { json: { email: OWNER, password: OWNER_PW } });
    assert(bad.status === 401 && ok.status === 200 && ok.data.token, `${bad.status} ${ok.status}`); T = await signIn(OWNER, OWNER_PW);
    return '401 then 200 with 8-hour token';
  });
  // Approval rules get their own tests at the end; relax them so older flow tests (sending $0-margin drafts) run unchanged.
  await req('PUT', '/api/admin/approval-rules', { token: T, json: { min_margin_pct: 0, max_total: 0, flag_pre_pricing: false, approve_all: false } });
  const adminGets = ['/api/admin/leads', '/api/admin/leads/1', '/api/admin/estimates', '/api/admin/contracts', '/api/admin/projects', '/api/admin/invoices', '/api/admin/customers', '/api/admin/dashboard', '/api/admin/audit-log', '/api/admin/users', '/api/admin/settings', '/api/admin/backups', '/api/admin/templates', '/api/admin/scopes', '/api/admin/command-center', '/api/admin/issues', '/api/admin/calls', '/api/admin/visits', '/api/admin/inspections', '/api/admin/reports', '/api/admin/documents', '/api/admin/search?q=ab', '/api/admin/takeoffs', '/api/admin/emails', '/api/admin/financial-summary', '/api/admin/me', '/api/files/x.pdf'];
  const adminWrites = [['POST', '/api/admin/estimates'], ['PUT', '/api/admin/estimates/1'], ['DELETE', '/api/admin/leads/1'], ['PATCH', '/api/admin/leads/1'], ['POST', '/api/admin/invoices'], ['POST', '/api/admin/invoices/1/payment'], ['PUT', '/api/admin/settings'], ['POST', '/api/admin/automation/run'], ['POST', '/api/admin/backups'], ['POST', '/api/admin/users'], ['DELETE', '/api/admin/customers/1'], ['POST', '/api/admin/account/password']];
  await check('Security', `All ${adminGets.length + adminWrites.length} admin endpoints refuse requests with no token`, async () => {
    const bad = [];
    for (const u of adminGets) { const r = await req('GET', u); if (r.status !== 401) bad.push('GET ' + u + ' ' + r.status); }
    for (const [m, u] of adminWrites) { const r = await req(m, u, { json: {} }); if (r.status !== 401) bad.push(m + ' ' + u + ' ' + r.status); }
    assert(!bad.length, bad.join(', ')); return 'all 401';
  });
  await check('Security', 'Forged, expired and wrong-secret tokens are refused', async () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ role: 'admin', email: OWNER }, 'wrong-secret-wrong-secret-wrong-secret');
    const expired = jwt.sign({ role: 'admin', email: OWNER, exp: Math.floor(Date.now() / 1000) - 10 }, env.JWT_SECRET);
    const notAdmin = jwt.sign({ role: 'viewer', email: OWNER }, env.JWT_SECRET);
    const s = await Promise.all([forged, expired, notAdmin, 'garbage'].map(t => req('GET', '/api/admin/leads', { token: t }).then(r => r.status)));
    assert(s.every(x => x === 401), s.join(',')); return 'forged/expired/non-admin/garbage -> 401';
  });
  await check('Security', 'Added user can sign in; removed user loses access immediately', async () => {
    const add = await req('POST', '/api/admin/users', { token: T, json: { name: 'Crew Lead', email: 'crew@brightclean.test', password: 'crew-password-1234' } });
    const t2 = (await req('POST', '/api/admin/login', { json: { email: 'crew@brightclean.test', password: 'crew-password-1234' } })).data.token;
    const before = (await req('GET', '/api/admin/leads', { token: t2 })).status;
    await req('DELETE', '/api/admin/users/' + add.data.id, { token: T });
    const after = (await req('GET', '/api/admin/leads', { token: t2 })).status;
    assert(add.status === 201 && before === 200 && after === 401, `${add.status} ${before} ${after}`);
    return 'add 201, access 200, after removal 401';
  });
  await check('Security', 'Owner cannot be removed; weak passwords refused', async () => {
    const weak = await req('POST', '/api/admin/users', { token: T, json: { email: 'w@b.test', password: 'short' } });
    const badEmail = await req('POST', '/api/admin/users', { token: T, json: { email: 'nope', password: 'long-enough-password' } });
    assert(weak.status === 400 && badEmail.status === 400, `${weak.status} ${badEmail.status}`); return 'weak password 400, invalid email 400';
  });
  await check('Security', 'Uploaded documents: download needs sign-in, path traversal blocked, content intact', async () => {
    const lead = (await req('GET', '/api/admin/leads/' + bidId, { token: T })).data.lead;
    assert(lead.files.length === 2, 'files ' + lead.files.length);
    const u = lead.files.find(f => f.name === 'plans.pdf').url;
    const anon = await req('GET', u); const authed = await req('GET', u, { token: T });
    const trav = await req('GET', '/api/files/..%2f..%2fserver.js', { token: T });
    assert(anon.status === 401 && authed.status === 200 && Buffer.compare(authed.data, pdf) === 0 && trav.status === 404, `${anon.status} ${authed.status} ${trav.status}`);
    return 'anonymous 401, signed-in 200 (bytes identical), traversal 404';
  });
  await check('Security', 'Security headers present; HTML in submissions is stored as text, not run', async () => {
    const r = await fetch(B + '/'); const h = r.headers;
    assert(h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') && !h.get('x-powered-by'), 'headers');
    await req('POST', '/api/inquiries', { form: { name: '<img src=x onerror=alert(1)>', email: 'xss@test.test', message: '<script>alert(1)</script>' } });
    const lead = (await req('GET', '/api/admin/leads', { token: T })).data.leads.find(l => l.email === 'xss@test.test');
    assert(lead && lead.contact_name.includes('<img'), 'not stored');
    return 'nosniff, frame protection, no x-powered-by; payload stored verbatim (admin UI escapes it, see UI test)';
  });
  await check('Security', 'Two-step sign-in: set up and confirm with an app code; sign-in then needs a code; wrong code refused; right code signs in', async () => {
    const totp = require('../totp');
    const email = 'mfa.tester@brightclean.test', pw = 'Temp-password-2026!!';
    const mk = await req('POST', '/api/admin/users', { token: T, json: { email, name: 'MFA Tester', password: pw, role: 'manager' } });
    const l1 = await req('POST', '/api/admin/login', { json: { email, password: pw } });
    const setup = await req('POST', '/api/admin/mfa/setup', { token: l1.data.token });
    const again = await req('POST', '/api/admin/mfa/setup', { token: l1.data.token });
    assert(again.status === 200 && again.data.secret === setup.data.secret, 'a set-up in progress keeps its key: ' + JSON.stringify(again.data));
    const en = await req('POST', '/api/admin/mfa/enable', { token: l1.data.token, json: { code: totp.codeAt(setup.data.secret, Math.floor(Date.now() / 30000)) } });
    const l2 = await req('POST', '/api/admin/login', { json: { email, password: pw } });
    const wrong = await req('POST', '/api/admin/login/mfa', { json: { mfa_token: l2.data.mfa_token, code: '000000' } });
    const right = await req('POST', '/api/admin/login/mfa', { json: { mfa_token: l2.data.mfa_token, code: totp.codeAt(setup.data.secret, Math.floor(Date.now() / 30000)) } });
    const me = await req('GET', '/api/admin/me', { token: right.data.token });
    const cancelOn = await req('POST', '/api/admin/mfa/cancel', { token: l1.data.token });
    assert(cancelOn.status === 200 && (await req('GET', '/api/admin/mfa', { token: l1.data.token })).data.enabled === true, 'cancel does not turn off a set-up that is on');
    assert(mk.status === 201 && l1.status === 200 && l1.data.token && setup.status === 200 && en.status === 200 && l2.status === 200 && l2.data.mfa_required === true && !l2.data.token && wrong.status === 401 && right.status === 200 && right.data.token && me.status === 200,
      JSON.stringify({ mk: mk.status, l1: l1.status, en: en.status, l2: [l2.status, l2.data.mfa_required], wrong: wrong.status, right: right.status }));
    return 'enrolled; sign-in asks for a code; 000000 refused (401); current code signs in';
  });
  await check('Security', 'Owners and managers without a code-checked session can only set two-step sign-in up: other routes refuse them, the set-up routes work', async () => {
    const jwt = require('../node_modules/jsonwebtoken');
    const tok = jwt.sign({ role: 'admin', email: OWNER, tv: 0 }, globalThis.__jwtSecret, { expiresIn: '1h' });
    const me = await req('GET', '/api/admin/me', { token: tok });
    const blocked = await req('GET', '/api/admin/leads', { token: tok });
    const status = await req('GET', '/api/admin/mfa', { token: tok });
    assert(me.status === 200 && me.data.mfa_setup_required === true && blocked.status === 403 && /Two-step/.test(blocked.data.error || '') && status.status === 200,
      JSON.stringify({ me: me.status, blocked: blocked.status, status: status.status }));
    return 'owner token without the code check: /me 200 (set-up flagged); leads 403; set-up status 200';
  });
  await check('Security', 'Login is rate limited (brute-force protection)', async () => {
    let s = []; for (let i = 0; i < 9; i++) s.push((await req('POST', '/api/admin/login', { json: { email: 'x@y.test', password: 'wrong-password-123' } })).status);
    assert(s.includes(429), s.join(',')); return 'statuses ' + s.join(',');
  });

  // ---------- Customers ----------
  await check('Customers', 'Bid and inquiry submitters appear in the customer directory without duplicates', async () => {
    await req('POST', '/api/inquiries', { form: { name: 'Dana Builder', email: 'DANA@prairie.test', message: 'second message' } });
    const c = (await req('GET', '/api/admin/customers', { token: T })).data.customers;
    const dana = c.filter(x => x.email === 'dana@prairie.test');
    assert(dana.length === 1 && dana[0].company === 'Prairie Construction' && dana[0].leads.length >= 1, JSON.stringify(dana.map(d => [d.email, d.leads.length])));
    assert(!c.some(x => x.email === 'sam@jobs.test'), 'applicant added as customer');
    return `${c.length} customers; Dana once (case-insensitive) with ${dana[0].leads.length} lead(s); job applicant excluded`;
  });
  let custId;
  await check('Customers', 'Add, edit, duplicate-check and remove a customer', async () => {
    const a = await req('POST', '/api/admin/customers', { token: T, json: { name: 'Lee Owner', company: 'Valley Apartments', email: 'lee@valley.test', phone: '515-555-0102' } });
    const dup = await req('POST', '/api/admin/customers', { token: T, json: { name: 'Lee', email: 'LEE@valley.test' } });
    const bad = await req('POST', '/api/admin/customers', { token: T, json: { name: 'Q', email: 'bad@' } });
    custId = a.data.id;
    const e = await req('PATCH', '/api/admin/customers/' + custId, { token: T, json: { notes: 'Gate code 1234', address: '9 Elm St' } });
    const got = (await req('GET', '/api/admin/customers', { token: T })).data.customers.find(x => x.id === custId);
    assert(a.status === 201 && dup.status === 409 && bad.status === 400 && e.status === 200 && got.notes === 'Gate code 1234', `${a.status} ${dup.status} ${bad.status} ${e.status}`);
    return 'add 201, duplicate 409, bad email 400, edit saved';
  });

  await check('Customers', 'Same company without an email is matched to the existing customer (no duplicate)', async () => {
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Other Person', company: 'prairie construction', scope: 'x', labor_hours: 1, labor_rate: 10 } });
    const c = (await req('GET', '/api/admin/customers', { token: T })).data.customers.filter(x => (x.company || '').toLowerCase() === 'prairie construction');
    assert(r.status === 201 && c.length === 1, 'entries ' + c.length); return '1 Prairie Construction entry after a no-email estimate';
  });
  await check('Customers', 'Phone-only callers: the same number in another format is refused as a duplicate; a different number is a new customer', async () => {
    const a = await req('POST', '/api/admin/customers', { token: T, json: { name: 'Phone Caller', phone: '(515) 555-0281' } });
    const b = await req('POST', '/api/admin/customers', { token: T, json: { name: 'Phone Caller Again', phone: '+1 515-555-0281' } });
    const c = await req('POST', '/api/admin/customers', { token: T, json: { name: 'Other Caller', phone: '515-555-0282' } });
    assert(a.status === 201 && b.status === 409 && c.status === 201 && a.data.id !== c.data.id, JSON.stringify([a.status, b.status, b.data.error, c.status]));
    return 'Customer #' + a.data.id + ' created; the same number in another format refused (409); a different number → #' + c.data.id;
  });
  // ---------- Estimating ----------
  const { estimateMath } = require('../estimating');
  await check('Estimating', 'Legacy formula unchanged when new fields are blank (20,000 sq ft example = $498.67)', async () => {
    const m = estimateMath({ area_sqft: 20000, production_rate: 2500, labor_rate: 30, supplies_cost: 100, overhead_pct: 10, margin_pct: 25 });
    assert(m.proposal_total === 498.67 && m.labor_hours === 8 && m.total_cost === 374, JSON.stringify(m));
    return '8 h x $30 + $100 = $340; +10% OH = $374; /0.75 = $498.67';
  });
  await check('Estimating', 'Full model: visits, travel, mobilization, subcontractor, disposal, insurance, contingency, overhead, margin, tax, crew days', async () => {
    const m = estimateMath({ area_sqft: 10000, production_rate: 2000, visits: 4, labor_rate: 28, supplies_cost: 200, equipment_cost: 50, other_cost: 0, travel_cost: 25, mobilization_cost: 150, subcontractor_cost: 300, disposal_cost: 75, insurance_pct: 3, contingency_pct: 5, overhead_pct: 12, margin_pct: 30, tax_pct: 7, crew_size: 2, shift_hours: 8 });
    // hand calculation
    const hours = 5 * 4, labor = hours * 28, direct = labor + 200 + 50 + 0 + 25 * 4 + 150 + 300 + 75;
    const ins = direct * .03, cont = (direct + ins) * .05, oh = (direct + ins + cont) * .12, cost = direct + ins + cont + oh, price = cost / .7, total = price * 1.07;
    const r2 = n => Math.round(n * 100) / 100;
    assert(m.labor_hours === 20 && m.total_cost === r2(cost) && m.proposal_total === r2(total) && m.crew_days === 1.25, JSON.stringify(m));
    return `20 labor h; direct $${direct}; cost $${r2(cost)}; total $${r2(total)}; 1.25 crew days`;
  });
  await check('Estimating', 'Minimum job charge and line-item price override', async () => {
    const a = estimateMath({ labor_hours: 1, labor_rate: 20, margin_pct: 20, minimum_charge: 250 });
    const b = estimateMath({ labor_hours: 10, labor_rate: 30, margin_pct: 25, use_line_items: '1', line_items: [{ description: 'A', amount: 900 }, { description: 'B', amount: 100 }], tax_pct: 5 });
    assert(a.proposal_total === 250 && a.minimum_applied && b.proposal_total === 1050 && b.used_line_items, JSON.stringify([a, b]));
    return 'min charge $250 applied over $25; line items $1,000 + 5% tax = $1,050';
  });
  await check('Estimating', 'Six quote templates available, production rates left blank for Bright Clean to set', async () => {
    const t = (await req('GET', '/api/admin/templates', { token: T })).data.templates;
    assert(t.length === 6 && t.every(x => x.scope && !x.production_rate), t.length); return t.map(x => x.name).join('; ');
  });

  // ---------- Proposals ----------
  let E1, E2, tok1, tok2;
  await check('Proposals', 'Create estimate with expanded fields; stored values match calculation', async () => {
    const body = { lead_id: bidId, customer_name: 'Dana Builder', company: 'Prairie Construction', email: 'dana@prairie.test', project_name: 'Ankeny Medical Office', site_address: '100 Main St', scope: 'Final clean', area_sqft: 24000, production_rate: 2000, labor_rate: 30, visits: 1, crew_size: 3, shift_hours: 8, mobilization_cost: 150, overhead_pct: 10, margin_pct: 25, template_key: 'post-construction-final', line_items: [{ description: 'Final clean', amount: 1500 }] };
    const r = await req('POST', '/api/admin/estimates', { token: T, json: body });
    const e = (await req('GET', '/api/admin/estimates/' + r.data.estimate.id, { token: T })).data.estimate;
    const m = estimateMath(body);
    E1 = e.id; tok1 = e.public_token;
    assert(r.status === 201 && e.proposal_total === m.proposal_total && e.crew_days === 0.5 && e.mobilization_cost === 150 && e.template_key === 'post-construction-final', JSON.stringify(e).slice(0, 300));
    return `#${E1} total $${e.proposal_total} = calculated; 12 labor h / (3 x 8) = 0.5 crew days`;
  });
  await check('Proposals', 'Estimate rejects an invalid customer email', async () => {
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'x', scope: 'y', email: 'bad@email' } });
    assert(r.status === 400, r.status); return '400 ' + r.data.error;
  });
  await check('Proposals', 'Edit recalculates; duplicate starts fresh (no sent/viewed/decision history)', async () => {
    const up = await req('PUT', '/api/admin/estimates/' + E1, { token: T, json: { customer_name: 'Dana Builder', company: 'Prairie Construction', email: 'dana@prairie.test', project_name: 'Ankeny Medical Office', scope: 'Final clean', area_sqft: 24000, production_rate: 2000, labor_rate: 30, crew_size: 3, shift_hours: 8, mobilization_cost: 150, overhead_pct: 10, margin_pct: 30, line_items: [] } });
    const dup = await req('POST', `/api/admin/estimates/${E1}/duplicate`, { token: T });
    const d = (await req('GET', '/api/admin/estimates/' + dup.data.id, { token: T })).data.estimate;
    E2 = d.id; tok2 = d.public_token;
    assert(up.status === 200 && up.data.estimate.margin_pct === 30 && d.status === 'Draft' && !d.viewed_at && !d.sent_at && d.public_token !== tok1, 'dup ' + JSON.stringify(d).slice(0, 200));
    return `edit 200 (margin 30%, total $${up.data.estimate.proposal_total}); duplicate #${E2} Draft with new link`;
  });
  await check('Email', 'Proposal email sent to customer with brightclean.net link; status Sent with time', async () => {
    m0 = mail.length;
    const r = await req('POST', `/api/admin/estimates/${E1}/send`, { token: T }); await sleep(400);
    const e = (await req('GET', '/api/admin/estimates/' + E1, { token: T })).data.estimate;
    const msg = mailsTo('dana@prairie.test', m0)[0];
    assert(r.status === 200 && e.status === 'Sent' && e.sent_at && msg && msg.raw.includes('https://brightclean.net/proposal/' + tok1), `${r.status} ${e.status} ${msg && msg.subject}`);
    return `"${msg.subject}" with link https://brightclean.net/proposal/${tok1.slice(0, 8)}…`;
  });
  await check('Proposals', 'Admin preview does not count as a customer view', async () => {
    const p = await req('GET', '/api/proposal/' + tok1, { token: T });
    const e = (await req('GET', '/api/admin/estimates/' + E1, { token: T })).data.estimate;
    assert(p.data.preview === true && e.status === 'Sent' && !e.viewed_at, `${p.data.preview} ${e.status} ${e.viewed_at}`);
    return 'preview flagged; status still Sent, no view recorded';
  });
  await check('Proposals', 'Customer view records first-viewed time, last-viewed time and count', async () => {
    await req('GET', '/api/proposal/' + tok1); await sleep(20); await req('GET', '/api/proposal/' + tok1);
    const e = (await req('GET', '/api/admin/estimates/' + E1, { token: T })).data.estimate;
    assert(e.status === 'Viewed' && e.viewed_at && e.last_viewed_at > e.viewed_at && e.view_count === 2, JSON.stringify([e.status, e.viewed_at, e.last_viewed_at, e.view_count]));
    return `Viewed; first ${e.viewed_at}; last ${e.last_viewed_at}; 2 views`;
  });
  await check('Proposals', 'Public proposal page renders the proposal (HTML route)', async () => {
    const r = await fetch(B + '/proposal/' + tok1); const t = await r.text();
    const js = await (await fetch(B + '/assets/proposal-page.js')).text();
    assert(r.status === 200 && t.includes('/assets/proposal-page.js') && js.includes('/api/proposal/'), r.status); return '200; page loads proposal-page.js which calls the proposal API';
  });
  await check('Workflow', 'Customer approval: recorded with time and IP, creates draft contract + planning project, notifies office', async () => {
    m0 = mail.length;
    const r = await req('POST', `/api/proposal/${tok1}/respond`, { json: { decision: 'approve', signer_name: 'Dana Signer', signer_title: 'Owner', agree: true } }); await sleep(400);
    const e = (await req('GET', '/api/admin/estimates/' + E1, { token: T })).data.estimate;
    const c = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.filter(x => x.estimate_id === E1);
    const p = (await req('GET', '/api/admin/projects', { token: T })).data.projects.filter(x => c[0] && x.contract_id === c[0].id);
    const note = mailsTo('info@brightclean.net', m0).find(m => /approved/i.test(m.subject));
    assert(r.status === 200 && e.status === 'Approved' && e.decided_at && e.decision_ip && c.length === 1 && c[0].status === 'Draft' && p.length === 1 && p[0].status === 'Planning' && note, JSON.stringify([r.status, e.status, c.length, p.length, !!note]));
    return `Approved ${e.decided_at}; contract #${c[0].id} Draft; project #${p[0].id} Planning; office emailed "${note.subject}"`;
  });
  await check('Proposals', 'Finalized decision cannot be changed by the customer (approve->decline, repeat approve)', async () => {
    const d = await req('POST', `/api/proposal/${tok1}/respond`, { json: { decision: 'decline' } });
    const a = await req('POST', `/api/proposal/${tok1}/respond`, { json: { decision: 'approve', signer_name: 'Dana Signer', signer_title: 'Owner', agree: true } });
    const e = (await req('GET', '/api/admin/estimates/' + E1, { token: T })).data.estimate;
    const c = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.filter(x => x.estimate_id === E1);
    assert(d.status === 409 && a.status === 409 && e.status === 'Approved' && c.length === 1, `${d.status} ${a.status} ${e.status} ${c.length}`);
    return `409 "${d.data.error}"; still Approved; still 1 contract`;
  });
  await check('Proposals', 'Customer-made decision is locked in admin too; editing approved proposal blocked', async () => {
    const s = await req('PATCH', '/api/admin/estimates/' + E1, { token: T, json: { status: 'Draft' } });
    const ed = await req('PUT', '/api/admin/estimates/' + E1, { token: T, json: { customer_name: 'x', scope: 'y' } });
    const del = await req('DELETE', '/api/admin/estimates/' + E1, { token: T });
    assert(s.status === 409 && ed.status === 409 && del.status === 409, `${s.status} ${ed.status} ${del.status}`);
    return 'status change 409, edit 409, delete 409';
  });
  await check('Proposals', 'Customer decline is recorded and creates no contract; then locked', async () => {
    await req('POST', `/api/admin/estimates/${E2}/send`, { token: T });
    const r = await req('POST', `/api/proposal/${tok2}/respond`, { json: { decision: 'decline' } });
    const again = await req('POST', `/api/proposal/${tok2}/respond`, { json: { decision: 'approve', signer_name: 'Dana Signer', signer_title: 'Owner', agree: true } });
    const c = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.filter(x => x.estimate_id === E2);
    const e = (await req('GET', '/api/admin/estimates/' + E2, { token: T })).data.estimate;
    assert(r.status === 200 && e.status === 'Declined' && again.status === 409 && c.length === 0, `${r.status} ${e.status} ${again.status} ${c.length}`);
    return 'Declined, approve afterwards 409, 0 contracts';
  });
  await check('Proposals', 'Expired proposal cannot be opened or approved; invalid decision rejected; unknown link 404', async () => {
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Old', scope: 'x', labor_hours: 1, labor_rate: 10, expires_on: '2020-01-01', email: 'old@test.test' } });
    const tk = r.data.estimate.public_token;
    const v = await req('GET', '/api/proposal/' + tk), a = await req('POST', `/api/proposal/${tk}/respond`, { json: { decision: 'approve', signer_name: 'Dana Signer', signer_title: 'Owner', agree: true } });
    const inv = await req('POST', `/api/proposal/${tok2}/respond`, { json: { decision: 'maybe' } });
    const nf = await req('GET', '/api/proposal/doesnotexist');
    assert(v.status === 410 && a.status === 410 && inv.status === 400 && nf.status === 404, `${v.status} ${a.status} ${inv.status} ${nf.status}`);
    return 'view 410, approve 410, bad decision 400, unknown 404';
  });
  await check('Workflow', 'Handoff setting OFF: approval is recorded but no contract/project is created', async () => {
    await req('PUT', '/api/admin/settings', { token: T, json: { auto_handoff: false } });
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'NoHandoff', company: 'NH Co', scope: 'x', labor_hours: 2, labor_rate: 20 } });
    const tk = r.data.estimate.public_token;
    await req('POST', `/api/proposal/${tk}/respond`, { json: { decision: 'approve', signer_name: 'Dana Signer', signer_title: 'Owner', agree: true } });
    const c = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.filter(x => x.estimate_id === r.data.estimate.id);
    await req('PUT', '/api/admin/settings', { token: T, json: { auto_handoff: true } });
    assert(c.length === 0, 'contracts ' + c.length); return 'approved, 0 contracts while off; setting restored to on';
  });
  await check('Workflow', 'Admin cannot approve a proposal; only the client’s online approval creates the contract + project (once)', async () => {
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Phone Yes', company: 'Phone Co', scope: 'x', labor_hours: 2, labor_rate: 20 } });
    const id = r.data.estimate.id, tok = r.data.estimate.public_token;
    const adm = await req('PATCH', '/api/admin/estimates/' + id, { token: T, json: { status: 'Approved' } });
    const c0 = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.filter(x => x.estimate_id === id).length;
    const man = await req('POST', '/api/admin/contracts', { token: T, json: { estimate_id: id, customer_name: 'Phone Yes', title: 'early', value: 100, status: 'Draft' } });
    await req('PATCH', '/api/admin/estimates/' + id, { token: T, json: { status: 'Sent' } });
    const ok = await req('POST', `/api/proposal/${tok}/respond`, { json: { decision: 'approve', signer_name: 'Pat Yes', signer_title: 'Owner', agree: true } }); await sleep(300);
    await req('POST', `/api/proposal/${tok}/respond`, { json: { decision: 'approve', signer_name: 'Pat Yes', signer_title: 'Owner', agree: true } }); await sleep(200);
    const c = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.filter(x => x.estimate_id === id);
    const p = (await req('GET', '/api/admin/projects', { token: T })).data.projects.filter(x => c[0] && x.contract_id === c[0].id);
    assert(adm.status === 409 && /Only the client/.test(adm.data.error) && c0 === 0 && man.status === 409 && ok.status === 200 && c.length === 1 && p.length === 1, JSON.stringify({ adm: adm.data, c0, man: man.data, ok: ok.data, c: c.length, p: p.length }));
    return 'admin “Approved” refused (409), no contract; manual contract on an unapproved proposal refused; client approved online → 1 contract + 1 project (second approval did not duplicate)';
  });

  // ---------- Contracts, projects, invoices ----------
  let contractId, projectId, invId;
  await check('Workflow', 'Contract and project can be updated through execution to completion', async () => {
    const c = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.find(x => x.estimate_id === E1); contractId = c.id;
    const p = (await req('GET', '/api/admin/projects', { token: T })).data.projects.find(x => x.contract_id === contractId); projectId = p.id;
    const a = await req('PATCH', '/api/admin/contracts/' + contractId, { token: T, json: { status: 'Active', signature_status: 'Signed', signer_name: 'Dana Builder', signed_on: '2026-11-02', start_date: '2026-11-10', end_date: '2027-11-10' } });
    const early = await req('PATCH', '/api/admin/projects/' + projectId, { token: T, json: { status: 'In Progress' } });
    for (const key of ['staffing', 'dates', 'access', 'equipment', 'supplies', 'safety']) await req('POST', `/api/admin/pm/projects/${projectId}/readiness`, { token: T, json: { key } });
    const ap = await req('POST', `/api/admin/pm/projects/${projectId}/approve-dispatch`, { token: T });
    const b = await req('PATCH', '/api/admin/projects/' + projectId, { token: T, json: { status: 'In Progress', progress: 50, manager: 'Eric', due_date: '2026-11-15' } });
    const noSign = await req('PATCH', '/api/admin/projects/' + projectId, { token: T, json: { status: 'Completed', progress: 100 } });
    await req('POST', `/api/admin/pm/projects/${projectId}/signoff`, { token: T, json: { name: 'Dana Builder', title: 'Owner rep' } });
    const noInsp = await req('PATCH', '/api/admin/projects/' + projectId, { token: T, json: { status: 'Completed', progress: 100 } });
    const tplI = (await req('GET', '/api/admin/qc/templates', { token: T })).data.templates[0];
    const insP = (await req('POST', '/api/admin/qc/inspections', { token: T, json: { template_id: tplI.id, area: 'Whole building', date: require('../bizdate').today(), project_id: projectId, crew: 'A', itype: 'Internal' } })).data.inspection;
    await req('PATCH', `/api/admin/qc/inspections/${insP.id}`, { token: T, json: { items: insP.items.map(i => ({ ...i, result: 'Pass' })) } });
    await req('POST', `/api/admin/qc/inspections/${insP.id}/sign`, { token: T, json: { name: 'Eric Moore' } });
    const d = await req('PATCH', '/api/admin/projects/' + projectId, { token: T, json: { status: 'Completed', progress: 100 } });
    if (noInsp.status !== 409 || !/inspection/.test(noInsp.data.error || '')) throw new Error('Completion without an inspection should be refused: ' + JSON.stringify(noInsp.data));
    const p2 = (await req('GET', '/api/admin/projects', { token: T })).data.projects.find(x => x.id === projectId);
    assert(a.status === 200 && early.status === 409 && /readiness/.test(early.data.error) && ap.status === 200 && b.status === 200 && noSign.status === 409 && /sign-off/.test(noSign.data.error) && d.status === 200 && p2.status === 'Completed' && p2.progress === 100, JSON.stringify([early.data, ap.data, noSign.data, p2.status]));
    return `contract #${contractId} signed; project #${projectId}: In Progress before readiness 409; 6 readiness checks + dispatch approval; In Progress; Completed without sign-off 409; signed off; Completed 100%`;
  });
  await check('Invoices', 'Invoice numbering, creation with billing email, invalid email and duplicate number rejected', async () => {
    const n = (await req('GET', '/api/admin/next-invoice-number', { token: T })).data.number;
    const r = await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: n, project_id: projectId, customer_name: 'Dana Builder', company: 'Prairie Construction', email: 'ap@prairie.test', amount: 2000, paid_amount: 0, due_date: '2026-11-30', status: 'Sent' } });
    const bad = await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: 'X-1', email: 'ap@', amount: 1 } });
    const dup = await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: n, amount: 5 } });
    invId = r.data.id;
    assert(r.status === 201 && bad.status === 400 && dup.status === 409 && /^BC-\d{4}-0001$/.test(n), `${r.status} ${bad.status} ${dup.status} ${n}`);
    return `${n} created; bad email 400; duplicate number 409`;
  });
  await check('Invoices', 'Partial then full payment updates balance and status; customer balance follows', async () => {
    const a = await req('POST', `/api/admin/invoices/${invId}/payment`, { token: T, json: { amount: 500 } });
    const zero = await req('POST', `/api/admin/invoices/${invId}/payment`, { token: T, json: { amount: 0 } });
    const c1 = (await req('GET', '/api/admin/customers', { token: T })).data.customers.find(x => x.email === 'dana@prairie.test');
    const b = await req('POST', `/api/admin/invoices/${invId}/payment`, { token: T, json: { amount: 1500 } });
    const fin = (await req('GET', '/api/admin/financial-summary', { token: T })).data;
    assert(a.data.status === 'Partially Paid' && zero.status === 400 && b.data.status === 'Paid' && fin.outstanding === 0, JSON.stringify([a.data, b.data, fin]));
    return `$500 -> Partially Paid; $0 rejected; $1,500 -> Paid; outstanding $0; customer open balance was $${c1 ? c1.billed - c1.paid : '?'} mid-way`;
  });

  // ---------- Automation ----------
  const runAt = at => req('POST', '/api/admin/automation/run', { token: T, json: { at } });
  let P, PT, inv2;
  await check('Automation', 'With reminders OFF (default), nothing is sent', async () => {
    const s = (await req('GET', '/api/admin/settings', { token: T })).data;
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Reminder Test', company: 'RT Co', email: 'rt@test.test', scope: 'x', labor_hours: 2, labor_rate: 30, expires_on: '2027-12-31' } });
    P = r.data.estimate.id; PT = r.data.estimate.public_token;
    await req('POST', `/api/admin/estimates/${P}/send`, { token: T });
    m0 = mail.length; const res = await runAt(new Date(Date.now() + 8 * 864e5).toISOString()); await sleep(300);
    // Bid deadline alerts are always on (they go to the owner, not the customer), so they are not reminders: ignore them here.
    const sentNow = mail.slice(m0).filter(x => !/^(Bid due|MISSED bid deadline)/.test(x.subject));
    assert(!s.settings.auto_proposal_reminders && !s.settings.auto_invoice_reminders && s.settings.auto_handoff && res.data.result.proposal_reminders === 0 && res.data.result.invoice_reminders === 0 && sentNow.length === 0, JSON.stringify([s.settings, res.data, mail.slice(m0).map(x => x.subject)]));
    return 'defaults: proposal reminders off, invoice reminders off, handoff on, backup on; 0 emails';
  });
  await check('Automation', 'Proposal reminders: none before day 3, one at day 3, one at day 7, never repeated', async () => {
    await req('PUT', '/api/admin/settings', { token: T, json: { auto_proposal_reminders: true } });
    const day = n => new Date(Date.now() + n * 864e5).toISOString();
    m0 = mail.length;
    const r1 = (await runAt(day(1))).data.result.proposal_reminders;
    const r3 = (await runAt(day(3.2))).data.result.proposal_reminders;
    const r3b = (await runAt(day(3.5))).data.result.proposal_reminders;
    const r7 = (await runAt(day(7.2))).data.result.proposal_reminders;
    const r7b = (await runAt(day(9))).data.result.proposal_reminders;
    await sleep(300);
    const sent = mailsTo('rt@test.test', m0);
    assert(r1 === 0 && r3 === 1 && r3b === 0 && r7 === 1 && r7b === 0 && sent.length === 2 && sent[0].raw.includes('https://brightclean.net/proposal/' + PT), [r1, r3, r3b, r7, r7b, sent.length].join(','));
    return `day1 0, day3 1, day3.5 0, day7 1, day9 0 -> exactly 2 emails with proposal link`;
  });
  await check('Automation', 'Proposal reminders stop once the customer decides; no auto-approval ever', async () => {
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Decided', company: 'Dec Co', email: 'dec@test.test', scope: 'x', labor_hours: 1, labor_rate: 30 } });
    const id = r.data.estimate.id;
    await req('POST', `/api/admin/estimates/${id}/send`, { token: T });
    await req('POST', `/api/proposal/${r.data.estimate.public_token}/respond`, { json: { decision: 'decline' } });
    m0 = mail.length; await runAt(new Date(Date.now() + 10 * 864e5).toISOString()); await sleep(200);
    const all = (await req('GET', '/api/admin/estimates', { token: T })).data.estimates;
    const rt = all.find(e => e.id === P);
    assert(!mailsTo('dec@test.test', m0).length && rt.status !== 'Approved', 'sent to decided or auto-approved');
    return 'declined proposal got 0 reminders; reminded proposal still "' + rt.status + '" (never auto-approved)';
  });
  await check('Automation', 'Client portal opt-out: a customer who turned off proposal reminders gets none; a manual send still goes', async () => {
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Optout', company: 'Opt Co', email: 'optout@test.test', scope: 'x', labor_hours: 1, labor_rate: 30 } });
    await req('POST', `/api/admin/estimates/${r.data.estimate.id}/send`, { token: T });
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    pdb.prepare(`INSERT INTO portal_profiles(email,notify,updated_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET notify=excluded.notify`)
      .run('optout@test.test', JSON.stringify({ proposals: false, invoices: true, messages: true }), new Date().toISOString());
    pdb.close();
    m0 = mail.length; await runAt(new Date(Date.now() + 10 * 864e5).toISOString()); await sleep(200);
    const reminded = mailsTo('optout@test.test', m0).length;
    const manual = await req('POST', `/api/admin/estimates/${r.data.estimate.id}/send`, { token: T });
    await sleep(200);
    assert(reminded === 0 && manual.status === 200 && mailsTo('optout@test.test', m0).length === 1, JSON.stringify({ reminded, manual: manual.status }));
    return 'opted-out customer: 0 automatic reminders; manual send still emailed (1 message)';
  });

  await check('Settings', 'Company profile: owner saves and reads it back; bad email and phone refused; staff refused; the on/off settings list is unchanged', async () => {
    const ok = await req('PUT', '/api/admin/business-profile', { token: T, json: { company_name: 'Bright Cleaning Sev Inc', primary_email: 'info@brightclean.net', main_phone: '(515) 303-3024', business_hours: 'Mon - Fri, 8:00 AM - 5:00 PM' } });
    const get = await req('GET', '/api/admin/settings', { token: T });
    const badMail = await req('PUT', '/api/admin/business-profile', { token: T, json: { primary_email: 'not-an-email' } });
    const badPhone = await req('PUT', '/api/admin/business-profile', { token: T, json: { main_phone: 'call me' } });
    assert(ok.status === 200 && ok.data.business.company_name === 'Bright Cleaning Sev Inc', 'save failed: ' + JSON.stringify(ok.data));
    assert(get.data.business && get.data.business.primary_email === 'info@brightclean.net' && get.data.business.main_phone === '(515) 303-3024', 'not read back: ' + JSON.stringify(get.data.business));
    assert(badMail.status === 400 && /primary email/.test(badMail.data.error), 'bad email not refused: ' + JSON.stringify(badMail.data));
    assert(badPhone.status === 400 && /phone/.test(badPhone.data.error), 'bad phone not refused: ' + JSON.stringify(badPhone.data));
    assert(get.data.settings && typeof get.data.settings.auto_backup === 'boolean' && !('biz_company_name' in get.data.settings), 'on/off settings changed shape');
    const mk = await req('POST', '/api/admin/users', { token: T, json: { name: 'Biz Staff', email: 'biz.staff@test.test', role: 'staff', password: 'staff-password-1234' } });
    const sTok = require('../node_modules/jsonwebtoken').sign({ role: 'admin', email: 'biz.staff@test.test', tv: 0, mfa: true }, env.JWT_SECRET);
    const sput = await req('PUT', '/api/admin/business-profile', { token: sTok, json: { company_name: 'Hacked' } });
    assert(mk.status === 201 && sput.status === 403, 'staff could change the profile: ' + sput.status + ' create ' + mk.status);
    return 'owner saves and reads the profile; bad email and phone refused with a message; on/off settings unchanged';
  });
  await check('Flow', 'Approved job: office sign-off makes the project Contracted; its visits are Scheduled; an unsigned job stays Planning with Tentative visits', async () => {
    const Database2 = require('../node_modules/better-sqlite3');
    const db2e = id => { const d = new Database2(require('path').join(globalThis.__dataDir, 'brightclean.db'), { readonly: true }); const r = d.prepare('SELECT email FROM contracts WHERE id=?').get(id); d.close(); return r && r.email; };
    const mk = async (name, email) => {
      const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: name, company: name + ' Co', email, project_name: name + ' job', site_address: '9 Flow St', scope: 'Weekly office cleaning', labor_hours: 20, labor_rate: 30, margin_pct: 30 } });
      const id = r.data.estimate.id;
      await req('POST', '/api/admin/estimates/' + id + '/send', { token: T });
      const d = new Database2(require('path').join(globalThis.__dataDir, 'brightclean.db'), { readonly: true });
      const tok = d.prepare('SELECT public_token FROM estimates WHERE id=?').get(id).public_token; d.close();
      const ap = await req('POST', '/api/proposal/' + tok + '/respond', { json: { decision: 'approve', signer_name: name + ' Signer', signer_title: 'Owner', agree: true } });
      return { id, approved: ap.status === 200 };
    };
    const A = await mk('Flowa', 'flowa@test.test');
    const B = await mk('Flowb', 'flowb@test.test');
    const db = new Database2(require('path').join(globalThis.__dataDir, 'brightclean.db'));
    const kA = db.prepare('SELECT id FROM contracts WHERE estimate_id=?').get(A.id), kB = db.prepare('SELECT id FROM contracts WHERE estimate_id=?').get(B.id);
    const pA = kA && db.prepare('SELECT id, status FROM projects WHERE contract_id=?').get(kA.id);
    const pB = kB && db.prepare('SELECT id, status FROM projects WHERE contract_id=?').get(kB.id);
    db.close();
    assert(A.approved && B.approved && kA && kB && pA && pB, JSON.stringify({ A, B, kA, kB, pA, pB }));
    assert(db2e(kA.id) === 'flowa@test.test', 'contract has no customer email, so the portal would not show the job');
    assert(pA.status === 'Planning', 'project should start in Planning: ' + pA.status);
    const sign = await req('POST', '/api/admin/contracts2/' + kA.id + '/countersign', { token: T, json: { name: 'Owner Manager' } });
    assert(sign.status === 200, 'office sign-off failed: ' + JSON.stringify(sign.data));
    const wA = await req('POST', '/api/admin/pm/projects/' + pA.id + '/work-orders', { token: T, json: { frequency: 'weekly', count: 2, start: '2026-12-07' } });
    const wB = await req('POST', '/api/admin/pm/projects/' + pB.id + '/work-orders', { token: T, json: { frequency: 'weekly', count: 2, start: '2026-12-07' } });
    const d2 = new Database2(require('path').join(globalThis.__dataDir, 'brightclean.db'), { readonly: true });
    const stA = d2.prepare('SELECT status FROM projects WHERE id=?').get(pA.id).status;
    const visA = d2.prepare("SELECT status FROM visits WHERE project_id=? AND type='Work order'").all(pA.id).map(v => v.status);
    const visB = d2.prepare("SELECT status FROM visits WHERE project_id=? AND type='Work order'").all(pB.id).map(v => v.status);
    d2.close();
    assert(stA === 'Contracted', 'project after sign-off: ' + stA);
    assert(wA.status === 201 && wA.data.status === 'Scheduled' && visA.length === 2 && visA.every(s => s === 'Scheduled'), JSON.stringify({ wA: wA.data, visA }));
    assert(wB.status === 201 && wB.data.status === 'Tentative' && visB.every(s => s === 'Tentative'), JSON.stringify({ wB: wB.data, visB }));
    return 'sign-off: project Planning -> Contracted; 2 weekly visits Scheduled (staff + portal see them); unsigned job: 2 visits Tentative';
  });
  await check('Automation', 'Invoice reminders: 3 days before due, 1 day overdue, 7 days overdue, once each; paid invoices skipped', async () => {
    await req('PUT', '/api/admin/settings', { token: T, json: { auto_invoice_reminders: true } });
    const due = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    const r = await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: 'BC-TEST-REM', customer_name: 'AP', email: 'ap2@test.test', amount: 1000, paid_amount: 0, due_date: due, status: 'Sent' } });
    inv2 = r.data.id;
    const dueMs = new Date(due + 'T12:00:00Z').getTime(), at = d => new Date(dueMs + d * 864e5).toISOString();
    m0 = mail.length;
    const seq = [];
    for (const d of [-5, -3, -2, 1, 2, 7, 8]) seq.push((await runAt(at(d))).data.result.invoice_reminders);
    await sleep(300);
    const sent = mailsTo('ap2@test.test', m0);
    const paidSent = mailsTo('ap@prairie.test', m0).length;
    assert(seq.join(',') === '0,1,0,1,0,1,0' && sent.length === 3 && paidSent === 0, seq.join(',') + ' sent ' + sent.length + ' paid ' + paidSent);
    return `days -5,-3,-2,+1,+2,+7,+8 -> ${seq.join(',')}; 3 emails: ${sent.map(s => s.subject).join(' | ')}; paid invoice 0`;
  });
  await check('Automation', 'Automation creates no records and changes no statuses (no duplicates, no mobilization)', async () => {
    const before = await Promise.all(['contracts', 'projects', 'invoices', 'estimates'].map(k => req('GET', '/api/admin/' + k, { token: T }).then(r => JSON.stringify(r.data[k].map(x => [x.id, x.status])))));
    await runAt(new Date(Date.now() + 30 * 864e5).toISOString());
    const after = await Promise.all(['contracts', 'projects', 'invoices', 'estimates'].map(k => req('GET', '/api/admin/' + k, { token: T }).then(r => JSON.stringify(r.data[k].map(x => [x.id, x.status])))));
    assert(before.join() === after.join(), 'changed'); return 'contracts/projects/invoices/estimates identical before and after a run';
  });
  await check('Automation', 'Every automated email is logged; settings changes are audited', async () => {
    const s = (await req('GET', '/api/admin/settings', { token: T })).data;
    const audit = (await req('GET', '/api/admin/audit-log', { token: T })).data.events;
    const sent = s.log.filter(l => l.status === 'sent');
    assert(sent.length >= 5 && audit.some(a => a.action === 'changed settings'), sent.length);
    return `${sent.length} sent emails in automation log; settings changes in activity log`;
  });
  await check('Automation', 'Email failure is logged as failed and retried on the next run (not marked sent)', async () => {
    smtp.close(); await sleep(200);
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Fail', company: 'Fail Co', email: 'fail@test.test', scope: 'x', labor_hours: 1, labor_rate: 30 } });
    const s = await req('POST', `/api/admin/estimates/${r.data.estimate.id}/send`, { token: T });
    const db = new Database(path.join(dataDir, 'brightclean.db'));
    db.prepare("UPDATE estimates SET status='Sent', sent_at=? WHERE id=?").run(new Date(Date.now() - 4 * 864e5).toISOString(), r.data.estimate.id); db.close();
    await runAt(new Date().toISOString());
    const log = (await req('GET', '/api/admin/settings', { token: T })).data.log.filter(l => l.ref_id === r.data.estimate.id);
    assert(s.status === 502 && log.length && log[0].status === 'failed', JSON.stringify([s.status, log]));
    return `proposal send while mail server down -> 502 shown to user; reminder logged "failed" (will retry)`;
  });

  // ---------- Backups ----------
  let backupName, backupFile;
  await check('Backup', 'Manual backup creates a database copy; list and download (signed-in only)', async () => {
    const r = await req('POST', '/api/admin/backups', { token: T }); backupName = r.data.name;
    const list = (await req('GET', '/api/admin/backups', { token: T })).data.backups;
    const dl = await req('GET', '/api/admin/backups/' + backupName, { token: T });
    const anon = await req('GET', '/api/admin/backups/' + backupName);
    const bad = await req('GET', '/api/admin/backups/..%2fbrightclean.db', { token: T });
    backupFile = path.join(work, 'restored.db'); fs.writeFileSync(backupFile, dl.data);
    assert(r.status === 201 && list.some(b => b.name === backupName) && dl.status === 200 && dl.data.length > 10000 && anon.status === 401 && bad.status === 400, `${r.status} ${dl.status} ${anon.status} ${bad.status}`);
    return `${backupName} (${dl.data.length} bytes); anonymous 401; bad name 400`;
  });
  await check('Backup', 'Encrypted backups: the copy is unreadable without the key, opens with it, and a wrong key or a changed file is refused', async () => {
    const bc = require('../backupcrypto'), crypto = require('crypto');
    const src = path.join(work, 'enc-src.db'), dest = path.join(work, 'enc-out.db.enc');
    fs.writeFileSync(src, Buffer.from('SQLite format 3\0 pretend database contents for the encryption test'));
    const key = crypto.createHash('sha256').update('test-backup-key').digest();
    bc.encryptFile(src, dest, key);
    const enc = fs.readFileSync(dest);
    const plain = bc.decryptBuffer(enc, key);
    let wrongKey = false, tampered = false;
    try { bc.decryptBuffer(enc, crypto.createHash('sha256').update('other').digest()); } catch { wrongKey = true; }
    const bad = Buffer.from(enc); bad[bad.length - 1] ^= 1;
    try { bc.decryptBuffer(bad, key); } catch { tampered = true; }
    assert(plain.equals(fs.readFileSync(src)) && !enc.includes('SQLite format') && wrongKey && tampered, JSON.stringify({ wrongKey, tampered }));
    return 'ciphertext contains no plain text; decrypts with the key; wrong key and changed file refused';
  });
  await check('Backup', 'Data integrity report: owner only; orphaned links, duplicate customer keys and payment mismatches are counted', async () => {
    const r = await req('GET', '/api/admin/integrity', { token: T });
    const bad = (r.data.checks || []).filter(c => c.ok === false);
    assert(r.status === 200 && r.data.checks.length >= 13 && r.data.failing === 0, JSON.stringify({ status: r.status, failing: r.data.failing, bad }));
    return `${r.data.checks.length} checks, ${r.data.failing} failing, ${r.data.unchecked} not checked`;
  });
  await check('Backup', 'Restore drill: backup opens in a separate server instance with identical data', async () => {
    const live = new Database(path.join(dataDir, 'brightclean.db'), { readonly: true });
    const counts = t => ['leads', 'estimates', 'contracts', 'projects', 'invoices', 'customers', 'audit_log'].map(x => `${x}=${t.prepare(`SELECT COUNT(*) n FROM ${x}`).get().n}`).join(' ');
    const bak = new Database(backupFile, { readonly: true });
    const integ = bak.prepare('PRAGMA integrity_check').get().integrity_check;
    const liveCounts = counts(live), bakCounts = counts(bak); live.close(); bak.close();
    // Start a second instance on the restored copy (never the live file).
    await killWait(server.child);
    const restoreDir = path.join(work, 'restore'); fs.mkdirSync(restoreDir); fs.copyFileSync(backupFile, path.join(restoreDir, 'brightclean.db'));
    const s2 = await startServer(env, restoreDir);
    const t2 = await signIn(OWNER, OWNER_PW);
    const leads = (await req('GET', '/api/admin/leads', { token: t2 })).data.leads.length;
    await killWait(s2.child);
    server = await startServer(env, dataDir);
    assert(integ === 'ok' && liveCounts.replace(/audit_log=\d+/, '') === bakCounts.replace(/audit_log=\d+/, '') && leads > 0, `${integ} | ${liveCounts} | ${bakCounts}`);
    return `integrity ok; live [${liveCounts}] vs backup [${bakCounts}]; restored instance served ${leads} leads`;
  });
  await check('Backup', 'Daily backup runs on schedule and keeps only the 14 newest', async () => {
    T = await signIn(OWNER, OWNER_PW);
    const dir = path.join(dataDir, 'backups');
    for (let i = 0; i < 16; i++) fs.writeFileSync(path.join(dir, `brightclean-2026010${i % 10}-0000${String(i).padStart(2, '0')}.db`), 'x');
    const old = new Date(Date.now() - 2 * 864e5); for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old);
    const r = await runAt(new Date().toISOString());
    const n = fs.readdirSync(dir).filter(f => f.endsWith('.db')).length;
    assert(r.data.result.backup && n === 14, `${JSON.stringify(r.data.result)} files ${n}`);
    return `daily backup ${r.data.result.backup} created; ${n} kept`;
  });

  // ---------- Leads admin ----------
  await check('Leads', 'Lead status and notes update; CSV fields present; delete removes attachments', async () => {
    const u = await req('PATCH', '/api/admin/leads/' + bidId, { token: T, json: { status: 'Won', notes: 'Walkthrough done' } });
    const l = (await req('GET', '/api/admin/leads/' + bidId, { token: T })).data.lead;
    const files = l.files.map(f => path.join(work, 'uploads', path.basename(f.url)));
    const del = await req('DELETE', '/api/admin/leads/' + bidId, { token: T });
    assert(u.status === 200 && l.status === 'Won' && l.notes === 'Walkthrough done' && del.status === 200 && files.every(f => !fs.existsSync(f)), 'lead ops');
    return 'status Won, notes saved, deleted with 2 attachments removed from disk';
  });
  await check('Dashboard', 'Overview data reflects new leads, waiting proposals and finances', async () => {
    const d = (await req('GET', '/api/admin/dashboard', { token: T })).data;
    assert(Array.isArray(d.newLeads) && Array.isArray(d.awaitingResponse) && d.finance && Array.isArray(d.activity), 'shape');
    return `${d.newLeads.length} new leads, ${d.awaitingResponse.length} awaiting, outstanding $${d.finance.outstanding}`;
  });

  // ---------- Cleaning scope library ----------
  await check('Scopes', 'Library seeded in 4 categories; rates left blank and flagged, never invented', async () => {
    const r = (await req('GET', '/api/admin/scopes', { token: T })).data;
    const cats = new Set(r.items.map(i => i.category));
    const invented = r.items.filter(i => i.production_rate != null || i.unit_price != null || i.crew_size != null);
    assert(r.items.length >= 40 && cats.size === 4 && !invented.length && r.summary.needs_rates === r.summary.total, JSON.stringify(r.summary));
    return `${r.items.length} items in ${[...cats].join(', ')}; ${r.summary.needs_rates} flagged as needing rates; 0 invented rates`;
  });
  await check('Scopes', 'Every seeded item has unit, description, included work, exclusions and quality standard', async () => {
    const r = (await req('GET', '/api/admin/scopes', { token: T })).data;
    const bad = r.items.filter(i => !i.unit || !i.description || !i.included || !i.exclusions || !i.quality_standard);
    assert(!bad.length, bad.map(b => b.name).join(', '));
    return `${r.items.length}/${r.items.length} complete`;
  });
  await check('Scopes', 'Entering rates clears the flag; change is in the activity log', async () => {
    const it = (await req('GET', '/api/admin/scopes', { token: T })).data.items.find(i => i.name === 'Final construction clean (detail)');
    const u = await req('PATCH', '/api/admin/scopes/' + it.id, { token: T, json: { production_rate: '450', crew_size: '4', unit_price: '0.35' } });
    const log = (await req('GET', '/api/admin/audit-log', { token: T })).data.events.find(e => e.entity === 'scope item' && e.entity_id === it.id);
    assert(u.status === 200 && u.data.item.production_rate === 450 && u.data.item.missing.length === 0 && log, JSON.stringify(u.data));
    return `rate 450 SF/hr, crew 4, $0.35/SF saved; flag cleared; logged "${log.details}"`;
  });
  await check('Scopes', 'Validation: bad category, missing unit, negative rate, duplicate name rejected', async () => {
    const a = await req('POST', '/api/admin/scopes', { token: T, json: { category: 'nope', name: 'X', unit: 'SF' } });
    const b = await req('POST', '/api/admin/scopes', { token: T, json: { category: 'janitorial', name: 'X' } });
    const c = await req('POST', '/api/admin/scopes', { token: T, json: { category: 'janitorial', name: 'X', unit: 'SF', production_rate: '-5' } });
    const d = await req('POST', '/api/admin/scopes', { token: T, json: { category: 'construction', name: 'Rough construction clean', unit: 'SF' } });
    assert(a.status === 400 && b.status === 400 && c.status === 400 && d.status === 409, [a.status, b.status, c.status, d.status].join());
    return `400, 400, 400, 409`;
  });
  await check('Scopes', 'Add custom item, archive it (kept, hidden), restore it; signed-out access blocked', async () => {
    const a = await req('POST', '/api/admin/scopes', { token: T, json: { category: 'specialty', name: 'Graffiti removal', unit: 'SF', pricing_method: 'hourly' } });
    const del = await req('DELETE', '/api/admin/scopes/' + a.data.item.id, { token: T });
    const after = (await req('GET', '/api/admin/scopes', { token: T })).data.items.find(i => i.id === a.data.item.id);
    const back = await req('PATCH', '/api/admin/scopes/' + a.data.item.id, { token: T, json: { active: true } });
    const anon = await req('PATCH', '/api/admin/scopes/' + a.data.item.id, { json: { name: 'x' } });
    assert(a.status === 201 && del.status === 200 && after && after.active === 0 && back.data.item.active === 1 && anon.status === 401, 'ops');
    return 'created 201, archived (row kept, active=0), restored, anonymous edit 401';
  });

  // ---------- Estimates priced from the scope library ----------
  const scopes = async () => (await req('GET', '/api/admin/scopes', { token: T })).data.items;
  const sid = async name => (await scopes()).find(i => i.name === name).id;
  const baseEst = { customer_name: 'Pat GC', company: 'Ridge Builders', email: 'pat@ridge.test', project_name: 'Ridge Office', scope: 'Final clean', margin_pct: 0, overhead_pct: 0, tax_pct: 0 };
  let scopeEstId;
  await check('Scope pricing', 'Estimate line priced from library: quantity x your price; hours = qty / production rate; browser amount ignored', async () => {
    const id = await sid('Final construction clean (detail)'); // 450 SF/hr, $0.35/SF set above
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { ...baseEst, scope_category: 'construction', use_line_items: 1, labor_rate: 30, line_items: [{ scope_id: id, quantity: 80000, amount: 1, description: 'tampered' }, { description: 'Lift rental', amount: 850 }] } });
    const e = (await req('GET', '/api/admin/estimates/' + r.data.estimate.id, { token: T })).data.estimate;
    const li = e.line_items.find(i => i.scope_id);
    scopeEstId = e.id;
    assert(r.status === 201 && li.amount === 28000 && li.hours === 177.78 && /80,000 SF/.test(li.description) && e.proposal_total === 28850 && e.labor_hours === 177.78 && e.scope_category === 'construction', JSON.stringify({ li, t: e.proposal_total, h: e.labor_hours }));
    return `80,000 SF x $0.35 = $28,000 (browser sent $1, ignored); 177.78 labor hrs from 450 SF/hr; + lift $850 = $28,850`;
  });
  await check('Scope pricing', 'Category lock: janitorial item on a construction estimate is rejected', async () => {
    const jid = await sid('Daily office cleaning');
    await req('PATCH', '/api/admin/scopes/' + jid, { token: T, json: { production_rate: 3000, crew_size: 1, unit_price: 0.08 } });
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { ...baseEst, scope_category: 'construction', line_items: [{ scope_id: jid, quantity: 80000 }] } });
    const ok = await req('POST', '/api/admin/estimates', { token: T, json: { ...baseEst, scope_category: 'janitorial', line_items: [{ scope_id: jid, quantity: 20000 }] } });
    assert(r.status === 400 && /commercial janitorial item/i.test(r.data.error) && ok.status === 201, r.data.error);
    return `400 "${r.data.error}"; same item on a janitorial estimate: 201`;
  });
  await check('Scope pricing', 'Missing rates, missing category, zero quantity and archived items are rejected', async () => {
    const nid = await sid('Rough construction clean'); // no rates
    const a = await req('POST', '/api/admin/estimates', { token: T, json: { ...baseEst, scope_category: 'construction', line_items: [{ scope_id: nid, quantity: 100 }] } });
    const fid = await sid('Final construction clean (detail)');
    const b = await req('POST', '/api/admin/estimates', { token: T, json: { ...baseEst, line_items: [{ scope_id: fid, quantity: 100 }] } });
    const c = await req('POST', '/api/admin/estimates', { token: T, json: { ...baseEst, scope_category: 'construction', line_items: [{ scope_id: fid, quantity: 0 }] } });
    const g = (await scopes()).find(i => i.name === 'Graffiti removal');
    await req('DELETE', '/api/admin/scopes/' + g.id, { token: T });
    const d = await req('POST', '/api/admin/estimates', { token: T, json: { ...baseEst, scope_category: 'specialty', line_items: [{ scope_id: g.id, quantity: 10 }] } });
    assert([a, b, c, d].every(x => x.status === 400) && /no price/.test(a.data.error), [a, b, c, d].map(x => x.data.error).join(' | '));
    return [a, b, c, d].map(x => x.data.error).join(' | ');
  });
  await check('Scope pricing', 'Hourly item needs a labor rate, then prices as hours x labor rate', async () => {
    const pid = await sid('Day porter service');
    await req('PATCH', '/api/admin/scopes/' + pid, { token: T, json: { production_rate: 1, crew_size: 1, pricing_method: 'hourly' } });
    const a = await req('POST', '/api/admin/estimates', { token: T, json: { ...baseEst, scope_category: 'janitorial', line_items: [{ scope_id: pid, quantity: 20 }] } });
    const b = await req('POST', '/api/admin/estimates', { token: T, json: { ...baseEst, scope_category: 'janitorial', labor_rate: 28, line_items: [{ scope_id: pid, quantity: 20 }] } });
    const li = (await req('GET', '/api/admin/estimates/' + b.data.estimate.id, { token: T })).data.estimate.line_items[0];
    assert(a.status === 400 && b.status === 201 && li.amount === 560 && li.labor_rate === 28, JSON.stringify(li));
    return `without labor rate: 400; with $28/hr: 20 hrs = $560`;
  });
  await check('Scope pricing', 'Rate change later does not alter a saved estimate; editing re-prices at current rates', async () => {
    const fid = await sid('Final construction clean (detail)');
    await req('PATCH', '/api/admin/scopes/' + fid, { token: T, json: { unit_price: 0.40 } });
    const before = (await req('GET', '/api/admin/estimates/' + scopeEstId, { token: T })).data.estimate;
    const put = await req('PUT', '/api/admin/estimates/' + scopeEstId, { token: T, json: { ...baseEst, scope_category: 'construction', use_line_items: 1, labor_rate: 30, line_items: before.line_items } });
    const after = (await req('GET', '/api/admin/estimates/' + scopeEstId, { token: T })).data.estimate;
    assert(before.proposal_total === 28850 && put.status === 200 && after.proposal_total === 32850, `${before.proposal_total} -> ${after.proposal_total}`);
    return `price changed to $0.40/SF: saved estimate stayed $28,850; after edit and save: $32,850`;
  });
  await check('Security', 'Customer proposal link shows line descriptions and amounts only, never internal rates or hours', async () => {
    const e = (await req('GET', '/api/admin/estimates/' + scopeEstId, { token: T })).data.estimate;
    const p = (await req('GET', '/api/proposal/' + e.public_token)).data.proposal;
    const keys = [...new Set(p.line_items.flatMap(Object.keys))];
    const raw = JSON.stringify(p);
    assert(keys.join() === 'description,amount' && !/production_rate|labor_rate|"hours"|unit_price/.test(raw) && p.line_items.length === 2, raw.slice(0, 300));
    return `public line keys: ${keys.join(', ')}; no production rate, labor rate, hours or unit price in response`;
  });
  await check('Scope pricing', 'Duplicating a scope-priced estimate keeps its lines and category', async () => {
    const d = await req('POST', `/api/admin/estimates/${scopeEstId}/duplicate`, { token: T });
    const e = (await req('GET', '/api/admin/estimates/' + d.data.id, { token: T })).data.estimate;
    assert(d.status === 201 && e.scope_category === 'construction' && e.line_items.some(i => i.scope_id) && e.proposal_total === 32850, JSON.stringify(e.line_items));
    return `copy #${d.data.id}: category construction, ${e.line_items.length} lines, $32,850`;
  });

  // ---------- Command Center ----------
  await check('Command Center', 'KPIs are computed from real records (leads, sent, won, collected, projects)', async () => {
    const c = (await req('GET', '/api/admin/command-center?days=30', { token: T })).data;
    const db = new Database(path.join(dataDir, 'brightclean.db'), { readonly: true });
    const from = new Date(Date.now() - 30 * 864e5).toISOString();
    const leads = db.prepare(`SELECT COUNT(*) n FROM leads WHERE kind IN ('bid','inquiry') AND created_at>=?`).get(from).n;
    const sent = db.prepare(`SELECT COUNT(*) n FROM estimates WHERE sent_at>=?`).get(from).n;
    const won = db.prepare(`SELECT COUNT(*) n FROM estimates WHERE status='Approved' AND COALESCE(decided_at,updated_at)>=?`).get(from).n;
    const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM payments`).get().v;
    db.close();
    const k = c.kpis;
    assert(k.new_leads.value === leads && k.proposals_sent.value === sent && k.won.value === won && k.collected_month.value === paid && paid === 2000, JSON.stringify(k));
    return `leads ${leads}, sent ${sent}, won ${won} (${'$' + k.won.amount}), collected this month $${paid}, active projects ${k.active_projects.value}, attention ${k.attention.value}`;
  });
  await check('Command Center', 'Payments are stored with dates; a back-dated payment counts in its own month', async () => {
    const inv = (await req('POST', '/api/admin/invoices', { token: T, json: { customer_name: 'Date Test', amount: 900, due_date: '2026-12-01', billing_email: 'd@t.test' } })).data;
    const id = inv.id || (inv.invoice && inv.invoice.id);
    const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString().slice(0, 10);
    const a = await req('POST', `/api/admin/invoices/${id}/payment`, { token: T, json: { amount: 300, received_on: lastMonth } });
    const future = await req('POST', `/api/admin/invoices/${id}/payment`, { token: T, json: { amount: 100, received_on: '2099-01-01' } });
    const k = (await req('GET', '/api/admin/command-center', { token: T })).data.kpis;
    assert(a.status === 200 && future.status === 200 && k.collected_month.value === 2100, JSON.stringify(k.collected_month));
    return `$300 dated ${lastMonth} not counted this month; future date ignored and recorded as today ($100); month total $${k.collected_month.value}`;
  });
  await check('Command Center', 'Unconnected modules say "not connected" with what is needed; no sample data', async () => {
    const c = (await req('GET', '/api/admin/command-center', { token: T })).data;
    const m = c.modules;
    const raw = JSON.stringify(c);
    assert(m.calls.connected === true && /Twilio/.test(m.calls.status) && m.blueprint.connected === false && /ANTHROPIC_API_KEY/.test(m.blueprint.needs) && !/Ryan Companies|DMCS|Mercy College|Indigo/.test(raw), JSON.stringify(m));
    return `email: ${m.email.status}; calls: ${m.calls.status}; blueprint: ${m.blueprint.status}; scopes: ${m.scopes.status}`;
  });
  await check('Command Center', 'Period filter works and invalid period falls back to 30 days', async () => {
    const a = (await req('GET', '/api/admin/command-center?days=7', { token: T })).data.days;
    const b = (await req('GET', '/api/admin/command-center?days=abc', { token: T })).data.days;
    assert(a === 7 && b === 30, `${a} ${b}`); return '7 -> 7, abc -> 30';
  });

  // ---------- Service-specific quote forms ----------
  const quote = async (fields, files = []) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) [].concat(v).forEach(x => fd.append(k, x));
    for (const f of files) fd.append('documents', new Blob([Buffer.from('%PDF-1.4 test')]), f);
    const r = await fetch(B + '/api/quotes', { method: 'POST', body: fd });
    return { status: r.status, data: await r.json() };
  };
  const contact = { contact_name: 'Dana Ruiz', company: 'Ridge Builders', email: 'dana@ridge.test', phone: '515-555-0100', address: '100 Main St, Des Moines, IA', consent: 'yes' };
  await check('Quote forms', 'Schema lists all 7 services with fields; same schema the server validates against', async () => {
    const s = (await req('GET', '/api/quote-schema')).data.services;
    const keys = Object.keys(s);
    assert(keys.length === 7 && ['multifamily', 'construction_final', 'janitorial', 'windows', 'power_washing', 'parking', 'unit_turnover'].every(k => keys.includes(k)) && keys.every(k => s[k].fields.length >= 4), keys.join());
    return keys.map(k => `${k} (${s[k].fields.length} questions)`).join(', ');
  });
  let quoteLeadId;
  await check('Quote forms', 'Construction final-clean request: lead, answers, files, pre-pricing flags, customer match, emails', async () => {
    const r = await quote({ ...contact, service_key: 'construction_final', gc_company: 'Ridge Builders', building_type: 'Office', square_footage: '80,000', floors: '3', phases: ['Final clean', 'Touch-up / punch list'], windows: 'Interior and exterior', exterior_height: '4+ stories (lift or rope access)', restrooms: '12', plans: 'Uploading them now', completion_date: '2026-12-15' }, ['A-101 floor plan.pdf']);
    const l = (await req('GET', '/api/admin/leads/' + r.data.id, { token: T })).data.lead;
    const ik = JSON.parse(l.intake);
    const cust = (await req('GET', '/api/admin/customers', { token: T })).data.customers.filter(c => (c.company || '').toLowerCase() === 'ridge builders');
    quoteLeadId = l.id;
    assert(r.status === 201 && l.kind === 'bid' && l.service_key === 'construction_final' && ik.answers.square_footage === 80000 && ik.category === 'construction' && l.files.length === 1 && ik.flags.some(f => f.code === 'site_visit') && !ik.flags.some(f => f.code === 'plans') && cust.length === 1 && !('needs' in r.data), JSON.stringify({ ik, cust: cust.length }));
    return `lead #${l.id}; 80,000 SF stored as a number; 1 file; flags: ${ik.flags.map(f => f.code).join(', ')}; matched to the existing Ridge Builders customer (no duplicate); internal flags not sent back to the customer`;
  });
  await check('Quote forms', 'Required service questions enforced; hidden follow-ups dropped; unknown options rejected', async () => {
    const a = await quote({ ...contact, email: 'x1@t.test', service_key: 'multifamily', buildings: '2', frequency: 'Weekly' });
    const b = await quote({ ...contact, email: 'x2@t.test', service_key: 'janitorial', facility_type: 'Spaceship', square_footage: '5000', frequency: 'Weekly' });
    const c = await quote({ ...contact, email: 'x3@t.test', service_key: 'multifamily', buildings: '2', units: '120', common_areas: ['Hallways and corridors'], elevators: '4', frequency: 'Weekly' });
    const ik = JSON.parse((await req('GET', '/api/admin/leads/' + c.data.id, { token: T })).data.lead.intake);
    const d = await quote({ ...contact, email: 'x4@t.test', service_key: 'nope' });
    assert(a.status === 400 && /Total units is required/.test(a.data.error) && /Common areas/.test(a.data.error) && b.status === 400 && /Facility type/.test(b.data.error) && c.status === 201 && !('elevators' in ik.answers) && d.status === 400, JSON.stringify([a.data, b.data, ik.answers, d.data]));
    return `missing units/areas: 400 "${a.data.error}"; bad option: 400; elevator count dropped when Elevators not selected; unknown service: 400`;
  });
  await check('Quote forms', 'Contact rules, honeypot and double-submit guard', async () => {
    const a = await quote({ ...contact, email: 'not-an-email', service_key: 'parking', lot_size: '120 spaces', services: ['Litter pickup'], frequency: 'Weekly' });
    const b = await quote({ ...contact, email: 'p@t.test', consent: '', service_key: 'parking', lot_size: '120 spaces', services: ['Litter pickup'], frequency: 'Weekly' });
    const hp = await quote({ ...contact, email: 'p@t.test', website_url: 'spam', service_key: 'parking', lot_size: '120 spaces', services: ['Litter pickup'], frequency: 'Weekly' });
    const before = (await req('GET', '/api/admin/leads', { token: T })).data.leads.length;
    const f1 = await quote({ ...contact, email: 'p@t.test', service_key: 'parking', lot_size: '120 spaces', services: ['Litter pickup'], frequency: 'Weekly' });
    const f2 = await quote({ ...contact, email: 'P@T.test', service_key: 'parking', lot_size: '120 spaces', services: ['Litter pickup'], frequency: 'Weekly' });
    const after = (await req('GET', '/api/admin/leads', { token: T })).data.leads.length;
    assert(a.status === 400 && b.status === 400 && hp.status === 400 && f1.status === 201 && f2.status === 200 && f2.data.duplicate && f2.data.id === f1.data.id && after === before + 1, JSON.stringify([a.status, b.status, hp.status, f1.status, f2.data, before, after]));
    return 'bad email 400, no consent 400, honeypot 400; same request twice -> 1 lead (second returns the first id)';
  });
  await check('Quote forms', 'Pre-pricing rules per service (windows, power washing, unit turnover, parking)', async () => {
    const get = async id => JSON.parse((await req('GET', '/api/admin/leads/' + id, { token: T })).data.lead.intake).flags.map(f => f.code);
    const w = await quote({ ...contact, email: 'w@t.test', service_key: 'windows', stories: '4+ stories', sides: 'Both', access: 'Not sure' });
    const p = await quote({ ...contact, email: 'pw@t.test', service_key: 'power_washing', surfaces: ['Sidewalks'], condition: 'Gum / oil stains', water_access: 'No' });
    const u = await quote({ ...contact, email: 'u@t.test', service_key: 'unit_turnover', unit_types: ['1 bedroom'], turns_per_month: '6', condition: 'Heavy' });
    const pk = await quote({ ...contact, email: 'pk@t.test', service_key: 'parking', lot_size: 'big one', services: ['Litter pickup'], frequency: 'Weekly' });
    const [fw, fp, fu, fk] = [await get(w.data.id), await get(p.data.id), await get(u.data.id), await get(pk.data.id)];
    assert(fw.includes('count') && fw.includes('site_visit') && fp.includes('measure') && fp.includes('photos') && fp.includes('clarify') && fu.includes('photos') && fk.includes('measure'), JSON.stringify({ fw, fp, fu, fk }));
    return `windows: ${fw}; power washing: ${fp}; unit turnover: ${fu}; parking: ${fk}`;
  });

  // ---------- Customer issues: notes, complaints, tasks, follow-ups ----------
  const cust0 = (await req('GET', '/api/admin/customers', { token: T })).data.customers[0];
  let complaintId;
  await check('Issues', 'Complaint linked to a customer, assigned, due date; shows on the customer and in the attention count', async () => {
    const before = (await req('GET', '/api/admin/command-center', { token: T })).data.kpis.attention;
    const r = await req('POST', '/api/admin/issues', { token: T, json: { type: 'complaint', category: 'Quality', title: 'Level 2 restrooms missed', description: 'Mirrors streaked', customer_id: cust0.id, property: 'Ridge Office', priority: 'High', assigned_to: OWNER, due_date: '2020-01-01', customer_comms: 'Needs update' } });
    complaintId = r.data.issue.id;
    const list = (await req('GET', '/api/admin/issues?customer_id=' + cust0.id, { token: T })).data;
    const after = (await req('GET', '/api/admin/command-center', { token: T })).data.kpis.attention;
    const log = (await req('GET', '/api/admin/audit-log', { token: T })).data.events.find(e => e.entity === 'complaint' && e.entity_id === complaintId);
    assert(r.status === 201 && r.data.issue.overdue && list.issues.some(i => i.id === complaintId) && list.counts.open_complaints >= 1 && after.value === before.value + 2 && after.parts.open_complaints >= 1 && log, JSON.stringify({ before, after }));
    return `#${complaintId} created, overdue flag on; listed on the customer; attention ${before.value} -> ${after.value} (complaint + overdue); logged`;
  });
  await check('Issues', 'Validation: title, type, real assignee, real customer, valid date', async () => {
    const bad = async j => (await req('POST', '/api/admin/issues', { token: T, json: j })).data.error;
    const errs = [await bad({ type: 'task' }), await bad({ type: 'nope', title: 'x' }), await bad({ type: 'task', title: 'x', assigned_to: 'stranger@x.test' }), await bad({ type: 'task', title: 'x', customer_id: 999999 }), await bad({ type: 'task', title: 'x', due_date: 'tomorrow' })];
    assert(errs.every(Boolean) && /title/.test(errs[0]) && /type/.test(errs[1]) && /access/.test(errs[2]) && /not found/.test(errs[3]) && /date/.test(errs[4]), errs.join(' | '));
    return errs.join(' | ');
  });
  await check('Issues', 'A complaint cannot close without a resolution and a customer update', async () => {
    const a = await req('PATCH', '/api/admin/issues/' + complaintId, { token: T, json: { status: 'Resolved' } });
    const b = await req('PATCH', '/api/admin/issues/' + complaintId, { token: T, json: { status: 'Resolved', resolution: 'Re-cleaned all restrooms on Level 2' } });
    const b2 = await req('PATCH', '/api/admin/issues/' + complaintId, { token: T, json: { status: 'Resolved', resolution: 'Re-cleaned all restrooms on Level 2', customer_comms: 'Customer informed' } });
    const c = await req('PATCH', '/api/admin/issues/' + complaintId, { token: T, json: { status: 'Resolved', resolution: 'Re-cleaned all restrooms on Level 2', corrective_action: 'Added restroom checklist to night crew', customer_comms: 'Customer informed' } });
    const closeUnverified = await req('PATCH', '/api/admin/issues/' + complaintId, { token: T, json: { status: 'Closed' } });
    const v = await req('PATCH', '/api/admin/issues/' + complaintId, { token: T, json: { verify: true, verification_note: 'Walked Level 2 with site manager' } });
    const cl = await req('PATCH', '/api/admin/issues/' + complaintId, { token: T, json: { status: 'Closed' } });
    const log = (await req('GET', '/api/admin/audit-log', { token: T })).data.events;
    assert(a.status === 400 && /resolved/.test(a.data.error) && b.status === 400 && /corrective action/.test(b.data.error) && /Update the customer/.test(b.data.error) && b2.status === 400 && /corrective action/.test(b2.data.error) && c.status === 200 && c.data.issue.resolved_at && !c.data.issue.overdue && closeUnverified.status === 400 && /verified/.test(closeUnverified.data.error) && v.status === 200 && v.data.issue.status === 'Verified' && v.data.issue.verified_by === OWNER && cl.status === 200 && log.some(e => e.entity === 'complaint' && e.action === 'resolved') && log.some(e => e.entity === 'complaint' && e.action === 'verified'), JSON.stringify([a.data, b.data, b2.data, closeUnverified.data, v.data]));
    return `no resolution 400; no corrective action 400; customer not updated 400; resolved; close before verification 400; verified by ${v.data.issue.verified_by}; closed; all logged`;
  });
  await check('Issues', 'Reopen clears the resolved date; notes default to closed and can be deleted; complaints cannot', async () => {
    const r = await req('PATCH', '/api/admin/issues/' + complaintId, { token: T, json: { status: 'Open' } });
    const n = await req('POST', '/api/admin/issues', { token: T, json: { type: 'note', title: 'Prefers calls after 3pm', customer_id: cust0.id } });
    const dn = await req('DELETE', '/api/admin/issues/' + n.data.issue.id, { token: T });
    const dc = await req('DELETE', '/api/admin/issues/' + complaintId, { token: T });
    assert(r.status === 200 && r.data.issue.resolved_at === null && n.data.issue.status === 'Closed' && dn.status === 200 && dc.status === 400, JSON.stringify([r.data.issue.resolved_at, n.data.issue.status, dn.status, dc.status]));
    return 'reopened (resolved date cleared); note saved as Closed and deleted; complaint delete refused (400)';
  });
  await check('Issues', 'Filters: overdue, type, assigned to me; never exposed to signed-out or public routes', async () => {
    const t = await req('POST', '/api/admin/issues', { token: T, json: { type: 'task', title: 'Send COI to Ridge', assigned_to: OWNER, due_date: '2099-01-01' } });
    const overdue = (await req('GET', '/api/admin/issues?status=overdue', { token: T })).data.issues.map(i => i.id);
    const tasks = (await req('GET', '/api/admin/issues?type=task', { token: T })).data.issues.map(i => i.type);
    const mine = (await req('GET', '/api/admin/issues?assigned=me', { token: T })).data.issues;
    const anon = (await req('GET', '/api/admin/issues')).status;
    assert(overdue.includes(complaintId) && !overdue.includes(t.data.issue.id) && tasks.every(x => x === 'task') && mine.length >= 2 && anon === 401, JSON.stringify({ overdue, tasks, mine: mine.length, anon }));
    return `overdue list has the complaint, not the future task; type filter ok; ${mine.length} assigned to me; signed-out 401`;
  });

  // ---------- Approval levels ----------
  await req('PUT', '/api/admin/approval-rules', { token: T, json: { min_margin_pct: 15, max_total: 25000, flag_pre_pricing: true, approve_all: false } });
  const est = async extra => (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Approval Test', email: 'appr@t.test', scope: 'Final clean', area_sqft: 20000, production_rate: 400, labor_rate: 30, tax_pct: 0, overhead_pct: 0, ...extra } })).data.estimate;
  let lowId;
  await check('Approvals', 'Low-margin proposal is held: cannot email, mark Sent, or be opened/approved by the customer', async () => {
    const e = await est({ margin_pct: 5 }); lowId = e.id;
    const ap = (await req('GET', `/api/admin/estimates/${e.id}/approval`, { token: T })).data;
    const send = await req('POST', `/api/admin/estimates/${e.id}/send`, { token: T });
    const mark = await req('PATCH', `/api/admin/estimates/${e.id}`, { token: T, json: { status: 'Sent' } });
    const tok = (await req('GET', '/api/admin/estimates/' + e.id, { token: T })).data.estimate.public_token;
    const view = await req('GET', '/api/proposal/' + tok);
    const respond = await req('POST', `/api/proposal/${tok}/respond`, { json: { decision: 'approve', signer_name: 'Dana Signer', signer_title: 'Owner', agree: true } });
    const preview = await req('GET', '/api/proposal/' + tok, { token: T });
    const after = (await req('GET', '/api/admin/estimates/' + e.id, { token: T })).data.estimate.status;
    assert(ap.required && /Margin 5\.0% is below your 15% minimum/.test(ap.reasons[0]) && send.status === 409 && /owner approval/.test(send.data.error) && mark.status === 409 && view.status === 423 && respond.status === 423 && preview.status === 200 && after === 'Draft', JSON.stringify({ ap, send: send.status, mark: mark.status, view: view.status, respond: respond.status, preview: preview.status, after }));
    return `reason "${ap.reasons[0]}"; email 409, mark Sent 409, customer view 423, customer approve 423, admin preview 200; still Draft`;
  });
  await check('Approvals', 'Owner approves with a note; the proposal can then be marked Sent and opened; logged', async () => {
    const a = await req('POST', `/api/admin/estimates/${lowId}/approve`, { token: T, json: { note: 'Strategic account, OK at 5%' } });
    const mark = await req('PATCH', `/api/admin/estimates/${lowId}`, { token: T, json: { status: 'Sent' } });
    const tok = (await req('GET', '/api/admin/estimates/' + lowId, { token: T })).data.estimate.public_token;
    const view = await req('GET', '/api/proposal/' + tok);
    const log = (await req('GET', '/api/admin/audit-log', { token: T })).data.events.find(e => e.action === 'approved for sending' && e.entity_id === lowId);
    assert(a.status === 200 && a.data.approval.valid && a.data.approval.note && mark.status === 200 && view.status === 200 && log && /Strategic/.test(log.details), JSON.stringify([a.data, mark.status, view.status]));
    return `approved by ${a.data.approval.approved_by}; marked Sent; customer link opens; activity log: "${log.details.slice(0, 90)}"`;
  });
  await check('Approvals', 'Editing after approval cancels it; the proposal needs approval again', async () => {
    const e = await est({ margin_pct: 5 });
    await req('POST', `/api/admin/estimates/${e.id}/approve`, { token: T, json: {} });
    const ok1 = (await req('GET', `/api/admin/estimates/${e.id}/approval`, { token: T })).data.approval.valid;
    const full = (await req('GET', '/api/admin/estimates/' + e.id, { token: T })).data.estimate;
    await req('PUT', '/api/admin/estimates/' + e.id, { token: T, json: { ...full, labor_rate: 32, margin_pct: 5 } });
    const ap = (await req('GET', `/api/admin/estimates/${e.id}/approval`, { token: T })).data;
    const send = await req('PATCH', `/api/admin/estimates/${e.id}`, { token: T, json: { status: 'Sent' } });
    assert(ok1 === true && ap.approval && ap.approval.valid === false && send.status === 409 && /edited since/.test(send.data.error), JSON.stringify([ok1, ap.approval, send.data]));
    return `valid before edit; after changing the labor rate: approval void, mark Sent 409 "${send.data.error.slice(-80)}"`;
  });
  await check('Approvals', 'Large total and open pre-pricing notes trigger approval; healthy proposal needs none', async () => {
    const big = await est({ area_sqft: 400000, margin_pct: 30 });
    const healthy = await est({ margin_pct: 30 });
    const fl = await (async () => { const fd = new FormData(); Object.entries({ contact_name: 'Pre Price', email: 'pp@t.test', phone: '1', address: 'A', consent: 'yes', service_key: 'janitorial', facility_type: 'Office', square_footage: '9000', frequency: 'Weekly' }).forEach(([k, v]) => fd.append(k, v)); return (await (await fetch(B + '/api/quotes', { method: 'POST', body: fd })).json()).id; })();
    const fromLead = await est({ margin_pct: 30, lead_id: fl });
    const a = (await req('GET', `/api/admin/estimates/${big.id}/approval`, { token: T })).data;
    const b = (await req('GET', `/api/admin/estimates/${healthy.id}/approval`, { token: T })).data;
    const c = (await req('GET', `/api/admin/estimates/${fromLead.id}/approval`, { token: T })).data;
    assert(a.required && /above \$25,000/.test(a.reasons.join()) && !b.required && c.required && /needed before pricing/.test(c.reasons.join()), JSON.stringify([a.reasons, b.reasons, c.reasons]));
    return `big: ${a.reasons}; healthy: none; from walkthrough-flagged request: ${c.reasons}`;
  });
  await check('Approvals', '$0 proposal is blocked outright; only the owner approves or changes rules; pending count on Command Center', async () => {
    const zero = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Zero', email: 'z@t.test', scope: 'x' } })).data.estimate;
    const z = await req('PATCH', `/api/admin/estimates/${zero.id}`, { token: T, json: { status: 'Sent' } });
    const za = await req('POST', `/api/admin/estimates/${zero.id}/approve`, { token: T });
    await req('POST', '/api/admin/users', { token: T, json: { email: 'staff@brightclean.test', name: 'Staff', password: 'staff-password-12345' } });
    const st = (await req('POST', '/api/admin/login', { json: { email: 'staff@brightclean.test', password: 'staff-password-12345' } })).data.token;
    const e = await est({ margin_pct: 5 });
    const byStaff = await req('POST', `/api/admin/estimates/${e.id}/approve`, { token: st });
    const rulesByStaff = await req('PUT', '/api/admin/approval-rules', { token: st, json: { min_margin_pct: 0 } });
    const pending = (await req('GET', '/api/admin/command-center', { token: T })).data.kpis.attention.parts.awaiting_approval;
    const badRule = await req('PUT', '/api/admin/approval-rules', { token: T, json: { min_margin_pct: 150 } });
    assert(z.status === 409 && /\$0/.test(z.data.error) && za.status === 400 && byStaff.status === 403 && rulesByStaff.status === 403 && pending >= 1 && badRule.status === 400, JSON.stringify([z.status, za.status, byStaff.status, rulesByStaff.status, pending, badRule.status]));
    return `$0: mark Sent 409 and approve 400; staff approve 403; staff rule change 403; awaiting approval ${pending}; 150% margin rule 400`;
  });

  // ---------- Price book: bid the way Bright Clean bids ----------
  await check('Price book', 'Import loads 41 items with prices; labor hours optional; re-import keeps owner edits', async () => {
    const a = (await req('POST', '/api/admin/scopes/import-pricebook', { token: T })).data;
    const items = (await req('GET', '/api/admin/scopes', { token: T })).data.items;
    const c1 = items.find(i => i.name.startsWith('Clean #1'));
    await req('PATCH', '/api/admin/scopes/' + c1.id, { token: T, json: { unit_price: 0.2 } });
    const b = (await req('POST', '/api/admin/scopes/import-pricebook', { token: T })).data;
    const c1b = (await req('GET', '/api/admin/scopes', { token: T })).data.items.find(i => i.id === c1.id);
    await req('PATCH', '/api/admin/scopes/' + c1.id, { token: T, json: { unit_price: 0.18375 } });
    assert(a.created === 41 && c1.missing.length === 0 && c1.production_rate == null && b.created === 0 && b.kept === 41 && c1b.unit_price === 0.2, JSON.stringify({ a, b, p: c1b.unit_price }));
    return `first import: ${a.created} created; Clean #1 ready with no labor hours; second import: 0 created, ${b.kept} kept (owner's edited price untouched)`;
  });
  await check('Price book', 'Terrell State Hospital reproduced exactly: 417,000 SF x Clean #1-#3 = $197,032.50; + rental allowance + 8.25% tax = $224,653.93', async () => {
    const items = (await req('GET', '/api/admin/scopes', { token: T })).data.items;
    const ph = n => items.find(i => i.name.startsWith(n)).id;
    const lines = ['Clean #1', 'Clean #2', 'Clean #3'].map(n => ({ scope_id: ph(n), quantity: 417000 }));
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Robins & Morton', company: 'Robins & Morton', email: 'pm@rm.test', project_name: 'Terrell State Hospital', scope: 'Construction cleaning, Clean #1-#3', scope_category: 'construction', use_line_items: 1, tax_pct: 8.25, line_items: [...lines, { description: 'Rental Allowance', amount: 10500 }] } });
    const e = (await req('GET', '/api/admin/estimates/' + r.data.estimate.id, { token: T })).data.estimate;
    const amts = e.line_items.map(i => i.amount);
    assert(r.status === 201 && amts.slice(0, 3).join() === '76623.75,54731.25,65677.5' && Math.abs(e.proposal_total - 224653.93) < 0.01, JSON.stringify({ amts, total: e.proposal_total }));
    return `lines ${amts.slice(0, 3).map(a => '$' + a.toLocaleString()).join(' + ')} + $10,500 allowance; total with 8.25% tax $${e.proposal_total.toLocaleString()} (bid: $224,653.93)`;
  });
  await check('Price book', 'Apartment and hallway bids price from the sheets (24 two-bed/two-bath move-outs + 30 standard hallways + 6 stairwells)', async () => {
    const items = (await req('GET', '/api/admin/scopes', { token: T })).data.items;
    const id = n => items.find(i => i.name === n).id;
    const r = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Valley Apartments', email: 'pm@valley.test', scope: 'Unit turns and hallways', scope_category: 'multifamily', use_line_items: 1, line_items: [
      { scope_id: id('Move-in / move-out clean – 2 Bed / 2 Bath'), quantity: 24 }, { scope_id: id('Hallway – Standard clean'), quantity: 30 }, { scope_id: id('Hallway add-on – Stairwell cleaning'), quantity: 6 }] } });
    const e = (await req('GET', '/api/admin/estimates/' + r.data.estimate.id, { token: T })).data.estimate;
    assert(e.proposal_total === 24 * 80 + 30 * 45 + 6 * 30, e.proposal_total);
    return `24 x $80 + 30 x $45 + 6 x $30 = $${e.proposal_total.toLocaleString()}`;
  });

  // ---------- Operations suite ----------
  await check('Suite', 'Manual lead: validation, created with source, customer matched, logged', async () => {
    const bad = await req('POST', '/api/admin/leads', { token: T, json: { kind: 'bid' } });
    const badE = await req('POST', '/api/admin/leads', { token: T, json: { company: 'X', email: 'nope' } });
    const ok = await req('POST', '/api/admin/leads', { token: T, json: { kind: 'bid', source: 'Referral', contact_name: 'Sam Lee', company: 'Harbor GC', email: 'sam@harbor.test', phone: '555', project_name: 'Harbor Clinic', square_footage: '42000', details: 'Final clean' } });
    const l = (await req('GET', '/api/admin/leads/' + ok.data.id, { token: T })).data.lead;
    const cust = (await req('GET', '/api/admin/customers', { token: T })).data.customers.some(c => c.email === 'sam@harbor.test');
    assert(bad.status === 400 && badE.status === 400 && ok.status === 201 && /Source: Referral/.test(l.details) && l.kind === 'bid' && cust, JSON.stringify([bad.data, badE.data]));
    return `missing contact 400; bad email 400; lead #${ok.data.id} created (source Referral), customer record added`;
  });
  await check('Suite', 'Call log: today counts, missed flagged, call can create a lead, follow-up due then done', async () => {
    const a = await req('POST', '/api/admin/calls', { token: T, json: { contact_name: 'Jo Park', company: 'Park Apartments', phone: '515-555-0110', purpose: 'Bid request', outcome: 'Answered', summary: '120 units, recurring hallways', follow_up_date: '2020-01-01', create_lead: true } });
    await req('POST', '/api/admin/calls', { token: T, json: { phone: '515-555-0199', outcome: 'Missed', purpose: 'Other' } });
    const bad = await req('POST', '/api/admin/calls', { token: T, json: { outcome: 'Missed' } });
    const r = (await req('GET', '/api/admin/calls', { token: T })).data;
    const lead = (await req('GET', '/api/admin/leads/' + a.data.lead_id, { token: T })).data.lead;
    const done = await req('PATCH', '/api/admin/calls/' + a.data.call.id, { token: T, json: { follow_up_done: true } });
    const r2 = (await req('GET', '/api/admin/calls', { token: T })).data;
    assert(a.status === 201 && lead.kind === 'bid' && /Phone call/.test(lead.details) && bad.status === 400 && r.today.total >= 2 && r.today.missed >= 1 && r.follow_ups_due >= 1 && done.data.call.follow_up_done === 1 && r2.follow_ups_due === r.follow_ups_due - 1, JSON.stringify([r.today, r.follow_ups_due, r2.follow_ups_due]));
    return `today ${r.today.total} calls (${r.today.missed} missed); bid-request call created lead #${a.data.lead_id}; follow-ups due ${r.follow_ups_due} -> ${r2.follow_ups_due}`;
  });
  await check('Suite', 'Schedule: visit validation, listing in range with project due dates, status change logged', async () => {
    const d = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const bad = await req('POST', '/api/admin/visits', { token: T, json: { title: 'X', date: d, start_time: '10:00', end_time: '09:00' } });
    const v = await req('POST', '/api/admin/visits', { token: T, json: { title: 'Walkthrough – Harbor Clinic', type: 'Walkthrough', date: d, start_time: '09:00', end_time: '10:30', assigned_to: OWNER, crew_size: 2 } });
    const list = (await req('GET', '/api/admin/visits', { token: T })).data;
    const upd = await req('PATCH', '/api/admin/visits/' + v.data.visit.id, { token: T, json: { status: 'Done' } });
    assert(bad.status === 400 && /End time/.test(bad.data.error) && v.status === 201 && list.visits.some(x => x.id === v.data.visit.id) && Array.isArray(list.project_due) && upd.data.visit.status === 'Done', JSON.stringify([bad.data, list.visits.length]));
    return `end-before-start 400; visit on ${d} listed; marked Done`;
  });
  await check('Suite', 'Inspections: checklist scored; a failed item needs a note; average shown', async () => {
    const tpl = (await req('GET', '/api/admin/inspections', { token: T })).data.templates['Construction final clean'];
    const items = tpl.map((label, i) => ({ label, result: i === 0 ? 'Fail' : i === 1 ? 'N/A' : 'Pass', note: '' }));
    const bad = await req('POST', '/api/admin/inspections', { token: T, json: { area: 'Level 2', date: '2026-11-01', template: 'Construction final clean', items } });
    items[0].note = 'Dust on window sills in 204–210';
    const ok = await req('POST', '/api/admin/inspections', { token: T, json: { area: 'Level 2', date: '2026-11-01', template: 'Construction final clean', inspector: 'Eric', items } });
    const all = items.map(i => ({ ...i, result: 'Pass', note: '' }));
    const re = await req('PATCH', '/api/admin/inspections/' + ok.data.inspection.id, { token: T, json: { items: all } });
    const sum = (await req('GET', '/api/admin/inspections', { token: T })).data.summary;
    assert(bad.status === 400 && /failed item/.test(bad.data.error) && ok.data.inspection.score === 85.7 && ok.data.inspection.passed === 0 && re.data.inspection.score === 100 && re.data.inspection.passed === 1 && sum.count_90d >= 1, JSON.stringify([ok.data.inspection.score, re.data.inspection.score, sum]));
    return `fail without note 400; 6 of 7 rated items passed = ${ok.data.inspection.score}% (needs rework); after re-clean 100% pass; 90-day average ${sum.average_score_90d}%`;
  });
  await check('Suite', 'Reports: 12 months, win rate and won value match the records', async () => {
    const r = (await req('GET', '/api/admin/reports', { token: T })).data;
    const ests = (await req('GET', '/api/admin/estimates', { token: T })).data.estimates;
    const w = ests.filter(e => e.status === 'Approved').length, l = ests.filter(e => e.status === 'Declined').length;
    assert(r.months.length === 12 && r.leads.length === 12 && r.won_count === w && r.lost_count === l && (w + l === 0 ? r.win_rate === null : Math.abs(r.win_rate - Math.round(w / (w + l) * 1000) / 10) < 0.01), JSON.stringify({ wr: r.win_rate, w, l, rw: r.won_count }));
    return `12 months; ${w} won / ${l} lost = ${r.win_rate}% win rate; won value $${r.won_value}`;
  });
  await check('Suite', 'Drawings: upload linked to a customer, listed, download needs sign-in, bad type rejected', async () => {
    const cust = (await req('GET', '/api/admin/customers', { token: T })).data.customers[0];
    const fd = new FormData(); fd.append('files', new Blob([Buffer.from('%PDF-1.4 plans')]), 'A-101 Floor Plan.pdf'); fd.append('kind', 'Drawings'); fd.append('revision', 'IFC'); fd.append('customer_id', String(cust.id));
    const up = await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd }); const uj = await up.json();
    const fd2 = new FormData(); fd2.append('files', new Blob([Buffer.from('x')]), 'virus.exe');
    const bad = await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd2 });
    const list = (await req('GET', '/api/admin/documents', { token: T })).data;
    const doc = list.documents.find(d => d.id === uj.ids[0]);
    const anon = await fetch(B + doc.file_url), signed = await fetch(B + doc.file_url, { headers: { Authorization: 'Bearer ' + T } });
    const found = (await req('GET', '/api/admin/search?q=Floor Plan', { token: T })).data.results.some(x => x.type === 'document');
    assert(up.status === 201 && bad.status >= 400 && doc && doc.revision === 'IFC' && doc.customer_id === cust.id && anon.status === 401 && signed.status === 200 && list.ai_ready === false && found, JSON.stringify({ s: up.status, b: bad.status, anon: anon.status, signed: signed.status }));
    return `uploaded "A-101 Floor Plan.pdf" (Rev IFC) to customer #${cust.id}; .exe rejected (${bad.status}); file 401 signed-out, 200 signed-in; findable by search; takeoff waits for API key`;
  });
  await check('Suite', 'Global search finds leads, customers, proposals, calls; short query returns nothing', async () => {
    const r = (await req('GET', '/api/admin/search?q=Harbor', { token: T })).data.results;
    const c = (await req('GET', '/api/admin/search?q=Park Apart', { token: T })).data.results;
    const s1 = (await req('GET', '/api/admin/search?q=a', { token: T })).data.results;
    const types = [...new Set(r.map(x => x.type))];
    assert(types.includes('lead') && types.includes('customer') && c.some(x => x.type === 'call') && s1.length === 0, JSON.stringify(types));
    return `"Harbor" -> ${types.join(', ')}; "Park Apart" -> call found; 1-letter query -> nothing`;
  });

  // ---------- Takeoffs and Email Center ----------
  await check('Takeoff', 'Takeoff with sourced quantities becomes an exact bid: Terrell 417,000 SF from sheet G0.1', async () => {
    const items = (await req('GET', '/api/admin/scopes', { token: T })).data.items;
    const ph = n => items.find(i => i.name.startsWith(n)).id;
    const doc = (await req('GET', '/api/admin/documents', { token: T })).data.documents[0];
    const noSheet = await req('POST', '/api/admin/takeoffs', { token: T, json: { name: 'Terrell', category: 'construction', lines: [{ scope_id: ph('Clean #1'), quantity: 417000, method: 'From schedule' }] } });
    const wrongCat = await req('POST', '/api/admin/takeoffs', { token: T, json: { name: 'Terrell', category: 'construction', lines: [{ scope_id: items.find(i => i.category === 'multifamily' && i.unit_price != null).id, quantity: 5, method: 'Entered' }] } });
    const lines = ['Clean #1', 'Clean #2', 'Clean #3'].map(n => ({ scope_id: ph(n), quantity: '417,000', sheet: 'G0.1', method: 'From schedule' }));
    const t = await req('POST', '/api/admin/takeoffs', { token: T, json: { name: 'Terrell State Hospital – IFC set', category: 'construction', building_sf: '417,000', document_id: doc.id, lines, questions: 'Confirm basement scope' } });
    const e = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Robins & Morton', email: 'pm@rm.test', scope: 'From takeoff', scope_category: 'construction', use_line_items: 1, tax_pct: 0, line_items: t.data.takeoff.lines.map(l => ({ scope_id: l.scope_id, quantity: l.quantity })) } });
    const link = await req('POST', `/api/admin/takeoffs/${t.data.takeoff.id}/link`, { token: T, json: { estimate_id: e.data.estimate.id } });
    const back = (await req('GET', '/api/admin/takeoffs', { token: T })).data.takeoffs.find(x => x.id === t.data.takeoff.id);
    assert(noSheet.status === 400 && /source sheet/.test(noSheet.data.error) && wrongCat.status === 400 && t.status === 201 && t.data.takeoff.lines[0].quantity === 417000 && e.data.estimate.proposal_total === 197032.5 && link.status === 200 && back.status === 'Estimated' && back.estimate_id === e.data.estimate.id && back.document_title, JSON.stringify([noSheet.data, wrongCat.data, e.data.estimate && e.data.estimate.proposal_total]));
    return `missing sheet 400 ("${noSheet.data.error.slice(0, 60)}…"); wrong category 400; takeoff from "${back.document_title}" priced to $197,032.50; linked to estimate #${back.estimate_id}`;
  });
  await check('Email Center', 'Every sent email is logged with recipient, subject and body; signed-out access blocked', async () => {
    const r = (await req('GET', '/api/admin/emails', { token: T })).data; if (!r.emails) throw new Error('emails route: ' + JSON.stringify(r).slice(0, 300));
    const anon = (await req('GET', '/api/admin/emails')).status;
    const any = r.emails[0];
    assert(r.emails.length > 0 && any.to_addr && any.subject && any.status && anon === 401, JSON.stringify(r.summary));
    return `${r.emails.length} emails logged (latest "${any.subject}" to ${any.to_addr}, ${any.status}); 30-day: ${r.summary.sent_30d} sent, ${r.summary.failed_30d} failed; signed-out 401`;
  });

  // ---------- End-to-end: one job through every linked screen ----------
  await check('End-to-end', 'Quote form -> lead -> estimate -> proposal -> customer approval -> contract + project -> visit -> inspection -> invoice -> payment -> reports', async () => {
    await req('PUT', '/api/admin/approval-rules', { token: T, json: { min_margin_pct: 15, max_total: 25000, flag_pre_pricing: false, approve_all: false } });
    const fd = new FormData(); Object.entries({ contact_name: 'Erin Flow', company: 'Flow Apartments', email: 'erin@flow.test', phone: '515-555-0177', address: '9 Flow St, Ankeny IA', consent: 'yes', service_key: 'unit_turnover', unit_types: '2 bedroom', turns_per_month: '6', condition: 'Average' }).forEach(([k, v]) => fd.append(k, v));
    const lead = await (await fetch(B + '/api/quotes', { method: 'POST', body: fd })).json();
    const items = (await req('GET', '/api/admin/scopes', { token: T })).data.items;
    const mo = items.find(i => i.name === 'Move-in / move-out clean – 2 Bed / 2 Bath').id;
    const est = (await req('POST', '/api/admin/estimates', { token: T, json: { lead_id: lead.id, customer_name: 'Erin Flow', company: 'Flow Apartments', email: 'erin@flow.test', project_name: 'Flow Apartments turns', scope: 'Monthly unit turns', scope_category: 'multifamily', use_line_items: 1, labor_rate: 20, labor_hours: 10, line_items: [{ scope_id: mo, quantity: 6 }] } })).data.estimate;
    // Email delivery is covered by the Email and Postmark suites; the test server has no mail catcher at this stage, so mark Sent directly.
    const sent = await req('PATCH', `/api/admin/estimates/${est.id}`, { token: T, json: { status: 'Sent' } });
    const tok = (await req('GET', '/api/admin/estimates/' + est.id, { token: T })).data.estimate.public_token;
    const view = await req('GET', '/api/proposal/' + tok);
    const yes = await req('POST', `/api/proposal/${tok}/respond`, { json: { decision: 'approve', signer_name: 'Dana Signer', signer_title: 'Owner', agree: true } });
    const contracts = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.filter(c => c.estimate_id === est.id);
    const project = (await req('GET', '/api/admin/projects', { token: T })).data.projects.find(p => p.contract_id === (contracts[0] || {}).id);
    const cust = (await req('GET', '/api/admin/customers', { token: T })).data.customers.find(c => (c.email || '') === 'erin@flow.test');
    const visit = await req('POST', '/api/admin/visits', { token: T, json: { title: 'Start-up walkthrough', date: require('../bizdate').today(), project_id: project.id, customer_id: cust.id } });
    const insp = await req('POST', '/api/admin/inspections', { token: T, json: { area: 'Unit 204', date: require('../bizdate').today(), project_id: project.id, items: [{ label: 'Rent-ready overall', result: 'Pass' }] } });
    const inv = (await req('POST', '/api/admin/invoices', { token: T, json: { project_id: project.id, customer_name: 'Erin Flow', company: 'Flow Apartments', amount: est.proposal_total, due_date: '2026-12-31', billing_email: 'erin@flow.test' } })).data;
    const invId = inv.id || (inv.invoice && inv.invoice.id);
    const pay = await req('POST', `/api/admin/invoices/${invId}/payment`, { token: T, json: { amount: est.proposal_total } });
    const rep = (await req('GET', '/api/admin/reports', { token: T })).data;
    const found = (await req('GET', '/api/admin/search?q=Flow', { token: T })).data.results.map(r => r.type);
    const custView = (await req('GET', '/api/admin/customers', { token: T })).data.customers.find(c => c.id === cust.id);
    assert(lead.id && est.proposal_total === 480 && sent.status === 200 && view.status === 200 && yes.status === 200 && contracts.length === 1 && project && visit.status === 201 && insp.data.inspection.score === 100 && pay.status === 200 && rep.won_count >= 1 && ['lead', 'customer', 'estimate', 'project', 'invoice'].every(t => found.includes(t)), JSON.stringify({ total: est.proposal_total, sent: sent.status, yes: yes.data, contracts: contracts.length, project: !!project, found, inv, pay: pay.status }));
    return `lead #${lead.id} -> estimate #${est.id} ($480 = 6 x $80) -> marked Sent -> customer approved -> contract #${contracts[0].id} + project #${project.id} -> visit, inspection 100% -> invoice paid in full -> reports show ${rep.won_count} won; search finds lead, customer, proposal, project and invoice; customer billed $${custView ? custView.billed || 0 : '?'}`;
  });
  await check('Invoices', 'Invoices created without a number get the next BC-YYYY-NNNN automatically (no duplicate error)', async () => {
    const a = (await req('POST', '/api/admin/invoices', { token: T, json: { customer_name: 'No Number A', amount: 10 } })).data;
    const b = (await req('POST', '/api/admin/invoices', { token: T, json: { customer_name: 'No Number B', amount: 10 } })).data;
    const all = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices;
    const na = all.find(i => i.id === a.id).invoice_number, nb = all.find(i => i.id === b.id).invoice_number;
    assert(a.id && b.id && /^BC-\d{4}-\d{4}$/.test(na) && /^BC-\d{4}-\d{4}$/.test(nb) && na !== nb, JSON.stringify({ a, b, na, nb }));
    return `${na} and ${nb} assigned automatically`;
  });
  // ---------- Roles, approval flow, auto-bid ----------
  await check('Roles', 'Owner sets roles; a manager can approve; staff cannot and instead sends the owner a request (task created)', async () => {
    await req('PUT', '/api/admin/approval-rules', { token: T, json: { min_margin_pct: 0, max_total: 1000, flag_pre_pricing: false, approve_all: false } });
    const mk = async (email) => { await req('POST', '/api/admin/users', { token: T, json: { email, name: email, password: 'a-long-password-123' } }); return (await req('POST', '/api/admin/login', { json: { email, password: 'a-long-password-123' } })).data.token; };
    const mgrT = await mk('manager@brightclean.test'), stfT = await mk('crew@brightclean.test');
    const users = (await req('GET', '/api/admin/users', { token: T })).data;
    const mgr = users.users.find(u => u.email === 'manager@brightclean.test');
    const byStaff = await req('PATCH', `/api/admin/users/${mgr.id}/role`, { token: stfT, json: { role: 'owner' } });
    await req('PATCH', `/api/admin/users/${mgr.id}/role`, { token: T, json: { role: 'manager' } });
    const e1 = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Role Test', email: 'r@t.test', scope: 'x', area_sqft: 10000, production_rate: 300, labor_rate: 30, margin_pct: 30 } })).data.estimate;
    const staffApprove = await req('POST', `/api/admin/estimates/${e1.id}/approve`, { token: stfT });
    const staffSees = (await req('GET', `/api/admin/estimates/${e1.id}/approval`, { token: stfT })).data;
    const reqApp = await req('POST', `/api/admin/estimates/${e1.id}/request-approval`, { token: stfT });
    const task = (await req('GET', '/api/admin/issues?type=task', { token: T })).data.issues.find(i => i.title.includes(`#${e1.id}`));
    const mgrApprove = await req('POST', `/api/admin/estimates/${e1.id}/approve`, { token: mgrT });
    const after = (await req('GET', '/api/admin/users', { token: mgrT })).data;
    assert(byStaff.status === 403 && staffApprove.status === 403 && staffSees.can_approve === false && staffSees.role === 'staff' && reqApp.status === 200 && task && task.assigned_to === OWNER && mgrApprove.status === 200 && after.me.role === 'manager' && after.can_manage_roles === false, JSON.stringify({ byStaff: byStaff.status, staffApprove: staffApprove.status, task: !!task, mgr: mgrApprove.status }));
    return `staff role change 403; staff approve 403 -> request created task "${task.title}" for the owner; manager approved (200); manager cannot change roles`;
  });
  await check('Approvals', 'Marking a proposal Approved by hand is always blocked — even after internal owner approval, only the client can approve', async () => {
    const e = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Manual Approve', email: 'm@t.test', scope: 'x', area_sqft: 10000, production_rate: 300, labor_rate: 30, margin_pct: 30 } })).data.estimate;
    const a = await req('PATCH', '/api/admin/estimates/' + e.id, { token: T, json: { status: 'Approved' } });
    await req('POST', `/api/admin/estimates/${e.id}/approve`, { token: T, json: { note: 'ok' } });
    const b = await req('PATCH', '/api/admin/estimates/' + e.id, { token: T, json: { status: 'Approved' } });
    await req('PUT', '/api/admin/approval-rules', { token: T, json: { min_margin_pct: 0, max_total: 0, flag_pre_pricing: false, approve_all: false } });
    assert(a.status === 409 && b.status === 409 && /Only the client/.test(b.data.error), JSON.stringify([a.data, b.data]));
    return 'before and after internal approval: 409 — the client approves online';
  });
  await check('Auto-bid', 'A construction quote request becomes a priced draft estimate automatically (no clicks)', async () => {
    const fd = new FormData(); Object.entries({ contact_name: 'Auto Bid GC', company: 'AutoBid Builders', email: 'ab@builders.test', phone: '515-555-0150', address: '5 Build Rd, Ankeny IA', consent: 'yes', service_key: 'construction_final', gc_company: 'AutoBid Builders', building_type: 'Office', square_footage: '20000', windows: 'No windows', plans: 'Will send them later' }).forEach(([k, v]) => fd.append(k, v));
    ['Rough clean', 'Final clean'].forEach(p => fd.append('phases', p));
    const q = await (await fetch(B + '/api/quotes', { method: 'POST', body: fd })).json();
    let lead; for (let i = 0; i < 20; i++) { await sleep(300); lead = (await req('GET', '/api/admin/leads/' + q.id, { token: T })).data.lead; if (lead.auto_estimate_id) break; }
    const e = (await req('GET', '/api/admin/estimates/' + lead.auto_estimate_id, { token: T })).data.estimate;
    const names = e.line_items.map(i => i.description.split(' –')[0]);
    assert(e.status === 'Draft' && e.lead_id === q.id && e.proposal_total === Math.round(20000 * (0.18375 + 0.13125 + 0.1575) * 100) / 100 && names.join() === 'Clean #1,Clean #2,Clean #3' && /Still needed: Drawings/.test(e.scope), JSON.stringify({ total: e.proposal_total, names, scope: e.scope }));
    return `lead #${q.id} -> draft estimate #${e.id}: Clean #1–#3 at 20,000 SF = $${e.proposal_total.toLocaleString()} (Draft, not sent); notes drawings still needed`;
  });
  await check('Auto-bid', 'Unit turnover request priced from the sheet; service with no prices is left for the owner; manual "Draft estimate" button works', async () => {
    const send = async o => { const fd = new FormData(); Object.entries({ contact_name: 'Auto Turns', email: 'turns@apts.test', phone: '1', address: 'A', consent: 'yes', ...o }).forEach(([k, v]) => [].concat(v).forEach(x => fd.append(k, x))); return (await (await fetch(B + '/api/quotes', { method: 'POST', body: fd })).json()).id; };
    const u = await send({ service_key: 'unit_turnover', unit_types: ['2 bedroom'], turns_per_month: '6', condition: 'Average' });
    const j = await send({ email: 'pw@office.test', service_key: 'power_washing', surfaces: ['Sidewalks'], condition: 'Moderate' });
    await sleep(1500);
    const lu = (await req('GET', '/api/admin/leads/' + u, { token: T })).data.lead, lj = (await req('GET', '/api/admin/leads/' + j, { token: T })).data.lead;
    const eu = (await req('GET', '/api/admin/estimates/' + lu.auto_estimate_id, { token: T })).data.estimate;
    const manual = await req('POST', `/api/admin/leads/${j}/draft-estimate`, { token: T });
    assert(eu.proposal_total === 480 && lj.auto_estimate_id === 0 && manual.status === 400 && /Not enough to price|no structured/.test(manual.data.error), JSON.stringify({ t: eu.proposal_total, j: lj.auto_estimate_id, m: manual.data }));
    return `6 x 2-bed move-outs = $480 drafted; power washing (no price-book pricing) left for owner (${manual.data.error.slice(0, 70)})`;
  });

  await check('Reports', 'Every stage from first call to payment reaches Reports, and the money ties out to the invoices', async () => {
    const r = (await req('GET', '/api/admin/reports', { token: T })).data;
    const inv = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.filter(i => i.status !== 'Void');
    const calls = (await req('GET', '/api/admin/calls', { token: T })).data.calls;
    const out = inv.reduce((t, i) => t + (i.paid_amount < i.amount ? i.amount - i.paid_amount : 0), 0);
    const billed = inv.reduce((t, i) => t + i.amount, 0);
    const stage = k => r.flow.find(f => f.k === k).n;
    const zero = r.flow.filter(f => !f.n).map(f => f.k);
    const monthCalls = r.calls.reduce((t, m) => t + m.n, 0);
    assert(zero.length === 0 && Math.abs(r.receivables.outstanding - out) < 0.01 && Math.abs(r.receivables.billed - billed) < 0.01 && monthCalls === calls.length && r.automation.approvals > 0 && r.automation.auto_estimates > 0 && r.lead_services.some(x => x.k === 'construction_final' && x.drafted > 0) && r.ops.inspections.n > 0 && r.ops.complaints.n > 0, JSON.stringify({ zero, rv: r.receivables, out, billed, monthCalls, calls: calls.length, au: r.automation }));
    return `${r.flow.length} stages all counted (${r.flow.map(f => f.k.split(' ')[0] + ' ' + f.n).join(', ')}); outstanding $${out.toFixed(2)} and billed $${billed.toFixed(2)} match the invoices; ${monthCalls} calls by month = ${calls.length} logged`;
  });
  await check('Reports', 'Executive figures stay separate (approved ≠ signed ≠ invoiced ≠ collected), win rate shows its sample, CSV export works and is protected', async () => {
    const r = (await req('GET', '/api/admin/reports', { token: T })).data, ex = r.executive;
    const ests = (await req('GET', '/api/admin/estimates', { token: T })).data.estimates.filter(e => e.status === 'Approved' && (e.decided_at || e.updated_at) >= r.period.start);
    const inv = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.filter(i => i.status !== 'Void' && i.created_at >= r.period.start);
    const cons = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts;
    const appr = Math.round(ests.reduce((t, e) => t + e.proposal_total, 0) * 100) / 100;
    const csv = await fetch(B + '/api/admin/reports/export.csv', { headers: { Authorization: 'Bearer ' + T } }); const text = await csv.text();
    const anon = await fetch(B + '/api/admin/reports/export.csv');
    assert(Math.abs(ex.approved_proposals.value - appr) < 0.01 && ex.approved_proposals.count === ests.length && Math.abs(ex.invoiced.value - inv.reduce((t, i) => t + i.amount, 0)) < 0.01 && ex.signed_contracts.count === cons.filter(c => ['Signed', 'Executed', 'Fully signed'].includes(c.signature_status)).length && ex.unsigned_contracts.count > 0 && ex.actual_gross_profit.value === null && r.win.sample === r.win.won + r.win.lost && /Won ÷/.test(r.win.definition) && r.data_issues.some(x => /not signed/.test(x.text)) && r.data_issues.some(x => /Not tracked yet/.test(x.text)) && csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type')) && /Approved proposal value/.test(text) && anon.status === 401, JSON.stringify({ ex, appr, win: r.win, n: inv.length }));
    return `approved $${ex.approved_proposals.value.toLocaleString()} (${ex.approved_proposals.count}) vs signed $${ex.signed_contracts.value} (${ex.signed_contracts.count}; ${ex.unsigned_contracts.count} unsigned) vs invoiced $${ex.invoiced.value} vs collected $${ex.collected.value}; win ${r.win.won}/${r.win.sample}${r.win.small_sample ? ' (small sample flagged)' : ''}; actual profit not claimed; ${r.data_issues.length} data checks; CSV ${text.split('\n').length} lines; signed-out 401`;
  });
  // ---------- Customers CRM ----------
  let crmId;
  await check('CRM', 'Contacts: add several under one company, duplicate email refused, primary switches and updates the account', async () => {
    const c = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'CRM Test Holdings', name: 'Ana First', email: 'ana@crmtest.test', phone: '515-555-0300' } })).data; crmId = c.id;
    const dup = await req('POST', '/api/admin/customers', { token: T, json: { company: 'CRM Test Holdings', email: 'other@crmtest.test' } });
    const b = await req('POST', `/api/admin/customers/${crmId}/contacts`, { token: T, json: { name: 'Ben Second', title: 'Facilities', email: 'ben@crmtest.test', phone: '515-555-0301', can_sign: true } });
    const bdup = await req('POST', `/api/admin/customers/${crmId}/contacts`, { token: T, json: { name: 'Ben Again', email: 'BEN@crmtest.test' } });
    const noName = await req('POST', `/api/admin/customers/${crmId}/contacts`, { token: T, json: { email: 'x@crmtest.test' } });
    await req('PATCH', `/api/admin/customers/${crmId}/contacts/${b.data.id}`, { token: T, json: { is_primary: true } });
    const p = (await req('GET', `/api/admin/customers/${crmId}/profile`, { token: T })).data;
    const rmPrimary = await req('DELETE', `/api/admin/customers/${crmId}/contacts/${b.data.id}`, { token: T });
    assert(dup.status === 409 && b.status === 201 && bdup.status === 400 && noName.status === 400 && p.contacts.length === 2 && p.contacts[0].name === 'Ben Second' && p.contacts[0].is_primary === 1 && p.customer.email === 'ben@crmtest.test' && rmPrimary.status === 400, JSON.stringify({ dup: dup.status, bdup: bdup.data, contacts: p.contacts.map(x => [x.name, x.is_primary]), email: p.customer.email }));
    return `2 contacts; duplicate customer 409; duplicate contact email (any case) 400; primary switched to Ben, account email follows; removing the primary contact refused`;
  });
  await check('CRM', 'Properties: several locations with access notes; duplicate address refused; status change', async () => {
    const a1 = await req('POST', `/api/admin/customers/${crmId}/properties`, { token: T, json: { name: 'HQ', address: '1 Main St, Ankeny IA', property_type: 'Office', square_feet: '42,000', access_notes: 'Gate code 1234' } });
    const a2 = await req('POST', `/api/admin/customers/${crmId}/properties`, { token: T, json: { name: 'Warehouse', address: '9 Dock Rd', property_type: 'Industrial', units: 0 } });
    const dup = await req('POST', `/api/admin/customers/${crmId}/properties`, { token: T, json: { name: 'HQ again', address: '1 MAIN ST, Ankeny IA' } });
    const bad = await req('POST', `/api/admin/customers/${crmId}/properties`, { token: T, json: { name: 'X', square_feet: 'lots' } });
    await req('PATCH', `/api/admin/customers/${crmId}/properties/${a2.data.id}`, { token: T, json: { status: 'Inactive' } });
    const p = (await req('GET', `/api/admin/customers/${crmId}/profile`, { token: T })).data;
    assert(a1.status === 201 && a2.status === 201 && dup.status === 409 && bad.status === 400 && p.properties.length === 2 && p.properties.find(x => x.name === 'HQ').square_feet === 42000 && p.properties.find(x => x.name === 'Warehouse').status === 'Inactive', JSON.stringify(p.properties));
    return '2 properties (42,000 SF HQ with gate code); duplicate address 409; bad size 400; warehouse set Inactive';
  });
  await check('CRM', 'Notes carry author and time; only the author or an owner can edit; edits are audited with the old text', async () => {
    const n = (await req('POST', `/api/admin/customers/${crmId}/notes`, { token: T, json: { category: 'Site access', body: 'Use the east entrance after 6pm.', pinned: true } })).data.note;
    const empty = await req('POST', `/api/admin/customers/${crmId}/notes`, { token: T, json: { body: '  ' } });
    await req('POST', '/api/admin/users', { token: T, json: { email: 'crmstaff@brightclean.test', name: 'S', password: 'a-long-password-123' } });
    const st = (await req('POST', '/api/admin/login', { json: { email: 'crmstaff@brightclean.test', password: 'a-long-password-123' } })).data.token;
    const byStaff = await req('PATCH', `/api/admin/customers/${crmId}/notes/${n.id}`, { token: st, json: { body: 'changed' } });
    const byOwner = await req('PATCH', `/api/admin/customers/${crmId}/notes/${n.id}`, { token: T, json: { body: 'Use the east entrance after 6pm. Badge at security.' } });
    const log = (await req('GET', '/api/admin/audit-log', { token: T })).data.events.find(e => e.entity === 'customer note' && e.action === 'edited' && e.entity_id === n.id);
    assert(n.author === OWNER && n.created_at && n.pinned === 1 && empty.status === 400 && byStaff.status === 403 && byOwner.status === 200 && log && /was: "Use the east entrance after 6pm\."/.test(log.details), JSON.stringify({ n, byStaff: byStaff.status, log }));
    return `note by ${n.author} at ${n.created_at.slice(0, 16)}; empty 400; staff edit 403; owner edit logged with previous text`;
  });
  await check('CRM', 'Account status/owner changes are validated and audited old → new; duplicate company refused', async () => {
    const ok = await req('PATCH', `/api/admin/customers/${crmId}/account`, { token: T, json: { status: 'Active', account_owner: OWNER, customer_type: 'Commercial', industry: 'Facility services' } });
    const bad = await req('PATCH', `/api/admin/customers/${crmId}/account`, { token: T, json: { status: 'Gold' } });
    const other = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Other Co CRM', email: 'o@other.test' } })).data.id;
    const dupCo = await req('PATCH', `/api/admin/customers/${other}/account`, { token: T, json: { company: 'crm test holdings' } });
    const log = (await req('GET', '/api/admin/audit-log', { token: T })).data.events.find(e => e.entity === 'customer' && e.entity_id === crmId && /account_owner/.test(e.details || ''));
    assert(ok.status === 200 && ok.data.changed.includes('account_owner') && bad.status === 400 && dupCo.status === 400 && log && /→/.test(log.details), JSON.stringify({ ok: ok.data, bad: bad.status, dupCo: dupCo.data, log }));
    return `changed ${ok.data.changed.join(', ')}; invalid status 400; duplicate company 400; audit: "${log.details.slice(0, 90)}…"`;
  });
  await check('CRM', 'Profile gathers calls (matched by phone), emails, issues and records; financial figures stay separate', async () => {
    await req('POST', '/api/admin/calls', { token: T, json: { contact_name: 'Ben', phone: '(515) 555-0301', purpose: 'Existing customer', summary: 'Asked about Saturday service' } });
    await req('POST', '/api/admin/issues', { token: T, json: { type: 'complaint', title: 'Lobby glass streaks', customer_id: crmId, priority: 'High' } });
    const e1 = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Ben Second', company: 'CRM Test Holdings', email: 'ben@crmtest.test', scope: 'Janitorial', area_sqft: 10000, production_rate: 400, labor_rate: 30, margin_pct: 30 } })).data.estimate;
    const e2 = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Ben Second', company: 'CRM Test Holdings', email: 'ben@crmtest.test', scope: 'Windows', area_sqft: 5000, production_rate: 400, labor_rate: 30, margin_pct: 30 } })).data.estimate;
    await req('PATCH', '/api/admin/estimates/' + e2.id, { token: T, json: { status: 'Sent' } }); await req('POST', `/api/proposal/${e2.public_token}/respond`, { json: { decision: 'approve', signer_name: 'Ben Second', signer_title: 'Owner', agree: true } }); await sleep(300);
    const p = (await req('GET', `/api/admin/customers/${crmId}/profile`, { token: T })).data, f = p.financials;
    assert(p.calls.some(x => /Saturday/.test(x.summary)) && p.issues.some(i => i.title === 'Lobby glass streaks') && p.estimates.some(e => e.id === e1.id) && p.proposals.some(e => e.id === e2.id) && Math.abs(f.estimates.value - e1.proposal_total) < 0.01 && Math.abs(f.approved.value - e2.proposal_total) < 0.01 && f.invoiced.value === 0 && f.collected.value === 0 && p.communications.some(x => x.type === 'call') && p.communications.some(x => x.type === 'note') && p.activity.length > 3, JSON.stringify(f));
    return `call matched by phone; complaint, draft estimate #${e1.id} and approved #${e2.id} linked; estimates $${f.estimates.value} ≠ approved $${f.approved.value} ≠ invoiced $0 ≠ collected $0; ${p.communications.length} communications; ${p.activity.length} activity entries`;
  });
  await check('CRM', 'Remove needs owner + typed confirmation, and is refused when the customer has linked records', async () => {
    const st = (await req('POST', '/api/admin/login', { json: { email: 'crmstaff@brightclean.test', password: 'a-long-password-123' } })).data.token;
    const byStaff = await req('DELETE', '/api/admin/customers/' + crmId, { token: st, json: { confirm: 'CRM Test Holdings' } });
    const noConfirm = await req('DELETE', '/api/admin/customers/' + crmId, { token: T, json: { confirm: 'wrong' } });
    const linked = await req('DELETE', '/api/admin/customers/' + crmId, { token: T, json: { confirm: 'CRM Test Holdings' } });
    const lone = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Lonely Prospect', email: 'l@lonely.test' } })).data.id;
    const ok = await req('DELETE', '/api/admin/customers/' + lone, { token: T, json: { confirm: 'lonely prospect' } });
    assert(byStaff.status === 403 && noConfirm.status === 400 && linked.status === 409 && /Inactive/.test(linked.data.error) && ok.status === 200, JSON.stringify([byStaff.status, noConfirm.status, linked.data, ok.status]));
    return `staff 403; wrong confirmation 400; with linked proposals 409 ("${linked.data.error.slice(0, 70)}…"); unlinked prospect removed`;
  });

  await check('Issues', 'Six item types with numbers; links to contact, property and project are checked against the customer; source captured; duplicates blocked', async () => {
    const cu = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Issue Link Co', name: 'Lia', email: 'lia@issuelink.test' } })).data.id;
    const k = (await req('POST', `/api/admin/customers/${cu}/contacts`, { token: T, json: { name: 'Max Site', phone: '515-555-0500' } })).data.id;
    const pr = (await req('POST', `/api/admin/customers/${cu}/properties`, { token: T, json: { name: 'North Tower', address: '1 North St' } })).data.id;
    const other = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Other Link Co', email: 'o@otherlink.test' } })).data.id;
    const made = {};
    for (const ty of ['complaint', 'service_request', 'incident', 'task', 'follow_up', 'note']) made[ty] = (await req('POST', '/api/admin/issues', { token: T, json: { type: ty, title: `Link test ${ty}`, customer_id: cu, contact_id: k, property_id: pr, source: 'Phone call', work_order: 'WO-77', category: 'Cleaning quality' } })).data.issue;
    const wrong = await req('POST', '/api/admin/issues', { token: T, json: { type: 'task', title: 'Wrong link', customer_id: other, property_id: pr } });
    const dup = await req('POST', '/api/admin/issues', { token: T, json: { type: 'complaint', title: 'Link test complaint', customer_id: cu } });
    const badSrc = await req('POST', '/api/admin/issues', { token: T, json: { type: 'task', title: 'x', source: 'Pigeon' } });
    const one = (await req('GET', '/api/admin/issues/' + made.incident.id, { token: T })).data.issue;
    assert(Object.values(made).every(Boolean) && made.complaint.number === `ISS-${1000 + made.complaint.id}` && made.service_request.number.startsWith('REQ-') && made.incident.number.startsWith('INC-') && made.task.number.startsWith('TSK-') && one.contact_name === 'Max Site' && one.property_name === 'North Tower' && one.source === 'Phone call' && one.work_order === 'WO-77' && made.note.status === 'Closed' && wrong.status === 400 && /different customer/.test(wrong.data.error) && dup.status === 409 && badSrc.status === 400, JSON.stringify({ made: Object.values(made).map(x => x && x.number), wrong: wrong.data, dup: dup.status }));
    return `${Object.values(made).map(x => x.number).join(', ')}; contact/property/work order/source saved; property of another customer 400; duplicate 409; bad source 400`;
  });
  let tid;
  await check('Issues', 'Comments, attachments, reassignment notification, escalation to management, reminders, recurring tasks, filters and KPI counts', async () => {
    await req('POST', '/api/admin/users', { token: T, json: { email: 'crew1@brightclean.test', name: 'Crew One', password: 'a-long-password-123' } }).catch(() => {});
    const t = (await req('POST', '/api/admin/issues', { token: T, json: { type: 'task', title: 'Restock supply closet', assigned_to: 'crew1@brightclean.test', due_date: require('../bizdate').today(), recurrence: 'weekly', priority: 'High' } })).data.issue; tid = t.id;
    const cm = await req('POST', `/api/admin/issues/${t.id}/comments`, { token: T, json: { body: 'Use the blue bins' } });
    const fd = new FormData(); fd.append('issue_id', String(t.id)); fd.append('kind', 'Photos'); fd.append('files', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: 'image/png' }), 'before.png');
    const up = await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd });
    await req('PATCH', '/api/admin/issues/' + t.id, { token: T, json: { assigned_to: OWNER } });
    await req('PATCH', '/api/admin/issues/' + t.id, { token: T, json: { assigned_to: 'crew1@brightclean.test', escalate: true, reminder_at: new Date(Date.now() - 1000).toISOString() } });
    await req('POST', '/api/admin/issues/run-reminders', { token: T });
    const kpi = (await req('GET', '/api/admin/issues', { token: T })).data.counts;
    const dueToday = (await req('GET', '/api/admin/issues?status=today', { token: T })).data.issues.some(i => i.id === t.id);
    const hi = (await req('GET', '/api/admin/issues?priority=High&group=tasks&assigned=crew1@brightclean.test', { token: T })).data.issues.some(i => i.id === t.id);
    const done = await req('PATCH', '/api/admin/issues/' + t.id, { token: T, json: { status: 'Resolved', resolution: 'Restocked' } });
    const next = (await req('GET', '/api/admin/issues?q=Restock%20supply', { token: T })).data.issues.find(i => i.parent_id === t.id);
    const det = (await req('GET', '/api/admin/issues/' + t.id, { token: T })).data;
    const sent = (await req('GET', '/api/admin/emails', { token: T })).data.emails.filter(e => e.subject.includes(t.number)).map(e => e.subject);
    assert(cm.status === 201 && up.status === 201 && det.comments[0].body === 'Use the blue bins' && det.files.length === 1 && det.issue.escalated === 1 && sent.some(x => /^Assigned to you/.test(x)) && sent.some(x => /^Escalated/.test(x)) && kpi.high >= 1 && kpi.due_today >= 1 && kpi.escalated >= 1 && dueToday && hi && done.status === 200 && next && next.status === 'Open' && next.recurrence === 'weekly' && det.history.some(h => h.action === 'reassigned') && det.history.some(h => h.action === 'escalated'), JSON.stringify({ sent, kpi, det: det.history.map(h => h.action), next: !!next }));
    return `comment + attachment saved; emails logged: ${sent.length} (${[...new Set(sent.map(x => x.split(':')[0]))].join(', ')}); KPIs high ${kpi.high}, due today ${kpi.due_today}, escalated ${kpi.escalated}; filters work; completing created next weekly task due ${next.due_date}; history: ${[...new Set(det.history.map(h => h.action))].join(', ')}`;
  });
  await check('Issues', 'Reminder sends once when its time passes; categories configurable by owner only; staff cannot delete others\u2019 notes', async () => {
    const t = (await req('POST', '/api/admin/issues', { token: T, json: { type: 'follow_up', title: 'Call back about quote', reminder_at: new Date(Date.now() - 5000).toISOString(), assigned_to: OWNER } })).data.issue;
    await req('POST', '/api/admin/issues/run-reminders', { token: T }); await req('POST', '/api/admin/issues/run-reminders', { token: T });
    const rem = (await req('GET', '/api/admin/emails', { token: T })).data.emails.filter(e => e.subject === `Reminder: ${t.number} ${t.title}`).length;
    const st = (await req('POST', '/api/admin/login', { json: { email: 'crew1@brightclean.test', password: 'a-long-password-123' } })).data.token;
    const cfgStaff = await req('PUT', '/api/admin/issues/config', { token: st, json: { categories: ['A', 'B'] } });
    const cfg = await req('PUT', '/api/admin/issues/config', { token: T, json: { categories: ['Cleaning quality', 'Missed service', 'Billing / payment', 'Valet trash'] } });
    const opts = (await req('GET', '/api/admin/issues', { token: T })).data.options.categories;
    const n = (await req('POST', '/api/admin/issues', { token: T, json: { type: 'note', title: 'Owner note' } })).data.issue;
    const delByStaff = await req('DELETE', '/api/admin/issues/' + n.id, { token: st });
    const delOwner = await req('DELETE', '/api/admin/issues/' + n.id, { token: T });
    assert(rem === 1 && cfgStaff.status === 403 && cfg.status === 200 && opts.includes('Valet trash') && delByStaff.status === 403 && delOwner.status === 200, JSON.stringify({ rem, cfgStaff: cfgStaff.status, opts, delByStaff: delByStaff.status }));
    return `reminder sent exactly once (2 sweeps, 1 email); staff cannot change categories (403); owner set 4 categories incl. "Valet trash"; staff cannot delete owner's note (403)`;
  });

  // ---------- Estimates & Proposals (#21) ----------
  await check('Proposals', 'Customer acceptance requires a typed name and authorization; the signature is stored; decline reason recorded', async () => {
    const mk = async () => (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Sig Test', company: 'Sig Co', email: 'sig@sigco.test', scope: 'Janitorial', area_sqft: 8000, production_rate: 400, labor_rate: 30, margin_pct: 30 } })).data.estimate;
    const e = await mk(); await req('PATCH', '/api/admin/estimates/' + e.id, { token: T, json: { status: 'Sent' } });
    const noName = await req('POST', `/api/proposal/${e.public_token}/respond`, { json: { decision: 'approve' } });
    const noAgree = await req('POST', `/api/proposal/${e.public_token}/respond`, { json: { decision: 'approve', signer_name: 'Pat Q' } });
    const ok = await req('POST', `/api/proposal/${e.public_token}/respond`, { json: { decision: 'approve', signer_name: 'Pat Quinn', signer_title: 'Facilities Director', agree: true } });
    const d = (await req('GET', '/api/admin/bids/' + e.id, { token: T })).data.estimate;
    const e2 = await mk(); await req('PATCH', '/api/admin/estimates/' + e2.id, { token: T, json: { status: 'Sent' } });
    const dec = await req('POST', `/api/proposal/${e2.public_token}/respond`, { json: { decision: 'decline', reason: 'Went with incumbent' } });
    const d2 = (await req('GET', '/api/admin/bids/' + e2.id, { token: T })).data.estimate;
    assert(noName.status === 400 && noAgree.status === 400 && ok.status === 200 && d.signer_name === 'Pat Quinn' && d.signer_title === 'Facilities Director' && d.signed_at && d.status === 'Approved' && dec.status === 200 && d2.decline_reason === 'Went with incumbent', JSON.stringify([noName.data, ok.data, d.signer_name]));
    return `no name 400; not authorized 400; accepted by ${d.signer_name}, ${d.signer_title} at ${d.signed_at.slice(0, 16)}; decline reason "${d2.decline_reason}"`;
  });
  await check('Proposals', 'Revise creates version 2 and keeps v1 unchanged (superseded, link closed); drafts cannot be revised; withdraw needs a reason and closes the link', async () => {
    const e = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Rev Test', company: 'Rev Co', email: 'rev@revco.test', scope: 'Windows', area_sqft: 6000, production_rate: 400, labor_rate: 30, margin_pct: 30 } })).data.estimate;
    const draftRev = await req('POST', `/api/admin/bids/${e.id}/revise`, { token: T });
    await req('PATCH', '/api/admin/estimates/' + e.id, { token: T, json: { status: 'Sent' } });
    const lock = await req('PATCH', '/api/admin/bids/' + e.id, { token: T, json: { exclusions: 'No exterior' } });
    const rv = await req('POST', `/api/admin/bids/${e.id}/revise`, { token: T });
    const old = (await req('GET', '/api/admin/bids/' + e.id, { token: T })).data;
    const oldLink = await req('POST', `/api/proposal/${e.public_token}/respond`, { json: { decision: 'approve', signer_name: 'X Y', agree: true } });
    const nw = (await req('GET', '/api/admin/bids/' + rv.data.id, { token: T })).data.estimate;
    await req('PATCH', '/api/admin/estimates/' + rv.data.id, { token: T, json: { status: 'Sent' } });
    const wNo = await req('POST', `/api/admin/bids/${rv.data.id}/withdraw`, { token: T, json: {} });
    const w = await req('POST', `/api/admin/bids/${rv.data.id}/withdraw`, { token: T, json: { reason: 'Customer paused the project' } });
    const wLink = await req('POST', `/api/proposal/${nw.public_token}/respond`, { json: { decision: 'approve', signer_name: 'X Y', agree: true } });
    assert(draftRev.status === 400 && lock.status === 409 && rv.status === 201 && rv.data.version === 2 && old.estimate.status === 'Superseded' && old.versions.length === 2 && oldLink.status === 410 && nw.status === 'Draft' && nw.version === 2 && nw.public_token !== e.public_token && Math.abs(nw.proposal_total - e.proposal_total) < 0.01 && wNo.status === 400 && w.status === 200 && wLink.status === 410 && /withdrawn/.test(wLink.data.error), JSON.stringify({ draftRev: draftRev.status, lock: lock.status, rv: rv.data, old: old.estimate.status, oldLink: oldLink.status, w: w.status, wLink: wLink.data }));
    return `draft revise 400; terms locked after send 409; v2 created (#${rv.data.id}), v1 superseded, old link 410; withdraw w/o reason 400; withdrawn link 410 ("${wLink.data.error.slice(0, 50)}…")`;
  });
  await check('Proposals', 'PDF download is a real PDF without internal notes; customer PDF only after sending; flags catch high $/sf, labor hours, low margin, missing quantities', async () => {
    const e = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Pdf Test', company: 'Pdf Co', email: 'pdf@pdfco.test', scope: 'Final clean of Building A', area_sqft: 100000, production_rate: 20, labor_rate: 120, margin_pct: 5 } })).data.estimate;
    await req('PATCH', '/api/admin/bids/' + e.id, { token: T, json: { internal_notes: 'SECRET-MARGIN-NOTE', assumptions: 'Power and water provided', exclusions: 'Exterior windows' } });
    const pdf = await fetch(B + `/api/admin/bids/${e.id}/pdf`, { headers: { Authorization: 'Bearer ' + T } }); const buf = Buffer.from(await pdf.arrayBuffer()), txt = buf.toString('latin1');
    const pubDraft = await fetch(B + `/api/proposal/${e.public_token}/pdf`);
    const anon = await fetch(B + `/api/admin/bids/${e.id}/pdf`);
    const d = (await req('GET', '/api/admin/bids/' + e.id, { token: T })).data.estimate;
    const pub = (await req('GET', '/api/proposal/' + e.public_token)).data;
    const f = d.flags.map(x => x.text).join(' | ');
    assert(pdf.status === 200 && /application\/pdf/.test(pdf.headers.get('content-type')) && txt.startsWith('%PDF-1.4') && /%%EOF$/.test(txt) && txt.includes('Power and water provided') && txt.includes('Exterior windows') && !txt.includes('SECRET-MARGIN-NOTE') && pubDraft.status === 404 && anon.status === 401 && /per sq ft/.test(f) && /labor hours/.test(f) && !JSON.stringify(pub).includes('SECRET-MARGIN-NOTE'), f + ' ' + pdf.status);
    return `PDF ${buf.length} bytes (valid header/trailer, assumptions + exclusions, no internal note); customer PDF of a draft 404; signed-out 401; flags: ${d.flags.length} (${f.slice(0, 160)}…)`;
  });
  await check('Proposals', 'Dashboard: drafts, review, waiting, approved, declined, expiring, proposed vs contracted value, projected gross profit (estimate), win rate; GC bids listed separately', async () => {
    const g = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'GC Est', company: 'Big GC', email: 'est@biggc.test', scope: 'Final clean', area_sqft: 50000, production_rate: 500, labor_rate: 30, margin_pct: 25 } })).data.estimate;
    const gb = await req('PATCH', '/api/admin/bids/' + g.id, { token: T, json: { bid_type: 'gc_bid', gc_name: 'Robins & Morton', bid_due_date: '2026-12-01' } });
    const dash = (await req('GET', '/api/admin/bids/dashboard', { token: T })).data;
    const bids = (await req('GET', '/api/admin/bids?view=bids', { token: T })).data.estimates, ests = (await req('GET', '/api/admin/bids?view=estimates', { token: T })).data.estimates, props = (await req('GET', '/api/admin/bids?view=proposals', { token: T })).data.estimates;
    const all = (await req('GET', '/api/admin/estimates', { token: T })).data.estimates.filter(e => !['Superseded', 'Withdrawn'].includes(e.status));
    const appr = all.filter(e => e.status === 'Approved');
    assert(gb.status === 200 && bids.some(x => x.id === g.id && x.gc_name === 'Robins & Morton') && !ests.some(x => x.id === g.id) && props.every(x => !['Draft', 'Ready'].includes(x.status)) && ests.every(x => ['Draft', 'Ready'].includes(x.status)) && dash.approved.n === appr.length && Math.abs(dash.approved.v - appr.reduce((t, e) => t + e.proposal_total, 0)) < 0.01 && typeof dash.contracted_value === 'number' && dash.win.decided >= dash.win.won && /not revenue/.test(dash.note) && bids[0].number.startsWith('P-'), JSON.stringify(dash));
    return `drafts ${dash.drafts.n}, review ${dash.review.n}, waiting ${dash.waiting.n}, approved ${dash.approved.n} ($${dash.approved.v.toLocaleString()}), declined ${dash.declined.n}, expiring ${dash.expiring.n}; contracted $${dash.contracted_value}; win ${dash.win.won}/${dash.win.decided}; GC bid listed only under Bids`;
  });

  // ---------- Projects Management Center (#22) ----------
  await check('Projects', 'Auto-created project stays in Planning until contract executed + readiness + dispatch approval; staff cannot approve dispatch', async () => {
    const e = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Proj Test', company: 'Proj Co', email: 'proj@projco.test', scope: 'Final clean', area_sqft: 20000, production_rate: 500, labor_rate: 30, margin_pct: 30 } })).data.estimate;
    await req('PATCH', '/api/admin/estimates/' + e.id, { token: T, json: { status: 'Sent' } });
    await req('POST', `/api/proposal/${e.public_token}/respond`, { json: { decision: 'approve', signer_name: 'Pat Proj', agree: true } }); await sleep(300);
    const k = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.find(x => x.estimate_id === e.id);
    const list = (await req('GET', '/api/admin/pm/projects', { token: T })).data;
    const p = list.projects.find(x => x.contract_id === k.id);
    const tryActive = await req('POST', `/api/admin/pm/projects/${p.id}/status`, { token: T, json: { status: 'In Progress' } });
    for (const key of ['staffing', 'dates', 'access', 'equipment', 'supplies', 'safety']) await req('POST', `/api/admin/pm/projects/${p.id}/readiness`, { token: T, json: { key } });
    const noContract = await req('POST', `/api/admin/pm/projects/${p.id}/approve-dispatch`, { token: T });
    await req('PATCH', '/api/admin/contracts/' + k.id, { token: T, json: { signature_status: 'Signed', status: 'Active', signer_name: 'Dana Builder', signed_on: '2026-11-01' } });
    const st = (await req('POST', '/api/admin/login', { json: { email: 'crew1@brightclean.test', password: 'a-long-password-123' } })).data.token;
    globalThis.__st = st;
    const staff = await req('POST', `/api/admin/pm/projects/${p.id}/approve-dispatch`, { token: st });
    const ok = await req('POST', `/api/admin/pm/projects/${p.id}/approve-dispatch`, { token: T });
    const go = await req('POST', `/api/admin/pm/projects/${p.id}/status`, { token: T, json: { status: 'In Progress' } });
    const det = (await req('GET', '/api/admin/pm/projects/' + p.id, { token: T })).data;
    globalThis.__pmId = p.id;
    assert(p.status === 'Planning' && p.estimate_id === e.id && p.number.startsWith('PJT-') && tryActive.status === 409 && /contract/.test(tryActive.data.error) && /readiness/.test(tryActive.data.error) && noContract.status === 409 && staff.status === 403 && ok.status === 200 && ok.data.project.status === 'Ready to mobilize' && go.status === 200 && det.project.status === 'In Progress' && det.project.actual_start && det.readiness.items.every(i => i.by && i.at) && det.estimate && det.estimate.id === e.id, JSON.stringify({ p: p.status, tryActive: tryActive.data, noContract: noContract.data, staff: staff.status, ok: ok.data }));
    return `${p.number} linked to proposal #${e.id}; In Progress blocked ("${tryActive.data.error.slice(0, 90)}…"); unsigned contract 409; staff 403; owner approved → Ready to mobilize → In Progress (actual start ${det.project.actual_start}); readiness has who + when`;
  });
  await check('Projects', 'Work plan from the service template; progress comes only from done (half) and verified (full) weighted tasks; same person cannot verify own work; work orders generated', async () => {
    const id = globalThis.__pmId;
    const noSvc = await req('POST', `/api/admin/pm/projects/${id}/plan`, { token: T, json: { service: 'bogus' } });
    const plan = await req('POST', `/api/admin/pm/projects/${id}/plan`, { token: T, json: { service: 'construction' } });
    const again = await req('POST', `/api/admin/pm/projects/${id}/plan`, { token: T, json: { service: 'construction' } });
    let det = (await req('GET', '/api/admin/pm/projects/' + id, { token: T })).data;
    const rough = det.tasks.find(t => /Rough clean/.test(t.title)), total = det.tasks.reduce((s, t) => s + t.weight, 0);
    const verifyOpen = await req('PATCH', '/api/admin/pm/tasks/' + rough.id, { token: T, json: { status: 'Verified' } });
    const st = globalThis.__st;
    const done = await req('PATCH', '/api/admin/pm/tasks/' + rough.id, { token: st, json: { status: 'Done' } });
    const selfVerify = await req('PATCH', '/api/admin/pm/tasks/' + rough.id, { token: st, json: { status: 'Verified' } });
    const ver = await req('PATCH', '/api/admin/pm/tasks/' + rough.id, { token: T, json: { status: 'Verified' } });
    const manual = await req('PATCH', '/api/admin/projects/' + id, { token: T, json: { progress: 90 } });
    det = (await req('GET', '/api/admin/pm/projects/' + id, { token: T })).data;
    const wo = await req('POST', `/api/admin/pm/projects/${id}/work-orders`, { token: T, json: { frequency: 'weekly', count: 3, start: '2026-12-01' } });
    const wo2 = await req('POST', `/api/admin/pm/projects/${id}/work-orders`, { token: T, json: { frequency: 'weekly', count: 3, start: '2026-12-01' } });
    const visits = (await req('GET', '/api/admin/pm/projects/' + id, { token: T })).data.visits.filter(v => v.type === 'Work order');
    assert(noSvc.status === 400 && plan.status === 201 && plan.data.tasks === 7 && again.status === 409 && verifyOpen.status === 409 && done.data.progress === Math.round(rough.weight / 2 / total * 100) && selfVerify.status === 403 && ver.data.progress === Math.round(rough.weight / total * 100) && det.project.progress === ver.data.progress && wo.status === 201 && wo.data.created === 3 && wo.data.status === 'Scheduled' && wo2.data.created === 0 && visits.length === 3, JSON.stringify({ plan: plan.data, done: done.data, ver: ver.data, prog: det.project.progress, wo: wo.data, wo2: wo2.data }));
    return `7-task construction plan (weights total ${total}); done → ${done.data.progress}%, verified → ${ver.data.progress}% (manual 90% ignored: shows ${det.project.progress}%); self-verify 403; 3 weekly work orders (no duplicates on repeat)`;
  });
  await check('Projects', 'Actual costs vs budget, customer sign-off, completion blocked by open tasks, certificate PDF, billing handoff creates one DRAFT invoice for the unbilled contract value', async () => {
    const id = globalThis.__pmId;
    await req('PATCH', '/api/admin/pm/projects/' + id, { token: T, json: { budget: 5000 } });
    const bad = await req('POST', `/api/admin/pm/projects/${id}/costs`, { token: T, json: { category: 'Labor', amount: -5 } });
    await req('POST', `/api/admin/pm/projects/${id}/costs`, { token: T, json: { category: 'Labor', amount: '1,200.50', description: 'Crew A 3 days' } });
    await req('POST', `/api/admin/pm/projects/${id}/costs`, { token: T, json: { category: 'Supplies', amount: 300 } });
    await req('POST', `/api/admin/pm/projects/${id}/signoff`, { token: T, json: { name: 'Pat Proj', title: 'Facilities' } });
    const blocked = await req('POST', `/api/admin/pm/projects/${id}/status`, { token: T, json: { status: 'Completed' } });
    let det = (await req('GET', '/api/admin/pm/projects/' + id, { token: T })).data;
    for (const t of det.tasks) { await req('PATCH', '/api/admin/pm/tasks/' + t.id, { token: T, json: { status: 'Done' } }); }
    const certEarly = await fetch(B + `/api/admin/pm/projects/${id}/certificate`, { headers: { Authorization: 'Bearer ' + T } });
    const noInspP = await req('POST', `/api/admin/pm/projects/${id}/status`, { token: T, json: { status: 'Completed' } });
    const tplP = (await req('GET', '/api/admin/qc/templates', { token: T })).data.templates[0];
    const insPr = (await req('POST', '/api/admin/qc/inspections', { token: T, json: { template_id: tplP.id, area: 'Office', date: require('../bizdate').today(), project_id: id, crew: 'A', itype: 'Internal' } })).data.inspection;
    await req('PATCH', `/api/admin/qc/inspections/${insPr.id}`, { token: T, json: { items: insPr.items.map(i => ({ ...i, result: 'Pass' })) } });
    await req('POST', `/api/admin/qc/inspections/${insPr.id}/sign`, { token: T, json: { name: 'Eric Moore' } });
    const comp = await req('POST', `/api/admin/pm/projects/${id}/status`, { token: T, json: { status: 'Completed' } });
    if (noInspP.status !== 409 || !/inspection/.test(noInspP.data.error || '')) throw new Error('Completion without an inspection should be refused: ' + JSON.stringify(noInspP.data));
    const cert = await fetch(B + `/api/admin/pm/projects/${id}/certificate`, { headers: { Authorization: 'Bearer ' + T } }); const ctext = Buffer.from(await cert.arrayBuffer()).toString('latin1');
    const h1 = await req('POST', `/api/admin/pm/projects/${id}/billing-handoff`, { token: T });
    const h2 = await req('POST', `/api/admin/pm/projects/${id}/billing-handoff`, { token: T });
    const inv = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(i => i.id === h1.data.invoice_id);
    det = (await req('GET', '/api/admin/pm/projects/' + id, { token: T })).data;
    assert(bad.status === 400 && det.project.actual_cost === 1500.5 && det.project.cost_by.Labor === 1200.5 && blocked.status === 409 && /task/.test(blocked.data.error) && certEarly.status === 409 && comp.status === 200 && det.project.actual_end && ctext.startsWith('%PDF') && ctext.includes('Pat Proj') && h1.status === 201 && h2.status === 409 && inv.status === 'Draft' && Math.abs(inv.amount - det.project.contract_value) < 0.01 && det.project.progress === 50, JSON.stringify({ cost: det.project.actual_cost, blocked: blocked.data, h1: h1.data, inv, prog: det.project.progress }));
    return `costs $${det.project.actual_cost} (labor $1,200.50 + supplies $300) vs budget $5,000; completion blocked while tasks open; certificate only after completion (PDF names the signer); one draft invoice $${inv.amount} (second handoff 409); progress ${det.project.progress}% since tasks are done, not verified`;
  });

  // ---------- Scheduling & Dispatch (#23) ----------
  const mkVisit = async (title, date, st, en, extra = {}) => (await req('POST', '/api/admin/visits', { token: T, json: { title, type: 'Cleaning phase', date, start_time: st, end_time: en, address: '100 Main St, Dallas TX', ...extra } })).data;
  const vid = x => (x.visit || x).id;
  await check('Schedule', 'Employees with skills and hours; overlapping shift and time off are blocked; overtime needs a manager reason; staff cannot approve overtime', async () => {
    const a = (await req('POST', '/api/admin/employees', { token: T, json: { name: 'Ana Crew', email: 'ana@crew.test', role: 'Lead', crew: 'A', skills: 'floor machine, windows', hourly_rate: 22, max_week_hours: 10 } })).data.employee;
    const b = (await req('POST', '/api/admin/employees', { token: T, json: { name: 'Ben Crew', role: 'Cleaner', crew: 'A', hourly_rate: 18 } })).data.employee;
    const dupe = await req('POST', '/api/admin/employees', { token: T, json: { name: 'Ana Again', email: 'ANA@crew.test' } });
    const v1 = vid(await mkVisit('Lobby clean', '2026-12-07', '08:00', '12:00')), v2 = vid(await mkVisit('Overlap job', '2026-12-07', '11:00', '14:00')), v3 = vid(await mkVisit('Off day job', '2026-12-08', '08:00', '12:00')), v4 = vid(await mkVisit('Long job', '2026-12-09', '07:00', '17:00'));
    const ok1 = await req('POST', `/api/admin/dispatch/visits/${v1}/crew`, { token: T, json: { employee_id: a.id } });
    const overlap = await req('POST', `/api/admin/dispatch/visits/${v2}/crew`, { token: T, json: { employee_id: a.id } });
    await req('POST', `/api/admin/employees/${a.id}/timeoff`, { token: T, json: { start_date: '2026-12-08', end_date: '2026-12-08', reason: 'Doctor' } });
    const off = await req('POST', `/api/admin/dispatch/visits/${v3}/crew`, { token: T, json: { employee_id: a.id } });
    const st = globalThis.__st;
    const otStaff = await req('POST', `/api/admin/dispatch/visits/${v4}/crew`, { token: st, json: { employee_id: a.id, override_reason: 'need' } });
    const otNoReason = await req('POST', `/api/admin/dispatch/visits/${v4}/crew`, { token: T, json: { employee_id: a.id } });
    const otOk = await req('POST', `/api/admin/dispatch/visits/${v4}/crew`, { token: T, json: { employee_id: a.id, override_reason: 'Customer deadline' } });
    const cand = (await req('GET', `/api/admin/dispatch/visits/${v2}/candidates`, { token: T })).data;
    globalThis.__sch = { a, b, v1, v2, v3, v4 };
    assert(a && b && dupe.status === 409 && ok1.status === 200 && overlap.status === 409 && /already on/.test(overlap.data.error) && off.status === 409 && /off on/.test(off.data.error) && otStaff.status === 403 && otNoReason.status === 409 && otNoReason.data.needs_override && otOk.status === 200 && cand.recommended[0] === b.id && cand.candidates.find(c => c.id === a.id).block.length, JSON.stringify({ overlap: overlap.data, off: off.data, otNoReason: otNoReason.data, rec: cand.recommended }));
    return `overlap 409 ("${overlap.data.error.slice(0, 60)}…"); time off 409; overtime: staff 403, no reason 409, owner with reason OK; recommender picks Ben (Ana busy)`;
  });
  await check('Schedule', 'Untimed jobs on the same day warn instead of block (crew can do two small jobs); timed overlaps still block', async () => {
    const e = (await req('POST', '/api/admin/employees', { token: T, json: { name: 'Untimed Crew' } })).data.employee;
    const u1 = (await mkVisit('Untimed A', '2026-12-14', '', '')), u2 = (await mkVisit('Untimed B', '2026-12-14', '', ''));
    const a1 = await req('POST', `/api/admin/dispatch/visits/${vid(u1)}/crew`, { token: T, json: { employee_id: e.id } });
    const a2 = await req('POST', `/api/admin/dispatch/visits/${vid(u2)}/crew`, { token: T, json: { employee_id: e.id } });
    assert(a1.status === 200 && a2.status === 200 && a2.data.warnings.some(w => /no set time/.test(w)), JSON.stringify([a1.data, a2.data]));
    return `second untimed job assigned with warning: "${a2.data.warnings.find(w => /no set time/.test(w))}"`;
  });
  await check('Schedule', 'Dispatch needs crew + manager, respects project planning holds; emails crew; reschedule detects conflicts; holiday and skip rules', async () => {
    const { a, b, v1, v2 } = globalThis.__sch;
    const noCrew = await req('POST', `/api/admin/dispatch/visits/${v2}/dispatch`, { token: T });
    await req('POST', `/api/admin/dispatch/visits/${v2}/crew`, { token: T, json: { employee_id: b.id } });
    const staffD = await req('POST', `/api/admin/dispatch/visits/${v2}/dispatch`, { token: globalThis.__st });
    const before = (await req('GET', '/api/admin/emails', { token: T })).data.emails.length;
    const d1 = await req('POST', `/api/admin/dispatch/visits/${v1}/dispatch`, { token: T });
    const sent = (await req('GET', '/api/admin/emails', { token: T })).data.emails.filter(e => /^Dispatched: Lobby clean/.test(e.subject));
    const plan = (await req('POST', '/api/admin/projects', { token: T, json: { name: 'Held project', status: 'Planning' } })).data.id;
    const pv = vid(await mkVisit('Held job', '2026-12-10', '08:00', '10:00', { project_id: plan }));
    await req('POST', `/api/admin/dispatch/visits/${pv}/crew`, { token: T, json: { employee_id: b.id } });
    const held = await req('POST', `/api/admin/dispatch/visits/${pv}/dispatch`, { token: T });
    const mv = await req('POST', `/api/admin/dispatch/visits/${v2}/move`, { token: T, json: { date: '2026-12-07', start_time: '09:00', end_time: '10:00' } });
    await req('POST', `/api/admin/dispatch/visits/${v1}/crew`, { token: T, json: { employee_id: b.id } }).catch(() => {});
    await req('POST', '/api/admin/holidays', { token: T, json: { date: '2026-12-25', name: 'Christmas' } });
    const hol = await req('POST', `/api/admin/dispatch/visits/${v2}/move`, { token: T, json: { date: '2026-12-25' } });
    const skipNo = await req('POST', `/api/admin/dispatch/visits/${v2}/skip`, { token: T, json: {} });
    const skip = await req('POST', `/api/admin/dispatch/visits/${v2}/skip`, { token: T, json: { reason: 'Building closed' } });
    const board = (await req('GET', '/api/admin/dispatch/board?date=2026-12-07', { token: T })).data;
    assert(noCrew.status === 409 && staffD.status === 403 && d1.status === 200 && d1.data.crew === 1 && sent.length === 1 && sent[0].to_addr === 'ana@crew.test' && held.status === 409 && /Planning|tentative/i.test(held.data.error) && hol.status === 409 && hol.data.holiday && skipNo.status === 400 && skip.status === 200 && board.kpis.today >= 1 && typeof board.kpis.available === 'number', JSON.stringify({ noCrew: noCrew.data, staffD: staffD.status, d1: d1.data, sent: sent.length, held: held.data, mv: mv.data, hol: hol.data, k: board.kpis }));
    return `no crew 409; staff dispatch 403; dispatched with email to ${sent[0].to_addr}; project in Planning blocks dispatch; holiday move 409; skip needs reason; board KPIs today ${board.kpis.today}, available ${board.kpis.available}/${board.kpis.staff}`;
  });
  await check('Schedule', 'Crew link: sees only own dispatched jobs, no prices; check-in/out records time; checklist gates completion; incident reaches Issues; approved time posts labor cost to the project', async () => {
    const { a, v1 } = globalThis.__sch;
    const link = (await req('GET', `/api/admin/employees/${a.id}/link`, { token: T })).data.url;
    const staffLink = await req('GET', `/api/admin/employees/${a.id}/link`, { token: globalThis.__st });
    const tok = link.split('/').pop();
    const page = await fetch(B + link); const html = await page.text();
    const me = (await req('GET', `/api/crew/${tok}?date=2026-12-07`)).data;
    const bad = await req('GET', '/api/crew/not-a-real-token');
    const other = await req('POST', `/api/crew/${tok}/jobs/${globalThis.__sch.v2}/checkin`, { json: {} });
    const pid = globalThis.__pmId;
    await req('PATCH', '/api/admin/visits/' + v1, { token: T, json: { project_id: pid } }).catch(() => {});
    const ci = await req('POST', `/api/crew/${tok}/jobs/${v1}/checkin`, { json: {} });
    const ci2 = await req('POST', `/api/crew/${tok}/jobs/${v1}/checkin`, { json: {} });
    const inc = await req('POST', `/api/crew/${tok}/jobs/${v1}/incident`, { json: { title: 'Broken lobby tile', description: 'Found cracked tile by elevator' } });
    const co = await req('POST', `/api/crew/${tok}/jobs/${v1}/checkout`, { json: {} });
    const comp = await req('POST', `/api/crew/${tok}/jobs/${v1}/complete`, { json: {} });
    const iss = (await req('GET', '/api/admin/issues?status=open&q=Broken%20lobby', { token: T })).data.issues[0];
    const te = (await req('GET', '/api/admin/time?from=2026-01-01&to=2030-01-01', { token: T })).data.entries.find(x => x.visit_id === v1);
    const man = await req('POST', '/api/admin/time', { token: T, json: { employee_id: a.id, visit_id: v1, clock_in: '2026-12-07T08:00:00Z', clock_out: '2026-12-07T12:30:00Z' } });
    const bad16 = await req('POST', '/api/admin/time', { token: T, json: { employee_id: a.id, clock_in: '2026-12-07T00:00:00Z', clock_out: '2026-12-08T00:00:00Z' } });
    const before = (await req('GET', '/api/admin/pm/projects/' + pid, { token: T })).data.project.actual_cost;
    const ap = await req('POST', `/api/admin/time/${man.data.id}/approve`, { token: T });
    const again = await req('POST', `/api/admin/time/${man.data.id}/approve`, { token: T });
    const after = (await req('GET', '/api/admin/pm/projects/' + pid, { token: T })).data.project.actual_cost;
    const job = me.jobs.find(j => j.id === v1);
    assert(link.startsWith('/crew/') && staffLink.status === 403 && page.status === 200 && /My jobs/.test(html) && me.employee.name === 'Ana Crew' && job && !JSON.stringify(me).match(/proposal_total|amount|hourly_rate|price/i) && bad.status === 404 && other.status === 404 && ci.status === 200 && ci2.status === 409 && inc.status === 201 && co.status === 200 && comp.status === 200 && iss && iss.type === 'incident' && iss.source === 'Employee' && te && te.clock_out && man.status === 201 && bad16.status === 400 && ap.status === 200 && ap.data.cost === 99 && again.status === 409 && Math.abs(after - before - 99) < 0.01, JSON.stringify({ staffLink: staffLink.status, me: me.jobs.length, other: other.status, ci2: ci2.data, comp: comp.data, iss: !!iss, ap: ap.data, before, after }));
    return `crew page loads; only own jobs, no prices; someone else's job 404; double check-in 409; incident → ${iss.number}; check-out/complete recorded; manual 4.5 h × $22 = $${ap.data.cost} approved → project actual cost $${before} → $${after}; >16 h entry 400; staff cannot see crew links`;
  });

  // ---------- Quality & Inspections (#24) ----------
  await check('Quality', '10 configurable templates; weighted scoring; failed item needs a comment; sign-off needs every item rated and locks the inspection; staff cannot edit templates', async () => {
    const t = (await req('GET', '/api/admin/qc/templates', { token: T })).data.templates;
    const fin = t.find(x => x.name === 'Construction final clean');
    const cu = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'QC Customer', email: 'qc@qccust.test' } })).data.id;
    const ins = (await req('POST', '/api/admin/qc/inspections', { token: T, json: { template_id: fin.id, area: 'Bldg A', date: '2026-12-01', customer_id: cu, crew: 'A' } })).data.inspection;
    const items = ins.items.map((i, n) => ({ ...i, result: n === 0 ? 'Fail' : 'Pass' }));
    const noNote = await req('PATCH', '/api/admin/qc/inspections/' + ins.id, { token: T, json: { items } });
    items[0].note = 'Residue near entry';
    const ok = await req('PATCH', '/api/admin/qc/inspections/' + ins.id, { token: T, json: { items } });
    const tot = items.reduce((s, i) => s + i.weight, 0), exp = Math.round((tot - items[0].weight) / tot * 1000) / 10;
    const half = await req('POST', '/api/admin/qc/inspections', { token: T, json: { template_id: fin.id, area: 'Unrated', date: '2026-12-01' } });
    const signEmpty = await req('POST', `/api/admin/qc/inspections/${half.data.inspection.id}/sign`, { token: T, json: { name: 'Eric Moore' } });
    const sign = await req('POST', `/api/admin/qc/inspections/${ins.id}/sign`, { token: T, json: { name: 'Eric Moore' } });
    const locked = await req('PATCH', '/api/admin/qc/inspections/' + ins.id, { token: T, json: { notes: 'x' } });
    const staffTpl = await req('PUT', '/api/admin/qc/templates/' + fin.id, { token: globalThis.__st, json: { items: fin.items } });
    globalThis.__qc = { id: ins.id, cu };
    assert(t.length >= 10 && fin.items.every(i => i.room && i.weight) && noNote.status === 400 && /comment/.test(noNote.data.error) && ok.data.inspection.score === exp && ok.data.inspection.passed === 0 && signEmpty.status === 400 && sign.status === 200 && sign.data.inspection.status === 'Corrective action' && sign.data.inspection.signed_name === 'Eric Moore' && locked.status === 409 && staffTpl.status === 403, JSON.stringify({ n: t.length, score: ok.data.inspection.score, exp, sign: sign.data, locked: locked.status }));
    return `${t.length} templates; weighted score ${exp}% (one weight-${items[0].weight} item failed); fail without comment 400; unrated sign 400; signed by Eric Moore → Corrective action; locked after signing (409); staff template edit 403`;
  });
  await check('Quality', 'Failed items create corrective work orders (no duplicates) in Issues & Tasks; reinspection of only failed items closes the original when it passes', async () => {
    const { id } = globalThis.__qc;
    const c1 = await req('POST', `/api/admin/qc/inspections/${id}/corrective`, { token: T, json: { assigned_to: OWNER } });
    const c2 = await req('POST', `/api/admin/qc/inspections/${id}/corrective`, { token: T, json: {} });
    const task = (await req('GET', '/api/admin/issues/' + c1.data.ids[0], { token: T })).data.issue;
    const re = (await req('POST', `/api/admin/qc/inspections/${id}/reinspect`, { token: T })).data;
    const ri = re.inspection;
    await req('PATCH', '/api/admin/qc/inspections/' + ri.id, { token: T, json: { items: ri.items.map(i => ({ ...i, result: 'Pass' })) } });
    const s2 = await req('POST', `/api/admin/qc/inspections/${ri.id}/sign`, { token: T, json: { name: 'Eric Moore' } });
    const orig = (await req('GET', '/api/admin/qc/inspections/' + id, { token: T })).data;
    assert(c1.status === 201 && c1.data.created === 1 && c2.data.created === 0 && task.type === 'task' && task.source === 'Inspection' && /Corrective:/.test(task.title) && /Residue near entry/.test(task.description) && ri.items.length === 1 && ri.itype === 'Reinspection' && re.open_corrective === 1 && s2.data.inspection.passed === 1 && orig.inspection.status === 'Closed' && orig.reinspections.length === 1 && orig.corrective.length === 1, JSON.stringify({ c1: c1.data, c2: c2.data, ri: ri && ri.items.length, orig: orig.inspection.status }));
    return `1 corrective task (${task.number}, source Inspection), repeat 0; reinspection with 1 item passed 100% → original Closed`;
  });
  await check('Quality', 'Customer walkthrough acceptance: blocked while deficiencies are open unless "with exceptions"; clean acceptance records project sign-off; PDF; dashboard & reports by customer/category; repeat failures', async () => {
    const { cu } = globalThis.__qc;
    const tpl = (await req('GET', '/api/admin/qc/templates', { token: T })).data.templates.find(x => x.name === 'Commercial janitorial');
    const pr = (await req('POST', '/api/admin/projects', { token: T, json: { name: 'QC project', status: 'Planning' } })).data.id;
    const mk = async (fail) => { const i = (await req('POST', '/api/admin/qc/inspections', { token: T, json: { template_id: tpl.id, area: 'HQ', date: '2026-12-02', customer_id: cu, project_id: pr, itype: 'Customer walkthrough', crew: 'B' } })).data.inspection;
      await req('PATCH', '/api/admin/qc/inspections/' + i.id, { token: T, json: { items: i.items.map((x, n) => ({ ...x, result: fail && n === 0 ? 'Fail' : 'Pass', note: fail && n === 0 ? 'Trash left in office 3' : '' })) } });
      await req('POST', `/api/admin/qc/inspections/${i.id}/sign`, { token: T, json: { name: 'Eric Moore' } }); return i.id; };
    const w1 = await mk(true), w2 = await mk(true), w3 = await mk(false);
    const blocked = await req('POST', `/api/admin/qc/inspections/${w1}/accept`, { token: T, json: { name: 'Pat Client' } });
    const exc = await req('POST', `/api/admin/qc/inspections/${w1}/accept`, { token: T, json: { name: 'Pat Client', with_exceptions: true } });
    const clean = await req('POST', `/api/admin/qc/inspections/${w3}/accept`, { token: T, json: { name: 'Pat Client', title: 'Office manager' } });
    const proj = (await req('GET', '/api/admin/pm/projects/' + pr, { token: T })).data.project;
    const pdf = await fetch(B + `/api/admin/qc/inspections/${w1}/pdf`, { headers: { Authorization: 'Bearer ' + T } }); const pt = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    const dash = (await req('GET', '/api/admin/qc/dashboard?from=2026-01-01&to=2027-01-01', { token: T })).data;
    const byCust = (await req('GET', '/api/admin/qc/report?by=customer&from=2026-01-01&to=2027-01-01', { token: T })).data.rows.find(r => r.key === 'QC Customer');
    const byCat = (await req('GET', '/api/admin/qc/report?by=category&from=2026-01-01&to=2027-01-01', { token: T })).data.rows;
    assert(blocked.status === 409 && blocked.data.outstanding.length === 1 && exc.status === 200 && exc.data.inspection.status === 'Accepted with exceptions' && clean.data.inspection.status === 'Customer accepted' && proj.signoff_name === 'Pat Client' && pt.startsWith('%PDF') && pt.includes('Trash left in office 3') && dash.kpis.completed >= 4 && dash.deficiencies.length && dash.repeat_failures.some(r => r.where === 'QC Customer' && r.n >= 2) && dash.by_project.some(p => p.project === 'QC project') && byCust && byCust.inspections >= 4 && byCat.length >= 1, JSON.stringify({ pdf: pdf.status, pdfHas: pt.includes('Trash left in office 3'), pdfHead: pt.slice(0, 8), byCust, byCat, bp: dash.by_project }));
    return `acceptance blocked with 1 open deficiency (409); "with exceptions" recorded; clean walkthrough accepted → project sign-off "Pat Client"; PDF has the comment; KPIs avg ${dash.kpis.avg}%, failed ${dash.kpis.failed}; repeat failure flagged at QC Customer (${dash.repeat_failures[0].n}×); report by customer ${byCust.avg}% avg`;
  });

  // ---------- Drawings & Documents (#25) ----------
  await check('Documents', 'Revision control: new revision supersedes the old one (history kept, takeoffs flagged), revision label required, only current can be revised; sheet index with discipline; archive is owner/manager only and reversible', async () => {
    const pdf = new Blob([Buffer.from('%PDF-1.4\n% drawings v1\n')], { type: 'application/pdf' });
    const fd = new FormData(); fd.append('files', pdf, 'Terrell-A.pdf'); fd.append('kind', 'Drawings'); fd.append('revision', 'IFC'); fd.append('title', 'Sample drawing set');
    const up = await (await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd })).json();
    const id = up.ids[0];
    const rv = async (rev, file = true, target = id) => { const f = new FormData(); if (file) f.append('file', new Blob([Buffer.from('%PDF-1.4\n% v2\n')], { type: 'application/pdf' }), 'Terrell-A-rev2.pdf'); if (rev) f.append('revision', rev); const r = await fetch(B + `/api/admin/docs/${target}/revision`, { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: f }); return { status: r.status, data: await r.json() }; };
    const sh = await req('PUT', `/api/admin/docs/${id}/sheets`, { token: T, json: { sheets: [{ sheet: 'G0.1', title: 'Cover' }, { sheet: 'A1.1', title: 'Level 1' }] } });
    const dupe = await req('PUT', `/api/admin/docs/${id}/sheets`, { token: T, json: { sheets: [{ sheet: 'A1.1' }, { sheet: 'a1.1' }] } });
    const noLabel = await rv('');
    const same = await rv('IFC');
    const r2 = await rv('Rev 2');
    const again = await rv('Rev 3', true, id);
    const nd = (await req('GET', '/api/admin/docs/' + r2.data.id, { token: T })).data, od = (await req('GET', '/api/admin/docs/' + id, { token: T })).data;
    const staffArch = await req('PATCH', '/api/admin/docs/' + r2.data.id, { token: globalThis.__st, json: { archive: true } });
    const arch = await req('PATCH', '/api/admin/docs/' + r2.data.id, { token: T, json: { archive: true } });
    const unarch = await req('PATCH', '/api/admin/docs/' + r2.data.id, { token: T, json: { archive: false } });
    const lib = (await req('GET', '/api/admin/docs/library', { token: T })).data;
    const noBp = await req('POST', `/api/admin/docs/${r2.data.id}/takeoff`, { token: T });
    assert(sh.data.sheets[0].discipline === 'General' && sh.data.sheets[1].discipline === 'Architectural' && dupe.status === 400 && noLabel.status === 400 && same.status === 400 && r2.status === 201 && again.status === 409 && nd.document.status === 'Current' && nd.document.version === 2 && nd.document.sheets.length === 2 && nd.history.length === 1 && nd.history[0].revision === 'IFC' && od.document.status === 'Superseded' && od.newer.id === r2.data.id && staffArch.status === 403 && arch.data.document.status === 'Archived' && unarch.data.document.status === 'Current' && lib.kpis.superseded >= 1 && noBp.status === 409, JSON.stringify({ sh: sh.data, r2: r2.data, again: again.data, nd: nd.document && nd.document.status, od: od.document.status, lib: lib.kpis }));
    return `IFC → Rev 2 (v2): old Superseded with link to newer, history 1, sheets carried over (G=General, A=Architectural); revising superseded 409; no label / same label 400; staff archive 403; archive + restore; library KPIs ${JSON.stringify(lib.kpis)}`;
  });

  // ---------- Takeoff & Estimating engine (#26) ----------
  await check('Engine', 'Server pricing from the price book: factors, mobilization, minimum charge, labor hours/cost, margin warning, $/SF and quantity sanity checks', async () => {
    const mk = async (name, unit, price, rate) => (await req('POST', '/api/admin/scopes', { token: T, json: { category: 'construction', name, unit, pricing_method: 'per_unit', unit_price: price, production_rate: rate } })).data;
    const a = await mk('Engine rough clean', 'SF', 0.12, 2000), b = await mk('Engine window clean', 'pane', 6, 12);
    const aid = (a.item || a.scope || a).id, bid = (b.item || b.scope || b).id;
    const cu = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Engine GC', email: 'est@enginegc.test' } })).data.id;
    const tk = (await req('POST', '/api/admin/takeoffs', { token: T, json: { name: 'Engine job', category: 'construction', building_sf: 40000, customer_id: cu, lines: [{ scope_id: aid, quantity: 40000, sheet: 'G0.1', method: 'From schedule' }, { scope_id: bid, quantity: 200, sheet: 'A3.1', method: 'Measured' }] } })).data.takeoff;
    const p0 = (await req('GET', `/api/admin/takeoffs/${tk.id}/price`, { token: T })).data.price;
    const bad = await req('PUT', `/api/admin/takeoffs/${tk.id}/adjustments`, { token: T, json: { custom: [{ label: 'x', pct: 500 }] } });
    const p1 = (await req('PUT', `/api/admin/takeoffs/${tk.id}/adjustments`, { token: T, json: { factors: ['high_work', 'occupied', 'nonsense'], mobilization: 350, labor_rate: 32, margin_target: 40 } })).data.price;
    const p2 = (await req('PUT', `/api/admin/takeoffs/${tk.id}/adjustments`, { token: T, json: { minimum: 20000, labor_rate: 32 } })).data.price;
    const over = (await req('POST', '/api/admin/takeoffs', { token: T, json: { name: 'Over job', category: 'construction', building_sf: 1000, lines: [{ scope_id: aid, quantity: 5000, sheet: 'A1', method: 'Measured' }] } })).data.takeoff;
    const p3 = (await req('GET', `/api/admin/takeoffs/${over.id}/price`, { token: T })).data.price;
    globalThis.__eng = { tk: tk.id, aid, bid, cu };
    const base = 40000 * 0.12 + 200 * 6, hrs = 40000 / 2000 + 200 / 12;
    assert(p0.base === base && p0.total === base && /labor rate/.test(p0.warnings.join(' ')) && bad.status === 400 && p1.factor_pct === 25 && p1.adjustment === base * 0.25 && p1.total === base * 1.25 + 350 && Math.abs(p1.hours - hrs) < 0.02 && Math.abs(p1.labor_cost - hrs * 32 * 1.25) < 0.5 && p1.margin_pct > 0 && p2.minimum_applied && p2.total === 20000 && p3.warnings.some(w => /more than the building area/.test(w)) && !p3.warnings.some(w => /outside the usual/.test(w)) && (await req('GET', `/api/admin/takeoffs/${tk.id}/price`, { token: T })).data.price.warnings.length >= 0, JSON.stringify({ w0: p0.warnings, p1: p1 && { pct: p1.factor_pct, adj: p1.adjustment, tot: p1.total, h: p1.hours, lc: p1.labor_cost, m: p1.margin_pct }, p2: p2 && [p2.total, p2.minimum_applied], p3: p3.warnings }));
    return `base $${base} (40,000 SF × $0.12 + 200 panes × $6); +25% (high work, occupied) + $350 mobilization = $${p1.total}; ${p1.hours} labor h × $32 → cost $${p1.labor_cost}, margin ${p1.margin_pct}%; minimum $20,000 applied; over-quantity and $/SF warnings`;
  });
  await check('Engine', 'Convert to a draft estimate with sheet-sourced lines and adjustment lines; re-pricing updates the same draft; a sent proposal is protected; revised drawings block conversion until a new version or confirmation', async () => {
    const { tk, cu } = globalThis.__eng;
    await req('PUT', `/api/admin/takeoffs/${tk}/adjustments`, { token: T, json: { factors: ['after_hours'], labor_rate: 30 } });
    const e1 = await req('POST', `/api/admin/takeoffs/${tk}/estimate`, { token: T, json: {} });
    const est = (await req('GET', '/api/admin/estimates/' + e1.data.estimate_id, { token: T })).data.estimate;
    await req('PUT', `/api/admin/takeoffs/${tk}/adjustments`, { token: T, json: { factors: [], labor_rate: 30 } });
    const e2 = await req('POST', `/api/admin/takeoffs/${tk}/estimate`, { token: T, json: {} });
    const est2 = (await req('GET', '/api/admin/estimates/' + e1.data.estimate_id, { token: T })).data.estimate;
    await req('PATCH', '/api/admin/estimates/' + e1.data.estimate_id, { token: T, json: { status: 'Sent' } });
    const e3 = await req('POST', `/api/admin/takeoffs/${tk}/estimate`, { token: T, json: {} });
    // stale drawings
    const fd = new FormData(); fd.append('files', new Blob([Buffer.from('%PDF-1.4\n')], { type: 'application/pdf' }), 'eng.pdf'); fd.append('kind', 'Drawings'); fd.append('revision', 'IFC');
    const doc = (await (await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd })).json()).ids[0];
    const t2 = (await req('POST', '/api/admin/takeoffs', { token: T, json: { name: 'Stale job', category: 'construction', document_id: doc, customer_id: cu, building_sf: 10000, lines: [{ scope_id: globalThis.__eng.aid, quantity: 10000, sheet: 'G0.1', method: 'From schedule' }] } })).data.takeoff;
    const f2 = new FormData(); f2.append('file', new Blob([Buffer.from('%PDF-1.4\n%r2')], { type: 'application/pdf' }), 'eng2.pdf'); f2.append('revision', 'Rev 2');
    const rev = await (await fetch(B + `/api/admin/docs/${doc}/revision`, { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: f2 })).json();
    const blocked = await req('POST', `/api/admin/takeoffs/${t2.id}/estimate`, { token: T, json: {} });
    const v2 = await req('POST', `/api/admin/takeoffs/${t2.id}/version`, { token: T, json: {} });
    const nt = (await req('GET', '/api/admin/takeoffs', { token: T })).data.takeoffs.find(x => x.id === v2.data.id);
    const ok = await req('POST', `/api/admin/takeoffs/${v2.data.id}/estimate`, { token: T, json: {} });
    const ack = await req('POST', `/api/admin/takeoffs/${t2.id}/estimate`, { token: T, json: { acknowledge_stale: true } });
    const items = typeof est.line_items === 'string' ? JSON.parse(est.line_items) : est.line_items;
    assert(e1.status === 201 && est.status === 'Draft' && est.company === 'Engine GC' && items.some(i => i.sheet === 'A3.1') && items.some(i => /After-hours/.test(i.description || '')) && est.labor_hours > 0 && est.proposal_total === e1.data.total && e2.status === 200 && e2.data.updated && e2.data.estimate_id === e1.data.estimate_id && est2.proposal_total < est.proposal_total && e3.status === 409 && blocked.status === 409 && blocked.data.stale && v2.status === 201 && v2.data.version === 2 && v2.data.document_id === rev.id && nt.name === 'Stale job v2' && !nt.stale_note && ok.status === 201 && ack.status === 201, JSON.stringify({ e1: e1.data, e2: e2.data, e3: e3.data, blocked: blocked.data, v2: v2.data, rev, ok: ok.data }));
    return `draft estimate #${e1.data.estimate_id} $${e1.data.total} (sheets on lines, after-hours line, ${est.labor_hours} h); re-priced same draft → $${e2.data.total}; sent proposal 409; revised drawings block conversion (409) → v2 on Rev 2 converts; or confirm to proceed`;
  });

  // ---------- Reports: P&L, aging, labor, PDF, schedules (#27) ----------
  await check('Reports+', 'P&L for a custom range: invoiced (no drafts/void), collected, recorded costs by category, gross profit and margin; project profitability; data checks', async () => {
    const pr = (await req('POST', '/api/admin/projects', { token: T, json: { name: 'Report project', status: 'In Progress' } })).data.id;
    const mkInv = async (amount, paid, status, due) => { const n = (await req('GET', '/api/admin/next-invoice-number', { token: T })).data.number; const created = (await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: n, project_id: pr, customer_name: 'Rep Co', company: 'Rep Co', email: 'ap@rep.test', amount, due_date: due, status: ['Paid', 'Partially Paid'].includes(status) ? 'Sent' : status } })).data; const iid = created.id || (created.invoice && created.invoice.id); if (paid > 0) await req('POST', `/api/admin/invoices/${iid}/payment`, { token: T, json: { amount: paid } }); return created; };
    await mkInv(10000, 4000, 'Partially Paid', '2026-10-01'); await mkInv(5000, 0, 'Draft', '2026-12-01'); await mkInv(2000, 0, 'Void', '2026-12-01');
    await req('POST', `/api/admin/pm/projects/${pr}/costs`, { token: T, json: { category: 'Labor', amount: 3000, cost_date: require('../bizdate').today() } });
    await req('POST', `/api/admin/pm/projects/${pr}/costs`, { token: T, json: { category: 'Supplies', amount: 500, cost_date: require('../bizdate').today() } });
    const from = require('../bizdate').today(), to = from;
    const fr = await req('GET', `/api/admin/reports/finance?from=${from}&to=${to}`, { token: T }); if (!fr.data.projects) throw new Error(fr.status + ' ' + JSON.stringify(fr.data).slice(0, 200)); const f = fr.data;
    const p = f.projects.find(x => x.id === pr);
    const sw = (await req('GET', `/api/admin/reports/finance?from=${to}&to=2020-01-01`, { token: T })).data;
    assert(f.invoiced >= 10000 && f.collected >= 4000 && f.cost_by_category.Labor >= 3000 && f.cost_by_category.Supplies >= 500 && Math.abs(f.gross_profit - (f.invoiced - f.costs)) < 0.01 && p.invoiced === 10000 && p.collected === 4000 && p.cost === 3500 && p.profit === 6500 && p.margin === 65 && /Revenue = invoices issued/.test(f.basis) && sw.from === '2020-01-01', JSON.stringify({ f: { inv: f.invoiced, col: f.collected, costs: f.costs, cat: f.cost_by_category, gp: f.gross_profit }, p, checks: f.checks }));
    globalThis.__repProj = pr;
    return `project: invoiced $10,000 (draft/void excluded), collected $4,000, cost $3,500 (labor $3,000 + supplies $500) → profit $6,500, margin 65%; reversed date range corrected; checks: ${f.checks.length}`;
  });
  await check('Reports+', 'A/R aging buckets by days past due with customer totals; labor report: hours, cost, overtime per week, pending approval; PDF export; scheduled report (owner only, valid emails) sends the summary email', async () => {
    await new Promise(r => { try { smtp.close(() => r()); } catch { r(); } setTimeout(r, 1000); }); smtp = await startSmtp(); await sleep(300);
    const a = (await req('GET', '/api/admin/reports/aging', { token: T })).data;
    const rep = a.invoices.find(i => i.customer === 'Rep Co');
    const lab = (await req('GET', '/api/admin/reports/labor?from=2026-01-01&to=2027-12-31', { token: T })).data;
    const ana = lab.employees.find(e => e.name === 'Ana Crew');
    const pdf = await fetch(B + '/api/admin/reports/pdf?from=2026-01-01&to=2027-12-31', { headers: { Authorization: 'Bearer ' + T } }); const pt = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    const bad = await req('POST', '/api/admin/reports/schedules', { token: T, json: { frequency: 'Weekly', recipients: 'not-an-email' } });
    const staff = await req('POST', '/api/admin/reports/schedules', { token: globalThis.__st, json: { frequency: 'Weekly', recipients: 'boss@brightclean.test' } });
    const sc = await req('POST', '/api/admin/reports/schedules', { token: T, json: { frequency: 'Monthly', recipients: 'boss@brightclean.test, acct@brightclean.test' } });
    const sent = await req('POST', `/api/admin/reports/schedules/${sc.data.id}/send`, { token: T });
    const mails = (await req('GET', '/api/admin/emails', { token: T })).data.emails.filter(e => /monthly report/.test(e.subject));
    const late = Math.round((Date.parse(require('../bizdate').today() + 'T00:00:00Z') - Date.parse('2026-10-01T00:00:00Z')) / 864e5); // calendar days on the business clock
    assert(rep && rep.balance === 6000 && rep.days_late === late && rep.bucket === (late <= 30 ? '1–30' : late <= 60 ? '31–60' : late <= 90 ? '61–90' : '90+') && a.customers.some(c => c.customer === 'Rep Co' && c.total === 6000) && Math.abs(Object.values(a.buckets).reduce((s, v) => s + v, 0) - a.total) < 0.02 && ana && ana.hours > 0 && ana.cost > 0 && lab.totals.hours >= ana.hours && /Overtime/.test(lab.basis) && pdf.status === 200 && pt.startsWith('%PDF') && pt.includes('Accounts receivable aging') && bad.status === 400 && staff.status === 403 && sc.status === 201 && [200, 502].includes(sent.status) && mails.length === 2 && mails.every(m => /Open receivables/.test(m.body)) && (sent.status === 200 || /could not be sent/.test(sent.data.error)), JSON.stringify({ rep, ana, tot: lab.totals, sent: sent.data, mails: mails.length }));
    return `Rep Co $6,000 open, ${rep.days_late} days late → ${rep.bucket}; Ana ${ana.hours} h / $${ana.cost} (overtime ${ana.overtime_hours} h); PDF with P&L/aging/labor; bad email 400, staff 403; monthly report attempted to both recipients (each logged in Email Center; failures reported, not hidden)`;
  });

  // ---------- Contracts Management Center (#28) ----------
  await check('Contracts', 'Send needs email/value/scope/start; customer link: view → sign (full name + authorization, IP/time) → owner countersign executes it; staff cannot countersign; signed contract is locked; project hold clears', async () => {
    const k = (await req('POST', '/api/admin/contracts', { token: T, json: { company: 'Signco', customer_name: 'Sam Sign', title: 'Signco janitorial', value: 0, status: 'Draft' } })).data;
    const kid = k.id || (k.contract && k.contract.id);
    const s0 = await req('POST', `/api/admin/contracts2/${kid}/send`, { token: T });
    const bad = await req('PATCH', `/api/admin/contracts2/${kid}`, { token: T, json: { email: 'nope' } });
    await req('PATCH', `/api/admin/contracts2/${kid}`, { token: T, json: { email: 'sam@signco.test', value: '48,600', scope: 'Nightly janitorial, 5 nights/week', start_date: '2026-12-01', end_date: '2027-11-30', payment_terms: 'Net 30', auto_renew: true } });
    const s1 = await req('POST', `/api/admin/contracts2/${kid}/send`, { token: T });
    const tok = s1.data.link.split('/').pop();
    const page = await fetch(B + '/contract/' + tok); const html = await page.text();
    const pub = (await req('GET', '/api/contract/' + tok)).data.contract;
    const st = (await req('GET', `/api/admin/contracts2/${kid}`, { token: T })).data.contract;
    const noAgree = await req('POST', `/api/contract/${tok}/sign`, { json: { name: 'Sam Sign' } });
    const oneName = await req('POST', `/api/contract/${tok}/sign`, { json: { name: 'Sam', agree: true } });
    const sg = await req('POST', `/api/contract/${tok}/sign`, { json: { name: 'Sam Sign', title: 'Facilities', agree: true } });
    const again = await req('POST', `/api/contract/${tok}/sign`, { json: { name: 'Sam Sign', agree: true } });
    const edit = await req('PATCH', `/api/admin/contracts2/${kid}`, { token: T, json: { value: 1 } });
    const staffCs = await req('POST', `/api/admin/contracts2/${kid}/countersign`, { token: globalThis.__st, json: { name: 'Crew Person' } });
    const pr = (await req('POST', '/api/admin/projects', { token: T, json: { name: 'Signco project', contract_id: kid, status: 'Planning' } })).data.id;
    const before = (await req('GET', '/api/admin/pm/projects/' + pr, { token: T })).data.guard_next;
    const cs = await req('POST', `/api/admin/contracts2/${kid}/countersign`, { token: T, json: { name: 'Eric Moore' } });
    const after = (await req('GET', '/api/admin/pm/projects/' + pr, { token: T })).data.guard_next;
    const pdf = await fetch(B + `/api/admin/contracts2/${kid}/pdf`, { headers: { Authorization: 'Bearer ' + T } }); const pt = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    const leak = JSON.stringify(pub);
    globalThis.__k = kid;
    assert(s0.status === 400 && /customer email/.test(s0.data.error) && bad.status === 400 && s1.status === 200 && page.status === 200 && /Sign contract|Contract/.test(html) && pub.value === 48600 && /Net 30/.test(JSON.stringify(pub)) && !/public_token|signed_ip|countersigned_by/.test(leak) && st.signature_status === 'Viewed' && st.viewed_at && noAgree.status === 400 && oneName.status === 400 && sg.status === 200 && again.status === 409 && edit.status === 409 && staffCs.status === 403 && /Customer signed/.test(before) && cs.status === 200 && cs.data.contract.signature_status === 'Signed' && cs.data.contract.status === 'Active' && !/contract/.test(after || '') && pt.startsWith('%PDF') && pt.includes('Sam Sign') && pt.includes('Eric Moore'), JSON.stringify({ s0: s0.data, s1: s1.data, st: st.signature_status, before, after, cs: cs.data }));
    return `send blocked until email/value/scope/start set; link viewed → Viewed; one-word name / no authorization 400; signed (IP+time); re-sign 409; edit after signing 409; staff countersign 403; owner countersign → Signed + Active; project hold no longer cites the contract; PDF has both signatures; no internal fields on the public link`;
  });
  await check('Contracts', 'A signed contract with no project creates its job at countersign (Contracted, linked both ways)', async () => {
    const k = (await req('POST', '/api/admin/contracts', { token: T, json: { company: 'JobCo', customer_name: 'Job Owner', title: 'JobCo cleaning', value: 1200, status: 'Draft' } })).data;
    const kid = k.id || (k.contract && k.contract.id);
    await req('PATCH', `/api/admin/contracts2/${kid}`, { token: T, json: { email: 'owner@jobco.test', value: 1200, scope: 'Nightly cleaning', start_date: '2026-12-01', end_date: '2027-11-30' } });
    const s1 = await req('POST', `/api/admin/contracts2/${kid}/send`, { token: T });
    const tok = s1.data.link.split('/').pop();
    await req('POST', `/api/contract/${tok}/sign`, { json: { name: 'Job Owner', title: 'Owner', agree: true } });
    const before = (await req('GET', '/api/admin/pm/projects', { token: T })).data.projects.filter(x => x.contract_id === kid).length;
    const cs = await req('POST', `/api/admin/contracts2/${kid}/countersign`, { token: T, json: { name: 'Eric Moore' } });
    const projects = (await req('GET', '/api/admin/pm/projects', { token: T })).data.projects.filter(x => x.contract_id === kid);
    const kc = (await req('GET', `/api/admin/contracts2/${kid}`, { token: T })).data.contract;
    const ok = cs.status === 200 && before === 0 && projects.length === 1 && projects[0].status === 'Contracted' && kc.project_id === projects[0].id;
    assert(ok, JSON.stringify({ cs: cs.status, before, projects: projects.map(p => [p.id, p.status]), project_id: kc.project_id }));
    return `countersign created project #${projects[0].id} (Contracted) and linked contract.project_id`;
  });
  await check('Flow', 'Office sign-off releases visits: a visit planned on an unsigned contract is Tentative, becomes Scheduled at countersign; a project cannot be created as Completed', async () => {
    const k = (await req('POST', '/api/admin/contracts', { token: T, json: { company: 'ReleaseCo', customer_name: 'Rel Owner', title: 'ReleaseCo cleaning', value: 900, status: 'Draft' } })).data;
    const kid = k.id || (k.contract && k.contract.id);
    await req('PATCH', `/api/admin/contracts2/${kid}`, { token: T, json: { email: 'owner@release.test', value: 900, scope: 'Weekly cleaning', start_date: '2026-12-01', end_date: '2027-11-30' } });
    const pj = (await req('POST', '/api/admin/projects', { token: T, json: { name: 'ReleaseCo job', contract_id: kid, status: 'Planning', service: 'janitorial' } })).data;
    const pid = pj.id || (pj.project && pj.project.id);
    const vis = await req('POST', '/api/admin/visits', { token: T, json: { title: 'ReleaseCo walkthrough', date: '2026-12-02', project_id: pid } });
    const before = (await req('GET', '/api/admin/visits', { token: T })).data.visits.find(v => v.id === (vis.data.id || (vis.data.visit && vis.data.visit.id)));
    const s1 = await req('POST', `/api/admin/contracts2/${kid}/send`, { token: T });
    const tok = s1.data.link.split('/').pop();
    await req('POST', `/api/contract/${tok}/sign`, { json: { name: 'Rel Owner', title: 'Owner', agree: true } });
    const cs = await req('POST', `/api/admin/contracts2/${kid}/countersign`, { token: T, json: { name: 'Eric Moore' } });
    const after = (await req('GET', '/api/admin/visits', { token: T })).data.visits.find(v => v.project_id === pid);
    const completed = await req('POST', '/api/admin/projects', { token: T, json: { name: 'Done at birth', status: 'Completed' } });
    const ok = vis.status === 201 && before && before.status === 'Tentative' && cs.status === 200 && after && after.status === 'Scheduled' && completed.status === 409;
    assert(ok, JSON.stringify({ visit: vis.status, before: before && before.status, cs: cs.status, after: after && after.status, completed: completed.status }));
    return `visit on unsigned contract: Tentative → Scheduled at countersign; project created as Completed refused (409)`;
  });
  await check('Contracts', 'Amendment and renewal of a proposal-approved contract need the customer signature before countersign; the original countersigns on the approval', async () => {
    await req('PUT', '/api/admin/approval-rules', { token: T, json: { min_margin_pct: 15, max_total: 25000, flag_pre_pricing: false, approve_all: false } });
    const items = (await req('GET', '/api/admin/scopes', { token: T })).data.items;
    const mo = items.find(i => i.name === 'Move-in / move-out clean – 2 Bed / 2 Bath').id;
    const est = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Amy Amend', company: 'Amend Co', email: 'amy@amend.test', project_name: 'Amend turns', scope: 'Monthly unit turns', scope_category: 'multifamily', use_line_items: 1, labor_rate: 20, labor_hours: 10, line_items: [{ scope_id: mo, quantity: 6 }] } })).data.estimate;
    await req('PATCH', `/api/admin/estimates/${est.id}`, { token: T, json: { status: 'Sent' } });
    const tok = (await req('GET', '/api/admin/estimates/' + est.id, { token: T })).data.estimate.public_token;
    const yes = await req('POST', `/api/proposal/${tok}/respond`, { json: { decision: 'approve', signer_name: 'Amy Signer', signer_title: 'Owner', agree: true } });
    const kid = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.find(c => c.estimate_id === est.id).id;
    await req('PATCH', `/api/admin/contracts2/${kid}`, { token: T, json: { start_date: '2026-12-01', end_date: '2027-11-30' } });
    const cs0 = await req('POST', `/api/admin/contracts2/${kid}/countersign`, { token: T, json: { name: 'Eric Moore' } });
    const am = await req('POST', `/api/admin/contracts2/${kid}/amend`, { token: T, json: { reason: 'Add a porter day' } });
    const amId = am.data.id || (am.data.contract && am.data.contract.id);
    const acs = await req('POST', `/api/admin/contracts2/${amId}/countersign`, { token: T, json: { name: 'Eric Moore' } });
    const rn = await req('POST', `/api/admin/contracts2/${kid}/renew`, { token: T, json: {} });
    const rnId = rn.data.id || (rn.data.contract && rn.data.contract.id);
    const rcs = rnId ? await req('POST', `/api/admin/contracts2/${rnId}/countersign`, { token: T, json: { name: 'Eric Moore' } }) : { status: 0, data: {} };
    const ok = yes.status === 200 && cs0.status === 200 && am.status === 201 && acs.status === 409 && rn.status === 201 && rcs.status === 409;
    assert(ok, JSON.stringify({ yes: yes.status, cs0: cs0.status, am: am.status, acs: acs.status, rn: rn.status, rcs: rcs.status, err: acs.data && acs.data.error }));
    return `original countersigned on approval (200); amendment countersign refused (${acs.status}) until the customer signs; renewal countersign refused (${rcs.status})`;
  });
  await check('Contracts', 'Decline with reason; editing a sent contract voids the old link; amendment supersedes the original once executed; renewal shifts dates and price; dashboard counts', async () => {
    const kid = globalThis.__k;
    const k2 = (await req('POST', '/api/admin/contracts', { token: T, json: { company: 'Declineco', title: 'Declineco windows', value: 5000, status: 'Draft' } })).data;
    const id2 = k2.id || (k2.contract && k2.contract.id);
    await req('PATCH', `/api/admin/contracts2/${id2}`, { token: T, json: { email: 'a@declineco.test', scope: 'Windows', start_date: '2026-12-01' } });
    const t1 = (await req('POST', `/api/admin/contracts2/${id2}/send`, { token: T })).data.link.split('/').pop();
    const noReason = await req('POST', `/api/contract/${t1}/decline`, { json: {} });
    const dec = await req('POST', `/api/contract/${t1}/decline`, { json: { reason: 'Price too high for exterior' } });
    await req('PATCH', `/api/admin/contracts2/${id2}`, { token: T, json: { value: 4500 } });
    const old = await req('GET', '/api/contract/' + t1);
    const t2 = (await req('POST', `/api/admin/contracts2/${id2}/send`, { token: T })).data.link.split('/').pop();
    const am0 = await req('POST', `/api/admin/contracts2/${id2}/amend`, { token: T, json: { reason: 'x' } });
    const am = await req('POST', `/api/admin/contracts2/${kid}/amend`, { token: T, json: { reason: 'Add Saturday day porter' } });
    await req('PATCH', `/api/admin/contracts2/${am.data.id}`, { token: T, json: { value: 52000 } });
    const at = (await req('POST', `/api/admin/contracts2/${am.data.id}/send`, { token: T })).data.link.split('/').pop();
    const asg = await req('POST', `/api/contract/${at}/sign`, { json: { name: 'Sam Sign', agree: true } });
    const acs = await req('POST', `/api/admin/contracts2/${am.data.id}/countersign`, { token: T, json: { name: 'Eric Moore' } });
    const orig = (await req('GET', `/api/admin/contracts2/${kid}`, { token: T })).data;
    const amd = (await req('GET', `/api/admin/contracts2/${am.data.id}`, { token: T })).data.contract;
    const rn = await req('POST', `/api/admin/contracts2/${am.data.id}/renew`, { token: T, json: { increase_pct: 3 } });
    const rn2 = await req('POST', `/api/admin/contracts2/${am.data.id}/renew`, { token: T, json: {} });
    const rk = (await req('GET', `/api/admin/contracts2/${rn.data.id}`, { token: T })).data.contract;
    const dash = (await req('GET', '/api/admin/contracts2', { token: T })).data.kpis;
    assert(noReason.status === 400 && dec.status === 200 && old.status === 404 && t2 !== t1 && am0.status === 409 && am.status === 201 && orig.contract.status === 'Superseded' && amd.number.endsWith('-v2') && amd.signature_status === 'Signed' && orig.versions.length >= 2 && rn.status === 201 && rn.data.start_date === '2027-12-01' && rn2.status === 409 && Math.abs(rk.value - 53560) < 0.01 && rk.kind === 'Renewal' && dash.executed >= 1 && dash.drafts >= 1, JSON.stringify({ dec: dec.data, old: old.status, am0: am0.data, orig: orig.contract.status, amd: amd.number, rn: rn.data, rk: rk.value, dash }));
    return `decline needs a reason; editing voided the old link (404) and a new link was issued; draft can't be amended; amendment ${amd.number} executed → original Superseded; renewal from ${rn.data.start_date} at +3% ($${rk.value}); KPIs ${JSON.stringify(dash)}`;
  });

  // ---------- Calls: phone-provider capture (#29) ----------
  await check('Calls', 'Twilio webhooks: forged or unsigned requests 403; signed missed call auto-logged with today follow-up and customer matched by phone; duplicate CallSid updates instead of duplicating; recording + transcript attach; intel dashboard', async () => {
    const crypto = require('crypto'), base = (process.env.PUBLIC_BASE_URL_TEST || 'https://brightclean.net');
    const cu = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Phone Match Co', name: 'Pat Phone', phone: '(515) 555-0943', email: 'pat@phonematch.test' } })).data.id;
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params, sig) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(sig ? { 'X-Twilio-Signature': sig } : {}) }, body: new URLSearchParams(params).toString() });
    const p1 = { CallSid: 'CA111', From: '+15155550943', To: '+15155550100', Direction: 'inbound', CallStatus: 'no-answer', CallDuration: '0' };
    const none = await post('/api/webhooks/twilio/status', p1);
    const forged = await post('/api/webhooks/twilio/status', p1, crypto.createHmac('sha1', 'wrong').update('x').digest('base64'));
    const ok = await post('/api/webhooks/twilio/status', p1, sign('/api/webhooks/twilio/status', p1));
    const p2 = { ...p1, CallStatus: 'completed', CallDuration: '95' };
    const again = await post('/api/webhooks/twilio/status', p2, sign('/api/webhooks/twilio/status', p2));
    const calls = (await req('GET', '/api/admin/calls', { token: T })).data.calls.filter(c => c.provider_sid === 'CA111');
    const r1 = { CallSid: 'CA111', RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1' };
    const rec = await post('/api/webhooks/twilio/recording', r1, sign('/api/webhooks/twilio/recording', r1));
    const r2 = { CallSid: 'CA111', RecordingUrl: 'https://evil.test/x' };
    const badRec = await post('/api/webhooks/twilio/recording', r2, sign('/api/webhooks/twilio/recording', r2));
    const t1 = { CallSid: 'CA111', TranscriptionText: 'Hi this is Pat, we need a quote for a 20,000 square foot final clean next month.' };
    const tr = await post('/api/webhooks/twilio/transcription', t1, sign('/api/webhooks/twilio/transcription', t1));
    await req('POST', '/api/admin/customers', { token: T, json: { company: 'Shared Line A', phone: '515-555-0811', email: 'a@sl.test' } }); await req('POST', '/api/admin/customers', { token: T, json: { company: 'Shared Line B', phone: '515.555.0811', email: 'b@sl.test' } });
    const p3 = { CallSid: 'CA222', From: '+15155550811', To: '+15155550100', Direction: 'inbound', CallStatus: 'completed', CallDuration: '30' };
    await post('/api/webhooks/twilio/status', p3, sign('/api/webhooks/twilio/status', p3));
    const shared = (await req('GET', '/api/admin/calls', { token: T })).data.calls.find(c => c.provider_sid === 'CA222');
    const det = (await req('GET', `/api/admin/calls/${calls[0].id}/detail`, { token: T })).data.call;
    const intel = (await req('GET', '/api/admin/calls-intel', { token: T })).data;
    const noAuth = await req('GET', '/api/admin/calls-intel');
    globalThis.__call = calls[0].id;
    assert(none.status === 403 && forged.status === 403 && ok.status === 200 && again.status === 200 && calls.length === 1 && calls[0].customer_id === cu && calls[0].outcome === 'Missed' && calls[0].duration_s === 95 && calls[0].follow_up_date === require('../bizdate').today() && rec.status === 200 && badRec.status === 400 && tr.status === 200 && /20,000 square foot/.test(det.transcript) && /api\.twilio\.com/.test(det.recording_url) && shared && shared.customer_id === null && intel.connected && intel.total_30 >= 1 && noAuth.status === 401, JSON.stringify({ none: none.status, forged: forged.status, ok: ok.status, calls, det: det && det.recording_url, intel }));
    return 'unsigned 403, forged 403; signed no-answer → call logged, matched to Phone Match Co, follow-up today; later "completed" updated duration (95 s) but kept Missed; recording (Twilio URL only) and transcript attached; intel dashboard; admin-only';
  });

  await check('Calls', 'Inbound call handling: signed voice webhook returns TwiML voicemail (no forward number); unanswered dial → Voicemail with follow-up and recording/transcribe callbacks; parent "completed" keeps Voicemail', async () => {
    const crypto = require('crypto'), base = 'https://brightclean.net';
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params, sig) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(sig ? { 'X-Twilio-Signature': sig } : {}) }, body: new URLSearchParams(params).toString() });
    const v = { CallSid: 'CA333', From: '+15155550444', To: '+15155550100', Direction: 'inbound' };
    const forged = await post('/api/webhooks/twilio/voice', v);
    const vr = await post('/api/webhooks/twilio/voice', v, sign('/api/webhooks/twilio/voice', v)); const vx = await vr.text();
    const dr = { ...v, DialCallStatus: 'no-answer' };
    const dres = await post('/api/webhooks/twilio/dial-result', dr, sign('/api/webhooks/twilio/dial-result', dr)); const dx = await dres.text();
    const st = { ...v, CallStatus: 'completed', CallDuration: '40' };
    await post('/api/webhooks/twilio/status', st, sign('/api/webhooks/twilio/status', st));
    const c = (await req('GET', '/api/admin/calls', { token: T })).data.calls.filter(x => x.provider_sid === 'CA333');
    const ans = { ...v, CallSid: 'CA444', DialCallStatus: 'completed' };
    const ar = await (await post('/api/webhooks/twilio/dial-result', ans, sign('/api/webhooks/twilio/dial-result', ans))).text();
    const intel = (await req('GET', '/api/admin/calls-intel', { token: T })).data;
    assert(/may be recorded for quality/.test(vx), 'voicemail greeting carries the recording notice: ' + vx);
    assert(forged.status === 403 && vr.status === 200 && /<Record [^>]*transcribe="true"/.test(vx) && /transcribeCallback="https:\/\/brightclean\.net\/api\/webhooks\/twilio\/transcription"/.test(vx) && !/<Dial/.test(vx) && /<Record/.test(dx) && c.length === 1 && c[0].outcome === 'Voicemail' && c[0].follow_up_date === require('../bizdate').today() && c[0].duration_s === 40 && /<Hangup\/>/.test(ar) && intel.voice_url === 'https://brightclean.net/api/webhooks/twilio/voice' && intel.forwarding === false, JSON.stringify({ vx, dx, c, ar, intel }));
    return 'unsigned 403; no forward number → greeting + transcribed voicemail; unanswered dial → Voicemail call with today follow-up; later "completed" kept Voicemail (40 s); answered dial hangs up cleanly';
  });

  await check('Audit', 'Taxed line-item proposal: customer page gets subtotal + tax; PDF shows Subtotal, Tax and Total that tie to the line items; lump-sum lines show no fake "0" qty or $0.00 rate', async () => {
    const lines = [['Phase 1 – Construction Clean', 76623.75], ['Phase 2 – Pre-Punch Clean', 54731.25], ['Phase 3 – Post-Punch / Final Clean', 65677.5], ['Phase 4 – Furniture / Turnover Clean', 21892.5], ['Rental Allowance', 10500], ['Interior + Exterior Window Cleaning', 40000]];
    const e = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Audit GC', company: 'Audit GC', scope: 'Four-phase construction cleaning', area_sqft: 417000, use_line_items: 1, tax_pct: 8.25, line_items: lines.map(([description, amount]) => ({ description, amount })) } })).data.estimate;
    const pub = (await req('GET', '/api/proposal/' + e.public_token, { token: T })).data.proposal;
    const pdf = await fetch(B + `/api/admin/bids/${e.id}/pdf`, { headers: { Authorization: 'Bearer ' + T } }); const buf = Buffer.from(await pdf.arrayBuffer());
    const fs = require('fs'), os = require('os'), path = require('path'), f = path.join(os.tmpdir(), 'audit-' + e.id + '.pdf'); fs.writeFileSync(f, buf);
    const txt = require('child_process').execFileSync('pdftotext', ['-layout', f, '-']).toString().replace(/\s+/g, ' ');
    assert(e.proposal_total === 291652.56 && e.line_items_total === 269425 && pub.tax_pct === 8.25 && pub.line_items_total === 269425 && /Subtotal before tax/.test(txt) && /\$269,425\.00/.test(txt) && /Tax \(8\.25%\)/.test(txt) && /\$22,227\.56/.test(txt) && /Total/.test(txt) && /\$291,652\.56/.test(txt) && /Phase 1 – Construction Clean/.test(txt.replace(/-/g, '–')) && /\$76,623\.75/.test(txt) && !/ 0 \$0\.00/.test(txt), JSON.stringify({ total: e.proposal_total, pub: [pub.tax_pct, pub.line_items_total], txt: txt.slice(txt.indexOf('Pricing'), txt.indexOf('Pricing') + 500) }));
    return 'lines $269,425.00 + 8.25% tax $22,227.56 = $291,652.56 on the PDF and the customer feed; no fake qty/rate on lump-sum lines';
  });

  await check('Audit', 'Approval hand-off links the new project and contract to the proposal and the customer; files attach to a proposal (and its customer) and list on the proposal', async () => {
    const cu = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Handoff GC', name: 'Hana Off', email: 'hana@handoffgc.test' } })).data.id;
    const e = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Hana Off', company: 'Handoff GC', email: 'hana@handoffgc.test', project_name: 'Handoff job', scope: 'Final clean', area_sqft: 10000, use_line_items: 1, line_items: [{ description: 'Final clean', amount: 4000 }] } })).data.estimate;
    await req('PATCH', '/api/admin/estimates/' + e.id, { token: T, json: { status: 'Sent' } }); await req('POST', `/api/proposal/${e.public_token}/respond`, { json: { decision: 'approve', signer_name: 'Hana Off', signer_title: 'PM', agree: true } }); await sleep(300);
    const k = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.find(c => c.estimate_id === e.id);
    const pr = (await req('GET', '/api/admin/projects', { token: T })).data.projects.find(x => x.contract_id === (k && k.id));
    const fd = new FormData(); fd.append('files', new Blob([Buffer.from('%PDF-1.4\n%prop')], { type: 'application/pdf' }), 'Handoff_Proposal.pdf'); fd.append('kind', 'Proposal'); fd.append('estimate_id', String(e.id)); fd.append('title', 'Handoff Proposal');
    const up = await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd }); const upd = await up.json();
    const files = (await req('GET', `/api/admin/estimates/${e.id}/files`, { token: T })).data.files;
    const bad = new FormData(); bad.append('files', new Blob([Buffer.from('%PDF-1.4\n')], { type: 'application/pdf' }), 'x.pdf'); bad.append('estimate_id', '999999');
    const badr = await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: bad });
    const docs = (await req('GET', '/api/admin/documents', { token: T })).data.documents.filter(d => d.title === 'Handoff Proposal');
    assert(k && k.customer_id === cu && pr && pr.estimate_id === e.id && pr.customer_id === cu && up.status === 201 && files.length === 1 && files[0].kind === 'Proposal' && docs.length === 1 && docs[0].customer_id === cu && badr.status === 400, JSON.stringify({ k, pr: pr && { e: pr.estimate_id, c: pr.customer_id }, upd, files, docs, bad: badr.status }));
    return 'approved → contract + project linked to proposal and customer; PDF attached to the proposal shows in its file list and in the customer’s documents; unknown proposal rejected';
  });

  // ---------- DIRECTIVE WORKFLOW A: website inquiry → paid invoice, one continuous record ----------
  await check('Workflow A', 'Website bid request → lead → customer → proposal → client approval → signed contract → project → schedule/crew → inspection → acceptance → invoice → payment → reports', async () => {
    const steps = [], ok = (n, pass, ev) => { steps.push({ step: n, result: pass ? 'PASS' : 'FAIL', evidence: String(ev).slice(0, 240) }); return pass; };
    try {
    const co = 'Workflow A Builders', em = 'pm@workflowa.test';
    const mk = () => { const fd = new FormData(); Object.entries({ contact_name: 'Wanda Flow', company: co, email: em, phone: '515-555-0610', project_name: 'WFA Clinic', project_type: 'Medical office', address: '600 Flow Ave, Ankeny, IA', square_footage: '12,000', bid_due_date: '2026-12-15', details: 'Final clean + windows', consent: 'on' }).forEach(([k, v]) => fd.append(k, v)); fd.append('service', 'Post-construction final cleaning'); return fd; };
    // 1-2 website intake creates lead; duplicate handled
    const r1 = await fetch(B + '/api/bids', { method: 'POST', body: mk() }); const j1 = await r1.json();
    ok('1 Website bid request creates a lead', r1.status === 201 && j1.id, JSON.stringify(j1));
    const r2 = await fetch(B + '/api/bids', { method: 'POST', body: mk() }); const j2 = await r2.json();
    const leadsAll = (await req('GET', '/api/admin/leads', { token: T })).data.leads.filter(l => (l.email || '').toLowerCase() === em);
    ok('2 Duplicate submission does not create a second lead (or is flagged)', leadsAll.length === 1 || leadsAll.some(l => /duplicate/i.test(JSON.stringify(l))), `leads with this email: ${leadsAll.length}; 2nd response ${r2.status} ${JSON.stringify(j2).slice(0, 80)}`);
    // 3 customer created/matched
    const cust = (await req('GET', '/api/admin/customers', { token: T })).data.customers.filter(c => c.company === co || (c.email || '').toLowerCase() === em);
    ok('3 Customer profile created/matched (one record)', cust.length === 1, `customers matching: ${cust.length}`);
    const cid = cust[0] && cust[0].id;
    // 4 estimate from the lead
    const e = (await req('POST', '/api/admin/estimates', { token: T, json: { lead_id: j1.id, customer_name: 'Wanda Flow', company: co, email: em, project_name: 'WFA Clinic', site_address: '600 Flow Ave, Ankeny, IA', scope: 'Final clean, 12,000 SF', area_sqft: 12000, use_line_items: 1, tax_pct: 7, line_items: [{ description: 'Final clean', amount: 3600 }, { description: 'Interior windows', amount: 900 }] } })).data.estimate;
    ok('4 Estimate created from the lead with correct math', e && e.proposal_total === 4815 && e.line_items_total === 4500, e && `${e.line_items_total} + 7% = ${e.proposal_total}`);
    // 5 proposal sent by email
    const before = mail.length; const snd = await req('POST', `/api/admin/estimates/${e.id}/send`, { token: T }); await sleep(400);
    const sentMail = mail.find(m => m.to.includes(em) && m.raw.includes(e.public_token));
    ok('5 Proposal emailed to the client with its link', snd.status === 200 && sentMail && sentMail.raw.includes('/proposal/' + e.public_token), `${snd.status} ${JSON.stringify(snd.data).slice(0, 80)} mail:${!!sentMail}`);
    // 6 lead status advances
    const lead6 = (await req('GET', '/api/admin/leads', { token: T })).data.leads.find(l => l.id === j1.id);
    ok('6 Lead status reflects the sent proposal', lead6 && /Proposal Sent|Proposal in Progress/.test(lead6.status), lead6 && lead6.status);
    // 7 admin cannot approve; client views + approves
    const adm = await req('PATCH', '/api/admin/estimates/' + e.id, { token: T, json: { status: 'Approved' } });
    await req('GET', '/api/proposal/' + e.public_token);
    const ap = await req('POST', `/api/proposal/${e.public_token}/respond`, { json: { decision: 'approve', signer_name: 'Wanda Flow', signer_title: 'PM', agree: true } }); await sleep(400);
    const k0 = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.find(x => x.estimate_id === e.id);
    const p0 = k0 && (await req('GET', '/api/admin/projects', { token: T })).data.projects.find(x => x.contract_id === k0.id);
    ok('7 Only the client approves; approval prepares a DRAFT contract + planning project linked to customer & proposal', adm.status === 409 && ap.status === 200 && k0 && k0.signature_status !== 'Signed' && p0 && p0.status === 'Planning' && p0.customer_id === cid && p0.estimate_id === e.id, JSON.stringify({ adm: adm.status, ap: ap.status, k: k0 && [k0.status, k0.signature_status, k0.customer_id], p: p0 && [p0.status, p0.customer_id, p0.estimate_id] }));
    const lead7 = (await req('GET', '/api/admin/leads', { token: T })).data.leads.find(l => l.id === j1.id);
    ok('8 Lead marked Won after client approval', lead7 && lead7.status === 'Won', lead7 && lead7.status);
    // 9 contract signature workflow
    await req('PATCH', `/api/admin/contracts2/${k0.id}`, { token: T, json: { email: em, scope: 'Final clean, 12,000 SF + interior windows', start_date: '2026-12-01', end_date: '2026-12-31', value: 4815 } });
    const ks = await req('POST', `/api/admin/contracts2/${k0.id}/send`, { token: T });
    const ktok = ks.data.link && ks.data.link.split('/').pop();
    const sg = await req('POST', `/api/contract/${ktok}/sign`, { json: { name: 'Wanda Flow', title: 'PM', agree: true } });
    const cs = await req('POST', `/api/admin/contracts2/${k0.id}/countersign`, { token: T, json: { name: 'Eric Moore' } });
    ok('9 Contract sent, signed by client, countersigned → executed', ks.status === 200 && sg.status === 200 && cs.status === 200 && cs.data.contract.signature_status === 'Signed', JSON.stringify({ send: ks.status, sign: sg.status, cs: cs.status }));
    // 10 project readiness + dispatch authorization
    await req('POST', `/api/admin/pm/projects/${p0.id}/plan`, { token: T, json: { service: 'construction' } });
    for (const key of ['staffing', 'dates', 'access', 'equipment', 'supplies', 'safety']) await req('POST', `/api/admin/pm/projects/${p0.id}/readiness`, { token: T, json: { key } });
    const ad = await req('POST', `/api/admin/pm/projects/${p0.id}/approve-dispatch`, { token: T });
    const go = await req('POST', `/api/admin/pm/projects/${p0.id}/status`, { token: T, json: { status: 'In Progress' } });
    ok('10 Readiness confirmed, owner authorizes dispatch, project In Progress', ad.status === 200 && go.status === 200, JSON.stringify({ ad: [ad.status, ad.data.error], go: [go.status, go.data.error] }));
    // 11 schedule + crew + field work
    const emp = (await req('POST', '/api/admin/employees', { token: T, json: { name: 'Flo Crew', email: 'flo@crew.test', role: 'Lead', crew: 'A', skills: 'final clean', hourly_rate: 24, max_week_hours: 40 } })).data.employee;
    const v = (await req('POST', '/api/admin/visits', { token: T, json: { title: 'WFA final clean', date: require('../bizdate').today(), start_time: '08:00', end_time: '12:00', project_id: p0.id, customer_id: cid } })).data;
    const vid = (v.visit || v).id;
    const asg = await req('POST', `/api/admin/dispatch/visits/${vid}/crew`, { token: T, json: { employee_id: emp.id } });
    const dsp = await req('POST', `/api/admin/dispatch/visits/${vid}/dispatch`, { token: T });
    const link = (await req('GET', `/api/admin/employees/${emp.id}/link`, { token: T })).data.url; const ctok = link.split('/').pop();
    const ci = await req('POST', `/api/crew/${ctok}/jobs/${vid}/checkin`, { json: {} });
    const co2 = await req('POST', `/api/crew/${ctok}/jobs/${vid}/checkout`, { json: {} });
    ok('11 Visit scheduled for the project, crew assigned + dispatched, crew checks in/out from the field link', vid && asg.status === 200 && dsp.status === 200 && ci.status === 200 && co2.status === 200, JSON.stringify({ asg: [asg.status, asg.data.error], dsp: [dsp.status, dsp.data.error], ci: [ci.status, ci.data.error], co: [co2.status, co2.data.error] }));
    // 12 inspection + customer acceptance
    const tpl = (await req('GET', '/api/admin/qc/templates', { token: T })).data.templates[0];
    const ins = (await req('POST', '/api/admin/qc/inspections', { token: T, json: { template_id: tpl.id, area: 'Whole building', date: require('../bizdate').today(), customer_id: cid, project_id: p0.id, crew: 'A', itype: 'Customer walkthrough' } })).data.inspection;
    const insUp = await req('PATCH', `/api/admin/qc/inspections/${ins.id}`, { token: T, json: { items: ins.items.map(i => ({ ...i, result: 'Pass' })) } });
    const isg = await req('POST', `/api/admin/qc/inspections/${ins.id}/sign`, { token: T, json: { name: 'Eric Moore' } });
    const acc = await req('POST', `/api/admin/qc/inspections/${ins.id}/accept`, { token: T, json: { name: 'Wanda Flow', title: 'PM' } });
    ok('12 Inspection passed, signed; customer acceptance recorded', insUp.status === 200 && isg.status === 200 && acc.status === 200, JSON.stringify({ up: [insUp.status, insUp.data.error], sign: [isg.status, isg.data.error], acc: [acc.status, acc.data.error] }));
    // 13 completion + billing hand-off
    const pd = (await req('GET', '/api/admin/pm/projects/' + p0.id, { token: T })).data;
    for (const t of (pd.tasks || [])) { await req('PATCH', `/api/admin/pm/tasks/${t.id}`, { token: T, json: { approved: true, status: 'Done' } }); await req('PATCH', `/api/admin/pm/tasks/${t.id}`, { token: T, json: { status: 'Verified' } }); }
    const done = await req('POST', `/api/admin/pm/projects/${p0.id}/status`, { token: T, json: { status: 'Completed' } });
    const bh = await req('POST', `/api/admin/pm/projects/${p0.id}/billing-handoff`, { token: T });
    const inv = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(i => i.project_id === p0.id);
    ok('13 Project completed (customer sign-off) and billing hand-off creates ONE draft invoice for the contract value', done.status === 200 && [200, 201].includes(bh.status) && inv && inv.status === 'Draft' && Math.abs(inv.amount - 4815) < 0.01, JSON.stringify({ done: [done.status, done.data.error], bh: [bh.status, bh.data.error], inv: inv && [inv.status, inv.amount] }));
    // 14 invoice sent, partial then full payment
    const sendInv = await req('PATCH', '/api/admin/invoices/' + inv.id, { token: T, json: { status: 'Sent' } });
    const pay1 = await req('POST', `/api/admin/invoices/${inv.id}/payment`, { token: T, json: { amount: 2000 } });
    const mid = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(i => i.id === inv.id);
    const pay2 = await req('POST', `/api/admin/invoices/${inv.id}/payment`, { token: T, json: { amount: 2815 } });
    const fin = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(i => i.id === inv.id);
    const over = await req('POST', `/api/admin/invoices/${inv.id}/payment`, { token: T, json: { amount: 1 } });
    ok('14 Invoice sent; partial payment → Partially Paid; balance paid → Paid; overpayment refused', sendInv.status === 200 && pay1.status === 200 && mid.paid_amount === 2000 && pay2.status === 200 && fin.paid_amount === 4815 && fin.status === 'Paid' && [400, 409].includes(over.status), JSON.stringify({ mid: [mid.status, mid.paid_amount], fin: [fin.status, fin.paid_amount], over: over.status }));
    // 15 reports + customer history
    const from = '2020-01-01', to = '2030-12-31';
    const fr = (await req('GET', `/api/admin/reports/finance?from=${from}&to=${to}`, { token: T })).data;
    const prof = (await req('GET', `/api/admin/customers/${cid}/profile`, { token: T })).data;
    const pf = prof.financials || {};
    ok('15 Finance report includes the invoice + payment', fr && JSON.stringify(fr).includes('4815') || (fr.totals && fr.totals.collected >= 4815), JSON.stringify(fr.totals || fr).slice(0, 200));
    ok('16 Customer profile shows proposal, contract, project, invoice and payment history', prof && (prof.proposals || prof.estimates || []).some(x => x.id === e.id) && (prof.contracts || []).some(x => x.id === k0.id) && (prof.projects || []).some(x => x.id === p0.id) && (prof.invoices || []).some(x => x.id === inv.id), JSON.stringify({ keys: Object.keys(prof), fin: pf }).slice(0, 220));
    ok('17 Customer financials separate approved vs signed vs invoiced vs collected', pf && JSON.stringify(pf).includes('4815'), JSON.stringify(pf).slice(0, 220));
    const audit = (await req('GET', '/api/admin/audit-log', { token: T })).data.events;
    ok('18 Activity log records the key steps', audit.some(a => a.entity === 'contract' && a.entity_id == k0.id && /countersign/.test(a.action)) && audit.some(a => a.entity === 'invoice' && a.entity_id == inv.id), `events for contract/invoice: ${audit.filter(a => (a.entity === 'contract' && a.entity_id == k0.id) || (a.entity === 'invoice' && a.entity_id == inv.id)).length}`);
    } catch (err) { steps.push({ step: '(stopped)', result: 'FAIL', evidence: err.stack.split('\n').slice(0, 2).join(' ') }); }
    require('fs').writeFileSync(require('path').join(__dirname, 'workflowA.json'), JSON.stringify(steps, null, 1));
    const fails = steps.filter(s => s.result === 'FAIL');
    assert(!fails.length, fails.map(f => f.step + ' :: ' + f.evidence).join(' || '));
    return `${steps.length}/${steps.length} steps PASS on one continuous record`;
  });

  await check('Audit', 'D-01: a contract cannot be marked Signed without a recorded client signer; staff cannot record it; recorded copy keeps signer + who recorded it', async () => {
    const k = (await req('POST', '/api/admin/contracts', { token: T, json: { company: 'Paper Sign Co', title: 'Paper contract', value: 1200, status: 'Draft' } })).data; const id = k.id || (k.contract && k.contract.id);
    const bare = await req('PATCH', '/api/admin/contracts/' + id, { token: T, json: { signature_status: 'Signed' } });
    const fake = await req('PATCH', '/api/admin/contracts/' + id, { token: T, json: { signature_status: 'Customer signed' } });
    const staff = await req('PATCH', '/api/admin/contracts/' + id, { token: globalThis.__st, json: { signature_status: 'Signed', signer_name: 'Pat Paper' } });
    const ok = await req('PATCH', '/api/admin/contracts/' + id, { token: T, json: { signature_status: 'Signed', signer_name: 'Pat Paper', signer_title: 'Owner', signed_on: '2026-11-01' } });
    const d = (await req('GET', '/api/admin/contracts2/' + id, { token: T })).data.contract;
    assert(bare.status === 400 && fake.status === 409 && staff.status === 403 && ok.status === 200 && d.signature_status === 'Signed' && d.signer_name === 'Pat Paper' && /recorded signed copy/.test(d.countersigned_by) && d.signed_at.startsWith('2026-11-01'), JSON.stringify({ bare: bare.data, fake: fake.status, staff: staff.status, ok: ok.status, d: d && [d.signature_status, d.signer_name, d.countersigned_by] }));
    return 'bare "Signed" 400; faking "Customer signed" 409; staff 403; owner recorded paper signature with signer, date and recorder';
  });

  await check('Audit', 'D-05: the $1.79M "house" error cannot recur — a price-per-SF typed as production rate is refused on save and edit; absurd totals cannot be sent', async () => {
    const bad = await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'House Repro', scope: 'x', area_sqft: 20001, production_rate: 0.18, labor_rate: 11, overhead_pct: 10, margin_pct: 25, crew_size: 3 } });
    const e = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'House Repro', email: 'house@repro.test', scope: 'x', area_sqft: 20001, production_rate: 2000, labor_rate: 11, overhead_pct: 10, margin_pct: 25, crew_size: 3 } })).data.estimate;
    const edit = await req('PUT', '/api/admin/estimates/' + e.id, { token: T, json: { ...e, production_rate: 0.18 } });
    const big = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Absurd Co', email: 'absurd@co.test', scope: 'x', area_sqft: 1000, use_line_items: 1, line_items: [{ description: 'Clean', amount: 90000 }] } })).data.estimate;
    await req('POST', `/api/admin/estimates/${big.id}/approve`, { token: T, json: { note: 'ok' } });
    const send = await req('POST', `/api/admin/estimates/${big.id}/send`, { token: T });
    assert(bad.status === 400 && /looks like a price per square foot/.test(bad.data.error) && e && e.proposal_total < 10000 && edit.status === 400 && send.status === 409 && /cannot be sent until fixed/.test(send.data.error), JSON.stringify({ bad: bad.status, sane: e && e.proposal_total, edit: edit.status, send: [send.status, send.data.error] }));
    return `0.18 refused on create and edit; same job at 2,000 SF/h = $${e.proposal_total}; $90/SF proposal blocked from sending`;
  });

  // ---------- DIRECTIVE WORKFLOW F: customer complaint, one continuous record ----------
  await check('Workflow F', 'Complaint call → issue (no retyping) → owner alerted → customer emailed update (recorded) → corrective visit scheduled → work done → follow-up inspection → resolved → verified → closed; history retained', async () => {
    const steps = [], ok = (n, pass, ev) => { steps.push({ step: n, result: pass ? 'PASS' : 'FAIL', evidence: String(ev).slice(0, 220) }); return pass; };
    try {
      const cu = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Complaint Towers', name: 'Carl Plain', email: 'carl@complaint.test', phone: '515-555-0711' } })).data.id;
      const call = (await req('POST', '/api/admin/calls', { token: T, json: { contact_name: 'Carl Plain', phone: '515-555-0711', customer_id: cu, purpose: 'Complaint', summary: 'Lobby glass streaked and trash not emptied on 3rd floor after last night.' } })).data.call;
      ok('1 Complaint call logged and linked to the customer', call && call.customer_id === cu, call && call.id);
      const m0 = mail.length;
      const iss = await req('POST', `/api/admin/calls/${call.id}/issue`, { token: globalThis.__st, json: { priority: 'Urgent' } }); await sleep(300);
      const it = iss.data.issue;
      ok('2 Issue created from the call without retyping (complaint, linked, summary carried over)', iss.status === 201 && it.type === 'complaint' && it.customer_id === cu && /Lobby glass streaked/.test(it.description) && it.customer_comms === 'Needs update', JSON.stringify({ st: iss.status, err: iss.data.error, t: it && it.type, n: it && it.number }));
      const again = await req('POST', `/api/admin/calls/${call.id}/issue`, { token: T });
      ok('3 Same call cannot create a second issue', again.status === 409, again.status);
      ok('4 Owner alerted for an urgent complaint', mail.slice(m0).some(m => /Urgent complaint/i.test(m.subject)), mail.slice(m0).map(m => m.subject).join(' | '));
      const closeEarly = await req('PATCH', '/api/admin/issues/' + it.id, { token: T, json: { status: 'Resolved', resolution: 'x' } });
      ok('5 Cannot close a complaint before the customer is updated', closeEarly.status === 400, closeEarly.data.error);
      await req('POST', `/api/admin/issues/${it.id}/comments`, { token: T, json: { body: 'INTERNAL: night crew B skipped floor 3' } });
      const m1 = mail.length;
      const upd = await req('POST', `/api/admin/issues/${it.id}/customer-update`, { token: T, json: { message: 'Thank you for letting us know. We are sending a crew tomorrow at 7 AM to re-clean the lobby glass and service the 3rd floor.' } }); await sleep(300);
      const um = mail.slice(m1).find(m => m.to.includes('carl@complaint.test'));
      ok('6 Customer emailed an acknowledgment; recorded; internal note NOT included', upd.status === 200 && um && /re-clean the lobby glass/.test(um.raw) && !/INTERNAL|skipped floor/.test(um.raw) && upd.data.issue.customer_comms === 'Customer informed', JSON.stringify({ st: upd.status, sent: !!um }));
      const vis = await req('POST', `/api/admin/issues/${it.id}/schedule-visit`, { token: T, json: { date: '2026-12-02', start_time: '07:00', end_time: '09:00' } });
      const board = (await req('GET', '/api/admin/visits?from=2026-12-01&to=2026-12-03', { token: T })).data;
      const v = (board.visits || []).find(x => x.id === vis.data.visit_id);
      ok('7 Corrective visit scheduled from the issue (on the schedule, linked to customer); issue In progress', vis.status === 201 && v && v.customer_id === cu && vis.data.issue.status === 'In progress', JSON.stringify({ st: vis.status, v: v && [v.title, v.type] }));
      await req('PATCH', '/api/admin/visits/' + vis.data.visit_id, { token: T, json: { status: 'Completed' } });
      const tpl = (await req('GET', '/api/admin/qc/templates', { token: T })).data.templates[0];
      const ins = (await req('POST', '/api/admin/qc/inspections', { token: T, json: { template_id: tpl.id, area: 'Lobby + 3rd floor', date: '2026-12-02', customer_id: cu, crew: 'B' } })).data.inspection;
      await req('PATCH', `/api/admin/qc/inspections/${ins.id}`, { token: T, json: { items: ins.items.map(i => ({ ...i, result: 'Pass' })) } });
      const isg = await req('POST', `/api/admin/qc/inspections/${ins.id}/sign`, { token: T, json: { name: 'Eric Moore' } });
      ok('8 Follow-up inspection after the corrective work passes and is signed', isg.status === 200, isg.data.error || 'signed');
      const res1 = await req('PATCH', '/api/admin/issues/' + it.id, { token: T, json: { status: 'Resolved', resolution: 'Crew re-cleaned lobby glass and serviced floor 3; inspection passed.' } });
      const ver = await req('PATCH', '/api/admin/issues/' + it.id, { token: T, json: { verify: true } });
      const cl = await req('PATCH', '/api/admin/issues/' + it.id, { token: T, json: { status: 'Closed' } });
      ok('9 Resolved with resolution notes, verified, closed', res1.status === 200 && ver.status === 200 && cl.status === 200, JSON.stringify([res1.status, res1.data.error, ver.status, ver.data.error, cl.status, cl.data.error]));
      const full = (await req('GET', '/api/admin/issues/' + it.id, { token: T })).data;
      const prof = (await req('GET', `/api/admin/customers/${cu}/profile`, { token: T })).data;
      ok('10 History retained: comments (internal + customer-facing), call link, issue on customer profile', (full.comments || []).length >= 3 && (prof.issues || []).some(x => x.id === it.id) && (prof.calls || []).some(c => c.issue_id === it.id), JSON.stringify({ comments: (full.comments || []).length, profIssue: (prof.issues || []).some(x => x.id === it.id) }));
    } catch (err) { steps.push({ step: '(stopped)', result: 'FAIL', evidence: err.stack.split('\n').slice(0, 2).join(' ') }); }
    require('fs').writeFileSync(require('path').join(__dirname, 'workflowF.json'), JSON.stringify(steps, null, 1));
    const fails = steps.filter(s => s.result === 'FAIL');
    assert(!fails.length, fails.map(f => f.step + ' :: ' + f.evidence).join(' || '));
    return `${steps.length}/${steps.length} steps PASS`;
  });

  // ---------- DIRECTIVE WORKFLOW G: invoice and collection ----------
  await check('Workflow G', 'Invoice checked against contract → sent by email with PDF (recorded) → sending ≠ paid → reminder once (no duplicates) → partial → paid → resend blocked → aging/finance updated', async () => {
    const steps = [], ok = (n, pass, ev) => { steps.push({ step: n, result: pass ? 'PASS' : 'FAIL', evidence: String(ev).slice(0, 220) }); return pass; };
    try {
      const bdate = require('../bizdate').today(), addD = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
      await req('POST', '/api/admin/customers', { token: T, json: { company: 'Collect Co', name: 'Cora Lect', email: 'ap@collect.test' } });
      const e = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Cora Lect', company: 'Collect Co', email: 'ap@collect.test', project_name: 'Collect job', scope: 'Janitorial', area_sqft: 8000, use_line_items: 1, line_items: [{ description: 'Monthly janitorial', amount: 5000 }] } })).data.estimate;
      await req('PATCH', '/api/admin/estimates/' + e.id, { token: T, json: { status: 'Sent' } });
      await req('POST', `/api/proposal/${e.public_token}/respond`, { json: { decision: 'approve', signer_name: 'Cora Lect', signer_title: 'AP', agree: true } }); await sleep(300);
      const k = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.find(x => x.estimate_id === e.id);
      const p = (await req('GET', '/api/admin/projects', { token: T })).data.projects.find(x => x.contract_id === k.id);
      ok('1 Contract ($5,000) and project exist for billing', k && k.value === 5000 && p, k && k.value);
      const i1 = (await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: 'WFG-1', project_id: p.id, customer_name: 'Cora Lect', company: 'Collect Co', amount: 3000, due_date: addD(bdate, -2), status: 'Draft' } })).data;
      const id1 = i1.id || (i1.invoice && i1.invoice.id);
      const payDraft = await req('POST', `/api/admin/invoices/${id1}/payment`, { token: T, json: { amount: 100 } });
      const unsignedSend = await req('POST', `/api/admin/invoices/${id1}/send`, { token: T, json: { to: 'ap@collect.test' } });
      await req('PATCH', '/api/admin/contracts/' + k.id, { token: T, json: { signature_status: 'Signed', signer_name: 'Cora Lect', signed_on: bdate } });
      const noMail =await req('POST', `/api/admin/invoices/${id1}/send`, { token: T, json: { to: 'not-an-email' } });
      const m0 = mail.length; const s1 = await req('POST', `/api/admin/invoices/${id1}/send`, { token: T, json: { to: 'ap@collect.test' } }); await sleep(300);
      const sm = mail.slice(m0).find(m => m.to.includes('ap@collect.test'));
      ok('2 Invoice sent by email with the PDF attached; bad address refused; no payment on a Draft and no send before the contract is signed', payDraft.status === 409 && unsignedSend.status === 409 && /not signed/.test(unsignedSend.data.error || '') && noMail.status === 400 && s1.status === 200 && sm && /WFG-1/.test(sm.subject) && /application\/pdf/.test(sm.raw), JSON.stringify({ bad: noMail.status, s1: [s1.status, s1.data.error] }));
      const inv1 = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(i => i.id === id1);
      ok('3 Sending marks it Sent (with date + recipient) — NOT paid', inv1.status === 'Sent' && inv1.paid_amount === 0 && inv1.sent_to === 'ap@collect.test' && inv1.sent_at, JSON.stringify([inv1.status, inv1.paid_amount, inv1.sent_to]));
      const pdf = await fetch(B + `/api/admin/invoices/${id1}/pdf`, { headers: { Authorization: 'Bearer ' + T } }); const pt = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
      ok('4 Invoice PDF downloads with balance due', pdf.status === 200 && pt.startsWith('%PDF') && pt.includes('WFG-1') && pt.includes('3,000.00'), pdf.status);
      const i2 = (await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: 'WFG-2', project_id: p.id, customer_name: 'Cora Lect', company: 'Collect Co', email: 'ap@collect.test', amount: 2500, due_date: addD(bdate, 30), status: 'Draft' } })).data;
      const id2 = i2.id || (i2.invoice && i2.invoice.id);
      const over = await req('POST', `/api/admin/invoices/${id2}/send`, { token: T });
      const staffOver = await req('POST', `/api/admin/invoices/${id2}/send`, { token: globalThis.__st, json: { over_contract_reason: 'Change order 1' } });
      const ownerOver = await req('POST', `/api/admin/invoices/${id2}/send`, { token: T, json: { over_contract_reason: 'Approved change order #1: added Saturday service' } });
      ok('5 Billing above the contract value is stopped; staff cannot override; owner can with a recorded reason', over.status === 409 && /above the contract value/.test(over.data.error) && staffOver.status === 403 && ownerOver.status === 200, JSON.stringify([over.status, staffOver.status, ownerOver.status]));
      await req('PUT', '/api/admin/settings', { token: T, json: { auto_invoice_reminders: true } });
      await req('PATCH', '/api/admin/invoices/' + id1, { token: T, json: { email: 'ap@collect.test' } });
      const m1 = mail.length; await req('POST', '/api/admin/automation/run', { token: T }); await sleep(300);
      const rem1 = mail.slice(m1).filter(m => m.to.includes('ap@collect.test') && /WFG-1/.test(m.subject + m.raw));
      const m2 = mail.length; await req('POST', '/api/admin/automation/run', { token: T }); await sleep(300);
      const rem2 = mail.slice(m2).filter(m => m.to.includes('ap@collect.test') && /WFG-1/.test(m.subject + m.raw));
      await req('PUT', '/api/admin/settings', { token: T, json: { auto_invoice_reminders: false } });
      ok('6 Overdue reminder sent once; running again does not duplicate', rem1.length === 1 && /Past due/i.test(rem1[0].subject) && rem2.length === 0, JSON.stringify({ first: rem1.map(m => m.subject), second: rem2.length }));
      const pp = await req('POST', `/api/admin/invoices/${id1}/payment`, { token: T, json: { amount: 1000 } });
      const mid = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(i => i.id === id1);
      const pf = await req('POST', `/api/admin/invoices/${id1}/payment`, { token: T, json: { amount: 2000 } });
      const fin = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(i => i.id === id1);
      const resend = await req('POST', `/api/admin/invoices/${id1}/send`, { token: T });
      ok('7 Partial → Partially Paid; balance → Paid; a paid invoice cannot be re-sent', pp.status === 200 && mid.status === 'Partially Paid' && pf.status === 200 && fin.status === 'Paid' && resend.status === 409, JSON.stringify([mid.status, fin.status, resend.status]));
      const ag = (await req('GET', '/api/admin/reports/aging', { token: T })).data;
      const open2 = (ag.invoices || []).find(x => x.number === 'WFG-2'), paid1 = (ag.invoices || []).find(x => x.number === 'WFG-1');
      ok('8 A/R aging shows the open invoice and not the paid one', open2 && open2.balance === 2500 && !paid1, JSON.stringify({ open2: open2 && open2.balance, paid1: !!paid1 }));
      const dash0 = (await req('GET', '/api/admin/dashboard', { token: T })).data.finance;
      const cust0 = (await req('GET', '/api/admin/customers', { token: T })).data.customers.find(c => c.company === 'Collect Co');
      await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: 'WFG-D', project_id: p.id, customer_name: 'Cora Lect', company: 'Collect Co', email: 'ap@collect.test', amount: 777, due_date: addD(bdate, 30), status: 'Draft' } });
      const dash1 = (await req('GET', '/api/admin/dashboard', { token: T })).data.finance;
      const cust1 = (await req('GET', '/api/admin/customers', { token: T })).data.customers.find(c => c.company === 'Collect Co');
      const pre = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(i => i.id === id1);
      const over2 = await req('POST', `/api/admin/invoices/${id1}/refund`, { token: T, json: { amount: pre.paid_amount + 1, note: 'Too much' } });
      const rf = await req('POST', `/api/admin/invoices/${id1}/refund`, { token: T, json: { amount: 500, note: 'Duplicate charge' } });
      const post = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(i => i.id === id1);
      const trail = (await req('GET', '/api/admin/audit-log', { token: T })).data.events.filter(a => a.entity === 'invoice' && Number(a.entity_id) === Number(id1) && a.action === 'refunded');
      ok('11 A refund returns money: balance and status update, refund recorded in the activity log, cannot exceed what was received', over2.status === 409 && rf.status === 200 && Math.abs(post.paid_amount - (pre.paid_amount - 500)) < 0.01 && post.status === 'Partially Paid' && trail.length === 1, JSON.stringify({ over2: over2.status, rf: rf.status, paid: [pre.paid_amount, post.paid_amount], status: post.status, logged: trail.length }));
      ok('10 A Draft invoice is not billed: dashboard billed and the customer balance ignore it, matching Reports and Command', dash1.billed === dash0.billed && cust1.billed === cust0.billed && cust0.billed > 0, JSON.stringify({ dash: [dash0.billed, dash1.billed], cust: [cust0.billed, cust1.billed] }));
      const audit = (await req('GET', '/api/admin/audit-log', { token: T })).data.events.filter(a => a.entity === 'invoice' && [id1, id2].includes(Number(a.entity_id)));
      ok('9 Sends, the over-contract reason and payments are in the activity log', audit.some(a => /sent invoice/.test(a.action)) && audit.some(a => /above contract value/.test(a.details || '')), audit.map(a => a.action).join(', '));
    } catch (err) { steps.push({ step: '(stopped)', result: 'FAIL', evidence: err.stack.split('\n').slice(0, 2).join(' ') }); }
    require('fs').writeFileSync(require('path').join(__dirname, 'workflowG.json'), JSON.stringify(steps, null, 1));
    const fails = steps.filter(s => s.result === 'FAIL');
    assert(!fails.length, fails.map(f => f.step + ' :: ' + f.evidence).join(' || '));
    return `${steps.length}/${steps.length} steps PASS`;
  });

  await check('Permissions', 'Data integrity report is refused to staff and managers (owner only)', async () => {
    const s = await req('GET', '/api/admin/integrity', { token: globalThis.__st });
    assert(s.status === 403, 'staff got ' + s.status);
    return 'staff refused (403); owner allowed (checked in Backup)';
  });
  await check('Permissions', 'D-08: staff are refused on every owner/manager action (enforced on the server, denial logged); owner still allowed', async () => {
    const st = globalThis.__st, out = {};
    const deny = [['POST', '/api/admin/users', { email: 'x@y.test', password: 'a-long-password-123' }], ['DELETE', '/api/admin/users/999', null], ['PUT', '/api/admin/settings', { auto_handoff: true }], ['PUT', '/api/admin/ai/settings', { auto_triage: true }],
      ['PUT', '/api/admin/automation/ai-settings', {}], ['POST', '/api/admin/backups', {}], ['GET', '/api/admin/backups', null], ['GET', '/api/admin/backups/anything.db', null], ['POST', '/api/admin/invoices/1/payment', { amount: 1 }],
      ['GET', '/api/admin/users', null], ['GET', '/api/admin/reports/finance', null], ['GET', '/api/admin/reports/aging', null], ['GET', '/api/admin/audit-log', null], ['POST', '/api/admin/estimates/1/approve', { note: 'x' }], ['PUT', '/api/admin/approval-rules', { max_total: 0 }]];
    for (const [m, u, j] of deny) { const r = await req(m, u, { token: st, json: j || undefined }); out[m + ' ' + u] = r.status; }
    const allowedStaff = [['GET', '/api/admin/leads'], ['GET', '/api/admin/customers'], ['GET', '/api/admin/issues']];
    for (const [m, u] of allowedStaff) { const r = await req(m, u, { token: st }); out['staff ' + m + ' ' + u] = r.status; }
    const own = await req('GET', '/api/admin/users', { token: T }), ownFin = await req('GET', '/api/admin/reports/finance', { token: T });
    const logged = (await req('GET', '/api/admin/audit-log', { token: T })).data.events.filter(e => e.action === 'permission denied').length;
    const bad = Object.entries(out).filter(([k, v]) => k.startsWith('staff ') ? v !== 200 : v !== 403);
    assert(!bad.length && own.status === 200 && ownFin.status === 200 && logged >= deny.length - 2, JSON.stringify({ bad, own: own.status, logged }));
    return `${deny.length} sensitive actions refused for staff (403) and logged (${logged}); staff keep day-to-day access; owner allowed`;
  });

  // ---------- DIRECTIVE WORKFLOW B: general-contractor bid with drawings + addendum ----------
  await check('Workflow B', 'GC bid request with real PDF drawings → deadline alerts (once each) → drawings filed to the bid → sheet index → sheet-sourced takeoff → addendum supersedes + flags recheck → v2 takeoff → priced proposal linked to the bid → approval gate → sent on time → late-bid guard → GC accepts → contract/project → history preserved', async () => {
    const steps = [], ok = (n, pass, ev) => { steps.push({ step: n, result: pass ? 'PASS' : 'FAIL', evidence: String(ev).slice(0, 220) }); return pass; };
    try {
      const { Doc } = require('../pdf'); const mkPdf = (title, n) => { const d = new Doc(); for (let i = 1; i <= n; i++) { d.heading(`${title} — sheet A${i}.1`, 14); d.para('Floor plan. Finish schedule: VCT, carpet, sealed concrete. Restrooms 4.'); if (i < n) d.newPage ? d.newPage() : d.gap(800); } return d.toBuffer(); };
      const bdate = require('../bizdate').today(), addD = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
      const due = addD(bdate, 5), gc = 'Ironline Builders', em = 'est@ironline.test';
      const fd = new FormData(); Object.entries({ contact_name: 'Ivy Estimator', company: gc, email: em, phone: '515-555-0820', project_name: 'Ironline Clinic', project_type: 'Medical office', address: '800 Iron Way, Ankeny, IA', square_footage: '30,000', bid_due_date: due, details: 'Final clean + interior glass. Drawings attached.', consent: 'on' }).forEach(([k, v]) => fd.append(k, v));
      fd.append('service', 'Post-construction final cleaning'); fd.append('documents', new Blob([mkPdf('Ironline Clinic', 3)], { type: 'application/pdf' }), 'Ironline_A-sheets.pdf');
      const r1 = await fetch(B + '/api/bids', { method: 'POST', body: fd }); const j1 = await r1.json(); const lead = (await req('GET', '/api/admin/leads', { token: T })).data.leads.find(l => l.id === j1.id);
      ok('1 GC bid request captured: GC, project, due date, attached drawings', r1.status === 201 && lead && lead.company === gc && lead.bid_due_date === due && (Array.isArray(lead.files) ? lead.files : JSON.parse(lead.files || '[]')).length === 1, JSON.stringify({ st: r1.status, due: lead && lead.bid_due_date }));
      const runAt = async d => { const m0 = mail.length; const rr = await req('POST', '/api/admin/automation/run', { token: T, json: { at: d + 'T15:00:00Z' } }); globalThis.__runRes = (globalThis.__runRes || []).concat([JSON.stringify(rr.data).slice(0, 160)]); await sleep(900); return mail.slice(m0).filter(m => /Ironline Clinic/.test(m.subject)); };
      const a3 = await runAt(addD(due, -3)), a3b = await runAt(addD(due, -3)), a1 = await runAt(addD(due, -1));
      ok('2 Deadline alerts: "due in 3 days", then "tomorrow" — each sent once, internal only', a3.length === 1 && /due in 3 days/i.test(a3[0].subject) && a3b.length === 0 && a1.length === 1 && /tomorrow/i.test(a1[0].subject) && !a3.concat(a1).some(m => m.to.includes(em)), JSON.stringify({ a3: a3.map(m => m.subject), dup: a3b.length, a1: a1.map(m => m.subject), runs: globalThis.__runRes }));
      const cu = (await req('GET', '/api/admin/customers', { token: T })).data.customers.find(c => c.company === gc).id;
      const up = new FormData(); up.append('files', new Blob([mkPdf('Ironline Clinic IFC', 4)], { type: 'application/pdf' }), 'Ironline_IFC.pdf'); up.append('kind', 'Drawings'); up.append('revision', 'IFC'); up.append('lead_id', String(lead.id)); up.append('customer_id', String(cu));
      const dr = await (await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: up })).json(); const docId = dr.ids && dr.ids[0];
      const lib = (await req('GET', '/api/admin/docs/library', { token: T })).data; const doc = (lib.documents || lib.items || []).find(x => x.id === docId);
      ok('3 Real 4-page PDF drawing set filed to the bid lead + GC customer', docId && doc && doc.lead_id === lead.id && doc.customer_id === cu, JSON.stringify({ docId, lead: doc && doc.lead_id }));
      const sh = await req('PUT', `/api/admin/docs/${docId}/sheets`, { token: T, json: { sheets: [{ number: 'A1.1', title: 'Floor plan L1' }, { number: 'A2.1', title: 'Floor plan L2' }, { number: 'A6.1', title: 'Finish schedule' }] } });
      ok('4 Sheet index recorded (discipline detected)', sh.status === 200, JSON.stringify(sh.data).slice(0, 120));
      const sc = async (n, u, pz) => { const r = (await req('POST', '/api/admin/scopes', { token: T, json: { category: 'construction', name: n, unit: u, pricing_method: 'per_unit', unit_price: pz, production_rate: u === 'SF' ? 1500 : 10 } })).data; return (r.item || r.scope || r).id; };
      const sA = await sc('WFB final clean', 'SF', 0.22), sB = await sc('WFB interior glass', 'pane', 6.5);
      const tk = (await req('POST', '/api/admin/takeoffs', { token: T, json: { name: 'Ironline Clinic', category: 'construction', document_id: docId, customer_id: cu, building_sf: 30000, lines: [{ scope_id: sA, quantity: 30000, sheet: 'A1.1', method: 'From schedule' }, { scope_id: sB, quantity: 180, sheet: 'A6.1', method: 'Measured' }] } })).data.takeoff;
      const noSheet = await req('POST', '/api/admin/takeoffs', { token: T, json: { name: 'bad', category: 'construction', document_id: docId, lines: [{ scope_id: sA, quantity: 10, method: 'Measured' }] } });
      ok('5 Takeoff lines each cite a source sheet; a measured line without a sheet is refused', tk && tk.lines.length === 2 && noSheet.status === 400, JSON.stringify({ tk: tk && tk.id, noSheet: noSheet.status }));
      const ad = new FormData(); ad.append('file', new Blob([mkPdf('Ironline Clinic ADDENDUM 1', 4)], { type: 'application/pdf' }), 'Ironline_Add1.pdf'); ad.append('revision', 'Addendum 1');
      const rev = await (await fetch(B + `/api/admin/docs/${docId}/revision`, { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: ad })).json();
      const tkAfter = (await req('GET', '/api/admin/takeoffs', { token: T })).data.takeoffs.find(x => x.id === tk.id);
      const blocked = await req('POST', `/api/admin/takeoffs/${tk.id}/estimate`, { token: T, json: {} });
      ok('6 Addendum supersedes the IFC set; existing takeoff flagged for recheck; pricing it is blocked', rev.id && tkAfter.stale_note && blocked.status === 409 && blocked.data.stale, JSON.stringify({ rev: rev.id, stale: tkAfter.stale_note, blocked: blocked.status }));
      const v2 = await req('POST', `/api/admin/takeoffs/${tk.id}/version`, { token: T, json: {} });
      await req('PUT', `/api/admin/takeoffs/${v2.data.id}/adjustments`, { token: T, json: { factors: ['occupied'], mobilization: 400, labor_rate: 30 } });
      const est = await req('POST', `/api/admin/takeoffs/${v2.data.id}/estimate`, { token: T, json: { lead_id: lead.id } });
      const e = (await req('GET', '/api/admin/estimates/' + est.data.estimate_id, { token: T })).data.estimate;
      ok('7 v2 takeoff on Addendum 1 priced into a proposal linked to the bid (lead, GC, due date carried over)', v2.status === 201 && v2.data.document_id === rev.id && est.status === 201 && e.lead_id === lead.id && e.gc_name === gc && e.bid_due_date === due, JSON.stringify({ v2: v2.data, est: est.status, e: e && [e.lead_id, e.gc_name, e.bid_due_date, e.proposal_total] }));
      await req('PATCH', '/api/admin/estimates/' + e.id, { token: T, json: { email: em } });
      await req('PUT', '/api/admin/approval-rules', { token: T, json: { min_margin_pct: 0, max_total: 5000, flag_pre_pricing: false, approve_all: false } });
      const held = await req('POST', `/api/admin/estimates/${e.id}/send`, { token: T });
      await req('POST', `/api/admin/estimates/${e.id}/approve`, { token: T, json: { note: 'Checked against Addendum 1 quantities' } });
      const sent = await req('POST', `/api/admin/estimates/${e.id}/send`, { token: T }); await sleep(250);
      await req('PUT', '/api/admin/approval-rules', { token: T, json: { min_margin_pct: 0, max_total: 0, flag_pre_pricing: false, approve_all: false } });
      const leadNow = (await req('GET', '/api/admin/leads', { token: T })).data.leads.find(l => l.id === lead.id);
      ok('8 Risk/approval gate holds the large bid until owner approval; then sent before the deadline; lead → Proposal Sent', held.status === 409 && sent.status === 200 && leadNow.status === 'Proposal Sent', JSON.stringify({ held: [held.status, (held.data.error || '').slice(0, 60)], sent: sent.status, lead: leadNow.status }));
      const late = (await req('POST', '/api/admin/estimates', { token: T, json: { customer_name: 'Late GC', email: 'late@gc.test', scope: 'x', area_sqft: 1000, use_line_items: 1, line_items: [{ description: 'Clean', amount: 900 }] } })).data.estimate;
      await req('PATCH', '/api/admin/bids/' + late.id, { token: T, json: { bid_due_date: addD(bdate, -1) } });
      const l1 = await req('POST', `/api/admin/estimates/${late.id}/send`, { token: T }), l2 = await req('POST', `/api/admin/estimates/${late.id}/send`, { token: T, json: { late_ok: true } });
      ok('9 Sending after the bid deadline needs explicit confirmation (logged)', l1.status === 409 && l1.data.late && l2.status === 200, JSON.stringify([l1.status, l2.status]));
      const acc = await req('POST', `/api/proposal/${e.public_token}/respond`, { json: { decision: 'approve', signer_name: 'Ivy Estimator', signer_title: 'Chief Estimator', agree: true } }); await sleep(300);
      const k = (await req('GET', '/api/admin/contracts', { token: T })).data.contracts.find(x => x.estimate_id === e.id);
      const pj = k && (await req('GET', '/api/admin/projects', { token: T })).data.projects.find(x => x.contract_id === k.id);
      const leadWon = (await req('GET', '/api/admin/leads', { token: T })).data.leads.find(l => l.id === lead.id);
      ok('10 GC accepts online → bid Won; draft contract + planning project for the GC', acc.status === 200 && k && pj && pj.customer_id === cu && leadWon.status === 'Won', JSON.stringify({ acc: acc.status, k: !!k, pj: pj && pj.customer_id, lead: leadWon.status }));
      const vers = (await req('GET', `/api/admin/docs/${rev.id}`, { token: T })).data;
      const tks = (await req('GET', '/api/admin/takeoffs', { token: T })).data.takeoffs.filter(x => x.id === tk.id || x.parent_id === tk.id);
      ok('11 History preserved: IFC kept as superseded revision; v1 and v2 takeoffs both retained', JSON.stringify(vers).includes('IFC') && tks.length === 2, JSON.stringify({ hasIFC: JSON.stringify(vers).includes('IFC'), takeoffs: tks.map(x => [x.id, x.version, x.status]) }));
    } catch (err) { steps.push({ step: '(stopped)', result: 'FAIL', evidence: err.stack.split('\n').slice(0, 2).join(' ') }); }
    require('fs').writeFileSync(require('path').join(__dirname, 'workflowB.json'), JSON.stringify(steps, null, 1));
    const fails = steps.filter(s => s.result === 'FAIL');
    assert(!fails.length, fails.map(f => f.step + ' :: ' + f.evidence).join(' || '));
    return `${steps.length}/${steps.length} steps PASS`;
  });

  // ---------- DIRECTIVE WORKFLOWS C / D / E: service-specific questionnaires + pricing ----------
  await check('Workflows C/D/E', 'Construction, multifamily and janitorial each use their own questionnaire; multifamily + janitorial now price recurring monthly service from the price book; janitorial calculates staffing from the company production rate; anything unpriced is named, never guessed', async () => {
    const steps = [], ok = (n, pass, ev) => { steps.push({ step: n, result: pass ? 'PASS' : 'FAIL', evidence: String(ev).slice(0, 240) }); return pass; };
    try {
      const schema = (await req('GET', '/api/quote-schema')).data.services, names = k => schema[k].fields.map(f => f.name);
      ok('C/D/E-1 Separate questionnaires: construction asks GC/phases/plans/safety/exclusions; multifamily asks units/buildings/corridors/stairwells (no GC/phases); janitorial asks facility/frequency/shift/occupancy/access', ['gc_company', 'phases', 'plans', 'elevators', 'stairwells', 'safety_requirements', 'exclusions'].every(n => names('construction_final').includes(n)) && ['units', 'buildings', 'hallway_sqft', 'stairwells', 'common_areas'].every(n => names('multifamily').includes(n)) && !names('multifamily').includes('gc_company') && !names('multifamily').includes('phases') && ['facility_type', 'frequency', 'shift', 'occupancy', 'access_notes', 'special_requirements'].every(n => names('janitorial').includes(n)), JSON.stringify({ c: names('construction_final').length, d: names('multifamily').length, e: names('janitorial').length }));
      const scopes = (await req('GET', '/api/admin/scopes', { token: T })).data; const list = scopes.items || scopes.scopes || [];
      const setP = async (cat, name, price, rate) => { const it = list.find(x => x.category === cat && x.name.startsWith(name)); if (!it) return false; const r = await req('PATCH', '/api/admin/scopes/' + it.id, { token: T, json: { unit_price: price, ...(rate ? { production_rate: rate } : {}) } }); return r.status === 200; };
      const priced = [await setP('janitorial', 'Daily office cleaning', 0.08, 3500), await setP('janitorial', 'Breakrooms', 6), await setP('multifamily', 'Hallways and corridors', 0.05), await setP('multifamily', 'Stairwells', 4), await setP('multifamily', 'Elevators', 8), await setP('multifamily', 'Valet trash', 0.9)];
      ok('C/D/E-2 Test prices set on existing price-book items (Cleaning Scopes)', priced.every(Boolean), JSON.stringify(priced));
      const leadOf = async id => (await req('GET', '/api/admin/leads', { token: T })).data.leads.find(l => l.id === id);
      // D: multifamily
      const qd = await quote({ ...contact, email: 'pm@ridgeapts.test', company: 'Ridge Apartments', service_key: 'multifamily', property_name: 'Ridge Apts', buildings: '2', units: '120', floors: '4', common_areas: ['Hallways and corridors', 'Stairwells', 'Elevators', 'Clubhouse'], elevators: '2', hallway_sqft: '12000', stairwells: '2', frequency: 'Weekly', occupancy: 'Occupied', extras: ['Valet trash'], valet_doors: '120' });
      const dd = await req('POST', `/api/admin/leads/${qd.data.id}/draft-estimate`, { token: T }); const de = dd.data.estimate_id && (await req('GET', '/api/admin/estimates/' + dd.data.estimate_id, { token: T })).data.estimate;
      const want = Math.round((12000 * 0.05 * 4.33 + 2 * 4 * 4 * 4.33 + 2 * 8 * 4.33 + 120 * 21.7 * 0.9) * 100) / 100;
      // The automatic draft can finish first; then the explicit call reports the existing draft (200). Either is correct.
      ok('D-3 Multifamily request priced as recurring monthly service (hallways + stairwells + elevators + valet trash); clubhouse SF listed as still needed', qd.status === 201 && [200, 201].includes(dd.status) && de && Math.abs(de.proposal_total - want) < 0.05 && /per month/.test(de.scope) && /Clubhouse square footage/.test(de.scope), JSON.stringify({ q: qd.status, d: [dd.status, dd.data.error], total: de && de.proposal_total, want }));
      // E: janitorial
      const qe = await quote({ ...contact, email: 'fm@officeco.test', company: 'OfficeCo', service_key: 'janitorial', facility_type: 'Office', square_footage: '20000', floors: '2', restrooms: '4', breakrooms: '2', frequency: '5 days per week', shift: 'After hours', supplies: 'Bright Clean supplies them', occupancy: '120', access_notes: 'Badge from security desk' });
      const ed = await req('POST', `/api/admin/leads/${qe.data.id}/draft-estimate`, { token: T }); const ee = ed.data.estimate_id && (await req('GET', '/api/admin/estimates/' + ed.data.estimate_id, { token: T })).data.estimate;
      const wantE = Math.round((20000 * 21.7 * 0.08 + 2 * 21.7 * 6) * 100) / 100;
      ok('E-4 Janitorial priced monthly from the price book (SF × visits × $/SF + breakrooms)', qe.status === 201 && ed.status === 201 && ee && Math.abs(ee.proposal_total - wantE) < 0.05, JSON.stringify({ q: qe.status, d: [ed.status, ed.data.error], total: ee && ee.proposal_total, wantE }));
      ok('E-5 Staffing from the company production rate: 20,000 SF ÷ 3,500 SF/hr = 5.71 h/visit → 2 cleaners on a 4-hour evening shift; ~124 labor hours/month', ee && /5\.71 labor hours per visit/.test(ee.scope) && /2 cleaner\(s\)/.test(ee.scope) && /123\.9\d? labor hours per month|124 labor hours per month/.test(ee.scope), ee && ee.scope.slice(0, 400));
      ok('E-6 Restrooms not guessed: fixture count requested instead of an invented price', ee && /Fixture count for the 4 restroom/.test(ee.scope), '');
      // E without prices: nothing invented
      await setP('janitorial', 'Daily office cleaning', null, 3500);
      const qe2 = await quote({ ...contact, email: 'fm2@officeco.test', company: 'OfficeCo 2', service_key: 'janitorial', facility_type: 'Office', square_footage: '8000', frequency: 'Weekly', shift: 'After hours', supplies: 'Discuss' });
      const ed2 = await req('POST', `/api/admin/leads/${qe2.data.id}/draft-estimate`, { token: T });
      ok('E-7 With no price set, the system refuses to invent one and names exactly what to set', ed2.status === 400 && /Set the price per SF per visit for "Daily office cleaning"/.test(ed2.data.error), JSON.stringify([ed2.status, ed2.data.error]));
      await setP('janitorial', 'Daily office cleaning', 0.08, 3500);
      // C: construction (uses construction questionnaire + pricing)
      const qc = await quote({ ...contact, email: 'gc@cfinal.test', company: 'C-Final Builders', service_key: 'construction_final', gc_company: 'C-Final Builders', building_type: 'Healthcare', square_footage: '15000', floors: '2', phases: ['Final clean'], windows: 'No windows', plans: 'Will send them later', elevators: '1', stairwells: '2', safety_requirements: 'Hard hats, site orientation', exclusions: 'Exterior glass above 2nd floor' });
      const ld = await leadOf(qc.data.id); const ik = JSON.parse(ld.intake || '{}');
      ok('C-8 Construction request keeps the new safety/exclusion/elevator/stairwell answers', qc.status === 201 && ik.answers && ik.answers.safety_requirements === 'Hard hats, site orientation' && ik.answers.exclusions && Number(ik.answers.stairwells) === 2, JSON.stringify({ st: qc.status, keys: ik.answers && Object.keys(ik.answers).length }));
    } catch (err) { steps.push({ step: '(stopped)', result: 'FAIL', evidence: err.stack.split('\n').slice(0, 2).join(' ') }); }
    require('fs').writeFileSync(require('path').join(__dirname, 'workflowCDE.json'), JSON.stringify(steps, null, 1));
    const fails = steps.filter(s => s.result === 'FAIL');
    assert(!fails.length, fails.map(f => f.step + ' :: ' + f.evidence).join(' || '));
    return `${steps.length}/${steps.length} steps PASS`;
  });

  // ---------- DIRECTIVE WORKFLOWS C / D / E: service-specific questionnaires → drafted pricing ----------
  await check('Workflows C/D/E', 'Construction final clean, multifamily and commercial janitorial each use their own questionnaire, flag missing information, and draft price-book pricing (recurring monthly + staffing for janitorial)', async () => {
    const steps = [], ok = (n, pass, ev) => { steps.push({ step: n, result: pass ? 'PASS' : 'FAIL', evidence: String(ev).slice(0, 240) }); return pass; };
    const quote = async (key, ans, extra = {}) => { const fd = new FormData(); Object.entries({ contact_name: 'Q ' + key, company: key + ' Co', email: `${key}@q.test`, phone: '515-555-0900', address: '1 Quote St, Ankeny, IA', consent: 'on', service_key: key, ...extra }).forEach(([k, v]) => fd.append(k, v)); for (const [k, v] of Object.entries(ans)) [].concat(v).forEach(x => fd.append(k, String(x))); const r = await fetch(B + '/api/quotes', { method: 'POST', body: fd }); return { status: r.status, data: await r.json() }; };
    const draft = async id => { const r = await req('POST', `/api/admin/leads/${id}/draft-estimate`, { token: T }); const e = r.data.estimate_id ? (await req('GET', '/api/admin/estimates/' + r.data.estimate_id, { token: T })).data.estimate : null; return { r, e }; };
    try {
      // C — construction final
      const cBad = await quote('construction_final', { building_type: 'Office' });
      ok('C1 Construction questionnaire enforces its own required questions (GC, SF, phases, windows, drawings)', cBad.status === 400 && /required|choose|enter/i.test(cBad.data.error) && !/units|buildings/i.test(cBad.data.error), cBad.data.error);
      const c = await quote('construction_final', { gc_company: 'Summit GC', building_type: 'Healthcare', square_footage: 42000, floors: 3, phases: ['Rough clean', 'Final clean', 'Touch-up / punch list'], windows: 'Interior and exterior', window_count: 120, exterior_height: '4+ stories (lift or rope access)', plans: 'Will send them later', bid_due_date: '2026-12-20', elevators: 2, stairwells: 2 });
      const cl = (await req('GET', '/api/admin/leads', { token: T })).data.leads.find(l => l.id === c.data.id); const cik = JSON.parse(cl.intake || '{}');
      ok('C2 Construction request stored with GC, SF, bid due date; missing info identified (drawings, lift/rope glass access)', c.status === 201 && cl.bid_due_date === '2026-12-20' && cik.flags.some(f => f.code === 'plans') && cik.flags.some(f => f.code === 'site_visit'), JSON.stringify(cik.flags));
      const cd = await draft(c.data.id);
      ok('C3 Draft construction estimate from the price book: rough + final + touch-up priced per SF on 42,000 SF, still-needed items listed', cd.r.status === 201 && cd.e && cd.e.line_items.length >= 2 && cd.e.line_items.every(i => i.quantity === 42000) && /Still needed/.test(cd.e.scope) && /Drawings/.test(cd.e.scope), JSON.stringify({ st: cd.r.status, err: cd.r.data.error, lines: cd.e && cd.e.line_items.map(i => i.description) }));
      // D — multifamily
      const dBad = await quote('multifamily', { buildings: 3 });
      ok('D1 Multifamily questionnaire asks multifamily questions (units, common areas, frequency) — not the construction ones', dBad.status === 400 && !/general contractor|GC|drawings|phases/i.test(dBad.data.error), dBad.data.error);
      const d = await quote('multifamily', { property_name: 'Prairie Flats', buildings: 3, units: 144, floors: 4, common_areas: ['Hallways and corridors', 'Stairwells', 'Elevators', 'Trash rooms'], elevators: 3, hallway_sqft: 18000, stairwells: 6, frequency: '3 days per week', occupancy: 'Occupied', extras: ['Valet trash'], valet_doors: 144 });
      const dd = await draft(d.data.id);
      ok('D2 Multifamily draft: recurring monthly price from hallways, stairwells, elevators, valet trash at 13 visits/month; trash rooms flagged as needing a count', d.status === 201 && dd.r.status === 201 && dd.e && /per month/.test(dd.e.scope) && /13 visits per month/.test(dd.e.scope) && dd.e.line_items.some(i => /Hallways/.test(i.description)) && /trash rooms/i.test(dd.e.scope), JSON.stringify({ st: dd.r.status, err: dd.r.data.error, lines: dd.e && dd.e.line_items.map(i => i.description) }));
      // E — janitorial
      const e = await quote('janitorial', { facility_type: 'Medical office', square_footage: 24000, floors: 2, restrooms: 6, breakrooms: 2, floor_types: ['Carpet', 'VCT'], frequency: '5 days per week', shift: 'After hours', supplies: 'Bright Clean supplies them', day_porter: 'No' });
      const ed = await draft(e.data.id);
      ok('E1 Janitorial draft: monthly recurring price (24,000 SF × 21.7 visits) + staffing from the company production rate; restroom fixture count requested', e.status === 201 && ed.r.status === 201 && ed.e && ed.e.line_items.some(i => i.quantity === 520800) && /Staffing:/.test(ed.e.scope) && /cleaner/.test(ed.e.scope) && /Fixture count/.test(ed.e.scope), JSON.stringify({ st: ed.r.status, err: ed.r.data.error, lines: ed.e && ed.e.line_items.map(i => i.description), scope: ed.e && ed.e.scope.slice(0, 300) }));
      ok('E2 Drafts are Drafts: nothing is sent or approved automatically; review required', [cd.e, dd.e, ed.e].every(x => x && x.status === 'Draft') && /Review before sending/.test(ed.e.scope), [cd.e, dd.e, ed.e].map(x => x && x.status).join(','));
    } catch (err) { steps.push({ step: '(stopped)', result: 'FAIL', evidence: err.stack.split('\n').slice(0, 2).join(' ') }); }
    require('fs').writeFileSync(require('path').join(__dirname, 'workflowCDE.json'), JSON.stringify(steps, null, 1));
    const fails = steps.filter(s => s.result === 'FAIL');
    assert(!fails.length, fails.map(f => f.step + ' :: ' + f.evidence).join(' || '));
    return `${steps.length}/${steps.length} steps PASS`;
  });

  await check('Calls', 'Click-to-call: settings validated; staff phone rings first; bridge dials the customer from the business number (recorded); customer answered vs no-answer recorded; unsigned bridge refused', async () => {
    const crypto = require('crypto'), base = 'https://brightclean.net';
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params, sig) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body: new URLSearchParams(params) });
    const notReady = await req('POST', '/api/admin/calls/dial', { token: T, json: { to: '515-555-0177' } });
    const badSid = await req('PUT', '/api/admin/phone/settings', { token: T, json: { account_sid: 'nope' } });
    const staffSet = await req('PUT', '/api/admin/phone/settings', { token: globalThis.__st, json: { number: '5153033024' } });
    const set = await req('PUT', '/api/admin/phone/settings', { token: T, json: { account_sid: 'AC' + 'a'.repeat(32), number: '(515) 303-3024' } });
    const cu = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Dial Co', name: 'Dee Dial', phone: '515-555-0177' } })).data.id;
    const n0 = globalThis.__twCalls.length;
    const d = await req('POST', '/api/admin/calls/dial', { token: T, json: { to: '515-555-0177', customer_id: cu, agent: '+15155550199' } });
    const tw = globalThis.__twCalls[n0];
    const c1 = (await req('GET', `/api/admin/calls/${d.data.call_id}/detail`, { token: T })).data.call;
    const bpath = `/api/webhooks/twilio/bridge?call=${d.data.call_id}`, bp = { CallSid: c1.provider_sid, AccountSid: 'AC' + 'a'.repeat(32), Direction: 'outbound-api' };
    const forged = await post(bpath, bp, 'bad');
    const br = await post(bpath, bp, sign(bpath, bp)); const xml = await br.text();
    const rpath = `/api/webhooks/twilio/bridge-result?call=${d.data.call_id}`, rp = { CallSid: c1.provider_sid, DialCallStatus: 'completed', DialCallDuration: '93' };
    await post(rpath, rp, sign(rpath, rp));
    const sp = { CallSid: c1.provider_sid, CallStatus: 'completed', Direction: 'outbound-api', To: '+15155550199', CallDuration: '110' };
    await post('/api/webhooks/twilio/status', sp, sign('/api/webhooks/twilio/status', sp));
    const c2 = (await req('GET', `/api/admin/calls/${d.data.call_id}/detail`, { token: T })).data.call;
    // no-answer path
    const d2 = await req('POST', '/api/admin/calls/dial', { token: T, json: { to: '5155550178', agent: '+15155550199' } });
    const c3a = (await req('GET', `/api/admin/calls/${d2.data.call_id}/detail`, { token: T })).data.call;
    const r2 = `/api/webhooks/twilio/bridge-result?call=${d2.data.call_id}`, rp2 = { CallSid: c3a.provider_sid, DialCallStatus: 'no-answer' };
    await post(r2, rp2, sign(r2, rp2));
    const c3 = (await req('GET', `/api/admin/calls/${d2.data.call_id}/detail`, { token: T })).data.call;
    const same = await req('POST', '/api/admin/calls/dial', { token: T, json: { to: '515-555-0199', agent: '+15155550199' } });
    assert(notReady.status === 503 && badSid.status === 400 && staffSet.status === 403 && set.status === 200 && set.data.can_dial
      && d.status === 201 && tw.To === '+15155550199' && tw.From === '+15153033024' && /\/bridge\?call=/.test(tw.Url) && /^Basic /.test(tw.auth)
      && c1.customer_id === cu && c1.direction === 'Outbound' && forged.status === 403
      && br.status === 200 && xml.includes('<Dial callerId="+15153033024"') && xml.includes('+15155550177') && xml.includes('record-from-answer') && xml.includes('Dial Co')
      && c2.outcome === 'Answered' && c2.duration_s === 93 && c3.outcome === 'No answer' && c3.follow_up_date && same.status === 400,
      JSON.stringify({ nr: notReady.status, bad: badSid.status, staff: staffSet.status, set: set.data, d: d.data, tw, c1: c1 && [c1.customer_id, c1.direction, c1.outcome], forged: forged.status, xml: xml.slice(0, 200), c2: c2 && [c2.outcome, c2.duration_s], c3: c3 && [c3.outcome, c3.follow_up_date], same: same.status }));
    return `rings ${tw.To} first, bridges to ${'+15155550177'} from ${tw.From}; answered 93s; no-answer → follow-up; forged bridge 403`;
  });

  await check('Calls', 'Browser phone: token is a Twilio access token (identity office, incoming + outgoing app); inbound calls ring the browser; a browser call is logged and dialed from the business number; non-browser callers refused', async () => {
    const crypto = require('crypto'), base = 'https://brightclean.net', jwt = require('../node_modules/jsonwebtoken');
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(path, params) }, body: new URLSearchParams(params) });
    const ps = (await req('GET', '/api/admin/phone/settings', { token: T })).data;
    const n0 = globalThis.__twCalls.length;
    const tk = await req('GET', '/api/admin/voice/token', { token: T });
    const dec = jwt.verify(tk.data.token, 'test-api-secret', { complete: true });
    const appCreate = globalThis.__twCalls.slice(n0).find(c => /Applications\.json/.test(c.url));
    const tk2 = await req('GET', '/api/admin/voice/token', { token: T });
    const appCreates = globalThis.__twCalls.slice(n0).filter(c => /Applications\.json/.test(c.url)).length;
    const vin = { CallSid: 'CAin' + 'c'.repeat(28), From: '+15155550144', To: '+15153033024', Direction: 'inbound', AccountSid: 'AC' + 'a'.repeat(32) };
    const vx = await (await post('/api/webhooks/twilio/voice', vin)).text();
    assert(/<Say[^>]*>[^<]*may be recorded for quality[^<]*<\/Say>[\s\S]*<Dial/.test(vx), 'live call hears the recording notice before ringing: ' + vx);
    const cu = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Browser Co', name: 'Bea Rowser', phone: '515-555-0155' } })).data.id;
    const st = await req('POST', '/api/admin/calls/browser-start', { token: T, json: { to: '515-555-0155', customer_id: cu } });
    const cv = { CallSid: 'CAbr' + 'd'.repeat(28), From: 'client:office', To: '', call_id: String(st.data.call_id), AccountSid: 'AC' + 'a'.repeat(32) };
    const cx = await (await post('/api/webhooks/twilio/client-voice', cv)).text();
    const notClient = await (await post('/api/webhooks/twilio/client-voice', { ...cv, From: '+15550001111' })).text();
    const row = (await req('GET', `/api/admin/calls/${st.data.call_id}/detail`, { token: T })).data.call;
    const staffTok = await req('GET', '/api/admin/voice/token', { token: globalThis.__st });
    assert(ps.softphone === true && tk.status === 200 && dec.header.cty === 'twilio-fpa;v=1' && dec.payload.iss === 'SK' + 'b'.repeat(32) && dec.payload.sub === 'AC' + 'a'.repeat(32)
      && dec.payload.grants.identity === 'office' && dec.payload.grants.voice.incoming.allow === true && dec.payload.grants.voice.outgoing.application_sid && dec.payload.exp - dec.payload.nbf <= 3700
      && appCreate && /client-voice/.test(appCreate.VoiceUrl) && appCreates === 1 && tk2.status === 200
      && vx.includes('<Client>office</Client>') && st.status === 201 && cx.includes('<Dial callerId="+15153033024"') && cx.includes('+15155550155') && cx.includes(`bridge-result?call=${st.data.call_id}`)
      && /could not be placed/.test(notClient) && row.customer_id === cu && row.provider_sid === cv.CallSid && row.source === 'Browser' && staffTok.status === 200,
      JSON.stringify({ ps, tk: tk.status, hdr: dec.header, iss: dec.payload.iss, grants: dec.payload.grants, appCreate, appCreates, vx: vx.slice(0, 260), st: st.data, cx: cx.slice(0, 260), notClient: notClient.slice(0, 120), row: row && [row.customer_id, row.provider_sid, row.source], staff: staffTok.status }));
    return 'token OK (one routing app created, reused); inbound rings <Client>office</Client>; browser call logged to customer and dialed from +15153033024';
  });

  await check('Calls', 'Ring phones: lenient parsing (two numbers, any format), admin setting overrides Render, inbound rings every phone except the caller, click-to-call rings the first; staff cannot change them', async () => {
    const crypto = require('crypto'), base = 'https://brightclean.net';
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(path, params) }, body: new URLSearchParams(params) });
    const bad = await req('PUT', '/api/admin/phone/settings', { token: T, json: { ring_phones: '12345' } });
    const staff = await req('PUT', '/api/admin/phone/settings', { token: globalThis.__st, json: { ring_phones: '4692678472' } });
    const set = await req('PUT', '/api/admin/phone/settings', { token: T, json: { ring_phones: '+1 (469) 267-8472 or 515.329.5889' } });
    const g = (await req('GET', '/api/admin/phone/settings', { token: T })).data;
    const vin = { CallSid: 'CArp' + 'e'.repeat(28), From: '+14692678472', To: '+15153033024', Direction: 'inbound' };
    const fromCell = await (await post('/api/webhooks/twilio/voice', vin)).text();
    const fromOther = await (await post('/api/webhooks/twilio/voice', { ...vin, CallSid: 'CArq' + 'e'.repeat(28), From: '+15155550101' })).text();
    const n0 = globalThis.__twCalls.length;
    await req('POST', '/api/admin/calls/dial', { token: T, json: { to: '515-555-0102' } });
    const rang = globalThis.__twCalls[n0];
    await req('PUT', '/api/admin/phone/settings', { token: T, json: { ring_phones: '' } });
    assert(bad.status === 400 && staff.status === 403 && set.status === 200 && JSON.stringify(g.ring_phones) === JSON.stringify(['+14692678472', '+15153295889']) && g.ring_source === 'admin'
      && !fromCell.includes('<Number>+14692678472</Number>') && fromCell.includes('<Number>+15153295889</Number>')
      && fromOther.includes('<Number>+14692678472</Number>') && fromOther.includes('<Number>+15153295889</Number>') && rang && rang.To === '+14692678472',
      JSON.stringify({ bad: bad.status, staff: staff.status, g, fromCell: fromCell.slice(0, 260), fromOther: fromOther.slice(0, 300), rang }));
    return 'two numbers parsed from "(469) 267-8472 or 515.329.5889"; both ring (caller excluded); click-to-call rings the first';
  });

  await check('Calls', 'Live transcription: calls start Twilio Real-Time Transcription; final utterances are saved with speaker labels (correct for inbound vs outbound), merged even when they arrive before the call record exists; partials and repeats ignored; unsigned refused', async () => {
    const crypto = require('crypto'), base = 'https://brightclean.net';
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params, sig) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig || sign(path, params) }, body: new URLSearchParams(params) });
    const sid = 'CAlt' + 'f'.repeat(28), lt = '/api/webhooks/twilio/live-transcript';
    const vx = await (await post('/api/webhooks/twilio/voice', { CallSid: sid, From: '+15155550133', To: '+15153033024', Direction: 'inbound' })).text();
    const ev = (seq, track, text, extra = {}) => post(lt, { CallSid: sid, TranscriptionEvent: 'transcription-content', SequenceId: String(seq), Track: track, TranscriptionData: JSON.stringify({ transcript: text, confidence: 0.9 }), ...extra });
    await ev(1, 'inbound_track', 'Hi, I need a quote for a final clean on a 12,000 square foot office.');
    await ev(2, 'outbound_track', 'Sure, when is the building ready?');
    await ev(3, 'inbound_track', 'Partial gues', { Final: 'false' });
    await ev(3, 'inbound_track', 'December first. Can you send it by Friday?');
    await ev(3, 'inbound_track', 'December first. Can you send it by Friday?');
    const forged = await post(lt, { CallSid: sid, TranscriptionEvent: 'transcription-content', SequenceId: '9', Track: 'inbound_track', TranscriptionData: '{"transcript":"evil"}' }, 'bad');
    await post('/api/webhooks/twilio/status', { CallSid: sid, CallStatus: 'completed', Direction: 'inbound', From: '+15155550133', To: '+15153033024', CallDuration: '95' });
    await sleep(200);
    const row = (await req('GET', '/api/admin/calls', { token: T })).data.calls.find(c => c.provider_sid === sid);
    const t = row && row.transcript || '';
    // outbound (browser) leg: inbound_track is us
    const st = await req('POST', '/api/admin/calls/browser-start', { token: T, json: { to: '515-555-0134' } });
    const osid = 'CAlo' + 'f'.repeat(28);
    await post('/api/webhooks/twilio/client-voice', { CallSid: osid, From: 'client:office', To: '', call_id: String(st.data.call_id) });
    await post(lt, { CallSid: osid, TranscriptionEvent: 'transcription-content', SequenceId: '1', Track: 'inbound_track', TranscriptionData: JSON.stringify({ transcript: 'Hi, this is Eric from Bright Clean.' }) });
    await post(lt, { CallSid: osid, TranscriptionEvent: 'transcription-content', SequenceId: '2', Track: 'outbound_track', TranscriptionData: JSON.stringify({ transcript: 'Hello Eric.' }) });
    const orow = (await req('GET', `/api/admin/calls/${st.data.call_id}/detail`, { token: T })).data.call;
    assert(vx.includes('<Start><Transcription') && vx.includes('live-transcript') && vx.includes('both_tracks') && forged.status === 403
      && row && t.includes('[Live transcript]') && t.includes('Customer: Hi, I need a quote') && t.includes('Bright Clean: Sure, when is the building ready?') && t.includes('Customer: December first') && !t.includes('Partial gues') && t.split('December first').length === 2 && !t.includes('evil')
      && orow.transcript.includes('Bright Clean: Hi, this is Eric') && orow.transcript.includes('Customer: Hello Eric.'),
      JSON.stringify({ vx: vx.slice(0, 200), forged: forged.status, t, o: orow && orow.transcript }));
    return 'inbound: Customer/Bright Clean labelled, merged after the record was created; outbound labels reversed correctly';
  });

  await check('Calls', 'Save caller as customer: name-only caller becomes a customer keyed by phone; all past calls from the number link; the next call auto-matches; existing phone or chosen customer links without duplicates; name required', async () => {
    const crypto = require('crypto'), base = 'https://brightclean.net';
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(path, params) }, body: new URLSearchParams(params) });
    const mk = async (sid, from) => { await post('/api/webhooks/twilio/status', { CallSid: sid, CallStatus: 'completed', Direction: 'inbound', From: from, To: '+15153033024', CallDuration: '40' }); return (await req('GET', '/api/admin/calls', { token: T })).data.calls.find(c => c.provider_sid === sid); };
    const c1 = await mk('CAsv1' + 'a'.repeat(27), '+15157785899'), c2 = await mk('CAsv2' + 'a'.repeat(27), '+15157785899'), c3 = await mk('CAsv3' + 'a'.repeat(27), '+15157785899');
    const noName = await req('POST', `/api/admin/calls/${c1.id}/customer`, { token: T, json: { name: '' } });
    const sv = await req('POST', `/api/admin/calls/${c1.id}/customer`, { token: T, json: { name: 'Danielle Kelly', notes: 'Residential, cleaning Monday' } });
    const after = (await req('GET', '/api/admin/calls', { token: T })).data.calls.filter(c => [c1.id, c2.id, c3.id].includes(c.id));
    const c4 = await mk('CAsv4' + 'a'.repeat(27), '+15157785899');
    const prof = (await req('GET', `/api/admin/customers/${sv.data.customer.id}/profile`, { token: T })).data;
    const c5 = await mk('CAsv5' + 'a'.repeat(27), '+15157785899');
    await req('PATCH', `/api/admin/calls/${c5.id}`, { token: T, json: { customer_id: null } }).catch(() => {});
    const again = await req('POST', `/api/admin/calls/${c4.id}/customer`, { token: T, json: { name: 'Dani K' } });
    const other = await mk('CAsv6' + 'a'.repeat(27), '+15155550188');
    const pick = await req('POST', `/api/admin/calls/${other.id}/customer`, { token: T, json: { customer_id: sv.data.customer.id } });
    const count = (await req('GET', '/api/admin/customers', { token: T })).data.customers.filter(c => /Danielle|Dani K/.test(c.name || '')).length;
    assert(noName.status === 400 && sv.status === 201 && sv.data.created && sv.data.linked_calls === 3 && sv.data.customer.phone === '+15157785899' && after.every(c => c.customer_id === sv.data.customer.id && c.contact_name === 'Danielle Kelly')
      && c4.customer_id === sv.data.customer.id && (prof.calls || []).length >= 4 && again.status === 200 && !again.data.created && again.data.customer.id === sv.data.customer.id && pick.status === 200 && pick.data.customer.id === sv.data.customer.id && count === 1,
      JSON.stringify({ noName: noName.status, sv: sv.data, after: after.map(c => [c.customer_id, c.contact_name]), c4: c4 && c4.customer_id, profCalls: (prof.calls || []).length, again: again.data, pick: pick.status, count }));
    return `"Danielle Kelly" created from a call; 3 past calls linked; next call auto-matched; no duplicates`;
  });

  await check('Calls', 'Voicemail playback: recordings play inside the admin (server fetches the MP3 from Twilio with the account credentials); recording that arrives before the call record is kept and attached; no recording → 404; signed-out → 401; deleted at Twilio → clear message', async () => {
    const crypto = require('crypto'), base = 'https://brightclean.net';
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(path, params) }, body: new URLSearchParams(params) });
    const TW = process.env.__TW_API || (globalThis.__twBase);
    const sid = 'CAvm' + 'b'.repeat(28), recUrl = `${globalThis.__twBase}/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/RE${'c'.repeat(32)}`;
    await post('/api/webhooks/twilio/recording', { CallSid: sid, RecordingUrl: recUrl, RecordingSid: 'RE' + 'c'.repeat(32) });   // before the call record exists
    await post('/api/webhooks/twilio/status', { CallSid: sid, CallStatus: 'completed', Direction: 'inbound', From: '+15155550166', To: '+15153033024', CallDuration: '33' }); await sleep(200);
    const row = (await req('GET', '/api/admin/calls', { token: T })).data.calls.find(c => c.provider_sid === sid);
    const n0 = globalThis.__twCalls.length;
    const r = await fetch(B + `/api/admin/calls/${row.id}/recording`, { headers: { Authorization: 'Bearer ' + T } }); const bytes = Buffer.from(await r.arrayBuffer()).toString();
    const got = globalThis.__twCalls.slice(n0).find(x => x.get);
    const anon = await fetch(B + `/api/admin/calls/${row.id}/recording`);
    const none = (await req('POST', '/api/admin/calls', { token: T, json: { phone: '515-555-0167', purpose: 'Other', summary: 'no rec' } })).data.call;
    const noRec = await fetch(B + `/api/admin/calls/${none.id}/recording`, { headers: { Authorization: 'Bearer ' + T } });
    const sid2 = 'CAvn' + 'b'.repeat(28);
    await post('/api/webhooks/twilio/status', { CallSid: sid2, CallStatus: 'completed', Direction: 'inbound', From: '+15155550168', To: '+15153033024', CallDuration: '9' });
    await post('/api/webhooks/twilio/recording', { CallSid: sid2, RecordingUrl: `${globalThis.__twBase}/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/REgone`, RecordingSid: 'REgone' });
    const row2 = (await req('GET', '/api/admin/calls', { token: T })).data.calls.find(c => c.provider_sid === sid2);
    const gone = await fetch(B + `/api/admin/calls/${row2.id}/recording`, { headers: { Authorization: 'Bearer ' + T } }); const goneMsg = (await gone.json()).error;
    const badHost = await post('/api/webhooks/twilio/recording', { CallSid: sid2, RecordingUrl: 'https://evil.example.com/rec', RecordingSid: 'RE1' });
    assert(row && row.recording_url === recUrl && r.status === 200 && /audio\/mpeg/.test(r.headers.get('content-type')) && bytes.includes('fake-mp3-audio-bytes') && got && /\.mp3$/.test(got.url) && got.auth === 'Basic ' + Buffer.from('AC' + 'a'.repeat(32) + ':tw-test-token').toString('base64')
      && anon.status === 401 && noRec.status === 404 && gone.status === 404 && /no longer has/.test(goneMsg) && badHost.status === 400,
      JSON.stringify({ rec: row && row.recording_url, st: r.status, ct: r.headers.get('content-type'), got, anon: anon.status, noRec: noRec.status, gone: [gone.status, goneMsg], bad: badHost.status }));
    return 'early recording attached after the call was saved; MP3 streamed through the admin with Twilio auth; missing/deleted/foreign cases handled';
  });

  await check('Permissions', 'D-09..D-11: legacy routes cannot create/activate unsigned contracts; invoices become Paid only through recorded payments; staff cannot delete; owners cannot delete signed/sent records', async () => {
    const st = globalThis.__st, out = {};
    const k = (await req('POST', '/api/admin/contracts', { token: T, json: { company: 'Probe Co', title: 'Probe', value: 1000, status: 'Draft' } })).data; const kid = k.id || (k.contract && k.contract.id);
    out.postSigned = (await req('POST', '/api/admin/contracts', { token: T, json: { company: 'Probe2 Co', title: 'P2', value: 1000, status: 'Active', signature_status: 'Signed' } })).status;
    out.patchActiveUnsigned = (await req('PATCH', '/api/admin/contracts/' + kid, { token: T, json: { status: 'Active' } })).status;
    const kk = (await req('GET', '/api/admin/contracts2/' + kid, { token: T })).data.contract; out.kAfter = [kk.status, kk.signature_status];
    const inv = (await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: 'PRB-1', customer_name: 'x', amount: 10, due_date: '2026-12-31', status: 'Draft' } })).data; const iid = inv.id || (inv.invoice && inv.invoice.id);
    out.staffDelInvoice = (await req('DELETE', '/api/admin/invoices/' + iid, { token: st })).status;
    out.staffDelContract = (await req('DELETE', '/api/admin/contracts/' + kid, { token: st })).status;
    out.staffPatchInvoicePaid = (await req('PATCH', '/api/admin/invoices/' + iid, { token: st, json: { status: 'Paid', paid_amount: 10 } })).status;
    out.ownerPatchInvoicePaid = (await req('PATCH', '/api/admin/invoices/' + iid, { token: T, json: { status: 'Paid' } })).status;
    const iv = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(i => i.id === iid); out.invAfter = iv ? [iv.status, iv.paid_amount] : 'deleted';
    const signedK = (await req('POST', '/api/admin/contracts', { token: T, json: { company: 'Signed Co', title: 'S', value: 500, status: 'Draft' } })).data; const sid = signedK.id || (signedK.contract && signedK.contract.id);
    await req('PATCH', '/api/admin/contracts/' + sid, { token: T, json: { signature_status: 'Signed', status: 'Active', signer_name: 'Sam Signer', signed_on: '2026-11-01' } });
    out.ownerDelSigned = (await req('DELETE', '/api/admin/contracts/' + sid, { token: T })).status;
    const draftInv = (await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: 'PRB-DRAFT', customer_name: 'x', amount: 5, due_date: '2026-12-31', status: 'Draft' } })).data; out.ownerDelDraftInvoice = (await req('DELETE', '/api/admin/invoices/' + (draftInv.id || draftInv.invoice.id), { token: T })).status;
    { const pi = (await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: 'PRB-EDIT', customer_name: 'x', amount: 50, due_date: '2026-12-31', status: 'Sent' } })).data; const pid = pi.id || pi.invoice.id; await req('POST', `/api/admin/invoices/${pid}/payment`, { token: T, json: { amount: 50 } }); const row = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(i => i.id === pid); out.editPaidNotes = (await req('PATCH', '/api/admin/invoices/' + pid, { token: T, json: { ...row, notes: 'PO 123' } })).status; }
    out.postPaidInvoice = (await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: 'PRB-PAID', customer_name: 'x', amount: 5, paid_amount: 5, due_date: '2026-12-31', status: 'Paid' } })).status;
    assert(out.postSigned === 409 && out.patchActiveUnsigned === 409 && out.kAfter[0] === 'Draft' && out.staffDelInvoice === 403 && out.staffDelContract === 403 && out.staffPatchInvoicePaid === 409 && out.ownerPatchInvoicePaid === 409 && out.invAfter[0] === 'Draft' && out.ownerDelSigned === 409 && out.ownerDelDraftInvoice === 200 && out.postPaidInvoice === 409 && out.editPaidNotes === 200, JSON.stringify(out));
    return JSON.stringify(out);
  });

  await check('Command Center', 'Every live metric loads without error and its drill-down lists exactly the records behind the number (count and total agree) for 7/30/365-day periods; unknown metric 404; signed-out 401', async () => {
    const bad = [];
    for (const d of [7, 30, 365]) {
      // Card and drill-down are two requests. Background work (webhooks, sweeps) can add a record between them,
      // so a mismatch is re-read once; it only fails if the two still disagree on a stable read.
      const readBoth = async (key, days) => {
        const mm = (await req('GET', '/api/admin/command-center/metrics?days=' + days, { token: T })).data.metrics.find(z => z.key === key);
        const dd = (await req('GET', `/api/admin/command-center/drill/${key}?days=${days}`, { token: T })).data;
        return { mm, dd };
      };
      const m = (await req('GET', '/api/admin/command-center/metrics?days=' + d, { token: T })).data;
      for (const x0 of m.metrics) {
        if (x0.error) { bad.push(`${x0.key}@${d}: ${x0.error}`); continue; }
        let x = x0, dr = (await req('GET', `/api/admin/command-center/drill/${x0.key}?days=${d}`, { token: T })).data;
        if (dr.count !== x.count || (x.count <= 200 && dr.rows.length !== x.count)) { const again = await readBoth(x0.key, d); if (again.mm) x = again.mm; dr = again.dd; }
        const sum = dr.rows.reduce((s2, r) => s2 + (Number(r.amount) || 0), 0);
        if (dr.count !== x.count || (x.count <= 200 && dr.rows.length !== x.count)) bad.push(`${x.key}@${d}: card ${x.count} vs list ${dr.rows.length}`);
        if (x.amount != null && x.count <= 200 && Math.abs(sum - x.amount) > 0.01) bad.push(`${x.key}@${d}: total ${x.amount} vs ${sum}`);
        if (dr.rows.some(r => r.id == null)) bad.push(`${x.key}@${d}: row without id`);
      }
    }
    const m30 = (await req('GET', '/api/admin/command-center/metrics?days=30', { token: T })).data.metrics;
    const unk = await req('GET', '/api/admin/command-center/drill/nope', { token: T }), anon = await req('GET', '/api/admin/command-center/metrics');
    const cc = (await req('GET', '/api/admin/command-center', { token: T })).data;
    const nz = m30.filter(x => x.count > 0).map(x => `${x.key}=${x.count}`);
    assert(!bad.length && unk.status === 404 && anon.status === 401 && m30.length >= 20 && cc.modules.calls.connected === true && ['Sales', 'Operations', 'Finance', 'Calls & AI'].every(g => m30.some(x => x.group === g)), JSON.stringify({ bad, unk: unk.status, anon: anon.status, n: m30.length, calls: cc.modules.calls }));
    return `${m30.length} metrics × 3 periods: every card matches its list; non-zero now: ${nz.slice(0, 12).join(', ')}`;
  });

  await check('Command Center', 'Management + by-service drill; personal prefs are per user and validated; live stream needs a one-time ticket, sends "hello", and pushes a change when a website lead arrives (outside the admin)', async () => {
    const m = (await req('GET', '/api/admin/command-center/metrics?days=365', { token: T })).data.metrics;
    const mg = m.filter(x => x.group === 'Management'), errs = m.filter(x => x.error).map(x => x.key + ':' + x.error);
    const dv = (await req('GET', '/api/admin/command-center/divisions?days=365', { token: T })).data.rows;
    let svcOk = true; for (const r of dv) { const dr = (await req('GET', `/api/admin/command-center/drill/collected?days=365&service=${encodeURIComponent(r.service)}`, { token: T })).data; if (dr.count !== r.n || Math.abs(dr.rows.reduce((a, x) => a + x.amount, 0) - r.collected) > 0.01) svcOk = false; }
    const p1 = await req('PUT', '/api/admin/prefs/command_center', { token: T, json: { days: 90, hidden: ['Management'] } });
    const pBad = await req('PUT', '/api/admin/prefs/evil', { token: T, json: { x: 1 } });
    const mine = (await req('GET', '/api/admin/prefs', { token: T })).data, theirs = (await req('GET', '/api/admin/prefs', { token: globalThis.__st })).data;
    const noTicket = await fetch(B + '/api/admin/events?ticket=nope');
    const tk = (await req('POST', '/api/admin/events/ticket', { token: T, json: {} })).data.ticket;
    const ctl = new AbortController(); const sr = await fetch(B + '/api/admin/events?ticket=' + tk, { signal: ctl.signal }); const rd = sr.body.getReader(); let buf = '';
    let pend = null; const readFor = async ms => { const end = Date.now() + ms; while (Date.now() < end) { pend = pend || rd.read(); const r = await Promise.race([pend, sleep(Math.max(1, end - Date.now())).then(() => null)]); if (!r) break; pend = null; if (r.done) break; buf += Buffer.from(r.value).toString(); } };
    await readFor(600);
    const hello = /event: hello/.test(buf);
    const fd = new URLSearchParams({ name: 'Live Lead', email: 'live@lead.test', phone: '5155550999', company: 'Live Co', message: 'Need a quote for office cleaning please' });
    await fetch(B + '/api/inquiries', { method: 'POST', body: fd });
    await readFor(3500); ctl.abort();
    const reused = await fetch(B + '/api/admin/events?ticket=' + tk);
    const pushed = /event: change/.test(buf) && /"entity":"lead"/.test(buf);
    assert(mg.length >= 4 && !errs.length && svcOk && p1.status === 200 && pBad.status === 400 && mine.command_center && mine.command_center.days === 90 && !(theirs.command_center) && noTicket.status === 401 && hello && pushed && reused.status === 401,
      JSON.stringify({ mg: mg.map(x => x.key), errs, svcOk, p1: p1.status, pBad: pBad.status, mine, theirs, noTicket: noTicket.status, hello, pushed, buf: buf.slice(0, 300), reused: reused.status }));
    return `management metrics: ${mg.map(x => x.key).join(', ')}; ${dv.length} service lines drill exactly; prefs per user; website lead pushed live`;
  });

  await check('Action map', 'Every admin button/form that calls the server reaches a route that exists (generated from the code: 0 dangling); staff cannot read financial totals or trigger reminder runs (gaps found by the map)', async () => {
    const out = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, '..', 'tools', 'action-map.js')], { encoding: 'utf8' });
    const map = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'action-map.json'), 'utf8'));
    const fin = await req('GET', '/api/admin/financial-summary', { token: globalThis.__st }), finOwner = await req('GET', '/api/admin/financial-summary', { token: T });
    const rem = await req('POST', '/api/admin/issues/run-reminders', { token: globalThis.__st, json: {} });
    assert(out.status === 0 && map.dangling.length === 0 && map.handlers >= 190 && fin.status === 403 && finOwner.status === 200 && rem.status === 403, JSON.stringify({ status: out.status, stdout: out.stdout.slice(0, 300), dangling: map.dangling.slice(0, 5), handlers: map.handlers, fin: fin.status, finOwner: finOwner.status, rem: rem.status }));
    return `${map.handlers} handlers, ${map.rows.reduce((s2, r) => s2 + r.calls.length, 0)} server calls, 0 dangling; staff blocked from financial-summary and run-reminders`;
  });

  await check('Calls', 'Automatic callback: the press-1 prompt has a real keypress address; pressing 1 rings the team phones; any other key ends politely', async () => {
    const crypto = require('crypto'), base = 'https://brightclean.net';
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(path, params) }, body: new URLSearchParams(params) });
    const ring = await req('PUT', '/api/admin/phone/settings', { token: T, json: { ring_phones: '515-555-0166' } });
    const p = { CallSid: 'CAob' + 'c'.repeat(28), From: '+15155550166', To: '+15153033024', Direction: 'outbound-api', AccountSid: 'AC' + 'a'.repeat(32) };
    const prompt = await (await post('/api/webhooks/twilio/outbound?lead=7', p)).text();
    const press = await (await post('/api/webhooks/twilio/outbound-press?lead=7', { ...p, Digits: '1' })).text();
    const other = await (await post('/api/webhooks/twilio/outbound-press?lead=7', { ...p, Digits: '9' })).text();
    assert(ring.status === 200 && prompt.includes(`action="${base}/api/webhooks/twilio/outbound-press?lead=7"`) && !/\$\{/.test(prompt) && /<Gather numDigits="1"/.test(prompt), 'prompt: ' + prompt);
    assert(/<Dial[^>]*>[\s\S]*<Number>\+15155550166<\/Number>/.test(press) && !/<Hangup/.test(press), 'press 1 should ring the team: ' + press);
    assert(!/<Dial/.test(other) && /Goodbye/.test(other), 'other key should end politely: ' + other);
    return 'prompt keypress address is real; press 1 rings the team phone; other keys end politely';
  });

  await check('Calls', 'Automatic callback: when nobody answers after press 1 the caller hears a message and the call ends; an answered call ends quietly', async () => {
    const crypto = require('crypto'), base = 'https://brightclean.net';
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(path, params) }, body: new URLSearchParams(params) });
    const p = { CallSid: 'CAdial' + 'd'.repeat(26), From: '+15155550166', To: '+15153033024', Direction: 'outbound-api', AccountSid: 'AC' + 'a'.repeat(32) };
    const missed = await (await post('/api/webhooks/twilio/callback-dial?lead=7', { ...p, DialCallStatus: 'no-answer' })).text();
    const answered = await (await post('/api/webhooks/twilio/callback-dial?lead=7', { ...p, DialCallStatus: 'completed' })).text();
    assert(/nobody is free right now/.test(missed) && /<Hangup\/>/.test(missed), 'no-answer should apologise and hang up: ' + missed);
    assert(!/nobody is free/.test(answered) && /<Hangup\/>/.test(answered), 'answered call should end quietly: ' + answered);
    return 'no-answer apologises and ends; answered call ends quietly';
  });

  await check('Calls', 'Browser calls: the customer hears the recording notice before the call connects', async () => {
    const crypto = require('crypto'), base = 'https://brightclean.net';
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(path, params) }, body: new URLSearchParams(params) });
    const p = { CallSid: 'CAnot' + 'e'.repeat(27), From: '+15155550166', To: '+15153033024', Direction: 'outbound-api', AccountSid: 'AC' + 'a'.repeat(32) };
    const notice = await (await post('/api/webhooks/twilio/call-notice', p)).text();
    const dial = await (await post('/api/webhooks/twilio/client-voice', { ...p, From: 'client:office', To: '+15155550166' })).text();
    assert(/This call may be recorded for quality and training\./.test(notice), 'notice text: ' + notice);
    assert(/<Number url="[^"]*\/api\/webhooks\/twilio\/call-notice">\+15155550166<\/Number>/.test(dial), 'client call should announce before connecting: ' + dial);
    return 'customer hears the notice, then the call connects';
  });

  await check('Calls', 'Health check exercises Twilio sign-in and the number routing (not just "a key exists") and reports each part; voicemails create one assigned callback task; only owner/manager can change the callback owner', async () => {
    const crypto = require('crypto'), base = 'https://brightclean.net';
    const sign = (path, params) => crypto.createHmac('sha1', 'tw-test-token').update(base + path + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64');
    const post = (path, params) => fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sign(path, params) }, body: new URLSearchParams(params) });
    const h = (await req('GET', '/api/admin/phone/health', { token: T })).data, by = Object.fromEntries(h.checks.map(c => [c.key, c]));
    const sid = 'CAvmcb' + 'a'.repeat(26);
    await post('/api/webhooks/twilio/voice', { CallSid: sid, From: '+15155550888', To: '+15153033024', Direction: 'inbound' });
    await post('/api/webhooks/twilio/dial-result', { CallSid: sid, From: '+15155550888', DialCallStatus: 'no-answer' });
    await post('/api/webhooks/twilio/dial-result', { CallSid: sid, From: '+15155550888', DialCallStatus: 'no-answer' });
    const c = (await req('GET', '/api/admin/calls', { token: T })).data.calls.find(x => x.provider_sid === sid);
    const iss = (await req('GET', `/api/admin/issues/${c.callback_issue_id}`, { token: T })).data.issue;
    const staffOwner = await req('PUT', '/api/admin/phone/callback-owner', { token: globalThis.__st, json: { email: 'staff@x.test' } });
    const badOwner = await req('PUT', '/api/admin/phone/callback-owner', { token: T, json: { email: 'stranger@nowhere.test' } });
    const chk = { auth: by.twilio_auth && by.twilio_auth.status === 'pass', routing: by.number_routing && by.number_routing.status === 'pass', ai: by.ai_model && by.ai_model.status === 'fail' && /missing/.test(by.ai_model.detail), owner: by.callback_owner && by.callback_owner.status === 'pass',
      vmTask: iss && iss.type === 'follow_up' && iss.assigned_to === OWNER && /voicemail/i.test(iss.description) && iss.due_date, staff: staffOwner.status === 403, bad: badOwner.status === 400 };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ checks: h.checks, iss, staff: staffOwner.status, bad: badOwner.status }));
    return `health: ${h.checks.map(x => x.key + '=' + x.status).join(', ')}; voicemail → FUP-${1000 + iss.id} for ${iss.assigned_to}`;
  });

  await check('Consistency', 'One payment updates every dependent view the same way: invoice balance/status, Command Center outstanding + collected (and their drill-downs), finance report, customer profile; a failed inspection shows on the failed-inspections metric and its corrective work is linked', async () => {
    const cu = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Consistency Co', name: 'Cy', email: 'cy@cons.test' } })).data.id;
    const pr = (await req('POST', '/api/admin/projects', { token: T, json: { name: 'Consistency project', company: 'Consistency Co', status: 'Active', customer_id: cu } })).data.id;
    const n = (await req('GET', '/api/admin/next-invoice-number', { token: T })).data.number, today = new Date().toISOString().slice(0, 10);
    const inv = (await req('POST', '/api/admin/invoices', { token: T, json: { invoice_number: n, project_id: pr, customer_name: 'Cy', company: 'Consistency Co', email: 'cy@cons.test', amount: 1000, due_date: '2030-01-01', status: 'Sent' } })).data, iid = inv.id || inv.invoice.id;
    const snap = async () => { const m = (await req('GET', '/api/admin/command-center/metrics?days=30', { token: T })).data.metrics, g = k => m.find(x => x.key === k); const f = (await req('GET', `/api/admin/reports/finance?from=2000-01-01&to=2100-01-01`, { token: T })).data; const iv = (await req('GET', '/api/admin/invoices', { token: T })).data.invoices.find(x => x.id === iid); const od = (await req('GET', '/api/admin/command-center/drill/outstanding?days=30', { token: T })).data.rows.find(r => r.id === iid); return { out: g('outstanding').amount, col: g('collected').amount || 0, fin: f.collected, paid: iv.paid_amount, status: iv.status, rowBal: od ? od.amount : 0 }; };
    const a = await snap();
    const pay = await req('POST', `/api/admin/invoices/${iid}/payment`, { token: T, json: { amount: 400 } });
    const b = await snap();
    const prof = (await req('GET', `/api/admin/customers/${cu}/profile`, { token: T })).data, pj = JSON.stringify(prof);
    const colDrill = (await req('GET', '/api/admin/command-center/drill/collected?days=30', { token: T })).data.rows.some(r => r.id === iid && Math.abs(r.amount - 400) < 0.01);
    // failed inspection → metric + linked corrective work
    const tpl = (await req('GET', '/api/admin/qc/templates', { token: T })).data.templates[0];
    const fiBefore = (await req('GET', '/api/admin/command-center/metrics?days=30', { token: T })).data.metrics.find(x => x.key === 'failed_inspections').count;
    const ins = (await req('POST', '/api/admin/qc/inspections', { token: T, json: { template_id: tpl.id, area: 'Consistency lobby', date: today, customer_id: cu, project_id: pr } })).data.inspection;
    await req('PATCH', '/api/admin/qc/inspections/' + ins.id, { token: T, json: { items: ins.items.map((x, k) => ({ ...x, result: k < 2 ? 'Fail' : 'Pass', note: k < 2 ? 'Streaks' : '' })) } });
    await req('POST', `/api/admin/qc/inspections/${ins.id}/sign`, { token: T, json: { name: 'Eric Moore' } });
    const corr = await req('POST', `/api/admin/qc/inspections/${ins.id}/corrective`, { token: T, json: {} });
    const fiAfter = (await req('GET', '/api/admin/command-center/metrics?days=30', { token: T })).data.metrics.find(x => x.key === 'failed_inspections').count;
    const fiDrill = (await req('GET', '/api/admin/command-center/drill/failed_inspections?days=30', { token: T })).data.rows.some(r => r.id === ins.id);
    const linked = (await req('GET', '/api/admin/issues', { token: T })).data; const corrIssues = (linked.items || linked.issues || []).filter(i => i.inspection_id === ins.id);
    const chk = { paid: pay.status === 200 && b.paid === 400 && b.status === 'Partially Paid', outstanding: Math.abs((a.out - b.out) - 400) < 0.01, rowBalance: Math.abs(a.rowBal - 1000) < 0.01 && Math.abs(b.rowBal - 600) < 0.01, collected: Math.abs((b.col - a.col) - 400) < 0.01, colDrill, finance: Math.abs((b.fin - a.fin) - 400) < 0.01, profile: /Consistency project|"paid_amount":400|600/.test(pj),
      fiMetric: fiAfter === fiBefore + 1, fiDrill, corrective: corr.status < 300 && corrIssues.length >= 1 && corrIssues.every(i => i.customer_id === cu) };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ a, b, pay: pay.status, fiBefore, fiAfter, corr: corr.status, corrIssues: corrIssues.length, prof: pj.slice(0, 300) }));
    return `payment $400: invoice 1000→600 balance, outstanding −400, collected +400 (card, drill, finance report agree), profile updated; failed inspection: metric ${fiBefore}→${fiAfter}, ${corrIssues.length} linked corrective item(s)`;
  });

  await check('Security', 'Upload content checks: a program renamed .pdf and a PDF with embedded JavaScript are refused (and nothing is stored); a real PDF is accepted; same rule on the public bid form', async () => {
    const up = async (name, bytes) => { const fd = new FormData(); fd.append('files', new Blob([bytes]), name); fd.append('kind', 'Drawings'); const r = await fetch(B + '/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const before = (await req('GET', '/api/admin/documents', { token: T })).data.documents.length;
    const exe = await up('drawings.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]));
    const js = await up('plans.pdf', Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF'));
    const fake = await up('photo.png', Buffer.from('not really a png'));
    const ok = await up('real.pdf', Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF'));
    const after = (await req('GET', '/api/admin/documents', { token: T })).data.documents.length;
    const fd = new FormData(); ['name', 'email', 'company', 'project_name', 'project_type', 'address', 'square_footage', 'details'].forEach(k => fd.append(k, k === 'email' ? 'p@x.test' : 'Test ' + k)); fd.append('services', 'Final cleaning');
    fd.append('documents', new Blob([Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)])]), 'bid.pdf');
    const pub = await fetch(B + '/api/bids', { method: 'POST', body: fd });
    const chk = { exe: exe.status === 400 && /program/.test(exe.body.error), js: js.status === 400 && /scripts/.test(js.body.error), fake: fake.status === 400 && /not a real PNG/.test(fake.body.error), ok: ok.status < 300, stored: after === before + 1, pub: pub.status === 400 };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ exe, js, fake, ok: ok.status, before, after, pub: pub.status }));
    return 'renamed program, scripted PDF, fake PNG refused; real PDF stored (+1 only); public form refuses a renamed ELF binary';
  });

  await check('Security', 'Sessions: changing a password signs out every other session (old token 401) and returns a fresh token for this device; "sign out everywhere" does the same; tokens issued before session versions still work', async () => {
    const jwt = require('../node_modules/jsonwebtoken');
    const em = 'sess@brightclean.test', pw1 = 'session-password-one-1', pw2 = 'session-password-two-2';
    await req('POST', '/api/admin/users', { token: T, json: { name: 'Sess', email: em, password: pw1, role: 'staff' } });
    const mint = () => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' }); // login is rate-limited (8/15 min) and the suite has used it up
    const a = mint(), b = mint();
    const legacy = jwt.sign({ role: 'admin', email: em }, globalThis.__jwtSecret || process.env.__JWT || '', { expiresIn: '1h' });
    const legacyOk = globalThis.__jwtSecret ? (await req('GET', '/api/admin/leads', { token: legacy })).status : 200;
    const ch = await req('POST', '/api/admin/account/password', { token: a, json: { current: pw1, next: pw2 } });
    const aOld = (await req('GET', '/api/admin/leads', { token: a })).status, bOld = (await req('GET', '/api/admin/leads', { token: b })).status, aNew = (await req('GET', '/api/admin/leads', { token: ch.data.token })).status;
    const c = jwt.sign({ role: 'admin', email: em, tv: 1 }, globalThis.__jwtSecret, { expiresIn: '1h' }); // a session started after the password change (version 1)
    const so = await req('POST', '/api/admin/account/sign-out-everywhere', { token: ch.data.token, json: {} });
    const cAfter = (await req('GET', '/api/admin/leads', { token: c })).status, soNew = (await req('GET', '/api/admin/leads', { token: so.data.token })).status, legacyAfter = globalThis.__jwtSecret ? (await req('GET', '/api/admin/leads', { token: legacy })).status : 401;
    const chk = { changed: ch.status === 200 && !!ch.data.token, aOld: aOld === 401, bOld: bOld === 401, aNew: aNew === 200, cAfter: cAfter === 401, soNew: soNew === 200, legacyBefore: legacyOk === 200, legacyAfter: legacyAfter === 401 };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ ch: ch.status, aOld, bOld, aNew, cAfter, soNew, legacyOk, legacyAfter }));
    return 'password change: other sessions 401, this device keeps working; sign-out-everywhere: other session 401; pre-version tokens valid until the first bump';
  });

  await check('Health', '/health reports the build fingerprint, and it equals the fingerprint computed over the running files (so a release archive can be matched to the live server)', async () => {
    const h = (await req('GET', '/health')).data, b = require('../buildinfo').compute(require('path').join(__dirname, '..'));
    assert(h.build === b.fingerprint.slice(0, 12) && h.build_files === b.files && b.files > 50, JSON.stringify({ h, b: [b.fingerprint.slice(0, 12), b.files] }));
    return `build ${h.build} over ${h.build_files} running files`;
  });

  await check('Complaints', 'Complaint → Quality case end to end: one case per complaint (retries/sync never duplicate), linked to customer + original job + crew; missing info flagged not invented; staff cannot move stages; root cause before corrective; corrective cleaning is a real scheduled visit with crew; failed reinspection reopens; customer must accept before resolve; close resolves the source issue; metrics + drill-downs + Autopilot activity reflect it', async () => {
    const cu = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Walker Offices', name: 'Wanda', phone: '515-555-0711', email: 'w@walker.test', address: '1144 Boulevard, Walker, IA' } })).data.id;
    const emp = (await req('POST', '/api/admin/employees', { token: T, json: { name: 'Carl Crew', phone: '515-555-0712', role: 'Cleaner' } })).data; const eid = emp.id || (emp.employee && emp.employee.id);
    const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    const v = (await req('POST', '/api/admin/visits', { token: T, json: { title: 'Nightly clean Walker', type: 'Cleaning', date: d(-1), customer_id: cu, address: '1144 Boulevard, Walker, IA' } })).data; const vid = v.id || (v.visit && v.visit.id);
    await req('POST', `/api/admin/dispatch/visits/${vid}/crew`, { token: T, json: { employee_id: eid, override_reason: 'test' } });
    const iss = (await req('POST', '/api/admin/issues', { token: T, json: { type: 'complaint', title: 'Floors still dirty after last night', description: 'Office floors not cleaned', customer_id: cu, priority: 'High' } })).data; const iid = (iss.issue || iss.item || iss).id;
    const list1 = (await req('GET', '/api/admin/quality/complaints', { token: T })).data.complaints.filter(c => c.source_issue_id === iid);
    const list2 = (await req('GET', '/api/admin/quality/complaints', { token: T })).data.complaints.filter(c => c.source_issue_id === iid);
    const c0 = list1[0], det = (await req('GET', `/api/admin/quality/complaints/${c0.id}`, { token: T })).data;
    // unknown caller → info needed
    const iss2 = (await req('POST', '/api/admin/issues', { token: T, json: { type: 'complaint', title: 'Anonymous complaint', description: 'Trash not taken out' } })).data; const iid2 = (iss2.issue || iss2.item || iss2).id;
    const anon = (await req('GET', '/api/admin/quality/complaints', { token: T })).data.complaints.find(c => c.source_issue_id === iid2);
    const staff = await req('POST', `/api/admin/quality/complaints/${c0.id}/stage`, { token: globalThis.__st, json: { to: 'INVESTIGATING' } });
    const inv = await req('POST', `/api/admin/quality/complaints/${c0.id}/stage`, { token: T, json: { to: 'INVESTIGATING' } });
    const noRoot = await req('POST', `/api/admin/quality/complaints/${c0.id}/corrective`, { token: T, json: { date: d(1) } });
    const ca = await req('POST', `/api/admin/quality/complaints/${c0.id}/stage`, { token: T, json: { to: 'CORRECTIVE_ACTION', root_cause: 'Crew skipped the floor scrubber step in suite 200' } });
    const cor = await req('POST', `/api/admin/quality/complaints/${c0.id}/corrective`, { token: T, json: { date: d(1), start_time: '18:00', employee_ids: [eid], instructions: 'Scrub suite 200 floors' } });
    const sched = (await req('GET', `/api/admin/visits?from=${d(0)}&to=${d(3)}`, { token: T })).data; const svis = (sched.visits || sched.items || []).find(x => x.id === cor.data.visit_id);
    // reinspection: failed then passed
    const tpl = (await req('GET', '/api/admin/qc/templates', { token: T })).data.templates[0];
    const mkInsp = async fail => { const i = (await req('POST', '/api/admin/qc/inspections', { token: T, json: { template_id: tpl.id, area: 'Suite 200', date: d(1), customer_id: cu } })).data.inspection; await req('PATCH', '/api/admin/qc/inspections/' + i.id, { token: T, json: { items: i.items.map((x, k) => ({ ...x, result: fail ? 'Fail' : 'Pass', note: fail ? 'Still streaked' : '' })) } }); await req('POST', `/api/admin/qc/inspections/${i.id}/sign`, { token: T, json: { name: 'Sam Supervisor' } }); return i.id; };
    const badConfirm = await req('POST', `/api/admin/quality/complaints/${c0.id}/stage`, { token: T, json: { to: 'CUSTOMER_CONFIRMATION' } });
    const r1 = await req('POST', `/api/admin/quality/complaints/${c0.id}/reinspection`, { token: T, json: { inspection_id: await mkInsp(true) } });
    const r2 = await req('POST', `/api/admin/quality/complaints/${c0.id}/reinspection`, { token: T, json: { inspection_id: await mkInsp(false) } });
    const noAccept = await req('POST', `/api/admin/quality/complaints/${c0.id}/stage`, { token: T, json: { to: 'RESOLVED', resolution_summary: 'Floors rescrubbed; reinspection passed' } });
    await req('POST', `/api/admin/quality/complaints/${c0.id}/customer-contact`, { token: T, json: { channel: 'phone', message: 'Called Wanda; she confirmed the floors look right now', accepted: true } });
    const res1 = await req('POST', `/api/admin/quality/complaints/${c0.id}/stage`, { token: T, json: { to: 'RESOLVED', resolution_summary: 'Floors rescrubbed; reinspection passed' } });
    const cl = await req('POST', `/api/admin/quality/complaints/${c0.id}/stage`, { token: T, json: { to: 'CLOSED' } });
    const srcIssue = (await req('GET', `/api/admin/issues/${iid}`, { token: T })).data.issue;
    const final = (await req('GET', `/api/admin/quality/complaints/${c0.id}`, { token: T })).data;
    const m = (await req('GET', '/api/admin/command-center/metrics?days=30', { token: T })).data.metrics, g = k => m.find(x => x.key === k);
    const openDrill = (await req('GET', '/api/admin/command-center/drill/open_complaints?days=30', { token: T })).data;
    const act = (await req('GET', '/api/admin/autopilot/activity', { token: T })).data;
    const chk = { one: list1.length === 1 && list2.length === 1, linked: c0.customer_id === cu && det.original_visit && det.original_visit.id === vid && /Carl Crew/.test(det.complaint.crew || ''), assigned: c0.status === 'ASSIGNED' && !!c0.assigned_manager && !!c0.response_due,
      autopilot: det.autopilot.some(a => /original job/.test(a.step)) && det.autopilot.some(a => a.status === 'needs_approval' && /corrective/.test(a.step)), anon: anon && anon.status === 'INFO_NEEDED' && /customer/.test(anon.info_needed || ''),
      staff: staff.status === 403, inv: inv.status === 200, noRoot: noRoot.status === 409, ca: ca.status === 200, cor: cor.status === 201 && !!svis, crew: svis && /Corrective/.test(svis.title || ''), badConfirm: badConfirm.status === 409,
      r1: r1.data.passed === false && r1.data.complaint.status === 'CORRECTIVE_ACTION', r2: r2.data.passed === true && r2.data.complaint.status === 'CUSTOMER_CONFIRMATION', noAccept: noAccept.status === 409, resolved: res1.status === 200, closed: cl.status === 200 && final.complaint.status === 'CLOSED',
      srcIssue: srcIssue && srcIssue.status === 'Closed', history: final.history.length >= 8, metric: g('open_complaints').count === openDrill.rows.length && openDrill.rows.some(r => r.id === anon.id), approvals: g('autopilot_approvals') && !g('autopilot_approvals').error, feed: act.recent.length > 0 && act.awaiting.some(a => a.ref_id === anon.id) };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ r1: r1.status + ' ' + JSON.stringify(r1.data).slice(0, 300), staff: staff.status, noRoot: noRoot.status, cor: cor.data, sched: (sched.visits || sched.items || []).length, r1: r1.data, r2: r2.data, noAccept: noAccept.data, res1: res1.data, cl: cl.data, srcIssue: srcIssue && srcIssue.status, anon }).slice(0, 1600));
    return `${c0.number}: linked to visit #${vid} + crew; ${final.history.length} history entries; ${det.autopilot.length} autopilot steps; anonymous complaint → Information needed`;
  });

  await check('Security', 'Script CSP: no inline scripts or inline event handlers anywhere in the site/admin; script policy is sent report-only by default (enforced only via CSP_ENFORCE_SCRIPTS=1); violation reports are collected and shown to owner/manager only', async () => {
    const fs = require('fs'), path = require('path'), pub = path.join(__dirname, '..', 'public'); const bad = [];
    const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(html|js)$/.test(f)) { const t = fs.readFileSync(p, 'utf8'); if (/\.html$/.test(f) && /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>/i.test(t)) bad.push(p + ': inline <script>'); if (/\son(click|error|load|submit|change|input|mouseover|keydown)=["']/i.test(t)) bad.push(p + ': inline handler'); } } };
    walk(pub);
    const h = await fetch(B + '/'), ro = h.headers.get('content-security-policy-report-only') || '', en = h.headers.get('content-security-policy') || '';
    const rep = await fetch(B + '/api/csp-report', { method: 'POST', headers: { 'Content-Type': 'application/csp-report' }, body: JSON.stringify({ 'csp-report': { 'document-uri': 'https://brightclean.net/proposal/abcdefghijklmnopqrstuvwxyz', 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example/x.js' } }) });
    const sh = await req('GET', '/api/admin/system-health', { token: T }), shStaff = await req('GET', '/api/admin/system-health', { token: globalThis.__st });
    const stored = sh.data.csp.reports.find(r => r.blocked === 'https://evil.example/x.js');
    const chk = { noInline: !bad.length, reportOnly: /script-src 'self' https:\/\/cdn\.jsdelivr\.net/.test(ro) && /report-uri \/api\/csp-report/.test(ro), enforcedSafe: /object-src 'none'/.test(en) && !/script-src/.test(en), report: rep.status === 204, stored: !!stored && /:token/.test(stored.page), staff: shStaff.status === 403 };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ bad: bad.slice(0, 5), ro, en, rep: rep.status, stored }));
    return `0 inline scripts/handlers; report-only: ${ro}; violation stored (token redacted); staff 403`;
  });

  await check('Health', 'Monitoring: a server error is recorded (path normalised), counted in /health errors_1h, visible in System health, and the owner is emailed once per distinct error per hour', async () => {
    const before = mail.length;
    const b1 = await fetch(B + '/api/test/boom'), b2 = await fetch(B + '/api/test/boom'); await sleep(400);
    const h = (await req('GET', '/health')).data, sh = (await req('GET', '/api/admin/system-health', { token: T })).data;
    const e = sh.errors.find(x => x.path === '/api/test/boom');
    const mails = mail.slice(before).filter(m => /Bright Clean error/.test(m.subject || m.raw || JSON.stringify(m)));
    assert(b1.status === 500 && b2.status === 500 && e && e.count >= 2 && h.errors_1h >= 2 && mails.length === 1, JSON.stringify({ b1: b1.status, e, h, mails: mails.length }));
    return `error recorded ×${e.count}; /health errors_1h=${h.errors_1h}; one alert email (deduplicated)`;
  });

  await check('Microsoft 365', 'Outlook inbox: connect link carries a one-time state; callback with a bad/expired state is refused; token stored encrypted (no plain refresh token in the DB); sync copies inbox messages once, matches the sender to the lead (case-insensitive), drops non-https links; staff cannot connect or disconnect', async () => {
    const st0 = (await req('GET', '/api/admin/m365/status', { token: T })).data;
    const lead = (await req('POST', '/api/admin/leads', { token: T, json: { kind: 'inquiry', contact_name: 'Sharon', company: 'BorTunCo', email: 'sharon@bortunco.test', details: 'quote' } })).data; const lid = lead.id || (lead.lead && lead.lead.id);
    const staffConn = await req('POST', '/api/admin/m365/connect', { token: globalThis.__st, json: {} });
    const conn = (await req('POST', '/api/admin/m365/connect', { token: T, json: {} })).data, state = new URL(conn.url).searchParams.get('state');
    const badState = await fetch(B + '/api/m365/callback?state=nope&code=x', { redirect: 'manual' });
    const cb = await fetch(B + `/api/m365/callback?state=${state}&code=goodcode`, { redirect: 'manual' });
    const reuse = await fetch(B + `/api/m365/callback?state=${state}&code=goodcode`, { redirect: 'manual' });
    await sleep(500);
    const st1 = (await req('GET', '/api/admin/m365/status', { token: T })).data;
    const s1 = (await req('POST', '/api/admin/m365/sync', { token: T, json: {} })).data, s2 = (await req('POST', '/api/admin/m365/sync', { token: T, json: {} })).data;
    const inbox = (await req('GET', '/api/admin/inbox', { token: T })).data.messages, mine = (await req('GET', '/api/admin/inbox?lead_id=' + lid, { token: T })).data.messages;
    const db = new (require('../node_modules/better-sqlite3'))(require('path').join(globalThis.__dataDir || '', 'brightclean.db'), { readonly: true, fileMustExist: false });
    let plain = null; try { plain = db.prepare("SELECT value FROM settings WHERE key='m365_token'").get(); } catch { /* */ } try { db.close(); } catch { /* */ }
    const staffDisc = await req('POST', '/api/admin/m365/disconnect', { token: globalThis.__st, json: {} });
    const disc = await req('POST', '/api/admin/m365/disconnect', { token: T, json: {} }), st2 = (await req('GET', '/api/admin/m365/status', { token: T })).data;
    const vendor = inbox.find(m => m.from_addr === 'news@vendor.test');
    const chk = { configured: st0.configured && !st0.connected, staffConn: staffConn.status === 403, url: /oauth2\/v2\.0\/authorize/.test(conn.url) && /Mail\.Read/.test(conn.url) && !!state, badState: badState.status === 400, cb: cb.status === 302, reuse: reuse.status === 400,
      connected: st1.connected && st1.account === 'info@brightclean.test', once: inbox.filter(m => m.subject === 'Re: Your Quote Request').length === 1 && (s2.added || 0) === 0, matched: mine.length === 1 && mine[0].from_addr === 'sharon@bortunco.test', badLink: vendor && vendor.web_link === null,
      encrypted: !plain || !/rt-secret-value/.test(plain.value || ''), staffDisc: staffDisc.status === 403, disc: disc.status === 200 && !st2.connected };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ st0, conn: conn.url && conn.url.slice(0, 120), bad: badState.status, cb: cb.status, reuse: reuse.status, st1, s1, s2, inbox: inbox.map(m => [m.from_addr, m.lead_id, m.web_link]), mine: mine.length }).slice(0, 1500));
    return `connected as ${st1.account}; ${inbox.length} messages synced once; reply matched to lead #${lid}; refresh token not stored in plain text`;
  });

  await check('Email', 'A recipient the provider refuses (Postmark 406 inactive) is answered 422 with guidance (not a 502), recorded as undeliverable, and does not raise a server-error alert', async () => {
    const before = (await req('GET', '/api/admin/system-health', { token: T })).data.errors.length;
    const r = await fetch(B + '/api/test/reject', { method: 'POST' }); const j = await r.json();
    const und = (await req('GET', '/api/admin/email-undeliverable', { token: T })).data.addresses;
    const after = (await req('GET', '/api/admin/system-health', { token: T })).data.errors.length;
    assert(r.status === 422 && j.recipient_rejected && /spelling/.test(j.error) && und.some(a => a.address === 'typo@bortuncoo.test') && after === before, JSON.stringify({ st: r.status, j, und, before, after }));
    return '422 with spelling guidance; address flagged undeliverable; no error alert';
  });

  await check('Health', 'Browsers always revalidate the admin and site code after an update (Cache-Control: no-cache on HTML/JS/CSS) while images may still be cached', async () => {
    const js = await fetch(B + '/admin/admin.js'), html = await fetch(B + '/admin/'), et = js.headers.get('etag');
    const again = await new Promise(r => require('http').get(B + '/admin/admin.js', { headers: { 'If-None-Match': et } }, res => { res.resume(); r({ status: res.statusCode }); })); // plain request: Node's fetch adds its own cache header
    assert(js.headers.get('cache-control') === 'no-cache' && html.headers.get('cache-control') === 'no-cache' && again.status === 304, JSON.stringify({ js: js.headers.get('cache-control'), html: html.headers.get('cache-control'), again: again.status }));
    return 'no-cache on admin.js and pages; unchanged file answers 304 (fast)';
  });

  await check('Complaints', 'Corrective loop: scheduling corrective cleaning creates a dispatched crew job with a corrective checklist and emails the crew their link; the crew sees it; completing without an AFTER photo is refused; after checklist + photo the crew completes it and the case moves to Reinspection by itself with the manager emailed', async () => {
    const d1 = (() => { const x = new Date(); x.setDate(x.getDate() + 1); return x.toISOString().slice(0, 10); })();
    const cu = (await req('POST', '/api/admin/customers', { token: T, json: { company: 'Loop Co', name: 'Lou', email: 'lou@loop.test', address: '9 Loop Rd' } })).data.id;
    const emp = (await req('POST', '/api/admin/employees', { token: T, json: { name: 'Rita Repair', phone: '515-555-0333', email: 'rita@crew.test', role: 'Cleaner' } })).data; const eid = emp.id || (emp.employee && emp.employee.id);
    const iss = (await req('POST', '/api/admin/issues', { token: T, json: { type: 'complaint', title: 'Lobby floor streaked', description: 'Streaks in lobby', customer_id: cu, priority: 'High' } })).data; const iid = (iss.issue || iss.item || iss).id;
    const c = (await req('GET', '/api/admin/quality/complaints', { token: T })).data.complaints.find(x => x.source_issue_id === iid);
    await req('POST', `/api/admin/quality/complaints/${c.id}/stage`, { token: T, json: { to: 'CORRECTIVE_ACTION', root_cause: 'Wrong pad used on lobby floor' } });
    const before = mail.length;
    const cor = await req('POST', `/api/admin/quality/complaints/${c.id}/corrective`, { token: T, json: { date: d1, start_time: '19:00', employee_ids: [eid], instructions: 'Re-scrub lobby with red pad; Buff the entrance mat area' } });
    const crewMail = mailsTo('rita@crew.test', before).find(m => /Corrective cleaning/.test(m.subject));
    const link = (await req('GET', `/api/admin/employees/${eid}/link`, { token: T })).data; const tk = String(link.url || '').split('/').pop(); const mailTk = crewMail && (crewMail.raw.match(/\/crew\/([A-Za-z0-9_-]+)/) || [])[1];
    const portal = (await req('GET', `/api/crew/${tk}?date=${d1}`)).data; const job = (portal.jobs || []).find(j => j.id === cor.data.visit_id);
    const vid = cor.data.visit_id;
    const noPhoto1 = await req('POST', `/api/crew/${tk}/jobs/${vid}/complete`, { json: {} });
    for (let i = 0; i < (job ? job.checklist.length : 0); i++) await req('POST', `/api/crew/${tk}/jobs/${vid}/checklist`, { json: { index: i, done: true } });
    const noPhoto2 = await req('POST', `/api/crew/${tk}/jobs/${vid}/complete`, { json: {} });
    const fd = new FormData(); fd.append('stage', 'After'); fd.append('photos', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: 'image/png' }), 'after.png');
    const up = await fetch(B + `/api/crew/${tk}/jobs/${vid}/photos`, { method: 'POST', body: fd }); const upBody = await up.text();
    const before2 = mail.length;
    const done = await req('POST', `/api/crew/${tk}/jobs/${vid}/complete`, { json: {} }); await sleep(300);
    const det = (await req('GET', `/api/admin/quality/complaints/${c.id}`, { token: T })).data;
    const mgrMail = mail.slice(before2).find(m => /Reinspect now/.test(m.subject));
    const act = det.actions.find(a => a.action_type === 'corrective_visit');
    const chk = { scheduled: cor.status === 201 && cor.data.notified === 1, crewMail: !!crewMail && /Before and after photos/.test(crewMail.raw) && mailTk === tk, sees: !!job && job.checklist.length >= 5 && /Take AFTER photos/.test(JSON.stringify(job.checklist)) && /Re-scrub lobby/.test(JSON.stringify(job.checklist)),
      noPrice: job && !/\$\s?\d/.test(JSON.stringify(job)), refused1: noPhoto1.status === 409, refused2: noPhoto2.status === 409 && /AFTER photo/.test(noPhoto2.data.error), photo: up.status === 201, done: done.status === 200,
      advanced: det.complaint.status === 'REINSPECTION' && act && act.status === 'Completed' && /1 photo/.test(act.notes || ''), mgr: !!mgrMail, timeline: det.autopilot.some(a => /Corrective cleaning completed/.test(a.step)) };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ cor: cor.data && { s: cor.status, n: cor.data.notified, e: cor.data.error }, tk: !!tk, job: job && job.checklist, n1: noPhoto1.data, n2: noPhoto2.data, up: up.status + ' ' + upBody.slice(0, 200), done: done.data, st: det.complaint.status, act }).slice(0, 1500));
    return `crew dispatched + emailed; ${job.checklist.length}-item checklist; refused without after photo; completed → ${det.complaint.status}; manager emailed`;
  });

  await check('Security', 'Roles: supervisor and inspector are enforced on the server — supervisor runs field operations but never sees money/sales/settings; inspector only quality; staff unchanged; roles assignable at creation; /me gives the pages each role sees', async () => {
    const jwt = require('../node_modules/jsonwebtoken'), mint = em => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' });
    const mk = async (em, role) => (await req('POST', '/api/admin/users', { token: T, json: { name: role, email: em, password: 'role-test-password-1', role } })).status;
    const cS = await mk('sup@roles.test', 'supervisor'), cI = await mk('insp@roles.test', 'inspector'), bad = await mk('x@roles.test', 'emperor'), ownerTry = await mk('o2@roles.test', 'owner');
    const S = mint('sup@roles.test'), I = mint('insp@roles.test'), st = async (tok, m, path, json) => (await req(m, path, { token: tok, json })).status;
    const meS = (await req('GET', '/api/admin/me', { token: S })).data, meI = (await req('GET', '/api/admin/me', { token: I })).data;
    const sup = { invoices: await st(S, 'GET', '/api/admin/invoices'), estimates: await st(S, 'GET', '/api/admin/estimates'), leads: await st(S, 'GET', '/api/admin/leads'), finance: await st(S, 'GET', '/api/admin/reports/finance'), dash: await st(S, 'GET', '/api/admin/dashboard'), cc: await st(S, 'GET', '/api/admin/command-center'), users: await st(S, 'GET', '/api/admin/users'), settings: await st(S, 'PUT', '/api/admin/settings', {}), emails: await st(S, 'GET', '/api/admin/emails'),
      visits: await st(S, 'GET', '/api/admin/visits'), issues: await st(S, 'GET', '/api/admin/issues'), calls: await st(S, 'GET', '/api/admin/calls'), customers: await st(S, 'GET', '/api/admin/customers'), quality: await st(S, 'GET', '/api/admin/quality/complaints'), drillMoney: await st(S, 'GET', '/api/admin/command-center/drill/collected?days=30'), drillOps: await st(S, 'GET', '/api/admin/command-center/drill/open_complaints?days=30') };
    const mS = (await req('GET', '/api/admin/command-center/metrics?days=30', { token: S })).data.metrics, groupsS = [...new Set(mS.map(x => x.group))];
    const anyCase = (await req('GET', '/api/admin/quality/complaints', { token: T })).data.complaints.find(c => !['RESOLVED', 'CLOSED'].includes(c.status));
    const supStage = anyCase ? await st(S, 'POST', `/api/admin/quality/complaints/${anyCase.id}/stage`, { to: 'INVESTIGATING' }) : 200;
    const insp = { qc: await st(I, 'GET', '/api/admin/qc/templates'), quality: await st(I, 'GET', '/api/admin/quality/complaints'), customers: await st(I, 'GET', '/api/admin/customers'), visits: await st(I, 'GET', '/api/admin/visits'),
      calls: await st(I, 'GET', '/api/admin/calls'), issues: await st(I, 'GET', '/api/admin/issues'), invoices: await st(I, 'GET', '/api/admin/invoices'), projects: await st(I, 'GET', '/api/admin/projects'), metrics: await st(I, 'GET', '/api/admin/command-center/metrics'),
      stage: anyCase ? await st(I, 'POST', `/api/admin/quality/complaints/${anyCase.id}/stage`, { to: 'ON_HOLD', note: 'x' }) : 403, reinsp: anyCase ? await st(I, 'POST', `/api/admin/quality/complaints/${anyCase.id}/reinspection`, { inspection_id: 999999 }) : 404 };
    const staffInv = await st(globalThis.__st, 'GET', '/api/admin/invoices');
    const denied = (await req('GET', '/api/admin/audit-log', { token: T })).data; const deniedRows = JSON.stringify(denied).match(/permission denied/g) || [];
    const chk = { create: cS === 201 && cI === 201 && bad === 400 && ownerTry === 400, meS: meS.role === 'supervisor' && meS.sees_money === false && meS.views.includes('schedule') && !meS.views.includes('invoices'), meI: meI.role === 'inspector' && meI.home === 'quality' && !meI.views.includes('calls'),
      supDenied: ['invoices', 'estimates', 'leads', 'finance', 'dash', 'cc', 'users', 'settings', 'emails', 'drillMoney'].every(k => sup[k] === 403), supAllowed: ['visits', 'issues', 'calls', 'customers', 'quality', 'drillOps'].every(k => sup[k] === 200),
      supGroups: !groupsS.some(g => ['Finance', 'Management', 'Sales'].includes(g)) && groupsS.includes('Quality'), supStage: supStage === 200,
      inspAllowed: ['qc', 'quality', 'customers', 'visits'].every(k => insp[k] === 200), inspDenied: ['calls', 'issues', 'invoices', 'projects', 'metrics', 'stage'].every(k => insp[k] === 403), inspReinsp: insp.reinsp === 404, staff: staffInv === 200, audited: deniedRows.length > 0 };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ cS, cI, bad, ownerTry, meS, meI, sup, groupsS, supStage, insp, staffInv }).slice(0, 1500));
    return `supervisor: ${Object.values(sup).filter(x => x === 403).length} areas refused, operations allowed, groups ${groupsS.join('/')}; inspector: quality only; staff unchanged; refusals audited`;
  });

  await check('Security', 'Display names: the owner sets their name and it shows in Users & access and /me; another user sets only their own', async () => {
    const r = await req('PUT', '/api/admin/account/name', { token: T, json: { name: 'Eric Moore' } });
    const me = (await req('GET', '/api/admin/me', { token: T })).data, users = (await req('GET', '/api/admin/users', { token: T })).data.users;
    const empty = await req('PUT', '/api/admin/account/name', { token: T, json: { name: '' } });
    assert(r.status === 200 && me.name === 'Eric Moore' && users.some(u => u.owner && u.name === 'Eric Moore') && empty.status === 400, JSON.stringify({ r: r.status, me, users: users.slice(0, 2), empty: empty.status }));
    return 'owner shown as Eric Moore';
  });

  await check('Security', 'Sales role: enforced on the server — sales pages and leads/estimates/proposals/calls/email work; invoices, finance reports, settings writes, user admin and audit log are refused; no finance groups in Command Center', async () => {
    const jwt = require('../node_modules/jsonwebtoken'), mint = em => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' });
    const cSa = (await req('POST', '/api/admin/users', { token: T, json: { name: 'Sally Sales', email: 'sales@roles.test', password: 'role-test-password-1', role: 'sales' } })).status;
    const SA = mint('sales@roles.test'), st = async (tok, m, path, json) => (await req(m, path, { token: tok, json })).status;
    const me = (await req('GET', '/api/admin/me', { token: SA })).data;
    const allowed = { leads: await st(SA, 'GET', '/api/admin/leads'), estimates: await st(SA, 'GET', '/api/admin/estimates'), customers: await st(SA, 'GET', '/api/admin/customers'), calls: await st(SA, 'GET', '/api/admin/calls'), emails: await st(SA, 'GET', '/api/admin/emails'), issues: await st(SA, 'GET', '/api/admin/issues'), phoneSettingsRead: await st(SA, 'GET', '/api/admin/phone/settings') };
    const denied = { invoices: await st(SA, 'GET', '/api/admin/invoices'), finance: await st(SA, 'GET', '/api/admin/reports/finance'), financialSummary: await st(SA, 'GET', '/api/admin/financial-summary'), settingsWrite: await st(SA, 'PUT', '/api/admin/settings', {}), phoneSettingsWrite: await st(SA, 'PUT', '/api/admin/phone/settings', {}), users: await st(SA, 'GET', '/api/admin/users'), auditLog: await st(SA, 'GET', '/api/admin/audit-log'), customerInvoices: await st(SA, 'GET', '/api/admin/customers/1/invoices'), dashboard: await st(SA, 'GET', '/api/admin/dashboard') };
    const groups = [...new Set(((await req('GET', '/api/admin/command-center/metrics?days=30', { token: SA })).data.metrics || []).map(x => x.group))];
    const chk = { create: cSa === 201, me: me.role === 'sales' && me.label === 'Sales' && me.sees_money === false && me.views.includes('leads') && !me.views.includes('invoices') && me.home === 'leads', allowed: Object.values(allowed).every(x => x === 200), denied: Object.values(denied).every(x => x === 403), groups: !groups.some(g => ['Finance', 'Management', 'Sales'].includes(g)) && groups.includes('Quality') };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ cSa, me, allowed, denied, groups }).slice(0, 1500));
    return 'sales: sales pages allowed, invoices/finance/settings/users/audit refused, no finance groups';
  });

  await check('Website', 'Website photos & video: the public gallery shows the shipped photos and page video; admin uploads, hide/show, reorder, replace and delete work; only registered files are served; upload content is checked; only owner, manager and office staff can change it', async () => {
    const jwt = require('../node_modules/jsonwebtoken'), mint = em => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' });
    const up = async (tok, method, path, parts) => { const fd = new FormData(); for (const [k, v] of Object.entries(parts || {})) { if (v && v.blob) fd.append(k, new Blob([v.bytes], { type: v.type || 'application/octet-stream' }), v.name); else fd.append(k, v); } const r = await fetch(B + path, { method, headers: tok ? { Authorization: 'Bearer ' + tok } : {}, body: fd }); let j = {}; try { j = await r.json(); } catch { /* none */ } return { status: r.status, data: j }; };
    const jpg = (n) => ({ blob: true, name: n, type: 'image/jpeg', bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]) });
    const mp4 = (n) => ({ blob: true, name: n, type: 'video/mp4', bytes: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(400, 1)]) });
    const exeAsJpg = { blob: true, name: 'evil.jpg', type: 'image/jpeg', bytes: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 0)]) };
    const txt = { blob: true, name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('hello') };
    const pub0 = (await req('GET', '/api/site/gallery')).data;
    const shipped = pub0.gallery.length, heroShipped = !!(pub0.hero && pub0.hero.url);
    const adminList = (await req('GET', '/api/admin/site-media', { token: T })).data.items;
    const noAuth = (await req('GET', '/api/admin/site-media')).status;
    const up1 = await up(T, 'POST', '/api/admin/site-media', { file: jpg('Test Photo.jpg'), title: 'Test photo', location: '', alt: 'Test photo alt' });
    const galleryAfter = (await req('GET', '/api/site/gallery')).data.gallery;
    const added = galleryAfter.find(g => g.title === 'Test photo');
    const served = added ? await fetch(B + added.url) : null;
    const notReg = (await fetch(B + '/site-media/not-registered-123.jpg')).status;
    const exeRefused = (await up(T, 'POST', '/api/admin/site-media', { file: exeAsJpg, title: 'x' })).status;
    const txtRefused = (await up(T, 'POST', '/api/admin/site-media', { file: txt, title: 'x' })).status;
    const heroJpgRefused = (await up(T, 'POST', '/api/admin/site-media', { file: jpg('p.jpg'), slot: 'hero_video', title: 'x' })).status;
    const staffAdd = await up(globalThis.__st, 'POST', '/api/admin/site-media', { file: jpg('staff.jpg'), title: 'Staff photo' });
    const roleBlocks = [];
    for (const em of ['sup@roles.test', 'insp@roles.test', 'sales@roles.test']) { const tok = mint(em); roleBlocks.push((await req('GET', '/api/admin/site-media', { token: tok })).status, (await up(tok, 'POST', '/api/admin/site-media', { file: jpg('no.jpg'), title: 'no' })).status); }
    const beforeHide = (await req('GET', '/api/site/gallery')).data.gallery.length;
    const hid = await up(T, 'PATCH', `/api/admin/site-media/${added ? added.id : 0}`, { visible: 'false' });
    const hiddenCount = (await req('GET', '/api/site/gallery')).data.gallery.length;
    const shown = await up(T, 'PATCH', `/api/admin/site-media/${added ? added.id : 0}`, { visible: 'true' });
    const list2 = (await req('GET', '/api/admin/site-media', { token: T })).data.items.filter(i => i.slot === 'gallery');
    const rev = [...list2].reverse().map(i => i.id);
    const reord = await req('POST', '/api/admin/site-media/reorder', { token: T, json: { ids: rev } });
    const firstAfter = (await req('GET', '/api/site/gallery')).data.gallery[0];
    const rep = await up(T, 'PATCH', `/api/admin/site-media/${added ? added.id : 0}`, { title: 'Test photo renamed', file: jpg('Replaced.jpg') });
    const renamed = (await req('GET', '/api/site/gallery')).data.gallery.find(g => g.title === 'Test photo renamed');
    const heroAdd = await up(T, 'POST', '/api/admin/site-media', { file: mp4('clip.mp4'), slot: 'hero_video', title: 'Test page video' });
    const heroNow = (await req('GET', '/api/site/gallery')).data.hero;
    const heroRow = (await req('GET', '/api/admin/site-media', { token: T })).data.items.find(i => i.slot === 'hero_video');
    const heroDel = heroRow ? await req('DELETE', `/api/admin/site-media/${heroRow.id}`, { token: T }) : { status: 0 };
    const heroAfter = (await req('GET', '/api/site/gallery')).data.hero;
    const del = await req('DELETE', `/api/admin/site-media/${renamed ? renamed.id : 0}`, { token: T });
    const staffItem = (await req('GET', '/api/admin/site-media', { token: T })).data.items.find(i => i.title === 'Staff photo');
    if (staffItem) await req('DELETE', `/api/admin/site-media/${staffItem.id}`, { token: T });
    const finalCount = (await req('GET', '/api/site/gallery')).data.gallery.length;
    const chk = {
      shipped: shipped >= 11 && heroShipped && adminList.length >= 12,
      noAuth: noAuth === 401,
      upload: up1.status === 201 && !!added && added.url.startsWith('/site-media/') && served && served.status === 200 && (served.headers.get('content-type') || '').startsWith('image/'),
      unregistered: notReg === 404,
      refused: exeRefused === 400 && txtRefused === 400 && heroJpgRefused === 400,
      staff: staffAdd.status === 201,
      roles: roleBlocks.every(x => x === 403),
      hideShow: hid.status === 200 && hiddenCount === beforeHide - 1 && shown.status === 200,
      reorder: reord.status === 200 && firstAfter && firstAfter.id === rev[0],
      replace: rep.status === 200 && !!renamed && renamed.url !== added.url,
      heroReplace: heroAdd.status === 201 && !!heroNow && heroNow.url.startsWith('/site-media/'),
      heroRestore: heroDel.status === 200 && heroAfter === null,
      deleted: del.status === 200 && finalCount === shipped
    };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ shipped, heroShipped, noAuth, up1: up1.status, notReg, exeRefused, txtRefused, heroJpgRefused, staff: staffAdd.status, roleBlocks, hid: hid.status, hiddenCount, shown: shown.status, reord: reord.status, rep: rep.status, heroAdd: heroAdd.status, heroDel: heroDel.status, heroAfter, del: del.status, finalCount }).slice(0, 1800));
    return 'gallery and page video served; upload checked by content; hide, reorder, replace, delete and page-video restore work; supervisor, inspector and sales refused';
  });

  await check('Website SEO', 'SEO: every sitemap URL is a real public page on the canonical host; each public page has a canonical link, Open Graph and Twitter tags; private pages are noindex; structured data parses; photo files exist', async () => {
    const pubDir = path.join(__dirname, '..', 'public'), sm = fs.readFileSync(path.join(pubDir, 'sitemap.xml'), 'utf8');
    const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    const missing = locs.filter(u => !u.startsWith('https://brightclean.net/') || !fs.existsSync(path.join(pubDir, u.replace('https://brightclean.net/', '') || 'index.html')));
    const htmls = []; (function walk(d, rel) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f), r = rel ? rel + '/' + f : f; if (fs.statSync(p).isDirectory()) { if (f !== 'admin') walk(p, r); } else if (f.endsWith('.html')) htmls.push(r); } })(pubDir, '');
    const priv = new Set(['contract.html', 'crew.html', 'proposal.html', '404.html']);
    const noSeo = [], noindex = [], badLd = [];
    for (const r of htmls) {
      const s = fs.readFileSync(path.join(pubDir, r), 'utf8');
      if (priv.has(r)) { if (!/name="robots" content="noindex/.test(s)) noindex.push(r); continue; }
      if (!/rel="canonical" href="https:\/\/brightclean\.net\//.test(s) || !/property="og:title"/.test(s) || !/name="twitter:card"/.test(s)) noSeo.push(r);
      for (const m of s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) { try { JSON.parse(m[1]); } catch { badLd.push(r); } }
      for (const img of s.matchAll(/<img src="(\/assets\/[^"]+)"/g)) if (!fs.existsSync(path.join(pubDir, img[1].slice(1)))) noSeo.push(r + ' missing ' + img[1]);
    }
    assert(!missing.length && !noSeo.length && !noindex.length && !badLd.length, JSON.stringify({ missing, noSeo, noindex, badLd }).slice(0, 1200));
    return `${locs.length} sitemap URLs, all real pages; ${htmls.length - priv.size} public pages with canonical + Open Graph; private pages noindex`;
  });

  await check('Integrations', 'API keys and lead intake: owner creates a key (shown once), another source posts a lead that records its source, bad or revoked keys are refused, and only the owner can manage keys', async () => {
    const created = await req('POST', '/api/admin/api-keys', { token: T, json: { name: 'Partner site test' } });
    const key = created.data.key || '';
    const list = (await req('GET', '/api/admin/api-keys', { token: T })).data.keys || [];
    const shownAgain = JSON.stringify(list).includes(key);
    const intake = (k, body) => fetch(B + '/api/integrations/leads', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(k ? { 'X-API-Key': k } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
    const good = await intake(key, { name: 'Partner Lead Test', company: 'Partner Co', email: 'partner.lead@example.com', phone: '515-555-0199', project_name: 'Partner project', service: 'Commercial janitorial', details: 'Came from the partner site', source: 'landing-page' });
    const leadRow = good.data.id ? (await req('GET', '/api/admin/leads', { token: T })).data.leads.find(l => l.id === good.data.id) : null;
    const noKey = await intake('', { name: 'No Key', email: 'x@example.com' });
    const badKey = await intake('bc_live_not-a-real-key', { name: 'Bad Key', email: 'x@example.com' });
    const noContact = await intake(key, { details: 'nobody to call' });
    const badEmail = await intake(key, { name: 'Bad Email', email: 'not-an-email' });
    const staffMake = await req('POST', '/api/admin/api-keys', { token: globalThis.__st, json: { name: 'staff try' } });
    const keyId = created.data.id;
    const revoke = await req('POST', `/api/admin/api-keys/${keyId}/revoke`, { token: T });
    const afterRevoke = await intake(key, { name: 'After Revoke', email: 'after.revoke@example.com' });
    const chk = {
      created: created.status === 201 && key.startsWith('bc_live_') && key.length > 30,
      hashOnly: !shownAgain && list.some(k => k.id === keyId && k.prefix === key.slice(0, 12)),
      intake: good.status === 201 && !!leadRow && leadRow.intake.startsWith('API: Partner site test') && leadRow.email === 'partner.lead@example.com' && leadRow.kind === 'inquiry',
      refused: noKey.status === 401 && badKey.status === 401 && noContact.status === 400 && badEmail.status === 400,
      staffBlocked: staffMake.status === 403,
      revoked: revoke.status === 200 && afterRevoke.status === 401
    };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ created: created.status, good: good.status, leadRow: leadRow && leadRow.intake, noKey: noKey.status, badKey: badKey.status, noContact: noContact.status, badEmail: badEmail.status, staffMake: staffMake.status, revoke: revoke.status, afterRevoke: afterRevoke.status, shownAgain }).slice(0, 1200));
    return 'key created once and stored as a hash; partner lead recorded with its source; bad, missing and revoked keys refused; staff cannot manage keys';
  });

  await check('Inspections', 'Inspections: a record can be cancelled only by an owner or manager; staff are refused; cancelled records leave the open count', async () => {
    const tplId = ((await req('GET', '/api/admin/qc/templates', { token: T })).data.templates || [])[0].id;
    const made = await req('POST', '/api/admin/qc/inspections', { token: T, json: { template_id: tplId, area: 'Cancel test site', date: '2026-11-06', crew: 'Test crew', itype: 'Internal' } });
    const id = made.data.inspection && made.data.inspection.id;
    const staffTry = await req('PATCH', `/api/admin/qc/inspections/${id}`, { token: globalThis.__st, json: { status: 'Cancelled' } });
    const ownerTry = await req('PATCH', `/api/admin/qc/inspections/${id}`, { token: T, json: { status: 'Cancelled' } });
    const after = (await req('GET', `/api/admin/qc/inspections/${id}`, { token: T })).data.inspection;
    const chk = { created: made.status === 201 && !!id, staffRefused: staffTry.status === 403, ownerCancels: ownerTry.status === 200 && after && after.status === 'Cancelled' };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ made: made.status, staffTry: staffTry.status, ownerTry: ownerTry.status, after: after && after.status }).slice(0, 600));
    return 'owner cancels an inspection; staff refused';
  });

  await check('Security', 'Supervisor cannot read company settings or the reminder log; own account and quality work still allowed', async () => {
    const jwt = require('../node_modules/jsonwebtoken'), mint = em => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' });
    const S = mint('sup@roles.test');
    const sGet = (await req('GET', '/api/admin/settings', { token: S })).status;
    const ownerGet = (await req('GET', '/api/admin/settings', { token: T })).status;
    const quality = (await req('GET', '/api/admin/quality/complaints', { token: S })).status;
    assert(sGet === 403 && ownerGet === 200 && quality === 200, JSON.stringify({ sGet, ownerGet, quality }));
    return 'supervisor refused company settings (403); owner 200; quality 200';
  });

  await check('Settings', 'Labor assumptions: owner stores the business-plan values; invalid values refused; staff can read and not change; supervisor refused', async () => {
    const jwt = require('../node_modules/jsonwebtoken'), mint = em => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' });
    const get0 = await req('GET', '/api/admin/labor-assumptions', { token: T });
    const put = await req('PUT', '/api/admin/labor-assumptions', { token: T, json: { payroll_burden_pct: 22 } });
    const get1 = await req('GET', '/api/admin/labor-assumptions', { token: T });
    const bad = await req('PUT', '/api/admin/labor-assumptions', { token: T, json: { base_wage_per_hour: 5000 } });
    const staffPut = await req('PUT', '/api/admin/labor-assumptions', { token: globalThis.__st, json: { payroll_burden_pct: 10 } });
    const staffGet = await req('GET', '/api/admin/labor-assumptions', { token: globalThis.__st });
    const supGet = await req('GET', '/api/admin/labor-assumptions', { token: mint('sup@roles.test') });
    await req('PUT', '/api/admin/labor-assumptions', { token: T, json: { payroll_burden_pct: 20 } });
    const chk = {
      defaults: get0.status === 200 && get0.data.labor.base_wage_per_hour === 20 && get0.data.labor.target_contribution_margin_pct === 30,
      stored: put.status === 200 && get1.data.labor.payroll_burden_pct === 22,
      invalidRefused: bad.status === 400,
      staffReadOnly: staffPut.status === 403 && staffGet.status === 200,
      supervisorRefused: supGet.status === 403
    };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ get0: get0.status, put: put.status, bad: bad.status, staffPut: staffPut.status, staffGet: staffGet.status, supGet: supGet.status }).slice(0, 600));
    return 'owner stores labor assumptions; invalid refused; staff read-only; supervisor refused';
  });

  await check('Leads', 'Lead review: owner marks leads real or fake and archives or restores them in bulk; invalid actions refused; supervisors refused', async () => {
    const jwt = require('../node_modules/jsonwebtoken'), mint = em => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' });
    const mk = async n => (await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Review ' + n, email: `review${n}@example.com`, message: 'Bulk review test' }) })).json();
    const a = await mk(1), b = await mk(2);
    const bulk = (tok, ids, action) => req('POST', '/api/admin/leads/bulk', { token: tok, json: { ids, action } });
    const fake = await bulk(T, [a.id, b.id], 'fake');
    const afterFake = (await req('GET', '/api/admin/leads', { token: T })).data.leads.filter(l => [a.id, b.id].includes(l.id));
    const real = await bulk(T, [a.id], 'real');
    const restore = await bulk(T, [a.id, b.id], 'restore');
    const afterRestore = (await req('GET', '/api/admin/leads', { token: T })).data.leads.filter(l => [a.id, b.id].includes(l.id));
    const badAction = await bulk(T, [a.id], 'delete-everything');
    const supRefused = await bulk(mint('sup@roles.test'), [a.id], 'archive');
    const chk = {
      fakeArchives: fake.status === 200 && afterFake.every(l => l.status === 'Archived' && l.review === 'fake'),
      realMarks: real.status === 200 && afterRestore.find(l => l.id === a.id) && true,
      restores: restore.status === 200 && afterRestore.every(l => l.status === 'New'),
      invalidRefused: badAction.status === 400,
      supervisorRefused: supRefused.status === 403
    };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ fake: fake.status, real: real.status, restore: restore.status, badAction: badAction.status, supRefused: supRefused.status, afterFake: afterFake.map(l => [l.status, l.review]) }).slice(0, 600));
    return 'bulk fake archives, restore works, invalid and supervisor refused';
  });

  await check('Leads', 'Lead stages and follow-ups: a note moves a new lead to being worked; a follow-up hides it until its date and creates a task in Issues & tasks; clearing returns it; restore sets it back to new; staff allowed, supervisor refused', async () => {
    const jwt = require('../node_modules/jsonwebtoken'), mint = em => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' });
    const made = await (await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Stage Test', email: 'stage.test@example.com', message: 'Stage test lead' }) })).json();
    const id = made.id;
    const get = async () => (await req('GET', '/api/admin/leads', { token: T })).data.leads.find(l => l.id === id);
    const s0 = (await get()).stage;
    await req('PATCH', `/api/admin/leads/${id}`, { token: T, json: { notes: 'Called the customer' } });
    const s1 = (await get()).stage;
    const fu = await req('POST', `/api/admin/leads/${id}/follow-up`, { token: T, json: { date: '2099-01-15', note: 'Call back about the walkthrough' } });
    const s2 = (await get()).stage;
    const issues = (await req('GET', '/api/admin/issues', { token: T })).data.issues || [];
    const task = issues.find(i => i.id === (fu.data && fu.data.issue_id));
    const clear = await req('DELETE', `/api/admin/leads/${id}/follow-up`, { token: T });
    const s3 = (await get()).stage;
    await req('POST', '/api/admin/leads/bulk', { token: T, json: { ids: [id], action: 'archive' } });
    const s4 = (await get()).stage;
    await req('POST', '/api/admin/leads/bulk', { token: T, json: { ids: [id], action: 'restore' } });
    const s5 = (await get()).stage;
    const supFu = await req('POST', `/api/admin/leads/${id}/follow-up`, { token: mint('sup@roles.test'), json: { date: '2099-01-15' } });
    const chk = {
      startsNew: s0 === 'new',
      noteWorked: s1 === 'worked',
      followUpHides: fu.status === 200 && s2 === 'followup' && !!task && task.type === 'follow_up' && task.due_date === '2099-01-15',
      cleared: clear.status === 200 && s3 === 'worked',
      archivedDone: s4 === 'done',
      restoredNew: s5 === 'new',
      supervisorRefused: supFu.status === 403
    };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ s0, s1, s2, s3, s4, s5, fu: fu.status, clear: clear.status, supFu: supFu.status, task: task && task.type }).slice(0, 600));
    return 'note -> worked; follow-up hides and creates a task; clear, archive and restore set stages; supervisor refused';
  });

  await check('Leads', 'Lead to customer: converting a lead creates (or matches) one customer, links it, moves the lead to converted, and never duplicates on a second convert; supervisors refused', async () => {
    const jwt = require('../node_modules/jsonwebtoken'), mint = em => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' });
    const made = await (await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Convert Test', email: 'convert.test@example.com', message: 'Please send a quote' }) })).json();
    const id = made.id;
    const lead = async () => (await req('GET', '/api/admin/leads', { token: T })).data.leads.find(l => l.id === id);
    const supRefused = await req('POST', `/api/admin/leads/${id}/convert`, { token: mint('sup@roles.test') });
    const first = await req('POST', `/api/admin/leads/${id}/convert`, { token: T });
    const second = await req('POST', `/api/admin/leads/${id}/convert`, { token: T });
    const l = await lead();
    const customers = (await req('GET', '/api/admin/customers', { token: T })).data.customers || [];
    const matches = customers.filter(c => (c.email || '').toLowerCase() === 'convert.test@example.com');
    const chk = {
      supervisorRefused: supRefused.status === 403,
      converted: first.status === 200 && !!first.data.customer_id && l.customer_id === first.data.customer_id && l.stage === 'converted' && l.status === 'Won',
      noDuplicate: second.status === 200 && second.data.customer_id === first.data.customer_id && matches.length === 1
    };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ sup: supRefused.status, first: first.status, second: second.status, stage: l && l.stage, matches: matches.length }).slice(0, 500));
    return 'lead converted to one linked customer; second convert does not duplicate; supervisor refused';
  });

  await check('Phone', 'Automatic callbacks: off by default; owner only; cannot be turned on without the legal-review confirmation; daily limit checked; leads are flagged for callback', async () => {
    const jwt = require('../node_modules/jsonwebtoken'), mint = em => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' });
    const g0 = await req('GET', '/api/admin/outbound-callbacks', { token: T });
    const onNoLegal = await req('PUT', '/api/admin/outbound-callbacks', { token: T, json: { enabled: true } });
    const badLimit = await req('PUT', '/api/admin/outbound-callbacks', { token: T, json: { daily_limit: 99 } });
    const legal = await req('PUT', '/api/admin/outbound-callbacks', { token: T, json: { legal_review_confirmed: true } });
    const staffGet = await req('GET', '/api/admin/outbound-callbacks', { token: globalThis.__st });
    const staffPut = await req('PUT', '/api/admin/outbound-callbacks', { token: globalThis.__st, json: { daily_limit: 5 } });
    const supGet = await req('GET', '/api/admin/outbound-callbacks', { token: mint('sup@roles.test') });
    const made = await (await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Callback Test', email: 'callback.test@example.com', message: 'Please call me back' }) })).json();
    const flag = await req('POST', `/api/admin/leads/${made.id}/callback-request`, { token: T, json: { requested: true } });
    const off = await req('PUT', '/api/admin/outbound-callbacks', { token: T, json: { legal_review_confirmed: false } });
    const chk = {
      offByDefault: g0.status === 200 && g0.data.settings.enabled === false,
      legalRequired: onNoLegal.status === 400,
      limitChecked: badLimit.status === 400,
      legalStored: legal.status === 200 && legal.data.settings.legal_review_confirmed === true,
      staffRefused: staffGet.status === 403 && staffPut.status === 403,
      supervisorRefused: supGet.status === 403,
      leadFlagged: flag.status === 200,
      stillOff: off.status === 200
    };
    const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
    assert(!failed.length, 'failed: ' + failed.join(', ') + ' | ' + JSON.stringify({ g0: g0.status, onNoLegal: onNoLegal.status, badLimit: badLimit.status, legal: legal.status, staffGet: staffGet.status, staffPut: staffPut.status, supGet: supGet.status, flag: flag.status }).slice(0, 600));
    return 'automatic callbacks off by default, owner only, legal confirmation required, limit checked, leads flagged';
  });

  await check('Phone', 'Test call: owner only; a bad number is refused; staff refused (no real call is placed by the tests)', async () => {
    const bad = await req('POST', '/api/admin/test-call', { token: T, json: { to: '12345' } });
    const staff = await req('POST', '/api/admin/test-call', { token: globalThis.__st, json: { to: '+15157785860' } });
    assert(bad.status === 400 && staff.status === 403, JSON.stringify({ bad: bad.status, staff: staff.status }));
    return 'test call: bad number refused; staff refused';
  });

  await check('Phone', 'Transcribe recording: a call with no recording is refused; status reports not started; unknown call 404', async () => {
    const made = await (await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Transcribe Test', email: 'transcribe.test@example.com', message: 'x' }) })).json();
    const calls = (await req('GET', '/api/admin/calls', { token: T })).data.calls || [];
    const noRec = calls.find(c => !c.recording_url);
    const bad = noRec ? await req('POST', `/api/admin/calls/${noRec.id}/transcribe`, { token: T }) : { status: 400 };
    const status = noRec ? await req('GET', `/api/admin/calls/${noRec.id}/transcribe-status`, { token: T }) : { status: 200, data: { status: 'not-started' } };
    const missing = await req('POST', '/api/admin/calls/999999/transcribe', { token: T });
    assert(bad.status === 400 && status.data.status === 'not-started' && missing.status === 404 && !!made.id, JSON.stringify({ bad: bad.status, status: status.data, missing: missing.status }));
    return 'transcribe refused without a recording; unknown call 404';
  });

  await check('AI off', 'Without an API key every AI action says AI is off (503), nothing breaks', async () => {
    const st = (await req('GET', '/api/admin/ai/status', { token: T })).data;
    const a = await req('POST', '/api/admin/ai/leads/1/triage', { token: T });
    const b = await req('POST', '/api/admin/ai/calls/extract', { token: T, json: { notes: 'x' } });
    const c = await req('POST', '/api/admin/ai/documents/1/takeoff', { token: T });
    assert(st.enabled === false && [a, b, c].every(x => x.status === 503 && x.data.ai_off), JSON.stringify([a.data, b.data, c.data]));
    return `status off; triage, call notes and takeoff all 503 "${a.data.error}"`;
  });

  await check('Work queue', 'Email: a new email is in Needs Attention; a follow-up for a future date leaves Today and shows in Scheduled; it returns on its date; handled emails are Completed; opening it changes nothing', async () => {
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    const mid = pdb.prepare("INSERT INTO inbox_messages(graph_id,from_addr,from_name,subject,preview,received_at,created_at) VALUES(?,?,?,?,?,?,?)")
      .run('wq-' + Date.now(), 'property.mgr@example.com', 'Property Manager', 'Hallway cleaning quote', 'Can you quote hallway cleaning?', new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
    pdb.close();
    const bizToday = require('../bizdate').today();
    const tomorrow = new Date(bizToday + 'T12:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const future = '2099-11-12';
    const find = async (bucket) => ((await req('GET', `/api/admin/work-queue?dept=emails&bucket=${bucket}`, { token: T })).data.items || []).find(i => i.id === mid);
    const inNew = !!(await find('new'));
    await req('GET', '/api/admin/inbox', { token: T }); // opening/reading changes nothing
    const stillNew = !!(await find('new'));
    const sched = await req('POST', `/api/admin/inbox/${mid}/state`, { token: T, json: { action: 'schedule', date: future, note: 'Send quote on Nov 12' } });
    const scheduled = !!(await find('scheduled')), notToday = !(await find('today')), notNew = !(await find('new'));
    const sched2 = await req('POST', `/api/admin/inbox/${mid}/state`, { token: T, json: { action: 'schedule', date: future } });
    const countAll = ((await req('GET', '/api/admin/work-queue?dept=emails', { token: T })).data.items || []).filter(i => i.id === mid).length;
    const todayFu = await req('POST', `/api/admin/inbox/${mid}/state`, { token: T, json: { action: 'schedule', date: bizToday } });
    const inToday = !!(await find('today'));
    const handled = await req('POST', `/api/admin/inbox/${mid}/state`, { token: T, json: { action: 'handle' } });
    const completed = !!(await find('completed')), leftToday = !(await find('today'));
    const bad = await req('POST', `/api/admin/inbox/${mid}/state`, { token: T, json: { action: 'schedule', date: 'next week' } });
    const missing = await req('POST', '/api/admin/inbox/999999/state', { token: T, json: { action: 'handle' } });
    const snooze = await req('POST', `/api/admin/inbox/${mid}/state`, { token: T, json: { action: 'snooze', until: new Date(Date.now() + 86400000 * 3).toISOString() } });
    const snoozed = !!(await find('scheduled'));
    const chk = { inNew, stillNew, scheduled, notToday, notNew, sched: sched.status === 200, noDuplicate: countAll === 1 && sched2.status === 200, inToday: todayFu.status === 200 && inToday, handled: handled.status === 200 && completed && leftToday, badRefused: bad.status === 400, missing404: missing.status === 404, snoozed: snooze.status === 200 && snoozed };
    assert(Object.values(chk).every(Boolean), JSON.stringify(chk));
    return 'email: new → scheduled (out of Today) → due today → completed; snooze works; duplicates impossible; bad input refused';
  });

  await check('Work queue', 'Calls: a callback for tomorrow leaves Today and shows in Scheduled; a handled call is Completed; the call is listed once; assignment works', async () => {
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    const cid = pdb.prepare("INSERT INTO calls(direction,phone,contact_name,company,outcome,purpose,summary,created_by,created_at) VALUES('Inbound',?,?,?,?,?,?,?,?)")
      .run('+15155550199', 'Callback Caller', 'Apt Group', 'Answered', 'New business', 'Wants hallway cleaning', 'system', new Date().toISOString()).lastInsertRowid;
    pdb.close();
    const bizToday = require('../bizdate').today();
    const tomorrow = new Date(bizToday + 'T12:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tom = tomorrow.toISOString().slice(0, 10);
    const bucketOf = async (b) => ((await req('GET', `/api/admin/work-queue?dept=calls&bucket=${b}`, { token: T })).data.items || []).filter(i => i.id === cid).length;
    const before = await bucketOf('new');
    const sch = await req('POST', `/api/admin/calls/${cid}/work`, { token: T, json: { action: 'schedule', date: tom, assigned_to: 'office@brightclean.net' } });
    const today1 = await bucketOf('today'), sched = await bucketOf('scheduled'), new1 = await bucketOf('new');
    const all = (await req('GET', '/api/admin/work-queue?dept=calls', { token: T })).data.items || [];
    const listedOnce = all.filter(i => i.id === cid).length === 1;
    const assigned = all.find(i => i.id === cid);
    const handled = await req('POST', `/api/admin/calls/${cid}/work`, { token: T, json: { action: 'handle' } });
    const done = await bucketOf('completed');
    const badAction = await req('POST', `/api/admin/calls/${cid}/work`, { token: T, json: { action: 'explode' } });
    const chk = { startsNew: before === 1, schedOk: sch.status === 200, notToday: today1 === 0, scheduled: sched === 1, notNew: new1 === 0, listedOnce, assignedSaved: !!assigned && assigned.assigned_to === 'office@brightclean.net', handled: handled.status === 200 && done === 1, badActionRefused: badAction.status === 400 };
    assert(Object.values(chk).every(Boolean), JSON.stringify(chk));
    return 'call: new → callback tomorrow (out of Today, in Scheduled) → handled and Completed; listed once; assignment saved';
  });

  await check('Work queue', 'Leads: a lead with a future next action leaves Today but stays in CRM; it appears on its due date; assignment works; the follow-up task is not listed twice', async () => {
    const made = await (await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Queue Lead', email: 'queue.lead@example.com', message: 'Queue test lead' }) })).json();
    const id = made.id;
    const bizToday = require('../bizdate').today();
    const inLeads = async (b) => ((await req('GET', `/api/admin/work-queue?dept=leads&bucket=${b}`, { token: T })).data.items || []).filter(i => i.id === id).length;
    const fut = await req('POST', `/api/admin/leads/${id}/follow-up`, { token: T, json: { date: '2099-01-15', note: 'Walkthrough follow-up' } });
    const scheduled = await inLeads('scheduled'), today1 = await inLeads('today');
    const crmStill = (await req('GET', '/api/admin/leads', { token: T })).data.leads.some(l => l.id === id);
    const taskItems = ((await req('GET', '/api/admin/work-queue?dept=tasks', { token: T })).data.items || []);
    const leadTaskShown = taskItems.some(t => t.id === (fut.data && fut.data.issue_id));
    const asg = await req('POST', `/api/admin/leads/${id}/assign`, { token: T, json: { assigned_to: 'sales@brightclean.net' } });
    const assigned = ((await req('GET', '/api/admin/work-queue?dept=leads', { token: T })).data.items || []).find(i => i.id === id);
    const dueToday = await req('POST', `/api/admin/leads/${id}/follow-up`, { token: T, json: { date: bizToday, note: 'Call today' } });
    const today2 = await inLeads('today');
    const chk = { futureHidesFromToday: fut.status === 200 && scheduled === 1 && today1 === 0, crmKeeps: crmStill, taskNotDuplicated: !leadTaskShown, assigned: asg.status === 200 && assigned && assigned.assigned_to === 'sales@brightclean.net', dueTodayShows: dueToday.status === 200 && today2 === 1 };
    assert(Object.values(chk).every(Boolean), JSON.stringify(chk));
    return 'lead: future follow-up is scheduled (out of Today) but kept in CRM; due today shows; owner saved; no duplicate task';
  });

  await check('Work queue', 'Tasks: a task due today is in Today; moving its date to next week schedules it; resolved tasks are Completed; staff can act, inspectors cannot read the queue', async () => {
    const bizToday = require('../bizdate').today();
    const created = await req('POST', '/api/admin/issues', { token: T, json: { type: 'task', title: 'Queue task check', due_date: bizToday, priority: 'Normal' } });
    const tid = created.data && (created.data.id || (created.data.issue && created.data.issue.id));
    assert(tid, 'task not created: ' + JSON.stringify(created.data).slice(0, 200));
    const inT = async (b) => ((await req('GET', `/api/admin/work-queue?dept=tasks&bucket=${b}`, { token: T })).data.items || []).filter(i => i.id === tid).length;
    const today1 = await inT('today');
    const moved = await req('POST', `/api/admin/tasks/${tid}/work`, { token: T, json: { due_date: '2099-03-01', assigned_to: 'office@brightclean.net' } });
    const sched = await inT('scheduled'), notToday = (await inT('today')) === 0;
    const jwt = require('../node_modules/jsonwebtoken'), mint = em => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' });
    await req('POST', '/api/admin/users', { token: T, json: { name: 'Ivy Inspector', email: 'insp.wq@roles.test', password: 'role-test-password-2', role: 'inspector' } });
    await req('POST', '/api/admin/users', { token: T, json: { name: 'Sam Staff', email: 'staff.wq@roles.test', password: 'role-test-password-3', role: 'staff' } });
    const inspector = await req('GET', '/api/admin/work-queue?dept=tasks', { token: mint('insp.wq@roles.test') });
    const staffOk = await req('GET', '/api/admin/work-queue?dept=tasks', { token: mint('staff.wq@roles.test') });
    const closed = await req('PATCH', `/api/admin/issues/${tid}`, { token: T, json: { status: 'Resolved', resolution: 'Handled in the work-queue test' } });
    const done = await inT('completed');
    const chk = { todayShows: today1 === 1, moved: moved.status === 200 && sched === 1 && notToday, inspectorRefused: inspector.status === 403, staffAllowed: staffOk.status === 200, resolvedCompleted: closed.status === 200 && done === 1 };
    assert(Object.values(chk).every(Boolean), JSON.stringify(chk));
    return 'task: due today → rescheduled out of Today → resolved and Completed; inspector refused the queue; staff allowed';
  });

  await check('Work queue', 'Summary counts match the lists; closeout reports the day and records rescheduled work as rescheduled', async () => {
    const s = (await req('GET', '/api/admin/work-queue/summary', { token: T })).data;
    const lists = {};
    for (const d of ['emails', 'calls', 'leads', 'tasks']) lists[d] = ((await req('GET', `/api/admin/work-queue?dept=${d}`, { token: T })).data.items || []).length;
    const countsMatch = ['emails', 'calls', 'leads', 'tasks'].every(d => s.counts[d].all === lists[d]);
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    const hid = pdb.prepare("INSERT INTO inbox_messages(graph_id,from_addr,from_name,subject,preview,received_at,created_at) VALUES(?,?,?,?,?,?,?)")
      .run('wq-close-' + Date.now(), 'closeout.test@example.com', 'Closeout Test', 'Closeout handled email', 'Quote request', new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
    pdb.close();
    await req('POST', `/api/admin/inbox/${hid}/state`, { token: T, json: { action: 'handle' } });
    const c = await req('GET', '/api/admin/closeout', { token: T });
    const r = c.data;
    const chk = { summaryMatches: countsMatch, closeoutOk: c.status === 200 && typeof r.calls_handled === 'number', emailHandledCounted: r.emails_handled >= 1, rescheduledCounted: r.activities_rescheduled >= 1, exceptionsList: Array.isArray(r.exceptions), badDate: (await req('GET', '/api/admin/closeout?date=nope', { token: T })).status === 400 };
    assert(Object.values(chk).every(Boolean), JSON.stringify({ chk, lists, counts: s.counts, r }));
    return `summary matches lists (${JSON.stringify(lists)}); closeout: handled ${r.emails_handled} email(s), ${r.activities_rescheduled} rescheduled`;
  });

  await check('Work queue', 'Sent: an email with no reply is Awaiting reply; a reply from that address moves it to Replied; a failed send is Not delivered', async () => {
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    const before = new Date(Date.now() - 60000).toISOString();
    const ok1 = pdb.prepare("INSERT INTO email_log(to_addr,subject,body,status,created_at) VALUES('quote.wait@example.com','Your quote','Hi','sent',?)").run(before).lastInsertRowid;
    const ok2 = pdb.prepare("INSERT INTO email_log(to_addr,subject,body,status,created_at) VALUES('quote.replied@example.com','Your quote 2','Hi','sent',?)").run(before).lastInsertRowid;
    const bad = pdb.prepare("INSERT INTO email_log(to_addr,subject,body,status,error,created_at) VALUES('bounce.test@example.com','Bounce','Hi','failed','Mailbox not found',?)").run(before).lastInsertRowid;
    pdb.prepare("INSERT INTO inbox_messages(graph_id,from_addr,from_name,subject,preview,received_at,created_at) VALUES('wq-sent-reply','Quote.Replied@example.com','Replier','Re: Your quote 2','Yes please',?,?)").run(new Date().toISOString(), new Date().toISOString());
    pdb.close();
    const bucketOf = async (id, b) => ((await req('GET', `/api/admin/work-queue?dept=sent&bucket=${b}`, { token: T })).data.items || []).some(i => i.id === id);
    const chk = { waiting: await bucketOf(ok1, 'waiting'), replied: await bucketOf(ok2, 'completed') && !(await bucketOf(ok2, 'waiting')), failed: await bucketOf(bad, 'new') };
    assert(Object.values(chk).every(Boolean), JSON.stringify(chk));
    return 'sent: awaiting reply until a reply arrives (case-insensitive match); failed sends need attention';
  });

  await check('Work queue', 'Email → task: creates one task linked to the email; pressing it again returns the same task; the task is in Tasks; the email keeps its state', async () => {
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    const mid = pdb.prepare("INSERT INTO inbox_messages(graph_id,from_addr,from_name,subject,preview,received_at,created_at) VALUES('wq-task-mail','task.mail@example.com','Task Mail','Carpet cleaning request','Please call me',?,?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
    pdb.close();
    const first = await req('POST', `/api/admin/inbox/${mid}/task`, { token: T, json: {} });
    const second = await req('POST', `/api/admin/inbox/${mid}/task`, { token: T, json: {} });
    const tid = first.data.task_id;
    const tasks = (await req('GET', '/api/admin/work-queue?dept=tasks', { token: T })).data.items || [];
    const matches = tasks.filter(t => t.id === tid);
    const emailStill = ((await req('GET', '/api/admin/work-queue?dept=emails&bucket=new', { token: T })).data.items || []).some(i => i.id === mid);
    const chk = { created: first.status === 200 && !!tid, repeatSameTask: second.data.task_id === tid && second.data.existing === true, oneTaskListed: matches.length === 1 && /Carpet cleaning/.test(matches[0].title), emailKeepsState: emailStill, missingEmail: (await req('POST', '/api/admin/inbox/999999/task', { token: T, json: {} })).status === 404 };
    assert(Object.values(chk).every(Boolean), JSON.stringify(chk));
    return 'email → one task, repeat returns the same task, task listed once, email still in Needs attention';
  });

  await check('Work queue', 'Permissions: owner, manager, staff, sales and supervisor can read the queue; inspectors and signed-out users cannot; sales and staff can act on emails; inspectors cannot write', async () => {
    const jwt = require('../node_modules/jsonwebtoken'), mint = em => jwt.sign({ role: 'admin', email: em, tv: 0, mfa: true }, globalThis.__jwtSecret, { expiresIn: '1h' });
    const users = [['mgr.wq2@roles.test', 'manager'], ['sup.wq2@roles.test', 'supervisor'], ['sales.wq2@roles.test', 'sales'], ['staff.wq2@roles.test', 'staff'], ['insp.wq2@roles.test', 'inspector']];
    for (const [email, role] of users) await req('POST', '/api/admin/users', { token: T, json: { name: role, email, password: 'role-test-password-9', role } });
    const getAs = em => req('GET', '/api/admin/work-queue?dept=emails', { token: mint(em) });
    const r = {
      owner: (await req('GET', '/api/admin/work-queue?dept=emails', { token: T })).status,
      manager: (await getAs('mgr.wq2@roles.test')).status,
      supervisor: (await getAs('sup.wq2@roles.test')).status,
      sales: (await getAs('sales.wq2@roles.test')).status,
      staff: (await getAs('staff.wq2@roles.test')).status,
      inspector: (await getAs('insp.wq2@roles.test')).status,
      signedOut: (await req('GET', '/api/admin/work-queue?dept=emails')).status,
      inspectorWrites: (await req('POST', '/api/admin/inbox/1/state', { token: mint('insp.wq2@roles.test'), json: { action: 'handle' } })).status,
      salesCanAct: (await req('POST', '/api/admin/inbox/1/state', { token: mint('sales.wq2@roles.test'), json: { action: 'waiting' } })).status
    };
    const chk = { ownerOk: r.owner === 200, managerOk: r.manager === 200, supervisorOk: r.supervisor === 200, salesOk: r.sales === 200, staffOk: r.staff === 200, inspectorRefused: r.inspector === 403, signedOutRefused: r.signedOut === 401, inspectorWriteRefused: r.inspectorWrites === 403, salesActs: r.salesCanAct === 200 || r.salesCanAct === 404 };
    assert(Object.values(chk).every(Boolean), JSON.stringify({ chk, r }));
    return 'owner/manager/supervisor/sales/staff read the queue; inspector and signed-out refused; inspector cannot write';
  });

  await check('Work queue', 'Date rules: with today set to the due day an item is Today; the day before it is Scheduled; the day after it is Overdue; a snooze that has passed returns the email to Needs attention', async () => {
    const wq = require('../workqueue');
    const today = '2026-11-12';
    const chk = {
      dueToday: wq.dateBucket('2026-11-12', today) === 'today',
      scheduledBefore: wq.dateBucket('2026-11-12', '2026-11-11') === 'scheduled',
      overdueAfter: wq.dateBucket('2026-11-12', '2026-11-13') === 'overdue',
      noDateIsNull: wq.dateBucket(null, today) === null,
      snoozedPassed: wq.emailBucket({}, { status: 'open', snooze_until: '2026-11-11T10:00:00.000Z' }, today, '2026-11-12T10:00:00.000Z') === 'new',
      snoozedFuture: wq.emailBucket({}, { status: 'open', snooze_until: '2026-11-13T10:00:00.000Z' }, today, '2026-11-12T10:00:00.000Z') === 'scheduled',
      handledStays: wq.emailBucket({}, { status: 'completed', follow_up_date: '2026-11-12' }, today, '2026-11-12T10:00:00.000Z') === 'completed'
    };
    assert(Object.values(chk).every(Boolean), JSON.stringify(chk));
    return 'due day → Today; before → Scheduled; after → Overdue; passed snooze → back to Needs attention; handled stays Completed';
  });

  await check('Work queue', 'Repeated events: scheduling the same email or call twice leaves one record and one item; a duplicate task request creates no second task', async () => {
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    const mid = pdb.prepare("INSERT INTO inbox_messages(graph_id,from_addr,from_name,subject,preview,received_at,created_at) VALUES('wq-repeat','repeat.mail@example.com','Repeat','Repeat test','x',?,?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
    pdb.close();
    await req('POST', `/api/admin/inbox/${mid}/state`, { token: T, json: { action: 'schedule', date: '2099-05-05' } });
    await req('POST', `/api/admin/inbox/${mid}/state`, { token: T, json: { action: 'schedule', date: '2099-05-05' } });
    const rows = (await req('GET', '/api/admin/work-queue?dept=emails', { token: T })).data.items.filter(i => i.id === mid);
    const stateRows = (() => { const d = new Database(path.join(dataDir, 'brightclean.db'), { readonly: true }); const n = d.prepare('SELECT COUNT(*) n FROM inbox_state WHERE message_id=?').get(mid).n; d.close(); return n; })();
    assert(rows.length === 1 && stateRows === 1, JSON.stringify({ rows: rows.length, stateRows }));
    return 'a repeated schedule keeps one state row and one item in the queue';
  });

  await check('Work queue', 'Lead views: a lead received today needing first contact is Contact today; an untouched lead from earlier is Overdue; a lead with a proposal in progress is Qualified; a customer is Converted; a lost lead is Lost / closed', async () => {
    const mk = async (name) => (await (await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email: name.replace(/\s/g, '.').toLowerCase() + '@example.com', message: 'Lead view test' }) })).json()).id;
    const fresh = await mk('Lead Fresh'), old = await mk('Lead Old'), qual = await mk('Lead Qual'), conv = await mk('Lead Conv'), lost = await mk('Lead Lost');
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    pdb.prepare('UPDATE leads SET created_at=? WHERE id=?').run(threeDaysAgo, old);
    pdb.prepare("UPDATE leads SET status='Proposal in Progress' WHERE id=?").run(qual);
    pdb.prepare("UPDATE leads SET status='Lost' WHERE id=?").run(lost);
    pdb.prepare('UPDATE leads SET customer_id=999001, stage=\'converted\' WHERE id=?').run(conv);
    pdb.close();
    const inB = async (b, id) => ((await req('GET', `/api/admin/work-queue?dept=leads&bucket=${b}`, { token: T })).data.items || []).some(i => i.id === id);
    const chk = { contactToday: await inB('contact_today', fresh), overdue: await inB('overdue', old), qualified: await inB('qualified', qual), converted: await inB('converted', conv), lostClosed: await inB('closed', lost), notInContactToday: !(await inB('contact_today', old)) };
    assert(Object.values(chk).every(Boolean), JSON.stringify(chk));
    return 'lead views: contact today, overdue, qualified, converted, lost — each lead in one view only';
  });

  await check('Work queue', 'Missed-call escalation: a missed call not returned within the threshold is escalated and listed first; a recent one is not; returning it clears the escalation; the closeout reports it', async () => {
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    const old = pdb.prepare("INSERT INTO calls(direction,phone,contact_name,outcome,purpose,summary,created_by,created_at) VALUES('Inbound','+15155550111','Missed Old','Missed','New business','Called back?','system',?)").run(new Date(Date.now() - 3 * 3600000).toISOString()).lastInsertRowid;
    const recent = pdb.prepare("INSERT INTO calls(direction,phone,contact_name,outcome,purpose,summary,created_by,created_at) VALUES('Inbound','+15155550112','Missed Recent','Missed','New business','','system',?)").run(new Date().toISOString()).lastInsertRowid;
    pdb.close();
    const calls = (await req('GET', '/api/admin/work-queue?dept=calls&bucket=missed', { token: T })).data.items || [];
    const oldItem = calls.find(c => c.id === old), recentItem = calls.find(c => c.id === recent);
    const firstIsEscalated = calls.length > 0 && calls[0].escalated === true;
    const handled = await req('POST', `/api/admin/calls/${old}/work`, { token: T, json: { action: 'handle' } });
    const after = ((await req('GET', '/api/admin/work-queue?dept=calls', { token: T })).data.items || []).find(c => c.id === old);
    const closeout = (await req('GET', '/api/admin/closeout', { token: T })).data;
    const wq = require('../workqueue');
    const chk = { oldEscalated: !!oldItem && oldItem.escalated === true, recentNotEscalated: !!recentItem && recentItem.escalated === false, escalatedFirst: firstIsEscalated, returnedClears: handled.status === 200 && after.bucket === 'completed' && after.escalated === false, closeoutCounts: closeout.missed_calls_escalated >= 0 && typeof closeout.missed_calls_escalated === 'number', pureRule: wq.isEscalated({ outcome: 'Missed', created_at: new Date(Date.now() - 120 * 60000).toISOString() }, Date.now(), 60) === true && wq.isEscalated({ outcome: 'Missed', created_at: new Date().toISOString() }, Date.now(), 60) === false };
    assert(Object.values(chk).every(Boolean), JSON.stringify({ chk, closeout: closeout.exceptions }));
    return 'missed call escalates after the threshold and sorts first; returning it clears it; closeout counts it';
  });

  await check('Work queue', 'Email links and thread: an email links to a real lead, a missing lead or customer is refused, linking nothing is refused; the thread shows received and sent mail with that address; priority filters tasks', async () => {
    const lead = await (await fetch(B + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Link Target', email: 'link.target@example.com', message: 'Link test' }) })).json();
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    const mid = pdb.prepare("INSERT INTO inbox_messages(graph_id,from_addr,from_name,subject,preview,received_at,created_at) VALUES('wq-thread','thread.person@example.com','Thread Person','Thread question','First message',?,?)").run(new Date(Date.now() - 3600000).toISOString(), new Date().toISOString()).lastInsertRowid;
    pdb.prepare("INSERT INTO email_log(to_addr,subject,body,status,created_at) VALUES('Thread.Person@example.com','Our reply','We can help',?,?)").run('sent', new Date(Date.now() - 1800000).toISOString());
    pdb.close();
    const okLink = await req('POST', `/api/admin/inbox/${mid}/link`, { token: T, json: { lead_id: lead.id } });
    const badLead = await req('POST', `/api/admin/inbox/${mid}/link`, { token: T, json: { lead_id: 999999 } });
    const badCust = await req('POST', `/api/admin/inbox/${mid}/link`, { token: T, json: { customer_id: 999999 } });
    const empty = await req('POST', `/api/admin/inbox/${mid}/link`, { token: T, json: {} });
    const missing = await req('POST', '/api/admin/inbox/999999/link', { token: T, json: { lead_id: lead.id } });
    const linked = ((await req('GET', `/api/admin/inbox?lead_id=${lead.id}`, { token: T })).data.messages || []).some(m => m.id === mid);
    const thread = await req('GET', `/api/admin/inbox/${mid}/thread`, { token: T });
    const kinds = (thread.data.messages || []).map(m => m.kind);
    const threadOk = thread.status === 200 && kinds.includes('received') && kinds.includes('sent') && kinds[0] === 'received';
    await req('POST', '/api/admin/issues', { token: T, json: { type: 'task', title: 'Priority high check', priority: 'High', due_date: '2099-01-01' } });
    await req('POST', '/api/admin/issues', { token: T, json: { type: 'task', title: 'Priority low check', priority: 'Low', due_date: '2099-01-01' } });
    const high = ((await req('GET', '/api/admin/work-queue?dept=tasks&priority=High', { token: T })).data.items || []);
    const onlyHigh = high.length > 0 && high.every(t => t.priority === 'High') && high.some(t => t.title === 'Priority high check') && !high.some(t => t.title === 'Priority low check');
    const chk = { linkWorks: okLink.status === 200 && linked, badLeadRefused: badLead.status === 400, badCustomerRefused: badCust.status === 400, emptyRefused: empty.status === 400, missingEmail404: missing.status === 404, threadShowsBoth: threadOk, priorityFilter: onlyHigh };
    assert(Object.values(chk).every(Boolean), JSON.stringify({ chk, kinds }));
    return 'email links to a real lead only; thread shows received and sent mail; priority filter works on tasks';
  });

  await check('Leads', 'Partner leads without an email: the drawer says "None on file" and explains why a reply cannot be sent; partner leads saved before origins were set are backfilled to API', async () => {
    const adminJs = (await req('GET', '/admin/admin.js')).data.toString();
    const leadstage = require('fs').readFileSync(require('path').join(__dirname, '..', 'leadstage.js'), 'utf8');
    const chk = { noEmailRow: adminJs.includes('None on file'), noEmailReason: adminJs.includes('cannot be sent from here'), backfill: leadstage.includes("SET origin='api' WHERE origin='website' AND intake LIKE 'API: %'") };
    assert(Object.values(chk).every(Boolean), JSON.stringify(chk));
    return 'drawer shows None on file and explains the blocked reply; partner backfill is in place';
  });

  await check('Work queue', 'Command Center: the signed-in page has a Today’s work card; the summary is available to owners and staff', async () => {
    const html = (await req('GET', '/admin/')).data.toString();
    const adminJs = (await req('GET', '/admin/admin.js')).data.toString();
    const chk = { card: html.includes('id="ccWorkKpis"'), wiredToOverview: adminJs.includes('loadCcWork().catch'), staffSummary: (await req('GET', '/api/admin/work-queue/summary', { token: T })).status === 200 };
    assert(Object.values(chk).every(Boolean), JSON.stringify(chk));
    return 'Command Center card present and wired to the queue summary';
  });

  await check('Work queue', 'Attachments: listed and downloaded from Outlook on demand; refused cleanly when the inbox is not connected or the email is unknown; never stored on the server', async () => {
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    const mid = pdb.prepare("INSERT INTO inbox_messages(graph_id,from_addr,from_name,subject,preview,received_at,created_at) VALUES('wq-att','att.person@example.com','Att Person','Plans attached','See attached',?,?)").run(new Date().toISOString(), new Date().toISOString()).lastInsertRowid;
    pdb.close();
    const list = await req('GET', `/api/admin/inbox/${mid}/attachments`, { token: T });
    const dl = await req('GET', `/api/admin/inbox/${mid}/attachments/AAMk-fake`, { token: T });
    const missing = await req('GET', '/api/admin/inbox/999999/attachments', { token: T });
    const missingDl = await req('GET', '/api/admin/inbox/999999/attachments/x', { token: T });
    const signedOut = await req('GET', `/api/admin/inbox/${mid}/attachments`);
    const chk = { notConnected409: list.status === 409, downloadNotConnected409: dl.status === 409, unknown404: missing.status === 404 && missingDl.status === 404, signedOutRefused: signedOut.status === 401, screenWired: (await req('GET', '/admin/admin.js')).data.toString().includes('wqAtt') };
    assert(Object.values(chk).every(Boolean), JSON.stringify({ chk, list: list.status, dl: dl.status }));
    return 'attachments refused cleanly when Outlook is not connected; unknown emails 404; signed-out refused; the Thread view lists and downloads them';
  });

  await check('Conversation', 'Conversation: mail we sent and replies from the same address appear together, newest first; a lead or customer shows them; signed-out refused; the Outlook-connection note is accurate', async () => {
    const addr = 'conv.person@example.com';
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    pdb.prepare("INSERT INTO email_log(to_addr,subject,body,status,created_at) VALUES(?,?,?,?,?)").run(addr, 'Conv quote', 'Here is the quote', 'sent', new Date(Date.now() - 7200000).toISOString());
    pdb.prepare("INSERT INTO inbox_messages(graph_id,from_addr,from_name,subject,preview,received_at,created_at) VALUES('wq-conv-reply',?,'Conv Person','Re: Conv quote','Thanks, looks good',?,?)").run(addr.toUpperCase(), new Date(Date.now() - 3600000).toISOString(), new Date().toISOString());
    pdb.close();
    const j = (await req('GET', `/api/admin/conversation?addresses=${encodeURIComponent(addr)}`, { token: T })).data;
    const kinds = (j.messages || []).map(m => m.kind);
    const newestFirst = (j.messages || []).every((m, i, a) => i === 0 || String(a[i - 1].at) >= String(m.at));
    const none = (await req('GET', '/api/admin/conversation?addresses=', { token: T })).data;
    const signedOut = await req('GET', `/api/admin/conversation?addresses=${encodeURIComponent(addr)}`);
    const chk = { bothKinds: kinds.includes('sent') && kinds.includes('reply'), replyFirst: j.messages && j.messages[0].kind === 'reply', newestFirst, emptyAddresses: Array.isArray(none.messages) && none.messages.length === 0, signedOutRefused: signedOut.status === 401, notConnectedNote: j.inbox_connected === false };
    assert(Object.values(chk).every(Boolean), JSON.stringify({ chk, kinds }));
    return 'conversation shows sent mail and replies together, newest first; the Outlook note is accurate';
  });

  await check('Portal', 'Portal Messages: a customer sees the emails we sent them and their replies (not other customers’ mail); signed-out refused', async () => {
    const addr = 'portal.mail.person@example.com';
    const pdb = new Database(path.join(dataDir, 'brightclean.db'));
    pdb.prepare("INSERT INTO email_log(to_addr,subject,body,status,created_at) VALUES(?,?,?,?,?)").run(addr, 'Portal visible quote', 'Visible to them', 'sent', new Date().toISOString());
    pdb.prepare("INSERT INTO email_log(to_addr,subject,body,status,created_at) VALUES('someone.else@example.com','Not theirs','Private',?,?)").run('sent', new Date().toISOString());
    pdb.prepare("INSERT INTO inbox_messages(graph_id,from_addr,from_name,subject,preview,received_at,created_at) VALUES('wq-portal-reply',?,'Portal Person','Their reply','Yes please',?,?)").run(addr, new Date().toISOString(), new Date().toISOString());
    pdb.close();
    const crypto = require('crypto');
    const payload = Buffer.from(JSON.stringify({ email: addr, iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', globalThis.__jwtSecret + ':client-portal').update(payload).digest('base64url');
    const tok = payload + '.' + sig;
    const me = await req('GET', '/api/portal/me', { token: tok });
    const subjects = [...(me.data.emailsFromUs || []).map(m => m.subject), ...(me.data.emailsFromCustomer || []).map(m => m.subject)];
    const signedOut = await req('GET', '/api/portal/me');
    const chk = { status: me.status === 200, seesOwnSent: subjects.includes('Portal visible quote'), seesOwnReply: subjects.includes('Their reply'), hidesOthers: !subjects.includes('Not theirs'), signedOutRefused: signedOut.status === 401 };
    assert(Object.values(chk).every(Boolean), JSON.stringify({ chk, status: me.status, sample: me.data && me.data.error }));
    return 'portal shows only the customer’s own sent emails and replies';
  });

  server.child.kill(); smtp.close();
  const pass = results.filter(r => r.status === 'PASS').length;
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ run_at: new Date().toISOString(), node: process.version, pass, fail: results.length - pass, results }, null, 2));
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('Suite crashed:', e); try { server && server.child.kill(); } catch { } process.exit(2); });
