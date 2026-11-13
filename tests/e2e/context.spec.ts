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
  // The model sees the balance at step 26.
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

test('tracked values are highlighted in the payload (02 inspector.payload_features)', async ({
  page,
}) => {
  await open(page, '#/mcp/mcp-balance/23/protocol');
  const marks = page.locator('.tab-panel .json-value.json-mark');
  await expect(marks.filter({ hasText: '"123"' }).first()).toBeVisible();
  await expect(marks.filter({ hasText: '12500.75' }).first()).toBeVisible();
});
