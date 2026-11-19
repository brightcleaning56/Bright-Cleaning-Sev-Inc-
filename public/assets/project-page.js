// Project page: shows every photo for one project (the photos that share the project name). The name comes from ?p=...
(function () {
  var name = new URLSearchParams(location.search).get('p') || '';
  var title = document.getElementById('pTitle'), loc = document.getElementById('pLoc'), grid = document.getElementById('pGrid');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
  function typeOf(url) { var m = /\.([a-z0-9]+)$/i.exec(url || ''); return TYPES[(m && m[1] || '').toLowerCase()] || 'video/mp4'; }
  fetch('/api/site/gallery', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    var items = ((d && d.gallery) || []).filter(function (g) { return (g.title || '') === name; });
    if (!name || !items.length) {
      title.textContent = 'Project not found';
      grid.innerHTML = '<p>That project is not listed. <a href="/projects.html">See all projects</a>.</p>';
      return;
    }
    title.textContent = name;
    document.title = name + ' | Bright Cleaning Sev Inc.';
    if (items[0].location) loc.textContent = items[0].location;
    grid.innerHTML = items.map(function (g) {
      return g.kind === 'video'
        ? '<figure><video controls playsinline preload="metadata"' + (g.poster ? ' poster="' + esc(g.poster) + '"' : '') + '><source src="' + esc(g.url) + '" type="' + typeOf(g.url) + '"></video></figure>'
        : '<figure><a href="' + esc(g.url) + '" target="_blank" rel="noopener"><img src="' + esc(g.url) + '" alt="' + esc(g.alt || name) + '" loading="lazy"></a></figure>';
    }).join('');
  }).catch(function () {
    title.textContent = 'Project photos';
    grid.innerHTML = '<p>The photos are not available right now. Please try again later.</p>';
  });
})();
