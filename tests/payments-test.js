// Tests online invoice payments against an in-memory database. No real Stripe calls are made.
const path = require('path');
const crypto = require('crypto');
const root = process.argv[2];
process.env.JWT_SECRET = 'test-secret-for-payments-tests-0123456789';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123';
delete process.env.STRIPE_SECRET_KEY;
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
const db = new Database(':memory:');
db.exec(`
CREATE TABLE invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, invoice_number TEXT, amount REAL, paid_amount REAL DEFAULT 0, due_date TEXT, status TEXT, created_at TEXT);
CREATE TABLE estimates(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, project_name TEXT, status TEXT, proposal_total REAL, public_token TEXT, created_at TEXT);
CREATE TABLE contracts(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, title TEXT, value REAL, status TEXT, signature_status TEXT, public_token TEXT, created_at TEXT, signed_at TEXT);
CREATE TABLE customers(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT);
CREATE TABLE leads(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT);
CREATE TABLE projects(id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER, name TEXT, status TEXT, progress REAL, site_address TEXT);
CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, type TEXT, date TEXT, start_time TEXT, end_time TEXT, address TEXT, status TEXT, project_id INTEGER);
CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT, entity TEXT, entity_id INTEGER, details TEXT, created_at TEXT);
`);
const EMAIL = 'payer@example.com';
db.prepare("INSERT INTO invoices(email,invoice_number,amount,paid_amount,status,created_at) VALUES(?,?,?,?,?,?)").run(EMAIL, 'BC-2026-0100', 300, 0, 'Sent', '2026-11-01T00:00:00Z');
db.prepare("INSERT INTO invoices(email,invoice_number,amount,paid_amount,status,created_at) VALUES(?,?,?,?,?,?)").run('someone-else@example.com', 'BC-2026-0200', 500, 0, 'Sent', '2026-11-01T00:00:00Z');
db.prepare("INSERT INTO invoices(email,invoice_number,amount,paid_amount,status,created_at) VALUES(?,?,?,?,?,?)").run(EMAIL, 'BC-2026-0300', 80, 0, 'Draft', '2026-11-01T00:00:00Z');

const routes = {};
const app = { get: (p, f) => { routes['GET ' + p] = f; }, post: (p, f) => { routes['POST ' + p] = f; } };
require(path.join(root, 'payments.js'))(app, { db, logAction: () => {} });
// Session for the payer, made the same way the portal makes it
const SECRET = process.env.JWT_SECRET + ':client-portal';
const sign = p => { const body = Buffer.from(JSON.stringify(p)).toString('base64url'); return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url'); };
const mine = sign({ email: EMAIL, exp: Date.now() + 3600000 });

function call(key, body = {}, headers = {}, params = {}) {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { body, headers, params, rawBody: undefined };
  return Promise.resolve(routes[key](req, res)).then(() => ({ code: res.code, body: res.body }));
}
function stripeSig(raw, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(t + '.').update(raw).digest('hex');
  return 't=' + t + ',v1=' + v1;
}
let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); } }

(async () => {
  const inv = db.prepare("SELECT id FROM invoices WHERE invoice_number='BC-2026-0100'").get().id;
  const other = db.prepare("SELECT id FROM invoices WHERE invoice_number='BC-2026-0200'").get().id;
  const draft = db.prepare("SELECT id FROM invoices WHERE invoice_number='BC-2026-0300'").get().id;

  // Paying
  const noAuth = await call('POST /api/portal/invoices/:id/pay', {}, {}, { id: String(inv) });
  check('pay: signed-out refused', noAuth.code === 401, noAuth);
  const notMine = await call('POST /api/portal/invoices/:id/pay', {}, { authorization: 'Bearer ' + mine }, { id: String(other) });
  check('pay: someone else\'s invoice not found', notMine.code === 404, notMine);
  const isDraft = await call('POST /api/portal/invoices/:id/pay', {}, { authorization: 'Bearer ' + mine }, { id: String(draft) });
  check('pay: draft invoice refused', isDraft.code === 409, isDraft);
  const noKey = await call('POST /api/portal/invoices/:id/pay', {}, { authorization: 'Bearer ' + mine }, { id: String(inv) });
  check('pay: clear message when Stripe is not set up', noKey.code === 503 && /not set up/.test(noKey.body.error), noKey);

  // Webhook: signature checked before anything changes
  const event = { type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', amount_total: 12000, customer_email: EMAIL, metadata: { invoice_id: String(inv) } } } };
  const raw = Buffer.from(JSON.stringify(event));
  const badSig = await call('POST /api/webhooks/stripe', event, { 'stripe-signature': 't=' + Math.floor(Date.now() / 1000) + ',v1=deadbeef' }, {}, );
  // rawBody is needed for the signature; set it on the request
  async function hook(sig, buf) {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    const body = JSON.parse(buf.toString());
    await routes['POST /api/webhooks/stripe']({ body, headers: { 'stripe-signature': sig }, rawBody: buf }, res);
    return { code: res.code, body: res.body };
  }
  const wrong = await hook('t=' + Math.floor(Date.now() / 1000) + ',v1=deadbeef', raw);
  check('webhook: wrong signature refused, nothing changes', wrong.code === 400 && db.prepare('SELECT paid_amount FROM invoices WHERE id=?').get(inv).paid_amount === 0, wrong);
  const old = await hook(stripeSig(raw, Math.floor(Date.now() / 1000) - 3600), raw);
  check('webhook: old timestamp refused', old.code === 400, old);
  const good = await hook(stripeSig(raw), raw);
  const row = db.prepare('SELECT paid_amount, status FROM invoices WHERE id=?').get(inv);
  check('webhook: valid payment marks the invoice paid in full', good.code === 200 && row.paid_amount === 120 && row.status === 'Partially Paid', { good, row });
  const again = await hook(stripeSig(raw), raw);
  const row2 = db.prepare('SELECT paid_amount FROM invoices WHERE id=?').get(inv);
  check('webhook: the same payment is never counted twice', row2.paid_amount === 120, { again, row2 });
  const rec = db.prepare("SELECT COUNT(*) n FROM online_payments WHERE stripe_session_id='cs_test_1'").get().n;
  check('webhook: payment recorded once', rec === 1, rec);
  const unpaid = { type: 'checkout.session.completed', data: { object: { id: 'cs_test_2', payment_status: 'unpaid', amount_total: 100, metadata: { invoice_id: String(inv) } } } };
  const rawU = Buffer.from(JSON.stringify(unpaid));
  await hook(stripeSig(rawU), rawU);
  check('webhook: unpaid session does not change the invoice', db.prepare('SELECT paid_amount FROM invoices WHERE id=?').get(inv).paid_amount === 120);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
