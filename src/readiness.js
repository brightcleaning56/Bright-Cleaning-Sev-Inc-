'use strict';

const fs = require('fs');
const { sourceCollectable, loadSourceRegistry } = require('./ingest/sources');

const DEFAULT_OWNER_INPUTS = {
  legalEntityName: null,
  policiesApprovedBy: null,
  policiesApprovedAt: null,
  paymentProcessorConnected: false,
  insuranceBoundAt: null,
  backupRestoreTestedAt: null,
  penetrationTestAt: null,
  emailProviderConnected: false,
};

function loadOwnerInputs(file) {
  if (!fs.existsSync(file)) return { ...DEFAULT_OWNER_INPUTS };
  return { ...DEFAULT_OWNER_INPUTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/**
 * Go-live gate. Each gate is pass, fail, or owner_action. The system will not
 * report GO until every gate passes. The gates are the 24-hour checklist in
 * docs/LAUNCH_24_HOURS.md, so the answer comes from configuration, not hope.
 */
function evaluateReadiness({ store, config }) {
  const owner = loadOwnerInputs(config.readinessFile);
  const registry = loadSourceRegistry(config.sourcesFile);
  const authorized = registry.filter((s) => sourceCollectable(s, { allowSample: false }).ok);
  const brightClean = store.list('orgs', null, (o) => o.status === 'active' && o.autopilot && o.autopilot.enabled)[0];
  const cards = brightClean && brightClean.pricing ? brightClean.pricing.rateCards.length : 0;
  const line1 = brightClean && brightClean.legal ? brightClean.legal.postalAddress.line1 : '';
  // Placeholder text from the example template must never count as a real address.
  const hasAddress = Boolean(line1) && !/REPLACE/i.test(line1);

  const gate = (id, label, ok, detail, ownerOwns = false) => ({
    id,
    label,
    status: ok ? 'pass' : (ownerOwns ? 'owner_action' : 'fail'),
    detail,
  });

  const gates = [
    gate('policies_approved', 'Attorney-reviewed policy library approved',
      Boolean(owner.policiesApprovedBy && owner.policiesApprovedAt),
      owner.policiesApprovedBy ? `approved by ${owner.policiesApprovedBy}` : 'no attorney approval recorded', true),
    gate('authorized_sources', 'At least one data source with reviewed terms and commercial reuse',
      authorized.length > 0,
      `${authorized.length} of ${registry.length} sources authorised`, true),
    gate('no_sample_data', 'Sample/demo permits disabled in production',
      !config.allowSampleData, config.allowSampleData ? 'BUILDINTEL_ALLOW_SAMPLE=1 is set' : 'disabled'),
    gate('admin_key', 'Admin key configured',
      Boolean(config.adminKey) && config.adminKey.length >= 24, 'set BUILDINTEL_ADMIN_KEY (24+ chars)'),
    gate('unsubscribe_secret', 'Unsubscribe signing secret configured',
      Boolean(config.unsubscribeSecret) && config.unsubscribeSecret.length >= 24,
      'set BUILDINTEL_UNSUBSCRIBE_SECRET (24+ chars)'),
    gate('bright_clean_tenant', 'Bright Clean tenant active with postal address',
      Boolean(brightClean) && hasAddress, brightClean ? 'tenant found' : 'no active tenant with autopilot enabled'),
    gate('bright_clean_pricing', 'Bright Clean rate cards entered by the owner',
      cards > 0, `${cards} rate card(s)`, true),
    gate('live_email', 'Live email provider connected and sending mode set to live',
      config.sendMode === 'live' && owner.emailProviderConnected,
      `send mode: ${config.sendMode}`, true),
    gate('payments', 'Payment processor connected (Stripe or equivalent)',
      owner.paymentProcessorConnected, 'not connected', true),
    gate('insurance', 'Insurance bound (cyber and professional liability)',
      Boolean(owner.insuranceBoundAt), owner.insuranceBoundAt ? `bound ${owner.insuranceBoundAt}` : 'not bound', true),
    gate('backup_restore', 'Backup restore tested successfully',
      Boolean(owner.backupRestoreTestedAt), owner.backupRestoreTestedAt || 'never tested', false),
    gate('pen_test', 'Independent penetration test completed',
      Boolean(owner.penetrationTestAt), owner.penetrationTestAt || 'not completed', true),
  ];

  const failing = gates.filter((g) => g.status !== 'pass');
  return {
    goLive: failing.length === 0,
    passed: gates.length - failing.length,
    total: gates.length,
    gates,
  };
}

module.exports = { evaluateReadiness, loadOwnerInputs, DEFAULT_OWNER_INPUTS };
