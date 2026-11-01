'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { safeEqual, escapeHtml, normEmail, ValidationError, NotFoundError, ConflictError, hmac } = require('./util');
const svc = require('./service');
const { audit } = require('./store');
const { runCycle, syncAllSources } = require('./autopilot');
const { evaluateReadiness } = require('./readiness');
const { estimate } = require('./domain/estimating');

const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new ValidationError('request body must be valid JSON'));
      }
    });
  });
}

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(payload);
}

function requireAdmin(config, req) {
  if (!config.adminKey) throw new HttpError(503, 'admin access is disabled: BUILDINTEL_ADMIN_KEY is not set');
  const key = req.headers['x-admin-key'];
  if (!key || !safeEqual(key, config.adminKey)) throw new HttpError(401, 'invalid admin key');
}

/**
 * Resolves the tenant for an org-scoped route. Either the tenant's own key, or
 * the owner's admin key plus x-org-id (the owner console acts on a tenant's behalf).
 */
function requireOrg(store, req, config) {
  const header = req.headers['x-org-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (header) {
    const org = svc.findOrgByApiKey(store, header);
    if (!org) throw new HttpError(401, 'invalid or missing organisation key');
    return org;
  }
  const adminKey = req.headers['x-admin-key'];
  if (config.adminKey && adminKey && safeEqual(adminKey, config.adminKey) && req.headers['x-org-id']) {
    const org = store.get('orgs', null, String(req.headers['x-org-id']));
    if (!org || org.status !== 'active') throw new NotFoundError('Organisation not found');
    return org;
  }
  throw new HttpError(401, 'invalid or missing organisation key');
}

// Static owner console. Whitelisted files only, so no path traversal is possible.
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', csp: "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/config.js': { file: 'config.js', type: 'application/javascript; charset=utf-8' },
};

function serveStatic(config, res, pathname) {
  const entry = STATIC_FILES[pathname];
  const full = path.join(config.root, 'public', entry.file);
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': entry.csp || "default-src 'none'",
  });
  res.end(fs.readFileSync(full));
}

function unsubscribeUrl(config, email) {
  const token = hmac(config.unsubscribeSecret, normEmail(email));
  return `${config.publicBaseUrl}/api/unsubscribe?email=${encodeURIComponent(normEmail(email))}&token=${token}`;
}

function bidView(store, orgId, bid) {
  const opportunity = store.get('opportunities', orgId, bid.opportunityId);
  const permit = opportunity ? store.get('permits', null, opportunity.permitId) : null;
  return {
    ...bid,
    project: permit ? { projectName: permit.projectName, permitId: permit.permitId, city: permit.city, state: permit.state } : null,
  };
}

