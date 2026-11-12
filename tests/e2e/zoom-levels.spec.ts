// 08-acceptance-tests.yaml e2e_tests: zoom-levels (issue #51, 02-ui-ux.yaml zoom_levels).
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const status = (page: Page) => page.locator('.control-row .status, .controls .status').first();
const zoom = (page: Page) => page.getByRole('group', { name: 'Zoom', exact: true });
const level = (page: Page, name: string) => zoom(page).getByRole('button', { name, exact: true });
const announcer = (page: Page) => page.locator('.control-row > [aria-live="polite"]');
/** What the page shows below the header: the tabs name MCP and RAG, the content must not. */
const content = (page: Page) => page.locator('.shell-content');
const PROTOCOL = /\b(MCP|HTTP|JSON-RPC|LLM API|REST|tools\/call)\b/;

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./${hash}`);
  await page.locator('[data-measured]').first().waitFor();
}

test('a first-time visitor sees the Overview of mcp-balance before any protocol name', async ({
  page,
}) => {
  await open(page, '');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/0$/);
  await expect(level(page, 'Overview')).toHaveAttribute('aria-pressed', 'true');
  const diagram = page.locator('svg.diagram');
  await expect(diagram).toHaveAttribute('aria-label', /overview, before the first stage/);
  await expect(page.getByRole('list', { name: 'Parties' }).locator('.participant')).toHaveText([
    'You',
    'Assistant',
    'Bank systems',
  ]);
  await expect(page.locator('.inspector')).toContainText('Next runs the first stage.');
  await expect(page.locator('[data-stage]')).toHaveCount(4);
  await expect(status(page)).toHaveText('Stage 0 of 4');
  // Nothing in the page names a protocol: no headline, step details or panels at the Overview.
  expect(await content(page).innerText()).not.toMatch(PROTOCOL);
  // Next moves stage by stage; the message is the stage's sentence, still without a protocol.
  const next = page.getByRole('button', { name: 'Next step' });
  for (let s = 1; s <= 4; s += 1) {
    await next.click();
    await expect(status(page)).toHaveText(`Stage ${s} of 4`);
    await expect(page.locator('[data-stage][data-current]')).toHaveCount(1);
    const sentence =
      (await page.locator('[data-stage][data-current] .stage-sentence').textContent()) ?? '';
    await expect(page.locator('.inspector .message:visible')).toHaveText(
      sentence.replace(/\s+/g, ' ').trim(),
    );
    expect(await content(page).innerText()).not.toMatch(PROTOCOL);
  }
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/28$/);
  await page.getByRole('button', { name: 'Previous step' }).click();
  await expect(status(page)).toHaveText('Stage 3 of 4');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/24$/);
});

test('zooming in and out keeps the place, by button and by key, and is announced', async ({
  page,
}) => {
  // Stage 3 of mcp-balance: the model's tool request (event 10) to the tool result (event 24).
  await open(page, '#/mcp/mcp-balance/24');
  await expect(status(page)).toHaveText('Stage 3 of 4');
  // In: the first event of the stage.
  await page.keyboard.press('+');
  await expect(level(page, 'Architecture')).toHaveAttribute('aria-pressed', 'true');
  await expect(status(page)).toHaveText('Step 10 of 28 · Model chooses a tool; agent validates');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/10\/architecture$/);
  await expect(announcer(page)).toHaveText(
    'Architecture. Step 10 of 28 · Model chooses a tool; agent validates.',
  );
  await expect(page.locator('[data-group="planning"]')).toHaveAttribute('aria-expanded', 'true');
  // Architecture and Protocol keep the event.
  await page.keyboard.press('=');
  await expect(status(page)).toHaveText('Step 10 of 28 · Model chooses a tool; agent validates');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/10\/protocol$/);
  await page.getByRole('slider', { name: 'Step', exact: true }).fill('14');
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await expect(status(page)).toHaveText('Step 14 of 28 · MCP tool call');
  await page.keyboard.press('-');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/14\/architecture$/);
  // Out: the end of the stage holding the event.
  await page.keyboard.press('-');
  await expect(status(page)).toHaveText('Stage 3 of 4');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/24$/);
  await expect(announcer(page)).toHaveText('Overview. Stage 3 of 4.');
  // Past either end nothing changes.
  await page.keyboard.press('-');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/24$/);
  // By button, straight to Protocol, focus staying on the control. At step 0 the place is 0.
  await page.getByRole('button', { name: 'Previous step' }).click();
  await page.getByRole('button', { name: 'Previous step' }).click();
  await expect(status(page)).toHaveText('Stage 1 of 4');
  await level(page, 'Protocol').click();
  await expect(status(page)).toHaveText('Step 1 of 28 · Client setup and optional discovery');
  await expect(level(page, 'Protocol')).toBeFocused();
  await page.getByRole('button', { name: 'Reset' }).click();
  await level(page, 'Overview').click();
  await expect(status(page)).toHaveText('Stage 0 of 4');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/0$/);
});

test('deep links open each level; an old link without a level opens the stage holding its step', async ({
  page,
}) => {
  await open(page, '#/mcp/mcp-balance/14');
  await expect(status(page)).toHaveText('Stage 3 of 4');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/24$/);
  // /overview names the Overview too, and is written without a level.
  await open(page, '#/mcp/mcp-balance/3/overview');
  await expect(status(page)).toHaveText('Stage 1 of 4');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/8$/);
  await open(page, '#/rag/rag-index/4/architecture');
  await expect(level(page, 'Architecture')).toHaveAttribute('aria-pressed', 'true');
  await expect(status(page)).toHaveText('Step 4 of 10 · Chunk');
  await open(page, '#/combined/combined-balance-explanation/20/protocol');
  await expect(level(page, 'Protocol')).toHaveAttribute('aria-pressed', 'true');
  await expect(status(page)).toHaveText(/^Step 20 of 35 · /);
  // Reloading keeps the level and the place.
  await page.reload();
  await page.locator('[data-measured]').first().waitFor();
  await expect(status(page)).toHaveText(/^Step 20 of 35 · /);
  await expect(page).toHaveURL(/\/20\/protocol$/);
});

test('every tab offers the three levels; Compare tells both stories stage by stage', async ({
  page,
}) => {
  for (const tab of ['rag', 'combined']) {
    await open(page, `#/${tab}`);
    await expect(zoom(page).getByRole('button')).toHaveText([
      'Overview',
      'Architecture',
      'Protocol',
    ]);
    await expect(page.locator('[data-stage]').first()).toBeVisible();
  }
  await open(page, '#/compare');
  await expect(zoom(page).getByRole('button')).toHaveText(['Overview', 'Architecture', 'Protocol']);
  // A plain heading and no aspects at the Overview: nothing in the content names a protocol
  // but the panes' own names (02 compare_view.layout).
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(/^Two assistants answer/);
  await expect(page.locator('.compare-aspects')).toBeHidden();
  const shared = page.locator('.compare-status');
  await expect(shared).toHaveText('Stage 0 of 4');
  const rag = page.getByRole('region', { name: 'RAG', exact: true });
  const mcp = page.getByRole('region', { name: 'MCP', exact: true });
  await page.getByRole('button', { name: 'Next step' }).click();
  // Preparation: MCP learns the bank's actions; RAG's index was built earlier.
  await expect(shared).toHaveText('Stage 1 of 4 · Preparation');
  await expect(rag.locator('.compare-message')).toHaveText('Index built earlier by rag-index.');
  await expect(mcp.locator('.compare-position p')).toHaveText('Stage 1 of 4');
  await expect(mcp.getByRole('link', { name: 'Inspect in MCP' })).toBeVisible();
  await page.getByRole('button', { name: 'Next step' }).click();
  await page.getByRole('button', { name: 'Next step' }).click();
  // Both look up their information in the same compare step; the address counts events.
  await expect(shared).toHaveText('Stage 3 of 4 · Information acquisition');
  await expect(page).toHaveURL(/#\/compare\/compare-rag-mcp\/14$/);
  await expect(rag.locator('.compare-position p')).toHaveText('Stage 2 of 3');
  await expect(mcp.locator('.compare-position p')).toHaveText('Stage 3 of 4');
  await expect(rag.locator('[data-stage][data-current]')).toHaveAttribute('data-stage', 'search');
  await expect(mcp.locator('[data-stage][data-current]')).toHaveAttribute('data-stage', 'fetch');
  // Zooming in keeps RAG's place: the first event of its search stage, MCP in the same phase;
  // only the control row announces it.
  const live = page.locator('.compare-phase-line [aria-live="polite"]');
  const said = await live.textContent();
  await page.keyboard.press('+');
  await expect(page).toHaveURL(/#\/compare\/compare-rag-mcp\/\d+\/architecture$/);
  await expect(rag.locator('.compare-position p')).toHaveText('Step 2 of 10 · Embed query');
  await expect(shared).toHaveText(/^Step \d+ of 28 · Information acquisition$/);
  await expect(announcer(page)).toHaveText(/^Architecture\. Step \d+ of 28/);
  await expect(live).toHaveText(said ?? '');
  await expect(page.locator('.compare-aspects')).toBeVisible();
  await page.keyboard.press('-');
  await expect(shared).toHaveText('Stage 3 of 4 · Information acquisition');
  // The answer stage covers three semantic phases, and says so.
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(shared).toHaveText('Stage 4 of 4 · Context assembly to Answer');
  await expect(page.locator('.compare-phases [aria-current="step"]')).toHaveText([
    'Context assembly',
    'Model generation',
    'Answer',
  ]);
  // An old address without a level, which meant Architecture, opens the stage holding its step.
  await open(page, '#/compare/compare-rag-mcp/16');
  await expect(shared).toHaveText('Stage 3 of 4 · Information acquisition');
  await expect(page).toHaveURL(/#\/compare\/compare-rag-mcp\/14$/);
});

test('at Architecture the current group starts in view together with its step', async ({
  page,
}) => {
  // 02 zoom_levels.scrolling: from the end, back to the first step of the backend group (event
  // 17). The step alone is already in view there; the group's takeaway above it is not, unless
  // the region shows the group's start too.
  await page.setViewportSize({ width: 1280, height: 720 });
  // Without motion the region jumps at once, so each position is final.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '#/mcp/mcp-balance/0/architecture');
  const slider = page.getByRole('slider', { name: 'Step', exact: true });
  await slider.fill('28');
  await expect(status(page)).toHaveText('Step 28 of 28 · Answer');
  await expect
    .poll(() => page.locator('.workspace .diagram-pane').evaluate((r) => r.scrollTop))
    .toBeGreaterThan(0);
  await slider.fill('17');
  await expect(status(page)).toHaveText('Step 17 of 28 · REST backend');
  const region = page.locator('.workspace .diagram-pane');
  await expect
    .poll(async () => {
      const [box, group, step, header] = await Promise.all([
        region.boundingBox(),
        page.locator('.group[data-current] .group-frame').boundingBox(),
        page.locator('.step[data-current]').boundingBox(),
        page.locator('.diagram-head').boundingBox(),
      ]);
      if (!box || !group || !step || !header) return false;
      return group.y >= header.y + header.height - 1 && step.y + step.height <= box.y + box.height;
    })
    .toBe(true);
});

for (const width of [1440, 390]) {
  test(`axe finds no serious issue on the Overview at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const hash of ['#/mcp', '#/rag', '#/compare/compare-rag-mcp/3']) {
      await open(page, hash);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const blocking = results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${hash}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
      expect(blocking).toEqual([]);
    }
  });
}
