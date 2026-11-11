// 08-acceptance-tests.yaml e2e_tests: offline and pages (issue #18).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { BrowserContext, Page } from '@playwright/test';
import { BASE_PATH } from '../../vite.config';
import { expect, test } from './fixtures';

const product = parse(readFileSync('specifications/00-product.yaml', 'utf8')) as {
  primary_questions: { mcp: string; rag: string; combined: string };
};
const manifest = JSON.parse(readFileSync('dist/asset-manifest.json', 'utf8')) as {
  version: string;
  hash: string;
  files: { path: string; integrity: string }[];
};

const simulated = (page: Page) => page.locator('.simulated');
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Current step' });
const slider = (page: Page) => page.getByRole('slider', { name: 'Step' });

/** Loads the app and waits until it reports that the build is cached. */
async function loadAndCache(page: Page, hash = ''): Promise<void> {
  await page.goto(`./${hash}`);
  await expect(simulated(page)).toHaveText(
    'Everything here is simulated. Nothing leaves your browser. Available offline.',
    { timeout: 30_000 },
  );
}

/**
 * Cuts the network: the browser goes offline and any same-origin request that still
 * reaches the network layer is aborted and recorded, so the test can assert that
 * everything came from the service worker's cache.
 */
async function goOffline(context: BrowserContext): Promise<string[]> {
  const reachedNetwork: string[] = [];
  const origin = new URL(test.info().project.use.baseURL ?? 'http://localhost').origin;
  await context.setOffline(true);
  await context.route(
    (url) => url.origin === origin,
    (route) => {
      reachedNetwork.push(route.request().url());
      return route.abort('internetdisconnected');
    },
  );
  return reachedNetwork;
}

/**
 * Opens a scenario and steps through every event to the last one, returning what the
 * inspector showed on the way (whitespace-normalised), so the test can check the question,
 * payloads and answer of the whole run.
 */
async function walkThrough(page: Page, hash: string): Promise<string> {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.locator('[data-measured] svg.diagram').waitFor();
  const last = Number(await slider(page).getAttribute('max'));
  const seen: string[] = [];
  for (let step = 0; step <= last; step++) {
    await slider(page).fill(String(step));
    await expect(page.locator('.status')).toContainText(`Step ${step} of ${last}`);
    seen.push((await inspector(page).innerText()).replace(/\s+/g, ' '));
  }
  // The SVG diagram draws one labelled arrow per step (protocol mode shows every event).
  const diagram = page.locator('[data-measured] svg.diagram');
  await expect(diagram).toBeVisible();
  await expect(diagram.locator('.arrow')).toHaveCount(last);
  await expect(diagram.locator('.arrow-label')).toHaveCount(last);
  return seen.join('\n');
}

/**
 * The header wordmark is decoded and the favicon loads, both under the base path
 * (02-ui-ux.yaml layout brand); offline they can only come from the cache.
 */
async function expectBrandLoaded(page: Page): Promise<void> {
  const base = new URL(BASE_PATH, test.info().project.use.baseURL).href;
  const wordmark = page.getByRole('heading', { level: 1 }).getByRole('img', { name: 'AgentScope' });
  await expect(wordmark).toBeVisible();
  await expect
    .poll(() => wordmark.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);
  expect(await wordmark.evaluate((img: HTMLImageElement) => img.currentSrc)).toBe(
    `${base}brand/agentscope-silver-light.svg`,
  );
  const favicon = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? '';
    const response = await fetch(href);
    return { href, status: response.status, type: response.headers.get('content-type') };
  });
  expect(favicon).toEqual({
    href: `${base}brand/agentscope-silver-favicon.svg`,
    status: 200,
    type: expect.stringMatching(/^image\/svg\+xml\b/),
  });
}

const normalised = (text: string) => text.replace(/\s+/g, ' ');

test('offline: after one online visit, all three primary scenarios work without a network', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await loadAndCache(page);
  const reachedNetwork = await goOffline(context);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('AgentScope');
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await expectBrandLoaded(page);

  // MCP: the question, the tool call on the wire and the balance.
  const mcp = await walkThrough(page, '#/mcp/mcp-balance/0/protocol');
  expect(mcp).toContain(normalised(product.primary_questions.mcp));
  expect(mcp).toContain('"method": "tools/call"');
  expect(mcp).toContain('Your current account balance is CHF 12,500.75.');

  // RAG: the answer cites its sources, each resolved to a chunk of a document.
  const rag = await walkThrough(page, '#/rag/rag-query/0/protocol');
  expect(rag).toContain(normalised(product.primary_questions.rag));
  expect(rag).toContain('Opening an account: anyone aged 18 or over');
  expect(rag).toContain('"citation": 1, "chunkId": "account-opening@1.2-c50o10-001"');

  // Combined: the live balance and the cited conditions.
  const combined = await walkThrough(page, '#/combined/combined-balance-explanation/0/protocol');
  expect(combined).toContain(normalised(product.primary_questions.combined));
  expect(combined).toContain('Your current balance is CHF 12,500.75');
  expect(combined).toContain('"citation": 1');

  // Both self-hosted fonts render from the cache too.
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
  });
  expect(fonts.join()).toContain('Inter');
  expect(fonts.join()).toContain('JetBrains Mono');
  // Nothing but the browser's own update check of sw.js tried the network.
  expect(reachedNetwork.filter((url) => !url.endsWith('/sw.js'))).toEqual([]);
});

