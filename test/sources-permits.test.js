'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { sourceCollectable, loadSourceRegistry, syncSource } = require('../src/ingest/sources');
const { validatePermitRecord, normalizePermit, permitDedupeKey } = require('../src/domain/permits');
const { makeEnv, makeStore } = require('./helpers');

const SOURCES_FILE = path.resolve(__dirname, '..', 'data', 'sources.json');

const GOOD_SOURCE = {
  id: 'city-api',
  name: 'City API',
  agency: 'City',
  sourceUrl: 'https://city.example.gov/permits',
  method: 'official_api',
  termsUrl: 'https://city.example.gov/terms',
  commercialReusePermitted: true,
  termsReviewedBy: 'Owner, 2026-10-01',
  contact: 'records@city.example.gov',
  authRequired: false,
  rateLimitPerHour: 60,
  retentionDays: 365,
};

test('a complete, reviewed official source is collectable', () => {
  assert.deepEqual(sourceCollectable(GOOD_SOURCE), { ok: true, reasons: [] });
});

test('scraping and bypass methods are always refused', () => {
  for (const method of ['html_scrape', 'captcha_bypass', 'login_bypass', 'paywall_bypass']) {
    const gate = sourceCollectable({ ...GOOD_SOURCE, method });
    assert.equal(gate.ok, false, method);
    assert.match(gate.reasons.join(' '), /prohibited/);
  }
});

test('a source without reviewed terms or commercial reuse is blocked', () => {
  assert.equal(sourceCollectable({ ...GOOD_SOURCE, termsReviewedBy: 'pending' }).ok, false);
  assert.equal(sourceCollectable({ ...GOOD_SOURCE, commercialReusePermitted: false }).ok, false);
});

test('sample data is blocked outside demo mode', () => {
  const sample = { ...GOOD_SOURCE, method: 'sample', commercialReusePermitted: false, termsReviewedBy: 'not_applicable' };
  assert.equal(sourceCollectable(sample, { allowSample: false }).ok, false);
  assert.equal(sourceCollectable(sample, { allowSample: true }).ok, true);
});

test('the shipped registry authorises no production source yet', () => {
  const production = loadSourceRegistry(SOURCES_FILE)
    .filter((s) => s.method !== 'sample')
    .filter((s) => sourceCollectable(s).ok);
  assert.equal(production.length, 0);
});

test('permit validation names every missing or invalid field', () => {
  const problems = validatePermitRecord({ permitId: 'X1', state: 'Iowa', sourceUrl: 'ftp://nope', confidence: 'maybe' });
  assert.ok(problems.some((p) => /missing projectName/.test(p)));
  assert.ok(problems.some((p) => /sourceUrl must be an http/.test(p)));
  assert.ok(problems.some((p) => /confidence must be/.test(p)));
  assert.ok(problems.some((p) => /two-letter/.test(p)));
});

test('dedupe key is stable across case and whitespace differences', () => {
  const a = permitDedupeKey({ state: 'ia', city: ' Des Moines ', permitId: 'bp-100' });
  const b = permitDedupeKey({ state: 'IA', city: 'des moines', permitId: 'BP-100 ' });
  assert.equal(a, b);
});

test('normalised permits keep their source link, confidence and sample flag', () => {
  const raw = {
    permitId: 'BP-7', projectName: 'Tower', propertyAddress: '1 Main', city: 'Dallas', state: 'tx',
    projectType: 'Office', permitStatus: 'issued', sourceUrl: 'https://city.example.gov/p/7',
    lastVerifiedAt: '2026-10-30T00:00:00Z', confidence: 'verified', squareFeet: 9000, estimatedValue: 1000000,
  };
  const p = normalizePermit(raw, GOOD_SOURCE);
  assert.equal(p.state, 'TX');
  assert.equal(p.projectType, 'office');
  assert.equal(p.sourceUrl, raw.sourceUrl);
  assert.equal(p.valueBasis, 'reported');
  assert.equal(p.isSample, false);
});

test('syncing a blocked source writes nothing to the store', () => {
  const { env } = makeEnv();
  const { store, config } = makeStore(env);
  const result = syncSource(store, { ...GOOD_SOURCE, method: 'html_scrape' }, { allowSample: false, now: new Date() });
  assert.equal(result.status, 'blocked');
  assert.equal(store.list('permits', null).length, 0);
  assert.ok(config);
});

test('syncing the demo fixture stores valid records and rejects broken ones', () => {
  const { env } = makeEnv();
  const { store, config } = makeStore(env);
  const [sample] = loadSourceRegistry(config.sourcesFile).filter((s) => s.id === 'sample-demo');
  const result = syncSource(store, sample, { allowSample: true, now: new Date() });
  assert.equal(result.status, 'ok');
  assert.equal(result.inserted, 3);
  assert.equal(result.rejected.length, 0);
  assert.equal(store.list('permits', null).every((p) => p.isSample), true);
});
