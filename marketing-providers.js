'use strict';
// Google Ads and Meta connections for Marketing, read-only.
// The owner connects each provider once with its sign-in (OAuth 2.0). The token is stored encrypted with
// MARKETING_TOKEN_KEY (AES-256-GCM). Sync copies daily campaign spend into marketing_spend, only for local campaigns
// the owner has linked to a provider campaign ID. Nothing is changed at the provider: no campaign, budget or ad is written.
// Provider credentials and endpoints come from Render environment variables (see docs/MARKETING_PROVIDER_SETUP.md).
const crypto = require('crypto');

const PROVIDERS = {
  google_ads: {
    label: 'Google Ads',
    channel: 'google_ads',
    scopes: ['https://www.googleapis.com/auth/adwords'],
    env: { id: 'GOOGLE_ADS_CLIENT_ID', secret: 'GOOGLE_ADS_CLIENT_SECRET', devToken: 'GOOGLE_ADS_DEVELOPER_TOKEN', loginCustomer: 'GOOGLE_ADS_LOGIN_CUSTOMER_ID' },
    authorize: () => process.env.GOOGLE_ADS_AUTHORIZE_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    token: () => process.env.GOOGLE_ADS_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    api: () => (process.env.GOOGLE_ADS_API_BASE || 'https://googleads.googleapis.com/v26').replace(/\/$/, ''),
  },
  meta_ads: {
    label: 'Meta Ads',
    channel: 'meta_ads',
    scopes: ['ads_read'],
    env: { id: 'META_APP_ID', secret: 'META_APP_SECRET' },
    authorize: () => process.env.META_AUTHORIZE_URL || 'https://www.facebook.com/v23.0/dialog/oauth',
    api: () => (process.env.META_API_BASE || 'https://graph.facebook.com/v23.0').replace(/\/$/, ''),
  },
};

const isProvider = p => Object.prototype.hasOwnProperty.call(PROVIDERS, p);

