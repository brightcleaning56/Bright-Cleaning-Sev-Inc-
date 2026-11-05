// Projects page: shows the photos and page video managed in the admin (Website). If the server is unreachable or
// nothing is set up, the built-in gallery and video on the page stay as they are.
(function () {
  var grid = document.getElementById('galleryGrid'), vid = document.getElementById('pageVideo');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
  function typeOf(url) { var m = /\.([a-z0-9]+)$/i.exec(url || ''); return TYPES[(m && m[1] || '').toLowerCase()] || 'video/mp4'; }
  fetch('/api/site/gallery', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d) return;
    if (vid && d.hero && d.hero.url) {
      vid.innerHTML = '<source src="' + esc(d.hero.url) + '" type="' + typeOf(d.hero.url) + '">';
      if (d.hero.poster) vid.setAttribute('poster', d.hero.poster);
      vid.load();
    }
    if (grid && d.gallery && d.gallery.length) {
      // A photo that fails to load is removed from the grid, as the built-in gallery does.
      grid.addEventListener('error', function (e) { var a = e.target && e.target.closest && e.target.closest('article'); if (a) a.remove(); }, true);
      grid.innerHTML = d.gallery.map(function (g) {
        var media = g.kind === 'video'
          ? '<video controls playsinline preload="metadata"' + (g.poster ? ' poster="' + esc(g.poster) + '"' : '') + ' style="width:100%;display:block;border-radius:12px 12px 0 0;aspect-ratio:4/3;object-fit:cover;background:#10263e"><source src="' + esc(g.url) + '" type="' + typeOf(g.url) + '"></video>'
          : '<img src="' + esc(g.url) + '" alt="' + esc(g.alt || g.title) + '" loading="lazy">';
        return '<article class="project">' + media + '<div><h3>' + esc(g.title) + '</h3>' + (g.location ? '<p>' + esc(g.location) + '</p>' : '') + '</div></article>';
      }).join('');
    }
  }).catch(function () { /* keep the built-in gallery */ });
})();
