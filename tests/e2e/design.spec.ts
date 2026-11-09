import { expect, test } from './fixtures';

for (const { name, width } of [
  { name: 'phone', width: 390 },
  { name: 'desktop', width: 1280 },
]) {
  test(`design specimen renders on ${name} without page overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('./#/design');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Design system');
    for (const section of ['Type', 'Colour', 'Arrows', 'Payload', 'Scores']) {
      await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });
}

test('self-hosted fonts load from the app origin', async ({ page }) => {
  await page.goto('./#/design');
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
  });
  expect(loaded).toEqual(expect.arrayContaining(['Inter Variable', 'JetBrains Mono Variable']));
});

test('folded payload boilerplate expands and folds again, keeping focus', async ({ page }) => {
  await page.goto('./#/design');
  const fold = page.getByRole('button', { name: '"_meta"' });
  const detail = page.getByText('io.modelcontextprotocol/clientInfo');
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(detail).toBeHidden();
  await fold.focus();
  await page.keyboard.press('Enter');
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(detail).toBeVisible();
  await expect(fold).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(detail).toBeHidden();
});

test('figures expose their text to assistive technology', async ({ page }) => {
  await page.goto('./#/design');
  await expect(page.getByRole('region', { name: /Arrow examples/ })).toBeVisible();
  await expect(page.getByText('MCP · tools/call result')).toBeVisible();
  await expect(page.getByRole('list', { name: /Retrieval scores/ })).toContainText(
    /savings-account · 001\s+0\.90, retained/,
  );
});

test('font licences ship with the site', async ({ page }) => {
  const response = await page.request.get('./licenses/fonts.txt');
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('SIL Open Font License');
});

test('contrast ratios on the specimen come from the live tokens', async ({ page }) => {
  await page.goto('./#/design');
  await expect(page.getByText('18.88 : 1')).toBeVisible();
});
