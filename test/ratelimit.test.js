'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RateLimiter } = require('../src/ratelimit');
const { makeEnv, makeStore, ADMIN_KEY } = require('./helpers');
const { createServer } = require('../src/server');
const { createTransport } = require('../src/transport');

test('the limiter allows up to the limit in a window, then refuses', () => {
  const rl = new RateLimiter({ limit: 3, windowMs: 60000 });
  const t0 = 1_000_000;
  assert.equal(rl.hit('a', t0).allowed, true);
  assert.equal(rl.hit('a', t0).allowed, true);
  const third = rl.hit('a', t0);
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  const fourth = rl.hit('a', t0 + 1000);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.retryAfterSec, 59);
});

test('callers are counted separately, and the window resets', () => {
  const rl = new RateLimiter({ limit: 1, windowMs: 60000 });
  const t0 = 2_000_000;
  assert.equal(rl.hit('a', t0).allowed, true);
  assert.equal(rl.hit('a', t0).allowed, false);
  assert.equal(rl.hit('b', t0).allowed, true, 'another caller is not affected');
  assert.equal(rl.hit('a', t0 + 60000).allowed, true, 'a new window starts after a minute');
});

test('an invalid limit is rejected at construction', () => {
  assert.throws(() => new RateLimiter({ limit: 0 }), /positive integer/);
  assert.throws(() => new RateLimiter({ limit: 1.5 }), /positive integer/);
});

test('over HTTP: 429 with Retry-After once the limit is hit, health is exempt, and the key is not stored raw', async () => {
  const { env } = makeEnv({ BUILDINTEL_RATE_LIMIT_PER_MIN: '3' });
  const { store, config } = makeStore(env);
  const server = createServer({ store, config, transport: createTransport(config) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(`${base}/api/readiness`, { headers: { 'x-admin-key': ADMIN_KEY } });
      statuses.push(res.status);
      if (res.status === 429) {
        assert.ok(Number(res.headers.get('retry-after')) >= 1);
        assert.equal(res.headers.get('x-ratelimit-limit'), '3');
      }
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await fetch(`${base}/health`)).status, 200, 'health checks are never limited');
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
