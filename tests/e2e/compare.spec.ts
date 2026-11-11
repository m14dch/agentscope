// 08-acceptance-tests.yaml e2e_tests: compare-sync (issue #16, 02-ui-ux.yaml compare_view).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

type Phase = { id: string; label: string; semantic_phase?: string };
const read = (file: string) => parse(readFileSync(`specifications/${file}`, 'utf8'));
const comparison = read('06-comparison-scenarios.yaml') as {
  semantic_phases: Phase[];
  compare: { phase_mapping: Record<string, Record<string, string>> };
};
const scenarios = [
  ...(read('04-mcp-scenarios.yaml') as { scenarios: { id: string; phases: Phase[] }[] }).scenarios,
  ...(read('05-rag-scenarios.yaml') as { scenarios: { id: string; phases: Phase[] }[] }).scenarios,
];
const semanticLabel = new Map(comparison.semantic_phases.map((p) => [p.id, p.label]));

/** Scenario phase label → semantic phase label, from the specification, per scenario. */
function semanticOf(scenario: string): Map<string, string> {
  const phases = scenarios.find((s) => s.id === scenario)?.phases ?? [];
  const mapping = comparison.compare.phase_mapping[scenario] ?? {};
  return new Map(
    phases.map((p) => [p.label, semanticLabel.get(mapping[p.id] ?? '') ?? `unmapped ${p.id}`]),
  );
}
const ragPhases = semanticOf('rag-query');
const mcpPhases = semanticOf('mcp-balance');

const rag = (page: Page) => page.getByRole('region', { name: 'RAG', exact: true });
const mcp = (page: Page) => page.getByRole('region', { name: 'MCP', exact: true });
// The compare step's line; on phones it moves into the bottom bar (02 layout.phone.controls).
const status = (page: Page) => page.locator('.compare-status');

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./${hash}`);
  await expect(page.locator('[data-measured] svg.diagram')).toHaveCount(2);
}

/** The semantic phase a pane shows: from its step's own scenario phase, or its placeholder. */
async function paneSemantic(pane: Locator, phases: Map<string, string>): Promise<string> {
  const position = (await pane.locator('.compare-position p').textContent()) ?? '';
  const label = position.split(' · ')[1];
  return label === undefined ? 'none' : (phases.get(label) ?? `unknown ${label}`);
}

/** The shared phase from "Step <s> of <m> · <phase>". */
async function sharedPhase(page: Page): Promise<string> {
  return ((await status(page).textContent()) ?? '').split(' · ')[1] ?? 'none';
}

test('compare-sync: Next keeps both panes on the same semantic phase, with the RAG placeholder', async ({
  page,
}) => {
  await open(page, '#/compare');
  await expect(page).toHaveURL(/#\/compare\/compare-rag-mcp\/0$/);
  // The Overview steps by stage (zoom-levels.spec.ts); every event is stepped at Architecture.
  await page.getByRole('button', { name: 'Architecture', exact: true }).click();
  await expect(status(page)).toHaveText('Step 0 of 28');
  const next = page.getByRole('button', { name: 'Next' });
  for (let s = 1; s <= 28; s += 1) {
    await next.click();
    await expect(status(page)).toHaveText(new RegExp(`^Step ${s} of 28 · `));
    await expect(page).toHaveURL(new RegExp(`#/compare/compare-rag-mcp/${s}/architecture$`));
    const phase = await sharedPhase(page);
    await expect(page.locator('.compare-phases [aria-current="step"]')).toHaveText(phase);
    expect(await paneSemantic(mcp(page), mcpPhases), `MCP at compare step ${s}`).toBe(phase);
    if (phase === 'Preparation') {
      // RAG has nothing in preparation: it names no step of its own and says why.
      await expect(rag(page).locator('.compare-message')).toHaveText(
        'Index built earlier by rag-index.',
      );
      await expect(rag(page).locator('.compare-position p')).toHaveText(
        'No step in Preparation · 0 of 10 played',
      );
      await expect(rag(page).locator('[data-current]')).toHaveCount(0);
    } else {
      expect(await paneSemantic(rag(page), ragPhases), `RAG at compare step ${s}`).toBe(phase);
    }
  }
  await expect(status(page)).toHaveText('Step 28 of 28 · Answer');
  await expect(rag(page).locator('.compare-position p')).toHaveText('Step 10 of 10 · Answer');
  await expect(mcp(page).locator('.compare-position p')).toHaveText('Step 28 of 28 · Answer');
});

