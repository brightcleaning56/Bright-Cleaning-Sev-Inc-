// Records which campaign brought a visitor to the bid and contact forms.
// It reads UTM parameters and a campaign_id from the page URL, and adds one hidden field (attr_json) to each form.
// The server checks every value and keeps only what it needs. No click IDs (gclid, fbclid) are read or stored.
// Visitors with Do Not Track switched on are not tracked.
(function () {
  'use strict';
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;

  function pageTouch() {
    var p = new URLSearchParams(location.search);
    var t = {};
    UTM.forEach(function (k) { var v = p.get(k); if (v) t[k] = v.slice(0, 200); });
    var c = p.get('campaign_id');
    if (c && /^\d{1,9}$/.test(c)) t.campaign_id = Number(c);
    t.landing_path = location.pathname;
    t.referrer = document.referrer || '';
    return t;
  }
  function hasCampaign(t) {
    return !!(t.utm_source || t.utm_campaign || t.utm_medium || t.campaign_id);
  }
  // First campaign touch seen in this browser session (kept in session storage; the server stores only the first touch it receives for a lead).
  function firstTouch(now) {
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('bc_first_touch') || 'null'); } catch (e) { saved = null; }
    if (!saved && hasCampaign(now)) {
      saved = now;
      try { sessionStorage.setItem('bc_first_touch', JSON.stringify(saved)); } catch (e) { /* storage blocked: first touch is the current page */ }
    }
    return saved;
  }

  var now = pageTouch();
  var first = firstTouch(now);

  function attach() {
    ['bidForm', 'contactForm'].forEach(function (id) {
      var form = document.getElementById(id);
      if (!form) return;
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'attr_json';
      input.value = JSON.stringify(Object.assign({}, now, { first: first || null }));
      form.appendChild(input);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach); else attach();
})();