function mountProviders(app, ctx) {
  const { db, auth, logAction, audit, now = () => new Date().toISOString() } = ctx;
  const base = () => (process.env.PUBLIC_BASE_URL || 'https://brightclean.net').replace(/\/$/, '');
  const redirectFor = p => `${base()}/api/marketing/providers/${p}/callback`;
  const states = new Map();

  const creds = p => { const e = PROVIDERS[p].env; return { id: process.env[e.id] || '', secret: process.env[e.secret] || '', devToken: e.devToken ? process.env[e.devToken] || '' : '', loginCustomer: e.loginCustomer ? process.env[e.loginCustomer] || '' : '' }; };
  const configured = p => { const c = creds(p); return !!(c.id && c.secret && process.env.MARKETING_TOKEN_KEY && (p !== 'google_ads' || c.devToken)); };

  // Encryption: the key is derived from MARKETING_TOKEN_KEY. Without it nothing is stored.
  const key = () => crypto.createHash('sha256').update(String(process.env.MARKETING_TOKEN_KEY || '')).digest();
  const seal = obj => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv), d = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), d]).toString('base64'); };
  const open = s => { try { const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')); } catch { return null; } };

  const row = p => db.prepare('SELECT * FROM marketing_connections WHERE provider=?').get(p);
  // The last sign-in error is kept even when no connection exists yet, so the screen can show why it failed.
  db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  const errKey = p => 'marketing_provider_error_' + p;
  const getErr = p => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(errKey(p)); return r ? r.value : null; };
  const setError = (p, msg) => {
    const text = String(msg || '').slice(0, 300) || null;
    db.prepare('UPDATE marketing_connections SET last_error=?, updated_at=? WHERE provider=?').run(text, now(), p);
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(errKey(p), text || '', now());
  };
  const clearError = p => db.prepare('DELETE FROM settings WHERE key=?').run(errKey(p));

  async function call(url, opts = {}) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = (j.error && (j.error.message || j.error)) || (j.error_description) || ('provider returned ' + r.status);
      // Google Ads puts the specific reason (for example DEVELOPER_TOKEN_NOT_APPROVED) in error details.
      const codes = [];
      try { for (const d of (j.error && j.error.details) || []) for (const e of d.errors || []) { const c = e.errorCode || {}; for (const k of Object.keys(c)) codes.push(k + '=' + c[k]); } } catch { /* keep the message */ }
      throw new Error((String(typeof m === 'object' ? JSON.stringify(m) : m) + (codes.length ? ' [' + codes.join(', ') + ']' : '')).slice(0, 300));
    }
    return j;
  }

  // ----- Token exchange -----
  async function exchangeCode(p, code) {
    const c = creds(p);
    if (p === 'google_ads') {
      const j = await call(PROVIDERS.google_ads.token(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: redirectFor(p), grant_type: 'authorization_code' }) });
      if (!j.access_token) throw new Error('Google did not return a token');
      return { access_token: j.access_token, refresh_token: j.refresh_token || null, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    }
    // Meta: short-lived code -> short-lived token -> long-lived token (about 60 days).
    const api = PROVIDERS.meta_ads.api();
    const short = await call(`${api}/oauth/access_token?` + new URLSearchParams({ client_id: c.id, redirect_uri: redirectFor(p), client_secret: c.secret, code }));
    const long = await call(`${api}/oauth/access_token?` + new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: c.id, client_secret: c.secret, fb_exchange_token: short.access_token }));
    if (!long.access_token) throw new Error('Meta did not return a token');
    return { access_token: long.access_token, refresh_token: null, expires_at: Date.now() + (Number(long.expires_in) || 5184000) * 1000 };
  }

  // Google access tokens expire after an hour; refresh them with the stored refresh token.
  async function freshGoogleToken(t) {
    if (t.access_token && t.expires_at > Date.now() + 60000) return t;
    if (!t.refresh_token) throw new Error('Google connection has no refresh token. Disconnect and connect again.');
    const c = creds('google_ads');
    const j = await call(PROVIDERS.google_ads.token(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: t.refresh_token, client_id: c.id, client_secret: c.secret, grant_type: 'refresh_token' }) });
    return { ...t, access_token: j.access_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  }

  // Finds the account the connection will read. First account only in this release; the label is shown on the screen.
  async function pickAccount(p, token) {
    if (p === 'google_ads') {
      const c = creds(p);
      const j = await call(`${PROVIDERS.google_ads.api()}/customers:listAccessibleCustomers`, { headers: googleHeaders(c, token) });
      const ids = (j.resourceNames || []).map(x => String(x).replace(/^customers\//, ''));
      if (!ids.length) throw new Error('No Google Ads accounts are accessible to this sign-in.');
      // One account is safe to use directly. With several, the owner must choose, because a wrong pick would read another business's spend.
      if (ids.length === 1) return { id: ids[0], label: 'Google Ads customer ' + ids[0] };
      return { id: null, label: 'Google Ads: choose the account to sync' };
    }
    const j = await call(`${PROVIDERS.meta_ads.api()}/me/adaccounts?` + new URLSearchParams({ fields: 'account_id,name', limit: '50', access_token: token.access_token }));
    const list = j.data || [];
    if (!list.length) throw new Error('No Meta ad accounts are available to this sign-in.');
    // Same rule as Google: auto-pick only when there is exactly one account.
    if (list.length > 1) return { id: null, label: 'Meta: choose the ad account to sync' };
    const first = list[0];
    return { id: 'act_' + first.account_id, label: first.name || ('Ad account ' + first.account_id) };
  }
  const googleHeaders = (c, token) => ({ Authorization: 'Bearer ' + token.access_token, 'developer-token': c.devToken, ...(c.loginCustomer ? { 'login-customer-id': c.loginCustomer.replace(/-/g, '') } : {}) });

  // ----- Status (no secrets) -----
  function statusOf(p) {
    const r = row(p);
    const out = { provider: p, label: PROVIDERS[p].label, configured: configured(p), connected: !!r && r.status === 'connected', account_external_id: r ? r.account_external_id : null,
      account_label: r ? r.account_label : null, token_expires_at: r ? r.token_expires_at : null, last_sync_at: r ? r.last_sync_at : null, last_error: r ? r.last_error : null,
      scopes: PROVIDERS[p].scopes, redirect_uri: redirectFor(p) };
    // With no connection, the last sign-in error (if any) is shown instead.
    if (!r) out.last_error = getErr(p);
    return out;
  }

  // ----- Routes -----
  app.get('/api/admin/marketing/providers', auth, (req, res) => res.json({ providers: Object.keys(PROVIDERS).map(statusOf), token_key_set: !!process.env.MARKETING_TOKEN_KEY }));

  app.post('/api/admin/marketing/providers/:p/connect', auth, (req, res) => {
    const p = req.params.p; if (!isProvider(p)) return res.status(404).json({ error: 'Unknown provider' });
    if (!configured(p)) return res.status(503).json({ error: `${PROVIDERS[p].label} is not set up yet. Add its client ID and secret in Render, plus MARKETING_TOKEN_KEY (see docs/MARKETING_PROVIDER_SETUP.md).` });
    const state = crypto.randomBytes(24).toString('hex');
    states.set(state, { provider: p, by: (req.user && req.user.email) || 'owner', exp: Date.now() + 10 * 60000 });
    const c = creds(p);
    const params = p === 'google_ads'
      ? { client_id: c.id, redirect_uri: redirectFor(p), response_type: 'code', scope: PROVIDERS[p].scopes.join(' '), access_type: 'offline', prompt: 'consent', state }
      : { client_id: c.id, redirect_uri: redirectFor(p), response_type: 'code', scope: PROVIDERS[p].scopes.join(','), state };
    audit(req, 'started provider connection', 'provider', null, { provider: p });
    res.json({ url: PROVIDERS[p].authorize() + '?' + new URLSearchParams(params) });
  });

  // Browser return from the provider. Single-use state (10 minutes). No secrets are put in the redirect.
  app.get('/api/marketing/providers/:p/callback', async (req, res) => {
    const p = req.params.p;
    const st = states.get(String(req.query.state || '')); states.delete(String(req.query.state || ''));
    if (!isProvider(p) || !st || st.provider !== p || st.exp < Date.now()) return res.status(400).type('text/plain').send('This sign-in link expired or was already used. Go back to Marketing and connect again.');
    const back = result => res.redirect(`/admin/marketing?provider=${p}&result=${result}`);
    if (req.query.error) { setError(p, 'Sign-in was cancelled or refused.'); return back('refused'); }
    if (!process.env.MARKETING_TOKEN_KEY) { setError(p, 'MARKETING_TOKEN_KEY is not set.'); return back('error'); }
    try {
      const token = await exchangeCode(p, String(req.query.code || ''));
      const account = await pickAccount(p, token);
      db.prepare('DELETE FROM marketing_connections WHERE provider=?').run(p);
      const t = now();
      db.prepare(`INSERT INTO marketing_connections(provider,account_label,account_external_id,status,scopes_json,token_ciphertext,token_expires_at,last_sync_at,last_error,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(p, account.label, account.id, 'connected', JSON.stringify(PROVIDERS[p].scopes), seal(token), new Date(token.expires_at).toISOString(), null, null, t, t);
      if (typeof logAction === 'function') { try { logAction({ user: { email: st.by } }, 'connected ' + PROVIDERS[p].label, 'marketing', null, account.label); } catch { /* audit side-channel only */ } }
      db.prepare('INSERT INTO marketing_audit(actor,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?)').run(st.by, 'connected', 'provider', null, JSON.stringify({ provider: p, account: account.id }), t);
      clearError(p);
      return back('connected');
    } catch (e) {
      setError(p, e.message);
      return back('error');
    }
  });

  app.post('/api/admin/marketing/providers/:p/disconnect', auth, (req, res) => {
    const p = req.params.p; if (!isProvider(p)) return res.status(404).json({ error: 'Unknown provider' });
    db.prepare('DELETE FROM marketing_connections WHERE provider=?').run(p);
    audit(req, 'disconnected', 'provider', null, { provider: p });
    res.json(statusOf(p));
  });

  // Owner links a local campaign to the provider campaign it runs on. Only then does sync write spend for it.
  app.post('/api/admin/marketing/campaigns/:id/link', auth, (req, res) => {
    const id = Number(req.params.id);
    const c = Number.isInteger(id) && id > 0 && db.prepare('SELECT * FROM marketing_campaigns WHERE id=?').get(id);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const b = req.body || {};
    const p = b.provider; if (!isProvider(p)) return res.status(400).json({ error: 'Unknown provider' });
    if (PROVIDERS[p].channel !== c.channel) return res.status(400).json({ error: `This campaign is set to ${c.channel}. Link it to a ${c.channel} campaign.` });
    const pcid = String(b.provider_campaign_id == null ? '' : b.provider_campaign_id).trim().slice(0, 64);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(pcid)) return res.status(400).json({ error: 'Provider campaign ID is required (letters, numbers, dashes only)' });
    const conn = row(p);
    db.prepare('UPDATE marketing_campaigns SET provider=?, provider_account_id=?, provider_campaign_id=?, updated_at=? WHERE id=?').run(p, conn ? conn.account_external_id : null, pcid, now(), id);
    audit(req, 'linked to provider campaign', 'campaign', id, { provider: p, provider_campaign_id: pcid });
    res.json({ campaign: db.prepare('SELECT * FROM marketing_campaigns WHERE id=?').get(id) });
  });

  // Read-only spend sync. Re-running updates today's figures; it never creates a duplicate row.
  async function sync(p) {
    const conn = row(p);
    if (!conn || conn.status !== 'connected') throw new Error(`${PROVIDERS[p].label} is not connected.`);
    if (!conn.account_external_id) throw new Error(`Choose the ${PROVIDERS[p].label} account to sync first.`);
    const linked =db.prepare('SELECT id, provider_campaign_id FROM marketing_campaigns WHERE provider=? AND provider_campaign_id IS NOT NULL').all(p);
    const byProvider = new Map(linked.map(x => [String(x.provider_campaign_id), x.id]));
    let token = open(conn.token_ciphertext); if (!token) throw new Error('Stored token could not be read. Disconnect and connect again.');
    if (p === 'google_ads') token = await freshGoogleToken(token);
    const rows = [];
    if (p === 'google_ads') {
      const c = creds(p);
      const q = 'SELECT campaign.id, segments.date, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS';
      const customerId = conn.account_external_id;
      const batches = await call(`${PROVIDERS.google_ads.api()}/customers/${customerId}/googleAds:searchStream`, { method: 'POST', headers: { ...googleHeaders(c, token), 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
      for (const batch of Array.isArray(batches) ? batches : []) for (const r of batch.results || []) rows.push({ campaign: String(r.campaign.id), date: r.segments.date, amount: Number(r.metrics.costMicros || 0) / 1e6 });
    } else {
      let url = `${PROVIDERS.meta_ads.api()}/${conn.account_external_id}/insights?` + new URLSearchParams({ level: 'campaign', time_increment: '1', date_preset: 'last_30d', fields: 'campaign_id,spend,date_start', limit: '500', access_token: token.access_token });
      for (let page = 0; url && page < 20; page++) {
        const j = await call(url);
        for (const r of j.data || []) rows.push({ campaign: String(r.campaign_id), date: r.date_start, amount: Number(r.spend || 0) });
        url = (j.paging && j.paging.next) || null;
      }
    }
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const batch = 'sync-' + Date.now();
    let written = 0, unmatched = new Set();
    db.transaction(() => {
      for (const r of rows) {
        if (!day.test(r.date || '') || !Number.isFinite(r.amount) || r.amount < 0) continue;
        const campaignId = byProvider.get(r.campaign);
        if (!campaignId) { unmatched.add(r.campaign); continue; }
        db.prepare(`INSERT INTO marketing_spend(campaign_id,provider,spend_date,amount,currency,provider_record_id,import_batch,created_at) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(provider,campaign_id,spend_date,provider_record_id) DO UPDATE SET amount=excluded.amount, import_batch=excluded.import_batch`)
          .run(campaignId, p, r.date, Math.round(r.amount * 100) / 100, 'USD', `${r.campaign}:${r.date}`, batch, now());
        written++;
      }
      db.prepare('UPDATE marketing_connections SET last_sync_at=?, last_error=NULL, updated_at=? WHERE provider=?').run(now(), now(), p);
    })();
    return { provider: p, rows_read: rows.length, rows_written: written, campaigns_linked: byProvider.size, provider_campaigns_not_linked: unmatched.size, batch };
  }

  // Google Ads accounts this sign-in can use, with names. Used by the owner to choose the account to sync.
  async function googleAccountList(conn) {
    let token = open(conn.token_ciphertext); if (!token) throw new Error('Stored token could not be read. Disconnect and connect again.');
    token = await freshGoogleToken(token);
    const c = creds('google_ads');
    const j = await call(`${PROVIDERS.google_ads.api()}/customers:listAccessibleCustomers`, { headers: googleHeaders(c, token) });
    const ids = (j.resourceNames || []).map(x => String(x).replace(/^customers\//, '')).slice(0, 50);
    const out = [];
    for (const id of ids) {
      let name = null, manager = false, note = null;
      try {
        const r = await call(`${PROVIDERS.google_ads.api()}/customers/${id}/googleAds:searchStream`, { method: 'POST', headers: { ...googleHeaders(c, token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'SELECT customer.id, customer.descriptive_name, customer.manager FROM customer LIMIT 1' }) });
        const first = (Array.isArray(r) ? r : []).flatMap(b => b.results || [])[0];
        if (first && first.customer) { name = first.customer.descriptiveName || null; manager = !!first.customer.manager; }
      } catch (e) { note = 'Name not loaded: ' + String(e.message || '').slice(0, 200); }
      out.push({ id, name, manager, note });
    }
    // Client accounts under a manager are not in listAccessibleCustomers, so ask each manager for its clients.
    for (const m of out.filter(a => a.manager)) {
      try {
        const r = await call(`${PROVIDERS.google_ads.api()}/customers/${m.id}/googleAds:searchStream`, { method: 'POST', headers: { ...googleHeaders({ ...c, loginCustomer: m.id }, token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager FROM customer_client' }) });
        const rows = (Array.isArray(r) ? r : []).flatMap(b => b.results || []);
        // Diagnostic: what the manager returned, so the owner can see why clients are missing.
        const diag = 'Manager ' + m.id + ' returned ' + rows.length + ' client row(s) in ' + (Array.isArray(r) ? r.length : 0) + ' batch(es)';
        m.note = (m.note ? m.note + ' ' : '') + diag + '.';
        for (const row of rows) {
          const cc = row.customerClient; if (!cc || !cc.id) continue;
          const cid = String(cc.id);
          if (out.some(a => a.id === cid)) continue;
          out.push({ id: cid, name: cc.descriptiveName || null, manager: !!cc.manager, note: 'Client of manager ' + m.id });
        }
      } catch (e) {
        console.log('[google_ads] client lookup failed for manager ' + m.id + ': ' + String(e.message || '').slice(0, 500));
        m.note = (m.note ? m.note + ' ' : '') + 'Client list not loaded: ' + String(e.message || '').slice(0, 200);
      }
    }
    return out;
  }

  // Reads one client account through the connected manager login. Returns { id, name } or null.
  async function verifiedClient(conn, id, why) {
    let token = open(conn.token_ciphertext); if (!token) return null;
    token = await freshGoogleToken(token);
    const c = creds('google_ads');
    try {
      const r = await call(`${PROVIDERS.google_ads.api()}/customers/${id}/googleAds:searchStream`, { method: 'POST', headers: { ...googleHeaders(c, token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1' }) });
      const first = (Array.isArray(r) ? r : []).flatMap(b => b.results || [])[0];
      if (!first || !first.customer || String(first.customer.id) !== id) return null;
      return { id, name: first.customer.descriptiveName || null };
    } catch (e) { if (why) why.reason = String(e.message || '').slice(0, 300); return null; }
  }

  app.get('/api/admin/marketing/providers/google_ads/accounts', auth, async (req, res) => {
    const conn = row('google_ads');
    if (!conn || conn.status !== 'connected') return res.status(409).json({ error: 'Google Ads is not connected.' });
    try { res.json({ accounts: await googleAccountList(conn), chosen: conn.account_external_id }); }
    catch (e) { res.status(502).json({ error: 'Could not list the Google Ads accounts: ' + e.message }); }
  });

  app.post('/api/admin/marketing/providers/google_ads/account', auth, async (req, res) => {
    const conn = row('google_ads');
    if (!conn || conn.status !== 'connected') return res.status(409).json({ error: 'Google Ads is not connected.' });
    const id = String((req.body || {}).customer_id || '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(id)) return res.status(400).json({ error: 'Choose an account with a 10-digit ID.' });
    try {
      const accounts = await googleAccountList(conn);
      let pick = accounts.find(a => a.id === id);
      if (!pick) {
        // Not in the list: accept a typed client ID only if the API can read it through the manager login.
        const why = {};
        pick = await verifiedClient(conn, id, why);
        if (!pick) return res.status(400).json({ error: 'That account is not available to this sign-in. Check the ID and that it is linked to the manager account.' + (why.reason ? ' Google said: ' + why.reason : '') });
      }
      const label = 'Google Ads ' + (pick.name || 'account') + ' (' + id + ')';
      db.prepare('UPDATE marketing_connections SET account_external_id=?, account_label=?, last_error=NULL, updated_at=? WHERE provider=?').run(id, label, now(), 'google_ads');
      audit(req, 'chose Google Ads account', 'provider', null, { provider: 'google_ads', account: id });
      res.json({ ok: true, account_label: label });
    } catch (e) {
      res.status(502).json({ error: 'Could not save the account: ' + e.message });
    }
  });

  app.post('/api/admin/marketing/providers/:p/sync', auth, async (req, res) => {
    const p = req.params.p; if (!isProvider(p)) return res.status(404).json({ error: 'Unknown provider' });
    try {
      const out = await sync(p);
      audit(req, 'synced spend', 'provider', null, { provider: p, rows_written: out.rows_written });
      res.json(out);
    } catch (e) {
      setError(p, e.message);
      res.status(502).json({ error: 'Sync failed: ' + e.message });
    }
  });
}

module.exports = mountProviders;
module.exports.PROVIDERS = PROVIDERS;
