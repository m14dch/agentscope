import { describe, expect, it } from 'vitest';
import { checkDeployment, pageVersion, referencedUrls } from '../../scripts/deployment-check';

const PAGE = 'https://m14dch.github.io/agentscope/';
const HTML = `<!doctype html><html><head>
  <meta name="agentscope-version" content="abc123">
  <link rel="icon" href="data:,">
  <script type="module" crossorigin src="/agentscope/assets/index-abc.js"></script>
  <link rel="stylesheet" crossorigin href="/agentscope/assets/index-def.css">
  <link rel="icon" href='favicon.svg'>
</head><body><a href="https://example.com/">not an asset</a></body></html>`;

function fakeFetch(responses: Record<string, number>, html = HTML) {
  return async (url: string) => ({
    status: responses[url] ?? 404,
    text: async () => html,
  });
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
});

describe('checkDeployment', () => {
  const ok = {
    [PAGE]: 200,
    'https://m14dch.github.io/agentscope/assets/index-abc.js': 200,
    'https://m14dch.github.io/agentscope/assets/index-def.css': 200,
    'https://m14dch.github.io/agentscope/favicon.svg': 200,
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
    ]);
  });

  it('reports network errors instead of throwing', async () => {
    const failing = async (url: string) => {
      if (url === PAGE) throw new Error('fetch failed');
      return { status: 200, text: async () => '' };
    };
    expect(await checkDeployment(PAGE, failing)).toEqual([`${PAGE} failed: fetch failed`]);
    const assetFails = async (url: string) => {
      if (url !== PAGE) throw new Error('connection reset');
      return { status: 200, text: async () => HTML };
    };
    expect(await checkDeployment(PAGE, assetFails)).toContain(
      'https://m14dch.github.io/agentscope/favicon.svg returned connection reset',
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
    expect(await checkDeployment(PAGE, fakeFetch(ok, html))).toEqual([
      'https://m14dch.github.io/assets/a.js is outside the base path /agentscope/',
      "https://cdn.example/x.css is outside the site's origin",
    ]);
  });
});
