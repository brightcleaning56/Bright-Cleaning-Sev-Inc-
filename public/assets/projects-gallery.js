// Projects page: one card per project (photos with the same title are one project). The project name opens
// /project.html?p=... which shows every photo for that project. If the server is unreachable or nothing is set up,
// the built-in gallery and video on the page stay as they are.
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
      // Group by project name (the photo title), keeping the admin's order.
      var order = [], byName = {};
      d.gallery.forEach(function (g) {
        var name = g.title || 'Project';
        if (!byName[name]) { byName[name] = []; order.push(name); }
        byName[name].push(g);
      });
      // A photo that fails to load is removed from the grid, as the built-in gallery does.
      grid.addEventListener('error', function (e) { var a = e.target && e.target.closest && e.target.closest('article'); if (a) a.remove(); }, true);
      grid.innerHTML = order.map(function (name) {
        var items = byName[name], cover = items[0], link = '/project.html?p=' + encodeURIComponent(name), n = items.length;
        var media = cover.kind === 'video'
          ? '<video controls playsinline preload="metadata"' + (cover.poster ? ' poster="' + esc(cover.poster) + '"' : '') + ' style="width:100%;display:block;border-radius:12px 12px 0 0;aspect-ratio:4/3;object-fit:cover;background:#10263e"><source src="' + esc(cover.url) + '" type="' + typeOf(cover.url) + '"></video>'
          : '<a href="' + link + '"><img src="' + esc(cover.url) + '" alt="' + esc(cover.alt || name) + '" loading="lazy"></a>';
        return '<article class="project">' + media + '<div><h3><a href="' + link + '">' + esc(name) + '</a></h3>' +
          (cover.location ? '<p>' + esc(cover.location) + '</p>' : '') +
          '<p><a href="' + link + '">View all ' + n + ' photo' + (n === 1 ? '' : 's') + ' &rarr;</a></p></div></article>';
      }).join('');
    }
  }).catch(function () { /* keep the built-in gallery */ });
})();
