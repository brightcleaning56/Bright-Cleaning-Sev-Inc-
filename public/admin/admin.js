/* Bright Clean operations portal. Plain JS, no build step. */
(() => {
  'use strict';

  // ---------- Helpers ----------
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const TOKEN_KEY = 'bc_admin_token';
  let token = localStorage.getItem(TOKEN_KEY);

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(v || 0));
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const fmtDate = v => {
    if (!v) return '—';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00') : new Date(v);
    return isNaN(d) ? esc(v) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const fmtWhen = v => {
    const d = new Date(v);
    return isNaN(d) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const ago = v => {
    const s = (Date.now() - new Date(v).getTime()) / 1000;
    if (!isFinite(s)) return '';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + ' d ago';
    return fmtDate(v);
  };
  const formObj = form => Object.fromEntries(new FormData(form).entries());

  function toast(text, isErr) {
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : '');
    t.setAttribute('role', 'status');
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), isErr ? 5000 : 2600);
  }

  async function api(url, opts = {}) {
    opts.headers = { ...(opts.headers || {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) };
    if (opts.json !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    const r = await fetch(url, opts);
    let j = {};
    try { j = await r.json(); } catch { /* no body */ }
    if (r.status === 401 && url !== '/api/admin/login') {
      signOut('Your session ended. Please sign in again.');
      throw new Error('Signed out');
    }
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }

  // ---------- Status vocabularies ----------
  const STATUS = {
    leads: ['New', 'In Review', 'Site Walkthrough', 'Proposal in Progress', 'Proposal Sent', 'Won', 'Lost', 'Archived'],
    estimates: ['Draft', 'Ready', 'Sent', 'Viewed', 'Approved', 'Declined', 'Expired'],
    contracts: ['Draft', 'Review', 'Active', 'Renewal Due', 'Closed'],
    signature: ['Not sent', 'Sent', 'Signed'],
    projects: ['Planning', 'Mobilization', 'In Progress', 'Quality Review', 'Completed', 'On Hold'],
    invoices: ['Draft', 'Sent', 'Partially Paid', 'Paid', 'Overdue', 'Void']
  };
  const TONE = {
    New: 'blue', 'In Review': 'amber', 'Site Walkthrough': 'amber', 'Proposal in Progress': 'amber', 'Proposal Sent': 'blue', Won: 'green', Lost: 'red', Archived: '',
    Draft: '', Ready: 'blue', Sent: 'blue', Viewed: 'amber', Approved: 'green', Declined: 'red', Expired: 'red',
    Review: 'amber', Active: 'green', 'Renewal Due': 'amber', Closed: '',
    'Not sent': '', Signed: 'green',
    Planning: 'blue', Mobilization: 'amber', 'In Progress': 'blue', 'Quality Review': 'amber', Completed: 'green', 'On Hold': 'red',
    'Partially Paid': 'amber', Paid: 'green', Overdue: 'red', Void: ''
  };
  const badge = s => `<span class="badge ${TONE[s] || ''}">${esc(s || '—')}</span>`;
  const options = (list, selected) => list.map(s => `<option${s === selected ? ' selected' : ''}>${esc(s)}</option>`).join('');
  const KIND_LABEL = { bid: 'Bid request', inquiry: 'Contact message', career: 'Job application' };

  // Invoice display status: past due and unpaid shows Overdue.
  const invoiceState = i => {
    const bal = Math.max(0, Number(i.amount || 0) - Number(i.paid_amount || 0));
    if (['Paid', 'Void', 'Draft'].includes(i.status)) return i.status;
    if (i.due_date && i.due_date < todayISO() && bal > 0) return 'Overdue';
    return i.status;
  };

  // ---------- State ----------
  const state = { leads: [], estimates: [], contracts: [], projects: [], invoices: [], customers: [], leadKind: 'bid', view: 'overview' };

  // ---------- Auth ----------
  function signOut(message) {
    token = null;
    localStorage.removeItem(TOKEN_KEY);
    closeDrawer();
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#loginStatus').textContent = message || '';
    $('#loginStatus').className = 'msg' + (message ? ' err' : '');
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const st = $('#loginStatus');
    st.className = 'msg'; st.textContent = 'Signing in…';
    try {
      const x = await api('/api/admin/login', { method: 'POST', json: formObj(e.target) });
      token = x.token;
      localStorage.setItem(TOKEN_KEY, token);
      e.target.reset();
      st.textContent = '';
      start();
    } catch (err) { st.className = 'msg err'; st.textContent = err.message; }
  });
  $('#logout').addEventListener('click', () => signOut());

  async function start() {
    try {
      const me = await api('/api/admin/me');
      $('#whoEmail').textContent = me.email || '';
    } catch { return; }
    $('#login').hidden = true;
    $('#app').hidden = false;
    go((location.hash || '#overview').slice(1).split('/')[0] || 'overview', true);
  }

  // ---------- Navigation ----------
  const VIEWS = ['overview', 'leads', 'customers', 'issues', 'proposals', 'estimator', 'contracts', 'projects', 'invoices', 'scopes', 'activity', 'settings'];
  function go(view, replace) {
    if (!VIEWS.includes(view)) view = 'overview';
    state.view = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + view));
    const navView = view === 'estimator' ? 'proposals' : view;
    $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === navView));
    const hash = '#' + view;
    if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null, '', hash);
    window.scrollTo(0, 0);
    load(view);
  }
  window.addEventListener('popstate', () => go((location.hash || '#overview').slice(1)));
  $$('#nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
  document.addEventListener('click', e => {
    const link = e.target.closest('[data-view-link]');
    if (link) go(link.dataset.viewLink);
    const act = e.target.closest('[data-action="new-estimate"]');
    if (act) openEstimator();
    const nw = e.target.closest('[data-new]');
    if (nw) openRecord(nw.dataset.new, null);
  });

  async function load(view) {
    try {
      if (view === 'overview') await loadOverview();
      if (view === 'leads') await loadLeads();
      if (view === 'customers') await loadCustomers();
      if (view === 'proposals') await loadEstimates();
      if (['contracts', 'projects', 'invoices'].includes(view)) await loadRegister(view);
      if (view === 'issues') await loadIssues();
      if (view === 'scopes') await loadScopes();
      if (view === 'activity') await loadActivity();
      if (view === 'settings') await loadSettings();
    } catch (err) { if (err.message !== 'Signed out') toast(err.message, true); }
    refreshNewCount();
  }

  async function refreshNewCount() {
    try {
      const a = (await api('/api/admin/leads')).leads || [];
      state.leads = a;
      const n = a.filter(l => l.status === 'New').length;
      $('#navNew').hidden = !n;
      $('#navNew').textContent = n;
    } catch { /* ignore */ }
  }

  // ---------- Overview ----------
  const ICON = {
    leads: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    dollar: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1M19 8v6M22 11h-6"/>',
    inv: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 18v-6M9.5 13.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'
  };
  const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  const chg = c => c === null || c === undefined ? '<small class="flat">no prior data</small>' : `<small class="${c > 0 ? 'up' : c < 0 ? 'down' : 'flat'}">${c > 0 ? '▲' : c < 0 ? '▼' : ''} ${Math.abs(c)}% vs prior</small>`;
  $('#ccDays').addEventListener('change', () => loadOverview());
  async function loadOverview() {
    const [d, cc] = await Promise.all([api('/api/admin/dashboard'), api('/api/admin/command-center?days=' + $('#ccDays').value)]);
    $('#todayLine').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + ' · live figures from your records';
    const k = cc.kpis, per = `last ${cc.days} days`;
    const att = k.attention.parts;
    const tiles = [
      { label: 'New leads', sub: per, value: k.new_leads.value, change: k.new_leads.change, icon: 'leads', c: '#1f6fd1', to: 'leads' },
      { label: 'Proposals sent', sub: per, value: k.proposals_sent.value, change: k.proposals_sent.change, icon: 'doc', c: '#2f80ed', to: 'proposals' },
      { label: 'Won', sub: k.won.amount ? money(k.won.amount) : per, value: k.won.value, change: k.won.change, icon: 'check', c: '#1f9d55', to: 'proposals' },
      { label: 'Collected this month', value: money(k.collected_month.value), icon: 'dollar', c: '#178a4c', to: 'invoices' },
      { label: 'Active projects', value: k.active_projects.value, icon: 'cal', c: '#2563eb', to: 'projects' },
      { label: 'Needs attention', value: k.attention.value, icon: 'alert', c: '#d64545', to: att.awaiting_approval ? 'proposals' : (att.open_complaints || att.overdue_tasks) ? 'issues' : att.overdue_invoices ? 'invoices' : att.late_projects ? 'projects' : 'leads', alert: k.attention.value > 0,
        title: `Proposals awaiting approval ${att.awaiting_approval} · open complaints ${att.open_complaints} · overdue tasks ${att.overdue_tasks} · overdue invoices ${att.overdue_invoices} · late projects ${att.late_projects} · leads waiting 2+ days ${att.leads_waiting_2_days} · failed emails (7 days) ${att.failed_emails_7_days}` }
    ];
    $('#ccKpis').innerHTML = tiles.map((t, i) => `<button class="kpi${t.alert ? ' alert' : ''}" data-i="${i}"${t.title ? ` title="${esc(t.title)}"` : ''}><span class="ic" style="background:${t.c}">${svg(t.icon)}</span><span style="min-width:0"><span>${esc(t.label)}</span><b>${esc(t.value)}</b>${'change' in t ? chg(t.change) : `<small class="flat">${esc(t.sub || (t.alert ? 'see details' : ''))}</small>`}</span></button>`).join('');
    $$('#ccKpis .kpi').forEach(b => b.onclick = () => go(tiles[b.dataset.i].to));
    const colors = ['#1d4f91', '#2563eb', '#1497b5', '#1f9d55'];
    $('#ccPipe').innerHTML = cc.pipeline.map((p, i) => `<div class="st" style="--w:${100 - i * 10}%;--c:${colors[i]}"><span>${esc(p.stage)} (${p.n})</span><span>${p.valued ? money(p.v) : ''}</span></div>`).join('')
      + (cc.pipeline.every(p => !p.n) ? '<p class="empty" style="margin-top:6px">Your pipeline fills in as leads, estimates and proposals come in.</p>' : '');
    $('#ccAct').innerHTML = renderActivity(cc.activity) || '<p class="empty">No activity yet.</p>';
    const QA = [
      ['New estimate', 'plus', () => openEstimator()], ['Add customer', 'user', () => { go('customers'); setTimeout(() => $('#custAdd').click(), 300); }],
      ['Create invoice', 'inv', () => openRecord('invoices', null)], ['Add scope item', 'layers', () => { go('scopes'); setTimeout(() => $('#scopeAdd').click(), 400); }],
      ['Review leads', 'inbox', () => go('leads')], ['Back up now', 'save', async () => { try { const r = await api('/api/admin/backups', { method: 'POST' }); toast('Backup created: ' + r.name); } catch (e) { toast(e.message, true); } }]
    ];
    $('#ccQuick').innerHTML = QA.map(([l, ic], i) => `<button type="button" data-qa="${i}">${svg(ic)}${esc(l)}</button>`).join('');
    $$('#ccQuick [data-qa]').forEach(b => b.onclick = QA[b.dataset.qa][2]);
    const PORTALS = [['Multifamily', 'Apartments · units · common areas', '/quote.html?service=multifamily'], ['Construction final clean', 'New builds · punch list · windows', '/quote.html?service=construction_final'],
      ['Commercial janitorial', 'Offices · facilities · recurring', '/quote.html?service=janitorial'], ['Exterior services', 'Power washing · windows · parking', '/quote.html?service=power_washing'], ['Other services', 'Unit turns · valet trash', '/quote.html?service=unit_turnover']];
    $('#ccPortals').innerHTML = PORTALS.map(([t, s2, u]) => `<a href="${u}" target="_blank" rel="noopener"><b>${esc(t)}</b><small>${esc(s2)}</small></a>`).join('');
    $('#ccMods').innerHTML = Object.values(cc.modules).map(m => `<div class="card mod"><div class="cardhead"><h2>${esc(m.label)}</h2>${m.connected ? '<span class="badge green">Ready</span>' : '<span class="badge amber">Setup needed</span>'}</div><p><b>${esc(m.status)}</b>${m.needs ? '<br>' + esc(m.needs) : ''}</p></div>`).join('');

    const list = (el, rows, render, empty) => {
      $(el).innerHTML = rows.length ? rows.map(render).join('') : `<li class="empty" style="cursor:default">${esc(empty)}</li>`;
    };
    list('#ovNew', d.newLeads, l => `<li data-lead="${l.id}"><span><b>${esc(l.contact_name || 'Unnamed')}</b><small>${esc(KIND_LABEL[l.kind] || l.kind)}${l.company ? ' · ' + esc(l.company) : ''}${l.project_name ? ' · ' + esc(l.project_name) : ''}</small></span><span class="r"><small>${esc(ago(l.created_at))}</small></span></li>`, 'No new leads. You’re caught up.');
    list('#ovAwait', d.awaitingResponse, e => `<li data-est="${e.id}"><span><b>${esc(e.customer_name)}</b><small>${esc(e.project_name || e.company || '')}</small></span><span class="r">${money(e.proposal_total)}<small>${esc(e.status)} ${esc(ago(e.updated_at))}</small></span></li>`, d.draftProposals ? `Nothing sent is waiting. ${d.draftProposals} draft proposal(s) not sent yet.` : 'Nothing waiting on a customer.');
    list('#ovDue', d.dueProjects, p => `<li data-rec="projects:${p.id}"><span><b>${esc(p.name || 'Project')}</b><small>${esc(p.company || p.customer_name || '')} · ${esc(p.status)} · ${Number(p.progress || 0)}%</small></span><span class="r">${p.due_date < todayISO() ? '<span class="badge red">Past due</span>' : ''}<small>Due ${fmtDate(p.due_date)}</small></span></li>`, 'No projects due in the next two weeks.');
    list('#ovOverdue', d.overdueInvoices, i => `<li data-rec="invoices:${i.id}"><span><b>${esc(i.invoice_number)}</b><small>${esc(i.company || i.customer_name || '')}</small></span><span class="r">${money(i.amount - i.paid_amount)}<small>Due ${fmtDate(i.due_date)}</small></span></li>`, 'No overdue invoices.');
    $('#ovRenewCard').hidden = !d.renewals.length;
    list('#ovRenew', d.renewals, c => `<li data-rec="contracts:${c.id}"><span><b>${esc(c.title || 'Contract')}</b><small>${esc(c.company || c.customer_name || '')}</small></span><span class="r"><small>Ends ${fmtDate(c.end_date)}</small></span></li>`, '');
    bindOpeners($('#v-overview'));
  }

  function bindOpeners(root) {
    $$('[data-lead]', root).forEach(el => el.onclick = () => openLead(Number(el.dataset.lead)));
    $$('[data-est]', root).forEach(el => el.onclick = () => openEstimate(Number(el.dataset.est)));
    $$('[data-rec]', root).forEach(el => el.onclick = () => { const [t, id] = el.dataset.rec.split(':'); openRecord(t, Number(id)); });
  }

  function renderActivity(rows) {
    return (rows || []).map(x => {
      const who = x.actor === 'website' ? 'Website' : x.actor === 'customer' ? 'Customer' : x.actor;
      const what = `${esc(x.action)} ${esc(x.entity)}${x.entity_id ? ' #' + esc(x.entity_id) : ''}${x.details ? ' — ' + esc(x.details) : ''}`;
      return `<p><time datetime="${esc(x.created_at)}">${esc(fmtWhen(x.created_at))}</time><span><b>${esc(who)}</b> ${what}</span></p>`;
    }).join('');
  }

  // ---------- Leads ----------
  const leadStatusSel = $('#leadStatusFilter');
  leadStatusSel.innerHTML = '<option value="open">All open</option><option value="">Everything (incl. archived)</option>' + options(STATUS.leads);
  $$('#leadKinds button').forEach(b => b.onclick = () => { state.leadKind = b.dataset.kind; renderLeads(); });
  $('#leadSearch').addEventListener('input', () => renderLeads());
  leadStatusSel.addEventListener('change', () => renderLeads());

  async function loadLeads() {
    state.leads = (await api('/api/admin/leads')).leads || [];
    renderLeads();
  }

  function renderLeads() {
    $$('#leadKinds button').forEach(b => {
      const n = state.leads.filter(l => (l.kind || 'bid') === b.dataset.kind && l.status === 'New').length;
      b.classList.toggle('active', b.dataset.kind === state.leadKind);
      b.textContent = { bid: 'Bid requests', inquiry: 'Contact messages', career: 'Job applications' }[b.dataset.kind] + (n ? ` (${n} new)` : '');
    });
    const k = state.leadKind;
    const q = $('#leadSearch').value.trim().toLowerCase();
    const st = leadStatusSel.value;
    const rows = state.leads.filter(l => (l.kind || 'bid') === k)
      .filter(l => st === 'open' ? l.status !== 'Archived' : !st || l.status === st)
      .filter(l => !q || [l.contact_name, l.company, l.email, l.phone, l.project_name, l.address, l.service, l.details].join(' ').toLowerCase().includes(q));
    const heads = {
      bid: ['Received', 'Contact / company', 'Project', 'Services', 'Bid due', 'Status'],
      inquiry: ['Received', 'Name', 'Email / phone', 'Message', 'Status'],
      career: ['Received', 'Name', 'Email / phone', 'Role / message', 'Status']
    }[k];
    $('#leadHead').innerHTML = '<tr>' + heads.map(h => `<th>${h}</th>`).join('') + '</tr>';
    const snippet = (t, n = 90) => esc(String(t || '').replace(/\s+/g, ' ').slice(0, n)) + (String(t || '').length > n ? '…' : '');
    $('#leadRows').innerHTML = rows.length ? rows.map(l => {
      if (k === 'bid') return `<tr class="click" data-lead="${l.id}"><td>${fmtDate(l.created_at)}<small>${esc(ago(l.created_at))}</small></td><td><b>${esc(l.contact_name)}</b><small>${esc(l.company)}</small></td><td>${esc(l.project_name || '—')}<small>${esc(l.address || '')}</small></td><td>${snippet(l.service, 60) || '—'}</td><td>${fmtDate(l.bid_due_date)}</td><td>${badge(l.status)}</td></tr>`;
      return `<tr class="click" data-lead="${l.id}"><td>${fmtDate(l.created_at)}<small>${esc(ago(l.created_at))}</small></td><td><b>${esc(l.contact_name)}</b></td><td>${esc(l.email)}<small>${esc(l.phone || '')}</small></td><td>${snippet(l.details)}</td><td>${badge(l.status)}</td></tr>`;
    }).join('') : `<tr><td class="emptyrow" colspan="${heads.length}">${q || (st && st !== 'open') ? 'No leads match your search.' : 'Nothing here yet. New website submissions will show up automatically.'}</td></tr>`;
    bindOpeners($('#leadRows'));
  }

  async function openLead(id) {
    let l;
    try { l = (await api('/api/admin/leads/' + id)).lead; } catch (err) { return toast(err.message, true); }
    const facts = [
      ['Type', KIND_LABEL[l.kind] || l.kind], ['Received', fmtWhen(l.created_at)], ['Contact', l.contact_name], ['Company', l.company],
      ['Email', l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ''], ['Phone', l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : ''],
      ['Project', l.project_name], ['Project type', l.project_type], ['Services', l.service], ['Site address', l.address],
      ['Square footage', l.square_footage], ['Bid due', l.bid_due_date && fmtDate(l.bid_due_date)], ['Start date', l.start_date && fmtDate(l.start_date)],
      ['Frequency', l.frequency], ['Walkthrough', l.walkthrough]
    ].filter(([, v]) => v);
    const raw = new Set(['Email', 'Phone']);
    const files = (l.files || []);
    let intake = null; try { intake = l.intake ? JSON.parse(l.intake) : null; } catch { intake = null; }
    const flagBox = intake && intake.flags && intake.flags.length ? `<div class="formsection">Needed before pricing</div><ul class="needs">${intake.flags.map(f => `<li>${esc(f.text)}</li>`).join('')}</ul>` : (intake ? '<div class="formsection">Needed before pricing</div><p class="muted">Nothing flagged. The answers cover what is needed to price this service.</p>' : '');
    openDrawer({
      title: l.contact_name || 'Lead #' + l.id,
      sub: `${KIND_LABEL[l.kind] || 'Lead'} #${l.id}${l.company ? ' · ' + l.company : ''}`,
      body: `
        <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${raw.has(k) ? v : esc(v)}</dd>`).join('')}</dl>
        ${flagBox}
        ${l.details ? `<div class="formsection">Details</div><div class="pre">${esc(l.details)}</div>` : ''}
        ${files.length ? `<div class="formsection">Attachments</div><div class="related"><ul>${files.map((f, i) => `<li><button class="linklike" data-file="${i}">${esc(f.name)}</button></li>`).join('')}</ul></div>` : ''}
        <div class="formsection">Follow-up</div>
        <div class="grid">
          <div class="f"><label for="ls">Status</label><select id="ls">${options(STATUS.leads, l.status)}</select></div>
          <div class="f wide"><label for="ln">Internal notes</label><textarea id="ln" placeholder="Calls, site walk notes, next steps. Only visible here.">${esc(l.notes || '')}</textarea></div>
        </div>`,
      footer: `<button class="btn" id="lSave">Save</button>${l.kind !== 'career' ? '<button class="btn ghost" id="lQuote">Build estimate</button>' : ''}<span class="grow"></span><button class="btn danger" id="lDel">Delete</button>`
    });
    $$('[data-file]').forEach(b => b.onclick = () => downloadFile(files[b.dataset.file]));
    $('#lSave').onclick = async () => {
      try {
        await api('/api/admin/leads/' + l.id, { method: 'PATCH', json: { status: $('#ls').value, notes: $('#ln').value } });
        toast('Lead saved'); closeDrawer(); load(state.view);
      } catch (err) { toast(err.message, true); }
    };
    if ($('#lQuote')) $('#lQuote').onclick = () => { closeDrawer(); openEstimator(null, l); };
    $('#lDel').onclick = async () => {
      if (!confirm(`Delete this lead from ${l.contact_name || 'this contact'}? Attachments are deleted too. This can’t be undone.`)) return;
      try { await api('/api/admin/leads/' + l.id, { method: 'DELETE' }); toast('Lead deleted'); closeDrawer(); load(state.view); }
      catch (err) { toast(err.message, true); }
    };
  }

  async function downloadFile(f) {
    try {
      const r = await fetch(f.url, { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) throw new Error('File not available');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = f.name || 'attachment';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (err) { toast(err.message, true); }
  }

  $('#exportCsv').addEventListener('click', () => {
    const k = state.leadKind;
    const rows = state.leads.filter(l => (l.kind || 'bid') === k);
    const cols = ['id', 'created_at', 'kind', 'status', 'contact_name', 'company', 'email', 'phone', 'project_name', 'project_type', 'service', 'address', 'square_footage', 'bid_due_date', 'start_date', 'frequency', 'details', 'notes'];
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const blob = new Blob([[cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bright-clean-${{ bid: 'bid-requests', inquiry: 'contact-messages', career: 'job-applications' }[k]}-${todayISO()}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------- Customers ----------
  $('#custSearch').addEventListener('input', () => renderCustomers());
  async function loadCustomers() {
    state.customers = (await api('/api/admin/customers')).customers || [];
    renderCustomers();
  }
  function renderCustomers() {
    const q = $('#custSearch').value.trim().toLowerCase();
    const rows = state.customers.filter(c => !q || [c.company, c.name, c.email, c.phone, c.notes].join(' ').toLowerCase().includes(q));
    $('#custRows').innerHTML = rows.length ? rows.map(c => `<tr class="click" data-cust="${c.id}"><td><b>${esc(c.company || c.name || c.email)}</b>${c.company && c.name ? `<small>${esc(c.name)}</small>` : ''}</td><td>${esc(c.email || '—')}<small>${esc(c.phone || '')}</small></td><td class="num">${c.leads.length}</td><td class="num">${c.proposals.length}</td><td class="num">${c.projects.length}</td><td class="num">${money(c.billed)}</td><td class="num">${c.billed - c.paid > 0 ? `<b>${money(c.billed - c.paid)}</b>` : money(0)}</td></tr>`).join('')
      : `<tr><td class="emptyrow" colspan="7">${q ? 'No customers match your search.' : 'Customers are added automatically from bid requests, inquiries and estimates, or click “Add customer”.'}</td></tr>`;
    $$('[data-cust]').forEach(r => r.onclick = () => openCustomer(state.customers.find(c => c.id === Number(r.dataset.cust))));
  }
  $('#custAdd').addEventListener('click', () => openCustomer(null));
  function openCustomer(c) {
    const isNew = !c;
    c = c || { name: '', company: '', email: '', phone: '', address: '', notes: '', leads: [], proposals: [], contracts: [], projects: [], invoices: [], billed: 0, paid: 0 };
    const sec = (title, items, render) => items.length ? `<h3>${title} (${items.length})</h3><ul>${items.map(render).join('')}</ul>` : '';
    openDrawer({
      title: isNew ? 'New customer' : (c.company || c.name || c.email),
      sub: isNew ? '' : `Customer since ${fmtDate(c.created_at)} · source: ${c.source || '—'}`,
      body: `
        ${isNew ? '' : `<div class="stats" style="grid-template-columns:repeat(3,1fr)"><div class="stat" style="cursor:default"><span>Billed</span><b>${money(c.billed)}</b></div><div class="stat" style="cursor:default"><span>Collected</span><b>${money(c.paid)}</b></div><div class="stat" style="cursor:default"><span>Open balance</span><b>${money(c.billed - c.paid)}</b></div></div>`}
        <form id="custForm" class="grid" novalidate>
          <div class="f"><label for="c1">Contact name</label><input id="c1" name="name" value="${esc(c.name)}"></div>
          <div class="f"><label for="c2">Company</label><input id="c2" name="company" value="${esc(c.company)}"></div>
          <div class="f"><label for="c3">Email</label><input id="c3" name="email" type="email" value="${esc(c.email)}"${isNew ? '' : ' readonly title="Email links this customer to their records"'}></div>
          <div class="f"><label for="c4">Phone</label><input id="c4" name="phone" value="${esc(c.phone)}"></div>
          <div class="f wide"><label for="c5">Address</label><input id="c5" name="address" value="${esc(c.address)}"></div>
          <div class="f wide"><label for="c6">Notes</label><textarea id="c6" name="notes" placeholder="Billing contacts, site access, preferences">${esc(c.notes)}</textarea></div>
        </form><p class="msg" id="custMsg" role="status"></p>
        ${isNew ? '' : `<div class="related">
          ${sec('Leads', c.leads, x => `<li><button class="linklike" data-lead="${x.id}">${esc(KIND_LABEL[x.kind] || 'Lead')} #${x.id}${x.project_name ? ' · ' + esc(x.project_name) : ''}</button> ${badge(x.status)} <small>${fmtDate(x.created_at)}</small></li>`)}
          ${sec('Proposals', c.proposals, x => `<li><button class="linklike" data-est="${x.id}">${esc(x.project_name || 'Proposal #' + x.id)}</button> ${money(x.proposal_total)} ${badge(x.status)}</li>`)}
          ${sec('Contracts', c.contracts, x => `<li><button class="linklike" data-rec="contracts:${x.id}">${esc(x.title || 'Contract #' + x.id)}</button> ${money(x.value)} ${badge(x.status)}</li>`)}
          ${sec('Projects', c.projects, x => `<li><button class="linklike" data-rec="projects:${x.id}">${esc(x.name || 'Project #' + x.id)}</button> ${badge(x.status)} ${Number(x.progress || 0)}%</li>`)}
          ${sec('Invoices', c.invoices, x => `<li><button class="linklike" data-rec="invoices:${x.id}">${esc(x.invoice_number)}</button> ${money(x.amount)} ${badge(invoiceState(x))}</li>`)}
        </div>`}
        ${isNew ? '' : '<div class="cardhead" style="margin-top:14px"><h3 style="margin:0">Notes, complaints &amp; tasks</h3><button class="btn ghost" id="cIssue" type="button">Add</button></div><div id="cIssues" class="related"><p class="muted">Loading…</p></div>'}`,
      footer: `<button class="btn" id="cSave">${isNew ? 'Add customer' : 'Save'}</button>${isNew ? '' : `<button class="btn ghost" id="cQuote">New estimate</button>${c.email ? `<a class="btn ghost" href="mailto:${esc(c.email)}">Email</a>` : ''}<span class="grow"></span><button class="btn danger" id="cDel">Remove</button>`}`
    });
    bindOpeners($('#drawerRoot'));
    $('#cSave').onclick = async () => {
      const v = formObj($('#custForm'));
      try {
        if (isNew) await api('/api/admin/customers', { method: 'POST', json: v });
        else { delete v.email; await api('/api/admin/customers/' + c.id, { method: 'PATCH', json: v }); }
        toast(isNew ? 'Customer added' : 'Saved'); closeDrawer(); loadCustomers();
      } catch (err) { $('#custMsg').className = 'msg err'; $('#custMsg').textContent = err.message; }
    };
    if (!isNew) {
      $('#cQuote').onclick = () => { closeDrawer(); openEstimator(null, { contact_name: c.name, company: c.company, email: c.email, address: c.address }); };
      $('#cIssue').onclick = () => openIssue(null, c);
      api('/api/admin/issues?status=all&customer_id=' + c.id).then(r => {
        const box = $('#cIssues'); if (!box) return;
        box.innerHTML = r.issues.length ? '<ul>' + r.issues.map(i => `<li><button class="linklike" data-iss="${i.id}">${esc(i.title)}</button> ${badge(r.options.types[i.type])} ${badge(i.status)}${i.overdue ? ' <span class="badge red">Overdue</span>' : ''} <small>${fmtDate(i.created_at)}</small></li>`).join('') + '</ul>' : '<p class="muted">Nothing recorded yet.</p>';
        $$('#cIssues [data-iss]').forEach(b => b.onclick = () => openIssue(r.issues.find(i => i.id === Number(b.dataset.iss)), c));
      }).catch(() => { const box = $('#cIssues'); if (box) box.innerHTML = '<p class="muted">Could not load.</p>'; });
      $('#cDel').onclick = async () => {
        if (!confirm('Remove this customer from the directory? Their leads, proposals, contracts, projects and invoices are kept.')) return;
        try { await api('/api/admin/customers/' + c.id, { method: 'DELETE' }); toast('Removed'); closeDrawer(); loadCustomers(); } catch (err) { toast(err.message, true); }
      };
    }
  }

  // ---------- Estimates ----------
  $('#propStatusFilter').innerHTML = '<option value="">All statuses</option>' + options(STATUS.estimates);
  $('#propSearch').addEventListener('input', () => renderEstimates());
  $('#propStatusFilter').addEventListener('change', () => renderEstimates());

  async function loadEstimates() {
    state.estimates = (await api('/api/admin/estimates')).estimates || [];
    renderEstimates();
  }
  function renderEstimates() {
    const q = $('#propSearch').value.trim().toLowerCase();
    const st = $('#propStatusFilter').value;
    const rows = state.estimates.filter(e => !st || e.status === st)
      .filter(e => !q || [e.customer_name, e.company, e.project_name, e.email, e.site_address].join(' ').toLowerCase().includes(q));
    $('#propRows').innerHTML = rows.length ? rows.map(e => {
      const expired = e.expires_on && e.expires_on < todayISO() && !['Approved', 'Declined'].includes(e.status);
      return `<tr class="click" data-est="${e.id}"><td>${fmtDate(e.created_at)}</td><td><b>${esc(e.customer_name)}</b><small>${esc([e.company, e.project_name].filter(Boolean).join(' · '))}</small></td><td class="num"><b>${money(e.proposal_total)}</b></td><td>${badge(e.status)}</td><td>${e.expires_on ? fmtDate(e.expires_on) : '—'}${expired ? ' <span class="badge red">Expired</span>' : ''}</td><td><div class="rowactions"><button class="btn small ghost" data-edit="${e.id}">Edit</button></div></td></tr>`;
    }).join('') : `<tr><td class="emptyrow" colspan="6">${q || st ? 'No proposals match your search.' : 'No estimates yet. Click “New estimate” to build your first proposal.'}</td></tr>`;
    $$('#propRows [data-est]').forEach(r => r.onclick = e => { if (!e.target.closest('[data-edit]')) openEstimate(Number(r.dataset.est)); });
    $$('#propRows [data-edit]').forEach(b => b.onclick = () => editEstimate(Number(b.dataset.edit)));
  }

  async function openEstimate(id) {
    let e;
    try { e = (await api('/api/admin/estimates/' + id)).estimate; } catch (err) { return toast(err.message, true); }
    const url = location.origin + '/proposal/' + e.public_token;
    const items = e.line_items || [];
    openDrawer({
      title: e.project_name || 'Proposal #' + e.id,
      sub: `${e.customer_name}${e.company ? ' · ' + e.company : ''} · created ${fmtDate(e.created_at)}`,
      body: `
        <dl class="facts">
          <dt>Proposal total</dt><dd><b style="font-size:20px;color:var(--navy)">${money(e.proposal_total)}</b></dd>
          <dt>Cost incl. overhead</dt><dd>${money(e.total_cost)} · ${Number(e.labor_hours || 0).toFixed(1)} labor hours</dd>
          <dt>Gross margin</dt><dd>${Number(e.margin_pct || 0)}% · profit ${money(e.proposal_total / (1 + Number(e.tax_pct || 0) / 100) - e.total_cost)}</dd>
          <dt>Email</dt><dd>${esc(e.email || '— add one to email the proposal')}</dd>
          <dt>Site</dt><dd>${esc(e.site_address || '—')}</dd>
          <dt>Valid through</dt><dd>${fmtDate(e.expires_on)}</dd>
          <dt>Crew plan</dt><dd>${Number(e.crew_days || 0).toFixed(1)} crew days · ${Number(e.visits || 1)} visit(s) · crew of ${Number(e.crew_size || 1)}</dd>
          <dt>Sent</dt><dd>${e.sent_at ? esc(fmtWhen(e.sent_at)) : 'Not emailed yet'}</dd>
          <dt>Customer viewed</dt><dd>${e.viewed_at ? `First ${esc(fmtWhen(e.viewed_at))}${e.view_count > 1 ? ` · ${e.view_count} views, last ${esc(fmtWhen(e.last_viewed_at))}` : ''}` : 'Not yet'}</dd>
          ${e.decided_at ? `<dt>Decision</dt><dd>${badge(e.status)} ${esc(fmtWhen(e.decided_at))}${e.decision_ip ? ' · by the customer online' : ' · set in admin'}</dd>` : ''}
          ${e.lead_id ? `<dt>From lead</dt><dd><button class="linklike" data-lead="${e.lead_id}">Lead #${e.lead_id}</button></dd>` : ''}
        </dl>
        <div id="apprBox"></div>
        <div class="grid"><div class="f"><label for="es">Status</label><select id="es"${e.decision_ip ? ' disabled' : ''}>${options(STATUS.estimates, e.status)}</select><span class="hint">${e.decision_ip ? 'Locked: the customer made this decision online. Duplicate the proposal to revise it.' : 'Updates automatically when the customer views, approves or declines.'}</span></div></div>
        <div class="formsection">Scope</div><div class="pre">${esc(e.scope)}</div>
        ${items.length ? `<div class="formsection">Line items</div><table class="t"><tbody>${items.map(i => `<tr><td>${esc(i.description)}</td><td class="num">${money(i.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${e.terms ? `<div class="formsection">Terms</div><div class="pre">${esc(e.terms)}</div>` : ''}
        <div class="formsection">Customer link</div>
        <div class="f"><input readonly value="${esc(url)}" id="eUrl" aria-label="Customer proposal link"></div>`,
      footer: `
        <button class="btn" id="eSend"${e.email ? '' : ' disabled title="Add a customer email first"'}>Email to customer</button>
        <a class="btn ghost" href="${esc(url)}?preview=1" target="_blank" rel="noopener">Preview customer view</a>
        <button class="btn ghost" id="eCopy">Copy link</button>
        <button class="btn ghost" id="eEdit"${e.status === 'Approved' ? ' disabled title="Approved proposals are locked. Duplicate to change."' : ''}>Edit</button>
        <button class="btn ghost" id="eDup">Duplicate</button>
        <span class="grow"></span>
        <button class="btn danger" id="eDel"${e.status === 'Approved' ? ' disabled title="Approved proposals are kept for your records."' : ''}>Delete</button>`
    });
    bindOpeners($('#drawerRoot'));
    api(`/api/admin/estimates/${e.id}/approval`).then(ap => {
      const box = $('#apprBox'); if (!box) return;
      if (ap.blocked) { box.innerHTML = `<div class="needs" style="background:var(--redbg);color:var(--red)"><b>Can't be sent yet:</b> ${esc(ap.blocked)}</div>`; return; }
      if (!ap.required) { box.innerHTML = ''; return; }
      const ok = ap.approval && ap.approval.valid;
      box.innerHTML = `<div class="formsection">Approval</div><ul class="needs">${ap.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`
        + (ok ? `<p><span class="badge green">Approved</span> by ${esc(ap.approval.approved_by || 'owner')} ${esc(fmtWhen(ap.approval.created_at))}${ap.approval.note ? ' — ' + esc(ap.approval.note) : ''}</p>`
          : `${ap.approval ? '<p class="muted">An earlier approval no longer applies because the proposal was edited.</p>' : ''}${ap.can_approve ? '<div class="grid"><div class="f wide"><label for="apNote">Approval note (optional)</label><input id="apNote" placeholder="Why this is OK to send"></div></div><button class="btn" type="button" id="apGo">Approve for sending</button>' : '<p class="muted">Waiting for the owner to approve.</p>'}`);
      if ($('#apGo')) $('#apGo').onclick = async () => {
        try { await api(`/api/admin/estimates/${e.id}/approve`, { method: 'POST', json: { note: $('#apNote').value } }); toast('Approved for sending'); openEstimate(e.id); }
        catch (err) { toast(err.message, true); }
      };
    }).catch(() => { /* approval info optional */ });
    $('#es').onchange = async ev => {
      try { await api('/api/admin/estimates/' + e.id, { method: 'PATCH', json: { status: ev.target.value } }); toast('Status updated'); loadEstimates(); }
      catch (err) { ev.target.value = e.status; toast(err.message, true); }
    };
    $('#eCopy').onclick = () => navigator.clipboard.writeText(url).then(() => toast('Link copied')).catch(() => { $('#eUrl').select(); toast('Press Ctrl+C to copy'); });
    $('#eSend').onclick = async () => {
      if (!confirm(`Email this proposal to ${e.email}?`)) return;
      try { const r = await api(`/api/admin/estimates/${e.id}/send`, { method: 'POST' }); toast(r.message || 'Sent'); closeDrawer(); loadEstimates(); }
      catch (err) { toast(err.message, true); }
    };
    $('#eEdit').onclick = () => { closeDrawer(); editEstimate(e.id); };
    $('#eDup').onclick = async () => {
      try { const r = await api(`/api/admin/estimates/${e.id}/duplicate`, { method: 'POST' }); toast('Copy created'); closeDrawer(); editEstimate(r.id); }
      catch (err) { toast(err.message, true); }
    };
    $('#eDel').onclick = async () => {
      if (!confirm('Delete this proposal? The customer link will stop working. This can’t be undone.')) return;
      try { await api('/api/admin/estimates/' + e.id, { method: 'DELETE' }); toast('Proposal deleted'); closeDrawer(); load(state.view); }
      catch (err) { toast(err.message, true); }
    };
  }

  // Estimator form
  const ef = $('#estimateForm');
  const DEFAULTS = { area_sqft: 0, production_rate: 0, labor_hours: 0, labor_rate: 0, supplies_cost: 0, equipment_cost: 0, other_cost: 0, overhead_pct: 10, margin_pct: 25, tax_pct: 0, visits: 1, crew_size: 1, shift_hours: 8, travel_cost: 0, mobilization_cost: 0, subcontractor_cost: 0, disposal_cost: 0, insurance_pct: 0, contingency_pct: 0, minimum_charge: 0 };
  const EXTRA_KEYS = ['visits', 'crew_size', 'shift_hours', 'travel_cost', 'mobilization_cost', 'subcontractor_cost', 'disposal_cost', 'insurance_pct', 'contingency_pct', 'minimum_charge', 'template_key'];
  let templates = [];
  async function loadTemplates() {
    if (templates.length) return;
    try { templates = (await api('/api/admin/templates')).templates || []; } catch { return; }
    $('#eT').innerHTML = '<option value="">No template</option>' + templates.map(t => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join('');
  }
  $('#eT').addEventListener('change', () => {
    const t = templates.find(x => x.key === $('#eT').value); if (!t) return;
    const f = ef.elements;
    if (f.scope.value.trim() && !confirm('Replace the current scope and terms with this template?')) return;
    f.scope.value = t.scope || ''; f.terms.value = t.terms || '';
    if (t.production_rate) f.production_rate.value = t.production_rate;
    if (t.labor_rate) f.labor_rate.value = t.labor_rate;
    calcEstimate();
  });

  function openEstimator(est, lead) {
    ef.reset();
    ef.elements.id.value = '';
    Object.entries(DEFAULTS).forEach(([k, v]) => { ef.elements[k].value = v; });
    const d = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    ef.elements.expires_on.value = d;
    ef.elements.use_line_items.checked = false;
    loadTemplates();
    scopeLines = []; loadScopeLibrary();
    if (lead) {
      try { const ik = lead.intake ? JSON.parse(lead.intake) : null; if (ik && ik.category) $('#slCat').dataset.want = ik.category; } catch { /* no intake */ }
      Object.entries({
        lead_id: lead.id || '', customer_name: lead.contact_name || '', company: lead.company || '', email: lead.email || '',
        project_name: lead.project_name || '', site_address: lead.address || '',
        area_sqft: parseFloat(String(lead.square_footage || '').replace(/,/g, '')) || 0,
        scope: lead.id ? [lead.service && 'Requested services: ' + lead.service, lead.details].filter(Boolean).join('\n\n') : ''
      }).forEach(([k, v]) => { if (ef.elements[k]) ef.elements[k].value = v; });
    }
    if (est) {
      ['id', 'lead_id', 'customer_name', 'company', 'email', 'project_name', 'site_address', 'scope', 'area_sqft', 'production_rate', 'labor_rate', 'supplies_cost', 'equipment_cost', 'other_cost', 'overhead_pct', 'margin_pct', 'tax_pct', 'expires_on', 'terms']
        .forEach(k => { if (ef.elements[k]) ef.elements[k].value = est[k] ?? ''; });
      const derived = est.area_sqft && est.production_rate ? est.area_sqft / est.production_rate : 0;
      ef.elements.labor_hours.value = Math.abs(derived - est.labor_hours) > 0.01 ? est.labor_hours : 0;
      scopeLines = (est.line_items || []).filter(i => i.scope_id);
      ef.elements.line_items_text.value = (est.line_items || []).filter(i => !i.scope_id).map(i => `${i.description} | ${i.amount}`).join('\n');
      $('#slCat').dataset.want = est.scope_category || '';
      EXTRA_KEYS.forEach(k => { if (ef.elements[k] && est[k] !== undefined && est[k] !== null) ef.elements[k].value = est[k]; });
      ef.elements.use_line_items.checked = !!est.use_line_items;
      if (est.visits > 1 && Math.abs(derived * est.visits - est.labor_hours) < 0.01) ef.elements.labor_hours.value = 0;
      else if (est.visits > 1) ef.elements.labor_hours.value = +(est.labor_hours / est.visits).toFixed(2);
    }
    if (!est && !(lead && lead.intake)) $('#slCat').dataset.want = '';
    syncScopeCat(); renderScopeLines();
    $('#estTitle').textContent = est ? `Edit estimate — ${est.project_name || est.customer_name}` : 'New estimate';
    $('#estSave').textContent = est ? 'Save changes' : 'Save estimate';
    $('#estMsg').textContent = '';
    calcEstimate();
    go('estimator');
  }
  async function editEstimate(id) {
    try { openEstimator((await api('/api/admin/estimates/' + id)).estimate); } catch (err) { toast(err.message, true); }
  }

  // ---------- Scope library lines on estimates ----------
  let scopeLines = [];
  async function loadScopeLibrary() {
    if (!scopeState.items.length) {
      try { Object.assign(scopeState, await api('/api/admin/scopes')); } catch { return; }
    }
    syncScopeCat();
  }
  function syncScopeCat() {
    const sel = $('#slCat'), want = sel.dataset.want ?? sel.value;
    sel.innerHTML = '<option value="">Service category…</option>' + Object.entries(scopeState.categories || {}).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    sel.value = want || ''; sel.dataset.prev = sel.value; delete sel.dataset.want;
    fillScopeItems();
  }
  function fillScopeItems() {
    const cat = $('#slCat').value, sel = $('#slItem');
    const items = scopeState.items.filter(i => i.active && i.category === cat);
    sel.disabled = !cat;
    sel.innerHTML = !cat ? '<option value="">Choose a category first</option>'
      : '<option value="">Choose an item…</option>' + items.map(i => `<option value="${i.id}"${i.missing.length ? ' disabled' : ''}>${esc(i.name)} — per ${esc(i.unit)}${i.missing.length ? ' (needs rates)' : ''}</option>`).join('');
    const ready = items.filter(i => !i.missing.length).length;
    $('#slHint').textContent = cat && !ready ? 'No items in this category have rates yet. Add production rates and prices under Cleaning scopes to price from the library.'
      : 'Only items from the chosen category can be used, so construction work is never priced with janitorial rates. Lines are priced from your rates in Cleaning scopes; saving re-prices them at the current rates.';
  }
  $('#slCat').addEventListener('change', e => {
    const sel = e.target, other = scopeLines.filter(l => l.category !== sel.value);
    if (other.length && !confirm(`Changing the category removes ${other.length} library line(s) from another category. Continue?`)) { sel.value = sel.dataset.prev || ''; return; }
    scopeLines = scopeLines.filter(l => l.category === sel.value);
    sel.dataset.prev = sel.value; fillScopeItems(); renderScopeLines(); calcEstimate();
  });
  function priceLine(it, qty) {
    const hours = qty / it.production_rate;
    const laborRate = Number(ef.elements.labor_rate.value) || 0;
    const amount = it.pricing_method === 'hourly' ? hours * laborRate : it.pricing_method === 'lump_sum' ? it.unit_price : qty * it.unit_price;
    const r = n => Math.round(n * 100) / 100;
    return { scope_id: it.id, description: `${it.name} (${Number.isInteger(qty) ? qty.toLocaleString('en-US') : r(qty)} ${it.unit})`, category: it.category, unit: it.unit,
      quantity: qty, unit_price: it.unit_price, production_rate: it.production_rate, pricing_method: it.pricing_method, hours: r(hours), amount: r(amount) };
  }
  function repriceHourly() {
    scopeLines = scopeLines.map(l => { const it = scopeState.items.find(i => i.id === l.scope_id); return it && l.pricing_method === 'hourly' ? priceLine(it, l.quantity) : l; });
    renderScopeLines();
  }
  $('#slAdd').addEventListener('click', () => {
    const it = scopeState.items.find(i => i.id === Number($('#slItem').value));
    const qty = Number(String($('#slQty').value).replace(/,/g, ''));
    if (!it) { toast('Choose a scope item.', true); return; }
    if (!Number.isFinite(qty) || qty <= 0) { toast('Enter a quantity above zero.', true); $('#slQty').focus(); return; }
    scopeLines.push(priceLine(it, qty));
    if (scopeLines.length === 1 && !parseLines(ef.elements.line_items_text.value).length) ef.elements.use_line_items.checked = true;
    $('#slQty').value = ''; $('#slItem').value = '';
    renderScopeLines(); calcEstimate();
  });
  function renderScopeLines() {
    $('#slWrap').hidden = !scopeLines.length;
    $('#slRows').innerHTML = scopeLines.map((l, i) => `<tr><td>${esc(l.description)}<small>${l.pricing_method === 'hourly' ? 'Hourly' : l.pricing_method === 'lump_sum' ? 'Lump sum' : money(l.unit_price) + ' / ' + esc(l.unit)} · ${Number(l.production_rate).toLocaleString()} ${esc(l.unit)}/hr</small></td><td class="num">${Number(l.quantity).toLocaleString()}</td><td class="num">${Number(l.hours).toFixed(2)}</td><td class="num">${money(l.amount)}</td><td><button type="button" class="btn ghost" data-slrm="${i}" aria-label="Remove line">Remove</button></td></tr>`).join('');
    $$('[data-slrm]').forEach(b => b.onclick = () => { scopeLines.splice(Number(b.dataset.slrm), 1); renderScopeLines(); calcEstimate(); });
  }

  function parseLines(text) {
    return String(text || '').split('\n').map(s => s.trim()).filter(Boolean).map(line => {
      const i = line.lastIndexOf('|');
      const description = (i >= 0 ? line.slice(0, i) : line).trim();
      const amount = i >= 0 ? Number(line.slice(i + 1).replace(/[$,\s]/g, '')) || 0 : 0;
      return { description, amount };
    });
  }

  // Mirrors estimating.js on the server.
  function estimateMath(v) {
    const n = k => Math.max(0, Number(v[k] || 0));
    const visits = Math.max(1, n('visits') || 1);
    const scopeHours = scopeLines.reduce((t, l) => t + Number(l.hours || 0), 0);
    const perVisit = n('labor_hours') || (n('area_sqft') && n('production_rate') ? n('area_sqft') / n('production_rate') : 0) || scopeHours;
    const hours = perVisit * visits;
    const labor = hours * n('labor_rate');
    const direct = labor + n('supplies_cost') + n('equipment_cost') + n('other_cost') + n('travel_cost') * visits + n('mobilization_cost') + n('subcontractor_cost') + n('disposal_cost');
    const insurance = direct * n('insurance_pct') / 100;
    const contingency = (direct + insurance) * n('contingency_pct') / 100;
    const overhead = (direct + insurance + contingency) * n('overhead_pct') / 100;
    const cost = direct + insurance + contingency + overhead;
    let price = cost / (1 - Math.min(90, n('margin_pct')) / 100);
    const items = [...scopeLines, ...parseLines(v.line_items_text)];
    const itemsTotal = items.reduce((s, i) => s + i.amount, 0);
    const useItems = !!v.use_line_items && itemsTotal > 0;
    if (useItems) price = itemsTotal;
    const minApplied = !useItems && n('minimum_charge') > 0 && price < n('minimum_charge');
    if (minApplied) price = n('minimum_charge');
    const total = price * (1 + n('tax_pct') / 100);
    const crewDays = hours / (Math.max(1, n('crew_size') || 1) * (n('shift_hours') || 8));
    return { hours, cost, price, total, crewDays, items, itemsTotal, useItems, minApplied, n };
  }
  function calcEstimate() {
    const v = formObj(ef);
    const m = estimateMath(v), n = m.n;
    $('#cHours').textContent = m.hours.toFixed(2);
    $('#cCost').textContent = money(m.cost);
    $('#cProfit').textContent = money(m.price - m.cost);
    $('#cTotal').textContent = money(m.total);
    $('#cDays').textContent = m.crewDays.toFixed(1);
    const warn = [];
    if (scopeLines.some(l => l.pricing_method === 'hourly') && !n('labor_rate')) warn.push('Some library lines are priced hourly. Enter the labor cost per hour to price them.');
    if (n('area_sqft') && !n('production_rate') && !n('labor_hours')) warn.push('Enter a production rate or labor hours, or labor won’t be counted.');
    if (m.hours && !n('labor_rate')) warn.push('Labor hours are set but the labor cost per hour is 0.');
    if (m.minApplied) warn.push(`The minimum job charge of ${money(n('minimum_charge'))} is being used.`);
    if (m.useItems && m.price < m.cost) warn.push(`The line-item total (${money(m.itemsTotal)}) is below your cost (${money(m.cost)}).`);
    if (!m.useItems && m.items.length && Math.abs(m.itemsTotal - m.price) > 1 && Math.abs(m.itemsTotal - m.total) > 1) warn.push(`Line items add up to ${money(m.itemsTotal)}, but the proposal total is ${money(m.total)}. The customer will see both. Check “Use the line-item total as the price” if the line items are the price.`);
    if (n('margin_pct') > 90) warn.push('Gross margin is capped at 90%.');
    $('#cWarn').hidden = !warn.length;
    $('#cWarn').textContent = warn.join(' ');
  }
  ef.addEventListener('input', e => { if (e.target && e.target.name === 'labor_rate') repriceHourly(); calcEstimate(); });

  ef.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#estMsg');
    const b = formObj(ef);
    if (!b.customer_name.trim() || !b.scope.trim()) { msg.className = 'msg err'; msg.textContent = 'Contact name and scope of work are required.'; return; }
    b.line_items = [...scopeLines.map(l => ({ scope_id: l.scope_id, quantity: l.quantity, description: l.description, amount: l.amount })), ...parseLines(b.line_items_text)];
    delete b.line_items_text;
    const id = b.id; delete b.id;
    msg.className = 'msg'; msg.textContent = 'Saving…';
    $('#estSave').disabled = true;
    try {
      let saved;
      if (id) saved = (await api('/api/admin/estimates/' + id, { method: 'PUT', json: b })).estimate;
      else saved = (await api('/api/admin/estimates', { method: 'POST', json: b })).estimate;
      if (b.lead_id && !id) {
        try { await api('/api/admin/leads/' + Number(b.lead_id), { method: 'PATCH', json: { status: 'Proposal in Progress' } }); } catch { /* lead may not exist */ }
      }
      toast(id ? 'Estimate updated' : 'Estimate saved');
      go('proposals');
      openEstimate(saved.id);
    } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    finally { $('#estSave').disabled = false; }
  });

  // ---------- Contracts / projects / invoices ----------
  const REG = {
    contracts: {
      label: 'contract', status: STATUS.contracts, extra: ['notes'],
      fields: [
        ['title', 'Contract title *', 'text', { wide: true, required: true }],
        ['customer_name', 'Customer contact'], ['company', 'Company'],
        ['start_date', 'Start date', 'date'], ['end_date', 'End / renewal date', 'date'],
        ['value', 'Contract value ($)', 'number'], ['estimate_id', 'From proposal #', 'number'],
        ['status', 'Status', 'select', { list: STATUS.contracts }], ['signature_status', 'Signature', 'select', { list: STATUS.signature }],
        ['scope', 'Scope / agreement summary', 'textarea', { wide: true }], ['notes', 'Notes (PO numbers, insurance, contacts)', 'textarea', { wide: true }]
      ],
      search: r => [r.title, r.customer_name, r.company, r.scope, r.notes],
      row: r => `<td><b>${esc(r.title || 'Contract #' + r.id)}</b>${r.estimate_id ? `<small>From proposal #${esc(r.estimate_id)}</small>` : ''}</td><td>${esc(r.company || r.customer_name || '—')}${r.company && r.customer_name ? `<small>${esc(r.customer_name)}</small>` : ''}</td><td>${r.start_date || r.end_date ? `${fmtDate(r.start_date)}<small>to ${fmtDate(r.end_date)}</small>` : '<small>No dates set</small>'}</td><td class="num">${money(r.value)}</td><td>${badge(r.signature_status)}</td><td>${badge(r.status)}</td>`,
      cols: 6
    },
    projects: {
      label: 'project', status: STATUS.projects, extra: [],
      fields: [
        ['name', 'Project name *', 'text', { wide: true, required: true }],
        ['customer_name', 'Customer contact'], ['company', 'Company'],
        ['site_address', 'Site address', 'text', { wide: true }],
        ['manager', 'Project manager'], ['contract_id', 'Contract #', 'number'],
        ['start_date', 'Start date', 'date'], ['due_date', 'Target completion', 'date'],
        ['status', 'Status', 'select', { list: STATUS.projects }], ['progress', 'Progress (%)', 'number', { min: 0, max: 100 }],
        ['notes', 'Notes / site requirements', 'textarea', { wide: true }]
      ],
      search: r => [r.name, r.customer_name, r.company, r.site_address, r.manager, r.notes],
      row: r => {
        const late = r.due_date && r.due_date < todayISO() && !['Completed', 'On Hold'].includes(r.status);
        return `<td><b>${esc(r.name || 'Project #' + r.id)}</b><small>${esc(r.site_address || '')}</small></td><td>${esc(r.company || r.customer_name || '—')}</td><td>${esc(r.manager || '—')}</td><td>${fmtDate(r.start_date)}<small>Due ${fmtDate(r.due_date)}${late ? ' · <span class="badge red">Past due</span>' : ''}</small></td><td>${Number(r.progress || 0)}%<div class="bar"><i style="width:${Math.min(100, Number(r.progress || 0))}%"></i></div></td><td>${badge(r.status)}</td>`;
      },
      cols: 6
    },
    invoices: {
      label: 'invoice', status: STATUS.invoices, extra: ['notes', 'issue_date'],
      fields: [
        ['invoice_number', 'Invoice number *', 'text', { required: true }], ['project_id', 'Project #', 'number'],
        ['customer_name', 'Customer contact'], ['company', 'Company'],
        ['email', 'Billing email', 'email', { wide: true, hint: 'Needed for automatic payment reminders.' }],
        ['issue_date', 'Invoice date', 'date'], ['due_date', 'Due date', 'date'],
        ['amount', 'Amount ($) *', 'number', { required: true }], ['paid_amount', 'Paid to date ($)', 'number'],
        ['status', 'Status', 'select', { list: STATUS.invoices }],
        ['notes', 'Description / notes (shown on the printed invoice)', 'textarea', { wide: true }]
      ],
      search: r => [r.invoice_number, r.customer_name, r.company, r.notes],
      row: r => {
        const bal = Math.max(0, Number(r.amount || 0) - Number(r.paid_amount || 0));
        return `<td><b>${esc(r.invoice_number)}</b>${r.project_id ? `<small>Project #${esc(r.project_id)}</small>` : ''}</td><td>${esc(r.company || r.customer_name || '—')}</td><td>${fmtDate(r.due_date)}</td><td class="num">${money(r.amount)}</td><td class="num">${bal ? `<b>${money(bal)}</b>` : money(0)}</td><td>${badge(invoiceState(r))}</td><td><div class="rowactions">${bal && !['Void', 'Draft'].includes(r.status) ? `<button class="btn small ghost" data-pay="${r.id}">Record payment</button>` : ''}</div></td>`;
      },
      cols: 7
    }
  };

  $$('[data-filter]').forEach(sel => {
    sel.innerHTML = '<option value="">All statuses</option>' + options(REG[sel.dataset.filter].status);
    sel.addEventListener('change', () => renderRegister(sel.dataset.filter));
  });
  $$('[data-search]').forEach(inp => inp.addEventListener('input', () => renderRegister(inp.dataset.search)));

  async function loadRegister(t) {
    state[t] = (await api('/api/admin/' + t))[t] || [];
    renderRegister(t);
    if (t === 'invoices') renderFinance();
  }

  function renderRegister(t) {
    const cfg = REG[t];
    const q = ($(`[data-search="${t}"]`).value || '').trim().toLowerCase();
    const st = $(`[data-filter="${t}"]`).value;
    const rows = state[t].filter(r => !st || (t === 'invoices' ? invoiceState(r) === st : r.status === st))
      .filter(r => !q || cfg.search(r).join(' ').toLowerCase().includes(q));
    $('#rows-' + t).innerHTML = rows.length ? rows.map(r => `<tr class="click" data-rec="${t}:${r.id}">${cfg.row(r)}</tr>`).join('')
      : `<tr><td class="emptyrow" colspan="${cfg.cols}">${q || st ? `No ${cfg.label}s match your search.` : `No ${cfg.label}s yet.`}</td></tr>`;
    $$(`#rows-${t} [data-rec]`).forEach(el => el.onclick = e => {
      const pay = e.target.closest('[data-pay]');
      if (pay) return recordPayment(Number(pay.dataset.pay));
      openRecord(t, Number(el.dataset.rec.split(':')[1]));
    });
  }

  function renderFinance() {
    const live = state.invoices.filter(i => i.status !== 'Void');
    const billed = live.reduce((s, i) => s + Number(i.amount || 0), 0);
    const paid = live.reduce((s, i) => s + Number(i.paid_amount || 0), 0);
    const overdue = live.filter(i => invoiceState(i) === 'Overdue');
    const overdueAmt = overdue.reduce((s, i) => s + Math.max(0, i.amount - i.paid_amount), 0);
    $('#finStats').innerHTML = [['Billed', money(billed)], ['Collected', money(paid)], ['Outstanding', money(Math.max(0, billed - paid))], ['Overdue', money(overdueAmt), overdue.length]]
      .map(([l, v, alert]) => `<div class="stat${alert ? ' alert' : ''}" style="cursor:default"><span>${l}</span><b>${v}</b></div>`).join('');
  }

  function fieldHTML([name, label, type = 'text', o = {}], val) {
    const id = 'r_' + name;
    const v = val ?? '';
    let input;
    if (type === 'select') input = `<select id="${id}" name="${name}">${options(o.list, v || o.list[0])}</select>`;
    else if (type === 'textarea') input = `<textarea id="${id}" name="${name}">${esc(v)}</textarea>`;
    else input = `<input id="${id}" name="${name}" type="${type}"${type === 'number' ? ' step="any" min="' + (o.min ?? 0) + '"' + (o.max ? ` max="${o.max}"` : '') : ''} value="${esc(v)}"${o.required ? ' required' : ''}>`;
    return `<div class="f${o.wide ? ' wide' : ''}"><label for="${id}">${esc(label)}</label>${input}${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ''}</div>`;
  }

  async function openRecord(t, id) {
    const cfg = REG[t];
    if (!state[t].length || (id && !state[t].find(r => r.id === id))) {
      try { state[t] = (await api('/api/admin/' + t))[t] || []; } catch (err) { return toast(err.message, true); }
    }
    let rec = id ? state[t].find(r => r.id === id) : null;
    if (id && !rec) return toast(`That ${cfg.label} no longer exists.`, true);
    if (!rec) {
      rec = {};
      if (t === 'invoices') {
        try { rec.invoice_number = (await api('/api/admin/next-invoice-number')).number; } catch { /* optional */ }
        rec.issue_date = todayISO();
        rec.due_date = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
        rec.status = 'Draft';
      }
    }
    const bal = t === 'invoices' ? Math.max(0, Number(rec.amount || 0) - Number(rec.paid_amount || 0)) : 0;
    openDrawer({
      title: id ? (rec.title || rec.name || rec.invoice_number || `${cfg.label} #${id}`) : `New ${cfg.label}`,
      sub: id ? `${cfg.label[0].toUpperCase() + cfg.label.slice(1)} #${id} · created ${fmtDate(rec.created_at)}` : '',
      body: `<form id="recForm" class="grid" novalidate>${cfg.fields.map(f => fieldHTML(f, rec[f[0]])).join('')}</form><p class="msg" id="recMsg" role="status"></p>`,
      footer: `<button class="btn" id="recSave">${id ? 'Save changes' : 'Create ' + cfg.label}</button>
        ${t === 'invoices' && id && bal && rec.status !== 'Void' ? '<button class="btn ghost" id="recPay">Record payment</button>' : ''}
        ${t === 'invoices' && id ? '<button class="btn ghost" id="recPrint">Print / PDF</button>' : ''}
        <span class="grow"></span>${id ? '<button class="btn danger" id="recDel">Delete</button>' : ''}`
    });
    const form = $('#recForm');
    $('#recSave').onclick = async () => {
      const v = formObj(form);
      const missing = cfg.fields.filter(f => f[3] && f[3].required && !String(v[f[0]] || '').trim()).map(f => f[1].replace(' *', ''));
      if (missing.length) { $('#recMsg').className = 'msg err'; $('#recMsg').textContent = 'Required: ' + missing.join(', '); return; }
      const base = {}, extra = {};
      Object.entries(v).forEach(([k, val]) => (cfg.extra.includes(k) ? extra : base)[k] = val);
      $('#recSave').disabled = true;
      try {
        let rid = id;
        if (id) await api(`/api/admin/${t}/${id}`, { method: 'PATCH', json: base });
        else rid = (await api('/api/admin/' + t, { method: 'POST', json: base })).id;
        if (cfg.extra.length) await api(`/api/admin/extra/${t}/${rid}`, { method: 'PATCH', json: extra });
        toast(id ? 'Saved' : `${cfg.label[0].toUpperCase() + cfg.label.slice(1)} created`);
        closeDrawer();
        state[t] = [];
        load(state.view);
      } catch (err) { $('#recMsg').className = 'msg err'; $('#recMsg').textContent = err.message; }
      finally { const b = $('#recSave'); if (b) b.disabled = false; }
    };
    if ($('#recDel')) $('#recDel').onclick = async () => {
      if (!confirm(`Delete this ${cfg.label}? This can’t be undone.`)) return;
      try { await api(`/api/admin/${t}/${id}`, { method: 'DELETE' }); toast('Deleted'); closeDrawer(); state[t] = []; load(state.view); }
      catch (err) { toast(err.message, true); }
    };
    if ($('#recPay')) $('#recPay').onclick = () => recordPayment(id);
    if ($('#recPrint')) $('#recPrint').onclick = () => printInvoice(rec);
  }

  async function recordPayment(id) {
    const inv = state.invoices.find(i => i.id === id);
    if (!inv) return;
    const bal = Math.max(0, inv.amount - inv.paid_amount);
    const input = prompt(`Record a payment for ${inv.invoice_number}.\nBalance due: ${money(bal)}\n\nAmount received:`, bal.toFixed(2));
    if (input === null) return;
    const amount = Number(String(input).replace(/[$,\s]/g, ''));
    if (!(amount > 0)) return toast('Enter an amount greater than zero.', true);
    if (amount > bal + 0.005 && !confirm(`${money(amount)} is more than the balance of ${money(bal)}. Record it anyway?`)) return;
    try {
      const r = await api(`/api/admin/invoices/${id}/payment`, { method: 'POST', json: { amount } });
      toast(`Payment recorded. Invoice is now ${r.status}.`);
      closeDrawer(); state.invoices = []; load(state.view);
    } catch (err) { toast(err.message, true); }
  }

  function printInvoice(i) {
    const bal = Math.max(0, Number(i.amount || 0) - Number(i.paid_amount || 0));
    const w = window.open('', '_blank');
    if (!w) return toast('Allow pop-ups to print the invoice.', true);
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(i.invoice_number)}</title>
      <style>body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#182a3a;max-width:760px;margin:40px auto;padding:0 24px}
      .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #10263e;padding-bottom:18px}
      h1{font-size:30px;margin:0;color:#10263e}.co b{font-size:18px;color:#10263e}.muted{color:#637587}
      table{width:100%;border-collapse:collapse;margin:26px 0}td,th{padding:10px;border-bottom:1px solid #dce5ec;text-align:left}th{font-size:12px;color:#637587}
      .num{text-align:right}.due{font-size:20px;font-weight:800;color:#10263e}.pre{white-space:pre-wrap}@media print{.noprint{display:none}}</style></head><body>
      <div class="top"><div class="co"><b>Bright Cleaning Sev Inc.</b><br><span class="muted">info@brightclean.net · 515-329-5889<br>brightclean.net</span></div>
      <div style="text-align:right"><h1>INVOICE</h1><div>${esc(i.invoice_number)}</div><div class="muted">Date: ${fmtDate(i.issue_date || (i.created_at || '').slice(0, 10))}<br>Due: ${fmtDate(i.due_date)}</div></div></div>
      <p style="margin-top:22px"><span class="muted">Bill to</span><br><b>${esc(i.company || i.customer_name || '')}</b>${i.company && i.customer_name ? '<br>' + esc(i.customer_name) : ''}</p>
      <table><thead><tr><th>Description</th><th class="num">Amount</th></tr></thead><tbody>
      <tr><td class="pre">${esc(i.notes || 'Services as agreed')}${i.project_id ? '\nProject #' + esc(i.project_id) : ''}</td><td class="num">${money(i.amount)}</td></tr>
      <tr><td class="num">Paid to date</td><td class="num">${money(i.paid_amount)}</td></tr>
      <tr><td class="num"><b>Balance due</b></td><td class="num due">${money(bal)}</td></tr></tbody></table>
      <p class="muted">Thank you for your business. Please reference ${esc(i.invoice_number)} with your payment.</p>
      <p class="noprint"><button onclick="print()">Print or save as PDF</button></p></body></html>`);
    w.document.close();
  }

  // ---------- Activity ----------
  async function loadActivity() {
    const a = (await api('/api/admin/audit-log')).events || [];
    $('#activityRows').innerHTML = renderActivity(a) || '<p class="empty">No activity recorded yet.</p>';
  }

  // ---------- Settings ----------
  $('#pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const v = formObj(e.target), m = $('#pwMsg');
    if (v.next !== v.confirm) { m.className = 'msg err'; m.textContent = 'The new passwords don’t match.'; return; }
    if (v.next.length < 14) { m.className = 'msg err'; m.textContent = 'Use at least 14 characters.'; return; }
    m.className = 'msg'; m.textContent = 'Saving…';
    try { const r = await api('/api/admin/account/password', { method: 'POST', json: { current: v.current, next: v.next } }); e.target.reset(); m.className = 'msg ok'; m.textContent = r.message; }
    catch (err) { m.className = 'msg err'; m.textContent = err.message; }
  });

  async function loadSettings() {
    await Promise.all([loadUsers(), loadAutomation(), loadBackups(), loadApprovalRules()]);
  }
  async function loadApprovalRules() {
    const r = await api('/api/admin/approval-rules'), f = $('#apprCard');
    f.elements.min_margin_pct.value = r.rules.min_margin_pct; f.elements.max_total.value = r.rules.max_total;
    f.elements.flag_pre_pricing.checked = r.rules.flag_pre_pricing; f.elements.approve_all.checked = r.rules.approve_all;
    [...f.elements].forEach(el => { el.disabled = !r.can_change; });
    $('#apMsg').className = 'msg'; $('#apMsg').textContent = r.can_change ? '' : 'Only the owner can change these.';
  }
  $('#apprCard').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api('/api/admin/approval-rules', { method: 'PUT', json: { min_margin_pct: f.elements.min_margin_pct.value, max_total: f.elements.max_total.value, flag_pre_pricing: f.elements.flag_pre_pricing.checked, approve_all: f.elements.approve_all.checked } });
      $('#apMsg').className = 'msg ok'; $('#apMsg').textContent = 'Saved.';
    } catch (err) { $('#apMsg').className = 'msg err'; $('#apMsg').textContent = err.message; }
  });
  const AUTO = [
    ['auto_handoff', 'Approved proposal handoff', 'When a customer approves a proposal, create a draft contract and a planning project. Nothing is scheduled or mobilized without you.'],
    ['auto_proposal_reminders', 'Proposal follow-up emails', 'Email the customer 3 and 7 days after a sent proposal was last opened, if they have not decided. Each reminder is sent once.'],
    ['auto_invoice_reminders', 'Invoice payment reminders', 'Email the billing contact 3 days before the due date, 1 day overdue and 7 days overdue. Each reminder is sent once.'],
    ['auto_backup', 'Daily database backup', 'Back up the database once a day and keep the 14 newest copies.']
  ];
  async function loadAutomation() {
    const d = await api('/api/admin/settings');
    $('#autoEmail').className = 'msg' + (d.email_configured ? ' ok' : ' err');
    $('#autoEmail').textContent = d.email_configured ? `Email is set up. Links in emails use ${d.public_base_url}.` : 'Email is not set up yet (SMTP_PASS missing in Render), so reminders are logged as skipped and nothing is sent.';
    $('#autoToggles').innerHTML = AUTO.map(([k, label, help]) => `<label class="userrow" style="cursor:pointer;align-items:flex-start"><span><b>${esc(label)}</b><small>${esc(help)}</small></span><input type="checkbox" data-auto="${k}"${d.settings[k] ? ' checked' : ''} style="width:20px;height:20px;margin-top:4px"></label>`).join('');
    $$('[data-auto]').forEach(cb => cb.onchange = async () => {
      try { await api('/api/admin/settings', { method: 'PUT', json: { [cb.dataset.auto]: cb.checked } }); toast(`${AUTO.find(a => a[0] === cb.dataset.auto)[1]} ${cb.checked ? 'on' : 'off'}`); }
      catch (err) { cb.checked = !cb.checked; toast(err.message, true); }
    });
    const kinds = { proposal_reminder: 'Proposal reminder', invoice_reminder: 'Invoice reminder', backup: 'Backup' };
    $('#autoLog').innerHTML = (d.log || []).slice(0, 15).map(x => `<p><time>${esc(fmtWhen(x.created_at))}</time><span><b>${esc(kinds[x.kind] || x.kind)}</b> ${x.ref_id ? '#' + esc(x.ref_id) + ' ' : ''}${esc(x.stage || '')} · <span class="badge ${x.status === 'sent' || x.status === 'ok' ? 'green' : x.status === 'failed' ? 'red' : ''}">${esc(x.status)}</span>${x.sent_to ? ' · ' + esc(x.sent_to) : ''}${x.detail ? ' · ' + esc(x.detail) : ''}</span></p>`).join('') || '<p class="empty">Nothing has run yet. Automations run every hour.</p>';
  }
  $('#autoRun').addEventListener('click', async () => {
    $('#autoMsg').className = 'msg'; $('#autoMsg').textContent = 'Running…';
    try { const r = (await api('/api/admin/automation/run', { method: 'POST' })).result; $('#autoMsg').className = 'msg ok'; $('#autoMsg').textContent = `Done: ${r.proposal_reminders || 0} proposal reminder(s), ${r.invoice_reminders || 0} invoice reminder(s)${r.backup ? ', backup made' : ''}.`; loadAutomation(); loadBackups(); }
    catch (err) { $('#autoMsg').className = 'msg err'; $('#autoMsg').textContent = err.message; }
  });
  async function loadBackups() {
    const d = await api('/api/admin/backups');
    const size = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
    $('#backupList').innerHTML = d.backups.length ? d.backups.map(b => `<div class="userrow"><span><b>${esc(fmtWhen(b.created_at))}</b><small>${esc(b.name)} · ${size(b.size)}</small></span><button class="btn small ghost" data-backup="${esc(b.name)}">Download</button></div>`).join('') : '<p class="empty">No backups yet.</p>';
    $$('[data-backup]').forEach(b => b.onclick = () => downloadFile({ url: '/api/admin/backups/' + b.dataset.backup, name: b.dataset.backup }));
  }
  $('#backupNow').addEventListener('click', async () => {
    $('#backupMsg').className = 'msg'; $('#backupMsg').textContent = 'Backing up…';
    try { const r = await api('/api/admin/backups', { method: 'POST' }); $('#backupMsg').className = 'msg ok'; $('#backupMsg').textContent = 'Backup created: ' + r.name; loadBackups(); }
    catch (err) { $('#backupMsg').className = 'msg err'; $('#backupMsg').textContent = err.message; }
  });
  async function loadUsers() {
    const users = (await api('/api/admin/users')).users || [];
    const me = $('#whoEmail').textContent;
    $('#userList').innerHTML = users.map(u => `<div class="userrow"><span><b>${esc(u.name || u.email)}</b><small>${esc(u.email)}${u.owner ? ' · Owner' : ''}${u.last_login_at ? ' · last signed in ' + esc(ago(u.last_login_at)) : ''}</small></span>${!u.owner && u.email !== me && u.id ? `<button class="btn small danger" data-deluser="${u.id}" data-email="${esc(u.email)}">Remove</button>` : ''}</div>`).join('');
    $$('[data-deluser]').forEach(b => b.onclick = async () => {
      if (!confirm(`Remove access for ${b.dataset.email}?`)) return;
      try { await api('/api/admin/users/' + b.dataset.deluser, { method: 'DELETE' }); toast('Access removed'); loadUsers(); }
      catch (err) { toast(err.message, true); }
    });
  }
  $('#userForm').addEventListener('submit', async e => {
    e.preventDefault();
    const m = $('#userMsg');
    m.className = 'msg'; m.textContent = 'Saving…';
    try { await api('/api/admin/users', { method: 'POST', json: formObj(e.target) }); e.target.reset(); m.className = 'msg ok'; m.textContent = 'Access added.'; loadUsers(); }
    catch (err) { m.className = 'msg err'; m.textContent = err.message; }
  });

  // ---------- Issues & tasks ----------
  const issState = { issues: [], options: null };
  ['#issStatus', '#issType', '#issMine'].forEach(sel => $(sel).addEventListener('change', () => loadIssues()));
  $('#issSearch').addEventListener('input', () => renderIssues());
  $('#issAdd').addEventListener('click', () => openIssue(null, null));
  async function loadIssues() {
    const q = new URLSearchParams({ status: $('#issStatus').value });
    if ($('#issType').value) q.set('type', $('#issType').value);
    if ($('#issMine').checked) q.set('assigned', 'me');
    const r = await api('/api/admin/issues?' + q);
    Object.assign(issState, { issues: r.issues, options: r.options, counts: r.counts });
    const n = r.counts.open_complaints + r.counts.overdue;
    $('#navIssues').hidden = !n; $('#navIssues').textContent = n;
    renderIssues();
  }
  function renderIssues() {
    const o = issState.options, q = $('#issSearch').value.trim().toLowerCase();
    const rows = issState.issues.filter(i => !q || [i.title, i.description, i.property, i.customer_name, i.customer_company].join(' ').toLowerCase().includes(q));
    $('#issRows').innerHTML = rows.length ? rows.map(i => `<tr class="click" data-issue="${i.id}"><td><b>${esc(i.title)}</b><small>${esc(i.category || '')}${i.property ? ' · ' + esc(i.property) : ''}</small></td><td>${esc(i.customer_company || i.customer_name || '—')}</td><td>${badge(o.types[i.type])}</td><td>${i.priority === 'Urgent' ? '<span class="badge red">Urgent</span>' : i.priority === 'High' ? '<span class="badge amber">High</span>' : esc(i.priority)}</td><td>${esc(i.assigned_to || '—')}</td><td class="${i.overdue ? 'late' : ''}">${i.due_date ? fmtDate(i.due_date) + (i.overdue ? ' · overdue' : '') : '—'}</td><td>${badge(i.status)}</td></tr>`).join('')
      : `<tr><td class="emptyrow" colspan="7">${$('#issStatus').value === 'open' ? 'No open items. Nice.' : 'Nothing matches.'}</td></tr>`;
    $$('[data-issue]').forEach(r => r.onclick = () => openIssue(issState.issues.find(i => i.id === Number(r.dataset.issue)), null));
  }
  async function openIssue(it, cust) {
    if (!issState.options) { try { const r = await api('/api/admin/issues?status=open'); issState.options = r.options; } catch (e) { return toast(e.message, true); } }
    if (!state.customers || !state.customers.length) { try { state.customers = (await api('/api/admin/customers')).customers; } catch { state.customers = []; } }
    const o = issState.options, isNew = !it;
    it = it || { type: 'complaint', priority: 'Normal', status: 'Open', customer_comms: 'Needs update', customer_id: cust ? cust.id : '' };
    const opt = (list, sel, labels) => list.map(v => `<option value="${esc(v)}"${String(v) === String(sel ?? '') ? ' selected' : ''}>${esc(labels ? labels[v] : v)}</option>`).join('');
    const v = k => esc(it[k] == null ? '' : it[k]);
    openDrawer({
      title: isNew ? 'New item' : it.title,
      sub: isNew ? (cust ? (cust.company || cust.name) : 'Internal only') : `${o.types[it.type]} #${it.id} · created ${fmtDate(it.created_at)}${it.created_by ? ' by ' + esc(it.created_by) : ''}${it.resolved_at ? ' · resolved ' + fmtDate(it.resolved_at) : ''}`,
      body: `<form id="issForm" class="grid" novalidate>
        <div class="f"><label for="i1">Type</label><select id="i1" name="type">${opt(Object.keys(o.types), it.type, o.types)}</select></div>
        <div class="f"><label for="i2">Category</label><select id="i2" name="category"><option value="">—</option>${opt(o.categories, it.category)}</select></div>
        <div class="f wide"><label for="i3">Title</label><input id="i3" name="title" value="${v('title')}" placeholder="Short summary"></div>
        <div class="f"><label for="i4">Customer</label><select id="i4" name="customer_id"><option value="">No customer</option>${state.customers.map(c => `<option value="${c.id}"${String(c.id) === String(it.customer_id ?? '') ? ' selected' : ''}>${esc(c.company || c.name || c.email)}</option>`).join('')}</select></div>
        <div class="f"><label for="i5">Property / project</label><input id="i5" name="property" value="${v('property')}"></div>
        <div class="f wide"><label for="i6">Description</label><textarea id="i6" name="description">${v('description')}</textarea></div>
        <div class="f"><label for="i7">Priority</label><select id="i7" name="priority">${opt(o.priorities, it.priority)}</select></div>
        <div class="f"><label for="i8">Assigned to</label><select id="i8" name="assigned_to"><option value="">Unassigned</option>${opt(o.users, it.assigned_to)}</select></div>
        <div class="f"><label for="i9">Due date</label><input id="i9" name="due_date" type="date" value="${v('due_date')}"></div>
        <div class="f"><label for="i10">Status</label><select id="i10" name="status">${opt(o.statuses, it.status)}</select></div>
        <div class="f wide"><label for="i11">Required action</label><textarea id="i11" name="required_action" placeholder="What needs to happen next">${v('required_action')}</textarea></div>
        <div class="f wide"><label for="i12">Resolution</label><textarea id="i12" name="resolution" placeholder="Required to close a complaint or task">${v('resolution')}</textarea></div>
        <div class="f"><label for="i13">Customer update</label><select id="i13" name="customer_comms">${opt(o.comms, it.customer_comms)}</select></div>
      </form><p class="msg" id="issMsg" role="status"></p>`,
      footer: `<button class="btn" id="iSave">${isNew ? 'Add' : 'Save'}</button>${!isNew && ['Open', 'In progress'].includes(it.status) ? '<button class="btn ghost" id="iResolve">Mark resolved</button>' : ''}<span class="grow"></span>${!isNew && it.type === 'note' ? '<button class="btn danger" id="iDel">Delete note</button>' : ''}`
    });
    const done = () => { closeDrawer(); if (state.view === 'issues') loadIssues(); else if (state.view === 'customers') loadCustomers(); else load(state.view); };
    const save = async extra => {
      const body = { ...formObj($('#issForm')), ...(extra || {}) };
      try {
        if (isNew) await api('/api/admin/issues', { method: 'POST', json: body });
        else await api('/api/admin/issues/' + it.id, { method: 'PATCH', json: body });
        toast(isNew ? 'Added' : extra ? 'Resolved' : 'Saved'); done();
      } catch (err) { $('#issMsg').className = 'msg err'; $('#issMsg').textContent = err.message; }
    };
    $('#iSave').onclick = () => save();
    if ($('#iResolve')) $('#iResolve').onclick = () => save({ status: 'Resolved' });
    if ($('#iDel')) $('#iDel').onclick = async () => { if (!confirm('Delete this note?')) return; try { await api('/api/admin/issues/' + it.id, { method: 'DELETE' }); toast('Deleted'); done(); } catch (err) { toast(err.message, true); } };
  }

  // ---------- Cleaning scopes ----------
  const scopeState = { items: [], categories: {}, pricing: {} };
  ['#scopeSearch', '#scopeCat', '#scopeShow'].forEach(sel => $(sel).addEventListener('input', () => renderScopes()));
  async function loadScopes() {
    const r = await api('/api/admin/scopes');
    Object.assign(scopeState, { items: r.items || [], categories: r.categories || {}, pricing: r.pricing || {} });
    const cur = $('#scopeCat').value;
    $('#scopeCat').innerHTML = '<option value="">All categories</option>' + Object.entries(scopeState.categories).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    $('#scopeCat').value = cur;
    const n = r.summary ? r.summary.needs_rates : 0;
    $('#navScopes').hidden = !n; $('#navScopes').textContent = n;
    $('#scopeNote').className = n ? 'msg err' : 'msg';
    $('#scopeNote').textContent = n ? `${n} of ${r.summary.total} active items still need your production rate, crew size or price. Estimates cannot price these items until they are filled in.` : '';
    renderScopes();
  }
  const qty = v => v == null ? '—' : Number(v).toLocaleString();
  function renderScopes() {
    const q = $('#scopeSearch').value.trim().toLowerCase(), cat = $('#scopeCat').value, show = $('#scopeShow').value;
    const rows = scopeState.items.filter(i => (!cat || i.category === cat)
      && (show === 'archived' ? !i.active : i.active && (show !== 'missing' || i.missing.length))
      && (!q || [i.name, i.description, i.unit, i.included, i.exclusions].join(' ').toLowerCase().includes(q)));
    $('#scopeRows').innerHTML = rows.length ? rows.map(i => `<tr class="click" data-scope="${i.id}"><td><b>${esc(i.name)}</b><small>${esc(i.frequency || '')}</small></td><td>${esc(scopeState.categories[i.category] || i.category)}</td><td>${esc(i.unit)}</td><td class="num">${qty(i.production_rate)}</td><td class="num">${qty(i.crew_size)}</td><td class="num">${i.pricing_method === 'hourly' ? 'Hourly' : i.unit_price == null ? '—' : money(i.unit_price) + ' / ' + esc(i.unit)}</td><td>${!i.active ? badge('Archived') : i.missing.length ? `<span class="badge amber" title="Missing: ${esc(i.missing.join(', '))}">Needs rates</span>` : badge('Ready')}</td></tr>`).join('')
      : `<tr><td class="emptyrow" colspan="7">No scope items match.</td></tr>`;
    $$('[data-scope]').forEach(r => r.onclick = () => openScope(scopeState.items.find(i => i.id === Number(r.dataset.scope))));
  }
  $('#scopeAdd').addEventListener('click', () => openScope(null));
  function openScope(it) {
    const isNew = !it;
    it = it || { category: $('#scopeCat').value || 'construction', name: '', unit: '', pricing_method: 'per_unit', active: 1 };
    const v = k => esc(it[k] == null ? '' : it[k]);
    const opts = (obj, sel) => Object.entries(obj).map(([k, l]) => `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
    const ta = (id, name, label, ph) => `<div class="f wide"><label for="${id}">${label}</label><textarea id="${id}" name="${name}" placeholder="${ph || ''}">${v(name)}</textarea></div>`;
    openDrawer({
      title: isNew ? 'New scope item' : it.name,
      sub: isNew ? '' : `${scopeState.categories[it.category] || ''} · updated ${fmtDate(it.updated_at)}`,
      body: `<form id="scopeForm" class="grid" novalidate>
          <div class="f"><label for="sc1">Category</label><select id="sc1" name="category">${opts(scopeState.categories, it.category)}</select></div>
          <div class="f"><label for="sc2">Name</label><input id="sc2" name="name" value="${v('name')}" required></div>
          <div class="f"><label for="sc3">Measurement unit</label><input id="sc3" name="unit" value="${v('unit')}" placeholder="SF, Each, Unit, Fixture, Hour" required></div>
          <div class="f"><label for="sc4">Frequency</label><input id="sc4" name="frequency" value="${v('frequency')}" placeholder="Once, Daily, Per turn"></div>
          <div class="f"><label for="sc5">Production rate (units per labor hour)</label><input id="sc5" name="production_rate" inputmode="decimal" value="${v('production_rate')}" placeholder="Your rate"></div>
          <div class="f"><label for="sc6">Typical crew size</label><input id="sc6" name="crew_size" inputmode="decimal" value="${v('crew_size')}"></div>
          <div class="f"><label for="sc7">Pricing method</label><select id="sc7" name="pricing_method">${opts(scopeState.pricing, it.pricing_method)}</select></div>
          <div class="f"><label for="sc8">Price per unit ($)</label><input id="sc8" name="unit_price" inputmode="decimal" value="${v('unit_price')}" placeholder="Leave blank for hourly"></div>
          ${ta('sc9', 'description', 'Description')}
          ${ta('sc10', 'included', 'Included work')}
          ${ta('sc11', 'exclusions', 'Exclusions')}
          ${ta('sc12', 'quality_standard', 'Quality standard')}
          ${ta('sc13', 'labor_notes', 'Labor requirements', 'Skills, supervision, shift')}
          <div class="f"><label for="sc14">Equipment</label><input id="sc14" name="equipment" value="${v('equipment')}"></div>
          <div class="f"><label for="sc15">Materials</label><input id="sc15" name="materials" value="${v('materials')}"></div>
        </form><p class="msg" id="scopeMsg" role="status"></p>`,
      footer: `<button class="btn" id="sSave">${isNew ? 'Add item' : 'Save'}</button>${isNew ? '' : `<span class="grow"></span>${it.active ? '<button class="btn danger" id="sArch">Archive</button>' : '<button class="btn ghost" id="sRestore">Restore</button>'}`}`
    });
    const fail = err => { $('#scopeMsg').className = 'msg err'; $('#scopeMsg').textContent = err.message; };
    $('#sSave').onclick = async () => {
      const body = formObj($('#scopeForm'));
      try {
        if (isNew) await api('/api/admin/scopes', { method: 'POST', json: body });
        else await api('/api/admin/scopes/' + it.id, { method: 'PATCH', json: body });
        toast(isNew ? 'Scope item added' : 'Saved'); closeDrawer(); loadScopes();
      } catch (err) { fail(err); }
    };
    if (!isNew && it.active) $('#sArch').onclick = async () => {
      if (!confirm('Archive this scope item? It will no longer be offered on new estimates. Past estimates are not changed.')) return;
      try { await api('/api/admin/scopes/' + it.id, { method: 'DELETE' }); toast('Archived'); closeDrawer(); loadScopes(); } catch (err) { fail(err); }
    };
    if (!isNew && !it.active) $('#sRestore').onclick = async () => {
      try { await api('/api/admin/scopes/' + it.id, { method: 'PATCH', json: { active: true } }); toast('Restored'); closeDrawer(); loadScopes(); } catch (err) { fail(err); }
    };
  }

  // ---------- Drawer ----------
  let lastFocus = null;
  function openDrawer({ title, sub, body, footer }) {
    lastFocus = document.activeElement;
    $('#drawerRoot').innerHTML = `<div class="scrim" data-close></div>
      <div class="drawer" role="dialog" aria-modal="true" aria-labelledby="dTitle">
        <header><div><h2 id="dTitle">${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div><button class="x" data-close aria-label="Close">×</button></header>
        <div class="body">${body}</div>
        ${footer ? `<footer>${footer}</footer>` : ''}
      </div>`;
    $$('#drawerRoot [data-close]').forEach(el => el.onclick = closeDrawer);
    const first = $('#drawerRoot .body input, #drawerRoot .body select, #drawerRoot .body textarea, #drawerRoot .x');
    if (first) first.focus();
  }
  function closeDrawer() {
    $('#drawerRoot').innerHTML = '';
    if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#drawerRoot').innerHTML) closeDrawer(); });

  // ---------- Boot ----------
  if (token) start(); else signOut();
})();
