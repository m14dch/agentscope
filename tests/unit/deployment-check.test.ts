import { describe, expect, it } from 'vitest';
import { checkDeployment, referencedUrls } from '../../scripts/deployment-check';

const PAGE = 'https://m14dch.github.io/agentscope/';
const HTML = `<!doctype html><html><head>
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
      'https://m14dch.github.io/agentscope/assets/index-abc.js',
      'https://m14dch.github.io/agentscope/assets/index-def.css',
      'https://m14dch.github.io/agentscope/favicon.svg',
    ]);
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
