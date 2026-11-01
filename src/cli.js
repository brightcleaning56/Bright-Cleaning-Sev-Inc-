#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { createTransport } = require('./transport');
const { createOrg } = require('./service');
const { evaluateReadiness } = require('./readiness');
const { runCycle } = require('./autopilot');

const USAGE = `Usage:
  node src/cli.js readiness                 Print the go-live gate report
  node src/cli.js create-org <file.json>    Create a tenant; prints its API key once
  node src/cli.js cycle                     Run one autopilot cycle now
`;

async function main(argv) {
  const [cmd, arg] = argv;
  const config = loadConfig();
  const store = new Store(config.dataFile);

  if (cmd === 'readiness') {
    const report = evaluateReadiness({ store, config });
    console.log(JSON.stringify(report, null, 2));
    return report.goLive ? 0 : 2;
  }
  if (cmd === 'create-org') {
    if (!arg) throw new Error('create-org needs a JSON file path');
    const input = JSON.parse(fs.readFileSync(arg, 'utf8'));
    const { org, apiKey } = createOrg(store, input);
    console.log(JSON.stringify({ orgId: org.id, name: org.name, apiKey }, null, 2));
    console.log('Store this API key now. It cannot be shown again.');
    return 0;
  }
  if (cmd === 'cycle') {
    const transport = createTransport(config);
    const report = await runCycle({ store, config, transport, now: new Date() });
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(USAGE);
  return cmd ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(err.message); process.exitCode = 1; },
  );
}

module.exports = { main };
