const $ = s => document.querySelector(s);
const srcLink = (u, text) => /^https?:\/\//i.test(String(u ?? '').trim()) ? `<a href="${esc(String(u).trim())}" target="_blank" rel="noopener">${esc(text)}</a>` : `<span title="No link published by the source">${esc(text)}</span>`;
const safeUrl = u => { const v = String(u ?? '').trim(); return /^https?:\/\//i.test(v) ? esc(v) : '#'; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Inline styles that depend on data cannot be written into HTML under a strict CSP.
// Render them as data-style and apply them through element.style once they are in the page.
const applyDataStyle = el => { el.style.cssText = el.getAttribute('data-style') || ''; el.removeAttribute('data-style'); };
new MutationObserver(muts => { for (const m of muts) for (const node of m.addedNodes) if (node.nodeType === 1) {
  if (node.hasAttribute('data-style')) applyDataStyle(node);
  node.querySelectorAll?.('[data-style]').forEach(applyDataStyle); } }).observe(document.body, { childList: true, subtree: true });
const usd = n => n == null ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US');
const money = n => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
let token = sessionStorage.getItem('bi_token'), me = null, tab = 'command', navKey = 'command', SUBVIEW = '';
let workspaceTabSet = false;   // the first screen after sign-in depends on the role (set once per session)
const CLOSED = new Set();
const PAGE_HEAD = {
  projects: ['Projects', 'Every commercial permit in your territory, grouped by job site. From city open-data records, refreshed hourly.', 'layers'],
  'projects:permits': ['Permits', 'Individual permits from city records. Filter by stage, building type, work type and value.', 'doc'],
  'projects:opps': ['Bid Opportunities', 'Projects that match your trades and are early enough to bid. Sort by start date to see what is coming up first.', 'brief'],
  planning: ['Planning & Development', 'Land-use applications and council actions that come before building permits. Many never become projects; treat them as early signals.', 'pin'],
  market: ['Market Activity', 'Construction activity counted from the permits BUILDINTEL has collected in your territory.', 'chart'],
  'market:analytics': ['Analytics & Forecasting', 'Trends from collected permits. Forecasts are not shown until a model is validated against history.', 'chart'],
  planroom: ['Plan Room', 'Drawings, specifications and addenda from bid packages you posted or were invited to. Viewable by the GC and invited bidders only.', 'file'],
  'planroom:drawing': ['Drawing Sets', 'Drawing sheets by discipline. Open, measure, or run AI analysis.', 'doc'],
  'planroom:specification': ['Specifications', 'Project manuals and specification sections from plan rooms.', 'file'],
  'planroom:addenda': ['Addenda & Revisions', 'Every file posted as an addendum. Bidders must acknowledge addenda before bidding.', 'clock'],
  'planroom:ai': ['AI Floor Plan Analyzer', 'Reads only what is printed on a sheet, cites the sheet for every item, and stays unverified until you confirm it.', 'spark'],
  contractors: ['Contractors (GCs)', 'Contractors named on permits in your territory, ranked by active work, with state license status where available.', 'users'],
  'contractors:dir': ['Company Directory', 'Every company named on permits in your territory.', 'users'],
  directory: ['Project Contacts', 'People at GCs, owners and architects, each with the source that confirms them. Names are never invented.', 'people'],
  'directory:gm': ['General Managers (GMs)', 'GMs appear only when a verified source lists them.', 'people'],
  invitations: ['Invitations to Bid', 'Bid requests from GCs and owners that match your trades and territory. Answer will-bid, review plans, and submit.', 'send'],
  'invitations:packages': ['Trade Packages', 'Bid packages by trade from GCs who invited you.', 'box'],
  'invitations:bids': ['Bid Management', 'Your invitations, bids, revisions and receipts in one place.', 'send'],
  searches: ['Saved Searches & Alerts', 'Saved filters send a daily email with new projects and stage changes.', 'bell'],
  tracked: ['Pipeline', 'Projects you follow, with your stage and notes. Stage changes on the permit are emailed to you.', 'star'],
  estimates: ['Takeoff & Estimating', 'Estimates from measured drawings, confirmed AI takeoffs, permit square footage or manual quantities.', 'calc'],
  'estimates:estimating': ['Estimating', 'Price quantities with labor, material, waste, overhead and profit. Totals are exact to the cent.', 'calc'],
  contracts: ['Awards & Contracts', 'Signed awards with the signer, consent, time and a fingerprint of the exact document.', 'award'],
  plan: ['Company Profile & Plan', 'Your trades decide which invitations you receive. Legal name and address are required to email GCs.', 'gear'],
  insurance: ['Insurance & Licenses', 'Certificates and licenses GCs see when they compare bids. "Verified" means confirmed with the carrier or state.', 'award'],
  rates: ['Pricing', 'Approved rate cards used for automatic cleaning prices.', 'money'],
  team: ['Team & Permissions', 'Who in your company can use BUILDINTEL and what each person may do. Seats come from your plan.', 'users'],
  subscription: ['Subscription Center', 'Your plan, what it includes, and what you have used. One subscription per company.', 'money'],
  publishers: ['Publisher Review', 'Companies asking to publish projects. Approve only after checking their evidence; record how you checked.', 'check'],
  coverage: ['Geographic Coverage', 'Exactly which jurisdictions BUILDINTEL collects from today, whether each feed is current, and how many records it holds. Coverage grows city by city; it is never implied.', 'us'],
  sources: ['Data Sources', 'Every data feed, its license evidence and status. Feeds only run after their terms are reviewed and recorded.', 'layers'],
  pipeline: ['Bids', 'Bids drafted, approved and sent by the autopilot.', 'send'], opps: ['Autopilot Opportunities', 'Scored opportunities the autopilot can price.', 'brief'],
  gaps: ['GCs to Add', 'Contractors with active projects but no verified contact yet.', 'users'], overview: ['Bid Analytics', 'Bid pipeline value, win rate and response times.', 'chart'],
};
const EXTRA_TABS = ['map', 'market', 'planroom', 'estimates', 'directory', 'contracts', 'invitations', 'insurance', 'coverage', 'team', 'subscription', 'rates'];

async function api(method, path, body) {
  const r = await fetch(path, {method, headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})}, body: body ? JSON.stringify(body) : undefined});
  if (r.status === 401) { token = null; sessionStorage.removeItem('bi_token'); render(); throw new Error('Sign in again'); }
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j;
}

function loginView() {
  $('#app').innerHTML = `<form class="login" id="lf"><h1>BUILDINTEL</h1><p>Sign in to run the bid desk.</p>
  <label for="e">Email</label><input id="e" type="email" autocomplete="username" required>
  <label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required>
  <div class="err" id="le"></div><button class="primary x-0ccf4e6b" >Sign in</button>
  <p class="x-86de7ac6" >New to BUILDINTEL? <a href="/get-started">Create an account. Tell us who you are first.</a></p></form>`;
  $('#lf').onsubmit = async ev => { ev.preventDefault();
    try { const r = await api('POST', '/api/login', {email: $('#e').value, password: $('#p').value}); token = r.token; sessionStorage.setItem('bi_token', token); render(); }
    catch (e) { $('#le').textContent = e.message; } };
}

function contractTable(cs, partyKey, partyLabel) {
  return `<div class="scroll"><table><tr><th>Project</th><th>${partyLabel}</th><th class="num">Amount</th><th>Signed</th><th></th></tr>${cs.map(c => `<tr><td>${esc(c.title)}<br><small>${esc(c.address)}</small></td><td>${esc(c[partyKey])}</td><td class="num">${money(c.total)}${c.recurring?'/mo':''}</td><td>${esc(c.signerName)}<br><small>${esc(c.signedAt.replace('T',' ').slice(0,16))} UTC</small></td><td><button data-doc="${c.id}">Open signed record</button></td></tr>`).join('')}</table></div>`;
}
function bindDocs() {
  document.querySelectorAll('[data-doc]').forEach(b => b.onclick = async () => { const r = await fetch(`/api/contracts/${b.dataset.doc}/document`, {headers: {Authorization: 'Bearer ' + token}}); const w = window.open(); w.document.write(await r.text()); });
}

