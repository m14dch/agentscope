// 08-acceptance-tests.yaml e2e_tests: quality-gate-events, and accessibility's keyboard and
// reduced-motion steps (issue #19).
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { parse } from 'yaml';
import { expect, test } from './fixtures';

/**
 * Quality gates of 08-acceptance-tests.yaml that no other browser test covers on its own:
 * at least min_supported_events played smoothly, keyboard-only use with visible focus on every
 * tab, and reduced motion.
 */
const gates = (
  parse(readFileSync('specifications/08-acceptance-tests.yaml', 'utf8')) as {
    quality_gates: { min_supported_events: number };
  }
).quality_gates;

/** Every scenario of the MCP, RAG and Combined tabs, and Compare, by route. */
const ROUTES = [
  'mcp/mcp-balance',
  'rag/rag-query',
  'rag/rag-index',
  'compare/compare-rag-mcp',
  'combined/combined-balance-explanation',
];

/** The step status: Compare's own above its panes' (each pane has a status too). */
const status = (page: Page, compare: boolean) =>
  page.locator(compare ? '.compare-status' : '.status').first();

async function ready(page: Page): Promise<void> {
  await page.locator('[data-measured]').first().waitFor();
}

/**
 * Steps from the start to the last step with → and returns how long each key took to handle,
 * rendering and layout included (the app renders synchronously on the key).
 */
async function stepThrough(page: Page): Promise<{ total: number; times: number[] }> {
  return page.evaluate(async () => {
    const status = () =>
      (document.querySelector('.compare-status') ?? document.querySelector('.status'))
        ?.textContent ?? '';
    const total = Number(/of (\d+)/.exec(status())?.[1] ?? 0);
    const times: number[] = [];
    for (let guard = 0; guard < 4 * total + 4; guard += 1) {
      if (new RegExp(`^Step ${total} of ${total}`).test(status())) break;
      const t0 = performance.now();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      void document.body.offsetHeight;
      times.push(performance.now() - t0);
      // Let the browser paint between steps, as a learner's key presses would.
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    }
    return { total, times };
  });
}

