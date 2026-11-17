// Lets the crew page open with no signal. Only the page itself and its script are kept; live data always comes from the server
// (the page saves today's jobs on the phone and sends queued changes itself).
const SHELL = 'bc-crew-shell-v3';
const SHELL_FILES = ['/crew.html', '/assets/crew-page.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Opening a crew link: use the network and keep a copy; with no signal, serve the saved page.
  if (event.request.mode === 'navigate' && url.pathname.startsWith('/crew/')) {
    event.respondWith(
      fetch(event.request)
        .then(res => { if (res.ok) caches.open(SHELL).then(c => c.put('/crew.html', res.clone())).catch(() => {}); return res; })
        .catch(() => caches.match('/crew.html'))
    );
    return;
  }

  // The page script: network first, saved copy when offline.
  if (SHELL_FILES.includes(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then(res => { if (res.ok) caches.open(SHELL).then(c => c.put(url.pathname, res.clone())).catch(() => {}); return res; })
        .catch(() => caches.match(url.pathname))
    );
  }
});
