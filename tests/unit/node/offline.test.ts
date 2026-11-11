// The build-generated asset manifest and the service worker (01-architecture.yaml
// deployment offline_mechanics). The worker runs in a VM with a fake Cache Storage and
// network, so install, cleanup, serving and readiness are checked without a browser.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BuiltFile,
  integrity,
  precacheManifest,
  readBuild,
  serviceWorkerSource,
} from '../../../scripts/vite-offline.ts';
import { STATUS_MESSAGE } from '../../../src/app/offline.ts';

const TEMPLATE = readFileSync(join(import.meta.dirname, '../../../src/offline/sw.js'), 'utf8');
const SCOPE = 'https://example.test/agentscope/';
const file = (path: string, text = path): BuiltFile => ({
  path,
  content: new TextEncoder().encode(text),
});

describe('precacheManifest', () => {
  const build = [
    file('index.html'),
    file('sw.js'),
    file('assets/index-a.js'),
    file('asset-manifest.json'),
    file('licenses/fonts.txt'),
  ];

  it('lists every built file except the generated ones, sorted, with the version', () => {
    const manifest = precacheManifest(build, 'abc123');
    expect(manifest.version).toBe('abc123');
    expect(manifest.files.map((f) => f.path)).toEqual([
      'assets/index-a.js',
      'index.html',
      'licenses/fonts.txt',
    ]);
    expect(manifest.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives each file its Subresource Integrity digest', () => {
    const manifest = precacheManifest(build, 'v');
    // sha256 of the bytes "index.html", base64: the digest a browser checks.
    expect(manifest.files.find((f) => f.path === 'index.html')?.integrity).toBe(
      'sha256-DrVHMEZYgFqteI0yDxC/Hyknl7Xm10Wjv2F1hNoBcFE=',
    );
    for (const f of manifest.files) expect(f.integrity).toBe(integrity(file(f.path).content));
  });

  it('hashes content: the same files give the same hash, any change a new one', () => {
    const hash = precacheManifest(build, 'v').hash;
    expect(precacheManifest([...build].reverse(), 'v').hash).toBe(hash);
    expect(precacheManifest([...build, file('assets/new.css')], 'v').hash).not.toBe(hash);
    expect(
      precacheManifest(
        build.map((f) => (f.path === 'index.html' ? file('index.html', 'changed') : f)),
        'v',
      ).hash,
    ).not.toBe(hash);
    // The worker template feeds the hash: a changed worker gets a new cache.
    expect(precacheManifest(build, 'v', 'template a').hash).not.toBe(
      precacheManifest(build, 'v', 'template b').hash,
    );
    // The generated files do not feed the hash.
    expect(
      precacheManifest(
        build.map((f) => (f.path === 'sw.js' ? file('sw.js', 'other') : f)),
        'v',
      ).hash,
    ).toBe(hash);
  });
});

describe('readBuild', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads nested files with POSIX paths relative to the build directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'agentscope-dist-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<html>');
    writeFileSync(join(dir, 'assets', 'a.js'), 'x');
    const files = readBuild(dir).map((f) => [f.path, new TextDecoder().decode(f.content)]);
    expect(files.sort()).toEqual([
      ['assets/a.js', 'x'],
      ['index.html', '<html>'],
    ]);
  });
});

it('the page and the worker use the same status message', () => {
  expect(TEMPLATE).toContain(`const STATUS_MESSAGE = '${STATUS_MESSAGE}';`);
});

// --- The worker in a VM -------------------------------------------------------------

class FakeCache {
  readonly entries = new Map<string, Response>();
  async put(key: string, response: Response) {
    this.entries.set(key, response);
  }
  /** Like the real Cache, every match is a fresh copy. */
  async match(key: string) {
    return this.entries.get(key)?.clone();
  }
}

/** Keeps creation order, as the real Cache Storage does. */
class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name) as FakeCache;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async has(name: string) {
    return this.stores.has(name);
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  /** Never creates the named cache. */
  async match(key: string, options: { cacheName: string }) {
    return this.stores.get(options.cacheName)?.match(key);
  }
}

type FakeRequest = {
  url: string;
  method: string;
  mode: string;
  cache: string;
  integrity: string;
};
type Listener = (event: unknown) => void;

const BUILD = [file('index.html'), file('assets/index-a.js'), file('licenses/fonts.txt')];

/**
 * Starts the generated worker. The fake network answers with the build's bytes (the
 * base URL with index.html's), except for `stale` (other bytes), `missing` (404) and
 * `redirected`; like a browser, it rejects bytes that do not match the request's integrity.
 */
