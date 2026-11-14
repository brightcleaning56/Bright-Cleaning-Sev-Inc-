// Load test: concurrent realistic requests against a running server. Reports latency percentiles and error counts.
// Usage: node scripts/load-test.mjs <baseUrl> <email> <password> [requests=400] [concurrency=20]
// Run against a copy of production or a staging service, never against live customers.
const [base, email, password, reqs = '400', conc = '20'] = process.argv.slice(2);
if (!base || !email || !password) { console.error('usage: node scripts/load-test.mjs <baseUrl> <email> <password> [requests] [concurrency]'); process.exit(2); }
const N = Number(reqs), C = Number(conc);
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
if (!login.ok) { console.error('login failed', login.status); process.exit(1); }
const token = (await login.json()).token;
const paths = ['/health', '/api/me', '/api/publications', '/api/contracts', '/api/publisher/summary', '/api/requests', '/api/subscription'];
const times = []; let errors = 0, next = 0; const byStatus = {};
const started = Date.now();
async function worker() {
  while (true) {
    const i = next++; if (i >= N) return;
    const p = paths[i % paths.length];
    const t0 = performance.now();
    try {
      const r = await fetch(base + p, { headers: p === '/health' ? {} : { authorization: 'Bearer ' + token } });
      if (!r.ok) { errors++; const k = `${p} ${r.status}`; byStatus[k] = (byStatus[k] || 0) + 1; }
      await r.arrayBuffer();
    } catch { errors++; byStatus[`${p} network`] = (byStatus[`${p} network`] || 0) + 1; }
    times.push(performance.now() - t0);
  }
}
await Promise.all(Array.from({ length: C }, worker));
const seconds = (Date.now() - started) / 1000;
times.sort((a, b) => a - b);
const pct = q => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))]);
console.log(JSON.stringify({ requests: N, concurrency: C, seconds: Math.round(seconds * 10) / 10, requestsPerSecond: Math.round(N / seconds), p50ms: pct(0.5), p95ms: pct(0.95), p99ms: pct(0.99), errors, errorsByPathAndStatus: byStatus }, null, 2));
process.exit(errors ? 1 : 0);
