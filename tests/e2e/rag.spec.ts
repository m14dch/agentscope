// 08-acceptance-tests.yaml e2e_tests: rag-walkthrough (ingestion, issue #14; retrieval, issue
// #15), and the retrieval panel against every 05-rag-scenarios.yaml reference_results entry.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { parseSpec } from '../../scripts/spec-sources';
import { RagEngine, type RagFixtures } from '../../src/rag/engine';
import { expect, test } from './fixtures';

interface Reference {
  parameters: Record<string, unknown>;
  selected: { chunkId: string; score: number; rerankScore?: number }[];
  answer: string;
  sources: string[];
  ranking?: { chunkId: string; score: number; embedding: number[] }[];
  query_embedding?: number[];
  keyword_hits?: { chunkId: string; keywordScore: number; score: number }[];
}
interface Rag {
  fixtures: RagFixtures;
  principles: string[];
  scenarios: { id: string; events: { id: string; payload: Record<string, unknown> }[] }[];
  reference_results: Record<string, Reference | string>;
}
const rag = parseSpec(
  readFileSync(join(import.meta.dirname, '../../specifications/05-rag-scenarios.yaml'), 'utf8'),
) as Rag;
const index = rag.scenarios.find((s) => s.id === 'rag-index');
const payload = (id: string) => index?.events.find((e) => e.id === id)?.payload ?? {};
const engine = new RagEngine(rag.fixtures);

const panel = (page: Page) => page.getByRole('region', { name: 'Chunks and vectors' });
const retrieval = (page: Page) =>
  page.getByRole('region', { name: 'Why each chunk was kept or dropped' });
const scoreRow = (page: Page, chunkId: string) =>
  retrieval(page).locator(`.dotplot li[data-chunk="${chunkId}"]`);

function reference(name: string): Reference {
  const ref = rag.reference_results[name];
  if (!ref || typeof ref === 'string') throw new Error(`no reference_results.${name}`);
  return ref;
}

interface Shown {
  selected: { chunkId: string; score: number; rerankScore?: number }[];
  answer: string;
  sources: string[];
}

/** What a reference entry says the screen shows. */
function expected(ref: Reference): Shown {
  return { selected: ref.selected, answer: ref.answer, sources: ref.sources };
}

/**
 * The retained chunks as the score plot shows them, in rank order, with their scores (and
 * reranker scores where shown), the answer text and the source lines.
 */
