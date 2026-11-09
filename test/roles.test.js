import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';
import { config } from '../src/config.js';

let nextIp = 10;   // each test signs up from its own address (sign-up is rate limited per address)

async function harness(t) {
  config.trustProxy = true;
  const ip = `203.0.113.${nextIp++}`;
  const store = new Store(null);
  const srv = createServer(store).listen(0);
  await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: b && JSON.stringify(b) });
    const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  return { store, call };
}

test('a subcontractor signs up with the trade keys that invitations match on', async t => {
  const { store, call } = await harness(t);
  const base = { company: 'Bright Electric', segment: 'subcontractor', name: 'Ana', email: 'ana@bright.test', password: 'long enough password', state: 'WA' };
  assert.equal((await call('POST', '/api/signup/subscriber', { ...base, trades: [] })).status, 400, 'a trade is required');
  assert.equal((await call('POST', '/api/signup/subscriber', { ...base, trades: ['not_a_trade'] })).status, 400, 'unknown trade rejected');
  const ok = await call('POST', '/api/signup/subscriber', { ...base, trades: ['electrical', 'low_voltage'] });
  assert.equal(ok.status, 200);
  const org = store.list('orgs', o => o.name === 'Bright Electric')[0];
  assert.equal(org.segment, 'subcontractor');
  assert.deepEqual(org.trades, ['electrical', 'low_voltage'], 'matching uses these keys');
  assert.equal(org.territories[0], 'WA');
});

test('a service provider signs up with services and is matched to cleaning work', async t => {
  const { store, call } = await harness(t);
  const base = { company: 'Clear Pane', segment: 'service_provider', name: 'Lee', email: 'lee@clear.test', password: 'long enough password', state: 'IA' };
  assert.equal((await call('POST', '/api/signup/subscriber', { ...base, services: [] })).status, 400, 'choose a service');
  assert.equal((await call('POST', '/api/signup/subscriber', { ...base, services: ['skydiving'] })).status, 400, 'unknown service rejected');
  const ok = await call('POST', '/api/signup/subscriber', { ...base, services: ['post_construction', 'windows'] });
  assert.equal(ok.status, 200);
  const org = store.list('orgs', o => o.name === 'Clear Pane')[0];
  assert.equal(org.segment, 'service_provider');
  assert.deepEqual(org.services, ['post_construction', 'windows']);
  assert.ok(org.trades.includes('cleaning'), 'service providers are matched to cleaning requests');
});

test('a general contractor or owner signs up with a valid buyer type only', async t => {
  const { store, call } = await harness(t);
  const base = { company: 'Ryan Companies', name: 'Sam', email: 'sam@ryan.test', password: 'long enough password' };
  assert.equal((await call('POST', '/api/signup/buyer', { ...base, kind: 'hobbyist' })).status, 400);
  assert.equal((await call('POST', '/api/signup/buyer', { ...base, kind: 'construction_manager' })).status, 200);
  const org = store.list('orgs', o => o.name === 'Ryan Companies')[0];
  assert.equal(org.kind, 'buyer');
  assert.equal(org.buyerKind, 'construction_manager');
});
