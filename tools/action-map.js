#!/usr/bin/env node
/* Bright Clean — action-to-destination map, generated from the code.
   For every admin button handler: label → API calls (method + path) → server route (+ permission) → next screen/record.
   Flags DANGLING calls (no server route) so a button can never point at nothing.
   Usage: node tools/action-map.js            → writes docs/ACTION_MAP.md and tests/action-map.json, exits 1 on dangling calls */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const admin = read('public/admin/admin.js'), html = read('public/admin/index.html');

// ---------- balanced-bracket helper ----------
function balanced(src, i) { // i at an opening ( { or [ ; returns index after the matching close
  const open = src[i], close = { '(': ')', '{': '}', '[': ']' }[open]; let d = 0, q = null;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (q) { if (c === '\\') { k++; continue; } if (c === q) q = null; else if (q === '`' && c === '$' && src[k + 1] === '{') { const e = balanced(src, k + 1); k = e - 1; } continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); if (k < 0) return src.length; continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '/') { // regex literal (after an operator/opening token) — skip it so quotes inside do not start a string
      let p = k - 1; while (p >= 0 && /\s/.test(src[p])) p--;
      if (p < 0 || '(,=:[!&|?{};+-*%<>~^'.includes(src[p]) || /\b(return|typeof|case|in|of)$/.test(src.slice(Math.max(0, p - 6), p + 1))) {
        let j = k + 1, cls = false; for (; j < src.length; j++) { const ch = src[j]; if (ch === '\\') { j++; continue; } if (ch === '\n') break; if (cls) { if (ch === ']') cls = false; continue; } if (ch === '[') cls = true; else if (ch === '/') break; }
        if (src[j] === '/') { k = j; while (/[a-z]/.test(src[k + 1])) k++; continue; }
      }
    }
    if (c === open) d++; else if (c === close) { d--; if (!d) return k + 1; }
  }
  return src.length;
}
const lineOf = i => admin.slice(0, i).split('\n').length;

// ---------- labels: id → visible text (admin.js templates + index.html) ----------
const labels = {};
for (const src of [html, admin]) for (const m of src.matchAll(/<button[^>]*\bid="([A-Za-z0-9_-]+)"[^>]*>([\s\S]*?)<\/button>/g)) {
  let t = m[2].replace(/<[^>]+>/g, ''); const alt = [...t.matchAll(/'([A-Z][^'${}]{1,40})'/g)].map(x => x[1]); t = t.replace(/\$\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim() || alt.join(' / '); if (t && !labels[m[1]]) labels[m[1]] = t.slice(0, 60);
}
for (const src of [html, admin]) {
  for (const m of src.matchAll(/<form[^>]*\bid="([A-Za-z0-9_-]+)"[\s\S]{0,4000}?<button(?![^>]*type="button")[^>]*>([^<]+)<\/button>/g)) if (!labels['form:' + m[1]]) labels['form:' + m[1]] = 'Form: ' + m[2].replace(/\$\{[^}]*\}/g, '').trim();
  for (const m of src.matchAll(/<(a|input|select)[^>]*\bid="([A-Za-z0-9_-]+)"[^>]*>([^<]{0,60})/g)) if (!labels[m[2]]) { const t = m[3].replace(/\$\{[^}]*\}/g, '').trim(); const ph = (m[0].match(/(placeholder|aria-label|title)="([^"]+)"/) || [])[2]; labels[m[2]] = t || (ph ? `${m[1]}: ${ph}` : `${m[1]} #${m[2]}`); }
}

// ---------- find handlers ----------
const handlers = [];
const add = (kind, sel, start, from) => { const at0 = start;
  // skip "async", parameters and "=>" to the real body; a block body is balanced, an expression body runs to the end of the statement
  let i = from; while (/\s/.test(admin[i])) i++;
  const head = admin.slice(i, i + 200), arrow = head.match(/^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/), fn = head.match(/^(async\s+)?function\s*[\w$]*\s*\([^)]*\)\s*/), ref = head.match(/^([A-Za-z_$][\w$]*)\s*[,)]/);
  if (arrow) i += arrow[0].length; else if (fn) i += fn[0].length;
  else if (ref) { const def = admin.search(new RegExp('(?:async\\s+)?function\\s+' + ref[1] + '\\s*\\(')); if (def < 0) return; i = admin.indexOf('{', admin.indexOf(')', def)); handlers.push({ kind, sel, at: at0, line: lineOf(start), body: admin.slice(i, balanced(admin, i)), via: ref[1] }); return; }
  let end; if (admin[i] === '{' || admin[i] === '(') end = balanced(admin, i); else { end = i; let d = 0; for (; end < admin.length; end++) { const c = admin[end]; if ('({['.includes(c)) { end = balanced(admin, end) - 1; continue; } if (c === ';' || c === '\n') break; } }
  handlers.push({ kind, sel, at: at0, line: lineOf(start), body: admin.slice(i, end) }); };
