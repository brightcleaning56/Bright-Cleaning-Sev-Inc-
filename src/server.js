import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isProduction } from './config.js';
import { now } from './store.js';
import { seedSources, canCollect, sourceComplianceIssues } from './sources/registry.js';
import { csvImport } from './sources/adapters.js';
import { ingestPermits } from './permits.js';
import { draftRateCard, approveRateCard, CATEGORIES } from './estimate.js';
import { bidLinkView, submitBidLink, bidLinkToken } from './bidlink.js';
import { validateContact, normName, transition } from './domain.js';
import { runCycleGuarded, cycleStatus, handleEmailEvent } from './autopilot.js';
import { readiness } from './readiness.js';
import { createBackup, restoreTest, backupDocuments, verifyDocumentVault, syncOffsite } from './backup.js';
import { createCheckout, applyStripeEvent, PLANS } from './billing.js';
import { BUYER_KINDS, createRequest, awardRequest, closeRequest, contractDocument, consentText, TRADES, setIntent, submitBid } from './marketplace.js';
import { contactFromProject } from './outreach.js';
import { prequalProfile, setPrequal, leveling } from './prequal.js';
import { SCALES, saveMeasurement, listMeasurements, deleteMeasurement } from './measure.js';
import { backfillCore, linkBidRequest, linkBidRequestTo, pickProjects, linkDocument, linkAward, recomputePhase, coreView, searchCoreMemory, mergeProjects, splitLinks, resolveReview, resolveProjectId } from './core.js';
import { reconcileCore, searchCoreSql } from './coredb.js';
import { parityReport } from './parity.js';
import { sqlSearchProjects, sqlSupports } from './permitsql.js';
import { hasPerm, permissionsOf, platformRolesOf, isPlatformStaff, PLATFORM_ROLES, adminAudit } from './admin/rbac.js';
import * as admin from './admin/service.js';
import * as adminMk from './admin/marketplace.js';
import * as adminOps from './admin/operations.js';
import * as adminPhase2b from './admin/phase2b.js';
import * as adminSupport from './admin/support.js';
import * as adminPhase5 from './admin/phase5.js';
import { newSecret, seal, checkCode, otpauthUri } from './admin/mfa.js';
import { parseFilters } from './leads.js';
import { PERMISSIONS, RELATIONSHIPS, can, requestVerification, decideVerification, createPublication, addPackage, checklist, publish, setStatus, coverage, searchBidders, quickPublish, isVerifiedPublisher } from './publishing.js';
import { CATALOG, PRICE_STATUS, entitlementsFor, seatCheck, usage } from './entitlements.js';
import { syncDocument, indexDocument, syncPlanRoom, listSets, searchDocuments, compareRevisions } from './planroom.js';
import { saveDocument, listDocuments, viewLink, openFromLink, acknowledgeAddenda, planholders } from './documents.js';
import { analyzeDocument, verifyAnalysis } from './ai.js';
import { startFromAnalysis, startManual, startForProject, startFromMeasurements, proposalHtml, updateEstimate, submitEstimateAsBid, computeEstimate } from './takeoff.js';
import { addCredential, verifyCredential, expiringSoon } from './credentials.js';
import { handleInbound, analytics, importDirectory, directoryGaps, requeueNeedsContact } from './engagement.js';
import { sendEmail } from './outbound.js';
import { searchProjects, projectDetail, trackProject, saveSearch, exportCsv, collectAlerts, contractors, contractorDetail, planningSignals, commandCenter, mapPoints, marketActivity } from './leads.js';
import { LEAD_PLANS, ALL_STATES, leadAccess } from './billing.js';
import { notificationPrefs } from './digest.js';
import { planComparison } from './entitlements.js';
import { hashPassword, verifyPassword, createSession, sessionUser, revokeSession, sign, unsign, rateLimit, verifyStripeSignature } from './security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function bootstrap(store) {
  seedSources(store);
  // The platform's own company is a cleaning company: give it its trades once so it receives cleaning invitations.
  for (const o of store.list('orgs', o => o.subscription?.plan === 'internal' && !Array.isArray(o.trades))) { o.trades = ['cleaning', 'janitorial']; store.put('orgs', o); }
  syncPlanRoom(store, { maxIndex: 0 }).catch(e => console.error('plan room sync failed', e.message));
  try { const r = backfillCore(store, { full: true }); if (r.newProjects || r.newLinks) console.log(`project core: ${r.projects} projects (${r.newProjects} new, ${r.newLinks} new links, ${r.openReview} to review)`); } catch (e) { console.error('core backfill failed', e.message); }
  if (config.ownerEmail && config.ownerPassword && !store.list('users', u => u.role === 'platform_owner').length) {
    const org = store.put('orgs', { slug: 'bright-clean', name: 'Bright Clean Inc.', status: 'onboarding', legal: {}, settings: defaultSettings(), subscription: { plan: 'internal', status: 'active' } });
    store.put('users', { email: config.ownerEmail.toLowerCase(), passwordHash: hashPassword(config.ownerPassword), role: 'platform_owner', orgId: org.id });
    store.audit({ actor: 'system', action: 'bootstrap.owner', target: config.ownerEmail });
  }
  store.save();
}

export function defaultSettings() {
  return {
    coverage: ['des moines, ia', 'west des moines, ia', 'ankeny, ia', 'dallas, tx'],
    projectTypes: [], minContract: 1500, validDays: 30,
    autoApprove: { enabled: false, maxTotal: 0, minScore: 100 },
    requireCurrentCOI: true, followUpDays: 5, digestDay: 1,
    liveSending: false, proposalTerms: '',
  };
}

export async function backupAndVerify(store, { fetchImpl } = {}) {
  const b = createBackup(store, config.backupDir, config.backupKey);
  b.documents = backupDocuments(store, config.docDir, config.backupDir, config.backupKey);   // plan-room PDFs, encrypted
  store.put('jobs', { type: 'backup', status: b.documents.corrupted.length || b.documents.missingOnDisk.length ? 'warning' : 'ok', result: b });
  const r = restoreTest(b.file, b.checksum, config.backupKey);
  r.vault = verifyDocumentVault(store, config.backupDir, config.backupKey);                    // records ↔ files, decrypt + fingerprint
  r.ok = r.ok && r.vault.ok;
  store.put('jobs', { type: 'restore_test', status: r.ok ? 'ok' : 'failed', result: r });
  let offsite = null;
  if (config.offsite) {
    const statePath = path.join(config.backupDir, 'offsite-state.json');
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
    try { offsite = await syncOffsite(config.offsite, config.backupDir, state, { fetchImpl }); fs.writeFileSync(statePath, JSON.stringify(offsite.state));
      store.put('jobs', { type: 'offsite', status: 'ok', result: { uploaded: offsite.uploaded, bytes: offsite.bytes, bucket: config.offsite.bucket } }); }
    catch (e) { offsite = { error: e.message }; store.put('jobs', { type: 'offsite', status: 'failed', result: { error: e.message } }); }
  }
  store.save();
  return { backup: b, restore: r, offsite };
}

// ---------------- HTTP plumbing ----------------
// Postmark sends the webhook password as HTTP Basic auth. The secret never goes in the URL, so it stays out of logs.
const webhookAuthorized = (config, req) => {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Basic ') || !config.postmarkWebhookSecret) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  return constantTimeEqual(pass, config.postmarkWebhookSecret);
};
const constantTimeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; worker-src 'self' blob:; img-src 'self' data: https://*.tile.openstreetmap.org",
  ...(isProduction() ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}),
};
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, ...SEC_HEADERS });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
// Public website pages may be framed by the same site only (the UI screen gallery previews them).
// The app and Super Admin keep X-Frame-Options DENY.
// Bid documents (proposals, signed records) are generated by BUILDINTEL with escaped data and no scripts.
// They keep their own styles, so this response allows inline styles and nothing else that is active.
const sendDocument = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  res.end(body);
};
const sendFramable = (res, code, body, type = 'text/html; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, ...SEC_HEADERS, 'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': SEC_HEADERS['Content-Security-Policy'].replace("default-src 'self';", "default-src 'self'; frame-ancestors 'self';") });
  res.end(body);
};
const readBody = req => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > 5e6) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const json = raw => { try { return raw ? JSON.parse(raw) : {}; } catch { return null; } };

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const need = (cond, code, msg) => { if (!cond) throw new HttpError(code, msg); };
const isOrgOwner = u => u.role === 'owner' || u.role === 'platform_owner';
const strip = u => u && ({ id: u.id, email: u.email, role: u.role, orgId: u.orgId });

