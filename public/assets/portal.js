// Client portal page: request a sign-in link, exchange it for a session, and show the customer's own records.
(function () {
  var KEY = 'bc_portal_session';
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function show(signedIn) { $('pSignin').hidden = signedIn; $('pRecords').hidden = !signedIn; }
  function link(href, text) { return href ? '<a href="' + esc(href) + '">' + esc(text) + '</a>' : ''; }
  function rows(list, render) { return list.length ? '<ul style="list-style:none;padding:0;margin:0">' + list.map(function (x) { return '<li style="padding:10px 0;border-bottom:1px solid #e5ecf4">' + render(x) + '</li>'; }).join('') + '</ul>' : '<p class="muted">Nothing here yet.</p>'; }

  function load(token) {
    return fetch('/api/portal/me', { headers: { Authorization: 'Bearer ' + token } }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }
  function paint(d) {
    $('pWho').textContent = 'Signed in as ' + d.email;
    $('pProposals').innerHTML = rows(d.proposals, function (p) { return '<b>' + esc(p.title) + '</b> · ' + money(p.total) + ' · ' + esc(p.status) + ' ' + link(p.link, 'Open'); });
    $('pContracts').innerHTML = rows(d.contracts, function (k) { return '<b>' + esc(k.title) + '</b> · ' + money(k.value) + ' · ' + esc(k.signature) + ' ' + (k.link ? link(k.link, 'Review and sign') : ''); });
    $('pInvoices').innerHTML = rows(d.invoices, function (i) { return '<b>' + esc(i.number) + '</b> · ' + money(i.amount) + ' · paid ' + money(i.paid) + ' · balance ' + money(i.balance) + (i.due ? ' · due ' + esc(i.due) : ''); });
    $('pProjects').innerHTML = rows(d.projects, function (p) { return '<b>' + esc(p.name) + '</b> · ' + esc(p.status) + ' · ' + esc(p.progress) + '% complete' + (p.site ? ' · ' + esc(p.site) : ''); });
    show(true);
  }
  function signOut() { try { sessionStorage.removeItem(KEY); } catch (e) { /* private window */ } history.replaceState(null, '', '/portal.html'); show(false); }

  $('pForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = e.target.email.value;
    $('pMsg').textContent = 'Sending…';
    fetch('/api/portal/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { $('pMsg').textContent = j.message || 'Check your email for the sign-in link.'; })
      .catch(function () { $('pMsg').textContent = 'Could not send the link. Please try again.'; });
  });

  $('pSignout').addEventListener('click', signOut);

  // Arriving from the email link: the token is in the URL hash, then removed from the address bar.
  var token = (location.hash || '').replace(/^#/, '');
  if (token) {
    history.replaceState(null, '', '/portal.html');
    fetch('/api/portal/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { $('pMsg').textContent = x.j.error || 'This sign-in link is not valid.'; return null; }
        try { sessionStorage.setItem(KEY, x.j.session); } catch (e) { /* private window: session stays in memory */ }
        return load(x.j.session);
      })
      .then(function (d) { if (d && d.ok) paint(d.j); else if (d) { $('pMsg').textContent = 'Please sign in again.'; } });
    return;
  }
  var saved = null; try { saved = sessionStorage.getItem(KEY); } catch (e) { saved = null; }
  if (saved) load(saved).then(function (d) { if (d.ok) paint(d.j); else { try { sessionStorage.removeItem(KEY); } catch (e) { /* */ } show(false); } });
})();
