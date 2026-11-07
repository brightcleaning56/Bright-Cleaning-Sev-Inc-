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
    messages: ['Messages & Support', 'Contact Bright Clean about your requests.'],
    settings: ['Account Settings', 'Your sign-in and account details.']
  };
  var data = null, email = '', page = 'overview';
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
        '<div class="panel"><h2>Upcoming services</h2>' + empty('No scheduled visits yet', 'Confirmed cleaning visits will appear here.') + '</div>' +
        '<div class="panel"><h2>Recent invoices</h2>' + (d.invoices.length ? '<table class="t"><tbody>' + d.invoices.slice(0, 5).map(function (i) { return '<tr><td><b>' + esc(i.number) + '</b></td><td>' + money(i.amount) + '</td><td>' + (i.balance > 0 ? '<span class="badge amber">Open</span> <small>call to pay</small>' : '<span class="badge green">Paid</span>') + '</td></tr>'; }).join('') + '</tbody></table>' : empty('No invoices yet', 'Invoices will appear here.')) + '</div></div>';
      html += '<div class="panel" style="margin-top:16px"><h2>Quick actions</h2><div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:12px">' +
        '<a class="nav-item" href="/request-a-quote.html"><span>＋</span> Request service</a>' +
        '<button class="nav-item" data-go="proposals"><span>▤</span> View proposals</button>' +
        '<button class="nav-item" data-go="contracts"><span>▧</span> Sign contracts</button>' +
        '<a class="nav-item" href="tel:+15153033024"><span>✉</span> Contact support</a></div></div>';
    } else if (page === 'proposals') {
      html = table(['Proposal', 'Total', 'Status', ''], d.proposals.map(function (p) { return [esc(p.title), money(p.total), esc(p.status), link(p.link, 'Open')]; }));
    } else if (page === 'contracts') {
      html = table(['Contract', 'Value', 'Signature', ''], d.contracts.map(function (k) { return [esc(k.title), money(k.value), esc(k.signature), k.link ? link(k.link, 'Review and sign') : '<span class="muted">Signed</span>']; }));
    } else if (page === 'invoices') {
      html = table(['Invoice', 'Amount', 'Paid', 'Balance', 'Due'], d.invoices.map(function (i) { return [esc(i.number), money(i.amount), money(i.paid), money(i.balance), esc(i.due || '—')]; }));
      html += '<p class="muted">To pay an invoice, call <a href="tel:+15153033024">+1 (515) 303-3024</a> or email <a href="mailto:info@brightclean.net">info@brightclean.net</a>.</p>';
    } else if (page === 'projects') {
      html = table(['Project', 'Status', 'Progress', 'Site'], d.projects.map(function (p) { return [esc(p.name), esc(p.status), esc(p.progress) + '%', esc(p.site || '—')]; }));
    } else if (page === 'properties') {
      html = d.projects.length ? table(['Site'], d.projects.map(function (p) { return [esc(p.site || p.name)]; })) : empty('No properties yet', 'Properties appear here once a project is set up for your account.');
    } else if (page === 'services') {
      html = empty('No scheduled visits yet', 'Your recurring services and confirmed visits will appear here.');
    } else if (page === 'quality') {
      html = empty('No inspections yet', 'Quality results and corrective actions will appear here after a service is inspected.');
    } else if (page === 'documents') {
      html = empty('No documents yet', 'Approved proposals, contracts and project files will appear here.');
    } else if (page === 'messages') {
      html = '<div class="panel"><p>Call <a href="tel:+15153033024">+1 (515) 303-3024</a> or email <a href="mailto:info@brightclean.net">info@brightclean.net</a>. We reply during business hours.</p></div>';
    } else if (page === 'settings') {
      html = '<div class="panel"><p>Signed in as <b>' + esc(email) + '</b>.</p><p><button class="primary-button" id="signOut" type="button">Sign out</button></p></div>';
    }
    c.innerHTML = html;
    var so = $('signOut'); if (so) so.addEventListener('click', signOut);
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
  function signOut() {
    try { sessionStorage.removeItem(KEY); } catch (e) { /* private window */ }
    data = null; email = ''; hideSignedIn(); history.replaceState(null, '', '/portal.html'); setPage('overview'); toast('Signed out');
  }

  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.addEventListener('click', function () { if (data) setPage(b.dataset.page); });
  });
  $('requestBtn').addEventListener('click', function () {});

  document.addEventListener('click', function (e) { var g = e.target.closest && e.target.closest('[data-go]'); if (g && data) setPage(g.getAttribute('data-go')); });

  // Arriving from the email link: the one-time token is in the URL hash, then removed from the address bar.
  var token = (location.hash || '').replace(/^#/, '');
  if (token) {
    history.replaceState(null, '', '/portal.html');
    fetch('/api/portal/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { toast(x.j.error || 'This sign-in link is not valid.'); render(); return null; }
        try { sessionStorage.setItem(KEY, x.j.session); } catch (e) { /* keep in memory */ }
        email = x.j.email;
        return load(x.j.session);
      })
      .then(function (d) { if (d && d.ok) { data = d.j; email = d.j.email; showSignedIn(); setPage('overview'); } else if (d) { toast('Please sign in again.'); render(); } });
  } else {
    var saved = null; try { saved = sessionStorage.getItem(KEY); } catch (e) { saved = null; }
    if (saved) {
      load(saved).then(function (d) {
        if (d.ok) { data = d.j; email = d.j.email; showSignedIn(); setPage('overview'); }
        else { try { sessionStorage.removeItem(KEY); } catch (e) { /* */ } render(); }
      });
    } else { render(); }
  }
})();
