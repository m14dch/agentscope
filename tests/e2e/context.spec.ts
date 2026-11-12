import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./${hash}`);
  await page.locator('[data-measured] svg.diagram').waitFor();
}

const panel = (page: Page) => page.locator('#context-panel');

test('the model-context panel is collapsed at start and opens on request', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/24/architecture');
  const toggle = page.getByRole('button', { name: 'Model context' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page)).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page)).toBeVisible();
});

test('the balance is in agent state at the tool result and seen by the model only from the follow-up request', async ({
  page,
}) => {
  await open(page, '#/mcp/mcp-balance/24/architecture');
  await page.getByRole('button', { name: 'Model context' }).click();
  const state = page.getByRole('region', { name: 'Agent state' });
  const seen = page.getByRole('region', { name: 'Model-visible context' });
  await expect(state.locator('li').filter({ hasText: 'Tool result received' })).toContainText(
    'not yet seen by the model',
  );
  await expect(seen).not.toContainText('12500.75');
  // Step 26 asks for a prediction first, so jump there.
  await page.getByRole('slider', { name: 'Step' }).fill('26');
  await expect(page.locator('.status')).toContainText('Step 26 of 28');
  await expect(seen).toContainText('12500.75');
  await expect(state.locator('li').filter({ hasText: 'Tool result received' })).not.toContainText(
    'not yet seen',
  );
});

test('no context panel where the scenario has no agent state', async ({ page }) => {
  await open(page, '#/rag/rag-index/3/architecture');
  await expect(page.getByRole('button', { name: 'Model context' })).toHaveCount(0);
});

test('selecting a tracked value marks its reached steps in the diagram, and Escape clears it', async ({
  page,
}) => {
  await open(page, '#/mcp/mcp-balance/24/protocol');
  await page.getByRole('tab', { name: 'Lineage', exact: true }).click();
  await page.getByRole('button', { name: 'Select balance 12500.75' }).click();
  // Reached steps that carry the balance: 20 to 24.
  await expect(page.locator('.step .label-mark')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Select balance 12500.75' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Later steps are not revealed in the occurrences.
  const row = page.locator('.lineage-row').filter({ hasText: 'balance' });
  await expect(row.locator('li')).toHaveText('12500.75 first at step 20; also 21, 22, 23 Selected');
  // The selection stays while stepping.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.step .label-mark')).toHaveCount(6);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(page.locator('.step .label-mark')).toHaveCount(0);
});

test('with a selection only its fields are highlighted in the payload', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/23/protocol');
  const marks = page.locator('.tab-panel .json-value.json-mark');
  await expect(marks.filter({ hasText: '"123"' }).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Lineage', exact: true }).click();
  await page.getByRole('button', { name: 'Select balance 12500.75' }).click();
  await page.getByRole('tab', { name: 'Payload', exact: true }).click();
  await expect(marks.filter({ hasText: '"123"' })).toHaveCount(0);
  await expect(marks.filter({ hasText: '12500.75' }).first()).toBeVisible();
});

test('Architecture marks the group caption holding the selected value with a solid ink underline', async ({
  page,
}) => {
  await open(page, '#/mcp/mcp-balance/24/protocol');
  await page.getByRole('tab', { name: 'Lineage', exact: true }).click();
  await page.getByRole('button', { name: 'Select balance 12500.75' }).click();
  await page.getByRole('button', { name: 'Architecture' }).click();
  const caption = page.locator('.group-label.arrow-label--selected').first();
  await expect(caption).toBeVisible();
  const style = await caption.evaluate((node) => {
    const s = getComputedStyle(node);
    return { line: s.textDecorationLine, kind: s.textDecorationStyle };
  });
  expect(style).toEqual({ line: 'underline', kind: 'solid' });
});

test('Escape in the scenario picker closes it and keeps the selection', async ({ page }) => {
  // Only RAG has a scenario picker (02 navigation.scenario_picker).
  await open(page, '#/rag/rag-query/10/protocol');
  await page.getByRole('tab', { name: 'Lineage', exact: true }).click();
  await page
    .getByRole('button', { name: /^Select / })
    .first()
    .click();
  const marks = await page.locator('.step .label-mark').count();
  expect(marks).toBeGreaterThan(0);
  await page.locator('.picker summary').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.picker')).not.toHaveAttribute('open', '');
  await expect(page.locator('.step .label-mark')).toHaveCount(marks);
});
