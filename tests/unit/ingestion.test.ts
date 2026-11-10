import { describe, expect, it } from 'vitest';
import { Player } from '../../src/engine/player.ts';
import {
  type IngestionModel,
  ingestionModel,
  runs,
  selectedChunk,
  sharedRanges,
  sharedText,
  sourceDocuments,
} from '../../src/inspector/ingestion.ts';
import { createPlayback, ragDerivation } from '../../src/rag/bundled.ts';
import { SMOOTHING, words } from '../../src/rag/engine.ts';
import { loadRegistry } from '../../src/scenarios/registry.ts';
import type { JsonObject, Scenario } from '../../src/scenarios/types.ts';

const registry = loadRegistry();
const { engine } = ragDerivation();
const scenario = registry['rag-index'] as Scenario;
const sources = sourceDocuments(engine.corpus(), engine.fixtures.documents);
const yaml = (id: string): JsonObject =>
  scenario.events.find((e) => e.id === id)?.payload as JsonObject;

/** Steps of index-05 and index-07 at the default parameters. */
const CHUNKED = 5;
const EMBEDDED = 7;

function model(player: Player): IngestionModel {
  const m = ingestionModel(player.playback.events, player.cursor, sources);
  if (!m) throw new Error('no ingestion model');
  return m;
}

describe('ingestion panel model', () => {
  it('appears only once the chunks are returned, and shows vectors from index-07 on', () => {
    const player = new Player(createPlayback(scenario));
    player.jump(CHUNKED - 1);
    expect(ingestionModel(player.playback.events, player.cursor, sources)).toBeUndefined();
    player.jump(CHUNKED);
    expect(model(player).vectors).toBe(false);
    expect(model(player).vectorStep).toBe(EMBEDDED);
    expect(
      model(player)
        .documents.flatMap((d) => d.chunks)
        .some((c) => c.vector),
    ).toBe(false);
    player.jump(EMBEDDED);
    expect(model(player).vectors).toBe(true);
  });

  it('holds the chunk IDs of index-05 and the vectors of index-07 at the defaults', () => {
    const player = new Player(createPlayback(scenario));
    player.jump(player.playback.length);
    const chunks = model(player).documents.flatMap((d) => d.chunks);
    const expected = yaml('index-05')['chunks'] as JsonObject[];
    expect(chunks.map((c) => c.id)).toEqual(expected.map((c) => c['chunkId']));
    expect(chunks.map((c) => c.words.join(' '))).toEqual(expected.map((c) => c['text']));
    const vectors = yaml('index-07')['embeddings'] as JsonObject[];
    expect(chunks.map((c) => [c.id, c.vector])).toEqual(
      vectors.map((v) => [v['chunkId'], v['embedding']]),
    );
    expect(model(player).documents.map((d) => d.documentId)).toEqual(
      engine.fixtures.documents.map((d) => d.id),
    );
    expect([model(player).chunkSize, model(player).overlap]).toEqual([50, 10]);
  });

  it('finds the words the selected chunk shares with its previous and next chunk', () => {
    const player = new Player(createPlayback(scenario));
    player.jump(CHUNKED);
    const everyday = model(player).documents[0];
    if (!everyday) throw new Error('no document');
    expect(everyday.words.length).toBe(79);
    const [first, second] = everyday.chunks;
    if (!first || !second) throw new Error('no chunks');
    // Chunks at words 0–49 and 40–78 share words 40–49.
    const ranges = sharedRanges(everyday, first);
    expect(ranges.map((r) => [r.neighbour.id, r.from, r.to])).toEqual([
      ['everyday-account@1.2-c50o10-002', 40, 50],
    ]);
    expect(sharedText(ranges)).toBe('Words 40–49 are also in everyday-account@1.2-c50o10-002.');
    expect(sharedRanges(everyday, second).map((r) => [r.neighbour.id, r.from, r.to])).toEqual([
      ['everyday-account@1.2-c50o10-001', 40, 50],
    ]);
    expect(everyday.words.slice(40, 50)).toEqual(second.words.slice(0, 10));

    // At 25 words with 20 shared, only the immediate neighbours count, not every chunk
    // that holds a word: the third chunk (words 10–34) shares 15–34 and 10–29.
    player.setParameters({ chunk_size_words: 25, overlap_words: 20 });
    const dense = model(player).documents[0];
    if (!dense) throw new Error('no document');
    const third = dense.chunks[2];
    if (!third) throw new Error('no chunk');
    expect(third.startWord).toBe(10);
    expect(sharedRanges(dense, third).map((r) => [r.neighbour.startWord, r.from, r.to])).toEqual([
      [5, 10, 30],
      [15, 15, 35],
    ]);
    const last = dense.chunks.at(-1);
    if (!last) throw new Error('no chunk');
    expect(sharedRanges(dense, last)).toHaveLength(1);

    player.setParameters({ chunk_size_words: 50, overlap_words: 0 });
    const none = model(player).documents[0];
    if (!none?.chunks[0]) throw new Error('no chunk');
    expect(sharedRanges(none, none.chunks[0])).toEqual([]);
    expect(sharedText([])).toBe('The selected chunk shares no words with its neighbours.');
  });

  it('recomputes chunks and vectors at once when the parameters change, on the same event', () => {
    const player = new Player(createPlayback(scenario));
    player.jump(EMBEDDED);
    player.setParameters({ chunk_size_words: 25, overlap_words: 0 });
    expect(player.cursor).toBe(EMBEDDED);
    const m = model(player);
    const everyday = m.documents[0];
    expect(everyday?.chunks.map((c) => c.id)).toEqual([
      'everyday-account@1.2-c25o0-001',
      'everyday-account@1.2-c25o0-002',
      'everyday-account@1.2-c25o0-003',
      'everyday-account@1.2-c25o0-004',
    ]);
    expect(everyday?.chunks.map((c) => c.startWord)).toEqual([0, 25, 50, 75]);
    for (const c of m.documents.flatMap((d) => d.chunks)) {
      expect(c.vector).toEqual(engine.embed(c.words.join(' ')));
    }
    expect([m.chunkSize, m.overlap]).toEqual([25, 0]);
  });

  it('keeps the selection on the chunk that holds its first word after a change', () => {
    const player = new Player(createPlayback(scenario));
    player.jump(CHUNKED);
    const first = selectedChunk(model(player), undefined);
    expect(first?.chunk.id).toBe('everyday-account@1.2-c50o10-001');
    const selection = { documentId: 'savings-account.md', startWord: 40 };
    expect(selectedChunk(model(player), selection)?.chunk.id).toBe(
      'savings-account@1.2-c50o10-002',
    );
    player.setParameters({ chunk_size_words: 25, overlap_words: 0 });
    // Word 40 lies in the chunk of words 25–49.
    expect(selectedChunk(model(player), selection)?.chunk.id).toBe('savings-account@1.2-c25o0-002');
    player.setParameters({ chunk_size_words: 100, overlap_words: 20 });
    expect(selectedChunk(model(player), selection)?.chunk.id).toBe(
      'savings-account@1.2-c100o20-001',
    );
    // An unknown document falls back to the first chunk of the first document.
    expect(selectedChunk(model(player), { documentId: 'nope', startWord: 3 })?.chunk.id).toBe(
      'everyday-account@1.2-c100o20-001',
    );
  });

  it('groups words into runs that share their marks', () => {
    const marks = (i: number) => ({ overlap: i >= 2, selected: i === 3 });
    expect(runs(['a', 'b', 'c', 'd', 'e'], marks)).toEqual([
      { text: 'a b', overlap: false, selected: false },
      { text: ' c', overlap: true, selected: false },
      { text: ' d', overlap: true, selected: true },
      { text: ' e', overlap: true, selected: false },
    ]);
  });

  it('keeps the document metadata the records store', () => {
    const doc = sources.find((d) => d.documentId === 'account-opening.md');
    expect(doc).toMatchObject({
      version: '1.2',
      title: 'Opening an account',
      visibility: 'public',
    });
    expect(doc?.words).toEqual(words(engine.fixtures.documents[2]?.text ?? ''));
  });
});

