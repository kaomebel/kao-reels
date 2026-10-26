// Ilova fayllarini keshlaydi — internet bo'lmasa ham dastur ochiladi.
// Fayllar o'zgarganda CACHE versiyasini oshiring.
const CACHE = 'biznes-tizim-v3';
const FILES = ['./', './index.html', './styles.css', './config.js', './vendor/supabase.js', './icons.js', './backend.js', './app.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Avval tarmoqdan (yangi versiya bo'lsa olinadi), bo'lmasa keshdan
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))),
  );
});
