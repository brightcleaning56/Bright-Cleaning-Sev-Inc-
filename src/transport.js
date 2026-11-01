'use strict';

const fs = require('fs');
const path = require('path');
const { newId } = require('./util');

const POSTMARK_URL = 'https://api.postmarkapp.com/email';

/**
 * Outbound message transports.
 *
 * dry_run (default): writes each message to an outbox folder for owner review.
 *   Nothing is sent, and bids are never marked "sent".
 * live + postmark: sends through the Postmark API. A bid is marked sent only when
 *   Postmark returns ErrorCode 0 with a MessageID and SubmittedAt (the acceptance receipt).
 */
function createTransport(config, { fetchImpl } = {}) {
  if (config.sendMode === 'dry_run') {
    return dryRunTransport(config.outboxDir);
  }
  if (config.sendMode === 'live') {
    if (config.emailProvider !== 'postmark') {
      throw new Error('BUILDINTEL_SEND_MODE=live needs BUILDINTEL_EMAIL_PROVIDER=postmark (the only adapter built so far)');
    }
    if (!config.postmarkToken) {
      throw new Error('BUILDINTEL_POSTMARK_TOKEN is required for live sending');
    }
    return postmarkTransport({
      token: config.postmarkToken,
      stream: config.postmarkStream || 'outbound',
      fetchImpl: fetchImpl || globalThis.fetch,
    });
  }
  throw new Error(`unknown send mode: ${config.sendMode}`);
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

/** Maps a BUILDINTEL message to the Postmark request body. */
function toPostmarkBody(message, stream) {
  return {
    From: message.fromName ? `${message.fromName} <${message.from}>` : message.from,
    To: message.to,
    Subject: message.subject,
    HtmlBody: message.html,
    MessageStream: stream,
    Tag: message.purpose || 'bid_submission',
  };
}

function postmarkTransport({ token, stream, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available for Postmark');
  return {
    mode: 'live',
    provider: 'postmark',
    async send(message) {
      const res = await fetchImpl(POSTMARK_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': token,
        },
        body: JSON.stringify(toPostmarkBody(message, stream)),
      });
      let data = {};
      try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
      if (!res.ok || data.ErrorCode !== 0) {
        throw new Error(`Postmark rejected the message: HTTP ${res.status}, ${data.Message || 'no detail'} (code ${data.ErrorCode})`);
      }
      if (!data.MessageID || !data.SubmittedAt) {
        throw new Error('Postmark response had no MessageID or SubmittedAt; not counted as sent');
      }
      return { providerMessageId: String(data.MessageID), acceptedAt: data.SubmittedAt };
    },
    async preview() {
      throw new Error('preview is handled by the dry-run transport');
    },
  };
}

module.exports = { createTransport, dryRunTransport, postmarkTransport, toPostmarkBody, POSTMARK_URL };
