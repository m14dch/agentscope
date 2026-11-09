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

test('folded payload boilerplate expands on click', async ({ page }) => {
  await page.goto('./#/design');
  const fold = page.getByRole('button', { name: 'Show _meta' });
  await expect(page.getByText('io.modelcontextprotocol/clientInfo')).toBeHidden();
  await fold.click();
  await expect(page.getByText('io.modelcontextprotocol/clientInfo')).toBeVisible();
  await expect(fold).toBeHidden();
});

test('contrast ratios on the specimen come from the live tokens', async ({ page }) => {
  await page.goto('./#/design');
  await expect(page.getByText('18.88 : 1')).toBeVisible();
});
