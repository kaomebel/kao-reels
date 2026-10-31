// Ilova fayllarini keshlaydi — internet bo'lmasa ham dastur ochiladi.
// Saytga joylashda scripts/build-web.js CACHE nomiga versiyani yozadi, shuning uchun
// har bir yangi versiyada bu fayl o'zgaradi va telefon yangilanishni sezadi.
const CACHE = 'biznes-tizim-2026.10.31-1434-dbafe03';
const FILES = ['./', './index.html', './styles.css', './config.js', './vendor/supabase.js', './vendor/qrcode.js', './vendor/jsbarcode.min.js', './icons.js', './backend.js', './app.js', './version.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  // no-cache: telefonning HTTP keshidagi eski nusxalar emas, serverdagi yangilari olinsin
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(FILES.map((f) => fetch(f, { cache: 'no-cache' }).then((r) => (r.ok ? c.put(f, r) : null)).catch(() => null))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Avval tarmoqdan (yangi versiya bo'lsa olinadi), internet bo'lmasa — keshdan
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