test(`at least ${gates.min_supported_events} events play smoothly, one key per step`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  let played = 0;
  const times: number[] = [];
  for (const route of ROUTES) {
    await page.goto(`./#/${route}/0/protocol`);
    await ready(page);
    const run = await stepThrough(page);
    expect(run.total).toBeGreaterThan(0);
    await expect(status(page, route.startsWith('compare/'))).toHaveText(
      new RegExp(`^Step ${run.total} of ${run.total}`),
    );
    // Compare counts compare steps, which replay the two scenarios already counted.
    if (!route.startsWith('compare/')) played += run.total;
    times.push(...run.times);
  }
  expect(played).toBeGreaterThanOrEqual(gates.min_supported_events);
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
  test.info().annotations.push({
    type: 'timing',
    description: `${played} events, ${times.length} keys, median ${times[times.length >> 1]?.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
  });
  // Smooth: a step is handled well within the 100 ms a learner perceives as instant.
  expect(p95).toBeLessThan(100);
});

// Each step before the route's step has at least two inspector tabs, so the tab keys can move.
const TABS = [
  ['MCP', 'mcp/mcp-balance/15'],
  ['RAG', 'rag/rag-query/9'],
  ['Compare', 'compare/compare-rag-mcp/16'],
  ['Combined', 'combined/combined-balance-explanation/34'],
] as const;

type Stop = { what: string; index: number; visible: boolean; onScreen: boolean };

/**
 * Marks every control a keyboard user must be able to reach: visible, enabled, interactive and
 * in the tab order. A roving group (the inspector's tabs) has one stop, its tabindex 0 member;
 * the content of a closed <details> is not rendered, so only its summary counts.
 */
async function markControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const interactive = [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      'summary',
      '[role="button"]',
      '[role="tab"]',
    ].join(',');
    // Anything else in the tab order (scroll regions, for example) counts too.
    const selector = `${interactive},[tabindex]:not([tabindex="-1"])`;
    /** A tab of a roving group: out of the tab order while another tab of its list is in it. */
    const roving = (el: Element) =>
      el.matches('[role="tab"]') &&
      !!el.closest('[role="tablist"]')?.querySelector('[role="tab"][tabindex="0"]');
    const controls = [...document.querySelectorAll<HTMLElement | SVGElement>(selector)].filter(
      (el) => {
        // An interactive control taken out of the tab order is a finding, unless it is roving.
        if (el.getAttribute('tabindex') === '-1' && roving(el)) return false;
        if (el.matches(':disabled')) return false;
        if (!el.checkVisibility({ visibilityProperty: true })) return false;
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      },
    );
    (window as unknown as { controls: Element[] }).controls = controls;
    return controls.map((el) => {
      const label = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim();
      return `${el.tagName.toLowerCase()} "${label.replace(/\s+/g, ' ').slice(0, 40)}"`;
    });
  });
}

/** Where Tab moves focus, in order, from where focus is until it cycles. */
async function tabOrder(page: Page): Promise<Stop[]> {
  const stops: Stop[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 400; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return undefined;
      // A stable identity for the cycle check: the element's path in the document.
      const path: string[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const index = n.parentElement ? [...n.parentElement.children].indexOf(n) : 0;
        path.unshift(`${n.tagName}${index}`);
      }
      const label = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim();
      const what = `${el.tagName.toLowerCase()} "${label.replace(/\s+/g, ' ').slice(0, 40)}"`;
      // The focus indicator: the 2 px outline of :focus-visible, or, on a diagram group, its
      // frame drawn 2 px in ink.
      const style = getComputedStyle(el);
      const frame = el.matches('.group') ? el.querySelector('.group-frame') : null;
      const visible = frame
        ? getComputedStyle(frame).strokeWidth === '2px'
        : style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
      const box = el.getBoundingClientRect();
      const onScreen =
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < innerHeight &&
        box.left < innerWidth;
      const index = (window as unknown as { controls: Element[] }).controls.indexOf(el);
      return { id: path.join('/'), what, index, visible, onScreen };
    });
    if (!stop || seen.has(stop.id)) break;
    seen.add(stop.id);
    stops.push({
      what: stop.what,
      index: stop.index,
      visible: stop.visible,
      onScreen: stop.onScreen,
    });
  }
  return stops;
}

/** Presses Tab until the focused element matches `selector` (and has `text`, if given). */
async function tabTo(page: Page, selector: string, text?: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await page.keyboard.press('Tab');
    const found = await page.evaluate(
      ([s, t]) => {
        const el = document.activeElement;
        return !!el?.matches(s) && (t === undefined || (el.textContent ?? '').trim() === t);
      },
      [selector, text] as const,
    );
    if (found) return;
  }
  throw new Error(`Tab never reached ${selector}${text ? ` "${text}"` : ''}`);
}

const focused = (page: Page) => page.locator(':focus');

const scrollPositions = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.diagram-scroller')].map((r) => [r.scrollTop, r.scrollLeft]),
  );

for (const [width, height] of [
  [1440, 900],
  [820, 1180],
] as const) {
  test.describe(`keyboard only at ${width} px`, () => {
    test.use({ viewport: { width, height } });

    for (const [tab, route] of TABS) {
      for (const level of ['/architecture', '/protocol']) {
        test(`${tab}${level}: Tab reaches every control with a visible focus, and keys operate them`, async ({
          page,
        }) => {
          // Keyboard only from the moment the page loads: no pointer input at all.
          await page.goto(`./#/${route}${level}`);
          await ready(page);
          const compare = tab === 'Compare';
          const line = status(page, compare);

          // The arrow keys step and Space plays and pauses while nothing has focus.
          const before = (await line.textContent()) ?? '';
          await page.keyboard.press('ArrowLeft');
          await expect(line).not.toHaveText(before);
          await page.keyboard.press('ArrowRight');
          await expect(line).toHaveText(before);
          await page.keyboard.press('ArrowLeft');
          await page.keyboard.press(' ');
          await expect(
            page.getByRole('button', { name: 'Pause', exact: true }).first(),
          ).toBeVisible();
          await page.keyboard.press(' ');
          await expect(
            page.getByRole('button', { name: 'Play', exact: true }).first(),
          ).toBeVisible();

          // Tab reaches every control, each on screen with a visible focus indicator.
          await page.goto(`./#/${route}${level}`);
          await page.reload();
          await ready(page);
          const controls = await markControls(page);
          const stops = await tabOrder(page);
          const reached = new Set(stops.map((s) => s.index));
          expect(controls.filter((_, i) => !reached.has(i))).toEqual([]);
          expect(stops.filter((s) => s.index < 0).map((s) => s.what)).toEqual([]);
          expect(stops.filter((s) => !s.visible).map((s) => s.what)).toEqual([]);
          expect(stops.filter((s) => !s.onScreen).map((s) => s.what)).toEqual([]);

          // Enter on Previous step steps back; the focused icon button shows its name and key.
          await page.reload();
          await ready(page);
          const now = (await line.textContent()) ?? '';
          await tabTo(page, 'button[data-icon="previous"]');
          const label = focused(page).locator('.control-label');
          await expect(label).toHaveText('Previous step (←)');
          expect((await label.boundingBox())?.width ?? 0).toBeGreaterThan(40);
          await page.keyboard.press('Enter');
          await expect(line).not.toHaveText(now);
          if (!compare) {
            await tabTo(page, '[role="tab"][aria-selected="true"]');
            const first = (await focused(page).textContent()) ?? '';
            await page.keyboard.press('ArrowRight');
            await expect(focused(page)).toHaveAttribute('aria-selected', 'true');
            await expect(focused(page)).not.toHaveText(first);
          }

          // Enter expands a diagram group (Architecture).
          if (level === '/architecture') {
            await page.reload();
            await ready(page);
            await tabTo(page, '[data-group][aria-expanded="false"]');
            const key = await focused(page).getAttribute('data-group');
            await page.keyboard.press('Enter');
            await expect(page.locator(`[data-group="${key}"]`).first()).toHaveAttribute(
              'aria-expanded',
              'true',
            );
          }

          // The scenario picker, on RAG only, opens with Enter and a scenario is chosen with Enter.
          if (tab === 'RAG') {
            await page.reload();
            await ready(page);
            const url = page.url();
            await tabTo(page, '.picker summary');
            await page.keyboard.press('Enter');
            await expect(page.locator('.picker')).toHaveAttribute('open', '');
            await tabTo(page, '.picker a:not([aria-current="true"])');
            await page.keyboard.press('Enter');
            await expect.poll(() => page.url()).not.toBe(url);
          }

          // The zoom control: Enter on another level's button zooms there.
          await page.reload();
          await ready(page);
          const other = level === '/architecture' ? 'Protocol' : 'Architecture';
          await tabTo(page, 'button', other);
          await page.keyboard.press('Enter');
          await expect(page.getByRole('button', { name: other, exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
          );
        });
      }
    }
  });
}

test.describe('reduced motion', () => {
  for (const [tab, route] of TABS) {
    test(`${tab}: nothing animates and the diagram jumps to each step at once`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1280, height: 700 });
      await page.goto(`./#/${route}/protocol`);
      await ready(page);
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press(i < 3 ? 'ArrowLeft' : 'ArrowRight');
        const now = await scrollPositions(page);
        await page.waitForTimeout(300);
        // A smooth scroll would still be moving: the regions are already where they end.
        expect(await scrollPositions(page)).toEqual(now);
      }
      // Play runs without any animation or transition anywhere on the page.
      await page.keyboard.press(' ');
      await page.waitForTimeout(1600);
      const moving = await page.evaluate(() => [
        ...document.getAnimations().map((a) => String(a)),
        ...[...document.querySelectorAll('*')]
          .filter((el) => {
            const s = getComputedStyle(el);
            const durations = s.transitionDuration.split(',').map((d) => parseFloat(d));
            return s.animationName !== 'none' || durations.some((d) => d > 0);
          })
          .map((el) => el.tagName),
      ]);
      expect(moving).toEqual([]);
    });
  }
});
