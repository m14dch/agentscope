// 08-acceptance-tests.yaml e2e_tests: rag-walkthrough. Issue #14 covers its ingestion steps
// ("Run ingestion", "Inspect chunks and vectors"); the retrieval steps belong to issue #15.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { parseSpec } from '../../scripts/spec-sources';
import { RagEngine, type RagFixtures } from '../../src/rag/engine';
import { expect, test } from './fixtures';

interface Rag {
  fixtures: RagFixtures;
  principles: string[];
  scenarios: { id: string; events: { id: string; payload: Record<string, unknown> }[] }[];
}
const rag = parseSpec(
  readFileSync(join(import.meta.dirname, '../../specifications/05-rag-scenarios.yaml'), 'utf8'),
) as Rag;
const index = rag.scenarios.find((s) => s.id === 'rag-index');
const payload = (id: string) => index?.events.find((e) => e.id === id)?.payload ?? {};
const engine = new RagEngine(rag.fixtures);

const panel = (page: Page) => page.getByRole('region', { name: 'Chunks and vectors' });

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`./${hash}`);
  await page.locator('[data-measured] svg.diagram').waitFor();
}

/** Every chunk ID and vector the panel shows, document by document. */
async function shown(page: Page): Promise<{ chunkId: string; embedding: number[] }[]> {
  const out: { chunkId: string; embedding: number[] }[] = [];
  const menu = panel(page).getByLabel('Document');
  for (const value of await menu
    .locator('option')
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))) {
    await menu.selectOption(value);
    const buttons = panel(page).locator('.chunk-select');
    for (let i = 0; i < (await buttons.count()); i += 1) {
      await buttons.nth(i).click();
      const chunkId = (await buttons.nth(i).textContent()) ?? '';
      await expect(panel(page).locator('.chunk-id')).toHaveText(chunkId);
      const values = await panel(page).locator('.vector-value').allTextContents();
      out.push({ chunkId, embedding: values.map(Number) });
    }
  }
  return out;
}

test.describe('rag-walkthrough', () => {
  test('run ingestion, then inspect chunks and vectors equal to index-05 and index-07', async ({
    page,
  }) => {
    await open(page, '#/rag/rag-index/0');
    await expect(panel(page)).toBeHidden();
    // Run ingestion.
    await page.getByRole('button', { name: 'Speed 4×' }).click();
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.locator('.status')).toHaveText('Step 10 of 10 · Store', { timeout: 10_000 });
    await expect(panel(page)).toBeVisible();

    // Inspect chunks and vectors.
    const chunks = payload('index-05')['chunks'] as { chunkId: string }[];
    const embeddings = payload('index-07')['embeddings'] as {
      chunkId: string;
      embedding: number[];
    }[];
    expect(chunks.map((c) => c.chunkId)).toEqual(embeddings.map((e) => e.chunkId));
    expect(await shown(page)).toEqual(embeddings);

    // The selected chunk's metadata, lexicon words and the embedding statement.
    await panel(page).getByLabel('Document').selectOption('everyday-account.md');
    await panel(page).getByRole('button', { name: 'everyday-account@1.2-c50o10-001' }).click();
    const note = rag.principles.find((p) => p.startsWith('The demo embedding')) ?? '';
    await expect(panel(page)).toContainText(note);
    await expect(panel(page).locator('.chunk-meta')).toContainText('Visibilitypublic');
    const product = panel(page).getByRole('row', { name: /^product/ });
    await expect(product).toContainText('everyday ×2, account ×3, standard');
    await expect(product).toContainText('6.1');
    await expect(product).toContainText('0.6186');

    // Overlap words are marked in place: words 40–49 of the Everyday document.
    const documentText = panel(page).locator('.ingestion-text').first();
    await expect(documentText.locator('.overlap')).toHaveText(
      'Statements are available every month in online banking. Domestic transfers',
    );
    await expect(documentText.locator('.chunk-mark')).toHaveCount(2);
  });

  test('chunk size and overlap recompute chunks and vectors at once, on the same step', async ({
    page,
  }) => {
    await open(page, '#/rag/rag-index/7/protocol');
    const before = page.url();
    await page.getByRole('button', { name: 'Chunk size 25 words' }).click();
    await page.getByRole('button', { name: 'Overlap 0 words' }).click();
    await expect(page.getByRole('button', { name: 'Chunk size 25 words' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Parameters are not part of the route; the cursor stays on index-07.
    expect(page.url()).toBe(before);
    await expect(page.locator('.status')).toHaveText('Step 7 of 10 · Embed');
    const docs = engine.corpus();
    const expected = engine
      .chunks(docs, 25, 0)
      .map((c) => ({ chunkId: c.id, embedding: c.embedding }));
    expect(await shown(page)).toEqual(expected);
    await expect(panel(page).locator('.overlap')).toHaveCount(0);
    // The inspector's payload is recomputed too.
    await expect(page.locator('.tab-panel')).toContainText('everyday-account@1.2-c25o0-004');
  });

  test('before the embed step the panel names the step that computes the vector', async ({
    page,
  }) => {
    await open(page, '#/rag/rag-index/4');
    await expect(panel(page)).toBeHidden();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator('.vector')).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'step 7' }).click();
    await expect(page.locator('.status')).toHaveText('Step 7 of 10 · Embed');
    // The link is gone once the vector shows; focus moves to the chunk's heading.
    await expect(panel(page).locator('.chunk-id')).toBeFocused();
    await expect(panel(page).locator('.vector-value')).toHaveCount(4);
  });

  test('focus stays on the chosen chunk and the parameter control while the panel rebuilds', async ({
    page,
  }) => {
    await open(page, '#/rag/rag-index/10');
    const second = panel(page).getByRole('button', { name: 'everyday-account@1.2-c50o10-002' });
    await second.focus();
    await page.keyboard.press('Enter');
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(second).toBeFocused();
    const size = page.getByRole('button', { name: 'Chunk size 100 words' });
    await size.focus();
    await page.keyboard.press('Enter');
    await expect(size).toBeFocused();
    // The selection follows to the chunk that holds word 40: the only 100-word chunk.
    await expect(panel(page).locator('.chunk-id')).toHaveText('everyday-account@1.2-c100o10-001');
  });

  // Run retrieval, change topK to 4, inspect the changed prompt, answer and citations:
  // issue #15 (RAG retrieval view) implements these steps here.
  test.fixme('run retrieval and change topK (issue #15)', async () => {});
});
