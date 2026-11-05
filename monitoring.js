// Built-in monitoring: records server errors (5xx responses, crashes, unhandled rejections) and CSP violation reports,
// emails the owner once per distinct problem per hour, and exposes counts for /health and the admin.
module.exports = function mountMonitoring(app, ctx) {
  const { db, auth, adminEmail, getMailer } = ctx, now = () => new Date().toISOString();
  db.exec(`CREATE TABLE IF NOT EXISTS app_errors(id INTEGER PRIMARY KEY AUTOINCREMENT, signature TEXT NOT NULL, kind TEXT, method TEXT, path TEXT, status INTEGER, message TEXT, count INTEGER DEFAULT 1, first_at TEXT, last_at TEXT, alerted_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS app_errors_sig ON app_errors(signature);
    CREATE TABLE IF NOT EXISTS csp_reports(id INTEGER PRIMARY KEY AUTOINCREMENT, signature TEXT UNIQUE NOT NULL, directive TEXT, blocked TEXT, page TEXT, sample TEXT, count INTEGER DEFAULT 1, first_at TEXT, last_at TEXT);`);
  const alert = row => {
    const r = db.prepare('SELECT alerted_at FROM app_errors WHERE signature=?').get(row.signature);
    if (r && r.alerted_at && Date.now() - Date.parse(r.alerted_at) < 3600e3) return;
    db.prepare('UPDATE app_errors SET alerted_at=? WHERE signature=?').run(now(), row.signature);
    const m = getMailer && getMailer(), to = process.env.ALERT_EMAIL || process.env.NOTIFY_EMAIL || adminEmail;
    if (m && to) m.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER || adminEmail, to, subject: `Bright Clean error: ${row.kind} ${row.status || ''} ${row.path || ''}`.slice(0, 160), text: `${row.message || ''}\n\n${row.method || ''} ${row.path || ''}\nFirst seen: ${now()}\nOpen Settings → System health in the admin for details.` }).catch(() => {});
  };
  const record = (kind, { method, path, status, message }) => {
    try {
      const p = String(path || '').split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, '/:token');
      const sig = `${kind}|${method || ''}|${p}|${status || ''}|${String(message || '').slice(0, 80)}`;
      db.prepare(`INSERT INTO app_errors(signature,kind,method,path,status,message,first_at,last_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(signature) DO UPDATE SET count=count+1, last_at=excluded.last_at`).run(sig, kind, method || null, p, status || null, String(message || '').slice(0, 1000), now(), now());
      alert({ signature: sig, kind, method, path: p, status, message });
    } catch { /* never let monitoring break a request */ }
  };
  // 5xx responses (route errors are already turned into responses by handlers)
  app.use((req, res, next) => { res.on('finish', () => { if (res.statusCode >= 500 && res.statusCode !== 503) record('http', { method: req.method, path: req.originalUrl, status: res.statusCode, message: res.statusMessage }); }); next(); });
  process.on('unhandledRejection', e => record('unhandledRejection', { message: (e && e.stack) || String(e) }));
  process.on('uncaughtExceptionMonitor', e => record('uncaughtException', { message: (e && e.stack) || String(e) }));
  ctx.recordError = record;
  if (process.env.MONITORING_TEST_ROUTE === '1' && process.env.NODE_ENV !== 'production') app.get('/api/test/boom', () => { throw new Error('Test failure for monitoring'); });
  // CSP violation collector (report-uri). Public, tiny bodies only, deduplicated.
  const express = require('express');
  app.post('/api/csp-report', express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }), (req, res) => {
    try {
      const list = Array.isArray(req.body) ? req.body.map(x => x.body || x) : [req.body && (req.body['csp-report'] || req.body)];
      for (const r of list.slice(0, 10)) { if (!r) continue;
        const directive = String(r['effective-directive'] || r.effectiveDirective || r['violated-directive'] || '').slice(0, 80), blocked = String(r['blocked-uri'] || r.blockedURL || '').slice(0, 200), page = String(r['document-uri'] || r.documentURL || '').split('?')[0].replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, '/:token').slice(0, 200), sample = String(r['script-sample'] || r.sample || '').slice(0, 120);
        const sig = `${directive}|${blocked}|${page}|${sample}`.slice(0, 500);
        db.prepare('INSERT INTO csp_reports(signature,directive,blocked,page,sample,first_at,last_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(signature) DO UPDATE SET count=count+1, last_at=excluded.last_at').run(sig, directive, blocked, page, sample, now(), now()); }
    } catch { /* ignore malformed reports */ }
    res.status(204).end();
  });
  const roleOk = req => { const e = String((req.user && req.user.email) || '').toLowerCase(), ow = String(adminEmail || '').toLowerCase(); if (!ow || e === ow) return true; const r = db.prepare('SELECT role FROM admin_users WHERE lower(email)=?').get(e); return r && ['owner', 'manager'].includes(r.role); };
  app.get('/api/admin/system-health', auth, (req, res) => {
    if (!roleOk(req)) return res.status(403).json({ error: 'Only an owner or manager can view system health.' });
    res.json({ errors: db.prepare('SELECT kind, method, path, status, message, count, first_at, last_at FROM app_errors ORDER BY last_at DESC LIMIT 50').all(),
      csp: { enforced_scripts: process.env.CSP_ENFORCE_SCRIPTS === '1', reports: db.prepare('SELECT directive, blocked, page, sample, count, first_at, last_at FROM csp_reports ORDER BY last_at DESC LIMIT 50').all() } });
  });
  ctx.errorsLastHour = () => { try { return db.prepare('SELECT COALESCE(SUM(count),0) n FROM app_errors WHERE last_at>=?').get(new Date(Date.now() - 3600e3).toISOString()).n; } catch { return null; } };
};
