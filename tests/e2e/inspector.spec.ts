import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./${hash}`);
  await page.locator('[data-measured] svg.diagram').waitFor();
}

const tablist = (page: Page) => page.getByRole('tablist', { name: 'Step details' });
const tab = (page: Page, name: string) => tablist(page).getByRole('tab', { name, exact: true });
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Current step' });

/** The rendered payload as JSON: folds and branches opened, fold labels removed. */
async function renderedPayload(page: Page): Promise<unknown> {
  const text = await page.locator('.tab-panel > .json').evaluate((root) => {
    const copy = root.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
    copy.querySelectorAll('.json-fold > summary, .json-label').forEach((s) => s.remove());
    document.body.append(copy);
    const out = copy.innerText;
    copy.remove();
    return out;
  });
  return JSON.parse(text);
}

test('the message comes first, then only the tabs the step has content for', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/14/protocol');
  await expect(inspector(page).locator('.message')).toHaveText(
    'Call the balance tool over Streamable HTTP.',
  );
  await expect(tablist(page).getByRole('tab')).toHaveText(['Payload', 'Transport', 'Security']);
  await open(page, '#/mcp/mcp-balance/13/protocol');
  await expect(tab(page, 'Transport')).toHaveCount(0);
});

test('every payload renders exactly as the event holds it, and Copy copies it', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  for (const [scenario, steps] of [
    ['mcp/mcp-balance', 28],
    ['rag/rag-query', 10],
  ] as const) {
    for (let step = 1; step <= steps; step += 1) {
      await open(page, `#/${scenario}/${step}/protocol`);
      if (!(await tab(page, 'Payload').count())) continue;
      await tab(page, 'Payload').click();
      await page.getByRole('button', { name: 'Copy' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
      const copied = JSON.parse(
        await page.evaluate(() => navigator.clipboard.readText()),
      ) as unknown;
      expect(await renderedPayload(page), `${scenario} step ${step}`).toEqual(copied);
    }
  }
});

test('MCP boilerplate is folded to one line and expands on click', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/14/protocol');
  const folds = page.locator('.tab-panel .json-fold');
  await expect(folds.locator('> summary')).toHaveText(['jsonrpc', '_meta']);
  await expect(page.getByText('"io.modelcontextprotocol/protocolVersion"')).toBeHidden();
  await folds.nth(1).locator('> summary').click();
  await expect(page.getByText('"io.modelcontextprotocol/protocolVersion"')).toBeVisible();
});

test('transport shows the mirrored MCP headers, folds unchanged ones and labels redacted tokens', async ({
  page,
}) => {
  await open(page, '#/mcp/mcp-balance/14/protocol');
  await tab(page, 'Transport').click();
  const panel = page.getByRole('tabpanel');
  await expect(panel).toContainText('Simulated exchange: nothing is sent over a network.');
  await expect(panel).toContainText('POST /mcp');
  await expect(panel).toContainText('Mcp-Method: tools/call');
  await expect(panel).toContainText('Mcp-Name: get_customer_balance');
  await expect(panel.locator('.json-fold > summary')).toHaveText('4 headers unchanged');
  await panel.locator('.json-fold > summary').click();
  await expect(panel).toContainText('MCP-Protocol-Version: 2026-07-28');
  await expect(panel).toContainText('Authorization: Bearer <REDACTED_MCP_ACCESS_TOKEN> redacted');
});

test('security lists each boundary with its risk and mitigation', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/14/protocol');
  await tab(page, 'Security').click();
  await expect(page.getByRole('tabpanel')).toContainText('agent-to-mcp');
  await expect(page.getByRole('tabpanel')).toContainText('Risk: Unauthorized tool invocation');
});

