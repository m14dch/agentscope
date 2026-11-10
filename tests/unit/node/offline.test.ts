// The build-generated asset manifest and the service worker (01-architecture.yaml
// deployment offline_mechanics). The worker runs in a VM with a fake Cache Storage,
// so install, cleanup, serving and readiness are checked without a browser.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BuiltFile,
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
    expect(manifest.files).toEqual(['assets/index-a.js', 'index.html', 'licenses/fonts.txt']);
    expect(manifest.hash).toMatch(/^[0-9a-f]{16}$/);
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
}

type FakeRequest = { url: string; method: string; mode: string; cache: string };
type Listener = (event: unknown) => void;

function startWorker(options: { missing?: string } = {}) {
  const manifest = precacheManifest(
    [file('index.html'), file('assets/index-a.js'), file('licenses/fonts.txt')],
    'v1',
  );
  const listeners = new Map<string, Listener>();
  const caches = new FakeCacheStorage();
  const fetched: FakeRequest[] = [];
  const state = { skipped: false, claimed: false };
  const sandbox = {
    URL,
    Set,
    Promise,
    Error,
    caches,
    Request: class {
      readonly url: string;
      readonly method = 'GET';
      readonly mode = 'cors';
      readonly cache: string;
      constructor(url: string, init: { cache?: string } = {}) {
        this.url = url;
        this.cache = init.cache ?? 'default';
      }
    },
    fetch: async (request: FakeRequest) => {
      fetched.push(request);
      const missing = options.missing && request.url.endsWith(options.missing);
      return new Response(`network ${request.url}`, { status: missing ? 404 : 200 });
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
    ...init,
  });

  async function status(): Promise<unknown> {
    let reply: unknown;
    const port = { postMessage: (message: unknown) => (reply = message) };
    await dispatch('message', { data: { type: STATUS_MESSAGE }, ports: [port] });
    return reply;
  }

  return { caches, fetched, state, cacheName, dispatch, request, status };
}

describe('service worker', () => {
  it('install fetches the base URL and every listed file past the HTTP cache', async () => {
    const worker = startWorker();
    await worker.dispatch('install');
    const urls = ['', 'assets/index-a.js', 'index.html', 'licenses/fonts.txt'].map(
      (path) => new URL(path, SCOPE).href,
    );
    expect(worker.fetched.map((r) => [r.url, r.cache])).toEqual(urls.map((u) => [u, 'reload']));
    expect([...(await worker.caches.open(worker.cacheName)).entries.keys()]).toEqual(urls);
    expect(worker.state.skipped).toBe(true);
  });

  it('install fails, and the worker does not take over, when any file fails', async () => {
    const worker = startWorker({ missing: 'licenses/fonts.txt' });
    await expect(worker.dispatch('install')).rejects.toThrow(
      `Precache failed: ${SCOPE}licenses/fonts.txt returned 404`,
    );
    expect(worker.state.skipped).toBe(false);
  });

  it('activation deletes only this app’s older caches for the same scope', async () => {
    const worker = startWorker();
    await worker.dispatch('install');
    const kept = [
      worker.cacheName,
      'another-app',
      'agentscope:https://example.test/other/:v0:0000',
      'agentscope:https://example.test/agentscope/x/:v0:0000',
    ];
    for (const name of [...kept, `agentscope:${SCOPE}:v0:0000`, `agentscope:${SCOPE}:dev:1111`]) {
      await worker.caches.open(name);
    }
    await worker.dispatch('activate');
    expect((await worker.caches.keys()).sort()).toEqual([...kept].sort());
    expect(worker.state.claimed).toBe(true);
  });

  it('serves precached files and navigations to the page from the cache', async () => {
    const worker = startWorker();
    await worker.dispatch('install');
    worker.fetched.length = 0;
    const served = async (request: FakeRequest) => {
      const response = await worker.dispatch('fetch', { request });
      return response && (await (await response).text());
    };
    expect(await served(worker.request('assets/index-a.js'))).toBe(
      `network ${SCOPE}assets/index-a.js`,
    );
    for (const url of ['', '#/rag/rag-query/3', 'index.html#/mcp']) {
      expect(await served(worker.request(url, { mode: 'navigate' })), url).toBe(`network ${SCOPE}`);
    }
    expect(worker.fetched).toEqual([]);
  });

  it('leaves everything else to the network', async () => {
    const worker = startWorker();
    await worker.dispatch('install');
    for (const request of [
      worker.request('api/balance'),
      worker.request('assets/index-a.js', { method: 'POST' }),
      worker.request('assets/index-a.js?v=2'),
      worker.request('?x=1', { mode: 'navigate' }),
      worker.request('https://example.test/other/index.html'),
      worker.request('https://elsewhere.test/agentscope/index.html'),
    ]) {
      expect(await worker.dispatch('fetch', { request }), request.url).toBeUndefined();
    }
  });

  it('falls back to the network when a precached file is missing from the cache', async () => {
    const worker = startWorker();
    await worker.dispatch('install');
    (await worker.caches.open(worker.cacheName)).entries.delete(`${SCOPE}index.html`);
    worker.fetched.length = 0;
    const response = await worker.dispatch('fetch', { request: worker.request('index.html') });
    expect(response).toBeDefined();
    await response;
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
