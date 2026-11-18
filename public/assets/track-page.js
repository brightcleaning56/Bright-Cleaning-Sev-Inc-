(function () {
  var token = location.pathname.split('/').filter(Boolean).pop() || '';
  var out = document.getElementById('out');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function dateLine(j) {
    var d = j.date ? new Date(j.date + 'T12:00:00') : null;
    var day = d && !isNaN(d) ? d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) : j.date;
    return day + (j.start_time ? ' · ' + j.start_time + (j.end_time ? '–' + j.end_time : '') : '');
  }
  function pillClass(s) { return s === 'Done' ? 'done' : s === 'Cancelled' ? 'cancel' : (s === 'In progress' || s === 'On the way') ? 'live' : ''; }
  function render(j) {
    var steps = j.steps.map(function (s) {
      var on = !!s.at;
      return '<li class="' + (on ? 'on' : '') + '"><span class="dot"></span><div><b>' + esc(s.label) + '</b><small>' + (on ? esc(when(s.at)) : 'Not yet') + '</small></div></li>';
    }).join('');
    var photos = j.photos.length
      ? '<div class="card"><b>Photos</b><div class="photos">' + j.photos.map(function (p) { return '<a href="' + esc(p.url) + '" target="_blank" rel="noopener"><img src="' + esc(p.url) + '" alt="' + esc(p.title) + '" loading="lazy"></a>'; }).join('') + '</div></div>'
      : '';
    out.innerHTML =
      '<div class="card"><h1>' + esc(j.title) + '</h1>' +
      '<div class="pill ' + pillClass(j.status) + '">' + esc(j.status) + '</div>' +
      '<div class="muted">' + esc(dateLine(j)) + '</div>' +
      (j.address ? '<div class="muted">' + esc(j.address) + '</div>' : '') +
      (j.crew_count ? '<div class="muted" style="margin-top:6px">Crew on the job: ' + j.crew_count + '</div>' : '') +
      '</div>' +
      '<div class="card"><b>Progress</b><ol class="steps">' + steps + '</ol></div>' + photos +
      '<p class="muted" style="text-align:center;margin-top:16px">This page updates as the job moves along. Questions? Call or email Bright Cleaning Sev Inc.</p>';
  }
  function load() {
    fetch('/api/track/' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (!x.ok) throw new Error(x.j.error || 'This link is not valid.'); render(x.j); })
      .catch(function (e) { out.innerHTML = '<div class="msg">' + esc(e.message || 'This link is not valid.') + '</div>'; });
  }
  load();
  setInterval(load, 60000);
})();