describe('demo embedding working', () => {
  it('lists the lexicon words per dimension and the sums the vector normalizes', () => {
    const text = (yaml('index-05')['chunks'] as JsonObject[])[0]?.['text'] as string;
    const working = engine.embedding(text);
    expect(working.vector).toEqual([0.6186, 0.3144, 0.72, 0.0101]);
    expect(working.vector).toEqual(engine.embed(text));
    expect(working.dimensions.map((d) => d.name)).toEqual([
      'product',
      'cost',
      'rules',
      'technical',
    ]);
    const [product, cost, rules, technical] = working.dimensions;
    expect(product?.hits).toEqual([
      { word: 'everyday', count: 2, weight: 1 },
      { word: 'account', count: 3, weight: 1 },
      { word: 'standard', count: 1, weight: 1 },
    ]);
    expect(cost?.hits.map((h) => h.word)).toEqual(['costs', 'chf', 'interest']);
    expect(product?.sum).toBeCloseTo(6.1, 10);
    expect(technical?.hits).toEqual([]);
    expect(technical?.sum).toBe(SMOOTHING);
    for (const d of working.dimensions) {
      const total = d.hits.reduce((s, h) => s + h.count * h.weight, SMOOTHING);
      expect(d.sum).toBeCloseTo(total, 10);
    }
    expect(rules?.sum).toBeCloseTo(7.1, 10);
    const length = Math.hypot(...working.dimensions.map((d) => d.sum));
    expect(working.length).toBeCloseTo(length, 10);
  });

  it('counts a word of two dimensions in both with its weight', () => {
    const working = engine.embedding('Terms and conditions');
    expect(working.dimensions[1]?.hits).toEqual([
      { word: 'terms', count: 1, weight: 0.5 },
      { word: 'conditions', count: 1, weight: 0.5 },
    ]);
    expect(working.dimensions[2]?.hits.map((h) => h.word)).toEqual(['terms', 'conditions']);
    expect(working.dimensions[1]?.sum).toBeCloseTo(1.1, 10);
  });
});
