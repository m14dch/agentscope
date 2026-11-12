// 08-acceptance-tests.yaml e2e_tests: phone-steps (issue #50, 02-ui-ux.yaml layout.phone,
// phone_steps, rag_retrieval.projection).
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const SIZES = [
  [390, 844],
  [360, 800],
] as const;

/** Every kept scenario and Compare (02 navigation.tab_contents). */
const PAGES = [
  'mcp/mcp-balance',
  'rag/rag-query',
  'rag/rag-index',
  'combined/combined-balance-explanation',
  'compare/compare-rag-mcp',
] as const;

const LEVELS = ['', '/architecture', '/protocol'] as const;

const rows = (page: Page) => page.locator('.step-row');
const row = (page: Page, text: string | RegExp) =>
  page.locator('.step-item').filter({ has: page.locator('.step-title', { hasText: text }) });

/** Opens a page and waits for its column of steps. */
async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./#/${hash}`);
  await page.locator('.steps-area > *').first().waitFor();
}

/**
 * What breaks the column: anything that scrolls or reaches past the screen sideways, any element
 * other than the page that scrolls vertically, and anything fixed or sticky to the screen.
 */
function problems(page: Page): Promise<string[]> {
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
      if (style.position === 'fixed' || style.position === 'sticky')
        found.push(`${style.position}: ${name(e)}`);
      const box = e.getBoundingClientRect();
      if (!box.width && !box.height) continue;
      if (box.left < -0.5 || box.right > width + 0.5)
        found.push(`outside ${Math.round(box.left)}–${Math.round(box.right)}: ${name(e)}`);
      if (!(e instanceof HTMLElement)) continue;
      if (style.overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1)
        found.push(`scrolls sideways ${e.scrollWidth} > ${e.clientWidth}: ${name(e)}`);
      if (/auto|scroll/.test(style.overflowY) && e.scrollHeight > e.clientHeight + 1)
        found.push(`scrolls ${e.scrollHeight} > ${e.clientHeight}: ${name(e)}`);
    }
    return [...new Set(found)];
  });
}

/** Controls outside running text smaller than 44 × 44 px (02 layout.phone.touch_targets). */
function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const c of document.querySelectorAll(
      'button, a[href], summary, select, input, [role="tab"]',
    )) {
      // Inline controls in a sentence or in code are exempt (WCAG 2.5.8).
      if (
        c.matches('.link, .citation, .balance') ||
        c.closest('.json, .annotated, .visually-hidden')
      )
        continue;
      if (c.closest('p, li.source-line, .travel, .callout')) continue;
      const box = c.getBoundingClientRect();
      if (!box.width && !box.height) continue;
      if (box.width < 44 || box.height < 43.5)
        found.push(
          `${c.tagName} "${(c.textContent ?? '').trim().slice(0, 30)}" ${Math.round(box.width)}×${Math.round(box.height)}`,
        );
    }
    return found;
  });
}

// One sweep over every kept scenario and Compare at every level and both sizes, with every row
// open: it is what finds a payload, panel or label that breaks the column, so it is not reduced
// to one representative page.
for (const [width, height] of SIZES) {
  test.describe(`at ${width} × ${height}`, () => {
    test.use({ viewport: { width, height } });
    for (const hash of PAGES) {
      test(`${hash}: every level reads in one column with every row open`, async ({ page }) => {
        for (const level of LEVELS) {
          await open(page, `${hash}/0${level}`);
          const where = `${hash}${level || '/overview'}`;
          if (level) {
            await page.getByRole('button', { name: 'Open all' }).click();
            const count = await rows(page).count();
            expect(count, where).toBeGreaterThan(0);
            await expect(page.locator('.step-row[aria-expanded="false"]'), where).toHaveCount(0);
            // Every body is shown and says something.
            const empty = await page
              .locator('.step-body')
              .evaluateAll(
                (bodies) =>
                  bodies.filter((b) => (b as HTMLElement).hidden || !(b.textContent ?? '').trim())
                    .length,
              );
            expect(empty, where).toBe(0);
          } else {
            await expect(page.locator('.stage-item').first()).toBeVisible();
            await expect(rows(page), where).toHaveCount(0);
          }
          expect(await problems(page), where).toEqual([]);
        }
      });
    }
  });
}

