// 08-acceptance-tests.yaml e2e_tests: accessibility, the axe scan (issue #19).
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Automated accessibility scan (issue 19): axe-core runs inside the page, so it sends no
 * request and the guard of fixtures.ts stays strict. Every tab and representative scenarios
 * and steps are scanned in both modes, at desktop and phone width, with the panels and the
 * menu open. Serious and critical findings fail the test; minor and moderate ones are left to
 * review (axe marks some of them as best practice, not WCAG).
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const ROUTES = [
  '#/mcp/mcp-balance/0',
  '#/mcp/mcp-balance/12',
  '#/mcp/mcp-not-found/23',
  '#/mcp/mcp-jsonrpc-error/18',
  '#/mcp/mcp-resources/12',
  '#/rag/rag-index/6',
  '#/rag/rag-query/10',
  '#/rag/rag-prompt-injection/10',
  '#/rag/rag-stale/10',
  '#/compare/compare-rag-mcp/8',
  '#/compare/compare-rag-mcp/28',
  '#/combined/combined-balance-explanation/35',
  '#/combined/combined-missing-terms/20',
];

const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;

async function scan(page: Page, where: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${where}: ${v.id} (${v.impact}) ${v.help}\n  ${v.nodes
          .slice(0, 5)
          .map((n) => n.target.join(' '))
          .join('\n  ')}`,
    );
  expect(blocking).toEqual([]);
}

/** Opens a collapsed fold if it is there. */
async function expand(page: Page, name: string): Promise<void> {
  const button = page.getByRole('button', { name, exact: true });
  if ((await button.count()) === 0 || !(await button.first().isVisible())) return;
  if ((await button.first().getAttribute('aria-expanded')) === 'false')
    await button.first().click();
}

for (const size of WIDTHS) {
  test.describe(`axe at ${size.name} width`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    for (const route of ROUTES) {
      for (const mode of ['architecture', 'protocol'] as const) {
        const url = `./${route}${mode === 'protocol' ? '/protocol' : ''}`;
        test(`${url} has no serious or critical issues`, async ({ page }) => {
          await page.goto(url);
          await page.locator('[data-measured]').first().waitFor();
          await scan(page, `${url} as loaded`);
          // The panels open: step details (phones), model context, an expanded group, the
          // scenario picker on desktop or the menu on phones.
          await expand(page, 'Step details');
          await expand(page, 'Model context');
          const group = page.locator('[data-group][aria-expanded="false"]').first();
          if ((await group.count()) > 0 && (await group.isVisible())) await group.click();
          if (size.name === 'phone') {
            await page.getByRole('button', { name: 'Menu' }).click();
            await expect(page.locator('#menu')).toBeVisible();
          } else {
            const picker = page.locator('.picker summary');
            if (await picker.isVisible()) await picker.click();
          }
          await scan(page, `${url} with panels open`);
        });
      }
    }

    test('the design specimen and an unknown route have no serious or critical issues', async ({
      page,
    }) => {
      await page.goto('./#/design');
      await page.locator('#app > *').first().waitFor();
      await scan(page, '#/design');
      await page.goto('./#/compare/unknown');
      await page.getByRole('link', { name: 'Go to Compare' }).waitFor();
      await scan(page, '#/compare/unknown');
    });
  });
}