function startWorker(options: { missing?: string; stale?: string; redirected?: string } = {}) {
  const manifest = precacheManifest(BUILD, 'v1');
  const listeners = new Map<string, Listener>();
  const caches = new FakeCacheStorage();
  const fetched: FakeRequest[] = [];
  const state = { skipped: false, claimed: false };
  const matches = (url: string, path: string | undefined) => !!path && url.endsWith(path);
  const sandbox = {
    URL,
    Set,
    Promise,
    Error,
    Response,
    caches,
    Request: class {
      readonly url: string;
      readonly method = 'GET';
      readonly mode = 'cors';
      readonly cache: string;
      readonly integrity: string;
      constructor(url: string, init: { cache?: string; integrity?: string } = {}) {
        this.url = url;
        this.cache = init.cache ?? 'default';
        this.integrity = init.integrity ?? '';
      }
    },
    fetch: async (request: FakeRequest) => {
      fetched.push(request);
      if (matches(request.url, options.missing)) return new Response('', { status: 404 });
      const text = matches(request.url, options.stale)
        ? 'stale'
        : request.url.slice(SCOPE.length) || 'index.html';
      const bytes = new TextEncoder().encode(text);
      if (request.integrity && request.integrity !== integrity(bytes)) {
        throw new TypeError(`Failed to fetch: integrity mismatch for ${request.url}`);
      }
      const response = new Response(bytes, { status: 200 });
      if (matches(request.url, options.redirected)) {
        Object.defineProperty(response, 'redirected', { value: true });
      }
      return response;
    },
    self: {
      registration: { scope: SCOPE },
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      skipWaiting: async () => {
        state.skipped = true;
      },
      clients: {
        claim: async () => {
          state.claimed = true;
        },
      },
    },
  };
  runInNewContext(serviceWorkerSource(manifest, TEMPLATE), sandbox);
  const cacheName = `agentscope:${SCOPE}:v1:${manifest.hash}`;

  /** Dispatches an extendable event and waits for what it extended. */
  async function dispatch(type: string, extra: object = {}) {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    const event = {
      ...extra,
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      respondWith: (p: Promise<Response>) => (response = p),
    };
    listeners.get(type)?.(event);
    await Promise.all(pending);
    return response;
  }

  const request = (url: string, init: Partial<FakeRequest> = {}): FakeRequest => ({
    url: new URL(url, SCOPE).href,
    method: 'GET',
    mode: 'cors',
    cache: 'default',
    integrity: '',
    ...init,
  });

  /** The body the worker answers with, or undefined when it leaves the request alone. */
  async function served(req: FakeRequest): Promise<string | undefined> {
    const response = await dispatch('fetch', { request: req });
    return response && (await (await response).text());
  }

  async function status(): Promise<unknown> {
    let reply: unknown;
    const port = { postMessage: (message: unknown) => (reply = message) };
    await dispatch('message', { data: { type: STATUS_MESSAGE }, ports: [port] });
    return reply;
  }

  const digest = (path: string) => manifest.files.find((f) => f.path === path)?.integrity;

  return { caches, fetched, state, cacheName, dispatch, request, served, status, digest };
}

