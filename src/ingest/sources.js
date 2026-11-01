'use strict';

const fs = require('fs');
const path = require('path');
const { validatePermitRecord, normalizePermit } = require('../domain/permits');

// Methods the platform will run. Anything not listed is refused.
const ALLOWED_METHODS = ['official_api', 'bulk_download', 'owner_feed', 'sample'];
// Methods that are never allowed, regardless of configuration.
const BLOCKED_METHODS = ['html_scrape', 'captcha_bypass', 'login_bypass', 'paywall_bypass'];

const REQUIRED_SOURCE_FIELDS = [
  'id', 'name', 'agency', 'sourceUrl', 'method', 'termsUrl',
  'commercialReusePermitted', 'termsReviewedBy', 'contact',
  'rateLimitPerHour', 'retentionDays',
];

/**
 * A source may run only when its compliance record is complete and it is not a
 * blocked access method. Returns { ok, reasons }. This is the gate that stops
 * unrestricted scraping from ever starting.
 */
function sourceCollectable(source, { allowSample = false } = {}) {
  const reasons = [];
  for (const field of REQUIRED_SOURCE_FIELDS) {
    const v = source[field];
    if (v === undefined || v === null || v === '') reasons.push(`missing compliance field: ${field}`);
  }
  if (BLOCKED_METHODS.includes(source.method)) {
    reasons.push(`access method "${source.method}" is prohibited`);
  } else if (!ALLOWED_METHODS.includes(source.method)) {
    reasons.push(`access method "${source.method}" is not an approved method`);
  }
  if (source.method === 'sample') {
    // Synthetic fixture data has no licence to check, but it is only ever used in demo mode.
    if (!allowSample) reasons.push('sample source is disabled outside demo mode');
  } else {
    if (source.commercialReusePermitted !== true) {
      reasons.push('commercial reuse is not confirmed by the source terms');
    }
    if (source.termsReviewedBy === 'pending' || source.termsReviewedBy === 'not_applicable') {
      reasons.push('terms of use have not been reviewed by the owner');
    }
  }
  if (source.authRequired && !source.credentialsRef) {
    reasons.push('source requires authentication but no credentials reference is configured');
  }
  return { ok: reasons.length === 0, reasons };
}

function loadSourceRegistry(file) {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const root = path.resolve(path.dirname(file), '..');
  return (Array.isArray(parsed.sources) ? parsed.sources : []).map((s) => (
    s.fixturePath ? { ...s, fixturePath: path.resolve(root, s.fixturePath) } : s
  ));
}

/**
 * Fetch adapters. Only official feeds and the offline sample file exist here.
 * Adding a new source means adding a reviewed adapter, not a scraper.
 */
const adapters = {
  sample(source) {
    const body = JSON.parse(fs.readFileSync(source.fixturePath, 'utf8'));
    return Array.isArray(body.records) ? body.records : [];
  },
  official_api() {
    throw new Error('official_api adapter is not configured for this source yet');
  },
  bulk_download() {
    throw new Error('bulk_download adapter is not configured for this source yet');
  },
  owner_feed() {
    throw new Error('owner_feed adapter is not configured for this source yet');
  },
};

/**
 * Runs one sync for one source. Invalid records are counted and kept out of
 * the store, so a bad feed cannot put fake or incomplete permits in production.
 */
function syncSource(store, source, { allowSample, now = new Date() }) {
  const gate = sourceCollectable(source, { allowSample });
  if (!gate.ok) {
    return { sourceId: source.id, status: 'blocked', reasons: gate.reasons };
  }
  const minIntervalMs = (60 / source.rateLimitPerHour) * 60 * 1000;
  const last = store.get('sources', null, source.id);
  if (last && last.lastAttemptAt && now - new Date(last.lastAttemptAt) < minIntervalMs) {
    return { sourceId: source.id, status: 'rate_limited' };
  }
  const attemptAt = now.toISOString();
  try {
    const rows = adapters[source.method](source);
    let inserted = 0;
    let updated = 0;
    const rejected = [];
    for (const raw of rows) {
      const problems = validatePermitRecord(raw);
      if (problems.length) {
        rejected.push({ permitId: raw.permitId || null, problems });
        continue;
      }
      const permit = normalizePermit(raw, source);
      const existing = store.get('permits', null, permit.id);
      if (existing) {
        store.upsertGlobal('permits', permit.id, 'id', permit);
        updated += 1;
      } else {
        store.insert('permits', permit);
        inserted += 1;
      }
    }
    store.upsertGlobal('sources', source.id, 'id', {
      id: source.id,
      lastAttemptAt: attemptAt,
      lastSuccessAt: attemptAt,
      lastError: null,
    });
    return { sourceId: source.id, status: 'ok', inserted, updated, rejected };
  } catch (err) {
    store.upsertGlobal('sources', source.id, 'id', {
      id: source.id,
      lastAttemptAt: attemptAt,
      lastError: err.message,
    });
    return { sourceId: source.id, status: 'error', error: err.message };
  }
}

module.exports = {
  ALLOWED_METHODS,
  BLOCKED_METHODS,
  REQUIRED_SOURCE_FIELDS,
  sourceCollectable,
  loadSourceRegistry,
  syncSource,
};
