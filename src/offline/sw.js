/**
 * AgentScope service worker (01-architecture.yaml deployment offline_mechanics).
 *
 * This is a template: the build (scripts/vite-offline.ts) writes dist/sw.js as
 * `const PRECACHE = <asset manifest>;` followed by this file, so every build that
 * changes a file also changes the worker. PRECACHE is { version, hash, files }, each
 * file { path, integrity } with the path relative to the base path.
 */
/* global PRECACHE */

const SCOPE = self.registration.scope;
const PREFIX = `agentscope:${SCOPE}:`;
const CACHE = `${PREFIX}${PRECACHE.version}:${PRECACHE.hash}`;
const INDEX = new URL('index.html', SCOPE).href;
/** Every URL to precache with its integrity digest; the base URL serves index.html. */
const ENTRIES = PRECACHE.files.map((file) => ({
  url: new URL(file.path, SCOPE).href,
  integrity: file.integrity,
}));
const INDEX_ENTRY = ENTRIES.find((entry) => entry.url === INDEX);
if (INDEX_ENTRY) ENTRIES.unshift({ url: SCOPE, integrity: INDEX_ENTRY.integrity });
const PRECACHED = new Set(ENTRIES.map((entry) => entry.url));
// Mirrored in src/app/offline.ts.
const STATUS_MESSAGE = 'agentscope:offline-status';

/**
 * Fetches every file past the HTTP cache with its integrity digest. Any failure, or a
 * stale file whose bytes do not match, fails the install; the browser retries at its
 * next update check.
 */
async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    ENTRIES.map(async ({ url, integrity }) => {
      const response = await fetch(new Request(url, { cache: 'reload', integrity }));
      if (!response.ok) throw new Error(`Precache failed: ${url} returned ${response.status}`);
      // Navigations refuse redirected responses: store a plain copy.
      const stored = response.redirected
        ? new Response(await response.blob(), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        : response;
      await cache.put(url, stored);
    }),
  );
}

/** This scope's caches other than the current one, newest first (Cache Storage keeps creation order). */
async function previousCaches() {
  const names = await caches.keys();
  return names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).reverse();
}

/**
 * Deletes this scope's caches except the current one and the newest previous one,
 * which a tab still running the previous build may need.
 */
async function cleanup() {
  const [, ...older] = await previousCaches();
  await Promise.all(older.map((name) => caches.delete(name)));
}

/** Whether every precached URL is in the current cache. */
async function complete() {
  const hits = await Promise.all(ENTRIES.map(({ url }) => caches.match(url, { cacheName: CACHE })));
  return hits.every(Boolean);
}

/**
 * The cache key for a GET request in the scope, or undefined when the worker leaves the
 * request to the network untouched (other methods, other origins, outside the scope).
 */
function cacheKey(request) {
  if (request.method !== 'GET') return undefined;
  const url = new URL(request.url);
  url.hash = '';
  if (!url.href.startsWith(SCOPE)) return undefined;
  // Hash routes all load the same page.
  if (request.mode === 'navigate' && url.search === '' && url.href === INDEX) return SCOPE;
  return url.href;
}

/** The current cache for precached URLs, then this scope's other caches, newest first. */
async function cached(key) {
  if (PRECACHED.has(key)) {
    const hit = await caches.match(key, { cacheName: CACHE });
    if (hit) return hit;
  }
  for (const cacheName of await previousCaches()) {
    const hit = await caches.match(key, { cacheName });
    if (hit) return hit;
  }
  return undefined;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precache().then(
      () => self.skipWaiting(),
      // Leave no partial cache behind; the install fails and is retried later.
      (error) =>
        caches.delete(CACHE).then(() => {
          throw error;
        }),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(cleanup().then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const key = cacheKey(event.request);
  if (key === undefined) return;
  event.respondWith(cached(key).then((response) => response ?? fetch(event.request)));
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
