/**
 * AgentScope service worker (01-architecture.yaml deployment offline_mechanics).
 *
 * This is a template: the build (scripts/vite-offline.ts) writes dist/sw.js as
 * `const PRECACHE = <asset manifest>;` followed by this file, so every build that
 * changes a file also changes the worker. PRECACHE is { version, hash, files },
 * with files relative to the base path ('' is the base URL itself).
 */
/* global PRECACHE */

const PREFIX = `agentscope:${self.registration.scope}:`;
const CACHE = `${PREFIX}${PRECACHE.version}:${PRECACHE.hash}`;
const URLS = ['', ...PRECACHE.files].map((file) => new URL(file, self.registration.scope).href);
const PRECACHED = new Set(URLS);
const INDEX = new URL('index.html', self.registration.scope).href;
// Mirrored in src/app/offline.ts.
const STATUS_MESSAGE = 'agentscope:offline-status';

/** Fetches every file past the HTTP cache; any failure fails the install. */
async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    URLS.map(async (url) => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok) throw new Error(`Precache failed: ${url} returned ${response.status}`);
      await cache.put(url, response);
    }),
  );
}

/** Deletes this app's caches for this scope except the current one. */
async function cleanup() {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(PREFIX) && name !== CACHE)
      .map((name) => caches.delete(name)),
  );
}

/** Whether every precached URL is in the current cache. */
async function complete() {
  if (!(await caches.has(CACHE))) return false;
  const cache = await caches.open(CACHE);
  const hits = await Promise.all(URLS.map((url) => cache.match(url)));
  return hits.every(Boolean);
}

/** The cache key for a request, or undefined when the worker leaves it to the network. */
function cacheKey(request) {
  if (request.method !== 'GET') return undefined;
  const url = new URL(request.url);
  url.hash = '';
  // Hash routes all load the same page.
  if (request.mode === 'navigate' && url.search === '' && url.href === INDEX) {
    return self.registration.scope;
  }
  return PRECACHED.has(url.href) ? url.href : undefined;
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(cleanup().then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const key = cacheKey(event.request);
  if (key === undefined) return;
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(key))
      .then((cached) => cached ?? fetch(event.request)),
  );
});

self.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (event.data?.type !== STATUS_MESSAGE || !port) return;
  event.waitUntil(
    complete().then(
      (ready) => port.postMessage({ type: STATUS_MESSAGE, ready, version: PRECACHE.version }),
      () => port.postMessage({ type: STATUS_MESSAGE, ready: false, version: PRECACHE.version }),
    ),
  );
});
