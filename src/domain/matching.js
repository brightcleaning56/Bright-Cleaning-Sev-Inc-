'use strict';

/**
 * Decides whether a permit is worth an org's attention. It returns reasons, so
 * every match can be explained, and blockers, so bad fits are excluded
 * instead of silently scored.
 *
 * profile = {
 *   territories: [{ state: 'IA', cities: ['Des Moines'] }]   // cities optional
 *   projectTypes: ['office','retail', ...]                   // empty = all
 *   minSquareFeet: 5000                                      // optional
 * }
 */
function matchPermit(permit, profile, { allowSample = false } = {}) {
  const reasons = [];
  const blockers = [];

  const territories = profile.territories || [];
  const inTerritory = territories.find((t) => t.state === permit.state);
  if (!inTerritory) {
    blockers.push(`outside service territory (${permit.state})`);
  } else if ((inTerritory.cities || []).length === 0) {
    reasons.push(`inside statewide territory ${permit.state}`);
  } else if (inTerritory.cities.map((c) => c.toLowerCase()).includes(permit.city.toLowerCase())) {
    reasons.push(`inside listed city ${permit.city}`);
  } else {
    blockers.push(`city ${permit.city} is not in the service territory`);
  }

  const types = profile.projectTypes || [];
  if (types.length && !types.includes(permit.projectType)) {
    blockers.push(`project type "${permit.projectType}" is not offered`);
  } else if (types.length) {
    reasons.push(`project type ${permit.projectType} is offered`);
  }

  const minSf = profile.minSquareFeet || 0;
  if (minSf && (permit.squareFeet == null || permit.squareFeet < minSf)) {
    blockers.push(permit.squareFeet == null ? 'square footage unknown' : `below minimum ${minSf} sq ft`);
  }

  if (permit.permitStatus === 'expired') blockers.push('permit has expired');
  if (permit.isSample && !allowSample) blockers.push('sample record (demo mode only)');

  // Unconfirmed records can be listed but must be reviewed by a person first.
  const needsReview = permit.confidence === 'unconfirmed';
  if (needsReview) reasons.push('confidence unconfirmed: human review required');

  let score = 0;
  if (blockers.length === 0) {
    score = 50;
    if (permit.confidence === 'verified') score += 20;
    if (permit.confidence === 'probable') score += 10;
    if (minSf && permit.squareFeet >= minSf * 2) score += 10;
    if (permit.permitStatus === 'issued' || permit.permitStatus === 'approved') score += 10;
  }

  return { match: blockers.length === 0, score, reasons, blockers, needsReview };
}

module.exports = { matchPermit };
