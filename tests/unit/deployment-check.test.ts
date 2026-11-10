import { describe, expect, it } from 'vitest';
import {
  checkDeployment,
  describeError,
  pageVersion,
  referencedUrls,
} from '../../scripts/deployment-check';
import { integrity } from '../../scripts/vite-offline';

const PAGE = 'https://m14dch.github.io/agentscope/';
const HTML = `<!doctype html><html><head>
  <meta name="agentscope-version" content="abc123">
  <link rel="icon" href="data:,">
  <script type="module" crossorigin src="/agentscope/assets/index-abc.js"></script>
  <link rel="stylesheet" crossorigin href="/agentscope/assets/index-def.css">
  <link rel="icon" href='favicon.svg'>
</head><body><a href="https://example.com/">not an asset</a></body></html>`;

const SITE = 'https://m14dch.github.io/agentscope/';
const MANIFEST_URL = `${SITE}asset-manifest.json`;
/** The fake serves the page's HTML for every file, so that is what each digest covers. */
const DIGEST = integrity(new TextEncoder().encode(HTML));
const manifestOf = (version: string, paths: string[], digest = DIGEST) =>
  JSON.stringify({
    version,
    hash: '0123456789abcdef',
    files: paths.map((path) => ({ path, integrity: digest })),
  });
const MANIFEST = manifestOf('abc123', ['assets/index-abc.js', 'assets/font.woff2', 'index.html']);

/** Answers with the given statuses (404 otherwise): the manifest for its URL, else the page. */
function fakeFetch(responses: Record<string, number>, html = HTML, manifest = MANIFEST) {
  return async (url: string) => {
    const body = url === MANIFEST_URL ? manifest : html;
    return {
      status: responses[url] ?? 404,
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    };
  };
}

describe('referencedUrls', () => {
  it('finds script and link references, resolved against the page, ignoring anchors', () => {
    expect(referencedUrls(HTML, PAGE)).toEqual([
      'data:,',
      'https://m14dch.github.io/agentscope/assets/index-abc.js',
      'https://m14dch.github.io/agentscope/assets/index-def.css',
      'https://m14dch.github.io/agentscope/favicon.svg',
    ]);
  });
});

describe('referencedUrls with other attribute forms', () => {
  it('reads unquoted and upper-case attributes', () => {
    expect(referencedUrls('<SCRIPT SRC=/agentscope/a.js></SCRIPT>', PAGE)).toEqual([
      'https://m14dch.github.io/agentscope/a.js',
    ]);
  });
});

describe('pageVersion', () => {
  it('reads the version stamp', () => {
    expect(pageVersion(HTML)).toBe('abc123');
    expect(pageVersion('<html></html>')).toBeUndefined();
  });

  it('reads the stamp in any attribute order and quoting', () => {
    expect(pageVersion("<meta content='abc123' name=agentscope-version>")).toBe('abc123');
    expect(pageVersion('<meta name="description" content="x"><meta name="other">')).toBeUndefined();
  });
});

describe('describeError', () => {
  it('includes the underlying cause code', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(describeError(new TypeError('fetch failed', { cause }))).toBe(
      'fetch failed (ECONNREFUSED)',
    );
    expect(describeError(new Error('boom'))).toBe('boom');
  });
});

