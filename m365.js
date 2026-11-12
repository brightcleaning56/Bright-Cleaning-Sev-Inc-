// Microsoft 365 (Outlook) inbox, read-only. Owner connects once with Microsoft sign-in (OAuth 2.0 authorization code);
// the refresh token is stored encrypted. Every few minutes new inbox messages are copied (sender, subject, preview, link)
// and matched to the lead / customer with that email address. Permissions: Mail.Read, User.Read, offline_access only.
const crypto = require('crypto');
module.exports = function mountM365(app, ctx) {
  const { db, auth, logAction, adminEmail } = ctx, now = () => new Date().toISOString();
  db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS inbox_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, graph_id TEXT UNIQUE NOT NULL, from_addr TEXT, from_name TEXT, subject TEXT, preview TEXT,
      received_at TEXT, conversation_id TEXT, web_link TEXT, lead_id INTEGER, customer_id INTEGER, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS inbox_from ON inbox_messages(from_addr); CREATE INDEX IF NOT EXISTS inbox_recv ON inbox_messages(received_at);`);
  const cfg = () => ({ id: process.env.MS365_CLIENT_ID || '', secret: process.env.MS365_CLIENT_SECRET || '', tenant: process.env.MS365_TENANT_ID || 'organizations',
    login: (process.env.MS365_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/$/, ''), graph: (process.env.MS365_GRAPH_BASE || 'https://graph.microsoft.com').replace(/\/$/, '') });
  const configured = () => !!(cfg().id && cfg().secret);
  const base = () => (process.env.PUBLIC_BASE_URL || 'https://brightclean.net').replace(/\/$/, '');
  const redirect = () => `${base()}/api/m365/callback`;
  const SCOPES = 'offline_access User.Read Mail.Read';
  const getS = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
  const setS = (k, v) => db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(k, v, now());
  const key = () => crypto.createHash('sha256').update(String(process.env.JWT_SECRET || '') + '|m365').digest();
  const enc = obj => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv), d = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), d]).toString('base64'); };
  const dec = s => { try { const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')); } catch { return null; } };
  const tok = () => { const v = getS('m365_token'); return v ? dec(v) : null; };
  const roleOf = req => { const e = String((req.user && req.user.email) || '').toLowerCase(), ow = String(adminEmail || '').toLowerCase(); if (!ow || e === ow) return 'owner'; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return (r && r.role) || 'staff'; };
  const states = new Map();
  async function tokenRequest(params) {
    const c = cfg(), r = await fetch(`${c.login}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, redirect_uri: redirect(), scope: SCOPES, ...params }) });
    const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) throw new Error(j.error_description ? String(j.error_description).split('\r\n')[0].slice(0, 200) : 'Microsoft sign-in failed (' + r.status + ')');
    return j;
  }
  async function accessToken() {
    const t = tok(); if (!t) throw new Error('Not connected');
    if (t.at && t.exp > Date.now() + 60000) return t.at;
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.rt });
    const nt = { ...t, at: j.access_token, rt: j.refresh_token || t.rt, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    setS('m365_token', enc(nt)); return nt.at;
  }
  const graph = async path => { const at = await accessToken(), r = await fetch(cfg().graph + path, { headers: { Authorization: 'Bearer ' + at, Prefer: 'outlook.body-content-type="text"' } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j.error && j.error.message) || 'Microsoft Graph ' + r.status); return j; };
  function match(addr) {
    const a = String(addr || '').toLowerCase(); if (!a) return {};
    const lead = db.prepare("SELECT id FROM leads WHERE lower(email)=? ORDER BY CASE WHEN status IN ('Won','Lost','Archived') THEN 1 ELSE 0 END, id DESC LIMIT 1").get(a);
    let cu = db.prepare('SELECT id FROM customers WHERE lower(email)=? LIMIT 1').get(a);
    if (!cu) { try { cu = db.prepare('SELECT customer_id id FROM customer_contacts WHERE lower(email)=? LIMIT 1').get(a); } catch { /* table may not exist */ } }
    return { lead_id: lead ? lead.id : null, customer_id: cu ? cu.id : null };
  }
  let syncing = false;
  async function sync() {
    if (syncing || !configured() || !tok()) return { skipped: true }; syncing = true;
    try {
      const since = getS('m365_last_received') || new Date(Date.now() - 14 * 864e5).toISOString();
      const q = `/v1.0/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime asc&$select=id,subject,from,receivedDateTime,bodyPreview,conversationId,webLink&$filter=receivedDateTime ge ${since}`;
      const j = await graph(q); let added = 0, last = since;
      for (const m of j.value || []) {
        const from = (m.from && m.from.emailAddress) || {}, mm = match(from.address);
        const r = db.prepare('INSERT OR IGNORE INTO inbox_messages(graph_id,from_addr,from_name,subject,preview,received_at,conversation_id,web_link,lead_id,customer_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(String(m.id).slice(0, 300), String(from.address || '').toLowerCase().slice(0, 254), String(from.name || '').slice(0, 150), String(m.subject || '').slice(0, 300), String(m.bodyPreview || '').slice(0, 1000), m.receivedDateTime, m.conversationId || null, /^https:\/\//.test(m.webLink || '') ? m.webLink : null, mm.lead_id, mm.customer_id, now());
        if (r.changes) { added++; try { require('./emailsuppress').onInbound(db, from.address, m.subject, m.bodyPreview); } catch (e) { console.error('reply tracking failed', e.message); } db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run('Outlook inbox', 'email received', mm.lead_id ? 'lead' : mm.customer_id ? 'customer' : 'email', mm.lead_id || mm.customer_id || 0, `${from.address || ''}: ${String(m.subject || '').slice(0, 120)}`, now()); }
        if (m.receivedDateTime > last) last = m.receivedDateTime;
      }
      setS('m365_last_received', last); setS('m365_last_sync', now()); setS('m365_last_error', '');
      return { added };
    } catch (e) { setS('m365_last_error', String(e.message).slice(0, 300)); if (ctx.monitoring && ctx.monitoring.recordError) ctx.monitoring.recordError('m365', { message: e.message }); return { error: e.message }; }
    finally { syncing = false; }
  }
  const t = setInterval(sync, Number(process.env.MS365_SYNC_MS || 180000)); t.unref && t.unref();

  app.get('/api/admin/m365/status', auth, (req, res) => {
    const tk = tok();
    res.json({ configured: configured(), connected: !!tk, account: tk ? tk.account : null, last_sync: getS('m365_last_sync'), last_error: getS('m365_last_error') || null,
      messages: db.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n, redirect_uri: redirect(), scopes: SCOPES.split(' ') });
  });
  app.post('/api/admin/m365/connect', auth, (req, res) => {
    if (!['owner', 'manager'].includes(roleOf(req))) return res.status(403).json({ error: 'Only an owner or manager can connect the company inbox.' });
    if (!configured()) return res.status(503).json({ error: 'Microsoft 365 is not set up yet: add MS365_CLIENT_ID, MS365_CLIENT_SECRET and MS365_TENANT_ID in Render (see Settings → Microsoft 365 for the steps).' });
    const state = crypto.randomBytes(24).toString('hex'); states.set(state, { by: req.user && req.user.email, exp: Date.now() + 10 * 60000 });
    const c = cfg(), u = `${c.login}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/authorize?` + new URLSearchParams({ client_id: c.id, response_type: 'code', redirect_uri: redirect(), response_mode: 'query', scope: SCOPES, state, prompt: 'select_account' });
    res.json({ url: u });
  });
  app.get('/api/m365/callback', async (req, res) => {
    const st = states.get(String(req.query.state || '')); states.delete(String(req.query.state || ''));
    const back = msg => res.redirect('/admin/#settings' + (msg ? '' : ''));
    if (!st || st.exp < Date.now()) return res.status(400).type('text/plain').send('This sign-in link expired or was already used. Go back to Settings and click Connect Outlook again.');
    if (req.query.error) { setS('m365_last_error', String(req.query.error_description || req.query.error).slice(0, 300)); return back(); }
    try {
      const j = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code || '') });
      const me = await (await fetch(cfg().graph + '/v1.0/me', { headers: { Authorization: 'Bearer ' + j.access_token } })).json().catch(() => ({}));
      setS('m365_token', enc({ at: j.access_token, rt: j.refresh_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, account: me.mail || me.userPrincipalName || 'connected', by: st.by, at_connect: now() }));
      setS('m365_last_error', '');
      db.prepare('INSERT INTO audit_log(actor,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run(st.by || 'owner', 'connected Outlook inbox', 'settings', 0, me.mail || me.userPrincipalName || '', now());
      sync().catch(() => {}); return back();
    } catch (e) { setS('m365_last_error', String(e.message).slice(0, 300)); return back(); }
  });
  app.post('/api/admin/m365/sync', auth, async (req, res) => { if (!tok()) return res.status(409).json({ error: 'The Outlook inbox is not connected.' }); res.json(await sync()); });
  app.post('/api/admin/m365/disconnect', auth, (req, res) => {
    if (roleOf(req) !== 'owner') return res.status(403).json({ error: 'Only the owner can disconnect the company inbox.' });
    db.prepare("DELETE FROM settings WHERE key IN ('m365_token')").run(); logAction(req, 'disconnected Outlook inbox', 'settings', 0, ''); res.json({ ok: true });
  });
  app.get('/api/admin/inbox', auth, (req, res) => {
    const w = [], a = []; for (const k of ['lead_id', 'customer_id']) if (req.query[k]) { w.push(`${k}=?`); a.push(Number(req.query[k])); }
    res.json({ messages: db.prepare(`SELECT id, from_addr, from_name, subject, preview, received_at, web_link, lead_id, customer_id FROM inbox_messages ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY received_at DESC LIMIT 200`).all(...a) });
  });
  // Attachments are read from Outlook when someone asks for them; nothing is copied to the server.
  const inboxGraphId = id => db.prepare('SELECT graph_id FROM inbox_messages WHERE id=?').get(Number(id));
  app.get('/api/admin/inbox/:id/attachments', auth, async (req, res) => {
    const m = inboxGraphId(req.params.id); if (!m) return res.status(404).json({ error: 'Email not found.' });
    if (!tok()) return res.status(409).json({ error: 'The Outlook inbox is not connected, so attachments cannot be opened.' });
    try {
      const j = await graph('/v1.0/me/messages/' + encodeURIComponent(m.graph_id) + '/attachments?$select=id,name,contentType,size,isInline');
      res.json({ attachments: (j.value || []).filter(a => !a.isInline).map(a => ({ id: a.id, name: a.name || 'attachment', content_type: a.contentType || 'application/octet-stream', size: a.size || 0 })) });
    } catch (e) { res.status(502).json({ error: 'Could not load the attachments: ' + e.message }); }
  });
  app.get('/api/admin/inbox/:id/attachments/:aid', auth, async (req, res) => {
    const m = inboxGraphId(req.params.id); if (!m) return res.status(404).json({ error: 'Email not found.' });
    if (!tok()) return res.status(409).json({ error: 'The Outlook inbox is not connected, so attachments cannot be opened.' });
    try {
      const a = await graph('/v1.0/me/messages/' + encodeURIComponent(m.graph_id) + '/attachments/' + encodeURIComponent(req.params.aid));
      if (!a.contentBytes) return res.status(415).json({ error: 'This attachment cannot be downloaded here.' });
      const name = String(a.name || 'attachment').replace(/[^\w.\- ]+/g, '_').slice(0, 150) || 'attachment';
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(Buffer.from(a.contentBytes, 'base64'));
    } catch (e) { res.status(502).json({ error: 'Could not download the attachment: ' + e.message }); }
  });
  ctx.m365Sync = sync;
};
