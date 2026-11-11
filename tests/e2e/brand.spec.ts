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

// 02-ui-ux.yaml layout.max_width, layout.source_link and design.typography (issue #47).
const WIDE = { width: 1920, height: 1080 };
/** The 90rem column inside the 48 px side margins, centred in a 1920 px window. */
const COLUMN = { left: (1920 - 1440) / 2 + 48, right: (1920 + 1440) / 2 - 48 };

/** Left and right edge of an element. */
async function edges(page: Page, selector: string): Promise<{ left: number; right: number }> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, selector).not.toBeNull();
  return { left: box?.x ?? NaN, right: (box?.x ?? NaN) + (box?.width ?? NaN) };
}

test('on a wide screen the text lies in the centred 90rem column, the header ends with the GitHub link', async ({
  page,
}) => {
  await page.setViewportSize(WIDE);
  await page.goto('./#/mcp/mcp-balance/3');
  const github = page.getByRole('link', { name: 'GitHub', exact: true });
  await expect(github).toBeVisible();

  // The header and the control row fill the column; the lesson starts on its left edge.
  for (const block of ['.shell-header', '.control-row']) {
    const { left, right } = await edges(page, block);
    expect(left, block).toBeCloseTo(COLUMN.left, 0);
    expect(right, block).toBeCloseTo(COLUMN.right, 0);
  }
  expect((await edges(page, '.lesson')).left).toBeCloseTo(COLUMN.left, 0);

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

test('on a wide screen the workspace widens only as far as its diagram needs, centred', async ({
  page,
}) => {
  await page.setViewportSize(WIDE);
  const pane = page.locator('.workspace .diagram-pane');

  // mcp-balance needs more than the column: no sideways scrolling, and not one pixel more.
  await page.goto('./#/mcp/mcp-balance/99/protocol');
  await page.locator('[data-measured]').waitFor();
  await expect.poll(() => pane.evaluate((p) => p.scrollWidth - p.clientWidth)).toBe(0);
  const spare = await pane.evaluate(
    (p) => p.clientWidth - Number(p.querySelector('svg.diagram')?.getAttribute('width')),
  );
  expect(spare).toBeGreaterThanOrEqual(0);
  expect(spare).toBeLessThanOrEqual(2);
  const wide = await edges(page, '.workspace');
  expect(wide.right - wide.left).toBeGreaterThan(COLUMN.right - COLUMN.left);
  expect(Math.abs(wide.left - (1920 - wide.right))).toBeLessThanOrEqual(1);

  // rag-query fits the column, so its workspace keeps the column's width.
  await page.goto('./#/rag/rag-query/99/protocol');
  await page.locator('[data-measured]').waitFor();
  const narrow = await edges(page, '.workspace');
  expect(narrow.left).toBeCloseTo(COLUMN.left, 0);
  expect(narrow.right).toBeCloseTo(COLUMN.right, 0);
});

test('the widened workspace keeps its width while stepping and after a parameter change; the splitter states its share on screen', async ({
  page,
}) => {
  await page.setViewportSize(WIDE);
  const width = async () => {
    const { left, right } = await edges(page, '.workspace');
    return Math.round(right - left);
  };

  // Every step of mcp-balance, from the architecture overview at step 0 to the end.
  await page.goto('./#/mcp/mcp-balance/0');
  await page.locator('[data-measured]').waitFor();
  const status = page.locator('.control-row .status');
  const length = Number(/of (\d+)/.exec((await status.textContent()) ?? '')?.[1]);
  expect(length).toBeGreaterThan(10);
  const wide = await width();
  expect(wide).toBeGreaterThan(COLUMN.right - COLUMN.left);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (let step = 1; step <= length; step++) {
    await page.keyboard.press('ArrowRight');
    // A prediction prompt comes first; the next press runs the step.
    if (await page.locator('.prediction').isVisible()) await page.keyboard.press('ArrowRight');
    await expect(status).toContainText(`Step ${step} of`);
    expect(await width(), `step ${step}`).toBe(wide);
  }

  // The separator gives the share the inspector takes of this wider workspace.
  const splitter = page.getByRole('separator', { name: 'Resize the inspector' });
  const inspector = await page.getByRole('complementary', { name: 'Current step' }).boundingBox();
  const shown = String(Math.round(((inspector?.width ?? 0) / wide) * 100));
  await expect(splitter).toHaveAttribute('aria-valuenow', shown);
  await expect(splitter).toHaveAttribute('aria-valuetext', `Inspector ${shown}% of the width`);

  // rag-query keeps the column's width when a parameter changes its steps.
  await page.goto('./#/rag/rag-query/10');
  await page.locator('[data-measured]').waitFor();
  const before = await width();
  const rerank = page.getByRole('button', { name: 'Reranking' });
  await rerank.click();
  await expect(rerank).toHaveAttribute('aria-pressed', 'true');
  expect(await width()).toBe(before);
});
