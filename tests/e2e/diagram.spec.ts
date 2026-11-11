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
  ['rag-query', 10],
  ['rag-stale', 10],
  ['rag-no-match', 10],
  ['rag-conflict', 10],
  ['rag-hybrid', 13],
  ['rag-prompt-injection', 10],
  ['combined-balance-explanation', 35],
  ['combined-missing-terms', 35],
] as const;

/** The shell route for a scenario at a step, in either mode. */
function route(id: string, step: number, mode: 'architecture' | 'protocol'): string {
  const tab = id.startsWith('mcp-') ? 'mcp' : id.startsWith('rag-') ? 'rag' : 'combined';
  return `#/${tab}/${id}/${step}${mode === 'protocol' ? '/protocol' : ''}`;
}

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./${hash}`);
  // The view lays out again with the real font, then marks itself measured.
  await page.locator('[data-measured] svg.diagram').waitFor();
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

// The layout does not depend on the viewport, but the acceptance criteria name both widths.
for (const [width, height, device] of [
  [1280, 900, 'desktop'],
  [820, 1100, 'tablet'],
] as const) {
  test(`no overlapping labels in any scenario at ${device} width`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const [id, steps] of SCENARIOS) {
      await open(page, route(id, steps, 'protocol'));
      expect(await overlaps(page), `${id} protocol`).toEqual([]);
      await open(page, route(id, steps, 'architecture'));
      // Expand every group.
      const groups = page.locator('[data-group]');
      const count = await groups.count();
      for (let i = 0; i < count; i += 1) {
        const group = page.locator('[data-phase][aria-expanded="false"]').first();
        await group.click();
      }
      expect(await overlaps(page), `${id} architecture`).toEqual([]);
    }
  });
}

// From 48rem (tablets); below it the diagram is the step list (02 diagram.phone_list).
test('the diagram scrolls horizontally on a narrow screen instead of squeezing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await open(page, route('mcp-balance', 28, 'protocol'));
  const region = page.getByRole('region', { name: /Sequence diagram/ });
  const { scroll, client, pageWidth } = await region.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(scroll).toBeGreaterThan(client);
  expect(pageWidth).toBeLessThanOrEqual(768);
});

test('switching mode keeps the cursor on the same step', async ({ page }) => {
  await open(page, route('mcp-balance', 14, 'protocol'));
  await expect(page.locator('[data-current]')).toHaveAttribute('data-index', '13');
  await page.getByRole('button', { name: 'Architecture' }).click();
  await expect(page.locator('.status').filter({ hasText: 'Step 14 of 28' })).toBeVisible();
  await expect(page.locator('[data-current]')).toHaveAttribute('data-phase', 'tool');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Protocol' }).click();
  await expect(page.locator('.status').filter({ hasText: 'Step 15 of 28' })).toBeVisible();
  await expect(page.locator('[data-current]')).toHaveAttribute('data-index', '14');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/15\/protocol$/);
});

test('future steps are hidden in protocol mode', async ({ page }) => {
  await open(page, route('mcp-balance', 3, 'protocol'));
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
  await open(page, route('mcp-balance', 14, 'architecture'));
  const group = page.locator('[data-group="tool"]');
  await group.focus();
  await page.keyboard.press('Enter');
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(group).toBeFocused();
  await expect(page.locator('.step')).toHaveCount(2);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('[data-group="tool"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.step')).toHaveCount(3);
  await page.locator('[data-group="tool"]').focus();
  await page.keyboard.press(' ');
  await expect(page.locator('[data-group="tool"]')).toHaveAttribute('aria-expanded', 'false');
});

test('meaning survives in greyscale: the current step and errors carry non-colour cues', async ({
  page,
}, info) => {
  await open(page, route('mcp-not-found', 23, 'protocol'));
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

test('with reduced motion the diagram region scrolls to the current step instantly, not the page', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 700 });
  await open(page, route('mcp-multiple-tools', 1, 'protocol'));
  await page.evaluate(() => {
    location.hash = '#/mcp/mcp-multiple-tools/40/protocol';
  });
  await page.locator('[data-current][data-index="39"]').waitFor();
  const state = await page.evaluate(() => {
    const region = document.querySelector('.diagram-scroller');
    const current = document.querySelector('[data-current]');
    const r = region?.getBoundingClientRect();
    const c = current?.getBoundingClientRect();
    return {
      page: window.scrollY,
      region: region?.scrollTop ?? 0,
      inside: !!r && !!c && c.top >= r.top && c.bottom <= r.bottom,
    };
  });
  expect(state.page).toBe(0);
  expect(state.region).toBeGreaterThan(0);
  expect(state.inside).toBe(true);
});

test('toggling a group keeps the scroll position and focus', async ({ page }) => {
  // Instant scrolling, so the opening scroll has finished before measuring.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 700 });
  await open(page, route('combined-balance-explanation', 35, 'architecture'));
  const region = page.locator('.diagram-scroller');
  const before = await region.evaluate((el) => el.scrollTop);
  const last = page.locator('[data-group="answer"]');
  await last.click();
  await expect(page.locator('[data-group="answer"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-group="answer"]')).toBeFocused();
  expect(await region.evaluate((el) => el.scrollTop)).toBe(before);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('focus stays on the same group while stepping', async ({ page }) => {
  await open(page, route('mcp-balance', 14, 'architecture'));
  await page.locator('[data-group="tool"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.status').filter({ hasText: 'Step 15 of 28' })).toBeVisible();
  await expect(page.locator('[data-group="tool"]')).toBeFocused();
});

test('arrow keys scroll the focused diagram region instead of stepping', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await open(page, route('mcp-balance', 5, 'protocol'));
  const region = page.locator('.diagram-scroller');
  await region.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.status').filter({ hasText: 'Step 5 of 28' })).toBeVisible();
  await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});

test('the participant names stay at the top of the region while it scrolls, above the current step', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, route('mcp-multiple-tools', 40, 'protocol'));
  await page.locator('[data-current][data-index="39"]').waitFor();
  const state = () =>
    page.evaluate(() => {
      const region = document.querySelector('.diagram-scroller') as HTMLElement;
      const r = region.getBoundingClientRect();
      const names = [...region.querySelectorAll('.participant')].map((t) =>
        t.getBoundingClientRect(),
      );
      const band = region.querySelector('.participants-band')?.getBoundingClientRect();
      const current = region.querySelector('[data-current]')?.getBoundingClientRect();
      return {
        scrolled: region.scrollTop,
        namesInside: names.every((n) => n.top >= r.top && n.bottom <= r.bottom),
        bandAtTop: Math.abs((band?.top ?? -1) - r.top) < 1,
        currentBelowNames: !!band && !!current && current.top >= band.bottom,
      };
    });
  const end = await state();
  expect(end.scrolled).toBeGreaterThan(0);
  expect(end).toMatchObject({ namesInside: true, bandAtTop: true, currentBelowNames: true });
  // Scrolling by hand keeps them in place too.
  await page.locator('.diagram-scroller').evaluate((el) => el.scrollTo({ top: 200 }));
  await expect.poll(async () => (await state()).bandAtTop).toBe(true);
  expect((await state()).namesInside).toBe(true);
});
