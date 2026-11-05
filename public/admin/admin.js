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
  // Local calendar date of this device (Central time for the office), not UTC — UTC flips to tomorrow every evening.
  const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
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

  // Copy text without ever throwing: clipboard API when available, otherwise select the field so the user can press Ctrl+C.
  async function copyText(text, field, okMsg) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); toast(okMsg || 'Copied'); return true; } } catch { /* fall through */ }
    if (field && field.select) { field.focus(); field.select(); }
    toast('Press Ctrl+C (Cmd+C on Mac) to copy'); return false;
  }
  // ---- Phone: in-browser calling (Twilio Voice SDK) when an API key is set; otherwise ring-my-phone-first. ----
  let phoneCfg = null, device = null, activeCall = null, callTimer = null;
  const SDK = { src: 'https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.18.5/dist/twilio.min.js', sri: 'sha384-LUG7DmzDPWNKRYoqyGpV4d/IByMLiya/oUhMSc/4/6hi0wbzO/8PffM4lzeFEYS8' };
  const phonePanel = () => { let el = document.getElementById('phonePanel'); if (!el) { el = document.createElement('div'); el.id = 'phonePanel'; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Phone');
    el.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9999;background:#fff;border:1px solid #d6dee8;border-radius:14px;box-shadow:0 10px 30px rgba(15,38,66,.18);padding:12px 14px;min-width:230px;font:14px/1.4 inherit;display:none'; document.body.appendChild(el); } return el; };
  function showPanel(html) { const el = phonePanel(); el.innerHTML = html; el.style.display = html ? 'block' : 'none'; }
  const fmtNum = n => { const d = String(n || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (n || 'Unknown'); };
  function inCallUI(label) {
    const t0 = Date.now(); clearInterval(callTimer);
    showPanel(`<b>📞 ${esc(label)}</b><div id="phT" class="muted" style="margin:4px 0 10px">Connecting…</div><button class="btn small ghost" id="phMute">Mute</button> <button class="btn small" id="phEnd" style="background:#c0392b;border-color:#c0392b">Hang up</button>`);
    callTimer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000), el = document.getElementById('phT'); if (el && activeCall && activeCall.status && activeCall.status() === 'open') el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, 1000);
    document.getElementById('phEnd').onclick = () => activeCall && activeCall.disconnect();
    document.getElementById('phMute').onclick = ev => { if (!activeCall) return; const m = !activeCall.isMuted(); activeCall.mute(m); ev.target.textContent = m ? 'Unmute' : 'Mute'; };
  }
  function wireCall(call, label) {
    activeCall = call; inCallUI(label);
    call.on('accept', () => { const el = document.getElementById('phT'); if (el) el.textContent = '0:00'; });
    const done = () => { activeCall = null; clearInterval(callTimer); showPanel(''); if (state.view === 'calls' && typeof loadCalls === 'function') setTimeout(loadCalls, 2500); };
    call.on('disconnect', done); call.on('cancel', done); call.on('reject', done); call.on('error', e => { toast('Call error: ' + (e.message || e), true); done(); });
  }
  function loadSdk() { return new Promise((ok, bad) => { if (window.Twilio && window.Twilio.Device) return ok(); const sc = document.createElement('script'); sc.src = SDK.src; sc.integrity = SDK.sri; sc.crossOrigin = 'anonymous'; sc.onload = ok; sc.onerror = () => bad(new Error('Could not load the phone software')); document.head.appendChild(sc); }); }
  async function initPhone() {
    try { phoneCfg = await api('/api/admin/phone/settings'); } catch { return; }
    if (!phoneCfg.softphone) return;
    try {
      await loadSdk();
      const t = await api('/api/admin/voice/token');
      device = new window.Twilio.Device(t.token, { codecPreferences: ['opus', 'pcmu'], closeProtection: 'A call is in progress. Leave anyway?' });
      device.on('tokenWillExpire', async () => { try { device.updateToken((await api('/api/admin/voice/token')).token); } catch { /* retried next time */ } });
      device.on('incoming', call => {
        const from = call.parameters && call.parameters.From;
        showPanel(`<b>📞 Incoming call</b><div style="margin:4px 0 10px">${esc(fmtNum(from))}<div class="muted" id="phWho"></div></div><button class="btn small" id="phAns">Answer</button> <button class="btn small ghost" id="phDec">Decline</button>`);
        api('/api/admin/customers').then(r => { const d = String(from || '').replace(/\D/g, '').slice(-10), m = (r.customers || []).filter(c => String(c.phone || '').replace(/\D/g, '').slice(-10) === d); const w = document.getElementById('phWho'); if (w && m.length === 1) w.textContent = m[0].company || m[0].name; }).catch(() => {});
        document.getElementById('phAns').onclick = () => { call.accept(); wireCall(call, fmtNum(from)); };
        document.getElementById('phDec').onclick = () => { call.reject(); showPanel(''); };
        call.on('cancel', () => showPanel(''));
      });
      device.on('error', e => console.warn('phone:', e && e.message));
      await device.register();
      const chip = document.createElement('div'); chip.id = 'phoneChip'; chip.title = 'Browser phone is on: calls to ' + fmtNum(phoneCfg.number) + ' ring here too';
      chip.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9998;background:#1e8e3e;color:#fff;border-radius:999px;padding:6px 12px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,.15)'; chip.textContent = '📞 Phone on'; chip.style.cursor = 'pointer'; chip.title += ' — click to dial'; chip.onclick = () => openDialPad(); document.body.appendChild(chip);
    } catch (e) { console.warn('phone off:', e.message); device = null; }
  }
  // Any [data-dial] button: call from this computer when the browser phone is on; otherwise ring the user's phone first.
  document.addEventListener('click', ev => {
    const b = ev.target.closest && ev.target.closest('[data-dial]'); if (!b) return;
    ev.preventDefault(); ev.stopPropagation();
    b.disabled = true; setTimeout(() => { b.disabled = false; }, 4000);
    startDial(b.dataset);
  }, true);
  async function startDial(d) {
    const b = { dataset: d };
    try { phoneCfg = phoneCfg || await api('/api/admin/phone/settings'); } catch { phoneCfg = null; }
    if (!phoneCfg || !phoneCfg.can_dial) { toast('Calling is not set up yet (Settings → Phone).', true); return; }
    const name = b.dataset.name || b.dataset.dial;
    if (activeCall) { toast('Finish the current call first.', true); return; }
    if (device) {
      if (!confirm(`Call ${name} at ${b.dataset.dial} from this computer?\n\nThe customer sees ${phoneCfg.number}. The call is recorded and logged.`)) return;
      try { const r = await api('/api/admin/calls/browser-start', { method: 'POST', json: { to: b.dataset.dial, customer_id: b.dataset.cust || undefined, lead_id: b.dataset.lead || undefined, name: b.dataset.name || '' } });
        const call = await device.connect({ params: { To: r.to, call_id: String(r.call_id) } }); wireCall(call, name); }
      catch (e) { toast(e.message, true); }
      return;
    }
    if (!confirm(`Call ${name} at ${b.dataset.dial}?\n\nYour phone ending ${String(phoneCfg.ring_phone || '').slice(-4)} rings first — answer it and you'll be connected. Calls show ${phoneCfg.number} as the caller ID and are recorded.`)) return;
    try { const r = await api('/api/admin/calls/dial', { method: 'POST', json: { to: b.dataset.dial, customer_id: b.dataset.cust || undefined, lead_id: b.dataset.lead || undefined, name: b.dataset.name || '' } }); toast(r.message); }
    catch (e) { toast(e.message, true); }
  }
  // Dial pad: call any number (optionally matched to a customer as you type).
  async function openDialPad(prefill) {
    let custs = []; try { custs = (await api('/api/admin/customers')).customers || []; } catch { /* */ }
    const withPhone = custs.filter(c => c.phone);
    openDrawer({ title: 'Call a number', body: `<form id="dpForm" class="ig"><div class="wide"><label for="dpNum">Phone number</label><input id="dpNum" type="tel" inputmode="tel" autocomplete="off" placeholder="(515) 555-0123" value="${esc(prefill || '')}" required style="font-size:20px;letter-spacing:.5px"></div>
      <div class="wide"><label for="dpWho">Or pick a customer</label><input id="dpWho" list="dpList" placeholder="Start typing a name or company…"><datalist id="dpList">${withPhone.map(c => `<option value="${esc((c.company || c.name) + ' — ' + c.phone)}">`).join('')}</datalist></div>
      <div class="wide" id="dpKeys" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:280px">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '0', '⌫'].map(k => `<button type="button" class="btn ghost" data-k="${k}" style="font-size:18px;padding:12px 0">${k}</button>`).join('')}</div></form>`,
      footer: '<button class="btn ghost" data-close>Close</button><button class="btn" id="dpGo">📞 Call</button>' });
    const num = $('#dpNum'); num.focus();
    $$('#dpKeys [data-k]').forEach(k => k.onclick = () => { num.value = k.dataset.k === '⌫' ? num.value.slice(0, -1) : num.value + k.dataset.k; num.focus(); });
    $('#dpWho').oninput = ev => { const m = withPhone.find(c => (c.company || c.name) + ' — ' + c.phone === ev.target.value); if (m) { num.value = m.phone; num.dataset.cust = m.id; num.dataset.name = m.company || m.name; } };
    const go = () => { const v = num.value.trim(); if (String(v).replace(/\D/g, '').length < 10) { toast('Enter a 10-digit phone number.', true); return; } closeDrawer(); startDial({ dial: v, cust: num.dataset.cust || '', name: num.dataset.name || '' }); };
    $('#dpGo').onclick = go; $('#dpForm').onsubmit = ev => { ev.preventDefault(); go(); };
  }
  // Save an unknown caller as a customer (or link to an existing one).
  async function openSaveCaller(c) {
    let custs = []; try { custs = (await api('/api/admin/customers')).customers || []; } catch { /* */ }
    openDrawer({ title: 'Save caller as customer', body: `<p class="muted">Calls from <b>${esc(c.phone || '')}</b> will be linked to this customer — past calls and every future call.</p>
      <form id="scForm" class="ig"><div><label for="scName">Name *</label><input id="scName" value="${esc(c.contact_name || '')}" placeholder="Danielle Kelly"></div><div><label for="scCo">Company (if a business)</label><input id="scCo" value="${esc(c.company || '')}"></div>
      <div class="wide"><label for="scEm">Email (optional)</label><input id="scEm" type="email"></div><div class="wide"><label for="scNotes">Notes (optional)</label><textarea id="scNotes" rows="2" placeholder="e.g. residential, cleaning Monday"></textarea></div>
      <div class="wide"><label for="scExisting">…or link to an existing customer</label><select id="scExisting"><option value="">— Create a new customer —</option>${custs.map(x => `<option value="${x.id}">${esc((x.company || x.name || 'Customer #' + x.id) + (x.phone ? ' · ' + x.phone : ''))}</option>`).join('')}</select></div></form>`,
      footer: '<button class="btn ghost" data-close>Cancel</button><button class="btn" id="scGo">Save customer</button>' });
    $('#scGo').onclick = async () => {
      const ex = $('#scExisting').value, body = ex ? { customer_id: Number(ex) } : { name: $('#scName').value, company: $('#scCo').value, email: $('#scEm').value, notes: $('#scNotes').value };
      try { const r = await api(`/api/admin/calls/${c.id}/customer`, { method: 'POST', json: body }); const nm = r.customer.company || r.customer.name; toast(`${r.created ? 'Saved' : 'Linked to'} ${nm} — ${r.linked_calls} call${r.linked_calls === 1 ? '' : 's'} linked`); closeDrawer(); if (typeof loadCalls === 'function') loadCalls(); openCall({ ...c, customer_id: r.customer.id }); }
      catch (e) { toast(e.message, true); }
    };
  }
  setTimeout(() => { if (token) initPhone(); }, 1500);
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
    signature: ['Not sent', 'Sent', 'Viewed', 'Customer signed', 'Signed', 'Declined'],
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
  function signOut(message) { try { if (es) { es.close(); es = null; } } catch { /* */ }
    token = null;
    localStorage.removeItem(TOKEN_KEY);
    try { $('#tbName').textContent = '—'; $('#tbRole').textContent = ''; } catch { /* */ }
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
      loadPrefs().finally(() => { start(); setTimeout(connectLive, 800); setTimeout(() => { if (token) initPhone(); }, 1500); });
    } catch (err) { st.className = 'msg err'; st.textContent = err.message; }
  });
  $('#logout').addEventListener('click', () => signOut());

  async function start() {
    try {
      const me = await api('/api/admin/me'); state.me = me;
      $('#whoEmail').textContent = me.email || ''; loadTopbar();
      { const lbl = document.querySelector('#whoRole') || (() => { const x = document.createElement('small'); x.id = 'whoRole'; x.style.cssText = 'display:block;opacity:.75'; $('#whoEmail').after(x); return x; })(); lbl.textContent = [me.name, me.label].filter(Boolean).join(' · '); }
      if (Array.isArray(me.views)) { $$('#nav [data-view]').forEach(b => { b.hidden = !me.views.includes(b.dataset.view); }); if (!me.views.includes((location.hash || '').slice(1) || 'overview')) location.hash = '#' + (me.home || me.views[0]); }
    } catch { return; }
    $('#login').hidden = true;
    $('#app').hidden = false;
    go((location.hash || '#overview').slice(1).split('/')[0] || 'overview', true);
  }

  // ---------- Navigation ----------
  const VIEWS = ['website', 'overview', 'leads', 'customers', 'issues', 'calls', 'emails', 'proposals', 'estimator', 'contracts', 'projects', 'invoices', 'schedule', 'quality', 'documents', 'takeoffs', 'reports', 'scopes', 'activity', 'settings'];
  function go(view, replace) {
    if (view === 'customer') view = 'customers';
    if (!VIEWS.includes(view)) view = 'overview';
    if (state.me && Array.isArray(state.me.views) && !state.me.views.includes(view)) view = state.me.home || state.me.views[0];
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
      if (view === 'emails') await loadEmails();
      if (view === 'takeoffs') await loadTakeoffs();
      if (view === 'scopes') await loadScopes();
      if (view === 'website') await loadWebsite();
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
  $('#ccDays').addEventListener('change', () => { savePref('command_center', { ...(prefs.command_center || {}), days: $('#ccDays').value }); loadOverview(); });
  setInterval(() => { if (state.view === 'overview' && document.visibilityState === 'visible' && !document.querySelector('#drawerRoot .drawer')) loadOverview().catch(() => {}); }, 30000);
  // ---- Personal preferences (per user) ----
  let prefs = {};
  async function loadPrefs() { try { prefs = await api('/api/admin/prefs'); } catch { prefs = {}; } }
  async function savePref(key, value) { prefs[key] = value; try { await api('/api/admin/prefs/' + key, { method: 'PUT', json: value }); } catch (e) { toast('Could not save your view: ' + e.message, true); } }
  // ---- Live updates: the server pushes "something changed"; the open screen reloads from the API ----
  let es = null, esTimer = null, esBackoff = 2000, liveOn = false, pending = new Set();
  function setLiveBadge(on) { liveOn = on; const b = document.querySelector('#todayLine .live'); if (b) { b.textContent = on ? 'Live' : 'Offline — retrying'; b.style.opacity = on ? '1' : '.6'; b.title = on ? 'Updates appear within seconds' : 'Live updates paused; data still refreshes every minute'; } }
  async function connectLive() {
    if (!token || es) return;
    try { const { ticket } = await api('/api/admin/events/ticket', { method: 'POST', json: {} }); es = new EventSource('/api/admin/events?ticket=' + ticket); }
    catch { return setTimeout(connectLive, esBackoff = Math.min(esBackoff * 2, 60000)); }
    es.addEventListener('hello', () => { esBackoff = 2000; setLiveBadge(true); });
    es.addEventListener('change', ev => { try { JSON.parse(ev.data).forEach(e => pending.add(e.entity)); } catch { /* */ } clearTimeout(esTimer); esTimer = setTimeout(applyLive, 1200); });
    es.onerror = () => { setLiveBadge(false); try { es.close(); } catch { /* */ } es = null; setTimeout(connectLive, esBackoff = Math.min(esBackoff * 2, 60000)); };
  }
  function applyLive() {
    const ents = [...pending]; pending.clear();
    if ($('#drawerRoot') && $('#drawerRoot').children.length) { ents.forEach(e => pending.add(e)); esTimer = setTimeout(applyLive, 4000); return; } // never refresh under an open panel
    const v = state.view;
    if (v === 'overview') loadOverview().catch(() => {});
    else if (v === 'calls' && ents.some(e => /call/.test(e))) loadCalls().catch(() => {});
    else if (v === 'leads' && ents.some(e => /lead/.test(e))) loadLeads().catch(() => {});
  }
  // ---- Live operations: every number opens the exact records behind it ----
  let liveTimer = null, liveData = null;
  const OPEN_BY = { lead: id => openLead(id), estimate: id => openEstimate(id), contract: id => openContract(id), invoice: id => openRecord('invoices', id), project: id => openProject(id), call: id => openCall({ id }),
    issue: async id => { try { const r = await api('/api/admin/issues/' + id); openIssue(r.item || r.issue || r); } catch (e) { toast(e.message, true); } }, complaint: id => openComplaint(id) };
  async function loadLive() {
    const el = $('#ccLive'); if (!el) return;
    try {
      const d = liveData = await api('/api/admin/command-center/metrics?days=' + $('#ccDays').value);
      const hidden = (prefs.command_center && prefs.command_center.hidden) || [], groups = ['Quality', 'Sales', 'Operations', 'Finance', 'Calls & AI', 'Management'].filter(g => !hidden.includes(g));
      el.innerHTML = `<div class="sechead" style="display:flex;justify-content:space-between;align-items:baseline;margin:18px 0 8px"><h2 style="margin:0">Live operations</h2><small class="muted">Click any line to see the exact records · updated ${esc(new Date(d.as_of).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))} · <a href="#" id="liveRefresh">Refresh</a> · <a href="#" id="liveCustom">Customize</a>${hidden.length ? ` <span class="muted">(${hidden.length} hidden)</span>` : ''}</small></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;align-items:start">${groups.map(g => `<div class="card" style="padding:12px 14px"><h3 class="secth" style="margin:0 0 6px">${esc(g)}</h3>${d.metrics.filter(m => m.group === g).map(m => m.error
          ? `<div class="muted" style="font-size:13px;padding:6px 0" title="${esc(m.error)}">${esc(m.label)}: unavailable</div>`
          : `<button type="button" class="liverow" data-drill="${m.key}" style="display:flex;width:100%;justify-content:space-between;align-items:center;gap:8px;padding:7px 4px;border:0;border-bottom:1px solid #eef2f6;background:none;cursor:pointer;text-align:left;font:inherit;color:inherit">
              <span>${esc(m.label)}</span><span style="white-space:nowrap"><b style="color:${m.alert ? '#c0392b' : 'inherit'}">${m.count}</b>${m.amount != null && m.count ? ` <small class="muted">${money(m.amount)}</small>` : ''} ›</span></button>`).join('')}</div>`).join('')}</div>`;
      if (!hidden.includes('Finance')) { try { const dv = await api('/api/admin/command-center/divisions?days=' + $('#ccDays').value); const tot = dv.rows.reduce((t, r) => t + r.collected, 0);
        const box = document.createElement('div'); box.className = 'card'; box.style.cssText = 'padding:12px 14px;margin-top:12px';
        box.innerHTML = `<h3 class="secth" style="margin:0 0 6px">Collected by service (period)</h3>${dv.rows.length ? dv.rows.map(r => `<button type="button" class="liverow" data-svc="${esc(r.service)}" style="display:block;width:100%;border:0;background:none;cursor:pointer;text-align:left;font:inherit;color:inherit;padding:5px 0"><span style="display:flex;justify-content:space-between"><span>${esc(r.service)}</span><b>${money(r.collected)} ›</b></span><span style="display:block;height:6px;background:#e6edf5;border-radius:4px;margin-top:3px"><span style="display:block;height:6px;border-radius:4px;background:#2563eb;width:${tot ? Math.max(2, Math.round(r.collected / tot * 100)) : 0}%"></span></span></button>`).join('') : '<p class="muted" style="margin:0">No payments recorded in this period. Record payments on invoices to see collections by service.</p>'}`;
        $('#ccLive').appendChild(box); $$('#ccLive [data-svc]').forEach(b => b.onclick = () => openDrill('collected', { service: b.dataset.svc })); } catch { /* optional panel */ } }
      try { const ap = await api('/api/admin/autopilot/activity'); const ic = { done: '✅', needs_approval: '⏳', blocked: '⚠️', failed: '❌' };
        const row = x => `<button type="button" class="liverow" data-cmpo="${x.ref_id}" title="${esc(x.step)}" style="display:block;width:100%;text-align:left;border:0;border-bottom:1px solid #eef2f6;background:none;padding:5px 2px;cursor:pointer;font:inherit;font-size:13px;color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ic[x.status] || '•'} <b>${esc(x.ref_number || '')}</b> ${esc(x.step)} <small class="muted">· ${esc(fmtWhen(x.created_at))}</small></button>`;
        const ab = document.createElement('div'); ab.className = 'card'; ab.style.cssText = 'padding:12px 14px;margin-top:12px';
        ab.innerHTML = `<h3 class="secth" style="margin:0 0 6px">Autopilot activity</h3><small class="muted">What the system detected, decided and did — and what is waiting on a person.</small>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:8px;align-items:start">${[['Awaiting your decision', ap.awaiting, 'Nothing waiting.'], ['Exceptions', ap.exceptions, 'None.'], ['Recent actions', ap.recent, 'No activity yet.']].map(([t, list, empty], k) => `<div><b>${t}${k < 2 ? ` (${list.length})` : ''}</b>${list.slice(0, 3).map(row).join('') || `<p class="muted">${empty}</p>`}${list.length > 3 ? `<details><summary class="muted" style="cursor:pointer;font-size:13px;margin-top:4px">Show all ${list.length}</summary>${list.slice(3).map(row).join('')}</details>` : ''}</div>`).join('')}</div>`;
        $('#ccLive').appendChild(ab); $$('#ccLive [data-cmpo]').forEach(b => b.onclick = () => { go('quality'); setTimeout(() => openComplaint(Number(b.dataset.cmpo)), 350); });
      } catch { /* optional panel */ }
      $$('#ccLive [data-drill]').forEach(b => b.onclick = () => openDrill(b.dataset.drill));
      $('#liveRefresh').onclick = ev => { ev.preventDefault(); loadLive(); };
      $('#liveCustom').onclick = ev => { ev.preventDefault(); const all = ['Quality', 'Sales', 'Operations', 'Finance', 'Calls & AI', 'Management'];
        openDrawer({ title: 'Customize Live operations', sub: 'Only changes what you see. Business records are not affected.', body: `<p class="muted">Show these groups:</p>${all.map(g => `<label class="chk" style="display:block;margin:6px 0"><input type="checkbox" data-g="${esc(g)}"${hidden.includes(g) ? '' : ' checked'}> ${esc(g)}</label>`).join('')}`,
          footer: '<button class="btn ghost" data-close>Cancel</button><button class="btn" id="custSave">Save</button>' });
        $('#custSave').onclick = async () => { const h = $$('#drawerRoot [data-g]').filter(x => !x.checked).map(x => x.dataset.g); await savePref('command_center', { ...(prefs.command_center || {}), hidden: h }); closeDrawer(); loadLive(); }; };
    } catch (e) { el.innerHTML = `<p class="msg err">Live operations could not load: ${esc(e.message)} <a href="#" id="liveRetry">Retry</a></p>`; const r = $('#liveRetry'); if (r) r.onclick = ev => { ev.preventDefault(); loadLive(); }; }
    clearTimeout(liveTimer); liveTimer = setTimeout(() => { if (state.view === 'overview' && !document.hidden) loadLive(); }, 60000);
  }
  async function openDrill(key, extra) {
    let d; try { d = await api(`/api/admin/command-center/drill/${key}?days=${$('#ccDays').value}${extra && extra.service ? '&service=' + encodeURIComponent(extra.service) : ''}`); } catch (e) { return toast(e.message, true); }
    const per = d.days === 1 ? 'today' : `last ${d.days} days`;
    openDrawer({ title: `${d.label} (${d.count})`, sub: `${d.group}${d.amount != null ? ' · total ' + money(d.amount) : ''} · period: ${per} · as of ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
      body: d.rows.length ? `<div>${d.rows.map(r => `<button type="button" class="liverow" data-open="${r.id}" style="display:flex;width:100%;justify-content:space-between;gap:10px;padding:10px 4px;border:0;border-bottom:1px solid #eef2f6;background:none;cursor:pointer;text-align:left;font:inherit;color:inherit">
          <span style="min-width:0"><b>${esc(r.title || '—')}</b><br><small class="muted">${esc(r.sub || '')}</small></span><span style="white-space:nowrap;text-align:right">${r.amount != null ? `<b>${money(r.amount)}</b><br>` : ''}<small class="muted">${esc(String(r.date || '').slice(0, 10))}</small></span></button>`).join('')}${d.count > d.rows.length ? `<p class="muted">Showing the latest ${d.rows.length} of ${d.count}.</p>` : ''}</div>`
        : `<p class="muted">Nothing here right now${d.view ? ` — <a href="#" id="drillGo">open ${esc(d.view)}</a>` : ''}.</p>`,
      footer: `<button class="btn ghost" data-close>Close</button>${d.view ? `<button class="btn ghost" id="drillPage">Open ${esc(d.view)} page</button>` : ''}` });
    $$('#drawerRoot [data-open]').forEach(b => b.onclick = async () => { const id = Number(b.dataset.open); closeDrawer(); go(d.view); if (d.open && OPEN_BY[d.open]) { await new Promise(r => setTimeout(r, 350)); OPEN_BY[d.open](id); } });
    if ($('#drillPage')) $('#drillPage').onclick = () => { closeDrawer(); go(d.view); };
    if ($('#drillGo')) $('#drillGo').onclick = ev => { ev.preventDefault(); closeDrawer(); go(d.view); };
  }
  async function openAttention() {
    const d = liveData || await api('/api/admin/command-center/metrics?days=' + $('#ccDays').value).catch(() => null); if (!d) return;
    const items = d.metrics.filter(m => m.alert);
    openDrawer({ title: `Needs attention (${items.reduce((s, m) => s + m.count, 0)})`, sub: 'Each line opens the exact records',
      body: items.length ? items.map(m => `<button type="button" class="liverow" data-drill="${m.key}" style="display:flex;width:100%;justify-content:space-between;padding:10px 4px;border:0;border-bottom:1px solid #eef2f6;background:none;cursor:pointer;font:inherit;color:inherit"><span>${esc(m.group)} · ${esc(m.label)}</span><b style="color:#c0392b">${m.count} ›</b></button>`).join('') : '<p class="muted">Nothing needs attention right now.</p>',
      footer: '<button class="btn ghost" data-close>Close</button>' });
    $$('#drawerRoot [data-drill]').forEach(b => b.onclick = () => openDrill(b.dataset.drill));
  }
  async function loadOverview() {
    if (state.me && state.me.sees_money === false) { // supervisors: live operations only (no revenue, proposals or collections)
      $$('#v-overview > *').forEach(el => { el.hidden = !(el.classList.contains('pagehead') || el.contains($('#ccLive')) || el.id === 'ccLive'); });
      $('#todayLine').innerHTML = esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) + ' · <span class="live">Live</span>';
      return loadLive();
    }
    const [d, cc] = await Promise.all([api('/api/admin/dashboard'), api('/api/admin/command-center?days=' + $('#ccDays').value)]);
    $('#todayLine').innerHTML = esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) + ` · <span class="live">Live</span> <small class="muted">updated ${esc(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</small>`;
    const k = cc.kpis, per = `last ${cc.days} days`;
    const att = k.attention.parts;
    const tiles = [
      { label: 'New leads', sub: per, value: k.new_leads.value, change: k.new_leads.change, icon: 'leads', c: '#1f6fd1', to: 'leads', drill: 'new_leads' },
      { label: 'Proposals sent', sub: per, value: k.proposals_sent.value, change: k.proposals_sent.change, icon: 'doc', c: '#2f80ed', to: 'proposals' },
      { label: 'Won', sub: k.won.amount ? money(k.won.amount) : per, value: k.won.value, change: k.won.change, icon: 'check', c: '#1f9d55', to: 'proposals' },
      { label: 'Collected this month', value: money(k.collected_month.value), icon: 'dollar', c: '#178a4c', to: 'invoices' },
      { label: 'Active projects', value: k.active_projects.value, icon: 'cal', c: '#2563eb', to: 'projects' },
      { label: 'Needs attention', value: k.attention.value, icon: 'alert', c: '#d64545', to: att.awaiting_approval ? 'proposals' : (att.open_complaints || att.overdue_tasks) ? 'issues' : att.overdue_invoices ? 'invoices' : att.late_projects ? 'projects' : 'leads', alert: k.attention.value > 0,
        title: `Proposals awaiting approval ${att.awaiting_approval} · open complaints ${att.open_complaints} · overdue tasks ${att.overdue_tasks} · overdue invoices ${att.overdue_invoices} · late projects ${att.late_projects} · leads waiting 2+ days ${att.leads_waiting_2_days} · failed emails (7 days) ${att.failed_emails_7_days}` }
    ];
    $('#ccKpis').innerHTML = tiles.map((t, i) => `<button class="kpi${t.alert ? ' alert' : ''}" data-i="${i}"${t.title ? ` title="${esc(t.title)}"` : ''}><span class="ic" style="background:${t.c}">${svg(t.icon)}</span><span style="min-width:0"><span>${esc(t.label)}</span><b>${esc(t.value)}</b>${'change' in t ? chg(t.change) : `<small class="flat">${esc(t.sub || (t.alert ? 'see details' : ''))}</small>`}</span></button>`).join('');
    $$('#ccKpis .kpi').forEach(b => b.onclick = () => { const t = tiles[b.dataset.i]; if (t.label === 'Needs attention') return openAttention(); if (t.drill) return openDrill(t.drill); go(t.to); });
    loadLive();
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
    { const L = state.leads.filter(l => (l.kind || 'bid') === 'bid'), now = Date.now(), wk = L.filter(l => now - Date.parse(l.created_at) < 7 * 864e5).length, mo = L.filter(l => String(l.created_at).slice(0, 7) === todayISO().slice(0, 7)).length;
      const won = L.filter(l => l.status === 'Won').length, lost = L.filter(l => l.status === 'Lost').length, open = L.filter(l => !['Won', 'Lost', 'Archived'].includes(l.status)).length;
      const inq = state.leads.filter(l => l.kind === 'inquiry' && l.status === 'New').length, jobs = state.leads.filter(l => l.kind === 'career' && l.status === 'New').length;
      if ($('#leadKpis')) $('#leadKpis').innerHTML = [kt('leads', 'blue', 'New bid requests', L.filter(l => l.status === 'New').length, `${wk} this week`), kt('overview', 'navy', 'Open pipeline', open, `${mo} received this month`), kt('check', 'green', 'Won', won, ''), kt('issues', 'red', 'Lost', lost, ''),
        kt('reports', 'teal', 'Win rate', won + lost ? Math.round(won / (won + lost) * 100) + '%' : '—', won + lost ? `${won} of ${won + lost} decided` : 'no decisions yet'), kt('emails', 'amber', 'Messages & applicants', inq + jobs, `${inq} messages · ${jobs} applicants`)].join('');
      const stages = ['New', 'In Review', 'Site Walkthrough', 'Proposal in Progress', 'Proposal Sent', 'Won', 'Lost'];
      if ($('#leadPipe')) { $('#leadPipe').innerHTML = stages.map(st => `<button type="button" data-pipe="${esc(st)}" class="${leadStatusSel.value === st && state.leadKind === 'bid' ? 'on' : ''}"><span>${esc(st)}</span><b>${L.filter(l => l.status === st).length}</b></button>`).join('');
        $$('#leadPipe [data-pipe]').forEach(b => b.onclick = () => { state.leadKind = 'bid'; leadStatusSel.value = leadStatusSel.value === b.dataset.pipe ? 'open' : b.dataset.pipe; renderLeads(); }); } }
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

  // Flag email addresses the email provider refused (bounced / spam complaint / suppressed).
  function markBounced() { const spans = $$('#drawerRoot [data-bounce]'); if (!spans.length) return; api('/api/admin/email-undeliverable').then(r => { const bad = new Map((r.addresses || []).map(a => [a.address, a])); spans.forEach(sp => { const a = bad.get(sp.dataset.bounce); if (a) { sp.innerHTML = '<span class="pill" style="background:#c0392b;color:#fff" title="' + esc(a.reason || '') + '">⚠ Email bounced — check the spelling</span>'; } }); }).catch(() => {}); }
  async function openLead(id) {
    let l;
    try { l = (await api('/api/admin/leads/' + id)).lead; } catch (err) { return toast(err.message, true); }
    const facts = [
      ['Type', KIND_LABEL[l.kind] || l.kind], ['Received', fmtWhen(l.created_at)], ['Contact', l.contact_name], ['Company', l.company],
      ['Email', l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a> <span data-bounce="${esc(String(l.email).toLowerCase())}"></span>` : ''], ['Phone', l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` + ` <button type="button" class="btn small ghost" data-dial="${esc(l.phone)}" data-lead="${l.id}" data-name="${esc(l.company || l.contact_name || '')}">📞 Call</button>` : ''],
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
    markBounced();
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
    if (cp.id && !state.customers.some(c => c.id === cp.id)) cp.id = null;
    if (!cp.id && state.customers.length && innerWidth > 1100) cp.id = state.customers[0].id;
    renderCustomers();
    if (cp.id) await loadCustomerPage();
  }
  $('#custStatus').addEventListener('change', () => renderCustomers());
  $('#custSort').addEventListener('change', () => renderCustomers());
  function renderCustomers() {
    const q = $('#custSearch').value.trim().toLowerCase(), st = $('#custStatus').value, so = $('#custSort').value;
    let rows = state.customers.filter(c => (!q || [c.company, c.name, c.email, c.phone, c.notes].join(' ').toLowerCase().includes(q)) && (!st || (c.status || 'Active') === st));
    rows = rows.slice().sort((a, b) => so === 'name' ? String(a.company || a.name).localeCompare(String(b.company || b.name)) : so === 'balance' ? ((b.billed || 0) - (b.paid || 0)) - ((a.billed || 0) - (a.paid || 0)) : String(b.updated_at).localeCompare(String(a.updated_at)));
    $('#custCount').textContent = `${rows.length} of ${state.customers.length}`;
    const tone = s => ({ Active: 'green', Prospect: 'amber', Inactive: 'navy' }[s] || 'navy');
    $('#custRows').innerHTML = rows.length ? rows.map(c => `<button type="button" role="listitem" class="crow${c.id === cp.id ? ' on' : ''}" data-cust="${c.id}"><span class="chip ${tone(c.status || 'Active')}">${ic('customers')}</span><span style="min-width:0"><b>${esc(c.company || c.name || c.email)}</b><small>${esc(c.company && c.name ? c.name : c.email || '')}</small></span>${badge(c.status || 'Active')}<span class="chev">${ic('chev')}</span></button>`).join('')
      : `<p class="empty">${q || st ? 'No customers match.' : 'Customers are added automatically from bid requests, inquiries and estimates, or click “New customer”.'}</p>`;
    $$('#custRows [data-cust]').forEach(r => r.onclick = () => openCustomerPage(Number(r.dataset.cust)));
  }
  $('#custAdd').addEventListener('click', () => openCustomer(null));
  // ---------- Customer profile page (full CRM workspace) ----------
  const cp = { id: Number(sessionStorage.getItem('bc_cust')) || null, tab: 'overview', d: null };
  function openCustomerPage(id) { cp.id = id; cp.tab = 'overview'; sessionStorage.setItem('bc_cust', id); if (state.view !== 'customers') go('customers'); else { renderCustomers(); loadCustomerPage(); } }
  async function loadCustomerPage() {
    if (!cp.id) return;
    try { cp.d = await api(`/api/admin/customers/${cp.id}/profile`); } catch (e) { $('#custPage').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
    renderCustomerPage();
  }
  const TABS = [['overview', 'Overview'], ['contacts', 'Contacts'], ['properties', 'Properties'], ['notes', 'Notes'], ['calls', 'Calls'], ['emails', 'Emails'], ['issues', 'Issues'], ['estimates', 'Estimates'], ['proposals', 'Proposals'], ['contracts', 'Contracts'], ['projects', 'Projects'], ['invoices', 'Invoices'], ['documents', 'Documents'], ['activity', 'Activity']];
  function renderCustomerPage() {
    const d = cp.d, c = d.customer, f = d.financials, pc = d.contacts.find(x => x.is_primary) || d.contacts[0] || {};
    const cnt = { contacts: d.contacts.length, properties: d.properties.length, notes: d.notes.length, calls: d.calls.length, emails: d.emails.length, issues: d.issues.length, estimates: d.estimates.length, proposals: d.proposals.length, contracts: d.contracts.length, projects: d.projects.length, invoices: d.invoices.length, documents: d.documents.length };
    const TI = { overview: 'overview', contacts: 'user', properties: 'customers', notes: 'note', calls: 'calls', emails: 'emails', issues: 'issues', estimates: 'proposals', proposals: 'proposals', contracts: 'contracts', projects: 'projects', invoices: 'invoices', documents: 'documents', activity: 'activity' };
    $('#custPage').innerHTML = `
      <div class="card cphero"><div class="bimg">${ic('customers')}</div>
        <div style="min-width:0;flex:1"><h1>${esc(c.company || c.name || c.email)} ${badge((c.status || 'Active') + ' customer')}</h1><div class="sub">${esc([c.customer_type, c.industry].filter(Boolean).join(' · ') || 'Commercial cleaning customer')}</div>
          <div class="cpmeta2"><div><span class="chip blue">${ic('user')}</span><div><span>Primary contact</span><b>${esc(pc.name || '—')}</b></div></div><div><span class="chip blue">${ic('calls')}</span><div><span>Phone</span><b>${pc.phone || c.phone ? `<a href="tel:${esc(pc.phone || c.phone)}">${esc(pc.phone || c.phone)}</a> <button type="button" class="btn small ghost" data-dial="${esc(pc.phone || c.phone)}" data-cust="${c.id}" data-name="${esc(pc.name || c.company || c.name || '')}">📞 Call</button>` : '—'}</b></div></div><div><span class="chip blue">${ic('emails')}</span><div><span>Email</span><b>${esc(pc.email || c.email || '—')}</b></div></div><div><span class="chip blue">${ic('pin')}</span><div><span>Address</span><b>${esc(c.address || '—')}</b></div></div><div><span class="chip blue">${ic('cal')}</span><div><span>Customer since</span><b>${fmtDate(c.created_at)}</b></div></div></div></div>
        <div class="cpbtns"><button class="btn" id="cpActBtn" aria-haspopup="true" aria-expanded="false">${ic('gear')} Actions ▾</button><button class="btn ghost" data-a="edit">${ic('edit')} Edit customer</button>
          <div class="menu" id="cpMenu" hidden><button data-a="note">${ic('note')} New note</button><button data-a="call">${ic('calls')} Log call</button><button data-a="email">${ic('emails')} Send email</button><button data-a="estimate">${ic('proposals')} Create estimate</button><button data-a="proposal">${ic('send')} Create proposal</button><button data-a="issue">${ic('issues')} Create issue</button>${d.role === 'owner' ? `<button data-a="remove" class="danger">${ic('trash')} Remove customer</button>` : ''}</div></div></div>
      <div class="fin2">${kt('proposals', 'purple', 'Estimates', money(f.estimates.value), `${f.estimates.count} draft`)}${kt('proposals', 'blue', 'Proposals', money(f.proposals_out.value), `${f.proposals_out.count} awaiting reply`)}${kt('check', 'green', 'Approved proposals', money(f.approved.value), `${f.approved.count} · not revenue`)}${kt('contracts', 'purple', 'Contract value', money(f.contracts_signed.value), `${f.contracts_signed.count} signed${f.contracts_unsigned.count ? ` · ${f.contracts_unsigned.count} unsigned` : ''}`)}${kt('invoices', 'blue', 'Invoiced', money(f.invoiced.value), `${f.invoiced.count} invoices`)}${kt('money', 'teal', 'Collected', money(f.collected.value), `${f.collected.count} payments`)}${kt('clock', 'red', 'Outstanding', money(f.outstanding.value), `${f.outstanding.count} open`)}</div>
      <div class="ctabs2 ctabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" data-t="${k}" class="${cp.tab === k ? 'on' : ''}" aria-selected="${cp.tab === k}">${ic(TI[k])}<span>${l}${cnt[k] != null ? ` (${cnt[k]})` : ''}</span></button>`).join('')}</div>
      <div id="cpBody"></div>`;
    $('#cpActBtn').onclick = e => { e.stopPropagation(); const m = $('#cpMenu'); m.hidden = !m.hidden; $('#cpActBtn').setAttribute('aria-expanded', String(!m.hidden)); };
    document.addEventListener('click', () => { const m = $('#cpMenu'); if (m) m.hidden = true; }, { once: true });
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
      const ACT = { call: ['calls', 'blue'], email: ['emails', 'teal'], note: ['note', 'amber'] };
      B.innerHTML = `<div class="ov3"><div>
          <div class="card"><h2>${ic('user')} Customer details</h2><dl class="stat">${[['Company', c.company], ['Customer type', c.customer_type], ['Status', c.status], ['Industry', c.industry], ['Account owner', c.account_owner], ['Source', c.source], ['Tax ID / EIN', c.tax_id]].map(([k, v]) => `<dt>${k}</dt><dd>${k === 'Status' ? badge(v || 'Active') : esc(v == null || v === '' ? '—' : v)}</dd>`).join('')}</dl></div>
          <div class="card"><h2>${ic('pin')} Service areas / properties (${d.properties.length}) <button class="linklike more" data-gotab="properties">+ Add property</button></h2>${d.properties.length ? '<ul class="prop">' + d.properties.slice(0, 4).map(p => `<li><span class="chip navy">${ic('customers')}</span><span style="min-width:0;flex:1"><b>${esc(p.name)}</b><small class="muted" style="display:block">${esc(p.address || '')}</small></span>${badge(p.status)}</li>`).join('') + '</ul>' : '<p class="empty">No properties yet.</p>'}</div></div>
        <div><div class="card"><h2>${ic('activity')} Recent activity <button class="linklike more" data-gotab="activity">View all</button></h2>${d.communications.length || d.activity.length ? '<ul class="actl">' + [...d.communications.slice(0, 4).map(x => ({ i: (ACT[x.type] || ['activity', 'navy']), t: x.title, s: x.text, at: x.at })), ...d.activity.slice(0, 2).map(a => ({ i: ['check', 'green'], t: `${a.action} ${a.entity}`, s: a.details || '', at: a.created_at }))].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 5).map(x => `<li><span class="chip ${x.i[1]}">${ic(x.i[0])}</span><span style="min-width:0"><b>${esc(x.t)}</b><small>${esc(String(x.s).slice(0, 110))}</small><small>${esc(fmtWhen(x.at))}</small></span></li>`).join('') + '</ul>' : '<p class="empty">No activity yet.</p>'}</div>
          <div class="card"><h2>${ic('scopes')} Quick actions</h2><div class="qa6"><button class="b" data-a="note">${ic('note')} New note</button><button class="b" data-a="call">${ic('calls')} Log call</button><button class="b" data-a="email">${ic('emails')} Send email</button><button class="g" data-a="estimate">${ic('proposals')} Create estimate</button><button class="p" data-a="proposal">${ic('send')} Create proposal</button><button class="r" data-a="issue">${ic('issues')} Create issue</button></div></div></div>
        <div><div class="card"><h2>${ic('emails')} Communication summary</h2><div class="comm3">${kt('calls', 'green', 'Calls', d.calls.length)}${kt('emails', 'blue', 'Emails', d.emails.length)}${kt('note', 'amber', 'Notes', d.notes.length)}</div></div>
          <div class="card"><h2>${ic('issues')} Open issues / complaints (${openIss.length}) <button class="linklike more" data-gotab="issues">View all</button></h2>${openIss.length ? '<ul class="mini">' + openIss.slice(0, 3).map(i => `<li><b>${esc(i.title)}</b> ${badge(i.priority)} ${badge(i.status)}<br><small class="muted">Assigned to ${esc(i.assigned_to || 'nobody yet')}${i.due_date ? ' · due ' + fmtDate(i.due_date) : ''}</small></li>`).join('') + '</ul>' : '<p class="empty">No open issues.</p>'}</div>
          <div class="card"><h2>${ic('projects')} Current projects (${d.projects.length}) <button class="linklike more" data-gotab="projects">View all</button></h2>${d.projects.length ? '<ul class="prop">' + d.projects.slice(0, 3).map(p => `<li><span class="chip blue">${ic('projects')}</span><span style="min-width:0;flex:1">${recLink('projects', p.id, p.name || 'Project #' + p.id)}<small class="muted" style="display:block">${esc(p.site_address || '')}${p.due_date ? ' · target ' + fmtDate(p.due_date) : ''}</small><span class="bar" style="width:${Math.max(3, Number(p.progress) || 0)}%;display:block;margin-top:6px"></span></span>${badge(p.status)}</li>`).join('') + '</ul>' : '<p class="empty">No projects.</p>'}</div></div></div>`;
      $$('#cpBody [data-gotab]').forEach(b => b.onclick = () => { cp.tab = b.dataset.gotab; renderCustomerPage(); });
      $$('#cpBody [data-a]').forEach(b => b.onclick = () => custAction(b.dataset.a));
      bindOpeners(B);
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

  // ---------- Estimates, proposals & bids (mockup layout) ----------
  const prop = { view: 'all', page: 1, dash: null, steps: [], sel: null };
  $('#propStatusFilter').innerHTML = '<option value="">Status: All</option>' + options([...STATUS.estimates, 'Withdrawn']);
  ['#propStatusFilter', '#propService', '#propRange'].forEach(x => $(x).addEventListener('change', () => { prop.page = 1; renderEstimates(); }));
  $('#propSearch').addEventListener('input', () => { prop.page = 1; renderEstimates(); });
  $$('#propTabs button').forEach(b => b.onclick = () => { if (b.dataset.pv === 'contracts') return go('contracts'); prop.view = b.dataset.pv; prop.page = 1; $$('#propTabs button').forEach(x => x.classList.toggle('on', x === b)); loadEstimates(); });
  const SVC = { construction: 'Construction', multifamily: 'Multifamily', janitorial: 'Janitorial', windows: 'Windows', exterior: 'Exterior', other: 'Other' };
  const pnum = e => e.number || `P-${String(e.created_at || '').slice(0, 4)}-${1000 + e.id}`;
  async function loadEstimates() {
    const [r, d] = await Promise.all([api('/api/admin/bids?view=' + prop.view), api('/api/admin/bids/dashboard')]);
    state.estimates = r.estimates || []; prop.steps = r.steps || []; prop.dash = d;
    $('#propKpis').innerHTML = [['proposals', 'blue', 'Draft estimates', d.drafts.n, d.drafts.week ? `+${d.drafts.week} this week` : money(d.drafts.v)], ['clock', 'amber', 'Awaiting review', d.review.n, money(d.review.v)], ['send', 'blue', 'Proposals pending', d.waiting.n, money(d.waiting.v)], ['check', 'green', 'Approved', d.approved.n, money(d.approved.v)], ['issues', 'red', 'Declined', d.declined.n, money(d.declined.v)], ['cal', 'amber', 'Expiring soon', d.expiring.n, 'Next 7 days']].map(x => kt(...x)).join('');
    $('#propSum').innerHTML = `<div><span>Total proposed value</span><b>${money(d.proposed_value)}</b></div><div><span>Contracted value (signed)</span><b>${money(d.contracted_value)}</b></div><div><span>Projected gross profit (estimate)</span><b>${d.projected_gp.costed ? money(d.projected_gp.v) + (d.projected_gp.pct != null ? ` <small>(${d.projected_gp.pct}%)</small>` : '') : '—'}</b></div><div><span>Win rate</span><b>${d.win.rate == null ? '—' : d.win.rate + '%'}</b> <small class="muted">${d.win.won} of ${d.win.decided} decided</small></div>`;
    const svcs = [...new Set(state.estimates.map(e => e.scope_category).filter(Boolean))];
    { const cur = $('#propService').value; $('#propService').innerHTML = '<option value="">Service: All</option>' + svcs.map(x => `<option value="${esc(x)}">${esc(SVC[x] || x)}</option>`).join(''); $('#propService').value = cur; }
    renderEstimates(); drawFlow(prop.sel ? state.estimates.find(e => e.id === prop.sel) : null);
    try { const a = await api('/api/admin/ai/status'); $('#propAiState').textContent = a.enabled ? 'Active' : 'Off'; $('#propAiState').className = 'badge ' + (a.enabled ? 'green' : ''); } catch { $('#propAiState').textContent = 'Off'; }
  }
  function drawFlow(e) {
    const st = e ? e.stage : null, steps = prop.steps.length ? prop.steps : ['Draft', 'Internal review', 'Approved for sending', 'Sent', 'Viewed', 'Accepted', 'Contract', 'Project planning'];
    const k = e ? steps.indexOf(st) : -1;
    const sub = { 'Draft': 'Estimate and pricing created', 'Internal review': 'Scope, pricing and margin checked', 'Approved for sending': 'Cleared by approval rules', 'Sent': 'Emailed with a secure review link', 'Viewed': 'Customer opened the proposal', 'Accepted': 'Customer approved and signed', 'Contract': 'Agreement generated from the approved version', 'Project planning': 'Handed off to operations' };
    $('#propFlow').innerHTML = steps.map((s, n) => `<li class="${k > n ? 'done' : k === n ? 'now' : ''}"><i></i><b>${esc(s)}</b><small>${esc(sub[s] || '')}</small></li>`).join('');
    $('#propFlowFor').textContent = e ? `${pnum(e)} · ${e.stage}${['Declined', 'Withdrawn', 'Expired', 'Superseded'].includes(e.stage) ? ' (ended)' : ''}` : 'Select a proposal to see where it is.';
  }
  function renderEstimates() {
    const q = $('#propSearch').value.trim().toLowerCase(), st = $('#propStatusFilter').value, sv = $('#propService').value, rg = Number($('#propRange').value) || 0;
    const since = rg ? new Date(Date.now() - rg * 864e5).toISOString() : '';
    const all = state.estimates.filter(e => (!st || e.status === st) && (!sv || e.scope_category === sv) && (!since || e.created_at >= since))
      .filter(e => !q || [e.customer_name, e.company, e.project_name, e.email, e.site_address, pnum(e)].join(' ').toLowerCase().includes(q));
    const per = 10, pages = Math.max(1, Math.ceil(all.length / per)); prop.page = Math.min(prop.page, pages);
    const rows = all.slice((prop.page - 1) * per, prop.page * per);
    $('#propRows').innerHTML = rows.length ? rows.map(e => {
      const expired = e.expires_on && e.expires_on < todayISO() && !['Approved', 'Declined', 'Withdrawn'].includes(e.status);
      const act = e.status === 'Approved' ? `Accepted<small>${e.signer_name ? 'by ' + esc(e.signer_name) : fmtDate(e.decided_at)}</small>` : e.view_count ? `Viewed (${e.view_count})<small>${fmtDate(e.last_viewed_at || e.viewed_at)}</small>` : e.sent_at ? 'Not opened yet' : '—';
      const warn = e.flags && e.flags.some(f => f.level !== 'info') ? ` <span title="${esc(e.flags.filter(f => f.level !== 'info').map(f => f.text).join('\n'))}" style="color:#c26a00">⚠</span>` : '';
      return `<tr class="click" data-est="${e.id}"><td><b style="color:#1f6fd1">${esc(pnum(e))}</b><small>v${e.version || 1}${e.bid_type === 'gc_bid' ? ' · GC bid' : ''}</small></td><td><b>${esc(e.company || e.customer_name)}</b><small>${esc(e.project_name || '')}</small></td>
        <td>${e.scope_category ? `<span class="pill t-task">${esc(SVC[e.scope_category] || e.scope_category)}</span>` : '<span class="muted">Not set</span>'}</td><td class="num"><b>${money(e.proposal_total)}</b>${warn}</td>
        <td>${fmtDate(e.created_at)}</td><td>${e.sent_at ? fmtDate(e.sent_at) : '—'}</td><td class="${expired ? 'due-late' : ''}">${e.expires_on ? fmtDate(e.expires_on) : '—'}</td><td>${act}</td>
        <td><span class="pill st-${esc(e.status)}">${esc(e.status === 'Approved' ? 'Accepted' : e.status)}</span></td><td><button class="btn small ghost" data-det="${e.id}" title="Details, versions and history">Details</button> <button class="btn small ghost" data-edit="${e.id}">Edit</button></td></tr>`;
    }).join('') : `<tr><td class="emptyrow" colspan="10">${q || st || sv || rg ? 'No proposals match your filters.' : 'No estimates yet. Click “New estimate” or describe a project to the AI assistant.'}</td></tr>`;
    $('#propShowing').textContent = all.length ? `Showing ${(prop.page - 1) * per + 1} – ${Math.min(prop.page * per, all.length)} of ${all.length}` : '';
    $('#propPages').innerHTML = pages > 1 ? Array.from({ length: pages }, (_, n) => `<button class="${n + 1 === prop.page ? 'on' : ''}" data-pg="${n + 1}">${n + 1}</button>`).join('') : '';
    $$('#propPages button').forEach(b => b.onclick = () => { prop.page = Number(b.dataset.pg); renderEstimates(); });
    $$('#propRows [data-est]').forEach(r => r.onclick = ev => { if (ev.target.closest('[data-edit],[data-det]')) return; prop.sel = Number(r.dataset.est); drawFlow(state.estimates.find(e => e.id === prop.sel)); openEstimate(prop.sel); });
    $$('#propRows [data-edit]').forEach(b => b.onclick = () => editEstimate(Number(b.dataset.edit)));
    $$('#propRows [data-det]').forEach(b => b.onclick = () => { prop.sel = Number(b.dataset.det); drawFlow(state.estimates.find(e => e.id === prop.sel)); openBid(prop.sel); });
  }
  $('#propCsv').addEventListener('click', () => {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`, rows = [['Proposal', 'Version', 'Type', 'Customer', 'Project', 'Service', 'Amount', 'Estimated cost', 'Status', 'Stage', 'Created', 'Sent', 'Valid until', 'Views', 'Accepted by'], ...state.estimates.map(e => [pnum(e), e.version || 1, e.bid_type === 'gc_bid' ? 'GC bid' : 'Proposal', e.company || e.customer_name, e.project_name, e.scope_category, e.proposal_total, e.total_cost, e.status, e.stage, e.created_at, e.sent_at, e.expires_on, e.view_count, e.signer_name])];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' })); a.download = 'proposals.csv'; a.click();
  });
  $('#propAiBtn').addEventListener('click', () => { $('#propAiDesc').focus(); $('#propAiDesc').scrollIntoView && $('#propAiDesc').scrollIntoView({ block: 'center' }); });
  $('#propAiGo').addEventListener('click', async () => {
    const d = $('#propAiDesc').value.trim(); if (d.length < 20) return toast('Describe the project in a sentence or two, with square footage or unit counts.', true);
    const b = $('#propAiGo'); b.disabled = true; b.textContent = 'Reading the price book…'; $('#propAiOut').textContent = '';
    try {
      const r = await api('/api/admin/ai/estimates/generate', { method: 'POST', json: { description: d, company: $('#propAiCo').value.trim() } });
      if (!r.created) $('#propAiOut').textContent = 'Not enough information to price it yet:\n• ' + r.questions.join('\n• ');
      else { $('#propAiOut').textContent = `Draft created: ${money(r.total)} from ${r.lines} price-book line(s).${r.questions.length ? '\nOpen questions:\n• ' + r.questions.join('\n• ') : ''}`; $('#propAiDesc').value = ''; await loadEstimates(); openBid(r.id); }
    } catch (e) { $('#propAiOut').textContent = e.message; }
    b.disabled = false; b.textContent = 'Generate estimate with AI';
  });
  async function openBid(id) {
    let r; try { r = await api('/api/admin/bids/' + id); } catch (e) { return toast(e.message, true); }
    const e = r.estimate, items = (() => { try { return Array.isArray(e.line_items) ? e.line_items : JSON.parse(e.line_items || '[]'); } catch { return []; } })();
    const margin = e.proposal_total > 0 && e.total_cost > 0 ? ((e.proposal_total - e.total_cost) / e.proposal_total * 100).toFixed(1) + '%' : '—';
    const sent = ['Sent', 'Viewed', 'Approved', 'Declined', 'Expired'].includes(e.status), editable = ['Draft', 'Ready'].includes(e.status);
    openDrawer({ title: `${pnum(e)} v${e.version || 1}`, sub: `${e.company || e.customer_name}${e.project_name ? ' · ' + e.project_name : ''} · ${e.stage}`,
      body: `${e.flags.length ? `<ul class="flagl">${e.flags.map(f => `<li class="${f.level}">${esc(f.text)}</li>`).join('')}</ul>` : '<p class="muted">No pricing flags.</p>'}
        <h3 class="secth">Customer &amp; project</h3><dl class="stat"><dt>Customer</dt><dd>${esc(e.company || '—')}</dd><dt>Contact</dt><dd>${esc(e.customer_name)}${e.email ? ' · ' + esc(e.email) : ''}</dd><dt>Site</dt><dd>${esc(e.site_address || '—')}</dd><dt>Service</dt><dd>${esc(SVC[e.scope_category] || e.scope_category || 'Not set')}</dd><dt>Type</dt><dd>${e.bid_type === 'gc_bid' ? `GC bid${e.gc_name ? ' · ' + esc(e.gc_name) : ''}${e.bid_due_date ? ' · due ' + fmtDate(e.bid_due_date) : ''}` : 'Customer proposal'}</dd></dl>
        <h3 class="secth">Scope of work</h3><p style="white-space:pre-wrap">${esc(e.scope || '')}</p>
        ${items.length ? `<h3 class="secth">Line items</h3><div class="tablewrap"><table class="t"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>${items.map(i => `<tr><td>${esc(i.description || i.name || '')}${i.basis ? `<small>${esc(i.basis)}</small>` : ''}</td><td class="num">${Number(i.quantity || i.qty || 0).toLocaleString()}</td><td class="num">${money(i.unit_price || i.rate)}</td><td class="num">${money(i.amount != null ? i.amount : (i.quantity || 0) * (i.unit_price || 0))}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <form id="bidForm" class="ig" style="margin-top:12px"><div class="wide"><label>Assumptions (shown to customer)</label><textarea name="assumptions" rows="2" ${editable ? '' : 'disabled'}>${esc(e.assumptions || '')}</textarea></div><div class="wide"><label>Exclusions (shown to customer)</label><textarea name="exclusions" rows="2" ${editable ? '' : 'disabled'}>${esc(e.exclusions || '')}</textarea></div>
          <div class="wide"><label>Internal notes (never shown to the customer)</label><textarea name="internal_notes" rows="2">${esc(e.internal_notes || '')}</textarea></div>
          <div><label>Bid type</label><select name="bid_type"><option value="proposal"${e.bid_type !== 'gc_bid' ? ' selected' : ''}>Customer proposal</option><option value="gc_bid"${e.bid_type === 'gc_bid' ? ' selected' : ''}>General contractor bid</option></select></div><div><label>General contractor</label><input name="gc_name" value="${esc(e.gc_name || '')}"></div><div><label>Bid due date</label><input type="date" name="bid_due_date" value="${esc(e.bid_due_date || '')}"></div><div></div></form>
        ${!editable ? '<p class="muted">Customer-facing terms are locked after sending. Use <b>Revise</b> to change them; the sent version stays on record.</p>' : ''}
        <h3 class="secth">Internal costs &amp; margin</h3><dl class="stat"><dt>Estimated cost</dt><dd>${money(e.total_cost)}</dd><dt>Price</dt><dd>${money(e.proposal_total)}</dd><dt>Gross margin (estimate)</dt><dd>${margin}</dd><dt>Labor hours</dt><dd>${Number(e.labor_hours || 0).toLocaleString()}</dd></dl>
        ${e.signed_at ? `<h3 class="secth">Acceptance</h3><p>Accepted by <b>${esc(e.signer_name)}</b>${e.signer_title ? ', ' + esc(e.signer_title) : ''} on ${fmtWhen(e.signed_at)}${e.decision_ip ? ` <small class="muted">from ${esc(e.decision_ip)}</small>` : ''}</p>` : ''}${e.decline_reason ? `<p><b>Decline reason:</b> ${esc(e.decline_reason)}</p>` : ''}${e.withdrawn_reason ? `<p><b>Withdrawn:</b> ${esc(e.withdrawn_reason)}</p>` : ''}
        ${r.contract ? `<p>Contract: <button class="linklike" data-rec="contracts:${r.contract.id}">${esc(r.contract.title || 'Contract #' + r.contract.id)}</button> ${badge(r.contract.signature_status || 'Not sent')}</p>` : ''}
        ${r.takeoffs.length || r.documents.length ? `<h3 class="secth">Drawings &amp; takeoffs</h3><ul class="mini">${r.takeoffs.map(t => `<li>Takeoff: ${esc(t.title)} ${badge(t.status)}${t.building_sf ? ' · ' + Number(t.building_sf).toLocaleString() + ' SF' : ''}</li>`).join('')}${r.documents.map(x => `<li>${esc(x.title)} <small class="muted">${esc(x.kind)}</small></li>`).join('')}</ul>` : ''}
        <h3 class="secth">Versions (${r.versions.length})</h3><ul class="mini">${r.versions.map(v => `<li>${v.id === e.id ? '<b>' : ''}v${v.version || 1} · ${badge(v.status)} ${money(v.proposal_total)} · ${fmtDate(v.created_at)}${v.id === e.id ? '</b> (this one)' : ` <button class="linklike" data-ver="${v.id}">open</button>`}</li>`).join('')}</ul>
        <h3 class="secth">Customer communications (${r.communications.length})</h3>${r.communications.length ? `<ul class="mini">${r.communications.slice(0, 10).map(m => `<li>${esc(m.subject)} <small class="muted">${fmtWhen(m.created_at)} · ${esc(m.status)}</small></li>`).join('')}</ul>` : '<p class="muted">No emails yet.</p>'}
        <h3 class="secth">Approval &amp; history</h3>${r.approval ? `<p class="flagl"><span class="warn" style="display:block;padding:6px 10px;border-radius:8px">${esc(r.approval)}</span></p>` : ''}<div class="activity">${renderActivity(r.history) || '<p class="empty">No history yet.</p>'}</div>`,
      footer: `<button class="btn ghost" data-close>Close</button><button class="btn ghost" id="bPdf">Download PDF</button>${e.public_token && sent ? '<button class="btn ghost" id="bPreview">Customer view</button>' : ''}${editable ? '<button class="btn ghost" id="bEdit">Edit</button>' : ''}${['Sent', 'Viewed', 'Declined', 'Expired'].includes(e.status) || (e.status === 'Approved' && !r.contract) ? '<button class="btn ghost" id="bRevise">Revise</button>' : ''}${['Draft', 'Ready', 'Sent', 'Viewed'].includes(e.status) ? '<button class="btn ghost danger" id="bWithdraw">Withdraw</button>' : ''}<button class="btn ghost" id="bDup">Duplicate</button><button class="btn" id="bSave">Save</button><button class="btn" id="bMore">${['Sent', 'Viewed'].includes(e.status) ? 'Resend / actions' : editable ? 'Send / approve…' : 'Actions…'}</button>` });
    bindOpeners($('#drawerRoot'));
    $$('#drawerRoot [data-ver]').forEach(b => b.onclick = () => openBid(Number(b.dataset.ver)));
    $('#bPdf').onclick = () => downloadFile({ name: `${pnum(e)}-v${e.version || 1}.pdf`, url: `/api/admin/bids/${e.id}/pdf` });
    $('#bPreview') && ($('#bPreview').onclick = () => window.open('/proposal/' + e.public_token, '_blank'));
    $('#bEdit') && ($('#bEdit').onclick = () => { closeDrawer(); editEstimate(e.id); });
    $('#bMore').onclick = () => openEstimate(e.id);
    $('#bDup').onclick = async () => { try { const x = await api(`/api/admin/estimates/${e.id}/duplicate`, { method: 'POST' }); toast('Duplicated as a new draft'); await loadEstimates(); openBid(x.id || (x.estimate && x.estimate.id)); } catch (err) { toast(err.message, true); } };
    $('#bSave').onclick = async () => { try { await api('/api/admin/bids/' + e.id, { method: 'PATCH', json: formObj($('#bidForm')) }); toast('Saved'); loadEstimates(); openBid(e.id); } catch (err) { toast(err.message, true); } };
    $('#bRevise') && ($('#bRevise').onclick = async () => { if (!confirm(`Create version ${(e.version || 1) + 1}? This version stays on record and its customer link closes.`)) return; try { const x = await api(`/api/admin/bids/${e.id}/revise`, { method: 'POST' }); toast(`Version ${x.version} created as a draft`); await loadEstimates(); openBid(x.id); } catch (err) { toast(err.message, true); } });
    $('#bWithdraw') && ($('#bWithdraw').onclick = async () => { const reason = prompt('Why are you withdrawing this proposal? (kept on record; the customer link will close)'); if (!reason) return; try { await api(`/api/admin/bids/${e.id}/withdraw`, { method: 'POST', json: { reason } }); toast('Withdrawn'); await loadEstimates(); openBid(e.id); } catch (err) { toast(err.message, true); } });
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
          ${Number(e.tax_pct) > 0 ? `<dt>Subtotal before tax</dt><dd>${money(e.proposal_total / (1 + Number(e.tax_pct) / 100))}</dd><dt>Tax (${Number(e.tax_pct)}%)</dt><dd>${money(e.proposal_total - e.proposal_total / (1 + Number(e.tax_pct) / 100))}</dd>` : ''}
          ${Number(e.total_cost) > 0 ? `<dt>Cost incl. overhead</dt><dd>${money(e.total_cost)} · ${Number(e.labor_hours || 0).toFixed(1)} labor hours</dd>
          <dt>Gross margin</dt><dd>${Math.round((1 - e.total_cost / (e.proposal_total / (1 + Number(e.tax_pct || 0) / 100))) * 1000) / 10}% · profit ${money(e.proposal_total / (1 + Number(e.tax_pct || 0) / 100) - e.total_cost)}</dd>` : `<dt>Cost &amp; margin</dt><dd class="muted">No costs entered, so margin can't be calculated. Add labor and costs (or price it from a takeoff) to see profit.</dd>`}
          <dt>Email</dt><dd>${esc(e.email || '— add one to email the proposal')}</dd>
          <dt>Site</dt><dd>${esc(e.site_address || '—')}</dd>
          <dt>Valid through</dt><dd>${fmtDate(e.expires_on)}</dd>
          <dt>Crew plan</dt><dd>${Number(e.crew_days || 0).toFixed(1)} crew days · ${Number(e.visits || 1)} visit(s) · crew of ${Number(e.crew_size || 1)}</dd>
          <dt>Sent</dt><dd>${e.sent_at ? esc(fmtWhen(e.sent_at)) : 'Not emailed yet'}</dd>
          <dt>Customer viewed</dt><dd>${e.viewed_at ? `First ${esc(fmtWhen(e.viewed_at))}${e.view_count > 1 ? ` · ${e.view_count} views, last ${esc(fmtWhen(e.last_viewed_at))}` : ''}` : 'Not yet'}</dd>
          ${e.decided_at ? `<dt>Decision</dt><dd>${badge(e.status)} ${esc(fmtWhen(e.decided_at))}${e.decision_ip ? ' · by the customer online' : ' · set in admin'}</dd>` : ''}
          ${e.lead_id ? `<dt>From lead</dt><dd><button class="linklike" data-lead="${e.lead_id}">Lead #${e.lead_id}</button></dd>` : ''}
        </dl>
        <div class="card" id="estFiles" style="margin:10px 0"><h3 class="secth" style="margin-top:0">Attached files</h3><p class="muted">Loading…</p></div>
        <div id="apprBox"></div>
        <div class="grid"><div class="f"><label for="es">Status</label><select id="es"${e.decision_ip ? ' disabled' : ''}>${options(STATUS.estimates.filter(x => x !== 'Approved' || e.status === 'Approved'), e.status)}</select><span class="hint">${e.decision_ip ? 'Locked: the customer made this decision online. Duplicate the proposal to revise it.' : 'Updates automatically when the customer views, approves or declines.'}</span></div></div>
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
    const loadEstFiles = async () => { const box = $('#estFiles'); if (!box) return; let f = []; try { f = (await api(`/api/admin/estimates/${e.id}/files`)).files; } catch { /* */ }
      box.innerHTML = `<h3 class="secth" style="margin-top:0">Attached files</h3>${f.length ? `<ul class="plain">${f.map(x => `<li style="margin:4px 0">📎 <a href="#" data-fdl="${x.id}">${esc(x.title || x.file_name)}</a> <small class="muted">${esc(x.kind)} · ${(x.size / 1024).toFixed(0)} KB · ${esc(fmtDate(x.created_at))}${x.uploaded_by ? ' · ' + esc(x.uploaded_by) : ''}</small></li>`).join('')}</ul>` : '<p class="muted">No files attached yet.</p>'}
        <label class="btn small ghost" style="cursor:pointer">Attach file<input type="file" id="estFileIn" hidden multiple></label> <small class="muted">Also saved to the customer's documents.</small>`;
      $$('#estFiles [data-fdl]').forEach(a => a.onclick = ev => { ev.preventDefault(); const x = f.find(y => y.id === Number(a.dataset.fdl)); downloadFile({ name: x.file_name, url: x.file_url }); });
      $('#estFileIn').onchange = async ev => { const files = [...ev.target.files]; if (!files.length) return; const fd = new FormData(); files.forEach(x => fd.append('files', x)); fd.append('kind', 'Proposal'); fd.append('estimate_id', e.id); if (e.customer_id) fd.append('customer_id', e.customer_id);
        if (files.length === 1) fd.append('title', files[0].name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '));
        try { const r = await fetch('/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Upload failed'); toast(`${files.length} file(s) attached`); loadEstFiles(); } catch (err) { toast(err.message, true); } };
    };
    loadEstFiles();
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
    $('#eCopy').onclick = () => copyText(url, $('#eUrl'), 'Link copied');
    $('#eSend').onclick = async () => {
      try { if (!(await clearApproval('goes to the customer'))) return; } catch (err) { return toast(err.message, true); }
      if (!confirm(`Email this proposal to ${e.email}?`)) return;
      try { let r; try { r = await api(`/api/admin/estimates/${e.id}/send`, { method: 'POST' }); } catch (er) { if (/was due/.test(er.message) && confirm(er.message + '\n\nSend it anyway?')) r = await api(`/api/admin/estimates/${e.id}/send`, { method: 'POST', json: { late_ok: true } }); else throw er; } toast(r.message || 'Sent'); closeDrawer(); loadEstimates(); }
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
    const d = localISO(new Date(Date.now() + 30 * 864e5));
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
    if (t === 'projects') return loadProjects();
    state[t] = (await api('/api/admin/' + t))[t] || [];
    renderRegister(t);
    if (t === 'invoices') renderFinance();
  }

  function renderRegister(t) {
    const cfg = REG[t];
    regHeader(t);
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

  async function openContract(id) {
    let d; try { d = await api('/api/admin/contracts2/' + id); } catch (e) { return toast(e.message, true); }
    const k = d.contract, signed = ['Customer signed', 'Signed'].includes(k.signature_status), exec = ['Signed', 'Executed', 'Fully signed'].includes(k.signature_status);
    const stTone = { 'Not sent': '', Sent: 'blue', Viewed: 'blue', 'Customer signed': 'amber', Signed: 'green', Declined: 'red' }[k.signature_status || 'Not sent'] || '';
    openDrawer({ title: `${k.number} · ${k.title || 'Contract'}`, sub: `${esc(k.kind || 'Contract')} · ${esc(k.company || k.customer_name || '')} · <span class="badge ${stTone}">${esc(k.signature_status || 'Not sent')}</span> · ${esc(k.status)}`,
      body: `${k.signature_status === 'Declined' ? `<p class="err" style="display:block">Customer declined: ${esc(k.decline_reason || '')}. Edit the contract and send it again.</p>` : ''}
        ${k.signed_at ? `<p class="muted">Customer signed: <b>${esc(k.signer_name)}</b>${k.signer_title ? ', ' + esc(k.signer_title) : ''} · ${fmtWhen(k.signed_at)} · IP ${esc(k.signed_ip || '')}${k.countersigned_at ? `<br>Countersigned: <b>${esc(k.countersigned_by)}</b> · ${fmtWhen(k.countersigned_at)}` : ''}</p>` : ''}
        ${k.link && !signed ? `<p>Signing link: <input readonly value="${esc(k.link)}" style="width:100%;padding:8px;border:1px solid #ccd5df;border-radius:8px" id="kLink"> <small class="muted">${k.viewed_at ? 'Viewed ' + fmtWhen(k.viewed_at) : k.sent_at ? 'Sent ' + fmtWhen(k.sent_at) : ''}</small></p>` : ''}
        <form class="ig" id="kForm"><div class="wide"><label>Title</label><input name="title" value="${esc(k.title || '')}"></div><div><label>Company</label><input name="company" value="${esc(k.company || '')}"></div><div><label>Customer contact</label><input name="customer_name" value="${esc(k.customer_name || '')}"></div>
          <div><label>Customer email (receives the link)</label><input name="email" value="${esc(k.email || '')}"></div><div><label>Contract value ($)</label><input name="value" inputmode="decimal" value="${esc(k.value || '')}"></div><div><label>Start</label><input type="date" name="start_date" value="${esc(k.start_date || '')}"></div><div><label>End</label><input type="date" name="end_date" value="${esc(k.end_date || '')}"></div>
          <div><label>Payment terms</label><input name="payment_terms" value="${esc(k.payment_terms || 'Net 30')}"></div><div><label>Billing</label><input name="billing" value="${esc(k.billing || '')}" placeholder="e.g. Monthly in advance"></div><div><label>Auto-renew</label><select name="auto_renew"><option value="">No</option><option value="1"${k.auto_renew ? ' selected' : ''}>Yes</option></select></div><div><label>Notice days</label><input name="notice_days" inputmode="numeric" value="${esc(k.notice_days ?? 30)}"></div>
          <div class="wide"><label>Scope of work</label><textarea name="scope" rows="5">${esc(k.scope || '')}</textarea></div><div class="wide"><label>Terms and conditions</label><textarea name="terms" rows="8">${esc(k.terms || d.default_terms)}</textarea></div></form>
        ${d.versions.length > 1 ? `<h3 class="secth">Versions</h3>${d.versions.map(v => `<p style="margin:3px 0"><button class="linklike" data-kv="${v.id}">v${v.version || 1}</button> ${badge(v.status)} ${esc(v.signature_status || '')} · ${money(v.value)}</p>`).join('')}` : ''}
        <h3 class="secth">History</h3><div class="activity">${renderActivity(d.history) || '<p class="muted">No activity yet.</p>'}</div>`,
      footer: `<button class="btn ghost" data-close>Close</button><button class="btn ghost" id="kPdf">PDF</button>${!signed ? '<button class="btn ghost" id="kSave">Save</button>' : ''}${!signed && k.status !== 'Superseded' ? `<button class="btn" id="kSend">${k.link ? 'Re-send link' : 'Send for signature'}</button>` : ''}${k.signature_status === 'Customer signed' ? '<button class="btn" id="kCs">Countersign</button>' : ''}${exec ? '<button class="btn ghost" id="kAmend">Amend</button><button class="btn ghost" id="kRenew">Renew</button>' : ''}` });
    if (signed) $$('#kForm input, #kForm textarea, #kForm select').forEach(x => x.disabled = true);
    const act = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    const save = () => { const f = formObj($('#kForm')); return api('/api/admin/contracts2/' + id, { method: 'PATCH', json: { ...f, auto_renew: !!f.auto_renew } }); };
    act('#kSave', async () => { try { await save(); toast('Saved'); loadRegister('contracts'); openContract(id); } catch (e) { toast(e.message, true); } });
    act('#kSend', async () => { try { await save(); const r = await api(`/api/admin/contracts2/${id}/send`, { method: 'POST' }); try { await navigator.clipboard.writeText(r.link); } catch { /* */ } toast(r.emailed ? 'Sent to the customer for signature (link copied)' : 'Signing link created and copied — email could not be sent, share the link'); loadRegister('contracts'); openContract(id); } catch (e) { toast(e.message, true); } });
    act('#kCs', async () => { const name = prompt('Type your full name to countersign and execute this contract:'); if (!name) return; try { await api(`/api/admin/contracts2/${id}/countersign`, { method: 'POST', json: { name } }); toast('Countersigned — contract executed'); loadRegister('contracts'); openContract(id); } catch (e) { toast(e.message, true); } });
    act('#kPdf', () => downloadFile({ name: k.number + '.pdf', url: `/api/admin/contracts2/${id}/pdf` }));
    act('#kAmend', async () => { const reason = prompt('What does the amendment change?'); if (!reason) return; try { const r = await api(`/api/admin/contracts2/${id}/amend`, { method: 'POST', json: { reason } }); toast('Amendment drafted'); loadRegister('contracts'); openContract(r.id); } catch (e) { toast(e.message, true); } });
    act('#kRenew', async () => { const pct = prompt('Price change for the renewal term (%), e.g. 3 or 0:', '0'); if (pct === null) return; try { const r = await api(`/api/admin/contracts2/${id}/renew`, { method: 'POST', json: { increase_pct: Number(pct) || 0 } }); toast(`Renewal drafted: ${r.start_date} to ${r.end_date}`); loadRegister('contracts'); openContract(r.id); } catch (e) { toast(e.message, true); } });
    $$('#drawerRoot [data-kv]').forEach(b => b.onclick = () => openContract(Number(b.dataset.kv)));
    $$('#drawerRoot [data-close]').forEach(el => el.onclick = closeDrawer);
  }
  function regHeader(t) {
    const R = state[t] || [], sel = $(`[data-filter="${t}"]`), tabs = $('#regTabs-' + t), kp = $('#regKpis-' + t);
    if (!tabs || !kp || !sel) return;
    const sts = t === 'invoices' ? ['Draft', 'Sent', 'Partially Paid', 'Overdue', 'Paid', 'Void'] : ['Draft', 'Review', 'Active', 'Renewal Due', 'Closed'];
    const stOf = r => t === 'invoices' ? invoiceState(r) : r.status;
    tabs.innerHTML = `<button data-rt="" class="${!sel.value ? 'on' : ''}">All (${R.length})</button>` + sts.map(x => `<button data-rt="${esc(x)}" class="${sel.value === x ? 'on' : ''}">${esc(x)} (${R.filter(r => stOf(r) === x).length})</button>`).join('');
    $$('#regTabs-' + t + ' button').forEach(b => b.onclick = () => { sel.value = b.dataset.rt; renderRegister(t); });
    if (t === 'contracts') {
      const act = R.filter(r => r.status === 'Active'), sum = a => a.reduce((s, r) => s + (Number(r.value) || 0), 0), in60 = localISO(new Date(Date.now() + 60 * 864e5));
      kp.innerHTML = [kt('contracts', 'blue', 'Active contracts', act.length, money(sum(act))), kt('money', 'navy', 'Total contracted', money(sum(R.filter(r => r.status !== 'Closed'))), 'not closed'), kt('issues', 'amber', 'Awaiting signature', R.filter(r => ['Sent', 'Viewed', 'Customer signed'].includes(r.signature_status) && r.status !== 'Closed').length, `${R.filter(r => r.signature_status === 'Customer signed').length} need your countersignature`),
        kt('cal', 'red', 'Ending within 60 days', R.filter(r => r.status === 'Active' && r.end_date && r.end_date <= in60).length, 'plan the renewal'), kt('proposals', 'purple', 'Drafts', R.filter(r => r.status === 'Draft').length, ''), kt('check', 'green', 'Closed', R.filter(r => r.status === 'Closed').length, '')].join('');
    } else {
      const live = R.filter(i => i.status !== 'Void' && i.status !== 'Draft'), billed = live.reduce((s, i) => s + Number(i.amount || 0), 0), paid = live.reduce((s, i) => s + Number(i.paid_amount || 0), 0), od = live.filter(i => invoiceState(i) === 'Overdue');
      kp.innerHTML = [kt('invoices', 'blue', 'Billed', money(billed), `${live.length} sent invoices`), kt('check', 'green', 'Collected', money(paid), billed ? Math.round(paid / billed * 100) + '% of billed' : ''), kt('money', 'navy', 'Outstanding', money(Math.max(0, billed - paid)), ''),
        kt('issues', 'red', 'Overdue', money(od.reduce((s, i) => s + Math.max(0, i.amount - i.paid_amount), 0)), `${od.length} invoice(s)`), kt('proposals', 'purple', 'Drafts (not sent)', R.filter(i => i.status === 'Draft').length, ''), kt('check', 'teal', 'Paid in full', live.filter(i => invoiceState(i) === 'Paid').length, '')].join('');
      if ($('#invAging') && !regHeader.agingLoading) { regHeader.agingLoading = true; api('/api/admin/reports/aging').then(a => { $('#invAging').innerHTML = `<div class="st"><span>Open balance</span><b>${money(a.total || 0)}</b><small>A/R aging</small></div>` + Object.entries(a.buckets || {}).map(([k, v]) => `<div class="st"><span>${k === 'Current' ? 'Current (not due)' : esc(k) + ' days late'}</span><b style="color:${k !== 'Current' && v > 0 ? '#c0362d' : 'inherit'}">${money(v)}</b></div>`).join(''); }).catch(() => { $('#invAging').hidden = true; }).finally(() => { regHeader.agingLoading = false; }); }
    }
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
    if (t === 'projects' && id) return openProject(id);
    if (t === 'contracts' && id) return openContract(id);
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
        rec.due_date = localISO(new Date(Date.now() + 30 * 864e5));
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
        ${t === 'invoices' && id && !['Void', 'Paid'].includes(rec.status) ? `<button class="btn" id="recSend">${rec.sent_at ? 'Resend invoice' : 'Send invoice'}</button>` : ''}
        ${t === 'invoices' && id ? '<button class="btn ghost" id="recPdf">PDF</button><button class="btn ghost" id="recPrint">Print</button>' : ''}
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
    if ($('#recPdf')) $('#recPdf').onclick = () => downloadFile({ name: (rec.invoice_number || 'invoice') + '.pdf', url: `/api/admin/invoices/${id}/pdf` });
    if ($('#recSend')) $('#recSend').onclick = async () => { const to = prompt('Send the invoice (PDF attached) to:', rec.email || ''); if (!to) return; let body = { to };
      try { let r; try { r = await api(`/api/admin/invoices/${id}/send`, { method: 'POST', json: body }); }
        catch (e) { if (/above the contract value/.test(e.message)) { const reason = prompt(e.message + '\n\nOwner/manager: give the reason to bill above the contract (e.g. approved change order #):'); if (!reason) return; r = await api(`/api/admin/invoices/${id}/send`, { method: 'POST', json: { ...body, over_contract_reason: reason } }); } else throw e; }
        toast(`Invoice ${r.resend ? 're-sent' : 'sent'} to ${r.to}`); closeDrawer(); loadRegister('invoices'); } catch (e) { toast(e.message, true); } };
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
      <p class="noprint"><button id="printBtn">Print or save as PDF</button></p></body></html>`);
    w.document.close(); const pb = w.document.getElementById('printBtn'); if (pb) pb.addEventListener('click', () => w.print());
  }

  // ---------- Activity ----------
  let actEvents = [];
  async function loadActivity() {
    actEvents = (await api('/api/admin/audit-log')).events || [];
    const t = todayISO(), isToday = e => localISO(new Date(e.created_at)) === t, today = actEvents.filter(isToday);
    $('#actKpis').innerHTML = [kt('reports', 'blue', "Today's events", today.length, `${actEvents.length} loaded`), kt('customers', 'navy', 'Sign-ins today', today.filter(e => /sign|log(ged)? ?in/i.test(e.action)).length, ''),
      kt('proposals', 'purple', 'Changes today', today.filter(e => /creat|updat|edit|delet|archiv|chang|sent|sign/i.test(e.action)).length, ''), kt('leads', 'teal', 'From customers / website', actEvents.filter(e => /^customer|website|public/i.test(e.actor || '')).length, 'signatures, views, forms'),
      kt('calls', 'amber', 'Phone system', actEvents.filter(e => e.actor === 'phone system').length, 'captured calls'), kt('check', 'green', 'People active', new Set(today.map(e => e.actor).filter(Boolean)).size, 'today')].join('');
    renderActRows();
  }
  function renderActRows() {
    const q = ($('#actSearch').value || '').trim().toLowerCase();
    const rows = q ? actEvents.filter(e => [e.actor, e.action, e.entity, e.details].join(' ').toLowerCase().includes(q)) : actEvents;
    $('#activityRows').innerHTML = renderActivity(rows) || `<p class="empty">${q ? 'No activity matches your search.' : 'No activity recorded yet.'}</p>`;
  }
  $('#actSearch').addEventListener('input', () => renderActRows());

  // ---------- Settings ----------
  $('#pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const v = formObj(e.target), m = $('#pwMsg');
    if (v.next !== v.confirm) { m.className = 'msg err'; m.textContent = 'The new passwords don’t match.'; return; }
    if (v.next.length < 14) { m.className = 'msg err'; m.textContent = 'Use at least 14 characters.'; return; }
    m.className = 'msg'; m.textContent = 'Saving…';
    try { const r = await api('/api/admin/account/password', { method: 'POST', json: { current: v.current, next: v.next } }); if (r.token) { token = r.token; localStorage.setItem(TOKEN_KEY, token); } e.target.reset(); m.className = 'msg ok'; m.textContent = r.message; }
    catch (err) { m.className = 'msg err'; m.textContent = err.message; }
  });

  async function loadSettings() {
    addSignOutEverywhere();
    await Promise.all([loadUsers(), loadAutomation(), loadBackups(), loadApprovalRules(), loadAISettings(), loadPhoneSettings(), loadApiKeys()]);
  }
  async function loadApiKeys() {
    if (!$('#apiKeyRows')) return;
    let r; try { r = await api('/api/admin/api-keys'); } catch (e) { $('#apiKeyRows').innerHTML = `<tr><td colspan="6" class="muted">${esc(e.message)}</td></tr>`; $('#apiKeyNew').hidden = true; return; }
    $('#apiKeyNew').hidden = false;
    $('#apiKeyRows').innerHTML = (r.keys || []).map(k => `<tr><td><b>${esc(k.name)}</b></td><td><code>${esc(k.prefix)}…</code></td><td>${esc(fmtWhen(k.created_at))}</td><td>${k.last_used_at ? esc(fmtWhen(k.last_used_at)) : 'Never'}</td><td>${k.revoked_at ? '<span class="chip">Revoked</span>' : '<span class="chip green">Active</span>'}</td><td>${k.revoked_at ? '' : `<button class="btn small danger" data-apirevoke="${k.id}" data-name="${esc(k.name)}">Revoke</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No keys yet.</td></tr>';
    $$('#apiKeyRows [data-apirevoke]').forEach(b => b.onclick = async () => {
      if (!confirm(`Revoke the key “${b.dataset.name}”? Sources using it will stop sending leads.`)) return;
      try { await api(`/api/admin/api-keys/${b.dataset.apirevoke}/revoke`, { method: 'POST' }); toast('Key revoked'); loadApiKeys(); } catch (e) { toast(e.message, true); }
    });
    $('#apiKeyNew').onclick = () => openForm({
      title: 'New API key', sub: 'For a partner site, ad page or tool that sends leads.',
      defs: [{ name: 'name', label: 'Name', type: 'text', hint: 'For example "Partner website" or "Zapier". Shown on every lead from this source.' }],
      submit: body => api('/api/admin/api-keys', { method: 'POST', json: { name: body.name } }),
      after: res => { $('#apiKeyNote').textContent = ''; openDrawer({ title: 'Copy this key now', sub: 'It will not be shown again.', body: `<p>Key for <b>${esc(res.name)}</b>:</p><pre style="white-space:pre-wrap;word-break:break-all;background:#f3f6fa;padding:12px;border-radius:8px">${esc(res.key)}</pre><p class="hint">Paste it into the other system's X-API-Key header. Anyone with this key can send leads, so keep it private.</p>` }); loadApiKeys(); }
    });
  }
  function addSignOutEverywhere() {
    const pm0 = document.getElementById('pwMsg');
    if (pm0 && !document.getElementById('nameForm')) { const f = document.createElement('form'); f.id = 'nameForm'; f.style.cssText = 'display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin:12px 0';
      f.innerHTML = `<div class="f" style="flex:1;min-width:200px"><label for="myName">Your name</label><input id="myName" value="${esc((state.me && state.me.name) || '')}" maxlength="120"></div><button class="btn ghost">Save name</button><span class="msg" id="nameMsg" role="status"></span>`;
      const pwForm = pm0.closest('form'); (pwForm || pm0).parentNode.insertBefore(f, pwForm || pm0);
      f.onsubmit = async ev => { ev.preventDefault(); try { const r = await api('/api/admin/account/name', { method: 'PUT', json: { name: $('#myName').value } }); if (state.me) state.me.name = r.name; const lbl = $('#whoRole'); if (lbl) lbl.textContent = [r.name, state.me && state.me.label].filter(Boolean).join(' · '); $('#nameMsg').textContent = 'Saved.'; } catch (e) { $('#nameMsg').textContent = e.message; } }; }
    const pm = document.getElementById('pwMsg'); if (!pm || document.getElementById('soEverywhere')) return;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost'; b.id = 'soEverywhere'; b.textContent = 'Sign out all other devices'; b.style.marginLeft = '8px';
    pm.parentNode.insertBefore(b, pm);
    b.onclick = async () => { if (!confirm('Sign out every other device and browser using your account? This device stays signed in.')) return;
      try { const r = await api('/api/admin/account/sign-out-everywhere', { method: 'POST', json: {} }); if (r.token) { token = r.token; localStorage.setItem(TOKEN_KEY, token); } pm.className = 'msg ok'; pm.textContent = r.message; } catch (e) { pm.className = 'msg err'; pm.textContent = e.message; } };
  }
  async function loadPhoneSettings() {
    let card = document.getElementById('phoneCard');
    if (!card) { card = document.createElement('div'); card.className = 'card'; card.id = 'phoneCard'; card.style.marginBottom = '16px'; const head = document.querySelector('#v-settings .pagehead'); head.parentNode.insertBefore(card, head.nextSibling); }
    let r; try { r = await api('/api/admin/phone/settings'); } catch (e) { card.innerHTML = `<h2>Phone</h2><p class="muted">${esc(e.message)}</p>`; return; }
    const warn = !r.ring_phones.length && r.render_forward_digits ? `<p class="msg err" style="margin:8px 0">The ring phone in Render (TWILIO_FORWARD_TO) has ${r.render_forward_digits} digits and isn't a valid US number, so incoming calls go straight to voicemail. Enter the phone(s) below instead.</p>` : '';
    card.innerHTML = `<h2>Phone</h2>
      <p class="muted">Calls to <b>${esc(r.number || 'your Twilio number')}</b> ring the phones below${r.softphone ? ' and this admin (browser phone on)' : ''}. Unanswered calls go to voicemail with a same-day follow-up.</p>
      <dl class="facts"><dt>Phone service</dt><dd>${r.connected ? '<span class="badge green">Connected</span>' : '<span class="badge amber">Not connected</span>'}</dd>
      <dt>Click-to-call</dt><dd>${r.can_dial && r.ring_phones.length ? '<span class="badge green">Ready</span>' : '<span class="badge amber">Needs a ring phone</span>'}</dd>
      <dt>Browser phone</dt><dd>${r.softphone ? '<span class="badge green">On</span>' : '<span class="badge amber">Off</span> <small class="muted">needs TWILIO_API_KEY + TWILIO_API_SECRET in Render</small>'}</dd></dl>${warn}
      <form id="ringForm" style="margin-top:10px"><div class="f"><label for="ringPh">Phones to ring (separate several with commas)</label><input id="ringPh" value="${esc(r.ring_phones.join(', '))}" placeholder="+1 469 267 8472, +1 515 329 5889"></div>
      <div class="formbar"><button class="btn">Save ring phones</button><span class="msg" id="ringMsg" role="status"></span></div></form>`;
    { const hb = document.createElement('div'); hb.style.marginTop = '14px';
      hb.innerHTML = `<form id="cbForm" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap"><div class="f" style="flex:1;min-width:220px"><label for="cbOwner">Callbacks and voicemails are assigned to</label><input id="cbOwner" type="email" value="${esc(r.callback_owner || '')}" placeholder="name@brightclean.net"></div><button class="btn ghost">Save</button><span class="msg" id="cbMsg" role="status"></span></form>
        <div style="margin-top:12px"><button class="btn" type="button" id="phHealth">Run health check</button> <small class="muted">Tests Twilio, the number's routing, a real AI request, ring phones and fallback.</small><div id="phHealthOut" style="margin-top:8px"></div></div>`;
      card.appendChild(hb);
      $('#cbForm').onsubmit = async ev => { ev.preventDefault(); try { await api('/api/admin/phone/callback-owner', { method: 'PUT', json: { email: $('#cbOwner').value } }); $('#cbMsg').textContent = 'Saved.'; } catch (e) { $('#cbMsg').textContent = e.message; } };
      $('#phHealth').onclick = async ev => { const b = ev.target; b.disabled = true; b.textContent = 'Checking…';
        try { const h = await api('/api/admin/phone/health'); const ic = { pass: '✅', warn: '⚠️', fail: '❌' };
          $('#phHealthOut').innerHTML = `<p><b>${ic[h.overall]} ${h.overall === 'pass' ? 'Everything is working' : h.overall === 'warn' ? 'Working, with warnings' : 'Something needs fixing'}</b> <small class="muted">${esc(new Date(h.checked_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</small></p><table class="tbl" style="width:100%"><tbody>${h.checks.map(c => `<tr><td style="width:28px">${ic[c.status]}</td><td><b>${esc(c.label)}</b><br><small class="muted">${esc(c.detail || '')}</small></td></tr>`).join('')}</tbody></table>`; }
        catch (e) { $('#phHealthOut').innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
        b.disabled = false; b.textContent = 'Run health check'; };
    }
    { const ai = r.ai_receptionist || { mode: 'off', hours: { days: [1, 2, 3, 4, 5], open: '08:00', close: '17:00' } }, D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const box = document.createElement('div'); box.style.marginTop = '18px';
      box.innerHTML = `<h3 class="secth">AI receptionist</h3><p class="muted">Answers calls as Bright Clean's virtual assistant: talks with the caller, creates the lead or complaint, arranges callbacks and transfers to a person on request. It never quotes prices or promises dates. ${ai.ai_key ? '' : '<b>Needs ANTHROPIC_API_KEY in Render.</b>'}</p>
        <form id="aiRecForm" class="ig"><div class="wide"><label for="aiMode">When should the AI answer?</label><select id="aiMode">${[['off', 'Off — people and voicemail only'], ['no_answer', 'When no one picks up (instead of voicemail)'], ['after_hours', 'After business hours'], ['always', 'Always (answers every call first)']].map(([v, t]) => `<option value="${v}"${ai.mode === v ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="wide"><label>Business hours (Central)</label><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${D.map((d, i) => `<label class="chk"><input type="checkbox" data-day="${i}"${ai.hours.days.includes(i) ? ' checked' : ''}> ${d}</label>`).join('')}
          <input id="aiOpen" type="time" value="${esc(ai.hours.open)}" style="width:auto"> to <input id="aiClose" type="time" value="${esc(ai.hours.close)}" style="width:auto"></div></div>
        <div class="formbar"><button class="btn">Save AI receptionist</button><span class="msg" id="aiRecMsg" role="status"></span></div></form>`;
      card.appendChild(box);
      const tb = document.createElement('div'); tb.style.marginTop = '14px';
      tb.innerHTML = `<h3 class="secth">Test the AI receptionist</h3><p class="muted">Type what a caller would say. It answers with the real AI, prompt and rules used on calls. Nothing is saved.</p>
        <div id="aiTestLog" style="border:1px solid #d6dee8;border-radius:10px;padding:10px;min-height:60px;max-height:260px;overflow:auto;font-size:14px;background:#fbfcfe"><span class="muted">e.g. “Hi, I need a quote for a final clean on a new 30,000 square foot office in Ankeny.”</span></div>
        <form id="aiTestForm" style="display:flex;gap:8px;margin-top:8px"><input id="aiTestIn" placeholder="Caller says…" style="flex:1"><button class="btn">Send</button><button class="btn ghost" type="button" id="aiTestReset">Reset</button></form>`;
      card.appendChild(tb); let conv = [];
      const draw = () => { $('#aiTestLog').innerHTML = conv.map(m => `<div style="margin:4px 0"><b>${m.role === 'ai' ? '🤖 Receptionist' : '📞 Caller'}:</b> ${esc(m.text)}${m.actions && m.actions.length ? `<div class="muted" style="font-size:12px">↳ would ${m.actions.map(a => esc(a.action.replace(/_/g, ' ')) + (a.details && Object.keys(a.details).length ? ' (' + esc(Object.entries(a.details).map(([k, v]) => k + ': ' + v).join(', ')).slice(0, 220) + ')' : '')).join('; ')}</div>` : ''}</div>`).join(''); $('#aiTestLog').scrollTop = 1e6; };
      $('#aiTestReset').onclick = () => { conv = []; $('#aiTestLog').innerHTML = '<span class="muted">Reset.</span>'; };
      $('#aiTestForm').onsubmit = async ev => { ev.preventDefault(); const t = $('#aiTestIn').value.trim(); if (!t) return; conv.push({ role: 'caller', text: t }); $('#aiTestIn').value = ''; draw();
        try { const r = await api('/api/admin/ai-receptionist/test', { method: 'POST', json: { messages: conv } }); conv.push({ role: 'ai', text: r.reply, actions: r.actions }); } catch (e) { conv.push({ role: 'ai', text: '⚠ ' + e.message }); } draw(); };
      $('#aiRecForm').onsubmit = async ev => { ev.preventDefault(); try { await api('/api/admin/phone/settings', { method: 'PUT', json: { ai_mode: $('#aiMode').value, ai_hours: { days: $$('#aiRecForm [data-day]').filter(x => x.checked).map(x => Number(x.dataset.day)), open: $('#aiOpen').value, close: $('#aiClose').value } } }); $('#aiRecMsg').textContent = 'Saved.'; } catch (e) { $('#aiRecMsg').textContent = e.message; } };
    }
    $('#ringForm').onsubmit = async ev => { ev.preventDefault(); try { const x = await api('/api/admin/phone/settings', { method: 'PUT', json: { ring_phones: $('#ringPh').value } }); phoneCfg = null; $('#ringMsg').textContent = 'Saved.'; setTimeout(loadPhoneSettings, 600); } catch (e) { $('#ringMsg').textContent = e.message; } };
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
    $('#userList').innerHTML = users.map(u => `<div class="userrow"><span><b>${esc(u.name || u.email)}</b><small>${esc(u.email)} · ${esc(u.role ? u.role[0].toUpperCase() + u.role.slice(1) : (u.owner ? 'Owner' : 'Staff'))}${['owner', 'manager'].includes(u.role) ? ' (can approve proposals)' : ''}${u.last_login_at ? ' · last signed in ' + esc(ago(u.last_login_at)) : ''}</small></span>${u.id && !u.env_owner ? `<select data-role="${u.id}" aria-label="Role for ${esc(u.email)}"${canRoles ? '' : ' disabled'}>${['owner', 'manager', 'supervisor', 'inspector', 'sales', 'staff'].map(r => `<option value="${r}"${u.role === r ? ' selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select>` : ''}${!u.owner && u.email !== me && u.id ? `<button class="btn small danger" data-deluser="${u.id}" data-email="${esc(u.email)}">Remove</button>` : ''}</div>`).join('');
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

  // ---------- Icons, sidebar and top bar ----------
  const IC = {
    overview: '<path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/>', leads: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
    customers: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4M9 9h.01M15 9h.01M9 13h.01M15 13h.01"/>', issues: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/>',
    calls: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
    emails: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', proposals: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    contracts: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="m9 15 2 2 4-4"/>', projects: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
    invoices: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>', schedule: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    quality: '<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"/><path d="m9 12 2 2 4-4"/>', documents: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    takeoffs: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>', reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', scopes: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/>',
    activity: '<path d="M22 12h-4l-3 8-6-16-3 8H2"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    note: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', pin: '<path d="M12 22s7-6.1 7-12a7 7 0 0 0-14 0c0 5.9 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>', check: '<path d="M20 6 9 17l-5-5"/>', money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', plus: '<path d="M12 5v14M5 12h14"/>', edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    chev: '<path d="m9 6 6 6-6 6"/>', trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>', send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>'
  };
  IC.estimator = IC.proposals; IC.customer = IC.customers; IC.website = IC.documents || IC.overview;
  const ic = (k, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${IC[k] || IC.overview}</svg>`;
  $$('#nav button').forEach(b => { if (!b.querySelector('.ic')) b.insertAdjacentHTML('afterbegin', ic(b.dataset.view)); });
  $$('.tbicons [data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  const kt = (icon, tone, label, value, sub) => `<div class="ktile"><span class="chip ${tone}">${ic(icon)}</span><div style="min-width:0"><span>${esc(label)}</span><b>${esc(value)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div></div>`;
  async function loadTopbar() {
    // Identity comes from /me for the signed-in account, so it can never show someone else's name or role.
    try { const me = await api('/api/admin/me'); $('#tbName').textContent = me.name && me.name !== 'Owner' ? me.name : me.email || ''; $('#tbRole').textContent = me.label || me.role || ''; } catch { /* identity is optional here */ }
    // Badges load separately: a role that cannot see one of these (e.g. inspectors have no issues or email) just shows no badge.
    const get = p => api(p).catch(() => null);
    const setDot = (id, n) => { $(id).hidden = !n; $(id).textContent = n > 99 ? '99+' : n; };
    const [iss, mail, calls] = await Promise.all([get('/api/admin/issues?status=open'), get('/api/admin/emails'), get('/api/admin/calls')]);
    setDot('#tbAlerts', iss ? (iss.issues || []).filter(i => i.type === 'complaint' || i.overdue).length : 0);
    setDot('#tbMail', mail && mail.summary ? mail.summary.failed_30d : 0);
    setDot('#tbCalls', calls ? calls.follow_ups_due || 0 : 0);
  }
  setInterval(() => { if (document.visibilityState === 'visible' && token) loadTopbar(); }, 60000);

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
      else if (d.type === 'file') ctl = `<input id="${id}" name="${d.name}" type="file"${d.single ? '' : ' multiple'} accept="${d.accept || '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.zip'}">`;
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
  const KT_ICONS = [['overview', 'blue'], ['check', 'green'], ['money', 'navy'], ['clock', 'amber'], ['reports', 'teal'], ['leads', 'purple']];
  const kpiTiles = (el, tiles) => { const box = $(el); box.classList.add('kpis6'); box.classList.remove('small'); box.innerHTML = tiles.map((t, i) => { const [ico, tone] = t.alert ? ['issues', 'red'] : KT_ICONS[i % KT_ICONS.length];
    return `<div class="kpi ktile${t.alert ? ' alert' : ''}"><span class="chip ${tone}">${ic(ico)}</span><div style="min-width:0"><span>${esc(t.label)}</span><b>${esc(t.value)}</b>${t.sub ? `<small class="flat">${esc(t.sub)}</small>` : ''}</div></div>`; }).join(''); };

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
  $('#callFollow').addEventListener('change', () => { savePref('calls_filters', { follow: $('#callFollow').checked, vm: !!($('#callVm') && $('#callVm').checked) }); renderCalls(); });
  if ($('#callVm')) $('#callVm').addEventListener('change', () => { savePref('calls_filters', { follow: $('#callFollow').checked, vm: $('#callVm').checked }); renderCalls(); });
  const handlingOf = c => c.handling || (c.source === 'Browser' ? 'Browser' : c.outcome === 'Voicemail' ? 'Voicemail' : ['Twilio', 'Click-to-call'].includes(c.source) ? 'Human' : 'Manual');
  async function loadCalls() {
    if (!document.getElementById('dialPadBtn')) { const h = document.querySelector('#v-calls .pagehead'); if (h) { const btn = document.createElement('button'); btn.className = 'btn'; btn.id = 'dialPadBtn'; btn.type = 'button'; btn.textContent = '📞 Call a number'; btn.onclick = () => openDialPad(); const wrap = h.querySelector('.headact') || h; wrap.appendChild(btn); } }
    const r = await api('/api/admin/calls'); Object.assign(callState, r);
    kpiTiles('#callsKpis', [{ label: "Today's calls", value: r.today.total }, { label: 'Answered', value: r.today.answered }, { label: 'Missed / voicemail', value: r.today.missed, alert: r.today.missed > 0 }, { label: 'Follow-ups due', value: r.follow_ups_due, alert: r.follow_ups_due > 0 }]);
    $('#navCalls').hidden = !r.follow_ups_due; $('#navCalls').textContent = r.follow_ups_due;
    renderCalls();
    api('/api/admin/calls-intel').then(x => { const el = $('#callsIntel'); if (!el) return;
      el.innerHTML = `<div class="st"><span>Phone capture</span><b style="font-size:15px;color:${x.connected ? '#17904c' : '#a06a00'}">${x.connected ? 'Connected (Twilio)' : 'Not connected'}</b><small>${x.connected ? (x.forwarding ? 'calls ring your phone, log automatically' : 'calls go to voicemail, log automatically') : 'calls are logged by hand'}</small>${x.connected ? '' : `<small style="word-break:break-all">Twilio voice URL: ${esc(x.voice_url || '')}</small>`}</div>
        ${x.receptionist ? `<div class="st" style="cursor:pointer" data-go-settings title="Change in Settings → Phone"><span>AI receptionist</span><b style="font-size:15px;color:${x.receptionist.answering_now ? '#17904c' : '#a06a00'}">${x.receptionist.mode === 'off' ? 'Off' : !x.receptionist.key ? 'Needs AI key' : x.receptionist.answering_now ? 'On' : 'Waiting (business hours)'}</b><small>${esc({ off: 'people and voicemail only', no_answer: 'answers when no one picks up', after_hours: 'answers after hours', always: 'answers every call first' }[x.receptionist.mode] || '')}</small></div>` : ''}        <div class="st"><span>Last 30 days</span><b>${x.total_30}</b><small>${x.missed_30} missed</small></div>${x.by_intent.slice(0, 3).map(i => `<div class="st"><span>${esc(i.k)}</span><b>${i.n}</b><small>calls (AI)</small></div>`).join('')}
        <div class="st"><span>Hot leads (score 70+)</span><b>${x.hot_leads.length}</b><small>${x.hot_leads.slice(0, 2).map(h => esc(h.company || h.contact_name || '')).join(', ')}</small></div>`; el.querySelectorAll('[data-go-settings]').forEach(b => b.onclick = () => { location.hash = '#settings'; }); }).catch(() => {});
  }
  function renderCalls() {
    const q = $('#callSearch').value.trim().toLowerCase(), due = $('#callFollow').checked, vm = !!($('#callVm') && $('#callVm').checked), t = todayISO();
    const rows = callState.calls.filter(c => (!q || [c.contact_name, c.company, c.phone, c.summary, c.customer_company].join(' ').toLowerCase().includes(q)) && (!due || (!c.follow_up_done && c.follow_up_date && c.follow_up_date <= t)) && (!vm || c.outcome === 'Voicemail'));
    $('#callsRows').innerHTML = rows.length ? rows.map(c => `<tr class="click" data-call="${c.id}"><td>${esc(fmtWhen(c.created_at))}<small>${esc(c.direction)}</small></td><td><b>${esc(c.company || c.customer_company || c.contact_name || '—')}</b> <span class="pill" style="font-size:11px" title="How this call was handled">${esc(handlingOf(c))}</span><small>${esc([c.contact_name, c.phone].filter(Boolean).join(' · '))}</small></td><td>${badge(c.purpose)}</td><td>${c.outcome === 'Answered' ? esc(c.outcome) : `<span class="badge amber">${esc(c.outcome)}</span>`}</td><td>${esc((c.summary || '').slice(0, 90))}</td><td class="${!c.follow_up_done && c.follow_up_date && c.follow_up_date <= t ? 'late' : ''}">${c.follow_up_date ? (c.follow_up_done ? 'Done' : fmtDate(c.follow_up_date)) : '—'}</td></tr>`).join('')
      : `<tr><td class="emptyrow" colspan="6">No calls logged${q || due || vm ? ' match' : ' yet'}.</td></tr>`;
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
  async function openCall(c0) {
    let d; try { d = await api(`/api/admin/calls/${c0.id}/detail`); } catch (e) { return toast(e.message, true); }
    const c = d.call, a = c.ai, tone = { Positive: 'green', Neutral: '', Negative: 'red' };
    const aiHtml = a ? `<div class="card" style="margin:10px 0"><h3 class="secth" style="margin-top:0">AI call analysis <small class="muted">suggestion · ${fmtWhen(a.at)}</small></h3>
        <p>${esc(a.summary)}</p><p><span class="badge blue">${esc(a.intent)}</span> <span class="badge ${tone[a.sentiment] || ''}">${esc(a.sentiment)}</span> <span class="badge ${a.urgency === 'High' ? 'red' : ''}">Urgency: ${esc(a.urgency)}</span>${a.lead_score != null ? ` <span class="badge ${a.lead_score >= 70 ? 'green' : a.lead_score >= 40 ? 'amber' : ''}">Lead score ${a.lead_score}</span>` : ''}</p>
        ${a.score_reasons.length ? `<p class="muted">${a.score_reasons.map(esc).join(' · ')}</p>` : ''}
        ${Object.entries(a.details || {}).some(([, v]) => v) ? `<dl class="facts">${Object.entries(a.details).filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k.replace('_', ' '))}</dt><dd>${esc(typeof v === 'number' ? v.toLocaleString() : v)}</dd>`).join('')}</dl>` : ''}
        ${a.action_items.length ? `<p><b>Action items</b></p><ul>${a.action_items.map(x => `<li>${esc(x.task)} <small class="muted">${esc(x.owner || '')}${x.due ? ' · by ' + esc(x.due) : ''}</small></li>`).join('')}</ul>` : ''}
        ${a.risks.length ? `<p class="err" style="display:block">${a.risks.map(esc).join('<br>')}</p>` : ''}
        ${a.follow_up_date ? `<p>Suggested follow-up: <b>${esc(a.follow_up_date)}</b> <button class="btn small ghost" id="callUseFu" type="button">Set as follow-up</button></p>` : ''}
        ${a.reply_draft ? `<p><b>Reply draft</b> <button class="btn small ghost" id="callCopy" type="button">Copy</button></p><div class="pre" style="white-space:pre-wrap;background:#f6f9fc;border-radius:8px;padding:10px">${esc(a.reply_draft)}</div>` : ''}</div>` : '';
    openDrawer({ title: c.company || c.customer_company || c.contact_name || c.phone || 'Call', sub: `${esc(c.direction)} · ${fmtWhen(c.created_at)}${c.source === 'Twilio' ? ' · captured automatically' : c.created_by ? ' · logged by ' + esc(c.created_by) : ''}`,
      body: `<dl class="facts"><dt>Caller</dt><dd>${esc(c.contact_name || '—')}</dd><dt>Handled by</dt><dd>${esc(handlingOf(c))}</dd><dt>Phone</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a> <button type="button" class="btn small ghost" data-dial="${esc(c.phone)}" data-cust="${c.customer_id || ''}" data-name="${esc(c.company || c.contact_name || '')}">📞 Call back</button>` : '—'}</dd><dt>Customer</dt><dd>${esc(c.customer_company || c.customer_name || 'Not linked')}</dd><dt>Purpose</dt><dd>${esc(c.purpose)}</dd><dt>Outcome</dt><dd>${esc(c.outcome)}${c.duration_s ? ` · ${Math.round(c.duration_s / 60 * 10) / 10} min` : ''}</dd>
        <dt>Follow-up</dt><dd>${c.follow_up_date ? esc(c.follow_up_date) + (c.follow_up_done ? ' (done)' : '') : '—'}</dd>${c.issue_id ? `<dt>Issue</dt><dd>Issue #${c.issue_id} created from this call</dd>` : ''}${c.lead_id ? `<dt>Lead</dt><dd><button class="linklike" id="callLead">Open lead #${c.lead_id}</button></dd>` : ''}${c.recording_url ? `<dt>${c.outcome === 'Voicemail' ? 'Voicemail' : 'Recording'}</dt><dd id="recBox"><button type="button" class="btn small" id="recPlay">▶ Play ${c.outcome === 'Voicemail' ? 'voicemail' : 'recording'}</button></dd>` : ''}</dl>
        ${c.summary ? `<p>${esc(c.summary)}</p>` : ''}${aiHtml}
        <label for="callTr"><b>Transcript or detailed notes</b></label><textarea id="callTr" rows="6" style="width:100%" placeholder="Paste the call transcript or write what was said…">${esc(c.transcript || '')}</textarea>
        <h3 class="secth">History</h3><div class="activity">${renderActivity(d.history) || '<p class="muted">No activity.</p>'}</div>`,
      footer: `<button class="btn ghost" data-close>Close</button>${!c.customer_id && c.phone ? '<button class="btn" id="callSaveCust">Save as customer</button>' : ''}${c.customer_id && !c.issue_id ? '<button class="btn ghost" id="callIssue">Create issue</button>' : ''}<button class="btn ghost" id="callAnalyze">${a ? 'Re-analyze' : 'Analyze with AI'}</button>${c.follow_up_date && !c.follow_up_done ? '<button class="btn" id="callDone">Mark follow-up done</button>' : ''}` });
    const act = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    act('#callLead', () => { closeDrawer(); go('leads'); openLead(c.lead_id); });
    act('#callSaveCust', () => openSaveCaller(c));
    api('/api/admin/quality/complaints?call_id=' + c.id).then(r => { const k = (r.complaints || [])[0]; if (!k) return; const dl = document.querySelector('#drawerRoot dl.facts'); if (!dl) return; dl.insertAdjacentHTML('afterbegin', `<dt>Complaint case</dt><dd><a href="#" id="callCmp">${esc(k.number)}</a> <small class="muted">${esc(k.status_label)}</small></dd>`); $('#callCmp').onclick = ev => { ev.preventDefault(); closeDrawer(); go('quality'); setTimeout(() => openComplaint(k.id), 350); }; }).catch(() => {});
    if ($('#recPlay')) $('#recPlay').onclick = async ev => {
      const btn = ev.target; btn.disabled = true; btn.textContent = 'Loading…';
      try {
        const r = await fetch(`/api/admin/calls/${c.id}/recording`, { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) { let m = 'Could not load the recording.'; try { m = (await r.json()).error || m; } catch { /* */ } throw new Error(m); }
        const url = URL.createObjectURL(await r.blob());
        $('#recBox').innerHTML = `<audio controls autoplay src="${url}" style="width:100%;max-width:340px;display:block"></audio><a href="${url}" download="call-${c.id}.mp3" class="muted" style="font-size:12px">Download MP3</a>`;
      } catch (e) { btn.disabled = false; btn.textContent = '▶ Try again'; toast(e.message, true); }
    };
    act('#callIssue', async () => { try { const r = await api(`/api/admin/calls/${c.id}/issue`, { method: 'POST', json: {} }); toast(`${r.issue.number} created from this call`); closeDrawer(); go('issues'); openIssue(r.issue); } catch (e) { toast(e.message, true); } });
    act('#callDone', async () => { try { await api('/api/admin/calls/' + c.id, { method: 'PATCH', json: { follow_up_done: true } }); toast('Follow-up done'); closeDrawer(); loadCalls(); } catch (e) { toast(e.message, true); } });
    act('#callAnalyze', async () => { const b = $('#callAnalyze'); b.disabled = true; b.textContent = 'Analyzing…'; try { await api(`/api/admin/ai/calls/${c.id}/analyze`, { method: 'POST', json: { transcript: $('#callTr').value } }); toast('Call analyzed'); loadCalls(); openCall(c); } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Analyze with AI'; } });
    act('#callUseFu', async () => { try { await api('/api/admin/calls/' + c.id, { method: 'PATCH', json: { follow_up_date: a.follow_up_date, follow_up_done: false } }); toast('Follow-up set for ' + a.follow_up_date); loadCalls(); openCall(c); } catch (e) { toast(e.message, true); } });
    act('#callCopy', async () => { try { await navigator.clipboard.writeText(a.reply_draft); toast('Reply copied'); } catch { toast('Select the text to copy', true); } });
    $$('#drawerRoot [data-close]').forEach(el => el.onclick = closeDrawer);
  }

  // ---------- Schedule ----------
  const schedState = { visits: [], options: null };
  $('#scheduleAdd').addEventListener('click', () => scheduleVisit());
  $('#schedRange').addEventListener('change', () => loadSchedule());
  $('#schedMode').addEventListener('change', () => { if ($('#schedMode').value === 'week' && $('#schedRange').value === 'past') $('#schedRange').value = '14'; loadSchedule(); });
  async function loadSchedule() {
    const v = $('#schedRange').value, t = new Date();
    const from = v === 'past' ? new Date(t - 30 * 864e5) : t, to = v === 'past' ? t : new Date(+t + Number(v) * 864e5);
    const r = await api(`/api/admin/visits?from=${localISO(from)}&to=${localISO(to)}`); Object.assign(schedState, r);
    const items = [...r.visits.map(x => ({ ...x, kind: 'visit' })), ...r.project_due.map(p => ({ kind: 'due', id: p.id, date: p.due_date, title: `Due: ${p.name || p.customer_name}`, status: p.status, type: 'Project due' }))].sort((a, b) => (a.date + (a.start_time || '')).localeCompare(b.date + (b.start_time || '')));
    const week = r.visits.filter(x => x.status === 'Scheduled' && x.date <= localISO(new Date(+t + 7 * 864e5))).length;
    loadDispatch();
    const mode = $('#schedMode').value; $('#schedWeek').hidden = mode !== 'week'; $('#schedTable').hidden = mode === 'week';
    if (mode === 'week') {
      const start = new Date(); start.setHours(12, 0, 0, 0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return localISO(d); });
      $('#schedWeek').innerHTML = days.map(day => `<div class="day${day === todayISO() ? ' today' : ''}"><h3>${new Date(day + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</h3>${items.filter(x => x.date === day).map(x => x.kind === 'due' ? `<button class="ev due" data-due="${x.id}">${esc(x.title)}</button>` : `<button class="ev${x.status === 'Done' ? ' done' : ''}" data-visit="${x.id}"><b>${esc(x.start_time || '')}</b> ${esc(x.title)}</button>`).join('') || '<small class="muted">—</small>'}</div>`).join('');
    }
    $('#scheduleRows').innerHTML = items.length ? items.map(x => x.kind === 'due'
      ? `<tr class="click" data-due="${x.id}"><td>${fmtDate(x.date)}</td><td>—</td><td><b>${esc(x.title)}</b><small>Project due date</small></td><td>—</td><td>—</td><td>${badge(x.status)}</td></tr>`
      : `<tr class="click" data-visit="${x.id}"><td>${fmtDate(x.date)}</td><td>${esc([x.start_time, x.end_time].filter(Boolean).join('–') || 'Any time')}</td><td><b>${esc(x.title)}</b><small>${esc(x.type)}${x.address ? ' · ' + esc(x.address) : ''}</small></td><td>${esc(x.project_name || x.customer_company || x.customer_name || '—')}</td><td>${esc(x.assigned_to || '—')}${x.crew_size ? `<small>crew ${x.crew_size}</small>` : ''}</td><td>${badge(x.status)}</td></tr>`).join('')
      : '<tr><td class="emptyrow" colspan="6">Nothing scheduled in this range.</td></tr>';
    $$('#v-schedule [data-visit]').forEach(r => r.onclick = () => openJob(Number(r.dataset.visit)));
    $$('#v-schedule [data-due]').forEach(r => r.onclick = () => { go('projects'); openRecord('projects', Number(r.dataset.due)); });
  }
  // ---------- Dispatch center (board, employees, time, job panel) ----------
  const disp = { tab: 'cal', board: null, emps: null };
  $$('#schTabs button').forEach(b => b.onclick = () => { disp.tab = b.dataset.sp; $$('#schTabs button').forEach(x => x.classList.toggle('on', x === b)); ['cal', 'board', 'emp', 'time'].forEach(k => $('#sp-' + k).hidden = k !== disp.tab); drawDispTab(); });
  $('#empAdd').addEventListener('click', () => editEmployee(null));
  async function loadDispatch() {
    try { disp.board = await api('/api/admin/dispatch/board?date=' + todayISO()); } catch (e) { return; }
    const k = disp.board.kpis;
    $('#scheduleKpis').innerHTML = [kt('cal', 'blue', "Today's jobs", k.today, k.in_progress ? `${k.in_progress} in progress` : ''), kt('leads', 'green', 'Crews dispatched', k.dispatched_crews, 'Active today'), kt('issues', 'red', 'Unassigned jobs', k.unassigned, 'This week'), kt('check', 'green', 'Completed today', k.completed_today, ''),
      kt('schedule', 'blue', 'Jobs this week', k.week, ''), kt('clock', 'red', 'Overdue jobs', k.overdue, k.overdue ? 'Action required' : ''), kt('user', 'teal', 'Employee availability', `${k.available} / ${k.staff}`, 'Available today'), kt('issues', 'amber', 'Conflicts', k.conflicts, k.conflicts ? 'Double-booked or off' : 'None')]
      .map((h, n) => (n === 5 && k.overdue) || (n === 7 && k.conflicts) || (n === 2 && k.unassigned) ? h.replace('class="ktile"', 'class="ktile alert"') : h).join('');
    const today = disp.board.visits.filter(v => v.date === todayISO() && !['Cancelled', 'Skipped'].includes(v.status));
    const un = disp.board.visits.filter(v => v.date >= todayISO() && !v.crew.length && !['Cancelled', 'Skipped', 'Done'].includes(v.status)).slice(0, 6);
    $('#schSide').innerHTML = `<div class="card"><h2 style="font-size:17px">Dispatch board – today</h2>${today.length ? today.map(v => `<div class="jobcard" data-job="${v.id}"><span class="chip ${v.dispatched_at ? 'green' : 'amber'}">${ic('leads')}</span><span style="min-width:0;flex:1"><b>${esc(v.title)}</b><small>${esc(v.start_time || '')}${v.end_time ? '–' + esc(v.end_time) : ''} · ${v.crew.length ? esc(v.crew.map(c => c.name).join(', ')) : 'No crew'}</small></span>${v.status === 'Done' ? badge('Done') : v.dispatched_at ? '<span class="badge green">Dispatched</span>' : '<span class="badge amber">Needs dispatch</span>'}</div>`).join('') : '<p class="muted">Nothing scheduled today.</p>'}</div>
      <div class="card"><h2 style="font-size:17px">Unassigned jobs (${un.length})</h2>${un.length ? un.map(v => `<div class="jobcard"><span style="flex:1;min-width:0"><b>${esc(v.title)}</b><small>${fmtDate(v.date)} · ${esc(v.start_time || 'any time')}${v.crew_needed ? ` · ${v.crew_needed} needed` : ''}</small></span><button class="btn small" data-job="${v.id}">Assign</button></div>`).join('') : '<p class="muted">Every upcoming job has a crew.</p>'}</div>
      <div class="card"><h2 style="font-size:17px">Upcoming deadlines</h2>${disp.board.deadlines.length ? disp.board.deadlines.map(p => `<p style="margin:6px 0"><button class="linklike" data-rec="projects:${p.id}">${esc(p.name || 'Project #' + p.id)}</button><br><small class="muted">Due ${fmtDate(p.due_date)} · ${esc(p.status)}</small></p>`).join('') : '<p class="muted">No project deadlines coming up.</p>'}
      ${disp.board.conflicts.length ? `<h3 class="secth" style="color:#d1382f">Conflicts</h3>${disp.board.conflicts.map(c => `<p class="muted" style="margin:4px 0"><button class="linklike" data-job="${c.visit_id}">${esc(c.title)}</button> ${fmtDate(c.date)}: ${esc(c.problem)}</p>`).join('')}` : ''}</div>`;
    $$('#schSide [data-job]').forEach(el => el.onclick = () => openJob(Number(el.dataset.job)));
    bindOpeners($('#schSide'));
    if (disp.tab !== 'cal') drawDispTab();
  }
  async function drawDispTab() {
    if (disp.tab === 'board' && disp.board) {
      const days = [...new Set(disp.board.visits.filter(v => v.date >= todayISO()).map(v => v.date))].slice(0, 7);
      $('#sp-board').innerHTML = days.length ? days.map(d => `<div class="card"><h2 style="font-size:16px">${new Date(d + 'T12:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}${disp.board.holidays.some(h => h.date === d) ? ' <span class="badge amber">Holiday</span>' : ''}</h2>${disp.board.visits.filter(v => v.date === d).map(v => `<div class="jobcard" data-job="${v.id}"><span class="chip ${v.crew.length ? 'blue' : 'red'}">${ic('projects')}</span><span style="flex:1;min-width:0"><b>${esc(v.title)}</b><small>${esc(v.start_time || '')}–${esc(v.end_time || '')} · ${esc(v.address || '')}</small><small>${v.crew.length ? 'Crew: ' + esc(v.crew.map(c => c.name).join(', ')) : 'No crew assigned'}</small></span>${badge(v.status)}${v.dispatched_at ? '<span class="badge green">Dispatched</span>' : ''}</div>`).join('')}</div>`).join('') : '<div class="card"><p class="muted">No upcoming jobs.</p></div>';
      $$('#sp-board [data-job]').forEach(el => el.onclick = () => openJob(Number(el.dataset.job)));
    } else if (disp.tab === 'emp') {
      const r = await api('/api/admin/employees'); disp.emps = r;
      $('#sp-emp').innerHTML = `<div class="tablewrap card" style="padding:0"><table class="t"><thead><tr><th>Employee</th><th>Role / crew</th><th>Skills</th><th>Today</th><th>This week</th><th class="num">Rate</th><th></th></tr></thead><tbody>${r.employees.map(e => `<tr><td><b>${esc(e.name)}</b><small>${esc(e.phone || e.email || '')}</small></td><td>${esc(e.role || '')}${e.crew ? ' · Crew ' + esc(e.crew) : ''}</td><td><small>${esc(e.skills || '—')}</small></td><td>${!e.active ? '<span class="badge">Inactive</span>' : e.off ? `<span class="badge amber">Off: ${esc(e.off)}</span>` : e.available ? `<span class="badge green">Available</span> <small>${e.jobs_on_date} job(s)</small>` : '<span class="badge">Not scheduled</span>'}</td><td>${e.week_hours} / ${e.max_week_hours} h</td><td class="num">${money(e.hourly_rate)}</td>
        <td><button class="btn small ghost" data-ee="${e.id}">Edit</button> <button class="btn small ghost" data-to="${e.id}">Time off</button> <button class="btn small ghost" data-link="${e.id}">Crew link</button></td></tr>`).join('') || '<tr><td class="emptyrow" colspan="7">No employees yet. Click “Add employee”.</td></tr>'}</tbody></table></div>
        <div class="two"><div class="card"><h2 style="font-size:16px">Time off</h2>${r.timeoff.map(t => `<p style="margin:4px 0">${esc(t.name)}: ${fmtDate(t.start_date)}${t.end_date !== t.start_date ? ' – ' + fmtDate(t.end_date) : ''} <small class="muted">${esc(t.reason || '')}</small></p>`).join('') || '<p class="muted">None recorded.</p>'}</div>
        <div class="card"><h2 style="font-size:16px">Company holidays</h2>${r.holidays.map(h => `<p style="margin:4px 0">${fmtDate(h.date)} · ${esc(h.name)}</p>`).join('') || '<p class="muted">None.</p>'}<button class="btn small ghost" id="holAdd">Add holiday</button></div></div>`;
      $$('#sp-emp [data-ee]').forEach(b => b.onclick = () => editEmployee(r.employees.find(e => e.id === Number(b.dataset.ee))));
      $$('#sp-emp [data-to]').forEach(b => b.onclick = () => openForm({ title: 'Record time off', defs: [{ name: 'start_date', label: 'From', type: 'date' }, { name: 'end_date', label: 'To', type: 'date' }, { name: 'reason', label: 'Reason', wide: true }], submit: x => api(`/api/admin/employees/${b.dataset.to}/timeoff`, { method: 'POST', json: x }), after: x => { toast(x.needs_reassignment.length ? `Saved. ${x.needs_reassignment.length} job(s) need a new crew member.` : 'Time off saved'); loadDispatch(); drawDispTab(); } }));
      $$('#sp-emp [data-link]').forEach(b => b.onclick = async () => { try { const x = await api(`/api/admin/employees/${b.dataset.link}/link`); const url = location.origin + x.url; try { await navigator.clipboard.writeText(url); toast('Crew link copied. Send it to the employee by text.'); } catch { prompt('Crew link (private, send by text):', url); } } catch (e) { toast(e.message, true); } });
      $('#holAdd').onclick = () => openForm({ title: 'Add company holiday', defs: [{ name: 'date', label: 'Date', type: 'date' }, { name: 'name', label: 'Name' }], submit: x => api('/api/admin/holidays', { method: 'POST', json: x }), after: x => { toast(x.affected.length ? `Holiday saved. ${x.affected.length} scheduled job(s) fall on it.` : 'Holiday saved'); drawDispTab(); } });
    } else if (disp.tab === 'time') {
      const r = await api('/api/admin/time');
      $('#sp-time').innerHTML = `<div class="sumbar card"><div><span>Hours (14 days)</span><b>${(r.totals.minutes / 60).toFixed(1)}</b></div><div><span>Labor cost</span><b>${money(r.totals.cost)}</b></div><div><span>Clocked in now</span><b>${r.totals.open}</b></div><div><span>Awaiting approval</span><b>${r.totals.unapproved}</b></div></div>
        <button class="btn" id="timeAdd">Add time entry</button>
        <div class="tablewrap card" style="padding:0;margin-top:10px"><table class="t"><thead><tr><th>Employee</th><th>Job / project</th><th>In</th><th>Out</th><th class="num">Hours</th><th class="num">Cost</th><th>Source</th><th></th></tr></thead><tbody>${r.entries.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.visit_title || '')}<small>${esc(t.project_name || '')}</small></td><td>${fmtWhen(t.clock_in)}</td><td>${t.clock_out ? fmtWhen(t.clock_out) : '<span class="badge green">On the clock</span>'}</td><td class="num">${t.minutes ? (t.minutes / 60).toFixed(2) : '—'}</td><td class="num">${money(t.cost)}</td><td>${esc(t.source)}</td><td>${t.approved_by ? `<small class="muted">Approved by ${esc(t.approved_by)}</small>` : t.clock_out ? `<button class="btn small" data-ap="${t.id}">Approve</button>` : ''}</td></tr>`).join('') || '<tr><td class="emptyrow" colspan="8">No time recorded yet. Crews check in and out from their crew link.</td></tr>'}</tbody></table></div>`;
      $$('#sp-time [data-ap]').forEach(b => b.onclick = async () => { try { const x = await api(`/api/admin/time/${b.dataset.ap}/approve`, { method: 'POST' }); toast(x.posted ? `Approved. ${money(x.cost)} labor posted to the project.` : 'Approved'); drawDispTab(); } catch (e) { toast(e.message, true); } });
      $('#timeAdd').onclick = async () => { const em = disp.emps || await api('/api/admin/employees'); openForm({ title: 'Add time entry', defs: [{ name: 'employee_id', label: 'Employee', type: 'select', options: em.employees.map(e => [e.id, e.name]) }, { name: 'clock_in', label: 'Start', type: 'datetime-local' }, { name: 'clock_out', label: 'End', type: 'datetime-local' }, { name: 'note', label: 'Note', wide: true }], submit: x => api('/api/admin/time', { method: 'POST', json: { ...x, clock_in: new Date(x.clock_in).toISOString(), clock_out: new Date(x.clock_out).toISOString() } }), after: () => { toast('Time entry added'); drawDispTab(); } }); };
    }
  }
  function editEmployee(e) {
    openForm({ title: e ? 'Edit employee' : 'Add employee', defs: [{ name: 'name', label: 'Name' }, { name: 'role', label: 'Role', type: 'select', options: ['Cleaner', 'Lead', 'Supervisor', 'Window tech', 'Driver', 'Inspector'] }, { name: 'phone', label: 'Mobile phone' }, { name: 'email', label: 'Email (for dispatch notices)' }, { name: 'crew', label: 'Crew (e.g. A)' }, { name: 'skills', label: 'Skills / certifications (comma separated)', wide: true }, { name: 'hourly_rate', label: 'Hourly rate ($)' }, { name: 'max_week_hours', label: 'Weekly hour limit' }, { name: 'day_start', label: 'Usual start', type: 'time' }, { name: 'day_end', label: 'Usual end', type: 'time' }, { name: 'work_days', label: 'Work days (1=Mon … 7=Sun)' }],
      values: e || { role: 'Cleaner', max_week_hours: 40, day_start: '07:00', day_end: '17:00', work_days: '1,2,3,4,5' }, submit: b => api(e ? '/api/admin/employees/' + e.id : '/api/admin/employees', { method: e ? 'PATCH' : 'POST', json: b }), after: () => { toast('Saved'); loadDispatch(); if (disp.tab === 'emp') drawDispTab(); } });
  }
  async function openJob(id) {
    let c, v;
    try { [c] = await Promise.all([api(`/api/admin/dispatch/visits/${id}/candidates`)]); if (!disp.board) disp.board = await api('/api/admin/dispatch/board?date=' + todayISO()); v = disp.board.visits.find(x => x.id === id) || (schedState.visits || []).find(x => x.id === id); } catch (e) { return toast(e.message, true); }
    if (!v) { const r = await api('/api/admin/dispatch/board?date=' + (schedState.visits.find(x => x.id === id) || {}).date); v = r.visits.find(x => x.id === id); }
    const crew = c.candidates.filter(x => x.assigned), list = (v.checklist || []);
    openDrawer({ title: v.title, sub: `${fmtDate(v.date)} · ${esc(v.start_time || '')}${v.end_time ? '–' + esc(v.end_time) : ''} · ${esc(v.type)} · ${esc(v.status)}${v.dispatched_at ? ' · dispatched ' + fmtWhen(v.dispatched_at) : ''}`,
      body: `<p>${esc(v.address || '')}${v.address ? ` · <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v.address)}" target="_blank" rel="noopener">Directions</a>` : ''}</p>
        ${v.arrived_at || v.completed_at ? `<p class="muted">${v.arrived_at ? 'Arrived ' + fmtWhen(v.arrived_at) : ''}${v.departed_at ? ' · left ' + fmtWhen(v.departed_at) : ''}${v.completed_at ? ' · completed ' + fmtWhen(v.completed_at) : ''}</p>` : ''}
        <h3 class="secth">Crew (${crew.length}${v.crew_needed ? ' of ' + v.crew_needed : ''})</h3><p class="muted">${esc(c.basis)}</p>
        <ul class="cand">${c.candidates.map(x => `<li><span style="flex:1;min-width:0"><b>${esc(x.name)}</b> <small class="muted">${esc(x.role || '')}${x.crew ? ' · Crew ' + esc(x.crew) : ''} · ${x.week_hours} h that week</small>${c.recommended.includes(x.id) ? ' <span class="badge green">Recommended</span>' : ''}${x.block.length ? `<div class="why blk">${esc(x.block.join('; '))}</div>` : ''}${x.warn.length ? `<div class="why wrn">${esc(x.warn.join('; '))}</div>` : ''}</span>
          ${x.assigned ? `<button class="btn small ghost" data-un="${x.id}">Remove</button>` : x.block.length ? '' : `<button class="btn small" data-as="${x.id}" data-ot="${x.warn.some(w => /^overtime/.test(w)) ? 1 : 0}">Assign</button>`}</li>`).join('') || '<li class="muted">No employees yet. Add employees under the Employees tab.</li>'}</ul>
        <form class="ig" id="jobForm" style="margin-top:12px"><div class="wide"><label>Instructions for the crew</label><textarea name="instructions" rows="2">${esc(v.instructions || '')}</textarea></div><div class="wide"><label>Equipment &amp; supplies</label><input name="equipment" value="${esc(v.equipment || '')}"></div><div><label>Crew needed</label><input name="crew_needed" inputmode="numeric" value="${esc(v.crew_needed || '')}"></div><div><label>Priority</label><select name="priority">${['Low', 'Normal', 'High', 'Urgent'].map(p => `<option${(v.priority || 'Normal') === p ? ' selected' : ''}>${p}</option>`).join('')}</select></div>
          <div class="wide"><label>Checklist (one item per line)</label><textarea name="checklist" rows="3">${esc(list.map(x => x.text || x.title || '').join('\n'))}</textarea></div></form>`,
      footer: `<button class="btn ghost" data-close>Close</button><button class="btn ghost" id="jEdit">Edit details</button><button class="btn ghost" id="jMove">Move</button><button class="btn ghost danger" id="jSkip">Skip</button><button class="btn ghost" id="jSave">Save</button><button class="btn" id="jDispatch">${v.dispatched_at ? 'Re-send to crew' : 'Confirm dispatch'}</button>` });
    const re = () => { loadSchedule(); openJob(id); };
    $$('#drawerRoot [data-as]').forEach(b => b.onclick = async () => { let reason = ''; if (b.dataset.ot === '1') { reason = prompt('This assignment creates overtime. Reason for approving it:'); if (!reason) return; } try { const r = await api(`/api/admin/dispatch/visits/${id}/crew`, { method: 'POST', json: { employee_id: Number(b.dataset.as), override_reason: reason } }); toast(r.warnings && r.warnings.length ? 'Assigned (note: ' + r.warnings.join('; ') + ')' : 'Assigned'); re(); } catch (e) { toast(e.message, true); } });
    $$('#drawerRoot [data-un]').forEach(b => b.onclick = async () => { try { await api(`/api/admin/dispatch/visits/${id}/crew`, { method: 'POST', json: { employee_id: Number(b.dataset.un), remove: true } }); re(); } catch (e) { toast(e.message, true); } });
    $('#jSave').onclick = async () => { const f = formObj($('#jobForm')); try { await api('/api/admin/visits/' + id, { method: 'PATCH', json: { instructions: f.instructions, equipment: f.equipment, crew_needed: f.crew_needed, priority: f.priority, checklist: JSON.stringify(f.checklist.split('\n').map(t => t.trim()).filter(Boolean).map(t => { const o = list.find(x => (x.text || x.title) === t); return o || { text: t, done: false }; })) } }); toast('Saved'); re(); } catch (e) { toast(e.message, true); } };
    $('#jEdit').onclick = () => scheduleVisit((schedState.visits || []).find(x => x.id === id) || v);
    $('#jDispatch').onclick = async () => { try { const r = await api(`/api/admin/dispatch/visits/${id}/dispatch`, { method: 'POST' }); toast(`Dispatched to ${r.crew} crew member(s); ${r.notified} notified by email`); re(); } catch (e) { toast(e.message, true); } };
    $('#jSkip').onclick = async () => { const reason = prompt('Why is this visit being skipped?'); if (!reason) return; try { await api(`/api/admin/dispatch/visits/${id}/skip`, { method: 'POST', json: { reason } }); toast('Skipped'); closeDrawer(); loadSchedule(); } catch (e) { toast(e.message, true); } };
    $('#jMove').onclick = () => openForm({ title: 'Move job', defs: [{ name: 'date', label: 'New date', type: 'date' }, { name: 'start_time', label: 'Start', type: 'time' }, { name: 'end_time', label: 'End', type: 'time' }], values: v, submit: async b => { try { return await api(`/api/admin/dispatch/visits/${id}/move`, { method: 'POST', json: b }); } catch (e) { if (/holiday/.test(e.message) && confirm(e.message)) return api(`/api/admin/dispatch/visits/${id}/move`, { method: 'POST', json: { ...b, allow_holiday: true } }); if (/conflicts/.test(e.message) && confirm(e.message + '\n\nMove anyway and remove the conflicting crew members?')) return api(`/api/admin/dispatch/visits/${id}/move`, { method: 'POST', json: { ...b, drop_conflicting: true } }); throw e; } }, after: r => { toast(r.dropped && r.dropped.length ? `Moved. Removed: ${r.dropped.join(', ')}` : 'Moved'); re(); } });
    $$('#drawerRoot [data-close]').forEach(el => el.onclick = closeDrawer);
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

  // ---------- Reports: P&L, aging, labor, projects, schedules ----------
  const rep2 = { tab: 'overview' };
  { const t = new Date(), f = new Date(t.getFullYear(), t.getMonth() - 2, 1); $('#repFrom').value = localISO(f); $('#repTo').value = localISO(t); }
  $$('#repTabs button').forEach(b => b.onclick = () => { rep2.tab = b.dataset.rt; $$('#repTabs button').forEach(x => x.classList.toggle('on', x === b)); $('#v-reports').classList.toggle('alt', rep2.tab !== 'overview'); $('#repNew').hidden = rep2.tab === 'overview'; if (rep2.tab !== 'overview') drawRep2(); });
  $('#repApply').addEventListener('click', () => drawRep2());
  $('#repPdf').addEventListener('click', () => downloadFile({ name: `bright-clean-report-${$('#repFrom').value}-to-${$('#repTo').value}.pdf`, url: `/api/admin/reports/pdf?from=${$('#repFrom').value}&to=${$('#repTo').value}` }));
  async function drawRep2() {
    const q = `from=${$('#repFrom').value}&to=${$('#repTo').value}`, B = $('#repBody'), t = rep2.tab;
    $('#repFrom').closest('.filt').style.display = t === 'aging' || t === 'sched' || t === 'projects' ? 'none' : '';
    try {
      if (t === 'pl') {
        const f = await api('/api/admin/reports/finance?' + q);
        B.innerHTML = `<div class="kpis6">${kt('money', 'blue', 'Invoiced (revenue)', money(f.invoiced), `${f.invoices} invoice(s)`)}${kt('check', 'green', 'Collected on those', money(f.collected), '')}${kt('reports', 'amber', 'Recorded costs', money(f.costs), '')}${kt('money', 'teal', 'Gross profit', money(f.gross_profit), '')}${kt('scopes', 'navy', 'Gross margin', f.margin == null ? '—' : f.margin + '%', '')}${kt('cal', 'blue', 'Period', fmtDate(f.from), 'to ' + fmtDate(f.to))}</div>
          <div class="two"><div class="card"><h2 style="font-size:16px">Costs by category</h2>${Object.keys(f.cost_by_category).length ? `<dl class="stat">${Object.entries(f.cost_by_category).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${money(v)}</dd>`).join('')}<dt style="font-weight:700">Total</dt><dd style="font-weight:800">${money(f.costs)}</dd></dl>` : '<p class="muted">No costs recorded in this period. Record costs on projects, or approve crew time.</p>'}</div>
          <div class="card"><h2 style="font-size:16px">How these numbers are calculated</h2><p class="muted">${esc(f.basis)}</p>${f.checks.length ? `<h3 class="secth" style="color:#a46a00">Data checks</h3>${f.checks.map(c => `<p style="margin:4px 0">⚠ ${esc(c)}</p>`).join('')}` : '<p>✅ No data gaps found.</p>'}</div></div>`;
      } else if (t === 'aging') {
        const a = await api('/api/admin/reports/aging');
        B.innerHTML = `<div class="kpis6">${['Current', '1–30', '31–60', '61–90', '90+'].map((k, i) => kt(i < 2 ? 'clock' : 'issues', i === 0 ? 'green' : i < 3 ? 'amber' : 'red', k === 'Current' ? 'Not yet due' : k + ' days late', money(a.buckets[k]), '')).join('')}${kt('money', 'navy', 'Total open', money(a.total), 'as of ' + fmtDate(a.as_of))}</div>
          <div class="tablewrap card" style="padding:0"><table class="t"><thead><tr><th>Customer</th><th class="num">Not due</th><th class="num">1–30</th><th class="num">31–60</th><th class="num">61–90</th><th class="num">90+</th><th class="num">Total</th></tr></thead><tbody>${a.customers.map(c => `<tr><td><b>${esc(c.customer)}</b></td>${['Current', '1–30', '31–60', '61–90', '90+'].map(k => `<td class="num"${k === '90+' && c[k] ? ' style="color:#c0362d;font-weight:700"' : ''}>${c[k] ? money(c[k]) : '—'}</td>`).join('')}<td class="num"><b>${money(c.total)}</b></td></tr>`).join('') || '<tr><td class="emptyrow" colspan="7">No open invoices. 🎉</td></tr>'}</tbody></table></div>
          ${a.invoices.length ? `<div class="tablewrap card" style="padding:0"><table class="t"><thead><tr><th>Invoice</th><th>Customer</th><th>Project</th><th>Due</th><th class="num">Days late</th><th class="num">Balance</th></tr></thead><tbody>${a.invoices.map(i => `<tr class="click" data-rec="invoices:${i.id}"><td>${esc(i.number || '#' + i.id)}</td><td>${esc(i.customer)}</td><td>${esc(i.project || '—')}</td><td>${i.due_date ? fmtDate(i.due_date) : '—'}</td><td class="num">${i.days_late || '—'}</td><td class="num">${money(i.balance)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
        bindOpeners(B);
      } else if (t === 'labor') {
        const l = await api('/api/admin/reports/labor?' + q);
        B.innerHTML = `<div class="kpis6">${kt('clock', 'blue', 'Hours worked', l.totals.hours, '')}${kt('money', 'navy', 'Labor cost', money(l.totals.cost), '')}${kt('issues', 'red', 'Overtime hours', l.totals.overtime_hours, '')}${kt('clock', 'amber', 'Awaiting approval', l.totals.pending_hours + ' h', '')}${kt('leads', 'teal', 'Employees', l.employees.length, '')}${kt('projects', 'blue', 'Projects', l.projects.length, '')}</div>
          <div class="two"><div class="tablewrap card" style="padding:0"><table class="t"><thead><tr><th>Employee</th><th class="num">Hours</th><th class="num">Overtime</th><th class="num">Pending</th><th class="num">Cost</th></tr></thead><tbody>${l.employees.map(e => `<tr><td>${esc(e.name)}</td><td class="num">${e.hours}</td><td class="num"${e.overtime_hours ? ' style="color:#c0362d"' : ''}>${e.overtime_hours || '—'}</td><td class="num">${e.pending_hours || '—'}</td><td class="num">${money(e.cost)}</td></tr>`).join('') || '<tr><td class="emptyrow" colspan="5">No time recorded in this period.</td></tr>'}</tbody></table></div>
          <div class="tablewrap card" style="padding:0"><table class="t"><thead><tr><th>Project</th><th class="num">Hours</th><th class="num">Cost</th></tr></thead><tbody>${l.projects.map(p => `<tr><td>${esc(p.project)}</td><td class="num">${p.hours}</td><td class="num">${money(p.cost)}</td></tr>`).join('') || '<tr><td class="emptyrow" colspan="3">—</td></tr>'}</tbody></table></div></div><p class="muted">${esc(l.basis || '')}</p>`;
      } else if (t === 'projects') {
        const f = await api('/api/admin/reports/finance?' + q);
        B.innerHTML = `<div class="tablewrap card" style="padding:0"><table class="t"><thead><tr><th>Project</th><th>Status</th><th class="num">Contract</th><th class="num">Invoiced</th><th class="num">Collected</th><th class="num">Actual cost</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead><tbody>${f.projects.map(p => `<tr class="click" data-rec="projects:${p.id}"><td><b>${esc(p.name || '#' + p.id)}</b><small>${esc(p.company || p.customer_name || '')}</small></td><td>${badge(p.status)}</td><td class="num">${money(p.contract)}</td><td class="num">${money(p.invoiced)}</td><td class="num">${money(p.collected)}</td><td class="num">${money(p.cost)}</td><td class="num">${p.profit == null ? '<span class="muted">no costs</span>' : money(p.profit)}</td><td class="num"${p.margin != null && p.margin < 20 ? ' style="color:#c0362d;font-weight:700"' : ''}>${p.margin == null ? '—' : p.margin + '%'}</td></tr>`).join('') || '<tr><td class="emptyrow" colspan="8">No projects yet.</td></tr>'}</tbody></table></div><p class="muted">All invoices and recorded costs to date for each project. Profit is shown only when actual costs are recorded.</p>`;
        bindOpeners(B);
      } else if (t === 'sched') {
        const r = await api('/api/admin/reports/schedules');
        B.innerHTML = `<div class="card"><h2 style="font-size:16px">Scheduled report emails</h2><p class="muted">Weekly reports go out Monday morning for the previous week; monthly reports on the 1st for the previous month. Each email has P&amp;L, receivables, labor and data checks, with a link to the full report.${r.email_ready ? '' : ' <b style="color:#c0362d">Email is not set up yet, so scheduled reports cannot be sent.</b>'}</p>
          ${r.schedules.map(x => `<p style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0"><b>${esc(x.frequency)}</b> to ${esc(x.recipients)} <small class="muted">${x.last_sent ? 'last sent ' + fmtWhen(x.last_sent) : 'not sent yet'}</small><button class="btn small ghost" data-rs="${x.id}">Send now</button><button class="btn small ghost danger" data-rd="${x.id}">Remove</button></p>`).join('') || '<p class="muted">No scheduled reports.</p>'}
          <form class="inl" id="rsForm"><div><label>Frequency</label><select name="frequency"><option>Weekly</option><option>Monthly</option></select></div><div class="wide"><label>Send to (comma-separated emails)</label><input name="recipients" placeholder="info@brightclean.net"></div><div class="wide"><button class="btn">Add schedule</button></div></form></div>`;
        $('#rsForm').onsubmit = async ev => { ev.preventDefault(); try { await api('/api/admin/reports/schedules', { method: 'POST', json: formObj(ev.target) }); toast('Report scheduled'); drawRep2(); } catch (e) { toast(e.message, true); } };
        $$('#repBody [data-rs]').forEach(b => b.onclick = async () => { b.disabled = true; try { const x = await api(`/api/admin/reports/schedules/${b.dataset.rs}/send`, { method: 'POST' }); toast(`Sent to ${x.sent.join(', ')}${x.failed.length ? ' — failed: ' + x.failed.join('; ') : ''}`); drawRep2(); } catch (e) { toast(e.message, true); b.disabled = false; } });
        $$('#repBody [data-rd]').forEach(b => b.onclick = async () => { if (!confirm('Remove this scheduled report?')) return; try { await api('/api/admin/reports/schedules/' + b.dataset.rd, { method: 'DELETE' }); drawRep2(); } catch (e) { toast(e.message, true); } });
      }
    } catch (e) { B.innerHTML = `<p class="err" style="display:block">${esc(e.message)}</p>`; }
  }

  // ---------- Quality & inspections (mockup layout) ----------
  const qState = { inspections: [], dash: null, templates: [], tab: 'all', sel: null };
  const QTABS = [['all', 'All inspections'], ['pending', 'Pending'], ['failed', 'Failed'], ['corrective', 'Needs correction'], ['reinspect', 'Reinspections'], ['accept', 'Customer acceptance'], ['templates', 'Templates'], ['reports', 'Performance']];
  $('#qualityAdd').addEventListener('click', () => newInspection());
  $('#qTplBtn').addEventListener('click', () => { qState.tab = 'templates'; drawQ(); });
  ['#qSearch', '#qCust', '#qProj'].forEach(x => $(x).addEventListener(x === '#qSearch' ? 'input' : 'change', () => drawQ()));
  $('#qCsv').addEventListener('click', () => { const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`; const rows = [['Number', 'Date', 'Area', 'Customer', 'Project', 'Type', 'Template', 'Inspector', 'Crew', 'Score', 'Result', 'Status', 'Failed items'], ...qState.inspections.map(r => [r.number, r.date, r.area, r.customer_company || r.customer_name, r.project_name, r.itype, r.template, r.signed_name || r.inspector, r.crew, r.score, r.passed == null ? '' : r.passed ? 'Passed' : 'Failed', r.status, r.items.filter(i => i.result === 'Fail').map(i => i.label).join('; ')])]; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' })); a.download = 'inspections.csv'; a.click(); });
  // ---------------- Quality → Customer complaints ----------------
  const CSTAGE_COLOR = { NEW: '#6b7280', TRIAGE: '#6b7280', ASSIGNED: '#1f6fd1', INVESTIGATING: '#1f6fd1', CORRECTIVE_ACTION: '#c77700', REINSPECTION: '#c77700', CUSTOMER_CONFIRMATION: '#7c3aed', RESOLVED: '#1e8e3e', CLOSED: '#1e8e3e', INFO_NEEDED: '#c0392b', ON_HOLD: '#6b7280', ESCALATED: '#c0392b' };
  let cmpFilter = 'open';
  async function loadComplaints() {
    let box = document.getElementById('qcComplaints');
    if (!box) { box = document.createElement('div'); box.id = 'qcComplaints'; box.className = 'card'; box.style.cssText = 'margin-bottom:16px;padding:14px'; const head = document.querySelector('#v-quality .pagehead'); head.parentNode.insertBefore(box, head.nextSibling); }
    let d; try { d = await api('/api/admin/quality/complaints?status=' + encodeURIComponent(cmpFilter)); } catch (e) { box.innerHTML = `<p class="msg err">Complaints could not load: ${esc(e.message)}</p>`; return; }
    const tabs = [['open', 'Open'], ['INFO_NEEDED', 'Information needed'], ['INVESTIGATING', 'Investigating'], ['CORRECTIVE_ACTION', 'Corrective action'], ['REINSPECTION', 'Reinspection'], ['CUSTOMER_CONFIRMATION', 'Customer confirmation'], ['ESCALATED', 'Escalated'], ['RESOLVED', 'Resolved'], ['CLOSED', 'Closed']];
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px"><h2 style="margin:0;font-size:18px">Customer complaints</h2><small class="muted">Every complaint (phone, AI receptionist, issue or website) becomes one case here.</small></div>
      <div class="segtabs" style="margin:10px 0">${tabs.map(([k, l]) => `<button type="button" data-cf="${k}" class="${cmpFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${d.complaints.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Case</th><th>Customer / location</th><th>Complaint</th><th>Stage</th><th>Manager</th><th>Respond by</th></tr></thead><tbody>${d.complaints.map(c => `<tr class="click" data-cmp="${c.id}"><td><b>${esc(c.number)}</b><small>${esc(c.source_type)}</small></td><td>${esc(c.customer_company || c.customer_name || 'Unknown caller')}<small>${esc(c.property || '')}</small></td><td>${esc(String(c.description || '').slice(0, 90))}</td><td><span class="pill" style="background:${CSTAGE_COLOR[c.status]};color:#fff">${esc(c.status_label)}</span></td><td>${esc(c.assigned_manager || '—')}</td><td${c.overdue ? ' style="color:#c0392b;font-weight:600"' : ''}>${c.response_due ? esc(fmtWhen(c.response_due)) : '—'}${c.overdue ? ' · overdue' : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No complaints in this view.</p>'}`;
    $$('#qcComplaints [data-cf]').forEach(b => b.onclick = () => { cmpFilter = b.dataset.cf; loadComplaints(); });
    $$('#qcComplaints [data-cmp]').forEach(r => r.onclick = () => openComplaint(Number(r.dataset.cmp)));
  }
  async function openComplaint(id) {
    let d; try { d = await api('/api/admin/quality/complaints/' + id); } catch (e) { return toast(e.message, true); }
    const c = d.complaint, ic = { done: '✅', needs_approval: '⏳', blocked: '⚠️', failed: '❌' };
    let emps = []; try { emps = ((await api('/api/admin/employees')).employees || []).filter(e => e.active !== 0); } catch { /* */ }
    const stageBtn = (to, label, extra = '') => `<button type="button" class="btn small${extra}" data-to="${to}">${label}</button>`;
    openDrawer({ title: `${c.number} · ${c.status_label}`, sub: `${c.category} · ${c.severity} · reported ${fmtWhen(c.reported_at)} via ${c.source_type}`,
      body: `${c.info_needed ? `<p class="msg err" style="margin:0 0 10px">Information needed: ${esc(c.info_needed)}</p>` : ''}
        <dl class="facts"><dt>Customer</dt><dd>${d.customer ? `${esc(d.customer.company || d.customer.name)} <small class="muted">${esc(d.customer.phone || '')}</small>` : 'Not identified'}${d.repeat_complaints ? ` <span class="pill" style="background:#c0392b;color:#fff">${d.repeat_complaints} earlier complaint(s)</span>` : ''}</dd>
        <dt>Location</dt><dd>${esc(c.property || '—')}</dd><dt>Original job</dt><dd>${d.original_visit ? `${esc(d.original_visit.title)} · ${esc(d.original_visit.date)}` : '—'}</dd><dt>Crew</dt><dd>${esc(c.crew || '—')}</dd>
        <dt>Source call</dt><dd>${d.call ? `<a href="#" id="cmpCall">Call #${d.call.id}</a> <small class="muted">${esc(d.call.handling || '')} · ${esc(fmtWhen(d.call.created_at))}</small>` : '—'}</dd>
        <dt>Manager</dt><dd>${esc(c.assigned_manager || '—')}</dd><dt>Respond by</dt><dd${c.overdue ? ' style="color:#c0392b"' : ''}>${c.response_due ? esc(fmtWhen(c.response_due)) : '—'}${c.overdue ? ' (overdue)' : ''}</dd></dl>
        <h3 class="secth">Complaint</h3><p style="white-space:pre-wrap">${esc(c.description || '')}</p>${c.transcript ? `<details><summary>Call transcript</summary><pre style="white-space:pre-wrap;font-size:12px">${esc(c.transcript)}</pre></details>` : ''}
        <h3 class="secth">Investigation</h3><p style="white-space:pre-wrap" class="muted">${esc(c.investigation_notes || 'No notes yet.')}</p>
        <div class="f"><label for="cmpNote">Add investigation note</label><textarea id="cmpNote" rows="2"></textarea></div><button class="btn small ghost" id="cmpNoteSave">Save note</button>
        <div class="f" style="margin-top:8px"><label for="cmpRoot">Root cause</label><input id="cmpRoot" value="${esc(c.root_cause || '')}" placeholder="What went wrong"></div>
        <h3 class="secth">Corrective cleaning</h3>${d.actions.filter(a => a.action_type === 'corrective_visit').map(a => `<p>📅 ${esc(a.description)} · visit #${a.ref_id}</p>`).join('') || '<p class="muted">None scheduled.</p>'}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px"><input id="cmpDate" type="date"><input id="cmpTime" type="time" value="18:00"></div>
        <select id="cmpCrew" multiple size="${Math.min(4, Math.max(2, emps.length))}" style="width:100%;margin-top:6px">${emps.map(e => `<option value="${e.id}">${esc(e.name)}${e.role ? ' · ' + esc(e.role) : ''}</option>`).join('')}</select>
        <input id="cmpInstr" placeholder="Instructions for the crew" style="margin-top:6px"><button class="btn small" id="cmpCorr" style="margin-top:6px">Schedule corrective cleaning</button>
        <h3 class="secth">Reinspection</h3>${d.actions.filter(a => a.action_type === 'reinspection').map(a => `<p>${a.status === 'Passed' ? '✅' : '❌'} ${esc(a.description)}</p>`).join('') || '<p class="muted">None yet.</p>'}
        <select id="cmpInsp"><option value="">Link a completed inspection…</option>${d.inspections.map(i => `<option value="${i.id}">#${i.id} ${esc(i.area)} · ${esc(i.date || '')} · ${i.passed === 1 ? 'passed' : i.passed === 0 ? 'failed' : 'unsigned'}</option>`).join('')}</select> <button class="btn small ghost" id="cmpReinsp">Record reinspection</button>
        <h3 class="secth">Customer contact</h3>${d.comms.map(m => `<p>${m.accepted === 1 ? '👍' : m.accepted === 0 ? '👎' : '💬'} ${esc(fmtWhen(m.created_at))} · ${esc(m.channel)}: ${esc(m.message)}</p>`).join('') || '<p class="muted">No contact recorded.</p>'}
        <textarea id="cmpMsg" rows="2" placeholder="What was communicated to the customer"></textarea>
        <div style="display:flex;gap:6px;margin-top:6px"><button class="btn small ghost" data-acc="update">Log update</button><button class="btn small ghost" data-acc="yes">Customer accepted</button><button class="btn small ghost" data-acc="no">Customer rejected</button></div>
        <h3 class="secth">Resolution</h3><textarea id="cmpRes" rows="2" placeholder="Resolution summary">${esc(c.resolution_summary || '')}</textarea>
        <h3 class="secth">Autopilot timeline</h3><div style="font-size:13px">${d.autopilot.map(a => `<div style="margin:3px 0">${ic[a.status] || '•'} ${esc(a.step)} <small class="muted">· ${esc(a.decided_by)} · ${esc(fmtWhen(a.created_at))}${a.evidence ? ' · ' + esc(String(a.evidence).slice(0, 140)) : ''}</small></div>`).join('')}</div>
        <details style="margin-top:8px"><summary>History (${d.history.length})</summary>${d.history.map(h => `<div style="font-size:12px">${esc(fmtWhen(h.created_at))} · ${esc(h.actor || '')} · ${esc(h.action)}${h.next ? ': ' + esc(String(h.prev || '') ? h.prev + ' → ' : '') + esc(h.next) : ''}</div>`).join('')}</details>`,
      footer: `<button class="btn ghost" data-close>Close</button>${stageBtn('INVESTIGATING', 'Investigate', ' ghost')}${stageBtn('CORRECTIVE_ACTION', 'Corrective action', ' ghost')}${stageBtn('RESOLVED', 'Resolve')}${stageBtn('CLOSED', 'Close case', ' ghost')}${stageBtn('ESCALATED', 'Escalate', ' ghost')}${stageBtn('ON_HOLD', 'On hold', ' ghost')}` });
    const reload = () => { openComplaint(id); if (state.view === 'quality') loadComplaints(); };
    if ($('#cmpCall')) $('#cmpCall').onclick = ev => { ev.preventDefault(); closeDrawer(); go('calls'); setTimeout(() => openCall({ id: d.call.id }), 350); };
    $('#cmpNoteSave').onclick = async () => { try { await api(`/api/admin/quality/complaints/${id}/notes`, { method: 'POST', json: { text: $('#cmpNote').value } }); toast('Note saved'); reload(); } catch (e) { toast(e.message, true); } };
    $('#cmpCorr').onclick = async () => { try { if ($('#cmpRoot').value.trim() !== (c.root_cause || '')) await api(`/api/admin/quality/complaints/${id}/stage`, { method: 'POST', json: { to: c.status === 'CORRECTIVE_ACTION' ? 'CORRECTIVE_ACTION' : 'CORRECTIVE_ACTION', root_cause: $('#cmpRoot').value } });
      const r = await api(`/api/admin/quality/complaints/${id}/corrective`, { method: 'POST', json: { date: $('#cmpDate').value, start_time: $('#cmpTime').value, employee_ids: [...$('#cmpCrew').selectedOptions].map(o => Number(o.value)), instructions: $('#cmpInstr').value } }); toast(`Corrective cleaning scheduled (visit #${r.visit_id})`); reload(); } catch (e) { toast(e.message, true); } };
    $('#cmpReinsp').onclick = async () => { try { const r = await api(`/api/admin/quality/complaints/${id}/reinspection`, { method: 'POST', json: { inspection_id: Number($('#cmpInsp').value) } }); toast(r.passed ? 'Reinspection passed — confirm with the customer' : 'Reinspection failed — corrective action reopened', !r.passed); reload(); } catch (e) { toast(e.message, true); } };
    $$('#drawerRoot [data-acc]').forEach(b => b.onclick = async () => { try { await api(`/api/admin/quality/complaints/${id}/customer-contact`, { method: 'POST', json: { message: $('#cmpMsg').value, accepted: b.dataset.acc === 'yes' ? true : b.dataset.acc === 'no' ? false : undefined } }); toast('Recorded'); reload(); } catch (e) { toast(e.message, true); } });
    $$('#drawerRoot [data-to]').forEach(b => b.onclick = async () => { const to = b.dataset.to; const body = { to, root_cause: $('#cmpRoot').value, resolution_summary: $('#cmpRes').value };
      if (['ESCALATED', 'ON_HOLD'].includes(to)) { const n = prompt('Why?'); if (!n) return; body.note = n; }
      if (to === 'CLOSED' && !confirm(`Close ${c.number}? This ends the case.`)) return;
      try { await api(`/api/admin/quality/complaints/${id}/stage`, { method: 'POST', json: body }); toast('Updated'); reload(); } catch (e) { toast(e.message, true); } });
  }
  async function loadQuality() {
    loadComplaints();
    const [d, t] = await Promise.all([api('/api/admin/qc/dashboard?from=2000-01-01&to=2100-01-01'), api('/api/admin/qc/templates')]);
    qState.dash = d; qState.inspections = d.inspections; qState.templates = t.templates;
    const k = d.kpis;
    $('#qualityKpis').innerHTML = [kt('check', 'blue', 'Inspections completed', k.completed, ''), kt('scopes', 'blue', 'Average quality score', k.avg == null ? '—' : k.avg + '%', ''), kt('issues', 'red', 'Failed inspections', k.failed, ''), kt('clock', 'amber', 'Pending inspections', k.pending, k.acceptance_pending ? `${k.acceptance_pending} awaiting customer` : ''), kt('settings', 'amber', 'Corrective actions open', k.corrective_open, k.corrective_avg_days != null ? `avg ${k.corrective_avg_days} days to fix` : ''), kt('cal', 'teal', 'Reinspections due', k.reinspections_due, '')].join('');
    const tot = k.passed + k.failed, pp = tot ? k.passed / tot * 100 : 0;
    $('#qDonut').innerHTML = `<div class="donut" style="background:conic-gradient(#17904c 0 ${pp}%, #d1382f ${pp}% 100%)"><i>${tot}</i></div><p style="margin:2px 0"><span class="badge green">Passed</span> ${k.passed} (${tot ? Math.round(pp) : 0}%)</p><p style="margin:2px 0"><span class="badge red">Failed</span> ${k.failed} (${tot ? Math.round(100 - pp) : 0}%)</p>`;
    const tr = d.trend.slice(-9);
    $('#qTrend').innerHTML = tr.length ? tr.map(x => `<div><span>${x.avg}%</span><b style="height:${Math.max(4, x.avg)}%"></b>${new Date(x.week + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>`).join('') : '<p class="muted">Scores appear once inspections are recorded.</p>';
    $('#qDef').innerHTML = d.deficiencies.length ? d.deficiencies.slice(0, 6).map(x => `<p style="display:flex;justify-content:space-between;margin:6px 0"><span>${esc(x.category)}</span><b>${x.n}</b></p>`).join('') + (d.repeat_failures.length ? `<p class="muted" style="margin-top:8px"><b style="color:#d1382f">Repeat failures:</b> ${d.repeat_failures.slice(0, 3).map(r => `${esc(r.item)} at ${esc(r.where)} (${r.n}×)`).join('; ')}</p>` : '') : '<p class="muted">No deficiencies recorded.</p>';
    const fill = (sel, items, lbl) => { const c = $(sel).value; $(sel).innerHTML = `<option value="">${lbl}</option>` + [...new Map(items.filter(x => x[0]).map(x => [String(x[0]), x[1]])).entries()].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(''); $(sel).value = c; };
    fill('#qCust', d.inspections.map(r => [r.customer_id, r.customer_company || r.customer_name]), 'All customers'); fill('#qProj', d.inspections.map(r => [r.project_id, r.project_name]), 'All projects');
    drawQ(); if (qState.sel) showInspection(qState.sel);
  }
  function drawQ() {
    const ins = qState.inspections, q = $('#qSearch').value.trim().toLowerCase(), cu = $('#qCust').value, pr = $('#qProj').value;
    const counts = { all: ins.length, pending: ins.filter(r => r.status === 'In progress').length, failed: ins.filter(r => r.passed === 0).length, corrective: ins.filter(r => r.status === 'Corrective action').length, reinspect: ins.filter(r => r.itype === 'Reinspection' || r.status === 'Reinspection due').length, accept: ins.filter(r => r.itype === 'Customer walkthrough').length };
    $('#qTabs').innerHTML = QTABS.map(([k, l]) => `<button data-q="${k}" class="${qState.tab === k ? 'on' : ''}">${l}${counts[k] != null ? ` (${counts[k]})` : ''}</button>`).join('');
    $$('#qTabs button').forEach(b => b.onclick = () => { qState.tab = b.dataset.q; drawQ(); });
    if (qState.tab === 'templates') return drawTemplates();
    if (qState.tab === 'reports') return drawQReports();
    const match = r => ({ all: true, pending: r.status === 'In progress', failed: r.passed === 0, corrective: r.status === 'Corrective action', reinspect: r.itype === 'Reinspection' || r.status === 'Reinspection due', accept: r.itype === 'Customer walkthrough' })[qState.tab];
    const rows = ins.filter(r => match(r) && (!cu || String(r.customer_id) === cu) && (!pr || String(r.project_id) === pr) && (!q || [r.area, r.number, r.customer_company, r.customer_name, r.project_name, r.template, r.inspector, r.signed_name, r.crew].join(' ').toLowerCase().includes(q)));
    $('#qBody').innerHTML = `<div class="tablewrap card" style="padding:0"><table class="t isst"><thead><tr><th>Date</th><th>Inspection</th><th>Property / location</th><th>Customer</th><th>Service</th><th>Inspector</th><th>Score</th><th>Result</th><th>Status</th></tr></thead><tbody id="qualityRows">${rows.length ? rows.map(r => `<tr class="click" data-insp="${r.id}"><td>${fmtDate(r.date)}</td><td><b style="color:#1f6fd1">${esc(r.number)}</b><small>${esc(r.itype || 'Internal')}</small></td><td><b>${esc(r.area)}</b><small>${esc(r.property_name || r.project_name || '')}</small></td><td>${esc(r.customer_company || r.customer_name || '—')}</td><td>${esc(r.template || '—')}</td><td>${esc(r.signed_name || r.inspector || '—')}</td><td><b>${r.score == null ? '—' : r.score + '%'}</b></td><td>${r.passed == null ? '—' : r.passed ? '<span class="pill s-Resolved">✓ Passed</span>' : '<span class="pill p-High">✗ Failed</span>'}</td><td><span class="pill st-${r.status === 'Completed' || r.status === 'Closed' || /accepted/i.test(r.status || '') ? 'Approved' : r.status === 'In progress' ? 'Draft' : 'Expired'}">${esc(r.status || 'Completed')}</span></td></tr>`).join('') : '<tr><td class="emptyrow" colspan="9">No inspections here yet.</td></tr>'}</tbody></table></div>`;
    $$('#qBody [data-insp]').forEach(r => r.onclick = () => showInspection(Number(r.dataset.insp)));
  }
  async function showInspection(id) {
    qState.sel = id; let d; try { d = await api('/api/admin/qc/inspections/' + id); } catch (e) { return toast(e.message, true); }
    const r = d.inspection, rooms = {}; r.items.forEach((x, n) => (rooms[x.room || 'General'] = rooms[x.room || 'General'] || []).push({ ...x, n }));
    const pct = list => { const rated = list.filter(x => x.result === 'Pass' || x.result === 'Fail'); return rated.length ? Math.round(rated.filter(x => x.result === 'Pass').length / rated.length * 100) : null; };
    const sc = r.score == null ? 0 : r.score, col = r.passed === 0 ? '#d1382f' : '#17904c';
    $('#qSide').innerHTML = `<div class="card"><h2 style="font-size:18px;margin-bottom:2px">${esc(r.number)} ${badge(r.status || 'Completed')}</h2><b>${esc(r.area)}</b> <span class="muted">· ${esc(r.template || r.itype || '')}</span>
      <p class="muted" style="margin:4px 0">${esc(r.customer_company || r.customer_name || '')}${r.project_name ? ' · ' + esc(r.project_name) : ''}<br>${fmtDate(r.date)}${r.crew ? ' · Crew ' + esc(r.crew) : ''} · ${esc(r.signed_name || r.inspector || '')}</p>
      <div style="display:flex;gap:16px;align-items:center;margin:10px 0"><div class="ring" style="background:conic-gradient(${col} 0 ${sc}%, #e6edf5 ${sc}% 100%)"><i>${r.score == null ? '—' : Math.round(r.score) + '%'}</i></div><div><div>Result: ${r.passed == null ? 'Not scored' : r.passed ? '<span class="badge green">Passed</span>' : '<span class="badge red">Failed</span>'}</div><small class="muted">Pass mark ${r.threshold || 85}%</small></div></div>
      ${Object.entries(rooms).map(([room, list]) => `<details class="qroom"${list.some(x => x.result === 'Fail') ? ' open' : ''}><summary><span>${esc(room)} (${list.filter(x => x.result === 'Pass').length}/${list.length})</span><span>${pct(list) == null ? '—' : pct(list) + '%'}</span></summary><ul>${list.map(x => `<li>${x.result === 'Pass' ? '✅' : x.result === 'Fail' ? '❌' : x.result === 'N/A' ? '➖' : '⬜'} ${esc(x.label)} <small class="muted">w${x.weight}</small>${x.note ? `<br><small style="color:#c0362d">${esc(x.note)}</small>` : ''}</li>`).join('')}</ul></details>`).join('')}
      ${d.photos.length ? `<h3 class="secth">Photos (${d.photos.length})</h3><p>${d.photos.map(p => `<button class="linklike" data-ph="${p.id}">${esc(p.file_name || p.title)}</button>`).join(' · ')}</p>` : ''}
      ${r.notes ? `<h3 class="secth">Inspector notes</h3><p>${esc(r.notes)}</p>` : ''}${r.ai_summary ? `<h3 class="secth">AI summary <small class="muted">(suggestion)</small></h3><p style="white-space:pre-wrap;font-size:14px">${esc(r.ai_summary)}</p>` : ''}
      ${r.signed_at ? `<p style="border:1px solid var(--line2);border-radius:10px;padding:10px"><span style="font-family:cursive;font-size:20px">${esc(r.signed_name)}</span><br><small class="muted">${esc(r.signed_by || '')} · ${fmtWhen(r.signed_at)}</small></p>` : '<p class="muted">Not signed yet.</p>'}
      ${r.accepted_at ? `<p>Customer accepted: <b>${esc(r.accepted_by)}</b>${r.accepted_title ? ', ' + esc(r.accepted_title) : ''} · ${fmtWhen(r.accepted_at)}${r.accept_notes ? `<br><small class="muted">${esc(r.accept_notes)}</small>` : ''}</p>` : ''}
      ${d.corrective.length ? `<h3 class="secth">Corrective work orders</h3>${d.corrective.map(c => `<p style="margin:4px 0"><button class="linklike" data-iss="${c.id}">${esc(c.title)}</button> ${badge(c.status)}</p>`).join('')}` : ''}${d.reinspections.length ? `<h3 class="secth">Reinspections</h3>${d.reinspections.map(x => `<p style="margin:4px 0"><button class="linklike" data-ri="${x.id}">${fmtDate(x.date)} · ${x.score == null ? 'in progress' : x.score + '%'}</button> ${badge(x.status)}</p>`).join('')}` : ''}</div>
      <div class="card" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${!r.signed_at ? '<button class="btn" id="qInspect" style="grid-column:1/-1">Continue inspection</button>' : ''}<button class="btn ghost" id="qPdf">Download PDF</button><button class="btn ghost" id="qPhotos">Add photos</button><button class="btn ghost" id="qAi">AI summary</button>
        ${r.signed_at && r.items.some(x => x.result === 'Fail') ? '<button class="btn ghost" id="qWo">Create work orders</button><button class="btn ghost" id="qRe">Start reinspection</button>' : ''}${r.signed_at && r.itype === 'Customer walkthrough' && !r.accepted_at ? '<button class="btn" id="qAcc" style="grid-column:1/-1">Record customer acceptance</button>' : ''}</div>`;
    const act = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    act('#qInspect', () => inspectEditor(r));
    act('#qPdf', () => downloadFile({ name: r.number + '.pdf', url: `/api/admin/qc/inspections/${r.id}/pdf` }));
    act('#qPhotos', () => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true; inp.onchange = async () => { const fd = new FormData(); fd.append('inspection_id', r.id); fd.append('kind', 'Photos'); if (r.project_id) fd.append('project_id', r.project_id); if (r.customer_id) fd.append('customer_id', r.customer_id); [...inp.files].forEach(f => fd.append('files', f)); const x = await fetch('/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd }); if (x.ok) { toast('Photos added'); showInspection(r.id); } else toast((await x.json().catch(() => ({}))).error || 'Upload failed', true); }; inp.click(); });
    act('#qAi', async () => { $('#qAi').disabled = true; $('#qAi').textContent = 'Reading…'; try { await api(`/api/admin/ai/qc/${r.id}/summary`, { method: 'POST' }); showInspection(r.id); } catch (e) { toast(e.message, true); $('#qAi').disabled = false; $('#qAi').textContent = 'AI summary'; } });
    act('#qWo', () => openForm({ title: 'Create corrective work orders', sub: `${r.items.filter(x => x.result === 'Fail').length} failed item(s) become tasks in Issues & Tasks.`, defs: [{ name: 'assigned_to', label: 'Assign to (email)' }, { name: 'due_date', label: 'Due date', type: 'date' }, { name: 'required_action', label: 'Required action', wide: true, placeholder: 'Re-clean and take before/after photos' }], submit: b => api(`/api/admin/qc/inspections/${r.id}/corrective`, { method: 'POST', json: b }), after: x => { toast(`${x.created} work order(s) created`); loadQuality(); } }));
    act('#qRe', async () => { try { const x = await api(`/api/admin/qc/inspections/${r.id}/reinspect`, { method: 'POST' }); toast(x.open_corrective ? `Reinspection started (${x.open_corrective} corrective task(s) still open)` : 'Reinspection started'); await loadQuality(); inspectEditor(x.inspection); } catch (e) { toast(e.message, true); } });
    act('#qAcc', () => openForm({ title: 'Customer acceptance', defs: [{ name: 'name', label: 'Customer representative' }, { name: 'title', label: 'Title' }, { name: 'with_exceptions', label: 'Accept with exceptions (open deficiencies listed)', type: 'select', options: [['', 'No'], ['1', 'Yes']] }], submit: b => api(`/api/admin/qc/inspections/${r.id}/accept`, { method: 'POST', json: { ...b, with_exceptions: !!b.with_exceptions } }), after: () => { toast('Customer acceptance recorded'); loadQuality(); } }));
    $$('#qSide [data-iss]').forEach(b => b.onclick = () => openIssue({ id: Number(b.dataset.iss) }, null));
    $$('#qSide [data-ri]').forEach(b => b.onclick = () => showInspection(Number(b.dataset.ri)));
    $$('#qSide [data-ph]').forEach(b => b.onclick = () => { const p = d.photos.find(x => x.id === Number(b.dataset.ph)); downloadFile({ name: p.file_name || p.title, url: p.file_url }); });
  }
  async function newInspection() {
    if (!qState.templates.length) qState.templates = (await api('/api/admin/qc/templates')).templates;
    if (!state.customers || !state.customers.length) { try { state.customers = (await api('/api/admin/customers')).customers; } catch { state.customers = []; } }
    let projects = []; try { projects = (await api('/api/admin/pm/projects')).projects; } catch { /* */ }
    openForm({ title: 'New inspection', defs: [{ name: 'itype', label: 'Type', type: 'select', options: ['Internal', 'Customer walkthrough'] }, { name: 'template_id', label: 'Template', type: 'select', options: qState.templates.filter(t => t.active).map(t => [t.id, t.name]) }, { name: 'area', label: 'Site / area' }, { name: 'date', label: 'Date', type: 'date' },
      { name: 'customer_id', label: 'Customer', type: 'select', options: [['', '—'], ...state.customers.map(c => [c.id, c.company || c.name || c.email])] }, { name: 'project_id', label: 'Project', type: 'select', options: [['', '—'], ...projects.map(p => [p.id, `${p.number} ${p.name || ''}`])] }, { name: 'crew', label: 'Crew inspected' }],
      values: { date: todayISO(), itype: 'Internal' }, submit: b => api('/api/admin/qc/inspections', { method: 'POST', json: b }), after: async x => { await loadQuality(); inspectEditor(x.inspection); } });
  }
  function inspectEditor(r) {
    const items = r.items.map(x => ({ ...x }));
    const rows = () => items.map((x, n) => `<div class="qrow"><div><small class="muted">${esc(x.room)}</small><br><b>${esc(x.label)}</b> <small class="muted">weight ${x.weight}</small></div><div class="seg3">${[['Pass', 'p'], ['Fail', 'f'], ['N/A', 'n']].map(([v, c]) => `<button type="button" class="${c}${x.result === v ? ' on' : ''}" data-i="${n}" data-v="${v}">${v}</button>`).join('')}</div><input id="ci_n${n}" placeholder="${x.result === 'Fail' ? 'Required: what needs fixing' : 'Comment (optional)'}" value="${esc(x.note || '')}" data-n="${n}"></div>`).join('');
    openDrawer({ title: `Inspect: ${r.area}`, sub: `${esc(r.number || '')} · ${esc(r.template || '')} · pass mark ${r.threshold || 85}%`, body: `<p class="err" id="qMsg" hidden></p><div id="qRows">${rows()}</div><div class="ig" style="margin-top:12px"><div class="wide"><label>Inspector notes</label><textarea id="qNotes" rows="2">${esc(r.notes || '')}</textarea></div></div>`,
      footer: '<button class="btn ghost" data-close>Close</button><button class="btn ghost" id="qSave">Save progress</button><button class="btn" id="qSign">Sign inspection</button>' });
    const wire = () => { $$('#qRows [data-v]').forEach(b => b.onclick = () => { items[b.dataset.i].result = b.dataset.v; $('#qRows').innerHTML = rows(); wire(); }); $$('#qRows [data-n]').forEach(inp => inp.oninput = () => { items[inp.dataset.n].note = inp.value; }); };
    wire();
    const msg = t => { $('#qMsg').textContent = t; $('#qMsg').hidden = !t; };
    const save = () => api('/api/admin/qc/inspections/' + r.id, { method: 'PATCH', json: { items, notes: $('#qNotes').value } });
    $('#qSave').onclick = async () => { try { const x = await save(); toast(`Saved · ${x.inspection.score == null ? 'not scored yet' : x.inspection.score + '%'}`); loadQuality(); } catch (e) { msg(e.message); } };
    $('#qSign').onclick = async () => { try { await save(); const name = prompt('Type your full name to sign this inspection:'); if (!name) return; await api(`/api/admin/qc/inspections/${r.id}/sign`, { method: 'POST', json: { name } }); toast('Inspection signed'); closeDrawer(); qState.sel = r.id; loadQuality(); } catch (e) { msg(e.message); } };
    $$('#drawerRoot [data-close]').forEach(el => el.onclick = closeDrawer);
  }
  function drawTemplates() {
    $('#qBody').innerHTML = qState.templates.map(t => `<div class="card"><h2 style="font-size:16px;display:flex;justify-content:space-between">${esc(t.name)} <span><small class="muted">pass mark ${t.threshold}% · ${t.items.length} items</small> <button class="btn small ghost" data-te="${t.id}">Edit</button></span></h2><p class="muted" style="margin:0">${[...new Set(t.items.map(i => i.room))].map(esc).join(' · ')}</p></div>`).join('');
    $$('#qBody [data-te]').forEach(b => b.onclick = () => { const t = qState.templates.find(x => x.id === Number(b.dataset.te)); openForm({ title: 'Edit template: ' + t.name, sub: 'One item per line: Room | Item | weight (1–5) | category', defs: [{ name: 'threshold', label: 'Pass mark %' }, { name: 'items', label: 'Items', type: 'textarea', wide: true }], values: { threshold: t.threshold, items: t.items.map(i => [i.room, i.label, i.weight, i.category].join(' | ')).join('\n') },
      submit: x => api('/api/admin/qc/templates/' + t.id, { method: 'PUT', json: { threshold: x.threshold, items: x.items.split('\n').map(l => l.split('|').map(s => s.trim())).filter(a => a[1]).map(([room, label, weight, category]) => ({ room, label, weight, category })) } }), after: () => { toast('Template saved'); loadQuality(); } }); });
  }
  async function drawQReports() {
    const by = qState.by || 'crew', r = await api(`/api/admin/qc/report?by=${by}&from=2000-01-01&to=2100-01-01`);
    $('#qBody').innerHTML = `<div class="filt"><select id="qBy">${['crew', 'inspector', 'customer', 'property', 'project', 'service', 'category'].map(x => `<option value="${x}"${x === by ? ' selected' : ''}>By ${x}</option>`).join('')}</select></div><div class="tablewrap card" style="padding:0"><table class="t"><thead><tr><th>${esc(by)}</th><th class="num">Inspections</th><th class="num">Average score</th><th class="num">Failed inspections</th><th class="num">Failed items</th></tr></thead><tbody>${r.rows.map(x => `<tr><td>${esc(x.key)}</td><td class="num">${x.inspections}</td><td class="num"><b>${x.avg}%</b></td><td class="num">${x.failed}</td><td class="num">${x.failed_items}</td></tr>`).join('') || '<tr><td class="emptyrow" colspan="5">No scored inspections yet.</td></tr>'}</tbody></table></div>
      ${qState.dash.repeat_failures.length ? `<div class="card"><h2 style="font-size:16px">Repeat failures</h2>${qState.dash.repeat_failures.map(x => `<p style="margin:4px 0">${esc(x.item)} — ${esc(x.where)} <b>${x.n}×</b></p>`).join('')}</div>` : ''}`;
    $('#qBy').onchange = () => { qState.by = $('#qBy').value; drawQReports(); };
  }

  // ---------- Drawings & documents (revision control + blueprint reading) ----------
  const docState = { documents: [], kinds: [], tab: 'all', sel: null, lib: null };
  const DTABS = [['all', 'All current'], ['Drawings', 'Drawings'], ['Specifications', 'Specifications'], ['Addendum', 'Addenda'], ['Finish schedule', 'Finish schedules'], ['Photos', 'Photos'], ['Superseded', 'Superseded'], ['Archived', 'Archived']];
  $('#documentsAdd').addEventListener('click', () => uploadDocs());
  ['#docSearch', '#docProj', '#docKind'].forEach(x => $(x).addEventListener(x === '#docSearch' ? 'input' : 'change', () => renderDocs()));
  async function loadDocuments() {
    const r = await api('/api/admin/docs/library'); docState.lib = r; docState.documents = r.documents; docState.kinds = ['Drawings', 'Specifications', 'Addendum', 'Finish schedule', 'Photos', 'Other'];
    const k = r.kpis;
    $('#documentsKpis').innerHTML = [kt('documents', 'blue', 'Files', k.files, `${k.storage_mb} MB`), kt('documents', 'navy', 'Current drawing sets', k.drawing_sets, ''), kt('scopes', 'blue', 'Sheets indexed', k.sheets, ''), kt('clock', 'amber', 'Superseded revisions', k.superseded, 'kept for history'),
      kt('check', 'green', 'AI-read sets', k.analyzed, ''), kt('issues', 'amber', 'Awaiting reading', k.awaiting, 'PDF drawing sets'), kt('issues', 'red', 'Open drawing questions', k.open_questions, 'for the GC'), kt('settings', r.ai_ready ? 'teal' : 'red', 'AI reading', r.ai_ready ? 'Ready' : 'Off', r.ai_ready ? '' : 'needs API key')].join('');
    const c = $('#docProj').value; $('#docProj').innerHTML = '<option value="">All projects</option>' + [...new Map(r.documents.filter(d => d.project_id).map(d => [d.project_id, d.project_name])).entries()].map(([v, l]) => `<option value="${v}">${esc(l || 'Project #' + v)}</option>`).join(''); $('#docProj').value = c;
    renderDocs(); if (docState.sel) showDoc(docState.sel);
  }
  function renderDocs() {
    const all = docState.documents, t = docState.tab, q = $('#docSearch').value.trim().toLowerCase(), pr = $('#docProj').value;
    const match = d => t === 'Superseded' || t === 'Archived' ? d.status === t : d.status === 'Current' && (t === 'all' || d.kind === t);
    $('#docTabs').innerHTML = DTABS.map(([k, l]) => `<button data-dt="${esc(k)}" class="${t === k ? 'on' : ''}">${l} (${all.filter(d => k === 'Superseded' || k === 'Archived' ? d.status === k : d.status === 'Current' && (k === 'all' || d.kind === k)).length})</button>`).join('');
    $$('#docTabs button').forEach(b => b.onclick = () => { docState.tab = b.dataset.dt; renderDocs(); });
    const rows = all.filter(d => match(d) && (!pr || String(d.project_id) === pr) && (!q || [d.title, d.file_name, d.project_name, d.customer_company, d.customer_name, d.revision, d.tags].join(' ').toLowerCase().includes(q)));
    $('#documentsRows').innerHTML = rows.length ? rows.map(d => `<tr class="click" data-dsel="${d.id}"><td><b>${esc(d.title)}</b><small>${esc(d.file_name || '')}${d.size ? ' · ' + (d.size / 1048576).toFixed(1) + ' MB' : ''}</small></td><td>${esc(d.kind)}</td><td>${esc(d.revision || '—')}<small>v${d.version || 1}</small></td><td>${esc(d.project_name || d.customer_company || d.customer_name || '—')}</td><td>${d.sheet_count || '—'}</td>
      <td>${d.blueprint_status ? badge(d.blueprint_status) : d.analysis_status && d.analysis_status !== 'Not analyzed' ? badge(d.analysis_status) : '<span class="muted">—</span>'}</td><td>${fmtDate(d.created_at)}<small>${esc(String(d.uploaded_by || '').split('@')[0])}</small></td><td><span class="pill st-${d.status === 'Current' ? 'Approved' : d.status === 'Superseded' ? 'Expired' : 'Draft'}">${esc(d.status || 'Current')}</span></td>
      <td>${d.kind === 'Drawings' && d.status === 'Current' ? `<button class="btn small ghost" data-totake="${d.id}">Takeoff</button>` : ''}</td></tr>`).join('') : '<tr><td class="emptyrow" colspan="9">No files here. Upload a drawing set to start.</td></tr>';
    $$('#documentsRows [data-dsel]').forEach(r => r.onclick = e => { if (e.target.closest('[data-totake]')) return; showDoc(Number(r.dataset.dsel)); });
    $$('#documentsRows [data-totake]').forEach(b => b.onclick = () => { const d = docState.documents.find(x => x.id === Number(b.dataset.totake)); openTakeoff(null, d); });
  }
  async function showDoc(id) {
    docState.sel = id; let r; try { r = await api('/api/admin/docs/' + id); } catch (e) { return toast(e.message, true); }
    const d = r.document, bp = d.blueprint, isPdf = /\.pdf$/i.test(d.file_name || ''), cur = d.status === 'Current';
    $('#docSide').innerHTML = `<div class="card"><h2 style="font-size:17px;margin-bottom:2px">${esc(d.title)}</h2><p class="muted" style="margin:2px 0 8px">${esc(d.kind)} · ${esc(d.revision || 'no revision label')} · v${d.version || 1} · <span class="pill st-${cur ? 'Approved' : 'Expired'}">${esc(d.status)}</span><br>${esc(d.project_name || d.customer_company || d.customer_name || 'Not linked')} · ${fmtDate(d.created_at)} by ${esc(d.uploaded_by || '')}</p>
      ${r.newer ? `<p class="err" style="display:block">Superseded by <button class="linklike" data-dopen="${r.newer.id}">${esc(r.newer.revision || 'v' + r.newer.version)}</button>. Do not price or clean from this revision.</p>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${isPdf ? '<button class="btn ghost" id="dPrev">Preview</button>' : ''}<button class="btn ghost" id="dDl">Download</button>${cur ? '<button class="btn ghost" id="dRev">Upload new revision</button>' : ''}${cur && isPdf ? `<button class="btn" id="dAi">${bp ? 'Re-read with AI' : 'Read blueprint with AI'}</button>` : ''}${cur && bp ? '<button class="btn ghost" id="dTk">Create takeoff</button>' : ''}<button class="btn ghost" id="dArch">${d.status === 'Archived' ? 'Restore' : 'Archive'}</button></div></div>
      <div class="card"><h2 style="font-size:16px;display:flex;justify-content:space-between">Sheet index (${d.sheets.length}) <button class="btn small ghost" id="dSheets">Edit</button></h2>${d.sheets.length ? `<div class="tablewrap" style="max-height:220px;overflow:auto"><table class="t"><tbody>${d.sheets.map(s => `<tr><td><b>${esc(s.sheet)}</b></td><td>${esc(s.title || '')}</td><td><small>${esc(s.discipline || '')}</small></td><td><small>${esc(s.revision || '')}${s.source === 'AI' ? ' · AI' : ''}</small></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No sheets listed. Read the blueprint with AI or add sheets manually.</p>'}</div>
      ${bp ? `<div class="card"><h2 style="font-size:16px">Blueprint reading <small class="muted">AI, ${fmtWhen(bp.at)}</small></h2>
        <dl class="stat"><dt>Building area</dt><dd>${bp.building_sf ? Number(bp.building_sf).toLocaleString() + ' SF <small>(' + esc(bp.building_sf_sheet) + ')</small>' : '—'}</dd><dt>Floors</dt><dd>${bp.floors ? bp.floors + ' <small>(' + esc(bp.floors_sheet) + ')</small>' : '—'}</dd><dt>Rooms read</dt><dd>${bp.rooms.length}</dd><dt>Room area total</dt><dd>${Math.round(bp.rooms.reduce((s, x) => s + (x.area_sf || 0), 0)).toLocaleString()} SF</dd></dl>
        ${bp.counts.length ? `<h3 class="secth">Counts</h3>${bp.counts.map(c => `<p style="margin:3px 0">${esc(c.item)}: <b>${c.quantity}</b> <small class="muted">${esc(c.sheet)} · ${esc(c.confidence)}</small></p>`).join('')}` : ''}
        ${bp.rooms.length ? `<h3 class="secth">Rooms</h3><div class="tablewrap" style="max-height:220px;overflow:auto"><table class="t"><tbody>${bp.rooms.slice(0, 200).map(x => `<tr><td>${esc(x.number || '')} ${esc(x.name)}</td><td class="num">${x.area_sf ? x.area_sf.toLocaleString() + ' SF' : '—'}</td><td><small>${esc(x.floor_finish || '')}</small></td><td><small>${esc(x.sheet)} · ${esc(x.confidence)}</small></td></tr>`).join('')}</tbody></table></div>` : ''}
        ${bp.finishes.length ? `<h3 class="secth">Floor finishes</h3>${bp.finishes.map(f => `<p style="margin:3px 0">${esc(f.finish)} — ${esc(f.areas)} <small class="muted">${esc(f.sheet)}</small></p>`).join('')}` : ''}
        ${bp.cleaning_notes.length ? `<h3 class="secth">Cleaning notes</h3>${bp.cleaning_notes.map(n => `<p style="margin:3px 0">• ${esc(n.note)} <small class="muted">${esc(n.sheet)}</small></p>`).join('')}` : ''}
        ${bp.questions.length ? `<h3 class="secth" style="color:#c0362d">Questions for the GC (${bp.questions.length})</h3>${bp.questions.map(q => `<p style="margin:3px 0">? ${esc(q)}</p>`).join('')}` : ''}
        ${bp.dropped_without_sheet ? `<p class="muted"><small>${bp.dropped_without_sheet} AI finding(s) without a sheet reference were discarded.</small></p>` : ''}</div>` : ''}
      ${r.takeoffs.length ? `<div class="card"><h2 style="font-size:16px">Takeoffs</h2>${r.takeoffs.map(t => `<p style="margin:4px 0"><button class="linklike" data-tko="${t.id}">${esc(t.name)}</button> ${badge(t.status)}${t.stale_note ? `<br><small style="color:#c0362d">${esc(t.stale_note)}</small>` : ''}</p>`).join('')}</div>` : ''}
      ${r.history.length ? `<div class="card"><h2 style="font-size:16px">Revision history</h2>${r.history.map(h => `<p style="margin:4px 0"><button class="linklike" data-dopen="${h.id}">${esc(h.revision || 'v' + h.version)}</button> <small class="muted">${fmtDate(h.created_at)} · ${esc(h.uploaded_by || '')}</small></p>`).join('')}</div>` : ''}`;
    const act = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    act('#dDl', () => downloadFile({ name: d.file_name || d.title, url: d.file_url }));
    act('#dPrev', async () => { try { const x = await fetch(d.file_url, { headers: { Authorization: 'Bearer ' + token } }); if (!x.ok) throw new Error('Could not open the file.'); const u = URL.createObjectURL(await x.blob()); window.open(u, '_blank'); } catch (e) { toast(e.message, true); } });
    act('#dRev', () => openForm({ title: 'Upload new revision', sub: 'The current file becomes Superseded and stays in the history. Takeoffs from it are flagged for a recheck.', defs: [{ name: 'file', label: 'Revised file', type: 'file' }, { name: 'revision', label: 'Revision label', placeholder: 'e.g. Rev 2, Addendum 1, IFC' }, { name: 'notes', label: 'What changed', wide: true }],
      submit: async b => { const fd = new FormData(); const f = b.file && (b.file[0] || b.file); if (f) fd.append('file', f); fd.append('revision', b.revision || ''); fd.append('notes', b.notes || ''); const x = await fetch(`/api/admin/docs/${d.id}/revision`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd }); const j = await x.json().catch(() => ({})); if (!x.ok) throw new Error(j.error || 'Upload failed'); return j; },
      after: x => { toast(x.takeoffs_flagged ? `New revision uploaded; ${x.takeoffs_flagged} takeoff(s) flagged for recheck` : 'New revision uploaded'); docState.sel = x.id; loadDocuments(); } }));
    act('#dAi', async () => { const b = $('#dAi'); b.disabled = true; b.textContent = 'Reading the drawings… (up to a few minutes)'; try { const x = await api(`/api/admin/ai/documents/${d.id}/blueprint`, { method: 'POST' }); toast(`Read ${x.blueprint.sheets.length} sheets, ${x.blueprint.rooms.length} rooms, ${x.blueprint.questions.length} questions`); loadDocuments(); } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Read blueprint with AI'; } });
    act('#dTk', async () => { try { const x = await api(`/api/admin/docs/${d.id}/takeoff`, { method: 'POST' }); toast(`Takeoff #${x.takeoff_id} drafted for your review`); go('takeoffs'); } catch (e) { toast(e.message, true); } });
    act('#dArch', async () => { try { await api('/api/admin/docs/' + d.id, { method: 'PATCH', json: { archive: d.status !== 'Archived' } }); toast(d.status === 'Archived' ? 'Restored' : 'Archived'); loadDocuments(); } catch (e) { toast(e.message, true); } });
    act('#dSheets', () => openForm({ title: 'Sheet index', sub: 'One sheet per line: Sheet | Title | Revision. The discipline comes from the sheet letter (A = Architectural, M = Mechanical…).', defs: [{ name: 'sheets', label: 'Sheets', type: 'textarea', wide: true }], values: { sheets: d.sheets.map(s => [s.sheet, s.title, s.revision].join(' | ')).join('\n') },
      submit: b => api(`/api/admin/docs/${d.id}/sheets`, { method: 'PUT', json: { sheets: b.sheets.split('\n').map(l => l.split('|').map(x => x.trim())).filter(a => a[0]).map(([sheet, title, revision]) => ({ sheet, title, revision })) } }), after: () => { toast('Sheet index saved'); loadDocuments(); } }));
    $$('#docSide [data-dopen]').forEach(b => b.onclick = () => showDoc(Number(b.dataset.dopen)));
    $$('#docSide [data-tko]').forEach(b => b.onclick = () => { go('takeoffs'); });
  }
  function uploadDocs(preset) {
    preset = preset || {};
    openForm({ title: 'Upload drawings & documents', values: preset, defs: [
      { name: 'files', label: 'Files (up to 8, 30 MB each)', type: 'file' }, { name: 'kind', label: 'Type', type: 'select', options: docState.kinds.length ? docState.kinds : ['Drawings', 'Specifications', 'Addendum', 'Finish schedule', 'Photos', 'Other'] },
      { name: 'revision', label: 'Revision', placeholder: 'e.g. IFC, Rev 3, Addendum 2' }, { name: 'title', label: 'Title (single file only)' },
      { name: 'project_id', label: 'Project', type: 'project' }, { name: 'customer_id', label: 'Customer', type: 'customer' }],
      submit: async b => { const fd = new FormData(); [...(b.files || [])].forEach(f => fd.append('files', f)); for (const k of ['kind', 'revision', 'title', 'project_id', 'customer_id']) fd.append(k, b[k] || ''); return api('/api/admin/documents', { method: 'POST', body: fd }); },
      after: res => { toast(`${res.ids.length} file(s) uploaded`); if (preset.project_id && state.view === 'projects') openProject(Number(preset.project_id)); else { go('documents'); loadDocuments(); } } });
  }

  // ---------- Email Center ----------
  const mailState = { emails: [] };
  $('#emailSearch').addEventListener('input', () => renderEmails()); $('#emailStatus').addEventListener('change', () => renderEmails());
  async function loadEmails() {
    const [r, ms] = await Promise.all([api('/api/admin/emails'), api('/api/admin/m365/status').catch(() => ({}))]); mailState.emails = r.emails;
    kpiTiles('#emailsKpis', [{ label: 'Sent (30 days)', value: r.summary.sent_30d }, { label: 'Failed (30 days)', value: r.summary.failed_30d, alert: r.summary.failed_30d > 0 }, { label: 'Total (30 days)', value: r.summary.total_30d }, { label: 'Outlook inbox here', value: ms.connected ? 'Connected' : ms.configured ? 'Ready to connect' : 'Not set up', sub: ms.connected ? `${ms.account || ''} · ${ms.messages} messages${ms.last_sync ? ' · synced ' + fmtWhen(ms.last_sync) : ''}` : ms.configured ? 'click to connect' : 'click for setup steps', alert: !!ms.last_error }]);
    $('#navEmails').hidden = !r.summary.failed_30d; $('#navEmails').textContent = r.summary.failed_30d;
    { const tiles = $$('#emailsKpis > *'); const t = tiles[3]; if (t) { t.style.cursor = 'pointer'; t.onclick = () => openM365(ms); } }
    let ib = document.getElementById('inboxCard');
    if (ms.connected) { if (!ib) { ib = document.createElement('div'); ib.id = 'inboxCard'; ib.className = 'card'; ib.style.cssText = 'margin:14px 0;padding:14px'; $('#emailsKpis').after(ib); }
      const m = await api('/api/admin/inbox').catch(() => ({ messages: [] }));
      ib.innerHTML = `<h2 style="margin:0 0 8px;font-size:17px">Inbox (Outlook)</h2>${m.messages.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Linked to</th></tr></thead><tbody>${m.messages.slice(0, 50).map(x => `<tr><td>${esc(fmtWhen(x.received_at))}</td><td>${esc(x.from_name || x.from_addr)}<small>${esc(x.from_addr)}</small></td><td>${x.web_link ? `<a href="${esc(x.web_link)}" target="_blank" rel="noopener">${esc(x.subject || '(no subject)')}</a>` : esc(x.subject || '')}<small>${esc(String(x.preview || '').slice(0, 120))}</small></td><td>${x.lead_id ? `<a href="#" data-ilead="${x.lead_id}">Lead #${x.lead_id}</a>` : ''}${x.customer_id ? ` <a href="#" data-icust="${x.customer_id}">Customer #${x.customer_id}</a>` : ''}${!x.lead_id && !x.customer_id ? '<span class="muted">—</span>' : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No messages synced yet.</p>'}`;
      $$('#inboxCard [data-ilead]').forEach(a => a.onclick = ev => { ev.preventDefault(); go('leads'); setTimeout(() => openLead(Number(a.dataset.ilead)), 350); });
      $$('#inboxCard [data-icust]').forEach(a => a.onclick = ev => { ev.preventDefault(); go('customers'); setTimeout(() => openCustomerPage(Number(a.dataset.icust)), 350); });
    } else if (ib) ib.remove();
    renderEmails();
  }
  function openM365(ms) {
    const steps = `<ol style="padding-left:18px;line-height:1.6"><li>Sign in to <b>portal.azure.com</b> with the Microsoft 365 admin account → <b>Microsoft Entra ID</b> → <b>App registrations</b> → <b>New registration</b>.</li>
      <li>Name: <i>Bright Clean Operations</i>. Supported accounts: <i>this organizational directory only</i>. Redirect URI (Web): <code>${esc(ms.redirect_uri || 'https://brightclean.net/api/m365/callback')}</code></li>
      <li><b>API permissions</b> → Add → Microsoft Graph → <b>Delegated</b>: <code>Mail.Read</code>, <code>User.Read</code>, <code>offline_access</code> → Grant admin consent.</li>
      <li><b>Certificates &amp; secrets</b> → New client secret → copy its <b>Value</b>.</li>
      <li>In Render → brightclean-web → Environment add <code>MS365_CLIENT_ID</code> (Application ID), <code>MS365_TENANT_ID</code> (Directory ID) and <code>MS365_CLIENT_SECRET</code> (the secret value). Save.</li>
      <li>Come back here and click <b>Connect Outlook</b>.</li></ol><p class="muted">Read-only: the system can read the inbox to link replies to leads and customers. It cannot send, move or delete mail.</p>`;
    openDrawer({ title: 'Outlook inbox (Microsoft 365)', sub: ms.connected ? `Connected as ${ms.account}` : ms.configured ? 'Ready to connect' : 'Not set up yet',
      body: `${ms.last_error ? `<p class="msg err">Last problem: ${esc(ms.last_error)}</p>` : ''}${ms.connected ? `<p>Connected as <b>${esc(ms.account || '')}</b>. ${ms.messages} messages synced${ms.last_sync ? `, last sync ${esc(fmtWhen(ms.last_sync))}` : ''}. New mail is checked every 3 minutes.</p>` : ms.configured ? '<p>The app registration is in place. Click Connect Outlook and sign in with the mailbox to read (for example info@brightclean.net).</p>' : steps}`,
      footer: `<button class="btn ghost" data-close>Close</button>${ms.connected ? '<button class="btn ghost" id="m365Sync">Sync now</button><button class="btn ghost" id="m365Disc">Disconnect</button>' : ms.configured ? '<button class="btn" id="m365Conn">Connect Outlook</button>' : ''}` });
    if ($('#m365Conn')) $('#m365Conn').onclick = async () => { try { const r = await api('/api/admin/m365/connect', { method: 'POST', json: {} }); location.href = r.url; } catch (e) { toast(e.message, true); } };
    if ($('#m365Sync')) $('#m365Sync').onclick = async () => { try { const r = await api('/api/admin/m365/sync', { method: 'POST', json: {} }); toast(r.error ? 'Sync problem: ' + r.error : `Synced: ${r.added || 0} new`, !!r.error); closeDrawer(); loadEmails(); } catch (e) { toast(e.message, true); } };
    if ($('#m365Disc')) $('#m365Disc').onclick = async () => { if (!confirm('Disconnect the Outlook inbox? Already-synced messages stay.')) return; try { await api('/api/admin/m365/disconnect', { method: 'POST', json: {} }); toast('Disconnected'); closeDrawer(); loadEmails(); } catch (e) { toast(e.message, true); } };
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
    const T = r.takeoffs, val = T.reduce((s, t) => s + ((t.priced && JSON.parse(t.priced).total) || 0), 0);
    $('#takeoffKpis').innerHTML = [kt('takeoffs', 'blue', 'Takeoffs', T.length, ''), kt('clock', 'amber', 'Drafts', T.filter(t => t.status === 'Draft').length, ''), kt('check', 'green', 'Estimated', T.filter(t => t.status === 'Estimated').length, ''),
      kt('scopes', 'navy', 'Square feet taken off', Math.round(T.reduce((s, t) => s + (Number(t.building_sf) || 0), 0)).toLocaleString(), ''), kt('money', 'teal', 'Value priced', money(val), 'converted to estimates'), kt('issues', 'red', 'Need recheck', T.filter(t => t.stale_note).length, 'drawings revised')].join('');
    $('#takeoffsRows').innerHTML = T.length ? T.map(t => `<tr class="click" data-to="${t.id}"><td><b>${esc(t.name)}</b><small>${esc(t.customer_company || t.customer_name || '')}${t.version > 1 ? ' · v' + t.version : ''}</small>${t.stale_note ? `<small style="color:#c0362d">${esc(t.stale_note)}</small>` : ''}</td><td>${esc(t.document_title || '—')}<small>${esc(t.document_revision || '')}</small></td><td>${esc(CATN[t.category] || t.category)}</td><td class="num">${t.building_sf ? Number(t.building_sf).toLocaleString() : '—'}</td><td class="num">${t.lines.length}</td>
      <td class="num">${t.priced ? money(JSON.parse(t.priced).total) : '—'}</td><td>${badge(t.status)}${t.estimate_id ? ` <button class="linklike" data-est="${t.estimate_id}">#${t.estimate_id}</button>` : ''}</td><td><button class="btn small ghost" data-price="${t.id}">Price</button></td></tr>`).join('') : '<tr><td class="emptyrow" colspan="8">No takeoffs yet. Start one from a drawing set or click New takeoff.</td></tr>';
    $$('#takeoffsRows [data-to]').forEach(r => r.onclick = e => { if (e.target.closest('[data-est],[data-price]')) return; openTakeoff(toState.takeoffs.find(t => t.id === Number(r.dataset.to)), null); });
    $$('#takeoffsRows [data-price]').forEach(b => b.onclick = () => openPricing(Number(b.dataset.price)));
    bindOpeners($('#takeoffsRows'));
  }
  async function openPricing(id) {
    let d; try { d = await api(`/api/admin/takeoffs/${id}/price`); } catch (e) { return toast(e.message, true); }
    const t = d.takeoff, a = t.adjustments || {};
    const draw = p => `<div class="tablewrap"><table class="t" style="min-width:0;width:100%;table-layout:fixed"><colgroup><col><col style="width:70px"><col style="width:112px"></colgroup><thead><tr><th>Line</th><th>Sheet</th><th class="num">Amount</th></tr></thead><tbody>${p.lines.map(l => `<tr><td>${esc(l.description)}<small>${money(l.unit_price)}/${esc(l.unit)} · ${esc(l.method || '')}${l.hours ? ' · ' + l.hours + ' h' : ''}</small></td><td>${esc(l.sheet || '—')}</td><td class="num">${money(l.amount)}</td></tr>`).join('')}
        <tr><td colspan="2"><b>Price book subtotal</b></td><td class="num"><b>${money(p.base)}</b></td></tr>${p.factors.map(f => `<tr><td colspan="2">${esc(f.label)} (${f.pct > 0 ? '+' : ''}${f.pct}%)</td><td class="num">${money(p.base * f.pct / 100)}</td></tr>`).join('')}
        ${p.mobilization ? `<tr><td colspan="2">Mobilization</td><td class="num">${money(p.mobilization)}</td></tr>` : ''}${p.travel ? `<tr><td colspan="2">Travel</td><td class="num">${money(p.travel)}</td></tr>` : ''}${p.minimum_applied ? `<tr><td colspan="2">Minimum job charge applied</td><td class="num">${money(p.minimum - p.subtotal)}</td></tr>` : ''}
        <tr><td colspan="2"><b>Total</b></td><td class="num"><b style="font-size:18px">${money(p.total)}</b></td></tr></tbody></table></div>
      <dl class="stat"><dt>Labor hours</dt><dd>${p.hours || '—'}</dd><dt>Labor cost</dt><dd>${p.labor_cost != null ? money(p.labor_cost) : '—'}</dd><dt>Estimated margin</dt><dd style="color:${p.margin_pct != null && p.margin_pct < p.margin_target ? '#c0362d' : 'inherit'}">${p.margin_pct != null ? p.margin_pct + '%' : '—'} <small class="muted">target ${p.margin_target}%</small></dd><dt>Price per SF</dt><dd>${p.per_sf != null ? '$' + p.per_sf : '—'}</dd></dl>
      ${p.warnings.length ? `<div class="err" style="display:block">${p.warnings.map(w => '⚠ ' + esc(w)).join('<br>')}</div>` : '<p class="muted">No warnings.</p>'}`;
    openDrawer({ title: `Price: ${t.name}`, sub: `${esc(CATN[t.category] || t.category)}${t.building_sf ? ' · ' + Number(t.building_sf).toLocaleString() + ' SF' : ''} · v${t.version || 1}${t.estimate_id ? ' · estimate #' + t.estimate_id : ''}`,
      body: `<form class="ig" id="prForm"><div class="wide"><label>Difficulty factors</label>${d.factors.map(f => `<label class="chkrow"><input type="checkbox" name="f_${f.key}" ${(a.factors || []).includes(f.key) ? 'checked' : ''}><span>${esc(f.label)}</span><small class="muted">+${f.pct}%</small></label>`).join('')}</div>
        <div><label>Custom adjustment</label><input name="c_label" value="${esc(((a.custom || [])[0] || {}).label || '')}" placeholder="e.g. Repeat customer"></div><div><label>Custom %</label><input name="c_pct" inputmode="decimal" value="${esc(((a.custom || [])[0] || {}).pct || '')}" placeholder="-5"></div>
        <div><label>Mobilization ($)</label><input name="mobilization" inputmode="decimal" value="${esc(a.mobilization || '')}"></div><div><label>Travel ($)</label><input name="travel" inputmode="decimal" value="${esc(a.travel || '')}"></div>
        <div><label>Minimum job charge ($)</label><input name="minimum" inputmode="decimal" value="${esc(a.minimum || '')}"></div><div><label>Loaded labor rate ($/h)</label><input name="labor_rate" inputmode="decimal" value="${esc(a.labor_rate || '')}"></div>
        <div><label>Margin target (%)</label><input name="margin_target" inputmode="decimal" value="${esc(a.margin_target || 30)}"></div></form>
        <div id="prOut" style="margin-top:12px">${d.price ? draw(d.price) : ''}</div>`,
      footer: `<button class="btn ghost" data-close>Close</button>${t.stale_note ? '<button class="btn ghost" id="prVer">New version from current drawings</button>' : ''}<button class="btn ghost" id="prCalc">Recalculate</button><button class="btn" id="prEst">${t.estimate_id ? 'Update draft estimate' : 'Create estimate'}</button>` });
    const save = async () => { const f = formObj($('#prForm')); const body = { factors: d.factors.filter(x => f['f_' + x.key]).map(x => x.key), custom: f.c_label && f.c_pct ? [{ label: f.c_label, pct: f.c_pct }] : [], mobilization: f.mobilization, travel: f.travel, minimum: f.minimum, labor_rate: f.labor_rate, margin_target: f.margin_target };
      const r = await api(`/api/admin/takeoffs/${id}/adjustments`, { method: 'PUT', json: body }); if (r.error) throw new Error(r.error); $('#prOut').innerHTML = draw(r.price); return r.price; };
    $('#prCalc').onclick = async () => { try { await save(); } catch (e) { toast(e.message, true); } };
    $$('#prForm input[type=checkbox]').forEach(c => c.onchange = () => save().catch(e => toast(e.message, true)));
    $('#prEst').onclick = async () => { try { await save(); let cn = ''; if (!t.customer_id) { cn = prompt('This takeoff is not linked to a customer. Customer or company name for the estimate:'); if (!cn) return; } let r; try { r = await api(`/api/admin/takeoffs/${id}/estimate`, { method: 'POST', json: { customer_name: cn } }); } catch (e) { if (/revised|recheck/i.test(e.message) && confirm(e.message + '\n\nConfirm the quantities are still right and continue?')) r = await api(`/api/admin/takeoffs/${id}/estimate`, { method: 'POST', json: { customer_name: cn, acknowledge_stale: true } }); else throw e; }
      toast(r.updated ? `Draft estimate #${r.estimate_id} re-priced: ${money(r.total)}` : `Estimate #${r.estimate_id} created: ${money(r.total)}`); closeDrawer(); go('proposals'); openEstimate(r.estimate_id); } catch (e) { toast(e.message, true); } };
    const v = $('#prVer'); if (v) v.onclick = async () => { try { const r = await api(`/api/admin/takeoffs/${id}/version`, { method: 'POST' }); toast(`Version ${r.version} created on the current drawings. Recheck the quantities.`); closeDrawer(); loadTakeoffs(); openTakeoff((await api('/api/admin/takeoffs')).takeoffs.find(x => x.id === r.id), null); } catch (e) { toast(e.message, true); } };
    $$('#drawerRoot [data-close]').forEach(el => el.onclick = closeDrawer);
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
        let cn = ''; if (!saved.customer_id) { cn = prompt('This takeoff is not linked to a customer. Customer or company name for the estimate:') || ''; if (!cn) throw new Error('Choose the customer on the takeoff (or enter a customer name) to create the estimate.'); }
        let r; try { r = await api(`/api/admin/takeoffs/${saved.id}/estimate`, { method: 'POST', json: { customer_name: cn } }); }
        catch (e) { if (/revised|recheck/i.test(e.message) && confirm(e.message + '\n\nConfirm the quantities are still right and continue?')) r = await api(`/api/admin/takeoffs/${saved.id}/estimate`, { method: 'POST', json: { customer_name: cn, acknowledge_stale: true } }); else throw e; }
        toast(r.updated ? `Draft estimate #${r.estimate_id} re-priced` : `Estimate #${r.estimate_id} created from the takeoff`); closeDrawer(); go('proposals'); openEstimate(r.estimate_id);
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

  // ---------- Issues & tasks (mockup layout) ----------
  const issState = { issues: [], options: null, counts: {}, group: '', page: 1 };
  const ITYPE = { complaint: ['issues', 'red', 'Issue'], service_request: ['scopes', 'green', 'Request'], incident: ['issues', 'amber', 'Incident'], task: ['cal', 'blue', 'Task'], follow_up: ['calls', 'blue', 'Follow-up'], note: ['note', 'purple', 'Note'] };
  const initials = e => { const n = String(e || '').split('@')[0].split(/[._-]/).filter(Boolean); return ((n[0] || '?')[0] + ((n[1] || '')[0] || '')).toUpperCase(); };
  const pillCls = s => String(s).replace(/\s+/g, '-');
  ['#issStatus', '#issCat', '#issPri', '#issAssigned', '#issSource', '#issCust', '#issType', '#issMine'].forEach(sel => $(sel).addEventListener('change', () => { issState.page = 1; loadIssues(); }));
  let issT; $('#issSearch').addEventListener('input', () => { clearTimeout(issT); issT = setTimeout(() => { issState.page = 1; loadIssues(); }, 250); });
  $('#issAdd').addEventListener('click', () => openIssue(null, null));
  $('#issCsv').addEventListener('click', () => {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`, rows = [['Number', 'Type', 'Title', 'Customer', 'Contact', 'Property', 'Project', 'Category', 'Priority', 'Source', 'Assigned to', 'Due', 'Status', 'Created', 'Resolved'], ...issState.issues.map(i => [i.number, issState.options.types[i.type], i.title, i.customer_company || i.customer_name, i.contact_name, i.property_name || i.property, i.project_name, i.category, i.priority, i.source, i.assigned_to, i.due_date, i.status, i.created_at, i.resolved_at])];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' })); a.download = 'issues-and-tasks.csv'; a.click();
  });
  async function loadIssues() {
    const q = new URLSearchParams({ status: $('#issStatus').value });
    if (issState.group) q.set('group', issState.group);
    for (const [sel, k] of [['#issCat', 'category'], ['#issPri', 'priority'], ['#issSource', 'source'], ['#issCust', 'customer_id'], ['#issType', 'type']]) if ($(sel).value) q.set(k, $(sel).value);
    if ($('#issAssigned').value) q.set('assigned', $('#issAssigned').value); else if ($('#issMine').checked) q.set('assigned', 'me');
    if ($('#issSearch').value.trim()) q.set('q', $('#issSearch').value.trim());
    const r = await api('/api/admin/issues?' + q);
    Object.assign(issState, { issues: r.issues, options: r.options, counts: r.counts });
    const n = r.counts.open_complaints + r.counts.overdue;
    $('#navIssues').hidden = !n; $('#navIssues').textContent = n;
    const fill = (sel, items, label) => { const cur = $(sel).value; $(sel).innerHTML = `<option value="">${label}</option>` + items.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join(''); $(sel).value = cur; };
    fill('#issCat', r.options.categories.map(c => [c, c]), 'Category: All'); fill('#issSource', r.options.sources.map(c => [c, c]), 'Source: All');
    { const cur = $('#issAssigned').value; $('#issAssigned').innerHTML = '<option value="">Assigned: All</option><option value="me">Assigned to me</option><option value="none">Unassigned</option>' + r.options.users.map(u => `<option>${esc(u)}</option>`).join(''); $('#issAssigned').value = cur; }
    if (!state.customers || !state.customers.length) { try { state.customers = (await api('/api/admin/customers')).customers; } catch { state.customers = []; } }
    fill('#issCust', state.customers.map(c => [c.id, c.company || c.name || c.email]), 'Customer: All');
    const k = r.counts;
    $('#issKpis').innerHTML = [['issues', 'red', 'Open issues', k.open, 'Awaiting resolution', ''], ['issues', 'amber', 'High priority', k.high, k.urgent ? `${k.urgent} urgent` : 'Require attention', ''], ['cal', 'blue', 'Due today', k.due_today, 'Tasks and follow-ups', ''], ['clock', 'red', 'Overdue', k.overdue, 'Past due date', k.overdue ? 'alert' : ''], ['check', 'green', 'Resolved (this month)', k.resolved_month, 'Completed records', 'good']]
      .map(([icn, tone, l, v, sub, cls]) => kt(icn, tone, l, v, sub).replace('class="ktile"', `class="ktile ${cls}"`)).join('');
    $('#issTabs').innerHTML = [['', 'All items', k.all_n], ['issues', 'Issues', k.n_issues], ['tasks', 'Tasks', k.n_tasks], ['notes', 'Notes', k.n_notes], ['requests', 'Requests', k.n_requests], ['incidents', 'Incidents', k.n_incidents]]
      .map(([g, l, c]) => `<button role="tab" data-g="${g}" class="${issState.group === g ? 'on' : ''}">${l} (${c})</button>`).join('');
    $$('#issTabs button').forEach(b => b.onclick = () => { issState.group = b.dataset.g; issState.page = 1; loadIssues(); });
    renderIssues();
  }
  function renderIssues() {
    const o = issState.options, per = 10, all = issState.issues, pages = Math.max(1, Math.ceil(all.length / per));
    issState.page = Math.min(issState.page, pages);
    const rows = all.slice((issState.page - 1) * per, issState.page * per);
    $('#issRows').innerHTML = rows.length ? rows.map(i => { const [icn, tone] = ITYPE[i.type] || ITYPE.task; return `<tr class="click" data-issue="${i.id}">
      <td><div class="itm"><span class="chip ${tone}">${ic(icn)}</span><span><b>${esc(i.title)}</b><small>${esc(i.number)}${i.escalated ? ' · <span style="color:#d1382f">escalated</span>' : ''}</small></span></div></td>
      <td><b>${esc(i.customer_company || i.customer_name || '—')}</b><small>${esc(i.contact_name || '')}</small></td>
      <td>${esc(i.property_name || i.property || '—')}<small>${esc(i.project_name || i.work_order || '')}</small></td>
      <td><span class="pill t-${i.type}">${esc((ITYPE[i.type] || [])[2] || o.types[i.type])}</span></td><td>${esc(i.category || '—')}</td>
      <td><span class="pill p-${i.priority}">${esc(i.priority)}</span></td>
      <td>${i.assigned_to ? `<span class="avs"><i>${initials(i.assigned_to)}</i>${esc(i.assigned_to.split('@')[0])}</span>` : '<span class="muted">—</span>'}</td>
      <td class="${i.overdue ? 'due-late' : ''}">${i.due_date ? fmtDate(i.due_date) : '—'}${i.overdue ? '<small style="color:#d1382f">overdue</small>' : ''}</td>
      <td><span class="pill s-${pillCls(i.status)}">${esc(i.status)}</span></td></tr>`; }).join('')
      : `<tr><td class="emptyrow" colspan="9">${$('#issStatus').value === 'open' ? 'No open items. Nice.' : 'Nothing matches.'}</td></tr>`;
    $('#issShowing').textContent = all.length ? `Showing ${(issState.page - 1) * per + 1} – ${Math.min(issState.page * per, all.length)} of ${all.length} items` : '';
    $('#issPages').innerHTML = pages > 1 ? Array.from({ length: pages }, (_, n) => `<button class="${n + 1 === issState.page ? 'on' : ''}" data-pg="${n + 1}">${n + 1}</button>`).join('') : '';
    $$('#issPages button').forEach(b => b.onclick = () => { issState.page = Number(b.dataset.pg); renderIssues(); });
    $$('[data-issue]').forEach(r => r.onclick = () => openIssue(issState.issues.find(i => i.id === Number(r.dataset.issue)), null));
  }
  const TYPEPICK = [['complaint', 'issues', 'Issue / Complaint'], ['task', 'cal', 'Task / Follow-up'], ['note', 'note', 'Internal note'], ['service_request', 'scopes', 'Service request'], ['incident', 'quality', 'Incident']];
  const SAVE_LABEL = { complaint: 'Create issue', service_request: 'Create request', incident: 'Log incident', task: 'Create task', follow_up: 'Create follow-up', note: 'Save note' };
  async function openIssue(it, cust) {
    if (!issState.options) { try { const r = await api('/api/admin/issues?status=open'); issState.options = r.options; } catch (e) { return toast(e.message, true); } }
    if (!state.customers || !state.customers.length) { try { state.customers = (await api('/api/admin/customers')).customers; } catch { state.customers = []; } }
    const o = issState.options, isNew = !it;
    let det = null;
    if (!isNew) { try { det = await api('/api/admin/issues/' + it.id); it = det.issue; } catch (e) { return toast(e.message, true); } }
    it = it || { type: 'complaint', priority: 'Normal', status: 'Open', customer_comms: 'Needs update', customer_id: cust ? cust.id : '', source: '' };
    let type = it.type, pri = it.priority;
    const opt = (list, sel, labels) => list.map(v => `<option value="${esc(v)}"${String(v) === String(sel ?? '') ? ' selected' : ''}>${esc(labels ? labels[v] : v)}</option>`).join('');
    const v = k => esc(it[k] == null ? '' : it[k]);
    const isOpenSt = s => !['Resolved', 'Verified', 'Closed'].includes(s);
    const body = () => {
      const t = type, note = t === 'note', taskish = ['task', 'follow_up'].includes(t), cx = ['complaint', 'incident'].includes(t);
      return `${isNew ? `<div class="typepick" role="radiogroup" aria-label="Item type">${TYPEPICK.map(([k, icn, l]) => `<button type="button" role="radio" data-ty="${k}" class="${(k === t || (k === 'task' && t === 'follow_up')) ? 'on' : ''}" aria-checked="${k === t}">${ic(icn)}<span>${l}</span></button>`).join('')}</div>` : `<p class="muted" style="margin-top:0">${esc(it.number)} · ${esc(o.types[t])} · created ${fmtWhen(it.created_at)} by ${esc(it.created_by || '—')}</p>`}
      <p class="err" id="issMsg" role="alert" hidden></p>
      <form id="issForm" class="ig" novalidate><input type="hidden" name="type" value="${esc(t)}">
        ${taskish ? `<div class="wide"><label>Kind</label><div class="segpri" id="tkind"><button type="button" data-k="task" class="${t === 'task' ? 'on' : ''}">Task</button><button type="button" data-k="follow_up" class="${t === 'follow_up' ? 'on' : ''}">Follow-up</button></div></div>` : ''}
        <div><label for="i_cust">Customer${cx || t === 'service_request' ? ' *' : ''}</label><select id="i_cust" name="customer_id"><option value="">${note || taskish ? 'None (internal)' : 'Choose customer'}</option>${state.customers.map(c => `<option value="${c.id}"${String(c.id) === String(it.customer_id ?? '') ? ' selected' : ''}>${esc(c.company || c.name || c.email)}</option>`).join('')}</select></div>
        <div><label for="i_contact">Contact</label><select id="i_contact" name="contact_id"><option value="">—</option></select></div>
        ${note ? '' : `<div><label for="i_prop">Property / location</label><select id="i_prop" name="property_id"><option value="">—</option></select></div>
        <div><label for="i_proj">Project</label><select id="i_proj" name="project_id"><option value="">—</option></select></div>`}
        ${note ? '' : `<div><label for="i_src">Reported through</label><select id="i_src" name="source"><option value="">—</option>${opt(o.sources, it.source)}</select></div>`}
        <div><label for="i_cat">Category${note ? '' : ' *'}</label><select id="i_cat" name="category"><option value="">—</option>${opt(o.categories.includes(it.category) || !it.category ? o.categories : [it.category, ...o.categories], it.category)}</select></div>
        ${note ? '' : `<div class="${cx || t === 'service_request' ? '' : 'wide'}"><label>Priority *</label><div class="segpri" id="i_pri">${o.priorities.map(p => `<button type="button" data-p="${p}" class="${p === pri ? 'on' : ''}">${p}</button>`).join('')}</div></div>`}
        ${t === 'incident' ? '<div><label for="i_rep">Reported by</label><input id="i_rep" name="reported_by" value="' + v('reported_by') + '"></div>' : ''}
        <div class="wide"><label for="i_title">Title *</label><input id="i_title" name="title" maxlength="200" value="${v('title')}" required></div>
        <div class="wide"><label for="i_desc">${note ? 'Note' : 'Details'} *</label><textarea id="i_desc" name="description" rows="3">${v('description')}</textarea></div>
        ${note ? '' : `<div><label for="i_asg">Assigned to</label><select id="i_asg" name="assigned_to"><option value="">Unassigned</option>${opt(o.users, it.assigned_to)}</select></div>
        <div><label for="i_due">Due date</label><input id="i_due" type="date" name="due_date" value="${v('due_date')}"></div>
        <div><label for="i_rem">Reminder</label><input id="i_rem" type="datetime-local" name="reminder_at" value="${it.reminder_at ? new Date(new Date(it.reminder_at).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}"></div>
        <div><label for="i_wo">Work order</label><input id="i_wo" name="work_order" value="${v('work_order')}" placeholder="e.g. WO-1042"></div>
        ${taskish ? `<div><label for="i_rec">Repeat</label><select id="i_rec" name="recurrence">${opt(o.recurrence, it.recurrence, { '': 'Does not repeat', daily: 'Daily', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' })}</select></div>` : ''}
        <div class="wide"><label for="i_req">Required action</label><textarea id="i_req" name="required_action" rows="2">${v('required_action')}</textarea></div>`}
        ${!isNew && !note ? `<div><label for="i_status">Status</label><select id="i_status" name="status">${opt(o.statuses, it.status)}</select></div>
        ${cx || t === 'service_request' ? `<div><label for="i_comms">Customer update</label><select id="i_comms" name="customer_comms">${opt(o.comms, it.customer_comms)}</select></div>` : '<div></div>'}
        <div class="wide"><label for="i_res">Resolution</label><textarea id="i_res" name="resolution" rows="2" placeholder="What was done to resolve it">${v('resolution')}</textarea></div>
        ${cx ? `<div class="wide"><label for="i_ca">Corrective action</label><textarea id="i_ca" name="corrective_action" rows="2" placeholder="What changes so it doesn't happen again">${v('corrective_action')}</textarea></div>
        <div class="wide"><label for="i_vn">Verification</label>${it.verified_by ? `<p class="muted" style="margin:0">Verified by <b>${esc(it.verified_by)}</b> on ${fmtWhen(it.verified_at)}${it.verification_note ? ' — ' + esc(it.verification_note) : ''}</p>` : `<input id="i_vn" name="verification_note" placeholder="How the fix was checked (walkthrough, photo, customer sign-off)">`}</div>` : ''}` : ''}
        <div class="wide"><label>Attachments</label><label class="drop" for="i_files">${ic('documents')}<br>Drag files here or click to upload<br><small>Photos, documents or other evidence (PDF, JPG, PNG)</small><input id="i_files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.heic,.doc,.docx" style="display:none"></label><div id="i_flist" class="muted" style="margin-top:6px">${det && det.files.length ? det.files.map(f => `<button type="button" class="linklike" data-dl="${f.id}">${esc(f.title)}</button>`).join(' · ') : ''}</div></div>
        ${note ? '' : `<div class="wide"><label class="switch"><input type="checkbox" id="i_esc" ${it.escalated ? 'checked' : ''}> Escalate to management</label></div>`}
      </form>
      ${det ? `<h3 class="secth">Comments (${det.comments.length})</h3><ul class="thread">${det.comments.map(c => `<li><b>${esc(c.author || '—')}</b> <small class="muted">${fmtWhen(c.created_at)}</small><br>${esc(c.body)}</li>`).join('')}</ul>
        <div style="display:flex;gap:8px"><input id="i_cmt" placeholder="Add a comment…" style="flex:1;padding:10px 12px;border:1px solid #ccd5df;border-radius:9px;font:inherit"><button type="button" class="btn ghost" id="i_cmtBtn">Comment</button></div>
        <h3 class="secth">History</h3><div class="activity">${renderActivity(det.history) || '<p class="empty">No history yet.</p>'}</div>` : ''}`;
    };
    const footer = () => {
      const open = isOpenSt(it.status), cx = ['complaint', 'incident'].includes(type);
      return `<button class="btn ghost" data-close type="button">Cancel</button>${!isNew && type === 'note' ? '<button class="btn ghost danger" id="iDel" type="button">Delete note</button>' : ''}
        ${!isNew && type !== 'note' && open ? '<button class="btn ghost" id="iResolve" type="button">Resolve</button>' : ''}
        ${!isNew && ['complaint', 'service_request', 'incident'].includes(type) && open ? '<button class="btn ghost" id="iCustUpd" type="button">Email customer update</button><button class="btn ghost" id="iVisit" type="button">Schedule corrective visit</button>' : ''}
        ${!isNew && cx && it.status === 'Resolved' && !it.verified_by ? '<button class="btn ghost" id="iVerify" type="button">Verify fix</button>' : ''}
        ${!isNew && !open ? '<button class="btn ghost" id="iReopen" type="button">Reopen</button>' : ''}
        <button class="btn" id="iSave" type="button">${isNew ? SAVE_LABEL[type] : 'Save changes'}</button>`;
    };
    const draw = () => {
      const keep = $('#issForm') ? formObj($('#issForm')) : null;
      openDrawer({ title: isNew ? 'Create new item' : it.title, body: body(), footer: footer() });
      if (keep) { const f = $('#issForm'); Object.entries(keep).forEach(([k, val]) => { if (f.elements[k] && k !== 'type') f.elements[k].value = val; }); }
      wire();
      if ($('#iCustUpd')) $('#iCustUpd').onclick = async () => { const message = prompt('Message to the customer (only this text is sent — internal notes are never included):', `Thank you for letting us know about "${it.title}". `); if (!message) return;
        try { const r = await api(`/api/admin/issues/${it.id}/customer-update`, { method: 'POST', json: { message } }); toast('Update emailed to ' + r.to); closeDrawer(); openIssue(r.issue); if (typeof loadIssues === 'function') loadIssues(); } catch (e) { toast(e.message, true); } };
      if ($('#iVisit')) $('#iVisit').onclick = async () => { const date = prompt('Date for the corrective visit (YYYY-MM-DD):', todayISO()); if (!date) return; const start_time = prompt('Start time (HH:MM, optional):', '08:00') || ''; const end_time = start_time ? (prompt('End time (HH:MM, optional):', '10:00') || '') : '';
        try { const r = await api(`/api/admin/issues/${it.id}/schedule-visit`, { method: 'POST', json: { date, start_time, end_time } }); toast(`Corrective visit #${r.visit_id} scheduled for ${date} — assign the crew on the Schedule page`); closeDrawer(); openIssue(r.issue); } catch (e) { toast(e.message, true); } };
    };
    async function loadLinks() {
      const f = $('#issForm'), cid = f.elements.customer_id.value;
      const set = (name, items, label, sel) => { if (!f.elements[name]) return; f.elements[name].innerHTML = `<option value="">${label}</option>` + items.map(x => `<option value="${x.id}"${String(x.id) === String(sel ?? '') ? ' selected' : ''}>${esc(x.name)}${x.address ? ' – ' + esc(x.address) : ''}</option>`).join(''); };
      if (!cid) { set('contact_id', [], '—'); set('property_id', [], '—'); set('project_id', [], '—'); return; }
      try { const l = await api(`/api/admin/customers/${cid}/links`); set('contact_id', l.contacts, '—', it.contact_id || (isNew && (l.contacts.find(c => c.is_primary) || {}).id)); set('property_id', l.properties, '—', it.property_id); set('project_id', l.projects, '—', it.project_id); } catch { /* optional */ }
    }
    const msg = t => { const m = $('#issMsg'); m.textContent = t; m.hidden = !t; if (t && m.scrollIntoView) m.scrollIntoView({ block: 'nearest' }); };
    const payload = () => {
      const b = formObj($('#issForm')); b.type = type; if ($('#i_pri')) b.priority = pri;
      if (b.reminder_at) b.reminder_at = new Date(b.reminder_at).toISOString();
      if ($('#i_esc')) b.escalate = $('#i_esc').checked;
      delete b.verification_note; if ($('#i_vn') && $('#i_vn').value.trim()) b.verification_note = $('#i_vn').value.trim();
      return b;
    };
    async function uploadFiles(id) {
      const inp = $('#i_files'); if (!inp || !inp.files.length) return;
      const fd = new FormData(); fd.append('issue_id', id); fd.append('kind', 'Photos'); if (it.customer_id) fd.append('customer_id', it.customer_id);
      [...inp.files].forEach(f => fd.append('files', f));
      const r = await fetch('/api/admin/documents', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Upload failed');
    }
    async function save(extra) {
      const b = { ...payload(), ...(extra || {}) };
      if (!b.title || !b.title.trim()) return msg('Add a short title.');
      if (!isNew || type === 'note') { /* ok */ } else if (!b.description || !b.description.trim()) return msg('Add the details.');
      if (['complaint', 'service_request'].includes(type) && !b.customer_id) return msg('Choose the customer.');
      if (type !== 'note' && !b.category) return msg('Choose a category.');
      try {
        const r = await api(isNew ? '/api/admin/issues' : '/api/admin/issues/' + it.id, { method: isNew ? 'POST' : 'PATCH', json: b });
        await uploadFiles(r.issue.id);
        toast(isNew ? `${r.issue.number} created` : (extra && extra.verify ? 'Verified' : extra && extra.status ? `Marked ${extra.status.toLowerCase()}` : 'Saved'));
        closeDrawer(); loadIssues();
        if (state.view === 'customers' && cp.id) loadCustomerPage();
      } catch (e) { msg(e.message); }
    }
    function wire() {
      $$('#drawerRoot [data-ty]').forEach(b => b.onclick = () => { type = b.dataset.ty; draw(); });
      $$('#tkind button').forEach(b => b.onclick = () => { type = b.dataset.k; draw(); });
      $$('#i_pri button').forEach(b => b.onclick = () => { pri = b.dataset.p; $$('#i_pri button').forEach(x => x.classList.toggle('on', x === b)); });
      $('#i_cust').onchange = () => { it.contact_id = it.property_id = it.project_id = null; loadLinks(); };
      $('#i_files') && ($('#i_files').onchange = () => { $('#i_flist').textContent = [...$('#i_files').files].map(f => f.name).join(', '); });
      $$('#drawerRoot [data-dl]').forEach(b => b.onclick = () => { const f = det.files.find(x => x.id === Number(b.dataset.dl)); downloadFile({ name: f.file_name || f.title, url: f.file_url }); });
      $('#iSave').onclick = () => save();
      $('#iResolve') && ($('#iResolve').onclick = () => save({ status: 'Resolved' }));
      $('#iVerify') && ($('#iVerify').onclick = () => save({ verify: true }));
      $('#iReopen') && ($('#iReopen').onclick = () => save({ status: 'Open' }));
      $('#iDel') && ($('#iDel').onclick = async () => { if (!confirm('Delete this note?')) return; try { await api('/api/admin/issues/' + it.id, { method: 'DELETE' }); toast('Note deleted'); closeDrawer(); loadIssues(); } catch (e) { msg(e.message); } });
      $('#i_cmtBtn') && ($('#i_cmtBtn').onclick = async () => { const t = $('#i_cmt').value.trim(); if (!t) { toast('Write a comment first.', true); $('#i_cmt').focus(); return; } try { await api(`/api/admin/issues/${it.id}/comments`, { method: 'POST', json: { body: t } }); toast('Comment added'); openIssue(it, null); } catch (e) { msg(e.message); } });
      $$('#drawerRoot [data-close]').forEach(el => el.onclick = closeDrawer);
      loadLinks();
    }
    draw();
  }

  // ---------- Project Management Center (mockup layout + workspace) ----------
  const pj = { tab: 'all', page: 1, list: [], kpis: {}, services: {}, sel: null, wtab: 'overview', d: null };
  const PJ_TABS = [['all', 'All projects'], ['Planning', 'Planning'], ['awaiting', 'Awaiting approval'], ['Ready to mobilize', 'Ready to mobilize'], ['In Progress', 'Active'], ['On Hold', 'On hold'], ['Completed', 'Completed'], ['Archived', 'Archived']];
  const pjMatch = (p, t) => t === 'all' ? p.status !== 'Archived' : t === 'awaiting' ? p.awaiting_approval : t === 'In Progress' ? ['In Progress', 'Quality Review', 'Mobilization'].includes(p.status) : p.status === t;
  ['#pjSearch', '#pjSvc', '#pjMgr'].forEach(x => $(x).addEventListener(x === '#pjSearch' ? 'input' : 'change', () => { pj.page = 1; renderProjects(); }));
  async function loadProjects() {
    const r = await api('/api/admin/pm/projects'); Object.assign(pj, { list: r.projects, kpis: r.kpis, services: r.services, costCats: r.cost_categories });
    state.projects = r.projects;
    const k = r.kpis;
    $('#pjKpis').innerHTML = [kt('overview', 'blue', 'Active projects', k.active, ''), kt('cal', 'purple', 'Awaiting kickoff', k.kickoff, k.awaiting_approval ? `${k.awaiting_approval} awaiting approval` : 'In planning'), kt('issues', 'red', 'Behind schedule', k.behind, k.on_hold ? `${k.on_hold} on hold` : ''), kt('check', 'green', 'Completed (this month)', k.completed_month, ''),
      kt('money', 'navy', 'Contracted value', money(k.contracted), 'Signed contracts'), kt('reports', 'blue', 'Actual cost', money(k.actual_cost), k.budget ? `Budget ${money(k.budget)}` : 'Recorded expenses only'), kt('check', 'teal', 'Gross profit', k.actual_cost ? money(k.gross_profit) : '—', k.actual_cost ? 'Projects with recorded costs' : 'No costs recorded yet')]
      .map((h, i) => i >= 4 ? h.replace('class="ktile"', 'class="ktile money"') : h).join('');
    $('#pjTabs').innerHTML = PJ_TABS.map(([v, l]) => `<button data-t="${esc(v)}" class="${pj.tab === v ? 'on' : ''}">${l} (${r.projects.filter(p => pjMatch(p, v)).length})</button>`).join('');
    $$('#pjTabs button').forEach(b => b.onclick = () => { pj.tab = b.dataset.t; pj.page = 1; loadProjects(); });
    { const c = $('#pjSvc').value; $('#pjSvc').innerHTML = '<option value="">Service: All</option>' + Object.entries(r.services).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join(''); $('#pjSvc').value = c; }
    { const c = $('#pjMgr').value, ms = [...new Set(r.projects.map(p => p.manager).filter(Boolean))]; $('#pjMgr').innerHTML = '<option value="">Manager: All</option>' + ms.map(m => `<option>${esc(m)}</option>`).join(''); $('#pjMgr').value = c; }
    const steps = [['contracts', 'Contract executed'], ['proposals', 'Project planning'], ['leads', 'Staffing & resources'], ['cal', 'Scheduling & work orders'], ['projects', 'Execution'], ['quality', 'Quality inspections'], ['check', 'Customer acceptance'], ['check', 'Completed']];
    $('#pjFlow').innerHTML = steps.map(([i, l], n) => `${n ? '<b>→</b>' : ''}<span><i>${ic(i)}</i>${l}</span>`).join('');
    $('#pjWork').hidden = true; $('#pjList').hidden = false;
    renderProjects();
    if (pj.sel && r.projects.find(p => p.id === pj.sel)) drawPjSide(r.projects.find(p => p.id === pj.sel));
  }
  function renderProjects() {
    const q = $('#pjSearch').value.trim().toLowerCase(), sv = $('#pjSvc').value, mg = $('#pjMgr').value;
    const all = pj.list.filter(p => pjMatch(p, pj.tab) && (!sv || p.service === sv) && (!mg || p.manager === mg) && (!q || [p.name, p.company, p.customer_name, p.site_address, p.number].join(' ').toLowerCase().includes(q)));
    const per = 10, pages = Math.max(1, Math.ceil(all.length / per)); pj.page = Math.min(pj.page, pages);
    $('#rows-projects').innerHTML = all.length ? all.slice((pj.page - 1) * per, pj.page * per).map(p => `<tr class="click" data-pj="${p.id}"><td><b style="color:#1f6fd1">${esc(p.number)}</b></td><td><b>${esc(p.name || '—')}</b><small>${esc(p.site_address || '')}</small></td><td>${esc(p.company || p.customer_name || '—')}</td>
      <td>${p.service_label ? `<span class="pill t-task">${esc(p.service_label.split(' ')[0])}</span>` : '<span class="muted">Not set</span>'}</td><td>${p.manager ? `<span class="avs"><i>${initials(p.manager)}</i>${esc(String(p.manager).split('@')[0])}</span>` : '—'}</td>
      <td class="num">${money(p.contract_value)}</td><td>${p.start_date ? fmtDate(p.start_date) : '—'}<small>${p.due_date ? fmtDate(p.due_date) : ''}</small></td>
      <td><b>${p.progress || 0}%</b><div class="bar2 ${p.progress >= 100 ? 'done' : ''}"><i style="width:${p.progress || 0}%"></i></div></td><td><span class="pill st-${p.status === 'Completed' ? 'Approved' : p.status === 'On Hold' ? 'Expired' : p.status === 'Planning' ? 'Draft' : 'Sent'}">${esc(p.awaiting_approval ? 'Awaiting approval' : p.status === 'In Progress' ? 'Active' : p.status)}</span>${p.behind ? '<small style="color:#d1382f">behind</small>' : ''}</td></tr>`).join('')
      : `<tr><td class="emptyrow" colspan="9">${q || sv || mg ? 'No projects match.' : 'No projects here yet. Approved proposals create a planning project automatically.'}</td></tr>`;
    $('#pjShowing').textContent = all.length ? `Showing ${(pj.page - 1) * per + 1} – ${Math.min(pj.page * per, all.length)} of ${all.length} projects` : '';
    $('#pjPages').innerHTML = pages > 1 ? Array.from({ length: pages }, (_, n) => `<button class="${n + 1 === pj.page ? 'on' : ''}" data-pg="${n + 1}">${n + 1}</button>`).join('') : '';
    $$('#pjPages button').forEach(b => b.onclick = () => { pj.page = Number(b.dataset.pg); renderProjects(); });
    $$('#rows-projects [data-pj]').forEach(r => r.onclick = () => { pj.sel = Number(r.dataset.pj); drawPjSide(pj.list.find(p => p.id === pj.sel)); });
  }
  async function drawPjSide(p) {
    let d; try { d = await api('/api/admin/pm/projects/' + p.id); } catch (e) { return toast(e.message, true); }
    const up = d.tasks.filter(t => t.status === 'Open' && t.approved).slice(0, 4);
    $('#pjSide').innerHTML = `<div class="card"><h2 style="font-size:18px;margin-bottom:2px">${esc(p.number)} ${badge(p.status === 'In Progress' ? 'Active' : p.status)}</h2><b>${esc(p.name || '')}</b><p class="muted" style="margin:4px 0 10px">${esc(p.site_address || '')}</p>
      <div style="display:flex;justify-content:space-between"><b>Project progress</b><b>${p.progress || 0}%</b></div><div class="bar2" style="height:10px;margin:6px 0 12px"><i style="width:${p.progress || 0}%"></i></div>
      <dl class="stat"><dt>Contract value</dt><dd>${money(p.contract_value)}</dd><dt>Actual cost</dt><dd>${money(p.actual_cost)}</dd><dt>Start</dt><dd>${p.start_date ? fmtDate(p.start_date) : '—'}</dd><dt>End</dt><dd>${p.due_date ? fmtDate(p.due_date) : '—'}</dd><dt>Manager</dt><dd>${esc(p.manager || '—')}</dd><dt>Gross margin</dt><dd>${p.actual_cost && p.contract_value ? ((p.contract_value - p.actual_cost) / p.contract_value * 100).toFixed(1) + '%' : '—'}</dd></dl></div>
      <div class="card"><h2 style="font-size:16px">Services &amp; scope</h2><p>${esc(p.service_label || 'Service not set')}</p>${d.estimate ? `<p class="muted" style="white-space:pre-wrap;max-height:110px;overflow:auto">${esc(String(d.estimate.scope || '').slice(0, 400))}</p>` : ''}</div>
      <div class="card"><h2 style="font-size:16px">Upcoming tasks</h2>${up.length ? '<ul class="mini">' + up.map(t => `<li>${esc(t.title)} <small class="${t.due_date && t.due_date < todayISO() ? 'due-late' : 'muted'}">${t.due_date ? fmtDate(t.due_date) : t.phase || ''}</small></li>`).join('') + '</ul>' : '<p class="muted">No open tasks.</p>'}${!p.readiness_complete && p.status === 'Planning' ? `<p class="muted"><b>Before dispatch:</b> ${esc(p.readiness_missing.join(', '))}</p>` : ''}</div>
      <div class="card" style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn" id="pjOpen" style="grid-column:1/-1">Open project workspace</button><button class="btn ghost" data-w="schedule">Schedule work</button><button class="btn ghost" data-w="tasks">Add task</button><button class="btn ghost" data-w="comms">Log update</button><button class="btn ghost" data-w="documents">Upload file</button></div>`;
    $('#pjOpen').onclick = () => openProject(p.id);
    $$('#pjSide [data-w]').forEach(b => b.onclick = () => openProject(p.id, b.dataset.w));
  }
  $('#pjCsv').addEventListener('click', () => {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`, rows = [['Project', 'Name', 'Customer', 'Service', 'Manager', 'Status', 'Progress %', 'Contract value', 'Budget', 'Actual cost', 'Start', 'Due', 'Actual start', 'Actual end'], ...pj.list.map(p => [p.number, p.name, p.company || p.customer_name, p.service_label, p.manager, p.status, p.progress, p.contract_value, p.budget, p.actual_cost, p.start_date, p.due_date, p.actual_start, p.actual_end])];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' })); a.download = 'projects.csv'; a.click();
  });
  const WTABS = [['overview', 'Overview', 'overview'], ['scope', 'Scope of work', 'proposals'], ['schedule', 'Schedule', 'cal'], ['crew', 'Crew & staffing', 'leads'], ['tasks', 'Tasks & milestones', 'check'], ['documents', 'Documents & drawings', 'documents'], ['site', 'Site information', 'pin'], ['photos', 'Photos & evidence', 'documents'], ['quality', 'Quality inspections', 'quality'], ['issues', 'Issues & risks', 'issues'], ['costs', 'Costs & budget', 'money'], ['comms', 'Customer communications', 'emails'], ['contract', 'Contract', 'contracts'], ['activity', 'Activity history', 'activity']];
  async function openProject(id, tab) {
    if (state.view !== 'projects') { go('projects'); await new Promise(r => setTimeout(r, 400)); }
    try { pj.d = await api('/api/admin/pm/projects/' + id); } catch (e) { return toast(e.message, true); }
    pj.sel = id; if (tab) pj.wtab = tab; else if (!pj.d || pj.d.project.id !== id) pj.wtab = 'overview';
    $('#pjList').hidden = true; $('#pjWork').hidden = false; drawWork();
  }
  function drawWork() {
    const d = pj.d, p = d.project, W = $('#pjWork');
    const svcOpts = Object.entries(d.services).map(([v, l]) => `<option value="${v}"${p.service === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
    W.innerHTML = `<p><button class="linklike" id="pjBack">← All projects</button></p>
      <div class="card cphero"><div class="bimg">${ic('projects')}</div><div style="min-width:0;flex:1"><h1>${esc(p.name || p.number)} ${badge(p.status === 'In Progress' ? 'Active' : p.status)}</h1><div class="sub">${esc(p.number)} · ${esc(p.company || p.customer_name || '')} · ${esc(p.service_label || 'Service not set')}</div>
        <div class="cpmeta2"><div><span class="chip blue">${ic('pin')}</span><div><span>Site</span><b>${esc(p.site_address || '—')}</b></div></div><div><span class="chip blue">${ic('user')}</span><div><span>Project manager</span><b>${esc(p.manager || '—')}</b></div></div><div><span class="chip blue">${ic('cal')}</span><div><span>Planned</span><b>${p.start_date ? fmtDate(p.start_date) : '—'} – ${p.due_date ? fmtDate(p.due_date) : '—'}</b></div></div><div><span class="chip blue">${ic('clock')}</span><div><span>Actual</span><b>${p.actual_start ? fmtDate(p.actual_start) : 'not started'}${p.actual_end ? ' – ' + fmtDate(p.actual_end) : ''}</b></div></div></div></div>
        <div class="cpbtns"><button class="btn" id="pjStatus">Change status</button><button class="btn ghost" id="pjEdit">Edit project</button></div></div>
      <div class="fin2">${kt('check', 'blue', 'Progress', (p.progress || 0) + '%', 'from verified tasks')}${kt('contracts', 'purple', 'Contract value', money(p.contract_value), p.contract ? p.contract.signature_status || 'Not sent' : 'No contract')}${kt('reports', 'navy', 'Budget', money(p.budget), '')}${kt('money', 'teal', 'Actual cost', money(p.actual_cost), 'recorded')}${kt('check', 'green', 'Gross profit', p.actual_cost ? money(p.contract_value - p.actual_cost) : '—', p.actual_cost ? 'actual' : 'no costs yet')}${kt('cal', 'amber', 'Open tasks', p.tasks_open, p.tasks_review ? `${p.tasks_review} to review` : '')}${kt('issues', 'red', 'Open issues', d.issues.filter(i => !['Resolved', 'Verified', 'Closed'].includes(i.status)).length, '')}</div>
      <div class="ctabs2 ctabs" role="tablist">${WTABS.map(([k, l, i]) => `<button role="tab" data-wt="${k}" class="${pj.wtab === k ? 'on' : ''}">${ic(i)}<span>${l}</span></button>`).join('')}</div><div id="pjBody"></div>`;
    $('#pjBack').onclick = () => { $('#pjWork').hidden = true; $('#pjList').hidden = false; loadProjects(); };
    $$('#pjWork [data-wt]').forEach(b => b.onclick = () => { pj.wtab = b.dataset.wt; drawWork(); });
    $('#pjEdit').onclick = () => openForm({ title: 'Edit project', defs: [{ name: 'name', label: 'Project name', wide: true }, { name: 'service', label: 'Cleaning service', type: 'select', options: [['', 'Not set'], ...Object.entries(d.services)] }, { name: 'manager', label: 'Project manager' }, { name: 'site_address', label: 'Site address', wide: true }, { name: 'start_date', label: 'Planned start', type: 'date' }, { name: 'due_date', label: 'Planned completion', type: 'date' }, { name: 'budget', label: 'Budget ($)' }, { name: 'frequency', label: 'Service frequency', type: 'select', options: [['', '—'], 'once', 'daily', 'weekly', 'biweekly', 'monthly'] }],
      values: p, submit: b => api('/api/admin/pm/projects/' + p.id, { method: 'PATCH', json: b }), after: () => { toast('Saved'); openProject(p.id); } });
    $('#pjStatus').onclick = () => openForm({ title: 'Change status', sub: d.guard_next && p.status === 'Planning' ? d.guard_next : '', defs: [{ name: 'status', label: 'Status', type: 'select', options: ['Planning', 'Ready to mobilize', 'In Progress', 'Quality Review', 'On Hold', 'Completed', 'Archived'] }, { name: 'reason', label: 'Reason (required for On Hold)', wide: true }],
      values: { status: p.status }, submit: b => api(`/api/admin/pm/projects/${p.id}/status`, { method: 'POST', json: b }), after: () => { toast('Status updated'); openProject(p.id); } });
    const B = $('#pjBody'), t = pj.wtab, act = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    const reload = () => openProject(p.id);
    if (t === 'overview') {
      B.innerHTML = `<div class="ov3"><div><div class="card"><h2>${ic('check')} Readiness before dispatch</h2><ul class="rdy">${d.readiness.items.map(r => `<li><input type="checkbox" data-rk="${r.key}" ${r.by ? 'checked' : ''} aria-label="${esc(r.label)}"><span><b>${esc(r.label)}</b>${r.by ? `<small> · ${esc(r.by)} ${fmtWhen(r.at)}</small>` : ''}</span></li>`).join('')}</ul>
          <p class="muted">${p.contract ? `Contract: ${esc(p.contract.signature_status || 'Not sent')}` : 'No contract linked'}${p.contract_waiver ? ` · <b>Started without a signed contract:</b> ${esc(p.contract_waiver)}` : ''}</p>
          ${p.dispatch_approved_by ? `<p>✅ Dispatch approved by <b>${esc(p.dispatch_approved_by)}</b> ${fmtWhen(p.dispatch_approved_at)}</p>` : `<button class="btn" id="pjApprove">Approve dispatch</button>`}</div></div>
        <div><div class="card"><h2>${ic('cal')} Upcoming work</h2>${d.visits.filter(v => v.date >= todayISO()).slice(0, 5).map(v => `<p>${fmtDate(v.date)} · ${esc(v.title)} ${badge(v.status)}</p>`).join('') || '<p class="muted">Nothing scheduled.</p>'}</div>
          <div class="card"><h2>${ic('activity')} Latest updates</h2>${d.updates.slice(0, 4).map(u => `<p><b>${esc(u.kind)}</b> <small class="muted">${esc(u.author || '')} ${fmtWhen(u.created_at)}</small><br>${esc(u.body.slice(0, 200))}</p>`).join('') || '<p class="muted">No updates yet.</p>'}</div></div>
        <div><div class="card"><h2>${ic('check')} Completion</h2>${p.signoff_name ? `<p>Customer sign-off: <b>${esc(p.signoff_name)}</b>${p.signoff_title ? ', ' + esc(p.signoff_title) : ''} · ${fmtWhen(p.signoff_at)}</p>` : '<button class="btn ghost" id="pjSign">Record customer sign-off</button>'}
          ${p.status === 'Completed' ? `<p><button class="btn ghost" id="pjCert">Completion certificate (PDF)</button></p>${p.billing_invoice_id ? `<p>Billing draft: <button class="linklike" data-rec="invoices:${p.billing_invoice_id}">invoice #${p.billing_invoice_id}</button></p>` : '<p><button class="btn" id="pjBill">Hand off to billing</button></p>'}` : '<p class="muted">Complete all tasks and record sign-off to finish the project.</p>'}</div></div></div>`;
      $$('#pjBody [data-rk]').forEach(c => c.onchange = async () => { try { await api(`/api/admin/pm/projects/${p.id}/readiness`, { method: 'POST', json: { key: c.dataset.rk, confirmed: c.checked } }); reload(); } catch (e) { toast(e.message, true); c.checked = !c.checked; } });
      act('#pjApprove', async () => { try { await api(`/api/admin/pm/projects/${p.id}/approve-dispatch`, { method: 'POST' }); toast('Dispatch approved'); reload(); } catch (e) { toast(e.message, true); } });
      act('#pjSign', () => openForm({ title: 'Customer sign-off', defs: [{ name: 'name', label: 'Customer representative' }, { name: 'title', label: 'Title' }], submit: b => api(`/api/admin/pm/projects/${p.id}/signoff`, { method: 'POST', json: b }), after: () => { toast('Sign-off recorded'); reload(); } }));
      act('#pjCert', () => downloadFile({ name: `${p.number}-completion.pdf`, url: `/api/admin/pm/projects/${p.id}/certificate` }));
      act('#pjBill', async () => { try { const r = await api(`/api/admin/pm/projects/${p.id}/billing-handoff`, { method: 'POST' }); toast(`Draft invoice created for ${money(r.amount)} (not sent)`); reload(); } catch (e) { toast(e.message, true); } });
      bindOpeners(B);
    } else if (t === 'scope') {
      const e = d.estimate;
      B.innerHTML = `<div class="card"><h2>Contracted scope</h2>${e ? `<p class="muted">From approved proposal #${e.id} v${e.version || 1}${e.signer_name ? ` · accepted by ${esc(e.signer_name)}` : ''}</p><p style="white-space:pre-wrap">${esc(e.scope || '')}</p>${e.assumptions ? `<h3 class="secth">Assumptions</h3><p style="white-space:pre-wrap">${esc(e.assumptions)}</p>` : ''}${e.exclusions ? `<h3 class="secth">Exclusions</h3><p style="white-space:pre-wrap">${esc(e.exclusions)}</p>` : ''}<p><button class="linklike" data-est="${e.id}">Open the proposal</button></p>` : '<p class="muted">No approved proposal is linked to this project.</p>'}</div>`;
      bindOpeners(B);
    } else if (t === 'schedule') {
      B.innerHTML = `<div class="card"><h2>Schedule &amp; work orders</h2><form class="inl" id="woForm"><div><label>Frequency</label><select name="frequency">${['once', 'daily', 'weekly', 'biweekly', 'monthly'].map(f => `<option${(p.frequency || 'once') === f ? ' selected' : ''}>${f}</option>`).join('')}</select></div><div><label>First date</label><input type="date" name="start" value="${esc(p.start_date || todayISO())}"></div><div><label>How many</label><input name="count" value="4" inputmode="numeric"></div><div><label>Start time</label><input type="time" name="start_time" value="08:00"></div><div><label>End time</label><input type="time" name="end_time" value="16:00"></div><div><label>Crew / lead</label><input name="assigned_to" value="${esc(p.manager || '')}"></div><div class="wide"><button class="btn">Generate work orders</button> <small class="muted">${p.dispatch_approved_by ? 'They will be Scheduled.' : 'They stay Tentative until dispatch is approved.'}</small></div></form>
        ${rowsOr(d.visits.map(v => `<tr><td>${fmtDate(v.date)}</td><td>${esc(v.start_time || '')}–${esc(v.end_time || '')}</td><td>${esc(v.title)}</td><td>${esc(v.type)}</td><td>${esc(v.assigned_to || '—')}</td><td>${badge(v.status)}</td></tr>`), ['Date', 'Time', 'Work', 'Type', 'Crew', 'Status'], 'Nothing scheduled yet.')}</div>`;
      $('#woForm').onsubmit = async ev => { ev.preventDefault(); try { const r = await api(`/api/admin/pm/projects/${p.id}/work-orders`, { method: 'POST', json: formObj(ev.target) }); toast(`${r.created} work order(s) created (${r.status})`); reload(); } catch (e) { toast(e.message, true); } };
    } else if (t === 'crew') {
      const crew = [...new Set([p.manager, ...d.tasks.map(x => x.assigned_to), ...d.visits.map(v => v.assigned_to)].filter(Boolean))];
      B.innerHTML = `<div class="card"><h2>Crew &amp; staffing</h2>${crew.length ? '<ul class="mini">' + crew.map(c => `<li><span class="avs"><i>${initials(c)}</i>${esc(c)}</span></li>`).join('') + '</ul>' : '<p class="muted">No one assigned yet. Assign a manager, task owners or work-order crews.</p>'}<p class="muted">Employee availability, shifts and time tracking are part of Scheduling &amp; Dispatch.</p></div>`;
    } else if (t === 'tasks') {
      const by = {}; d.tasks.forEach(x => (by[x.phase || 'Other'] = by[x.phase || 'Other'] || []).push(x));
      B.innerHTML = `<div class="card"><h2>Tasks &amp; milestones</h2><p class="muted">Progress = verified tasks (full weight) + done tasks (half weight). Someone other than the person who did the work verifies it.</p>
        ${!d.tasks.length ? `<form class="inl" id="planForm"><div><label>Work plan for</label><select name="service">${svcOpts}</select></div><div class="wide"><button class="btn">Create work plan</button></div></form>` : ''}
        ${Object.entries(by).map(([ph, ts]) => `<h3 class="secth">${esc(ph)}</h3>${ts.map(x => `<div class="tk ${x.approved ? '' : 'review'}"><span style="flex:1"><b>${esc(x.title)}</b> <span class="w">weight ${x.weight}${x.assigned_to ? ' · ' + esc(x.assigned_to) : ''}${x.due_date ? ' · due ' + fmtDate(x.due_date) : ''}${x.source === 'ai' ? ' · AI suggestion' : ''}</span>${x.verified_by ? `<small class="muted"><br>verified by ${esc(x.verified_by)} ${fmtWhen(x.verified_at)}</small>` : x.done_by ? `<small class="muted"><br>done by ${esc(x.done_by)} ${fmtWhen(x.done_at)}</small>` : ''}</span>
          ${!x.approved ? `<button class="btn small" data-ta="${x.id}">Accept</button>` : x.status === 'Open' ? `<button class="btn small" data-ts="${x.id}" data-to="Done">Mark done</button>` : x.status === 'Done' ? `<button class="btn small" data-ts="${x.id}" data-to="Verified">Verify</button> <button class="btn small ghost" data-ts="${x.id}" data-to="Open">Reopen</button>` : '<span class="badge green">Verified</span>'}</div>`).join('')}`).join('')}
        <form class="inl" id="tkForm"><div class="wide"><label>New task</label><input name="title" required></div><div><label>Phase</label><select name="phase">${['Planning', 'Execution', 'Quality', 'Acceptance'].map(x => `<option>${x}</option>`).join('')}</select></div><div><label>Weight</label><input name="weight" value="5" inputmode="numeric"></div><div><label>Due</label><input type="date" name="due_date"></div><div><label>Assigned to</label><input name="assigned_to"></div><div class="wide"><button class="btn">Add task</button></div></form></div>`;
      act('#planForm', null); if ($('#planForm')) $('#planForm').onsubmit = async ev => { ev.preventDefault(); try { await api(`/api/admin/pm/projects/${p.id}/plan`, { method: 'POST', json: formObj(ev.target) }); toast('Work plan created'); reload(); } catch (e) { toast(e.message, true); } };
      $('#tkForm').onsubmit = async ev => { ev.preventDefault(); try { await api(`/api/admin/pm/projects/${p.id}/tasks`, { method: 'POST', json: formObj(ev.target) }); toast('Task added'); reload(); } catch (e) { toast(e.message, true); } };
      $$('#pjBody [data-ts]').forEach(b => b.onclick = async () => { try { await api('/api/admin/pm/tasks/' + b.dataset.ts, { method: 'PATCH', json: { status: b.dataset.to } }); reload(); } catch (e) { toast(e.message, true); } });
      $$('#pjBody [data-ta]').forEach(b => b.onclick = async () => { try { await api('/api/admin/pm/tasks/' + b.dataset.ta, { method: 'PATCH', json: { approved: true } }); reload(); } catch (e) { toast(e.message, true); } });
    } else if (t === 'documents' || t === 'photos') {
      const docs = d.documents.filter(x => t === 'photos' ? x.kind === 'Photos' : x.kind !== 'Photos');
      B.innerHTML = `<div class="card"><h2>${t === 'photos' ? 'Photos &amp; evidence' : 'Documents &amp; drawings'}</h2><button class="btn" id="pjUp">Upload</button>${rowsOr(docs.map(x => `<tr><td><button class="linklike" data-dl="${x.id}">${esc(x.title)}</button></td><td>${esc(x.kind)}</td><td>${esc(x.revision || '—')}</td><td>${fmtDate(x.created_at)}</td></tr>`), ['File', 'Type', 'Rev', 'Uploaded'], t === 'photos' ? 'No photos yet. Upload before-and-after photos as evidence.' : 'No documents yet.')}</div>`;
      $('#pjUp').onclick = () => uploadDocs({ project_id: p.id, kind: t === 'photos' ? 'Photos' : 'Drawings' });
      $$('#pjBody [data-dl]').forEach(b => b.onclick = () => { const x = d.documents.find(y => y.id === Number(b.dataset.dl)); downloadFile({ name: x.file_name || x.title, url: x.file_url }); });
    } else if (t === 'site') {
      const si = d.site, F = [['contact', 'Site contact (name / phone)'], ['hours', 'Working hours'], ['access', 'Access instructions (gate, keys, codes)'], ['parking', 'Parking & staging'], ['safety', 'Safety requirements (PPE, orientation)'], ['utilities', 'Water / power / disposal']];
      B.innerHTML = `<div class="card"><h2>Site information</h2><p class="muted">Internal only. Crews see this on their work orders.</p><form class="ig" id="siteForm">${F.map(([k, l]) => `<div class="wide"><label>${l}</label><textarea name="${k}" rows="2">${esc(si[k] || '')}</textarea></div>`).join('')}<div class="wide"><button class="btn">Save site information</button></div></form></div>`;
      $('#siteForm').onsubmit = async ev => { ev.preventDefault(); try { await api('/api/admin/pm/projects/' + p.id, { method: 'PATCH', json: { site_info: formObj(ev.target) } }); toast('Site information saved'); reload(); } catch (e) { toast(e.message, true); } };
    } else if (t === 'quality') {
      B.innerHTML = `<div class="card"><h2>Quality inspections</h2>${rowsOr(d.inspections.map(x => `<tr><td>${fmtDate(x.date)}</td><td>${esc(x.area)}</td><td>${esc(x.inspector || '—')}</td><td>${x.score == null ? '—' : x.score + '%'}</td><td>${x.passed ? '<span class="badge green">Passed</span>' : '<span class="badge red">Failed</span>'}</td></tr>`), ['Date', 'Area', 'Inspector', 'Score', 'Result'], 'No inspections yet.')}<button class="btn" id="pjInsp">Go to Quality &amp; inspections</button></div>`;
      $('#pjInsp').onclick = () => go('quality');
    } else if (t === 'issues') {
      B.innerHTML = `<div class="card"><h2>Issues &amp; risks</h2>${rowsOr(d.issues.map(i => `<tr class="click" data-iss="${i.id}"><td>${esc(i.title)}</td><td>${esc(i.type)}</td><td>${badge(i.priority)}</td><td>${badge(i.status)}</td><td>${i.due_date ? fmtDate(i.due_date) : '—'}</td></tr>`), ['Item', 'Type', 'Priority', 'Status', 'Due'], 'No issues linked to this project.')}<button class="btn" id="pjIss">Create issue</button></div>`;
      $('#pjIss').onclick = () => openIssue(null, p.customer_id ? { id: p.customer_id } : null);
      $$('#pjBody [data-iss]').forEach(r => r.onclick = () => openIssue({ id: Number(r.dataset.iss) }, null));
    } else if (t === 'costs') {
      B.innerHTML = `<div class="card"><h2>Costs &amp; budget</h2><dl class="stat"><dt>Budget</dt><dd>${money(p.budget)}</dd><dt>Actual cost (recorded)</dt><dd>${money(p.actual_cost)}</dd><dt>Variance</dt><dd style="color:${p.budget && p.actual_cost > p.budget ? '#d1382f' : 'inherit'}">${p.budget ? money(p.budget - p.actual_cost) : '—'}</dd>${Object.entries(p.cost_by).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${money(v)}</dd>`).join('')}</dl>
        <form class="inl" id="costForm"><div><label>Category</label><select name="category">${(d.cost_categories || []).map(c => `<option>${c}</option>`).join('')}</select></div><div><label>Amount ($)</label><input name="amount" inputmode="decimal" required></div><div><label>Date</label><input type="date" name="cost_date" value="${todayISO()}"></div><div class="wide"><label>Description</label><input name="description"></div><div class="wide"><button class="btn">Record cost</button></div></form>
        ${rowsOr(d.costs.map(c => `<tr><td>${fmtDate(c.cost_date)}</td><td>${esc(c.category)}</td><td>${esc(c.description || '')}</td><td class="num">${money(c.amount)}</td><td>${esc(c.entered_by || '')}</td></tr>`), ['Date', 'Category', 'Description', 'Amount', 'Entered by'], 'No costs recorded yet. Actual profit appears once real costs are entered.')}</div>`;
      $('#costForm').onsubmit = async ev => { ev.preventDefault(); try { await api(`/api/admin/pm/projects/${p.id}/costs`, { method: 'POST', json: formObj(ev.target) }); toast('Cost recorded'); reload(); } catch (e) { toast(e.message, true); } };
    } else if (t === 'comms') {
      B.innerHTML = `<div class="card"><h2>Updates &amp; customer communications</h2><form class="inl" id="upForm"><div><label>Type</label><select name="kind"><option>Update</option><option>Customer communication</option><option>Site note</option><option>Risk</option></select></div><div class="wide"><label>Note</label><textarea name="body" rows="3" required></textarea></div><div class="wide"><button class="btn">Log update</button></div></form>
        <ul class="tl">${d.updates.map(u => `<li><span class="ty">${esc(u.kind)}</span> <small class="muted">${esc(u.author || '')} · ${fmtWhen(u.created_at)}</small><br>${esc(u.body)}</li>`).join('') || '<p class="muted">No updates yet.</p>'}</ul></div>`;
      $('#upForm').onsubmit = async ev => { ev.preventDefault(); try { await api(`/api/admin/pm/projects/${p.id}/updates`, { method: 'POST', json: formObj(ev.target) }); toast('Logged'); reload(); } catch (e) { toast(e.message, true); } };
    } else if (t === 'contract') {
      B.innerHTML = `<div class="card"><h2>Contract</h2>${p.contract ? `<dl class="stat"><dt>Contract</dt><dd><button class="linklike" data-rec="contracts:${p.contract.id}">${esc(p.contract.title || 'Contract #' + p.contract.id)}</button></dd><dt>Value</dt><dd>${money(p.contract.value)}</dd><dt>Signature</dt><dd>${badge(p.contract.signature_status || 'Not sent')}</dd><dt>Status</dt><dd>${badge(p.contract.status)}</dd></dl>` : '<p class="muted">No contract linked.</p>'}
        <h3 class="secth">Invoices</h3>${rowsOr(d.invoices.map(i => `<tr class="click" data-rec="invoices:${i.id}"><td>${esc(i.invoice_number || '#' + i.id)}</td><td class="num">${money(i.amount)}</td><td class="num">${money(i.paid_amount)}</td><td>${badge(i.status)}</td></tr>`), ['Invoice', 'Amount', 'Paid', 'Status'], 'No invoices yet.')}</div>`;
      bindOpeners(B);
    } else if (t === 'activity') {
      B.innerHTML = `<div class="card"><h2>Activity history</h2><div class="activity">${renderActivity(d.activity) || '<p class="empty">No activity yet.</p>'}</div></div>`;
    }
  }

  // ---------- Cleaning scopes ----------
  const scopeState = { items: [], categories: {}, pricing: {} };
  ['#scopeSearch', '#scopeCat', '#scopeShow'].forEach(sel => $(sel).addEventListener('input', () => renderScopes()));
  // ---------- Website photos & video (Website view) ----------
  const webState = { items: [] };
  const WEB_ACCEPT = '.jpg,.jpeg,.png,.webp,.mp4,.mov,.webm,.m4v';
  const webMedia = i => i.kind === 'video'
    ? `<video src="${esc(i.url)}" muted preload="metadata" style="width:110px;height:70px;object-fit:cover;border-radius:8px;background:#10263e"></video>`
    : `<img src="${esc(i.url)}" alt="" loading="lazy" style="width:110px;height:70px;object-fit:cover;border-radius:8px">`;
  // Sends a form as multipart (a file is optional on edits). Empty values are left out.
  async function webSend(method, url, body) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(body || {})) {
      if (k === 'file') { if (v && v.length) fd.append('file', v[0]); }
      else if (v !== undefined && v !== null) fd.append(k, typeof v === 'boolean' ? String(v) : v);
    }
    return api(url, { method, body: fd });
  }
  async function loadWebsite() {
    const r = await api('/api/admin/site-media'); webState.items = r.items || [];
    const gallery = webState.items.filter(i => i.slot === 'gallery'), hero = webState.items.find(i => i.slot === 'hero_video');
    $('#webKpis').innerHTML = kt('documents', 'navy', 'Photos & videos', gallery.length, 'in the gallery')
      + kt('check', 'green', 'Shown on the website', gallery.filter(i => i.visible).length, 'visible to visitors')
      + kt('documents', 'blue', 'Page video', hero ? (hero.visible ? 'Shown' : 'Hidden') : 'Built-in', hero ? hero.title : 'the default video');
    renderWebsite();
  }
  function renderWebsite() {
    const hero = webState.items.find(i => i.slot === 'hero_video');
    $('#webHero').innerHTML = `<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">${hero ? webMedia(hero) : ''}<div style="flex:1;min-width:200px"><h2 style="margin:0 0 4px">Page video</h2><p class="hint" style="margin:0">${hero ? esc(hero.title) + (hero.visible ? '' : ' · hidden') : 'The built-in video is showing on the Projects page.'}</p></div><div class="headact"><button class="btn ghost" id="webHeroReplace">${hero ? 'Replace video' : 'Upload a video'}</button>${hero && hero.file ? '<button class="btn ghost" id="webHeroReset">Use built-in video</button>' : ''}</div></div>`;
    const rows = webState.items.filter(i => i.slot === 'gallery');
    $('#webRows').innerHTML = rows.map((i, n) => `<tr>
      <td>${webMedia(i)}</td>
      <td><b>${esc(i.title)}</b>${i.alt ? `<br><small class="muted">${esc(i.alt)}</small>` : ''}</td>
      <td>${esc(i.location || '—')}</td>
      <td>${i.kind === 'video' ? 'Video' : 'Photo'}</td>
      <td>${i.visible ? '<span class="chip green">Shown</span>' : '<span class="chip">Hidden</span>'}</td>
      <td style="white-space:nowrap"><button class="btn ghost small" data-wmove="-1" data-id="${i.id}" ${n === 0 ? 'disabled' : ''} aria-label="Move up">↑</button> <button class="btn ghost small" data-wmove="1" data-id="${i.id}" ${n === rows.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></td>
      <td style="white-space:nowrap"><button class="btn ghost small" data-wedit="${i.id}">Edit</button> <button class="btn ghost small" data-wvis="${i.id}">${i.visible ? 'Hide' : 'Show'}</button> <button class="btn small danger" data-wdel="${i.id}">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No photos yet. Use “Add photo or video”.</td></tr>';
    $('#webAdd').onclick = () => openForm({
      title: 'Add a photo or video', sub: 'It appears on the Projects page once saved.',
      defs: [
        { name: 'file', label: 'Photo or video', type: 'file', single: true, accept: WEB_ACCEPT, wide: true, hint: 'JPG, PNG or WEBP photo, or MP4, MOV or WEBM video, up to 200 MB. Choose one file.' },
        { name: 'title', label: 'Title', type: 'text', hint: 'Short name shown under the photo.' },
        { name: 'location', label: 'Location (optional)', type: 'text', hint: 'Only if you want it shown, for example “Des Moines, Iowa”.' },
        { name: 'alt', label: 'Description for screen readers', type: 'text', hint: 'What is in the picture, in a few words.' }
      ],
      submit: body => webSend('POST', '/api/admin/site-media', body),
      after: () => { toast('Added to the website'); loadWebsite(); }
    });
    $('#webHeroReplace').onclick = () => openForm({
      title: hero ? 'Replace the page video' : 'Upload the page video', sub: 'Plays at the top of the Projects page.',
      defs: [
        { name: 'file', label: 'Video', type: 'file', single: true, accept: '.mp4,.mov,.webm,.m4v', wide: true, hint: 'MP4, MOV or WEBM, up to 200 MB. Choose one file.' },
        { name: 'title', label: 'Title', type: 'text', value: hero ? hero.title : 'Page video' }
      ],
      submit: body => webSend('POST', '/api/admin/site-media', { ...body, slot: 'hero_video' }),
      after: () => { toast('Page video updated'); loadWebsite(); }
    });
    if ($('#webHeroReset')) $('#webHeroReset').onclick = async () => {
      if (!confirm('Remove the uploaded video and show the built-in video again?')) return;
      try { await api(`/api/admin/site-media/${hero.id}`, { method: 'DELETE' }); toast('Built-in video restored'); loadWebsite(); } catch (e) { toast(e.message, true); }
    };
    $$('#webRows [data-wedit]').forEach(b => b.onclick = () => {
      const i = webState.items.find(x => x.id === Number(b.dataset.wedit));
      openForm({
        title: 'Edit photo or video', sub: i.title,
        defs: [
          { name: 'title', label: 'Title', type: 'text' },
          { name: 'location', label: 'Location (optional)', type: 'text' },
          { name: 'alt', label: 'Description for screen readers', type: 'text' },
          { name: 'file', label: 'Replace the photo or video (optional)', type: 'file', single: true, accept: WEB_ACCEPT, wide: true, hint: 'Leave empty to keep the current file.' }
        ],
        values: { title: i.title, location: i.location, alt: i.alt },
        submit: body => webSend('PATCH', `/api/admin/site-media/${i.id}`, body),
        after: () => { toast('Saved'); loadWebsite(); }
      });
    });
    $$('#webRows [data-wvis]').forEach(b => b.onclick = async () => {
      const i = webState.items.find(x => x.id === Number(b.dataset.wvis));
      try { await webSend('PATCH', `/api/admin/site-media/${i.id}`, { visible: !i.visible }); toast(i.visible ? 'Hidden from the website' : 'Shown on the website'); loadWebsite(); } catch (e) { toast(e.message, true); }
    });
    $$('#webRows [data-wmove]').forEach(b => b.onclick = async () => {
      const ids = rows.map(x => x.id), at = ids.indexOf(Number(b.dataset.id)), to = at + Number(b.dataset.wmove);
      if (to < 0 || to >= ids.length) return;
      [ids[at], ids[to]] = [ids[to], ids[at]];
      try { await api('/api/admin/site-media/reorder', { method: 'POST', json: { ids } }); loadWebsite(); } catch (e) { toast(e.message, true); }
    });
    $$('#webRows [data-wdel]').forEach(b => b.onclick = async () => {
      const i = webState.items.find(x => x.id === Number(b.dataset.wdel));
      if (!confirm(`Remove “${i.title}” from the website?`)) return;
      try { await api(`/api/admin/site-media/${i.id}`, { method: 'DELETE' }); toast('Removed'); loadWebsite(); } catch (e) { toast(e.message, true); }
    });
  }

  async function loadScopes() {
    const r = await api('/api/admin/scopes');
    Object.assign(scopeState, { items: r.items || [], categories: r.categories || {}, pricing: r.pricing || {} });
    const cur = $('#scopeCat').value;
    $('#scopeCat').innerHTML = '<option value="">All categories</option>' + Object.entries(scopeState.categories).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    $('#scopeCat').value = cur;
    const n = r.summary ? r.summary.needs_rates : 0;
    { const act = scopeState.items.filter(i => !i.archived && i.active !== 0), byCat = k => act.filter(i => i.category === k).length, ic4 = { construction: ['projects', 'blue'], multifamily: ['customers', 'purple'], janitorial: ['check', 'green'], specialty: ['scopes', 'teal'] };
      $('#scopeKpis').innerHTML = kt('scopes', 'navy', 'Active scope items', act.length, `${Object.keys(scopeState.categories).length} categories`) + Object.entries(scopeState.categories).slice(0, 4).map(([k, v]) => kt(...(ic4[k] || ['scopes', 'blue']), v, byCat(k), '')).join('') + kt('issues', n ? 'red' : 'green', 'Need a price', n, n ? 'estimates skip these' : 'all priced'); }
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
  // ---- Sortable, paginated tables (every list table: table.t). Applied automatically, re-applied after re-renders. ----
  const PAGE = 50;
  const cellVal = td => { const t = (td ? td.textContent : '').trim(); const n = t.replace(/[$,%\s]/g, ''); if (/^-?\d+(\.\d+)?$/.test(n)) return { k: 0, v: Number(n) }; const d = Date.parse(t.replace(/·.*$/, '')); if (!isNaN(d) && /\d{4}|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(t)) return { k: 1, v: d }; return { k: 2, v: t.toLowerCase() }; };
  function sortBody(tb, col, dir) { const rows = [...tb.rows]; rows.sort((a, b) => { const x = cellVal(a.cells[col]), y = cellVal(b.cells[col]); const r = x.k !== y.k ? x.k - y.k : (x.v < y.v ? -1 : x.v > y.v ? 1 : 0); return r * dir; }); if (rows.some((r, i) => tb.rows[i] !== r)) rows.forEach(r => tb.appendChild(r)); }
  function pageBody(tbl) {
    const tb = tbl.tBodies[0]; if (!tb) return; const rows = [...tb.rows].filter(r => r.cells.length > 1), limit = Number(tbl.dataset.limit || PAGE);
    rows.forEach((r, i) => { r.hidden = i >= limit; });
    let f = tbl.parentElement.querySelector(':scope > .tblmore'); if (rows.length <= limit) { if (f) f.remove(); return; }
    if (!f) { f = document.createElement('div'); f.className = 'tblmore'; f.style.cssText = 'padding:8px 4px;font-size:13px;color:#5b6b7d'; tbl.after(f); }
    f.innerHTML = `Showing ${limit} of ${rows.length} · <a href="#" data-more>Show ${Math.min(PAGE, rows.length - limit)} more</a> · <a href="#" data-all>Show all</a>`;
    f.querySelector('[data-more]').onclick = ev => { ev.preventDefault(); tbl.dataset.limit = limit + PAGE; pageBody(tbl); };
    f.querySelector('[data-all]').onclick = ev => { ev.preventDefault(); tbl.dataset.limit = rows.length; pageBody(tbl); };
  }
  function enhanceTable(tbl) {
    try { if (!tbl.tHead || !tbl.tHead.rows[0] || !tbl.tBodies[0]) return; enhanceTable2(tbl); } catch (e) { console.warn('table enhance skipped:', e.message); }
  }
  function enhanceTable2(tbl) {
    if (!tbl.dataset.enh) { tbl.dataset.enh = '1';
      // One delegated listener: keeps working when the page rebuilds its header row.
      tbl.addEventListener('click', ev => { const th = ev.target.closest && ev.target.closest('thead th'); if (!th || !tbl.contains(th) || !th.textContent.trim()) return;
        const cells = [...th.parentElement.cells], i = cells.indexOf(th), dir = tbl.dataset.scol === String(i) && tbl.dataset.sdir === '1' ? -1 : 1; tbl.dataset.scol = i; tbl.dataset.sdir = dir;
        cells.forEach(h => { h.setAttribute('aria-sort', 'none'); const m = h.querySelector('.sortm'); if (m) m.remove(); });
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending'); th.insertAdjacentHTML('beforeend', `<span class="sortm" style="font-size:10px"> ${dir === 1 ? '▲' : '▼'}</span>`);
        sortBody(tbl.tBodies[0], i, dir); pageBody(tbl); if (tbl.__obs) tbl.__obs.takeRecords(); });
      tbl.__obs = new MutationObserver(() => { if (tbl.dataset.scol) sortBody(tbl.tBodies[0], Number(tbl.dataset.scol), Number(tbl.dataset.sdir)); delete tbl.dataset.limit; pageBody(tbl); tbl.__obs.takeRecords(); });
      tbl.__obs.observe(tbl.tBodies[0], { childList: true });
    }
    pageBody(tbl);
  }
  const enhanceAll = root => (root || document).querySelectorAll('table.t').forEach(enhanceTable);
  new MutationObserver(muts => { const seen = new Set(); for (const m of muts) { const host = m.target && m.target.closest ? m.target.closest('table.t') : null; if (host) seen.add(host); for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches && n.matches('table.t')) seen.add(n); else if (n.querySelectorAll) n.querySelectorAll('table.t').forEach(t => seen.add(t)); } } seen.forEach(t => { if (!t.dataset.enh) enhanceTable(t); }); }).observe(document.body, { childList: true, subtree: true });
  enhanceAll();
  if (token) { loadPrefs().then(() => { const cc = prefs.command_center || {}, cf = prefs.calls_filters || {}; if (cc.days && $('#ccDays') && [...$('#ccDays').options].some(o => o.value === String(cc.days))) $('#ccDays').value = String(cc.days); if ($('#callFollow')) $('#callFollow').checked = !!cf.follow; if ($('#callVm')) $('#callVm').checked = !!cf.vm; }).finally(() => { start(); setTimeout(connectLive, 800); }); } else signOut();
})();