const TYPES = ['office','retail','warehouse','industrial','multifamily','medical','education','hospitality','restaurant','institutional','mixed_use','other_commercial'];
const STAGE_LABEL = { applied: 'Permit applied', approved: 'Approved', issued: 'Permit issued', under_construction: 'Under construction', finaled: 'Completed', expired: 'Expired' };
let lastFilters = {};
let WORK = [];
const ago = iso => { if (!iso) return 'unknown'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const licBadge = l => !l ? '' : ` <small data-style="color:${l.active ? 'var(--pass)' : 'var(--fail)'}">· state license ${esc(l.number || '')} ${l.active ? 'active' : esc(String(l.status || 'not active').toLowerCase())}</small>`;
const workLabel = k => (WORK.find(w => w.key === k) || {}).label || k;


// ---------------- Command Center workspace (mirrors the BUILDINTEL design) ----------------
const TRADE_WORK = { roofing: ['roofing'], glazing: ['windows_glazing', 'exterior_facade'], waterproofing: ['roofing', 'exterior_facade', 'new_construction'],
  electrical: ['mep', 'new_construction', 'tenant_improvement'], plumbing: ['mep', 'new_construction', 'tenant_improvement'], hvac: ['mep', 'new_construction', 'tenant_improvement'],
  low_voltage: ['mep', 'new_construction', 'tenant_improvement'], fire_protection: ['fire_protection', 'new_construction'],
  drywall: ['interior_remodel', 'tenant_improvement', 'new_construction'], flooring: ['interior_remodel', 'tenant_improvement', 'new_construction'], painting: ['interior_remodel', 'tenant_improvement', 'new_construction', 'exterior_facade'],
  carpentry: ['new_construction', 'addition', 'tenant_improvement'], concrete: ['new_construction', 'addition', 'site_work'], masonry: ['new_construction', 'exterior_facade'], steel: ['new_construction', 'addition'],
  sitework: ['site_work', 'new_construction'], demolition: ['demolition'], paving: ['parking_paving', 'site_work'], landscaping: ['new_construction', 'site_work'],
  cleaning: ['new_construction', 'tenant_improvement', 'interior_remodel', 'addition'], janitorial: ['new_construction'], specialties: ['tenant_improvement', 'new_construction'], elevators: ['new_construction'],
  general_contracting: ['new_construction', 'addition', 'tenant_improvement', 'interior_remodel'] };
const TRADE_WINDOW = { roofing: 'Roofing', glazing: 'Windows', waterproofing: 'Roofing', electrical: 'Mechanical', plumbing: 'Mechanical', hvac: 'Mechanical', low_voltage: 'Mechanical', fire_protection: 'Mechanical',
  drywall: 'Drywall', flooring: 'Flooring', painting: 'Flooring', carpentry: 'Structure', concrete: 'Site work', masonry: 'Structure', steel: 'Structure', sitework: 'Site work', demolition: 'demolition',
  paving: 'Site work', landscaping: 'Site work', cleaning: 'cleaning', janitorial: 'janitorial', specialties: 'Flooring', elevators: 'Mechanical', general_contracting: 'Site work' };
const CC = { sel: null, seg: 'map', f: {}, centerTab: 'overview', myTrades: null, sheet: null };
const daysTo = d => d ? Math.ceil((Date.parse(d) - Date.now()) / 864e5) : null;
const usdShort = n => n == null ? '—' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M' : n >= 1e4 ? '$' + Math.round(n / 1e3) + 'K' : usd(n);
const fmtDate = d => { if (!d) return '—'; const x = new Date(String(d).length === 10 ? d + 'T12:00:00' : d); return isNaN(x) ? esc(d) : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
// Original building illustration (no stock photos: permit records don't include pictures).
const TYPE_TINT = { office: '#6d8fc7', retail: '#c79a6d', warehouse: '#8a8f99', industrial: '#7d8a7a', multifamily: '#b9826f', medical: '#6fa8a3', education: '#c4a55b', hospitality: '#9a7fb8', restaurant: '#c27c6a', institutional: '#8c7f6d', mixed_use: '#7a93b0' };
function bldg(type, big) {
  const c = TYPE_TINT[type] || '#7d95b8', fl = big ? 6 : 4, w = 120, h = 80;
  let win = ''; for (let r = 0; r < fl; r++) for (let x = 0; x < 6; x++) win += `<rect x="${38 + x * 8}" y="${16 + r * (48 / fl)}" width="5" height="${48 / fl - 3}" fill="#dfeaf8" opacity=".9"/>`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><linearGradient id="sky${type}${big ? 1 : 0}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe2f8"/><stop offset="1" stop-color="#eef5fc"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#sky${type}${big ? 1 : 0})"/><rect x="8" y="40" width="26" height="34" fill="${c}" opacity=".55"/><rect x="88" y="34" width="24" height="40" fill="${c}" opacity=".5"/>
    <rect x="34" y="10" width="54" height="64" fill="${c}"/>${win}<rect x="56" y="62" width="10" height="12" fill="#2b3a4f" opacity=".6"/><rect x="0" y="73" width="${w}" height="7" fill="#9fb59a"/></svg>`;
}

async function commandWorkspace(body, mapFirst) {
  if (mapFirst) CC.seg = 'map';
  if (CC.myTrades === null) CC.myTrades = (await api('GET', '/api/profile').catch(() => ({ trades: [] }))).trades || [];
  if (!TRADES_LIST.length) TRADES_LIST = await (await fetch('/api/trades')).json().catch(() => []);
  if (!WORK.length) WORK = await api('GET', '/api/work-tags').catch(() => []);
  let k; try { k = await api('GET', '/api/command-center'); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const pct = k.newSitesPrevMonth ? Math.round(100 * (k.newSitesThisMonth - k.newSitesPrevMonth) / k.newSitesPrevMonth) : null;
  const delta = pct == null ? '' : `<span class="delta ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct)}%</span>`;
  const tile = (icon, bg, fg, v, label, extra = '') => `<div class="kpi"><span class="ic" data-style="background:${bg};color:${fg}">${ICON[icon]}</span><div><b>${v}</b><span>${label}${extra}</span></div></div>`;
  body.innerHTML = `<div class="kpis">
    ${tile('home', '#e0f2e9', '#15803d', k.activeSites.toLocaleString(), 'Active Projects')}
    ${tile('trend', '#fde8e8', '#dc2626', k.newSitesThisMonth.toLocaleString(), 'New This Month', delta)}
    ${tile('doc', '#e6efff', '#1f5fd1', k.bidRequestsWithPlans.toLocaleString(), 'With Drawings')}
    ${tile('clip', '#fff1df', '#c2410c', k.openBidRequests.toLocaleString(), 'Open for Bidding')}
    ${tile('money', '#e0f2e9', '#15803d', k.reportedValue ? usdShort(k.reportedValue) : '—', 'Total Construction Value')}
    <div class="kpi"><span class="ic x-ecf067bb" >${ICON.us}</span><div><b class="x-1444c6ea" >${k.coverage.length ? 'Live Coverage' : 'Coverage'}</b><span>${k.states} state(s) · ${k.coverage.length} jurisdiction(s)${k.coverage.length ? '<br>' + k.coverage.map(c => esc(c.city)).join(', ') : ''}</span></div></div></div>
    <div class="ws"><div class="card" id="cc-left"></div><div id="cc-center"></div><div class="rightcol" id="cc-right"></div></div>`;
  await drawLeft();
}

async function drawLeft() {
  const box = $('#cc-left'); const seg = CC.seg;
  box.innerHTML = `<h3 class="x-5351578d" >Project Discovery</h3><div class="seg">${[['search', 'Search'], ['map', 'Map'], ['saved', 'Saved'], ['alerts', 'Alerts']].map(([k2, l]) => `<button data-seg="${k2}" class="${seg === k2 ? 'on' : ''}">${l}</button>`).join('')}</div><div id="cc-seg"></div>`;
  box.querySelectorAll('[data-seg]').forEach(b => b.onclick = () => { CC.seg = b.dataset.seg; drawLeft(); });
  const el = $('#cc-seg');
  if (seg === 'search' || seg === 'map') {
    const f = CC.f;
    const fi = (icon, label, ctrl) => `<div class="fi">${ICON[icon]}<div><label>${label}</label>${ctrl}</div></div>`;
    el.innerHTML = `${seg === 'map' ? '<div class="mapbox x-f889cd2d" id="ccmap" ></div>' : ''}
      <form class="flt" id="ccf"><div class="row x-a562f4fd" ><strong>Filter Projects</strong><a href="#" id="ccreset" class="link x-11696618" >Reset</a></div>
      ${fi('pin', 'Location', `<input name="city" value="${esc(f.city || '')}" placeholder="Any city in your territory">`)}
      ${fi('building', 'Project Type', `<select name="type"><option value="">Commercial (All)</option>${TYPES.map(x => `<option ${f.type === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`)}
      ${fi('clock', 'Construction Stage', `<select name="stage"><option value="">All active stages</option>${Object.entries(STAGE_LABEL).filter(([s2]) => !['finaled', 'expired'].includes(s2)).map(([s2, l]) => `<option value="${s2}" ${f.stage === s2 ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${fi('money', 'Project Value', `<div class="two"><input name="minValue" type="number" min="0" placeholder="Min $" value="${esc(f.minValue || '')}"><input name="maxValue" type="number" min="0" placeholder="Max $" value="${esc(f.maxValue || '')}"></div>`)}
      ${fi('brief', 'Work Type', `<select name="work"><option value="">Any work</option>${WORK.map(w => `<option value="${w.key}" ${f.work === w.key ? 'selected' : ''}>${esc(w.label)}</option>`).join('')}</select>`)}
      ${fi('grid', 'Building Size', `<input name="minSqft" type="number" min="0" placeholder="Minimum SF" value="${esc(f.minSqft || '')}">`)}
      <button class="primary" id="ccgo">Search Projects</button></form><div id="ccres"></div>`;
    $('#ccreset').onclick = ev => { ev.preventDefault(); CC.f = {}; CC.sel = null; drawLeft(); };
    $('#ccf').onsubmit = ev => { ev.preventDefault(); CC.f = Object.fromEntries([...new FormData($('#ccf')).entries()].filter(([, v]) => v !== '')); CC.sel = null; drawLeft(); };
    const r = await api('GET', '/api/projects?' + new URLSearchParams({ ...CC.f, pageSize: 25, sort: 'newest' })).catch(e => ({ results: [], total: 0, error: e.message }));
    $('#ccgo').textContent = `Search Projects (${(r.total || 0).toLocaleString()})`;
    $('#ccres').innerHTML = `<div class="row x-d6fdc1ea" ><strong class="x-433de30b" >Results (${(r.total || 0).toLocaleString()})</strong><small>Sort: Newest</small></div>` +
      (r.results.length ? r.results.map(p => { const dd = daysTo(p.estimatedStart);
        return `<div class="res ${CC.sel === p.id ? 'on' : ''}" data-pick="${p.id}"><span class="thumb">${bldg(p.projectType)}</span><div class="x-3922d326" ><b>${esc(p.title).slice(0, 56)}</b>
        <small>${esc(p.city)}, ${esc(p.state)} • ${esc(String(p.projectType).replace('_', ' '))}</small>
        <small>${p.squareFeet ? p.squareFeet.toLocaleString() + ' SF • ' : ''}${p.combinedValue ? usd(p.combinedValue) : 'value not reported'}</small>
        ${p.estimatedStart ? `<small class="due">${dd != null && dd < 0 ? 'Started (est.)' : 'Est. start'}: ${fmtDate(p.estimatedStart)}</small>` : ''}<div class="x-c00d3912" >${marketPill(p.market)}</div></div></div>`; }).join('')
        : `<div class="empty">${esc(r.error || 'No projects match these filters.')}</div>`);
    $('#ccres').querySelectorAll('[data-pick]').forEach(d => d.onclick = () => select(d.dataset.pick));
    if (!CC.sel && r.results[0]) select(r.results[0].id); else if (CC.sel) select(CC.sel); else { $('#cc-center').innerHTML = ''; $('#cc-right').innerHTML = ''; }
    if (seg === 'map') {
      await loadLeaflet();
      if (!window.L) { $('#ccmap').innerHTML = '<div class="empty x-cc781baa" >Map could not load.</div>'; return; }
      const map = L.map('ccmap', { zoomControl: true, preferCanvas: true }); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(map);
      const mp = await api('GET', '/api/projects/map?' + new URLSearchParams(CC.f)).catch(() => ({ points: [] }));
      mp.points.forEach(pt => L.circleMarker([pt.lat, pt.lng], { radius: 7, color: '#fff', weight: 2, fillColor: pt.id === CC.sel ? '#f59e0b' : '#1f5fd1', fillOpacity: 1 }).on('click', () => select(pt.id)).bindTooltip(esc(pt.title)).addTo(map));
      if (mp.points.length) map.fitBounds(mp.points.map(pt => [pt.lat, pt.lng]), { padding: [16, 16], maxZoom: 13 }); else map.setView([39.5, -98.35], 4);
    }
    return;
  }
  if (seg === 'saved') {
    const ss = await api('GET', '/api/searches').catch(() => []);
    el.innerHTML = ss.length ? ss.map(x => `<div class="res" data-apply="${x.id}"><span class="thumb x-2149cc93" >${ICON.search}</span><div><b>${esc(x.name)}</b><small>${esc(Object.entries(x.filters).map(([a2, b2]) => a2 + ': ' + b2).join(' · ') || 'everything in your territory')}</small><small>Last check: ${x.lastHits ?? 0} new · ${ago(x.lastRunAt)}</small></div></div>`).join('')
      : '<div class="empty">No saved searches yet. Use Projects to save one and get daily alerts.</div>';
    el.querySelectorAll('[data-apply]').forEach(d => d.onclick = () => { CC.f = { ...ss.find(x => x.id === d.dataset.apply).filters }; CC.seg = 'map'; CC.sel = null; drawLeft(); });
    return;
  }
  const tr = await api('GET', '/api/tracked').catch(() => []);
  el.innerHTML = tr.length ? tr.map(x => `<div class="res" data-pick="${x.project.id}"><span class="thumb">${bldg('office')}</span><div><b>${esc(x.project.title)}</b><small>${esc(x.project.address)}, ${esc(x.project.city)}</small><small>You: ${esc(x.stage)} · ${STAGE_LABEL[x.project.stage] || ''}</small></div></div>`).join('')
    : '<div class="empty">Follow projects to get stage-change alerts here and by email.</div>';
  el.querySelectorAll('[data-pick]').forEach(d => d.onclick = () => select(d.dataset.pick));
}

async function select(id) {
  if (CC.sel !== id) CC.sheet = null;
  CC.sel = id; document.querySelectorAll('[data-pick]').forEach(d => d.classList.toggle('on', d.dataset.pick === id));
  let p; try { p = await api('GET', '/api/projects/' + id); } catch (e) { CC.p = null; $('#cc-center').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  // With core reads on, the detail carries the permanent project id and its anchor permit (estimates/tracking attach there).
  if (p.projectId && p.projectId !== id && location.hash === '#project/' + id) history.replaceState(null, '', '#project/' + p.projectId);
  const anchor = p.anchorPermitId || (String(p.id).startsWith('BI-') ? null : p.id);
  const est = anchor ? ((await api('GET', '/api/estimates?permitId=' + anchor).catch(() => []))[0] || null) : null;
  let core = null; try { const pid = p.projectId || (await api('GET', `/api/core/lookup?kind=permit&ref=${encodeURIComponent(id)}`)).projectId; core = await api('GET', '/api/core/projects/' + pid); } catch {}
  CC.p = p; CC.est = est; CC.core = core; drawCenter(); drawRight();
}

function marketPill(m) { if (!m) return ''; const cls = { open_for_bids: 'green', pre_bid: 'amber', awarded: '', bidding_closed: '', planning: 'amber', discovered: '' }[m.status] || '';
  return `<span class="pill ${cls}" title="${esc(m.explanation)}">${esc(m.label)}${m.status === 'open_for_bids' ? (m.canBid ? ' · you\'re invited' : ' · not invited') : ''}</span>`; }
function stagePill(s2) { return `<span class="pill ${['issued', 'approved', 'under_construction'].includes(s2) ? 'green' : s2 === 'applied' ? 'amber' : ''}">${STAGE_LABEL[s2] || esc(s2)}</span>`; }
const onProfile = () => location.hash.startsWith('#project/');
const myWindow = name => CC.myTrades.some(tr => TRADE_WINDOW[tr] && name.toLowerCase().includes(TRADE_WINDOW[tr].toLowerCase()));
const bidDue = p => (p.bidPackages || []).filter(b => b.status === 'open').map(b => b.dueDate).sort()[0] || null;

function drawCenter() {
  const p = CC.p, t2 = p.timeline, due = bidDue(p);
  const tabsDef = [['overview', 'Overview', 'grid'], ['drawings', `Drawings (${p.drawings.length})`, 'doc'], ['specs', 'Plans & Specs', 'file'], ['people', 'People / GC', 'people'], ['packages', `Bid Packages (${p.bidPackages.length})`, 'box'],
    ['takeoff', 'Takeoff', 'clip'], ['estimating', 'Estimating', 'calc'], ['bidding', 'Bidding', 'send'], ['updates', `Updates (${(p.statusHistory || []).length + (p.sitePermits || []).length})`, 'clock']];
  $('#cc-center').innerHTML = `<div class="card"><div class="hdr"><span class="thumb big">${bldg(p.projectType, true)}</span><div class="ttl x-3922d326" ><h2>${esc(p.title)} ${p.tracked ? '<span class="x-de368d40" >★</span>' : ''}</h2>
      <div class="x-ff3d3b53" >${esc(p.address)}, ${esc(p.city)}, ${esc(p.state)}</div>
      <div class="row"><span class="pill">${esc(String(p.projectType).replace('_', ' '))}</span>${(p.work || []).slice(0, 1).map(w => `<span class="pill">${esc(workLabel(w))}</span>`).join('')}${stagePill(p.stage)}${marketPill(p.market)}</div></div>
      <div class="stats x-fb874af5" ><div class="stat"><b>${p.valuation ? usd(p.valuation) : '—'}</b><span>${p.valuation ? 'Est. Construction Value' : 'Value not reported'}</span></div>
        <div class="stat"><b>${p.squareFeet ? p.squareFeet.toLocaleString() + ' SF' : '—'}</b><span>Building Size</span></div>
        <div class="stat"><b>${due ? fmtDate(due) : t2 ? fmtDate(t2.estimatedStart) : '—'}</b><span>${due ? `Bid Due (${daysTo(due)} days)` : 'Est. Start'}</span></div></div>
      <div class="row btns x-2aca6dad" ><button class="primary" id="ccfollow">${ICON.star} ${p.tracked ? 'Following' : 'Follow Project'}</button>${onProfile() ? '' : '<button id="ccopen" title="Open the full project page" aria-label="Open the full project page">⋮</button>'}</div></div>
      <div class="tabs">${tabsDef.map(([k2, l, ic]) => `<button data-ct="${k2}" class="${CC.centerTab === k2 ? 'on' : ''}">${ICON[ic]}${l}</button>`).join('')}</div><div id="cc-tab"></div></div>`;
  $('#ccopen')?.addEventListener('click', () => { tab = 'projects'; location.hash = '#project/' + p.id; render(); });
  $('#ccfollow').onclick = async () => { try { await api('POST', `/api/projects/${p.id}/track`, { stage: p.tracked || 'watching' }); select(p.id); } catch (e) { alertBox(esc(e.message)); } };
  document.querySelectorAll('[data-ct]').forEach(b => b.onclick = () => { CC.centerTab = b.dataset.ct; drawCenter(); });
  const el = $('#cc-tab'), ct = CC.centerTab;
  const role = re => p.contacts.find(c => re.test(c.role));
  const gc = role(/General contractor/), own = role(/Owner/), arch = role(/Architect/);
  const overviewTable = `<div class="panel"><h3>Project Overview</h3><p class="x-fea14485" >${esc(p.description || '')}</p><div class="kv x-6750b234" >
      <span>Project ID</span><b title="Permanent BUILDINTEL project ID">${CC.core ? esc(CC.core.id) : '—'}</b>${CC.core ? `<span>Phase</span><span class="x-caee463b" >${esc(CC.core.phase)}</span>` : ''}<span>Permit #</span><span class="x-7891572d" >${esc(p.permitId)}</span><span>Stage</span><span>${due ? '<span class="pill green">In Bidding</span>' : stagePill(p.stage)}</span>
      <span>Start (Est.)</span><span class="x-7891572d" >${t2 ? fmtDate(t2.estimatedStart) : '—'}</span><span>Completion (Est.)</span><span class="x-7891572d" >${t2 ? fmtDate(t2.estimatedCompletion) : '—'}</span>
      <span>Owner</span><span class="x-7891572d" >${esc(own?.name || '—')}</span><span>GC</span><span class="x-7891572d" >${esc(gc?.name || '—')}</span><span>Architect</span><span class="x-7891572d" >${esc(arch?.name || '—')}</span>
      <span>Source</span><span class="x-7891572d" >${srcLink(p.sourceUrl, p.sourceName || 'City record')} · checked ${ago(p.lastVerifiedAt)}${p.confidence ? ' · confidence ' + esc(p.confidence) : ''}</span></div>${p.sourceDisclaimer ? `<p class="x-c94d43e2" ><small><em>${esc(p.sourceDisclaimer)}</em></small></p>` : ''}
      ${onProfile() ? '' : '<a class="link" id="ccfull">View Full Project Profile →</a>'}</div>`;
  if (ct === 'overview') {
    el.innerHTML = `<div class="ov">${overviewTable}<div class="panel" id="viewer"></div></div>
      <div class="row3"><div class="panel"><h3>${ICON.people} Key Contacts <small class="x-7e3a9447" >(GC & project team)</small></h3>${contactsHtml(p, 4)}<a class="link" data-ct2="people">View All Contacts →</a></div>
        <div class="panel"><h3>${ICON.layers} AI Floor Plan Analysis</h3>${donutHtml(p)}<a class="link" data-ct2="takeoff">View Detailed Takeoff →</a></div>
        <div class="panel"><h3>${ICON.clock} Project Schedule</h3>${scheduleHtml(p)}<a class="link" data-ct2="updates">View Full Schedule →</a></div></div>`;
    drawViewer();
  } else if (ct === 'drawings') { el.innerHTML = '<div class="panel" id="viewer"></div>'; drawViewer(); }
  else if (ct === 'specs') { const sp = p.drawings.filter(d => d.kind === 'specification'); el.innerHTML = sp.length ? sp.map(d => `<div class="contact">${ICON.file}<a href="#" data-doc-open="${d.id}">${esc(d.title || d.name)}</a>${d.addendum ? ` <span class="pill amber">Addendum ${d.addendum}</span>` : ''}</div>`).join('') : `<div class="empty">No specifications yet. They appear here when the GC posts a bid package for this site with a project manual.</div>`; bindDocOpen(el); }
  else if (ct === 'people') { el.innerHTML = contactsHtml(p, 50, true) + `<small>${esc(p.contractorNote || '')}</small>`; bindEmail(el, p.id); }
  else if (ct === 'packages' || ct === 'bidding') el.innerHTML = p.bidPackages.length ? `<div class="scroll"><table><tr><th>Bid package</th><th>From</th><th>Trades</th><th>Due</th><th>Your status</th><th></th></tr>${p.bidPackages.map(b => `<tr><td>${esc(b.title)}${b.addendumCount ? ` <span class="pill amber">${b.addendumCount} addenda</span>` : ''}</td><td>${esc(b.buyerName)}</td><td><small>${esc((b.trades || []).map(k2 => (TRADES_LIST.find(x => x.key === k2) || {}).label || k2).join(', '))}</small></td><td class="${daysTo(b.dueDate) < 14 ? 'due' : ''}">${fmtDate(b.dueDate)}</td><td>${esc((b.intent || '—').replace('_', ' '))}</td><td>${b.invitationId ? '<button data-goinv="1">Open</button>' : ''}</td></tr>`).join('')}</table></div>` : `<div class="empty">No bid packages for this site yet. When a GC posts one and invites your trade, it shows here and in Invitations to Bid.</div>`;
  else if (ct === 'takeoff') el.innerHTML = p.analyses.length ? p.analyses.map(a => `<div class="panel x-fdf33f23" ><h3>Sheet ${esc(a.sheet || '?')} · confirmed takeoff</h3><div class="scroll"><table><tr><th>Room</th><th class="num">Area (SF)</th><th>Basis</th></tr>${a.rooms.map(r => `<tr><td>${esc([r.number, r.name].filter(Boolean).join(' '))}</td><td class="num">${r.areaSqFt ? r.areaSqFt.toLocaleString() : '—'}</td><td><small>${r.basis === 'printed' ? 'printed on sheet' : 'not stated'}</small></td></tr>`).join('')}</table></div></div>`).join('') : `<div class="empty">No confirmed takeoff yet. Takeoffs come from drawings: open a sheet in Drawings, run AI analysis, confirm it, then build the estimate.</div>`;
  else if (ct === 'estimating') el.innerHTML = CC.est ? `<div class="panel"><h3>${esc(CC.est.title)}</h3><p>Total <b>${money(CC.est.totals.total)}</b> · ${CC.est.lines.length} line(s) · ${esc(CC.est.status)}</p><div class="row"><button class="primary" id="ccest2">Open estimate</button><button id="ccprop2">Create proposal</button></div></div>` : `<div class="empty">No estimate yet. Use <b>Build Estimate</b> on the right.</div>`;
  else if (CC.core && ct === 'updates') {
    const c = CC.core, roleL = r => ({ general_contractor: 'General contractor', owner: 'Owner', developer: 'Developer', architect: 'Architect', trade_contractor: 'Trade contractor (awarded)' }[r] || r);
    el.innerHTML = `<div class="grid2"><div class="panel"><h3>${ICON.clock} Lifecycle — ${esc(c.id)}</h3><ul class="tl">${c.phases.map(h => `<li class="${h.endedAt ? 'done' : 'now'}"><span class="x-6fedee39" >${esc(h.phase)}</span><small>${fmtDate(h.startedAt)}${h.endedAt ? ' – ' + fmtDate(h.endedAt) : ' – now'}</small></li>`).join('')}</ul>
        <small>Phase comes from the linked records (land-use filings, permits, bid packages, awards).</small></div>
      <div class="panel"><h3>${ICON.users} Team (with sources)</h3>${c.companies.length ? c.companies.map(co => `<div class="contact x-2a1b75c9" ><b>${esc(co.name)}</b> <small>${esc(roleL(co.role))}</small> ${co.verified ? '<span class="pill green">verified</span>' : '<span class="pill">named</span>'}<br>
        <small>${co.evidence.map(e => `${esc(e.method)}${e.ref ? ' (' + esc(e.ref) + ')' : ''}${e.verified ? ' ✓' : ''}`).join(' · ')} · first seen ${fmtDate(co.firstSeenAt)}, last ${fmtDate(co.lastSeenAt)}</small></div>`).join('') : '<small>No companies linked yet.</small>'}</div></div>
      <div class="panel x-d6f2af6e" ><h3>${ICON.layers} Linked records</h3><div class="scroll"><table><tr><th>Record</th><th>Detail</th><th>How it was linked</th></tr>
        ${c.signals.map(x => `<tr><td>Land-use filing ${esc(x.file || '')}</td><td>${esc(String(x.title).slice(0, 90))}</td><td><small>address match</small></td></tr>`).join('')}
        ${c.permits.map(x => `<tr><td>Permit ${srcLink(x.sourceUrl, x.permitId)}</td><td>${esc(String(x.description || '').slice(0, 90))} · ${esc(x.status || '')}</td><td><small>${esc(x.linkMethod)} · ${esc(x.confidence)}</small></td></tr>`).join('')}
        ${c.bidPackages.map(x => `<tr><td>Bid package</td><td>${esc(x.title)} · due ${fmtDate(x.dueDate)}</td><td><small>address match</small></td></tr>`).join('')}
        ${c.documents.length ? `<tr><td>Plan-room files</td><td>${c.documents.length} file(s)</td><td><small>uploaded to a linked bid package</small></td></tr>` : ''}</table></div></div>`;
  }
  else el.innerHTML = `<ul class="tl">${(p.statusHistory || []).slice().reverse().map(h => `<li class="done"><span>Permit ${esc(h.status)}</span><small>${fmtDate(h.at)}</small></li>`).join('')}${(p.sitePermits || []).map(x => `<li><span><a href="#" data-sp="${x.id}">${esc(x.permitId)}</a> ${esc((x.description || '').slice(0, 70))}</span><small>${fmtDate(x.permitDate)}</small></li>`).join('')}</ul>`;
  el.querySelectorAll('[data-sp]').forEach(a2 => a2.onclick = ev => { ev.preventDefault(); select(a2.dataset.sp); });
  el.querySelectorAll('[data-ct2]').forEach(a2 => a2.onclick = () => { CC.centerTab = a2.dataset.ct2; drawCenter(); });
  el.querySelectorAll('[data-goinv]').forEach(b2 => b2.onclick = () => { tab = 'invitations'; render(); });
  $('#ccfull')?.addEventListener('click', () => $('#ccopen').click());
  $('#ccest2')?.addEventListener('click', () => openProjectEstimate());
  $('#ccprop2')?.addEventListener('click', () => openProposal(CC.est.id));
}

// ---------------- takeoff viewer: scale, measure, area, count, notes ----------------
const TK = { scaleByDoc: {} };
async function openTakeoff(docId, ctx = {}) {
  const lib = await loadPdfJs();
  const ov = document.createElement('div'); ov.className = 'tk'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Drawing takeoff');
  ov.innerHTML = '<div><div class="tkbar"><b>Loading sheet…</b></div><div></div><div></div></div>'; document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') { if (st.pts.length) { st.pts = []; drawShapes(); } else close(); } if (e.key === 'Enter') finish(); };
  document.addEventListener('keydown', onKey);
  if (!lib) { ov.firstChild.innerHTML = '<div class="tkbar"><b>Viewer unavailable.</b> <button id="tkx">Close</button></div>'; ov.querySelector('#tkx').onclick = close; return; }
  const scales = await api('GET', '/api/scales').catch(() => []);
  const link = await api('POST', `/api/documents/${docId}/link`);
  const pdf = await lib.getDocument({ isEvalSupported: false, data: await (await fetch(link.url)).arrayBuffer() }).promise;
  const st = { page: 1, zoom: 1, tool: 'select', pts: [], hover: null, list: [], picked: new Set(), calib: null, msg: '' };
  const meta = (await api('GET', '/api/documents').catch(() => [])).find(d => d.id === docId) || {};
  const load = async () => { st.list = await api('GET', `/api/documents/${docId}/measurements`); if (!TK.scaleByDoc[docId]) { const last = [...st.list].reverse().find(m => m.scale); if (last) TK.scaleByDoc[docId] = last.scale.preset ? { preset: last.scale.preset } : { calibration: last.scale.calibration }; } };
  await load();
  const scaleLabel = () => { const sc = TK.scaleByDoc[docId]; return !sc ? 'Scale not set' : sc.preset || `Calibrated (${sc.calibration.lengthFt} ft)`; };
  const toolBtn = (k, l) => `<button data-tool="${k}" class="${st.tool === k ? 'on' : ''}">${l}</button>`;
  const shell = () => {
    ov.firstChild.innerHTML = `<div class="tkbar"><b>${esc(meta.sheet ? meta.sheet + ' — ' + (meta.title || '') : meta.name || 'Sheet')}</b>
      <button id="tkpp">‹</button><span>Page ${st.page} of ${pdf.numPages}</span><button id="tkpn">›</button>
      <button id="tkzo">−</button><span>${Math.round(st.zoom * 100)}%</span><button id="tkzi">+</button>
      <select id="tksc" aria-label="Drawing scale"><option value="">${esc(scaleLabel())}</option>${scales.map(x => `<option>${esc(x)}</option>`).join('')}</select>
      ${toolBtn('calibrate', 'Calibrate')}${toolBtn('select', 'Select')}${toolBtn('linear', 'Measure')}${toolBtn('area', 'Area')}${toolBtn('count', 'Count')}${toolBtn('note', 'Note')}
      <button id="tkfin" class="primary" ${st.pts.length ? '' : 'disabled'}>Finish</button><span class="x-57f9e31d" id="tkmsg" >${esc(st.msg)}</span><button class="x-6d000617" id="tkx" >Close</button></div>
      <div class="tkmain"><div class="tkpage"><div class="tkwrap" id="tkwrap"><canvas id="tkc"></canvas><svg id="tks"></svg></div></div>
      <div class="tklist"><b>Measurements</b><div id="tkl"></div></div></div>
      <div class="tkfoot"><button class="primary" id="tkest">Add selected to estimate</button><small>Values are computed by the server from your points and the sheet scale. Points are stored in sheet units, so zoom never changes a result.</small></div>`;
    $('#tkx').onclick = close;
    $('#tkpp').onclick = () => { if (st.page > 1) { st.page--; st.pts = []; renderPage(); } };
    $('#tkpn').onclick = () => { if (st.page < pdf.numPages) { st.page++; st.pts = []; renderPage(); } };
    $('#tkzi').onclick = () => { st.zoom = Math.min(4, st.zoom * 1.25); renderPage(); };
    $('#tkzo').onclick = () => { st.zoom = Math.max(.25, st.zoom / 1.25); renderPage(); };
    $('#tksc').onchange = () => { if ($('#tksc').value) { TK.scaleByDoc[docId] = { preset: $('#tksc').value }; st.msg = 'Scale set to ' + $('#tksc').value; } shell(); renderPage(); };
    ov.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => { st.tool = b.dataset.tool; st.pts = []; st.msg = { calibrate: 'Click both ends of a known dimension.', linear: 'Click points along the run; double-click or Finish to save.', area: 'Click the corners; double-click or Finish to close the area.', count: 'Click each item; Finish to save the count.', note: 'Click where the note goes.', select: '' }[st.tool]; shell(); renderPage(); });
    $('#tkfin').onclick = finish;
    $('#tkest').onclick = async () => { if (!st.picked.size) { setMsg('Tick the measurements to include.'); return; }
      try { const e = await api('POST', '/api/estimates/measurements', { ids: [...st.picked], permitId: ctx.permitId || null }); close(); CC.openEst = e.id; tab = 'estimates'; navKey = 'estimates'; render(); } catch (err) { setMsg(err.message); } };
    drawList();
  };
  const setMsg = m => { st.msg = m; const el = $('#tkmsg'); if (el) el.textContent = m; };
  let rs = 1;
  const renderPage = async () => {
    if (!$('#tkc')) shell();
    const page = await pdf.getPage(st.page); rs = st.zoom * 1.2;
    const vp = page.getViewport({ scale: rs }); const c = $('#tkc'); c.width = vp.width; c.height = vp.height; c.style.width = vp.width + 'px'; c.style.height = vp.height + 'px';
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const svg = $('#tks'); svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
    const pt = ev => { const r = svg.getBoundingClientRect(); return [Math.round((ev.clientX - r.left) / rs * 100) / 100, Math.round((ev.clientY - r.top) / rs * 100) / 100]; };
    svg.onclick = ev => { if (st.tool === 'select') return; st.pts.push(pt(ev));
      if (st.tool === 'calibrate' && st.pts.length === 2) return askCalibration();
      if (st.tool === 'note') return askNote();
      $('#tkfin').disabled = false; drawShapes(); };
    svg.ondblclick = ev => { ev.preventDefault(); if (['linear', 'area'].includes(st.tool)) { st.pts.pop(); finish(); } };
    svg.onmousemove = ev => { if (st.pts.length && ['linear', 'area', 'calibrate'].includes(st.tool)) { st.hover = pt(ev); drawShapes(); } };
    drawShapes();
  };
  const P = p => `${p[0] * rs},${p[1] * rs}`;
  const drawShapes = () => {
    const svg = $('#tks'); if (!svg) return;
    let h = '';
    for (const m of st.list.filter(m => m.page === st.page)) {
      const pts = m.points.map(P).join(' '), sel = st.picked.has(m.id);
      const cx = m.points.reduce((n, p) => n + p[0], 0) / m.points.length * rs, cy = m.points.reduce((n, p) => n + p[1], 0) / m.points.length * rs;
      const tag = txt => `<text x="${cx}" y="${cy}" font-size="13" font-weight="700" text-anchor="middle" fill="#0b2545" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(txt)}</text>`;
      if (m.kind === 'area') h += `<polygon points="${pts}" fill="rgba(31,95,209,${sel ? .35 : .18})" stroke="#1f5fd1" stroke-width="2"/>` + tag(`${m.value.toLocaleString()} SF`);
      if (m.kind === 'linear') h += `<polyline points="${pts}" fill="none" stroke="#ea580c" stroke-width="${sel ? 4 : 3}"/>` + tag(`${m.value.toLocaleString()} LF`);
      if (m.kind === 'count') h += m.points.map((p, i) => `<circle cx="${p[0] * rs}" cy="${p[1] * rs}" r="8" fill="#16a34a"/><text x="${p[0] * rs}" y="${p[1] * rs + 4}" font-size="10" text-anchor="middle" fill="#fff">${i + 1}</text>`).join('');
      if (m.kind === 'note') h += `<circle cx="${m.points[0][0] * rs}" cy="${m.points[0][1] * rs}" r="6" fill="#f59e0b"/><text x="${m.points[0][0] * rs + 10}" y="${m.points[0][1] * rs + 4}" font-size="12" fill="#7c2d12" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(m.label)}</text>`;
    }
    const cur = st.hover && ['linear', 'area', 'calibrate'].includes(st.tool) ? [...st.pts, st.hover] : st.pts;
    if (cur.length) {
      if (st.tool === 'area') h += `<polygon points="${cur.map(P).join(' ')}" fill="rgba(245,158,11,.2)" stroke="#f59e0b" stroke-dasharray="6 4" stroke-width="2"/>`;
      else if (st.tool === 'count') h += cur.map(p => `<circle cx="${p[0] * rs}" cy="${p[1] * rs}" r="8" fill="#f59e0b"/>`).join('');
      else h += `<polyline points="${cur.map(P).join(' ')}" fill="none" stroke="#f59e0b" stroke-dasharray="6 4" stroke-width="3"/>`;
      h += st.pts.map(p => `<circle cx="${p[0] * rs}" cy="${p[1] * rs}" r="4" fill="#f59e0b"/>`).join('');
    }
    svg.innerHTML = h;
  };
  const drawList = () => {
    const el = $('#tkl'); if (!el) return;
    el.innerHTML = st.list.length ? st.list.map(m => `<div class="it">${m.kind === 'note' ? '<span></span>' : `<input class="x-30e741d9" type="checkbox" data-pick-m="${m.id}" ${st.picked.has(m.id) ? 'checked' : ''}  aria-label="Include in estimate">`}
      <span><b>${esc(m.label || { linear: 'Length', area: 'Area', count: 'Count', note: 'Note' }[m.kind])}</b><br><small>${m.value != null ? m.value.toLocaleString() + ' ' + m.unit : 'note'} · p.${m.page}${m.scale ? ' · ' + esc(m.scale.label) : ''}</small></span>
      <button data-del-m="${m.id}" title="Delete" aria-label="Delete">✕</button></div>`).join('') : '<small>Nothing measured yet. Set the scale, then pick a tool.</small>';
    el.querySelectorAll('[data-pick-m]').forEach(c => c.onchange = () => { c.checked ? st.picked.add(c.dataset.pickM) : st.picked.delete(c.dataset.pickM); drawShapes(); });
    el.querySelectorAll('[data-del-m]').forEach(b => b.onclick = async () => { await api('DELETE', `/api/measurements/${b.dataset.delM}`); st.picked.delete(b.dataset.delM); await load(); drawList(); drawShapes(); });
  };
  const inlineAsk = (label, ph, onOk) => { const bar = ov.querySelector('.tkbar'); const f = document.createElement('form'); f.className = 'row'; f.style.width = '100%';
    f.innerHTML = `<label class="x-eed0f8fb" >${label}</label><input class="x-55585d51" id="tkask" placeholder="${ph}" ><button class="primary">OK</button><button type="button" id="tkcancel">Cancel</button>`;
    bar.appendChild(f); $('#tkask').focus(); $('#tkcancel').onclick = () => { st.pts = []; f.remove(); drawShapes(); };
    f.onsubmit = async ev => { ev.preventDefault(); await onOk($('#tkask').value.trim()); }; };
  const askCalibration = () => { drawShapes(); inlineAsk('Real length between the two points (feet)', 'e.g. 24 or 24.5', async v => {
    const n = Number(v); if (!(n > 0)) { setMsg('Enter a length in feet.'); return; }
    TK.scaleByDoc[docId] = { calibration: { p1: st.pts[0], p2: st.pts[1], lengthFt: n } }; st.pts = []; st.tool = 'linear'; st.msg = `Calibrated: ${n} ft. Now measure.`; shell(); renderPage(); }); };
  const askNote = () => { drawShapes(); inlineAsk('Note', 'e.g. Verify floor transition at lobby', async v => { if (!v) return; await save({ kind: 'note', label: v }); }); };
  const askLabel = kind => inlineAsk('Label (optional)', { linear: 'e.g. Rubber base', area: 'e.g. Open office carpet', count: 'e.g. Light fixtures' }[kind], async v => { await save({ kind, label: v }); });
  const save = async extra => {
    try { await api('POST', `/api/documents/${docId}/measurements`, { page: st.page, points: st.pts, scale: TK.scaleByDoc[docId] || null, ...extra });
      st.pts = []; st.hover = null; st.msg = 'Saved.'; await load(); shell(); renderPage(); } catch (e) { setMsg(e.message); }
  };
  const finish = () => {
    if (!st.pts.length || !['linear', 'area', 'count'].includes(st.tool)) return;
    if (st.tool !== 'count' && !TK.scaleByDoc[docId]) { setMsg('Set the scale (or calibrate) first.'); return; }
    askLabel(st.tool);
  };
  shell(); renderPage();
}

let PDFJS = null;
async function loadPdfJs() {
  if (PDFJS) return PDFJS;
  // pdf.js 6.4.299 legacy build (works in older browsers), self-hosted (versions <= 4.7.76 could run code from a malicious PDF). Loaded as a module.
  try { const lib = await import('/vendor/pdf.min.mjs'); lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs'; PDFJS = lib; } catch (e) { console.error('viewer failed to load', e); }
  return PDFJS;
}
async function drawViewer() {
  const box = $('#viewer'); if (!box) return;
  const ds = CC.p.drawings.filter(d => d.kind === 'drawing');
  if (!ds.length) { box.innerHTML = `<h3>${ICON.doc} Drawing Viewer</h3><div class="viewer"><div class="sheets"><div class="sheet">—</div></div><div class="canvas x-f99822a5" >No authorized drawing set for this site yet.<br>Drawings appear here when a GC posts a bid package for this address and invites you.</div><div class="tools"><button disabled>Open sheet</button><button disabled>AI analysis</button><button disabled>Revisions</button></div></div>`; return; }
  const cur = ds.find(d => d.id === CC.sheet) || ds[0]; CC.sheet = cur.id; CC.zoom = CC.zoom || 1;
  box.innerHTML = `<h3>${ICON.doc} Drawing Viewer — ${esc(cur.sheet || '')} ${esc(cur.title || cur.name)}</h3>
    <div class="vbar"><select class="x-30e741d9" id="vsel" >${ds.map(d => `<option value="${d.id}" ${d.id === cur.id ? 'selected' : ''}>${esc(d.sheet ? d.sheet + ' – ' + (d.title || '') : d.name)}${d.addendum ? ' (Add. ' + d.addendum + ')' : ''}</option>`).join('')}</select><span>${ds.indexOf(cur) + 1} of ${ds.length}</span><button id="vzo">−</button><span id="vz">${Math.round(CC.zoom * 100)}%</span><button id="vzi">+</button></div>
    <div class="viewer"><div class="sheets">${ds.map(d => `<div class="sheet ${d.id === cur.id ? 'on' : ''}" data-sh="${d.id}">${ICON.doc}<br>${esc(d.sheet || d.name.slice(0, 8))}</div>`).join('')}</div>
      <div class="canvas" id="vcan"><small>Loading sheet…</small></div>
      <div class="tools"><button class="primary" data-measure="${cur.id}">${ICON.clip} Measure / takeoff</button><button data-doc-open="${cur.id}">${ICON.file} Open full sheet</button><button data-ai="${cur.id}">${ICON.spark} AI analysis</button><button id="vrev">${ICON.clock} Revisions</button></div></div><div id="ai-${cur.id}"></div>`;
  bindDocOpen(box);
  box.querySelectorAll('[data-sh]').forEach(x => x.onclick = () => { CC.sheet = x.dataset.sh; drawViewer(); });
  $('#vsel').onchange = () => { CC.sheet = $('#vsel').value; drawViewer(); };
  $('#vzi').onclick = () => { CC.zoom = Math.min(4, CC.zoom * 1.25); drawViewer(); };
  $('#vzo').onclick = () => { CC.zoom = Math.max(.25, CC.zoom / 1.25); drawViewer(); };
  $('#vrev').onclick = () => { const same = ds.filter(d => d.sheet && d.sheet === cur.sheet).sort((x, y) => (x.addendum || 0) - (y.addendum || 0));
    if (same.length < 2) return alertBox('This sheet has no other revision to compare.');
    const i = same.findIndex(d => d.id === cur.id), prev = same[i > 0 ? i - 1 : 0], next = i > 0 ? cur : same[1];
    let box = document.getElementById('vcmp'); if (!box) { box = document.createElement('div'); box.id = 'vcmp'; $('#viewer').appendChild(box); }
    showCompare(prev.id, next.id, box); };
  try {
    const lib = await loadPdfJs(); if (!lib) throw new Error('viewer library unavailable');
    const link = await api('POST', `/api/documents/${cur.id}/link`);
    const buf = await (await fetch(link.url)).arrayBuffer();
    const pdf = await lib.getDocument({ isEvalSupported: false, data: buf }).promise, page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: CC.zoom * 1.1 }), c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const can = $('#vcan'); if (can) { can.innerHTML = ''; can.appendChild(c); }
  } catch (e) { const can = $('#vcan'); if (can) can.innerHTML = `<small class="x-cc781baa" >Preview unavailable here (${esc(e.message)}). Use “Open full sheet”.</small>`; }
}
function alertBox(html) { const b = document.createElement('div'); b.className = 'pop'; b.style.position = 'fixed'; b.innerHTML = html + '<div class="x-8a77e5a3" ><button>Close</button></div>'; b.querySelector('button').onclick = () => b.remove(); document.body.appendChild(b); }

function donutHtml(p) {
  const rooms = (p.analyses || []).flatMap(a => a.rooms.filter(r => r.basis === 'printed' && r.areaSqFt));
  if (!rooms.length) return `<div class="donut"><svg viewBox="0 0 42 42" width="120" height="120"><circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--line)" stroke-width="5"/><text x="21" y="20" text-anchor="middle" font-size="4.2" fill="currentColor" font-weight="700">No takeoff</text><text x="21" y="25" text-anchor="middle" font-size="3" fill="currentColor">yet</text></svg><small>Areas appear here after a drawing for this site is analyzed and confirmed. Nothing is estimated from the permit alone.</small></div>`;
  const by = {}; rooms.forEach(r => { const k2 = String(r.name || 'Other').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); by[k2] = (by[k2] || 0) + r.areaSqFt; });
  const total = rooms.reduce((n, r) => n + r.areaSqFt, 0), cols = ['#16a34a', '#f59e0b', '#1f5fd1', '#ef4444', '#8b5cf6', '#14b8a6', '#94a3b8'];
  const parts = Object.entries(by).sort((a2, b2) => b2[1] - a2[1]); const top = parts.slice(0, 6); const rest = parts.slice(6).reduce((n, [, v]) => n + v, 0); if (rest) top.push(['Other', rest]);
  let off = 25; const segs = top.map(([, v], i) => { const len = 100 * v / total; const sgm = `<circle cx="21" cy="21" r="15.9" fill="none" stroke="${cols[i]}" stroke-width="5" stroke-dasharray="${len} ${100 - len}" stroke-dashoffset="${off}"/>`; off -= len; return sgm; }).join('');
  return `<div class="x-e7309fb4" >Printed area total: <b>${total.toLocaleString()} SF</b></div><div class="donut"><svg viewBox="0 0 42 42" width="120" height="120">${segs}<text x="21" y="21" text-anchor="middle" font-size="4.6" font-weight="800" fill="currentColor">${total.toLocaleString()}</text><text x="21" y="26" text-anchor="middle" font-size="3" fill="currentColor">SF printed</text></svg>
    <div class="legend">${top.map(([k2, v], i) => `<div><span><i data-style="background:${cols[i]}"></i>${esc(k2)}</span><b>${v.toLocaleString()} SF</b></div>`).join('')}</div></div>`;
}
function scheduleHtml(p) {
  const t2 = p.timeline, now = Date.now(), items = [];
  // The first status uses the permit's own date from the city record; later changes use when they were observed.
  (p.statusHistory || []).forEach((h, i) => items.push({ label: 'Permit ' + h.status, date: (i === 0 && p.permitDate ? String(p.permitDate) : h.at).slice(0, 10), done: true }));
  (p.bidPackages || []).forEach(b => items.push({ label: 'Bids due — ' + b.title, date: String(b.dueDate).slice(0, 10), done: Date.parse(b.dueDate) < now }));
  if (t2) { items.push({ label: 'Construction Start (est.)', date: t2.estimatedStart, done: Date.parse(t2.estimatedStart) < now });
    t2.trades.filter(x => myWindow(x.trade)).forEach(x => items.push({ label: x.trade + ' (your trade)', date: x.from, done: Date.parse(x.from) < now }));
    items.push({ label: 'Completion (est.)', date: t2.estimatedCompletion, done: Date.parse(t2.estimatedCompletion) < now }); }
  items.sort((a2, b2) => a2.date.localeCompare(b2.date));
  const nextIdx = items.findIndex(x => !x.done);
  return items.length ? `<ul class="tl">${items.map((x, i) => `<li class="${x.done ? 'done' : ''} ${i === nextIdx ? 'now' : ''}"><span>${esc(x.label)}</span><small>${fmtDate(x.date)}</small></li>`).join('')}</ul>` : '<div class="empty">No dates yet.</div>';
}
function bindEmail(root, pid) {
  root.querySelectorAll('[data-email]').forEach(b => b.onclick = () => {
    const cid = b.dataset.email, box = document.getElementById('em-' + cid);
    box.innerHTML = `<form class="panel x-9c6c2209" ><textarea name="m" rows="4" placeholder="Introduce your company and what you'd like to bid on this project."></textarea>
      <small>Sent from BUILDINTEL with your company name, postal address and an unsubscribe link (required by law). Replies go to your email.</small><div class="row"><button class="primary">Send</button><span class="err"></span></div></form>`;
    box.querySelector('form').onsubmit = async ev => { ev.preventDefault(); const f = ev.target;
      try { const r = await api('POST', `/api/projects/${pid}/contact`, { contactId: cid, message: f.m.value }); f.innerHTML = `<small>${esc(r.note)}</small>`; } catch (e) { f.querySelector('.err').textContent = e.message; } };
  });
}
function contactsHtml(p, max, withEmail) {
  const rows = [];
  p.contacts.forEach(c => { rows.push(`<div class="contact x-d93a7f94" >${esc(c.name)} <small class="x-7e3a9447" >(${esc(c.role.replace(/ \(named on permit\)/, ''))})</small>${licBadge(c.license)}${c.license?.phone ? `<span class="ctc"><a href="tel:${esc(c.license.phone)}" title="${esc(c.license.phone)}">${ICON.phone}</a></span>` : ''}</div>`);
    c.people.forEach(x => rows.push(`<div class="contact"><span class="ini">${esc(x.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span><div class="x-19fb48c1" ><b>${esc(x.name)}</b>${x.verified ? ' <span class="pill green">verified</span>' : ''}<br><small>${esc(x.title || '')}</small>${x.email ? `<br><small>${esc(x.email)}</small>` : ''}</div><span class="ctc">${withEmail && x.verified && x.email ? `<button data-email="${x.id}">${ICON.mail} Email via BUILDINTEL</button>` : x.email ? `<a href="mailto:${esc(x.email)}" title="Email">${ICON.mail}</a>` : ''}${x.phone ? `<a href="tel:${esc(x.phone)}" title="Call">${ICON.phone}</a>` : ''}</span></div>${withEmail ? `<div id="em-${x.id}"></div>` : ''}`)); });
  return rows.length ? rows.slice(0, max).join('') : '<div class="empty x-cc781baa" >The city record names no contractor, owner or architect yet.</div>';
}

function drawRight() {
  const p = CC.p, t2 = p.timeline, due = bidDue(p);
  const gc = p.contacts.find(c => /General contractor/.test(c.role));
  const verified = p.contacts.some(c => c.people.some(x => x.verified));
  const myMatch = CC.myTrades.filter(tr => (TRADE_WORK[tr] || []).some(w => (p.work || []).includes(w)) || (p.bidPackages || []).some(b => (b.trades || []).includes(tr)));
  const chk = (ok, text) => `<li><span class="dot ${ok ? 'ok' : 'no'}">${ok ? '✓' : '–'}</span><span>${text}</span></li>`;
  const win = t2 && myMatch.length ? t2.trades.find(x => myWindow(x.trade)) : null;
  const tl = k2 => (TRADES_LIST.find(x => x.key === k2) || {}).label || k2;
  const analyzedSheets = (p.analyses || []).length, printed = (p.analyses || []).reduce((n, a) => n + (a.totals?.printedAreaSqFt || 0), 0);
  const alerts = [...(p.bidPackages || []).flatMap(b => [b.addendumCount ? `Addendum #${b.addendumCount} posted — ${esc(b.title)}` : null, b.status === 'open' ? `Bid due in ${daysTo(b.dueDate)} days — ${esc(b.title)}` : null]).filter(Boolean),
    ...(p.statusHistory || []).slice().reverse().map(h => `Permit ${esc(h.status)} — ${fmtDate(h.at)}`)];
  $('#cc-right').innerHTML = `<div class="card x-2b583d73" ><h3 class="x-3c049a5a" >${ICON.spark} BUILDINTEL AI Insights</h3><ul class="checks">
      ${chk(p.drawings.length > 0, p.drawings.length ? `Drawings available (${p.drawings.length} file(s))` : 'No drawings for this site yet')}
      ${chk(analyzedSheets > 0, analyzedSheets ? `Floor plan areas extracted (${analyzedSheets} sheet(s) confirmed)` : 'No floor plan analysis yet')}
      ${chk(printed > 0, printed ? `Printed area identified: ${printed.toLocaleString()} SF` : 'Area: not yet taken off')}
      ${chk(myMatch.length > 0, CC.myTrades.length ? (myMatch.length ? `Project matches your services (${myMatch.map(tl).join(', ')})` : 'No match with your services') : 'Set your trades in Company Profile')}
      ${chk(!!gc?.license?.active || verified, gc?.license?.active ? 'GC state license active' : verified ? 'Verified GC contact on file' : 'GC not yet verified')}
      ${chk(!!due, due ? 'Bid package open for your trade' : 'No open bid package yet')}</ul>
      <button class="btnfull x-2db7403a" id="ccai" >View AI Analysis →</button></div>
    <div class="card x-2b583d73" ><h3 class="x-3c049a5a" >${ICON.check} Your Opportunity</h3>
      <div class="kv x-7b254bba" ><span>Trade</span><b>${myMatch.length ? esc(tl(myMatch[0])) : '—'}</b>
      <span>Estimated Value</span><b>${CC.est && CC.est.totals.total ? money(CC.est.totals.total) + ' <small>(your estimate)</small>' : '<small>Build an estimate to price it</small>'}</b>
      <span>${due ? 'Bid Due' : 'Likely on site'}</span><b class="${due && daysTo(due) < 30 ? 'due' : ''}">${due ? `${fmtDate(due)} (${daysTo(due)} days)` : win ? fmtDate(win.from) : '—'}</b></div>
      ${p.market ? `<p class="x-6b7d91d3" ><b>Can I bid?</b> ${p.market.canBid ? '<span class="green">Yes.</span> ' : '<b>No.</b> '}${esc(p.market.explanation)}</p>` : ''}
      <button class="btnfull btn-green" id="ccbuild">${ICON.calc} Build Estimate</button><button class="btnfull" id="ccprop">${ICON.file} Create Proposal</button><button class="btnfull" id="ccsubmit">${ICON.send} Submit Bid</button><button class="btnfull" id="ccpipe">${ICON.plus} ${p.tracked ? 'In Pipeline' : 'Add to Pipeline'}</button></div>
    <div class="card x-2b583d73" ><h3 class="x-3c049a5a" >${ICON.star} Pipeline</h3>
      <div class="row">${['watching', 'contacted', 'bidding', 'won', 'lost'].map(st2 => `<button data-track="${st2}" class="${p.tracked === st2 ? 'primary' : ''}">${st2[0].toUpperCase() + st2.slice(1)}</button>`).join('')}</div>
      <form id="ccnote" class="row x-a7401b37" ><input name="t" placeholder="Add a note" aria-label="Note"><button>Save</button></form>
      ${(p.trackedRecord?.notes || []).slice(-4).reverse().map(n => `<small class="x-6f28f390" >${fmtDate(n.at)} · ${esc(n.text)}</small>`).join('')}</div>
    <div class="card"><h3 class="x-3c049a5a" >${ICON.bell} Project Alerts</h3>${alerts.length ? `<ul class="checks">${alerts.slice(0, 5).map(a2 => `<li><span class="dot x-d491fa50" ></span><span>${a2}</span></li>`).join('')}</ul>` : '<small>No changes recorded yet.</small>'}
      <a class="link" id="ccalerts">Set Alert Preferences →</a></div>`;
  $('#ccai').onclick = () => { if (p.drawings.length) { CC.centerTab = 'drawings'; drawCenter(); } else { tab = 'planroom'; navKey = 'planroom:ai'; SUBVIEW = 'ai'; render(); } };
  $('#ccbuild').onclick = () => openProjectEstimate();
  $('#ccprop').onclick = () => CC.est ? openProposal(CC.est.id) : alertBox('Build the estimate first; the proposal is generated from it.');
  $('#ccsubmit').onclick = () => { const inv = (p.bidPackages || []).find(b => b.invitationId && b.status === 'open'); if (inv) { tab = 'invitations'; navKey = 'invitations'; render(); } else { CC.centerTab = 'people'; drawCenter(); $('#cc-tab')?.scrollIntoView({ behavior: 'smooth' }); } };
  $('#ccpipe').onclick = async () => { try { await api('POST', `/api/projects/${p.id}/track`, { stage: p.tracked || 'watching' }); select(p.id); } catch (e) { alertBox(esc(e.message)); } };
  $('#ccalerts').onclick = () => { tab = 'searches'; navKey = 'searches'; render(); };
  const trackCall = async body => { try { await api('POST', `/api/projects/${p.id}/track`, body); select(p.id); } catch (e) { alertBox(esc(e.message)); } };
  document.querySelectorAll('#cc-right [data-track]').forEach(b => b.onclick = () => trackCall({ stage: b.dataset.track }));
  $('#ccnote').onsubmit = ev => { ev.preventDefault(); const t2 = ev.target.t.value.trim(); if (t2) trackCall({ stage: p.tracked || 'watching', note: t2 }); };
}
async function openProjectEstimate() {
  const permitId = CC.p.anchorPermitId || (String(CC.p.id).startsWith('BI-') ? null : CC.p.id);
  if (!permitId) return alertBox('This project has no building permit yet, so there is no square footage to price from. Build an estimate from a drawing (Measure) or a bid invitation instead.');
  const e = await api('POST', '/api/estimates/project', { permitId }); CC.openEst = e.id; tab = 'estimates'; navKey = 'estimates'; render(); }
async function openProposal(id) { const r = await fetch(`/api/estimates/${id}/proposal`, { headers: { Authorization: 'Bearer ' + token } }); const w = window.open(); w.document.write(await r.text()); w.document.close(); }

async function leadTab(t, body) {
  if (t === 'projects') {
    if (!WORK.length) WORK = await api('GET', '/api/work-tags').catch(() => []);
    const id = location.hash.startsWith('#project/') ? location.hash.slice(9) : null;
    if (id) return projectView(id, body);
    body.innerHTML = `<form class="x-8f1e7690" id="pf" >
      <input name="q" placeholder="Keywords, address, GC" value="${esc(lastFilters.q||'')}"><input name="city" placeholder="City" value="${esc(lastFilters.city||'')}">
      <select name="type"><option value="">Any building type</option>${TYPES.map(x => `<option ${lastFilters.type===x?'selected':''}>${x}</option>`).join('')}</select>
      <select name="work"><option value="">Any work type</option>${WORK.map(w => `<option value="${w.key}" ${lastFilters.work===w.key?'selected':''}>${esc(w.label)}</option>`).join('')}</select>
      <select name="stage"><option value="">Any stage</option>${Object.entries(STAGE_LABEL).map(([k,v]) => `<option value="${k}" ${lastFilters.stage===k?'selected':''}>${v}</option>`).join('')}</select>
      <input name="minValue" type="number" min="0" placeholder="Min value $" value="${esc(lastFilters.minValue||'')}">
      <label class="x-606f6500" ><input class="x-30e741d9" type="checkbox" name="hasContact"  ${lastFilters.hasContact?'checked':''}>Verified GC contact</label>
      <label class="x-606f6500" ><input class="x-30e741d9" type="checkbox" name="includeClosed"  ${lastFilters.includeClosed?'checked':''}>Include completed</label>
      <select name="sort"><option value="newest">Newest activity</option><option value="value">Highest value</option><option value="start">Starting soonest</option></select>
      <button class="primary">Search</button></form>
      <div class="row x-761d3add" ><input class="x-3521b3d8" id="sn" placeholder="Name this search to get daily alerts" ><button id="sv">Save search & alert me</button><button id="ex">Export CSV</button><span class="x-80c16bdf" id="msg" ></span></div>
      <div id="res"></div>`;
    const run = async () => {
      const fd = new FormData($('#pf')); lastFilters = Object.fromEntries([...fd.entries()].filter(([, v]) => v !== '')); if (fd.get('hasContact')) lastFilters.hasContact = 'true'; if (fd.get('includeClosed')) lastFilters.includeClosed = 'true';
      const qs = new URLSearchParams(lastFilters).toString();
      try {
        const r = await api('GET', '/api/projects?' + qs);
        $('#res').innerHTML = `<p class="x-57f9e31d" >${r.total} project site(s)${r.permitTotal > r.total ? ` (${r.permitTotal} permits)` : ''} in ${esc(Array.isArray(r.territories) ? r.territories.join(', ') : r.territories)}</p>` + (r.results.length ? `<div class="scroll"><table><tr><th>Project</th><th>Stage</th><th class="num">Reported value (all permits)</th><th>Est. start</th><th>Contractor on permit</th></tr>${r.results.map(p => `<tr><td><a href="#project/${p.id}">${esc(p.title)}</a><br><small>${esc(p.address)}, ${esc(p.city)}, ${esc(p.state)} · ${esc(p.projectType.replace('_',' '))}${p.squareFeet ? ' · ' + p.squareFeet.toLocaleString() + ' SF' : ''}${p.tracked ? ' · <strong>' + esc(p.tracked) + '</strong>' : ''}${p.permitCount > 1 ? ' · <strong>' + p.permitCount + ' permits</strong>' : ''}${p.work?.length ? '<br><small class="x-323fe151" >' + esc(p.work.map(workLabel).join(' · ')) + '</small>' : ''}<br><small class="x-57f9e31d" >checked against city record ${ago(p.checkedAt)}</small></small></td><td>${STAGE_LABEL[p.stage]||esc(p.stage)}<br>${marketPill(p.market)}</td><td class="num">${p.combinedValue ? usd(p.combinedValue) : '—'}</td><td>${esc(p.estimatedStart||'—')}</td><td>${esc(p.contractorOnPermit||'—')}</td></tr>`).join('')}</table></div>` : '<div class="empty">No projects match. Widen the filters, or save this search to be alerted when one appears.</div>');
        document.querySelectorAll('#res a[href^="#project/"]').forEach(a => a.onclick = ev => { ev.preventDefault(); location.hash = a.getAttribute('href'); render(); });
      } catch (e) { $('#res').innerHTML = `<div class="empty x-ce711e4f" >${esc(e.message)}</div>`; }
    };
    $('#pf').onsubmit = ev => { ev.preventDefault(); run(); };
    $('#sv').onclick = async () => { try { await api('POST', '/api/searches', { name: $('#sn').value || 'My search', filters: lastFilters }); $('#msg').textContent = 'Saved. You will get a daily email when matching projects appear or change.'; } catch (e) { $('#msg').textContent = e.message; } };
    $('#ex').onclick = async () => { const r = await fetch('/api/projects/export?' + new URLSearchParams(lastFilters), { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) { $('#msg').textContent = (await r.json()).error; return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = 'buildintel-projects.csv'; a.click(); };
    return run();
  }
  if (t === 'command' || t === 'map') return commandWorkspace(body, t === 'map');
  if (t === 'subscription') { const sub = await api('GET', '/api/subscription'); body.innerHTML = `<div class="card">${subscriptionHtml(sub)}</div>`; return; }
  if (t === 'team') {
    const users = await api('GET', '/api/org/users'), sub = await api('GET', '/api/subscription').catch(() => null), isOwner = me.user.role === 'owner';
    body.innerHTML = `<div class="card"><p class="x-d462248a" >Seats: <b>${sub ? sub.usage.seatsUsed + ' of ' + sub.entitlements.seats : '—'}</b></p><div class="scroll"><table><tr><th>User</th><th>Role</th><th>Status</th>${isOwner ? '<th></th>' : ''}</tr>${users.map(u => `<tr><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.disabled ? '<span class="pill">disabled</span>' : '<span class="pill green">active</span>'}</td>${isOwner ? `<td>${u.id !== me.user.id ? `<button data-udis="${u.id}" data-to="${!u.disabled}">${u.disabled ? 'Enable' : 'Disable'}</button>` : ''}</td>` : ''}</tr>`).join('')}</table></div>
      ${isOwner ? `<form id="tuf2" class="row x-8a77e5a3" ><input class="x-27af8985" name="email" placeholder="email" ><input class="x-a828909e" name="password" type="password" placeholder="temporary password (12+)" ><button>Add member</button><span class="err"></span></form>` : ''}</div>`;
    body.querySelectorAll('[data-udis]').forEach(b => b.onclick = async () => { try { await api('PATCH', '/api/org/users/' + b.dataset.udis, { disabled: b.dataset.to === 'true' }); render(); } catch (e) { alertBox(esc(e.message)); } });
    $('#tuf2')?.addEventListener('submit', async ev => { ev.preventDefault(); const f = ev.target; try { await api('POST', '/api/org/users', { email: f.email.value.trim(), password: f.password.value, role: 'member' }); render(); } catch (e) { f.querySelector('.err').textContent = e.message; } });
    return;
  }
  if (t === 'publishers') {
    const list = await api('GET', '/api/admin/publishers');
    body.innerHTML = list.length ? `<div class="scroll"><table><tr><th>Company</th><th>Type</th><th>Status</th><th>Evidence</th><th>Decision</th></tr>${list.map(x => `<tr><td><b>${esc(x.name)}</b><br><small>${x.publications} publication(s)</small></td><td>${esc(String(x.kind || '').replace('_', ' '))}</td><td>${pubPill(x.status)}</td>
      <td><small>${x.evidence ? [x.evidence.website ? srcLink(x.evidence.website, x.evidence.website) : '', x.evidence.licenseNumber ? 'license ' + esc(x.evidence.licenseNumber) : '', x.evidence.phone ? esc(x.evidence.phone) : '', esc(x.evidence.notes || '')].filter(Boolean).join(' · ') : '—'}</small></td>
      <td>${x.status === 'verified' ? `<small>${esc(x.note || '')}</small>` : `<form data-dec="${x.id}" class="row x-2aca6dad" ><input class="x-47b618fc" name="note" placeholder="How you checked (required)" ><button name="v" value="verified">Approve</button><button name="v" value="rejected">Reject</button></form>`}</td></tr>`).join('')}</table></div>` : '<div class="empty">No publisher accounts yet.</div>';
    body.querySelectorAll('form[data-dec]').forEach(f => f.querySelectorAll('button').forEach(b => b.onclick = async ev => { ev.preventDefault();
      try { await api('POST', `/api/admin/publishers/${f.dataset.dec}/decide`, { status: b.value, note: f.note.value }); render(); } catch (e) { alertBox(esc(e.message)); } }));
    return;
  }
  if (t === 'coverage') {
    const c = await api('GET', '/api/coverage');
    const platform = me.user.role === 'platform_owner';
    const pill = st2 => `<span class="pill ${{ live: 'green', stale: 'amber', error: 'red', off: '' }[st2]}">${{ live: 'Live', stale: 'Stale', error: 'Error', off: 'Off' }[st2]}</span>`;
    body.innerHTML = `<div class="kpis"><div class="kpi"><span class="ic x-cf4f085b" >${ICON.check}</span><div><b>${c.summary.liveSources}</b><span>Live data feeds</span></div></div>
      <div class="kpi"><span class="ic x-ecf067bb" >${ICON.pin}</span><div><b>${c.summary.liveJurisdictions}</b><span>Live cities</span></div></div>
      <div class="kpi"><span class="ic x-ecf067bb" >${ICON.us}</span><div><b>${c.summary.states.length}</b><span>States: ${esc(c.summary.states.join(', ') || 'none')}</span></div></div></div>
      <div class="scroll"><table><tr><th>Source</th><th>Data</th><th>Status</th><th class="num">Records</th><th>Last successful pull</th><th>Newest record</th>${platform ? '<th>Authorization / notes</th>' : ''}</tr>
      ${c.rows.map(r => `<tr><td><b>${esc(r.city ? r.city + ', ' + r.state : r.state || 'National')}</b><br><small>${esc(r.name)}</small></td><td>${esc(r.kind)}</td><td>${pill(r.status)}</td><td class="num">${r.records.toLocaleString()}</td>
        <td>${r.lastSuccessAt ? ago(r.lastSuccessAt) : '—'}</td><td>${r.lastRecordDate ? fmtDate(r.lastRecordDate) : '—'}</td>
        ${platform ? `<td><small>${r.authorized ? '<span class="pill green">terms recorded</span> ' + esc(r.evidence || '') : '<span class="pill">terms not reviewed</span>'}${r.error ? '<br><span class="x-ce711e4f" >' + esc(r.error) + '</span>' : ''}${r.status === 'off' && r.notes ? '<br>' + esc(r.notes) : ''}</small></td>` : ''}</tr>`).join('')}</table></div>
      <p><small>"Live" = switched on, terms recorded, and a successful pull in the last 26 hours. "Stale" = switched on but no successful pull in 26 hours.</small></p>
      ${platform ? '<div id="corebox"></div>' : ''}`;
    if (platform) {
      const st = await api('GET', '/api/core/stats').catch(() => null), rv = await api('GET', '/api/core/review').catch(() => []);
      if (st) $('#corebox').innerHTML = `<div class="card x-d6f2af6e" ><h3>${ICON.layers} Project Intelligence Core</h3>
        <p>${st.projects.toLocaleString()} permanent projects · ${st.links.toLocaleString()} linked records · ${st.companies.toLocaleString()} company relationships · phases: ${Object.entries(st.byPhase).map(([k, v]) => esc(k) + ' ' + v).join(', ') || '—'}</p>
        <p>${st.reconcile ? (st.reconcile.ok ? `<span class="pill green">database tables match records</span> schema v${st.reconcile.schemaVersion}` : `<span class="pill red">database tables out of step</span> ${esc(JSON.stringify(st.reconcile.tables))}`) : '<small>Relational tables are used with PostgreSQL.</small>'}</p>
        <h3 class="x-d2c171b1" >Needs review (${rv.length})</h3>${rv.length ? rv.map(r => `<div class="contact x-2a1b75c9" ><b>${esc(r.kind.replace('_', ' '))}</b> <small>${esc(r.reason)} · ${esc(r.siteKey)}</small><br>${r.candidates.map(c2 => `<button data-rv="${esc(r.id)}" data-pj="${esc(c2)}">Link to ${esc(c2)}</button>`).join(' ')}</div>`).join('') : '<small>Nothing to review. Ambiguous matches appear here instead of being guessed.</small>'}</div>`;
      document.querySelectorAll('[data-rv]').forEach(b => b.onclick = async () => { await api('POST', `/api/core/review/${encodeURIComponent(b.dataset.rv)}/resolve`, { projectId: b.dataset.pj }); render(); });
    }
    return;
  }
  if (t === 'planroom') {
    const view = SUBVIEW || 'all';
    if (view === 'ai') {   // AI analyzer keeps the flat list of drawings with Measure / AI analysis
      const docs = (await api('GET', '/api/documents').catch(() => [])).filter(d => d.kind === 'drawing');
      body.innerHTML = `<div class="card">${docs.length ? `<div class="scroll"><table><tr><th>Sheet / file</th><th>Discipline</th><th>Project</th><th>Revision</th><th></th></tr>${docs.map(d => `<tr><td><a href="#" data-doc-open="${d.id}">${esc(d.sheet ? d.sheet + ' — ' + (d.title || '') : d.name)}</a></td><td>${esc(d.discipline)}</td><td>${esc(d.request.title || '')}<br><small>${esc(d.request.buyerName || '')} · ${esc(d.request.city || '')}</small></td><td>${d.addendum ? `<span class="pill amber">Addendum ${d.addendum}</span>` : 'Original'}</td><td><a href="#" data-measure="${d.id}">Measure</a> · <a href="#" data-ai="${d.id}">AI analysis</a><div id="ai-${d.id}"></div></td></tr>`).join('')}</table></div>` : '<div class="empty">No drawings yet. They appear when a GC posts plans to a bid package you posted or were invited to.</div>'}</div>`;
      bindDocOpen(body); return;
    }
    const sets = await api('GET', '/api/planroom/sets').catch(() => []);
    const keep = st2 => view === 'specification' ? st2.discipline === 'Specifications' : view === 'drawing' ? st2.discipline !== 'Specifications' : true;
    const shown = sets.filter(keep).map(st2 => ({ ...st2, sheets: view === 'addenda' ? st2.sheets.filter(sh => sh.revisions.some(r => r.addendum)) : st2.sheets })).filter(st2 => st2.sheets.length);
    const byProject = {}; shown.forEach(st2 => (byProject[st2.projectName || 'Unlinked bid packages'] ||= []).push(st2));
    body.innerHTML = `<form id="dsf" class="card row x-4dadd803" >${ICON.search}<input name="q" placeholder="Search inside drawings and specifications — e.g. “lighting”, “division 26”, “fire damper”" aria-label="Search documents"><button class="primary">Search</button></form>
      <div id="dsr"></div>
      ${Object.keys(byProject).length ? Object.entries(byProject).map(([pn, list]) => `<div class="card x-da12f285" ><h3>${ICON.building} ${esc(pn)}</h3>
        ${list.map(st2 => `<div class="x-c704d442" ><b>${esc(st2.discipline)}</b> <small>${esc(st2.name)} · ${esc(st2.rights?.audience ? 'viewable by ' + st2.rights.audience : '')}</small></div>
          <div class="scroll"><table><tr><th>Sheet</th><th>Revisions</th><th></th></tr>${st2.sheets.map(sh => `<tr><td><a href="#" data-doc-open="${sh.current.documentId}">${esc(sh.sheet ? sh.sheet + ' — ' + sh.title : sh.title)}</a></td>
            <td>${sh.revisions.map(r => `<span class="pill ${r.documentId === sh.current.documentId ? 'green' : ''}" title="${esc(r.name)}">${esc(r.label)}</span>`).join(' ')}</td>
            <td>${sh.kind === 'drawing' ? `<a href="#" data-measure="${sh.current.documentId}">Measure</a> · <a href="#" data-ai="${sh.current.documentId}">AI analysis</a>` : ''}${sh.revisions.length > 1 ? ` · <a href="#" data-cmp="${sh.revisions.at(-2).documentId}|${sh.current.documentId}">Compare ${esc(sh.revisions.at(-2).label)} → ${esc(sh.current.label)}</a>` : ''}
              <div id="ai-${sh.current.documentId}"></div><div id="cmp-${sh.current.documentId}"></div></td></tr>`).join('')}</table></div>`).join('')}</div>`).join('')
        : `<div class="empty">No ${view === 'addenda' ? 'addenda' : view === 'specification' ? 'specifications' : 'drawings'} yet. Files appear here when a GC posts plans to a bid package you posted or were invited to.</div>`}`;
    bindDocOpen(body); bindCompare(body);
    $('#dsf').onsubmit = async ev => { ev.preventDefault(); const q = ev.target.q.value.trim(); const box = $('#dsr');
      if (q.length < 2) { box.innerHTML = ''; return; }
      const r = await api('GET', '/api/planroom/search?q=' + encodeURIComponent(q)).catch(e => { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return null; }); if (!r) return;
      box.innerHTML = `<div class="card x-da12f285" ><h3>${r.length} result(s) for “${esc(q)}”</h3>${r.length ? r.map(x => `<div class="contact x-2a1b75c9" ><a href="#" data-doc-open="${x.documentId}"><b>${esc(x.sheet ? x.sheet + ' — ' + (x.title || '') : x.name)}</b></a> <small>${esc(x.discipline)} · ${esc(x.revision || '')}${x.projectName ? ' · ' + esc(x.projectName) : ''}${x.page ? ' · page ' + x.page : ''}</small>${x.snippet ? `<br><small>“${esc(x.snippet)}”</small>` : ''}${x.textIndexed ? '' : '<br><small>(text not indexed yet — matched on the file name)</small>'}</div>`).join('') : '<small>No matches in documents you can open.</small>'}</div>`;
      bindDocOpen(box); };
    return;
  }
  if (t === 'estimates') {
    const list = await api('GET', '/api/estimates').catch(() => []);
    body.innerHTML = `<div class="card"><p class="x-00c503de" >Start one with <b>Build Estimate</b> on any project, <b>Measure</b> on a drawing, or a confirmed AI analysis.</p>
      ${list.length ? `<div class="scroll"><table><tr><th>Estimate</th><th>For</th><th class="num">Total</th><th>Status</th><th></th></tr>${list.map(e => `<tr><td>${esc(e.title)}</td><td><small>${e.invitationId ? 'Bid invitation' : e.permitId ? 'Project (permit)' : '—'}</small></td><td class="num">${money(e.totals.total)}</td><td>${esc(e.status)}</td><td><button data-open-est="${e.id}">Open</button></td></tr><tr><td class="x-fd8f71c4" colspan="5" ><div id="est-x${e.id}"></div></td></tr>`).join('')}</table></div>` : '<div class="empty">No estimates yet.</div>'}</div>`;
    const open = id => { const e = list.find(x => x.id === id); openEstimate('x' + id, e, { project: !e.invitationId }); };
    body.querySelectorAll('[data-open-est]').forEach(b => b.onclick = () => open(b.dataset.openEst));
    if (CC.openEst && list.some(x => x.id === CC.openEst)) { open(CC.openEst); CC.openEst = null; }
    return;
  }
  if (t === 'market') {
    const m = await api('GET', '/api/market').catch(e => ({ error: e.message }));
    if (m.error) { body.innerHTML = `<div class="empty">${esc(m.error)}</div>`; return; }
    const bars = (rows, label = x => x.key, val = x => x.permits) => { const max = Math.max(1, ...rows.map(val)); return `<div class="bars">${rows.map(r => `<div><span>${esc(label(r))}</span><span class="b" data-style="width:${Math.max(2, 100 * val(r) / max)}%"></span><b>${val(r).toLocaleString()}</b></div>`).join('')}</div>`; };
    body.innerHTML = `<p class="x-00c503de" >${m.totalPermits.toLocaleString()} permits counted.</p>
      <div class="grid2"><div class="card"><h3>Permits by month</h3>${bars(m.byMonth)}</div><div class="card"><h3>Busiest cities</h3>${bars(m.byCity)}</div>
      <div class="card"><h3>Building types</h3>${bars(m.byType, x => String(x.key).replace('_', ' '))}</div><div class="card"><h3>Work involved</h3>${bars(m.byWork, x => workLabel(x.key))}</div>
      <div class="card"><h3>Construction stage</h3>${bars(m.byStage, x => STAGE_LABEL[x.key] || x.key)}</div><div class="card"><h3>Reported value by building type</h3>${bars(m.byType.filter(x => x.value), x => String(x.key).replace('_', ' '), x => x.value).replace(/<b>([\d,]+)<\/b>/g, (_, n) => '<b>' + usdShort(Number(n.replace(/,/g, ''))) + '</b>')}</div></div>`;
    if (!WORK.length) WORK = await api('GET', '/api/work-tags').catch(() => []);
    return;
  }
  if (t === 'directory') {
    const all = await api('GET', '/api/contacts').catch(() => []);
    const cos = await api('GET', '/api/companies').catch(() => []);
    const coName = id => (cos.find(c => c.id === id) || {}).name || '';
    const gm = SUBVIEW === 'gm';
    const list = all.filter(c => !c.suppressed && c.status !== 'opted_out' && (!gm || /general manager|\bgm\b/i.test(c.role || '')));
    body.innerHTML = `<div class="card">
      ${list.length ? `<div class="scroll"><table><tr><th>Name</th><th>Title</th><th>Company</th><th>Status</th><th>Contact</th></tr>${list.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.role || '')}</td><td>${esc(coName(c.companyId))}</td><td>${['verified', 'source_confirmed'].includes(c.status) ? '<span class="pill green">verified</span>' : '<span class="pill">unverified</span>'}</td><td class="ctc">${c.email ? `<a href="mailto:${esc(c.email)}">${ICON.mail}</a> <small>${esc(c.email)}</small>` : ''}${c.evidenceUrl ? ` <a href="${safeUrl(c.evidenceUrl)}" target="_blank" rel="noopener">source</a>` : ''}</td></tr>`).join('')}</table></div>`
        : `<div class="empty">${gm ? 'No general managers on file yet. GMs appear here only when a verified source lists them.' : 'No contacts on file yet.'}</div>`}</div>`;
    return;
  }
  if (t === 'invitations') {
    if (!TRADES_LIST.length) TRADES_LIST = await (await fetch('/api/trades')).json().catch(() => []);
    const inv = await api('GET', '/api/invitations');
    const label = k => (TRADES_LIST.find(x => x.key === k) || {}).label || k;
    body.innerHTML = inv.length ? (await Promise.all(inv.map(async i => { const r = i.request; const open = r.status === 'open';
      return `<div class="gate x-6384e367" ><div><strong>${esc(r.title)}</strong> <small>${esc(r.buyerName)}${r.buyerKind ? ' (' + esc(String(r.buyerKind).replace('_', ' ')) + ')' : ''} · ${esc(r.address)}, ${esc(r.city)}, ${esc(r.state)} · bids due <strong>${esc(String(r.dueDate).slice(0, 10))}</strong> · ${esc(r.status)}</small>
        <small>${esc((r.trades || []).map(label).join(' · '))}${r.squareFeet ? ' · ' + r.squareFeet.toLocaleString() + ' SF' : ''}${r.documentsUrl ? ` · <a href="${safeUrl(r.documentsUrl)}" target="_blank" rel="noopener">plans & specs</a>` : ''}</small>
        ${i.why ? `<small class="muted">Why you were invited: ${esc(i.why)}</small>` : ''}
        ${r.description ? `<small>${esc(r.description)}</small>` : ''}
        <div data-inv="${i.id}">${r.documentCount ? await planRoomHtml(r.id) : ''}<div id="est-${i.id}"></div>${open ? `<button class="x-fe7b4979" data-est-manual="${i.id}" >Build estimate manually</button>` : ''}</div>
        ${r.addendumCount > i.acknowledgedThrough ? `<div class="x-c5c11f3d" ><small><strong>Addendum ${r.addendumCount} posted.</strong> ${esc(r.addenda.at(-1)?.note || '')} Review the plan room, then acknowledge before bidding.</small> <button data-ack="${i.id}">Acknowledge addenda 1–${r.addendumCount}</button></div>` : (r.addendumCount ? `<small>Addenda 1–${r.addendumCount} acknowledged.</small>` : '')}
        <div class="row x-fe7b4979" >${['will_bid', 'wont_bid', 'undecided'].map(x => `<button data-intent="${x}" data-id="${i.id}" ${i.intent === x ? 'class="primary"' : ''} ${open ? '' : 'disabled'}>${{ will_bid: 'Will bid', wont_bid: "Won't bid", undecided: 'Undecided' }[x]}</button>`).join('')}
          ${open ? `<button data-bidform="${i.id}" data-due="${esc(r.dueDate)}">${i.myBid ? 'Revise bid' : 'Submit bid'}</button> <button type="button" data-copylink="${i.id}">Copy bid link</button>` : ''}</div>
        ${i.myBid ? `<small>Your bid: <strong>${money(i.myBid.total)}${i.myBid.recurring ? '/mo' : ''}</strong> · ${esc(i.myBid.status.replace('_', ' '))} · revision ${i.myBid.revision} · ${ago(i.myBid.submittedAt)}${i.myBid.receiptId ? ` · receipt <b>${esc(i.myBid.receiptId)}</b> <span title="SHA-256 fingerprint of the exact bid document">(${esc(i.myBid.sha256.slice(0, 12))}…)</span>` : ''}</small>` : ''}
        <div id="bf-${i.id}"></div></div></div>`; }))).join('')
      : (me.org?.trades || []).length ? `<div class="empty">No open invitations right now. You're set up for ${esc((me.org.trades || []).map(k => (TRADES_LIST.find(t => t.key === k) || {}).label || k).join(', '))}, so a GC or property manager in your territory will invite you when work matches.</div>` : '<div class="empty">No invitations yet. Set your trades in Plan & profile, and you\'ll be invited automatically when a GC or property manager in your territory posts work you do.</div>';
    bindDocOpen(body);
    for (const i of inv) { const prior = await api('GET', '/api/estimates?invitationId=' + i.id).catch(() => []); if (prior.length) openEstimate(i.id, prior[0]); }
    body.querySelectorAll('[data-est-manual]').forEach(b => b.onclick = () => openEstimate(b.dataset.estManual, null));
    body.querySelectorAll('[data-ack]').forEach(b => b.onclick = async () => { await api('POST', `/api/invitations/${b.dataset.ack}/acknowledge`); render(); });
    body.querySelectorAll('[data-copylink]').forEach(b => b.onclick = async () => {
      const label = b.textContent;
      try { const { url } = await api('GET', `/api/invitations/${b.dataset.copylink}/bid-link`);
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url); else window.prompt('Copy this bid link:', url);
        b.textContent = 'Link copied'; setTimeout(() => { b.textContent = label; }, 2000);
      } catch (e) { b.textContent = 'Link unavailable'; setTimeout(() => { b.textContent = label; }, 2500); } });
    body.querySelectorAll('[data-intent]').forEach(b => b.onclick = async () => { await api('POST', `/api/invitations/${b.dataset.id}/intent`, { intent: b.dataset.intent }); render(); });
    body.querySelectorAll('[data-bidform]').forEach(b => b.onclick = () => {
      const id = b.dataset.bidform, due = b.dataset.due ? new Date(b.dataset.due) : null;
      const box = $('#bf-' + id);
      // The server accepts bids until one day after the due date; show the same rule before the subscriber types.
      if (due && Date.now() > due.getTime() + 864e5) { box.innerHTML = '<p class="err" role="alert">The bid due date has passed, so bids can no longer be sent for this project.</p>'; return; }
      const daysLeft = due ? Math.max(0, Math.ceil((due.getTime() - Date.now()) / 864e5)) : null;
      const dueText = due ? 'Bids due ' + esc(due.toLocaleDateString()) + (daysLeft === 0 ? ' (today)' : ' (' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' left)') : '';
      const field = 'display:grid;gap:4px;font-size:14px';
      box.innerHTML = '<form class="x-83f1a59e" novalidate >'
        + '<div><strong>Your bid</strong><br><small class="x-57f9e31d" >' + dueText + '</small></div>'
        + '<label class="x-27ac7107" >Total price (USD)<input name="amount" inputmode="decimal" autocomplete="off" placeholder="e.g. 12,500"></label>'
        + '<label class="x-54ead96c" ><input class="x-30e741d9" type="checkbox" name="recurring" >This is a monthly price, not a one-time total</label>'
        + '<label class="x-27ac7107" >What is included<textarea class="x-32646c1b" name="scope" rows="4" placeholder="Describe the work, at least 10 characters" ></textarea><small class="count x-57f9e31d" >0 of 10 characters</small></label>'
        + '<label class="x-27ac7107" >Exclusions and assumptions (optional)<textarea class="x-32646c1b" name="exclusions" rows="2" ></textarea></label>'
        + '<label class="x-27ac7107" >Link to your proposal or documents (optional)<input name="documentUrl" inputmode="url" placeholder="https://…"></label>'
        + '<label class="x-27ac7107" >Valid for (days)<input name="validDays" type="number" min="1" max="365" placeholder="30"></label>'
        + '<div class="err x-6b99de8b" role="alert" ></div>'
        + '<div class="row"><button type="submit" class="primary">Send bid</button><span class="muted x-5e0faad2" >You can revise the bid until the due date.</span></div></form>';
      const f = box.querySelector('form'), errBox = f.querySelector('[role=alert]'), btn = f.querySelector('button');
      const showErrors = list => { errBox.innerHTML = list.map(x => '<div>' + esc(x) + '</div>').join(''); errBox.style.display = list.length ? '' : 'none'; };
      f.scope.addEventListener('input', () => { const n = f.scope.value.trim().length; f.querySelector('.count').textContent = n + ' of 10 characters' + (n >= 10 ? '' : ' (at least 10 needed)'); });
      f.onsubmit = async ev => {
        ev.preventDefault();
        // The same rules the server enforces, checked first so nothing is lost to a rejected submit.
        const errs = [], amount = Number(String(f.amount.value).replace(/[$,\s]/g, ''));
        if (!(amount > 0)) errs.push('Enter the total price as a number greater than zero.');
        if (f.scope.value.trim().length < 10) errs.push('Describe what is included (at least 10 characters).');
        const url = f.documentUrl.value.trim();
        if (url && !/^https?:\/\//i.test(url)) errs.push('The document link must start with https://');
        const days = f.validDays.value;
        if (days && (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 365)) errs.push('Valid for must be a whole number of days from 1 to 365.');
        if (errs.length) { showErrors(errs); (amount > 0 ? f.scope : f.amount).focus(); return; }
        showErrors([]);
        btn.disabled = true; btn.textContent = 'Sending…';   // a double click must not send the bid twice
        try {
          await api('POST', '/api/invitations/' + id + '/bid', { amount: f.amount.value, recurring: f.recurring.checked, scope: f.scope.value, exclusions: f.exclusions.value, documentUrl: url || undefined, validDays: Number(days) || undefined });
          box.innerHTML = '<p class="x-664a6bbe" role="status" >Bid sent. It is now in your bids with a receipt.</p>';
          setTimeout(() => render(), 1200);
        } catch (e) {
          showErrors([e.message]);
          btn.disabled = false; btn.textContent = 'Send bid';   // the typed values stay in the form
        }
      };
    });
    return;
  }
  if (t === 'contractors') {
    const key = location.hash.startsWith('#contractor/') ? decodeURIComponent(location.hash.slice(12)) : null;
    if (key) {
      let c; try { c = await api('GET', '/api/contractors/' + encodeURIComponent(key)); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
      const L = c.license;
      body.innerHTML = `<p><a href="#" id="bk">← All contractors</a></p><h2>${esc(c.name)}</h2>
        <p>${L ? `State license <strong>${esc(L.number)}</strong> · <span data-style="color:${L.active ? 'var(--pass)' : 'var(--fail)'}">${esc(L.status || '')}</span>${L.type ? ' · ' + esc(L.type) : ''}${L.expiresAt ? ' · expires ' + esc(String(L.expiresAt).slice(0, 10)) : ''}${L.phone ? ' · ' + esc(L.phone) : ''}${L.address ? ' · ' + esc(L.address) : ''}${L.principal ? ' · principal ' + esc(L.principal) : ''} · <a href="${safeUrl(L.sourceUrl)}" target="_blank" rel="noopener">state record</a> (checked ${ago(L.checkedAt)})` : '<span class="x-57f9e31d" >No state license record matched (or this state isn\'t connected yet).</span>'}</p>
        ${L?.specialties?.length ? `<p><small>Specialties: ${esc(L.specialties.join(', '))}</small></p>` : ''}
        ${c.people.length ? `<p>${c.people.map(x => `${esc(x.name)}${x.title ? ', ' + esc(x.title) : ''}${x.email ? ' — ' + esc(x.email) : ''} (${x.verified ? 'verified' : 'unverified'})`).join('<br>')}</p>` : ''}
        <h3>Permits (${c.projects.length})</h3><div class="scroll"><table><tr><th>Project</th><th>Stage</th><th class="num">Value</th><th>Date</th></tr>${c.projects.map(p => `<tr><td><a href="#project/${p.id}">${esc(p.title)}</a><br><small>${esc(p.address)}, ${esc(p.city)}</small></td><td>${STAGE_LABEL[p.stage]||esc(p.stage)}</td><td class="num">${p.valuation ? usd(p.valuation) : '—'}</td><td>${esc((p.permitDate||'').slice(0,10))}</td></tr>`).join('')}</table></div>`;
      $('#bk').onclick = ev => { ev.preventDefault(); history.replaceState(null, '', location.pathname); render(); };
      body.querySelectorAll('a[href^="#project/"]').forEach(a => a.onclick = ev => { ev.preventDefault(); tab = 'projects'; location.hash = a.getAttribute('href'); render(); });
      return;
    }
    body.innerHTML = `<form id="cf2" class="row x-da12f285" ><input class="x-2f3f7d77" name="q" placeholder="Contractor name" ><input class="x-151dcb2e" name="state" placeholder="State" maxlength="2" ><button class="primary">Search</button></form><div id="cres"></div>`;
    const run = async () => { const fd = new FormData($('#cf2')); const r = await api('GET', '/api/contractors?' + new URLSearchParams([...fd.entries()].filter(([, v]) => v)));
      $('#cres').innerHTML = `<p class="x-57f9e31d" >${r.total} contractor(s) named on permits in your territory, busiest first.</p>` + (r.results.length ? `<div class="scroll"><table><tr><th>Contractor</th><th class="num">Active permits</th><th class="num">Sites</th><th class="num">Reported value</th><th>Cities</th><th>Latest permit</th></tr>${r.results.map(c => `<tr><td><a href="#contractor/${encodeURIComponent(c.key)}">${esc(c.name)}</a>${licBadge(c.license)}<br><small class="x-323fe151" >${esc(c.work.slice(0, 4).map(workLabel).join(' · '))}</small></td><td class="num">${c.activePermits}</td><td class="num">${c.sites}</td><td class="num">${c.reportedValue ? usd(c.reportedValue) : '—'}</td><td><small>${esc(c.cities.slice(0, 3).join(', '))}</small></td><td>${esc((c.latestPermit||'').slice(0,10))}</td></tr>`).join('')}</table></div>` : '<div class="empty">No contractors match.</div>');
      document.querySelectorAll('#cres a[href^="#contractor/"]').forEach(a => a.onclick = ev => { ev.preventDefault(); location.hash = a.getAttribute('href'); render(); }); };
    $('#cf2').onsubmit = ev => { ev.preventDefault(); run(); };
    return run();
  }
  if (t === 'planning') {
    body.innerHTML = `<form id="pf3" class="row x-da12f285" ><input class="x-3521b3d8" name="q" placeholder="Keyword, e.g. rezone, hotel, subdivision" ><button class="primary">Search</button></form><div id="sres"></div>`;
    const run = async () => { const r = await api('GET', '/api/signals?' + new URLSearchParams([...new FormData($('#pf3')).entries()].filter(([, v]) => v)));
      $('#sres').innerHTML = `<p class="x-57f9e31d" >${esc(r.note)}</p>` + (r.results.length ? `<div class="scroll"><table><tr><th>Item</th><th>Type</th><th>Status</th><th>Introduced</th></tr>${r.results.map(x => `<tr><td><a href="${safeUrl(x.url)}" target="_blank" rel="noopener">${esc(x.file || '')}</a> ${esc(x.title).slice(0, 220)}<br><small>${x.address ? esc(x.address) + ', ' : ''}${esc(x.city || '')}, ${esc(x.state || '')}${x.kind === 'land_use_application' ? ' · land-use application' : ' · council record'}</small></td><td><small>${esc(x.type || '')}</small></td><td><small>${esc(x.status || '')}</small></td><td>${esc((x.introDate||'').slice(0,10))}</td></tr>`).join('')}</table></div>` : '<div class="empty">No planning or zoning items in your territory yet. Coverage depends on which cities publish their council records openly.</div>'); };
    $('#pf3').onsubmit = ev => { ev.preventDefault(); run(); };
    return run();
  }
  if (t === 'searches') {
    const ss = await api('GET', '/api/searches');
    body.innerHTML = ss.length ? `<p>Each saved search emails you once a day when a matching project is new or changes stage.</p><div class="scroll"><table><tr><th>Name</th><th>Filters</th><th>Last checked</th><th class="num">Last hits</th><th></th></tr>${ss.map(x => `<tr><td>${esc(x.name)}</td><td><small>${esc(Object.entries(x.filters).map(([k,v]) => k + ': ' + v).join(' · ') || 'everything in your territory')}</small></td><td><small>${esc((x.lastRunAt||'').replace('T',' ').slice(0,16))}</small></td><td class="num">${x.lastHits ?? '—'}</td><td><button data-del="${x.id}">Delete</button></td></tr>`).join('')}</table></div>`
      : '<div class="empty">No saved searches yet. Run a search on the Projects tab and save it to get daily alerts.</div>';
    body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('DELETE', '/api/searches/' + b.dataset.del); render(); });
  }
  if (t === 'tracked') {
    const tr = await api('GET', '/api/tracked');
    body.innerHTML = tr.length ? `<div class="scroll"><table><tr><th>Project</th><th>Your stage</th><th>Project stage</th><th>Est. start</th><th>Latest note</th></tr>${tr.map(x => `<tr><td><a href="#project/${x.project.id}">${esc(x.project.title)}</a><br><small>${esc(x.project.address)}, ${esc(x.project.city)}</small></td><td>${esc(x.stage)}</td><td>${STAGE_LABEL[x.project.stage]||''}</td><td>${esc(x.project.estimatedStart||'—')}</td><td><small>${esc(x.notes.at(-1)?.text||'')}</small></td></tr>`).join('')}</table></div>`
      : '<div class="empty">Track projects from their detail page to build your pipeline here.</div>';
    body.querySelectorAll('a[href^="#project/"]').forEach(a => a.onclick = ev => { ev.preventDefault(); tab = 'projects'; location.hash = a.getAttribute('href'); render(); });
  }
  if (t === 'plan') {
    const [a, pl] = await Promise.all([api('GET', '/api/access'), api('GET', '/api/lead-plans')]);
    if (!TRADES_LIST.length) TRADES_LIST = await (await fetch('/api/trades')).json().catch(() => []);
    const prof = await api('GET', '/api/profile');
    const profHtml = `<h3>Company profile</h3><p class="x-57f9e31d" >Trades decide which bid invitations you receive. Legal name and postal address are required by law to email GCs from BUILDINTEL.</p>
      <form class="x-15db064d" id="pff" >
      <div class="x-022c8ca4" >${TRADES_LIST.map(t => `<label class="x-54ead96c" ><input class="x-30e741d9" type="checkbox" name="ptr" value="${t.key}"  ${prof.trades.includes(t.key) ? 'checked' : ''}>${esc(t.label)}</label>`).join('')}</div>
      <input name="legalName" placeholder="Legal company name" value="${esc(prof.legal.name || '')}"><input name="postalAddress" placeholder="Postal address" value="${esc(prof.legal.postalAddress || '')}">
      <input name="phone" placeholder="Phone" value="${esc(prof.profile.phone || '')}"><input name="website" placeholder="Website (https://…)" value="${esc(prof.profile.website || '')}">
      <div class="row"><button class="primary">Save profile</button><span class="x-3b74a57e" id="pfm" ></span></div></form>`;
    const pq = await api('GET', '/api/prequal/me').catch(() => null);
    const pqHtml = pq ? `<div class="panel x-905d8b3d" ><h3>${ICON.check} Your prequalification profile <small class="x-7e3a9447" >(what GCs see when they compare bids)</small></h3>
      <div class="kv"><span>General liability</span><span>${pq.insurance.generalLiability.onFile ? usd(pq.insurance.generalLiability.limit) + (pq.insurance.generalLiability.current ? '' : ' — expired') + (pq.insurance.generalLiability.verified ? ' · verified' : ' · on file') : 'none on file'}</span>
      <span>Workers comp</span><span>${pq.insurance.workersComp.onFile ? usd(pq.insurance.workersComp.limit) + (pq.insurance.workersComp.current ? '' : ' — expired') : 'none on file'}</span>
      <span>Licenses</span><span>${[...pq.stateLicenses.map(l => esc(l.state + ' ' + l.number + ' (' + (l.active ? 'active' : l.status) + ')')), ...pq.licenses.map(l => esc(l.issuer + ' ' + l.number))].join(', ') || 'none on file'}</span>
      <span>Track record</span><span>${pq.history.bidsSubmitted} bid(s) submitted · ${pq.history.awards} award(s) on BUILDINTEL</span></div>
      ${pq.flags.length ? `<p class="x-fe3c2b3b" >${esc(pq.flags.join(' · '))}. <a href="#" id="goins">Add insurance & licenses</a></p>` : '<p class="green x-c94d43e2" >No gaps.</p>'}</div>` : '';
    const np = await api('GET', '/api/me/notifications').catch(() => null);
    const notifHtml = np ? `<h3>Invitation emails</h3><p class="x-57f9e31d" >Invitations always appear in your list at once. This only controls the emails. Choose a daily digest to get at most one invitation email a day.</p>
      <form class="x-15db064d" id="nf" >
        <label>How to send invitation emails <select name="mode"><option value="immediate" ${np.mode === 'immediate' ? 'selected' : ''}>As they arrive</option><option value="daily_digest" ${np.mode === 'daily_digest' ? 'selected' : ''}>One digest a day</option></select></label>
        <label>Most invitation emails per day (1 to 20) <input name="maxPerDay" type="number" min="1" max="20" value="${Number(np.maxPerDay) || 3}"></label>
        <div><button type="submit">Save email settings</button> <span class="x-57f9e31d" id="nfm" ></span></div></form>` : '';
    body.innerHTML = pqHtml + profHtml + notifHtml + `<h3>Your territory</h3><p>${esc((a.territories||[]).join(', ') || 'none')} · ${esc(a.trade || '')}</p>
      <form id="tf" class="row x-905d8b3d" ><input class="x-aef3df2a" id="ts" placeholder="States, e.g. IA, NE, MO" value="${esc((a.territories||[]).join(', '))}" ><button>Update territory</button><span class="x-3b74a57e" id="tm" ></span></form>
      <h3>Plans</h3><div class="x-a2d253fd" >${Object.entries(pl.plans).filter(([k]) => k !== 'trial').map(([k, p]) => `<div class="x-3e0d2840" ><div class="x-afb4f0ac" >${esc(p.name)} · $${p.monthly}/mo</div><p class="x-57f9e31d" >${p.states >= 51 ? 'All states' : p.states + ' state' + (p.states > 1 ? 's' : '')} · ${p.savedSearches} saved searches · ${p.exportsPerMonth.toLocaleString()} export rows/month · ${p.seats} users</p><button class="primary" data-plan="${k}">Choose ${esc(p.name)}</button></div>`).join('')}</div><p class="x-57f9e31d" id="pm" ></p>`;
    $('#goins')?.addEventListener('click', ev => { ev.preventDefault(); tab = 'insurance'; navKey = 'insurance'; render(); });
    $('#nf')?.addEventListener('submit', async ev => { ev.preventDefault(); const f = ev.target;
      try { await api('PUT', '/api/me/notifications', { mode: f.mode.value, maxPerDay: Number(f.maxPerDay.value) }); $('#nfm').textContent = 'Saved.'; }
      catch (e) { $('#nfm').textContent = e.message; } });
    $('#pff').onsubmit = async ev => { ev.preventDefault(); const f = ev.target;
      try { await api('PATCH', '/api/profile', { trades: [...f.querySelectorAll('input[name=ptr]:checked')].map(x => x.value), legalName: f.legalName.value, postalAddress: f.postalAddress.value, phone: f.phone.value, website: f.website.value }); $('#pfm').textContent = 'Saved. Matching bid invitations will appear in Bid invitations.'; }
      catch (e) { $('#pfm').textContent = e.message; } };
    $('#tf').onsubmit = async ev => { ev.preventDefault(); try { await api('PATCH', '/api/territories', { states: $('#ts').value.split(/[ ,]+/).filter(Boolean) }); render(); } catch (e) { $('#tm').textContent = e.message; } };
    body.querySelectorAll('[data-plan]').forEach(b => b.onclick = async () => { try { const r = await api('POST', '/api/billing/checkout', { plan: b.dataset.plan }); location.href = r.url; } catch (e) { $('#pm').textContent = e.message; } });
  }
}

