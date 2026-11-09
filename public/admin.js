// BUILDINTEL Super Admin portal. Holds no data of its own: every number and record comes from /api/admin/*, which
// enforces permissions server-side. Controls either work or are disabled with the phase that delivers them.
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => d ? new Date(d).toLocaleString() : '—';
let TOKEN = sessionStorage.getItem('bi_admin_token'), ME = null;

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login' && path !== '/api/admin/step-up') { sessionStorage.removeItem('bi_admin_token'); TOKEN = null; render(); throw new Error('signed out'); }
  if (r.status === 428) {                                    // step-up: confirm password, then retry once
    await stepUp(); return api(method, path, body);
  }
  if (!r.ok) throw Object.assign(new Error(data.error || ('error ' + r.status)), { status: r.status });
  return data;
}

// ---------- dialogs: reason / step-up ----------
function dialog({ title, message, needReason = true, extra = '', okLabel = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    $('#dlgt').textContent = title; $('#dlgm').textContent = message || ''; $('#dlgx').innerHTML = extra; $('#dlge').textContent = '';
    $('#dlgrl').style.display = needReason ? '' : 'none'; $('#dlgr').value = '';
    const ok = $('#dlgok'); ok.textContent = okLabel; ok.className = danger ? 'danger' : 'primary';
    const d = $('#dlg');
    ok.onclick = () => { const reason = $('#dlgr').value.trim(); if (needReason && reason.length < 5) { $('#dlge').textContent = 'Give a reason of at least 5 characters.'; return; }
      const fields = Object.fromEntries([...$('#dlgx').querySelectorAll('[name]')].map(x => [x.name, x.value])); d.close(); resolve({ reason, ...fields }); };
    d.onclose = () => { if (d.returnValue === 'cancel') resolve(null); };
    d.returnValue = ''; d.showModal(); (needReason ? $('#dlgr') : ($('#dlgx').querySelector('input') || ok)).focus();
  });
}
async function stepUp() {
  const mfa = ME?.mfa === 'enabled';
  const r = await dialog({ title: 'Confirm your identity', message: 'This action needs recent confirmation (valid for 10 minutes).', needReason: false, okLabel: 'Confirm',
    extra: '<label>Password<br><input type="password" name="password" autocomplete="current-password" style="width:100%"></label>' + (mfa ? '<br><label>Authenticator code<br><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="width:100%"></label>' : '') });
  if (!r) throw new Error('cancelled');
  await api('POST', '/api/admin/step-up', { password: r.password, ...(mfa ? { code: r.code } : {}) });
}
async function act(title, message, path, payload = {}, opts = {}) {
  const r = await dialog({ title, message, danger: opts.danger, extra: opts.extra || '' });
  if (!r) return null;
  try { const out = await api('POST', path, { ...payload, ...r }); toast(opts.done || 'Done — recorded in the audit log.'); return out; }
  catch (e) { if (e.message !== 'cancelled') alert(e.message); return null; }
}
function toast(msg) { const t = document.createElement('div'); t.setAttribute('role', 'status'); t.textContent = msg; t.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#0d2240;color:#fff;padding:10px 14px;border-radius:10px;z-index:9'; document.body.appendChild(t); setTimeout(() => t.remove(), 3500); }

// ---------- navigation (all spec sections; unbuilt ones disabled with their phase) ----------
const NAV = [
  ['A. Command Center', [['dashboard', 'Dashboard', 'admin.dashboard.read'], ['analytics', 'Platform analytics', 'admin.dashboard.read'], ['queue', 'Admin action queue', 'admin.dashboard.read']]],
  ['B. Organizations', [['companies', 'Companies', 'admin.company.read'], ['users', 'Users', 'admin.user.read'], ['verification', 'Publisher verification', 'admin.company.verify'], ['authority', 'Project authority', 'admin.publisher.review']]],
  ['C. Construction Intelligence', [['projects', 'Projects', 'admin.project.read'], ['duplicates', 'Duplicate review', 'admin.project.read'], ['markets', 'Trades & markets', 'admin.dashboard.read'], ['ext:#open:coverage', 'Coverage & core health (main app)', 'admin.project.read']]],
  ['D. Marketplace Operations', [['packages', 'Bid packages & bids', 'admin.bid.read'], ['documents', 'Plan-room documents', 'admin.bid.read']]],
  ['E. Financial Operations', [['subscriptions', 'Subscriptions', 'admin.billing.read'], [null, 'Invoices, refunds & reconciliation', 'Blocked — needs Stripe']]],
  ['F. Data & AI Operations', [['sources', 'Data sources', 'admin.source.manage'], ['ai', 'AI usage & limits', 'admin.ai.manage'], ['exports', 'Scoped exports', 'admin.dashboard.read']]],
  ['G. Customer Operations', [['support', 'Support cases & disputes', 'admin.support.manage']]],
  ['H. Security & Compliance', [['security', 'My security (MFA)', 'admin.dashboard.read'], ['audit', 'Audit log', 'admin.audit.read'], ['incidents', 'Security events & incidents', 'admin.support.manage'], ['privacy', 'Privacy requests', 'admin.company.read']]],
  ['I. System Administration', [['ext:#open:readiness', 'Launch gates & release (main app)', 'admin.system.manage'], ['jobs', 'Jobs, integrations, backups', 'admin.dashboard.read']]],
];
const can = p => ME?.permissions.includes(p);
const route = () => { const h = location.hash.replace(/^#\/?/, '') || 'dashboard'; const [path, qs] = h.split('?'); return { parts: path.split('/'), q: new URLSearchParams(qs || '') }; };
const go = (path, q) => { location.hash = '#/' + path + (q && [...q].length ? '?' + q : ''); };

async function render() {
  if (!TOKEN) return renderLogin();
  try { ME = await api('GET', '/api/admin/me'); } catch { return; }
  if (!ME.platformRoles.length) { $('#app').innerHTML = `<div id="login" class="card"><h2>No platform role</h2><p>This account (${esc(ME.email)}) has no BUILDINTEL platform role, so the Super Admin portal is not available.</p><button id="out">Sign out</button></div>`; $('#out').onclick = signOut; return; }
  const { parts, q } = route();
  $('#app').innerHTML = `<div id="shell"><nav id="side" aria-label="Super Admin"><h1>BUILDINTEL</h1><div class="sub">Super Admin · ${esc(ME.platformRoles.map(r => ME.roles[r]).join(', '))}</div>
    ${NAV.map(([g, items]) => `<div class="grp">${esc(g)}</div>${items.map(([k, label, perm]) => k === null ? `<button disabled title="Not built yet">${esc(label)}<small>${esc(perm)}</small></button>`
      : k.startsWith('ext:') ? (can(perm) ? `<button data-ext="${esc(k.slice(4))}">${esc(label)} ↗</button>` : '')
      : can(perm) ? `<button data-nav="${k}" ${parts[0] === k || ({ company: 'companies', user: 'users', project: 'projects', package: 'packages', document: 'documents', source: 'sources' }[parts[0]] === k) ? 'aria-current="page"' : ''}>${esc(label)}</button>` : '').join('')}`).join('')}</nav>
    <div><div id="top"><button id="menu" aria-controls="side" aria-expanded="false">☰ Menu</button><span id="crumbs"></span><span class="row"><span style="position:relative"><input id="gs" placeholder="Search companies and users" aria-label="Search companies and users" style="width:260px"><div id="gsr" class="card" style="display:none;position:absolute;right:0;top:36px;width:360px;z-index:5"></div></span>
      <span class="muted">${esc(ME.email)}</span><button id="out">Sign out</button></span></div><main id="main" tabindex="-1"><p class="muted">Loading…</p></main></div></div>`;
  document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => { $('#side').classList.remove('open'); go(b.dataset.nav); });
  $('#menu').onclick = () => { const o = $('#side').classList.toggle('open'); $('#menu').setAttribute('aria-expanded', String(o)); if (o) $('#side').querySelector('button:not([disabled])')?.focus(); };
  document.querySelectorAll('[data-ext]').forEach(b => b.onclick = () => { sessionStorage.setItem('bi_token', TOKEN); window.location.href = '/app' + b.dataset.ext; });   // same sign-in carries over
  $('#out').onclick = signOut;
  let tmr; $('#gs').oninput = () => { clearTimeout(tmr); tmr = setTimeout(globalSearch, 250); };
  const views = { dashboard: viewDashboard, companies: viewCompanies, company: viewCompany, users: viewUsers, user: viewUser, verification: viewVerification, authority: viewAuthority, audit: viewAudit,
    projects: viewProjects, project: viewProject, duplicates: viewDuplicates, markets: viewMarkets, packages: viewPackages, package: viewPackage, documents: viewDocuments, document: viewDocument,
    subscriptions: viewSubscriptions, sources: viewSources, source: viewSource, ai: viewAi, security: viewSecurity, analytics: viewAnalytics, queue: viewQueue, support: viewSupport, incidents: viewIncidentsRouter, privacy: viewPrivacy, jobs: viewJobs, exports: viewExports };
  const v = views[parts[0]] || viewDashboard;
  try { await v(parts, q); labelTables(); } catch (e) { $('#main').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
const crumbs = list => { $('#crumbs').innerHTML = list.map(([l, h]) => h ? `<a href="#/${h}">${esc(l)}</a>` : esc(l)).join(' / '); document.title = list.at(-1)[0] + ' · BUILDINTEL Super Admin'; };
function renderLogin() {
  $('#app').innerHTML = `<form id="login" class="card"><h2>BUILDINTEL Super Admin</h2><p class="muted">Sign in with a BUILDINTEL platform account.</p>
    <label>Email<br><input id="le" type="email" autocomplete="username" style="width:100%"></label><br><br><label>Password<br><input id="lp" type="password" autocomplete="current-password" style="width:100%"></label>
    <p class="err" id="lerr"></p><button class="primary">Sign in</button></form>`;
  $('#login').onsubmit = async ev => { ev.preventDefault();
    const code = $('#lc')?.value.trim();
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('#le').value.trim(), password: $('#lp').value, ...(code ? { code } : {}) }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { TOKEN = d.token; sessionStorage.setItem('bi_admin_token', TOKEN); return render(); }
    if (d.mfaRequired && !$('#lc')) $('#lp').closest('label').insertAdjacentHTML('afterend', '<br><br><label>Authenticator code<br><input id="lc" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="width:100%"></label>');
    $('#lerr').textContent = d.error || 'sign-in failed'; $('#lc')?.focus(); };
}
async function signOut() { try { await api('POST', '/api/logout'); } catch {} sessionStorage.removeItem('bi_admin_token'); TOKEN = null; location.hash = ''; render(); }
async function globalSearch() {
  const qv = $('#gs').value.trim(), box = $('#gsr'); if (qv.length < 2) { box.style.display = 'none'; return; }
  const [c, u] = await Promise.all([can('admin.company.read') ? api('GET', '/api/admin/companies?limit=5&q=' + encodeURIComponent(qv)) : { items: [] }, can('admin.user.read') ? api('GET', '/api/admin/users?limit=5&q=' + encodeURIComponent(qv)) : { items: [] }]);
  box.innerHTML = [...c.items.map(x => `<div><a href="#/company/${x.id}">${esc(x.name)}</a> <small class="muted">company · ${esc(x.type)}</small></div>`), ...u.items.map(x => `<div><a href="#/user/${x.id}">${esc(x.email)}</a> <small class="muted">user · ${esc(x.company || '')}</small></div>`)].join('') || '<small class="muted">No matches.</small>';
  box.style.display = 'block'; box.querySelectorAll('a').forEach(a => a.onclick = () => { box.style.display = 'none'; $('#gs').value = ''; });
}

// ---------- shared table with server-side filters, sort and pages ----------
function pager(res, base, q) {
  const cur = Number(q.get('cursor') || 0), lim = Number(q.get('limit') || 25);
  const prev = new URLSearchParams(q); prev.set('cursor', Math.max(0, cur - lim)); const next = new URLSearchParams(q); next.set('cursor', res.nextCursor || 0);
  return `<div class="row" style="justify-content:space-between;margin-top:8px"><small class="muted">${res.total} total · showing ${res.items.length ? cur + 1 : 0}–${cur + res.items.length} · as of ${fmt(res.asOf)}</small>
    <span class="row"><button ${cur ? '' : 'disabled'} data-go="${esc(base + '?' + prev)}">Previous</button><button ${res.nextCursor ? '' : 'disabled'} data-go="${esc(base + '?' + next)}">Next</button></span></div>`;
}
const bindGo = root => root.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { location.hash = '#/' + b.dataset.go; });
const statusPill = s => `<span class="pill ${{ verified: 'green', active: 'green', email_confirmed: 'green', pending: 'amber', more_info_requested: 'amber', email_unconfirmed: 'amber', suspended: 'red', rejected: 'red', disabled: 'red' }[s] || ''}">${esc(String(s).replace(/_/g, ' '))}</span>`;
function filterForm(fields, q, base) {
  const active = [...q].filter(([k]) => k !== 'sort' && k !== 'cursor').length;   // sorting and paging aren't filters
  return `<details class="filters" ${window.innerWidth > 820 || active ? 'open' : ''}><summary>Filters${active ? ' (active)' : ''}</summary><form class="row card" id="ff">${fields.map(([k, label, opts]) => opts ? `<label>${esc(label)} <select name="${k}"><option value="">any</option>${opts.map(o => `<option ${q.get(k) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>` : `<input name="${k}" placeholder="${esc(label)}" value="${esc(q.get(k) || '')}">`).join('')}<button class="primary">Apply</button><button type="button" id="ffclear">Clear</button></form></details>`;
}
function bindFilter(base) {
  $('#ff').onsubmit = ev => { ev.preventDefault(); const q = new URLSearchParams([...new FormData(ev.target)].filter(([, v]) => v)); go(base, q); };
  $('#ffclear').onclick = () => go(base);
}

// ---------- views ----------
async function viewDashboard() {
  crumbs([['Dashboard']]);
  const d = await api('GET', '/api/admin/overview');
  $('#main').innerHTML = `<p class="muted">Computed from stored records · as of ${fmt(d.asOf)} (${esc(d.timezone)}). Hover a number for its formula. Values that cannot be measured yet say why instead of showing zero.</p>` +
    d.sections.map(s => `<section class="card"><h2 style="margin-top:0;font-size:16px">${esc(s.title)}</h2><div class="cards">${s.cards.map(c => `<div class="metric">${c.unavailable
      ? `<b>—</b><small>${esc(c.label)}</small><div class="na">${esc(c.unavailable)}</div>`
      : c.drill && can(c.drill.perm || (c.drill.view === 'users' ? 'admin.user.read' : 'admin.company.read')) ? `<button title="${esc(c.formula)}" data-drill='${esc(JSON.stringify(c.drill))}'><b>${esc(c.value)}</b><small>${esc(c.label)} ›</small></button>`
      : `<span title="${esc(c.formula)}"><b>${esc(c.value)}</b><small>${esc(c.label)}</small></span>`}</div>`).join('')}</div></section>`).join('');
  document.querySelectorAll('[data-drill]').forEach(b => b.onclick = () => { const x = JSON.parse(b.dataset.drill); go(x.view, new URLSearchParams(x.filter || {})); });
}
async function viewCompanies(_, q, base = 'companies', title = 'Companies') {
  crumbs([[title]]);
  if (!q.get('sort')) q.set('sort', 'name');
  const r = await api('GET', '/api/admin/companies?' + q);
  $('#main').innerHTML = filterForm([['q', 'Name or ID'], ['type', 'Type', ['publisher', 'subscriber', 'platform company']], ['verification', 'Verification', ['unverified', 'pending', 'more_info_requested', 'verified', 'rejected', 'email_confirmed', 'email_unconfirmed']], ['status', 'Status', ['active', 'pending', 'suspended']], ['sort', 'Sort', ['name', 'created', 'activity', 'members']]], q, base) +
    `<div class="card scroll"><table><tr><th>Company</th><th>Type</th><th>Verification</th><th>Status</th><th>Market</th><th>Plan</th><th>Members</th><th>Last activity</th></tr>
    ${r.items.map(c => `<tr><td><a href="#/company/${c.id}">${esc(c.name)}</a></td><td>${esc(c.type)}${c.buyerKind ? '<br><small class="muted">' + esc(c.buyerKind.replace(/_/g, ' ')) + '</small>' : ''}</td><td>${statusPill(c.verification)}</td><td>${statusPill(c.status)}</td><td>${esc(c.primaryMarket || '—')}</td><td>${esc(c.planName)}</td><td>${c.members}</td><td>${fmt(c.lastActivity)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No companies match.</td></tr>'}</table>${pager(r, base, q)}</div>`;
  bindFilter(base); bindGo($('#main'));
}
const viewVerification = (p, q) => { if (!q.get('type')) { q.set('type', 'publisher'); q.set('verification', 'pending'); } return viewCompanies(p, q, 'verification', 'Publisher verification'); };
const TABS = [['overview', 'Overview'], ['verification', 'Verification'], ['members', 'Members'], ['markets', 'Trades & markets'], ['credentials', 'Licenses & insurance'], ['publishing', 'Publisher authority'], ['marketplace', 'Projects & bids'], ['subscription', 'Subscription'], ['support', 'Restrictions & notes'], ['activity', 'Activity']];
async function viewCompany(parts) {
  const id = parts[1], tab = parts[2] || 'overview';
  const c = await api('GET', '/api/admin/companies/' + id);
  crumbs([['Companies', 'companies'], [c.name]]);
  const v = c.verificationDetail, body = {
    overview: `<table><tr><th>Legal name</th><td>${esc(c.legal?.name || c.name)}</td></tr><tr><th>Type</th><td>${esc(c.type)} ${esc(c.buyerKind || '')}</td></tr><tr><th>Status</th><td>${statusPill(c.status)}</td></tr><tr><th>Verification</th><td>${statusPill(c.verification)}</td></tr><tr><th>Created</th><td>${fmt(c.createdAt)}</td></tr><tr><th>Company ID</th><td><code>${esc(c.id)}</code></td></tr></table>`,
    verification: `<table><tr><th>Status</th><td>${statusPill(v.status)}</td></tr>${v.evidence ? `<tr><th>Evidence</th><td>${Object.entries(v.evidence).filter(([, x]) => x).map(([k, x]) => `${esc(k)}: ${esc(x)}`).join('<br>')}</td></tr>` : ''}<tr><th>Requested</th><td>${fmt(v.requestedAt)}</td></tr><tr><th>Last decision</th><td>${esc(v.decidedBy || '—')} ${v.decidedAt ? fmt(v.decidedAt) : ''}<br>${esc(v.note || '')}</td></tr></table>
      ${c.type === 'publisher' && can('admin.company.verify') ? `<div class="row" style="margin-top:10px"><button class="primary" data-dec="approve">Approve</button><button data-dec="request_info">Request more information</button><button class="danger" data-dec="reject">Reject</button></div>` : ''}`,
    members: `<table><tr><th>User</th><th>Company role</th><th>Platform roles</th><th>State</th><th>Last login</th></tr>${c.members.map(m => `<tr><td><a href="#/user/${m.id}">${esc(m.email)}</a></td><td>${esc(m.role)}</td><td>${esc(m.platformRoles.join(', ') || '—')}</td><td>${statusPill(m.disabled ? 'disabled' : 'active')}</td><td>${fmt(m.lastLoginAt)}</td></tr>`).join('')}</table>`,
    markets: `<p><b>Trades:</b> ${esc(c.trades.join(', ') || '—')}</p><p><b>Territories:</b> ${esc(c.territories.join(', ') || '—')}</p>`,
    credentials: c.credentials.length ? `<table><tr><th>Kind</th><th>Status</th><th>Expires</th></tr>${c.credentials.map(x => `<tr><td>${esc(x.kind)}</td><td>${esc(x.status)}</td><td>${esc(x.expiresOn || '—')}</td></tr>`).join('')}</table>` : '<p class="muted">No licenses or insurance on file.</p>',
    publishing: c.publications.length ? `<table><tr><th>Publication</th><th>Status</th><th>Relationship</th><th>Authority review</th></tr>${c.publications.map(p => `<tr><td>${esc(p.title)}</td><td>${esc(p.status)}</td><td>${esc(String(p.relationship || '').replace(/_/g, ' '))}</td><td>${esc(p.authorityReview || 'not required')}</td></tr>`).join('')}</table>` : '<p class="muted">No publications.</p>',
    marketplace: `<table>${Object.entries(c.marketplace).map(([k, x]) => `<tr><th>${esc(k.replace(/([A-Z])/g, ' $1'))}</th><td>${esc(x)}</td></tr>`).join('')}</table><p class="muted">Package and bid drill-down arrives with marketplace oversight (Phase 3).</p>`,
    subscription: `<table><tr><th>Plan</th><td>${esc(c.subscription.name || c.subscription.plan)}</td></tr><tr><th>Status</th><td>${esc(c.subscription.status || '—')}</td></tr><tr><th>Seats</th><td>${esc(c.subscription.seats ?? '—')}</td></tr><tr><th>Payments</th><td>Stripe ${esc(c.subscription.stripe)}</td></tr></table>`,
    support: `<h3>Restrictions</h3>${c.restrictions.length ? c.restrictions.map(r => `<div>${esc(r.type)} · ${fmt(r.at)} · ${esc(r.by)} — ${esc(r.reason)}</div>`).join('') : '<p class="muted">None.</p>'}
      ${can('admin.company.suspend') && c.type !== 'platform company' ? `<p>${c.status === 'suspended' ? '<button id="react" class="primary">Reactivate company</button>' : '<button id="susp" class="danger">Suspend company</button>'}</p>` : ''}
      <h3>Internal notes</h3><p class="muted">Visible to BUILDINTEL staff only.</p>${c.notes.map(n => `<div class="card"><small class="muted">${esc(n.author)} · ${fmt(n.createdAt)}</small><div>${esc(n.body)}</div></div>`).join('') || '<p class="muted">No notes.</p>'}
      <form id="nf" class="row"><input name="body" placeholder="Add an internal note" style="flex:1" aria-label="Internal note"><button>Add note</button></form>`,
    activity: `<table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>${c.activity.map(a => `<tr><td>${fmt(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td><small>${esc(a.detail?.reason || '')}${a.detail?.after ? ' → ' + esc(JSON.stringify(a.detail.after)) : ''}</small></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No activity.</td></tr>'}</table>`,
  };
  $('#main').innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(c.name)}</h2><span>${statusPill(c.status)} ${statusPill(c.verification)}</span></div>
    <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" data-tab="${k}">${esc(l)}</button>`).join('')}</div><div role="tabpanel">${body[tab] || body.overview}</div></div>`;
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => go(`company/${id}/${b.dataset.tab}`));
  const reload = () => viewCompany(parts);
  document.querySelectorAll('[data-dec]').forEach(b => b.onclick = async () => { const d = b.dataset.dec;
    if (await act({ approve: 'Approve publisher', request_info: 'Request more information', reject: 'Reject publisher' }[d], d === 'request_info' ? 'Say exactly what the company must provide; they see this message.' : 'Record how you checked the evidence.', `/api/admin/companies/${id}/verification-decision`, { decision: d }, { danger: d === 'reject' })) reload(); });
  $('#susp')?.addEventListener('click', async () => { if (await act('Suspend company', 'All members are signed out and blocked until reactivated. Requires password confirmation.', `/api/admin/companies/${id}/status`, { status: 'suspended' }, { danger: true })) reload(); });
  $('#react')?.addEventListener('click', async () => { if (await act('Reactivate company', 'Members can sign in again.', `/api/admin/companies/${id}/status`, { status: 'active' })) reload(); });
  $('#nf')?.addEventListener('submit', async ev => { ev.preventDefault(); const body = ev.target.body.value.trim(); if (!body) return; await api('POST', `/api/admin/companies/${id}/notes`, { body }); reload(); });
}
async function viewUsers(_, q) {
  crumbs([['Users']]);
  if (!q.get('sort')) q.set('sort', 'email');
  const r = await api('GET', '/api/admin/users?' + q);
  $('#main').innerHTML = filterForm([['q', 'Email, name or company'], ['state', 'State', ['active', 'disabled']], ['platform', 'Platform', ['staff', 'customers']], ['sort', 'Sort', ['email', 'lastLogin', 'created']]], q, 'users') +
    `<div class="card scroll"><table><tr><th>User</th><th>Company</th><th>Company role</th><th>Platform roles</th><th>State</th><th>Sessions</th><th>Last login</th></tr>
    ${r.items.map(u => `<tr><td><a href="#/user/${u.id}">${esc(u.email)}</a></td><td>${u.orgId ? `<a href="#/company/${u.orgId}">${esc(u.company || '')}</a>` : '—'}</td><td>${esc(u.companyRole)}</td><td>${esc(u.platformRoles.join(', ') || '—')}</td><td>${statusPill(u.state)}</td><td>${u.activeSessions}</td><td>${fmt(u.lastLoginAt)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No users match.</td></tr>'}</table>${pager(r, 'users', q)}</div>`;
  bindFilter('users'); bindGo($('#main'));
}
async function viewUser(parts) {
  const id = parts[1]; const u = await api('GET', '/api/admin/users/' + id);
  crumbs([['Users', 'users'], [u.email]]);
  const self = u.email === ME.email;
  $('#main').innerHTML = `<div class="card"><h2 style="margin-top:0">${esc(u.email)}</h2><table><tr><th>Company</th><td>${u.orgId ? `<a href="#/company/${u.orgId}">${esc(u.company)}</a>` : '—'}</td></tr><tr><th>Company role</th><td>${esc(u.companyRole)}</td></tr>
    <tr><th>State</th><td>${statusPill(u.state)}</td></tr><tr><th>Active sessions</th><td>${u.activeSessions}</td></tr><tr><th>MFA</th><td>${esc(u.mfa)} ${u.mfa === 'enabled' && can('admin.security.manage') && !self ? '<button id="umfa" class="danger">Reset MFA</button>' : ''}</td></tr><tr><th>Last login</th><td>${fmt(u.lastLoginAt)}</td></tr>
    <tr><th>Platform roles</th><td>${esc(u.platformRoles.join(', ') || 'none')}</td></tr></table>
    ${can('admin.user.manage') && !self ? `<div class="row" style="margin-top:10px">${u.state === 'disabled' ? '<button id="uen" class="primary">Reactivate user</button>' : '<button id="udis" class="danger">Disable user</button>'}<button id="urev" ${u.activeSessions ? '' : 'disabled title="No active sessions"'}>Sign out everywhere</button></div>` : self ? '<p class="muted">You cannot change your own account here.</p>' : ''}
    ${can('admin.roles.manage') && !self ? `<h3>Platform roles</h3><div class="row"><select id="rsel" aria-label="Platform role">${Object.entries(ME.roles).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select><button id="rgrant">Grant</button><button id="rrev">Revoke</button></div><p class="muted">Role changes require password confirmation. Only a platform owner can grant or revoke platform owner.</p>` : ''}
    <h3>Sign-in history</h3>${u.loginHistory.map(h => `<div><small>${fmt(h.at)} · ${esc(h.action)}</small></div>`).join('') || '<p class="muted">No sign-ins recorded.</p>'}</div>`;
  const reload = () => viewUser(parts);
  $('#umfa')?.addEventListener('click', async () => { if (await act('Reset MFA', 'For a lost authenticator: confirm their identity first. They are signed out everywhere and must enroll again. Requires your password and code.', `/api/admin/users/${id}/mfa-reset`, {}, { danger: true })) reload(); });
  $('#udis')?.addEventListener('click', async () => { if (await act('Disable user', 'They are signed out everywhere and cannot sign in. Requires password confirmation.', `/api/admin/users/${id}/status`, { state: 'disabled' }, { danger: true })) reload(); });
  $('#uen')?.addEventListener('click', async () => { if (await act('Reactivate user', 'They can sign in again.', `/api/admin/users/${id}/status`, { state: 'active' })) reload(); });
  $('#urev')?.addEventListener('click', async () => { if (await act('Sign out everywhere', 'Ends every active session for this user. Requires password confirmation.', `/api/admin/users/${id}/revoke-sessions`)) reload(); });
  const role = grant => async () => { if (await act(grant ? 'Grant platform role' : 'Revoke platform role', `${grant ? 'Grant' : 'Revoke'}: ${ME.roles[$('#rsel').value]}`, `/api/admin/users/${id}/platform-roles`, { role: $('#rsel').value, grant })) reload(); };
  $('#rgrant')?.addEventListener('click', role(true)); $('#rrev')?.addEventListener('click', role(false));
}
async function viewAuthority(_, q) {
  crumbs([['Project authority']]);
  const r = await api('GET', '/api/admin/authority?' + q);
  $('#main').innerHTML = `<p class="muted">Construction managers, architects and other agents publishing for an owner. Approving the company does not approve its authority for a specific project.</p>
    <div class="card scroll"><table><tr><th>Project</th><th>Publisher</th><th>Relationship</th><th>Evidence</th><th>Review</th><th></th></tr>${r.items.map(x => `<tr><td>${esc(x.title)}</td><td><a href="#/company/${x.publisherOrgId}">${esc(x.publisher)}</a></td><td>${esc(x.relationship)}</td><td>${esc(x.evidence || '—')}</td><td>${statusPill(x.review)}</td>
      <td>${x.review === 'pending' ? `<button data-auth="${x.id}" data-d="approved" class="primary">Approve</button> <button data-auth="${x.id}" data-d="rejected" class="danger">Reject</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing to review.</td></tr>'}</table>${pager(r, 'authority', q)}</div>`;
  bindGo($('#main'));
  document.querySelectorAll('[data-auth]').forEach(b => b.onclick = async () => { if (await act(b.dataset.d === 'approved' ? 'Approve authority' : 'Reject authority', 'Record how you confirmed the owner authorized this publisher.', `/api/admin/authority/${b.dataset.auth}/decision`, { decision: b.dataset.d }, { danger: b.dataset.d === 'rejected' })) viewAuthority(_, q); });
}
// ---------- Phase 2b: platform analytics and admin action queue ----------
async function viewAnalytics() {
  crumbs([['Platform analytics']]);
  const r = await api('GET', '/api/admin/analytics');
  const months = r.series[0].values.map(v => v.month);
  $('#main').innerHTML = `<p class="muted">Computed from stored records, UTC, last 12 months (${esc(r.window.from)} to ${esc(r.window.to)}). A zero means nothing was recorded in that month. Nothing here is estimated.</p>
    <div class="card scroll"><table><tr><th>Measure</th><th>Total</th><th>In window</th>${months.map(m => '<th>' + esc(m) + '</th>').join('')}</tr>
    ${r.series.map(s => '<tr><td title="' + esc(s.formula) + '">' + esc(s.label) + '</td><td>' + s.total + '</td><td>' + s.inWindow + '</td>' + s.values.map(v => '<td>' + v.count + '</td>').join('') + '</tr>').join('')}</table></div>
    <h3>Data sources</h3>
    <div class="card scroll"><table><tr><th>Source</th><th>Enabled</th><th>Last successful run</th><th>Last error</th></tr>
    ${r.sources.map(s => '<tr><td>' + esc(s.name) + '</td><td>' + (s.enabled ? 'yes' : 'no') + '</td><td>' + (s.lastSuccessAt ? fmt(s.lastSuccessAt) : '—') + '</td><td class="muted">' + esc(s.lastError || '—') + '</td></tr>').join('') || '<tr><td colspan="4" class="muted">No sources configured.</td></tr>'}</table></div>`;
  bindGo($('#main'));
}
async function viewQueue() {
  crumbs([['Admin action queue']]);
  const r = await api('GET', '/api/admin/action-queue');
  $('#main').innerHTML = `<p class="muted">Everything that needs an administrator decision, oldest first. ${r.count} open.</p>
    <div class="card scroll"><table><tr><th>Type</th><th>Item</th><th>Detail</th><th>Since</th><th></th></tr>
    ${r.items.map(x => '<tr><td>' + esc(x.label) + '</td><td>' + esc(x.title) + '</td><td class="muted">' + esc(x.detail) + '</td><td>' + (x.since ? fmt(x.since) : '—') + '</td><td>' + (x.link ? '<a href="' + esc(x.link) + '">Open</a>' : '—') + '</td></tr>').join('') || '<tr><td colspan="5" class="muted">Nothing waiting. Every item is handled.</td></tr>'}</table></div>`;
  bindGo($('#main'));
}
// ---------- Phase 5: support cases (internal and customer-visible notes) ----------
const PRIORITY = ['low', 'normal', 'high'];
const CASE_STATUS = ['open', 'waiting_customer', 'resolved', 'closed'];
async function viewSupport(parts, q) {
  if (parts[1]) return viewSupportCase(parts[1]);
  crumbs([['Support cases']]);
  const r = await api('GET', '/api/admin/support?' + q);
  const companies = (await api('GET', '/api/admin/companies?limit=100')).items || [];
  $('#main').innerHTML = `<p class="muted">Internal notes are for staff only. Customer-visible notes are the only notes a company sees.</p>
    <div class="card"><h3>New case</h3>
      <form id="newcase" class="grid2">
        <label>Company <select name="companyId">${companies.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
        <label>Priority <select name="priority">${PRIORITY.map(p => `<option>${p}</option>`).join('')}</select></label>
        <label>Subject <input name="subject" required minlength="5"></label>
        <label>Opening message (visible to the company) <textarea name="body"></textarea></label>
        <div><button class="primary" type="submit">Open case</button></div>
      </form></div>
    <div class="card scroll"><table><tr><th>Subject</th><th>Company</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Updated</th></tr>
    ${r.items.map(c => `<tr><td><a href="#/support/${esc(c.id)}">${esc(c.subject)}</a></td><td>${esc(c.company)}</td><td>${esc(c.status)}</td><td>${esc(c.priority)}</td><td>${esc(c.assignee || '—')}</td><td>${fmt(c.updatedAt)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No support cases.</td></tr>'}</table></div>`;
  $('#newcase').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target);
    try { const c = await api('POST', '/api/admin/support', Object.fromEntries(f)); location.hash = '#/support/' + c.id; } catch (err) { toast(err.message); } };
  const inq = (await api('GET', '/api/admin/inquiries')).items || [];
  $('#main').insertAdjacentHTML('beforeend', `<div class="card scroll"><h3>Website inquiries</h3><p class="muted">Messages from the public contact form. Reply by email; these are not linked to an account.</p>
    <table><tr><th>Received</th><th>From</th><th>Company</th><th>Type</th><th>Message</th></tr>
    ${inq.map(x => `<tr><td>${fmt(x.createdAt)}</td><td>${esc(x.name)}<br><small class="muted"><a href="mailto:${esc(x.email)}">${esc(x.email)}</a></small></td><td>${esc(x.company || '—')}</td><td>${esc(x.type)}</td><td>${esc(x.message)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No messages yet.</td></tr>'}</table></div>`);
  bindGo($('#main'));
}
async function viewSupportCase(id) {
  const c = await api('GET', '/api/admin/support/' + encodeURIComponent(id));
  crumbs([['Support cases', 'support'], [c.subject]]);
  $('#main').innerHTML = `<div class="card"><h2>${esc(c.subject)}</h2>
    <p class="muted">${esc(c.company || '—')} · priority ${esc(c.priority)} · assignee ${esc(c.assignee || 'none')} · opened by ${esc(c.createdBy)}</p>
    <p>Status: <strong>${esc(c.status)}</strong></p>
    <h3>Notes</h3>
    ${(c.notes || []).map(n => `<div class="note"><small>${fmt(n.at)} · ${esc(n.by)} · <span class="${n.visibility === 'internal' ? 'warn' : ''}">${esc(n.visibility === 'internal' ? 'INTERNAL (staff only)' : 'visible to company')}</span></small><p>${esc(n.body)}</p></div>`).join('') || '<p class="muted">No notes yet.</p>'}
    <form id="addnote" class="grid2"><label>Visibility <select name="visibility"><option value="customer">Visible to company</option><option value="internal">Internal (staff only)</option></select></label>
      <label>Note <textarea name="body" required></textarea></label><div><button type="submit">Add note</button></div></form></div>
    <div class="card"><h3>Status</h3><form id="setstatus" class="grid2">
      <label>New status <select name="status">${CASE_STATUS.map(s => `<option value="${s}" ${s === c.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select></label>
      <label>Reason (required) <input name="reason" minlength="5" required></label><div><button type="submit">Change status</button></div></form>
      <form id="assign" class="grid2"><label>Assign to (name or email) <input name="assignee" required></label><div><button type="submit">Assign</button></div></form></div>
    <div class="card"><h3>History</h3><table><tr><th>When</th><th>By</th><th>Action</th><th>Reason</th></tr>
    ${(c.history || []).map(h => `<tr><td>${fmt(h.at)}</td><td>${esc(h.by)}</td><td>${esc(h.action)}</td><td class="muted">${esc(h.reason || '')}</td></tr>`).join('')}</table></div>`;
  const post = async (path, body, msg) => { try { await api('POST', '/api/admin/support/' + encodeURIComponent(id) + path, body); toast(msg); viewSupportCase(id); } catch (err) { toast(err.message); } };
  $('#addnote').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); post('/notes', Object.fromEntries(f), 'Note added'); };
  $('#setstatus').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); post('/status', Object.fromEntries(f), 'Status changed'); };
  $('#assign').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); post('/assign', Object.fromEntries(f), 'Case assigned'); };
  bindGo($('#main'));
}
// ---------- Phase 5: incidents, privacy requests, jobs and health, scoped exports ----------
async function viewIncidents(parts) {
  crumbs([['Security events & incidents']]);
  const r = await api('GET', '/api/admin/incidents');
  const sev = ['low', 'medium', 'high', 'critical'];
  $('#main').innerHTML = `<p class="muted">Record security events and their handling. The timeline is append-only.</p>
    <div class="card"><h3>Open an incident</h3><form id="newinc" class="grid2">
      <label>Title <input name="title" minlength="5" required></label>
      <label>Severity <select name="severity">${sev.map(s => `<option>${s}</option>`).join('')}</select></label>
      <label>Summary <textarea name="summary"></textarea></label><div><button class="primary" type="submit">Open incident</button></div></form></div>
    <div class="card scroll"><table><tr><th>Incident</th><th>Severity</th><th>Status</th><th>Opened by</th><th>Opened</th><th>Last update</th></tr>
    ${r.items.map(i => `<tr><td><a href="#/incidents/${esc(i.id)}">${esc(i.title)}</a></td><td>${esc(i.severity)}</td><td>${esc(i.status)}</td><td>${esc(i.openedBy)}</td><td>${fmt(i.createdAt)}</td><td>${fmt(i.updatedAt)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No incidents recorded.</td></tr>'}</table></div>`;
  $('#newinc').onsubmit = async e => { e.preventDefault(); try { const x = await api('POST', '/api/admin/incidents', Object.fromEntries(new FormData(e.target))); location.hash = '#/incidents/' + x.id; } catch (err) { toast(err.message); } };
  bindGo($('#main'));
}
function viewIncidentsRouter(parts, q) { return parts[1] ? viewIncidentDetail(parts[1]) : viewIncidents(parts, q); }
async function viewIncidentDetail(id) {
  crumbs([['Security events & incidents', 'incidents'], ['Incident']]);
  const all = await api('GET', '/api/admin/incidents');
  const i = all.items.find(x => x.id === id);
  if (!i) { $('#main').innerHTML = '<p class="muted">Incident not found.</p>'; return; }
  $('#main').innerHTML = `<div class="card"><h2>${esc(i.title)}</h2><p class="muted">${esc(i.severity)} · ${esc(i.status)} · opened by ${esc(i.openedBy)}</p>
    <form id="upd" class="grid2"><label>New status <select name="status"><option>open</option><option>monitoring</option><option>resolved</option></select></label>
    <label>Update (required) <textarea name="message" minlength="5" required></textarea></label><div><button class="primary" type="submit">Add update</button></div></form></div>
    <div class="card"><h3>Timeline</h3><p class="muted">Use the update form to add to the timeline. Full history is kept in the audit log.</p></div>`;
  $('#upd').onsubmit = async e => { e.preventDefault(); try { await api('POST', '/api/admin/incidents/' + encodeURIComponent(id) + '/updates', Object.fromEntries(new FormData(e.target))); toast('Update recorded'); viewIncidentDetail(id); } catch (err) { toast(err.message); } };
  bindGo($('#main'));
}
async function viewPrivacy() {
  crumbs([['Privacy requests']]);
  const rows = await api('GET', '/api/privacy/requests');
  $('#main').innerHTML = `<p class="muted">Access, correction, deletion and opt-out requests. Resolving a deletion removes the matching contacts and suppresses the address everywhere.</p>
    <div class="card scroll"><table><tr><th>Type</th><th>Email</th><th>Status</th><th>Due</th><th>Overdue</th><th></th></tr>
    ${rows.map(r => { const overdue = r.status !== 'resolved' && r.dueBy && Date.now() > Date.parse(r.dueBy); return `<tr><td>${esc(r.type)}</td><td>${esc(r.email)}</td><td>${esc(r.status)}</td><td>${fmt(r.dueBy)}</td><td>${overdue ? '<span class="warn">overdue</span>' : '—'}</td><td>${r.status !== 'resolved' ? `<button data-res="${esc(r.id)}" class="primary">Resolve</button>` : `resolved ${fmt(r.resolvedAt)}`}</td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">No requests.</td></tr>'}</table></div>`;
  document.querySelectorAll('[data-res]').forEach(b => b.onclick = async () => { try { await api('POST', '/api/privacy/requests/' + encodeURIComponent(b.dataset.res) + '/resolve', {}); toast('Request resolved'); viewPrivacy(); } catch (err) { toast(err.message); } });
  bindGo($('#main'));
}
async function viewJobs() {
  crumbs([['Jobs, integrations, backups']]);
  const [j, h] = await Promise.all([api('GET', '/api/admin/jobs-overview'), api('GET', '/api/admin/health')]);
  $('#main').innerHTML = `<h3>Health center</h3><p class="muted">Each check is measured or labelled. "Not connected" and "unmeasured" are stated, never shown as healthy.</p>
    <div class="card scroll"><table><tr><th>Check</th><th>State</th><th>Detail</th></tr>${h.checks.map(c => `<tr><td>${esc(c.label)}</td><td>${esc(c.state.replace('_', ' '))}</td><td class="muted">${esc(c.detail)}</td></tr>`).join('')}</table></div>
    <h3>Data source runs</h3><div class="card scroll"><table><tr><th>Source</th><th>Enabled</th><th>Last success</th><th>Last error</th></tr>
    ${j.integrations.map(s => `<tr><td>${esc(s.name)}</td><td>${s.enabled ? 'yes' : 'no'}</td><td>${fmt(s.lastSuccessAt)}</td><td class="muted">${esc(s.lastError || '—')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No sources.</td></tr>'}</table></div>
    <h3>Recent jobs</h3><div class="card scroll"><table><tr><th>When</th><th>Type</th><th>Status</th><th>Detail</th></tr>
    ${j.recent.map(x => `<tr><td>${fmt(x.createdAt)}</td><td>${esc(x.type || '—')}</td><td>${esc(x.status || '—')}</td><td class="muted">${esc(x.error || x.summary ? JSON.stringify(x.summary || x.error) : '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No jobs recorded.</td></tr>'}</table></div>
    <p class="muted">${esc(j.lastBackupNote || ('Last backup: ' + fmt(j.lastBackup?.at)))}</p>`;
  bindGo($('#main'));
}
async function viewExports() {
  crumbs([['Scoped exports']]);
  const r = await api('GET', '/api/admin/exports');
  $('#main').innerHTML = `<p class="muted">Exports are limited to the data you are allowed to see, need a reason, expire after 24 hours, and can only be downloaded by the person who made them.</p>
    <div class="card"><form id="mkexp" class="grid2">
      <label>Dataset <select name="dataset"><option value="companies">Companies (no contact details, no notes)</option><option value="support_cases">Support cases (metadata only)</option><option value="audit_recent">Audit log (latest 1,000)</option></select></label>
      <label>Reason (required) <input name="reason" minlength="5" required></label><div><button class="primary" type="submit">Create export</button></div></form>
      <div id="tok"></div></div>
    <div class="card scroll"><table><tr><th>Dataset</th><th>Rows</th><th>Created</th><th>Expires</th><th></th></tr>
    ${r.items.map(e => `<tr><td>${esc(e.label)}</td><td>${e.rowCount}</td><td>${fmt(e.createdAt)}</td><td>${e.expired ? '<span class="warn">expired</span>' : fmt(e.expiresAt)}</td><td class="muted">${e.expired ? '' : 'download needs its token'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No exports yet.</td></tr>'}</table></div>`;
  $('#mkexp').onsubmit = async e => { e.preventDefault();
    try { const x = await api('POST', '/api/admin/exports', Object.fromEntries(new FormData(e.target)));
      $('#tok').innerHTML = `<p><strong>Export ready: ${x.export.rowCount} rows.</strong> Download token (shown once):</p><div class="keybox">${esc(x.token)}</div>
        <p><button id="dl" class="primary">Download CSV</button></p>`;
      $('#dl').onclick = async () => { try { const res = await fetch('/api/admin/exports/' + encodeURIComponent(x.export.id) + '/download?token=' + encodeURIComponent(x.token), { headers: { authorization: 'Bearer ' + TOKEN } }); if (!res.ok) throw new Error((await res.json()).error); const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${x.export.dataset}.csv`; a.click(); toast('Download started'); } catch (err) { toast(err.message); } };
    } catch (err) { toast(err.message); } };
  bindGo($('#main'));
}
async function viewAudit(_, q) {
  crumbs([['Audit log']]);
  const r = await api('GET', '/api/admin/audit?' + q);
  $('#main').innerHTML = filterForm([['actor', 'Actor email'], ['action', 'Action (prefix, e.g. admin.)'], ['target', 'Target ID'], ['requestId', 'Request ID'], ['outcome', 'Outcome', ['success', 'denied']]], q, 'audit') +
    `<div class="card scroll"><p class="muted">Append-only: entries cannot be edited or deleted. Secrets are redacted.</p><table><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th><th>Detail</th></tr>${r.items.map(a => `<tr><td>${fmt(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td><small>${esc(a.target || '')}</small></td><td>${a.detail?.outcome ? statusPill(a.detail.outcome === 'denied' ? 'rejected' : 'active').replace(/>[^<]+</, '>' + esc(a.detail.outcome) + '<') : ''}</td><td><small>${esc(a.detail?.reason || '')}${a.detail?.requestId ? '<br>request ' + esc(a.detail.requestId.slice(0, 8)) : ''}</small></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No entries match.</td></tr>'}</table>${pager(r, 'audit', q)}</div>`;
  bindFilter('audit'); bindGo($('#main'));
}
// ---------- Phase 3: projects, duplicates, markets, packages, documents ----------
const money = v => v == null ? '—' : '$' + Number(v).toLocaleString();
async function viewProjects(_, q) {
  crumbs([['Projects']]); if (!q.get('sort')) q.set('sort', 'newest');
  const r = await api('GET', '/api/admin/projects?' + q);
  $('#main').innerHTML = filterForm([['q', 'Name, address or BI- id'], ['source', 'Permit number'], ['state', 'State (2 letters)'], ['phase', 'Phase', ['planning', 'design', 'permitting', 'bidding', 'construction', 'closeout']], ['status', 'Status', ['active', 'stale', 'invalid']], ['sort', 'Sort', ['newest', 'name', 'value', 'permits']]], q, 'projects') +
    `<div class="card scroll"><table><tr><th>Project</th><th>Location</th><th>Phase</th><th>Status</th><th>Permits</th><th>Packages</th><th>Est. value</th></tr>${r.items.map(p => `<tr><td><a href="#/project/${p.id}">${esc(p.name)}</a><br><small class="muted">${esc(p.id)}${p.corrected ? ' · corrected' : ''}</small></td><td>${esc(p.address || '')}<br><small>${esc(p.city || '')}, ${esc(p.state || '')}</small></td><td>${esc(p.phase)}</td><td>${statusPill(p.status === 'active' ? 'active' : p.status === 'stale' ? 'pending' : 'rejected').replace(/>[^<]+</, '>' + esc(p.status) + '<')}</td><td>${p.permits}${p.landUse ? ' + ' + p.landUse + ' land use' : ''}</td><td>${p.packages}${p.openPackages ? ' (' + p.openPackages + ' open)' : ''}</td><td>${money(p.estValue)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No projects match.</td></tr>'}</table>${pager(r, 'projects', q)}</div>`;
  bindFilter('projects'); bindGo($('#main'));
}
async function viewProject(parts) {
  const p = await api('GET', '/api/admin/projects/' + encodeURIComponent(parts[1]));
  crumbs([['Projects', 'projects'], [p.name]]);
  const mayFix = can('admin.project.correct'), mayMerge = can('admin.project.merge');
  $('#main').innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(p.name)}</h2><span><span class="pill">${esc(p.phase)}</span> <span class="pill ${p.status === 'active' ? 'green' : 'amber'}">${esc(p.status)}</span></span></div>
    <p class="muted">${esc(p.id)} · ${esc(p.address || '')}, ${esc(p.city || '')}, ${esc(p.state || '')}${p.aliases.length ? ' · also known as ' + esc(p.aliases.join(', ')) : ''}${p.statusReason ? ' · ' + esc(p.statusReason) : ''}</p>
    ${mayFix ? `<div class="row"><button id="pfix">Correct a field</button><button id="pstat">Change status</button></div>` : ''}</div>
    <div class="card scroll"><h3>Permits (source records — never edited here)</h3><table><tr>${mayMerge ? '<th></th>' : ''}<th>Permit</th><th>Status</th><th>Description</th><th>Value</th><th>Linked by</th></tr>${p.permits.map(x => `<tr>${mayMerge ? `<td><input type="checkbox" class="splitpick" value="permit:${esc(x.id)}" aria-label="Select ${esc(x.permitId)}"></td>` : ''}<td>${x.sourceUrl ? `<a href="${esc(x.sourceUrl)}" target="_blank" rel="noopener">${esc(x.permitId)}</a>` : esc(x.permitId)}</td><td>${esc(x.status)}</td><td>${esc(String(x.description || '').slice(0, 90))}</td><td>${money(x.valuation)}</td><td><small>${esc(x.linkMethod)} · ${esc(x.confidence)}</small></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No permits.</td></tr>'}</table>
      ${mayMerge && p.permits.length > 1 ? '<button id="psplit" style="margin-top:8px">Split selected permits into a new project</button>' : ''}</div>
    ${p.landUse.length ? `<div class="card"><h3>Land-use filings</h3>${p.landUse.map(x => `<div>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.file || x.id)}</a>` : esc(x.file || x.id)} — ${esc(x.title)}</div>`).join('')}</div>` : ''}
    <div class="card scroll"><h3>Bid packages</h3><table><tr><th>Package</th><th>Publisher</th><th>Status</th><th>Invited</th><th>Bids</th></tr>${p.packages.map(k => `<tr><td><a href="#/package/${k.id}">${esc(k.title)}</a></td><td>${esc(k.publisher)}</td><td>${esc(k.status)}</td><td>${k.invited}</td><td>${k.bids}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None.</td></tr>'}</table></div>
    <div class="card"><h3>Team (with evidence)</h3>${p.companies.map(c => `<div>${esc(c.name)} <small class="muted">${esc(c.role.replace(/_/g, ' '))} · ${c.verified ? 'verified' : 'named'} · ${esc(c.method)} · ${c.evidence} source(s)</small></div>`).join('') || '<p class="muted">None.</p>'}
      <h3>Phase history</h3>${p.phases.map(h => `<div><small>${esc(h.phase)} · ${fmt(h.startedAt)}${h.endedAt ? ' → ' + fmt(h.endedAt) : ' → now'}</small></div>`).join('')}
      <h3>Corrections</h3>${p.corrections.map(c => `<div><small>${fmt(c.at)} · ${esc(c.by)}: ${esc(c.field)} “${esc(c.from)}” → “${esc(c.to)}” — ${esc(c.reason)}</small></div>`).join('') || '<p class="muted">None — values are as derived from the sources.</p>'}</div>`;
  const reload = () => viewProject(parts);
  $('#pfix')?.addEventListener('click', async () => { if (await act('Correct a project field', 'The original value is kept in the correction history. Source permits are not changed.', `/api/admin/projects/${encodeURIComponent(p.id)}/resolve`, { action: 'correct' },
    { extra: '<label>Field <select name="field"><option value="name">Project name</option><option value="projectType">Project type</option></select></label><br><label>New value<br><input name="value" style="width:100%"></label><br>' })) reload(); });
  $('#pstat')?.addEventListener('click', async () => { if (await act('Change project status', 'Stale or invalid projects stay on record with the reason.', `/api/admin/projects/${encodeURIComponent(p.id)}/resolve`, { action: 'status' },
    { extra: '<label>Status <select name="status"><option>stale</option><option>invalid</option><option>active</option></select></label><br>' })) reload(); });
  $('#psplit')?.addEventListener('click', async () => { const linkIds = [...document.querySelectorAll('.splitpick:checked')].map(x => x.value);
    if (!linkIds.length) return alert('Select the permits to move first.');
    const out = await act('Split into a new project', `${linkIds.length} permit(s) move to a new project. Requires password confirmation.`, `/api/admin/projects/${encodeURIComponent(p.id)}/split`, { linkIds }, { danger: true });
    if (out) go('project/' + out.projectId); });
}
async function viewDuplicates(_, q) {
  crumbs([['Duplicate review']]);
  const r = await api('GET', '/api/admin/duplicates?' + q);
  $('#main').innerHTML = `<p class="muted">Records that could belong to more than one project, and projects that look like the same site. Nothing merges automatically.</p>` + (r.items.map((x, i) => `<div class="card"><b>${x.type === 'ambiguous_link' ? 'Ambiguous: ' + esc(x.record) : 'Likely duplicate'}</b> <small class="muted">${esc(x.reason)}</small>
    <table><tr><th>${x.type === 'ambiguous_link' ? 'Link to' : 'Keep'}</th><th>Project</th><th>Location</th><th>Permits</th><th>Packages</th></tr>${x.projects.map(p => `<tr><td><input type="radio" name="k${i}" value="${esc(p.id)}" aria-label="Choose ${esc(p.name)}"></td><td><a href="#/project/${p.id}">${esc(p.name)}</a><br><small class="muted">${esc(p.id)}</small></td><td>${esc(p.address || '')}, ${esc(p.city || '')}</td><td>${p.permits}</td><td>${p.packages}</td></tr>`).join('')}</table>
    ${x.type === 'ambiguous_link' ? (can('admin.project.correct') ? `<button data-res="${esc(x.reviewId)}" data-i="${i}">Link to the selected project</button>` : '') : (can('admin.project.merge') ? `<button data-merge="${i}" data-ids="${esc(x.projects.map(p => p.id).join(','))}">Preview merge into the selected project</button><div id="pv${i}"></div>` : '')}</div>`).join('') || '<div class="card muted">Nothing to review.</div>');
  document.querySelectorAll('[data-res]').forEach(b => b.onclick = async () => { const pick = document.querySelector(`input[name=k${b.dataset.i}]:checked`); if (!pick) return alert('Select a project first.');
    if (await act('Link record to project', 'Record why this is the right project.', `/api/admin/review/${encodeURIComponent(b.dataset.res)}/resolve`, { projectId: pick.value })) viewDuplicates(_, q); });
  document.querySelectorAll('[data-merge]').forEach(b => b.onclick = async () => { const i = b.dataset.merge, pick = document.querySelector(`input[name=k${i}]:checked`); if (!pick) return alert('Select the project to keep first.');
    const keep = pick.value, drops = b.dataset.ids.split(',').filter(id => id !== keep);
    const previews = await Promise.all(drops.map(d => api('GET', `/api/admin/merge-preview?keep=${encodeURIComponent(keep)}&drop=${encodeURIComponent(d)}`)));
    $('#pv' + i).innerHTML = previews.map(pv => `<div class="card"><b>Merge ${esc(pv.drop.id)} into ${esc(pv.keep.id)}</b><div>Moves: ${Object.entries(pv.moves).map(([k, n]) => `${n} ${esc(k)}`).join(', ')}</div><ul>${pv.effects.map(e => `<li><small>${esc(e)}</small></li>`).join('')}</ul>
      <button class="danger" data-domerge="${esc(pv.drop.id)}" data-keep="${esc(keep)}">Merge (requires password)</button></div>`).join('');
    $('#pv' + i).querySelectorAll('[data-domerge]').forEach(m => m.onclick = async () => { if (await act('Merge projects', 'The merged-away ID keeps resolving. A wrong merge is undone with a split.', '/api/admin/projects-merge', { keepId: m.dataset.keep, dropId: m.dataset.domerge }, { danger: true })) go('project/' + m.dataset.keep); }); });
}
async function viewMarkets() {
  crumbs([['Trades & markets']]); const m = await api('GET', '/api/admin/markets');
  $('#main').innerHTML = `<p class="muted">Counts from stored records as of ${fmt(m.asOf)}. Project counts are records BUILDINTEL holds — not total market coverage.</p><div class="row" style="align-items:flex-start">
    <div class="card scroll" style="flex:1;min-width:260px"><h3>Trades (subscriber companies)</h3><table><tr><th>Trade</th><th>Companies</th></tr>${m.trades.map(t => `<tr><td>${esc(t.trade)}</td><td>${t.companies}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">None.</td></tr>'}</table></div>
    <div class="card scroll" style="flex:1;min-width:260px"><h3>Markets (states)</h3><table><tr><th>State</th><th>Subscriber companies</th><th>Projects held</th></tr>${m.markets.map(x => `<tr><td>${esc(x.state)}</td><td>${x.subscriberCompanies}</td><td>${x.projects}</td></tr>`).join('')}</table></div></div>`;
}
async function viewPackages(_, q) {
  crumbs([['Bid packages & bids']]); if (!q.get('sort')) q.set('sort', 'newest');
  const r = await api('GET', '/api/admin/packages?' + q);
  $('#main').innerHTML = filterForm([['q', 'Package, publisher or id'], ['status', 'Status', ['draft', 'open', 'closed', 'awarded']], ['sort', 'Sort', ['newest', 'due', 'bids']]], q, 'packages') +
    `<div class="card scroll"><table><tr><th>Package</th><th>Publisher</th><th>Status</th><th>Due</th><th>Invited</th><th>Opened plans</th><th>Will bid</th><th>Bids</th><th>Late</th></tr>${r.items.map(k => `<tr><td><a href="#/package/${k.id}">${esc(k.title)}</a></td><td>${esc(k.publisher)}</td><td>${esc(k.status)}</td><td>${esc(k.dueDate)}</td><td>${k.invited}</td><td>${k.opened}</td><td>${k.willBid}</td><td>${k.bids}</td><td>${k.late || ''}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No packages match.</td></tr>'}</table>${pager(r, 'packages', q)}</div>`;
  bindFilter('packages'); bindGo($('#main'));
}
async function viewPackage(parts) {
  const k = await api('GET', '/api/admin/packages/' + parts[1]); crumbs([['Bid packages & bids', 'packages'], [k.title]]);
  const mayRevoke = can('admin.document.access.revoke');
  const revoked = new Set((await api('GET', '/api/admin/documents/' + (k.documents[0]?.id || '_none')).catch(() => ({ canView: [] }))).canView.filter(x => /REVOKED/.test(x.basis)).map(x => x.orgId));
  $('#main').innerHTML = `<div class="card"><h2 style="margin-top:0">${esc(k.title)}</h2><p class="muted">${esc(k.publisher)} · ${esc(k.status)} · due ${esc(k.dueDate)} · ${esc(k.distribution)}${k.projectId ? ` · project <a href="#/project/${k.projectId}">${esc(k.projectId)}</a>` : ''}</p>
    ${k.award ? `<p><b>Awarded</b> to ${esc(k.award.company)} · ${money(k.award.total)} · signed ${fmt(k.award.signedAt)}${k.award.signer ? ' by ' + esc(k.award.signer) : ''}</p>` : ''}</div>
    <div class="card scroll"><h3>Invitations</h3><table><tr><th>Company</th><th>Intent</th><th>Invited</th><th>Opened plans</th><th>Plan access</th></tr>${k.invitations.map(i => `<tr><td>${esc(i.company)}</td><td>${esc(i.intent)}</td><td>${fmt(i.invitedAt)}</td><td>${fmt(i.viewedAt)}</td>
      <td>${revoked.has(i.orgId) ? '<span class="pill red">revoked</span>' : '<span class="pill green">allowed</span>'} ${mayRevoke && k.documents.length ? `<button data-acc="${esc(i.orgId)}" data-rev="${!revoked.has(i.orgId)}">${revoked.has(i.orgId) ? 'Restore' : 'Revoke'}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No invitations.</td></tr>'}</table></div>
    <div class="card scroll"><h3>Bids (as submitted — read-only)</h3><table><tr><th>Company</th><th>Amount</th><th>Submitted</th><th>Receipt</th><th>Fingerprint</th></tr>${k.submissions.map(b => `<tr><td>${esc(b.company)}</td><td>${money(b.amount)}</td><td>${fmt(b.submittedAt)} ${b.late ? '<span class="pill red">late</span>' : ''}</td><td>${esc(b.receipt || '—')}</td><td><small><code>${esc(String(b.sha256 || '').slice(0, 16))}</code></small></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No bids yet.</td></tr>'}</table>
      <p class="muted">Bid amounts, files and times cannot be changed here.</p></div>
    <div class="card scroll"><h3>Documents</h3><table><tr><th>File</th><th>Revision</th><th>State</th></tr>${k.documents.map(d => `<tr><td><a href="#/document/${d.id}">${esc(d.name)}</a></td><td>${esc(d.revision)}</td><td>${esc(d.state)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No documents.</td></tr>'}</table></div>`;
  document.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => { const rv = b.dataset.rev === 'true';
    if (await act(rv ? 'Revoke plan access' : 'Restore plan access', rv ? 'The company can no longer open this package’s plans, including links already sent to them. Requires password confirmation.' : 'The company can open the plans again.', `/api/admin/packages/${k.id}/access`, { orgId: b.dataset.acc, revoke: rv }, { danger: rv })) viewPackage(parts); });
}
async function viewDocuments(_, q) {
  crumbs([['Plan-room documents']]); if (!q.get('sort')) q.set('sort', 'newest');
  const r = await api('GET', '/api/admin/documents?' + q);
  $('#main').innerHTML = filterForm([['q', 'File, package or publisher'], ['state', 'State', ['available', 'quarantined', 'removed']], ['sort', 'Sort', ['newest', 'name']]], q, 'documents') +
    `<div class="card scroll"><table><tr><th>File</th><th>Package</th><th>Revision</th><th>Size</th><th>State</th><th>Malware scan</th></tr>${r.items.map(d => `<tr><td><a href="#/document/${d.id}">${esc(d.name)}</a></td><td><a href="#/package/${d.packageId}">${esc(d.package || '')}</a><br><small class="muted">${esc(d.publisher || '')}</small></td><td>${esc(d.revision)}</td><td>${d.size ? Math.round(d.size / 1024) + ' KB' : '—'}</td><td>${esc(d.state)}</td><td><small>${esc(d.malwareScan)}</small></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No documents match.</td></tr>'}</table>${pager(r, 'documents', q)}</div>`;
  bindFilter('documents'); bindGo($('#main'));
}
async function viewDocument(parts) {
  const d = await api('GET', '/api/admin/documents/' + parts[1]); crumbs([['Plan-room documents', 'documents'], [d.name]]);
  $('#main').innerHTML = `<div class="card"><h2 style="margin-top:0">${esc(d.name)}</h2><table><tr><th>Package</th><td><a href="#/package/${d.packageId}">${esc(d.package || '')}</a></td></tr><tr><th>Revision</th><td>${esc(d.revision)}</td></tr><tr><th>State</th><td>${esc(d.state)}${d.quarantine ? ' — ' + esc(d.quarantine.reason) : ''}</td></tr>
    <tr><th>Fingerprint (SHA-256)</th><td><code>${esc(d.sha256 || '—')}</code></td></tr><tr><th>Validation</th><td>${esc(d.validation)}</td></tr><tr><th>Malware scan</th><td>${esc(d.malwareScan)}</td></tr><tr><th>Storage</th><td>${esc(d.storage)}</td></tr></table>
    ${can('admin.document.access.revoke') ? `<p>${d.state === 'quarantined' ? '<button id="drel" class="primary">Release from quarantine</button>' : '<button id="dq" class="danger">Quarantine file</button>'}</p>` : ''}</div>
    <div class="card scroll"><h3>Who can open it</h3><table><tr><th>Company</th><th>Basis</th></tr>${d.canView.map(x => `<tr><td>${esc(x.company)}</td><td>${esc(x.basis)}</td></tr>`).join('')}</table><p class="muted">${d.state === 'quarantined' ? 'Quarantined: nobody can open it until released.' : 'Checked again every time a link is opened.'}</p></div>`;
  $('#dq')?.addEventListener('click', async () => { if (await act('Quarantine file', 'Nobody — including the publisher — can open it until released. Requires password confirmation.', `/api/admin/documents/${d.id}/quarantine`, { quarantine: true }, { danger: true })) viewDocument(parts); });
  $('#drel')?.addEventListener('click', async () => { if (await act('Release file', 'Invited companies can open it again.', `/api/admin/documents/${d.id}/quarantine`, { quarantine: false })) viewDocument(parts); });
}
// ---------- mobile: tables become labeled cards ----------
function labelTables() { document.querySelectorAll('main table').forEach(t => { const heads = [...t.querySelectorAll('tr:first-child th')].map(h => h.textContent.trim());
  if (!heads.length) return; t.classList.add('cards-sm'); t.querySelectorAll('tr').forEach(tr => [...tr.children].forEach((c, i) => { if (c.tagName === 'TD' && heads[i]) c.dataset.label = heads[i]; })); }); }
// ---------- Phase 4: subscriptions, sources, AI; MFA ----------
async function viewSubscriptions(_, q) {
  crumbs([['Subscriptions']]); if (!q.get('sort')) q.set('sort', 'company');
  const r = await api('GET', '/api/admin/subscriptions?' + q), may = can('admin.billing.manage');
  $('#main').innerHTML = `<div class="card"><b>Revenue:</b> <span class="na" style="color:var(--warn)">${esc(r.revenue.unavailable)}</span> · Stripe: ${esc(r.stripe)}<br><small class="muted">Manual adjustments grant access only — they never record a payment.</small></div>` +
    filterForm([['q', 'Company'], ['line', 'Line', ['subscriber', 'publisher']], ['plan', 'Plan', r.catalog.filter(c => c.key !== 'internal').map(c => c.key)], ['sort', 'Sort', ['company', 'plan']]], q, 'subscriptions') +
    `<div class="card scroll"><table><tr><th>Company</th><th>Plan</th><th>Status</th><th>Access</th><th>Payment</th><th>Seats</th><th>AI today</th><th></th></tr>${r.items.map(x => `<tr><td><a href="#/company/${x.orgId}">${esc(x.company)}</a></td><td>${esc(x.planName)}${x.listPrice ? '<br><small class="muted">list $' + x.listPrice + '/mo (proposed)</small>' : ''}</td><td>${esc(x.status)}${x.trialEndsAt ? '<br><small>trial to ' + fmt(x.trialEndsAt) + '</small>' : ''}</td><td><small>${esc(x.access)}</small></td><td><small>${esc(x.paymentState)}</small></td><td>${esc(x.seats)}</td><td>${esc(x.aiToday)}</td>
      <td>${may ? `<button data-adj="${x.orgId}" data-line="${x.line}" data-trial="${x.plan === 'trial'}">Adjust</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">None.</td></tr>'}</table>${pager(r, 'subscriptions', q)}</div>
    <div class="card scroll"><h3>Plan catalog</h3><table><tr><th>Plan</th><th>Line</th><th>Monthly</th><th>Status</th></tr>${r.catalog.filter(c => c.key !== 'internal').map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.line)}</td><td>${c.monthly == null ? 'custom' : c.monthly ? '$' + c.monthly : 'free'}</td><td><small>${esc(c.priceStatus)}</small></td></tr>`).join('')}</table></div>`;
  bindFilter('subscriptions'); bindGo($('#main'));
  document.querySelectorAll('[data-adj]').forEach(b => b.onclick = async () => { const plans = r.catalog.filter(c => c.line === b.dataset.line && !['trial', 'internal'].includes(c.key));
    const out = await act('Manual subscription adjustment', 'Grants access only; no payment is recorded. Requires password confirmation.', `/api/admin/subscriptions/${b.dataset.adj}/adjust`, {},
      { extra: `<label>Action <select name="action"><option value="set_plan">Set plan (comp)</option>${b.dataset.trial === 'true' ? '<option value="extend_trial">Extend trial</option>' : ''}</select></label><br><label>Plan <select name="plan">${plans.map(c => `<option value="${c.key}">${esc(c.name)}</option>`).join('')}</select></label><br><label>Days (trial extension) <input name="days" type="number" min="1" max="60" value="14"></label><br>` });
    if (out) viewSubscriptions(_, q); });
}
async function viewSources(_, q) {
  crumbs([['Data sources']]); if (!q.get('sort')) q.set('sort', 'name');
  const r = await api('GET', '/api/admin/sources?' + q);
  $('#main').innerHTML = filterForm([['state', 'Show', ['running', 'paused', 'failing']], ['sort', 'Sort', ['name', 'freshness']]], q, 'sources') +
    `<div class="card scroll"><table><tr><th>Source</th><th>Jurisdiction</th><th>State</th><th>Terms review</th><th>Freshness</th><th>Records</th><th>Failed runs</th></tr>${r.items.map(x => `<tr><td><a href="#/source/${x.id}">${esc(x.name)}</a></td><td>${esc(x.jurisdiction)}</td><td>${x.enabled ? (x.lastError ? '<span class="pill red">failing</span>' : '<span class="pill green">running</span>') : '<span class="pill">paused</span>'}</td>
      <td>${x.authorized ? '<span class="pill green">complete</span>' : `<small>${esc(x.compliance.length)} item(s) missing</small>`}</td><td><small>${esc(x.freshness)}</small></td><td>${x.records.active}${x.records.archived ? ' <small>(+' + x.records.archived + ' archived)</small>' : ''}</td><td>${x.runs.failed} of ${x.runs.total}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">None.</td></tr>'}</table>${pager(r, 'sources', q)}</div>`;
  bindFilter('sources'); bindGo($('#main'));
}
async function viewSource(parts) {
  const x = await api('GET', '/api/admin/sources/' + parts[1]); crumbs([['Data sources', 'sources'], [x.name]]);
  $('#main').innerHTML = `<div class="card"><h2 style="margin-top:0">${esc(x.name)}</h2><table><tr><th>Jurisdiction</th><td>${esc(x.jurisdiction)}</td></tr><tr><th>State</th><td>${x.enabled ? 'running (' + esc(x.schedule) + ')' : 'paused'}</td></tr><tr><th>Freshness</th><td>${esc(x.freshness)} · newest record ${esc(x.lastRecordDate || '—')}</td></tr>
    <tr><th>Terms review</th><td>${x.authorized ? 'complete' + (x.authorization?.evidence ? ' — ' + esc(x.authorization.evidence) : '') : '<b>Cannot run until:</b><br>' + x.compliance.map(esc).join('<br>')}${x.termsUrl ? `<br><a href="${esc(x.termsUrl)}" target="_blank" rel="noopener">View terms</a>` : ''}</td></tr>
    <tr><th>Last error</th><td>${esc(x.lastError || '—')}</td></tr><tr><th>Last probe</th><td>${x.lastProbe ? fmt(x.lastProbe.at) + ' · source updated ' + esc(x.lastProbe.lastUpdated || '?') : '—'}</td></tr></table>
    <div class="row" style="margin-top:10px">${x.enabled ? '<button id="spause">Pause</button><button id="sretry" class="primary">Retry now</button>' : `<button id="sresume" class="primary" ${x.authorized ? '' : 'disabled title="Terms review incomplete"'}>Resume</button>`}<button id="sprobe">Probe</button><button id="sresync" class="danger">Resync (archive & re-pull)</button></div><p id="smsg" class="muted"></p></div>
    <div class="card scroll"><h3>Import history</h3><table><tr><th>When</th><th>Result</th><th>Received</th><th>New</th><th>Updated</th><th>Rejected</th><th>Error</th></tr>${x.importRuns.map(j => `<tr><td>${fmt(j.at)}</td><td>${j.status === 'ok' ? '<span class="pill green">ok</span>' : '<span class="pill red">failed</span>'}</td><td>${j.received ?? ''}</td><td>${j.inserted ?? ''}</td><td>${j.updated ?? ''}</td><td>${j.rejected ?? ''}</td><td><small>${esc(j.error || '')}</small></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No runs yet.</td></tr>'}</table></div>`;
  const reload = () => viewSource(parts);
  $('#spause')?.addEventListener('click', async () => { if (await act('Pause source', 'Stops hourly pulls until resumed.', `/api/admin/sources/${x.id}/enabled`, { enabled: false })) reload(); });
  $('#sresume')?.addEventListener('click', async () => { if (await act('Resume source', 'Hourly pulls start again.', `/api/admin/sources/${x.id}/enabled`, { enabled: true })) reload(); });
  $('#sretry')?.addEventListener('click', async () => { const out = await act('Retry now', 'Pulls this source once now and links new permits to projects.', `/api/admin/sources/${x.id}/retry`); if (out) { $('#smsg').textContent = out.result?.error ? 'Failed: ' + out.result.error : `Received ${out.result?.received ?? 0}, new ${out.result?.inserted ?? 0}, updated ${out.result?.updated ?? 0}; ${out.newProjects} new project(s).`; setTimeout(reload, 1500); } });
  $('#sprobe')?.addEventListener('click', async () => { $('#smsg').textContent = 'Probing…'; try { const r2 = await api('POST', `/api/admin/sources/${x.id}/probe`, {}); $('#smsg').textContent = `Reachable. Source last updated ${r2.lastUpdated || 'unknown'}${(r2.mappedFieldsMissing || []).length ? '; missing fields: ' + r2.mappedFieldsMissing.join(', ') : ''}.`; } catch (e) { $('#smsg').textContent = e.message; } });
  $('#sresync')?.addEventListener('click', async () => { if (await act('Resync source', 'Archives this source’s current records (kept, not deleted) and re-pulls from the beginning. Requires password confirmation.', `/api/admin/sources/${x.id}/resync`, {}, { danger: true })) reload(); });
}
async function viewAi(_, q) {
  crumbs([['AI usage & limits']]); if (!q.get('sort')) q.set('sort', 'month');
  const r = await api('GET', '/api/admin/ai/usage?' + q);
  $('#main').innerHTML = `<div class="card"><b>Provider:</b> ${esc(r.provider)} · <b>Cost:</b> <span style="color:var(--warn)">${esc(r.cost.unavailable)}</span><br><b>Accuracy:</b> <span style="color:var(--warn)">${esc(r.accuracy.unavailable)}</span><br><small class="muted">AI quantities stay suggestions until an estimator confirms them. Limits here can only lower a plan's allowance.</small></div>` +
    filterForm([['active', 'Only companies using AI', ['true']], ['sort', 'Sort', ['month', 'company']]], q, 'ai') +
    `<div class="card scroll"><table><tr><th>Company</th><th>Today</th><th>This month</th><th>Confirmed</th><th>Unconfirmed</th><th>Daily allowance</th><th></th></tr>${r.items.map(x => `<tr><td><a href="#/company/${x.orgId}">${esc(x.company)}</a></td><td>${x.today}</td><td>${x.thisMonth}</td><td>${x.confirmed}</td><td>${x.unconfirmed}</td><td>${x.allowance}${x.override != null ? ` <small>(limited from ${x.planAllowance})</small>` : ''}</td><td><button data-ail="${x.orgId}">Set limit</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">None.</td></tr>'}</table>${pager(r, 'ai', q)}</div>`;
  bindFilter('ai'); bindGo($('#main'));
  document.querySelectorAll('[data-ail]').forEach(b => b.onclick = async () => { if (await act('Set AI daily limit', 'Lower this company’s daily AI analyses below its plan (0 pauses AI). Leave empty to remove the limit.', `/api/admin/ai/${b.dataset.ail}/limit`, {}, { extra: '<label>Daily limit <input name="limit" type="number" min="0" max="1000"></label><br>' })) viewAi(_, q); });
}
async function viewSecurity() {
  crumbs([['My security']]);
  $('#main').innerHTML = `<div class="card"><h2 style="margin-top:0">Two-step sign-in (authenticator app)</h2>${ME.mfa === 'enabled' ? '<p><span class="pill green">On</span> Sign-in and sensitive actions ask for a 6-digit code. Lost your phone? Another administrator with security permission can reset it after confirming your identity.</p>'
    : `<p>Use an authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator). Once on, sign-in and sensitive actions ask for its 6-digit code.</p><button id="mfas" class="primary">Set up</button><div id="mfab"></div>`}</div>`;
  $('#mfas')?.addEventListener('click', async () => { const r = await api('POST', '/api/admin/mfa/setup', {});
    $('#mfab').innerHTML = `<p>In your app, add an account and enter this key (or open the setup link on your phone):</p><p><code style="font-size:16px;letter-spacing:2px">${esc(r.secret.replace(/(.{4})/g, '$1 ').trim())}</code></p><p><a href="${esc(r.uri)}">Setup link</a></p>
      <form id="mfae" class="row"><input name="code" inputmode="numeric" maxlength="6" placeholder="6-digit code" aria-label="Code from your app"><button class="primary">Turn on</button><span class="err" id="mfaerr"></span></form>`;
    $('#mfae').onsubmit = async ev => { ev.preventDefault(); try { await api('POST', '/api/admin/mfa/enable', { code: ev.target.code.value.trim() }); toast('Two-step sign-in is on.'); render(); } catch (e) { $('#mfaerr').textContent = e.message; } }; });
}
window.addEventListener('hashchange', render);
render();
