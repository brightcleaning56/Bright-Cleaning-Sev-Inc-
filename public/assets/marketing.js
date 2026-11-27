// Marketing & Growth admin screens. Every number comes from /api/admin/marketing and shows its source.
// Screens whose data needs a provider connection or AI generation say so; they do not show placeholder numbers.
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var view = $('#view'), titleEl = $('#page-title'), modeEl = $('#mode'), toastEl = $('#toast');
  var screen = 'dashboard';
  var labels = {
    dashboard: 'Growth dashboard', campaigns: 'Campaign manager', studio: 'AI marketing studio', keywords: 'Keyword intelligence',
    calendar: 'Content calendar', publishing: 'Social publishing', google: 'Google Ads', meta: 'Meta Ads',
    seo: 'Local SEO and service areas', attribution: 'Lead attribution', roi: 'Performance and ROI', settings: 'Marketing settings'
  };
  var CHANNELS = ['google_ads', 'meta_ads', 'google_business_profile', 'facebook', 'instagram', 'email', 'organic', 'referral', 'other'];

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 2800);
  }
  // Signed-in admins use the HttpOnly session cookie. Writes must send the CSRF header, as the rest of the admin does.
  function api(path, opts) {
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    var headers = { 'Accept': 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-BC-CSRF'] = '1';
    return fetch('/api/admin/marketing' + path, {
      method: method, credentials: 'same-origin', headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || ('Request failed (' + r.status + ')')); e.status = r.status; throw e; }
        return data;
      });
    });
  }
  function notConnected(err) {
    modeEl.textContent = 'Not connected';
    view.innerHTML = '<div class="card"><h2>Marketing data could not load</h2><p>' + esc(err.message) + '</p><p>Sign in again, then press Refresh.</p></div>';
  }
  function notBuilt(title, why) {
    return '<div class="card"><h2>' + esc(title) + '</h2><p><b>Not built yet.</b> ' + esc(why) + '</p><p class="muted">Nothing on this screen is live. No provider account is connected and no data is shown here.</p></div>';
  }
  function empty(msg) { return '<tr><td colspan="9" class="muted">' + esc(msg) + '</td></tr>'; }

  function dashboard() {
    return api('/summary').then(function (s) {
      modeEl.textContent = 'Live data';
      view.innerHTML =
        '<div class="grid four">' +
        card('Campaigns', s.campaigns.total, s.campaigns.active + ' active') +
        card('Attributed leads', s.attributed_leads, 'Leads with a recorded campaign') +
        card('Qualified leads', s.qualified_leads, s.definitions.qualified_leads) +
        card('Imported spend', money(s.spend), s.definitions.spend) +
        '</div>' +
        '<div class="card"><h2>Revenue, cash and profit</h2><p><b>Not reconciled yet.</b> Revenue and profit appear only after invoice, payment and project-cost records are joined to each lead. Until then, no ROI is shown.</p></div>';
    });
  }

  function campaigns() {
    return api('/campaigns').then(function (d) {
      var rows = d.campaigns.map(function (c) {
        return '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.channel) + '</td><td>' + esc(c.status) + '</td><td>' + esc(c.approval_status) + '</td><td>' + money(c.budget_amount) + ' ' + esc(c.budget_period) + '</td><td>' + c.attributed_leads + '</td><td>' + money(c.spend) + '</td>' +
          '<td class="row-actions">' +
          '<button class="btn small" data-act="approve" data-id="' + c.id + '">Approve</button> ' +
          (c.status === 'active' ? '<button class="btn small" data-act="pause" data-id="' + c.id + '">Pause</button>' : '<button class="btn small" data-act="activate" data-id="' + c.id + '">Activate</button>') +
          ' <button class="btn small" data-act="budget" data-id="' + c.id + '">Budget</button></td></tr>';
      }).join('') || empty('No campaigns yet. Create the first one above.');
      view.innerHTML =
        '<div class="card"><h2>New campaign (draft)</h2>' +
        '<form id="campaignForm" class="form-grid">' +
        '<label>Name<input name="name" maxlength="160" required></label>' +
        '<label>Channel<select name="channel">' + CHANNELS.map(function (c) { return '<option value="' + c + '">' + c + '</option>'; }).join('') + '</select></label>' +
        '<label>Service<input name="service_label" maxlength="160"></label>' +
        '<label>Monthly budget (USD)<input name="budget_amount" type="number" min="0" step="0.01" value="0"></label>' +
        '<label>Landing page (site path)<input name="landing_path" maxlength="300" placeholder="/commercial-cleaning.html"></label>' +
        '<label>Audience notes<input name="audience" maxlength="1000"></label>' +
        '<div><button class="btn primary" type="submit">Save draft</button></div></form>' +
        '<p class="muted">Creating a draft starts nothing. Approval, activation and budget changes are owner actions, and activation only changes Bright Clean\'s internal status.</p></div>' +
        '<div class="card"><h2>Campaigns (' + d.total + ')</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Channel</th><th>Status</th><th>Approval</th><th>Budget</th><th>Attributed leads</th><th>Imported spend</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
      $('#campaignForm').addEventListener('submit', submitCampaign);
      view.querySelectorAll('[data-act]').forEach(function (b) { b.addEventListener('click', campaignAction); });
    });
  }
  function submitCampaign(e) {
    e.preventDefault();
    var f = new FormData(e.target), body = {};
    f.forEach(function (v, k) { body[k] = v; });
    body.budget_amount = Number(body.budget_amount || 0);
    api('/campaigns', { method: 'POST', body: body }).then(function () { toast('Draft campaign saved'); render(); })
      .catch(function (err) { toast(err.message); });
  }
  function campaignAction(e) {
    var act = e.currentTarget.dataset.act, id = e.currentTarget.dataset.id;
    if (act === 'approve') return api('/campaigns/' + id + '/approve', { method: 'POST', body: {} }).then(function () { toast('Approved'); render(); }).catch(function (x) { toast(x.message); });
    if (act === 'budget') {
      var v = window.prompt('New monthly budget in USD (owner only)');
      if (v === null) return;
      return api('/campaigns/' + id + '/budget', { method: 'POST', body: { budget_amount: Number(v) } }).then(function () { toast('Budget saved'); render(); }).catch(function (x) { toast(x.message); });
    }
    var next = act === 'pause' ? 'paused' : 'active';
    if (next === 'active' && !window.confirm('Activate this campaign inside Bright Clean? This does not start any ad account.')) return;
    api('/campaigns/' + id + '/status', { method: 'POST', body: { status: next } }).then(function () { toast('Status changed (internal only)'); render(); }).catch(function (x) { toast(x.message); });
  }

  function attribution() {
    return api('/leads?limit=100').then(function (d) {
      var rows = d.leads.map(function (l) {
        return '<tr data-lead="' + l.id + '" class="clickable"><td>#' + l.id + ' ' + esc(l.contact_name || l.company || 'Lead') + '</td><td>' + esc(l.status) + '</td><td>' + esc(l.first_source || '') + ' / ' + esc(l.first_campaign || '') + '</td><td>' + esc(l.latest_source || '') + ' / ' + esc(l.latest_campaign || '') + '</td><td>' + esc(String(l.first_touch_at || '').slice(0, 10)) + '</td></tr>';
      }).join('') || empty('No attributed leads yet. Leads appear here when a campaign link is used on the bid or contact form.');
      view.innerHTML = '<div class="card"><h2>Attributed leads (' + d.total + ')</h2><p class="muted">First touch is fixed when the lead arrives. Latest touch moves with each new visit. Click a lead to see its touch history.</p><div class="table-wrap"><table><thead><tr><th>Lead</th><th>Status</th><th>First touch</th><th>Latest touch</th><th>First seen</th></tr></thead><tbody>' + rows + '</tbody></table></div><div id="touchHost"></div></div>';
      view.querySelectorAll('tr[data-lead]').forEach(function (tr) {
        tr.addEventListener('click', function () {
          api('/leads/' + tr.dataset.lead + '/attribution').then(function (a) {
            $('#touchHost').innerHTML = '<h3>Touch history for lead #' + tr.dataset.lead + '</h3><ul>' + a.touchpoints.map(function (t) {
              return '<li>' + esc(String(t.occurred_at).slice(0, 16).replace('T', ' ')) + ' · ' + esc(t.source || 'direct') + ' / ' + esc(t.campaign_name || '') + ' · ' + esc(t.landing_path || '') + '</li>';
            }).join('') + '</ul><p class="muted">Model: ' + esc(a.model) + '. Revenue is not shown here.</p>';
          }).catch(function (x) { toast(x.message); });
        });
      });
    });
  }

  function content() {
    return api('/content').then(function (d) {
      var rows = d.content.map(function (c) {
        return '<tr><td>' + esc(c.title) + '</td><td>' + esc(c.channel) + '</td><td>' + esc(c.status) + '</td><td>' + esc(String(c.created_at).slice(0, 10)) + '</td>' +
          '<td>' + (c.status === 'draft' ? '<button class="btn small" data-approve="' + c.id + '">Approve (owner)</button>' : '') + '</td></tr>';
      }).join('') || empty('No content drafts yet.');
      view.innerHTML =
        '<div class="card"><h2>New content draft</h2><form id="contentForm" class="form-grid">' +
        '<label>Title<input name="title" maxlength="180" required></label>' +
        '<label>Channel<input name="channel" maxlength="50" value="facebook"></label>' +
        '<label class="full">Body<textarea name="body" rows="4" maxlength="20000" required></textarea></label>' +
        '<div><button class="btn primary" type="submit">Save draft</button></div></form>' +
        '<p class="muted">Drafts are not published. Publishing to social accounts is not built.</p></div>' +
        '<div class="card"><h2>Content</h2><div class="table-wrap"><table><thead><tr><th>Title</th><th>Channel</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
      $('#contentForm').addEventListener('submit', function (e) {
        e.preventDefault(); var f = new FormData(e.target), body = {}; f.forEach(function (v, k) { body[k] = v; });
        api('/content', { method: 'POST', body: body }).then(function () { toast('Draft saved'); render(); }).catch(function (x) { toast(x.message); });
      });
      view.querySelectorAll('[data-approve]').forEach(function (b) {
        b.addEventListener('click', function () { api('/content/' + b.dataset.approve + '/approve', { method: 'POST', body: {} }).then(function () { toast('Approved. Nothing was published.'); render(); }).catch(function (x) { toast(x.message); }); });
      });
    });
  }

  function roi() {
    return api('/campaigns?limit=200').then(function (d) {
      var opts = d.campaigns.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
      view.innerHTML = '<div class="card"><h2>Performance and ROI</h2>' +
        (d.campaigns.length ? '<label>Campaign <select id="roiPick">' + opts + '</select></label><div id="roiOut"></div>' : '<p class="muted">Create a campaign first.</p>') +
        '<p><b>Revenue, cash collected, direct cost and gross profit are not reconciled yet.</b> This screen shows spend and lead counts only.</p></div>';
      var pick = $('#roiPick');
      if (pick) { pick.addEventListener('change', loadRoi); loadRoi(); }
    });
  }
  function loadRoi() {
    var id = $('#roiPick').value;
    api('/campaigns/' + id + '/metrics').then(function (m) {
      $('#roiOut').innerHTML = '<div class="grid three">' + card('Imported spend', money(m.spend), 'Provider import rows') + card('Attributed leads', m.attributed_leads, 'First-touch model') + card('Financials', 'Not reconciled', 'Revenue needs verified joins') + '</div>';
    }).catch(function (x) { toast(x.message); });
  }

  function settings() {
    return Promise.all([api('/connections'), api('/events/exceptions').catch(function () { return null; })]).then(function (r) {
      var conns = r[0].connections;
      var ex = r[1];
      view.innerHTML =
        '<div class="card"><h2>Provider connections</h2>' +
        (conns.length ? '<ul>' + conns.map(function (c) { return '<li>' + esc(c.provider) + ' · ' + esc(c.status) + '</li>'; }).join('') + '</ul>' : '<p>No ad or social accounts are connected. Connecting Google, Meta and Google Business Profile is not built yet.</p>') +
        '</div>' +
        '<div class="card"><h2>Unresolved lifecycle events</h2>' +
        (ex === null ? '<p class="muted">Owners only.</p>' : (ex.events.length ? '<p>' + ex.events.length + ' event(s) could not be linked to a lead. They are not attached to any lead.</p>' : '<p>None.</p>')) +
        '</div>';
    });
  }

  function card(label, value, note) {
    return '<div class="card kpi"><div class="kpi-label">' + esc(label) + '</div><div class="kpi-value">' + esc(value) + '</div><div class="muted">' + esc(note) + '</div></div>';
  }

  var renderers = {
    dashboard: dashboard, campaigns: campaigns, attribution: attribution, calendar: content, roi: roi, settings: settings,
    studio: function () { view.innerHTML = notBuilt('AI marketing studio', 'Copy generation is not connected. It will draft from approved service and service-area data and never publish on its own.'); },
    keywords: function () { view.innerHTML = notBuilt('Keyword intelligence', 'Needs a keyword-data provider account. No search-volume numbers are shown until one is connected.'); },
    publishing: function () { view.innerHTML = notBuilt('Social publishing', 'Needs approved provider apps and OAuth. Nothing is posted from here.'); },
    google: function () { view.innerHTML = notBuilt('Google Ads manager', 'Needs a Google Ads account, API approval and OAuth. Spend can be imported by hand in the meantime.'); },
    meta: function () { view.innerHTML = notBuilt('Meta Ads manager', 'Needs a Meta business app, app review and OAuth. Spend can be imported by hand in the meantime.'); },
    seo: function () { view.innerHTML = notBuilt('Local SEO and service areas', 'Needs Google Business Profile access. Service-area data is not yet connected.'); }
  };

  function render() {
    titleEl.textContent = labels[screen];
    document.querySelectorAll('#nav button').forEach(function (b) { b.classList.toggle('active', b.dataset.screen === screen); });
    view.innerHTML = '<div class="card muted">Loading…</div>';
    var out = renderers[screen]();
    if (out && out.catch) out.catch(notConnected);
  }

  $('#nav').addEventListener('click', function (e) {
    var b = e.target.closest('[data-screen]');
    if (b) { screen = b.dataset.screen; render(); }
  });
  $('#refresh').addEventListener('click', render);
  $('#create').addEventListener('click', function () { screen = 'campaigns'; render(); });
  render();
})();
