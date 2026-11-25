// Rend l'app installable. Réseau d'abord (toujours la dernière version), cache en secours sans réseau.
const CACHE = 'pk-moves';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  // Supabase (données, vidéos) et le CDN ne passent pas par ici
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // no-cache : redemande toujours au serveur (GitHub Pages fait garder les fichiers 10 min sinon)
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request)));
});

// notifs envoyées par l'Edge Function « push » : { title, body, url }
self.addEventListener('push', e => {
  const m = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(m.title || 'PK Moves', { body: m.body || '', icon: 'icon-192.png', data: m.url || './', tag: m.url }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data, self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const win = list.find(c => c.url.startsWith(self.registration.scope));
    return win ? win.focus().then(c => c.navigate(url)) : clients.openWindow(url);
  }));
});
