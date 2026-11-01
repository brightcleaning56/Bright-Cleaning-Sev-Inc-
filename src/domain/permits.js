'use strict';

const { sha256 } = require('../util');

const PERMIT_STATUSES = ['applied', 'approved', 'issued', 'expired'];
const CONFIDENCE_LEVELS = ['verified', 'probable', 'unconfirmed'];
const PROJECT_TYPES = [
  'office', 'retail', 'warehouse', 'multifamily', 'school',
  'institutional', 'medical', 'industrial', 'other',
];

const REQUIRED_FIELDS = [
  'permitId', 'projectName', 'propertyAddress', 'city', 'state',
  'projectType', 'permitStatus', 'sourceUrl', 'lastVerifiedAt', 'confidence',
];

function isHttpUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch (_) {
    return false;
  }
}

/** Returns the list of problems with a raw permit record. Empty list = valid. */
function validatePermitRecord(raw) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (raw[field] === undefined || raw[field] === null || String(raw[field]).trim() === '') {
      errors.push(`missing ${field}`);
    }
  }
  if (raw.permitStatus && !PERMIT_STATUSES.includes(raw.permitStatus)) {
    errors.push(`permitStatus must be one of ${PERMIT_STATUSES.join(', ')}`);
  }
  if (raw.confidence && !CONFIDENCE_LEVELS.includes(raw.confidence)) {
    errors.push(`confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}`);
  }
  if (raw.projectType && !PROJECT_TYPES.includes(String(raw.projectType).toLowerCase())) {
    errors.push(`unknown projectType "${raw.projectType}"`);
  }
  if (raw.sourceUrl && !isHttpUrl(raw.sourceUrl)) {
    errors.push('sourceUrl must be an http(s) URL pointing to the original government record');
  }
  if (raw.state && !/^[A-Za-z]{2}$/.test(String(raw.state))) {
    errors.push('state must be a two-letter code');
  }
  if (raw.squareFeet !== undefined && raw.squareFeet !== null
    && !(Number.isFinite(raw.squareFeet) && raw.squareFeet > 0)) {
    errors.push('squareFeet must be a positive number when present');
  }
  if (raw.estimatedValue !== undefined && raw.estimatedValue !== null
    && !(Number.isFinite(raw.estimatedValue) && raw.estimatedValue >= 0)) {
    errors.push('estimatedValue must be a non-negative number when present');
  }
  return errors;
}

/** Stable key so the same government permit is never stored twice. */
function permitDedupeKey(raw) {
  const key = `${String(raw.state).toUpperCase()}|${String(raw.city).trim().toLowerCase()}|${String(raw.permitId).trim().toUpperCase()}`;
  return sha256(key).slice(0, 32);
}

/**
 * Normalises a valid raw record into the platform shape. Every permit keeps its
 * source link and confidence, and the estimated value is labelled as reported.
 */
function normalizePermit(raw, source) {
  return {
    id: permitDedupeKey(raw),
    dedupeKey: permitDedupeKey(raw),
    sourceId: source.id,
    permitId: String(raw.permitId).trim(),
    projectName: String(raw.projectName).trim(),
    propertyAddress: String(raw.propertyAddress).trim(),
    city: String(raw.city).trim(),
    state: String(raw.state).trim().toUpperCase(),
    projectType: String(raw.projectType).trim().toLowerCase(),
    squareFeet: raw.squareFeet ?? null,
    permitStatus: raw.permitStatus,
    owner: raw.owner || null,
    gc: raw.gc || null,
    architect: raw.architect || null,
    estimatedValue: raw.estimatedValue ?? null,
    valueBasis: raw.estimatedValue != null ? 'reported' : null,
    permitDate: raw.permitDate || null,
    sourceUrl: raw.sourceUrl,
    lastVerifiedAt: raw.lastVerifiedAt,
    confidence: raw.confidence,
    isSample: Boolean(raw.sample || source.method === 'sample'),
  };
}

module.exports = {
  PERMIT_STATUSES,
  CONFIDENCE_LEVELS,
  PROJECT_TYPES,
  validatePermitRecord,
  permitDedupeKey,
  normalizePermit,
};
