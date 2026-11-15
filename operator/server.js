// Operator console, Phase A (read-only). Watches each company copy's /api/health and reports
// health, build drift and errors. It never reads customer data. Owner sign-in needs a password and a
// two-step code (the same TOTP helper the customer app uses).
// Run: node operator/server.js   (see render-operator.yaml for the Render service)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');
const bcrypt = require('bcryptjs');
const totp = require('../totp');
const createMailer = require('../postmark');

const REGISTRY = process.env.OPS_REGISTRY || path.join(__dirname, 'companies.json');
const POLL_MS = Number(process.env.OPS_POLL_MS || 5 * 60 * 1000);
const TIMEOUT_MS = Number(process.env.OPS_TIMEOUT_MS || 10000);
const SESSION_MS = 8 * 60 * 60 * 1000;
const COOKIE = 'ops_session';
const SECRET = process.env.OPS_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_EMAIL = String(process.env.OPS_ADMIN_EMAIL || '').trim().toLowerCase();
const PASSWORD_HASH = process.env.OPS_PASSWORD_HASH || '';
const TOTP_SECRET = process.env.OPS_TOTP_SECRET || '';
const ALERT_TO = process.env.OPS_ALERT_EMAIL || '';
const mailer = process.env.POSTMARK_TOKEN
  ? createMailer(process.env.POSTMARK_TOKEN, { apiUrl: process.env.POSTMARK_API_URL, stream: process.env.POSTMARK_STREAM })
  : null;

const state = new Map();      // slug -> last check result
const attempts = new Map();   // ip -> { n, since } for sign-in throttling
let lastRun = null;

function loadRegistry() {
  const data = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  return Array.isArray(data.companies) ? data.companies : [];
}

// One company: call its health endpoint and describe what it reports.
async function checkOne(c) {
  const out = {
    slug: c.slug, name: c.name, checked_at: new Date().toISOString(), http: null, ok: false,
    db: null, build: null, expected_build: c.expected_build || null, build_match: null,
    errors_1h: null, uptime_s: null, problem: ''
  };
  try {
    const r = await fetch(c.health_url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    out.http = r.status;
    const j = await r.json().catch(() => ({}));
    out.db = j.db || null;
    out.build = j.build || null;
    out.errors_1h = typeof j.errors_1h === 'number' ? j.errors_1h : null;
    out.uptime_s = typeof j.uptime_s === 'number' ? j.uptime_s : null;
    out.ok = r.status === 200 && j.ok === true && j.db === 'ok';
    out.build_match = out.expected_build ? out.build === out.expected_build : null;
    if (!out.ok) out.problem = 'Health check failed (HTTP ' + r.status + ')';
    else if (out.build_match === false) out.problem = 'Running build ' + out.build + ', expected ' + out.expected_build;
    else if (out.errors_1h > 0) out.problem = out.errors_1h + ' error(s) in the last hour';
  } catch (e) {
    out.problem = 'Cannot reach the system: ' + (e && e.name === 'TimeoutError' ? 'timed out' : (e && e.message) || 'unknown error');
  }
  return out;
}

async function notify(result, previousProblem) {
  const subject = result.problem
    ? 'Bright Clean operator: ' + result.name + ' needs attention'
    : 'Bright Clean operator: ' + result.name + ' is back to normal';
  const text = result.problem ? result.name + ': ' + result.problem + '\nChecked ' + result.checked_at : 'Previous problem: ' + previousProblem;
  if (!mailer || !ALERT_TO) { console.log('[operator] alert (no mailer configured):', subject); return; }
  try {
    await mailer.sendMail({ from: process.env.FROM_EMAIL || ALERT_TO, to: ALERT_TO, subject, text });
  } catch (e) { console.error('[operator] alert failed:', e.message); }
}

// Checks every company, stores the result, and emails only when a company's problem changes.
async function pollAll(companies = loadRegistry()) {
  const results = await Promise.all(companies.map(checkOne));
  for (const r of results) {
    const prev = state.get(r.slug);
    const prevProblem = prev ? prev.problem : '';
    state.set(r.slug, r);
    if (r.problem !== prevProblem) await notify(r, prevProblem);
  }
  lastRun = new Date().toISOString();
  return results;
}

// ---- sign-in and sessions -------------------------------------------------------------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [body, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function throttled(ip) {
  const now = Date.now(), a = attempts.get(ip);
  if (!a || now - a.since > 15 * 60 * 1000) return false;
  return a.n >= 10;
}
function failed(ip) {
  const now = Date.now(), a = attempts.get(ip);
  if (!a || now - a.since > 15 * 60 * 1000) attempts.set(ip, { n: 1, since: now });
  else a.n += 1;
}

