'use strict';

const path = require('path');

const SEND_MODES = ['dry_run', 'live'];

// All runtime settings come from environment variables so no secret lives in code.
function loadConfig(env = process.env) {
  const sendMode = env.BUILDINTEL_SEND_MODE || 'dry_run';
  if (!SEND_MODES.includes(sendMode)) {
    throw new Error(`BUILDINTEL_SEND_MODE must be one of ${SEND_MODES.join(', ')}`);
  }
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  const intervalMin = Number(env.BUILDINTEL_AUTOPILOT_INTERVAL_MIN || 60);
  if (!(intervalMin > 0)) {
    throw new Error('BUILDINTEL_AUTOPILOT_INTERVAL_MIN must be greater than 0');
  }
  if (!(Number.isInteger(Number(env.BUILDINTEL_RATE_LIMIT_PER_MIN || 120)) && Number(env.BUILDINTEL_RATE_LIMIT_PER_MIN || 120) > 0)) {
    throw new Error('BUILDINTEL_RATE_LIMIT_PER_MIN must be a positive integer');
  }
  const root = path.resolve(__dirname, '..');
  return {
    root,
    port,
    dataFile: env.BUILDINTEL_DATA_FILE || path.join(root, 'data', 'state.json'),
    outboxDir: env.BUILDINTEL_OUTBOX_DIR || path.join(root, 'data', 'outbox'),
    sourcesFile: path.join(root, 'data', 'sources.json'),
    // Owner go-live inputs. On Render this points at the persistent disk so redeploys keep them.
    readinessFile: env.BUILDINTEL_READINESS_FILE || path.join(root, 'data', 'readiness.json'),
    adminKey: env.BUILDINTEL_ADMIN_KEY || '',
    unsubscribeSecret: env.BUILDINTEL_UNSUBSCRIBE_SECRET || '',
    publicBaseUrl: env.BUILDINTEL_PUBLIC_URL || `http://localhost:${port}`,
    // Browser origins allowed to call the API cross-origin (for example the Netlify console).
    corsOrigins: String(env.BUILDINTEL_CORS_ORIGINS || '')
      .split(',').map((o) => o.trim()).filter(Boolean),
    // Requests per minute per caller. Health checks are exempt.
    rateLimitPerMinute: Number(env.BUILDINTEL_RATE_LIMIT_PER_MIN || 120),
    // Set to 1 only behind a trusted proxy (Render). Otherwise client IPs can be spoofed.
    trustProxy: env.BUILDINTEL_TRUST_PROXY === '1',
    // Sample/fixture permits are demo data. They must never reach production.
    allowSampleData: env.BUILDINTEL_ALLOW_SAMPLE === '1',
    autopilotEnabled: env.BUILDINTEL_AUTOPILOT === 'on',
    autopilotIntervalMinutes: intervalMin,
    sendMode,
  };
}

module.exports = { loadConfig, SEND_MODES };
