// HTTP checks for the email-suppression routes, on a temporary database with a stub sign-in. No mail is sent.
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const express = require(path.join(ROOT, 'node_modules', 'express'));
const ES = require(path.join(ROOT, 'emailsuppress'));
const results = []; const assert = (c, m) => { if (!c) throw new Error(m); };
async function check(name, fn) {
  try { const ev = await fn(); results.push({ name, status: 'PASS', evidence: ev }); console.log('PASS  ' + name); }
  catch (e) { results.push({ name, status: 'FAIL', evidence: e.message }); console.log('FAIL  ' + name + '  -> ' + e.message); }
}

const file = path.join(os.tmpdir(), 'suppress-routes-' + process.pid + '.db');
try { fs.unlinkSync(file); } catch {}
const db = new Database(file);
db.exec(`CREATE TABLE IF NOT EXISTS admin_users(id INTEGER PRIMARY KEY, email TEXT UNIQUE, role TEXT);
  CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);`);
db.prepare("INSERT INTO admin_users(email,role) VALUES('mgr@example.com','manager'),('sales@example.com','sales')").run();

const app = express(); app.use(express.json());
// Stub sign-in: the Bearer value is the email itself. Real sign-in is covered by run-tests.js.
const auth = (req, res, next) => { const e = (req.headers.authorization || '').replace(/^Bearer /, ''); if (!e) return res.status(401).json({ error: 'Authentication required' }); req.user = { email: e }; next(); };
const logAction = (req, action, entity, id, details) => db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run(req.user.email, action, entity, id, details, new Date().toISOString());
ES.mount(app, { db, auth, logAction, adminEmail: 'owner@example.com' });

(async () => {
  const srv = app.listen(0); const base = 'http://127.0.0.1:' + srv.address().port;
  const call = async (method, url, who, body) => {
    const r = await fetch(base + url, { method, headers: { Authorization: who, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  await check('Routes: sign-in is required', async () => {
    const r = await call('GET', '/api/admin/email-suppression', '');
    assert(r.status === 401, 'expected 401, got ' + r.status);
    return '401 when signed out';
  });
  await check('Routes: a sales user can record an opt-out and see it listed', async () => {
    const add = await call('POST', '/api/admin/email-suppression', 'sales@example.com', { email: 'Phone.Optout@Example.com', reason: 'opted_out', detail: 'Asked on the phone' });
    assert(add.status === 201, 'add ' + add.status);
    const list = await call('GET', '/api/admin/email-suppression', 'sales@example.com');
    const row = list.body.addresses.find(a => a.address === 'phone.optout@example.com');
    assert(row && row.reason === 'opted_out' && /Asked not/.test(row.label), 'listed with label');
    return 'added and listed';
  });
  await check('Routes: a bad address or reason is refused', async () => {
    assert((await call('POST', '/api/admin/email-suppression', 'sales@example.com', { email: 'nope', reason: 'opted_out' })).status === 400, 'bad email');
    assert((await call('POST', '/api/admin/email-suppression', 'sales@example.com', { email: 'a@example.com', reason: 'whatever' })).status === 400, 'bad reason');
    return '400 for both';
  });
  await check('Routes: only owner or manager can remove a block', async () => {
    const denied = await call('DELETE', '/api/admin/email-suppression/phone.optout%40example.com', 'sales@example.com');
    assert(denied.status === 403, 'sales delete ' + denied.status);
    assert(ES.isSuppressed(db, 'phone.optout@example.com'), 'still blocked after refused delete');
    const ok = await call('DELETE', '/api/admin/email-suppression/phone.optout%40example.com', 'mgr@example.com');
    assert(ok.status === 200, 'manager delete ' + ok.status);
    assert(!ES.isSuppressed(db, 'phone.optout@example.com'), 'removed');
    const audit = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action IN ('email suppressed','email unblocked')").get().n;
    assert(audit >= 2, 'audit rows ' + audit);
    return 'sales refused, manager removed, audited';
  });
  await check('Routes: an unknown address is reported as not found', async () => {
    const r = await call('DELETE', '/api/admin/email-suppression/nobody%40example.com', 'mgr@example.com');
    assert(r.status === 404, 'expected 404, got ' + r.status);
    return '404';
  });
  srv.close(); db.close();
  try { fs.unlinkSync(file); } catch {} try { fs.unlinkSync(file + '-wal'); } catch {} try { fs.unlinkSync(file + '-shm'); } catch {}
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
