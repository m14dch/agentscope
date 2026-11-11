// 08-acceptance-tests.yaml e2e_tests: combined-walkthrough (issue #17), and the provenance of
// tool data and document evidence (02-ui-ux.yaml context_panel.provenance, combined_answer).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Page } from '@playwright/test';
import { readSpecSources } from '../../scripts/spec-sources';
import { partSource, STATEMENT_LABELS } from '../../src/inspector/combined';
import { RagDerivation } from '../../src/rag/derive';
import type { JsonObject, Scenario } from '../../src/scenarios/types';
import { expect, test } from './fixtures';

interface Case {
  id: string;
  title: string;
  question: string;
  lesson?: string;
  expected_answer: string;
  expected_sources: string[];
}
const combined = (
  parse(readFileSync('specifications/06-comparison-scenarios.yaml', 'utf8')) as {
    combined: Case & { variants: Case[] };
  }
).combined;
const [missing] = combined.variants;
const product = parse(readFileSync('specifications/00-product.yaml', 'utf8')) as {
  primary_questions: { combined: string };
};

// Playing the whole scenario at 4× takes about fifteen seconds.
test.describe.configure({ timeout: 120_000 });

const status = (page: Page) => page.locator('.status');
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Current step' });
const operationLine = (page: Page) => inspector(page).locator('.message + p');
const answerPanel = (page: Page) =>
  page.getByRole('region', { name: 'Where each part of the answer comes from' });
