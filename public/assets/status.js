(function () {
  var el = function (id) { return document.getElementById(id); };
  function fmtUp(s) { if (s == null) return '—'; var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + h + 'h ' + m + 'm'; }
  function show(ok, label, color) { el('state').textContent = label; el('dot').style.background = color; }
  function check() {
    fetch('/api/health', { cache: 'no-store' }).then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (x) {
        var j = x.j || {};
        if (x.status === 200 && j.ok && j.db === 'ok') show(true, 'All systems running', 'var(--green)');
        else show(false, 'Some parts are not running', 'var(--red)');
        el('db').textContent = j.db === 'ok' ? 'OK' : (j.db || 'Not responding');
        el('up').textContent = fmtUp(j.uptime_s);
        el('ver').textContent = j.version ? j.version + ' (build ' + j.build + ')' : '—';
        el('err').textContent = j.errors_1h == null ? '—' : String(j.errors_1h);
        el('checked').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      })
      .catch(function () { show(false, 'Cannot reach the system right now', 'var(--red)'); el('checked').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); });
  }
  check(); setInterval(check, 60000);
})();
