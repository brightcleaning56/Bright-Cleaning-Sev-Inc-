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
  const VIEWS = ['overview', 'leads', 'customers', 'proposals', 'estimator', 'contracts', 'projects', 'invoices', 'activity', 'settings'];
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
      if (view === 'activity') await loadActivity();
      if (view === 'settings') await loadUsers();
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
  async function loadOverview() {
    const d = await api('/api/admin/dashboard');
    $('#todayLine').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const lc = k => d.leads.find(x => x.kind === k) || { n: 0, fresh: 0, week: 0 };
    const stats = [
      { label: 'New bid requests', value: lc('bid').fresh || 0, to: 'leads', kind: 'bid' },
      { label: 'Proposals waiting on customer', value: d.awaitingResponse.length, to: 'proposals' },
      { label: 'Outstanding balance', value: money(d.finance.outstanding), to: 'invoices' },
      { label: 'Overdue invoices', value: d.overdueInvoices.length, to: 'invoices', alert: d.overdueInvoices.length > 0 }
    ];
    $('#ovStats').innerHTML = stats.map((s, i) => `<button class="stat${s.alert ? ' alert' : ''}" data-i="${i}"><span>${esc(s.label)}</span><b>${esc(s.value)}</b></button>`).join('');
    $$('#ovStats .stat').forEach(b => b.onclick = () => { const s = stats[b.dataset.i]; if (s.kind) state.leadKind = s.kind; go(s.to); });

    const list = (el, rows, render, empty) => {
      $(el).innerHTML = rows.length ? rows.map(render).join('') : `<li class="empty" style="cursor:default">${esc(empty)}</li>`;
    };
    list('#ovNew', d.newLeads, l => `<li data-lead="${l.id}"><span><b>${esc(l.contact_name || 'Unnamed')}</b><small>${esc(KIND_LABEL[l.kind] || l.kind)}${l.company ? ' · ' + esc(l.company) : ''}${l.project_name ? ' · ' + esc(l.project_name) : ''}</small></span><span class="r"><small>${esc(ago(l.created_at))}</small></span></li>`, 'No new leads. You’re caught up.');
    list('#ovAwait', d.awaitingResponse, e => `<li data-est="${e.id}"><span><b>${esc(e.customer_name)}</b><small>${esc(e.project_name || e.company || '')}</small></span><span class="r">${money(e.proposal_total)}<small>${esc(e.status)} ${esc(ago(e.updated_at))}</small></span></li>`, d.draftProposals ? `Nothing sent is waiting. ${d.draftProposals} draft proposal(s) not sent yet.` : 'Nothing waiting on a customer.');
    list('#ovDue', d.dueProjects, p => `<li data-rec="projects:${p.id}"><span><b>${esc(p.name || 'Project')}</b><small>${esc(p.company || p.customer_name || '')} · ${esc(p.status)} · ${Number(p.progress || 0)}%</small></span><span class="r">${p.due_date < todayISO() ? '<span class="badge red">Past due</span>' : ''}<small>Due ${fmtDate(p.due_date)}</small></span></li>`, 'No projects due in the next two weeks.');
    list('#ovOverdue', d.overdueInvoices, i => `<li data-rec="invoices:${i.id}"><span><b>${esc(i.invoice_number)}</b><small>${esc(i.company || i.customer_name || '')}</small></span><span class="r">${money(i.amount - i.paid_amount)}<small>Due ${fmtDate(i.due_date)}</small></span></li>`, 'No overdue invoices.');
    $('#ovRenewCard').hidden = !d.renewals.length;
    list('#ovRenew', d.renewals, c => `<li data-rec="contracts:${c.id}"><span><b>${esc(c.title || 'Contract')}</b><small>${esc(c.company || c.customer_name || '')}</small></span><span class="r"><small>Ends ${fmtDate(c.end_date)}</small></span></li>`, '');
    $('#ovActivity').innerHTML = renderActivity(d.activity) || '<p class="empty">No activity yet.</p>';
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
    openDrawer({
      title: l.contact_name || 'Lead #' + l.id,
      sub: `${KIND_LABEL[l.kind] || 'Lead'} #${l.id}${l.company ? ' · ' + l.company : ''}`,
      body: `
        <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${raw.has(k) ? v : esc(v)}</dd>`).join('')}</dl>
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
    const rows = state.customers.filter(c => !q || [c.company, c.name, c.email, c.phone].join(' ').toLowerCase().includes(q));
    $('#custRows').innerHTML = rows.length ? rows.map((c, i) => `<tr class="click" data-cust="${state.customers.indexOf(c)}"><td><b>${esc(c.company || c.name)}</b>${c.company && c.name ? `<small>${esc(c.name)}</small>` : ''}</td><td>${esc(c.email || '—')}<small>${esc(c.phone || '')}</small></td><td class="num">${c.leads.length}</td><td class="num">${c.proposals.length}</td><td class="num">${c.projects.length}</td><td class="num">${money(c.billed)}</td><td class="num">${c.billed - c.paid > 0 ? `<b>${money(c.billed - c.paid)}</b>` : money(0)}</td></tr>`).join('')
      : `<tr><td class="emptyrow" colspan="7">${q ? 'No customers match your search.' : 'Customers appear here automatically from leads, proposals, contracts, projects and invoices.'}</td></tr>`;
    $$('[data-cust]').forEach(r => r.onclick = () => openCustomer(state.customers[r.dataset.cust]));
  }
  function openCustomer(c) {
    const sec = (title, items, render) => items.length ? `<h3>${title} (${items.length})</h3><ul>${items.map(render).join('')}</ul>` : '';
    openDrawer({
      title: c.company || c.name,
      sub: [c.name, c.email, c.phone].filter(Boolean).join(' · '),
      body: `
        <div class="stats" style="grid-template-columns:repeat(3,1fr)"><div class="stat" style="cursor:default"><span>Billed</span><b>${money(c.billed)}</b></div><div class="stat" style="cursor:default"><span>Collected</span><b>${money(c.paid)}</b></div><div class="stat" style="cursor:default"><span>Open balance</span><b>${money(c.billed - c.paid)}</b></div></div>
        <div class="related">
          ${sec('Leads', c.leads, x => `<li><button class="linklike" data-lead="${x.id}">${esc(KIND_LABEL[x.kind] || 'Lead')} #${x.id}${x.project_name ? ' · ' + esc(x.project_name) : ''}</button> ${badge(x.status)} <small>${fmtDate(x.created_at)}</small></li>`)}
          ${sec('Proposals', c.proposals, x => `<li><button class="linklike" data-est="${x.id}">${esc(x.project_name || 'Proposal #' + x.id)}</button> ${money(x.proposal_total)} ${badge(x.status)}</li>`)}
          ${sec('Contracts', c.contracts, x => `<li><button class="linklike" data-rec="contracts:${x.id}">${esc(x.title || 'Contract #' + x.id)}</button> ${money(x.value)} ${badge(x.status)}</li>`)}
          ${sec('Projects', c.projects, x => `<li><button class="linklike" data-rec="projects:${x.id}">${esc(x.name || 'Project #' + x.id)}</button> ${badge(x.status)} ${Number(x.progress || 0)}%</li>`)}
          ${sec('Invoices', c.invoices, x => `<li><button class="linklike" data-rec="invoices:${x.id}">${esc(x.invoice_number)}</button> ${money(x.amount)} ${badge(invoiceState(x))}</li>`)}
        </div>`,
      footer: `${c.email ? `<a class="btn ghost" href="mailto:${esc(c.email)}">Email</a>` : ''}<button class="btn" id="cQuote">New estimate for this customer</button>`
    });
    bindOpeners($('#drawerRoot'));
    $('#cQuote').onclick = () => { closeDrawer(); openEstimator(null, { contact_name: c.name, company: c.company, email: c.email }); };
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
          ${e.lead_id ? `<dt>From lead</dt><dd><button class="linklike" data-lead="${e.lead_id}">Lead #${e.lead_id}</button></dd>` : ''}
        </dl>
        <div class="grid"><div class="f"><label for="es">Status</label><select id="es">${options(STATUS.estimates, e.status)}</select><span class="hint">Updates automatically when the customer views, approves or declines.</span></div></div>
        <div class="formsection">Scope</div><div class="pre">${esc(e.scope)}</div>
        ${items.length ? `<div class="formsection">Line items</div><table class="t"><tbody>${items.map(i => `<tr><td>${esc(i.description)}</td><td class="num">${money(i.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${e.terms ? `<div class="formsection">Terms</div><div class="pre">${esc(e.terms)}</div>` : ''}
        <div class="formsection">Customer link</div>
        <div class="f"><input readonly value="${esc(url)}" id="eUrl" aria-label="Customer proposal link"></div>`,
      footer: `
        <button class="btn" id="eSend"${e.email ? '' : ' disabled title="Add a customer email first"'}>Email to customer</button>
        <a class="btn ghost" href="${esc(url)}" target="_blank" rel="noopener">Open customer view</a>
        <button class="btn ghost" id="eCopy">Copy link</button>
        <button class="btn ghost" id="eEdit"${e.status === 'Approved' ? ' disabled title="Approved proposals are locked. Duplicate to change."' : ''}>Edit</button>
        <button class="btn ghost" id="eDup">Duplicate</button>
        <span class="grow"></span>
        <button class="btn danger" id="eDel"${e.status === 'Approved' ? ' disabled title="Approved proposals are kept for your records."' : ''}>Delete</button>`
    });
    bindOpeners($('#drawerRoot'));
    $('#es').onchange = async ev => {
      try { await api('/api/admin/estimates/' + e.id, { method: 'PATCH', json: { status: ev.target.value } }); toast('Status updated'); loadEstimates(); }
      catch (err) { toast(err.message, true); }
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
  const DEFAULTS = { area_sqft: 0, production_rate: 0, labor_hours: 0, labor_rate: 0, supplies_cost: 0, equipment_cost: 0, other_cost: 0, overhead_pct: 10, margin_pct: 25, tax_pct: 0 };

  function openEstimator(est, lead) {
    ef.reset();
    ef.elements.id.value = '';
    Object.entries(DEFAULTS).forEach(([k, v]) => { ef.elements[k].value = v; });
    const d = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    ef.elements.expires_on.value = d;
    if (lead) {
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
      ef.elements.line_items_text.value = (est.line_items || []).map(i => `${i.description} | ${i.amount}`).join('\n');
    }
    $('#estTitle').textContent = est ? `Edit estimate — ${est.project_name || est.customer_name}` : 'New estimate';
    $('#estSave').textContent = est ? 'Save changes' : 'Save estimate';
    $('#estMsg').textContent = '';
    calcEstimate();
    go('estimator');
  }
  async function editEstimate(id) {
    try { openEstimator((await api('/api/admin/estimates/' + id)).estimate); } catch (err) { toast(err.message, true); }
  }

  function parseLines(text) {
    return String(text || '').split('\n').map(s => s.trim()).filter(Boolean).map(line => {
      const i = line.lastIndexOf('|');
      const description = (i >= 0 ? line.slice(0, i) : line).trim();
      const amount = i >= 0 ? Number(line.slice(i + 1).replace(/[$,\s]/g, '')) || 0 : 0;
      return { description, amount };
    });
  }

  function calcEstimate() {
    const v = formObj(ef);
    const n = k => Math.max(0, Number(v[k] || 0));
    const hours = n('labor_hours') || (n('area_sqft') && n('production_rate') ? n('area_sqft') / n('production_rate') : 0);
    const direct = hours * n('labor_rate') + n('supplies_cost') + n('equipment_cost') + n('other_cost');
    const cost = direct * (1 + n('overhead_pct') / 100);
    const price = cost / (1 - Math.min(90, n('margin_pct')) / 100);
    const total = price * (1 + n('tax_pct') / 100);
    $('#cHours').textContent = hours.toFixed(2);
    $('#cCost').textContent = money(cost);
    $('#cProfit').textContent = money(price - cost);
    $('#cTotal').textContent = money(total);
    const items = parseLines(v.line_items_text);
    const sum = items.reduce((s, i) => s + i.amount, 0);
    const warn = [];
    if (n('area_sqft') && !n('production_rate') && !n('labor_hours')) warn.push('Enter a production rate or labor hours, or labor won’t be counted.');
    if (hours && !n('labor_rate')) warn.push('Labor hours are set but the labor cost per hour is 0.');
    if (items.length && Math.abs(sum - price) > 1 && Math.abs(sum - total) > 1) warn.push(`Line items add up to ${money(sum)}, but the proposal total is ${money(total)}. The customer will see both.`);
    if (n('margin_pct') > 90) warn.push('Gross margin is capped at 90%.');
    $('#cWarn').hidden = !warn.length;
    $('#cWarn').textContent = warn.join(' ');
  }
  ef.addEventListener('input', calcEstimate);

  ef.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#estMsg');
    const b = formObj(ef);
    if (!b.customer_name.trim() || !b.scope.trim()) { msg.className = 'msg err'; msg.textContent = 'Contact name and scope of work are required.'; return; }
    b.line_items = parseLines(b.line_items_text);
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
    return `<div class="f${o.wide ? ' wide' : ''}"><label for="${id}">${esc(label)}</label>${input}</div>`;
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