export function createServer(store, deps = {}) {
  const routes = [];
  const route = (method, pattern, auth, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, fn });

  // ---- public ----
  route('GET', '/health', null, () => ({ ok: !store.lastFlushError, at: now(), storage: store.kind || 'memory', lastFlushAt: store.lastFlushAt || null, storageError: store.lastFlushError ? 'write failed — see logs' : null }));
  // The company's own bid link for one of its invitations (for the "copy bid link" button in the app).
  route('GET', '/api/invitations/:id/bid-link', 'user', ({ params, user }) => {
    const inv = store.get('invitations', params.id); need(inv && inv.sellerOrgId === user.orgId, 404, 'not found');
    const r = store.get('bidRequests', inv.requestId); need(r, 404, 'not found');
    return { url: `${config.baseUrl}/bid/${bidLinkToken(inv, r)}` };
  });
  // Bid without signing in: the link in an invitation email. See src/bidlink.js.
  route('GET', '/api/bid-link/:token', null, ({ params }) => { const r = bidLinkView(store, params.token); need(r.ok, r.code || 404, r.error); return r; });
  route('POST', '/api/bid-link/:token', null, ({ params, body, ip }) => {
    need(rateLimit('bidlink:' + ip, 20, 3600e3), 429, 'too many attempts from this address, try again later');
    const r = submitBidLink(store, params.token, body); need(r.ok, r.code || 400, r.error);
    return { ok: true, message: 'Bid received. Your bid is recorded with a receipt; the GC will be in touch by email.', submission: { id: r.submission.id, total: r.submission.total, submittedAt: r.submission.submittedAt } };
  });
  // Public contact form on the website. Stored for the Super Admin team to answer; no account needed.
  const INQUIRY_TYPES = ['Book a demo', 'Subscribe to projects', 'Publish projects', 'Support', 'Partnership', 'Other'];
  route('POST', '/api/inquiries', null, ({ body, ip }) => {
    need(rateLimit('inquiry:' + ip, 5, 3600e3), 429, 'too many messages from this address, try again later');
    const name = String(body.name || '').trim().slice(0, 120), email = String(body.email || '').trim().slice(0, 200);
    const company = String(body.company || '').trim().slice(0, 200), type = String(body.type || '');
    const message = String(body.message || '').trim().slice(0, 4000);
    need(name.length >= 2, 400, 'enter your full name');
    need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 400, 'enter a valid email address');
    need(INQUIRY_TYPES.includes(type), 400, 'choose an inquiry type');
    need(message.length >= 10, 400, 'message must be at least 10 characters');
    const q = store.put('inquiries', { name, email, company, type, message, status: 'new', createdAt: new Date().toISOString() });
    return { ok: true, id: q.id, message: 'Thanks. Your message was received and the BUILDINTEL team will reply by email.' };
  });
  route('POST', '/api/login', null, ({ body, ip }) => {
    need(rateLimit('login:' + ip, config.loginRateLimit, 15 * 60e3), 429, 'too many attempts, wait 15 minutes');
    const u = store.list('users', x => x.email === String(body.email || '').toLowerCase())[0];
    const ok = u && !u.disabled && verifyPassword(body.password || '', u.passwordHash);
    if (!ok) { store.audit({ actor: String(body.email || '').toLowerCase().slice(0, 200), orgId: u?.orgId || null, action: 'auth.login_failed', detail: { reason: u?.disabled ? 'disabled' : 'bad credentials' } }); store.save(); }
    need(ok, 401, 'invalid email or password');
    need(store.get('orgs', u.orgId)?.status !== 'suspended' || isPlatformStaff(u), 403, 'this company account is suspended — contact BUILDINTEL support');
    if (u.mfa?.sealed) {                               // MFA enrolled: the authenticator code is required too
      const step = body.code ? checkCode(u.mfa.sealed, body.code, u.mfa.lastStep ?? -1) : null;
      if (step == null) { store.audit({ actor: u.email, orgId: u.orgId, action: body.code ? 'auth.mfa_failed' : 'auth.mfa_required' }); store.save();
        throw Object.assign(new Error(body.code ? 'that code is not valid (or was already used) — try the next one' : 'enter the 6-digit code from your authenticator app'), { code: 401, extra: { mfaRequired: true } }); }
      u.mfa = { ...u.mfa, lastStep: step };
    }
    u.lastLoginAt = new Date().toISOString(); store.put('users', u);
    store.audit({ actor: u.email, orgId: u.orgId, action: 'auth.login' }); store.save();
    return { token: createSession(store, u), user: strip(u) };
  });
  route('POST', '/api/privacy/requests', null, ({ body, ip }) => {
    need(rateLimit('privacy:' + ip, 5, 3600e3), 429, 'too many requests');
    need(/^[^@\s]+@[^@\s]+$/.test(body.email || ''), 400, 'valid email required');
    need(['access', 'delete', 'correct', 'opt_out'].includes(body.type), 400, 'type must be access|delete|correct|opt_out');
    const r = store.put('privacyRequests', { email: body.email.toLowerCase(), type: body.type, details: String(body.details || '').slice(0, 2000), status: 'open', dueBy: new Date(Date.now() + 45 * 864e5).toISOString() });
    if (body.type === 'opt_out') store.suppressEverywhere(body.email, 'privacy opt-out', 'privacy_request');
    store.save();
    return { ok: true, id: r.id, message: 'Request received. We respond within 45 days.' };
  });
  route('POST', '/webhooks/postmark', null, ({ body, req }) => {
    need(webhookAuthorized(config, req), 401, 'bad credentials');
    const r = handleEmailEvent(store, body); store.save(); return r;
  });

  route('POST', '/webhooks/postmark-inbound', null, ({ body, req }) => {
    need(webhookAuthorized(config, req), 401, 'bad credentials');
    const r = handleInbound(store, body); store.save(); return r;
  });
  const sendVerification = async (org, user, email, what) => {
    const link = `${config.baseUrl}/verify/${sign({ o: org.id, u: user.id, t: Date.now() })}`;
    const r = await sendEmail({ From: config.platformFrom || 'no-reply@' + new URL(config.baseUrl).hostname, To: email, Subject: 'Confirm your BUILDINTEL account',
      TextBody: `Confirm your email to ${what}:\n\n${link}\n\nIf you didn't sign up, ignore this message.`, MessageStream: config.postmarkStream }, deps);
    store.put('messages', { orgId: org.id, kind: 'verification', dryRun: !!r.dryRun, to: email, link: r.dryRun ? link : undefined, messageId: r.messageId || null });
  };
  // Subcontractors and service providers sign up with the trades they perform. Matching uses trade keys, so the
  // keys are saved on the company at sign-up (a company with no trades never receives invitations).
  route('POST', '/api/signup/subscriber', null, async ({ body, ip }) => {
    need(rateLimit('signup:' + ip, 5, 3600e3), 429, 'too many signups from this address');
    need(body.company && body.name, 400, 'company and name required');
    const segment = body.segment === 'service_provider' ? 'service_provider' : 'subcontractor';
    const chosen = Array.isArray(body.trades) ? [...new Set(body.trades.map(String))] : [];
    need(chosen.length || body.segment === 'service_provider', 400, 'choose the trades you perform');
    need(chosen.every(t => TRADES.some(([k]) => k === t)), 400, 'unknown trade');
    const services = segment === 'service_provider' ? (Array.isArray(body.services) ? [...new Set(body.services.map(String))] : []) : [];
    need(segment !== 'service_provider' || (services.length && services.every(x => CATEGORIES.includes(x))), 400, 'choose the services you provide');
    const trades = segment === 'service_provider' ? [...new Set([...chosen, 'cleaning'])] : chosen;
    const state = String(body.state || '').toUpperCase();
    need(ALL_STATES.includes(state), 400, 'choose the state you work in');
    const email = String(body.email || '').toLowerCase();
    need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 400, 'valid business email required');
    need(!store.list('users', u => u.email === email).length, 409, 'email already registered');
    let passwordHash; try { passwordHash = hashPassword(body.password || ''); } catch (e) { throw new HttpError(400, e.message); }
    const label = trades.map(k => TRADES.find(([key]) => key === k)[1]).join(', ');
    const org = store.put('orgs', { slug: 'sub-' + Math.random().toString(36).slice(2, 8), name: String(body.company).slice(0, 200), kind: 'subscriber',
      segment, trade: label.slice(0, 200), trades, services, territories: [state], status: 'pending_verification', legal: {}, settings: defaultSettings(),
      subscription: { plan: 'trial', status: 'trialing', trialEndsAt: new Date(Date.now() + 14 * 864e5).toISOString() } });
    const user = store.put('users', { email, name: String(body.name).slice(0, 120), passwordHash, role: 'owner', orgId: org.id });
    await sendVerification(org, user, email, 'start your 14-day BUILDINTEL trial');
    store.audit({ actor: email, orgId: org.id, action: 'subscriber.signup', detail: { segment, trades, state } });
    return { ok: true, message: 'Check your email to confirm your account and start your trial.' };
  });
  route('POST', '/api/signup/buyer', null, async ({ body, ip }) => {
    need(rateLimit('signup:' + ip, 5, 3600e3), 429, 'too many signups from this address');
    need(body.company && body.name, 400, 'company and name required');
    need(BUYER_KINDS.includes(body.kind), 400, `kind must be one of ${BUYER_KINDS.join(', ')}`);
    const email = String(body.email || '').toLowerCase();
    need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 400, 'valid business email required');
    need(!store.list('users', u => u.email === email).length, 409, 'email already registered');
    let passwordHash; try { passwordHash = hashPassword(body.password || ''); } catch (e) { throw new HttpError(400, e.message); }
    const org = store.put('orgs', { slug: 'buyer-' + Math.random().toString(36).slice(2, 8), name: String(body.company).slice(0, 200), kind: 'buyer', buyerKind: body.kind, status: 'pending_verification', legal: {}, settings: {} });
    const user = store.put('users', { email, name: String(body.name).slice(0, 120), passwordHash, role: 'owner', orgId: org.id });
    const link = `${config.baseUrl}/verify/${sign({ o: org.id, u: user.id, t: Date.now() })}`;
    const r = await sendEmail({ From: config.platformFrom || 'no-reply@' + new URL(config.baseUrl).hostname, To: email, Subject: 'Confirm your BUILDINTEL account',
      TextBody: `Confirm your email to start receiving cleaning proposals:\n\n${link}\n\nIf you didn't sign up, ignore this message.`, MessageStream: config.postmarkStream }, deps);
    store.put('messages', { orgId: org.id, kind: 'verification', dryRun: !!r.dryRun, to: email, link: r.dryRun ? link : undefined, messageId: r.messageId || null });
    store.audit({ actor: email, orgId: org.id, action: 'buyer.signup' });
    return { ok: true, message: 'Check your email to confirm your account.' };
  });

  // ---- authenticated ----
  route('GET', '/api/me', 'user', ({ user }) => ({ user: strip(user), org: store.get('orgs', user.orgId) }));
  route('POST', '/api/logout', 'user', ({ token }) => { revokeSession(store, token); return { ok: true }; });

  route('GET', '/api/readiness', 'platform', () => readiness(store));
  // Release identifier: exactly which build is running, so a ZIP and the live service can't be confused.
  const STARTED = new Date().toISOString();
  const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  route('GET', '/api/release', 'platform', () => {
    const cycles = store.list('jobs', j => j.type === 'cycle').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { app: PKG.name, version: PKG.version, commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown (not provided by host)',
      branch: process.env.RENDER_GIT_BRANCH || null, startedAt: STARTED, node: process.version, storage: store.kind || 'file', dbTls: store.tls?.mode || null,
      concurrency: store.kind === 'postgres' ? { versionedWrites: true, conflicts: store.conflicts?.length || 0, notificationsReceived: store.notificationsReceived || 0, listener: store.listenerError ? 'error' : 'connected' } : null,
      schema: { version: store.kind === 'postgres' ? 4 : null, layout: 'records + audit (document model)', collections: Object.keys(store.data || {}).length },
      integrations: { coreReads: config.coreReads, sqlReads: config.sqlReads, email: config.emailMode === 'live' ? 'live' : 'dry-run', stripe: !!config.stripeSecret, ai: !!config.anthropicKey, offsiteBackup: !!config.offsite, samGov: !!config.samApiKey },
      collection: { lastCycleAt: cycles[0]?.createdAt || null, lastCycleStatus: cycles[0]?.status || null, running: cycleStatus().running, scheduler: process.env.SCHEDULER !== 'off' },
      sources: store.list('sources', x => x.enabled).map(x => ({ key: x.key, lastSuccessAt: x.lastSuccessAt || null, lastError: x.lastError || null })) };
  });
  // Coverage: which jurisdictions are actually live, current and authorized. Never implies more than exists.
  route('GET', '/api/coverage', 'user', ({ user }) => {
    const platform = user.role === 'platform_owner';
    const counts = {}; for (const p2 of store.list('permits', p2 => !p2.archived)) counts[p2.sourceId] = (counts[p2.sourceId] || 0) + 1;
    const sig = {}; for (const x of store.list('signals')) sig[x.sourceId] = (sig[x.sourceId] || 0) + 1;
    const lic = {}; for (const x of store.list('licenses', l => l.found)) lic[x.sourceId] = (lic[x.sourceId] || 0) + 1;
    const rows = store.list('sources').map(x => {
      const kind = x.adapter === 'license-socrata' ? 'Contractor licenses' : x.adapter === 'legistar' ? 'Council land-use actions' : x.adapter === 'signals-socrata' ? 'Land-use applications' : x.adapter === 'samgov' ? 'Federal opportunities' : x.method === 'file_import' ? 'Permits (file import)' : 'Building permits';
      const fresh = x.lastSuccessAt && Date.now() - Date.parse(x.lastSuccessAt) < 26 * 3600e3;
      const status = !x.enabled ? 'off' : x.lastError ? 'error' : fresh ? 'live' : 'stale';
      return { key: x.key, name: x.name, city: x.city, state: x.state, kind, status, records: counts[x.id] || sig[x.id] || lic[x.id] || 0,
        lastSuccessAt: x.lastSuccessAt || null, lastRecordDate: x.lastRecordDate || null,
        authorized: !!x.authorization?.evidence, ...(platform ? { evidence: x.authorization?.evidence || null, notes: x.notes || '', error: x.lastError || null } : {}) };
    }).filter(r => platform || r.status !== 'off').sort((a, b) => ['live', 'stale', 'error', 'off'].indexOf(a.status) - ['live', 'stale', 'error', 'off'].indexOf(b.status) || b.records - a.records);
    const live = rows.filter(r => r.status === 'live');
    return { summary: { liveSources: live.length, liveJurisdictions: new Set(live.filter(r => r.city).map(r => r.city + ',' + r.state)).size, states: [...new Set(live.map(r => r.state).filter(Boolean))] }, rows };
  });
  // Proves the email setup end to end: sends one message to the signed-in owner and reports exactly what happened.
  route('POST', '/api/admin/test-email', 'platform', async ({ user }) => {
    need(rateLimit('testmail:' + user.id, 5, 3600e3), 429, 'test email limit reached (5 per hour)');
    const from = config.platformFrom;
    if (!from) return { ok: false, mode: config.emailMode, problem: 'PLATFORM_FROM is not set in Render (e.g. alerts@yourdomain.com)' };
    const r = await sendEmail({ From: from, To: user.email, Subject: 'BUILDINTEL test email', TextBody: `This is a test from BUILDINTEL (${config.baseUrl}).\nIf you received it, platform email works: alerts, invitations and signup confirmations will be delivered.`, MessageStream: config.postmarkStream }, deps);
    store.put('messages', { kind: 'test_email', to: user.email, dryRun: !!r.dryRun, messageId: r.messageId || null, error: r.ok ? null : r.error });
    return r.dryRun ? { ok: false, mode: 'dry-run', problem: 'EMAIL_MODE is dry-run, so nothing was sent. Set EMAIL_MODE=live once the domain is verified.' }
      : r.ok ? { ok: true, mode: 'live', sentTo: user.email, messageId: r.messageId } : { ok: false, mode: 'live', problem: r.error };
  });
  // Answers immediately; the pull runs in the background (results appear in /api/jobs).
  route('POST', '/api/cycle', 'platform', ({ query }) => {
    if (query.get('wait') === 'true') return runCycleGuarded(store, deps);
    const st = cycleStatus();
    if (st.running) return { started: false, reason: 'a pull is already running', since: st.startedAt };
    runCycleGuarded(store, deps).catch(e => console.error('cycle failed', e));
    return { started: true, at: now() };
  });
  route('GET', '/api/cycle', 'platform', () => cycleStatus());
  route('POST', '/api/backup', 'platform', () => backupAndVerify(store));
  route('GET', '/api/audit', 'platform', ({ query }) => store.data.audit.slice(-Number(query.get('n') || 200)).reverse());
  route('GET', '/api/jobs', 'platform', () => store.list('jobs').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50));

  // orgs
  route('GET', '/api/orgs', 'platform', () => store.list('orgs'));
  route('POST', '/api/orgs', 'platform', ({ body, user }) => {
    need(body.name && body.slug, 400, 'name and slug required');
    need(!store.list('orgs', o => o.slug === body.slug).length, 409, 'slug taken');
    const o = store.put('orgs', { slug: body.slug, name: body.name, status: 'onboarding', legal: {}, settings: defaultSettings(), subscription: {} });
    store.audit({ actor: user.email, action: 'org.create', target: o.id }); return o;
  });
  route('PATCH', '/api/org', 'owner', ({ body, user }) => {
    const org = store.get('orgs', user.orgId);
    if (body.legal) org.legal = { ...org.legal, ...pick(body.legal, ['name', 'dba', 'postalAddress', 'phone', 'ein']) };
    if (body.senderEmail) { need(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.senderEmail), 400, 'invalid senderEmail'); org.senderEmail = body.senderEmail; }
    if (body.settings) {
      const s = pick(body.settings, ['coverage', 'projectTypes', 'minContract', 'validDays', 'proposalTerms', 'autoApprove', 'liveSending']);
      if (s.liveSending) need(config.emailMode === 'live', 400, 'liveSending requires EMAIL_MODE=live with a verified domain');
      org.settings = { ...org.settings, ...s };
    }
    store.put('orgs', org); store.audit({ actor: user.email, orgId: org.id, action: 'org.update', detail: Object.keys(body) });
    return org;
  });
  route('POST', '/api/org/activate', 'owner', ({ user }) => {
    const org = store.get('orgs', user.orgId);
    const missing = ['name', 'postalAddress'].filter(k => !org.legal?.[k]);
    if (!org.senderEmail) missing.push('senderEmail');
    need(!missing.length, 400, 'cannot activate, missing: ' + missing.join(', '));
    org.status = 'active'; store.put('orgs', org); store.audit({ actor: user.email, orgId: org.id, action: 'org.activate' });
    return org;
  });
  route('GET', '/api/org/users', 'user', ({ user }) => store.list('users', u => u.orgId === user.orgId).map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, permissions: u.role === 'owner' ? PERMISSIONS : (u.permissions || ['upload', 'invite']) })));
  route('PATCH', '/api/org/users/:id', 'owner', ({ params, body, user }) => {
    const u = store.get('users', params.id); need(u && u.orgId === user.orgId, 404, 'not found'); need(u.id !== user.id || body.disabled !== true, 400, 'you cannot disable yourself');
    if (body.permissions !== undefined) { need(Array.isArray(body.permissions) && body.permissions.every(x => PERMISSIONS.includes(x)), 400, `permissions: ${PERMISSIONS.join(', ')}`); u.permissions = [...new Set(body.permissions)]; }
    if (body.disabled !== undefined) { if (!body.disabled) need(seatCheck(store, store.get('orgs', user.orgId)).ok, 402, seatCheck(store, store.get('orgs', user.orgId)).error); u.disabled = !!body.disabled; }
    store.put('users', u); store.audit({ actor: user.email, orgId: user.orgId, action: 'user.update', target: u.id, detail: { permissions: u.permissions, disabled: u.disabled } });
    return { id: u.id, email: u.email, role: u.role, disabled: !!u.disabled, permissions: u.permissions || [] };
  });
  route('POST', '/api/org/users', 'owner', ({ body, user }) => {
    need(['owner', 'member'].includes(body.role), 400, 'role must be owner|member');
    const sc = seatCheck(store, store.get('orgs', user.orgId)); need(sc.ok, 402, sc.error);
    need(!body.permissions || (Array.isArray(body.permissions) && body.permissions.every(x => PERMISSIONS.includes(x))), 400, `permissions: ${PERMISSIONS.join(', ')}`);
    const email = String(body.email || '').toLowerCase();
    need(!store.list('users', u => u.email === email).length, 409, 'email in use');
    const u = store.put('users', { email, name: body.name ? String(body.name).slice(0, 120) : null, passwordHash: hashPassword(body.password || ''), role: body.role, orgId: user.orgId, ...(body.role === 'member' ? { permissions: body.permissions || ['upload', 'invite'] } : {}) });
    store.audit({ actor: user.email, orgId: user.orgId, action: 'user.create', target: u.id }); return strip(u);
  });

  // sources
  route('GET', '/api/sources', 'user', () => store.list('sources'));
  route('PATCH', '/api/sources/:id', 'platform', ({ body, params, user }) => {
    const s = store.get('sources', params.id); need(s, 404, 'not found');
    if (body.authorization) s.authorization = { ...s.authorization, ...pick(body.authorization, ['commercialReuse', 'redistribution', 'reviewedBy', 'reviewedAt', 'evidence', 'notes']) };
    if (body.adapterConfig) s.adapterConfig = { ...s.adapterConfig, ...body.adapterConfig };
    for (const k of ['enabled', 'termsUrl', 'url', 'rateLimitPerMin']) if (body[k] !== undefined) s[k] = body[k];
    store.put('sources', s); store.audit({ actor: user.email, action: 'source.update', target: s.id, detail: body });
    return s;
  });
  route('POST', '/api/sources/:id/import', 'platform', ({ raw, params, user }) => {
    const s = store.get('sources', params.id); need(s, 404, 'not found');
    need(s.method === 'file_import', 400, 'source is not a file import source');
    need(canCollect(s), 400, 'source not authorized: ' + (s.enabled ? sourceComplianceIssues(s).join(', ') : 'disabled'));
    const rows = csvImport(raw);
    const r = ingestPermits(store, s, rows);
    const latest = rows.map(x => x.issuedDate).filter(Boolean).sort().pop();
    Object.assign(s, { lastSuccessAt: now(), lastRecordDate: latest || s.lastRecordDate }); store.put('sources', s);
    store.put('jobs', { type: 'import', sourceId: s.id, status: 'ok', result: r });
    store.audit({ actor: user.email, action: 'source.import', target: s.id, detail: r }); return r;
  });

  // GC directory (platform intelligence)
  route('GET', '/api/companies', 'user', () => store.list('companies'));
  route('POST', '/api/companies', 'platform', ({ body, user }) => {
    need(body.name, 400, 'name required');
    for (const k of ['website', 'evidenceUrl']) need(!body[k] || /^https?:\/\//i.test(String(body[k])), 400, `${k} must be an http(s) link`);
    const c = store.put('companies', { name: body.name, normName: normName(body.name), website: body.website || null, kind: body.kind || 'general_contractor', bidInstructions: body.bidInstructions || null, evidenceUrl: body.evidenceUrl || null });
    store.audit({ actor: user.email, action: 'company.create', target: c.id }); return c;
  });
  route('GET', '/api/contacts', 'user', () => store.list('contacts').map(c => ({ ...c, suppressed: store.isSuppressed(c.email) })));
  route('POST', '/api/contacts', 'platform', ({ body, user }) => {
    const c = pick(body, ['companyId', 'name', 'role', 'email', 'phone', 'status', 'evidenceUrl', 'publishedForBusiness', 'homeAddress', 'ssn', 'dob']);
    c.status ||= 'unverified';
    const errors = validateContact(c); need(!errors.length, 400, errors.join('; '));
    need(store.get('companies', c.companyId), 400, 'company not found');
    if (store.isSuppressed(c.email)) c.status = 'opted_out';
    if (['verified', 'source_confirmed'].includes(c.status)) c.verifiedAt = now();
    const rec = store.put('contacts', c); store.audit({ actor: user.email, action: 'contact.create', target: rec.id });
    requeueNeedsContact(store); return rec;
  });

  // rate cards
  route('GET', '/api/rate-cards', 'user', ({ user }) => store.tlist('rateCards', user.orgId));
  route('POST', '/api/rate-cards', 'owner', ({ body, user }) => { need(store.get('orgs', user.orgId)?.kind !== 'buyer', 403, 'buyer accounts do not have pricing'); const r = draftRateCard(store, user.orgId, body, user.email); need(r.ok, 400, r.errors?.join('; ')); return r.rateCard; });
  route('POST', '/api/rate-cards/:id/approve', 'owner', ({ params, user }) => {
    const r = approveRateCard(store, user.orgId, params.id, user.email, user.role === 'platform_owner' ? 'owner' : user.role);
    need(r.ok, 400, r.errors?.join('; ')); return r.rateCard;
  });

  // pipeline
  route('GET', '/api/opportunities', 'user', ({ user }) => store.tlist('opportunities', user.orgId).map(o => ({ ...o, permit: (o.permitId && store.get('permits', o.permitId)) || o.project })).sort((a, b) => b.score - a.score));
  route('GET', '/api/bids', 'user', ({ user }) => store.tlist('bids', user.orgId));
  route('GET', '/api/proposals/:id', 'user', ({ params, user }) => { const p = store.tget('proposals', user.orgId, params.id); need(p, 404, 'not found'); return { __html: p.html }; });
  route('POST', '/api/bids/:id/:action', 'owner', ({ params, body, user }) => {
    const bid = store.tget('bids', user.orgId, params.id); need(bid, 404, 'not found');
    const map = { approve: 'approved', withdraw: 'withdrawn', retry: 'draft', awarded: 'awarded', lost: 'lost' };
    need(map[params.action], 400, 'unknown action');
    try { transition(store, bid, map[params.action], user.email, body.note ? { note: body.note } : null); }
    catch (e) { throw new HttpError(409, e.message); }
    return bid;
  });

  // marketplace (buyers: GCs, property managers)
  const buyerOrg = user => { const o = store.get('orgs', user.orgId); need(o?.kind === 'buyer', 403, 'buyer accounts only'); return o; };
  route('POST', '/api/orgs/:id/verify', 'platform', ({ params, user }) => {
    const o = store.get('orgs', params.id); need(o?.kind === 'buyer', 404, 'buyer org not found');
    o.status = 'active'; o.verifiedBy = user.email; o.verifiedAt = now(); store.put('orgs', o);
    store.audit({ actor: user.email, orgId: o.id, action: 'buyer.verify' }); return o;
  });
  route('GET', '/api/requests', 'user', ({ user }) => {
    const o = store.get('orgs', user.orgId);
    if (o.kind === 'buyer') return store.list('bidRequests', r => r.buyerOrgId === o.id).map(r => {
      const inv = store.list('invitations', i => i.requestId === r.id);
      return { ...r, submissions: store.list('submissions', s => s.requestId === r.id).length,
        invited: inv.length, willBid: inv.filter(i => i.intent === 'will_bid').length, wontBid: inv.filter(i => i.intent === 'wont_bid').length };
    });
    return store.list('bidRequests', r => r.status === 'open').map(r => pick(r, ['id', 'title', 'city', 'state', 'projectType', 'squareFeet', 'services', 'frequencyPerMonth', 'dueDate', 'buyerName', 'buyerKind']));
  });
  route('POST', '/api/requests', 'user', ({ body, user }) => {
    if (body.projectId) { const pr = store.get('projects', resolveProjectId(store, body.projectId) || ''); need(pr, 400, 'project not found'); need(!pr.state || pr.state === String(body.state || '').toUpperCase(), 400, 'that project is in a different state than this request'); }
    try { const r = quickPublish(store, buyerOrg(user), user, body); need(r.ok, r.code || 400, r.error);
      const l = store.get('projectLinks', 'bid_request:' + r.request.id) || {};
      return { ...r.request, invited: r.invited, projectId: l.projectId || null, publicationId: r.publicationId }; }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, e.message); }
  });
  route('GET', '/api/requests/:id/submissions', 'user', ({ params, user }) => {
    const o = buyerOrg(user); const r = store.get('bidRequests', params.id); need(r && r.buyerOrgId === o.id, 404, 'not found');
    return store.list('submissions', s => s.requestId === r.id).map(s => pick(s, ['id', 'sellerName', 'sellerEmail', 'total', 'recurring', 'submittedAt', 'status']));
  });
  route('GET', '/api/submissions/:id', 'user', ({ params, user }) => {
    const o = buyerOrg(user); const sub = store.get('submissions', params.id); need(sub && sub.buyerOrgId === o.id, 404, 'not found');
    return { __html: sub.proposalHtml };
  });
  route('GET', '/api/consent-text', 'user', ({ user }) => ({ text: consentText(store.get('orgs', user.orgId).name) }));
  route('POST', '/api/requests/:id/award', 'owner', ({ params, body, user, req, ip }) => {
    need(can(user, 'award'), 403, 'your company has not given you permission to award work');
    try { const r = awardRequest(store, buyerOrg(user), user, params.id, body.submissionId, { signerName: body.signerName, consent: body.consent, ip, userAgent: req.headers['user-agent'] });
      const c = r?.contractId && store.get('contracts', r.contractId); if (c) { const pid = linkAward(store, c); if (pid) recomputePhase(store, pid); }
      return r; }
    catch (e) { throw new HttpError(e.code || 400, e.message); }
  });
  const canSeeContract = (c, user) => c && (c.buyerOrgId === user.orgId || c.sellerOrgId === user.orgId);
  route('GET', '/api/contracts', 'user', ({ user }) => store.list('contracts', c => canSeeContract(c, user))
    .map(c => ({ id: c.id, title: c.title, address: c.address, buyerName: c.buyerName, sellerName: c.sellerName, total: c.total, recurring: c.recurring, signedAt: c.acceptance.at, signerName: c.acceptance.signerName, status: c.status })));
  route('GET', '/api/contracts/:id/document', 'user', ({ params, user }) => {
    const c = store.get('contracts', params.id); need(canSeeContract(c, user), 404, 'not found'); return { __html: contractDocument(c) };
  });

  route('GET', '/api/me/notifications', 'owner', ({ user }) => {
    const org = store.get('orgs', user.orgId); need(org, 404, 'company not found');
    return { ...notificationPrefs(org), explanation: 'Invitations always appear in the app at once. Emails: "immediate" sends each batch as it arrives, "daily_digest" sends at most one per day. maxPerDay caps invitation emails per day.' };
  });
  route('PUT', '/api/me/notifications', 'owner', ({ body, user }) => {
    const org = store.get('orgs', user.orgId); need(org, 404, 'company not found');
    need(['immediate', 'daily_digest'].includes(body.mode), 400, 'mode must be immediate or daily_digest');
    const maxPerDay = Number(body.maxPerDay ?? 3);
    need(Number.isInteger(maxPerDay) && maxPerDay >= 1 && maxPerDay <= 20, 400, 'maxPerDay must be a whole number from 1 to 20');
    org.settings = { ...(org.settings || {}), notifications: { mode: body.mode, maxPerDay } };
    store.put('orgs', org); store.audit({ actor: user.email, orgId: org.id, action: 'notifications.updated', detail: { mode: body.mode, maxPerDay } });
    return notificationPrefs(org);
  });
  route('GET', '/api/digest/preview', 'owner', async ({ user }) => {
    const { buildDigest } = await import('./digest.js');
    return buildDigest(store, store.get('orgs', user.orgId), { includePlatform: user.role === 'platform_owner' });
  });

  // insurance + licenses
  route('GET', '/api/credentials', 'user', ({ user }) => store.tlist('credentials', user.orgId));
  route('POST', '/api/credentials', 'owner', ({ body, user }) => {
    need(store.get('orgs', user.orgId)?.kind !== 'buyer', 403, 'seller accounts only');
    const r = addCredential(store, user.orgId, body, user.email); need(r.ok, 400, r.errors?.join('; ')); requeueNeedsContact(store); return r.credential;
  });
  route('POST', '/api/orgs/:orgId/credentials/:id/verify', 'platform', ({ params, body, user }) => {
    const r = verifyCredential(store, params.orgId, params.id, user.email, body); need(r.ok, 400, r.errors?.join('; ')); return r.credential;
  });
  route('GET', '/api/credentials/expiring', 'user', ({ user, query }) => expiringSoon(store, user.orgId, Number(query.get('days') || 30)));
  route('POST', '/api/requests/:id/close', 'owner', ({ params, user }) => {
    try { return closeRequest(store, buyerOrg(user), user, params.id); } catch (e) { throw new HttpError(e.code || 400, e.message); }
  });

  // ---------------- trades, company profile, invitations to bid, outreach ----------------
  route('GET', '/api/trades', null, () => TRADES.map(([key, label]) => ({ key, label })));
  route('PATCH', '/api/profile', 'owner', ({ body, user }) => {
    const o = store.get('orgs', user.orgId); need(o && o.kind !== 'buyer', 403, 'subscriber accounts only');
    if (body.trades !== undefined) {
      need(Array.isArray(body.trades) && body.trades.every(t => TRADES.some(([k]) => k === t)), 400, 'unknown trade');
      o.trades = [...new Set(body.trades)];
    }
    o.legal = { ...(o.legal || {}), ...(body.legalName ? { name: String(body.legalName).slice(0, 200) } : {}), ...(body.postalAddress ? { postalAddress: String(body.postalAddress).slice(0, 300) } : {}) };
    need(!body.website || /^https?:\/\//i.test(String(body.website)), 400, 'website must be an http(s) link');
    o.profile = { ...(o.profile || {}), ...Object.fromEntries(['phone', 'website', 'description'].filter(k => body[k] !== undefined).map(k => [k, String(body[k]).slice(0, 1000)])) };
    store.put('orgs', o); store.audit({ actor: user.email, orgId: o.id, action: 'profile.update', detail: Object.keys(body) });
    return { trades: o.trades || [], legal: o.legal, profile: o.profile };
  });
  route('GET', '/api/profile', 'user', ({ user }) => { const o = store.get('orgs', user.orgId); return { trades: o.trades || [], legal: o.legal || {}, profile: o.profile || {}, territories: o.territories || [] }; });
  route('GET', '/api/invitations', 'user', ({ user }) => {
    const o = store.get('orgs', user.orgId); need(o.kind !== 'buyer', 403, 'subscriber accounts only');
    return store.list('invitations', i => i.sellerOrgId === o.id).map(i => {
      const r = store.get('bidRequests', i.requestId); if (!r) return null;
      const mine = store.list('submissions', s => s.requestId === r.id && s.sellerOrgId === o.id).sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)))[0];
      return { id: i.id, intent: i.intent, invitedAt: i.invitedAt, why: i.reason || null, request: { id: r.id, title: r.title, description: r.description, address: r.address, city: r.city, state: r.state, projectType: r.projectType,
        trades: r.trades, squareFeet: r.squareFeet, dueDate: r.dueDate, status: r.status, buyerName: r.buyerName, buyerKind: r.buyerKind, documentsUrl: r.documentsUrl,
        addendumCount: r.addendumCount || 0, addenda: r.addenda || [], documentCount: store.list('documents', d => d.requestId === r.id && !d.removed).length },
        acknowledgedThrough: i.ackAddendum || 0,
        myBid: mine ? { total: mine.total, recurring: mine.recurring, status: mine.status, submittedAt: mine.submittedAt, revision: mine.revision || 1, receiptId: mine.receiptId || null, sha256: mine.sha256 || null } : null };
    }).filter(Boolean).sort((a, b) => String(a.request.dueDate).localeCompare(String(b.request.dueDate)));
  });
  route('POST', '/api/invitations/:id/intent', 'user', ({ params, body, user }) => { const r = setIntent(store, store.get('orgs', user.orgId), user, params.id, body.intent); need(r.ok, r.code || 400, r.error); return r.invitation; });
  route('POST', '/api/invitations/:id/bid', 'user', ({ params, body, user }) => { const r = submitBid(store, store.get('orgs', user.orgId), user, params.id, body); need(r.ok, r.code || 400, r.error); return r.submission; });
  // plan room
  route('GET', '/api/requests/:id/documents', 'user', ({ params, user }) => { const r = listDocuments(store, store.get('orgs', user.orgId), params.id); need(r !== null, 404, 'not found'); return r; });
  route('POST', '/api/documents/:id/link', 'user', ({ params, user }) => { const r = viewLink(store, store.get('orgs', user.orgId), user, params.id); need(r.ok, r.code || 400, r.error); return { url: r.url }; });
  route('GET', '/api/ai/status', 'user', () => ({ enabled: !!config.anthropicKey, model: config.anthropicKey ? config.anthropicModel : null, dailyLimit: config.aiDailyLimit }));
  route('POST', '/api/documents/:id/analyze', 'user', async ({ params, user }) => { const r = await analyzeDocument(store, store.get('orgs', user.orgId), user, params.id, deps); need(r.ok, r.code || 400, r.error); return r.analysis; });
  route('GET', '/api/documents/:id/analyses', 'user', ({ params, user }) => store.tlist('analyses', user.orgId, a => a.documentId === params.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  route('POST', '/api/analyses/:id/verify', 'user', ({ params, body, user }) => { const r = verifyAnalysis(store, store.get('orgs', user.orgId), user, params.id, body); need(r.ok, r.code || 400, r.error); return r.analysis; });
  // takeoff → estimate → bid
  const orgFor = user => store.get('orgs', user.orgId);
  route('POST', '/api/estimates/project', 'user', ({ body, user }) => { const r = startForProject(store, orgFor(user), user, body); need(r.ok, r.code || 400, r.error); return r.estimate; });
  route('GET', '/api/estimates/:id/proposal', 'user', ({ params, user }) => { const h = proposalHtml(store, orgFor(user), params.id); need(h, 404, 'not found'); return { __html: h }; });
  route('GET', '/api/market', 'user', ({ user }) => { const r = marketActivity(store, notBuyer(user)); need(r.ok, r.code || 400, r.error); return r; });
  route('GET', '/api/documents', 'user', ({ user }) => {
    const o = orgFor(user);
    const reqIds = new Set([...store.list('bidRequests', r => r.buyerOrgId === o.id).map(r => r.id), ...store.list('invitations', i => i.sellerOrgId === o.id).map(i => i.requestId)]);
    return store.list('documents', d => !d.removed && reqIds.has(d.requestId)).map(d => { const r = store.get('bidRequests', d.requestId) || {};
      return { id: d.id, name: d.name, sheet: d.sheet, discipline: d.discipline, kind: d.kind, title: d.title, addendum: d.addendum, size: d.size, uploadedAt: d.uploadedAt, request: { id: r.id, title: r.title, city: r.city, state: r.state, buyerName: r.buyerName } }; })
      .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  });
  route('POST', '/api/estimates/manual', 'user', ({ body, user }) => { const r = startManual(store, orgFor(user), user, body); need(r.ok, r.code || 400, r.error); return r.estimate; });
  route('POST', '/api/estimates', 'user', ({ body, user }) => { const r = startFromAnalysis(store, orgFor(user), user, body); need(r.ok, r.code || 400, r.error); return r.estimate; });
  route('GET', '/api/estimates', 'user', ({ user, query }) => store.tlist('estimates', user.orgId, e => (!query.get('invitationId') || e.invitationId === query.get('invitationId')) && (!query.get('permitId') || e.permitId === query.get('permitId'))).map(e => computeEstimate(store, user.orgId, e)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  route('PATCH', '/api/estimates/:id', 'user', ({ params, body, user }) => { const r = updateEstimate(store, orgFor(user), user, params.id, body); need(r.ok, r.code || 400, r.error); return r.estimate; });
  route('POST', '/api/estimates/:id/submit', 'user', ({ params, body, user }) => { const r = submitEstimateAsBid(store, orgFor(user), user, params.id, body); need(r.ok, r.code || 400, r.error); return r; });
  route('POST', '/api/invitations/:id/acknowledge', 'user', ({ params, user }) => { const r = acknowledgeAddenda(store, store.get('orgs', user.orgId), user, params.id); need(r.ok, r.code || 400, r.error); return r; });
  route('GET', '/api/requests/:id/planholders', 'user', ({ params, user }) => { const r = planholders(store, store.get('orgs', user.orgId), params.id); need(r, 404, 'not found'); return r; });
  // on-drawing takeoff
  route('GET', '/api/scales', null, () => Object.keys(SCALES));
  // ---------------- Project Intelligence Core ----------------
  route('GET', '/api/core/projects/:id', 'user', ({ params, user }) => { const r = coreView(store, store.get('orgs', user.orgId), decodeURIComponent(params.id)); need(r.ok, r.code || 400, r.error); return r.project; });
  // ---------------- Super Admin portal (permission-based; every action audited) ----------------
  const A = (perm, stepUp) => ({ perm, stepUp: !!stepUp });
  const R2 = r => { need(r.ok, r.code || 400, r.error); return r; };
  route('GET', '/api/admin/me', 'user', ({ user }) => ({ email: user.email, mfa: user.mfa?.sealed ? 'enabled' : 'not enrolled', platformRoles: platformRolesOf(user), permissions: [...permissionsOf(user)], roles: Object.fromEntries(Object.entries(PLATFORM_ROLES).map(([k, v]) => [k, v.name])) }));
  route('POST', '/api/admin/step-up', 'user', ({ body, user, token, requestId }) => {
    need(isPlatformStaff(user), 403, 'not permitted');
    need(rateLimit('stepup:' + user.id, 10, 15 * 60e3), 429, 'too many attempts');
    let ok = verifyPassword(body.password || '', user.passwordHash);
    if (ok && user.mfa?.sealed) { const step = checkCode(user.mfa.sealed, body.code, user.mfa.lastStep ?? -1); ok = step != null; if (ok) { user.mfa = { ...user.mfa, lastStep: step }; store.put('users', user); } }
    adminAudit(store, { user, requestId }, { action: 'admin.step_up', target: user.id, outcome: ok ? 'success' : 'denied', detail: { mfa: !!user.mfa?.sealed } });
    need(ok, 401, user.mfa?.sealed ? 'password or authenticator code incorrect' : 'password incorrect');
    const sess = store.get('sessions', crypto.createHash('sha256').update(token).digest('hex')); sess.stepUpUntil = new Date(Date.now() + 10 * 60e3).toISOString(); store.put('sessions', sess);
    return { stepUpUntil: sess.stepUpUntil };
  });
  route('GET', '/api/admin/overview', A('admin.dashboard.read'), () => admin.overview(store));
  route('GET', '/api/admin/companies', A('admin.company.read'), ({ query }) => R2(admin.listCompanies(store, query)));
  route('GET', '/api/admin/companies/:id', A('admin.company.read'), ({ params }) => R2(admin.companyDetail(store, params.id)).company);
  route('POST', '/api/admin/companies/:id/verification-decision', A('admin.company.verify'), ({ params, body, user, requestId }) => R2(admin.companyVerificationDecision(store, { user, requestId }, params.id, body)));
  route('POST', '/api/admin/companies/:id/status', A('admin.company.suspend', true), ({ params, body, user, requestId }) => R2(admin.companyStatus(store, { user, requestId }, params.id, body)));
  route('POST', '/api/admin/companies/:id/notes', A('admin.company.read'), ({ params, body, user, requestId }) => R2(admin.addNote(store, { user, requestId }, 'company', params.id, body.body)));
  route('GET', '/api/admin/users', A('admin.user.read'), ({ query }) => R2(admin.listUsers(store, query)));
  route('GET', '/api/admin/users/:id', A('admin.user.read'), ({ params }) => R2(admin.userDetail(store, params.id)).user);
  route('POST', '/api/admin/users/:id/status', A('admin.user.manage', true), ({ params, body, user, requestId }) => R2(admin.userStatus(store, { user, requestId }, params.id, body)));
  route('POST', '/api/admin/users/:id/revoke-sessions', A('admin.user.manage', true), ({ params, body, user, requestId }) => R2(admin.userRevokeSessions(store, { user, requestId }, params.id, body)));
  route('POST', '/api/admin/users/:id/platform-roles', A('admin.roles.manage', true), ({ params, body, user, requestId }) => R2(admin.setPlatformRole(store, { user, requestId }, params.id, body)));
  route('GET', '/api/admin/authority', A('admin.publisher.review'), ({ query }) => R2(admin.authorityQueue(store, query)));
  route('POST', '/api/admin/authority/:id/decision', A('admin.publisher.review'), ({ params, body, user, requestId }) => R2(admin.authorityDecision(store, { user, requestId }, params.id, body)));
  route('GET', '/api/admin/analytics', A('admin.dashboard.read'), () => adminPhase2b.platformAnalytics(store));
  route('GET', '/api/admin/action-queue', A('admin.dashboard.read'), () => adminPhase2b.actionQueue(store));
  route('GET', '/api/admin/inquiries', A('admin.support.manage'), () => ({ items: store.list('inquiries').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 100) }));
  route('GET', '/api/admin/support', A('admin.support.manage'), ({ query }) => R2(adminSupport.listCases(store, query)));
  route('POST', '/api/admin/support', A('admin.support.manage'), ({ body, user, requestId }) => R2(adminSupport.createCase(store, { user, requestId }, body)).case);
  route('GET', '/api/admin/support/:id', A('admin.support.manage'), ({ params }) => R2(adminSupport.caseDetail(store, params.id)).case);
  route('POST', '/api/admin/support/:id/notes', A('admin.support.manage'), ({ params, body, user, requestId }) => R2(adminSupport.addNote(store, { user, requestId }, params.id, body)).case);
  route('POST', '/api/admin/support/:id/status', A('admin.support.manage'), ({ params, body, user, requestId }) => R2(adminSupport.setStatus(store, { user, requestId }, params.id, body)).case);
  route('POST', '/api/admin/support/:id/assign', A('admin.support.manage'), ({ params, body, user, requestId }) => R2(adminSupport.assign(store, { user, requestId }, params.id, body)).case);
  route('GET', '/api/admin/incidents', A('admin.support.manage'), () => adminPhase5.listIncidents(store));
  route('POST', '/api/admin/incidents', A('admin.support.manage'), ({ body, user, requestId }) => R2(adminPhase5.createIncident(store, { user, requestId }, body)).incident);
  route('POST', '/api/admin/incidents/:id/updates', A('admin.support.manage'), ({ params, body, user, requestId }) => R2(adminPhase5.updateIncident(store, { user, requestId }, params.id, body)).incident);
  route('GET', '/api/admin/jobs-overview', A('admin.dashboard.read'), () => adminPhase5.jobsOverview(store));
  route('GET', '/api/admin/health', A('admin.dashboard.read'), () => adminPhase5.healthCenter(store, config, { storageKind: store.kind || 'memory', storageError: store.lastFlushError || null }));
  route('POST', '/api/admin/exports', A('admin.dashboard.read'), ({ body, user, requestId }) => {
    const r = adminPhase5.createExport(store, { user, requestId }, body); need(r.ok, r.code || 400, r.error); return { export: r.export, token: r.token, note: 'The download token is shown once. Save it now.' }; });
  route('GET', '/api/admin/exports', A('admin.dashboard.read'), ({ user }) => adminPhase5.listExports(store, { user }));
  route('GET', '/api/admin/exports/:id/download', 'user', ({ params, query, user, requestId }) => {
    const r = adminPhase5.downloadExport(store, { user, requestId }, params.id, query.get ? query.get('token') : query.token); need(r.ok, r.code || 400, r.error); return { __csv: r.csv, filename: r.filename }; });
  route('GET', '/api/my/support/:id', 'user', ({ params, user }) => R2(adminSupport.customerView(store, params.id, user.orgId)).case);
  route('GET', '/api/admin/audit', A('admin.audit.read'), async ({ query }) => admin.auditSearch(store, query));
  // Phase 3: projects, duplicates, corrections, bid/award oversight (read-only), documents
  const C = ({ user, requestId }) => ({ user, requestId });
  route('GET', '/api/admin/projects', A('admin.project.read'), ({ query }) => R2(adminMk.listProjects(store, query)));
  route('GET', '/api/admin/projects/:id', A('admin.project.read'), ({ params }) => R2(adminMk.projectAdminDetail(store, decodeURIComponent(params.id))).project);
  route('POST', '/api/admin/projects/:id/resolve', A('admin.project.correct'), ctx => R2(adminMk.resolveProject(store, C(ctx), decodeURIComponent(ctx.params.id), ctx.body)));
  route('GET', '/api/admin/duplicates', A('admin.project.read'), ({ query }) => R2(adminMk.duplicateCandidates(store, query)));
  route('GET', '/api/admin/merge-preview', A('admin.project.read'), ({ query }) => R2(adminMk.mergePreview(store, query.get('keep'), query.get('drop'))));
  route('POST', '/api/admin/projects-merge', A('admin.project.merge', true), ctx => R2(adminMk.adminMerge(store, C(ctx), ctx.body)));
  route('POST', '/api/admin/projects/:id/split', A('admin.project.merge', true), ctx => R2(adminMk.adminSplit(store, C(ctx), decodeURIComponent(ctx.params.id), ctx.body)));
  route('POST', '/api/admin/review/:id/resolve', A('admin.project.correct'), ctx => R2(adminMk.adminResolveReview(store, C(ctx), decodeURIComponent(ctx.params.id), ctx.body)));
  route('GET', '/api/admin/packages', A('admin.bid.read'), ({ query }) => R2(adminMk.listPackages(store, query)));
  route('GET', '/api/admin/packages/:id', A('admin.bid.read'), ({ params }) => R2(adminMk.packageDetail(store, params.id)).package);
  route('POST', '/api/admin/packages/:id/access', A('admin.document.access.revoke', true), ctx => R2(adminMk.setPackageAccess(store, C(ctx), ctx.params.id, ctx.body)));
  route('GET', '/api/admin/documents', A('admin.bid.read'), ({ query }) => R2(adminMk.listDocuments(store, query)));
  route('GET', '/api/admin/documents/:id', A('admin.bid.read'), ({ params }) => R2(adminMk.documentDetail(store, params.id)).document);
  route('POST', '/api/admin/documents/:id/quarantine', A('admin.document.access.revoke', true), ctx => R2(adminMk.setQuarantine(store, C(ctx), ctx.params.id, ctx.body)));
  route('GET', '/api/admin/markets', A('admin.dashboard.read'), () => adminMk.tradesAndMarkets(store));
  // Phase 4 (no owner credentials needed): subscriptions, data sources, AI usage
  route('GET', '/api/admin/subscriptions', A('admin.billing.read'), ({ query }) => R2(adminOps.listSubscriptions(store, query)));
  route('POST', '/api/admin/subscriptions/:id/adjust', A('admin.billing.manage', true), ctx => R2(adminOps.adjustSubscription(store, C(ctx), ctx.params.id, ctx.body)));
  route('GET', '/api/admin/sources', A('admin.source.manage'), ({ query }) => R2(adminOps.listSources(store, query)));
  route('GET', '/api/admin/sources/:id', A('admin.source.manage'), ({ params }) => R2(adminOps.sourceDetail(store, params.id)).source);
  route('POST', '/api/admin/sources/:id/enabled', A('admin.source.manage'), ctx => R2(adminOps.setSourceEnabled(store, C(ctx), ctx.params.id, ctx.body)));
  route('POST', '/api/admin/sources/:id/probe', A('admin.source.manage'), async ctx => { const src = store.get('sources', ctx.params.id); need(src, 404, 'source not found');
    const r = await probeSource(src, ctx.user.email, ctx.body); adminAudit(store, C(ctx), { action: 'admin.source.probe', target: src.id }); return r; });
  route('POST', '/api/admin/sources/:id/retry', A('admin.source.manage'), async ctx => { const src = store.get('sources', ctx.params.id); need(src, 404, 'source not found');
    need(src.enabled, 409, 'source is paused — resume it first'); need(String(ctx.body.reason || '').trim().length >= 5, 400, 'a reason is required (5+ characters)');
    const { collectSources } = await import('./autopilot.js');
    const lock = await store.withLock('collect:' + src.id, () => collectSources(store, { only: src.id, fetchImpl: deps.fetchImpl }));
    need(lock.ran, 409, 'another pull of this source is running');
    const linked = backfillCore(store);                          // link new permits to projects, as the hourly cycle does
    adminAudit(store, C(ctx), { action: 'admin.source.retry', target: src.id, reason: ctx.body.reason, detail: { result: lock.result[0] || null, newProjects: linked.newProjects } });
    return { result: lock.result[0] || null, newProjects: linked.newProjects }; });
  route('POST', '/api/admin/sources/:id/resync', A('admin.source.manage', true), ctx => { const src = store.get('sources', ctx.params.id); need(src, 404, 'source not found');
    need(String(ctx.body.reason || '').trim().length >= 5, 400, 'a reason is required (5+ characters)');
    const r = resyncSource(src, ctx.user.email); adminAudit(store, C(ctx), { action: 'admin.source.resync', target: src.id, reason: ctx.body.reason, detail: r }); return r; });
  route('GET', '/api/admin/ai/usage', A('admin.ai.manage'), ({ query }) => R2(adminOps.aiUsage(store, query)));
  route('POST', '/api/admin/ai/:id/limit', A('admin.ai.manage'), ctx => R2(adminOps.setAiLimit(store, C(ctx), ctx.params.id, ctx.body)));
  // MFA (authenticator app) for platform staff
  route('POST', '/api/admin/mfa/setup', 'user', ({ user, requestId }) => {
    need(isPlatformStaff(user), 403, 'not permitted'); need(!user.mfa?.sealed, 409, 'MFA is already on — ask a security admin to reset it');
    const secret = newSecret(); user.mfaPending = { sealed: seal(secret), at: new Date().toISOString() }; store.put('users', user);
    adminAudit(store, { user, requestId }, { action: 'admin.mfa.setup', target: user.id });
    return { secret, uri: otpauthUri(user.email, secret) };
  });
  route('POST', '/api/admin/mfa/enable', 'user', ({ user, body, requestId }) => {
    need(user.mfaPending?.sealed, 409, 'start setup first');
    const step = checkCode(user.mfaPending.sealed, body.code); need(step != null, 400, 'that code is not valid — check the time on your phone and try again');
    user.mfa = { sealed: user.mfaPending.sealed, enabledAt: new Date().toISOString(), lastStep: step }; delete user.mfaPending; store.put('users', user);
    adminAudit(store, { user, requestId }, { action: 'admin.mfa.enable', target: user.id }); return { mfa: 'enabled' };
  });
  route('POST', '/api/admin/users/:id/mfa-reset', A('admin.security.manage', true), ({ params, body, user, requestId }) => {
    const u = store.get('users', params.id); need(u, 404, 'user not found'); need(u.mfa?.sealed, 409, 'MFA is not enabled for this user');
    need(String(body.reason || '').trim().length >= 5, 400, 'a reason is required (5+ characters)'); need(u.id !== user.id, 409, 'you cannot reset your own MFA');
    delete u.mfa; delete u.mfaPending; store.put('users', u); const revoked = admin.revokeAllSessions(store, u.id);
    adminAudit(store, { user, requestId }, { action: 'admin.mfa.reset', target: u.id, orgId: u.orgId, reason: body.reason, detail: { sessionsRevoked: revoked } });
    return { ok: true, sessionsRevoked: revoked };
  });

  // ---------------- Project Publishing & subscriptions ----------------
  const pubOrg = user => { const o = store.get('orgs', user.orgId); need(o?.kind === 'buyer', 403, 'publisher accounts only'); return o; };
  const R = (r, pick) => { need(r.ok, r.code || 400, r.error); return pick ? r[pick] : r; };
  route('GET', '/api/publisher', 'user', ({ user }) => { const o = pubOrg(user); return { kind: o.buyerKind, publisher: o.publisher || { status: 'unverified' }, verified: isVerifiedPublisher(o), relationships: RELATIONSHIPS, permissions: PERMISSIONS }; });
  route('POST', '/api/publisher/verification', 'owner', ({ body, user }) => R(requestVerification(store, pubOrg(user), user, body), 'publisher'));
  route('GET', '/api/admin/publishers', 'platform', () => store.list('orgs', o => o.kind === 'buyer').map(o => ({ id: o.id, name: o.name, kind: o.buyerKind, status: o.publisher?.status || 'unverified', evidence: o.publisher?.evidence || null, requestedAt: o.publisher?.requestedAt || null, note: o.publisher?.note || null, publications: store.list('publications', p => p.publisherOrgId === o.id).length }))
    .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || String(b.requestedAt).localeCompare(String(a.requestedAt))));
  route('POST', '/api/admin/publishers/:id/decide', 'platform', ({ params, body, user }) => R(decideVerification(store, user, params.id, body), 'publisher'));
  route('GET', '/api/publications', 'user', ({ user }) => { const o = pubOrg(user); return store.list('publications', p => p.publisherOrgId === o.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(p => { const c = coverage(store, o, p.id); return { ...p, totals: c.totals, ready: c.checklist.ready }; }); });
  route('POST', '/api/publications', 'user', ({ body, user }) => R(createPublication(store, pubOrg(user), user, body), 'publication'));
  route('GET', '/api/publications/:id', 'user', ({ params, user }) => { const c = coverage(store, pubOrg(user), params.id); need(c, 404, 'not found'); return c; });
  route('PATCH', '/api/publications/:id', 'user', ({ params, body, user }) => {
    const o = pubOrg(user), p = store.get('publications', params.id); need(p && p.publisherOrgId === o.id, 404, 'not found'); need(can(user, 'publish'), 403, 'no permission'); need(p.status === 'draft', 409, 'only drafts can be edited (add a package or an addendum instead)');
    for (const k of ['title', 'description', 'estValue', 'buildingSf']) if (body[k] !== undefined) p[k] = k === 'estValue' || k === 'buildingSf' ? Number(body[k]) || null : String(body[k]).slice(0, k === 'title' ? 200 : 4000);
    if (body.authorizationEvidence !== undefined) p.authority = { ...p.authority, evidence: String(body.authorizationEvidence).slice(0, 2000) };
    store.put('publications', p); return p; });
  route('POST', '/api/publications/:id/packages', 'user', ({ params, body, user }) => R(addPackage(store, pubOrg(user), user, params.id, body), 'package'));
  route('PATCH', '/api/packages/:id', 'user', ({ params, body, user }) => {
    const o = pubOrg(user), r = store.get('bidRequests', params.id); need(r && r.buyerOrgId === o.id && r.publicationId, 404, 'not found'); need(can(user, 'publish') || can(user, 'invite'), 403, 'no permission');
    if (r.status !== 'draft') { need(Object.keys(body).every(k => k === 'invitees'), 409, 'published packages: change dates or scope with an addendum; you can still invite more bidders'); }
    for (const k of ['description', 'inclusions', 'exclusions', 'instructions', 'contactName', 'title']) if (body[k] !== undefined) r[k] = String(body[k]).slice(0, 4000);
    if (body.dueDate !== undefined) { need(Date.parse(body.dueDate) > Date.now(), 400, 'due date must be in the future'); r.dueDate = body.dueDate; }
    if (body.trades !== undefined) { need(Array.isArray(body.trades) && body.trades.length && body.trades.every(t => TRADES.some(([k]) => k === t)), 400, 'unknown trade'); r.trades = body.trades; }
    if (body.distribution !== undefined) r.distribution = body.distribution === 'invite_only' ? 'invite_only' : 'eligible';
    if (body.noDocuments !== undefined) r.noDocuments = !!body.noDocuments;
    if (body.invitees !== undefined) { need(Array.isArray(body.invitees), 400, 'invitees must be a list');
      const added = body.invitees.filter(id => !(r.invitees || []).includes(id)); r.invitees = [...new Set([...(r.invitees || []), ...body.invitees.map(String)])].slice(0, 500);
      if (r.status === 'open') inviteCompanies(store, r, added); }
    store.put('bidRequests', r); return r; });
  route('DELETE', '/api/packages/:id', 'user', ({ params, user }) => { const o = pubOrg(user), r = store.get('bidRequests', params.id); need(r && r.buyerOrgId === o.id && r.publicationId, 404, 'not found'); need(r.status === 'draft', 409, 'only draft packages can be removed'); need(can(user, 'publish'), 403, 'no permission'); store.remove('bidRequests', r.id); return { ok: true }; });
  route('POST', '/api/publications/:id/publish', 'user', ({ params, user }) => R(publish(store, pubOrg(user), user, params.id)));
  route('POST', '/api/publications/:id/status', 'user', ({ params, body, user }) => R(setStatus(store, pubOrg(user), user, params.id, body.status), 'publication'));
  route('GET', '/api/bidders', 'user', ({ user, query }) => { pubOrg(user); return searchBidders(store, { q: query.get('q'), trade: query.get('trade'), state: query.get('state') }); });
  route('GET', '/api/subscription', 'user', ({ user }) => { const o = store.get('orgs', user.orgId); const e = entitlementsFor(o);
    return { entitlements: e, usage: usage(store, o), catalog: Object.entries(CATALOG).filter(([k, v]) => v.line === (o.kind === 'buyer' ? 'publisher' : 'subscriber') && k !== 'trial').map(([k, v]) => ({ key: k, ...v })), priceStatus: PRICE_STATUS }; });

  // ---------------- National Plan Room ----------------
  route('GET', '/api/planroom/sets', 'user', ({ user, query }) => listSets(store, store.get('orgs', user.orgId), { projectId: query.get('projectId') || null }));
  route('GET', '/api/planroom/search', 'user', ({ user, query }) => {
    need(rateLimit('docsearch:' + user.id, 120, 60e3), 429, 'too many searches, wait a minute');
    return searchDocuments(store, store.get('orgs', user.orgId), query.get('q'));
  });
  route('GET', '/api/planroom/compare', 'user', ({ user, query }) => { const r = compareRevisions(store, store.get('orgs', user.orgId), query.get('from'), query.get('to')); need(r.ok, r.code || 400, r.error); return r; });
  route('GET', '/api/planroom/status', 'platform', () => ({ documents: store.list('documents', d => !d.removed).length, textIndexed: store.list('documentText', t => !t.error).length,
    textErrors: store.list('documentText', t => t.error).map(t => ({ documentId: t.documentId, error: t.error })), sets: store.list('drawingSets').length, sheets: store.list('drawingSheets').length, revisions: store.list('drawingRevisions').length }));
  route('GET', '/api/core/pick', 'user', ({ query }) => pickProjects(store, { state: query.get('state'), q: query.get('q') }));
  route('GET', '/api/core/lookup', 'user', ({ query }) => { const kind = query.get('kind') || 'permit', ref = query.get('ref'); const l = store.get('projectLinks', `${kind}:${ref}`); need(l, 404, 'not linked'); return { projectId: resolveProjectId(store, l.projectId), method: l.method, confidence: l.confidence }; });
  route('GET', '/api/core/search', 'user', async ({ user, query }) => {
    const o = store.get('orgs', user.orgId); const a = (await import('./billing.js')).leadAccess(o); need(a.ok, 402, a.reason);
    const args = { states: o.subscription?.plan === 'internal' ? null : a.states, q: query.get('q'), type: query.get('type'), phase: query.get('phase'), minValue: query.get('minValue'), limit: query.get('limit') };
    return { engine: store.kind === 'postgres' ? 'postgres' : 'memory', results: store.kind === 'postgres' ? await searchCoreSql(store.pool, args) : searchCoreMemory(store, args) };
  });
  route('GET', '/api/core/stats', 'platform', async () => ({
    projects: store.list('projects').length, links: store.list('projectLinks').length, companies: store.list('projectCompanies').length,
    byPhase: store.list('projects').reduce((m, p) => (m[p.phase] = (m[p.phase] || 0) + 1, m), {}),
    openReview: store.list('reviewQueue', r => r.status === 'open').length, reconcile: store.kind === 'postgres' ? await reconcileCore(store.pool, store) : null }));
  route('GET', '/api/core/parity', 'platform', () => ({ coreReads: config.coreReads, ...parityReport(store) }));
  route('POST', '/api/core/backfill', 'platform', () => backfillCore(store, { full: true }));
  route('GET', '/api/core/review', 'platform', () => store.list('reviewQueue', r => r.status === 'open'));
  route('POST', '/api/core/review/:id/resolve', 'platform', ({ params, body, user }) => { const r = resolveReview(store, decodeURIComponent(params.id), body.projectId, user.email); need(r.ok, r.code || 400, r.error); return r; });
  route('POST', '/api/core/merge', 'platform', ({ body, user }) => { const r = mergeProjects(store, body.keepId, body.dropId, user.email); need(r.ok, r.code || 400, r.error); return r; });
  route('POST', '/api/core/split', 'platform', ({ body, user }) => { const r = splitLinks(store, body.projectId, body.linkIds || [], user.email); need(r.ok, r.code || 400, r.error); return r; });
  route('GET', '/api/documents/:id/measurements', 'user', ({ params, user }) => listMeasurements(store, store.get('orgs', user.orgId), params.id));
  route('POST', '/api/documents/:id/measurements', 'user', ({ params, body, user }) => { const r = saveMeasurement(store, store.get('orgs', user.orgId), user, params.id, body); need(r.ok, r.code || 400, r.error); return r.measurement; });
  route('DELETE', '/api/measurements/:id', 'user', ({ params, user }) => { const r = deleteMeasurement(store, store.get('orgs', user.orgId), params.id); need(r.ok, r.code || 400, r.error); return r; });
  route('POST', '/api/estimates/measurements', 'user', ({ body, user }) => { const r = startFromMeasurements(store, store.get('orgs', user.orgId), user, body); need(r.ok, r.code || 400, r.error); return r.estimate; });
  // prequalification + bid leveling (GC side)
  route('GET', '/api/requests/:id/leveling', 'user', ({ params, user }) => { const r = leveling(store, store.get('orgs', user.orgId), params.id); need(r, 404, 'not found'); return r; });
  route('POST', '/api/prequal/:sellerId', 'owner', ({ params, body, user }) => { const r = setPrequal(store, store.get('orgs', user.orgId), user, params.sellerId, body); need(r.ok, r.code || 400, r.error); return r.prequal; });
  route('GET', '/api/prequal/me', 'user', ({ user }) => prequalProfile(store, store.get('orgs', user.orgId)));
  route('POST', '/api/projects/:id/contact', 'user', async ({ params, body, user }) => {
    const r = await contactFromProject(store, notBuyer(user), user, params.id, body, deps); need(r.ok, r.code || 400, r.error); return r;
  });

  // engagement + intelligence
  route('GET', '/api/analytics', 'user', ({ user }) => analytics(store, user.orgId));
  route('GET', '/api/directory/gaps', 'user', ({ user }) => directoryGaps(store, user.orgId));
  route('POST', '/api/directory/import', 'platform', ({ raw, user }) => {
    const r = importDirectory(store, raw, user.email); r.requeued = requeueNeedsContact(store); return r;
  });
  route('POST', '/api/bids/:id/clear-attention', 'owner', ({ params, user }) => {
    const bid = store.tget('bids', user.orgId, params.id); need(bid, 404, 'not found');
    bid.needsAttention = false; store.tput('bids', user.orgId, bid); return bid;
  });

  // ---------------- lead intelligence (subscribers) ----------------
  const orgOf = user => store.get('orgs', user.orgId);
  const notBuyer = user => { const o = orgOf(user); need(o?.kind !== 'buyer', 403, 'subscriber accounts only'); need(o.status !== 'pending_verification', 403, 'confirm your email to see leads'); return o; };
  // Public: who the data comes from, plus any disclaimer a source's terms require (e.g. City of Chicago).
  route('GET', '/api/attributions', null, () => store.list('sources', x => x.enabled).map(x => ({ name: x.name, agency: x.agency, url: x.url, disclaimer: x.attribution || null })));
  route('GET', '/api/lead-plans', null, () => ({ plans: LEAD_PLANS, states: ALL_STATES }));
  route('GET', '/api/work-tags', null, async () => (await import('./leads.js')).WORK_TAGS.map(([key, label]) => ({ key, label })));
  route('GET', '/api/access', 'user', ({ user }) => { const o = orgOf(user); const a = leadAccess(o); return { ...a, states: a.states, trialEndsAt: o.subscription?.trialEndsAt || null, territories: o.territories || [], trade: o.trade || null }; });
  route('PATCH', '/api/territories', 'owner', ({ body, user }) => {
    const o = notBuyer(user);
    const states = [...new Set((body.states || []).map(s => String(s).toUpperCase()))];
    need(states.length && states.every(s => ALL_STATES.includes(s)), 400, 'states must be US state codes');
    const max = LEAD_PLANS[o.subscription?.plan]?.states ?? 51;
    need(states.length <= max, 400, `your plan covers ${max} state(s)`);
    o.territories = states; store.put('orgs', o); store.audit({ actor: user.email, orgId: o.id, action: 'territories.update', detail: states }); return { territories: states };
  });
  route('GET', '/api/command-center', 'user', ({ user }) => { const r = commandCenter(store, notBuyer(user)); need(r.ok, r.code || 400, r.error); return r.kpis; });
  route('GET', '/api/projects/map', 'user', ({ user, query }) => { const r = mapPoints(store, notBuyer(user), query); need(r.ok, r.code || 400, r.error); return r; });
  route('GET', '/api/projects/export', 'owner', ({ user, query }) => {
    const r = exportCsv(store, notBuyer(user), query); need(r.ok, r.code || 400, r.error);
    store.audit({ actor: user.email, orgId: user.orgId, action: 'projects.export', detail: { rows: r.rows } });
    return { __csv: r.csv, filename: `buildintel-projects-${new Date().toISOString().slice(0, 10)}.csv` };
  });
  route('GET', '/api/projects', 'user', async ({ user, query }) => {
    const opts = { page: Math.max(1, Number(query.get('page')) || 1), pageSize: Math.min(100, Number(query.get('pageSize')) || 50), sort: query.get('sort') || 'newest' };
    // SQL_READS=on: search runs in PostgreSQL (identical results — test/sql-reads.test.js); otherwise, or for the one
    // filter it doesn't support, the in-memory path.
    const sql = config.sqlReads === 'on' && store.kind === 'postgres' && sqlSupports(parseFilters(query));
    const r = sql ? await sqlSearchProjects(store, notBuyer(user), query, opts) : searchProjects(store, notBuyer(user), query, opts);
    need(r.ok, r.code || 400, r.error); return r;
  });
  route('GET', '/api/projects/:id', 'user', ({ user, params }) => { const r = projectDetail(store, notBuyer(user), params.id); need(r.ok, r.code || 400, r.error); return r.project; });
  route('POST', '/api/projects/:id/track', 'user', ({ user, params, body }) => { const r = trackProject(store, notBuyer(user), user, params.id, body); need(r.ok, r.code || 400, r.error); return r.tracked; });
  route('GET', '/api/tracked', 'user', ({ user }) => {
    const o = notBuyer(user);
    return store.tlist('tracked', o.id).map(t => { const d = projectDetail(store, o, t.permitId); return d.ok ? { ...t, project: { id: d.project.id, title: d.project.title, address: d.project.address, city: d.project.city, state: d.project.state, stage: d.project.stage, estimatedStart: d.project.estimatedStart } } : null; }).filter(Boolean);
  });
  route('GET', '/api/contractors', 'user', ({ user, query }) => { const r = contractors(store, notBuyer(user), query); need(r.ok, r.code || 400, r.error); return r; });
  route('GET', '/api/contractors/:key', 'user', ({ user, params }) => { const r = contractorDetail(store, notBuyer(user), decodeURIComponent(params.key)); need(r.ok, r.code || 400, r.error); return r.contractor; });
  route('GET', '/api/signals', 'user', ({ user, query }) => { const r = planningSignals(store, notBuyer(user), query); need(r.ok, r.code || 400, r.error); return r; });
  route('GET', '/api/searches', 'user', ({ user }) => store.tlist('savedSearches', notBuyer(user).id));
  route('POST', '/api/searches', 'user', ({ user, body }) => { const r = saveSearch(store, notBuyer(user), user, body); need(r.ok, 400, r.error); return r.search; });
  route('DELETE', '/api/searches/:id', 'user', ({ user, params }) => {
    const o = notBuyer(user); const s2 = store.tget('savedSearches', o.id, params.id); need(s2, 404, 'not found');
    delete store.data.savedSearches[s2.id]; store.mark('savedSearches', s2.id, 'del'); store.audit({ actor: user.email, orgId: o.id, action: 'search.delete', target: s2.id }); return { ok: true };
  });
  route('GET', '/api/searches/alerts-preview', 'user', ({ user }) => collectAlerts(store, notBuyer(user)).map(a => ({ search: a.search.name, hits: a.hits.length })));

  // Probe a Socrata dataset: shows real column names + one sample row so a field map is set from evidence, not guesses.
  // Re-pull a source cleanly after its mapping or filters change: old records are archived (hidden, kept for audit)
  // and the sync cursor is reset, so the next cycle backfills under the current rules.
  const resyncSource = (src, actor) => {
    let archived = 0;
    for (const p of store.list('permits', p => p.sourceId === src.id && !p.archived)) { p.archived = true; p.archivedAt = now(); store.put('permits', p); archived++; }
    src.syncCursor = null; src.lastRecordDate = null; store.put('sources', src);
    store.audit({ actor, action: 'source.resync', target: src.id, detail: { archived } });
    return { archived };
  };
  const probeSource = async (src, actor, body) => {
    need(['socrata', 'arcgis', 'license-socrata', 'signals-socrata'].includes(src?.adapter), 400, 'probe supports Socrata, ArcGIS, license and signal sources');
    const { probeSocrata, probeArcgis } = await import('./sources/adapters.js');
    let r; try { r = await (src.adapter === 'arcgis' ? probeArcgis : probeSocrata)(src.adapterConfig, { fetchImpl: deps.fetchImpl || fetch, distinct: body?.distinct }); } catch (e) { throw new HttpError(502, 'source unreachable: ' + e.message); }
    src.lastProbe = { at: now(), lastUpdated: r.lastUpdated, license: r.license, missing: r.mappedFieldsMissing };
    store.put('sources', src); store.audit({ actor, action: 'source.probe', target: src.id, detail: src.lastProbe });
    return r;
  };
  route('POST', '/api/sources/:id/resync', 'platform', ({ params, user }) => { const src = store.get('sources', params.id); need(src, 404, 'not found'); return { ok: true, ...resyncSource(src, user.email) }; });   // shared with /admin; response shape unchanged

  route('POST', '/api/sources/:id/probe', 'platform', async ({ params, user, body }) => probeSource(store.get('sources', params.id), user.email, body));   // shared with /admin


  // billing
  route('GET', '/api/plans', null, () => PLANS);
  route('GET', '/api/plan-comparison', null, () => planComparison());
  route('POST', '/api/billing/checkout', 'owner', async ({ body, user }) => {
    need((PLANS[body.plan] || LEAD_PLANS[body.plan]) && !['internal', 'trial'].includes(body.plan), 400, 'unknown plan');
    const r = await createCheckout(store.get('orgs', user.orgId), body.plan, deps); need(r.ok, 400, r.error); return r;
  });

  // privacy admin
  route('GET', '/api/privacy/requests', 'platform', () => store.list('privacyRequests'));
  route('POST', '/api/privacy/requests/:id/resolve', 'platform', ({ params, body, user }) => {
    const r = store.get('privacyRequests', params.id); need(r, 404, 'not found');
    const matches = store.list('contacts', c => (c.email || '').toLowerCase() === r.email);
    let result = { matchedContacts: matches.length };
    if (r.type === 'access') result.export = matches;
    if (r.type === 'delete') { for (const c of matches) store.remove('contacts', c.id); store.suppressEverywhere(r.email, 'deletion request', 'privacy_request'); }
    if (r.type === 'correct' && body.correction) for (const c of matches) store.put('contacts', { ...c, ...pick(body.correction, ['name', 'role', 'status']) });
    Object.assign(r, { status: 'resolved', resolvedAt: now(), resolvedBy: user.email, result: { ...result, export: undefined } });
    store.put('privacyRequests', r); store.audit({ actor: user.email, action: 'privacy.resolve', target: r.id, detail: { type: r.type } });
    return { request: r, ...result };
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ip = (config.trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
    try {
      // static + special pages
      // Self-hosted viewer library (pdf.js, Apache-2.0): exact allowlist, cached.
      const VENDOR = { '/vendor/pdf.min.mjs': 'pdf.min.mjs', '/vendor/pdf.worker.min.mjs': 'pdf.worker.min.mjs', '/vendor/leaflet.js': 'leaflet.js', '/vendor/leaflet.css': 'leaflet.css' };
      if (req.method === 'GET' && VENDOR[url.pathname]) {
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff' });
        return fs.createReadStream(path.join(ROOT, 'public/vendor', VENDOR[url.pathname])).pipe(res);
      }
      // Super Admin portal: its own page and script (the API enforces every permission; the page holds no data).
      if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/'))
        return send(res, 200, fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/main.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/main.js')).pipe(res); }
      if (req.method === 'GET' && url.pathname === '/app.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/app.css')).pipe(res); }
      if (req.method === 'GET' && url.pathname === '/admin.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/admin.css')).pipe(res); }
      if (req.method === 'GET' && url.pathname === '/gallery.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/gallery.css')).pipe(res); }
      if (req.method === 'GET' && url.pathname === '/plain.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/plain.css')).pipe(res); }
      if (req.method === 'GET' && url.pathname === '/admin.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/admin.js')).pipe(res); }
      // Public marketing website. The authenticated product workspace stays at /app and /login.
      if (req.method === 'GET' && url.pathname === '/site.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/site.css')).pipe(res); }
      if (req.method === 'GET' && url.pathname === '/site.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/site.js')).pipe(res); }
      if (req.method === 'GET' && (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico')) { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/favicon.svg')).pipe(res); }
      if (req.method === 'GET' && url.pathname.startsWith('/bid/') && url.pathname.length > 5) return sendFramable(res, 200, fs.readFileSync(path.join(ROOT, 'public/bid.html'), 'utf8'));
      if (req.method === 'GET' && url.pathname === '/bid.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/bid.js')).pipe(res); }
      if (req.method === 'GET' && url.pathname === '/product.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/product.css')).pipe(res); }
      if (req.method === 'GET' && url.pathname === '/ui-screens') return sendFramable(res, 200, fs.readFileSync(path.join(ROOT, 'public/ui-screens/index.html'), 'utf8'));
      if (req.method === 'GET' && url.pathname === '/home.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/home.css')).pipe(res); }
      if (req.method === 'GET' && url.pathname === '/pages.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...SEC_HEADERS }); return fs.createReadStream(path.join(ROOT, 'public/pages.css')).pipe(res); }
      const PUBLIC_PAGES = new Set(['get-started', 'platform', 'project-intelligence', 'marketplace', 'plan-room', 'takeoff-estimating', 'bid-management', 'service-contractors', 'data-trust', 'pricing', 'about', 'solutions', 'contact', 'faq']);
      const publicPage = url.pathname.replace(/^\/|\/$/g, '');
      if (req.method === 'GET' && PUBLIC_PAGES.has(publicPage)) return sendFramable(res, 200, fs.readFileSync(path.join(ROOT, 'public/pages', publicPage + '.html'), 'utf8'));
      if (req.method === 'GET' && url.pathname === '/')
        return sendFramable(res, 200, fs.readFileSync(path.join(ROOT, 'public/site.html'), 'utf8'));
      if (req.method === 'GET' && ['/app', '/app/', '/login', '/index.html'].includes(url.pathname))
        return send(res, 200, fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname.startsWith('/legal/')) {
        const f = path.join(ROOT, 'docs/policies', path.basename(url.pathname) + '.md');
        need(fs.existsSync(f), 404, 'not found');
        return send(res, 200, fs.readFileSync(f, 'utf8'), 'text/plain; charset=utf-8');
      }
      if (url.pathname.startsWith('/u/')) return unsubscribe(req, res, url, store);
      const up = req.method === 'POST' && url.pathname.match(/^\/api\/requests\/([^/]+)\/documents$/);
      if (up) {
        const user = sessionUser(store, (req.headers.authorization || '').replace(/^Bearer /, ''));
        if (!user) return send(res, 401, { error: 'sign in required' });
        const org = store.get('orgs', user.orgId);
        if (org?.kind !== 'buyer') return send(res, 403, { error: 'only the GC/owner that posted the request can upload' });
        if (!can(user, 'upload')) return send(res, 403, { error: 'your company has not given you permission to upload documents' });
        const chunks = []; let size = 0, tooBig = false;
        await new Promise((resolve, reject) => { req.on('data', c => { size += c.length; if (size > config.maxDocBytes) { tooBig = true; } else chunks.push(c); }); req.on('end', resolve); req.on('error', reject); });
        if (tooBig) return send(res, 413, { error: `file is larger than ${Math.round(config.maxDocBytes / 1048576)} MB` });
        const r = saveDocument(store, org, user, up[1], { name: url.searchParams.get('name'), buffer: Buffer.concat(chunks), addendum: url.searchParams.get('addendum') === '1', note: url.searchParams.get('note') });
        if (r.ok) { const d = store.get('documents', r.document.id); linkDocument(store, d); syncDocument(store, d);
          indexDocument(store, d.id).then(() => store.save()).catch(e => console.error('text index failed', e.message)); }  // background
        store.save();
        return send(res, r.ok ? 200 : r.code, r.ok ? r.document : { error: r.error });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/docs/')) {
        const r = openFromLink(store, url.pathname.slice(6)); store.save();
        if (!r.ok) return send(res, r.code, `<p>${r.error}</p>`, 'text/html; charset=utf-8');
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${r.name.replace(/"/g, '')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
        return fs.createReadStream(r.file).pipe(res);
      }
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname.startsWith('/verify/')) {
        // GET shows a confirmation page and changes nothing. Only the POST activates the account, so a link
        // prefetched by a mail scanner cannot confirm anyone.
        const token = url.pathname.slice(8);
        const p = unsign(token);
        const org = p?.o && store.get('orgs', p.o);
        const valid = org && ['buyer', 'subscriber'].includes(org.kind) && Date.now() - p.t < 7 * 864e5;
        const page = (code, inner) => send(res, code, `<!doctype html><meta name=viewport content="width=device-width"><link rel=stylesheet href="/plain.css"><body class=plain>${inner}</body>`, 'text/html');
        const signIn = '<p><a href="/app">Sign in</a></p>';
        if (!valid) return page(400, '<h1>This link is invalid or has expired</h1><p>Sign up again or ask BUILDINTEL support for a new link.</p>');
        if (req.method === 'GET') {
          if (org.status !== 'pending_verification') return page(200, `<h1>Email already confirmed</h1>${signIn}`);
          return page(200, `<h1>Confirm your email</h1><p>Press the button to confirm this address and start using BUILDINTEL.</p><form method="POST" action="/verify/${token}"><button type="submit">Confirm email</button></form>`);
        }
        if (org.status === 'pending_verification') {
          org.status = 'active'; org.verifiedAt = now(); org.verifiedBy = 'email'; store.put('orgs', org);
          store.audit({ actor: 'email', orgId: org.id, action: 'buyer.verify' }); store.save();
        }
        return page(200, `<h1>Email confirmed</h1><p>${org.kind === 'buyer' ? 'You can sign in and post bid requests now.' : 'Your 14-day trial has started. Sign in to search projects.'}</p>${signIn}`);
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/stripe') {
        const raw = await readBody(req);
        if (!verifyStripeSignature(raw, req.headers['stripe-signature'], config.stripeWebhookSecret)) return send(res, 400, { error: 'bad signature' });
        const r = applyStripeEvent(store, JSON.parse(raw)); store.save(); return send(res, 200, r);
      }

      const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
      need(r, 404, 'not found');
      const raw = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : '';
      const isCsv = (req.headers['content-type'] || '').includes('text/csv');
      const body = isCsv ? {} : json(raw); need(body !== null, 400, 'invalid JSON');
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      let user = null; const requestId = admin.newRequestId();
      if (r.auth) {
        user = sessionUser(store, token); need(user, 401, 'sign in required');
        // A suspended company's members are refused everywhere (platform staff are never suspended this way).
        if (!isPlatformStaff(user) && store.get('orgs', user.orgId)?.status === 'suspended') { const e = new Error('this company account is suspended — contact BUILDINTEL support'); e.code = 403; throw e; }
        if (r.auth === 'platform') need(user.role === 'platform_owner', 403, 'platform owner only');
        if (r.auth === 'owner') need(isOrgOwner(user), 403, 'company owner only');
        if (typeof r.auth === 'object') {          // Super Admin: explicit permission, deny by default, denials audited
          if (!hasPerm(user, r.auth.perm)) {
            adminAudit(store, { user, requestId }, { action: 'admin.denied', target: `${req.method} ${url.pathname}`, orgId: user.orgId, outcome: 'denied', detail: { permission: r.auth.perm } }); store.save();
            const e = new Error('not permitted'); e.code = 403; throw e;
          }
          if (r.auth.stepUp) { const sess = store.get('sessions', crypto.createHash('sha256').update(token).digest('hex'));
            if (!(sess?.stepUpUntil && Date.parse(sess.stepUpUntil) > Date.now())) { const e = new Error('confirm your password to continue (step-up required)'); e.code = 428; throw e; } }
        }
      }
      const out = await r.fn({ req, body, raw, query: url.searchParams, params: url.pathname.match(r.re).groups || {}, user, token, ip, requestId });
      if (req.method !== 'GET') store.save();
      if (out?.__html) return sendDocument(res, 200, out.__html);
      if (out?.__csv !== undefined) { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"`, ...SEC_HEADERS }); return res.end(out.__csv); }
      return send(res, 200, out);
    } catch (e) {
      const code = e.code && Number.isInteger(e.code) ? e.code : 500;
      if (code === 500) console.error(e);
      return send(res, code, { error: code === 500 ? 'internal error' : e.message, ...(code !== 500 && e.extra ? e.extra : {}) });
    }
  });
}