describe('service worker', () => {
  it('install fetches the base URL and every file past the HTTP cache, with digests', async () => {
    const worker = startWorker();
    await worker.dispatch('install');
    expect(worker.fetched.map((r) => [r.url, r.cache, r.integrity])).toEqual([
      [SCOPE, 'reload', worker.digest('index.html')],
      [`${SCOPE}assets/index-a.js`, 'reload', worker.digest('assets/index-a.js')],
      [`${SCOPE}index.html`, 'reload', worker.digest('index.html')],
      [`${SCOPE}licenses/fonts.txt`, 'reload', worker.digest('licenses/fonts.txt')],
    ]);
    expect([...(await worker.caches.open(worker.cacheName)).entries.keys()].sort()).toEqual(
      [SCOPE, ...BUILD.map((f) => `${SCOPE}${f.path}`)].sort(),
    );
    expect(worker.state.skipped).toBe(true);
  });

  it('a file that fails to load fails the install and leaves no cache', async () => {
    const worker = startWorker({ missing: 'licenses/fonts.txt' });
    await expect(worker.dispatch('install')).rejects.toThrow(
      `Precache failed: ${SCOPE}licenses/fonts.txt returned 404`,
    );
    expect(worker.state.skipped).toBe(false);
    expect(await worker.caches.keys()).toEqual([]);
  });

  it('a stale file whose bytes do not match its digest fails the install', async () => {
    const worker = startWorker({ stale: 'assets/index-a.js' });
    await expect(worker.dispatch('install')).rejects.toThrow('integrity mismatch');
    expect(worker.state.skipped).toBe(false);
    expect(await worker.caches.keys()).toEqual([]);
  });

  it('stores a redirected response as a plain one with the same body', async () => {
    const worker = startWorker({ redirected: 'index.html' });
    await worker.dispatch('install');
    const cache = await worker.caches.open(worker.cacheName);
    const stored = await cache.match(`${SCOPE}index.html`);
    expect(stored?.redirected).toBe(false);
    expect(await stored?.text()).toBe('index.html');
  });

  it('activation keeps the current and the newest previous cache of this scope only', async () => {
    const worker = startWorker();
    const others = [
      'another-app',
      'agentscope:https://example.test/other/:v0:0000',
      'agentscope:https://example.test/agentscope/x/:v0:0000',
    ];
    // Created before this build's cache, oldest first.
    for (const name of [
      `agentscope:${SCOPE}:v-2:2222`,
      ...others,
      `agentscope:${SCOPE}:v-1:1111`,
      `agentscope:${SCOPE}:v0:0000`,
    ]) {
      await worker.caches.open(name);
    }
    await worker.dispatch('install');
    await worker.dispatch('activate');
    expect((await worker.caches.keys()).sort()).toEqual(
      [...others, `agentscope:${SCOPE}:v0:0000`, worker.cacheName].sort(),
    );
    expect(worker.state.claimed).toBe(true);
  });

  it('serves precached files and navigations to the page from the cache', async () => {
    const worker = startWorker();
    await worker.dispatch('install');
    worker.fetched.length = 0;
    expect(await worker.served(worker.request('assets/index-a.js'))).toBe('assets/index-a.js');
    expect(
      await worker.served(
        worker.request('assets/index-a.js', { cache: 'only-if-cached', mode: 'same-origin' }),
      ),
    ).toBe('assets/index-a.js');
    for (const url of ['', '#/rag/rag-query/3', 'index.html#/mcp']) {
      expect(await worker.served(worker.request(url, { mode: 'navigate' })), url).toBe(
        'index.html',
      );
    }
    expect(worker.fetched).toEqual([]);
  });

  it('serves a file of a previous build from this scope’s caches, newest first', async () => {
    const worker = startWorker();
    const put = async (cacheName: string, path: string, body: string) =>
      (await worker.caches.open(cacheName)).put(`${SCOPE}${path}`, new Response(body));
    await put(`agentscope:${SCOPE}:v-1:1111`, 'assets/specimen-old.js', 'older');
    await put(`agentscope:${SCOPE}:v0:0000`, 'assets/specimen-old.js', 'previous');
    await put('another-app', 'assets/only-elsewhere.js', 'not ours');
    await worker.dispatch('install');
    worker.fetched.length = 0;
    expect(await worker.served(worker.request('assets/specimen-old.js'))).toBe('previous');
    expect(worker.fetched).toEqual([]);
    // Other apps' caches are never read: this request goes to the network.
    await worker.served(worker.request('assets/only-elsewhere.js'));
    expect(worker.fetched.map((r) => r.url)).toEqual([`${SCOPE}assets/only-elsewhere.js`]);
  });

  it('sends misses in the scope to the network and leaves everything else alone', async () => {
    const worker = startWorker();
    await worker.dispatch('install');
    worker.fetched.length = 0;
    expect(await worker.served(worker.request('assets/index-a.js?v=2'))).toBe(
      'assets/index-a.js?v=2',
    );
    expect(worker.fetched.map((r) => r.url)).toEqual([`${SCOPE}assets/index-a.js?v=2`]);
    for (const request of [
      worker.request('assets/index-a.js', { method: 'POST' }),
      worker.request('https://example.test/other/index.html'),
      worker.request('https://elsewhere.test/agentscope/index.html'),
      worker.request('assets/index-a.js', { cache: 'only-if-cached', mode: 'no-cors' }),
    ]) {
      expect(await worker.dispatch('fetch', { request }), request.url).toBeUndefined();
    }
  });

  it('falls back to the network when a precached file is missing from the cache', async () => {
    const worker = startWorker();
    await worker.dispatch('install');
    (await worker.caches.open(worker.cacheName)).entries.delete(`${SCOPE}index.html`);
    worker.fetched.length = 0;
    expect(await worker.served(worker.request('index.html'))).toBe('index.html');
    expect(worker.fetched.map((r) => r.url)).toEqual([`${SCOPE}index.html`]);
  });

  it('confirms readiness only while every listed file is cached', async () => {
    const worker = startWorker();
    expect(await worker.status()).toEqual({ type: STATUS_MESSAGE, ready: false, version: 'v1' });
    await worker.dispatch('install');
    expect(await worker.status()).toEqual({ type: STATUS_MESSAGE, ready: true, version: 'v1' });
    (await worker.caches.open(worker.cacheName)).entries.delete(`${SCOPE}assets/index-a.js`);
    expect(await worker.status()).toEqual({ type: STATUS_MESSAGE, ready: false, version: 'v1' });
  });
});