test('compare-sync: stepping either pane moves the other to the same semantic phase', async ({
  page,
}) => {
  await open(page, '#/compare/compare-rag-mcp/16/architecture');
  // RAG has finished information acquisition while MCP continues.
  await expect(status(page)).toHaveText('Step 16 of 28 · Information acquisition');
  await expect(rag(page).locator('.compare-done')).toHaveText(
    'Done with information acquisition; MCP continues.',
  );
  // The RAG pane's own slider: its next step is in context assembly, so MCP follows.
  const ragSlider = page.getByRole('slider', { name: 'RAG step' });
  await ragSlider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(status(page)).toHaveText('Step 25 of 28 · Context assembly');
  await expect(ragSlider).toHaveValue('7');
  expect(await paneSemantic(mcp(page), mcpPhases)).toBe('Context assembly');
  await expect(ragSlider).toBeFocused();
  // The MCP pane's own slider, back into preparation: RAG returns to its placeholder.
  await page.getByRole('slider', { name: 'MCP step' }).fill('4');
  await expect(status(page)).toHaveText('Step 4 of 28 · Preparation');
  await expect(rag(page).locator('.compare-message')).toHaveText(
    'Index built earlier by rag-index.',
  );
  await expect(page.locator('.compare-phase-line [aria-live="polite"]')).toHaveText(
    'Preparation. RAG: Index built earlier by rag-index. MCP step 4 of 28.',
  );
  // And forward to RAG's last retrieval step: MCP goes to the same offset of that phase.
  await ragSlider.fill('6');
  await expect(status(page)).toHaveText('Step 14 of 28 · Information acquisition');
  await expect(mcp(page).locator('.compare-position p')).toContainText('Step 14 of 28');
  expect(await paneSemantic(mcp(page), mcpPhases)).toBe('Information acquisition');
  await expect(page.locator('.compare-phase-line [aria-live="polite"]')).toHaveText(
    'Information acquisition. RAG step 6 of 10. MCP step 14 of 28.',
  );
  await expect(page).toHaveURL(/#\/compare\/compare-rag-mcp\/14\/architecture$/);
});

test('compare: shared controls, keys and the zoom control act on both panes', async ({ page }) => {
  await open(page, '#/compare/compare-rag-mcp/9/architecture');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowRight');
  await expect(status(page)).toHaveText('Step 10 of 28 · Information acquisition');
  await page.keyboard.press('ArrowLeft');
  await expect(status(page)).toHaveText('Step 9 of 28 · User request');
  // Both panes show their question's step.
  await expect(rag(page).locator('.compare-position p')).toHaveText('Step 1 of 10 · User question');
  await expect(mcp(page).locator('.compare-position p')).toHaveText('Step 9 of 28 · User question');
  await page.getByRole('button', { name: 'Protocol' }).click();
  await expect(page).toHaveURL(/#\/compare\/compare-rag-mcp\/9\/protocol$/);
  await expect(page.locator('svg.diagram')).toHaveCount(2);
  for (const pane of [rag(page), mcp(page)]) {
    await expect(pane.locator('svg.diagram')).toHaveAttribute('aria-label', /protocol view/);
  }
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(status(page)).toHaveText('Step 0 of 28');
  await page.getByRole('button', { name: 'Next step' }).click();
  await expect(status(page)).toHaveText('Step 1 of 28 · Preparation');
  await page.getByRole('slider', { name: 'Compare step' }).fill('28');
  await expect(status(page)).toHaveText('Step 28 of 28 · Answer');
  // The live region stays quiet while playing and speaks once playback pauses.
  const live = page.locator('.compare-phase-line [aria-live="polite"]');
  await page.getByRole('slider', { name: 'Compare step' }).fill('20');
  await expect(live).toContainText('MCP step 20 of 28.');
  await page.getByRole('combobox', { name: 'Play speed' }).selectOption('4');
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(status(page)).toHaveText(/^Step 2[12] of 28/, { timeout: 3000 });
  await expect(live).toContainText('MCP step 20 of 28.');
  await page.getByRole('button', { name: 'Pause' }).click();
  const paused = ((await status(page).textContent()) ?? '').match(/^Step (\d+)/)?.[1];
  await expect(live).toContainText(`MCP step ${paused} of 28.`);
  // From step 27 it plays to the end, pauses and says so.
  await page.getByRole('slider', { name: 'Compare step' }).fill('27');
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(status(page)).toHaveText('Step 28 of 28 · Answer', { timeout: 3000 });
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await expect(live).toHaveText('Answer. RAG step 10 of 10. MCP step 28 of 28.');
  // Every aspect is one sentence beside its label.
  await expect(page.locator('.compare-aspects dt')).toHaveText([
    'Data source',
    'Freshness expectations',
    'Model-visible context',
    'Actions vs retrieval',
    'Trust boundaries',
  ]);
});

test('compare: panes side by side on desktop, stacked on tablet, no page-level horizontal scroll', async ({
  page,
}) => {
  const box = async (l: Locator) => (await l.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
  const pageScroll = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, '#/compare/compare-rag-mcp/14/architecture');
  let r = await box(rag(page));
  let m = await box(mcp(page));
  expect(m.x, 'MCP right of RAG').toBeGreaterThan(r.x + r.width - 1);
  // The diagrams start at the same height whatever each message says.
  const top = async (pane: Locator) => (await box(pane.locator('.diagram-pane'))).y;
  expect(Math.abs((await top(rag(page))) - (await top(mcp(page))))).toBeLessThan(2);
  expect(await pageScroll()).toBeLessThanOrEqual(0);
  for (const width of [820, 390]) {
    await page.setViewportSize({ width, height: 1180 });
    // Below 48rem both panes lay out again as step lists; measure only once they have.
    await expect(
      page.locator(`[data-presentation="${width < 768 ? 'list' : 'diagram'}"]`),
    ).toHaveCount(2);
    await expect
      .poll(async () => {
        r = await box(rag(page));
        m = await box(mcp(page));
        return m.y >= r.y + r.height - 1 && m.width > width - 100;
      }, `MCP below RAG and full width at ${width}px`)
      .toBe(true);
    expect(await pageScroll(), `page scroll at ${width}px`).toBeLessThanOrEqual(0);
    // Each diagram scrolls inside its own named region instead.
    await expect(mcp(page).getByRole('region', { name: /MCP sequence diagram/ })).toBeVisible();
  }
  // Both panes still step together when stacked.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(status(page)).toHaveText('Step 15 of 28 · Information acquisition');
});

test('compare: focus moves to the heading when Compare is chosen from the tabs', async ({
  page,
}) => {
  await page.goto('./#/mcp/mcp-balance/0/architecture');
  await page.locator('[data-measured] svg.diagram').waitFor();
  await page.getByRole('link', { name: 'Compare' }).press('Enter');
  await expect(page.locator('.lesson h2')).toBeFocused();
  await expect(page.locator('.lesson h2')).toContainText('MCP fetches live data');
});