async function projectView(id, body) {
  if (CC.myTrades === null) CC.myTrades = (await api('GET', '/api/profile').catch(() => ({ trades: [] }))).trades || [];
  if (!TRADES_LIST.length) TRADES_LIST = await (await fetch('/api/trades')).json().catch(() => []);
  body.innerHTML = `<div class="row x-761d3add" ><a href="#" id="bk" class="link x-11696618" >← Back to projects</a></div><div class="ws2"><div id="cc-center"></div><div class="rightcol" id="cc-right"></div></div>`;
  $('#bk').onclick = ev => { ev.preventDefault(); history.replaceState(null, '', location.pathname); render(); };
  await select(id);
  if (!CC.p || CC.p.id !== id) { body.innerHTML = `<div class="empty">Project not found or outside your territory. <a href="#" id="bk2">Back to projects</a></div>`; $('#bk2').onclick = ev => { ev.preventDefault(); history.replaceState(null, '', location.pathname); render(); }; }
}

// Plain-language plan comparison on the sign-up screen. Prices come from the server and are labelled as proposed.
async function renderPlanComparison(sel) {
  const el = document.querySelector(sel); if (!el) return;
  const plans = await fetch('/api/plan-comparison').then(r => r.json()).catch(() => []);
  if (!plans.length) return;
  el.innerHTML = '<h2 class="x-54aa447e" >Choose a plan</h2>'
    + '<p class="x-f3045b1d" >What each plan includes, in plain terms. Start with the free 14-day trial.</p>'
    + '<div class="x-1cc91afd" >'
    + plans.map(p => '<div class="x-d16d5d5a" >'
      + '<h3 class="x-11696618" >' + esc(p.name) + '</h3>'
      + '<div class="x-6c21b8b4" >' + esc(p.price) + '</div>'
      + (p.priceNote ? '<small class="x-57f9e31d" >' + esc(p.priceNote) + '</small>' : '')
      + '<ul class="x-0ca2fa6d" >' + p.lines.map(l => '<li>' + esc(l) + '</li>').join('') + '</ul></div>').join('')
    + '</div>';
}
// Sign-up by role. Each role gets its own form and the account is set up for that role from the first login.
const ROLE_SIGNUP = {
  gc: { title: 'General contractor or GM', intro: 'Post bid packages, invite matching subcontractors, compare every bid side by side and award with an e-signature.', endpoint: 'buyer',
    kinds: [['general_contractor', 'General contractor'], ['construction_manager', 'Construction manager']], kindLabel: 'Your company is a' },
  owner: { title: 'Owner, developer or property manager', intro: 'Publish projects with trade packages, invite contractors, and compare and award bids with a signed record.', endpoint: 'buyer',
    kinds: [['owner', 'Building owner'], ['developer', 'Developer'], ['property_manager', 'Property manager']], kindLabel: 'You are a' },
  sub: { title: 'Subcontractor', intro: 'Get invited to bids that match the trades you perform and your territory, and find projects early from permit records.', endpoint: 'subscriber', segment: 'subcontractor' },
  service: { title: 'Service provider', intro: 'Get invited to cleaning and facility-service bids, and price matching requests with your approved rate cards.', endpoint: 'subscriber', segment: 'service_provider' },
};
const SERVICE_OPTIONS = [['post_construction', 'Post-construction cleaning'], ['janitorial', 'Janitorial & facility cleaning'], ['windows', 'Window cleaning'],
  ['pressure_washing', 'Pressure washing'], ['parking_lot', 'Parking lot & site care'], ['floor_care', 'Floor care'], ['other', 'Other facility services']];
