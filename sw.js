// Offline support: the app shell plus the MediaPipe runtime and pose model are
// cached so the alarm still works at 7am with no network.

const VERSION = 'v2';
const SHELL_CACHE = `squatclock-shell-${VERSION}`;
const RUNTIME_CACHE = 'squatclock-runtime';

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'audio.js',
  'squat.js',
  'store.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];

// Keep in sync with MP_VERSION / MP_MODEL in squat.js.
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const REMOTE = [
  `${MP}/vision_bundle.mjs`,
  `${MP}/wasm/vision_wasm_internal.js`,
  `${MP}/wasm/vision_wasm_internal.wasm`,
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
];
const REMOTE_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
    // Best effort: a flaky network shouldn't block installing the app.
    const runtime = await caches.open(RUNTIME_CACHE);
    await Promise.allSettled(REMOTE.map(async (url) => {
      if (await runtime.match(url)) return;
      const res = await fetch(url, { mode: 'cors' });
      if (res.ok) await runtime.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('squatclock-shell-') && k !== SHELL_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Versioned third-party files never change: cache first.
  if (REMOTE_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const hit = await cache.match(request.url);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) cache.put(request.url, res.clone());
      return res;
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // App shell: serve from cache instantly, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const key = request.mode === 'navigate' ? 'index.html' : request;
    const hit = await cache.match(key, { ignoreSearch: true });
    // no-cache: revalidate with the server instead of reusing a stale HTTP-cache copy.
    const refresh = fetch(request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) cache.put(key, res.clone());
        return res;
      })
      .catch(() => null);
    if (hit) {
      event.waitUntil(refresh);
      return hit;
    }
    return (await refresh) || new Response('Offline', { status: 503 });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all[0];
    if (client) {
      await client.focus();
      client.postMessage({ type: 'notification-click' });
    } else {
      await self.clients.openWindow('./');
    }
  })());
});