async function signIn(req, body) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (throttled(ip)) return { status: 429, error: 'Too many attempts. Wait 15 minutes and try again.' };
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const code = String(body.code || '').replace(/\s/g, '');
  const okPassword = !!ADMIN_EMAIL && email === ADMIN_EMAIL && !!PASSWORD_HASH && await bcrypt.compare(password, PASSWORD_HASH);
  const okCode = !!TOTP_SECRET && totp.verify(TOTP_SECRET, code);
  if (!okPassword || !okCode) { failed(ip); return { status: 401, error: 'Sign-in failed. Check the email, password and code.' }; }
  attempts.delete(ip);
  return { status: 200, cookie: COOKIE + '=' + sign({ e: email, exp: Date.now() + SESSION_MS }) + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800' + (process.env.NODE_ENV === 'production' ? '; Secure' : '') };
}

// ---- pages ----------------------------------------------------------------------------
const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Operator sign-in</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:32px max(16px,env(safe-area-inset-right,0px)) 32px max(16px,env(safe-area-inset-left,0px));background:#f2f5f9;color:#10263e}main{max-width:380px;margin:0 auto;background:#fff;border:1px solid #dfe6ee;border-radius:14px;padding:20px}label{display:block;margin:12px 0 4px}input{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #c8d2dc;border-radius:8px}button{margin-top:16px;width:100%;font:inherit;font-weight:600;padding:12px;border:0;border-radius:8px;background:#0f2741;color:#fff}.err{color:#b3261e;min-height:1.5em}</style></head>
<body><main><h1 style="font-size:1.3rem;margin:0 0 8px">Operator sign-in</h1><p style="color:#5d728a;margin:0 0 8px">Owner only. Enter your password and the code from your authenticator app.</p>
<form id="f" method="post" action="/ops/login" autocomplete="off"><label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username"><label for="p">Password</label><input id="p" name="password" type="password" required autocomplete="current-password"><label for="c">Two-step code</label><input id="c" name="code" inputmode="numeric" pattern="[0-9 ]*" required><button>Sign in</button><p class="err" id="err"></p></form></main>
<script>document.getElementById('f').addEventListener('submit',async function(ev){ev.preventDefault();var f=new FormData(this);var r=await fetch('/ops/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(f))});if(r.ok){location.href='/';}else{var j=await r.json().catch(function(){return{}});document.getElementById('err').textContent=j.error||'Sign-in failed.';}});</script></body></html>`;

const BOARD_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Operator console</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:20px max(16px,env(safe-area-inset-left,0px));background:#f2f5f9;color:#10263e}h1{font-size:1.4rem;margin:0 0 4px}.muted{color:#5d728a;font-size:14px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dfe6ee;border-radius:12px;overflow:hidden;margin-top:16px}th,td{text-align:left;padding:10px;border-bottom:1px solid #eef2f6;vertical-align:top}th{font-size:13px;color:#5d728a;font-weight:600}.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:13px;font-weight:600}.ok{background:#e5f4e4;color:#17904c}.bad{background:#fbebeb;color:#d1382f}.warn{background:#f9eeda;color:#b7791f}.wrap{overflow-x:auto}button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #c8d2dc;background:#fff;cursor:pointer}</style></head>
<body><h1>Operator console</h1><p class="muted">Read-only. Checks each company's health and build every few minutes. Customer data is never opened here. Last run: <span id="last">—</span> <button id="poll">Check now</button> <button id="out">Sign out</button></p>
<div class="wrap"><table><thead><tr><th>Company</th><th>Status</th><th>Build</th><th>Database</th><th>Errors (1 h)</th><th>Problem</th><th>Checked</th></tr></thead><tbody id="rows"><tr><td colspan="7" class="muted">Loading…</td></tr></tbody></table></div>
<script>
function cell(t){var td=document.createElement('td');td.textContent=t==null?'—':String(t);return td;}
async function load(){var r=await fetch('/api/status',{cache:'no-store'});if(r.status===401){location.href='/ops/login';return;}var j=await r.json();document.getElementById('last').textContent=j.last_run?new Date(j.last_run).toLocaleString():'not yet';var tb=document.getElementById('rows');tb.textContent='';
if(!j.companies.length){var e=document.createElement('tr');e.appendChild(cell('No companies in the registry yet.'));tb.appendChild(e);return;}
j.companies.forEach(function(c){var tr=document.createElement('tr');tr.appendChild(cell(c.name));var st=document.createElement('td');var b=document.createElement('span');b.className='badge '+(c.ok&&!c.problem?'ok':(c.ok?'warn':'bad'));b.textContent=c.ok&&!c.problem?'Running':(c.ok?'Check':'Down');st.appendChild(b);tr.appendChild(st);
var bu=cell(c.build||'—');if(c.build_match===false)bu.textContent=(c.build||'—')+' (expected '+c.expected_build+')';tr.appendChild(bu);tr.appendChild(cell(c.db));tr.appendChild(cell(c.errors_1h));tr.appendChild(cell(c.problem||'None'));tr.appendChild(cell(c.checked_at?new Date(c.checked_at).toLocaleTimeString():'—'));tb.appendChild(tr);});}
document.getElementById('poll').onclick=async function(){this.disabled=true;await fetch('/api/poll',{method:'POST'});this.disabled=false;load();};
document.getElementById('out').onclick=async function(){await fetch('/ops/logout',{method:'POST'});location.href='/ops/login';};
load();setInterval(load,60000);
</script></body></html>`;

// ---- HTTP -----------------------------------------------------------------------------
function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', () => {
      if ((req.headers['content-type'] || '').includes('json')) { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } }
      else resolve(querystring.parse(raw));
    });
    req.on('error', () => resolve({}));
  });
}

function handler(req, res) {
  const url = new URL(req.url, 'http://operator.local');
  const p = url.pathname;
  if (p === '/ops/health' && req.method === 'GET') return send(res, 200, { ok: true, companies: state.size, last_run: lastRun });
  if (p === '/ops/login' && req.method === 'GET') return send(res, 200, LOGIN_HTML, 'text/html; charset=utf-8');
  if (p === '/ops/login' && req.method === 'POST') {
    return readBody(req).then(async (body) => {
      const r = await signIn(req, body);
      if (r.error) return send(res, r.status, { error: r.error });
      send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': r.cookie });
    });
  }
  if (p === '/ops/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': COOKIE + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (p === '/' && req.method === 'GET') {
    if (!readSession(req)) { res.writeHead(302, { Location: '/ops/login' }); return res.end(); }
    return send(res, 200, BOARD_HTML, 'text/html; charset=utf-8');
  }
  if (p === '/api/status' && req.method === 'GET') {
    if (!readSession(req)) return send(res, 401, { error: 'Sign in first.' });
    const companies = loadRegistry().map(c => state.get(c.slug) || { slug: c.slug, name: c.name, ok: false, problem: 'Not checked yet', expected_build: c.expected_build || null, build: null, db: null, errors_1h: null, checked_at: null });
    return send(res, 200, { last_run: lastRun, companies });
  }
  if (p === '/api/poll' && req.method === 'POST') {
    if (!readSession(req)) return send(res, 401, { error: 'Sign in first.' });
    return pollAll().then(results => send(res, 200, { ok: true, checked: results.length }));
  }
  send(res, 404, { error: 'Not found.' });
}

function startServer(port = Number(process.env.PORT || 3100)) {
  const server = http.createServer((req, res) => {
    try { handler(req, res); } catch (e) { console.error('[operator]', e.message); send(res, 500, { error: 'Something went wrong.' }); }
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

module.exports = { checkOne, pollAll, startServer, readSession, state };

if (require.main === module) {
  startServer().then(() => {
    console.log('[operator] listening; polling every ' + Math.round(POLL_MS / 1000) + ' s');
    pollAll().catch(e => console.error('[operator] first check failed:', e.message));
    setInterval(() => pollAll().catch(e => console.error('[operator] check failed:', e.message)), POLL_MS).unref?.();
  });
}
