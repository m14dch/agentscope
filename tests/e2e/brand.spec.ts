// 02-ui-ux.yaml layout brand (issue #38): the header wordmark and the favicon.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { BASE_PATH } from '../../vite.config';
import { expect, test } from './fixtures';

const WORDMARK = 'brand/agentscope-silver-light.svg';
const FAVICON = 'brand/agentscope-silver-favicon.svg';

const manifest = JSON.parse(readFileSync('dist/asset-manifest.json', 'utf8')) as {
  files: { path: string }[];
};

const base = () => new URL(BASE_PATH, test.info().project.use.baseURL).href;
const wordmark = (page: Page) =>
  page.getByRole('heading', { level: 1 }).getByRole('img', { name: 'AgentScope' });

test('the header shows the light wordmark as the level-1 heading, linked to the start', async ({
  page,
}) => {
  // RAG has the scenario picker, the widest header (02 navigation.scenario_picker).
  await page.goto('./#/rag/rag-query/3');
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveAccessibleName('AgentScope');
  await expect(heading.getByRole('link', { name: 'AgentScope' })).toHaveAttribute('href', '#/');
  await expect(wordmark(page)).toBeVisible();
  // Resolved against the base path and actually decoded.
  expect(await wordmark(page).evaluate((img: HTMLImageElement) => img.currentSrc)).toBe(
    `${base()}${WORDMARK}`,
  );
  await expect
    .poll(() =>
      wordmark(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
    )
    .toBeGreaterThan(0);

  // 40 px high, and it does not overlap the tabs, the controls or the simulated statement.
  const box = await wordmark(page).boundingBox();
  expect(box?.height).toBeCloseTo(40, 0);
  for (const other of [
    page.getByRole('navigation', { name: 'Modules' }),
    page.locator('.picker'),
    page.getByRole('group', { name: 'View', exact: true }),
    page.locator('.simulated'),
  ]) {
    const b = await other.boundingBox();
    expect(b).not.toBeNull();
    if (!box || !b) continue;
    const overlaps =
      box.x < b.x + b.width &&
      b.x < box.x + box.width &&
      box.y < b.y + b.height &&
      b.y < box.y + box.height;
    expect(overlaps).toBe(false);
  }

  // Following the link goes to the start; the wordmark stays.
  await heading.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}#/mcp/mcp-balance/0$`));
  await expect(wordmark(page)).toBeVisible();
});

test('the favicon is the bundled SVG icon under the base path', async ({ page, request }) => {
  await page.goto('./');
  const icons = page.locator('link[rel="icon"]');
  await expect(icons).toHaveCount(1);
  await expect(icons).toHaveAttribute('type', 'image/svg+xml');
  const href = await icons.evaluate((link: HTMLLinkElement) => link.href);
  expect(href).toBe(`${base()}${FAVICON}`);

  const response = await request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^image\/svg\+xml\b/);
});

test('all three brand images ship with the build and are precached', () => {
  const listed = manifest.files.map((file) => file.path);
  for (const file of [
    'brand/agentscope-silver-light.svg',
    'brand/agentscope-silver-dark.svg',
    'brand/agentscope-silver-favicon.svg',
  ]) {
    expect(listed, file).toContain(file);
  }
});
