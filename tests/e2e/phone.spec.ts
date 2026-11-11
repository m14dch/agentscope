// 08-acceptance-tests.yaml e2e_tests: phone-layout (issue #30, 02-ui-ux.yaml layout.phone,
// diagram.phone_list, rag_retrieval.projection).
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

test.describe.configure({ timeout: 240_000 });

const SIZES = [
  [390, 844],
  [360, 800],
] as const;

/** Every scenario of the MCP, RAG and Combined tabs (02 navigation.tab_contents). */
const SCENARIOS = [
  ['mcp', 'mcp-balance'],
  ['mcp', 'mcp-not-found'],
  ['mcp', 'mcp-unauthorized'],
  ['mcp', 'mcp-jsonrpc-error'],
  ['mcp', 'mcp-multiple-tools'],
  ['mcp', 'mcp-resources'],
  ['rag', 'rag-query'],
  ['rag', 'rag-index'],
  ['rag', 'rag-stale'],
  ['rag', 'rag-no-match'],
  ['rag', 'rag-conflict'],
  ['rag', 'rag-hybrid'],
  ['rag', 'rag-prompt-injection'],
  ['combined', 'combined-balance-explanation'],
  ['combined', 'combined-missing-terms'],
] as const;

const bar = (page: Page) => page.getByRole('group', { name: /^Playback/ });
const list = (page: Page) => page.locator('.diagram-scroller[data-presentation="list"]');

/**
 * Everything that scrolls or reaches past the screen sideways: the page, any element whose
 * content is wider than its box (scrolling or clipped), and any element outside the viewport.
 */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const found: string[] = [];
    const name = (e: Element): string =>
      `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}.${[...e.classList].join('.')} "${(e.textContent ?? '').trim().slice(0, 40)}"`;
    if (document.documentElement.scrollWidth > width)
      found.push(`page ${document.documentElement.scrollWidth} > ${width}`);
    for (const e of document.body.querySelectorAll('*')) {
      if (e.closest('.visually-hidden')) continue;
      const style = getComputedStyle(e);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const box = e.getBoundingClientRect();
      if (!box.width && !box.height) continue;
      if (box.left < -0.5 || box.right > width + 0.5)
        found.push(`outside ${Math.round(box.left)}–${Math.round(box.right)}: ${name(e)}`);
      if (
        e instanceof HTMLElement &&
        style.overflowX !== 'visible' &&
        e.scrollWidth > e.clientWidth + 1
      )
        found.push(`scrolls ${e.scrollWidth} > ${e.clientWidth}: ${name(e)}`);
    }
    return [...new Set(found)];
  });
}

