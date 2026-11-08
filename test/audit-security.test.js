import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';

function start(store) {
  return new Promise(resolve => {
    const srv = createServer(store).listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('a spoofed X-Forwarded-For cannot reset the sign-in rate limit when no proxy is trusted', async t => {
  const saved = { limit: config.loginRateLimit, trust: config.trustProxy };
  config.loginRateLimit = 2; config.trustProxy = false;
  t.after(() => { config.loginRateLimit = saved.limit; config.trustProxy = saved.trust; });
  const { srv, base } = await start(new Store(null));
  t.after(() => srv.close());
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}` }, body: JSON.stringify({ email: 'nobody@x.test', password: 'wrong password here' }) });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [401, 401, 429], 'the third attempt is limited even with a new fake IP each time');
});

test('behind a trusted proxy, X-Forwarded-For identifies the real client', async t => {
  const saved = { limit: config.loginRateLimit, trust: config.trustProxy };
  config.loginRateLimit = 1; config.trustProxy = true;
  t.after(() => { config.loginRateLimit = saved.limit; config.trustProxy = saved.trust; });
  const { srv, base } = await start(new Store(null));
  t.after(() => srv.close());
  const attempt = ip => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email: 'nobody@x.test', password: 'wrong password here' }) });
  assert.equal((await attempt('203.0.113.5')).status, 401);
  assert.equal((await attempt('203.0.113.5')).status, 429, 'the same client is limited');
  assert.equal((await attempt('203.0.113.9')).status, 401, 'a different client has its own bucket');
});

test('Postmark webhooks refuse a missing or wrong secret and accept the right one', async t => {
  const saved = config.postmarkWebhookSecret;
  config.postmarkWebhookSecret = 'webhook-secret-0123456789abcdef';
  t.after(() => { config.postmarkWebhookSecret = saved; });
  const { srv, base } = await start(new Store(null));
  t.after(() => srv.close());
  const post = q => fetch(base + '/webhooks/postmark' + q, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ RecordType: 'Delivery', MessageID: 'x' }) });
  assert.equal((await post('')).status, 401);
  assert.equal((await post('?token=wrong')).status, 401);
  assert.equal((await post('?token=webhook-secret-0123456789abcdef')).status, 200);
});
