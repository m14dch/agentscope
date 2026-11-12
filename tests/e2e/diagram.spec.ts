import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

const SCENARIOS = [
  ['mcp-balance', 28],
  ['rag-index', 10],
  ['rag-query', 10],
  ['combined-balance-explanation', 35],
] as const;

/** The shell route for a scenario at a step, at Architecture or Protocol. */
function route(id: string, step: number, level: 'architecture' | 'protocol'): string {
  const tab = id.startsWith('mcp-') ? 'mcp' : id.startsWith('rag-') ? 'rag' : 'combined';
  return `#/${tab}/${id}/${step}/${level}`;
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
      // Expand every group (the current one is open already).
      const closed = page.locator('[data-phase][aria-expanded="false"]');
      while ((await closed.count()) > 0) await closed.first().click();
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

test('zooming between Architecture and Protocol keeps the cursor on the same step', async ({
  page,
}) => {
  await open(page, route('mcp-balance', 14, 'protocol'));
  await expect(page.locator('[data-current]')).toHaveAttribute('data-index', '13');
  await page.getByRole('button', { name: 'Architecture' }).click();
  await expect(page.locator('.status').filter({ hasText: 'Step 14 of 28' })).toBeVisible();
  // The current group, open with its current step (02 zoom_levels.architecture_groups).
  await expect(page.locator('[data-phase][data-current]')).toHaveAttribute('data-phase', 'tool');
  await expect(page.locator('.step[data-current]')).toHaveAttribute('data-index', '13');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Protocol' }).click();
  await expect(page.locator('.status').filter({ hasText: 'Step 15 of 28' })).toBeVisible();
  await expect(page.locator('[data-current]')).toHaveAttribute('data-index', '14');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/15\/protocol$/);
});

test('future steps are hidden at the Protocol level', async ({ page }) => {
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
  const group = page.locator('[data-group="setup"]');
  await group.focus();
  await page.keyboard.press('Enter');
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(group).toBeFocused();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('[data-group="setup"]')).toHaveAttribute('aria-expanded', 'true');
  // Setup's three steps and the current group's three (tool: steps 13 to 15).
  await expect(page.locator('.step')).toHaveCount(6);
  await page.locator('[data-group="setup"]').focus();
  await page.keyboard.press(' ');
  await expect(page.locator('[data-group="setup"]')).toHaveAttribute('aria-expanded', 'false');
});

test('the current group stays expanded while stepping; one the learner collapsed stays closed until the cursor enters it again', async ({
  page,
}) => {
  // 02 zoom_levels.architecture_groups and zoom_levels.scrolling, at a laptop size where group frames are
  // wider than the region; instant scrolling, so each step's position is final.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 720 });
  const next = page.getByRole('button', { name: 'Next' });
  // Next, past a prediction prompt (02 learning.prediction_rules).
  const forward = async (): Promise<void> => {
    await next.click();
    if (await page.locator('.prediction').count()) await next.click();
  };
  const current = page.locator('.step[data-current]');
  // The current step lies wholly inside the region, below the pinned participant names.
  const inside = () =>
    current.evaluate((el) => {
      const region = el.closest('.diagram-scroller');
      if (!region) return false;
      const r = region.getBoundingClientRect();
      const head = region.querySelector('.diagram-head')?.getBoundingClientRect().height ?? 0;
      const b = el.getBoundingClientRect();
      return (
        b.left >= r.left && b.right <= r.right && b.top >= r.top + head && b.bottom <= r.bottom
      );
    });
  // combined-balance-explanation has the widest groups (steps start far right of their frame).
  for (const [id, n] of [
    ['mcp-balance', 28],
    ['combined-balance-explanation', 35],
  ] as const) {
    await open(page, route(id, 1, 'architecture'));
    for (let step = 1; step <= n; step += 1) {
      if (step > 1) await forward();
      await expect(page.locator('.status')).toContainText(`Step ${step} of ${n}`);
      await expect(page.locator('[data-phase][data-current]')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(current).toHaveAttribute('data-index', String(step - 1));
      expect(await inside(), `${id} step ${step}`).toBe(true);
      // Only the current group is open: the overview stays one takeaway per phase.
      await expect(page.locator('[data-group][aria-expanded="true"]')).toHaveCount(1);
    }
  }
  // mcp-balance: planning is steps 10-12, tool 13-16.
  await page.evaluate(() => {
    location.hash = '#/mcp/mcp-balance/10/architecture';
  });
  const planning = page.locator('[data-group="planning"]');
  // On its caption: the frame's middle is covered by its expanded steps.
  await planning.locator('.group-label').click();
  await expect(planning).toHaveAttribute('aria-expanded', 'false');
  await forward();
  await expect(page.locator('.status')).toContainText('Step 11 of 28');
  await expect(page.locator('[data-group="planning"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.step[data-current]')).toHaveCount(0);
  await forward();
  await forward();
  await expect(page.locator('[data-group="planning"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-group="tool"]')).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.locator('[data-group="planning"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.step[data-current]')).toHaveAttribute('data-index', '11');
});

test('meaning survives in greyscale: the current step carries non-colour cues', async ({
  page,
}, info) => {
  await open(page, route('mcp-balance', 23, 'protocol'));
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
  await open(page, route('combined-balance-explanation', 1, 'protocol'));
  await page.evaluate(() => {
    location.hash = '#/combined/combined-balance-explanation/35/protocol';
  });
  await page.locator('[data-current][data-index="34"]').waitFor();
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
  // At the step before the last group, so the click expands a group that is not current.
  await open(page, route('combined-balance-explanation', 34, 'architecture'));
  const region = page.locator('.diagram-scroller');
  const last = page.locator('[data-group="answer"]');
  // The current group is open above it, so the click target may first need scrolling to.
  await last.scrollIntoViewIfNeeded();
  const before = await region.evaluate((el) => el.scrollTop);
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
  await open(page, route('combined-balance-explanation', 35, 'protocol'));
  await page.locator('[data-current][data-index="34"]').waitFor();
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
