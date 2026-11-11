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
  'mcp/mcp-resources',
  'mcp/mcp-not-found',
  'mcp/mcp-unauthorized',
  'mcp/mcp-jsonrpc-error',
  'mcp/mcp-multiple-tools',
  'rag/rag-query',
  'rag/rag-index',
  'rag/rag-stale',
  'rag/rag-no-match',
  'rag/rag-conflict',
  'rag/rag-hybrid',
  'rag/rag-prompt-injection',
  'compare/compare-rag-mcp',
  'combined/combined-balance-explanation',
  'combined/combined-missing-terms',
];

/** The step status: Compare's own above its panes' (each pane has a status too). */
const status = (page: Page, compare: boolean) =>
  page.locator(compare ? '.compare-status' : '.status').first();

async function ready(page: Page): Promise<void> {
  await page.locator('[data-measured]').first().waitFor();
}

/**
 * Steps from the start to the last step with → and returns how long each key took to handle,
 * rendering and layout included (the app renders synchronously on the key). A prediction
 * prompt takes one more key.
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

const TABS = [
  ['MCP', 'mcp/mcp-balance/12'],
  ['RAG', 'rag/rag-query/10'],
  ['Compare', 'compare/compare-rag-mcp/16'],
  ['Combined', 'combined/combined-balance-explanation/35'],
] as const;

type Stop = { what: string; visible: boolean; onScreen: boolean };

/** Where Tab moves focus, in order, from the top of the page until it cycles. */
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
      return { id: path.join('/'), what, visible, onScreen };
    });
    if (!stop || seen.has(stop.id)) break;
    seen.add(stop.id);
    stops.push({ what: stop.what, visible: stop.visible, onScreen: stop.onScreen });
  }
  return stops;
}

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
      for (const mode of ['', '/protocol']) {
        test(`${tab}${mode}: Tab reaches every control with a visible focus and the keys step`, async ({
          page,
        }) => {
          await page.goto(`./#/${route}${mode}`);
          await ready(page);
          const stops = await tabOrder(page);
          const names = stops.map((s) => s.what);
          // The controls a learner needs are all reachable.
          for (const label of ['MCP', 'RAG', 'Compare', 'Combined', 'Next', 'Previous', 'Play'])
            expect(
              names.some((n) => n.includes(`"${label}`)),
              label,
            ).toBe(true);
          expect(
            names.some((n) => n.startsWith('input')),
            'step slider',
          ).toBe(true);
          if (tab !== 'Compare')
            expect(
              names.some((n) => n.includes('"Payload')),
              'inspector tab',
            ).toBe(true);
          expect(stops.filter((s) => !s.visible).map((s) => s.what)).toEqual([]);
          expect(stops.filter((s) => !s.onScreen).map((s) => s.what)).toEqual([]);

          // The keys step wherever focus does not need them itself.
          const line = status(page, tab === 'Compare');
          const before = (await line.textContent()) ?? '';
          await page.locator('body').click({ position: { x: 1, y: 1 } });
          await page.keyboard.press('ArrowLeft');
          await expect(line).not.toHaveText(before);
          // Enter on the focused Next button steps forward again.
          await page.getByRole('button', { name: 'Next', exact: true }).first().focus();
          await page.keyboard.press('Enter');
          await expect(line).toHaveText(before);
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
      await page.locator('body').click({ position: { x: 1, y: 1 } });
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
