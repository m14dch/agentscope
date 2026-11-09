import { expect, test } from './fixtures';

test('placeholder page loads under the base path', async ({ page }) => {
  const failed: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AgentScope');
  await expect(page.locator('meta[name="agentscope-version"]')).toHaveAttribute('content', 'dev');
  expect(failed).toEqual([]);
});

test('a hash route serves the same app', async ({ page }) => {
  await page.goto('./#/rag');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AgentScope');
});