// 08-acceptance-tests.yaml e2e_tests: annotated-payload (02 inspector.carries, annotations).
test('annotated-payload: carries, groups that read as the payload, and where values travel', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '#/mcp/mcp-balance/14/protocol');
  await expect(inspector(page).locator('.carries li')).toHaveText([
    'the tool name the model chose',
    'the customer ID, which the agent checked against the signed-in customer',
    'the protocol revision, which the MCP-Protocol-Version header repeats',
    'JSON-RPC id 3, which the result repeats',
  ]);
  const toggle = page.getByRole('button', { name: 'Annotations' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
  const annotated = page.locator('#inspector-json');
  await expect(annotated.getByRole('heading', { level: 3 })).toHaveText([
    'JSON-RPC envelope',
    'Tool call',
    'Arguments',
    'Request metadata',
  ]);
  // The groups' lines, indentation restored, are exactly the payload's text.
  const text = await annotated
    .locator('.json-line')
    .evaluateAll((lines) =>
      lines
        .map((l) => '  '.repeat(Number((l as HTMLElement).dataset['depth'])) + l.textContent)
        .join('\n'),
    );
  // Copy still copies the raw payload, which is the same text.
  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  expect(text).toBe(await page.evaluate(() => navigator.clipboard.readText()));
  // The customer ID's bullet says where the value comes from and links there.
  const bullet = annotated.locator('li').filter({ hasText: 'whose balance to read' });
  await expect(bullet.locator('.travel')).toHaveText(
    'From the signed-in session · reaches the model at step 10 · the model repeats it at step 11 · the agent checks it at step 12 · sent to Example Bank MCP server here',
  );
  await bullet.getByRole('button', { name: 'step 10' }).click();
  await expect(page.locator('.status')).toContainText('Step 10 of 28');
  // The toggle stays open on the next annotated step.
  await expect(page.getByRole('button', { name: 'Annotations' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(annotated.getByRole('heading', { level: 3 }).first()).toHaveText('System prompt');
});

test('the pair link jumps between request and response', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/14/protocol');
  await page.getByRole('button', { name: 'Response: step 23' }).click();
  await expect(page.locator('.status')).toContainText('Step 23 of 28');
  await page.getByRole('button', { name: 'Request: step 14' }).click();
  await expect(page.locator('.status')).toContainText('Step 14 of 28');
});

test('the second LLM request highlights only what is new', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/26/protocol');
  const marked = page.locator('.tab-panel .json-branch.json-mark');
  await expect(marked).toHaveCount(2);
  await expect(marked.first()).toContainText('"assistant"');
  await expect(marked.nth(1)).toContainText('"tool"');
});

test('tabs follow the ARIA pattern and the choice survives stepping', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/14/protocol');
  await tab(page, 'Payload').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Transport')).toBeFocused();
  await expect(tab(page, 'Transport')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.status')).toContainText('Step 14 of 28');
  await page.keyboard.press('End');
  await expect(tab(page, 'Security')).toHaveAttribute('aria-selected', 'true');
  // Step 16 has no boundary: the first tab shows. Step 17 has one: the choice returns.
  await open(page, '#/mcp/mcp-balance/15/protocol');
  await tab(page, 'Security').click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(tab(page, 'Security')).toHaveCount(0);
  await expect(tab(page, 'Payload')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(tab(page, 'Security')).toHaveAttribute('aria-selected', 'true');
});

test('code stays readable at 200% zoom without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  // At 720 px the phone layout applies (02 layout.phone): the tabs sit behind Step details.
  await page.goto('./#/mcp/mcp-balance/26/protocol');
  await page.locator('[data-measured][data-presentation="list"]').waitFor();
  await page.getByRole('button', { name: 'Step details' }).click();
  await expect(page.locator('.tab-panel .json')).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  const overflow = await page
    .locator('.tab-panel .json')
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
  // Annotations open: the groups' lines and their callouts wrap too (02 inspector.annotations.phone).
  await page.getByRole('button', { name: 'Annotations' }).click();
  const wide = await page
    .locator('#inspector-json, #inspector-json .json')
    .evaluateAll((els) => Math.max(...els.map((el) => el.scrollWidth - el.clientWidth)));
  expect(wide).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});

test('open folds and focus survive changes that are not a step', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/14/protocol');
  const meta = page.locator('.tab-panel .json-fold').nth(1);
  await meta.locator('> summary').click();
  await expect(meta).toHaveAttribute('open', '');
  await page.getByRole('combobox', { name: 'Play speed' }).selectOption('2');
  await page.getByRole('button', { name: 'Protocol' }).click();
  await expect(page.locator('.tab-panel .json-fold').nth(1)).toHaveAttribute('open', '');
});

test('focus stays on the equivalent control when the step changes', async ({ page }) => {
  await open(page, '#/mcp/mcp-balance/14/protocol');
  await page.getByRole('button', { name: 'Copy' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.status')).toContainText('Step 15 of 28');
  await expect(page.getByRole('button', { name: 'Copy' })).toBeFocused();
  await open(page, '#/mcp/mcp-balance/14/protocol');
  await page.getByRole('button', { name: 'Response: step 23' }).click();
  await expect(page.getByRole('button', { name: 'Request: step 14' })).toBeFocused();
});