async function goTo(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

/** Opens a disclosure button if it is shown and closed. */
async function expand(control: Locator): Promise<void> {
  if ((await control.count()) && (await control.getAttribute('aria-expanded')) === 'false')
    await control.click();
}

for (const [width, height] of SIZES) {
  test.describe(`at ${width} × ${height}`, () => {
    test.use({ viewport: { width, height }, hasTouch: true });

    for (const [tab, id] of SCENARIOS) {
      test(`${id}: no horizontal scrolling at any step in either mode, every step readable`, async ({
        page,
      }) => {
        await page.goto(`./#/${tab}/${id}/0/protocol`);
        await list(page).and(page.locator('[data-measured]')).waitFor();
        const n = Number(
          await page.getByRole('slider', { name: 'Step', exact: true }).getAttribute('max'),
        );
        await expand(page.getByRole('button', { name: 'Model context' }));
        for (let k = 0; k <= n; k += 1) {
          await goTo(page, `#/${tab}/${id}/${k}/protocol`);
          await expect(page.locator('.controls .status')).toHaveText(
            new RegExp(`^Step ${k} of ${n}( ·|$)`),
          );
          await expand(page.getByRole('button', { name: 'Step details' }));
          expect(await overflow(page), `${id} step ${k} protocol`).toEqual([]);
          if (k === 0) continue;
          // The step list: every reached step names its sender and receiver; the current one
          // is the last row, emphasized and inside its region.
          const rows = list(page).locator('.row');
          await expect(rows).toHaveCount(k);
          const current = list(page).locator('.row[data-current]');
          await expect(current).toHaveClass(/row--emphasized/);
          await expect(current.locator('.row-route')).toContainText(/\S to \S/);
          await expect(current.locator('.row-arrow')).toHaveCount(1);
          const region = await list(page).boundingBox();
          await expect
            .poll(
              async () => {
                const box = await current.boundingBox();
                return (
                  !!box &&
                  !!region &&
                  box.y >= region.y - 1 &&
                  box.y + box.height <= region.y + region.height + 1
                );
              },
              { message: `${id} step ${k}: current row in view` },
            )
            .toBe(true);
          // The message, its participants and the payload are readable.
          const inspector = page.getByRole('complementary', { name: 'Current step' });
          await expect(inspector.locator('.message')).not.toBeEmpty();
          await expect(inspector.locator('.message + .small')).toContainText('→');
          if (await page.getByRole('tab', { name: 'Payload' }).count())
            await expect(page.locator('.tab-panel')).toBeVisible();
        }
        // Architecture mode at the last step, every group expanded.
        await goTo(page, `#/${tab}/${id}/${n}`);
        await expect(list(page).locator('.phase').first()).toBeVisible();
        for (let i = await list(page).locator('.phase-toggle').count(); i > 0; i -= 1) {
          const closed = list(page).locator('.phase-toggle[aria-expanded="false"]').first();
          if (!(await closed.count())) break;
          await closed.click();
        }
        await expect(list(page).locator('.phase-toggle[aria-expanded="false"]')).toHaveCount(0);
        await expect(list(page).locator('.phase--current')).toHaveCount(1);
        await expect(list(page).locator('svg.diagram')).toHaveCount(0);
        expect(await overflow(page), `${id} architecture`).toEqual([]);
      });
    }

    test('Compare: both panes use the step list and nothing scrolls sideways', async ({ page }) => {
      for (const mode of ['', '/protocol']) {
        await page.goto(`./#/compare/compare-rag-mcp/0${mode}`);
        await expect(page.locator('[data-presentation="list"][data-measured]')).toHaveCount(2);
        const n = Number(
          await page.getByRole('slider', { name: 'Compare step' }).getAttribute('max'),
        );
        for (let k = 0; k <= n; k += 1) {
          await goTo(page, `#/compare/compare-rag-mcp/${k}${mode}`);
          await expect(page.locator('.controls .compare-status')).toHaveText(
            new RegExp(`^Step ${k} of ${n}`),
          );
          expect(await overflow(page), `compare ${k}${mode}`).toEqual([]);
        }
        await expect(page.locator('svg.diagram')).toHaveCount(0);
      }
    });
  });
}

test.describe('at 390 × 844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('Previous, Play/Pause and Next stay in reach while stepping through the longest scenario', async ({
    page,
  }) => {
    await page.goto('./#/mcp/mcp-multiple-tools/0/protocol');
    await list(page).and(page.locator('[data-measured]')).waitFor();
    const n = 40;
    const scrollY = await page.evaluate(() => window.scrollY);
    const status = page.locator('.controls .status');
    for (let guard = 0; guard < 2 * n; guard += 1) {
      for (const name of ['Previous', /^(Play|Pause)$/, 'Next'] as const) {
        const control = bar(page).getByRole('button', { name, exact: typeof name === 'string' });
        const box = await control.boundingBox();
        expect(box, `${String(name)} has a box`).not.toBeNull();
        if (!box) continue;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(844);
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        // Nothing covers it: the control itself is hit at its centre.
        const hit = await page.evaluate(
          ([x, y]) => document.elementFromPoint(x as number, y as number)?.textContent ?? '',
          [box.x + box.width / 2, box.y + box.height / 2],
        );
        expect(hit).toMatch(typeof name === 'string' ? name : /^(Play|Pause)$/);
      }
      if ((await status.textContent())?.startsWith(`Step ${n} of ${n}`)) break;
      // Next shows a prediction prompt first, then runs the step (02 learning.prediction_rules).
      await bar(page).getByRole('button', { name: 'Next', exact: true }).click();
    }
    await expect(status).toHaveText(new RegExp(`^Step ${n} of ${n}`));
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    // Play and Pause from the bar.
    await bar(page).getByRole('button', { name: 'Previous', exact: true }).click();
    await bar(page).getByRole('button', { name: 'Play', exact: true }).click();
    await expect(status).toHaveText(new RegExp(`^Step ${n} of ${n}`));
  });

  test('the menu holds the picker, the view switch, the speeds, Start and Reset; targets are 44 px', async ({
    page,
  }) => {
    await page.goto('./#/rag/rag-query/10');
    await list(page).and(page.locator('[data-measured]')).waitFor();
    await expand(page.getByRole('button', { name: 'Step details' }));
    await expand(page.getByRole('button', { name: 'Model context' }));
    const menu = page.getByRole('button', { name: 'Menu' });
    // Closed, the menu hides its controls; the tabs and the statement stay visible.
    await expect(page.getByRole('group', { name: 'View', exact: true })).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
    await expect(page.getByText('Everything here is simulated.')).toBeVisible();
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    const body = page.locator('#menu');
    await expect(body.getByRole('group', { name: 'View', exact: true })).toBeVisible();
    await expect(body.getByRole('group', { name: 'Speed', exact: true })).toBeVisible();
    await expect(body.getByRole('button', { name: 'Start' })).toBeVisible();
    await expect(body.getByRole('button', { name: 'Reset' })).toBeVisible();
    await expect(body.getByRole('link', { name: 'Ingest and index documents' })).toBeVisible();
    expect(await overflow(page)).toEqual([]);
    // Every control outside running text is at least 44 × 44 px (02 layout.phone.touch_targets).
    const small = await page.evaluate(() => {
      const found: string[] = [];
      const controls = document.querySelectorAll(
        'button, a[href], summary, select, input, [role="tab"], [tabindex="0"]',
      );
      for (const c of controls) {
        // Inline controls in a sentence or in code are exempt (WCAG 2.5.8).
        if (c.matches('.link, .citation, .balance') || c.closest('.json, .visually-hidden'))
          continue;
        if (c.matches('.diagram-scroller, .tab-panel, [role="region"], h2, h3')) continue;
        const box = c.getBoundingClientRect();
        if (!box.width && !box.height) continue;
        if (box.width < 44 || box.height < 43.5)
          found.push(
            `${c.tagName} "${(c.textContent ?? '').trim().slice(0, 30)}" ${Math.round(box.width)}×${Math.round(box.height)}`,
          );
      }
      return found;
    });
    expect(small).toEqual([]);
    // The view switch works from the menu and keeps the step.
    await body.getByRole('button', { name: 'Protocol' }).click();
    await expect(list(page).locator('.row[data-current]')).toHaveCount(1);
    await expect(page).toHaveURL(/#\/rag\/rag-query\/10\/protocol$/);
    // Escape closes the menu and returns focus to it.
    await body.getByRole('button', { name: 'Architecture' }).focus();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeFocused();
    // Keys still step the scenario (02 layout.phone.input).
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.controls .status')).toHaveText(/^Step 9 of 10/);
  });

  test('step details fold and stay as left while stepping; the prediction prompt comes first', async ({
    page,
  }) => {
    await page.goto('./#/mcp/mcp-balance/13/protocol');
    await list(page).and(page.locator('[data-measured]')).waitFor();
    const toggle = page.getByRole('button', { name: 'Step details' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('tablist', { name: 'Step details' })).toBeHidden();
    await toggle.click();
    await expect(page.getByRole('tablist', { name: 'Step details' })).toBeVisible();
    await bar(page).getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Step details' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // A prediction prompt sits above the step's message.
    for (let i = 0; i < 20 && !(await page.locator('.prediction').count()); i += 1)
      await bar(page).getByRole('button', { name: 'Next', exact: true }).click();
    const prompt = await page.locator('.prediction').boundingBox();
    const message = await page.locator('.inspector .message').boundingBox();
    expect(prompt && message && prompt.y + prompt.height <= message.y).toBe(true);
  });

  test('architecture groups expand from the step list by touch and keyboard', async ({ page }) => {
    await page.goto('./#/mcp/mcp-balance/14');
    await list(page).and(page.locator('[data-measured]')).waitFor();
    const group = list(page).locator('[data-group="tool"]');
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await group.tap();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(list(page).locator('.phase--current .row[data-current]')).toHaveCount(1);
    await group.focus();
    await page.keyboard.press('Enter');
    await expect(list(page).locator('[data-group="tool"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(list(page).locator('[data-group="tool"]')).toBeFocused();
    // Stepping keeps focus on the same group.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.controls .status')).toHaveText(/^Step 15 of 28/);
    await expect(list(page).locator('[data-group="tool"]')).toBeFocused();
  });

  test('the RAG projection takes its compact form: the question labelled, every point listed', async ({
    page,
  }) => {
    await page.goto('./#/rag/rag-query/10');
    await list(page).and(page.locator('[data-measured]')).waitFor();
    const projection = page.locator('.retrieval-projection');
    await expect(projection.locator('.point-label')).toHaveText(['question']);
    const items = projection.locator('.projection-list li');
    await expect(items.first()).toHaveText(
      /^account-opening@1\.2 · 001: rules \d\.\d\d, product \d\.\d\d · retained$/,
    );
    expect(await items.count()).toBe(
      await projection.locator('.projection-plot .point:not(.query)').count(),
    );
    await expect(projection.locator('.projection')).not.toHaveAttribute('role', 'region');
  });
});

test('from 48rem the diagram and the controls are unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.goto('./#/mcp/mcp-balance/14/protocol');
  await page.locator('[data-measured] svg.diagram').waitFor();
  await expect(page.getByRole('button', { name: 'Menu' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Step details' })).toBeHidden();
  await expect(page.getByRole('tablist', { name: 'Step details' })).toBeVisible();
  const controls = page.getByRole('group', { name: 'Playback' });
  await expect(controls.getByRole('button')).toHaveText([
    'Start',
    'Previous',
    'Play',
    'Next',
    'Reset',
    '0.5×',
    '1×',
    '2×',
    '4×',
  ]);
  expect(await controls.evaluate((e) => getComputedStyle(e).position)).toBe('static');
  // Narrowing to a phone moves the controls; widening puts them back in place.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list(page)).toBeVisible();
  await expect(controls.getByRole('button')).toHaveText(['Previous', 'Play', 'Next']);
  await page.setViewportSize({ width: 768, height: 1000 });
  await expect(page.locator('svg.diagram')).toBeVisible();
  await expect(controls.getByRole('button')).toHaveCount(9);
  await expect(page.locator('.timeline .status')).toHaveText(/^Step 14 of 28/);
});
