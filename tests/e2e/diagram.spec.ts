import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

const SCENARIOS = [
  ['mcp-balance', 28],
  ['mcp-not-found', 28],
  ['mcp-unauthorized', 26],
  ['mcp-jsonrpc-error', 18],
  ['mcp-multiple-tools', 40],
  ['mcp-resources', 34],
  ['rag-index', 10],
  ['rag-query', 12],
  ['rag-stale', 12],
  ['rag-no-match', 12],
  ['rag-conflict', 12],
  ['rag-hybrid', 15],
  ['rag-prompt-injection', 12],
  ['combined-balance-explanation', 35],
] as const;

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./${hash}`);
  await page.locator('svg.diagram').waitFor();
  await page.evaluate(() => document.fonts.ready);
  // The view lays out again once fonts are measured.
  await page.waitForTimeout(100);
}

/** Pairs of overlapping text boxes inside the diagram, measured with the real font. */
async function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const texts = [...document.querySelectorAll<SVGTextElement>('svg.diagram text')];
    const boxes = texts.map((t) => ({ name: t.textContent ?? '', box: t.getBBox() }));
    const found: string[] = [];
    boxes.forEach((first, i) => {
      for (const second of boxes.slice(i + 1)) {
        const a = first.box;
        const b = second.box;
        const tol = 0.5;
        if (
          a.x + tol < b.x + b.width &&
          b.x + tol < a.x + a.width &&
          a.y + tol < b.y + b.height &&
          b.y + tol < a.y + a.height
        ) {
          found.push(`"${first.name}" × "${second.name}"`);
        }
      }
    });
    const width = document.querySelector<SVGSVGElement>('svg.diagram')?.viewBox.baseVal.width ?? 0;
    for (const { name, box } of boxes)
      if (box.x + box.width > width + 0.5) found.push(`"${name}" overflows`);
    return found;
  });
}

for (const [width, height, device] of [
  [1280, 900, 'desktop'],
  [820, 1100, 'tablet'],
] as const) {
  test(`no overlapping labels in any scenario at ${device} width`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const [id, steps] of SCENARIOS) {
      await open(page, `#/diagram/${id}/${steps}/protocol`);
      expect(await overlaps(page), `${id} protocol`).toEqual([]);
      await open(page, `#/diagram/${id}/${steps}/architecture`);
      // Expand every group.
      const groups = page.locator('[data-phase]');
      const count = await groups.count();
      for (let i = 0; i < count; i += 1) {
        const group = page.locator('[data-phase][aria-expanded="false"]').first();
        await group.click();
      }
      expect(await overlaps(page), `${id} architecture`).toEqual([]);
    }
  });
}

test('the diagram scrolls horizontally on a narrow screen instead of squeezing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await open(page, '#/diagram/mcp-balance/28/protocol');
  const region = page.getByRole('region', { name: /Sequence diagram/ });
  const { scroll, client, pageWidth } = await region.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(scroll).toBeGreaterThan(client);
  expect(pageWidth).toBeLessThanOrEqual(600);
});

test('switching mode keeps the cursor on the same step', async ({ page }) => {
  await open(page, '#/diagram/mcp-balance/14/protocol');
  await expect(page.locator('[data-current]')).toHaveAttribute('data-index', '13');
  await page.getByRole('button', { name: 'Architecture' }).click();
  await expect(page.getByText('Step 14 of 28')).toBeVisible();
  await expect(page.locator('[data-current]')).toHaveAttribute('data-phase', 'tool');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Protocol' }).click();
  await expect(page.getByText('Step 15 of 28')).toBeVisible();
  await expect(page.locator('[data-current]')).toHaveAttribute('data-index', '14');
  await expect(page).toHaveURL(/#\/diagram\/mcp-balance\/15\/protocol$/);
});

test('future steps are hidden in protocol mode', async ({ page }) => {
  await open(page, '#/diagram/mcp-balance/3/protocol');
  await expect(page.locator('.step')).toHaveCount(3);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.step')).toHaveCount(4);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.step')).toHaveCount(2);
});

test('groups expand and collapse with the keyboard, and stay open while stepping', async ({
  page,
}) => {
  await open(page, '#/diagram/mcp-balance/14/architecture');
  const group = page.locator('[data-phase="tool"]');
  await group.focus();
  await page.keyboard.press('Enter');
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(group).toBeFocused();
  await expect(page.locator('.step')).toHaveCount(2);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('[data-phase="tool"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.step')).toHaveCount(3);
  await page.locator('[data-phase="tool"]').focus();
  await page.keyboard.press(' ');
  await expect(page.locator('[data-phase="tool"]')).toHaveAttribute('aria-expanded', 'false');
});

test('meaning survives in greyscale: the current step and errors carry non-colour cues', async ({
  page,
}, info) => {
  await open(page, '#/diagram/mcp-not-found/23/protocol');
  const style = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { weight: s.fontWeight, width: s.strokeWidth, dash: s.strokeDasharray };
      });
  const current = await style('[data-current] .arrow-label');
  const past = await style('.step:not([data-current]) .arrow-label--past');
  expect(current.weight).toBe('600');
  expect(past.weight).toBe('400');
  expect((await style('[data-current] .arrow')).width).toBe('2px');
  expect((await style('.arrow--network:not(.arrow--current)')).width).toBe('1.5px');
  expect((await style('.arrow--simulated')).dash).toBe('4px, 3px');
  const errors = await page.locator('.arrow-label--error').allTextContents();
  expect(errors).toEqual([
    '× transport error · HTTP 404 Not Found',
    '× tool execution error · MCP · tools/call result',
  ]);
  await page.addStyleTag({ content: 'html { filter: grayscale(1); }' });
  await info.attach('greyscale', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('with reduced motion the current step scrolls into view instantly', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 600 });
  await open(page, '#/diagram/mcp-multiple-tools/1/protocol');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.evaluate(() => {
    location.hash = '#/diagram/mcp-multiple-tools/40/protocol';
  });
  await page.locator('[data-current][data-index="39"]').waitFor();
  const y = await page.evaluate(() => window.scrollY);
  expect(y).toBeGreaterThan(0);
  const { top, bottom, height } = await page.evaluate(() => {
    const r =
      document.querySelector('[data-current]')?.getBoundingClientRect() ?? new DOMRect(0, -1);
    return { top: r.top, bottom: r.bottom, height: window.innerHeight };
  });
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeLessThanOrEqual(height);
});
