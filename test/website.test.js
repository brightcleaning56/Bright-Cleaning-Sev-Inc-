import './_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['platform', 'project-intelligence', 'marketplace', 'plan-room', 'takeoff-estimating', 'bid-management', 'service-contractors', 'data-trust', 'pricing', 'about', 'solutions', 'contact', 'faq'];

async function serve(t) {
  const srv = createServer(new Store(null)).listen(0);
  await new Promise(r => srv.once('listening', r));
  t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}`;
}

test('the homepage is the public website; the workspace stays at /app and /login', async t => {
  const base = await serve(t);
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Find\. Bid\. Win\./);
  assert.ok(!homeHtml.includes('/main.js'), 'the homepage does not load the workspace script');
  for (const p of ['/app', '/login']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, p);
    assert.ok((await r.text()).includes('/main.js'), `${p} serves the workspace`);
  }
  assert.equal((await fetch(`${base}/admin`)).status, 200);
});

test('every public product page is served, with its own title and the shared styles', async t => {
  const base = await serve(t);
  for (const p of PAGES) {
    const r = await fetch(`${base}/${p}`);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /<title>[^<]+<\/title>/, `${p} has a title`);
    assert.match(html, /\/site\.css/, `${p} uses the site styles`);
  }
  const css = await fetch(`${base}/site.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const js = await fetch(`${base}/site.js`);
  assert.match(js.headers.get('content-type'), /text\/javascript/);
  assert.equal((await fetch(`${base}/pages.css`)).status, 200);
});

test('website pages respect the content policy: no inline scripts or event handlers', () => {
  const files = ['site.html', ...PAGES.map(p => `pages/${p}.html`)].map(f => path.join(ROOT, 'public', f));
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${path.basename(f)} has an inline script`);
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), `${path.basename(f)} has an inline event handler`);
  }
});

test('every internal link on the website leads to a page that exists', async t => {
  const base = await serve(t);
  const files = ['site.html', ...PAGES.map(p => `pages/${p}.html`)];
  const targets = new Set();
  for (const f of files) {
    const html = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]*)(?:[#?][^"]*)?"/g)) targets.add(m[1]);
  }
  assert.ok(targets.size > 20, 'the website links to its pages');
  for (const p of targets) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, `broken link on the website: ${p}`);
  }
});

test('the workspace sign-in links and emailed deep links point at /app, not the homepage', () => {
  const main = fs.readFileSync(path.join(ROOT, 'public/main.js'), 'utf8');
  assert.ok(!/href="\/">Sign in/.test(main), 'sign-in links go to /app');
  const server = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  assert.ok(!/href="\/">Sign in/.test(server));
  const digest = fs.readFileSync(path.join(ROOT, 'src/digest.js'), 'utf8');
  assert.ok(!/baseUrl\}\/#/.test(digest) && !/baseUrl\}\/`/.test(digest), 'emails link into /app');
  const billing = fs.readFileSync(path.join(ROOT, 'src/billing.js'), 'utf8');
  assert.ok(!/baseUrl\}\/\?billing/.test(billing), 'Stripe returns to /app');
});