test('pages: the subpath build serves shell, assets, hash navigation and a base-scoped worker', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(60_000);
  // CI and the default build both use a repository subpath; a root build has none to test.
  test.skip(BASE_PATH === '/', 'Built for a root site (AGENTSCOPE_BASE=/), not a subpath');
  const base = new URL(BASE_PATH, test.info().project.use.baseURL).href;

  // Every file of the build loads under the base path, and nothing outside it.
  for (const file of ['', 'sw.js', 'asset-manifest.json', ...manifest.files.map((f) => f.path)]) {
    expect((await request.get(new URL(file, base).href)).status(), file).toBe(200);
  }

  // The shell, its version stamp and hash navigation within one document.
  await loadAndCache(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('AgentScope');
  await expect(page.locator('meta[name="agentscope-version"]')).toHaveAttribute(
    'content',
    manifest.version,
  );
  await page.evaluate(() => ((window as unknown as { marker: boolean }).marker = true));
  await page
    .getByRole('navigation', { name: 'Modules' })
    .getByRole('link', { name: 'RAG' })
    .click();
  await expect(page).toHaveURL(`${base}#/rag/rag-query/0`);
  expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true);

  // One worker for the base path, controlling the page, with this build's cache only.
  const worker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      scope: registration?.scope,
      script: registration?.active?.scriptURL,
      controlled: navigator.serviceWorker.controller !== null,
      caches: await caches.keys(),
    };
  });
  expect(worker).toEqual({
    scope: base,
    script: `${base}sw.js`,
    controlled: true,
    caches: [`agentscope:${base}:${manifest.version}:${manifest.hash}`],
  });

  // Offline reload of a deep link restores the same route from the cache.
  const reachedNetwork = await goOffline(context);
  await page.goto('./#/rag/rag-query/3');
  await page.reload();
  await expect(page.locator('.status')).toContainText('Step 3 of ');
  await expect(simulated(page)).toContainText('Available offline.');
  await expectBrandLoaded(page);
  expect(reachedNetwork.filter((url) => !url.endsWith('/sw.js'))).toEqual([]);
});

test('nothing about offline is shown before the build is cached', async ({ page, context }) => {
  // Hold back one precached file so the worker cannot finish installing.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await context.route('**/licenses/fonts.txt', async (route) => {
    await held;
    await route.fallback();
  });
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('AgentScope');
  await page.waitForTimeout(500);
  await expect(simulated(page)).toHaveText(
    'Everything here is simulated. Nothing leaves your browser.',
  );
  await expect(page.locator('.offline-status')).toBeHidden();
  release();
  await expect(simulated(page)).toContainText('Available offline.', { timeout: 30_000 });
});

test('a stale file whose bytes do not match its digest fails the install', async ({
  page,
  context,
}) => {
  // As if a CDN still served the previous build's copy of one file.
  await context.route('**/licenses/fonts.txt', (route) =>
    route.fulfill({ contentType: 'text/plain', body: 'a previous version' }),
  );
  // Keep the worker the app registers, so its fate is known even if its registration goes.
  await context.addInitScript(() => {
    const container = navigator.serviceWorker;
    const register = container.register.bind(container);
    container.register = async (...args) => {
      const registration = await register(...args);
      (window as unknown as { registered: ServiceWorker | null }).registered =
        registration.installing ?? registration.waiting ?? registration.active;
      return registration;
    };
  });
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('AgentScope');
  await page.waitForFunction(() => 'registered' in window);
  const state = await page.evaluate(async () => {
    const worker = (window as unknown as { registered: ServiceWorker | null }).registered;
    const settled = () => worker?.state === 'activated' || worker?.state === 'redundant';
    if (worker && !settled()) {
      await new Promise<void>((resolve) =>
        worker.addEventListener('statechange', () => settled() && resolve()),
      );
    }
    return worker?.state;
  });
  expect(state).toBe('redundant');
  // No partial cache is left behind.
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  await expect(page.locator('.offline-status')).toBeHidden();
});

test.describe('without a service worker', () => {
  test.use({ serviceWorkers: 'block' });

  test('a lazily loaded page that fails to load shows an error, not a blank page', async ({
    page,
    context,
  }) => {
    // As in a tab still running a build whose files are gone.
    await context.route('**/assets/specimen-*.js', (route) => route.abort('failed'));
    await page.goto('./#/design');
    // An alert, so assistive technology announces it.
    await expect(page.getByRole('alert')).toHaveText(
      '× The design specimen could not be loaded. Reload the page to get the current version.',
    );
    await page.getByRole('link', { name: 'Back to the app' }).click();
    await expect(page.locator('.simulated')).toBeVisible();
  });
});
