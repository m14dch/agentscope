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
  await page.goto('./#/mcp/mcp-balance/3');
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

// 02-ui-ux.yaml layout.max_width, layout.source_link and design.typography (issue #47).
test('on a wide screen the content is at most 90rem wide and centred, the header ends with the GitHub link', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('./#/mcp/mcp-balance/3');
  const github = page.getByRole('link', { name: 'GitHub', exact: true });
  await expect(github).toBeVisible();

  // Everything sits inside the centred 1440 px column, the diagram region included.
  const shell = await page.locator('.shell').boundingBox();
  expect(shell).not.toBeNull();
  if (!shell) return;
  expect(shell.width).toBeLessThanOrEqual(1440);
  expect(Math.abs(shell.x - (1920 - shell.x - shell.width))).toBeLessThanOrEqual(1);
  for (const region of [page.locator('.workspace'), page.locator('.timeline')]) {
    const box = await region.boundingBox();
    expect(box && box.x >= shell.x && box.x + box.width <= shell.x + shell.width).toBe(true);
  }

  // The link ends the header row: an ordinary link in the same tab, after the view switch.
  await expect(github).toHaveAttribute('href', 'https://github.com/m14dch/agentscope');
  await expect(github).not.toHaveAttribute('target', /.+/);
  const link = await github.boundingBox();
  const view = await page.getByRole('group', { name: 'View', exact: true }).boundingBox();
  expect(link && view && link.x > view.x + view.width).toBe(true);
  await page.getByRole('button', { name: 'Protocol', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(github).toBeFocused();

  // Sentences above the diagram have a line height of at least 1.5.
  for (const text of ['.simulated', '.lesson h2', '.headline']) {
    const ratio = await page.locator(text).evaluate((node) => {
      const style = getComputedStyle(node);
      return parseFloat(style.lineHeight) / parseFloat(style.fontSize);
    });
    expect(ratio, text).toBeGreaterThanOrEqual(1.5);
  }
});
