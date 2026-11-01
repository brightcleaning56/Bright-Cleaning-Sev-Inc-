'use strict';

const { money, isPositive, isNonNegative, ValidationError } = require('../util');

/**
 * Deterministic commercial cleaning estimate.
 *
 * Every rate is an input supplied by the tenant. Nothing is assumed or invented.
 * The same inputs always produce the same output, which is what the estimating
 * accuracy tests rely on.
 *
 *   laborHours   = squareFeet / productionRate            (sq ft per labor hour)
 *   labor        = laborHours * laborRate
 *   burden       = labor * burdenPct                       (payroll taxes/insurance)
 *   supervision  = (labor + burden) * supervisionPct
 *   materials    = squareFeet * materialsPerSqFt
 *   equipment    = equipmentPerDay * days
 *   direct       = labor + burden + supervision + materials + equipment + travelFee
 *   overhead     = direct * overheadPct
 *   cost         = direct + overhead
 *   price        = cost / (1 - marginPct)                  (margin is on price)
 *   total        = max(price, minimumBid)
 */
function estimate(input) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };

  req(isPositive(input.squareFeet), 'squareFeet must be a positive number');
  req(isPositive(input.productionRate), 'productionRate (sq ft per labor hour) must be positive');
  req(isPositive(input.laborRate), 'laborRate (per hour) must be positive');
  req(isNonNegative(input.burdenPct) && input.burdenPct < 1, 'burdenPct must be in [0, 1)');
  req(isNonNegative(input.supervisionPct) && input.supervisionPct < 1, 'supervisionPct must be in [0, 1)');
  req(isNonNegative(input.overheadPct) && input.overheadPct < 1, 'overheadPct must be in [0, 1)');
  req(isNonNegative(input.marginPct) && input.marginPct < 0.9, 'marginPct must be in [0, 0.9)');
  req(isNonNegative(input.materialsPerSqFt ?? 0), 'materialsPerSqFt must be non-negative');
  req(isNonNegative(input.equipmentPerDay ?? 0), 'equipmentPerDay must be non-negative');
  req(Number.isInteger(input.days ?? 1) && (input.days ?? 1) >= 1, 'days must be an integer >= 1');
  req(isNonNegative(input.travelFee ?? 0), 'travelFee must be non-negative');
  req(isNonNegative(input.minimumBid ?? 0), 'minimumBid must be non-negative');
  if (errors.length) throw new ValidationError('Invalid estimate inputs', errors);

  const laborHours = input.squareFeet / input.productionRate;
  const labor = money(laborHours * input.laborRate);
  const burden = money(labor * input.burdenPct);
  const supervision = money((labor + burden) * input.supervisionPct);
  const materials = money(input.squareFeet * (input.materialsPerSqFt ?? 0));
  const equipment = money((input.equipmentPerDay ?? 0) * (input.days ?? 1));
  const travel = money(input.travelFee ?? 0);

  const direct = money(labor + burden + supervision + materials + equipment + travel);
  const overhead = money(direct * input.overheadPct);
  const cost = money(direct + overhead);
  const priceBeforeMinimum = money(cost / (1 - input.marginPct));
  const minimumBid = input.minimumBid ?? 0;
  const minimumApplied = priceBeforeMinimum < minimumBid;
  const total = minimumApplied ? money(minimumBid) : priceBeforeMinimum;

  return {
    basis: 'estimated',
    laborHours: Math.round(laborHours * 100) / 100,
    lineItems: [
      { key: 'labor', label: 'Labor', amount: labor },
      { key: 'burden', label: 'Payroll burden', amount: burden },
      { key: 'supervision', label: 'Supervision', amount: supervision },
      { key: 'materials', label: 'Materials and supplies', amount: materials },
      { key: 'equipment', label: 'Equipment', amount: equipment },
      { key: 'travel', label: 'Travel', amount: travel },
      { key: 'overhead', label: 'Overhead', amount: overhead },
    ],
    cost,
    marginPct: input.marginPct,
    minimumApplied,
    total,
  };
}

/**
 * Chooses the first rate card that covers the permit's project type. A rate
 * card with no projectTypes covers everything. Returns null when nothing fits,
 * so the caller can leave the bid unpriced instead of guessing a rate.
 */
function selectRateCard(rateCards, projectType) {
  if (!Array.isArray(rateCards)) return null;
  return rateCards.find((card) => {
    const types = card.projectTypes || [];
    return types.length === 0 || types.includes(projectType);
  }) || null;
}

module.exports = { estimate, selectRateCard };