function buildRoutes({ store, config, transport }) {
  return [
    ['GET', /^\/health$/, async () => ({ status: 200, body: { ok: true, time: new Date().toISOString() } })],

    ['GET', /^\/api\/admin\/orgs$/, async (req) => {
      requireAdmin(config, req);
      const orgs = store.list('orgs', null).map(svc.publicOrg);
      return { status: 200, body: orgs };
    }],

    ['GET', /^\/api\/admin\/orgs\/([^/]+)\/overview$/, async (req, match) => {
      requireAdmin(config, req);
      const orgId = match[1];
      const org = store.get('orgs', null, orgId);
      if (!org) throw new NotFoundError('Organisation not found');
      return {
        status: 200,
        body: {
          org: svc.publicOrg(org),
          contacts: store.list('contacts', orgId),
          opportunities: store.list('opportunities', orgId),
          bids: store.list('bids', orgId).map((b) => bidView(store, orgId, b)),
          audit: store.list('audit', orgId).slice(-50).reverse(),
        },
      };
    }],

    ['GET', /^\/api\/readiness$/, async (req) => {
      requireAdmin(config, req);
      return { status: 200, body: evaluateReadiness({ store, config }) };
    }],

    ['POST', /^\/api\/orgs$/, async (req) => {
      requireAdmin(config, req);
      const body = await readJson(req);
      return { status: 201, body: svc.createOrg(store, body) };
    }],

    ['GET', /^\/api\/me$/, async (req) => {
      const org = requireOrg(store, req, config);
      return { status: 200, body: svc.publicOrg(org) };
    }],

    ['PUT', /^\/api\/me\/profile$/, async (req) => {
      const org = requireOrg(store, req, config);
      const body = await readJson(req);
      return { status: 200, body: svc.updateProfile(store, org.id, body) };
    }],

    ['PUT', /^\/api\/me\/pricing$/, async (req) => {
      const org = requireOrg(store, req, config);
      const body = await readJson(req);
      return { status: 200, body: { rateCards: svc.setPricing(store, org.id, body.rateCards) } };
    }],

    ['POST', /^\/api\/me\/autopilot$/, async (req) => {
      const org = requireOrg(store, req, config);
      const body = await readJson(req);
      const next = {
        enabled: Boolean(body.enabled),
        autoApproveMaxTotal: Number(body.autoApproveMaxTotal || 0),
      };
      if (!(next.autoApproveMaxTotal >= 0)) throw new ValidationError('autoApproveMaxTotal must be >= 0');
      store.update('orgs', null, org.id, { autopilot: next });
      audit(store, org.id, `user:${org.id}`, 'autopilot.policy', org.id, next);
      return { status: 200, body: next };
    }],

    ['POST', /^\/api\/contacts$/, async (req) => {
      const org = requireOrg(store, req, config);
      const body = await readJson(req);
      return { status: 201, body: svc.addContact(store, org.id, body) };
    }],

    ['POST', /^\/api\/contacts\/([^/]+)\/verify$/, async (req, match) => {
      requireAdmin(config, req);
      const body = await readJson(req);
      const orgId = body.orgId;
      if (!orgId) throw new ValidationError('orgId is required');
      return { status: 200, body: svc.verifyContact(store, orgId, match[1], { ...body, actor: 'owner' }) };
    }],

    ['POST', /^\/api\/estimates$/, async (req) => {
      requireOrg(store, req, config);
      const body = await readJson(req);
      return { status: 200, body: estimate(body) };
    }],

    ['GET', /^\/api\/opportunities$/, async (req) => {
      const org = requireOrg(store, req, config);
      const rows = store.list('opportunities', org.id).map((o) => {
        const permit = store.get('permits', null, o.permitId);
        return { ...o, permit: permit ? { permitId: permit.permitId, projectName: permit.projectName, city: permit.city, state: permit.state, sourceUrl: permit.sourceUrl, confidence: permit.confidence } : null };
      });
      return { status: 200, body: rows };
    }],

    ['GET', /^\/api\/bids$/, async (req) => {
      const org = requireOrg(store, req, config);
      return { status: 200, body: store.list('bids', org.id).map((b) => bidView(store, org.id, b)) };
    }],

    ['POST', /^\/api\/bids\/([^/]+)\/approve$/, async (req, match) => {
      const org = requireOrg(store, req, config);
      svc.approveBid(store, org.id, match[1], `user:${org.id}`);
      const dispatch = await svc.dispatchBid({ store, config, transport, orgId: org.id, bidId: match[1] });
      return { status: 200, body: { dispatch, bid: bidView(store, org.id, svc.getBid(store, org.id, match[1])) } };
    }],

    ['POST', /^\/api\/bids\/([^/]+)\/withdraw$/, async (req, match) => {
      const org = requireOrg(store, req, config);
      return { status: 200, body: svc.withdrawBid(store, org.id, match[1], `user:${org.id}`) };
    }],

    ['GET', /^\/api\/audit$/, async (req) => {
      const org = requireOrg(store, req, config);
      return { status: 200, body: store.list('audit', org.id).slice(-100).reverse() };
    }],

    ['GET', /^\/api\/unsubscribe$/, async (req, _m, url) => {
      if (!config.unsubscribeSecret) throw new HttpError(503, 'unsubscribe is not configured');
      const email = normEmail(url.searchParams.get('email'));
      const token = url.searchParams.get('token') || '';
      if (!email || !safeEqual(token, svc.unsubscribeToken(config.unsubscribeSecret, email))) {
        throw new HttpError(400, 'invalid unsubscribe link');
      }
      svc.unsubscribe(store, email, 'unsubscribe_link');
      return {
        status: 200,
        html: `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><body style="font-family:Arial;margin:40px"><h1>You have been unsubscribed</h1><p>${escapeHtml(email)} will not receive further marketing email from this platform.</p></body>`,
      };
    }],

    ['POST', /^\/api\/admin\/sync$/, async (req) => {
      requireAdmin(config, req);
      return { status: 200, body: syncAllSources(store, config, new Date()) };
    }],

    ['POST', /^\/api\/admin\/autopilot\/run$/, async (req) => {
      requireAdmin(config, req);
      return { status: 200, body: await runCycle({ store, config, transport, now: new Date() }) };
    }],

    ['GET', /^\/api\/admin\/jobs$/, async (req) => {
      requireAdmin(config, req);
      return { status: 200, body: store.list('jobs', null).slice(-50).reverse() };
    }],

    ['GET', /^\/api\/admin\/queue$/, async (req) => {
      requireAdmin(config, req);
      // Owner-only cross-tenant view. Each row keeps its orgId so the console can act on it.
      const pending = store.listAllTenants('bids', (b) => b.status === 'pending_approval');
      return { status: 200, body: pending };
    }],
  ];
}

/**
 * CORS for the API only. Allowed origins come from BUILDINTEL_CORS_ORIGINS.
 * No cookies are used, so credentials are never sent cross-origin.
 */
function applyCors(config, req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!origin || !config.corsOrigins.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-admin-key,x-org-id,x-org-key,authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function createServer({ store, config, transport }) {
  const routes = buildRoutes({ store, config, transport });
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) applyCors(config, req, res);
      if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        return serveStatic(config, res, url.pathname);
      }
      const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
      if (!route) {
        const exists = routes.some(([, pattern]) => pattern.test(url.pathname));
        throw new HttpError(exists ? 405 : 404, exists ? 'method not allowed' : 'not found');
      }
      const match = url.pathname.match(route[1]);
      const result = await route[2](req, match, url);
      if (result.html) return send(res, result.status, result.html, 'text/html');
      return send(res, result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof ValidationError) return send(res, 400, { error: err.message, details: err.details });
      if (err instanceof NotFoundError) return send(res, 404, { error: err.message });
      if (err instanceof ConflictError) return send(res, 409, { error: err.message });
      console.error('[buildintel] unhandled error', err);
      return send(res, 500, { error: 'internal error' });
    }
  });
}

module.exports = { createServer, unsubscribeUrl };
