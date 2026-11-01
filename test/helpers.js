'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { Store } = require('../src/store');
const { createOrg, addContact, verifyContact } = require('../src/service');

const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const UNSUB_SECRET = 'test-unsub-secret-0123456789abcdef';

/** Isolated config + store per test. Files live in a fresh temp directory. */
function makeEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildintel-test-'));
  return {
    env: {
      BUILDINTEL_DATA_FILE: path.join(dir, 'state.json'),
      BUILDINTEL_OUTBOX_DIR: path.join(dir, 'outbox'),
      BUILDINTEL_ADMIN_KEY: ADMIN_KEY,
      BUILDINTEL_UNSUBSCRIBE_SECRET: UNSUB_SECRET,
      BUILDINTEL_ALLOW_SAMPLE: '1',
      BUILDINTEL_PUBLIC_URL: 'http://buildintel.test',
      PORT: '0',
      ...extra,
    },
    dir,
  };
}

function makeStore(env) {
  const config = loadConfig(env);
  return { config, store: new Store(config.dataFile) };
}

const BRIGHT_CLEAN_INPUT = {
  name: 'Bright Clean Inc.',
  legalName: 'Bright Clean Inc.',
  email: 'owner@brightclean.example',
  postalAddress: { line1: '123 Main St', city: 'Des Moines', state: 'IA', postalCode: '50309' },
  territories: [{ state: 'IA', cities: ['Des Moines', 'West Des Moines', 'Ankeny'] }, { state: 'TX', cities: ['Dallas'] }],
  projectTypes: ['office', 'retail', 'warehouse'],
  minSquareFeet: 5000,
  services: ['final_clean'],
  scope: 'Commercial construction cleaning.',
  autopilot: { enabled: true, autoApproveMaxTotal: 5000 },
};

const RATE_CARD = {
  service: 'final_clean',
  productionRate: 2000,
  laborRate: 40,
  burdenPct: 0.2,
  supervisionPct: 0.1,
  overheadPct: 0.1,
  marginPct: 0.25,
  materialsPerSqFt: 0.05,
  equipmentPerDay: 100,
  days: 1,
  minimumBid: 0,
};

/** Creates the Bright Clean tenant with pricing and one verified GC contact. */
function seedBrightClean(store, { withPricing = true, withContact = true, autopilot } = {}) {
  const { org, apiKey } = createOrg(store, { ...BRIGHT_CLEAN_INPUT, ...(autopilot ? { autopilot } : {}) });
  if (withPricing) {
    store.update('orgs', null, org.id, { pricing: { rateCards: [RATE_CARD] } });
  }
  let contact = null;
  if (withContact) {
    contact = addContact(store, org.id, { company: 'Demo General Builders', name: 'Estimator', email: 'estimator@demo-gc.example' });
    contact = verifyContact(store, org.id, contact.id, { status: 'verified', source: 'owner confirmed via GC bid list', actor: 'owner' });
  }
  return { org: store.get('orgs', null, org.id), apiKey, contact };
}

module.exports = { makeEnv, makeStore, seedBrightClean, ADMIN_KEY, UNSUB_SECRET, BRIGHT_CLEAN_INPUT, RATE_CARD };