for (const m of admin.matchAll(/\bact\('([^']+)',\s*/g)) { const b = m.index + m[0].length; add('act', m[1], m.index, admin[b] === '(' || admin[b] === '{' ? b : admin.indexOf('{', b)); }
for (const m of admin.matchAll(/\$\('([^']+)'\)\.(onclick|onsubmit|onchange)\s*=\s*/g)) { const b = m.index + m[0].length; const s = admin.slice(b).search(/[({]/); add(m[2], m[1], m.index, b + s); }
for (const m of admin.matchAll(/\$\$\('([^']+)'\)\.forEach\([^=]*=>\s*\w+\.(onclick|onchange)\s*=\s*/g)) { const b = m.index + m[0].length; const s = admin.slice(b).search(/[({]/); add('each-' + m[2], m[1], m.index, b + s); }
for (const m of admin.matchAll(/\$\('([^']+)'\)\.addEventListener\('(click|submit|change)',\s*/g)) { const b = m.index + m[0].length; const s = admin.slice(b).search(/[({]/); add('listen-' + m[2], m[1], m.index, b + s); }

// ---------- what each handler does ----------
const norm = p => p.replace(/\?.*$/, '').replace(/\$\{[^}]*\}/g, ':p').replace(/:p(:p)+/g, ':p').replace(/\/+$/, '');
const FN = Object.create(null); const def = (n, at, body) => (FN[n] = FN[n] || []).push({ at, body });
for (const m of admin.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) { const i = m.index + m[0].length - 1; def(m[1], m.index, admin.slice(i, balanced(admin, i))); }
for (const m of admin.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/g)) { const i = m.index + m[0].length; if (admin[i] === '{' || admin[i] === '(') def(m[1], m.index, admin.slice(i, balanced(admin, i))); else { let e = i, d = 0; for (; e < admin.length; e++) { const c = admin[e]; if ('([{'.includes(c)) { e = balanced(admin, e) - 1; continue; } if (c === ';' || c === '\n') break; } def(m[1], m.index, admin.slice(i, e)); } }
const SKIP = new Set(['api', 'toast', 'esc', 'money', 'go', 'openDrawer', 'closeDrawer', 'fmtWhen', 'todayISO', 'svg', 'ic', 'act', 'confirm']);
function analyse(body, depth = 0, at = Infinity) {
  const pick = n => { const ds = FN[n]; if (!ds) return null; const before = ds.filter(x => x.at < at); return (before.length ? before[before.length - 1] : ds[0]).body; };
  const calls = [];
  if (depth === 0) for (const m of body.matchAll(/\b([a-z][A-Za-z0-9_$]+)\(/g)) { const f = m[1]; if (!SKIP.has(f) && FN[f] && !/^(open|load|render)/.test(f)) { const sub = analyse(pick(f), 1); calls.push(...sub.calls.map(c => ({ ...c, via: f }))); } }
  // api('…' + id + '/x', { method }) — follow string concatenation; each non-string piece becomes :p
  for (const m of body.matchAll(/\b(api|fetch)\(\s*(?=[`'])/g)) {
    let i = m.index + m[0].length, out = '';
    for (;;) {
      while (/\s/.test(body[i])) i++;
      const q = body[i];
      if (q === "'" || q === '`') { const e = balanced(body.replace(/./g, (c, k) => k === i ? '(' : c), i); let j = i + 1; while (j < body.length && body[j] !== q) { if (body[j] === '\\') j++; else if (q === '`' && body[j] === '$' && body[j + 1] === '{') { j = balanced(body, j + 1) - 1; } j++; } out += body.slice(i + 1, j); i = j + 1; }
      else { let d = 0, j = i; for (; j < body.length; j++) { const c = body[j]; if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) { if (!d) break; d--; } else if (!d && (c === ',' || c === '+')) break; } out += '${x}'; i = j; }
      while (/\s/.test(body[i])) i++;
      if (body[i] === '+') { i++; continue; } break;
    }
    if (!out.startsWith('/api/')) continue;
    let method = 'GET'; if (body[i] === ',') { const opt = body.slice(i, i + 200).match(/^,\s*\{[^}]*?method:\s*'([A-Z]+)'/); if (opt) method = opt[1]; }
    calls.push({ method, path: norm(out.replace(/\/\$\{x\}$/, '/${x}')) });
  }
  const dest = new Set();
  for (const m of body.matchAll(/\bgo\('([a-z-]+)'/g)) dest.add('page: ' + m[1]);
  for (const m of body.matchAll(/\b(open[A-Z][A-Za-z]+)\(/g)) if (!/^openDrawer$/.test(m[1])) dest.add('opens: ' + m[1].replace(/^open/, ''));
  for (const m of body.matchAll(/openDrawer\(\{\s*title:\s*[`']([^`'$]{2,60})/g)) dest.add('panel: ' + m[1].trim());
  if (/window\.open\(|\.download\s*=|download=/.test(body)) dest.add('download/new tab');
  if (/\bload[A-Z][A-Za-z]*\(\)/.test(body)) dest.add('refreshes list');
  const seen = new Set(); const uniq = calls.filter(c => { const k = c.method + c.path; if (seen.has(k)) return false; seen.add(k); return true; });
  return { calls: uniq, dest: [...dest], confirm: /\bconfirm\(/.test(body), validates: /toast\([^)]*,\s*true\)|\.textContent\s*=\s*['`][A-Z]/.test(body) };
}

// ---------- server routes ----------
const routes = [];
for (const f of fs.readdirSync(ROOT).filter(f => f.endsWith('.js'))) {
  const src = read(f);
  for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*([`'])([^`']+)\2\s*,([^\n]*)/g)) {
    const raw = m[3], start = m.index, chunk = src.slice(start, start + 2500);
    // expand template routes with the real key lists from the source (never guessed)
    const keyList = v => { const near = src.slice(Math.max(0, start - 3000), start); if (v === 'key') { const reg = near.match(/const registers=\{([\s\S]*?)\};/); return reg ? [...reg[1].matchAll(/(\w+):\{table:/g)].map(x => x[1]) : []; } const arr = near.match(new RegExp('for \\(const ' + v + ' of \\[([^\\]]+)\\]\\)\\s*\\{?\\s*$', 'm')) || src.slice(Math.max(0, start - 300), start).match(/for \(const \w+ of \[([^\]]+)\]\)/); return arr ? arr[1].split(',').map(x => x.trim().replace(/'/g, '')) : []; };
    const keys = raw.includes('${key}') ? keyList('key') : raw.includes('${table}') ? keyList('table') : [null];
    for (const k of keys) {
      const p = (k ? raw.replace(/\$\{(key|table)\}/g, k) : raw).replace(/:\w+/g, ':p');
      const moduleCheck = /roleOf\(|\['owner', ?'manager'\]|role !== 'owner'|isOwner\(/.test(chunk.split(/\n\s*app\.(get|post|put|patch|delete)\(/)[0]);
      routes.push({ method: m[1].toUpperCase(), path: p, file: f, auth: /\bauth\b/.test(m[4]) ? 'signed-in' : 'public', moduleCheck });
    }
  }
}
// central gate rules (server.js)
const gate = [];
for (const m of read('server.js').matchAll(/\{m:\/\^\(?([A-Z|]+)\)?\$\/,p:\/(.+?)\/,roles:\[([^\]]+)\]/g)) gate.push({ methods: m[1].split('|'), re: new RegExp(m[2]), roles: m[3].replace(/'/g, '') });
const toRe = p => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:p/g, '[^/]+') + '$');
function routeFor(c) {
  const sample = c.path.replace(/:p/g, '1');
  const r = routes.find(r => r.method === c.method && (r.path === c.path || toRe(r.path).test(sample) || toRe(c.path).test(r.path.replace(/:p/g, '1'))));
  if (!r) return null;
  const g = gate.find(g => g.methods.includes(c.method) && g.re.test(sample));
  return { ...r, permission: g ? `central gate: ${g.roles}` : r.moduleCheck ? 'module check (owner/manager)' : r.auth === 'public' ? 'public' : 'any signed-in user' };
}

// ---------- observed effects from the click audit ----------
let inv = []; try { inv = JSON.parse(read('tests/button-inventory-pass1.json')); } catch { /* optional */ }
const observed = label => { const hits = inv.filter(b => b.label && label && b.label.toLowerCase() === label.toLowerCase()); if (!hits.length) return ''; const r = [...new Set(hits.map(h => h.result))]; return `${hits.length}× clicked: ${r.join('/')}`; };

// ---------- build ----------
const rows = handlers.map(h => {
  const a = analyse(h.body, 0, h.at), id = (h.sel.match(/^#([A-Za-z0-9_-]+)$/) || [])[1];
  let label = (id && (labels[id] || labels['form:' + id])) || '';
  if (!label) { const attr = (h.sel.match(/\[(data-[\w-]+)/) || [])[1]; if (attr) { const m = admin.match(new RegExp('<(button|a|tr|select|input)[^>]*\\b' + attr + '\\b[^>]*>([^<]{0,60})')); const t = m && m[2].replace(/\$\{[^}]*\}/g, '').trim(); const alt = m && [...(m[0] + admin.slice(m.index + m[0].length, m.index + m[0].length + 120)).matchAll(/'([A-Z][^'${}<]{1,30})'/g)].map(x => x[1]).slice(0, 2).join(' / ');
    label = t || alt || ({ 'data-call': 'Call row (open)', 'data-dial': '📞 Call', 'data-drill': 'Live metric (drill-down)', 'data-open': 'Drill-down row (open record)', 'data-svc': 'Collected-by-service bar', 'data-iss': 'Issue row (open)', 'data-issue': 'Issue link (open)', 'data-auto': 'Automation switch', 'data-g': 'Search result (open)', 'data-tko': 'Takeoff row (open)', 'data-rk': 'Readiness item', 'data-scope': 'Cleaning scope row (open)' }[attr]) || ''; if (label) label += ` [${attr}]`; } }
  if (!label && /Tabs button$/.test(h.sel)) label = 'Tab buttons ' + h.sel.split(' ')[0];
  if (!label && /\.kpi$/.test(h.sel)) label = 'Command Center KPI card';
  if (!label) label = h.sel;
  const calls = a.calls.map(c => { const r = routeFor(c); return { ...c, route: r ? `${r.file}` : null, permission: r ? r.permission : null }; });
  return { label, selector: h.sel, event: h.kind, line: h.line, calls, destinations: a.dest, confirm: a.confirm, user_feedback: a.validates, observed: observed(label) };
}).filter(r => r.calls.length || r.destinations.length);
const dangling = rows.flatMap(r => r.calls.filter(c => !c.route).map(c => `${r.label} (line ${r.line}) → ${c.method} ${c.path}`));
const used = new Set(rows.flatMap(r => r.calls.map(c => c.route && `${c.method} ${c.path}`)));
const adminRoutes = routes.filter(r => r.path.startsWith('/api/admin'));

// routes the admin never calls from a button (may still be used by pages, the public site, webhooks or background jobs)
const allFront = admin + read('public/admin/index.html') + fs.readdirSync(path.join(ROOT, 'public')).filter(f => /\.(html|js)$/.test(f)).map(f => read('public/' + f)).join('\n');
const unusedRoutes = adminRoutes.filter(r => { const base = r.path.split('/:p')[0]; return !rows.some(x => x.calls.some(c => c.method === r.method && toRe(r.path).test(c.path.replace(/:p/g, '1')))) && !allFront.includes(base.replace('/api/admin', '')); }).map(r => `${r.method} ${r.path} (${r.file})`);
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tests/action-map.json'), JSON.stringify({ generated: new Date().toISOString(), handlers: rows.length, dangling, unused_routes: unusedRoutes, rows }, null, 1));
const md = [`# Admin action → destination map`, '', `Generated from the code by \`node tools/action-map.js\` (${new Date().toISOString().slice(0, 10)}). Do not edit by hand.`, '',
  `**${rows.length}** button/form handlers that call the server or move the user somewhere · **${rows.reduce((s, r) => s + r.calls.length, 0)}** server calls · **${dangling.length}** dangling (no matching route) · ${adminRoutes.length} admin API routes exist.`, '',
  '| Control (label) | Event | Server call(s) → module · permission | Goes to / result | Confirms | Observed in click audit |', '|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.label.replace(/\|/g, '/')} | ${r.event} | ${r.calls.map(c => `${c.method} \`${c.path}\`${c.via ? ' (via ' + c.via + ')' : ''} → ${c.route || '**MISSING**'}${c.permission ? ' · ' + c.permission : ''}`).join('<br>') || '—'} | ${r.destinations.join('<br>') || 'stays on page (message)'} | ${r.confirm ? 'yes' : ''} | ${r.observed} |`),
  '', `## Server routes with no admin control (${unusedRoutes.length})`, 'Not necessarily dead: some serve the public site, crews, webhooks, exports or scheduled jobs. Review before removing anything.', '', ...unusedRoutes.map(u => '- ' + u), '', dangling.length ? `## Dangling calls\n${dangling.map(d => '- ' + d).join('\n')}` : '## Dangling calls\nNone — every button calls a route that exists.', ''].join('\n');
fs.writeFileSync(path.join(ROOT, 'docs/ACTION_MAP.md'), md);
console.log(`${rows.length} handlers, ${rows.reduce((s, r) => s + r.calls.length, 0)} calls, ${dangling.length} dangling`);
if (dangling.length) { console.log(dangling.join('\n')); process.exit(1); }
