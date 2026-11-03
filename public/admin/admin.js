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
  const VIEWS = ['overview', 'leads', 'customers', 'customer', 'issues', 'calls', 'emails', 'proposals', 'estimator', 'contracts', 'projects', 'invoices', 'schedule', 'quality', 'documents', 'takeoffs', 'reports', 'scopes', 'activity', 'settings'];
  function go(view, replace) {
    if (!VIEWS.includes(view)) view = 'overview';
    state.view = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'v-' + view));
    const navView = view === 'estimator' ? 'proposals' : view === 'customer' ? 'customers' : view;
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
      if (view === 'calls') await loadCalls();
      if (view === 'schedule') await loadSchedule();
      if (view === 'quality') await loadQuality();
      if (view === 'documents') await loadDocuments();
      if (view === 'reports') await loadReports();
      if (view === 'customer') await loadCustomerPage();
      if (view === 'emails') await loadEmails();
      if (view === 'takeoffs') await loadTakeoffs();
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
  setInterval(() => { if (state.view === 'overview' && document.visibilityState === 'visible' && !document.querySelector('#drawerRoot .drawer')) loadOverview().catch(() => {}); }, 30000);
  async function loadOverview() {
    const [d, cc] = await Promise.all([api('/api/admin/dashboard'), api('/api/admin/command-center?days=' + $('#ccDays').value)]);
    $('#todayLine').innerHTML = esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) + ` · <span class="live">Live</span> <small class="muted">updated ${esc(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</small>`;
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
    if (!window.matchMedia || !matchMedia('(prefers-reduced-motion: reduce)').matches) $$('#ccKpis .kpi b').forEach(el => {
      const txt = el.textContent, m = txt.match(/^(\$?)([\d,]+)(\.\d+)?$/); if (!m) return;
      const target = Number((m[2] + (m[3] || '')).replace(/,/g, '')); if (!(target > 0)) return;
      const t0 = performance.now(), dur = 600;
      const step = t => { const p = Math.min(1, (t - t0) / dur), v = target * (1 - Math.pow(1 - p, 3)); el.textContent = m[1] ? money(v) : Math.round(v).toLocaleString(); if (p < 1) requestAnimationFrame(step); else el.textContent = txt; };
      requestAnimationFrame(step);
    });
    const colors = ['#1d4f91', '#2563eb', '#1497b5', '#1f9d55'];
    $('#ccPipe').innerHTML = cc.pipeline.map((p, i) => `<div class="st" style="--w:${100 - i * 10}%;--c:${colors[i]}"><span>${esc(p.stage)} (${p.n})</span><span>${p.valued ? money(p.v) : ''}</span></div>`).join('')
      + (cc.pipeline.every(p => !p.n) ? '<p class="empty" style="margin-top:6px">Your pipeline fills in as leads, estimates and proposals come in.</p>' : '');
    $('#ccAct').innerHTML = renderActivity(cc.activity) || '<p class="empty">No activity yet.</p>';
    const QA = [
      ['New lead', 'user', () => newLead()], ['Log call', 'inbox', () => logCall()], ['Schedule visit', 'cal', () => scheduleVisit()], ['Upload drawings', 'layers', () => uploadDocs()],
      ['New estimate', 'plus', () => openEstimator()], ['Add customer', 'user', () => { go('customers'); setTimeout(() => $('#custAdd').click(), 300); }],
      ['Create invoice', 'inv', () => openRecord('invoices', null)], ['Add scope item', 'layers', () => { go('scopes'); setTimeout(() => $('#scopeAdd').click(), 400); }],
      ['Review leads', 'inbox', () => go('leads')], ['Back up now', 'save', async () => { try { const r = await api('/api/admin/backups', { method: 'POST' }); toast('Backup created: ' + r.name); } catch (e) { toast(e.message, true); } }]
    ];
    $('#ccQuick').innerHTML = QA.map(([l, ic], i) => `<button type="button" data-qa="${i}">${svg(ic)}${esc(l)}</button>`).join('');
    $$('#ccQuick [data-qa]').forEach(b => b.onclick = QA[b.dataset.qa][2]);
    const PORTALS = [['Multifamily', 'Apartments · units · common areas', '/quote.html?service=multifamily'], ['Construction final clean', 'New builds · punch list · windows', '/quote.html?service=construction_final'],
      ['Commercial janitorial', 'Offices · facilities · recurring', '/quote.html?service=janitorial'], ['Exterior services', 'Power washing · windows · parking', '/quote.html?service=power_washing'], ['Other services', 'Unit turns · valet trash', '/quote.html?service=unit_turnover']];
    $('#ccPortals').innerHTML = PORTALS.map(([t, s2, u]) => `<a href="${u}" target="_blank" rel="noopener"><b>${esc(t)}</b><small>${esc(s2)}</small></a>`).join('');
    api('/api/admin/calls').then(c => {
      const t = todayISO();
      $('#ccCalls').innerHTML = `<div class="kpis small" style="margin:6px 0 10px"><div class="kpi"><span><span>Today</span><b>${c.today.total}</b></span></div><div class="kpi"><span><span>Answered</span><b>${c.today.answered}</b></span></div><div class="kpi${c.today.missed ? ' alert' : ''}"><span><span>Missed</span><b>${c.today.missed}</b></span></div><div class="kpi${c.follow_ups_due ? ' alert' : ''}"><span><span>Follow-ups due</span><b>${c.follow_ups_due}</b></span></div></div>`
        + (c.calls.length ? '<ul class="mini">' + c.calls.slice(0, 4).map(x => `<li><b>${esc(x.company || x.customer_company || x.contact_name || x.phone || 'Caller')}</b> · ${esc(x.purpose)}${x.follow_up_date && !x.follow_up_done && x.follow_up_date <= t ? ' · <span class="badge amber">follow up</span>' : ''}<br><small class="muted">${esc(fmtWhen(x.created_at))} · ${esc((x.summary || '').slice(0, 70))}</small></li>`).join('') + '</ul>' : '<p class="empty">No calls logged yet. Use Log call in Quick actions.</p>');
    }).catch(() => { $('#ccCalls').innerHTML = '<p class="empty">Could not load calls.</p>'; });
    api('/api/admin/issues?status=all').then(r => {
      $('#ccNotes').innerHTML = r.issues.length ? '<ul class="mini">' + r.issues.slice(0, 5).map(i => `<li><b>${esc(i.customer_company || i.customer_name || 'No customer')}</b> ${badge(i.status)}${i.overdue ? ' <span class="badge red">Overdue</span>' : ''}<br><small class="muted">${esc(r.options.types[i.type])}: ${esc(i.title)} · ${esc(fmtWhen(i.created_at))}</small></li>`).join('') + '</ul>' : '<p class="empty">No notes, complaints or tasks yet.</p>';
    }).catch(() => { $('#ccNotes').innerHTML = '<p class="empty">Could not load notes.</p>'; });
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
        <div id="leadAI"></div>
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
    renderLeadAI(l);
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
    $$('[data-cust]').forEach(r => r.onclick = () => openCustomerPage(Number(r.dataset.cust)));
  }
  $('#custAdd').addEventListener('click', () => openCustomer(null));
  // ---------- Customer profile page (full CRM workspace) ----------
  const cp = { id: Number(sessionStorage.getItem('bc_cust')) || null, tab: 'overview', d: null };
  function openCustomerPage(id) { cp.id = id; cp.tab = 'overview'; sessionStorage.setItem('bc_cust', id); go('customer'); }
  async function loadCustomerPage() {
    if (!cp.id) return go('customers', true);
    try { cp.d = await api(`/api/admin/customers/${cp.id}/profile`); } catch (e) { $('#custPage').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
    renderCustomerPage();
  }
  const TABS = [['overview', 'Overview'], ['contacts', 'Contacts'], ['properties', 'Properties'], ['notes', 'Notes'], ['calls', 'Calls'], ['emails', 'Emails'], ['issues', 'Issues'], ['estimates', 'Estimates'], ['proposals', 'Proposals'], ['contracts', 'Contracts'], ['projects', 'Projects'], ['invoices', 'Invoices'], ['documents', 'Documents'], ['activity', 'Activity']];
  function renderCustomerPage() {
    const d = cp.d, c = d.customer, f = d.financials, pc = d.contacts.find(x => x.is_primary) || d.contacts[0] || {};
    const cnt = { contacts: d.contacts.length, properties: d.properties.length, notes: d.notes.length, calls: d.calls.length, emails: d.emails.length, issues: d.issues.length, estimates: d.estimates.length, proposals: d.proposals.length, contracts: d.contracts.length, projects: d.projects.length, invoices: d.invoices.length, documents: d.documents.length };
    const tile = (l, o, sub) => `<div class="kpi"><span style="min-width:0"><span>${esc(l)}</span><b>${money(o.value)}</b><small class="flat">${o.count} ${esc(sub)}</small></span></div>`;
    $('#custPage').innerHTML = `
      <p><button class="linklike" id="cpBack">← All customers</button></p>
      <div class="cphead"><div><h1>${esc(c.company || c.name || c.email)} ${badge(c.status || 'Active')}</h1>
        <div class="cpmeta"><span>Primary contact <b>${esc(pc.name || '—')}</b></span><span>Phone <b>${pc.phone || c.phone ? `<a href="tel:${esc(pc.phone || c.phone)}">${esc(pc.phone || c.phone)}</a>` : '—'}</b></span><span>Email <b>${esc(pc.email || c.email || '—')}</b></span><span>Address <b>${esc(c.address || '—')}</b></span><span>Account owner <b>${esc(c.account_owner || 'Unassigned')}</b></span><span>Customer since <b>${fmtDate(c.created_at)}</b></span></div></div>
        <div class="cpact"><button class="btn" data-a="note">New note</button><button class="btn ghost" data-a="call">Log call</button><button class="btn ghost" data-a="email">Send email</button><button class="btn ghost" data-a="estimate">Create estimate</button><button class="btn ghost" data-a="proposal">Create proposal</button><button class="btn ghost" data-a="issue">Create issue</button><button class="btn ghost" data-a="edit">Edit account</button>${d.role === 'owner' ? '<button class="btn ghost danger" data-a="remove">Remove</button>' : ''}</div></div>
      <div class="fin">${tile('Draft estimates', f.estimates, 'estimates')}${tile('Proposals awaiting reply', f.proposals_out, 'sent')}${tile('Approved proposals', f.approved, 'approved · not revenue')}${tile('Signed contracts', f.contracts_signed, `signed${f.contracts_unsigned.count ? ` · ${f.contracts_unsigned.count} unsigned (${money(f.contracts_unsigned.value)})` : ''}`)}${tile('Invoiced', f.invoiced, 'invoices')}${tile('Collected', f.collected, 'payments')}${tile('Outstanding', f.outstanding, 'open invoices')}</div>
      <div class="ctabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" data-t="${k}" class="${cp.tab === k ? 'on' : ''}" aria-selected="${cp.tab === k}">${l}${cnt[k] != null ? `<small>${cnt[k]}</small>` : ''}</button>`).join('')}</div>
      <div id="cpBody"></div>`;
    $('#cpBack').onclick = () => go('customers');
    $$('#custPage .ctabs button').forEach(b => b.onclick = () => { cp.tab = b.dataset.t; renderCustomerPage(); });
    $$('#custPage [data-a]').forEach(b => b.onclick = () => custAction(b.dataset.a));
    renderCustTab();
  }
  const rowsOr = (rows, cols, empty) => rows.length ? `<div class="tablewrap"><table class="t"><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="empty">${empty}</p>`;
  function renderCustTab() {
    const d = cp.d, c = d.customer, B = $('#cpBody'), t = cp.tab, o = d.options;
    const recLink = (type, id, label) => `<button class="linklike" data-rec="${type}:${id}">${esc(label)}</button>`;
    if (t === 'overview') {
      const openIss = d.issues.filter(i => !['Resolved', 'Closed'].includes(i.status));
      B.innerHTML = `<div class="two"><div class="card"><h2>Customer details</h2><dl class="stat">${[['Company', c.company], ['Customer type', c.customer_type], ['Status', c.status], ['Industry', c.industry], ['Account owner', c.account_owner], ['Source', c.source], ['Tax ID / EIN', c.tax_id], ['Properties', d.properties.length], ['Contacts', d.contacts.length]].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v == null || v === '' ? '—' : v)}</dd>`).join('')}</dl></div>
        <div class="card"><h2>Recent communication</h2>${d.communications.length ? '<ul class="tl">' + d.communications.slice(0, 6).map(x => `<li><span class="ty">${x.type}</span> <b>${esc(x.title)}</b> <small class="muted">${esc(fmtWhen(x.at))}${x.by ? ' · ' + esc(x.by) : ''}</small><br><small>${esc((x.text || '').slice(0, 160))}</small></li>`).join('') + '</ul>' : '<p class="empty">No calls, emails or notes yet.</p>'}</div></div>
        <div class="two"><div class="card"><h2>Open issues &amp; complaints (${openIss.length})</h2>${openIss.length ? '<ul class="mini">' + openIss.slice(0, 5).map(i => `<li><b>${esc(i.title)}</b> ${badge(i.priority)} ${badge(i.status)}<br><small class="muted">${esc(i.assigned_to || 'Unassigned')}${i.due_date ? ' · due ' + fmtDate(i.due_date) : ''}</small></li>`).join('') + '</ul>' : '<p class="empty">No open issues.</p>'}</div>
        <div class="card"><h2>Current projects</h2>${d.projects.length ? '<ul class="mini">' + d.projects.map(p => `<li>${recLink('projects', p.id, p.name || 'Project #' + p.id)} ${badge(p.status)}<br><small class="muted">${p.due_date ? 'due ' + fmtDate(p.due_date) : ''}</small></li>`).join('') + '</ul>' : '<p class="empty">No projects.</p>'}</div></div>`;
    } else if (t === 'contacts') {
      B.innerHTML = `<div class="card"><h2>Contacts</h2><form class="inl" id="ctForm"><div><label>Name *</label><input name="name" required></div><div><label>Title</label><input name="title"></div><div><label>Email</label><input name="email" type="email"></div><div><label>Phone</label><input name="phone"></div><div><label class="chk"><input type="checkbox" name="is_primary"> Primary contact</label></div><div><label class="chk"><input type="checkbox" name="can_sign"> Can sign contracts</label></div><div class="wide"><button class="btn">Save contact</button></div></form>
        ${rowsOr(d.contacts.map(k => `<tr><td><b>${esc(k.name)}</b>${k.is_primary ? ' <span class="badge green">Primary</span>' : ''}${k.can_sign ? ' <span class="badge blue">Signer</span>' : ''}<small>${esc(k.title || '')}</small></td><td>${esc(k.email || '—')}</td><td>${esc(k.phone || '—')}</td><td>${k.is_primary ? '' : `<button class="btn small ghost" data-prim="${k.id}">Make primary</button> <button class="btn small danger" data-rmct="${k.id}">Remove</button>`}</td></tr>`), ['Name', 'Email', 'Phone', ''], 'No contacts yet.')}</div>`;
      $('#ctForm').onsubmit = async e => { e.preventDefault(); try { const b = formObj(e.target); b.is_primary = e.target.elements.is_primary.checked; b.can_sign = e.target.elements.can_sign.checked; await api(`/api/admin/customers/${c.id}/contacts`, { method: 'POST', json: b }); toast('Contact saved'); loadCustomerPage(); } catch (err) { toast(err.message, true); } };
      $$('[data-prim]').forEach(b => b.onclick = async () => { try { await api(`/api/admin/customers/${c.id}/contacts/${b.dataset.prim}`, { method: 'PATCH', json: { is_primary: true } }); toast('Primary contact updated'); loadCustomerPage(); } catch (err) { toast(err.message, true); } });
      $$('[data-rmct]').forEach(b => b.onclick = async () => { if (!confirm('Remove this contact?')) return; try { await api(`/api/admin/customers/${c.id}/contacts/${b.dataset.rmct}`, { method: 'DELETE' }); toast('Contact removed'); loadCustomerPage(); } catch (err) { toast(err.message, true); } });
    } else if (t === 'properties') {
      B.innerHTML = `<div class="card"><h2>Properties &amp; service locations</h2><form class="inl" id="prForm"><div><label>Name *</label><input name="name" placeholder="Main Campus – Bldg B" required></div><div><label>Type</label><select name="property_type">${o.property_types.map(x => `<option>${x}</option>`).join('')}</select></div><div><label>Address</label><input name="address"></div><div><label>Units</label><input name="units" inputmode="numeric"></div><div><label>Square feet</label><input name="square_feet" inputmode="decimal"></div><div class="wide"><label>Access instructions (internal)</label><textarea name="access_notes" rows="2" placeholder="Gate code, parking, key pickup, contact on site"></textarea></div><div class="wide"><button class="btn">Save property</button></div></form>
        ${rowsOr(d.properties.map(p => `<tr><td><b>${esc(p.name)}</b><small>${esc(p.property_type || '')}</small></td><td>${esc(p.address || '—')}</td><td>${p.units ?? '—'} units · ${p.square_feet ? Number(p.square_feet).toLocaleString() + ' SF' : '— SF'}</td><td><small>${esc(p.access_notes || '')}</small></td><td>${badge(p.status)} <button class="btn small ghost" data-pst="${p.id}" data-to="${p.status === 'Active' ? 'Inactive' : 'Active'}">${p.status === 'Active' ? 'Deactivate' : 'Activate'}</button></td></tr>`), ['Property', 'Address', 'Size', 'Access', 'Status'], 'No properties yet.')}</div>`;
      $('#prForm').onsubmit = async e => { e.preventDefault(); try { await api(`/api/admin/customers/${c.id}/properties`, { method: 'POST', json: formObj(e.target) }); toast('Property saved'); loadCustomerPage(); } catch (err) { toast(err.message, true); } };
      $$('[data-pst]').forEach(b => b.onclick = async () => { try { await api(`/api/admin/customers/${c.id}/properties/${b.dataset.pst}`, { method: 'PATCH', json: { status: b.dataset.to } }); loadCustomerPage(); } catch (err) { toast(err.message, true); } });
    } else if (t === 'notes') {
      B.innerHTML = `<div class="card"><h2>Internal notes</h2><p class="muted">Visible to your team only. Notes never appear in customer emails or proposals.</p><form class="inl" id="ntForm"><div><label>Category</label><select name="category">${o.note_categories.map(x => `<option>${x}</option>`).join('')}</select></div><div><label class="chk"><input type="checkbox" name="pinned"> Pin to top</label></div><div></div><div class="wide"><label>Note *</label><textarea name="body" rows="3" required></textarea></div><div class="wide"><button class="btn">Save note</button></div></form>
        ${d.notes.length ? '<ul class="tl">' + d.notes.map(n => `<li>${n.pinned ? '<span class="badge amber">Pinned</span> ' : ''}<span class="ty">${esc(n.category)}</span> <small class="muted">${esc(n.author || 'unknown')} · ${esc(fmtWhen(n.created_at))}${n.updated_at !== n.created_at ? ' · edited' : ''}</small><br>${esc(n.body)} <button class="linklike" data-pin="${n.id}" data-v="${n.pinned ? 0 : 1}">${n.pinned ? 'Unpin' : 'Pin'}</button></li>`).join('') + '</ul>' : '<p class="empty">No notes yet.</p>'}</div>`;
      $('#ntForm').onsubmit = async e => { e.preventDefault(); try { await api(`/api/admin/customers/${c.id}/notes`, { method: 'POST', json: { ...formObj(e.target), pinned: e.target.elements.pinned.checked } }); toast('Note saved'); loadCustomerPage(); } catch (err) { toast(err.message, true); } };
      $$('[data-pin]').forEach(b => b.onclick = async () => { try { await api(`/api/admin/customers/${c.id}/notes/${b.dataset.pin}`, { method: 'PATCH', json: { pinned: b.dataset.v === '1' } }); loadCustomerPage(); } catch (err) { toast(err.message, true); } });
    } else if (t === 'calls') {
      B.innerHTML = `<div class="card"><h2>Calls</h2><button class="btn" id="cpLog">Log call</button>${rowsOr(d.calls.map(x => `<tr><td>${esc(fmtWhen(x.created_at))}<small>${esc(x.direction)}</small></td><td>${esc(x.contact_name || x.phone || '—')}</td><td>${badge(x.purpose)}</td><td>${esc(x.outcome)}</td><td>${esc(x.summary || '')}</td></tr>`), ['When', 'Caller', 'Purpose', 'Outcome', 'Summary'], 'No calls recorded for this customer.')}</div>`;
      $('#cpLog').onclick = () => custAction('call');
    } else if (t === 'emails') {
      B.innerHTML = `<div class="card"><h2>Emails</h2><p class="muted">Every email the system sent to this customer's contacts. Replies from customers arrive in Outlook until the Microsoft 365 inbox is connected.</p><button class="btn" id="cpMail">Send email</button>${rowsOr(d.emails.map(m => `<tr class="click" data-ml="${m.id}"><td>${esc(fmtWhen(m.created_at))}</td><td>${esc(m.to_addr)}</td><td>${esc(m.subject)}</td><td>${m.status === 'sent' ? '<span class="badge green">Sent</span>' : '<span class="badge red">Failed</span>'}</td></tr>`), ['When', 'To', 'Subject', 'Status'], 'No emails yet.')}</div>`;
      $('#cpMail').onclick = () => custAction('email');
      $$('[data-ml]').forEach(r => r.onclick = () => { const m = d.emails.find(x => x.id === Number(r.dataset.ml)); openDrawer({ title: m.subject, sub: `To ${esc(m.to_addr)} · ${esc(fmtWhen(m.created_at))}`, body: `<pre style="white-space:pre-wrap;font:inherit">${esc(m.body || '')}</pre>`, footer: '' }); });
    } else if (t === 'issues') {
      B.innerHTML = `<div class="card"><h2>Issues &amp; complaints</h2><button class="btn" id="cpIss">Create issue</button>${rowsOr(d.issues.map(i => `<tr class="click" data-iss="${i.id}"><td><b>${esc(i.title)}</b><small>${esc(i.type)} · ${esc(i.category || '')}</small></td><td>${badge(i.priority)}</td><td>${badge(i.status)}</td><td>${esc(i.assigned_to || 'Unassigned')}</td><td>${i.due_date ? fmtDate(i.due_date) : '—'}</td></tr>`), ['Item', 'Priority', 'Status', 'Assigned', 'Due'], 'No issues for this customer.')}</div>`;
      $('#cpIss').onclick = () => custAction('issue');
      $$('[data-iss]').forEach(r => r.onclick = () => openIssue(d.issues.find(i => i.id === Number(r.dataset.iss)), { id: c.id }));
    } else if (t === 'estimates' || t === 'proposals') {
      const list = t === 'estimates' ? d.estimates : d.proposals;
      B.innerHTML = `<div class="card"><h2>${t === 'estimates' ? 'Estimates (internal drafts)' : 'Proposals (sent to the customer)'}</h2><button class="btn" id="cpEst">${t === 'estimates' ? 'Create estimate' : 'Create proposal'}</button>${rowsOr(list.map(e => `<tr class="click" data-est="${e.id}"><td>#${e.id} <b>${esc(e.project_name || '')}</b></td><td>${esc(e.scope_category || 'Not categorized')}</td><td class="num">${money(e.proposal_total)}</td><td>${badge(e.status)}</td><td>${e.sent_at ? fmtDate(e.sent_at) : '—'}</td></tr>`), ['Proposal', 'Service', 'Total', 'Status', 'Sent'], t === 'estimates' ? 'No draft estimates.' : 'No proposals sent yet.')}</div>`;
      $('#cpEst').onclick = () => custAction(t === 'estimates' ? 'estimate' : 'proposal'); bindOpeners(B);
    } else if (t === 'contracts') {
      B.innerHTML = `<div class="card"><h2>Contracts</h2>${rowsOr(d.contracts.map(k => `<tr class="click" data-rec="contracts:${k.id}"><td><b>${esc(k.title || 'Contract #' + k.id)}</b></td><td class="num">${money(k.value)}</td><td>${badge(k.status)}</td><td>${badge(k.signature_status || 'Not sent')}</td><td>${k.start_date ? fmtDate(k.start_date) : '—'} – ${k.end_date ? fmtDate(k.end_date) : '—'}</td></tr>`), ['Contract', 'Value', 'Status', 'Signature', 'Term'], 'No contracts.')}</div>`; bindOpeners(B);
    } else if (t === 'projects') {
      B.innerHTML = `<div class="card"><h2>Projects</h2>${rowsOr(d.projects.map(p => `<tr class="click" data-rec="projects:${p.id}"><td><b>${esc(p.name || 'Project #' + p.id)}</b><small>${esc(p.site_address || '')}</small></td><td>${badge(p.status)}</td><td>${p.progress || 0}%</td><td>${p.due_date ? fmtDate(p.due_date) : '—'}</td></tr>`), ['Project', 'Status', 'Progress', 'Due'], 'No projects.')}</div>`; bindOpeners(B);
    } else if (t === 'invoices') {
      B.innerHTML = `<div class="card"><h2>Invoices &amp; payments</h2>${rowsOr(d.invoices.map(i => `<tr class="click" data-rec="invoices:${i.id}"><td><b>${esc(i.invoice_number || '#' + i.id)}</b></td><td class="num">${money(i.amount)}</td><td class="num">${money(i.paid_amount)}</td><td class="num">${money(Math.max(0, i.amount - i.paid_amount))}</td><td>${i.due_date ? fmtDate(i.due_date) : '—'}</td><td>${badge(i.status)}</td></tr>`), ['Invoice', 'Amount', 'Paid', 'Balance', 'Due', 'Status'], 'No invoices.')}</div>`; bindOpeners(B);
    } else if (t === 'documents') {
      B.innerHTML = `<div class="card"><h2>Documents</h2><button class="btn" id="cpUp">Upload files</button>${rowsOr(d.documents.map(x => `<tr><td><button class="linklike" data-dl="${x.id}">${esc(x.title)}</button><small>${esc(x.file_name || '')}</small></td><td>${esc(x.kind)}</td><td>${esc(x.revision || '—')}</td><td>${fmtDate(x.created_at)}</td></tr>`), ['Document', 'Type', 'Rev', 'Uploaded'], 'No documents for this customer.')}</div>`;
      $('#cpUp').onclick = () => uploadDocs();
      $$('[data-dl]').forEach(b => b.onclick = () => { const x = d.documents.find(y => y.id === Number(b.dataset.dl)); downloadFile({ name: x.file_name || x.title, url: x.file_url }); });
    } else if (t === 'activity') {
      B.innerHTML = `<div class="card"><h2>Activity history</h2><p class="muted">Every change to this customer and its records, with who made it and when.</p><div class="activity">${renderActivity(d.activity) || '<p class="empty">No activity yet.</p>'}</div></div>`;
    }
  }
  async function custAction(a) {
    const d = cp.d, c = d.customer, pc = d.contacts.find(x => x.is_primary) || {};
    if (a === 'note') { cp.tab = 'notes'; renderCustomerPage(); setTimeout(() => $('#ntForm textarea').focus(), 50); }
    else if (a === 'call') logCall({ customer_id: c.id, company: c.company || '', contact_name: pc.name || '', phone: pc.phone || c.phone || '' });
    else if (a === 'issue') openIssue(null, { id: c.id });
    else if (a === 'estimate' || a === 'proposal') { go('estimator'); setTimeout(() => openEstimator(null, { contact_name: pc.name || c.name || '', company: c.company || '', email: pc.email || c.email || '', address: c.address || '' }), 50); }
    else if (a === 'email') {
      const tos = d.contacts.filter(k => k.email);
      if (!tos.length) return toast('Add a contact with an email address first.', true);
      openForm({ title: 'Send email', sub: esc(c.company || c.name), defs: [{ name: 'to', label: 'To', type: 'select', options: tos.map(k => [k.email, `${k.name} <${k.email}>`]) }, { name: 'subject', label: 'Subject', wide: true }, { name: 'body', label: 'Message', type: 'textarea' }],
        values: { to: pc.email || tos[0].email }, submit: b => api(`/api/admin/customers/${c.id}/email`, { method: 'POST', json: b }), after: () => { toast('Email sent'); loadCustomerPage(); } });
    } else if (a === 'edit') {
      openForm({ title: 'Edit account', defs: [{ name: 'company', label: 'Company' }, { name: 'status', label: 'Status', type: 'select', options: d.options.statuses }, { name: 'account_owner', label: 'Account owner', type: 'select', options: [['', 'Unassigned'], ...d.users] }, { name: 'customer_type', label: 'Customer type', type: 'select', options: ['', 'Commercial', 'General contractor', 'Property management', 'Multifamily', 'Healthcare', 'Education', 'Government', 'Residential'] }, { name: 'industry', label: 'Industry' }, { name: 'tax_id', label: 'Tax ID / EIN' }, { name: 'phone', label: 'Main phone' }, { name: 'address', label: 'Billing address', wide: true }],
        values: c, submit: b => api(`/api/admin/customers/${c.id}/account`, { method: 'PATCH', json: b }), after: r => { toast(r.changed.length ? 'Saved' : 'No changes'); loadCustomerPage(); } });
    } else if (a === 'remove') {
      const label = c.company || c.name || c.email;
      const typed = prompt(`Removing a customer cannot be undone. Customers with proposals, contracts, projects or invoices cannot be removed; set them to Inactive instead.\n\nType the customer name to confirm:\n${label}`);
      if (typed == null) return;
      try { await api('/api/admin/customers/' + c.id, { method: 'DELETE', json: { confirm: typed } }); toast('Customer removed'); sessionStorage.removeItem('bc_cust'); go('customers'); } catch (err) { toast(err.message, true); }
    }
  }

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
    // Approval-aware actions: the owner (or a manager) approves and acts in one step; staff send the owner a request.
    const clearApproval = async action => {
      const ap = await api(`/api/admin/estimates/${e.id}/approval`);
      if (ap.blocked) { toast(ap.blocked, true); return false; }
      if (!ap.required || (ap.approval && ap.approval.valid)) return true;
      const why = ap.reasons.map(r => '• ' + r).join('\n');
      if (ap.can_approve) {
        if (!confirm(`This proposal needs approval before it ${action}:\n${why}\n\nYou can approve it. Approve and continue?`)) return false;
        await api(`/api/admin/estimates/${e.id}/approve`, { method: 'POST', json: { note: `Approved by ${$('#whoEmail').textContent} when it ${action}` } });
        return true;
      }
      if (confirm(`This proposal needs owner approval before it ${action}:\n${why}\n\nSend the owner an approval request?`)) {
        await api(`/api/admin/estimates/${e.id}/request-approval`, { method: 'POST' }); toast('Approval request sent to the owner');
      }
      return false;
    };
    $('#es').onchange = async ev => {
      const to = ev.target.value;
      try {
        if (['Sent', 'Approved'].includes(to) && ['Draft', 'Ready'].includes(e.status) && !(await clearApproval(to === 'Sent' ? 'goes to the customer' : 'is marked approved'))) { ev.target.value = e.status; return; }
        await api('/api/admin/estimates/' + e.id, { method: 'PATCH', json: { status: to } }); toast('Status updated'); openEstimate(e.id); loadEstimates();
      }
      catch (err) { ev.target.value = e.status; toast(err.message, true); }
    };
    $('#eCopy').onclick = () => navigator.clipboard.writeText(url).then(() => toast('Link copied')).catch(() => { $('#eUrl').select(); toast('Press Ctrl+C to copy'); });
    $('#eSend').onclick = async () => {
      try { if (!(await clearApproval('goes to the customer'))) return; } catch (err) { return toast(err.message, true); }
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
    $('#slPhaseRow').hidden = cat !== 'construction';
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
    const hours = it.production_rate > 0 ? qty / it.production_rate : 0;
    const laborRate = Number(ef.elements.labor_rate.value) || 0;
    const amount = it.pricing_method === 'hourly' ? hours * laborRate : it.pricing_method === 'lump_sum' ? it.unit_price : qty * it.unit_price;
    const r = n => Math.round(n * 100) / 100;
    return { scope_id: it.id, description: `${it.name} (${Number.isInteger(qty) ? qty.toLocaleString('en-US') : r(qty)} ${it.unit})`, category: it.category, unit: it.unit,
      quantity: qty, unit_price: it.unit_price, production_rate: it.production_rate || 0, pricing_method: it.pricing_method, hours: r(hours), amount: r(amount) };
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
  $('#slPhases').addEventListener('click', () => {
    const sf = Number(String(ef.elements.area_sqft.value).replace(/,/g, ''));
    if (!(sf > 0)) { toast('Enter the building square footage first.', true); ef.elements.area_sqft.focus(); return; }
    const phases = ['Clean #1', 'Clean #2', 'Clean #3'].map(p => scopeState.items.find(i => i.active && i.category === 'construction' && i.name.startsWith(p) && !i.missing.length));
    const missingPh = ['Clean #1', 'Clean #2', 'Clean #3'].filter((p, i) => !phases[i]);
    if (missingPh.length) { toast(`Add a priced ${missingPh.join(', ')} item under Cleaning scopes first.`, true); return; }
    scopeLines = scopeLines.filter(l => !phases.some(p => p.id === l.scope_id));
    phases.forEach(it => scopeLines.push(priceLine(it, sf)));
    if (!parseLines(ef.elements.line_items_text.value).length) ef.elements.use_line_items.checked = true;
    renderScopeLines(); calcEstimate(); toast(`Added 3 phases at ${sf.toLocaleString()} SF`);
  });
  function renderScopeLines() {
    $('#slWrap').hidden = !scopeLines.length;
    $('#slRows').innerHTML = scopeLines.map((l, i) => `<tr><td>${esc(l.description)}<small>${l.pricing_method === 'hourly' ? 'Hourly' : l.pricing_method === 'lump_sum' ? 'Lump sum' : money(l.unit_price) + ' / ' + esc(l.unit)}${Number(l.production_rate) > 0 ? ` · ${Number(l.production_rate).toLocaleString()} ${esc(l.unit)}/hr` : ''}</small></td><td class="num">${Number(l.quantity).toLocaleString()}</td><td class="num">${Number(l.hours).toFixed(2)}</td><td class="num">${money(l.amount)}</td><td><button type="button" class="btn ghost" data-slrm="${i}" aria-label="Remove line">Remove</button></td></tr>`).join('');
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
    const pr = n('production_rate'), ar = n('area_sqft');
    const fix = $('#cFix');
    if (pr > 0 && pr < 20 && ar > 0) {
      fix.hidden = false;
      fix.innerHTML = `<b>Check the production rate.</b> ${pr} sq ft per labor hour means ${Math.round(ar / pr).toLocaleString()} labor hours for ${ar.toLocaleString()} SF. Crews usually clean 150–1,000 SF per hour. If ${money(pr)} is your <b>price per square foot</b>, use the button. <button type="button" class="btn small" id="cFixBtn">Price this as ${ar.toLocaleString()} SF × ${money(pr)}/SF</button>`;
      $('#cFixBtn').onclick = () => {
        const line = `Cleaning: ${ar.toLocaleString()} SF at ${money(pr)}/SF | ${(Math.round(ar * pr * 100) / 100).toFixed(2)}`;
        ef.elements.line_items_text.value = [ef.elements.line_items_text.value.trim(), line].filter(Boolean).join('\n');
        ef.elements.production_rate.value = 0; ef.elements.labor_hours.value = 0; ef.elements.use_line_items.checked = true;
        calcEstimate(); toast('Priced by the square foot. Labor build-up cleared.');
      };
    } else if (m.hours > 3000 * Math.max(1, n('visits') || 1)) {
      fix.hidden = false; fix.innerHTML = `<b>Unusually high labor:</b> ${Math.round(m.hours).toLocaleString()} hours. Check the area, production rate and number of visits before sending.`;
    } else fix.hidden = true;
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
    await Promise.all([loadUsers(), loadAutomation(), loadBackups(), loadApprovalRules(), loadAISettings()]);
  }
  async function loadAISettings() {
    const r = await api('/api/admin/ai/status'); aiStatus = r;
    $('#aiState').innerHTML = r.enabled ? `<span class="badge green">On</span> Model: ${esc(r.model)}` : '<span class="badge amber">Off</span> Add ANTHROPIC_API_KEY in Render (Environment) to turn it on.';
    $('#aiAuto').checked = r.auto_triage; $('#aiInfo').checked = r.auto_request_info !== false; $('#aiDraft').checked = r.auto_draft_estimates !== false;
  }
  [['#aiAuto', 'auto_triage'], ['#aiInfo', 'auto_request_info'], ['#aiDraft', 'auto_draft_estimates']].forEach(([sel, k]) => $(sel).addEventListener('change', async e => { try { await api('/api/admin/ai/settings', { method: 'PUT', json: { [k]: e.target.checked } }); toast('Saved'); } catch (err) { toast(err.message, true); } }));
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
    $('#autoEmail').textContent = d.email_configured ? `Email is set up. Links in emails use ${d.public_base_url}.` : 'Email is not set up yet (add POSTMARK_TOKEN in Render), so reminders are logged as skipped and nothing is sent.';
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
    const r = await api('/api/admin/users'), users = r.users || [], canRoles = !!r.can_manage_roles;
    const me = $('#whoEmail').textContent;
    $('#userList').innerHTML = users.map(u => `<div class="userrow"><span><b>${esc(u.name || u.email)}</b><small>${esc(u.email)} · ${esc(u.role ? u.role[0].toUpperCase() + u.role.slice(1) : (u.owner ? 'Owner' : 'Staff'))}${u.role !== 'staff' ? ' (can approve proposals)' : ''}${u.last_login_at ? ' · last signed in ' + esc(ago(u.last_login_at)) : ''}</small></span>${u.id && !u.env_owner ? `<select data-role="${u.id}" aria-label="Role for ${esc(u.email)}"${canRoles ? '' : ' disabled'}>${['owner', 'manager', 'staff'].map(r => `<option value="${r}"${u.role === r ? ' selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select>` : ''}${!u.owner && u.email !== me && u.id ? `<button class="btn small danger" data-deluser="${u.id}" data-email="${esc(u.email)}">Remove</button>` : ''}</div>`).join('');
    $$('[data-role]').forEach(sel => sel.onchange = async () => { try { await api(`/api/admin/users/${sel.dataset.role}/role`, { method: 'PATCH', json: { role: sel.value } }); toast('Role updated'); loadUsers(); } catch (err) { toast(err.message, true); loadUsers(); } });
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

  // ---------- AI ----------
  let aiStatus = null;
  const getAI = async () => aiStatus || (aiStatus = await api('/api/admin/ai/status').catch(() => ({ enabled: false })));
  async function renderLeadAI(l) {
    const box = $('#leadAI'); if (!box) return;
    const auto = l.auto_estimate_id > 0 ? `<div class="autobox"><b>Draft estimate #${l.auto_estimate_id} was prepared automatically</b> from this request using your price book. <button type="button" class="btn small" id="autoOpen">Review estimate</button></div>`
      : (l.intake ? `<div class="autobox">No automatic estimate yet. <button type="button" class="btn small ghost" id="autoDraft">Draft estimate from this request</button></div>` : '');
    if ($('#leadAuto')) $('#leadAuto').remove();
    box.insertAdjacentHTML('beforebegin', `<div id="leadAuto">${auto}</div>`);
    if ($('#autoOpen')) $('#autoOpen').onclick = () => { closeDrawer(); go('proposals'); openEstimate(l.auto_estimate_id); };
    if ($('#autoDraft')) $('#autoDraft').onclick = async () => { try { const r = await api(`/api/admin/leads/${l.id}/draft-estimate`, { method: 'POST' }); toast(`Draft estimate #${r.estimate_id} ready${r.total ? ' – ' + money(r.total) : ''}`); closeDrawer(); go('proposals'); openEstimate(r.estimate_id); } catch (e) { toast(e.message, true); } };
    const st = await getAI();
    let ai = null; try { ai = l.ai ? JSON.parse(l.ai) : null; } catch { ai = null; }
    if (!st.enabled && !ai) { box.innerHTML = '<div class="formsection">AI assistant</div><p class="muted">AI is off. Add ANTHROPIC_API_KEY in Render to get an automatic summary, missing-information list and a reply draft for every new lead.</p>'; return; }
    const run = '<button type="button" class="btn ghost" id="aiRun">' + (ai && !ai.error ? 'Re-run AI' : 'Run AI triage') + '</button>';
    if (!ai || ai.error) { box.innerHTML = `<div class="formsection">AI assistant</div><p class="muted">${ai && ai.error ? 'Last AI run failed: ' + esc(ai.error) : 'Not analyzed yet. New leads are analyzed automatically within a minute.'}</p>${run}`; }
    else box.innerHTML = `<div class="formsection">AI assistant</div>
      <p><b>${esc(ai.summary)}</b></p>
      <p>${badge(ai.category)} ${ai.priority === 'High' ? '<span class="badge red">High priority</span>' : badge(ai.priority)} <small class="muted">${esc(fmtWhen(ai.at))}</small></p>
      ${ai.missing && ai.missing.length ? `<ul class="needs">${ai.missing.map(m => `<li>Needed: ${esc(m)}</li>`).join('')}</ul>` : ''}
      <p><b>Next step:</b> ${esc(ai.next_step || '')}</p>
      <div class="grid"><div class="f wide"><label for="aiSubj">Reply subject</label><input id="aiSubj" value="${esc(ai.reply_subject || '')}"></div>
      <div class="f wide"><label for="aiBody">Reply (edit before sending)</label><textarea id="aiBody" rows="8">${esc(ai.reply_body || '')}</textarea></div></div>
      <button type="button" class="btn" id="aiSend"${l.email ? '' : ' disabled'}>Send reply to ${esc(l.email || 'customer')}</button> ${run}
      ${ai.info_requested_at ? `<p><span class="badge green">Questions emailed to the customer</span> <small class="muted">${esc(fmtWhen(ai.info_requested_at))}</small></p>` : ''}
      <p class="hint">Replies cannot include prices. Automatic questions go out only when information is missing and the setting is on.</p>`;
    $('#aiRun').onclick = async () => { $('#aiRun').disabled = true; $('#aiRun').textContent = 'Analyzing…'; try { const r = await api(`/api/admin/ai/leads/${l.id}/triage`, { method: 'POST' }); l.ai = JSON.stringify(r.ai); renderLeadAI(l); } catch (e) { toast(e.message, true); $('#aiRun').disabled = false; $('#aiRun').textContent = 'Run AI triage'; } };
    if ($('#aiSend')) $('#aiSend').onclick = async () => { if (!confirm(`Send this reply to ${l.email}?`)) return; try { await api(`/api/admin/leads/${l.id}/reply`, { method: 'POST', json: { subject: $('#aiSubj').value, body: $('#aiBody').value } }); toast('Reply sent'); } catch (e) { toast(e.message, true); } };
  }

  // ---------- Shared form drawer ----------
  // defs: [{name, label, type: text|textarea|select|date|time|number|checkbox|customer|project|user|file, options, wide, hint, value}]
  async function refs(need) {
    const out = {};
    if (need.customer) out.customers = state.customers && state.customers.length ? state.customers : (state.customers = (await api('/api/admin/customers')).customers || []);
    if (need.project) out.projects = state.projects && state.projects.length ? state.projects : (state.projects = (await api('/api/admin/projects')).projects || []);
    if (need.user) out.users = (await api('/api/admin/users')).users.map(u => u.email);
    return out;
  }
  async function openForm({ title, sub, defs, values = {}, submit, after, extraFooter }) {
    const need = { customer: defs.some(d => d.type === 'customer'), project: defs.some(d => d.type === 'project'), user: defs.some(d => d.type === 'user') };
    let r = {}; try { r = await refs(need); } catch { /* lists optional */ }
    const v = k => values[k] == null ? '' : values[k];
    const opt = (list, cur, lab) => list.map(o => { const [val, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}"${String(val) === String(cur) ? ' selected' : ''}>${esc(lab ? lab(l) : l)}</option>`; }).join('');
    const field = (d, i) => {
      const id = 'ff' + i, wide = d.wide || ['textarea', 'checkbox', 'file'].includes(d.type) ? ' wide' : '';
      let ctl;
      if (d.type === 'textarea') ctl = `<textarea id="${id}" name="${d.name}">${esc(v(d.name))}</textarea>`;
      else if (d.type === 'select') ctl = `<select id="${id}" name="${d.name}">${opt(d.options, v(d.name))}</select>`;
      else if (d.type === 'customer') ctl = `<select id="${id}" name="${d.name}"><option value="">None</option>${opt((r.customers || []).map(c => [c.id, c.company || c.name || c.email]), v(d.name))}</select>`;
      else if (d.type === 'project') ctl = `<select id="${id}" name="${d.name}"><option value="">None</option>${opt((r.projects || []).map(p => [p.id, p.name || p.customer_name]), v(d.name))}</select>`;
      else if (d.type === 'user') ctl = `<select id="${id}" name="${d.name}"><option value="">Unassigned</option>${opt(r.users || [], v(d.name))}</select>`;
      else if (d.type === 'checkbox') return `<div class="f wide"><label class="chk"><input type="checkbox" id="${id}" name="${d.name}" value="1"${values[d.name] ? ' checked' : ''}> ${esc(d.label)}</label>${d.hint ? `<span class="hint">${esc(d.hint)}</span>` : ''}</div>`;
      else if (d.type === 'file') ctl = `<input id="${id}" name="${d.name}" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.zip">`;
      else ctl = `<input id="${id}" name="${d.name}" type="${d.type === 'number' ? 'text" inputmode="decimal' : d.type || 'text'}" value="${esc(v(d.name))}"${d.placeholder ? ` placeholder="${esc(d.placeholder)}"` : ''}>`;
      return `<div class="f${wide}"><label for="${id}">${esc(d.label)}</label>${ctl}${d.hint ? `<span class="hint">${esc(d.hint)}</span>` : ''}</div>`;
    };
    openDrawer({ title, sub: sub || '', body: `<form id="genForm" class="grid" novalidate>${defs.map(field).join('')}</form><div id="genExtra"></div><p class="msg" id="genMsg" role="status"></p>`,
      footer: `<button class="btn" id="genSave">Save</button>${extraFooter || ''}` });
    $('#genSave').onclick = async () => {
      const f = $('#genForm'), body = {};
      for (const d of defs) { const el = f.elements[d.name]; if (!el) continue; body[d.name] = d.type === 'checkbox' ? el.checked : d.type === 'file' ? el.files : el.value; }
      try { const res = await submit(body); closeDrawer(); if (after) after(res); }
      catch (err) { $('#genMsg').className = 'msg err'; $('#genMsg').textContent = err.message; }
    };
    return $('#genForm');
  }
  const kpiTiles = (el, tiles) => { $(el).innerHTML = tiles.map(t => `<div class="kpi${t.alert ? ' alert' : ''}"><span style="min-width:0"><span>${esc(t.label)}</span><b>${esc(t.value)}</b>${t.sub ? `<small class="flat">${esc(t.sub)}</small>` : ''}</span></div>`).join(''); };

  // ---------- Global search ----------
  let gTimer = null;
  $('#gSearch').addEventListener('input', () => { clearTimeout(gTimer); gTimer = setTimeout(runSearch, 200); });
  $('#gSearch').addEventListener('keydown', e => { if (e.key === 'Escape') { $('#gResults').hidden = true; } if (e.key === 'ArrowDown') { const b = $('#gResults button'); if (b) { e.preventDefault(); b.focus(); } } });
  document.addEventListener('click', e => { if (!e.target.closest('.gsearch')) $('#gResults').hidden = true; });
  async function runSearch() {
    const q = $('#gSearch').value.trim(), box = $('#gResults');
    if (q.length < 2) { box.hidden = true; return; }
    let r; try { r = await api('/api/admin/search?q=' + encodeURIComponent(q)); } catch { return; }
    box.hidden = false;
    box.innerHTML = r.results.length ? r.results.map((x, i) => `<button type="button" data-g="${i}"><b>${esc(x.title || '(no name)')}</b><small>${esc(x.sub)}</small></button>`).join('') : '<p class="empty" style="padding:12px">Nothing found.</p>';
    $$('#gResults [data-g]').forEach(b => b.onclick = async () => {
      const x = r.results[Number(b.dataset.g)]; box.hidden = true; $('#gSearch').value = '';
      if (x.type === 'lead') { go('leads'); openLead(x.id); }
      else if (x.type === 'customer') openCustomerPage(x.id);
      else if (x.type === 'estimate') { go('proposals'); openEstimate(x.id); }
      else if (x.type === 'project') { go('projects'); openRecord('projects', x.id); }
      else if (x.type === 'invoice') { go('invoices'); openRecord('invoices', x.id); }
      else if (x.type === 'issue') { go('issues'); setTimeout(() => { const it = issState.issues.find(i => i.id === x.id); if (it) openIssue(it, null); }, 600); }
      else if (x.type === 'document') go('documents');
      else if (x.type === 'call') go('calls');
    });
  }

  // ---------- Manual lead ----------
  function newLead() {
    openForm({ title: 'New lead', sub: 'For calls, walk-ins and referrals', defs: [
      { name: 'kind', label: 'Type', type: 'select', options: [['bid', 'Bid request'], ['inquiry', 'General inquiry']] },
      { name: 'source', label: 'Source', type: 'select', options: ['Phone call', 'Referral', 'Walk-in', 'Email', 'Bid invitation', 'Other'] },
      { name: 'contact_name', label: 'Contact name' }, { name: 'company', label: 'Company' },
      { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'project_name', label: 'Project / property' }, { name: 'service', label: 'Service needed' },
      { name: 'square_footage', label: 'Square footage', type: 'number' }, { name: 'bid_due_date', label: 'Bid due date', type: 'date' },
      { name: 'address', label: 'Address', wide: true }, { name: 'details', label: 'Details', type: 'textarea' }],
      submit: b => api('/api/admin/leads', { method: 'POST', json: b }),
      after: res => { toast('Lead added'); go('leads'); openLead(res.id); } });
  }

  // ---------- Calls ----------
  const callState = { calls: [], options: null };
  $('#callsAdd').addEventListener('click', () => logCall());
  $('#callSearch').addEventListener('input', () => renderCalls());
  $('#callFollow').addEventListener('change', () => renderCalls());
  async function loadCalls() {
    const r = await api('/api/admin/calls'); Object.assign(callState, r);
    kpiTiles('#callsKpis', [{ label: "Today's calls", value: r.today.total }, { label: 'Answered', value: r.today.answered }, { label: 'Missed / voicemail', value: r.today.missed, alert: r.today.missed > 0 }, { label: 'Follow-ups due', value: r.follow_ups_due, alert: r.follow_ups_due > 0 }]);
    $('#navCalls').hidden = !r.follow_ups_due; $('#navCalls').textContent = r.follow_ups_due;
    renderCalls();
  }
  function renderCalls() {
    const q = $('#callSearch').value.trim().toLowerCase(), due = $('#callFollow').checked, t = todayISO();
    const rows = callState.calls.filter(c => (!q || [c.contact_name, c.company, c.phone, c.summary, c.customer_company].join(' ').toLowerCase().includes(q)) && (!due || (!c.follow_up_done && c.follow_up_date && c.follow_up_date <= t)));
    $('#callsRows').innerHTML = rows.length ? rows.map(c => `<tr class="click" data-call="${c.id}"><td>${esc(fmtWhen(c.created_at))}<small>${esc(c.direction)}</small></td><td><b>${esc(c.company || c.customer_company || c.contact_name || '—')}</b><small>${esc([c.contact_name, c.phone].filter(Boolean).join(' · '))}</small></td><td>${badge(c.purpose)}</td><td>${c.outcome === 'Answered' ? esc(c.outcome) : `<span class="badge amber">${esc(c.outcome)}</span>`}</td><td>${esc((c.summary || '').slice(0, 90))}</td><td class="${!c.follow_up_done && c.follow_up_date && c.follow_up_date <= t ? 'late' : ''}">${c.follow_up_date ? (c.follow_up_done ? 'Done' : fmtDate(c.follow_up_date)) : '—'}</td></tr>`).join('')
      : `<tr><td class="emptyrow" colspan="6">No calls logged${q || due ? ' match' : ' yet'}.</td></tr>`;
    $$('[data-call]').forEach(r => r.onclick = () => openCall(callState.calls.find(c => c.id === Number(r.dataset.call))));
  }
  async function logCall(prefill) {
    if (!callState.options) { try { Object.assign(callState, await api('/api/admin/calls')); } catch { /* */ } }
    const o = callState.options || { direction: ['Inbound'], outcome: ['Answered'], purpose: ['New business'] };
    openForm({ title: 'Log a call', defs: [
      { name: 'direction', label: 'Direction', type: 'select', options: o.direction }, { name: 'outcome', label: 'Outcome', type: 'select', options: o.outcome },
      { name: 'contact_name', label: 'Caller name' }, { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'company', label: 'Company' }, { name: 'customer_id', label: 'Existing customer', type: 'customer' },
      { name: 'purpose', label: 'Purpose', type: 'select', options: o.purpose }, { name: 'follow_up_date', label: 'Follow up on', type: 'date' },
      { name: 'summary', label: 'What was discussed', type: 'textarea' },
      { name: 'create_lead', label: 'Create a lead from this call (new business, bid request or pricing question)', type: 'checkbox' }],
      values: prefill || {},
      submit: b => api('/api/admin/calls', { method: 'POST', json: b }),
      extraFooter: '<button type="button" class="btn ghost" id="aiCall">Fill from notes (AI)</button>',
      after: res => { toast(res.lead_id ? 'Call logged and lead created' : 'Call logged'); if (state.view === 'calls') loadCalls(); else if (state.view === 'overview') loadOverview(); } });
  }
  document.addEventListener('click', async e => {
    if (!e.target || e.target.id !== 'aiCall') return;
    const f = $('#genForm'); const notes = f.elements.summary.value.trim();
    if (!notes) return toast('Type the call notes in "What was discussed" first.', true);
    e.target.disabled = true; e.target.textContent = 'Reading notes…';
    try {
      const r = (await api('/api/admin/ai/calls/extract', { method: 'POST', json: { notes } })).fields;
      for (const k of ['contact_name', 'company', 'phone']) if (r[k] && !f.elements[k].value) f.elements[k].value = r[k];
      if (r.purpose && [...f.elements.purpose.options].some(o => o.value === r.purpose)) f.elements.purpose.value = r.purpose;
      const extra = [r.service && 'Service: ' + r.service, r.square_footage && 'Size: ' + r.square_footage, r.deadline && 'Deadline: ' + r.deadline, r.follow_up && 'Next: ' + r.follow_up].filter(Boolean).join('\n');
      if (r.summary) f.elements.summary.value = r.summary + (extra ? '\n' + extra : '') + '\n---\n' + notes;
      if (['New business', 'Bid request', 'Pricing question'].includes(r.purpose)) f.elements.create_lead.checked = true;
      toast('Filled from your notes. Check before saving.');
    } catch (err) { toast(err.message, true); }
    e.target.disabled = false; e.target.textContent = 'Fill from notes (AI)';
  });
  function openCall(c) {
    openDrawer({ title: c.company || c.contact_name || c.phone || 'Call', sub: `${c.direction} · ${fmtWhen(c.created_at)}${c.created_by ? ' · logged by ' + esc(c.created_by) : ''}`,
      body: `<dl class="facts"><dt>Caller</dt><dd>${esc(c.contact_name || '—')}</dd><dt>Phone</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</dd><dt>Purpose</dt><dd>${esc(c.purpose)}</dd><dt>Outcome</dt><dd>${esc(c.outcome)}</dd><dt>Customer</dt><dd>${esc(c.customer_company || c.customer_name || '—')}</dd><dt>Lead</dt><dd>${c.lead_id ? `<button class="linklike" id="callLead">Lead #${c.lead_id}</button>` : '—'}</dd><dt>Follow-up</dt><dd>${c.follow_up_date ? fmtDate(c.follow_up_date) + (c.follow_up_done ? ' (done)' : '') : '—'}</dd></dl><div class="formsection">Summary</div><p>${esc(c.summary || '—')}</p>`,
      footer: c.follow_up_date && !c.follow_up_done ? '<button class="btn" id="callDone">Mark follow-up done</button>' : '' });
    if ($('#callLead')) $('#callLead').onclick = () => { closeDrawer(); go('leads'); openLead(c.lead_id); };
    if ($('#callDone')) $('#callDone').onclick = async () => { try { await api('/api/admin/calls/' + c.id, { method: 'PATCH', json: { follow_up_done: true } }); toast('Follow-up done'); closeDrawer(); loadCalls(); } catch (e) { toast(e.message, true); } };
  }

  // ---------- Schedule ----------
  const schedState = { visits: [], options: null };
  $('#scheduleAdd').addEventListener('click', () => scheduleVisit());
  $('#schedRange').addEventListener('change', () => loadSchedule());
  $('#schedMode').addEventListener('change', () => { if ($('#schedMode').value === 'week' && $('#schedRange').value === 'past') $('#schedRange').value = '14'; loadSchedule(); });
  async function loadSchedule() {
    const v = $('#schedRange').value, t = new Date();
    const from = v === 'past' ? new Date(t - 30 * 864e5) : t, to = v === 'past' ? t : new Date(+t + Number(v) * 864e5);
    const r = await api(`/api/admin/visits?from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`); Object.assign(schedState, r);
    const items = [...r.visits.map(x => ({ ...x, kind: 'visit' })), ...r.project_due.map(p => ({ kind: 'due', id: p.id, date: p.due_date, title: `Due: ${p.name || p.customer_name}`, status: p.status, type: 'Project due' }))].sort((a, b) => (a.date + (a.start_time || '')).localeCompare(b.date + (b.start_time || '')));
    const week = r.visits.filter(x => x.status === 'Scheduled' && x.date <= new Date(+t + 7 * 864e5).toISOString().slice(0, 10)).length;
    kpiTiles('#scheduleKpis', [{ label: 'Scheduled in view', value: r.visits.filter(x => x.status === 'Scheduled').length }, { label: 'Next 7 days', value: week }, { label: 'Project due dates', value: r.project_due.length }, { label: 'Done', value: r.visits.filter(x => x.status === 'Done').length }]);
    const mode = $('#schedMode').value; $('#schedWeek').hidden = mode !== 'week'; $('#schedTable').hidden = mode === 'week';
    if (mode === 'week') {
      const start = new Date(); start.setHours(12, 0, 0, 0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d.toISOString().slice(0, 10); });
      $('#schedWeek').innerHTML = days.map(day => `<div class="day${day === todayISO() ? ' today' : ''}"><h3>${new Date(day + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</h3>${items.filter(x => x.date === day).map(x => x.kind === 'due' ? `<button class="ev due" data-due="${x.id}">${esc(x.title)}</button>` : `<button class="ev${x.status === 'Done' ? ' done' : ''}" data-visit="${x.id}"><b>${esc(x.start_time || '')}</b> ${esc(x.title)}</button>`).join('') || '<small class="muted">—</small>'}</div>`).join('');
    }
    $('#scheduleRows').innerHTML = items.length ? items.map(x => x.kind === 'due'
      ? `<tr class="click" data-due="${x.id}"><td>${fmtDate(x.date)}</td><td>—</td><td><b>${esc(x.title)}</b><small>Project due date</small></td><td>—</td><td>—</td><td>${badge(x.status)}</td></tr>`
      : `<tr class="click" data-visit="${x.id}"><td>${fmtDate(x.date)}</td><td>${esc([x.start_time, x.end_time].filter(Boolean).join('–') || 'Any time')}</td><td><b>${esc(x.title)}</b><small>${esc(x.type)}${x.address ? ' · ' + esc(x.address) : ''}</small></td><td>${esc(x.project_name || x.customer_company || x.customer_name || '—')}</td><td>${esc(x.assigned_to || '—')}${x.crew_size ? `<small>crew ${x.crew_size}</small>` : ''}</td><td>${badge(x.status)}</td></tr>`).join('')
      : '<tr><td class="emptyrow" colspan="6">Nothing scheduled in this range.</td></tr>';
    $$('#v-schedule [data-visit]').forEach(r => r.onclick = () => scheduleVisit(schedState.visits.find(x => x.id === Number(r.dataset.visit))));
    $$('#v-schedule [data-due]').forEach(r => r.onclick = () => { go('projects'); openRecord('projects', Number(r.dataset.due)); });
  }
  function scheduleVisit(v) {
    const o = schedState.options || { type: ['Site visit', 'Walkthrough', 'Cleaning phase', 'Inspection', 'Punch list', 'Other'], status: ['Scheduled', 'Done', 'Cancelled'] };
    openForm({ title: v ? v.title : 'Schedule a visit', defs: [
      { name: 'title', label: 'Title', wide: true, placeholder: 'Walkthrough – Ridge Office, Level 2' },
      { name: 'type', label: 'Type', type: 'select', options: o.type }, { name: 'date', label: 'Date', type: 'date' },
      { name: 'start_time', label: 'Start', type: 'time' }, { name: 'end_time', label: 'End', type: 'time' },
      { name: 'customer_id', label: 'Customer', type: 'customer' }, { name: 'project_id', label: 'Project', type: 'project' },
      { name: 'assigned_to', label: 'Assigned to', type: 'user' }, { name: 'crew_size', label: 'Crew size', type: 'number' },
      { name: 'address', label: 'Address', wide: true }, { name: 'notes', label: 'Notes', type: 'textarea' },
      ...(v ? [{ name: 'status', label: 'Status', type: 'select', options: o.status }] : [])],
      values: v || { date: todayISO(), type: 'Site visit' },
      submit: b => v ? api('/api/admin/visits/' + v.id, { method: 'PATCH', json: b }) : api('/api/admin/visits', { method: 'POST', json: b }),
      after: () => { toast(v ? 'Saved' : 'Scheduled'); if (state.view === 'schedule') loadSchedule(); } });
  }

  // ---------- Quality & inspections ----------
  const qState = { inspections: [], templates: {} };
  $('#qualityAdd').addEventListener('click', () => openInspection(null));
  async function loadQuality() {
    const r = await api('/api/admin/inspections'); Object.assign(qState, r);
    kpiTiles('#qualityKpis', [{ label: 'Inspections (90 days)', value: r.summary.count_90d }, { label: 'Average score', value: r.summary.average_score_90d == null ? '—' : r.summary.average_score_90d + '%' }, { label: 'Failed (90 days)', value: r.summary.failed_90d, alert: r.summary.failed_90d > 0 }, { label: 'Total recorded', value: r.inspections.length }]);
    $('#qualityRows').innerHTML = r.inspections.length ? r.inspections.map(i => `<tr class="click" data-insp="${i.id}"><td>${fmtDate(i.date)}</td><td><b>${esc(i.area)}</b><small>${esc(i.template || '')}</small></td><td>${esc(i.project_name || i.customer_company || i.customer_name || '—')}</td><td>${esc(i.inspector || '—')}</td><td>${i.score == null ? '—' : i.score + '%'}</td><td>${i.passed == null ? badge('Not scored') : i.passed ? '<span class="badge green">Pass</span>' : '<span class="badge red">Needs rework</span>'}</td></tr>`).join('')
      : '<tr><td class="emptyrow" colspan="6">No inspections yet.</td></tr>';
    $$('[data-insp]').forEach(r => r.onclick = () => openInspection(qState.inspections.find(i => i.id === Number(r.dataset.insp))));
  }
  async function openInspection(it) {
    if (!Object.keys(qState.templates).length) { try { Object.assign(qState, await api('/api/admin/inspections')); } catch { /* */ } }
    let items = it ? it.items.map(x => ({ ...x })) : [];
    await openForm({ title: it ? it.area : 'New inspection', sub: it && it.score != null ? `Score ${it.score}%` : 'Pick a checklist, then mark each item',
      defs: [{ name: 'area', label: 'Area / room', placeholder: 'Level 2 – east wing' }, { name: 'date', label: 'Date', type: 'date' },
        { name: 'project_id', label: 'Project', type: 'project' }, { name: 'customer_id', label: 'Customer', type: 'customer' },
        { name: 'inspector', label: 'Inspector' }, { name: 'template', label: 'Checklist', type: 'select', options: [['', 'Choose…'], ...Object.keys(qState.templates)] },
        { name: 'notes', label: 'Notes', type: 'textarea' }],
      values: it || { date: todayISO() },
      submit: b => { const body = { ...b, items: items.map((x, i) => ({ label: x.label, result: $(`#ci_r${i}`).value, note: $(`#ci_n${i}`).value })) }; return it ? api('/api/admin/inspections/' + it.id, { method: 'PATCH', json: body }) : api('/api/admin/inspections', { method: 'POST', json: body }); },
      after: res => { const s = res.inspection.score; toast(s == null ? 'Saved' : `Saved: ${s}%`); loadQuality(); } });
    const draw = () => { $('#genExtra').innerHTML = items.length ? `<div class="formsection">Checklist</div><table class="checklist">${items.map((x, i) => `<tr><td style="width:46%">${esc(x.label)}</td><td style="width:18%"><select id="ci_r${i}" aria-label="Result for ${esc(x.label)}">${['', 'Pass', 'Fail', 'N/A'].map(o => `<option${o === x.result ? ' selected' : ''} value="${o}">${o || '—'}</option>`).join('')}</select></td><td><input id="ci_n${i}" value="${esc(x.note || '')}" placeholder="Note (required if Fail)" aria-label="Note for ${esc(x.label)}"></td></tr>`).join('')}</table>` : '<p class="muted">Choose a checklist above to load its items.</p>'; };
    $('#genForm').elements.template.addEventListener('change', e => { const t = qState.templates[e.target.value]; if (t && (!items.length || confirm('Replace the current checklist items?'))) { items = t.map(label => ({ label, result: '', note: '' })); draw(); } });
    draw();
  }

  // ---------- Drawings & documents ----------
  const docState = { documents: [], kinds: [] };
  $('#documentsAdd').addEventListener('click', () => uploadDocs());
  $('#docKind').addEventListener('change', () => renderDocs());
  async function loadDocuments() {
    const r = await api('/api/admin/documents'); Object.assign(docState, r);
    const cur = $('#docKind').value; $('#docKind').innerHTML = '<option value="">All types</option>' + r.kinds.map(k => `<option>${esc(k)}</option>`).join(''); $('#docKind').value = cur;
    kpiTiles('#documentsKpis', [{ label: 'Files', value: r.documents.length }, { label: 'Drawing sets', value: r.documents.filter(d => d.kind === 'Drawings').length }, { label: 'Addenda', value: r.documents.filter(d => d.kind === 'Addendum').length }, { label: 'AI takeoff', value: r.ai_ready ? 'Ready' : 'Off', sub: r.ai_ready ? '' : 'needs Anthropic API key', alert: !r.ai_ready }]);
    renderDocs();
  }
  function renderDocs() {
    const k = $('#docKind').value, rows = docState.documents.filter(d => !k || d.kind === k);
    $('#documentsRows').innerHTML = rows.length ? rows.map(d => `<tr><td><button class="linklike" data-doc="${d.id}">${esc(d.title)}</button><small>${esc(d.file_name || '')}${d.size ? ' · ' + Math.round(d.size / 1024).toLocaleString() + ' KB' : ''}</small></td><td>${esc(d.kind)}</td><td>${esc(d.revision || '—')}</td><td>${esc(d.project_name || d.customer_company || d.customer_name || '—')}</td><td>${fmtDate(d.created_at)}</td><td>${badge(d.analysis_status)} <button class="btn ghost" data-totake="${d.id}">Takeoff</button>${docState.ai_ready && /\.pdf$/i.test(d.file_name || '') ? ` <button class="btn ghost" data-aitake="${d.id}">AI takeoff</button>` : ''}</td></tr>`).join('')
      : '<tr><td class="emptyrow" colspan="6">No files yet. Upload a drawing set to start.</td></tr>';
    $$('#documentsRows [data-doc]').forEach(b => b.onclick = () => { const d = docState.documents.find(x => x.id === Number(b.dataset.doc)); downloadFile({ name: d.file_name || d.title, url: d.file_url }); });
    $$('#documentsRows [data-aitake]').forEach(b => b.onclick = async () => { b.disabled = true; b.textContent = 'Reading drawings…'; try { const r = await api(`/api/admin/ai/documents/${b.dataset.aitake}/takeoff`, { method: 'POST' }); toast(`AI read ${r.analysis.sheets.length} sheets; takeoff #${r.takeoff_id} drafted for your review`); go('takeoffs'); } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'AI takeoff'; } });
    $$('#documentsRows [data-totake]').forEach(b => b.onclick = () => { const d = docState.documents.find(x => x.id === Number(b.dataset.totake)); openTakeoff(null, d); });
  }
  function uploadDocs() {
    openForm({ title: 'Upload drawings & documents', defs: [
      { name: 'files', label: 'Files (up to 8, 15 MB each)', type: 'file' }, { name: 'kind', label: 'Type', type: 'select', options: docState.kinds.length ? docState.kinds : ['Drawings', 'Specifications', 'Addendum', 'Finish schedule', 'Photos', 'Other'] },
      { name: 'revision', label: 'Revision', placeholder: 'e.g. IFC, Rev 3, Addendum 2' }, { name: 'title', label: 'Title (single file only)' },
      { name: 'project_id', label: 'Project', type: 'project' }, { name: 'customer_id', label: 'Customer', type: 'customer' }],
      submit: async b => { const fd = new FormData(); [...(b.files || [])].forEach(f => fd.append('files', f)); for (const k of ['kind', 'revision', 'title', 'project_id', 'customer_id']) fd.append(k, b[k] || ''); return api('/api/admin/documents', { method: 'POST', body: fd }); },
      after: res => { toast(`${res.ids.length} file(s) uploaded`); go('documents'); loadDocuments(); } });
  }

  // ---------- Email Center ----------
  const mailState = { emails: [] };
  $('#emailSearch').addEventListener('input', () => renderEmails()); $('#emailStatus').addEventListener('change', () => renderEmails());
  async function loadEmails() {
    const r = await api('/api/admin/emails'); mailState.emails = r.emails;
    kpiTiles('#emailsKpis', [{ label: 'Sent (30 days)', value: r.summary.sent_30d }, { label: 'Failed (30 days)', value: r.summary.failed_30d, alert: r.summary.failed_30d > 0 }, { label: 'Total (30 days)', value: r.summary.total_30d }, { label: 'Outlook inbox here', value: 'Not connected', sub: 'needs Microsoft 365 app' }]);
    $('#navEmails').hidden = !r.summary.failed_30d; $('#navEmails').textContent = r.summary.failed_30d;
    renderEmails();
  }
  function renderEmails() {
    const q = $('#emailSearch').value.trim().toLowerCase(), st = $('#emailStatus').value;
    const rows = mailState.emails.filter(m => (!st || m.status === st) && (!q || [m.to_addr, m.subject].join(' ').toLowerCase().includes(q)));
    $('#emailsRows').innerHTML = rows.length ? rows.map(m => `<tr class="click" data-mail="${m.id}"><td>${esc(fmtWhen(m.created_at))}</td><td>${esc(m.to_addr)}</td><td>${esc(m.subject)}</td><td>${m.status === 'sent' ? '<span class="badge green">Sent</span>' : '<span class="badge red">Failed</span>'}</td></tr>`).join('') : '<tr><td class="emptyrow" colspan="4">No emails yet.</td></tr>';
    $$('[data-mail]').forEach(r => r.onclick = () => { const m = mailState.emails.find(x => x.id === Number(r.dataset.mail)); openDrawer({ title: m.subject || '(no subject)', sub: `To ${esc(m.to_addr)} · ${esc(fmtWhen(m.created_at))} · via ${esc(m.provider || '')}`, body: `${m.error ? `<p class="msg err">${esc(m.error)}</p>` : ''}<pre style="white-space:pre-wrap;font:inherit">${esc(m.body || '')}</pre>`, footer: '' }); });
  }

  // ---------- Takeoffs ----------
  const toState = { takeoffs: [], methods: ['Measured', 'From schedule', 'Entered', 'Inferred'] };
  $('#takeoffsAdd').addEventListener('click', () => openTakeoff(null, null));
  const CATN = { construction: 'Construction cleaning', multifamily: 'Multifamily', janitorial: 'Commercial janitorial', specialty: 'Specialty' };
  async function loadTakeoffs() {
    const r = await api('/api/admin/takeoffs'); Object.assign(toState, r);
    $('#takeoffsRows').innerHTML = r.takeoffs.length ? r.takeoffs.map(t => `<tr class="click" data-to="${t.id}"><td><b>${esc(t.name)}</b><small>${esc(t.customer_company || t.customer_name || '')}</small></td><td>${esc(t.document_title || '—')}${t.document_revision ? ' · Rev ' + esc(t.document_revision) : ''}</td><td>${esc(CATN[t.category] || t.category)}</td><td class="num">${t.building_sf ? Number(t.building_sf).toLocaleString() : '—'}</td><td class="num">${t.lines.length}</td><td>${badge(t.status)}${t.estimate_id ? ` <button class="linklike" data-est="${t.estimate_id}">Estimate #${t.estimate_id}</button>` : ''}</td></tr>`).join('') : '<tr><td class="emptyrow" colspan="6">No takeoffs yet. Open Drawings & documents and click Takeoff on a drawing set.</td></tr>';
    $$('#takeoffsRows [data-to]').forEach(r => r.onclick = e => { if (e.target.closest('[data-est]')) return; openTakeoff(toState.takeoffs.find(t => t.id === Number(r.dataset.to)), null); });
    bindOpeners($('#takeoffsRows'));
  }
  async function openTakeoff(t, doc) {
    if (!scopeState.items.length) { try { Object.assign(scopeState, await api('/api/admin/scopes')); } catch { /* */ } }
    if (!state.customers || !state.customers.length) { try { state.customers = (await api('/api/admin/customers')).customers || []; } catch { state.customers = []; } }
    let lines = t ? t.lines.map(l => ({ ...l })) : [];
    const cur = t || { name: doc ? doc.title : '', category: 'construction', document_id: doc ? doc.id : null, customer_id: doc ? doc.customer_id : null, building_sf: '', questions: '' };
    const priced = cat => scopeState.items.filter(i => i.active && i.category === cat && !i.missing.length);
    openDrawer({ title: t ? t.name : 'New takeoff', sub: doc ? `From ${esc(doc.title)}${doc.revision ? ' · Rev ' + esc(doc.revision) : ''}` : (t && t.document_title ? 'From ' + esc(t.document_title) : 'Quantities with their source'),
      body: `<form id="toForm" class="grid" novalidate>
        <div class="f wide"><label for="to1">Name</label><input id="to1" name="name" value="${esc(cur.name || '')}"></div>
        <div class="f"><label for="to2">Category</label><select id="to2" name="category">${Object.entries(CATN).map(([k, v]) => `<option value="${k}"${k === cur.category ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
        <div class="f"><label for="to3">Customer</label><select id="to3" name="customer_id"><option value="">None</option>${state.customers.map(c => `<option value="${c.id}"${String(c.id) === String(cur.customer_id ?? '') ? ' selected' : ''}>${esc(c.company || c.name || c.email)}</option>`).join('')}</select></div>
        <div class="f"><label for="to4">Building square footage</label><input id="to4" name="building_sf" inputmode="decimal" value="${esc(cur.building_sf ?? '')}"><span class="hint">From the area schedule or code-plan sheet.</span></div>
        <div class="f"><label>&nbsp;</label><button type="button" class="btn ghost" id="toPhases">Add Clean #1–#3 at this SF</button></div>
        <div class="f wide"><label for="to5">Questions for the GC / missing information</label><textarea id="to5" name="questions" placeholder="e.g. Exterior glass quantity not on A-sheets; confirm whether basement is in scope">${esc(cur.questions || '')}</textarea></div>
      </form>
      <div class="formsection">Quantities</div><table class="tolines" id="toLines"></table><button type="button" class="btn ghost" id="toAddLine">Add quantity</button>
      <p class="hint">Every measured or scheduled quantity needs its source sheet (for example A1.1), so anyone can check it against the drawing.</p>
      <div class="totals" id="toTotal"></div><p class="msg" id="toMsg" role="status"></p>`,
      footer: `<button class="btn" id="toSave">Save takeoff</button><button class="btn ghost" id="toEst">Create estimate from takeoff</button>` });
    const f = $('#toForm');
    const draw = () => {
      const opts = priced(f.elements.category.value);
      $('#toLines').innerHTML = lines.length ? `<tr><th>Scope item</th><th>Qty</th><th>Sheet</th><th>Method</th><th></th></tr>` + lines.map((l, i) => `<tr><td><select data-k="scope_id" data-i="${i}"><option value="">Choose…</option>${opts.map(o => `<option value="${o.id}"${o.id === l.scope_id ? ' selected' : ''}>${esc(o.name)} (${money(o.unit_price)}/${esc(o.unit)})</option>`).join('')}</select></td><td><input data-k="quantity" data-i="${i}" inputmode="decimal" value="${esc(l.quantity ?? '')}"></td><td><input data-k="sheet" data-i="${i}" value="${esc(l.sheet || '')}" placeholder="A1.1"></td><td><select data-k="method" data-i="${i}">${toState.methods.map(m => `<option${m === l.method ? ' selected' : ''}>${m}</option>`).join('')}</select></td><td><button type="button" class="btn ghost" data-rm="${i}" aria-label="Remove">✕</button></td></tr>`).join('') : '<tr><td class="muted">No quantities yet.</td></tr>';
      $$('#toLines [data-k]').forEach(el => el.oninput = el.onchange = () => { const l = lines[Number(el.dataset.i)]; l[el.dataset.k] = el.dataset.k === 'scope_id' ? Number(el.value) : el.value; total(); });
      $$('#toLines [data-rm]').forEach(b => b.onclick = () => { lines.splice(Number(b.dataset.rm), 1); draw(); });
      total();
    };
    const total = () => { const sum = lines.reduce((t, l) => { const it = scopeState.items.find(i => i.id === l.scope_id); return t + (it ? Number(String(l.quantity).replace(/,/g, '')) * it.unit_price : 0) || t; }, 0); $('#toTotal').innerHTML = `<div class="row grand"><span>Priced from your price book (before tax, allowances and alternates)</span><b>${money(sum)}</b></div>`; };
    f.elements.category.onchange = () => { if (lines.length && !confirm('Changing the category clears the quantities. Continue?')) { f.elements.category.value = cur.category; return; } lines = []; cur.category = f.elements.category.value; draw(); };
    $('#toAddLine').onclick = () => { lines.push({ scope_id: null, quantity: '', sheet: '', method: 'From schedule' }); draw(); };
    $('#toPhases').onclick = () => {
      const sf = Number(String(f.elements.building_sf.value).replace(/,/g, ''));
      if (f.elements.category.value !== 'construction') return toast('Construction phases apply to the Construction category.', true);
      if (!(sf > 0)) return toast('Enter the building square footage first.', true);
      const ph = ['Clean #1', 'Clean #2', 'Clean #3'].map(p => priced('construction').find(i => i.name.startsWith(p)));
      if (ph.some(x => !x)) return toast('Import the price book first (Cleaning scopes → Import price book).', true);
      lines = lines.filter(l => !ph.some(p => p.id === l.scope_id)); ph.forEach(p => lines.push({ scope_id: p.id, quantity: sf, sheet: '', method: 'From schedule' })); draw();
    };
    const body = () => ({ ...formObj(f), document_id: cur.document_id, lines: lines.map(l => ({ ...l, quantity: String(l.quantity) })) });
    const fail = e => { $('#toMsg').className = 'msg err'; $('#toMsg').textContent = e.message; };
    const save = async () => { const r = t ? await api('/api/admin/takeoffs/' + t.id, { method: 'PATCH', json: body() }) : await api('/api/admin/takeoffs', { method: 'POST', json: body() }); t = r.takeoff; return t; };
    $('#toSave').onclick = async () => { try { await save(); toast('Takeoff saved'); closeDrawer(); go('takeoffs'); loadTakeoffs(); } catch (e) { fail(e); } };
    $('#toEst').onclick = async () => {
      try {
        if (!lines.length) throw new Error('Add at least one quantity first.');
        const saved = await save();
        const c = state.customers.find(x => String(x.id) === String(saved.customer_id)) || {};
        const est = await api('/api/admin/estimates', { method: 'POST', json: { customer_name: c.name || c.company || saved.name, company: c.company || '', email: c.email || '', project_name: saved.name, area_sqft: saved.building_sf || 0,
          scope: `${CATN[saved.category]} from takeoff #${saved.id}${saved.document_title ? ' (' + saved.document_title + ')' : ''}`, scope_category: saved.category, use_line_items: 1,
          line_items: saved.lines.map(l => ({ scope_id: l.scope_id, quantity: l.quantity })), notes: saved.questions ? 'Open questions from takeoff:\n' + saved.questions : '' } });
        await api('/api/admin/takeoffs/' + saved.id, { method: 'PATCH', json: { status: 'Estimated' } });
        await api('/api/admin/takeoffs/' + saved.id + '/link', { method: 'POST', json: { estimate_id: est.estimate.id } }).catch(() => {});
        toast(`Estimate #${est.estimate.id} created from the takeoff`); closeDrawer(); go('proposals'); openEstimate(est.estimate.id);
      } catch (e) { fail(e); }
    };
    draw();
  }

  // ---------- Reports ----------
  $('#repMonths').addEventListener('change', () => loadReports());
  $('#repCsv').addEventListener('click', () => downloadFile({ name: `bright-clean-report.csv`, url: '/api/admin/reports/export.csv?months=' + $('#repMonths').value }));
  const RQ = ['Which customers owe us money?', 'How much work is in the sales pipeline?', 'What are our top services?', 'Which proposals should we follow up on?', 'Show revenue and collections by month.'];
  $('#repAiChips').innerHTML = RQ.map(q => `<button type="button">${esc(q)}</button>`).join('');
  $$('#repAiChips button').forEach(b => b.onclick = () => { $('#repAiQ').value = b.textContent; $('#repAiGo').click(); });
  $('#repAiGo').addEventListener('click', async () => {
    const q = $('#repAiQ').value.trim(); if (!q) return toast('Type a question first.', true);
    const b = $('#repAiGo'); b.disabled = true; b.textContent = 'Reading your records…'; $('#repAiOut').textContent = '';
    try { const r = await api('/api/admin/ai/reports/ask', { method: 'POST', json: { question: q, months: $('#repMonths').value } }); $('#repAiOut').textContent = r.answer; }
    catch (e) { $('#repAiOut').textContent = e.message; }
    b.disabled = false; b.textContent = 'Ask';
  });
  async function loadReports() {
    const r = await api('/api/admin/reports?months=' + $('#repMonths').value);
    const sum = a => a.reduce((t, x) => t + Number(x.v || 0), 0);
    const ex = r.executive, cnt = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    kpiTiles('#repKpis', [{ label: 'Approved proposal value', value: money(ex.approved_proposals.value), sub: cnt(ex.approved_proposals.count, 'proposal') + ' · not revenue' }, { label: 'Signed contract value', value: money(ex.signed_contracts.value), sub: cnt(ex.signed_contracts.count, 'contract') + (ex.unsigned_contracts.count ? ` · ${ex.unsigned_contracts.count} unsigned` : '') }, { label: 'Invoiced', value: money(ex.invoiced.value), sub: cnt(ex.invoiced.count, 'invoice') }, { label: 'Cash collected', value: money(ex.collected.value), sub: cnt(ex.collected.count, 'payment') }]);
    kpiTiles('#repKpis3', [{ label: 'Win rate', value: r.win.rate == null ? '—' : r.win.rate + '%', sub: r.win.sample ? `${r.win.won} won of ${r.win.sample} decided${r.win.small_sample ? ' · small sample' : ''}` : 'no decided proposals yet', alert: r.win.small_sample && r.win.sample > 0 }, { label: 'Active / completed projects', value: `${ex.active_projects} / ${ex.completed_projects}` }, { label: 'Estimated gross profit', value: ex.est_gross_profit.value == null ? '—' : money(ex.est_gross_profit.value), sub: ex.est_gross_profit.of ? `estimate · costed ${ex.est_gross_profit.based_on} of ${ex.est_gross_profit.of}` : 'no approved proposals' }, { label: 'Actual gross profit', value: '—', sub: 'no job costs recorded yet' }]);
    $('#repKpis3 .kpi').title = r.win.definition;
    $('#repIssues').innerHTML = r.data_issues.map(x => `<li class="${esc(x.level)}">${esc(x.text)}${x.ids && x.kind === 'estimate' ? ' ' + x.ids.slice(0, 5).map(id => `<button class="linklike" data-est="${id}">#${id}</button>`).join(' ') : ''}</li>`).join('');
    bindOpeners($('#repIssues'));
    const mName = k => new Date(k + '-15').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    $('#repMonthsRows').innerHTML = r.months.slice().reverse().map((m, j) => { const i = r.months.length - 1 - j; return `<tr><td>${mName(m)}</td><td class="num">${r.calls[i].n}</td><td class="num">${r.leads[i].n}</td><td class="num">${r.sent[i].n}</td><td class="num">${r.won[i].n}</td><td class="num">${money(r.won[i].v)}</td><td class="num">${money(r.billed[i].v)}</td><td class="num">${money(r.collected[i].v)}</td><td class="num">${r.quality[i].n ? r.quality[i].v + '%' : '—'}</td></tr>`; }).join('');
    const rv = r.receivables, o = r.ops, au = r.automation;
    kpiTiles('#repKpis2', [{ label: 'Outstanding', value: money(rv.outstanding) }, { label: 'Overdue', value: money(rv.overdue), sub: `${rv.overdue_n || 0} invoice(s)`, alert: rv.overdue > 0 }, { label: 'Inspection average', value: o.inspections.avg == null ? '—' : o.inspections.avg + '%', sub: `${o.inspections.n || 0} inspections` }, { label: 'Calls', value: o.calls.n || 0, sub: `${o.calls.missed || 0} missed · ${o.calls.to_leads || 0} became leads` }]);
    const top = Math.max(1, ...r.flow.map(f => f.n));
    $('#repFlowRows').innerHTML = r.flow.map(f => `<tr><td>${esc(f.k)}</td><td class="num">${f.n}</td><td>${f.n ? `<div class="bar" style="width:${Math.max(4, Math.round(f.n / top * 100))}%"></div>` : ''}</td></tr>`).join('');
    const dl = rows => '<dl class="stat">' + rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') + '</dl>';
    $('#repOps').innerHTML = dl([['Active projects', o.projects_active], ['Completed projects', o.projects_completed], ['Visits done (period)', o.visits_done], ['Visits coming up', o.visits_upcoming], ['Inspections failed', o.inspections.failed || 0], ['Complaints (period)', `${o.complaints.n || 0} · ${o.complaints.resolved || 0} resolved`], ['Average days to resolve', o.complaints.days == null ? '—' : o.complaints.days], ['Open tasks', `${o.tasks_open} · ${o.tasks_overdue} overdue`]]);
    $('#repRecv').innerHTML = dl([['Billed (all time)', money(rv.billed)], ['Collected (all time)', money(rv.paid)], ['Outstanding', money(rv.outstanding)], ['Overdue', money(rv.overdue)]]);
    $('#repAuto').innerHTML = dl([['Leads analyzed by AI', au.ai_triaged], ['Questions emailed to customers', au.ai_info_requests], ['Estimates drafted automatically', au.auto_estimates], ['AI drawing takeoffs', au.ai_takeoffs], ['Proposal approvals', au.approvals], ['Reminders sent', au.reminders], ['Emails sent / failed', `${au.emails_sent} / ${au.emails_failed}`], ['AI errors', au.ai_failures]]);
    const SVN = { construction_final: 'Construction final clean', multifamily: 'Multifamily', janitorial: 'Commercial janitorial', windows: 'Window cleaning', power_washing: 'Power washing', parking: 'Parking lot', unit_turnover: 'Unit turnover', inquiry: 'Contact form', 'bid (no form)': 'Bid request (no form)' };
    $('#repLeadSvc').innerHTML = r.lead_services.length ? r.lead_services.map(x => `<tr><td>${esc(SVN[x.k] || x.k)}</td><td class="num">${x.n}</td><td class="num">${x.drafted || 0}</td></tr>`).join('') : '<tr><td class="emptyrow" colspan="3">No data yet.</td></tr>';
    const empty = c => `<tr><td class="emptyrow" colspan="${c}">No data yet.</td></tr>`;
    const svc = { construction: 'Construction cleaning', multifamily: 'Multifamily', janitorial: 'Commercial janitorial', specialty: 'Specialty', unspecified: 'Not categorized' };
    $('#repSvcRows').innerHTML = r.by_service.length ? r.by_service.map(x => `<tr><td>${esc(svc[x.k] || x.k)}</td><td class="num">${x.n}</td><td class="num">${money(x.avg)}</td><td class="num">${money(x.total)}</td></tr>`).join('') : empty(4);
    $('#repPipeRows').innerHTML = r.pipeline.length ? r.pipeline.map(x => `<tr><td>${badge(x.k)}</td><td class="num">${x.n}</td><td class="num">${money(x.v)}</td></tr>`).join('') : empty(3);
    $('#repTopRows').innerHTML = r.top_customers.length ? r.top_customers.map(x => `<tr><td>${esc(x.k || '—')}</td><td class="num">${x.n}</td><td class="num">${money(x.billed)}</td><td class="num">${money(x.paid)}</td></tr>`).join('') : empty(4);
  }

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
    $('#scopeNote').textContent = n ? `${n} of ${r.summary.total} active items have no price yet. Estimates can only use items that have a price.` : '';
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
  $('#scopeImport').addEventListener('click', async () => {
    if (!confirm('Load the Bright Clean price book (construction per-SF phases, hourly extra work, apartment units, hallways and add-ons)? Items you already priced keep your price.')) return;
    try { const r = await api('/api/admin/scopes/import-pricebook', { method: 'POST' }); toast(`Price book: ${r.created} added, ${r.filled} prices filled, ${r.kept} kept`); loadScopes(); }
    catch (err) { toast(err.message, true); }
  });
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
          <div class="f"><label for="sc5">Production rate (units per labor hour, optional)</label><input id="sc5" name="production_rate" inputmode="decimal" value="${v('production_rate')}" placeholder="Your rate"></div>
          <div class="f"><label for="sc6">Typical crew size (optional)</label><input id="sc6" name="crew_size" inputmode="decimal" value="${v('crew_size')}"></div>
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
