// Client portal (integrated with the approved customer portal design).
// Sign-in is a one-time email link (no passwords). Pages show only this customer's own records from /api/portal/me.
// Pages with no data yet show neutral empty states. Nothing here sends data anywhere except the portal's own API.
(function () {
  var KEY = 'bc_portal_session';
  var META = {
    overview: ['Welcome back', 'Your services, projects and account details, all in one place.'],
    properties: ['My Properties', 'The locations and buildings on your account.'],
    services: ['Services & Schedule', 'Your recurring services and upcoming cleaning visits.'],
    proposals: ['Proposals', 'Estimates and proposals prepared for your organization.'],
    contracts: ['Contracts', 'Agreements, signatures and renewal dates.'],
    invoices: ['Invoices & Payments', 'Balances and invoice details.'],
    projects: ['Projects', 'Project progress and closeout information.'],
    quality: ['Quality & Inspections', 'Quality results and corrective actions.'],
    documents: ['Documents', 'Approved proposals, contracts and project files.'],
    request: ['Request a Service', 'Tell us what you need. We review every request and follow up with you.'],
    messages: ['Messages & Support', 'Send a message to the Bright Clean team and see your conversation.'],
    settings: ['Account Settings', 'Your sign-in and account details.']
  };
  var data = null, email = '', page = 'overview', session = null;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.classList.remove('show'); }, 2800); }
  function empty(title, text) { return '<div class="empty-state"><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p></div>'; }
  function table(head, rows) {
    if (!rows.length) return empty('Nothing here yet', 'When Bright Clean prepares records for your account, they will appear here.');
    return '<div class="panel"><table class="t"><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  function visitsHtml(list, max) {
    if (!list.length) return empty('No scheduled visits yet', 'Confirmed cleaning visits will appear here.');
    return '<ul style="list-style:none;padding:0;margin:0">' + list.slice(0, max).map(function (v) {
      var when = esc(v.date) + (v.start ? ' · ' + esc(v.start) + (v.end ? '–' + esc(v.end) : '') : '');
      return '<li style="padding:10px 0;border-bottom:1px solid #e5ecf4"><b>' + esc(v.title) + '</b><br><small>' + when + (v.address ? ' · ' + esc(v.address) : '') + ' · ' + esc(v.status) + '</small></li>';
    }).join('') + '</ul>';
  }
  function activityHtml(list) {
    if (!list.length) return empty('No activity yet', 'Updates to your proposals, contracts, invoices and services will appear here.');
    return '<ul style="list-style:none;padding:0;margin:0">' + list.map(function (a) {
      return '<li style="padding:10px 0;border-bottom:1px solid #e5ecf4"><small>' + esc(String(a.at || '').slice(0, 10)) + '</small><br>' + esc(a.text) + '</li>';
    }).join('') + '</ul>';
  }
  function setPage(p) {
    page = p;
    document.querySelectorAll('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.page === p); });
    $('page-title').textContent = META[p][0]; $('page-subtitle').textContent = META[p][1]; $('crumb').textContent = META[p][0];
    render();
  }
  function link(href, text) { return href ? '<a href="' + esc(href) + '">' + esc(text) + '</a>' : '<span class="muted">—</span>'; }

  function render() {
    var c = $('page-content');
    if (!data) { c.innerHTML = signinHtml(); bindSignin(); return; }
    var d = data, html = '';
    if (page === 'overview') {
      var open = d.invoices.reduce(function (t, i) { return t + i.balance; }, 0);
      var openCount = d.invoices.filter(function (i) { return i.balance > 0; }).length;
      var pending = d.proposals.filter(function (p) { return p.status === 'Sent' || p.status === 'Viewed'; }).length;
      html = '<div class="grid stats">' +
        '<article class="stat-card"><div class="stat-top">Active projects <span class="stat-icon">▦</span></div><div class="stat-value">' + d.projects.length + '</div><div class="stat-note">' + (d.projects.length ? 'On your account' : 'None yet') + '</div></article>' +
        '<article class="stat-card"><div class="stat-top">Contracts <span class="stat-icon">▧</span></div><div class="stat-value">' + d.contracts.length + '</div><div class="stat-note">' + (d.contracts.filter(function (k) { return k.link; }).length ? d.contracts.filter(function (k) { return k.link; }).length + ' waiting for signature' : 'Nothing to sign') + '</div></article>' +
        '<article class="stat-card"><div class="stat-top">Open invoices <span class="stat-icon">＄</span></div><div class="stat-value">' + openCount + '</div><div class="stat-note">' + (open ? money(open) + ' balance due' : 'Nothing due') + '</div></article>' +
        '<article class="stat-card"><div class="stat-top">Pending proposals <span class="stat-icon">▤</span></div><div class="stat-value">' + pending + '</div><div class="stat-note">' + (pending ? 'Review and approve' : 'Nothing to review') + '</div></article></div>';
      html += '<div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px">' +
        '<div class="panel"><h2>Upcoming services</h2>' + visitsHtml(d.visits, 5) + '</div>' +
        '<div class="panel"><h2>Recent invoices</h2>' + (d.invoices.length ? '<table class="t"><tbody>' + d.invoices.slice(0, 5).map(function (i) { return '<tr><td><b>' + esc(i.number) + '</b></td><td>' + money(i.amount) + '</td><td>' + (i.balance > 0 ? '<span class="badge amber">Open</span> <small>call to pay</small>' : '<span class="badge green">Paid</span>') + '</td></tr>'; }).join('') + '</tbody></table>' : empty('No invoices yet', 'Invoices will appear here.')) + '</div></div>';
      html += '<div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px"><div class="panel"><h2>Recent activity</h2>' + activityHtml(d.activity) + '</div><div></div></div>';
      html += '<div class="panel" style="margin-top:16px"><h2>Quick actions</h2><div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:12px">' +
        '<button class="nav-item" data-go="request"><span>＋</span> Request service</button>' +
        '<button class="nav-item" data-go="proposals"><span>▤</span> View proposals</button>' +
        '<button class="nav-item" data-go="contracts"><span>▧</span> Sign contracts</button>' +
        '<a class="nav-item" href="tel:+15153033024"><span>✉</span> Contact support</a></div></div>';
    } else if (page === 'proposals') {
      html = table(['Proposal', 'Total', 'Status', ''], d.proposals.map(function (p) { return [esc(p.title), money(p.total), esc(p.status), link(p.link, 'Open')]; }));
    } else if (page === 'contracts') {
      html = table(['Contract', 'Value', 'Signature', ''], d.contracts.map(function (k) { return [esc(k.title), money(k.value), esc(k.signature), k.link ? link(k.link, 'Review and sign') : '<span class="muted">Signed</span>']; }));
    } else if (page === 'invoices') {
      html = table(['Invoice', 'Amount', 'Paid', 'Balance', 'Due', ''], d.invoices.map(function (i) { return [esc(i.number), money(i.amount), money(i.paid), money(i.balance), esc(i.due || '—'), i.balance > 0 ? '<button class="primary-button" type="button" data-pay="' + esc(i.id) + '">Pay now</button>' : '<span class="muted">Paid</span>']; }));
      html += '<p class="muted">Pay securely by card with the Pay now button. To pay another way, call <a href="tel:+15153033024">+1 (515) 303-3024</a> or email <a href="mailto:info@brightclean.net">info@brightclean.net</a>.</p>';
    } else if (page === 'projects') {
      html = table(['Project', 'Status', 'Progress', 'Site'], d.projects.map(function (p) { return [esc(p.name), esc(p.status), esc(p.progress) + '%', esc(p.site || '—')]; }));
    } else if (page === 'properties') {
      html = d.properties.length ? table(['Property', 'Address', 'Status'], d.properties.map(function (x) { return [esc(x.name), esc(x.address), esc(x.status || '—')]; })) : empty('No properties yet', 'Properties appear here once a proposal or project is set up for your account. To add one, send a service request.');
      html += '<p style="margin-top:14px"><button class="primary-button" type="button" data-go="request">Request a service at a new property</button></p>';
    } else if (page === 'services') {
      html = '<div class="panel"><h2>Scheduled visits</h2>' + visitsHtml(d.visits, 50) + '</div>' +
        '<div class="panel" style="margin-top:16px"><h2>Your service requests</h2>' + (d.requests.length ? table(['Requested', 'Service', 'Status'], d.requests.map(function (r) { return [esc(String(r.at).slice(0, 10)), esc(r.service), esc(r.status)]; })) : empty('No service requests yet', 'Requests you send from this portal appear here, with their status.')) + '</div>';
    } else if (page === 'quality') {
      html = empty('No inspection reports yet', 'Approved inspection reports appear here after a service is inspected. If something needs attention, report it below and our team will follow up.') + '<p style="margin-top:14px"><button class="primary-button" type="button" data-go="messages">Report a service issue</button></p>';
    } else if (page === 'documents') {
      var docs = [];
      d.proposals.forEach(function (x) { docs.push([esc('Proposal: ' + x.title), 'Proposal', esc(x.status), link(x.link, 'View')]); });
      d.contracts.forEach(function (x) { docs.push([esc('Contract: ' + x.title), 'Contract', esc(x.signature), link(x.link, x.link ? 'Review' : 'Signed')]); });
      d.invoices.forEach(function (x) { docs.push([esc('Invoice ' + x.number), 'Invoice', esc(x.status), '<span class="muted">Pay on Invoices &amp; Payments</span>']); });
      html = table(['Document', 'Type', 'Status', ''], docs);
    } else if (page === 'messages') {
      html = '<div class="panel"><h2>Send a message</h2><form id="msgForm"><div class="field"><label>Subject</label><input name="subject" placeholder="For example: schedule change"></div><div class="field" style="margin-top:12px"><label>Message *</label><textarea name="body" rows="4" required></textarea></div><p style="margin-top:14px"><button class="primary-button" type="submit">Send message</button></p></form><p class="msg" id="msgMsg" role="status"></p><p class="muted">Urgent? Call <a href="tel:+15153033024">+1 (515) 303-3024</a>.</p></div>' +
        '<div class="panel" style="margin-top:16px"><h2>Your conversation</h2>' + (d.messages.length ? '<ul style="list-style:none;padding:0;margin:0">' + d.messages.map(function (m) { return '<li style="padding:10px 0;border-bottom:1px solid #e5ecf4"><small>' + esc(String(m.at).slice(0, 10)) + '</small><br><b>' + esc(m.subject) + '</b><br>' + esc(m.body) + '</li>'; }).join('') + '</ul>' : empty('No messages yet', 'Messages you send and replies from the Bright Clean team will appear here.')) + '</div>';
    } else if (page === 'request') {
      html = '<div class="panel"><form id="rsForm">' +
        '<div class="field"><label>Service needed *</label><select name="service" required><option value="">Choose a service</option><option>Post-construction final cleaning</option><option>Rough / progress cleaning</option><option>Punch-list / touch-up cleaning</option><option>Window cleaning (interior / exterior)</option><option>Commercial janitorial</option><option>Apartment common-area cleaning</option><option>Unit turnover / move-out</option><option>Commercial restroom cleaning</option><option>Floor care</option><option>Power washing</option><option>Other</option></select></div>' +
        '<div class="field"><label>Property address</label><input name="address"></div>' +
        '<div class="field"><label>Company</label><input name="company"></div>' +
        '<div class="field"><label>Your name</label><input name="contact_name"></div>' +
        '<div class="field"><label>Phone</label><input name="phone" type="tel"></div>' +
        '<div class="field"><label>What do you need? *</label><textarea name="details" rows="4" required placeholder="Example: weekly office cleaning, 3,000 sq ft, two restrooms."></textarea></div>' +
        '<p style="margin-top:14px"><button class="primary-button" type="submit">Send request</button></p>' +
        '</form><p class="msg" id="rsMsg" role="status"></p></div>';
    } else if (page === 'settings') {
      var pf = d.profile || {}, nf = pf.notify || {};
      var box = function (k, label) { return '<label class="chk" style="display:block;margin:6px 0"><input type="checkbox" name="n_' + k + '"' + (nf[k] !== false ? ' checked' : '') + '> ' + label + '</label>'; };
      html = '<div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:16px">' +
        '<div class="panel"><h2>Profile</h2><form id="profForm">' +
        '<div class="field"><label>Full name</label><input name="name" value="' + esc(pf.name || '') + '"></div>' +
        '<div class="field" style="margin-top:12px"><label>Company</label><input name="company" value="' + esc(pf.company || '') + '"></div>' +
        '<div class="field" style="margin-top:12px"><label>Phone</label><input name="phone" type="tel" value="' + esc(pf.phone || '') + '"></div>' +
        '<div class="field" style="margin-top:12px"><label>Sign-in email</label><input value="' + esc(email) + '" disabled></div>' +
        '<p class="muted" style="margin-top:8px">To change your sign-in email, message the team. We verify the new address before we change it.</p>' +
        '<p style="margin-top:14px"><button class="primary-button" type="submit">Save changes</button></p></form><p class="msg" id="profMsg" role="status"></p></div>' +
        '<div class="panel"><h2>Notifications</h2><p class="muted">Choose the updates we email you about.</p><form id="notifyForm">' +
        box('schedule', 'Schedule changes and visit confirmations') + box('proposals', 'New proposals and contract updates') +
        box('invoices', 'Invoices and payment receipts') + box('projects', 'Project progress and closeout notices') + box('messages', 'Replies to your messages') +
        '<p style="margin-top:14px"><button class="primary-button" type="submit">Save notifications</button></p></form><p class="msg" id="notifyMsg" role="status"></p></div></div>' +
        '<div class="panel" style="margin-top:16px"><h2>Sessions</h2><p><button class="nav-item" id="signOut" type="button">Sign out on this device</button> ' +
        '<button class="nav-item" id="signOutAll" type="button">Sign out everywhere</button></p><p class="muted">Signing out everywhere ends every session on every device. Sign in again with a new link.</p></div>';
    }
    c.innerHTML = html;
    var so = $('signOut'); if (so) so.addEventListener('click', signOut);
    var pfm = $('profForm');
    if (pfm) pfm.addEventListener('submit', function (e) {
      e.preventDefault(); $('profMsg').textContent = 'Saving…';
      var f = e.target;
      fetch('/api/portal/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session }, body: JSON.stringify({ name: f.name.value, company: f.company.value, phone: f.phone.value }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) { $('profMsg').textContent = x.ok ? 'Saved.' : (x.j.error || 'Could not save.'); if (x.ok) refreshData(); })
        .catch(function () { $('profMsg').textContent = 'Could not save. Please try again.'; });
    });
    var nfm = $('notifyForm');
    if (nfm) nfm.addEventListener('submit', function (e) {
      e.preventDefault(); $('notifyMsg').textContent = 'Saving…';
      var n = {}; ['schedule', 'proposals', 'invoices', 'projects', 'messages'].forEach(function (k) { n[k] = !!e.target['n_' + k].checked; });
      fetch('/api/portal/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session }, body: JSON.stringify({ notify: n }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) { $('notifyMsg').textContent = x.ok ? 'Saved.' : (x.j.error || 'Could not save.'); if (x.ok) refreshData(); })
        .catch(function () { $('notifyMsg').textContent = 'Could not save. Please try again.'; });
    });
    var soa = $('signOutAll');
    if (soa) soa.addEventListener('click', function () {
      if (!confirm('Sign out on every device? You will need a new sign-in link.')) return;
      fetch('/api/portal/sign-out-everywhere', { method: 'POST', headers: { Authorization: 'Bearer ' + session } })
        .then(function () { signOut(); toast('Signed out everywhere'); })
        .catch(function () { toast('Could not sign out everywhere. Try again.'); });
    });
    var mf = $('msgForm');
    if (mf) mf.addEventListener('submit', function (e) {
      e.preventDefault();
      $('msgMsg').textContent = 'Sending…';
      fetch('/api/portal/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session }, body: JSON.stringify({ subject: e.target.subject.value, body: e.target.body.value }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) { $('msgMsg').textContent = x.ok ? x.j.message : (x.j.error || 'Could not send.'); if (x.ok) { toast('Message sent'); setTimeout(function () { refreshData(); }, 400); } })
        .catch(function () { $('msgMsg').textContent = 'Could not send. Please try again or call (515) 303-3024.'; });
    });
    var rf = $('rsForm');
    if (rf) rf.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target, body = {};
      ['service', 'address', 'company', 'contact_name', 'phone', 'details'].forEach(function (k) { body[k] = f[k].value; });
      $('rsMsg').textContent = 'Sending…';
      fetch('/api/portal/request-service', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) { $('rsMsg').textContent = x.ok ? x.j.message : (x.j.error || 'Could not send the request.'); if (x.ok) f.reset(); })
        .catch(function () { $('rsMsg').textContent = 'Could not send the request. Please try again or call (515) 303-3024.'; });
    });
  }

  function signinHtml() {
    return '<div class="panel"><h2>Sign in</h2><p class="muted">Enter your email. We send a one-time sign-in link. There is no password.</p>' +
      '<form id="pForm"><div class="field"><label>Email address</label><input name="email" type="email" required autocomplete="email"></div>' +
      '<p style="margin-top:14px"><button class="primary-button" type="submit">Email me a sign-in link</button></p></form>' +
      '<p class="msg" id="pMsg" role="status"></p></div>';
  }
  function bindSignin() {
    var f = $('pForm'); if (!f) return;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      $('pMsg').textContent = 'Sending…';
      fetch('/api/portal/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e.target.email.value }) })
        .then(function (r) { return r.json(); })
        .then(function (j) { $('pMsg').textContent = j.message || 'Check your email for the sign-in link.'; })
        .catch(function () { $('pMsg').textContent = 'Could not send the link. Please try again.'; });
    });
  }

  function showSignedIn() {
    $('main-nav').hidden = false; $('who').hidden = false; $('requestBtn').hidden = false;
    $('whoEmail').textContent = email; $('avatar').textContent = (email[0] || 'B').toUpperCase();
  }
  function hideSignedIn() {
    $('main-nav').hidden = true; $('who').hidden = true; $('requestBtn').hidden = true;
  }
  function load(token) {
    return fetch('/api/portal/me', { headers: { Authorization: 'Bearer ' + token } }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }
  function refreshData() {
    if (!session) return;
    load(session).then(function (d) { if (d.ok) { data = d.j; render(); } });
  }
  function signOut() {
    try { sessionStorage.removeItem(KEY); } catch (e) { /* private window */ }
    data = null; email = ''; session = null; hideSignedIn(); history.replaceState(null, '', '/portal.html'); setPage('overview'); toast('Signed out');
  }

  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () { if (data) setPage(b.dataset.page); });
  });
  $('requestBtn').addEventListener('click', function () {});

  document.addEventListener('click', function (e) { var g = e.target.closest && e.target.closest('[data-go]'); if (g && data) setPage(g.getAttribute('data-go')); });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-pay]'); if (!b || !session) return;
    b.disabled = true; b.textContent = 'Opening secure payment…';
    fetch('/api/portal/invoices/' + encodeURIComponent(b.getAttribute('data-pay')) + '/pay', { method: 'POST', headers: { Authorization: 'Bearer ' + session } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (x.ok && x.j.url) { location.href = x.j.url; } else { toast(x.j.error || 'Payment could not be started.'); b.disabled = false; b.textContent = 'Pay now'; } })
      .catch(function () { toast('Payment could not be started. Please try again.'); b.disabled = false; b.textContent = 'Pay now'; });
  });
  var qp = new URLSearchParams(location.search);
  if (qp.get('paid')) { setTimeout(function () { toast('Thank you. Your payment for ' + qp.get('paid') + ' is being confirmed. It may take a moment to show.'); }, 600); }
  if (qp.get('cancelled')) { setTimeout(function () { toast('Payment was cancelled. Your invoice has not changed.'); }, 600); }

  // Arriving from the email link: the one-time token is in the URL hash, then removed from the address bar.
  var token = (location.hash || '').replace(/^#/, '');
  if (token) {
    history.replaceState(null, '', '/portal.html');
    fetch('/api/portal/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { toast(x.j.error || 'This sign-in link is not valid.'); render(); return null; }
        session = x.j.session; try { sessionStorage.setItem(KEY, x.j.session); } catch (e) { /* keep in memory */ }
        email = x.j.email;
        return load(x.j.session);
      })
      .then(function (d) { if (d && d.ok) { data = d.j; email = d.j.email; showSignedIn(); setPage('overview'); } else if (d) { toast('Please sign in again.'); render(); } });
  } else {
    var saved = null; try { saved = sessionStorage.getItem(KEY); } catch (e) { saved = null; }
    if (saved) {
      load(saved).then(function (d) {
        if (d.ok) { session = saved; data = d.j; email = d.j.email; showSignedIn(); setPage('overview'); }
        else { try { sessionStorage.removeItem(KEY); } catch (e) { /* */ } render(); }
      });
    } else { render(); }
  }
})();