async function unsubscribe(req, res, url, store) {
  const payload = unsign(url.pathname.slice(3));
  if (!payload?.e) return send(res, 400, '<p>This unsubscribe link is invalid.</p>', 'text/html');
  const page = msg => `<!doctype html><meta name=viewport content="width=device-width"><title>Unsubscribe</title><link rel=stylesheet href="/plain.css"><body class=plain>${msg}</body>`;
  if (req.method === 'POST') {
    store.suppressEverywhere(payload.e, 'unsubscribe link', 'email'); store.save();
    return send(res, 200, page(`<h1>You're unsubscribed</h1><p>${payload.e} will not receive further proposals from any company on this platform.</p>`), 'text/html');
  }
  return send(res, 200, page(`<h1>Unsubscribe</h1><p>Stop all proposal emails to ${payload.e}?</p><form method=post><button class=plain-btn>Unsubscribe</button></form>`), 'text/html');
}

function pick(o, keys) { return Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]])); }

// ---------------- entrypoint ----------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!config.appSecret || config.appSecret.length < 32) { console.error('APP_SECRET (>=32 chars) is required'); process.exit(1); }
  // Every outbound request gets a time limit, so a hung city server can't stall syncing.
  const rawFetch = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) => rawFetch(url, opts.signal ? opts : { ...opts, signal: AbortSignal.timeout(Number(process.env.FETCH_TIMEOUT_MS || 30000)) });
  const { openStore } = await import('./open-store.js');
  const store = await openStore();
  bootstrap(store);
  const server = createServer(store).listen(config.port, () => console.log(`BUILDINTEL on :${config.port} (storage ${store.kind}, email ${config.emailMode})`));
  const timers = [];
  if (config.schedulerEnabled) {
    let running = false;
    const guarded = (name, fn) => async () => {
      if (running) return; running = true;
      try { await fn(); } catch (e) { console.error(name + ' failed', e); store.put('jobs', { type: name, status: 'failed', error: e.message }); store.save(); }
      finally { running = false; }
    };
    const cycle = async () => { try { await runCycleGuarded(store); } catch (e) { console.error('cycle failed', e); } };
    timers.push(setInterval(cycle, config.cycleMinutes * 60e3), setTimeout(cycle, 10e3));
    const daily = guarded('daily', async () => {
      const r = await store.withLock('daily', async () => {
        if (config.backupKey) await backupAndVerify(store);
        const { sendDigests, sendLeadAlerts } = await import('./digest.js');
        await sendDigests(store);
        await sendLeadAlerts(store);
        store.save();
      });
      if (!r.ran) console.log('daily jobs skipped:', r.skipped);
    });
    timers.push(setInterval(daily, 6 * 3600e3), setTimeout(daily, 60e3));
  }
  const shutdown = async sig => {
    console.log(`${sig}: draining`); timers.forEach(clearInterval); server.close();
    try { store.save(); if (store.close) await store.close(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