async function roleSignupView(role) {
  const cfg = ROLE_SIGNUP[role];
  if (!TRADES_LIST.length && cfg.endpoint === 'subscriber' && cfg.segment === 'subcontractor') TRADES_LIST = await (await fetch('/api/trades')).json().catch(() => []);
  const kind = cfg.kinds ? `<label for="k">${cfg.kindLabel}<select id="k">${cfg.kinds.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>` : '';
  const trades = cfg.segment === 'subcontractor'
    ? `<fieldset class="role-set"><legend>Trades you perform (choose all that apply)</legend><div class="role-checks">${TRADES_LIST.filter(t => t.key !== 'general_contracting').map(t => `<label><input type="checkbox" name="tr" value="${t.key}"> ${esc(t.label)}</label>`).join('')}</div></fieldset>` : '';
  const services = cfg.segment === 'service_provider'
    ? `<fieldset class="role-set"><legend>Services you provide (choose all that apply)</legend><div class="role-checks">${SERVICE_OPTIONS.map(([v, l]) => `<label><input type="checkbox" name="sv" value="${v}"> ${esc(l)}</label>`).join('')}</div></fieldset>` : '';
  const state = cfg.endpoint === 'subscriber'
    ? `<label for="st">State you work in</label><input id="st" maxlength="2" placeholder="IA" required>` : '';
  $('#app').innerHTML = `<form class="login" id="sf"><h1>${esc(cfg.title)}</h1><p>${esc(cfg.intro)}</p>
  <label for="c">Company</label><input id="c" required>${kind}${trades}${services}${state}
  <label for="n">Your name</label><input id="n" required>
  <label for="e">Work email</label><input id="e" type="email" autocomplete="username" required>
  <label for="p">Password (12+ characters)</label><input id="p" type="password" minlength="12" autocomplete="new-password" required>
  <div class="err" id="le"></div><button class="primary x-0ccf4e6b" >Create account</button>
  <p class="x-86de7ac6" ><a href="/app">I already have an account</a></p></form>`;
  $('#sf').onsubmit = async ev => { ev.preventDefault(); $('#le').textContent = '';
    const picked = name => [...document.querySelectorAll(`input[name=${name}]:checked`)].map(x => x.value);
    const base = { company: $('#c').value, name: $('#n').value, email: $('#e').value, password: $('#p').value };
    try {
      let r;
      if (cfg.endpoint === 'buyer') r = await api('POST', '/api/signup/buyer', { ...base, kind: $('#k').value });
      else if (cfg.segment === 'subcontractor') r = await api('POST', '/api/signup/subscriber', { ...base, segment: cfg.segment, trades: picked('tr'), state: $('#st').value });
      else r = await api('POST', '/api/signup/subscriber', { ...base, segment: cfg.segment, services: picked('sv'), trades: ['cleaning', 'janitorial'], state: $('#st').value });
      $('#sf').innerHTML = `<h1>Check your email</h1><p>${esc(r.message)}</p><p><a href="/app">Sign in</a></p>`;
    } catch (e) { $('#le').textContent = e.message; } };
}