test.describe('at 390 × 844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('rows name the step, its direction in words, the operation and both participants', async ({
    page,
  }) => {
    await open(page, 'mcp/mcp-balance/0/protocol');
    await expect(rows(page)).toHaveCount(28);
    // No control row, bottom bar, menu or step slider.
    await expect(page.locator('.control-row, .controls, .menu-toggle')).toHaveCount(0);
    await expect(page.getByRole('slider')).toHaveCount(0);
    const call = rows(page).nth(13);
    await expect(call).toHaveAttribute('aria-expanded', 'false');
    await expect(call).toHaveAccessibleName(
      'Step 14 MCP · tools/call (request) MCP client → Example Bank MCP server',
    );
    // The glyph is hidden from assistive technology; the participants line states the direction.
    await expect(call.locator('.step-glyph')).toHaveAttribute('aria-hidden', 'true');
    await expect(call.locator('.step-glyph')).toHaveText('→');
    await expect(rows(page).nth(14).locator('.step-glyph')).toHaveText('±');
    await expect(rows(page).nth(14)).toContainText('Example Bank MCP server · nothing sent');
    await expect(rows(page).nth(14)).toHaveAccessibleName(/\(nothing sent\)/);
    await expect(rows(page).nth(19).locator('.step-glyph')).toHaveText('←');
    await expect(rows(page).nth(19)).toHaveAccessibleName(/\(response\) Core ledger → /);
    // Architecture: one row per group; the Overview: the stages, nothing to open.
    await page.getByRole('button', { name: 'Architecture' }).click();
    await expect(rows(page)).toHaveCount(10);
    await expect(rows(page).last()).toContainText('Answer · 1 step');
    await page.getByRole('button', { name: 'Overview' }).click();
    await expect(page.locator('.stage-item')).toHaveCount(4);
    await expect(page.locator('.stage-item').first()).toContainText('Assistant · Bank systems');
    await expect(page.getByRole('button', { name: 'Open all' })).toBeHidden();
    await expect(page.locator('.headline')).toBeHidden();
  });

  test('rows open and close by touch and keyboard; several stay open; the address follows', async ({
    page,
  }) => {
    await open(page, 'mcp/mcp-balance/0/protocol');
    const second = rows(page).nth(1);
    const third = rows(page).nth(2);
    await second.click();
    await third.click();
    await expect(second).toHaveAttribute('aria-expanded', 'true');
    await expect(third).toHaveAttribute('aria-expanded', 'true');
    await expect(third).toBeFocused();
    await expect(page.locator('#step-3')).toContainText('It carries');
    await expect(page.getByRole('tablist', { name: 'Step 3 details' })).toBeVisible();
    await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/3\/protocol$/);
    // The keyboard: Tab reaches the next row, Enter and Space toggle it, focus stays.
    await rows(page).nth(3).focus();
    await page.keyboard.press('Enter');
    await expect(rows(page).nth(3)).toHaveAttribute('aria-expanded', 'true');
    await expect(rows(page).nth(3)).toBeFocused();
    await expect(page).toHaveURL(/\/4\/protocol$/);
    await page.keyboard.press('Space');
    await expect(rows(page).nth(3)).toHaveAttribute('aria-expanded', 'false');
    // Closing leaves the address; the arrow keys keep their browser meaning.
    await expect(page).toHaveURL(/\/4\/protocol$/);
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/\/4\/protocol$/);
    await page.getByRole('button', { name: 'Close all' }).click();
    await expect(page.locator('.step-row[aria-expanded="true"]')).toHaveCount(0);
    // + and - zoom.
    await page.locator('body').press('-');
    await expect(rows(page)).toHaveCount(10);
    await expect(page).toHaveURL(/\/4\/architecture$/);
  });

  test('a deep link opens its row at the top of the screen; zooming opens the mapped row', async ({
    page,
  }) => {
    await open(page, 'mcp/mcp-balance/17/protocol');
    const get = rows(page).nth(16);
    await expect(get).toHaveAttribute('aria-expanded', 'true');
    await expect(get).toContainText('HTTP · GET');
    expect(Math.abs((await get.boundingBox())?.y ?? 99)).toBeLessThan(2);
    const scroll = await page.evaluate(() => window.scrollY);
    const zoom = page.getByRole('group', { name: 'Zoom' });
    await zoom.getByRole('button', { name: 'Architecture' }).click();
    await expect(zoom.getByRole('button', { name: 'Architecture' })).toBeFocused();
    await expect(page.locator('.step-row[aria-expanded="true"]')).toHaveCount(1);
    await expect(page.locator('.step-row[aria-expanded="true"]')).toContainText('REST backend');
    await expect(page.locator('.phone-intro [aria-live]')).toHaveText('Architecture. 10 groups.');
    // The page does not scroll on a change of level.
    expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(scroll);
    await zoom.getByRole('button', { name: 'Protocol' }).click();
    // Architecture and Protocol keep the event (zoom_levels.cursor_mapping).
    await expect(page).toHaveURL(/\/17\/protocol$/);
    await expect(page.locator('.step-row[aria-expanded="true"]')).toHaveCount(1);
    await expect(rows(page).nth(16)).toHaveAttribute('aria-expanded', 'true');
  });

  test('a prediction prompt comes before its step until "Show the step"', async ({ page }) => {
    await open(page, 'mcp/mcp-balance/0/protocol');
    const call = rows(page).nth(13);
    await call.click();
    const body = page.locator('#step-14');
    await expect(body.locator('.prompt')).toContainText('Who sends the tool call');
    await expect(body.getByRole('tablist')).toHaveCount(0);
    await body.getByRole('button', { name: 'Show the step' }).click();
    await expect(body.getByRole('tablist')).toBeVisible();
    await expect(body.locator('.message')).toBeFocused();
    await expect(body.locator('.prompt')).toBeVisible();
    // Open all shows every step in full, each prompt above it.
    await page.getByRole('button', { name: 'Close all' }).click();
    await page.getByRole('button', { name: 'Open all' }).click();
    const last = page.locator('#step-26');
    await expect(last.locator('.prompt')).toBeVisible();
    await expect(last.getByRole('tablist')).toBeVisible();
    await expect(last.getByRole('button', { name: 'Show the step' })).toHaveCount(0);
  });

  test('panels sit in the rows of their steps; the projection takes its compact form', async ({
    page,
  }) => {
    await open(page, 'rag/rag-query/0/protocol');
    await row(page, 'Apply topK and threshold').locator('.step-row').click();
    await row(page, 'Submit grounded prompt').locator('.step-row').click();
    await row(page, 'Display answer and source references').locator('.step-row').click();
    const select = row(page, 'Apply topK and threshold');
    await expect(
      select.getByRole('heading', { name: 'Why each chunk was kept or dropped' }),
    ).toBeVisible();
    await expect(select.locator('.retrieval-prompt, .retrieval-answer')).toHaveCount(0);
    const prompt = row(page, 'Submit grounded prompt');
    // Its prediction comes first (phone_steps.predictions).
    await prompt.getByRole('button', { name: 'Show the step' }).click();
    await expect(
      prompt.getByRole('heading', { name: 'Prompt before and after retrieval' }),
    ).toBeVisible();
    await prompt.getByRole('button', { name: 'Model context' }).click();
    await expect(prompt.locator('.context-panel')).toBeVisible();
    const answer = row(page, 'Display answer and source references');
    await expect(answer.getByRole('heading', { name: 'Answer', exact: true })).toBeVisible();
    await expect(answer.locator('.retrieval-scores')).toHaveCount(0);
    // A citation opens its evidence inside the row.
    await answer.locator('.citation').first().click();
    await expect(answer.locator('.evidence')).not.toBeEmpty();
    expect(await problems(page)).toEqual([]);

    // The compact projection: only the question labelled at its point, every point listed.
    const projection = select.locator('.retrieval-projection');
    await expect(projection.locator('.point-label')).toHaveText(['question']);
    const items = projection.locator('.projection-list li');
    await expect(items.first()).toHaveText(
      /^account-opening@1\.2 · 001: rules \d\.\d\d, product \d\.\d\d · retained$/,
    );
    expect(await items.count()).toBe(
      await projection.locator('.projection-plot .point:not(.query)').count(),
    );
    await expect(projection.locator('.projection-plot')).toHaveAttribute('aria-hidden', 'true');
    const second = items.nth(1).getByRole('button');
    await second.click();
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(projection.locator('.point-ring')).toHaveCount(1);

    // The Combined answer at c-08, the last step.
    await open(page, 'combined/combined-balance-explanation/35/protocol');
    await expect(
      page
        .locator('#step-35')
        .getByRole('heading', { name: 'Where each part of the answer comes from' }),
    ).toBeVisible();
  });

  test('parameters fold away; a change keeps the open rows of events still played', async ({
    page,
  }) => {
    await open(page, 'rag/rag-query/0/protocol');
    const fold = page.getByRole('button', { name: 'Parameters' });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await row(page, 'Apply topK and threshold').locator('.step-row').click();
    await fold.click();
    await page.getByRole('button', { name: 'Top K 4 chunks' }).click();
    await expect(page.getByRole('button', { name: 'Top K 4 chunks' })).toBeFocused();
    const select = row(page, 'Apply topK and threshold');
    await expect(select.locator('.step-row')).toHaveAttribute('aria-expanded', 'true');
    await expect(select.locator('.step-body')).toContainText('"top_k": 4');
    await page.getByRole('button', { name: 'Keyword retrieval' }).click();
    await expect(row(page, 'Keyword search')).toHaveCount(1);
  });

  test('every control outside running text is at least 44 × 44 px', async ({ page }) => {
    for (const hash of [
      'mcp/mcp-balance/0/protocol',
      'rag/rag-query/0/protocol',
      'combined/combined-balance-explanation/0/architecture',
      'compare/compare-rag-mcp/0/protocol',
    ]) {
      await open(page, hash);
      const fold = page.getByRole('button', { name: 'Parameters' });
      if (await fold.count()) await fold.click();
      await page.getByRole('button', { name: 'Open all' }).click();
      const annotations = page.getByRole('button', { name: 'Annotations' }).first();
      if (await annotations.count()) await annotations.click();
      expect(await smallTargets(page), hash).toEqual([]);
    }
  });

  test('Compare interleaves RAG and MCP by semantic phase, each row marked in text', async ({
    page,
  }) => {
    await open(page, 'compare/compare-rag-mcp/0/protocol');
    const phases = page.locator('.compare-phase h3');
    await expect(phases.first()).toHaveText('Preparation');
    const preparation = page.locator('.compare-phase').first();
    await expect(preparation.locator('.compare-placeholder')).toHaveText(
      'RAG Index built earlier by rag-index.',
    );
    await expect(preparation.locator('.step-lead').first()).toHaveText('MCP');
    const request = page.locator('.compare-phase').nth(1);
    await expect(request.locator('.step-lead')).toHaveText(['RAG', 'MCP']);
    await request.locator('.step-row').first().click();
    await expect(request.getByRole('link', { name: 'Inspect step 1 in RAG' })).toHaveAttribute(
      'href',
      '#/rag/rag-query/1/protocol',
    );
    // A change of level keeps the compare step in the address.
    await page.getByRole('button', { name: 'Overview' }).click();
    await expect(page).toHaveURL(/#\/compare\/compare-rag-mcp\/0$/);
    await expect(page.locator('.compare-aspects')).toBeHidden();
  });

  test('with reduced motion nothing animates while rows open', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'mcp/mcp-balance/14/protocol');
    await page.getByRole('button', { name: 'Open all' }).click();
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });
});

test('from 48rem the diagram and the control row are unchanged; crossing it lays out again', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.goto('./#/mcp/mcp-balance/14/protocol');
  await page.locator('[data-measured] svg.diagram').waitFor();
  await expect(page.locator('.control-row')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Step details' })).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows(page)).toHaveCount(28);
  await expect(rows(page).nth(13)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('svg.diagram')).toHaveCount(0);
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.locator('[data-measured] svg.diagram').waitFor();
  await expect(page.locator('.control-row .status')).toHaveText(/^Step 14 of 28/);
});
