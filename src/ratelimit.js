'use strict';

/**
 * Fixed-window rate limiter. Counts requests per caller per window in memory.
 * Keys are hashed by the caller (see server.js), so raw API keys are never stored.
 * Single-process only: a multi-instance deployment needs a shared store (for example Redis).
 */
class RateLimiter {
  constructor({ limit, windowMs = 60 * 1000 }) {
    if (!(Number.isInteger(limit) && limit > 0)) throw new Error('rate limit must be a positive integer');
    this.limit = limit;
    this.windowMs = windowMs;
    this.windows = new Map();
    this.lastSweep = 0;
  }

  hit(key, now = Date.now()) {
    this._sweep(now);
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    const allowed = w.count <= this.limit;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - w.count),
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
    };
  }

  _sweep(now) {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, w] of this.windows) {
      if (now >= w.resetAt) this.windows.delete(key);
    }
  }
}

module.exports = { RateLimiter };
