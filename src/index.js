'use strict';

const { loadConfig } = require('./config');
const { Store } = require('./store');
const { createTransport } = require('./transport');
const { createServer } = require('./server');
const { runCycle } = require('./autopilot');

function warnIfMisconfigured(config) {
  if (!config.adminKey) console.warn('[buildintel] BUILDINTEL_ADMIN_KEY is not set: admin routes are disabled');
  if (!config.unsubscribeSecret) console.warn('[buildintel] BUILDINTEL_UNSUBSCRIBE_SECRET is not set: unsubscribe links will not work');
  if (config.allowSampleData) console.warn('[buildintel] DEMO MODE: sample permits are enabled. Do not use for production.');
}

function startAutopilot({ store, config, transport }) {
  let running = false;
  const tick = async () => {
    if (running) return; // never let two cycles overlap
    running = true;
    try {
      const report = await runCycle({ store, config, transport, now: new Date() });
      console.log('[buildintel] autopilot cycle', JSON.stringify(report.orgs.map((o) => ({ org: o.name, matched: o.matched }))));
    } catch (err) {
      console.error('[buildintel] autopilot cycle failed', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.autopilotIntervalMinutes * 60 * 1000);
  timer.unref();
  tick();
  return { tick, stop: () => clearInterval(timer) };
}

function main(env = process.env) {
  const config = loadConfig(env);
  warnIfMisconfigured(config);
  const store = new Store(config.dataFile);
  const transport = createTransport(config); // throws in live mode until a provider is wired
  const server = createServer({ store, config, transport });
  server.listen(config.port, () => {
    const addr = server.address();
    console.log(`[buildintel] listening on port ${addr.port} (send mode: ${config.sendMode}, autopilot: ${config.autopilotEnabled ? 'on' : 'off'})`);
  });
  if (config.autopilotEnabled) startAutopilot({ store, config, transport });
  return server;
}

if (require.main === module) {
  main();
}

module.exports = { main, startAutopilot };