// In-page step links (for example "Post your first request") scroll to their form and focus its first field.
function bindFocusLinks() {
  document.querySelectorAll('[data-focus]').forEach(b => b.onclick = () => {
    const box = document.getElementById(b.dataset.focus); if (!box) return;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' }); box.querySelector('input,textarea,select')?.focus();
  });
}
// Dashboard banner: who this workspace is for, plus the setup steps that remain.
const ROLE_TEXT = {
  general_contractor: ['General contractor workspace', 'Post bid packages, invite matching subcontractors, compare bids and award contracts.'],
  construction_manager: ['General contractor workspace', 'Post bid packages, invite matching subcontractors, compare bids and award contracts.'],
  owner: ['Owner workspace', 'Publish projects with trade packages, invite contractors, and compare and award bids.'],
  developer: ['Owner workspace', 'Publish projects with trade packages, invite contractors, and compare and award bids.'],
  property_manager: ['Owner workspace', 'Publish projects with trade packages, invite contractors, and compare and award bids.'],
};
const OWNER_KINDS = ['owner', 'developer', 'property_manager'];
// Menu for each subscriber role (keys match the navigation below).
const SUB_ROLE_NAV = {
  subcontractor: ['command', 'projects', 'projects:opps', 'invitations', 'invitations:packages', 'invitations:bids', 'planroom', 'planroom:drawing', 'planroom:addenda',
    'estimates', 'contractors', 'directory', 'tracked', 'searches', 'contracts', 'insurance', 'plan', 'subscription', 'team'],
  service_provider: ['command', 'projects:opps', 'invitations', 'invitations:bids', 'rates', 'estimates', 'contractors', 'tracked', 'searches', 'contracts', 'insurance', 'plan', 'subscription', 'team'],
};
const SEGMENT_TEXT = {
  subcontractor: ['Subcontractor workspace', 'Invitations and projects that match your trades and territory.'],
  service_provider: ['Service provider workspace', 'Cleaning and facility-service bids in your territory. Approved rate cards price matching requests.'],
};
function roleBannerHtml(org, steps = []) {
  const text = org.kind === 'buyer' ? ROLE_TEXT[org.buyerKind] : SEGMENT_TEXT[org.segment];
  if (!text) return '';
  const done = steps.filter(x => x[1]).length;
  const list = steps.map(([label, ok, target]) => {
    const name = esc(label);
    const link = ok || !target ? name : target.startsWith('#') ? `<button type="button" class="linkish" data-focus="${target.slice(1)}">${name}</button>` : `<a href="#" data-goto="${target}">${name}</a>`;
    return `<li class="${ok ? 'done' : ''}"><span aria-hidden="true">${ok ? '✓' : '○'}</span>${link}</li>`;
  }).join('');
  return `<section class="role-banner" aria-label="Your workspace"><div><small>${done} of ${steps.length} setup steps done</small><h2>${text[0]}</h2><p>${text[1]}</p></div>${steps.length ? `<ol class="role-steps">${list}</ol>` : ''}</section>`;
}
const sv = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  home: sv('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'), pin: sv('<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  layers: sv('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'), file: sv('<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 17h6"/>'),
  users: sv('<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4a3 3 0 010 6M21 20c0-2.6-1.5-4.8-3.7-5.6"/>'),
  brief: sv('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2"/>'), send: sv('<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>'),
  gear: sv('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>'),
  search: sv('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'), bell: sv('<path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 003.4 0"/>'),
  building: sv('<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2M10 21v-3h4v3"/>'),
  trend: sv('<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>'), doc: sv('<path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/>'), clip: sv('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M9 12h6M9 16h4"/>'),
  money: sv('<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>'), us: sv('<path d="M3 8l4-2 5 1 4-1 5 2v8l-3 2-5-1-3 2-4-1-3-2z"/>'),
  spark: sv('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'), star: sv('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>'),
  help: sv('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 .5c0 1.7-2.5 2-2.5 3.5M12 17h.01"/>'),
  apps: sv('<circle cx="5" cy="5" r="1.5"/><circle cx="12" cy="5" r="1.5"/><circle cx="19" cy="5" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="19" r="1.5"/><circle cx="12" cy="19" r="1.5"/><circle cx="19" cy="19" r="1.5"/>'),
  award: sv('<circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/>'), chart: sv('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  mail: sv('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'), phone: sv('<path d="M5 3h4l2 5-2.5 1.5a11 11 0 006 6L16 13l5 2v4a2 2 0 01-2 2A17 17 0 013 5a2 2 0 012-2"/>'),
  plus: sv('<path d="M12 5v14M5 12h14"/>'), grid: sv('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'),
  people: sv('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>'), box: sv('<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/>'),
  clock: sv('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'), check: sv('<path d="M5 12l5 5 9-10"/>'), calc: sv('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h2M16 11h0M8 15h2M12 15h2M8 18h2M12 18h2"/>'),
  logo: `<svg viewBox="0 0 36 36" width="34" height="34" aria-hidden="true"><rect x="3" y="12" width="7" height="21" fill="#f5b301"/><rect x="12" y="5" width="8" height="28" fill="#f5b301"/><rect x="22" y="15" width="7" height="18" fill="#f5b301"/><path d="M2 33h32" stroke="#f5b301" stroke-width="2"/></svg>`,
};
let TRADES_LIST = [];
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise(res => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/leaflet.css'; document.head.appendChild(css);
    const js = document.createElement('script'); js.src = '/vendor/leaflet.js'; js.onload = res; js.onerror = res; document.head.appendChild(js);
  });
}
const kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
async function planRoomHtml(requestId) {
  let docs = []; try { docs = await api('GET', `/api/requests/${requestId}/documents`); } catch { return ''; }
  if (!docs.length) return '<small class="x-57f9e31d" >No plans uploaded yet.</small>';
  const groups = {}; docs.forEach(d => (groups[d.discipline] ||= []).push(d));
  return `<div class="x-358d84e0" ><strong>Plan room</strong> <small>${docs.length} file(s) · ${esc(docs[0].rights)}</small>
    ${Object.entries(groups).map(([g, ds]) => `<div class="x-fe7b4979" ><small><strong>${esc(g)}</strong></small>${ds.map(d => `<small><a href="#" data-doc-open="${d.id}">${esc(d.sheet ? d.sheet + ' — ' + d.title : d.name)}</a> · ${kb(d.size)}${d.addendum ? ` · <strong class="x-323fe151" >Addendum ${d.addendum}</strong>` : ''}${d.kind === 'drawing' ? ` · <a href="#" data-measure="${d.id}">Measure</a> · <a href="#" data-ai="${d.id}">AI analysis</a>` : ''}</small><div id="ai-${d.id}"></div>`).join('')}</div>`).join('')}</div>`;
}
function aiPanel(a) {
  const r = a.result, unv = a.status !== 'verified';
  return `<div data-style="border-left:3px solid ${unv ? 'var(--owner)' : 'var(--pass)'};padding:6px 10px;margin:4px 0 8px;background:var(--bg)">
    <small><strong>${unv ? 'Unverified AI reading — confirm against the drawing before using it' : 'Verified by ' + esc(a.verifiedBy) + ' ' + ago(a.verifiedAt)}</strong> · model ${esc(a.model)} · confidence ${esc(r.confidence)} · ${ago(a.createdAt)}</small>
    <small>${r.totals.roomsFound} room(s) found · ${r.totals.roomsWithPrintedArea} with a printed area${r.totals.printedAreaSqFt ? ' · printed total ' + r.totals.printedAreaSqFt.toLocaleString() + ' SF' : ''}. Areas not printed on the sheet are left blank, never estimated.</small>
    ${r.rooms.length ? `<div class="scroll"><table><tr><th>Room</th><th>Level</th><th class="num">Area (SF)</th><th>Source</th></tr>${r.rooms.map(x => `<tr><td>${esc([x.number, x.name].filter(Boolean).join(' '))}</td><td>${esc(x.level || '')}</td><td class="num">${x.areaSqFt ? x.areaSqFt.toLocaleString() : '<small>not stated</small>'}</td><td>${esc(x.sheet || '?')}</td></tr>`).join('')}</table></div>` : ''}
    ${r.finishes.length ? `<small><strong>Finishes:</strong> ${r.finishes.map(x => esc(`${x.item}${x.location ? ' (' + x.location + ')' : ''} [${x.sheet || '?'}]`)).join(' · ')}</small>` : ''}
    ${r.scopes.length ? `<small><strong>Scopes:</strong> ${r.scopes.map(x => esc(`${x.trade}: ${x.note} [${x.sheet || '?'}]`)).join(' · ')}</small>` : ''}
    ${r.notes.length ? `<small><strong>Notes:</strong> ${r.notes.map(esc).join(' · ')}</small>` : ''}
    ${unv ? `<div class="row x-96ad6099" ><button data-verify="${a.id}" data-doc="${a.documentId}">I checked it against the drawing — confirm</button></div>` : `<div class="row x-96ad6099" ><button class="primary" data-est-from="${a.id}">Start estimate from these quantities</button></div>`}</div>`;
}
function bindAi(root) {
  root.querySelectorAll('[data-ai]').forEach(link => link.onclick = async ev => { ev.preventDefault();
    const id = link.dataset.ai, box = document.getElementById('ai-' + id);
    const show = a => { box.innerHTML = aiPanel(a); box.querySelectorAll('[data-verify]').forEach(b => b.onclick = async () => { const v = await api('POST', `/api/analyses/${b.dataset.verify}/verify`, {}); show(v); });
      box.querySelectorAll('[data-est-from]').forEach(b => { const holder = b.closest('[data-inv]'); if (!holder) { b.remove(); return; }
        b.onclick = async () => { try { const e = await api('POST', '/api/estimates', { analysisId: b.dataset.estFrom, invitationId: holder.dataset.inv }); openEstimate(holder.dataset.inv, e); } catch (err) { b.insertAdjacentHTML('afterend', `<small class="x-ce711e4f" >${esc(err.message)}</small>`); } }; }); };
    try { const prior = await api('GET', `/api/documents/${id}/analyses`);
      if (prior.length) return show(prior[0]);
      box.innerHTML = '<small>Reading the drawing… (up to a minute)</small>';
      show(await api('POST', `/api/documents/${id}/analyze`));
    } catch (e) { box.innerHTML = `<small class="x-ce711e4f" >${esc(e.message)}</small>`; } });
}
let RATECARDS = null;
async function openEstimate(invId, e, opts = {}) {
  const box = document.getElementById('est-' + invId); if (!box) return;
  if (RATECARDS === null) RATECARDS = (await api('GET', '/api/rate-cards').catch(() => [])).filter(r => r.status === 'approved' && r.unit === 'sqft');
  let lines = e ? e.lines.map(l => ({ ...l })) : [{ kind: 'manual', description: '', qty: '', unit: 'SF', laborUnit: 0, materialUnit: 0, wastePct: 0, source: { type: 'manual' } }];
  let id = e?.id || null, ovh = e?.overheadPct ?? 0.1, pro = e?.profitPct ?? 0.1, totals = e?.totals || null;
  const submitted = e?.status === 'submitted';
  const units = ['SF', 'LF', 'EA', 'HR', 'LS', 'SY', 'CY'];
  const srcTxt = l => l.source?.type === 'drawing' ? `sheet ${esc(l.source.sheet || '?')}${l.source.room ? ' · ' + esc(l.source.room) : ''}${l.source.adjusted ? ' · adjusted' : ''}` : 'manual';
  const draw = msg => {
    box.innerHTML = `<div class="x-f27ee503" ><strong>Estimate</strong> ${submitted ? '<small>Submitted as your bid.</small>' : ''}
      <div class="scroll"><table><tr><th>Item</th><th class="num">Qty</th><th>Unit</th><th class="num">Labor $/unit</th><th class="num">Material $/unit</th><th class="num">Waste %</th><th class="num">Price</th><th>Source</th></tr>
      ${lines.map((l, n) => l.kind === 'ratecard' ? `<tr><td><input data-f="description" data-n="${n}" value="${esc(l.description)}"></td><td><input class="x-581be415" data-f="qty" data-n="${n}" value="${esc(l.qty)}" ></td><td>SF</td><td colspan="3"><select data-f="rateCardId" data-n="${n}">${RATECARDS.map(rc => `<option value="${rc.id}" ${rc.id === l.rateCardId ? 'selected' : ''}>${esc(rc.serviceName)} v${rc.version}</option>`).join('')}</select></td><td class="num">${l.price != null ? money(l.price) : ''}</td><td><small>rate card</small></td></tr>`
        : `<tr><td><input data-f="description" data-n="${n}" value="${esc(l.description)}"></td><td><input class="x-581be415" data-f="qty" data-n="${n}" value="${esc(l.qty)}" ></td><td><select data-f="unit" data-n="${n}">${units.map(u => `<option ${u === l.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></td>
        <td><input class="x-8573bae3" data-f="laborUnit" data-n="${n}" value="${esc(l.laborUnit)}" ></td><td><input class="x-8573bae3" data-f="materialUnit" data-n="${n}" value="${esc(l.materialUnit)}" ></td><td><input class="x-bd09c419" data-f="wastePct" data-n="${n}" value="${esc(Math.round((l.wastePct || 0) * 100))}" ></td>
        <td class="num">${l.price != null ? money(l.price) : ''}</td><td><small>${srcTxt(l)}</small></td></tr>`).join('')}</table></div>
      ${submitted ? '' : `<div class="row x-fe7b4979" ><button data-addline>+ Line</button>${RATECARDS.length ? '<button data-addrc>+ Rate-card line</button>' : ''}
        <label class="x-433de30b" >Overhead % <input class="x-bd09c419" id="ovh-${invId}" value="${Math.round(ovh * 100)}" ></label><label class="x-433de30b" >Profit % <input class="x-bd09c419" id="pro-${invId}" value="${Math.round(pro * 100)}" ></label>
        <button data-save>Save & calculate</button>${opts.project ? '<button class="primary" data-prop>Create proposal</button>' : '<button class="primary" data-submit>Submit as bid</button>'}</div>`}
      ${totals ? `<small>Labor & material ${money(totals.manualSubtotal)} · overhead ${money(totals.overhead)} · profit ${money(totals.profit)}${totals.rateCardSubtotal ? ' · rate-card lines ' + money(totals.rateCardSubtotal) : ''} · <strong>Total ${money(totals.total)}</strong></small>` : ''}
      <small class="err">${msg ? esc(msg) : ''}</small></div>`;
    if (submitted) box.querySelectorAll('[data-f]').forEach(inp => inp.disabled = true);
    box.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => { const l = lines[inp.dataset.n]; const f = inp.dataset.f; l[f] = f === 'wastePct' ? Number(inp.value) / 100 : inp.value; });
    const add = kind => { lines.push(kind === 'ratecard' ? { kind, description: RATECARDS[0].serviceName, qty: '', rateCardId: RATECARDS[0].id } : { kind, description: '', qty: '', unit: 'SF', laborUnit: 0, materialUnit: 0, wastePct: 0, source: { type: 'manual' } }); draw(); };
    box.querySelector('[data-addline]')?.addEventListener('click', () => add('manual'));
    box.querySelector('[data-addrc]')?.addEventListener('click', () => add('ratecard'));
    const save = async () => {
      ovh = Number($('#ovh-' + invId).value) / 100; pro = Number($('#pro-' + invId).value) / 100;
      if (!id) { /* manual estimate: create through the takeoff API by saving lines on a fresh record */ const r = await api('POST', '/api/estimates/manual', { invitationId: invId }); id = r.id; }
      const r = await api('PATCH', '/api/estimates/' + id, { lines, overheadPct: ovh, profitPct: pro });
      lines = r.lines.map(l => ({ ...l })); totals = r.totals; e = r; return r;
    };
    box.querySelector('[data-save]')?.addEventListener('click', async () => { try { await save(); draw(); } catch (err) { draw(err.message); } });
    box.querySelector('[data-prop]')?.addEventListener('click', async () => { try { await save(); openProposal(id); } catch (err) { draw(err.message); } });
    box.querySelector('[data-submit]')?.addEventListener('click', async () => { try { await save(); await api('POST', `/api/estimates/${id}/submit`, {}); render(); } catch (err) { draw(err.message); } });
  };
  draw();
}
async function showCompare(fromId, toId, box) {
  box.innerHTML = '<small>Comparing…</small>';
  try { const c = await api('GET', `/api/planroom/compare?from=${fromId}&to=${toId}`);
    box.innerHTML = `<div class="panel x-c1fafc23" ><b>${esc(c.from.label)} → ${esc(c.to.label)}</b> <small>${c.pagesChanged} page(s) with text changes · ${esc(c.note)}</small>
      ${c.pages.map(pg => `<div class="x-fe7b4979" ><small><b>Page ${pg.page}</b></small>${pg.removed.map(l => `<div class="x-0cbff10b" >− ${esc(l)}</div>`).join('')}${pg.added.map(l => `<div class="x-c50a90ce" >+ ${esc(l)}</div>`).join('')}</div>`).join('') || '<small>No text changes found.</small>'}</div>`;
  } catch (e) { box.innerHTML = `<small class="x-ce711e4f" >${esc(e.message)}</small>`; }
}
function bindCompare(root) { root.querySelectorAll('[data-cmp]').forEach(a => a.onclick = ev => { ev.preventDefault(); const [f, t2] = a.dataset.cmp.split('|'); showCompare(f, t2, document.getElementById('cmp-' + t2)); }); }
function bindDocOpen(root) {
  bindAi(root);
  root.querySelectorAll('[data-measure]').forEach(a => a.onclick = ev => { ev.preventDefault(); openTakeoff(a.dataset.measure, { permitId: tab === 'command' && CC.p ? CC.p.id : null }); });
  root.querySelectorAll('[data-doc-open]').forEach(a => a.onclick = async ev => { ev.preventDefault(); try { const r = await api('POST', `/api/documents/${a.dataset.docOpen}/link`); window.open(r.url, '_blank', 'noopener'); } catch (e) { a.textContent += ' (' + e.message + ')'; } });
}
// ---------------- Project Publishing Center (publisher side) ----------------
const REL_LABEL = { owner: 'Owner', developer: 'Developer', gc_of_record: 'General contractor of record', property_manager: 'Property manager for the owner', construction_manager: 'Construction manager (for the owner)', architect_for_owner: 'Architect/engineer authorized by the owner', agent_for_owner: 'Other agent authorized by the owner' };
const NEEDS_EV = ['construction_manager', 'architect_for_owner', 'agent_for_owner'];
// Preselect the relationship that matches the company type (never default a property manager to "Owner").
const KIND_REL = { owner: 'owner', public_agency: 'owner', developer: 'developer', general_contractor: 'gc_of_record', property_manager: 'property_manager', construction_manager: 'construction_manager', architect_engineer: 'architect_for_owner' };
const pubPill = st2 => `<span class="pill ${{ published: 'green', draft: 'amber', closed: '', archived: '' }[st2] || ''}">${esc(st2)}</span>`;
async function publisherPanels() {
  const pinfo = await api('GET', '/api/publisher').catch(() => null); if (!pinfo) return;
  const v = pinfo.publisher || {};
  $('#verc').innerHTML = pinfo.verified ? `<div class="card x-2b583d73" ><span class="pill green">Verified publisher</span> <small>${esc(v.note || '')}</small></div>`
    : `<div class="card x-36ec1aea" ><h3>${ICON.check} Publisher verification ${v.status === 'pending' ? '<span class="pill amber">pending review</span>' : v.status === 'rejected' ? '<span class="pill red">not approved</span>' : ''}</h3>
      <p class="x-d462248a" >BUILDINTEL checks that your company can publish construction projects before bidders see them (a confirmed email isn't proof of authority). You can prepare drafts meanwhile.${v.note ? ' Reviewer note: ' + esc(v.note) : ''}</p>
      ${v.status === 'pending' ? `<small>Submitted ${fmtDate(v.requestedAt)} — we'll review it.</small>` : `<form id="vf" class="grid2"><input name="website" placeholder="Company website (https://…)"><input name="licenseNumber" placeholder="Contractor license / business registration #"><input name="phone" placeholder="Office phone"><input name="notes" placeholder="Anything that helps us verify you"><div class="row"><button class="primary">Request verification</button><span class="err"></span></div></form>`}</div>`;
  $('#vf')?.addEventListener('submit', async ev => { ev.preventDefault(); const f = ev.target;
    try { await api('POST', '/api/publisher/verification', { website: f.website.value.trim(), licenseNumber: f.licenseNumber.value.trim(), phone: f.phone.value.trim(), notes: f.notes.value.trim() }); publisherPanels(); } catch (e) { f.querySelector('.err').textContent = e.message; } });
  const pubs = await api('GET', '/api/publications').catch(() => []);
  $('#pubc').innerHTML = `<div class="card x-87c136df" ><div class="row x-a562f4fd" ><h2>${ICON.building} Project Publishing Center</h2><button class="primary" id="newpub">${ICON.plus} New project</button></div>
    <p class="x-67fc00b7" >Publish a project with separate trade packages, plan rooms and bidder lists. Nothing is visible to bidders until you publish.</p><div id="newpubf"></div>
    ${pubs.length ? `<div class="scroll"><table><tr><th>Project</th><th>Status</th><th class="num">Packages</th><th class="num">Invited</th><th class="num">Opened plans</th><th class="num">Will bid</th><th class="num">Bids</th><th></th></tr>${pubs.map(p => `<tr><td><b>${esc(p.title)}</b><br><small>${esc(p.address)}, ${esc(p.city)}, ${esc(p.state)}${p.projectId ? ' · ' + esc(p.projectId) : ''}</small></td><td>${pubPill(p.status)}</td>
      <td class="num">${p.totals.packages}</td><td class="num">${p.totals.invited}</td><td class="num">${p.totals.openedPlans}</td><td class="num">${p.totals.willBid}</td><td class="num">${p.totals.bids}</td><td><button data-pubopen="${p.id}">Manage</button></td></tr>`).join('')}</table></div>` : '<div class="empty">No projects yet. Use <b>New project</b>.</div>'}
    <div id="pubm"></div></div>`;
  $('#newpub').onclick = () => {
    $('#newpubf').innerHTML = `<form id="npf" class="panel x-970f4ddb" ><b>New project</b>
      <div class="grid2"><input name="title" placeholder="Project name" required><input name="address" placeholder="Street address" required><input name="city" placeholder="City" required><input name="state" placeholder="State (2 letters)" maxlength="2" required>
      <select name="projectType">${['office','retail','warehouse','industrial','multifamily','medical','education','hospitality','restaurant','institutional','mixed_use','other_commercial'].map(x => `<option>${x}</option>`).join('')}</select>
      <input name="estValue" type="number" placeholder="Estimated value ($, optional)"><input name="buildingSf" type="number" placeholder="Building size (SF, optional)">
      <input name="owner" placeholder="Owner (optional)"><input name="architect" placeholder="Architect (optional)"></div>
      <textarea name="description" rows="2" placeholder="Project description"></textarea>
      <label><small>Your company's relationship to this project</small><select name="relationship">${Object.entries(REL_LABEL).map(([k, l]) => `<option value="${k}" ${k === KIND_REL[pinfo.kind] ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <input name="authorizationEvidence" placeholder="Authorization from the owner (required for CM / architect / other agent): letter, contract reference or link">
      <div class="row"><button class="primary">Create draft</button><span class="err"></span></div></form>`;
    $('#npf').onsubmit = async ev => { ev.preventDefault(); const f = ev.target; const b = Object.fromEntries(new FormData(f).entries());
      try { const p = await api('POST', '/api/publications', b); $('#newpubf').innerHTML = ''; await publisherPanels(); openPublication(p.id); } catch (e) { f.querySelector('.err').textContent = e.message; } };
  };
  document.querySelectorAll('[data-pubopen]').forEach(b => b.onclick = () => openPublication(b.dataset.pubopen));
  // team & subscription
  const users = await api('GET', '/api/org/users').catch(() => []), sub = await api('GET', '/api/subscription').catch(() => null);
  const isOwner = me.user.role === 'owner';
  $('#teamc').innerHTML = `<h3>${ICON.users} Team & permissions</h3><div class="scroll"><table><tr><th>User</th><th>Role</th><th>Permissions</th></tr>${users.map(u => `<tr><td>${esc(u.email)}${u.disabled ? ' <span class="pill">disabled</span>' : ''}</td><td>${esc(u.role)}</td><td>${u.role === 'owner' ? '<small>all</small>' : (isOwner ? ['publish', 'upload', 'invite', 'award', 'billing', 'users'].map(pm => `<label class="x-443f6684" ><input class="x-30e741d9" type="checkbox"  data-perm="${u.id}" value="${pm}" ${u.permissions.includes(pm) ? 'checked' : ''}>${pm}</label>`).join('') : esc(u.permissions.join(', ')))}</td></tr>`).join('')}</table></div>
    ${isOwner ? `<form id="tuf" class="row x-8a77e5a3" ><input class="x-a828909e" name="email" placeholder="email" ><input class="x-2089d521" name="password" type="password" placeholder="temporary password (12+)" ><button>Add member</button><span class="err"></span></form>` : ''}
    <small>${sub ? `Seats: ${sub.usage.seatsUsed} of ${sub.entitlements.seats}` : ''}</small>`;
  document.querySelectorAll('[data-perm]').forEach(c => c.onchange = async () => { const id = c.dataset.perm; const perms = [...document.querySelectorAll(`[data-perm="${id}"]:checked`)].map(x => x.value);
    try { await api('PATCH', '/api/org/users/' + id, { permissions: perms }); } catch (e) { alertBox(esc(e.message)); publisherPanels(); } });
  $('#tuf')?.addEventListener('submit', async ev => { ev.preventDefault(); const f = ev.target;
    try { await api('POST', '/api/org/users', { email: f.email.value.trim(), password: f.password.value, role: 'member', permissions: ['upload', 'invite'] }); publisherPanels(); } catch (e) { f.querySelector('.err').textContent = e.message; } });
  if (sub) $('#subc').innerHTML = subscriptionHtml(sub);
}
function subscriptionHtml(sub) {
  const e = sub.entitlements, u = sub.usage;
  return `<h3>${ICON.money} Subscription</h3><p><b>${esc(e.name || e.plan)}</b> ${e.monthly ? '· ' + usd(e.monthly) + '/month' : '· free'}${e.ok ? '' : ` <span class="pill red">${esc(e.reason)}</span>`}</p>
    <div class="kv"><span>Seats</span><span>${u.seatsUsed} of ${e.seats ?? '—'}</span>${e.activePublications != null ? `<span>Active projects</span><span>${u.activePublications} of ${e.activePublications}</span>` : ''}${e.markets != null ? `<span>Markets</span><span>${e.markets >= 51 ? 'national' : e.markets}</span>` : ''}<span>AI analyses today</span><span>${u.aiToday} of ${e.aiPerDay ?? 0}</span>${e.exportsPerMonth != null ? `<span>Export rows this month</span><span>${u.exportRowsThisMonth} of ${e.exportsPerMonth}</span>` : ''}</div>
    <h3 class="x-d2c171b1" >Plans</h3><div class="scroll"><table><tr><th>Plan</th><th class="num">Monthly</th><th>Includes</th></tr>${sub.catalog.map(c => `<tr class="x-3b7ad657"${c.key === e.plan ? ' ' : ''}><td>${esc(c.name)}</td><td class="num">${c.monthly == null ? 'custom' : c.monthly ? usd(c.monthly) : 'free'}</td><td><small>${c.seats} seat(s)${c.activePublications != null ? ` · ${c.activePublications} active projects` : ''}${c.markets != null ? ` · ${c.markets >= 51 ? 'national' : c.markets + ' market(s)'}` : ''}${c.aiPerDay ? ` · ${c.aiPerDay} AI/day` : ''}</small></td></tr>`).join('')}</table></div>
    <small>Prices: ${esc(sub.priceStatus)}. Payments start once Stripe is connected; upgrades and billing history appear here.</small>`;
}
async function openPublication(id) {
  const box = $('#pubm'); const c = await api('GET', '/api/publications/' + id);
  const p = c.publication, draft = p.status === 'draft';
  box.innerHTML = `<div class="panel x-56f43562" ><div class="row x-a562f4fd" ><h3 class="x-11696618" >${esc(p.title)} ${pubPill(p.status)}</h3><span class="row">
      ${['draft', 'published'].includes(p.status) ? `<button class="primary" id="pbpub" ${c.checklist.ready ? '' : 'title="Complete the checklist first"'}>${p.status === 'draft' ? 'Publish' : 'Publish new packages'}</button>` : ''}
      ${p.status === 'published' ? '<button data-pst="closed">Close bidding</button>' : ''}${p.status === 'closed' ? '<button data-pst="published">Reopen</button><button data-pst="archived">Archive</button>' : ''}${p.status === 'draft' ? '<button data-pst="archived">Discard draft</button>' : ''}</span></div>
    <small>${esc(REL_LABEL[p.authority?.relationship] || '')}${p.authority?.evidence ? ' · authorization: ' + esc(p.authority.evidence) : ''}${p.projectId ? ' · project ' + esc(p.projectId) : ''}</small>
    <h3 class="x-d2c171b1" >Checklist</h3><ul class="checks">${c.checklist.items.map(i => `<li><span class="dot ${i.ok ? 'ok' : 'no'}">${i.ok ? '✓' : '–'}</span><span>${esc(i.label)} <small>${esc(i.detail || '')}</small></span></li>`).join('')}</ul><div class="err" id="pberr"></div>
    <h3 class="x-d2c171b1" >Trade packages & coverage</h3>
    ${c.packages.length ? `<div class="scroll"><table><tr><th>Package</th><th>Status</th><th>Due</th><th>Distribution</th><th class="num">Docs</th><th class="num">Invited</th><th class="num">Opened plans</th><th class="num">Will bid</th><th class="num">Bids</th><th></th></tr>${c.packages.map(k => `<tr><td><b>${esc(k.title)}</b><br><small>${esc((k.trades || []).map(t => (TRADES_LIST.find(x => x.key === t) || {}).label || t).join(', '))}</small></td>
      <td>${pubPill(k.status)}${k.blockers ? `<br><small class="x-ce711e4f" >${esc(k.blockers)}</small>` : ''}</td><td>${fmtDate(k.dueDate)}</td>
      <td><small>${k.distribution === 'invite_only' ? `invite-only · ${k.inviteeCount} on list` : `eligible subscribers${k.inviteeCount ? ' + ' + k.inviteeCount + ' on list' : ''}`}</small></td>
      <td class="num">${{ uploaded: `${k.documents}<br><small>${esc(k.currentRevision)}</small>`, intentionally_none: '<small>none (intentional)</small>', to_follow: '<small>to follow</small>', missing: '<small class="x-ce711e4f" ><b>missing</b></small>' }[k.documentsState]}</td><td class="num">${k.invited}</td><td class="num">${k.openedPlans}</td><td class="num">${k.willBid}</td><td class="num">${k.bids}</td>
      <td>${k.status === 'draft' ? `<button data-nodocs="${k.id}">No documents needed</button> <button data-pkdel="${k.id}">Remove</button>` : ''} <button data-pkinv="${k.id}">Invite bidders</button></td></tr><tr><td class="x-fd8f71c4" colspan="10" ><div id="pkinv-${k.id}"></div></td></tr>`).join('')}</table></div><small>Upload plans for each package in “Your requests” below (each package is listed there with its plan room).</small>` : '<div class="empty">No packages yet.</div>'}
    ${['draft', 'published'].includes(p.status) ? `<form id="pkf" class="panel x-3a011d71" ><b>Add a trade package</b>
      <div class="grid2"><input name="title" placeholder="Package name (e.g. Electrical)" required><label><small>Bids due</small><input name="dueDate" type="date" required></label>
      <select name="trade">${TRADES_LIST.map(t => `<option value="${t.key}">${esc(t.label)}</option>`).join('')}</select>
      <select name="distribution"><option value="eligible">Eligible subscribers (matching trade & area) + my list</option><option value="invite_only">Invite-only (my list)</option></select></div>
      <textarea name="description" rows="2" placeholder="Scope of work (20+ characters)"></textarea><div class="grid2"><textarea name="inclusions" rows="2" placeholder="Inclusions"></textarea><textarea name="exclusions" rows="2" placeholder="Exclusions"></textarea></div>
      <div class="row"><button class="primary">Add package</button><span class="err"></span></div></form>` : ''}</div>`;
  const reload = async () => { await publisherPanels(); openPublication(id); };
  $('#pbpub')?.addEventListener('click', async () => { try { const r = await api('POST', `/api/publications/${id}/publish`); alertBox(`Published: ${r.packagesOpened} package(s) opened, ${r.invited} compan(ies) invited.`); reload(); } catch (e) { $('#pberr').textContent = e.message; } });
  box.querySelectorAll('[data-pst]').forEach(b => b.onclick = async () => { try { await api('POST', `/api/publications/${id}/status`, { status: b.dataset.pst }); reload(); } catch (e) { $('#pberr').textContent = e.message; } });
  box.querySelectorAll('[data-nodocs]').forEach(b => b.onclick = async () => { await api('PATCH', '/api/packages/' + b.dataset.nodocs, { noDocuments: true }); reload(); });
  box.querySelectorAll('[data-pkdel]').forEach(b => b.onclick = async () => { await api('DELETE', '/api/packages/' + b.dataset.pkdel); reload(); });
  box.querySelectorAll('[data-pkinv]').forEach(b => b.onclick = () => { const kid = b.dataset.pkinv, k = c.packages.find(x => x.id === kid), el = $('#pkinv-' + kid);
    el.innerHTML = `<div class="panel x-c1fafc23" ><div class="row"><input class="x-55585d51" id="bq-${kid}" placeholder="Search bidders by company name" ><button id="bs-${kid}">Search ${esc(p.state)} ${esc((k.trades || [])[0] || '')} companies</button></div><div id="br-${kid}"></div></div>`;
    $('#bs-' + kid).onclick = async () => { const r = await api('GET', `/api/bidders?state=${encodeURIComponent(p.state)}&trade=${encodeURIComponent((k.trades || [])[0] || '')}&q=${encodeURIComponent($('#bq-' + kid).value)}`);
      $('#br-' + kid).innerHTML = r.length ? r.map(x => `<div class="contact"><b>${esc(x.name)}</b> <small>${esc(x.trades.join(', '))} · ${esc(x.states.join(', '))}</small> <button data-addinv="${x.id}">Invite</button></div>`).join('') : '<small>No matching companies yet.</small>';
      $('#br-' + kid).querySelectorAll('[data-addinv]').forEach(btn => btn.onclick = async () => { await api('PATCH', '/api/packages/' + kid, { invitees: [btn.dataset.addinv] }); btn.replaceWith(document.createTextNode(k.status === 'open' ? 'invited' : 'added to list')); }); };
  });
  $('#pkf')?.addEventListener('submit', async ev => { ev.preventDefault(); const f = ev.target;
    try { await api('POST', `/api/publications/${id}/packages`, { title: f.title.value, dueDate: f.dueDate.value, trades: [f.trade.value], distribution: f.distribution.value, description: f.description.value, inclusions: f.inclusions.value, exclusions: f.exclusions.value }); reload(); }
    catch (e) { f.querySelector('.err').textContent = e.message; } });
}

async function buyerView() {
  if (!TRADES_LIST.length) TRADES_LIST = await (await fetch('/api/trades')).json().catch(() => []);
  const verified = me.org.status === 'active';
  const myRequests = await api('GET', '/api/requests').catch(() => []);
  const steps = [['Confirm your email', verified, null], ['Add your company details', !!(me.org.legal && Object.keys(me.org.legal).length), null], ['Company verified to publish', me.org.publisher?.status === 'verified', '#pubc'], ['Post your first request', myRequests.length > 0, '#rf'], ['Invite contractors to a package', myRequests.some(r => (r.invited || 0) > 0), '#rf']];
  $('#app').innerHTML = `<div class="wrap"><header><h1>BUILDINTEL</h1><span class="who">${esc(me.org.name)} · ${esc(me.user.email)} <button id="lo">Sign out</button></span></header>
  ${roleBannerHtml(me.org, steps)}
  ${verified ? '' : '<div class="empty x-49f14f8f" >Confirm your email to post requests. Check your inbox for the link.</div>'}
  <div id="verc"></div><div id="pubc"></div>
  <div class="sign x-6384e367" ><div><h2>Quick post: one trade package</h2><p>For a single trade. For a full project with several trade packages and plan rooms, use <b>New project</b> above. BUILDINTEL invites every matching contractor in that area; they answer will-bid / won't-bid and submit bids here.</p>
  <form class="x-fcc9f9e7" id="rf" >
   <div class="x-0edf7ec4" >
   <input id="t" placeholder="Project title" required><input id="a" placeholder="Street address" required><input id="ci" placeholder="City" required><input id="st" placeholder="State" maxlength="2" required>
   <select id="pt">${['office','retail','warehouse','industrial','multifamily','medical','education','hospitality','restaurant','institutional','mixed_use','other_commercial'].map(x=>`<option>${x}</option>`).join('')}</select>
   <label class="x-bbe2ad4b" >Bids due<input id="dd" type="date" required></label>
   <input id="docs" placeholder="Link to plans & specs (optional)">${me.org.buyerKind === 'construction_manager' ? '<input id="authev" placeholder="Owner authorization: letter or contract reference (required when you post for an owner)">' : ''}</div>
   <div class="x-d461c96d" ><input id="pjq" placeholder="Link to an existing BUILDINTEL project (optional): type 3+ letters of the name or address, after the state" autocomplete="off"><input type="hidden" id="pjid">
     <div id="pjres" class="panel x-ac51a92a" ></div><small class="x-6f28f390" id="pjsel" ></small></div>
   <textarea class="x-3de47ccc" id="ds" rows="3" placeholder="Scope / notes for bidders" ></textarea>
   <fieldset class="x-79559915" ><legend class="x-17d902bf" >Trades needed</legend><div class="x-022c8ca4" >${TRADES_LIST.map(t => `<label class="x-54ead96c" ><input class="x-30e741d9" type="checkbox" name="tr" value="${t.key}" >${esc(t.label)}</label>`).join('')}</div></fieldset>
   <details><summary class="x-3b6a3a65" >Also get instant cleaning prices (optional)</summary><div class="x-4e33256f" >
     <select id="sv"><option value="">No instant pricing</option><option value="post_construction">Post-construction clean</option><option value="janitorial">Recurring janitorial</option><option value="windows">Windows</option><option value="floor_care">Floor care</option><option value="pressure_washing">Pressure washing</option></select>
     <input id="sf2" type="number" min="1" placeholder="Square feet"><input id="fq" type="number" min="1" placeholder="Visits per month (janitorial)"></div></details>
   <button class="primary x-27af8985" ${verified?'':'disabled'} >Post request</button></form><div class="err" id="re"></div></div></div>
  <div id="sumstrip"></div><div class="card bidders-card" id="bidders"></div><div class="card" id="analytics"></div><h2 class="x-d1cd810f" >${OWNER_KINDS.includes(me.org.buyerKind) ? 'Your projects' : 'Your bid packages'}</h2><section id="body"></section>
  <h2 class="x-855107b5" >Signed contracts</h2><section id="contracts"></section>
  <div class="grid2 x-49fcd855" ><div class="card" id="teamc"></div><div class="card" id="subc"></div></div></div>`;
  publisherPanels();
  bindFocusLinks();
  $('#lo').onclick = async () => { await api('POST', '/api/logout').catch(()=>{}); token = null; me = null; sessionStorage.removeItem('bi_token'); render(); };
  $('#rf').onsubmit = async ev => { ev.preventDefault();
    const trades = [...document.querySelectorAll('input[name=tr]:checked')].map(x => x.value);
    const projectId = $('#pjid').value || undefined;
    try { const r = await api('POST', '/api/requests', {title: $('#t').value, address: $('#a').value, city: $('#ci').value, state: $('#st').value, projectType: $('#pt').value, dueDate: $('#dd').value,
      description: $('#ds').value, documentsUrl: $('#docs').value || undefined, authorizationEvidence: $('#authev')?.value || undefined, trades, services: $('#sv').value ? [$('#sv').value] : undefined,
      squareFeet: Number($('#sf2').value) || undefined, frequencyPerMonth: Number($('#fq').value) || undefined, projectId});
      $('#re').style.color = 'var(--pass)'; $('#re').textContent = `Posted. ${r.invited} matching contractor(s) invited so far; more are invited as they join.`; setTimeout(render, 2500); }
    catch (e) { $('#re').textContent = e.message; } };
  const cs = await api('GET', '/api/contracts');
  $('#contracts').innerHTML = cs.length ? contractTable(cs, 'sellerName', 'Provider') : '<div class="empty">Contracts you sign appear here with a downloadable record.</div>';
  bindDocs();
  const reqs = await api('GET', '/api/requests');
  { const open = reqs.filter(r => r.status === 'open' || r.status === 'draft').length, awarded = reqs.filter(r => r.status === 'awarded').length;
    const bids = reqs.reduce((n, r) => n + (r.willBid ?? 0), 0), invited = reqs.reduce((n, r) => n + (r.invited ?? 0), 0);
    const due = reqs.filter(r => r.status === 'open' && r.dueDate).map(r => r.dueDate).sort()[0];
    const tiles = [[reqs.length, OWNER_KINDS.includes(me.org.buyerKind) ? 'projects' : 'bid packages'], [open, 'open for bids'], [invited, 'contractors invited'], [bids, 'said they will bid'], [awarded, 'awarded'], [due ? String(due).slice(0, 10) : '—', 'next bid due']];
    $('#sumstrip').innerHTML = `<div class="buyer-tiles">${tiles.map(([n, l]) => `<div><b>${esc(String(n))}</b><small>${esc(l)}</small></div>`).join('')}</div>`; }
  { // Companies on this company's work: one row per company across every request.
    const withInvites = reqs.filter(r => (r.invited || 0) > 0);
    const lists = await Promise.all(withInvites.map(r => api('GET', `/api/requests/${r.id}/planholders`).catch(() => [])));
    const by = new Map();
    lists.flat().forEach(x => { const c = by.get(x.company) || { company: x.company || 'Company', trades: new Set(), packages: 0, willBid: 0, bids: 0, viewed: 0 };
      (x.trades || []).forEach(t => c.trades.add(t)); c.packages++; if (x.intent === 'will_bid') c.willBid++; if (x.bid) c.bids++; if (x.viewedPlans) c.viewed++; by.set(x.company, c); });
    const rows = [...by.values()].sort((a, b) => b.bids - a.bids || b.packages - a.packages);
    const title = OWNER_KINDS.includes(me.org.buyerKind) ? 'Contractors on your projects' : 'Subcontractors bidding on your packages';
    $('#bidders').innerHTML = `<h3>${title}</h3>` + (rows.length
      ? `<div class="scroll"><table><tr><th>Company</th><th>Trades</th><th class="num">Invited to</th><th class="num">Will bid</th><th class="num">Bid submitted</th><th class="num">Opened plans</th></tr>${rows.map(c => `<tr><td>${esc(c.company)}</td><td><small>${esc([...c.trades].map(k => (TRADES_LIST.find(t => t.key === k) || {}).label || k).join(', ') || '—')}</small></td><td class="num">${c.packages}</td><td class="num">${c.willBid}</td><td class="num">${c.bids}</td><td class="num">${c.viewed}</td></tr>`).join('')}</table></div>`
      : '<div class="empty">No companies invited yet. Invitations go out when a package is posted and matching companies are in your territory.</div>'); }
  { // Owners: project status and awarded value. GCs: bid spread for each package.
    const withBids = await Promise.all(reqs.filter(r => r.submissions).map(async r => ({ r, subs: await api('GET', `/api/requests/${r.id}/submissions`).catch(() => []) })));
    const count = st => reqs.filter(r => r.status === st).length;
    if (OWNER_KINDS.includes(me.org.buyerKind)) {
      const awarded = withBids.filter(x => x.r.status === 'awarded');
      const value = awarded.reduce((n, x) => n + (Number(x.subs.find(z => z.id === x.r.awardedSubmissionId)?.total) || 0), 0);
      $('#analytics').innerHTML = `<h3>Project status</h3><div class="buyer-tiles"><div><b>${count('open')}</b><small>open for bids</small></div><div><b>${awarded.length}</b><small>awarded</small></div><div><b>${count('closed')}</b><small>closed</small></div><div><b>${money(value)}</b><small>awarded value</small></div></div>`;
    } else {
      const spread = withBids.filter(x => x.subs.length).map(x => { const t = x.subs.map(z => Number(z.total)).filter(n => n > 0); const avg = t.reduce((a, b) => a + b, 0) / (t.length || 1);
        return `<tr><td>${esc(x.r.title)}</td><td class="num">${t.length}</td><td class="num">${t.length ? money(Math.min(...t)) : '—'}</td><td class="num">${t.length ? money(avg) : '—'}</td><td class="num">${t.length ? money(Math.max(...t)) : '—'}</td></tr>`; });
      $('#analytics').innerHTML = `<h3>Bid spread by package</h3>` + (spread.length
        ? `<div class="scroll"><table><tr><th>Package</th><th class="num">Bids</th><th class="num">Low</th><th class="num">Average</th><th class="num">High</th></tr>${spread.join('')}</table></div>`
        : '<div class="empty">No bids yet. Low, average and high bids appear here as subcontractors submit.</div>');
    }
  }
  let pjTimer;
  $('#pjq').oninput = () => { clearTimeout(pjTimer); pjTimer = setTimeout(async () => {
    const q = $('#pjq').value.trim(), st = $('#st').value.trim(); const box = $('#pjres');
    if (q.length < 3 || st.length !== 2) { box.style.display = 'none'; return; }
    const r = await api('GET', `/api/core/pick?state=${encodeURIComponent(st)}&q=${encodeURIComponent(q)}`).catch(() => []);
    box.innerHTML = r.length ? r.map(x => `<div class="res" data-pj="${esc(x.id)}" data-a="${esc(x.address || '')}" data-c="${esc(x.city || '')}"><div><b>${esc(x.name)}</b><small>${esc(x.address || '')}, ${esc(x.city || '')} · ${esc(x.id)} · ${esc(x.phase)}</small></div></div>`).join('') : '<small>No matching project. Leave blank and BUILDINTEL links by address.</small>';
    box.style.display = 'block';
    box.querySelectorAll('[data-pj]').forEach(el => el.onclick = () => { $('#pjid').value = el.dataset.pj; if (!$('#a').value) $('#a').value = el.dataset.a; if (!$('#ci').value) $('#ci').value = el.dataset.c;
      $('#pjsel').innerHTML = `Linked to <b>${esc(el.dataset.pj)}</b> <a href="#" id="pjclr">remove</a>`; $('#pjclr').onclick = ev => { ev.preventDefault(); $('#pjid').value = ''; $('#pjsel').textContent = ''; }; box.style.display = 'none'; }); }, 250); };
  if (!reqs.length) { $('#body').innerHTML = '<div class="empty">No requests yet. Post one above.</div>'; return; }
  const blocks = await Promise.all(reqs.map(async r => {
    const subs = r.submissions ? await api('GET', `/api/requests/${r.id}/submissions`) : [];
    const room = await planRoomHtml(r.id);
    const ph = r.invited ? await api('GET', `/api/requests/${r.id}/planholders`).catch(() => []) : [];
    const upload = ['open', 'draft'].includes(r.status) ? `<form data-up="${r.id}" class="row x-fe7b4979" ><input class="x-3521b3d8" type="file" accept="application/pdf" multiple ><label class="x-6a6cfcff" ><input class="x-30e741d9" type="checkbox" name="add" >This is an addendum</label><input class="x-55585d51" name="note" placeholder="Addendum note (what changed)" ><button>Upload PDFs</button><span class="err"></span></form>` : '';
    const phHtml = ph.length ? `<div class="scroll x-fe7b4979" ><table><tr><th>Planholder / bidder</th><th>Intent</th><th>Opened plans</th><th>Addenda acknowledged</th><th>Bid</th></tr>${ph.map(x => `<tr><td>${esc(x.company)}</td><td>${esc(x.intent.replace('_', ' '))}</td><td>${x.viewedPlans ? 'yes, ' + x.filesOpened + ' file(s) · ' + ago(x.lastViewedAt) : 'not yet'}</td><td>${x.addenda ? x.acknowledgedThrough + ' of ' + x.addenda : '—'}</td><td>${x.bid ? 'submitted' : '—'}</td></tr>`).join('')}</table></div>` : '';
    return `<div class="gate x-6384e367" ><div><strong>${esc(r.title)}</strong> <small>${esc(r.address)}, ${esc(r.city)}${r.squareFeet ? ' · ' + r.squareFeet.toLocaleString() + ' SF' : ''} · due ${esc(String(r.dueDate).slice(0,10))} · ${esc(r.status)}</small>
    <small>${(r.trades || []).map(k => esc((TRADES_LIST.find(t => t.key === k) || {}).label || k)).join(' · ')} · <strong>${r.invited ?? 0} invited</strong>, ${r.willBid ?? 0} will bid, ${r.wontBid ?? 0} won't bid${r.documentsUrl ? ` · <a href="${safeUrl(r.documentsUrl)}" target="_blank" rel="noopener">plans</a>` : ''}</small>
    ${room}${upload}${phHtml}
    ${r.submissions ? `<div class="row x-fe7b4979" ><button data-level="${r.id}">Compare bids (leveling & prequalification)</button></div><div id="lv-${r.id}"></div>` : ''}
    ${subs.length ? `<div class="scroll"><table><tr><th>Company</th><th class="num">Price</th><th>Status</th><th></th></tr>${subs.map(x => `<tr><td>${esc(x.sellerName)}<br><small>${esc(x.sellerEmail||'')}</small></td><td class="num">${money(x.total)}${x.recurring?'/mo':''}</td><td>${esc(x.status.replace('_',' '))}</td>
      <td><div class="row"><button data-sub="${x.id}">View proposal</button>${r.status==='open'?`<button class="primary" data-award="${x.id}" data-req="${r.id}">Award</button>`:''}</div></td></tr>`).join('')}</table></div>` : '<small>No bids yet. Invited companies are notified and can bid until the due date.</small>'}</div></div>`; }));
  $('#body').innerHTML = blocks.join('');
  bindDocOpen($('#body'));
  const ins = i => i.onFile ? `${i.current ? '' : '<span class="pill red">expired</span> '}${usd(i.limit)}${i.verified ? ' <span class="pill green">verified</span>' : ' <small>on file</small>'}` : '<span class="pill red">none</span>';
  const drawLevel = async id => {
    const L = await api('GET', `/api/requests/${id}/leveling`); const box = $('#lv-' + id);
    box.innerHTML = `<div class="panel x-8a77e5a3" ><h3>Bid leveling — ${L.stats.bids} bid(s) · low ${L.stats.low ? money(L.stats.low) : '—'} · median ${L.stats.median ? money(L.stats.median) : '—'} · high ${L.stats.high ? money(L.stats.high) : '—'}</h3>
      <div class="scroll"><table><tr><th>Bidder</th><th class="num">Bid</th><th class="num">vs. low</th><th>Addenda</th><th>General liability</th><th>Workers comp</th><th>License</th><th>Flags</th><th>Prequalification</th></tr>
      ${L.rows.map(x => `<tr><td><b>${esc(x.company)}</b><br><small>rev ${x.revision} · ${ago(x.submittedAt)}${x.receiptId ? ' · ' + esc(x.receiptId) : ''}</small></td><td class="num">${money(x.total)}${x.recurring ? '/mo' : ''}</td><td class="num">${x.pctAboveLow ? '+' + x.pctAboveLow + '%' : '<span class="pill green">low</span>'}</td>
        <td>${L.request.addendumCount ? (x.addendaAcknowledged >= L.request.addendumCount ? '<span class="pill green">all ' + L.request.addendumCount + '</span>' : '<span class="pill red">' + x.addendaAcknowledged + ' of ' + L.request.addendumCount + '</span>') : '—'}</td>
        <td>${ins(x.prequal.insurance.generalLiability)}</td><td>${ins(x.prequal.insurance.workersComp)}</td>
        <td>${[...x.prequal.stateLicenses.map(l => `${esc(l.state)} ${esc(l.number)} ${l.active ? '<span class="pill green">active</span>' : '<span class="pill red">' + esc(l.status || 'inactive') + '</span>'}`), ...x.prequal.licenses.map(l => `${esc(l.issuer)} ${esc(l.number)}${l.current ? '' : ' <span class="pill red">expired</span>'}`)].join('<br>') || '<small>none on file</small>'}</td>
        <td><small>${esc(x.prequal.flags.join('; ') || '—')}</small></td>
        <td>${x.decision ? `<span class="pill ${x.decision.status === 'approved' ? 'green' : x.decision.status === 'rejected' ? 'red' : ''}">${esc(x.decision.status)}</span><br>` : ''}<button data-pq="${x.sellerOrgId}" data-st="approved" data-req="${id}">Approve</button> <button data-pq="${x.sellerOrgId}" data-st="rejected" data-req="${id}">Reject</button></td></tr>`).join('')}</table></div>
      <small>Insurance and licenses are what each bidder filed; "verified" means confirmed with the carrier or state. State license status comes from the state's public register.</small></div>`;
    box.querySelectorAll('[data-pq]').forEach(b => b.onclick = async () => { await api('POST', `/api/prequal/${b.dataset.pq}`, { status: b.dataset.st }); drawLevel(b.dataset.req); });
  };
  document.querySelectorAll('[data-level]').forEach(b => b.onclick = () => drawLevel(b.dataset.level));
  document.querySelectorAll('[data-up]').forEach(f => f.onsubmit = async ev => { ev.preventDefault();
    const files = [...f.querySelector('input[type=file]').files]; const err = f.querySelector('.err');
    if (!files.length) { err.textContent = 'Choose PDF files first'; return; }
    for (const file of files) {
      err.style.color = 'var(--muted)'; err.textContent = 'Uploading ' + file.name + '…';
      const q = new URLSearchParams({ name: file.name, addendum: f.add.checked ? '1' : '0', note: f.note.value });
      const res = await fetch(`/api/requests/${f.dataset.up}/documents?${q}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/pdf' }, body: file });
      if (!res.ok) { err.style.color = 'var(--fail)'; err.textContent = file.name + ': ' + ((await res.json().catch(() => ({}))).error || res.status); return; }
    }
    render(); });
  document.querySelectorAll('[data-sub]').forEach(b => b.onclick = async () => { const r = await fetch('/api/submissions/' + b.dataset.sub, {headers: {Authorization: 'Bearer ' + token}}); const w = window.open(); w.document.write(await r.text()); });
  const consent = (await api('GET', '/api/consent-text')).text;
  document.querySelectorAll('[data-award]').forEach(b => b.onclick = () => {
    const row = b.closest('tr'); if (row.nextElementSibling?.classList.contains('signrow')) return;
    const tr = document.createElement('tr'); tr.className = 'signrow';
    tr.innerHTML = `<td colspan="4"><form class="x-4e5c758a" >
      <strong>Sign to award this proposal</strong><small>Other companies are told they were not selected. A signed record is saved for both sides.</small>
      <label>Type your full name<input name="n" required minlength="3" autocomplete="name"></label>
      <label class="x-0a9765da" ><input class="x-495e8c7d" type="checkbox" name="c" required ><span>${esc(consent)}</span></label>
      <div class="row"><button class="primary">Sign and award</button><button type="button" data-cancel>Cancel</button></div><div class="err"></div></form></td>`;
    row.after(tr);
    tr.querySelector('[data-cancel]').onclick = () => tr.remove();
    tr.querySelector('form').onsubmit = async ev => { ev.preventDefault(); const f = ev.target;
      try { const x = await api('POST', `/api/requests/${b.dataset.req}/award`, {submissionId: b.dataset.award, signerName: f.n.value, consent: f.c.checked}); render(); }
      catch (e) { f.querySelector('.err').textContent = e.message; } };
  });
}

const LEAD_TABS = [['command', 'Command center'], ['projects', 'Projects'], ['invitations', 'Bid invitations'], ['contractors', 'Contractors'], ['planning', 'Planning pipeline'], ['searches', 'Saved searches & alerts'], ['tracked', 'Tracked']];
const SUB_TABS = [...LEAD_TABS, ['plan', 'Plan & profile']];
const TABS = [['readiness', 'Launch gates'], ...LEAD_TABS, ['overview', 'Overview'], ['pipeline', 'Bids'], ['opps', 'Opportunities'], ['gaps', 'Add GCs next'], ['contracts', 'Contracts'], ['insurance', 'Insurance & licenses'], ['rates', 'Pricing'], ['plan', 'Company profile'], ['sources', 'Data sources']];

async function render() {
  if (!token) { const sg = location.hash.match(/^#signup-(gc|owner|sub|service)$/); return sg ? roleSignupView(sg[1]) : loginView(); }
  try { me = me || await api('GET', '/api/me'); } catch { return; }
  if (me.org?.kind === 'buyer') return buyerView();
  const isSub = me.org?.kind === 'subscriber';
  if (isSub && !TRADES_LIST.length) TRADES_LIST = await (await fetch('/api/trades')).json().catch(() => []);
  if (isSub && !workspaceTabSet) { tab = navKey = me.org.segment ? 'invitations' : 'command'; workspaceTabSet = true; }   // subcontractors and service providers land on their bid invitations
  if (location.hash.startsWith('#project/')) { tab = 'projects'; }
  if (location.hash.startsWith('#contractor/')) { tab = 'contractors'; }
  if (location.hash === '#invitations') { tab = 'invitations'; history.replaceState(null, '', location.pathname); }
  if (isSub && !SUB_TABS.some(([k]) => k === tab) && !EXTRA_TABS.includes(tab)) tab = 'command';
  if (tab === 'readiness' && me.user.role !== 'platform_owner') tab = 'command';
  if (navKey.split(':')[0] !== tab) { navKey = tab; SUBVIEW = ''; }
  const platform = me.user.role === 'platform_owner';
  const avail = new Set([...(isSub ? SUB_TABS : TABS.filter(([k]) => platform || !['readiness','sources'].includes(k))).map(([k]) => k), ...EXTRA_TABS, ...(platform ? ['publishers'] : [])]);
  // Deep link from the Super Admin portal: /#open:<screen>, honored only for screens this user may open.
  { const deep = location.hash.match(/^#open:([a-z]+)$/); if (deep && avail.has(deep[1])) { tab = deep[1]; navKey = deep[1]; history.replaceState(null, '', location.pathname); } }
  const NAV = [
    { key: 'command', label: 'Command Center', icon: 'home' }, { key: 'map', label: 'Project Discovery Map', icon: 'pin' },
    { group: 'Construction Intelligence', icon: 'layers', items: [['projects', 'Projects'], ['projects:permits', 'Permits'], ['planning', 'Planning & Development'], ['market', 'Market Activity']] },
    { group: 'Plans & Specifications', icon: 'file', items: [['planroom', 'Plan Room'], ['planroom:drawing', 'Drawing Sets'], ['planroom:specification', 'Specifications'], ['planroom:addenda', 'Addenda & Revisions']] },
    { key: 'planroom:ai', label: 'AI Floor Plan Analyzer', icon: 'spark' },
    { group: 'GC & Relationship Network', icon: 'users', items: [['contractors', 'Contractors (GCs)'], ['directory:gm', 'General Managers (GMs)'], ['directory', 'Project Contacts'], ['contractors:dir', 'Company Directory']] },
    { group: 'Project Opportunities', icon: 'brief', items: [['projects:opps', 'Bid Opportunities'], ['invitations:packages', 'Trade Packages'], ['invitations', 'Invitations to Bid'], ['searches', 'Saved Searches & Alerts'], ['tracked', 'Pipeline']] },
    { key: 'estimates', label: 'Takeoff & Estimating', icon: 'clip' },
    { key: isSub ? 'invitations:bids' : 'pipeline', label: 'Bid Management', icon: 'send' },
    { key: 'contracts', label: 'Awards & Contracts', icon: 'award' },
    { key: 'market:analytics', label: 'Analytics & Forecasting', icon: 'chart' },
    { group: 'Admin & Settings', icon: 'gear', items: [['subscription', 'Subscription Center'], ['team', 'Team & Permissions'], ['publishers', 'Publisher Review'], ['coverage', 'Geographic Coverage'], ['plan', isSub ? 'Plan & Company Profile' : 'Company Profile'], ['insurance', 'Insurance & Licenses'], ['rates', me.org?.segment === 'service_provider' ? 'Rate cards' : 'Pricing'], ['opps', 'Autopilot Opportunities'], ['gaps', 'GCs to Add'], ['overview', 'Bid Analytics'], ['readiness', 'Launch Gates'], ['sources', 'Data Sources']] },
  ];
  // Each subscriber role sees its own menu. Keys not listed are not shown in that role's navigation (they stay reachable from the banners).
  const roleSet = me.org?.kind === 'subscriber' && SUB_ROLE_NAV[me.org.segment] ? new Set(SUB_ROLE_NAV[me.org.segment]) : null;
  const ok = k => avail.has(k.split(':')[0]) && (!roleSet || roleSet.has(k));
  const sel = k => k === navKey;
  const navHtml = NAV.map(n => n.key ? (ok(n.key) ? `<button class="solo" role="tab" data-t="${n.key}" aria-selected="${sel(n.key)}">${ICON[n.icon]}${n.label}</button>` : '')
    : (it => it.length ? `<div class="grp ${CLOSED.has(n.group) ? 'closed' : ''}" data-grp="${esc(n.group)}"><span>${ICON[n.icon]}${n.group}</span><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></div><div class="sub">` + it.map(([k, l]) => `<button role="tab" data-t="${k}" aria-selected="${sel(k)}">${l}</button>`).join('') + '</div>' : '')(n.items.filter(([k]) => ok(k)))).join('');
  const TOP = [['command', 'Projects'], ['projects:permits', 'Permits'], ['planroom:drawing', 'Drawings'], ['contractors', 'GCs'], ['estimates', 'Takeoff'], ['estimates:estimating', 'Estimating'], ['invitations:bids', 'Bidding']].filter(([k]) => ok(k));
  const initials = String(me.org?.name || 'BI').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  $('#app').innerHTML = `<div class="app"><aside class="side"><div class="brand">${ICON.logo}<div><b>BUILDINTEL<sup class="x-fb2957a3" >®</sup></b><small>Commercial Construction Intelligence</small></div></div><nav aria-label="Main">${navHtml}</nav></aside>
    <div class="main"><div class="top"><div class="links">${TOP.map(([k, l]) => `<button data-tl="${k}" class="${k === navKey ? 'on' : ''}">${l}</button>`).join('')}</div>
      <form class="search" id="gs">${ICON.search}<input id="gq" placeholder="Search projects, companies, contacts, permits, or addresses…" aria-label="Search"></form>
      <div class="right"><span class="bell" id="bell" title="Bid invitations waiting">${ICON.bell}<i id="bellN" hidden></i></span><span class="iconbtn" id="help" title="How BUILDINTEL works">${ICON.help}</span><span class="iconbtn" id="apps" title="Quick links">${ICON.apps}</span>
        <span class="who2"><span class="avatar">${esc(initials)}</span><span>${esc(me.org?.name || '')}<br><small>${esc(me.user.email)}</small></span></span><button id="lo">Sign out</button></div><div id="popbox"></div></div>
      <div class="content"><div id="sign"></div><section id="body"></section></div></div></div>`;
  $('#lo').onclick = async () => { await api('POST', '/api/logout').catch(()=>{}); token = null; me = null; sessionStorage.removeItem('bi_token'); render(); };
  const go = t => { navKey = t; tab = t.split(':')[0]; SUBVIEW = t.split(':')[1] || ''; if (location.hash) history.replaceState(null, '', location.pathname); render(); };
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => go(b.dataset.t));
  document.querySelectorAll('[data-grp]').forEach(g => g.onclick = () => { CLOSED.has(g.dataset.grp) ? CLOSED.delete(g.dataset.grp) : CLOSED.add(g.dataset.grp); g.classList.toggle('closed'); });
  document.querySelectorAll('[data-tl]').forEach(b => b.onclick = () => go(b.dataset.tl));
  $('#gs').onsubmit = ev => { ev.preventDefault(); lastFilters = { q: $('#gq').value.trim() }; go('projects'); };
  $('#bell').onclick = () => go('invitations');
  const pop = html => { $('#popbox').innerHTML = $('#popbox').innerHTML ? '' : `<div class="pop">${html}</div>`; $('#popbox').querySelectorAll('[data-go]').forEach(x => x.onclick = ev => { ev.preventDefault(); go(x.dataset.go); }); };
  $('#help').onclick = () => pop(`<strong>How BUILDINTEL works</strong><ol class="x-bd098396" ><li>City permits & land-use filings arrive hourly → projects, schedules, GCs.</li><li>Follow projects and save searches for alerts.</li><li>GCs invite you to bid; plans open in the Plan Room.</li><li>AI reads drawings → you confirm → takeoff & estimate.</li><li>Submit your bid; the GC awards with an e-signature.</li></ol>`);
  $('#apps').onclick = () => pop([['command', 'Command Center'], ['planroom', 'Plan Room'], ['estimates', 'Takeoff & Estimating'], ['directory', 'Project Contacts'], ['market', 'Market Activity'], ['plan', 'Company Profile']].filter(([k]) => ok(k)).map(([k, l]) => `<a class="x-57832853" href="#" data-go="${k}" >${l}</a>`).join(''));
  api('GET', '/api/invitations').then(v => { const n = v.filter(i => i.request.status === 'open' && i.intent === 'undecided').length; if (n) { $('#bellN').textContent = n; $('#bellN').hidden = false; } }).catch(() => {});
  if (isSub) {
    const a = await api('GET', '/api/access');
    const gaps = await api('GET', '/api/prequal/me').catch(() => null);
    const steps = [['Confirm your email', me.org.status !== 'pending_verification', null], ['Trades and territory', (me.org.trades || []).length > 0 && (me.org.territories || []).length > 0, 'plan'],
      ['Company details', !!(me.org.legal && me.org.legal.name), 'plan'], ['Insurance and licenses', !!gaps && Array.isArray(gaps.flags) && gaps.flags.length === 0, 'insurance']];
    if (me.org.segment === 'service_provider') { const rc = await api('GET', '/api/rate-cards').catch(() => []); steps.push(['Approved rate card', rc.some(x => x.status === 'approved'), 'rates']); }
    $('#sign').insertAdjacentHTML('beforebegin', roleBannerHtml(me.org, steps));
    bindFocusLinks();
    $('#sign').innerHTML = a.ok ? (a.plan === 'trial' ? `<div class="card x-ae8369b5" ><span class="pill amber">Free trial</span> ${Math.max(0, Math.ceil((Date.parse(a.trialEndsAt) - Date.now()) / 864e5))} day(s) left · Territory: ${esc(a.territories.join(', '))} · <a href="#" data-goto="plan">Choose a plan</a></div>` : '')
      : `<div class="card x-5da2c578" >${esc(a.reason)}. <a href="#" data-goto="plan">Choose a plan</a></div>`;
    document.querySelectorAll('[data-goto]').forEach(x => x.onclick = ev => { ev.preventDefault(); go(x.dataset.goto); });
  }
  if (platform && tab === 'readiness') {
    const r = await api('GET', '/api/readiness');
    $('#sign').innerHTML = `<div class="sign"><div class="verdict ${r.verdict==='GO'?'go':''}">${r.verdict}</div><div><h2>${r.passed} of ${r.total} launch gates passed</h2>
    <p>${r.pilotReady ? 'Pilot ready: the autopilot is collecting, pricing and drafting bids.' : 'Pilot not ready yet. Clear the gates marked FAIL or OWNER below.'} Live sending stays off until every gate passes.</p>
    <div class="row x-d2c171b1" ><button class="primary" id="run">Run cycle now</button><button id="bk">Back up and verify restore</button><button id="tm">Send test email to me</button><span class="x-57f9e31d" id="tmr" ></span></div></div></div>`;
    api('GET', '/api/release').then(rl => { const el = document.createElement('p'); el.style.margin = '8px 0 0'; el.innerHTML = `<small>Release <b>${esc(rl.version)}</b> · commit <b>${String(rl.commit).startsWith('unknown') ? 'not reported by host' : esc(String(rl.commit).slice(0, 10))}</b>${rl.branch ? ' (' + esc(rl.branch) + ')' : ''} · started ${fmtDate(rl.startedAt)} ${new Date(rl.startedAt).toLocaleTimeString()} · storage ${esc(rl.storage)}${rl.dbTls ? ' (' + esc(rl.dbTls) + ')' : ''} · email ${esc(rl.integrations.email)} · payments ${rl.integrations.stripe ? 'on' : 'off'} · AI ${rl.integrations.ai ? 'on' : 'off'} · off-site backup ${rl.integrations.offsiteBackup ? 'on' : 'off'} · last pull ${rl.collection.lastCycleAt ? ago(rl.collection.lastCycleAt) : 'never'} (${esc(rl.collection.lastCycleStatus || '—')}) · scheduler ${rl.collection.scheduler ? 'on' : 'off'}</small>`; document.querySelector('.sign > div:last-child')?.appendChild(el); }).catch(() => {});
    $('#run').onclick = async () => { $('#run').textContent = 'Starting…'; try { const x = await api('POST', '/api/cycle'); $('#tmr').textContent = x.started ? 'Pull started in the background.' : (x.reason || ''); } catch (e) { $('#tmr').textContent = e.message; } $('#run').textContent = 'Run cycle now'; };
    $('#bk').onclick = async () => { $('#tmr').textContent = 'Backing up…'; try { const x = await api('POST', '/api/backup'); $('#tmr').textContent = x.restore.ok ? 'Backup saved and restore verified.' : 'Restore check failed: ' + (x.restore.error || 'checksum mismatch'); } catch (e) { $('#tmr').textContent = e.message; } };
    $('#tm').onclick = async () => { $('#tmr').textContent = 'Sending…'; try { const x = await api('POST', '/api/admin/test-email'); $('#tmr').style.color = x.ok ? 'var(--pass)' : 'var(--fail)'; $('#tmr').textContent = x.ok ? `Sent to ${x.sentTo}. Check your inbox (and spam).` : x.problem; } catch (e) { $('#tmr').textContent = e.message; } };
    $('#body').innerHTML = r.gates.map(g => `<div class="gate"><span class="tag ${g.status}">${g.status==='owner_action'?'OWNER':g.status.toUpperCase()}</span><div><strong>${esc(g.name)}</strong><small>${esc(g.evidence)}</small><small>Next step: ${esc(g.owner)}</small></div></div>`).join('');
    return;
  }
  let body = $('#body');
  const PH = PAGE_HEAD[navKey] || PAGE_HEAD[tab];
  if (PH && !/^#(project|contractor)\//.test(location.hash)) { body.innerHTML = `<div class="ph"><div><h1>${ICON[PH[2]] || ''}${PH[0]}</h1><p>${PH[1]}</p></div></div><div id="pbody"></div>`; body = $('#pbody'); }
  if (['command', 'map', 'projects', 'invitations', 'contractors', 'planning', 'searches', 'tracked', 'plan', 'market', 'planroom', 'estimates', 'directory', 'coverage', 'team', 'subscription', 'publishers'].includes(tab)) return leadTab(tab, body);
  if (tab === 'overview') {
    const a = await api('GET', '/api/analytics');
    const cell = (label, v) => `<div class="x-3e0d2840" ><div class="x-1f374e7e" >${v}</div><div class="x-57f9e31d" >${label}</div></div>`;
    body.innerHTML = `<div class="x-b3373900" >
      ${cell('Waiting for your approval', a.bids.pending_approval + ' · ' + money(a.value.awaitingApproval))}
      ${cell('Out with GCs and buyers', money(a.value.outstanding))}
      ${cell('Won', money(a.value.won))}
      ${cell('Win rate', a.winRate == null ? '—' : a.winRate + '%')}
      ${cell('Replies to read', a.needsAttention)}
      ${cell('Blocked on missing GC contact', a.opportunities.needs_contact)}</div>
      <p class="x-57f9e31d" >Email bids: ${a.byChannel.email.bids} (win rate ${a.byChannel.email.winRate ?? '—'}%). Buyer requests: ${a.byChannel.marketplace.bids} (win rate ${a.byChannel.marketplace.winRate ?? '—'}%).</p>`;
  }
  if (tab === 'contracts') {
    const cs = await api('GET', '/api/contracts');
    body.innerHTML = cs.length ? contractTable(cs, 'buyerName', 'Customer') : '<div class="empty">No signed contracts yet. When a buyer awards one of your proposals, the signed record appears here.</div>';
    bindDocs();
  }
  if (tab === 'insurance') {
    const cs = await api('GET', '/api/credentials');
    const today = Date.now();
    body.innerHTML = `<p>Bidding pauses automatically if no current general liability certificate is on file. Proposals list certificates as "on file" until the platform owner verifies them with the carrier or issuer.</p>
    ${cs.length ? `<div class="scroll"><table><tr><th>Type</th><th>Issuer</th><th>Number</th><th>Expires</th><th>Status</th></tr>${cs.map(c => `<tr><td>${c.type === 'coi' ? 'Insurance certificate' : esc(c.type)}${c.coverages?.length ? `<br><small>${esc(c.coverages.map(v => v.type.replace(/_/g,' ') + ' ' + money(v.limit)).join(', '))}</small>` : ''}</td><td>${esc(c.issuer)}</td><td>${esc(c.number)}</td>
      <td data-style="${Date.parse(c.expiresAt) < today ? 'color:var(--fail);font-weight:600' : Date.parse(c.expiresAt) < today + 30*864e5 ? 'color:var(--owner);font-weight:600' : ''}">${esc(c.expiresAt.slice(0,10))}</td>
      <td>${c.verification?.status === 'verified_with_issuer' ? `Verified with issuer ${esc(c.verification.verifiedAt.slice(0,10))}` : 'On file, not yet verified'}</td></tr>`).join('')}</table></div>` : '<div class="empty">No certificates on file. Add Bright Clean\'s general liability certificate to start bidding.</div>'}
    <h3 class="x-e4be8337" >Add insurance certificate</h3>
    <form class="x-78963d77" id="cf" >
      <input id="ci2" placeholder="Insurance carrier" required><input id="cn" placeholder="Policy number" required>
      <input id="cgl" type="number" min="1" placeholder="General liability limit ($)" required>
      <label class="x-bbe2ad4b" >Expires<input id="ce" type="date" required></label>
      <button class="primary">Add certificate</button></form><div class="err" id="cerr"></div>`;
    $('#cf').onsubmit = async ev => { ev.preventDefault();
      try { await api('POST', '/api/credentials', {type: 'coi', issuer: $('#ci2').value, number: $('#cn').value, coverages: [{type: 'general_liability', limit: Number($('#cgl').value)}], expiresAt: $('#ce').value}); render(); }
      catch (e) { $('#cerr').textContent = e.message; } };
  }
  if (tab === 'gaps') {
    const g = await api('GET', '/api/directory/gaps');
    body.innerHTML = g.length ? `<p>These contractors are on qualified permits but have no verified bid contact on file. Add the estimating email from their own website, ranked by bid value waiting.</p>
      <div class="scroll"><table><tr><th>Contractor on permit</th><th class="num">Projects</th><th class="num">Bid value waiting</th><th>Cities</th></tr>${g.map(x => `<tr><td>${esc(x.contractor)}<br><small>${esc(x.reason)}</small></td><td class="num">${x.projects}</td><td class="num">${money(x.blockedValue)}</td><td>${esc(x.cities.join(', '))}</td></tr>`).join('')}</table></div>`
      : '<div class="empty">Nothing is waiting on a contact. Every qualified project has a verified GC to send to.</div>';
  }
  if (tab === 'pipeline') {
    const [bids, opps] = await Promise.all([api('GET', '/api/bids'), api('GET', '/api/opportunities')]);
    const om = Object.fromEntries(opps.map(o => [o.id, o]));
    if (!bids.length) { body.innerHTML = '<div class="empty">No bids yet. Bids appear here after the autopilot finds a qualified project with a verified GC contact.</div>'; return; }
    body.innerHTML = `<div class="scroll"><table><tr><th>Project</th><th>Status</th><th class="num">Total</th><th>Actions</th></tr>${bids.map(b => { const p = om[b.opportunityId]?.permit || {};
      return `<tr><td>${esc(p.projectName || p.description)}<br><small>${esc(p.address)}, ${esc(p.city)} · ${esc(p.permitId)}</small>${b.lastDryRunIssues?.length ? `<br><small class="x-ce711e4f" >Blocked: ${esc(b.lastDryRunIssues.join('; '))}</small>` : ''}${b.needsAttention ? `<br><small class="x-323fe151" ><strong>Reply from ${esc(b.replies.at(-1).from)}:</strong> ${esc(b.replies.at(-1).text.slice(0, 240))}</small>` : ''}${b.channel==='marketplace' ? '<br><small>Requested by buyer</small>' : ''}</td>
      <td>${esc(b.status.replace('_',' '))}</td><td class="num">${money(b.total)}${b.recurring?'/mo':''}</td>
      <td><div class="row"><button data-view="${b.proposalId}">View proposal</button>${b.status==='pending_approval'?`<button class="primary" data-act="approve" data-id="${b.id}">Approve</button>`:''}
      ${['sent','delivered','opened'].includes(b.status) && b.channel!=='marketplace'?`<button data-act="awarded" data-id="${b.id}">Won</button><button data-act="lost" data-id="${b.id}">Lost</button>`:''}
      ${b.status==='failed'?`<button data-act="retry" data-id="${b.id}">Retry</button>`:''}${b.needsAttention?`<button data-act="clear-attention" data-id="${b.id}">Mark read</button>`:''}</div></td></tr>`; }).join('')}</table></div>`;
    body.querySelectorAll('[data-act]').forEach(x => x.onclick = async () => { try { await api('POST', `/api/bids/${x.dataset.id}/${x.dataset.act}`); render(); } catch (e) { alert(e.message); } });
    body.querySelectorAll('[data-view]').forEach(x => x.onclick = async () => { const r = await fetch('/api/proposals/' + x.dataset.view, {headers: {Authorization: 'Bearer ' + token}}); const w = window.open(); w.document.write(await r.text()); });
  }
  if (tab === 'opps') {
    const opps = await api('GET', '/api/opportunities');
    body.innerHTML = opps.length ? `<div class="scroll"><table><tr><th>Project</th><th>Status</th><th class="num">Score</th><th class="num">Estimate</th><th>Why</th></tr>${opps.map(o => `<tr><td>${esc(o.permit?.description)}<br><small>${esc(o.permit?.address)}, ${esc(o.permit?.city)} · <a href="${safeUrl(o.permit?.sourceUrl)}" target="_blank" rel="noopener">source record</a></small></td><td>${esc(o.status.replace(/_/g,' '))}</td><td class="num">${o.score}</td><td class="num">${money(o.estimate?.total)}</td><td><small>${esc([...o.reasons, ...o.blockers.map(b=>'✗ '+b), o.contactReason?'✗ '+o.contactReason:''].filter(Boolean).join(' · '))}</small></td></tr>`).join('')}</table></div>`
      : '<div class="empty">No opportunities yet. They appear after an authorized data source syncs and at least one rate card is approved.</div>';
  }
  if (tab === 'rates') {
    const cards = await api('GET', '/api/rate-cards');
    body.innerHTML = (cards.length ? `<div class="scroll"><table><tr><th>Service</th><th>Version</th><th>Status</th><th class="num">SF / labor hr</th><th class="num">Labor $/hr</th><th class="num">Margin</th><th class="num">Minimum</th><th></th></tr>${cards.map(c => `<tr><td>${esc(c.serviceName)}</td><td>v${c.version}</td><td>${c.status}</td><td class="num">${c.productionRate}</td><td class="num">${money(c.laborRate)}</td><td class="num">${Math.round(c.targetMarginPct*100)}%</td><td class="num">${money(c.minimumPrice)}</td><td>${c.status==='draft'?`<button class="primary" data-ap="${c.id}">Approve pricing</button>`:''}</td></tr>`).join('')}</table></div>`
      : '<div class="empty">No pricing yet. Nothing gets estimated until you add and approve a rate card (POST /api/rate-cards).</div>');
    body.querySelectorAll('[data-ap]').forEach(x => x.onclick = async () => { if (!confirm('Approve this pricing for live estimates?')) return; try { await api('POST', `/api/rate-cards/${x.dataset.ap}/approve`); render(); } catch (e) { alert(e.message); } });
  }
  if (tab === 'sources') {
    const s = await api('GET', '/api/sources');
    const cs = await api('GET', '/api/cycle').catch(() => ({}));
    body.innerHTML = `<div class="row x-da12f285" ><button class="primary" id="runnow">Run a pull now</button><span class="x-3b74a57e" id="rmsg" >${cs.running ? 'A pull is running (started ' + ago(cs.startedAt) + ')' : ''}</span></div>
    ${s.map(x => `<div class="gate x-6384e367" ><div>
      <strong>${esc(x.name)}</strong> <small>${esc(x.adapter || x.method)}</small>
      <small>${x.enabled ? '<span class="x-3a1947c1" >ON</span>' : '<span class="x-57f9e31d" >OFF</span>'} · ${x.authorization?.evidence ? 'terms reviewed by ' + esc(x.authorization.reviewedBy || '') + ' ' + esc(x.authorization.reviewedAt || '') : 'terms not reviewed'} · last success ${ago(x.lastSuccessAt)}${x.lastError ? ' · <span class="x-ce711e4f" >error: ' + esc(x.lastError) + '</span>' : ''}</small>
      <small>${esc(x.notes || '')}</small>
      <div class="row x-fe7b4979" >
        ${['socrata', 'arcgis', 'license-socrata', 'signals-socrata'].includes(x.adapter) ? `<button data-probe="${x.id}">Probe</button>` : ''}
        <button data-map="${x.id}">Edit mapping</button>
        ${x.enabled ? `<button data-off="${x.id}">Switch off</button>` : `<button class="primary" data-on="${x.id}">Switch on…</button>`}
        ${x.adapter && !['license-socrata', 'legistar'].includes(x.adapter) ? `<button data-resync="${x.id}">Resync</button>` : ''}
      </div>
      <div id="panel-${x.id}"></div></div></div>`).join('')}`;
    const panel = id => $('#panel-' + id);
    const byId = Object.fromEntries(s.map(x => [x.id, x]));
    $('#runnow').onclick = async () => { const r = await api('POST', '/api/cycle'); $('#rmsg').textContent = r.started ? 'Pull started in the background. Results appear here in a minute or two.' : (r.reason || r.skipped || ''); };
    body.querySelectorAll('[data-probe]').forEach(b => b.onclick = async () => {
      const id = b.dataset.probe; panel(id).innerHTML = '<small>Probing…</small>';
      try { const r = await api('POST', `/api/sources/${id}/probe`, {});
        panel(id).innerHTML = `<small>License: <strong>${esc(r.license || 'not stated')}</strong> · data updated ${esc((r.lastUpdated || '').slice(0, 10) || '?')} · mapping problems: <strong data-style="color:${r.mappedFieldsMissing?.length ? 'var(--fail)' : 'var(--pass)'}">${r.mappedFieldsMissing?.length ? esc(r.mappedFieldsMissing.join(', ')) : 'none'}</strong></small>
          <small>Columns: ${esc((r.columns || []).join(', '))}</small>
          ${byId[id].adapter !== 'arcgis' ? `<div class="row"><input class="x-55585d51" id="dv-${id}" placeholder="column name to see its values" ><button data-values="${id}">Show values</button></div><div id="vals-${id}"></div>` : ''}`;
        const vb = panel(id).querySelector('[data-values]');
        if (vb) vb.onclick = async () => { try { const v = await api('POST', `/api/sources/${id}/probe`, { distinct: $('#dv-' + id).value.trim() });
          $('#vals-' + id).innerHTML = `<small>${esc((v.values || []).map(x => `${x.value ?? '(blank)'}: ${x.count}`).join(' · '))}</small>`; } catch (e) { $('#vals-' + id).innerHTML = `<small class="x-ce711e4f" >${esc(e.message)}</small>`; } };
      } catch (e) { panel(id).innerHTML = `<small class="x-ce711e4f" >${esc(e.message)}</small>`; }
    });
    body.querySelectorAll('[data-map]').forEach(b => b.onclick = () => {
      const id = b.dataset.map;
      panel(id).innerHTML = `<small>Mapping (JSON). Only change column names you saw in Probe.</small><textarea class="x-b00ad09f" id="mj-${id}" rows="10" >${esc(JSON.stringify(byId[id].adapterConfig, null, 2))}</textarea><div class="row"><button class="primary" data-savemap="${id}">Save mapping</button><span id="mm-${id}"></span></div>`;
      panel(id).querySelector('[data-savemap]').onclick = async () => { let cfg; try { cfg = JSON.parse($('#mj-' + id).value); } catch { $('#mm-' + id).textContent = 'Not valid JSON'; return; }
        try { await api('PATCH', `/api/sources/${id}`, { adapterConfig: cfg }); $('#mm-' + id).textContent = 'Saved. Run Probe to confirm.'; } catch (e) { $('#mm-' + id).textContent = e.message; } };
    });
    body.querySelectorAll('[data-on]').forEach(b => b.onclick = () => {
      const id = b.dataset.on;
      panel(id).innerHTML = `<small>Switching on records your terms review. Read the source's terms (${esc(byId[id].termsUrl || '')}) first.</small>
        <input id="rv-${id}" placeholder="Reviewed by (your name)"><input id="ev-${id}" placeholder="Evidence: license shown in Probe, or where the terms allow reuse">
        <label class="x-54ead96c" ><input class="x-30e741d9" type="checkbox" id="ok-${id}" >The terms allow commercial reuse and showing this data to subscribers.</label>
        <div class="row"><button class="primary" data-confirm="${id}">Switch on</button><span id="om-${id}"></span></div>`;
      panel(id).querySelector('[data-confirm]').onclick = async () => {
        if (!$('#ok-' + id).checked || !$('#rv-' + id).value.trim() || !$('#ev-' + id).value.trim()) { $('#om-' + id).textContent = 'Fill in all three.'; return; }
        try { await api('PATCH', `/api/sources/${id}`, { enabled: true, authorization: { commercialReuse: true, redistribution: true, reviewedBy: $('#rv-' + id).value.trim(), reviewedAt: new Date().toISOString().slice(0, 10), evidence: $('#ev-' + id).value.trim() } }); render(); }
        catch (e) { $('#om-' + id).textContent = e.message; } };
    });
    body.querySelectorAll('[data-off]').forEach(b => b.onclick = async () => { await api('PATCH', `/api/sources/${b.dataset.off}`, { enabled: false }); render(); });
    body.querySelectorAll('[data-resync]').forEach(b => b.onclick = async () => { const r = await api('POST', `/api/sources/${b.dataset.resync}/resync`, {}); panel(b.dataset.resync).innerHTML = `<small>${r.archived} old records retired. The next pull reloads this source under its current mapping.</small>`; });
  }
}
(async () => { try { const a = await (await fetch('/api/attributions')).json();
  if (Array.isArray(a) && a.length) $('#attrib').innerHTML = '<strong>Data sources & disclaimers</strong><br>' + a.map(x => `${esc(x.name)} (${esc(x.agency || '')})${x.disclaimer ? '<br><em>' + esc(x.disclaimer) + '</em>' : ''}`).join('<br>') + '<br>Estimates (schedules, trade windows) are BUILDINTEL estimates, not city data.'; } catch {} })();
window.addEventListener('hashchange', () => { if (/^#(project|contractor)\//.test(location.hash)) render(); });
render();