async function onScreen(page: Page): Promise<Shown> {
  const rows = await retrieval(page)
    .locator('.dotplot li[data-chunk]')
    .evaluateAll((lis) =>
      lis.map((li) => ({
        chunkId: (li as HTMLElement).dataset['chunk'] ?? '',
        score: li.querySelector('.score-value')?.textContent ?? '',
        outcome: li.querySelector('.outcome')?.textContent ?? '',
      })),
    );
  const selected = rows
    .flatMap((r) => {
      const rank = /^retained, rank (\d+)/.exec(r.outcome);
      if (!rank) return [];
      const rerank = /rerank (\d\.\d+)/.exec(r.outcome);
      return [
        {
          rank: Number(rank[1]),
          chunkId: r.chunkId,
          score: Number(r.score),
          ...(rerank ? { rerankScore: Number(rerank[1]) } : {}),
        },
      ];
    })
    .sort((a, b) => a.rank - b.rank)
    .map((r) => {
      const { rank, ...rest } = r;
      void rank;
      return rest;
    });
  return {
    selected,
    answer: (await retrieval(page).locator('.answer-text').textContent()) ?? '',
    sources: await retrieval(page).locator('.source-line').allTextContents(),
  };
}

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
    await open(page, '#/rag/rag-index/0/architecture');
    await expect(panel(page)).toBeHidden();
    // Run ingestion.
    await page.getByRole('combobox', { name: 'Play speed' }).selectOption('4');
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

    // The words the selected chunk shares with its neighbour are marked in place, in the
    // document and in both chunks, and stated in words.
    const shared = 'Statements are available every month in online banking. Domestic transfers';
    const documentText = panel(page).locator('.ingestion-text').first();
    await expect(documentText.locator('.overlap')).toHaveText(shared);
    await expect(documentText.locator('.chunk-mark')).toHaveCount(2);
    const chunkTexts = panel(page).locator('.chunk-list .ingestion-text');
    await expect(chunkTexts.nth(0).locator('.overlap')).toHaveText(shared);
    await expect(chunkTexts.nth(1).locator('.overlap')).toHaveText(shared);
    await expect(panel(page).locator('.shared-note')).toHaveText(
      'Words 40–49 are also in everyday-account@1.2-c50o10-002.',
    );
  });

  test('dense overlap marks only what the selected chunk shares with its neighbours', async ({
    page,
  }) => {
    await open(page, '#/rag/rag-index/10/architecture');
    await page.getByRole('button', { name: 'Chunk size 25 words' }).click();
    await page.getByRole('button', { name: 'Overlap 20 words' }).click();
    // The first chunk (words 0–24) shares words 5–24 with the second only.
    await expect(panel(page).locator('.shared-note')).toHaveText(
      'Words 5–24 are also in everyday-account@1.2-c25o20-002.',
    );
    const documentText = panel(page).locator('.ingestion-text').first();
    const marked = (await documentText.locator('.overlap').allTextContents()).join('');
    expect(marked.trim().split(/\s+/)).toHaveLength(20);
    // Only the selected chunk and its neighbour carry marks in the list.
    await expect(panel(page).locator('.chunk-list li:has(.overlap)')).toHaveCount(2);
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
    await open(page, '#/rag/rag-index/4/architecture');
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
    await open(page, '#/rag/rag-index/10/architecture');
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

  test('focus moves to the step slider when the panel disappears while holding it', async ({
    page,
  }) => {
    await open(page, '#/rag/rag-index/5/architecture');
    const chunk = panel(page).getByRole('button', { name: 'everyday-account@1.2-c50o10-002' });
    await chunk.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.status')).toHaveText('Step 4 of 10 · Chunk');
    await expect(panel(page)).toBeHidden();
    await expect(page.getByRole('slider', { name: 'Step' })).toBeFocused();
  });

  test('a selected chunk ID that the new parameters no longer play is cleared', async ({
    page,
  }) => {
    await open(page, '#/rag/rag-index/5/protocol');
    await page.getByRole('tab', { name: 'Lineage', exact: true }).click();
    await page
      .getByRole('button', { name: 'Select chunkId "everyday-account@1.2-c50o10-001"' })
      .click();
    await expect(page.locator('.step .label-mark')).toHaveCount(1);
    await page.getByRole('button', { name: 'Chunk size 25 words' }).click();
    await expect(page.locator('.step .label-mark')).toHaveCount(0);
    await expect(page.locator('.select-value[aria-pressed="true"]')).toHaveCount(0);
    // Payload highlights show again: every tracked chunk ID of the step is marked.
    await page.getByRole('tab', { name: 'Payload', exact: true }).click();
    await expect(
      page.locator('.tab-panel .json-mark').filter({ hasText: 'c25o10-001' }).first(),
    ).toBeVisible();
  });

  test('run retrieval, change top K to 4, inspect the prompt, answer and citations', async ({
    page,
  }) => {
    // Run retrieval.
    await open(page, '#/rag/rag-query/0/architecture');
    await expect(retrieval(page)).toBeHidden();
    await page.getByRole('combobox', { name: 'Play speed' }).selectOption('4');
    await page.getByRole('button', { name: 'Play' }).click();
    // Play pauses before retrieve-05, whose prediction asks which document ranks first.
    await expect(page.locator('.prediction')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(retrieval(page)).toBeVisible();
    await page.getByRole('button', { name: 'Play' }).click();
    // Play pauses again before the model request (retrieve-10), whose prediction asks
    // whether the model has seen the documents before.
    await expect(page.locator('.prediction')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.status')).toHaveText('Step 7 of 10 · Assemble grounded prompt');
    await expect(retrieval(page).locator('.retrieval-prompt')).toContainText(
      'the model has not seen it yet',
    );
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.locator('.status')).toHaveText('Step 10 of 10 · Answer', { timeout: 10_000 });
    expect(await onScreen(page)).toEqual(expected(reference('rag-query')));

    // Change top K to 4: scores, prompt and answer change at once, on the same step.
    const before = page.url();
    await page.getByRole('button', { name: 'Top K 4 chunks' }).click();
    await expect(page.getByRole('button', { name: 'Top K 4 chunks' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(page.url()).toBe(before);
    await expect(page.locator('.status')).toHaveText('Step 10 of 10 · Answer');
    const ref = reference('rag-query-top-k-4');
    expect(await onScreen(page)).toEqual(expected(ref));
    await expect(scoreRow(page, 'savings-account@1.2-c50o10-001').locator('.outcome')).toHaveText(
      'outside topK',
    );

    // The changed LLM prompt: four document blocks, in the order of the selection.
    const after = retrieval(page).locator('.retrieval-prompt .retrieval-column').nth(1);
    await expect(after.locator('.document-block')).toHaveCount(4);
    for (const [i, s] of ref.selected.entries()) {
      await expect(after.locator('.document-block').nth(i)).toContainText(`chunk="${s.chunkId}"`);
    }
    await expect(after).not.toContainText('savings-account@1.2-c50o10-001');
    // The model request in the inspector carries the same blocks.
    await page.getByRole('slider', { name: 'Step' }).focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.status')).toHaveText('Step 8 of 10 · Model request');
    await expect(retrieval(page).locator('.retrieval-prompt')).toContainText(
      'Sent to the model at step 8',
    );
    await page.getByRole('tab', { name: 'Payload', exact: true }).click();
    const payload = page.locator('.tab-panel');
    for (const s of ref.selected) await expect(payload).toContainText(`chunk=\\"${s.chunkId}\\"`);
    await expect(payload).not.toContainText('savings-account@1.2-c50o10-001');

    // Citations: each opens its chunk next to the source document.
    await page.getByRole('slider', { name: 'Step' }).focus();
    await page.keyboard.press('End');
    await expect(page.locator('.status')).toHaveText('Step 10 of 10 · Answer');
    const citation = retrieval(page).locator('.citation', { hasText: '[2]' }).first();
    await expect(citation).toHaveAccessibleName(
      'Citation 2: account-opening.md v1.2, chunk account-opening@1.2-c50o10-002',
    );
    await citation.click();
    await expect(citation).toHaveAttribute('aria-pressed', 'true');
    await expect(citation).toBeFocused();
    const opened = retrieval(page).locator('#retrieval-evidence');
    await expect(opened.locator('.evidence-title')).toHaveText(
      '[2] chunk account-opening@1.2-c50o10-002',
    );
    const chunk = engine
      .chunks(engine.corpus(), 50, 10)
      .find((c) => c.id === 'account-opening@1.2-c50o10-002');
    await expect(opened.locator('.evidence-chunk')).toHaveText(chunk?.text ?? '');
    await expect(opened.locator('.chunk-mark')).toHaveText(chunk?.text ?? '');
    // A citation never breaks from the punctuation after it.
    await expect(retrieval(page).locator('.citation-group').first()).toHaveText('[1];');
    await expect(retrieval(page).locator('.citation-group').first()).toHaveCSS(
      'white-space',
      'nowrap',
    );
    // Activating it again closes it.
    await citation.click();
    await expect(opened).toBeEmpty();
    // [1] occurs three times; focus stays on the occurrence that was activated.
    const again = retrieval(page).locator('.citation', { hasText: '[1]' }).nth(1);
    await again.click();
    await expect(again).toBeFocused();
    await expect(opened.locator('.evidence-title')).toHaveText(
      '[1] chunk account-opening@1.2-c50o10-001',
    );
  });

  test('the threshold slider, reranking and full documents recompute at once', async ({ page }) => {
    await open(page, '#/rag/rag-query/10/architecture');
    const threshold = page.getByRole('slider', { name: 'Threshold' });
    await threshold.focus();
    for (let i = 0; i < 25; i += 1) await page.keyboard.press('ArrowRight');
    await expect(threshold).toBeFocused();
    await expect(page.locator('.parameter-value')).toHaveText('0.95');
    // The arrow keys moved the slider, not the cursor.
    await expect(page.locator('.status')).toHaveText('Step 10 of 10 · Answer');
    await expect(retrieval(page).locator('.threshold-label')).toHaveText('threshold 0.95');
    expect(await onScreen(page)).toEqual(expected(reference('rag-query-threshold-0.95')));

    // Reranking adds the rerank step before the cursor: the address keeps naming the step
    // as played at the defaults (02 navigation.route_steps).
    for (let i = 0; i < 25; i += 1) await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.parameter-value')).toHaveText('0.70');
    await page.getByRole('button', { name: 'Reranking' }).click();
    await expect(page.getByRole('button', { name: 'Reranking' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.status')).toHaveText('Step 11 of 11 · Answer');
    expect(page.url()).toMatch(/#\/rag\/rag-query\/10\/architecture$/);
    await expect(scoreRow(page, 'savings-account@1.2-c50o10-002').locator('.outcome')).toHaveText(
      /^retained, rank 2 · rerank 0\.7457$/,
    );
    await expect(retrieval(page).locator('.rerank-note')).toHaveText(
      'With reranking, the 5 best chunks by reranker score are retained, so a retained chunk can have a lower cosine score than a dropped one.',
    );

    // Full documents replace the chunks in the prompt and in the citations.
    await page.getByRole('button', { name: 'Fetch full documents' }).click();
    await expect(page.locator('.status')).toHaveText('Step 13 of 13 · Answer');
    await expect(retrieval(page).locator('.source-line').first()).toHaveText(
      '[1] account-opening.md v1.2, full document',
    );
    await retrieval(page).locator('.citation').first().click();
    await expect(retrieval(page).locator('.evidence-title')).toHaveText(
      '[1] account-opening.md v1.2, full document',
    );
    await expect(retrieval(page).locator('.evidence-chunk')).toHaveCount(0);
  });

  test('the panel follows the steps and hands focus to the slider when it disappears', async ({
    page,
  }) => {
    await open(page, '#/rag/rag-query/4/architecture');
    await expect(retrieval(page)).toBeHidden();
    await open(page, '#/rag/rag-query/5/architecture');
    await expect(retrieval(page)).toBeVisible();
    await expect(retrieval(page).locator('.dotplot .retained')).toHaveCount(0);
    // The threshold comes from retrieve-06, which is not played yet.
    await expect(retrieval(page).locator('.threshold-label')).toHaveCount(0);
    await expect(retrieval(page).locator('.dotplot--threshold')).toHaveCount(0);
    await expect(retrieval(page).locator('.retrieval-prompt')).toHaveCount(0);
    await retrieval(page).getByRole('button', { name: 'step 6' }).click();
    await expect(page.locator('.status')).toHaveText('Step 6 of 10 · Search and filter');
    await expect(retrieval(page).locator('.threshold-label')).toHaveText('threshold 0.70');
    // Without reranking no note repeats what the rows and the threshold already say.
    await expect(retrieval(page).locator('.retrieval-scores p')).toHaveCount(0);
    await expect(retrieval(page).locator('.dotplot .retained')).toHaveCount(5);
    // The prompt is assembled at step 7 and sent at step 8.
    await page.getByRole('button', { name: 'Next' }).click();
    const prompt = retrieval(page).locator('.retrieval-prompt');
    await expect(prompt).toContainText('the model has not seen it yet');
    await expect(prompt.locator('.retrieval-column').first()).toContainText(
      "You are Example Bank's assistant.",
    );
    await expect(retrieval(page).locator('.retrieval-answer')).toHaveCount(0);
    // Focus inside the panel moves to the step slider when the panel disappears.
    await open(page, '#/rag/rag-query/5/architecture');
    await retrieval(page).getByRole('button', { name: 'step 6' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.status')).toHaveText('Step 4 of 10 · Search and filter');
    await expect(retrieval(page)).toBeHidden();
    await expect(page.getByRole('slider', { name: 'Step' })).toBeFocused();
  });

  test('a selected chunk ID marks its label in both plots, never its accent dot', async ({
    page,
  }) => {
    await open(page, '#/rag/rag-query/6/protocol');
    await page.getByRole('tab', { name: 'Lineage', exact: true }).click();
    await page
      .getByRole('button', { name: 'Select chunkId "everyday-account@1.2-c50o10-002"' })
      .click();
    const row = scoreRow(page, 'everyday-account@1.2-c50o10-002');
    await expect(row.locator('.name.chunk-mark')).toHaveCount(1);
    await expect(row.locator('.dot.chunk-mark')).toHaveCount(0);
    await expect(retrieval(page).locator('.dotplot .chunk-mark')).toHaveCount(1);
    const point = retrieval(page).locator(
      '.projection-plot [data-chunk="everyday-account@1.2-c50o10-002"]',
    );
    await expect(point.locator('.label-mark')).toHaveCount(1);
    // The selection background always comes with an ink underline (02 design.colour.use).
    await expect(point.locator('.label-underline')).toHaveCount(1);
    await expect(point.locator('.label-underline')).toHaveCSS('stroke', 'rgb(37, 49, 34)');
    await expect(retrieval(page).locator('.projection-plot .label-mark')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(retrieval(page).locator('.chunk-mark, .label-mark')).toHaveCount(0);
  });
});

test.describe('reference_results on screen', () => {
  for (const [name, ref] of Object.entries(rag.reference_results)) {
    if (typeof ref === 'string') continue;
    test(`${name}: selection, scores, answer and sources`, async ({ page }) => {
      await open(page, '#/rag/rag-query/0/architecture');
      const k = ref.parameters['top_k'];
      if (k !== 5) await page.getByRole('button', { name: `Top K ${String(k)} chunks` }).click();
      const t = Number(ref.parameters['similarity_threshold']);
      if (t !== 0.7) {
        await page.getByRole('slider', { name: 'Threshold' }).focus();
        const steps = Math.round((t - 0.7) * 100);
        for (let i = 0; i < Math.abs(steps); i += 1)
          await page.keyboard.press(steps > 0 ? 'ArrowRight' : 'ArrowLeft');
        await expect(page.locator('.parameter-value')).toHaveText(t.toFixed(2));
      }
      if (ref.parameters['keyword_retrieval'])
        await page.getByRole('button', { name: 'Keyword retrieval' }).click();
      if (ref.parameters['rerank']) await page.getByRole('button', { name: 'Reranking' }).click();
      await page.getByRole('slider', { name: 'Step' }).focus();
      await page.keyboard.press('End');
      await expect(page.locator('.status')).toHaveText(/^Step (\d+) of \1 · Answer$/);
      expect(await onScreen(page)).toEqual(expected(ref));

      // The full ranking and the vectors behind the projection, where the entry gives them.
      const rows = retrieval(page).locator('.dotplot li[data-chunk]');
      if (ref.ranking) {
        const shown = await rows.evaluateAll((lis) =>
          lis.map((li) => [
            (li as HTMLElement).dataset['chunk'],
            Number(li.querySelector('.score-value')?.textContent),
          ]),
        );
        expect(shown).toEqual(ref.ranking.map((r) => [r.chunkId, r.score]));
        for (const r of ref.ranking) {
          const [product, cost, rules, technical] = r.embedding as [number, number, number, number];
          await expect(
            retrieval(page).locator(`.projection-plot [data-chunk="${r.chunkId}"]`),
          ).toHaveAttribute(
            'aria-label',
            new RegExp(
              `^${r.chunkId}: x ${(cost - rules).toFixed(4)}, y ${(product - technical).toFixed(4)}`,
            ),
          );
        }
      }
      if (ref.query_embedding) {
        const [product, cost, rules, technical] = ref.query_embedding as [
          number,
          number,
          number,
          number,
        ];
        await expect(retrieval(page).locator('.projection-plot .query')).toHaveAttribute(
          'aria-label',
          `The question: x ${(cost - rules).toFixed(4)}, y ${(product - technical).toFixed(4)}`,
        );
      }
      if (ref.keyword_hits) {
        const hits = await rows.evaluateAll((lis) =>
          lis.flatMap((li) => {
            const k = /keyword (\d(?:\.\d+)?)/.exec(
              li.querySelector('.outcome')?.textContent ?? '',
            );
            return k
              ? [
                  {
                    chunkId: (li as HTMLElement).dataset['chunk'] ?? '',
                    keywordScore: Number(k[1]),
                    score: Number(li.querySelector('.score-value')?.textContent),
                  },
                ]
              : [];
          }),
        );
        expect(hits.sort((a, b) => (a.chunkId < b.chunkId ? -1 : 1))).toEqual(ref.keyword_hits);
      }
    });
  }
});

test.describe('retrieval panel geometry', () => {
  for (const width of [800, 1024, 1440]) {
    // With keyword retrieval and reranking each row carries its longest outcome.
    test(`rag-query with keyword retrieval and reranking at ${width} px: every text stays in its column`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, '#/rag/rag-query/10/architecture');
      await page.getByRole('button', { name: 'Keyword retrieval' }).click();
      await page.getByRole('button', { name: 'Reranking' }).click();
      await expect(retrieval(page).locator('.answer-text')).toBeVisible();
      const problems = await retrieval(page).evaluate((root) => {
        const out: string[] = [];
        const box = (e: Element) => e.getBoundingClientRect();
        const plot = root.querySelector('.dotplot') as Element;
        const projection = root.querySelector('.retrieval-projection') as Element;
        const p = box(plot);
        for (const li of plot.querySelectorAll('li[data-chunk]')) {
          const id = (li as HTMLElement).dataset['chunk'];
          const track = li.querySelector('.track') as HTMLElement;
          if (track.clientWidth < 192) out.push(`${id}: track ${track.clientWidth}px`);
          for (const part of li.children) {
            const b = box(part);
            const e = part as HTMLElement;
            if (b.right > p.right + 0.5 || b.left < p.left - 0.5)
              out.push(`${id}: ${e.className} leaves the plot`);
            // The track lends its value rooms to the value label, checked below.
            if (!e.classList.contains('track') && e.scrollWidth > e.clientWidth + 1)
              out.push(`${id}: ${e.className} overflows`);
            if (b.bottom > box(projection).top)
              out.push(`${id}: ${e.className} reaches the projection`);
          }
          const value = box(li.querySelector('.value') as Element);
          if (value.left < box(track).left - 56 || value.right > box(track).right + 56)
            out.push(`${id}: value leaves its track`);
        }
        // Projection labels never overlap each other.
        const labels = [...root.querySelectorAll('.point-label')].map((t) =>
          (t as SVGGraphicsElement).getBoundingClientRect(),
        );
        labels.forEach((a, i) =>
          labels.forEach((b, j) => {
            if (
              j > i &&
              a.left < b.right - 1 &&
              a.right > b.left + 1 &&
              a.top < b.bottom - 1 &&
              a.bottom > b.top + 1
            )
              out.push(`projection labels ${i} and ${j} overlap`);
          }),
        );
        // Nor any point mark (the label's own one included).
        const marks = [...root.querySelectorAll('.projection-plot .mark')].map((m) =>
          (m as SVGGraphicsElement).getBoundingClientRect(),
        );
        labels.forEach((a, i) =>
          marks.forEach((m, j) => {
            if (
              a.left < m.right - 1 &&
              a.right > m.left + 1 &&
              a.top < m.bottom - 1 &&
              a.bottom > m.top + 1
            )
              out.push(`projection label ${i} over mark ${j}`);
          }),
        );
        // From 768 px the projection fits without scrolling (02 labels_and_charts).
        const holder = root.querySelector('.projection') as HTMLElement;
        if (holder.scrollWidth > holder.clientWidth + 1)
          out.push(`projection scrolls: ${holder.scrollWidth} > ${holder.clientWidth}`);
        return out;
      });
      expect(problems).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    });
  }
});
