'use strict';

const fs = require('fs');
const path = require('path');
const { newId } = require('./util');

/**
 * Outbound message transports.
 *
 * dry_run (default): writes each message to an outbox folder for owner review.
 *   Nothing is sent, and bids are never marked "sent".
 * live: requires a real provider adapter (for example SES, Postmark or
 *   SendGrid) that returns an acceptance id. None is configured yet, so the
 *   platform refuses to start in live mode rather than pretend to send.
 */
function createTransport(config) {
  if (config.sendMode === 'dry_run') {
    return dryRunTransport(config.outboxDir);
  }
  throw new Error(
    'BUILDINTEL_SEND_MODE=live needs an email provider adapter. None is configured in this build. '
    + 'Add the provider in src/transport.js, then set the provider credentials.',
  );
}

function dryRunTransport(outboxDir) {
  return {
    mode: 'dry_run',
    // Writes a preview the owner can read. This is not a send and returns no receipt.
    async preview(message) {
      fs.mkdirSync(outboxDir, { recursive: true });
      const file = path.join(outboxDir, `${newId('preview')}.json`);
      fs.writeFileSync(file, JSON.stringify({ ...message, previewedAt: new Date().toISOString() }, null, 2));
      return { file };
    },
    async send() {
      throw new Error('dry_run transport cannot send; approved bids stay approved until live mode is enabled');
    },
  };
}

module.exports = { createTransport, dryRunTransport };
