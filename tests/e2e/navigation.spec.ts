import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

const status = (page: Page) => page.locator('.status');

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./${hash}`);
  await page.locator('[data-measured] svg.diagram').waitFor();
}

/** The diagram's markup and the step's message, for determinism checks. */
async function snapshot(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      (document.querySelector('svg.diagram')?.outerHTML ?? '') +
      (document.querySelector('.inspector')?.textContent ?? ''),
  );
}

// 08-acceptance-tests.yaml e2e_tests: navigation.
test('navigation: jump to the last step, step back, switch view, reset and replay deterministically', async ({
  page,
}) => {
  await open(page, '#/mcp/mcp-balance/0');
  await expect(status(page)).toHaveText('Step 0 of 28');
  await page.getByRole('slider', { name: 'Step' }).fill('28');
  await expect(status(page)).toHaveText('Step 28 of 28 · Answer');
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(status(page)).toContainText('Step 27 of 28');
  const at27 = await snapshot(page);
  await page.getByRole('button', { name: 'Protocol' }).click();
  await expect(page.getByRole('button', { name: 'Protocol' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(status(page)).toContainText('Step 27 of 28');
  await page.getByRole('button', { name: 'Architecture' }).click();
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(status(page)).toHaveText('Step 0 of 28');
  await page.getByRole('slider', { name: 'Step' }).fill('27');
  expect(await snapshot(page)).toBe(at27);
});

test('a deep link restores tab, scenario, step and mode after reload', async ({ page }) => {
  await open(page, '#/rag/rag-hybrid/5/protocol');
  await expect(page.getByRole('link', { name: 'RAG' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.picker summary')).toContainText('reranking');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/#\/rag\/rag-hybrid\/6\/protocol$/);
  await page.reload();
  await page.locator('[data-measured] svg.diagram').waitFor();
  await expect(status(page)).toContainText('Step 6 of 13');
  await expect(page.getByRole('button', { name: 'Protocol' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('[data-current]')).toHaveAttribute('data-index', '5');
});

test('stepping replaces the history entry; changing scenario adds one', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/2');
  await page.getByRole('link', { name: 'Combined' }).click();
  await page.locator('[data-measured] svg.diagram').waitFor();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/#\/combined\/combined-balance-explanation\/2$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/2$/);
  await expect(status(page)).toContainText('Step 2 of 28');
});

test('keyboard: → next, ← previous, Space plays and pauses, with visible focus', async ({
  page,
}) => {
  await open(page, '#/mcp/mcp-balance/3');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowRight');
  await expect(status(page)).toContainText('Step 4 of 28');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(status(page)).toContainText('Step 2 of 28');
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).focus();
  const outline = await page
    .getByRole('button', { name: 'Next' })
    .evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe('solid');
});

test('a prediction appears before its step and the step answers it', async ({ page }) => {
  // mcp-11 carries a prediction: at step 10, Next shows the prompt first.
  await open(page, '#/mcp/mcp-balance/10');
  await page.getByRole('button', { name: 'Next' }).click();
  const prompt = page.locator('.prediction');
  await expect(prompt).toContainText('What will it return');
  await expect(status(page)).toContainText('Step 10 of 28');
  await page.keyboard.press('ArrowRight');
  await expect(status(page)).toContainText('Step 11 of 28');
  await expect(prompt).toHaveCount(0);
  // Previous never shows a prompt.
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(prompt).toHaveCount(0);
});

test('play pauses at a prediction', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/9');
  await page.getByRole('button', { name: '4×' }).click();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.locator('.prediction')).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await expect(status(page)).toContainText('Step 10 of 28');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(status(page)).toContainText('Step 11 of 28');
});

test('the scenario picker lists variants with their lessons', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/0');
  await page.locator('.picker summary').click();
  const item = page.locator('.picker li').filter({ hasText: 'isError true' });
  await expect(item).toContainText(
    'A backend failure comes back as a tool result with isError true',
  );
  await item.getByRole('link').click();
  await expect(page).toHaveURL(/#\/mcp\/mcp-not-found\/0$/);
  await expect(page.locator('.picker')).not.toHaveAttribute('open', '');
  await expect(page.locator('.lesson h2')).toHaveText(
    'How does an AI assistant obtain your live account balance?',
  );
});

test('an unknown scenario is named, with a way back', async ({ page }) => {
  await page.goto('./#/rag/nope/3');
  await expect(page.getByRole('alert')).toHaveText('× Unknown scenario: nope. Go to RAG');
  await page.getByRole('link', { name: 'Go to RAG' }).click();
  await page.locator('[data-measured] svg.diagram').waitFor();
  await expect(page).toHaveURL(/#\/rag\/rag-query\/0$/);
});

test('compare links both questions to their scenarios', async ({ page }) => {
  await page.goto('./#/compare');
  await expect(page.getByRole('heading', { level: 2 })).toContainText('MCP fetches live data');
  await page.getByRole('link', { name: 'What is the current balance of my bank account?' }).click();
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/0$/);
});

test('the simulated statement is always visible', async ({ page }) => {
  for (const hash of ['#/mcp', '#/compare', '#/rag/nope']) {
    await page.goto(`./${hash}`);
    await expect(
      page.getByText('Everything here is simulated. Nothing leaves your browser.'),
    ).toBeVisible();
  }
});

test('diagram and inspector sit side by side on desktop and stack on tablet', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, '#/mcp/mcp-balance/5');
  const diagram = page.getByRole('region', { name: /Sequence diagram/ });
  const inspector = page.getByRole('complementary', { name: 'Current step' });
  const box = async (l: typeof diagram) =>
    (await l.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
  let d = await box(diagram);
  let i = await box(inspector);
  expect(i.x, 'inspector right of the diagram').toBeGreaterThan(d.x + d.width - 1);
  expect(Math.abs(i.y - d.y), 'tops aligned').toBeLessThan(2);
  await page.setViewportSize({ width: 820, height: 1180 });
  d = await box(diagram);
  i = await box(inspector);
  expect(i.y, 'inspector below the diagram').toBeGreaterThanOrEqual(d.y + d.height - 1);
});

test('the splitter resizes the inspector with the keyboard, within 20rem and 60%', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, '#/mcp/mcp-balance/5');
  const inspector = page.getByRole('complementary', { name: 'Current step' });
  const workspace = page.locator('.workspace');
  const width = async () => (await inspector.boundingBox())?.width ?? 0;
  const splitter = page.getByRole('separator', { name: 'Resize the inspector' });
  await expect(splitter).toHaveAttribute('aria-valuenow', '30');
  const before = await width();
  await splitter.focus();
  await splitter.press('ArrowLeft');
  expect(await width()).toBeGreaterThan(before);
  await expect(page.locator('.status')).toContainText('Step 5 of 28');
  await splitter.press('Home');
  await expect(splitter).toHaveAttribute('aria-valuenow', '60');
  const total = (await workspace.boundingBox())?.width ?? 0;
  expect(await width()).toBeLessThanOrEqual(total * 0.6 + 1);
  // A narrower window keeps the inspector within 60%.
  await page.setViewportSize({ width: 1100, height: 1000 });
  const narrower = (await workspace.boundingBox())?.width ?? 0;
  expect(await width()).toBeLessThanOrEqual(narrower * 0.6 + 1);
  await splitter.press('End');
  expect(await width()).toBeGreaterThanOrEqual(320 - 1);
});

test('Space during a prediction plays on, like the Play button', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/10');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.prediction')).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(' ');
  await expect(page.locator('.status')).toContainText('Step 11 of 28', { timeout: 5000 });
  await page.keyboard.press(' ');
});

test('after choosing a tab or a scenario, focus moves to the new page heading', async ({
  page,
}) => {
  await open(page, '#/mcp/mcp-balance/0');
  await page.getByRole('link', { name: 'RAG' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.lesson h2')).toBeFocused();
  // Choosing from the picker.
  await page.locator('.picker summary').focus();
  await page.keyboard.press('Enter');
  await page
    .locator('.picker li')
    .filter({ hasText: 'No sufficiently relevant' })
    .getByRole('link')
    .press('Enter');
  await expect(page).toHaveURL(/#\/rag\/rag-no-match\/0$/);
  await expect(page.locator('.lesson h2')).toBeFocused();
  // Back, and links inside the page.
  await page.goBack();
  await expect(page.locator('.lesson h2')).toBeFocused();
  await page.goto('./#/compare');
  await page
    .getByRole('link', { name: 'What is the current balance of my bank account?' })
    .press('Enter');
  await expect(page.locator('.lesson h2')).toBeFocused();
  await page.goto('./#/rag/nope');
  await page.getByRole('link', { name: 'Go to RAG' }).press('Enter');
  await expect(page.locator('.lesson h2')).toBeFocused();
  // Escape closes the picker and returns to its summary.
  await page.locator('.picker summary').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('.picker')).not.toHaveAttribute('open', '');
  await expect(page.locator('.picker summary')).toBeFocused();
});
