// 08-acceptance-tests.yaml e2e_tests: mcp-walkthrough and mcp-errors (issue #12).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

const mcp = parse(readFileSync('specifications/04-mcp-scenarios.yaml', 'utf8')) as {
  variants: { id: string; lesson: string }[];
};
const security = parse(readFileSync('specifications/07-security-protocols.yaml', 'utf8')) as {
  error_taxonomy: Record<string, string>;
};

// Playing whole scenarios at 4× takes about ten seconds each.
test.describe.configure({ timeout: 120_000 });

const status = (page: Page) => page.locator('.status');
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Current step' });
const tab = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Step details' }).getByRole('tab', { name, exact: true });
/** The sender → receiver line that follows the step's message. */
const operationLine = (page: Page) => inspector(page).locator('.message + p');

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./${hash}`);
  await page.locator('[data-measured] svg.diagram').waitFor();
}

async function stepCount(page: Page): Promise<number> {
  return Number(await page.getByRole('slider', { name: 'Step' }).getAttribute('max'));
}

async function jump(page: Page, step: number): Promise<void> {
  await page.getByRole('slider', { name: 'Step' }).fill(String(step));
  await expect(status(page)).toContainText(`Step ${step} of `);
}

/** Plays from the start to the last step at 4×, continuing past every prediction. */
async function playThrough(page: Page): Promise<void> {
  const n = await stepCount(page);
  await page.getByRole('button', { name: '4×' }).click();
  await page.getByRole('button', { name: 'Play' }).click();
  const end = status(page).filter({ hasText: new RegExp(`^Step ${n} of ${n}`) });
  const prompt = page.getByRole('button', { name: 'Continue', exact: true });
  while (!(await end.count())) {
    await expect(end.or(prompt)).toBeVisible({ timeout: 10_000 });
    if (await prompt.count()) {
      await prompt.click();
      await page.getByRole('button', { name: 'Play' }).click();
    }
  }
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
}

/** The transport tab's lines as text, folds opened. */
async function transportText(page: Page): Promise<string> {
  await tab(page, 'Transport').click();
  const panel = page.getByRole('tabpanel');
  for (const fold of await panel.locator('details:not([open]) > summary').all()) await fold.click();
  return (await panel.innerText()).replace(/\s+/g, ' ');
}

test('mcp-walkthrough: the balance trace plays end to end and is inspectable', async ({ page }) => {
  await open(page, '#/mcp');
  await expect(page).toHaveURL(/#\/mcp\/mcp-balance\/0$/);
  await playThrough(page);
  await expect(status(page)).toHaveText('Step 28 of 28 · Answer');
  await expect(inspector(page)).toContainText('Your current account balance is CHF 12,500.75.');
  await page.getByRole('button', { name: 'Protocol' }).click();

  // server/discover: an MCP POST whose headers mirror the body.
  await jump(page, 2);
  await expect(operationLine(page)).toHaveText(
    'MCP client → Example Bank MCP server · MCP · server/discover',
  );
  let wire = await transportText(page);
  expect(wire).toContain('POST /mcp');
  expect(wire).toContain('MCP-Protocol-Version: 2026-07-28');
  expect(wire).toContain('Mcp-Method: server/discover');
  expect(wire).toContain('Authorization: Bearer <REDACTED_MCP_ACCESS_TOKEN> redacted');

  // tools/list.
  await jump(page, 5);
  await expect(operationLine(page)).toContainText('MCP · tools/list');
  wire = await transportText(page);
  expect(wire).toContain('Mcp-Method: tools/list');
  expect(wire).not.toContain('Mcp-Name');

  // tools/call: Mcp-Name mirrors params.name.
  await jump(page, 14);
  await expect(operationLine(page)).toContainText('MCP · tools/call');
  wire = await transportText(page);
  expect(wire).toContain('Mcp-Method: tools/call');
  expect(wire).toContain('Mcp-Name: get_customer_balance');

  // The REST GET carries the MCP server's own credential, never the MCP access token.
  await jump(page, 17);
  await expect(operationLine(page)).toContainText('HTTP · GET /customers/123/balance');
  wire = await transportText(page);
  expect(wire).toContain('GET /customers/123/balance');
  expect(wire).toContain('<REDACTED_BACKEND_SERVICE_TOKEN>');
  expect(wire).not.toContain('<REDACTED_MCP_ACCESS_TOKEN>');

  // The REST response holds the balance.
  await jump(page, 21);
  await expect(operationLine(page)).toContainText('HTTP 200 OK');
  expect(await transportText(page)).toContain('HTTP 200');
  await tab(page, 'Payload').click();
  await expect(page.getByRole('tabpanel')).toContainText('12500.75');

  // No step of the primary trace is an error.
  for (let k = 1; k <= 28; k += 1) {
    await jump(page, k);
    await expect(inspector(page).locator('.error-line'), `step ${k}`).toHaveCount(0);
  }
  await jump(page, 28);
  await expect(inspector(page).locator('.message')).toHaveText(
    'The agent shows the answer to the user.',
  );
  await expect(inspector(page)).toContainText('CHF 12,500.75');
});

test('server/discover offers the earlier initialize handshake, collapsed and labelled', async ({
  page,
}) => {
  await open(page, '#/mcp/mcp-balance/2/protocol');
  await tab(page, 'Payload').click();
  const earlier = page.locator('details.earlier');
  const summary = earlier.locator('> summary');
  await expect(summary).toHaveText('Compare with the initialize handshake of revision 2025-11-25');
  await expect(earlier).not.toHaveAttribute('open', '');
  await expect(page.getByText('"initialize"')).toBeHidden();
  await summary.click();
  await expect(earlier).toHaveAttribute('open', '');
  const headings = earlier.locator('.earlier-message > p.muted:first-child');
  await expect(headings).toHaveText([
    'Revision 2025-11-25 · MCP client → Example Bank MCP server · MCP · initialize',
    'Revision 2025-11-25 · Example Bank MCP server → MCP client · MCP · initialize result',
    'Revision 2025-11-25 · MCP client → Example Bank MCP server · MCP · notifications/initialized',
    'Revision 2025-11-25 · Example Bank MCP server → MCP client · HTTP 202 Accepted',
  ]);
  await expect(earlier).toContainText('Mcp-Session-Id: demo-session-7f3a');
  await expect(earlier).toContainText('"notifications/initialized"');
  await expect(earlier).toContainText('No body');
  // Readable at 200% zoom without horizontal scrolling, like the payload above it.
  await page.setViewportSize({ width: 720, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  for (const block of await earlier.locator('.json').all()) {
    expect(await block.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  // Only on server/discover: not on its result nor on other MCP requests.
  for (const step of [3, 5, 14]) {
    await jump(page, step);
    if (await tab(page, 'Payload').count()) await tab(page, 'Payload').click();
    await expect(page.locator('details.earlier'), `step ${step}`).toHaveCount(0);
  }
});

/** Every step's error line in a scenario, with its operation, in order. */
async function errorSteps(page: Page): Promise<string[]> {
  const n = await stepCount(page);
  const found: string[] = [];
  for (let k = 1; k <= n; k += 1) {
    await jump(page, k);
    const line = inspector(page).locator('.error-line');
    if (!(await line.count())) continue;
    const operation = (await operationLine(page).innerText()).split(' · ').slice(1).join(' · ');
    found.push(`${operation} | ${await line.locator('.error-kind').innerText()}`);
  }
  return found;
}

test('mcp-errors: each error variant names the correct kind', async ({ page }) => {
  const expected: Record<string, string[]> = {
    'mcp-not-found': [
      'HTTP 404 Not Found | × transport error',
      'MCP · tools/call result | × tool execution error',
    ],
    'mcp-unauthorized': [
      'HTTP 401 Unauthorized | × transport error',
      'MCP · tools/call result | × tool execution error',
    ],
    'mcp-jsonrpc-error': ['MCP · tools/call error | × protocol error'],
  };
  for (const [id, kinds] of Object.entries(expected)) {
    await open(page, `#/mcp/${id}/0/protocol`);
    await playThrough(page);
    expect(await errorSteps(page), id).toEqual(kinds);
  }

  // isError results are tool execution errors, with the taxonomy's definition beside the kind.
  await open(page, '#/mcp/mcp-not-found/0/protocol');
  const n = await stepCount(page);
  for (let k = 1; k <= n; k += 1) {
    await jump(page, k);
    if ((await operationLine(page).innerText()).endsWith('MCP · tools/call result')) break;
  }
  const line = inspector(page).locator('.error-line');
  await expect(line).toHaveText(
    `× tool execution error. ${security.error_taxonomy.tool_execution}`,
  );
  await tab(page, 'Payload').click();
  await expect(page.getByRole('tabpanel')).toContainText('"isError": true');
  expect(await transportText(page)).toContain('HTTP 200');
  await expect(page.locator('svg.diagram')).toContainText(
    '× tool execution error · MCP · tools/call result',
  );

  // The JSON-RPC error object is a protocol error, though HTTP still answers 200.
  await open(page, '#/mcp/mcp-jsonrpc-error/0/protocol');
  for (let k = 1; k <= (await stepCount(page)); k += 1) {
    await jump(page, k);
    if ((await operationLine(page).innerText()).endsWith('MCP · tools/call error')) break;
  }
  await expect(line).toHaveText(`× protocol error. ${security.error_taxonomy.protocol}`);
  await tab(page, 'Payload').click();
  await expect(page.getByRole('tabpanel')).toContainText('-32602');
  expect(await transportText(page)).toContain('HTTP 200');
  // The step that hands the failure to the agent is not an error arrow.
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(operationLine(page)).toContainText('Raise protocol error');
  await expect(line).toHaveCount(0);
  // Architecture mode names the kind on the group that holds the error.
  await page.getByRole('button', { name: 'Architecture' }).click();
  await expect(page.locator('svg.diagram .group-error')).toHaveText(' · × protocol error');
});

test('every MCP variant shows its lesson and plays to its last step', async ({ page }) => {
  expect(mcp.variants.map((v) => v.id)).toEqual([
    'mcp-resources',
    'mcp-not-found',
    'mcp-unauthorized',
    'mcp-jsonrpc-error',
    'mcp-multiple-tools',
  ]);
  for (const v of mcp.variants) {
    await open(page, `#/mcp/${v.id}/0`);
    await expect(page.locator('.lesson .headline'), v.id).toHaveText(v.lesson);
    await playThrough(page);
    await expect(page.locator('.lesson .headline'), v.id).toHaveText(v.lesson);
  }
  // Both successful extensions still end at the simulated balance.
  for (const id of ['mcp-resources', 'mcp-multiple-tools']) {
    await open(page, `#/mcp/${id}/0`);
    await jump(page, await stepCount(page));
    await expect(inspector(page), id).toContainText('CHF 12,500.75');
  }
});
