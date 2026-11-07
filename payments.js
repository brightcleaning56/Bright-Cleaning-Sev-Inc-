// Online invoice payments through Stripe Checkout. Off until STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set.
// A customer pays only their own invoice. The invoice is marked paid only when Stripe confirms the payment through a
// signed webhook, and each Stripe payment is recorded once.
const crypto = require('crypto');
module.exports = function mountPayments(app, ctx) {
  const { db, logAction } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS online_payments(id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, stripe_session_id TEXT UNIQUE NOT NULL, amount REAL NOT NULL, email TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS portal_profiles(email TEXT PRIMARY KEY, name TEXT, company TEXT, phone TEXT, notify TEXT, valid_after TEXT, updated_at TEXT)`);
  const now = () => new Date().toISOString();
  const SECRET = () => process.env.JWT_SECRET ? process.env.JWT_SECRET + ':client-portal' : 'dev-portal:client-portal';
  const unsign = tok => {
    const [body, sig] = String(tok || '').split('.'); if (!body || !sig) return null;
    const good = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      const r = db.prepare('SELECT valid_after FROM portal_profiles WHERE email=?').get(p.email);
      if (r && r.valid_after && (!p.iat || p.iat < Date.parse(r.valid_after))) return null;
      return p.exp > Date.now() ? p : null;
    } catch { return null; }
  };
  const base = () => (process.env.PUBLIC_BASE_URL || 'https://brightclean.net').replace(/\/$/, '');
  const money2 = n => Math.round(Number(n || 0) * 100) / 100;

  // The customer starts a payment for one of their own invoices.
  app.post('/api/portal/invoices/:id/pay', async (req, res) => {
    const sess = unsign(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!sess) return res.status(401).json({ error: 'Please sign in again.' });
    const inv = db.prepare("SELECT * FROM invoices WHERE id=? AND lower(email)=?").get(Number(req.params.id), sess.email);
    if (!inv) return res.status(404).json({ error: 'That invoice was not found on your account.' });
    if (['Draft', 'Void', 'Paid'].includes(inv.status)) return res.status(409).json({ error: 'This invoice cannot be paid online right now. Call (515) 303-3024 for help.' });
    const balance = money2(Number(inv.amount || 0) - Number(inv.paid_amount || 0));
    if (!(balance > 0)) return res.status(409).json({ error: 'This invoice is already paid in full.' });
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return res.status(503).json({ error: 'Online payment is not set up yet. Call (515) 303-3024 to pay by phone.' });
    const body = new URLSearchParams({
      mode: 'payment',
      customer_email: sess.email,
      success_url: base() + '/portal.html?paid=' + encodeURIComponent(inv.invoice_number),
      cancel_url: base() + '/portal.html?cancelled=' + encodeURIComponent(inv.invoice_number),
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(Math.round(balance * 100)),
      'line_items[0][price_data][product_data][name]': 'Invoice ' + inv.invoice_number,
      'metadata[invoice_id]': String(inv.id),
      'metadata[invoice_number]': inv.invoice_number,
      'payment_intent_data[metadata][invoice_id]': String(inv.id)
    });
    try {
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) return res.status(502).json({ error: 'The payment page could not be opened. Please try again or call (515) 303-3024.' });
      db.prepare('INSERT INTO online_payments(invoice_id,stripe_session_id,amount,email,status,created_at) VALUES(?,?,?,?,?,?)').run(inv.id, j.id, balance, sess.email, 'Pending', now());
      res.json({ url: j.url });
    } catch (e) { res.status(502).json({ error: 'The payment page could not be opened. Please try again or call (515) 303-3024.' }); }
  });

  // Stripe confirms a payment here. The signature is checked before anything changes.
  app.post('/api/webhooks/stripe', (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !req.rawBody) return res.status(503).json({ error: 'Not configured.' });
    const parts = Object.fromEntries(String(req.headers['stripe-signature'] || '').split(',').map(p => p.split('=')));
    const t = Number(parts.t), v1 = parts.v1;
    if (!t || !v1 || Math.abs(Date.now() / 1000 - t) > 300) return res.status(400).json({ error: 'Bad signature.' });
    const expect = crypto.createHmac('sha256', secret).update(t + '.').update(req.rawBody).digest('hex');
    if (v1.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expect))) return res.status(400).json({ error: 'Bad signature.' });
    const ev = req.body || {};
    if (ev.type !== 'checkout.session.completed') return res.json({ received: true });
    const s = ev.data && ev.data.object || {};
    if (s.payment_status !== 'paid') return res.json({ received: true });
    const invId = Number(s.metadata && s.metadata.invoice_id);
    const amount = money2((Number(s.amount_total) || 0) / 100);
    const tx = db.transaction(() => {
      const prev = db.prepare('SELECT status FROM online_payments WHERE stripe_session_id=?').get(s.id);
      if (prev && prev.status === 'Paid') return 'duplicate';
      const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invId);
      if (!inv) return 'no-invoice';
      const paid = money2(Number(inv.paid_amount || 0) + amount);
      const status = paid >= Number(inv.amount || 0) ? 'Paid' : 'Partially Paid';
      db.prepare('UPDATE invoices SET paid_amount=?, status=? WHERE id=?').run(paid, status, inv.id);
      if (prev) db.prepare("UPDATE online_payments SET status='Paid', paid_at=? WHERE stripe_session_id=?").run(now(), s.id);
      else db.prepare("INSERT INTO online_payments(invoice_id,stripe_session_id,amount,email,status,created_at,paid_at) VALUES(?,?,?,?,?,?,?)").run(inv.id, s.id, amount, s.customer_email || inv.email || '', 'Paid', now(), now());
      try { logAction({ user: { email: 'stripe' } }, 'online payment received', 'invoice', inv.id, `${inv.invoice_number}: $${amount.toFixed(2)} (${status})`); } catch { /* */ }
      return 'ok';
    });
    res.json({ received: true, result: tx() });
  });
};