describe('checkDeployment', () => {
  const ok = {
    [PAGE]: 200,
    'https://m14dch.github.io/agentscope/assets/index-abc.js': 200,
    'https://m14dch.github.io/agentscope/assets/index-def.css': 200,
    'https://m14dch.github.io/agentscope/favicon.svg': 200,
    [MANIFEST_URL]: 200,
    [`${SITE}sw.js`]: 200,
    [`${SITE}assets/font.woff2`]: 200,
    [`${SITE}index.html`]: 200,
  };

  it('passes a healthy deployment', async () => {
    expect(await checkDeployment(PAGE, fakeFetch(ok))).toEqual([]);
  });

  it('skips inline data: references and accepts the expected version', async () => {
    expect(await checkDeployment(PAGE, fakeFetch(ok), 'abc123')).toEqual([]);
  });

  it('reports a stale deployment', async () => {
    expect(await checkDeployment(PAGE, fakeFetch(ok), 'def456')).toEqual([
      'page version is abc123, expected def456',
      'asset manifest version is abc123, expected def456',
    ]);
  });

  it('reports network errors instead of throwing', async () => {
    const failing = async (url: string) => {
      if (url === PAGE) throw new Error('fetch failed');
      return { status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    };
    expect(await checkDeployment(PAGE, failing)).toEqual([`${PAGE} failed: fetch failed`]);
    const assetFails = async (url: string) => {
      if (url !== PAGE) throw new Error('connection reset');
      return { status: 200, text: async () => HTML, arrayBuffer: async () => new ArrayBuffer(0) };
    };
    expect(await checkDeployment(PAGE, assetFails)).toContain(
      'https://m14dch.github.io/agentscope/favicon.svg failed: connection reset',
    );
  });

  it('reports a page that does not load', async () => {
    expect(await checkDeployment(PAGE, fakeFetch({}))).toEqual([`${PAGE} returned 404`]);
  });

  it('reports a missing asset', async () => {
    const missing = { ...ok, 'https://m14dch.github.io/agentscope/favicon.svg': 404 };
    expect(await checkDeployment(PAGE, fakeFetch(missing))).toEqual([
      'https://m14dch.github.io/agentscope/favicon.svg returned 404',
    ]);
  });

  it('reports assets built for the wrong base path or another origin', async () => {
    const html = '<script src="/assets/a.js"></script><link href="https://cdn.example/x.css">';
    expect(await checkDeployment(PAGE, fakeFetch(ok, html, manifestOf('abc123', [])))).toEqual([
      'https://m14dch.github.io/assets/a.js is outside the base path /agentscope/',
      "https://cdn.example/x.css is outside the site's origin",
    ]);
  });

  it('reports a missing or invalid manifest, a missing service worker or listed file', async () => {
    expect(await checkDeployment(PAGE, fakeFetch({ ...ok, [MANIFEST_URL]: 404 }))).toEqual([
      `${MANIFEST_URL} returned 404`,
    ]);
    for (const invalid of ['{"files": 3}', '{"version": "v", "files": ["index.html"]}', 'x']) {
      expect(await checkDeployment(PAGE, fakeFetch(ok, HTML, invalid)), invalid).toEqual([
        `${MANIFEST_URL} is not a valid asset manifest`,
      ]);
    }
    expect(await checkDeployment(PAGE, fakeFetch({ ...ok, [`${SITE}sw.js`]: 404 }))).toEqual([
      `${SITE}sw.js returned 404`,
    ]);
    expect(
      await checkDeployment(PAGE, fakeFetch({ ...ok, [`${SITE}assets/font.woff2`]: 404 })),
    ).toEqual([`${SITE}assets/font.woff2 returned 404`]);
  });

  it('reports a stale manifest and listed files outside the base path', async () => {
    const manifest = manifestOf('old', ['../elsewhere.js']);
    expect(await checkDeployment(PAGE, fakeFetch(ok, HTML, manifest), 'abc123')).toEqual([
      'asset manifest version is old, expected abc123',
      'https://m14dch.github.io/elsewhere.js is outside the base path /agentscope/',
    ]);
  });

  it('reports a listed file whose bytes do not match its digest (a stale file)', async () => {
    const manifest = manifestOf('abc123', ['assets/font.woff2'], 'sha256-AAAA');
    expect(await checkDeployment(PAGE, fakeFetch(ok, HTML, manifest), 'abc123')).toEqual([
      `${SITE}assets/font.woff2 does not match its integrity digest (stale)`,
    ]);
  });
});