const statements = (page: Page) => answerPanel(page).locator('.statement');
const agentState = (page: Page) => page.getByRole('region', { name: 'Agent state' });
const seen = (page: Page) => page.getByRole('region', { name: 'Model-visible context' });

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./${hash}`);
  await page.locator('[data-measured] svg.diagram').waitFor();
}

async function jump(page: Page, step: number): Promise<void> {
  await page.getByRole('slider', { name: 'Step' }).fill(String(step));
  await expect(status(page)).toContainText(`Step ${step} of `);
}

/** Plays from the start to the last step at 4×, continuing past every prediction. */
async function playThrough(page: Page): Promise<void> {
  const n = Number(await page.getByRole('slider', { name: 'Step' }).getAttribute('max'));
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
}

/** The statements as [label, text] pairs. */
async function shownStatements(page: Page): Promise<[string, string][]> {
  return statements(page).evaluateAll((items) =>
    items.map((li) => [
      li.querySelector('.statement-source')?.textContent ?? '',
      li.querySelector('.statement-text')?.textContent ?? '',
    ]),
  );
}

const derivation = new RagDerivation(readSpecSources('specifications'));

/** The statements the engine composes for a case: [label, text] per answer part. */
function expectedStatements(fixtureOverrides?: JsonObject): [string, string][] {
  return derivation
    .combinedAnswer({} as Scenario, {}, fixtureOverrides)
    .parts.map((p) => [STATEMENT_LABELS[partSource(p)], p.text]);
}

test('combined-walkthrough: tool data and document evidence stay apart from question to answer', async ({
  page,
}) => {
  // The exact combined question.
  await open(page, '#/combined');
  await expect(page).toHaveURL(/#\/combined\/combined-balance-explanation\/0$/);
  expect(combined.question).toBe(product.primary_questions.combined);
  await expect(inspector(page).locator('.message')).toHaveText(combined.question);
  await expect(answerPanel(page)).toHaveCount(0);

  // MCP tool use and RAG evidence, traced separately.
  await page.getByRole('button', { name: 'Protocol' }).click();
  await jump(page, 15);
  await expect(operationLine(page)).toContainText('Apply topK and threshold');
  await jump(page, 21);
  await expect(operationLine(page)).toContainText('MCP · tools/call');
  await page.getByRole('tab', { name: 'Transport', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Mcp-Name: get_customer_balance');

  // In context: documents are model-visible from the first request, the tool result only from
  // the follow-up request; each is labelled with its source.
  await page.getByRole('button', { name: 'Model context' }).click();
  await jump(page, 17);
  await expect(
    agentState(page).locator('li').filter({ hasText: 'Retained chunks held for the prompt' }),
  ).toContainText('Document evidence · Retained chunks held for the prompt');
  const blocks = seen(page).locator('.context-documents > li');
  await expect(blocks).toHaveCount(5);
  await expect(blocks.first()).toContainText(
    'Document evidence · account-opening.md v1.2 · chunk account-opening@1.2-c50o10-001',
  );
  await expect(seen(page)).not.toContainText('Tool data');
  await jump(page, 31);
  await expect(
    agentState(page).locator('li').filter({ hasText: 'Tool result received' }),
  ).toContainText('Tool data · Tool result received · not yet seen by the model');
  await jump(page, 33);
  const tool = seen(page).locator('.context-list > li').filter({ hasText: 'Tool data' });
  await expect(tool).toHaveCount(1);
  await expect(tool).toContainText('tool · Tool data · get_customer_balance result · ');
  await expect(tool).toContainText('12500.75');
  // Position: the documents sit under the user message, the tool result in its own message after.
  const roles = await seen(page)
    .locator('.context-list > li > .small.muted:first-child')
    .allTextContents();
  expect(roles).toEqual(['system · ', 'user · ', 'assistant · ', 'tool · ']);
  await expect(blocks).toHaveCount(5);

  // The answer: CHF 12,500.75 from the tool, the cited fee, interest and access trade-offs.
  await jump(page, 0);
  await page.getByRole('button', { name: 'Architecture' }).click();
  await playThrough(page);
  await expect(status(page)).toHaveText('Step 35 of 35 · Answer');
  await expect(answerPanel(page)).toBeVisible();
  const shown = await shownStatements(page);
  expect(shown).toEqual(expectedStatements());
  expect(shown.map(([, text]) => text).join(' ')).toBe(combined.expected_answer);
  expect(shown[0]).toEqual([
    'Tool data · MCP',
    'Your current balance is CHF 12,500.75 (source: get_customer_balance tool).',
  ]);
  const documents = shown
    .filter(([label]) => label === 'Document evidence · RAG')
    .map(([, text]) => text)
    .join(' ');
  expect(documents).toContain('the Everyday account costs CHF 5 per month');
  expect(documents).toContain('the Savings account has no monthly fee, pays 0.50% annual interest');
  expect(documents).toContain(
    'the Everyday account includes a debit card for payments and cash withdrawals [3]',
  );
  expect(documents).toContain('the Savings account has no debit card');
  expect(shown.at(-1)).toEqual([
    'Comparison',
    expect.stringMatching(/^Whether the Savings account would be better/),
  ]);
  await expect(answerPanel(page).locator('.source-line')).toHaveText(combined.expected_sources);
  // The sources in the order of their statements: tool data first, then the documents.
  await expect(answerPanel(page).locator('.combined-source h5')).toHaveText([
    'Tool data',
    'Documents',
  ]);
  await expect(answerPanel(page).locator('.combined-source').first().locator('p')).toHaveText(
    'get_customer_balance result, returned at step 30',
  );

  // Provenance by label and position: the label column sits left of every statement.
  for (const li of await statements(page).all()) {
    const label = await li.locator('.statement-source').boundingBox();
    const text = await li.locator('.statement-text').boundingBox();
    expect(label && text && label.x + label.width <= text.x).toBe(true);
  }

  // The balance opens the tool result; each citation opens its chunk.
  const balance = answerPanel(page).getByRole('button', { name: /^CHF 12,500\.75: / });
  await expect(balance).toHaveAccessibleName(
    'CHF 12,500.75: the get_customer_balance tool result, returned at step 30',
  );
  await balance.click();
  await expect(balance).toHaveAttribute('aria-pressed', 'true');
  await expect(balance).toBeFocused();
  const opened = answerPanel(page).locator('#combined-evidence');
  await expect(opened.locator('.evidence-title')).toHaveText('Tool result · get_customer_balance');
  await expect(opened).toContainText('"balance": 12500.75');
  await expect(opened).toContainText('The model first saw it at step 33.');
  const citation = answerPanel(page).getByRole('button', {
    name: 'Citation 3: everyday-account.md v1.2, chunk everyday-account@1.2-c50o10-001',
  });
  await citation.first().click();
  await expect(balance).toHaveAttribute('aria-pressed', 'false');
  await expect(citation.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(citation.first()).toBeFocused();
  await expect(opened.locator('.evidence-title')).toHaveText(
    '[3] chunk everyday-account@1.2-c50o10-001',
  );
  await expect(opened.locator('.chunk-mark')).toContainText('It costs CHF 5 per month');
  await citation.first().click();
  await expect(opened).toBeEmpty();
  // The tool result's step link jumps there; the panel disappears and focus moves to the slider.
  await balance.click();
  await opened.getByRole('button', { name: 'step 30' }).click();
  await expect(status(page)).toContainText('Step 30 of 35');
  await expect(answerPanel(page)).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Step' })).toBeFocused();
  await expect(operationLine(page)).toContainText('tools/call result');

  // combined-missing-terms: the answer states the evidence gap instead of comparing.
  if (!missing) throw new Error('no Combined variant');
  await page.locator('.picker summary').click();
  const item = page.locator('.picker li').filter({ hasText: missing.title });
  await expect(item).toContainText(missing.lesson ?? '');
  await item.getByRole('link').click();
  await expect(page).toHaveURL(/#\/combined\/combined-missing-terms\/0$/);
  await expect(page.locator('.headline')).toHaveText(missing.lesson ?? '');
  await jump(page, 35);
  const gap = await shownStatements(page);
  expect(gap).toEqual(
    expectedStatements((missing as unknown as { fixture_overrides: JsonObject }).fixture_overrides),
  );
  expect(gap.map(([, text]) => text).join(' ')).toBe(missing.expected_answer);
  expect(gap.slice(-2)).toEqual([
    [
      'Not in the evidence',
      "The retrieved evidence does not cover the Savings account's fee and interest, the Savings account's minimum balance, the Savings account's card access, the Savings account's withdrawal rules and transfers between the accounts.",
    ],
    [
      'Comparison',
      "Without the Savings account terms I can't say whether another account type would offer better conditions.",
    ],
  ]);
  await expect(answerPanel(page).locator('.source-line')).toHaveText(missing.expected_sources);
  await expect(answerPanel(page)).not.toContainText('savings-account.md');
});

test('on narrow screens each label sits above its statement', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/combined/combined-balance-explanation/35');
  await page.locator('[data-measured][data-presentation="list"]').waitFor();
  for (const li of await statements(page).all()) {
    const label = await li.locator('.statement-source').boundingBox();
    const text = await li.locator('.statement-text').boundingBox();
    expect(label && text && label.y + label.height <= text.y + 1).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('a failed tool call is labelled as failed in context, and labels keep their separator', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await open(page, '#/mcp/mcp-jsonrpc-error/16');
  await page.getByRole('button', { name: 'Model context' }).click();
  const tool = seen(page).locator('.context-list > li').filter({ hasText: 'tool ·' });
  await expect(tool).toContainText('Tool call failed · get_balance');
  await expect(tool).not.toContainText('Tool data');
  await expect(
    agentState(page).locator('li').filter({ hasText: 'Tool message stored in conversation' }),
  ).toContainText('Tool call failed · Tool message stored in conversation');

  // At 820 px no separator after a label wraps onto a line of its own.
  for (const hash of ['#/mcp/mcp-not-found/26', '#/combined/combined-balance-explanation/33']) {
    await open(page, hash);
    await page.getByRole('button', { name: 'Model context' }).click();
    const orphans = await page.locator('#context-panel').evaluate((panel) =>
      [...panel.querySelectorAll('.source-label')].flatMap((label) => {
        const after = label.nextSibling;
        if (!after || after.nodeType !== Node.TEXT_NODE) return ['no separator'];
        const at = (after.textContent ?? '').indexOf('·');
        if (at < 0) return ['no separator'];
        const range = document.createRange();
        range.setStart(after, at);
        range.setEnd(after, at + 1);
        const dot = range.getClientRects()[0];
        const last = [...label.getClientRects()].at(-1);
        return dot && last && Math.abs(dot.top - last.top) < 2 ? [] : [label.textContent ?? ''];
      }),
    );
    expect(orphans, hash).toEqual([]);
    // An isError result of an existing tool is still tool data, named an error result.
    if (hash.includes('mcp-not-found'))
      await expect(seen(page)).toContainText('Tool data · get_customer_balance error result');
  }
  await expect(seen(page)).toContainText('Tool data · get_customer_balance result');
});
