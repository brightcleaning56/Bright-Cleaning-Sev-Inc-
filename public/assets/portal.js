// Client portal (integrated with the approved customer portal design).
// Sign-in is a one-time email link (no passwords). Pages show only this customer's own records from /api/portal/me.
// Pages with no data yet show neutral empty states. Nothing here sends data anywhere except the portal's own API.
(function () {
  var KEY = 'bc_portal_session';
  var META = {
    overview: ['Welcome Back', "Here's what's happening with your Bright Clean account today."],
    properties: ['My Properties', 'The locations and buildings on your account.'],
    services: ['Services & Schedule', 'Your recurring services and upcoming cleaning visits.'],
    proposals: ['Proposals', 'Review, approve, or request changes to your cleaning proposals.'],
    contracts: ['Contracts', 'Agreements, signatures and renewal dates for your cleaning services.'],
    invoices: ['Invoices & Payments', 'Balances and invoice details for your account.'],
    projects: ['Projects', 'Project progress and closeout information for your account.'],
    quality: ['Quality & Inspections', 'Quality results, inspections and corrective actions for your properties.'],
    documents: ['Documents', 'Approved proposals, contracts, project files and other important documents for your account.'],
    request: ['Request a Service', 'Tell us what you need. We review every request and follow up with you.'],
    messages: ['Messages & Support', 'Contact Bright Clean, track your requests, and get help with your services.'],
    settings: ['Account Settings', 'Manage your profile, contact information, notifications, and security.']
  };
  var data = null, email = '', page = 'overview', session = null, requestPreset = '';
  var REQUEST_TYPES = { proposal: 'Proposal request', contract: 'Contract request', recurring: 'Recurring service request', property: 'New property request' };
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
  function activeProps(d) { return (d.properties || []).filter(function (x) { return String(x.status || '').toLowerCase() !== 'archived'; }); }
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
        '<article class="stat-card"><div class="stat-top">Active Properties <span class="stat-icon">▦</span></div><div class="stat-value">' + activeProps(d).length + '</div><div class="stat-note">' + (activeProps(d).length ? 'On your account' : 'None yet') + '</div></article>' +
        '<article class="stat-card"><div class="stat-top">Upcoming Services <span class="stat-icon">▧</span></div><div class="stat-value">' + d.visits.filter(function (v) { return v.status !== 'Done'; }).length + '</div><div class="stat-note">' + (d.visits.filter(function (v) { return v.status !== 'Done'; }).length ? 'Confirmed visits' : 'None scheduled') + '</div></article>' +
        '<article class="stat-card"><div class="stat-top">Open Invoices <span class="stat-icon">＄</span></div><div class="stat-value">' + openCount + '</div><div class="stat-note">' + (open ? money(open) + ' balance due' : 'Nothing due') + '</div></article>' +
        '<article class="stat-card"><div class="stat-top">Pending Proposals <span class="stat-icon">▤</span></div><div class="stat-value">' + pending + '</div><div class="stat-note">' + (pending ? 'Review and approve' : 'Nothing to review') + '</div></article></div>';
      html += '<div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px">' +
        '<div class="panel"><h2>Upcoming Services</h2>' + visitsHtml(d.visits, 5) + '</div>' +
        '<div class="panel"><h2>Recent Invoices</h2>' + (d.invoices.length ? '<table class="t"><tbody>' + d.invoices.slice(0, 5).map(function (i) { return '<tr><td><b>' + esc(i.number) + '</b></td><td>' + money(i.amount) + '</td><td>' + (i.balance > 0 ? '<span class="badge amber">Open</span> <small>pay on Invoices &amp; Payments</small>' : '<span class="badge green">Paid</span>') + '</td></tr>'; }).join('') + '</tbody></table>' : empty('No invoices yet', 'Invoices will appear here.')) + '</div></div>';
      html += '<div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:16px"><div class="panel"><h2>Recent Activity</h2>' + activityHtml(d.activity) + '</div><div></div></div>';
      html += '<div class="panel" style="margin-top:16px"><h2>Quick Actions</h2><div class="grid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:12px">' +
        '<button class="nav-item" data-go="request"><span>＋</span> Request Service</button>' +
        '<button class="nav-item" data-go="proposals"><span>▤</span> View Proposals</button>' +
        '<button class="nav-item" data-go="contracts"><span>▧</span> View Contracts</button>' +
        '<a class="nav-item" href="tel:+15153033024"><span>✉</span> Contact Support</a></div></div>';
    } else if (page === 'proposals') {
      html = proposalsHtml();
    } else if (page === 'contracts') {
      html = '<p><button class="primary-button" type="button" data-request="contract">Request a contract</button></p>' + table(['Contract', 'Value', 'Signature', ''], d.contracts.map(function (k) { return [esc(k.title), money(k.value), esc(k.signature), k.link ? link(k.link, 'Review and sign') : (k.signature === 'Signed' ? '<span class="muted">Signed</span>' : '<span class="muted">Not available yet</span>')]; }));
    } else if (page === 'invoices') {
      html = table(['Invoice', 'Amount', 'Paid', 'Balance', 'Due', ''], d.invoices.map(function (i) { return [esc(i.number), money(i.amount), money(i.paid), money(i.balance), esc(i.due || '—'), i.balance > 0 ? '<button class="primary-button" type="button" data-pay="' + esc(i.id) + '">Pay now</button>' : '<span class="muted">Paid</span>']; }));
      html += '<p class="muted">Pay securely by card with the Pay now button. To pay another way, call <a href="tel:+15153033024">+1 (515) 303-3024</a> or email <a href="mailto:info@brightclean.net">info@brightclean.net</a>.</p>';
    } else if (page === 'projects') {
      html = table(['Project', 'Status', 'Progress', 'Site'], d.projects.map(function (p) { return [esc(p.name), esc(p.status), esc(p.progress) + '%', esc(p.site || '—')]; }));
    } else if (page === 'properties') {
      html = d.properties.length ? table(['Property', 'Address', 'Status'], d.properties.map(function (x) { return [esc(x.name), esc(x.address), esc(x.status || '—')]; })) : empty('No properties yet', 'Properties appear here once a proposal or project is set up for your account. To add one, send a service request.');
      html += '<p style="margin-top:14px"><button class="primary-button" type="button" data-request="property">Request a new property</button></p>';
    } else if (page === 'services') {
      html = '<p><button class="primary-button" type="button" data-request="recurring">Add recurring service</button></p><div class="panel"><h2>Service Schedule</h2>' + visitsHtml(d.visits, 50) + '</div>' +
        '<div class="panel" style="margin-top:16px"><h2>Service Requests</h2>' + (d.requests.length ? table(['Requested', 'Service', 'Status'], d.requests.map(function (r) { return [esc(String(r.at).slice(0, 10)), esc(r.service), esc(r.status)]; })) : empty('No service requests yet', 'Requests you send from this portal appear here, with their status.')) + '</div>';
    } else if (page === 'quality') {
      var insp = d.inspections || [];
      html = (insp.length
        ? '<div class="panel"><h2>Inspection reports</h2>' + table(['Date', 'Property', 'Score', 'Result', 'Status', 'Signed by'], insp.map(function (i) {
            return [esc(i.date || '—'), esc(i.project || i.area || '—'), i.score == null ? '—' : esc(i.score) + '%', i.passed ? '<span class="badge green">Passed</span>' : '<span class="badge amber">Needs attention</span>', esc(i.status || '—'), esc(i.signed_by || '—')];
          })) + '</div>'
        : empty('No inspection reports yet', 'Signed inspection reports for your properties appear here after a service is inspected.')) +
        '<p style="margin-top:14px">If something needs attention, <button class="nav-item sm" type="button" data-go="messages">report a service issue</button> and our team will follow up.</p>';
    } else if (page === 'documents') {
      var docs = [];
      d.proposals.forEach(function (x) { docs.push([esc('Proposal: ' + x.title), 'Proposal', esc(x.status), link(x.link, 'View')]); });
      d.contracts.forEach(function (x) { docs.push([esc('Contract: ' + x.title), 'Contract', esc(x.signature), link(x.link, x.link ? 'Review' : (x.signature === 'Signed' ? 'Signed' : 'Not available yet'))]); });
      d.invoices.forEach(function (x) { docs.push([esc('Invoice ' + x.number), 'Invoice', esc(x.status), '<span class="muted">Pay on Invoices &amp; Payments</span>']); });
      html = table(['Document', 'Type', 'Status', ''], docs);
    } else if (page === 'messages') {
      html = '<div class="panel"><h2>Contact Support</h2><form id="msgForm"><div class="field"><label>Subject</label><input name="subject" placeholder="For example: schedule change"></div><div class="field" style="margin-top:12px"><label>Message *</label><textarea name="body" rows="4" required></textarea></div><p style="margin-top:14px"><button class="primary-button" type="submit">Send message</button></p></form><p class="msg" id="msgMsg" role="status"></p><p class="muted">Urgent? Call <a href="tel:+15153033024">+1 (515) 303-3024</a>.</p></div>' +
        '<div class="panel" style="margin-top:16px"><h2>Conversations</h2>' + (d.messages.length ? '<ul style="list-style:none;padding:0;margin:0">' + d.messages.map(function (m) { return '<li style="padding:10px 0;border-bottom:1px solid #e5ecf4"><small>' + esc(String(m.at).slice(0, 10)) + '</small><br><b>' + esc(m.subject) + '</b><br>' + esc(m.body) + (m.replies || []).map(function (r) { return '<div style="margin:8px 0 0 14px;padding:8px;background:#f2f7fc;border-radius:8px"><small>Bright Clean · ' + esc(String(r.at).slice(0, 10)) + '</small><br>' + esc(r.body) + '</div>'; }).join('') + '</li>'; }).join('') + '</ul>' : empty('No messages yet', 'Messages you send and replies from the Bright Clean team will appear here.')) + '</div>';
    } else if (page === 'request') {
      requestPreset = requestPreset || '';
      html = '<div class="panel"><form id="rsForm">' +
        '<div class="field"><label>Service needed *</label><select name="service" required><option value="">Choose a service</option><option>Proposal request</option><option>Contract request</option><option>Recurring service request</option><option>New property request</option><option>Post-construction final cleaning</option><option>Rough / progress cleaning</option><option>Punch-list / touch-up cleaning</option><option>Window cleaning (interior / exterior)</option><option>Commercial janitorial</option><option>Apartment common-area cleaning</option><option>Unit turnover / move-out</option><option>Commercial restroom cleaning</option><option>Floor care</option><option>Power washing</option><option>Other</option></select></div>' +
        '<div class="field"><label>Property address</label><input name="address"></div>' +
        '<div class="field"><label>Company</label><input name="company"></div>' +
        '<div class="field"><label>Your name</label><input name="contact_name"></div>' +
        '<div class="field"><label>Phone</label><input name="phone" type="tel"></div>' +
        '<div class="field"><label>What do you need? *</label><textarea name="details" rows="4" required placeholder="Example: weekly office cleaning, 3,000 sq ft, two restrooms."></textarea></div>' +
        '<p style="margin-top:14px"><button class="primary-button" type="submit">Send request</button></p>' +
        '</form><p class="msg" id="rsMsg" role="status"></p></div>';
      requestPreset = requestPreset || '';
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
        '<div class="panel"><h2>Notifications</h2><p class="muted">Turn off automatic reminders. Other emails from Bright Clean, such as invoices you are sent, still come through.</p><form id="notifyForm">' +
        box('proposals', 'Proposal follow-up reminders') + box('invoices', 'Invoice payment reminders') + box('messages', 'Replies to your messages') +
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
      var n = {}; ['proposals', 'invoices', 'messages'].forEach(function (k) { n[k] = !!e.target['n_' + k].checked; });
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
    if (rf && requestPreset) { rf.service.value = requestPreset; requestPreset = ''; }
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

  // ---- Proposals: list with tabs and search, a detail panel, and confirm steps before any decision ----
  var propTab = 'all', propQuery = '', propSel = null, propDetail = 'overview';
  function propTabOf(p) { return p.actionable ? 'awaiting' : p.status === 'Approved' ? 'approved' : p.status === 'Declined' ? 'declined' : p.status === 'Expired' ? 'expired' : 'other'; }
  function propLabel(p) { return p.actionable ? 'Awaiting Review' : p.status; }
  function propBadge(p) {
    var l = propLabel(p), cls = { 'Awaiting Review': 'amber', 'Approved': 'green', 'Declined': 'red', 'Expired': 'purple' }[l] || 'blue';
    return '<span class="badge ' + cls + '">' + esc(l) + '</span>';
  }
  function proposalsHtml() {
    var all = data.proposals || [];
    var count = function (k) { return k === 'all' ? all.length : all.filter(function (p) { return propTabOf(p) === k; }).length; };
    var tabs = [['all', 'All Proposals'], ['awaiting', 'Awaiting Review'], ['approved', 'Approved'], ['declined', 'Declined'], ['expired', 'Expired']];
    var list = all.filter(function (p) {
      return (propTab === 'all' || propTabOf(p) === propTab) &&
        (!propQuery || [p.number, p.title, p.site, p.customer, p.status].join(' ').toLowerCase().indexOf(propQuery) >= 0);
    });
    if (!all.some(function (p) { return p.id === propSel; })) propSel = list.length ? list[0].id : null;
    var sel = all.filter(function (p) { return p.id === propSel; })[0];
    var stat = function (label, n, cls, icon) { return '<article class="stat-card ' + cls + '"><div class="stat-top">' + label + ' <span class="stat-icon">' + icon + '</span></div><div class="stat-value">' + n + '</div></article>'; };
    var html = '<div class="prop-actions"><button class="primary-button" type="button" data-request="proposal">＋ Request a Proposal</button><button class="btn ghost" type="button" data-go="messages">Message Bright Clean</button></div>';
    html += '<div class="grid stats prop-stats">' + stat('Total Proposals', all.length, 'st-blue', '▤') + stat('Awaiting Review', count('awaiting'), 'st-amber', '◷') +
      stat('Approved', count('approved'), 'st-green', '✓') + stat('Declined', count('declined'), 'st-red', '✕') + stat('Expired', count('expired'), 'st-purple', '▦') + '</div>';
    html += '<div class="prop-layout"><div class="panel prop-list"><div class="prop-tabs">' +
      tabs.map(function (t) { return '<button type="button" class="prop-tab' + (propTab === t[0] ? ' on' : '') + '" data-ptab="' + t[0] + '">' + t[1] + ' (' + count(t[0]) + ')</button>'; }).join('') + '</div>' +
      '<div class="prop-search"><input type="search" id="propQ" placeholder="Search proposal number, title or property…" value="' + esc(propQuery) + '"></div>' +
      (list.length ? '<div class="tbl-wrap"><table class="t"><thead><tr><th>Proposal #</th><th>Title</th><th>Property</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>' +
        list.map(function (p) {
          return '<tr class="' + (p.id === propSel ? 'row-on' : '') + '"><td><a href="#" data-pview="' + p.id + '">' + esc(p.number) + '</a></td><td>' + esc(p.title) + '</td><td>' + esc(p.site || '—') + '</td><td>' + money(p.total) + '</td><td>' + propBadge(p) + '</td><td><button class="btn ghost" type="button" data-pview="' + p.id + '">View</button></td></tr>';
        }).join('') + '</tbody></table></div>' : empty('No proposals match', 'Try another search, or choose All Proposals.')) + '</div>' +
      (sel ? proposalDetailHtml(sel) : '<aside class="panel prop-detail">' + empty('No proposal selected', 'Proposals from Bright Clean will appear here.') + '</aside>') + '</div>';
    return html;
  }
  function proposalDetailHtml(p) {
    var decidedOn = p.decided_at ? ' on ' + esc(p.decided_at) : '';
    var acts = p.actionable
      ? '<div class="prop-acts"><button class="primary-button" type="button" data-pact="approve">✓ Approve Proposal</button><button class="btn danger" type="button" data-pact="decline">✕ Decline</button><button class="btn ghost" type="button" data-pact="changes">✎ Request Changes</button></div>'
      : '<p class="prop-note">' + (p.status === 'Approved' ? 'You approved this proposal' + decidedOn + '.' : p.status === 'Declined' ? 'You declined this proposal' + decidedOn + '.' : p.status === 'Expired' ? 'This proposal has expired. Message Bright Clean for an updated one.' : 'This proposal is not open for a decision.') + '</p>';
    var tabs = [['overview', 'Overview'], ['scope', 'Scope of Work'], ['pricing', 'Pricing'], ['terms', 'Terms'], ['documents', 'Documents']];
    var body = '';
    if (propDetail === 'overview') {
      body = '<div class="prop-kv"><div><span>Property</span><b>' + esc(p.site || p.title) + '</b></div><div><span>Total investment</span><b>' + money(p.total) + '</b></div>' +
        '<div><span>Issued</span><b>' + esc(p.issued || '—') + '</b></div><div><span>Expires</span><b>' + esc(p.expires || '—') + '</b></div>' +
        '<div><span>Account contact</span><b>' + esc(p.customer || '—') + (p.company ? '<br><small class="muted">' + esc(p.company) + '</small>' : '') + '</b></div></div>';
    } else if (propDetail === 'scope') {
      body = '<p class="prop-scope">' + esc(p.scope || 'The scope of work is described in the proposal document.') + '</p>' + (p.area_sqft ? '<p class="muted">Area: ' + esc(Number(p.area_sqft).toLocaleString('en-US')) + ' sq ft</p>' : '');
    } else if (propDetail === 'pricing') {
      body = p.items.length
        ? '<table class="t prop-pricing"><thead><tr><th>Service</th><th>Frequency</th><th>Amount</th></tr></thead><tbody>' + p.items.map(function (i) { return '<tr><td>' + esc(i.description) + '</td><td>' + esc(i.frequency || '—') + '</td><td>' + money(i.amount) + '</td></tr>'; }).join('') + '<tr><td><b>Total investment</b></td><td></td><td><b>' + money(p.total) + '</b></td></tr></tbody></table>'
        : '<p>Total investment: <b>' + money(p.total) + '</b></p><p class="muted">The itemized pricing is in the proposal document.</p>';
      if (p.tax_pct) body += '<p class="muted">Tax rate applied: ' + esc(p.tax_pct) + '%.</p>';
    } else if (propDetail === 'terms') {
      body = '<p class="prop-scope">' + esc(p.terms || 'No additional terms on this proposal.') + '</p>';
    } else {
      body = '<div class="prop-doc"><div><b>Proposal PDF</b><br><small class="muted">' + esc(p.number) + '.pdf</small></div><a class="primary-button" href="' + esc(p.pdf) + '" target="_blank" rel="noopener">View / Download</a></div>' +
        '<p class="muted"><a href="' + esc(p.link) + '" target="_blank" rel="noopener">Open the online proposal</a></p>';
    }
    return '<aside class="panel prop-detail">' +
      '<div class="prop-head"><div><b class="prop-num">' + esc(p.number) + '</b><h3>' + esc(p.title) + '</h3></div><div>' + propBadge(p) + '</div></div>' +
      acts +
      (p.status === 'Declined' && p.decline_reason ? '<p class="muted">Your reason: ' + esc(p.decline_reason) + '</p>' : '') +
      '<div class="prop-tabs prop-dtabs">' + tabs.map(function (t) { return '<button type="button" class="prop-tab' + (propDetail === t[0] ? ' on' : '') + '" data-dtab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      body + '</aside>';
  }
  function proposalSel() { return (data.proposals || []).filter(function (p) { return p.id === propSel; })[0]; }
  function openProposalModal(kind) {
    var p = proposalSel(); if (!p) return;
    var title, text, fields, btn;
    if (kind === 'approve') {
      title = 'Approve ' + p.number + '?';
      text = 'You are approving ' + p.title + ' for ' + money(p.total) + '. Type your full name to sign. Our team will then confirm next steps.';
      fields = '<div class="field"><label>Full name *</label><input name="signer_name" required autocomplete="name"></div>' +
        '<div class="field" style="margin-top:12px"><label>Title (optional)</label><input name="signer_title"></div>' +
        '<label class="chk" style="margin-top:14px"><input type="checkbox" name="agree" required> I am authorized to approve this proposal for my organization.</label>';
      btn = 'Approve proposal';
    } else if (kind === 'decline') {
      title = 'Decline ' + p.number + '?';
      text = 'You can tell us why, if you like. This helps us improve future proposals.';
      fields = '<div class="field"><label>Reason (optional)</label><textarea name="reason" rows="3"></textarea></div>';
      btn = 'Decline proposal';
    } else {
      title = 'Request changes to ' + p.number;
      text = 'Describe what you would like changed. We will send an updated proposal.';
      fields = '<div class="field"><label>What should change? *</label><textarea name="body" rows="4" required></textarea></div>';
      btn = 'Send request';
    }
    var back = document.createElement('div'); back.className = 'modal-back';
    back.innerHTML = '<form class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><h2>' + esc(title) + '</h2><p class="muted">' + esc(text) + '</p>' + fields +
      '<p class="msg" role="status"></p><div class="modal-acts"><button type="button" class="btn ghost" data-mcancel>Cancel</button><button class="primary-button" type="submit">' + esc(btn) + '</button></div></form>';
    document.body.appendChild(back);
    back.querySelector('[data-mcancel]').addEventListener('click', function () { back.remove(); });
    back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });
    back.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target, msg = f.querySelector('.msg'), sb = f.querySelector('button[type=submit]');
      sb.disabled = true; msg.textContent = 'Sending…';
      var url, payload;
      if (kind === 'changes') { url = '/api/portal/proposals/' + p.id + '/changes'; payload = { body: f.body.value }; }
      else {
        url = '/api/portal/proposals/' + p.id + '/respond';
        payload = kind === 'approve' ? { decision: 'approve', signer_name: f.signer_name.value, signer_title: f.signer_title.value, agree: f.agree.checked } : { decision: 'decline', reason: f.reason.value };
      }
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) {
          if (x.ok) { back.remove(); toast(x.j.message || 'Saved.'); refreshData(); }
          else { msg.textContent = x.j.error || 'Could not send. Please try again.'; sb.disabled = false; }
        })
        .catch(function () { msg.textContent = 'Could not send. Please try again or call (515) 303-3024.'; sb.disabled = false; });
    });
    var first = back.querySelector('input,textarea'); if (first) first.focus();
  }
  document.addEventListener('click', function (e) {
    if (page !== 'proposals' || !data) return;
    var t = e.target.closest && e.target.closest('[data-ptab],[data-pview],[data-dtab],[data-pact]'); if (!t) return;
    if (t.hasAttribute('data-ptab')) { propTab = t.getAttribute('data-ptab'); propSel = null; render(); }
    else if (t.hasAttribute('data-pview')) { e.preventDefault(); propSel = Number(t.getAttribute('data-pview')); propDetail = 'overview'; render(); }
    else if (t.hasAttribute('data-dtab')) { propDetail = t.getAttribute('data-dtab'); render(); }
    else if (t.hasAttribute('data-pact')) { openProposalModal(t.getAttribute('data-pact')); }
  });
  document.addEventListener('input', function (e) {
    if (page !== 'proposals' || !e.target || e.target.id !== 'propQ') return;
    propQuery = e.target.value.trim().toLowerCase();
    var pos = e.target.selectionStart; render();
    var q = $('propQ'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (err) { /* */ } }
  });

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
    var r = e.target.closest && e.target.closest('[data-request]'); if (!r || !data) return;
    requestPreset = REQUEST_TYPES[r.getAttribute('data-request')] || ''; setPage('request');
  });
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
