import { expect, test } from './fixtures';

test('placeholder page loads under the base path', async ({ page }) => {
  const failed: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AgentScope');
  expect(failed).toEqual([]);
});

test('a hash route serves the same app', async ({ page }) => {
  await page.goto('./#/rag');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AgentScope');
});

test('the external-request guard catches requests to other origins', async ({ page }) => {
  test.fail(true, 'The guard must fail this test.');
  await page.goto('./');
  await page.evaluate(() => fetch('https://example.com/').catch(() => undefined));
});
