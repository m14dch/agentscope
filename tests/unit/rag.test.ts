import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import acceptanceYaml from '../../specifications/08-acceptance-tests.yaml?raw';
import sources from 'virtual:agentscope-specs';
import { Playback, type Snapshot } from '../../src/engine/playback.ts';
import { type Clock, Player } from '../../src/engine/player.ts';
import { createPlayback, ragDerivation } from '../../src/rag/bundled.ts';
import { thresholdText } from '../../src/rag/derive.ts';
import {
  NO_EVIDENCE_ANSWER,
  RagEngine,
  modelMessage,
  normalize,
  pyRound,
  round4,
  sourceLines,
  sourceObjects,
  tokens,
  words,
} from '../../src/rag/engine.ts';
import { loadRegistry } from '../../src/scenarios/registry.ts';
import type { Json, JsonObject, Scenario, ScenarioEvent } from '../../src/scenarios/types.ts';
import { contextFrom, validateRegistry } from '../../src/scenarios/validate.ts';

const registry = loadRegistry();
const rag = ragDerivation();
const engine = rag.engine;

interface Reference {
  parameters: {
    chunk_size_words: number;
    overlap_words: number;
    top_k: number;
    similarity_threshold: number;
    keyword_retrieval?: boolean;
    rerank?: boolean;
  };
  selected: { chunkId: string; score: number; rerankScore?: number }[];
  answer: string;
  sources: string[];
  ranking?: { chunkId: string; score: number; embedding: number[] }[];
  query_embedding?: number[];
  keyword_query_terms?: string[];
  keyword_hits?: { chunkId: string; keywordScore: number; score: number }[];
}

const references = Object.entries(
  (sources.rag as unknown as { reference_results: Record<string, Reference | string> })
    .reference_results,
).filter((entry): entry is [string, Reference] => entry[0] !== 'note');

const combined = sources.comparison.combined as unknown as {
  id: string;
  expected_answer: string;
  expected_sources: string[];
};

function scenario(id: string): Scenario {
  const scn = registry[id];
  if (!scn) throw new Error(`no scenario ${id}`);
  return scn;
}

const all = (p: Playback): Snapshot[] =>
  Array.from({ length: p.length + 1 }, (_, k) => p.snapshot(k));
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const local = (p: Playback, e: ScenarioEvent): string => e.id.replace(`${p.scenario.id}:`, '');

/** The played event with this local ID. */
function played(p: Playback, id: string): ScenarioEvent {
  const e = p.events.find((x) => local(p, x) === id);
  if (!e) throw new Error(`${p.scenario.id} plays no ${id}`);
  return e;
}

/** A structured source as its source line. */
const sourceLine = (s: JsonObject): string =>
  `[${String(s['citation'])}] ${String(s['documentId'])} v${String(s['version'])}, ` +
  (s['chunkId'] === undefined ? 'full document' : `chunk ${String(s['chunkId'])}`);

const field = (value: Json | undefined, ...path: (string | number)[]): Json | undefined =>
  path.reduce<Json | undefined>(
    (node, key) =>
      node !== null && typeof node === 'object'
        ? (node as Record<string, Json>)[key as string]
        : undefined,
    value,
  );

describe('engine primitives', () => {
  it("rounds like Python's round(x, 4): exact decimal value, ties to even", () => {
    expect(round4(0.03125)).toBe(0.0312); // Math.round would give 0.0313
    expect(round4(0.15625)).toBe(0.1562);
    expect(round4(0.09375)).toBe(0.0938);
    expect(round4(1.00005)).toBe(1.0001); // the double is slightly above the tie
    expect(round4(0.123449999)).toBe(0.1234);
    expect(round4(-0.03125)).toBe(-0.0312);
    expect(round4(0)).toBe(0);
    expect(round4(2.5)).toBe(2.5);
    expect([pyRound(2.5, 0), pyRound(3.5, 0), pyRound(-0.5, 0), pyRound(7.49, 0)]).toEqual([
      2, 4, -0, 7,
    ]);
    expect(() => pyRound(1, -1)).toThrow(RangeError);
    expect(() => pyRound(1, 1.5)).toThrow(RangeError);
  });

  it("writes thresholds as validate_specs.py's threshold_text does", () => {
    // str(round(x, 2)) without a trailing '.0': 0 and 1 read '0' and '1' in both.
    expect([0, 1, 0.7, 0.05, 0.125, 0.995, 0.355].map(thresholdText)).toEqual([
      '0',
      '1',
      '0.7',
      '0.05',
      '0.12',
      '0.99',
      '0.35',
    ]);
  });

  it('normalizes headings and lines and tokenizes runs of [a-z0-9]', () => {
    expect(normalize('# Title\nOne line.\n## Sub  heading\nTwo')).toBe(
      'Title One line. Sub  heading Two',
    );
    expect(tokens('GET /customers/{customerId}: HTTP 404, balances:read')).toEqual([
      'get',
      'customers',
      'customerid',
      'http',
      '404',
      'balances',
      'read',
    ]);
  });

  it('chunks word windows with overlap and stable IDs, stopping at the last word', () => {
    const doc = {
      documentId: 'a.b.md',
      version: '2.0',
      text: Array.from({ length: 12 }, (_, i) => `w${i}`).join(' '),
      trust: 'official' as const,
    };
    const chunks = engine.chunks([doc], 5, 2);
    expect(chunks.map((c) => [c.id, c.startWord, c.text])).toEqual([
      ['a.b@2.0-c5o2-001', 0, 'w0 w1 w2 w3 w4'],
      ['a.b@2.0-c5o2-002', 3, 'w3 w4 w5 w6 w7'],
      ['a.b@2.0-c5o2-003', 6, 'w6 w7 w8 w9 w10'],
      ['a.b@2.0-c5o2-004', 9, 'w9 w10 w11'],
    ]);
    expect(engine.chunks([{ ...doc, text: 'w0 w1 w2 w3 w4' }], 5, 2)).toHaveLength(1);
    expect(() => engine.chunks([doc], 5, 5)).toThrow(RangeError);
  });

  it('embeds with 0.1 smoothing and L2 normalization', () => {
    // No lexicon word: the smoothed vector is uniform.
    expect(engine.embed('nothing here')).toEqual([0.5, 0.5, 0.5, 0.5]);
    const v = engine.embed('account fee');
    expect(Math.hypot(...v)).toBeCloseTo(1, 3);
    expect(v[0]).toBe(v[1]);
    expect(RagEngine.cosine(v, v)).toBe(1);
    expect(RagEngine.cosine([1, 0], [0, 1])).toBe(0);
  });

  it('indexes every document of the fixtures at its version, with its trust level', () => {
    expect(engine.corpus().map((d) => `${d.documentId}@${d.version} ${d.trust}`)).toEqual(
      engine.fixtures.documents.map((d) => `${d.id}@${d.version} ${d.trust}`),
    );
    expect(engine.trustOf('account-opening.md')).toBe('official');
    expect(() => engine.trustOf('nope.md')).toThrow(/unknown document/);
  });

  it('answers exactly that nothing was found without retained chunks', () => {
    const answer = engine.answer([]);
    expect(answer).toMatchObject({ text: NO_EVIDENCE_ANSWER, cited: [] });
    expect(modelMessage(answer)).toBe(NO_EVIDENCE_ANSWER);
  });
});

describe('reference results (05-rag-scenarios.yaml)', () => {
  it.each(references)('%s: selection, scores, answer and sources', (_name, ref) => {
    const p = ref.parameters;
    const r = engine.retrieve(engine.corpus(), {
      chunkSize: p.chunk_size_words,
      overlap: p.overlap_words,
      topK: p.top_k,
      threshold: p.similarity_threshold,
      rerank: p.rerank ?? false,
    });
    expect(
      r.selected.map((c) => ({
        chunkId: c.id,
        score: c.score,
        ...(p.rerank ? { rerankScore: c.rerank } : {}),
      })),
    ).toEqual(ref.selected);
    const answer = engine.answer(r.selected);
    expect(answer.text).toBe(ref.answer);
    expect(sourceLines(answer.cited)).toEqual(ref.sources);
    // Every citation resolves to a source fixture.
    for (const c of answer.cited) {
      const doc = engine
        .corpus()
        .find((d) => d.documentId === c.documentId && d.version === c.version);
      expect(doc?.text, c.id).toBeDefined();
    }
    if (ref.ranking) {
      expect(r.queryVector).toEqual(ref.query_embedding);
      expect(
        r.ranked.map((c) => ({ chunkId: c.id, score: c.score, embedding: c.embedding })),
      ).toEqual(ref.ranking);
    }
    if (ref.keyword_hits) {
      expect(r.queryTerms).toEqual(ref.keyword_query_terms);
      expect(
        [...r.ranked]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .filter((c) => c.keyword > 0)
          .map((c) => ({ chunkId: c.id, keywordScore: c.keyword, score: c.score })),
      ).toEqual(ref.keyword_hits);
    }
  });

  it.each(references)('%s: the played events carry the reference result', (_name, ref) => {
    const p = createPlayback(scenario('rag-query'));
    const { top_k, similarity_threshold, keyword_retrieval, rerank } = ref.parameters;
    p.setParameters({
      top_k,
      similarity_threshold,
      keyword_retrieval: keyword_retrieval ?? false,
      rerank: rerank ?? false,
    });
    expect(field(played(p, 'retrieve-06').payload, 'retained')).toEqual(
      ref.selected.map((s) => s.chunkId),
    );
    const answer = played(p, 'retrieve-12').payload;
    expect(field(answer, 'answer')).toBe(ref.answer);
    const sourcesOf = (field(answer, 'sources') as JsonObject[]).map(
      (s) =>
        `[${String(s['citation'])}] ${String(s['documentId'])} v${String(s['version'])}, chunk ${String(s['chunkId'])}`,
    );
    expect(sourcesOf).toEqual(ref.sources);
    const message = String(field(played(p, 'retrieve-11').payload, 'message', 'content'));
    expect(message).toBe(
      ref.sources.length ? `${ref.answer}\n\nSources:\n${ref.sources.join('\n')}` : ref.answer,
    );
    // The model sees the text of exactly the retained chunks, at retrieve-10 and not before.
    const prompt = String(field(played(p, 'retrieve-10').payload, 'messages', 1, 'content'));
    const blocks = [...prompt.matchAll(/chunk="([^"]+)"/g)].map((m) => m[1]);
    expect(blocks).toEqual(ref.selected.map((s) => s.chunkId));
    const k = p.events.indexOf(played(p, 'retrieve-10')) + 1;
    expect(plain(p.snapshot(k).state['model_visible_messages'])).toEqual(
      plain(played(p, 'retrieve-10').payload),
    );
    expect(plain(p.snapshot(k - 1).state['model_visible_messages'])).toEqual([]);
  });
});

describe('Combined answers (06-comparison-scenarios.yaml)', () => {
  it('reproduces the Combined answer and sources in the played events', () => {
    const p = createPlayback(scenario(combined.id));
    const answer = played(p, 'c-08').payload;
    expect(field(answer, 'answer')).toBe(combined.expected_answer);
    expect(sourceLines([])).toEqual([]);
    const lines = (field(answer, 'sources') as JsonObject[]).map(
      (s) =>
        `[${String(s['citation'])}] ${String(s['documentId'])} v${String(s['version'])}, chunk ${String(s['chunkId'])}`,
    );
    expect(lines).toEqual(combined.expected_sources);
    expect(field(played(p, 'c-07').payload, 'message', 'content')).toBe(
      `${combined.expected_answer}\n\nSources:\n${combined.expected_sources.join('\n')}`,
    );
  });
});

describe('derived events', () => {
  const defaults = (scn: Scenario): Record<string, Json> =>
    Object.fromEntries(Object.entries(scn.parameters ?? {}).map(([k, v]) => [k, v.default]));

  it.each(['rag-index', 'rag-query', 'combined-balance-explanation'])(
    '%s: the YAML shows the derived events at the default parameters',
    (id) => {
      const scn = scenario(id);
      const optional = new Map(
        (scn.optional_steps ?? []).flatMap((s) => s.events.map((e) => [e, s.enabled_by])),
      );
      const configs = [
        defaults(scn),
        ...[...new Set(optional.values())].map((p) => ({ ...defaults(scn), [p]: true })),
      ];
      const derived = new Set(scn.derived_events);
      expect(derived.size).toBeGreaterThan(0);
      for (const e of scn.events) {
        const lid = e.id.replace(`${id}:`, '');
        if (!derived.has(lid)) continue;
        const by = optional.get(lid);
        const config = by ? configs.find((c) => c[by] === true) : configs[0];
        const out = rag.derive(scn, config ?? {}).find((x) => x.id === e.id);
        expect(out, e.id).toEqual(e);
        // Same key order too, so the inspector shows the same structure.
        expect(JSON.stringify(out), e.id).toBe(JSON.stringify(e));
      }
    },
  );

  it('regenerates payloads, explanations and tracked values when nothing is retained', () => {
    const p = createPlayback(scenario('rag-query'));
    p.setParameters({ top_k: 1, similarity_threshold: 0.99 });
    const filter = played(p, 'retrieve-06');
    expect(filter.payload).toMatchObject({
      top_k: 1,
      similarity_threshold: 0.99,
      retained: [],
    });
    expect(filter.explanation).toBe(
      'Keep chunks with a score of at least 0.99, then the best one. Ties are broken by chunk ID. No chunk reaches 0.99, so nothing is retained.',
    );
    expect(filter.tracked_values).toBeUndefined();
    const reasons = (field(filter.payload, 'discarded') as JsonObject[]).map((d) => d['reason']);
    expect(new Set(reasons)).toEqual(new Set(['below threshold']));
    expect(field(played(p, 'retrieve-09').payload, 'prompt_after', 'document_blocks')).toEqual([]);
    expect(played(p, 'retrieve-09').tracked_values).toBeUndefined();
    expect(String(field(played(p, 'retrieve-10').payload, 'messages', 1, 'content'))).toMatch(
      /Retrieved documents:\n\(none\)$/,
    );
    expect(played(p, 'retrieve-12').payload).toEqual({ answer: NO_EVIDENCE_ANSWER, sources: [] });
    const last = p.snapshot(p.length);
    expect(last.state['retrieval']).toEqual({ retained: [] });
    expect(last.lineage['chunkId']?.map((x) => x.event)).toEqual(['retrieve-05']);
  });

  it('adds the keyword, rerank and fetch steps only while their parameter is on', () => {
    const p = createPlayback(scenario('rag-query'));
    const ids = (): string[] => p.events.map((e) => local(p, e));
    expect(ids()).not.toContain('hybrid-01');
    expect(ids()).not.toContain('retrieve-07');
    expect(p.length).toBe(10);
    p.setParameters({ keyword_retrieval: true });
    expect(ids().slice(4, 7)).toEqual(['retrieve-05', 'hybrid-01', 'hybrid-02']);
    p.setParameters({ rerank: true, fetch_full_documents: true });
    expect(p.length).toBe(15);
    expect(p.events.map((e) => e.sequence)).toEqual(p.events.map((_, i) => i + 1));
    // Reranked: the Savings chunk 002 is second, so its document comes second.
    expect(field(played(p, 'retrieve-07').payload, 'documents')).toEqual(
      ['account-opening.md', 'savings-account.md', 'everyday-account.md'].map((documentId) => ({
        documentId,
        version: '1.2',
      })),
    );
    expect(played(p, 'hybrid-03').explanation).toMatch(/^Union both candidate lists/);
    expect(played(p, 'retrieve-06').explanation).toMatch(/the 5 best by reranker score/);
  });

  it('send the parent documents instead of the chunks with fetch_full_documents', () => {
    const p = createPlayback(scenario('rag-query'));
    const chunked = String(field(played(p, 'retrieve-12').payload, 'answer'));
    p.setParameters({ fetch_full_documents: true });
    const docs = engine.corpus();
    const fetched = field(played(p, 'retrieve-08').payload, 'documents') as JsonObject[];
    expect(fetched.map((d) => d['documentId'])).toEqual([
      'account-opening.md',
      'everyday-account.md',
      'savings-account.md',
    ]);
    const savings = docs.find((d) => d.documentId === 'savings-account.md');
    expect(fetched[2]?.['text']).toBe(words(savings?.text ?? '').join(' '));

    const request = played(p, 'retrieve-10');
    const [system, user] = field(request.payload, 'messages') as JsonObject[];
    expect(system?.['content']).toContain('Cite every statement with the document ID and version.');
    const prompt = String(user?.['content']);
    expect(prompt).not.toContain('chunk="');
    expect([...prompt.matchAll(/<document id="([^"]+)"/g)].map((m) => m[1])).toEqual(
      fetched.map((d) => d['documentId']),
    );
    // The withdrawal rules sit in a Savings chunk that is not retained; the parent has them.
    const withdrawals = 'further withdrawals cost CHF 2 each';
    expect(prompt).toContain(withdrawals);
    expect(request.explanation).toBe(
      'The fetched documents become model-visible only now, in place of the retained chunks. ' +
        "The model runs at the LLM provider; the agent reaches it only through the provider's API.",
    );
    expect(request.tracked_values?.['retrievedText']).toEqual(fetched.map((d) => d['text']));
    expect(request.tracked_values?.['chunkId']).toEqual(
      played(p, 'retrieve-06').tracked_values?.['chunkId'],
    );
    expect(field(played(p, 'retrieve-09').payload, 'prompt_after', 'document_blocks')).toEqual(
      fetched.map((d) => ({ documentId: d['documentId'], version: '1.2', trust: 'official' })),
    );
    expect(field(played(p, 'retrieve-09').payload, 'prompt_after', 'system')).toBe(
      system?.['content'],
    );
    const k = p.events.indexOf(request) + 1;
    expect(JSON.stringify(p.snapshot(k - 1).state['model_visible_messages'])).not.toContain(
      withdrawals,
    );
    expect(JSON.stringify(p.snapshot(k).state['model_visible_messages'])).toContain(withdrawals);

    // The answer is grounded in the documents and cites them, not chunks.
    const answer = played(p, 'retrieve-12');
    const text = String(field(answer.payload, 'answer'));
    expect(text).not.toBe(chunked);
    expect(text).toContain('allows one free withdrawal per month');
    expect(text).not.toContain('does not cover');
    const sources = (field(answer.payload, 'sources') as JsonObject[]).map(sourceLine);
    expect(sources).toEqual([
      '[1] account-opening.md v1.2, full document',
      '[2] everyday-account.md v1.2, full document',
      '[3] savings-account.md v1.2, full document',
    ]);
    expect(field(played(p, 'retrieve-11').payload, 'message', 'content')).toBe(
      `${text}\n\nSources:\n${sources.join('\n')}`,
    );
    expect(answer.explanation).toContain('comes from a cited document');
    expect(played(p, 'retrieve-11').explanation).toBe(
      'Simulated model output built from the facts supported by the fetched documents.',
    );
    // Every stated fact's evidence span is in the text of a document the answer cites.
    const citedIds = sources.map((line) => line.split(' ')[1]);
    const stated = engine.fixtures.answer_facts.flatMap((f) => {
      const ev = f.evidence['1.2'] ?? f.evidence['*'];
      return ev && text.includes(ev.predicate) ? [{ documentId: f.documentId, span: ev.span }] : [];
    });
    expect(stated.length).toBeGreaterThan(3);
    for (const { documentId, span } of stated) {
      expect(citedIds).toContain(documentId);
      const doc = fetched.find((d) => d['documentId'] === documentId);
      expect(String(doc?.['text'])).toContain(span);
    }

    // Undoing the change restores the chunk prompt.
    p.setParameters({ fetch_full_documents: false });
    expect(field(played(p, 'retrieve-12').payload, 'answer')).toBe(chunked);
  });

  it('word keyword hit explanations in the singular and round thresholds', () => {
    const p = createPlayback(scenario('rag-query'));
    p.setParameters({ keyword_retrieval: true, similarity_threshold: 0.06 });
    expect(played(p, 'hybrid-02').explanation).toBe(
      "Exact-term hits. One hit scores below the similarity threshold of 0.06: authentication@1.2-c50o10-001, a lexical false positive that matches only 'bank' and that the threshold later removes.",
    );
    p.setParameters({ similarity_threshold: 0.1 + 0.2 });
    expect(played(p, 'hybrid-02').explanation).toMatch(
      /^Exact-term hits\. 3 hits score below the similarity threshold of 0\.3: /,
    );
    expect(played(p, 'retrieve-06').explanation).toMatch(
      /^Keep chunks with a score of at least 0\.3, /,
    );
    p.setParameters({ similarity_threshold: 0 });
    expect(played(p, 'hybrid-02').explanation).toBe(
      'Exact-term hits. All of them reach the similarity threshold of 0.',
    );
  });

  it('follow chunking parameters in rag-index', () => {
    const p = createPlayback(scenario('rag-index'));
    p.setParameters({ chunk_size_words: 25, overlap_words: 0 });
    const chunks = field(played(p, 'index-05').payload, 'chunks') as JsonObject[];
    expect(chunks[0]?.['chunkId']).toBe('everyday-account@1.2-c25o0-001');
    expect(played(p, 'index-04').payload).toMatchObject({ chunk_size_words: 25, overlap_words: 0 });
    expect(played(p, 'index-05').explanation).toBe(
      `${chunks.length} chunks, each pointing back to its source document. Chunk IDs read ` +
        'document@version-c<size>o<overlap>-<number>, so c25o0 means 25-word chunks without overlap.',
    );
    expect(field(played(p, 'index-09').payload, 'upserted')).toBe(chunks.length);
    expect(p.snapshot(p.length).state['rag_index']).toMatchObject({
      indexed_chunks: chunks.length,
    });
    expect(
      (field(played(p, 'index-07').payload, 'embeddings') as JsonObject[]).map((e) => e['chunkId']),
    ).toEqual(chunks.map((c) => c['chunkId']));
  });

  it('pass validation and replay for every parameter combination', () => {
    const ctx = contextFrom(sources);
    const grid = (scn: Scenario): Record<string, Json>[] =>
      Object.entries(scn.parameters ?? {}).reduce<Record<string, Json>[]>(
        (configs, [name, spec]) => {
          const values: Json[] =
            spec.options ??
            (typeof spec.default === 'boolean'
              ? [false, true]
              : name === 'top_k'
                ? [1, 4, 8]
                : [0, 0.7, 0.95, 1]);
          return configs.flatMap((c) => values.map((v) => ({ ...c, [name]: v })));
        },
        [{}],
      );
    let checked = 0;
    for (const scn of Object.values(registry).filter((s) => s.derived_events)) {
      const p = createPlayback(scn);
      for (const config of grid(scn)) {
        p.setParameters(config);
        // The played events; the lists naming optional steps refer to the registry's events.
        const played: Scenario = { ...scn, events: [...p.events] };
        delete played.derived_events;
        delete played.optional_steps;
        expect(
          validateRegistry({ [scn.id]: played }, ctx),
          `${scn.id} ${JSON.stringify(config)}`,
        ).toEqual([]);
        expect(() => p.snapshot(p.length)).not.toThrow();
        checked += 1;
      }
    }
    // rag-query 3 × 4 × 2 × 2 × 2, rag-index 3 × 3, the Combined scenario its defaults.
    expect(checked).toBe(96 + 9 + 1);
  });

  it('yield identical snapshots after a parameter change is undone', () => {
    for (const [id, change] of [
      [
        'rag-query',
        { top_k: 2, similarity_threshold: 0.92, rerank: true, fetch_full_documents: true },
      ],
      ['rag-index', { chunk_size_words: 100, overlap_words: 20 }],
    ] as const) {
      const p = createPlayback(scenario(id));
      const original = { ...p.retrievalConfig };
      const before = plain(all(p));
      const changed = p.setParameters(change);
      expect(changed, id).toBeLessThanOrEqual(p.length);
      expect(plain(all(p)), id).not.toEqual(before);
      p.setParameters(original);
      expect(plain(all(p)), id).toEqual(before);
      // A second playback from scratch agrees: same scenario and parameters, same results.
      expect(plain(all(createPlayback(scenario(id)))), id).toEqual(before);
    }
  });

  it('keep snapshots before the first changed event', () => {
    const p = createPlayback(scenario('rag-query'));
    const before = all(p);
    const changed = p.setParameters({ top_k: 4 });
    expect(local(p, p.event(changed) as ScenarioEvent)).toBe('retrieve-06');
    const after = all(p);
    expect(after[changed - 1]?.state).toBe(before[changed - 1]?.state);
    expect(after[changed]?.state).not.toEqual(before[changed]?.state);
    // topK 4 drops the Savings chunk, as reference_results rag-query-top-k-4 says.
    expect(field(played(p, 'retrieve-12').payload, 'sources')).toEqual(
      sourceObjects(
        engine.answer(
          engine.retrieve(engine.corpus(), {
            chunkSize: 50,
            overlap: 10,
            topK: 4,
            threshold: 0.7,
            rerank: false,
          }).selected,
        ).cited,
      ),
    );
  });

  it('keep the cursor on the same event when optional steps come and go', () => {
    const clock: Clock = { setTimeout: () => undefined, clearTimeout: () => undefined };
    const player = new Player(createPlayback(scenario('rag-query')), clock);
    const at = (): string | undefined => player.playback.event(player.cursor)?.id;
    player.jump(7);
    expect(at()).toBe('retrieve-09');
    player.setParameters({ keyword_retrieval: true });
    expect(at()).toBe('retrieve-09');
    expect(player.cursor).toBe(9);
    player.jump(7);
    expect(at()).toBe('hybrid-02');
    // hybrid-02 is no longer played: the nearest earlier played event is retrieve-05.
    player.setParameters({ keyword_retrieval: false });
    expect(at()).toBe('retrieve-05');
    player.jump(0);
    player.setParameters({ fetch_full_documents: true });
    expect(player.cursor).toBe(0);
    player.jump(player.playback.length);
    player.setParameters({ top_k: 1 });
    expect(at()).toBe('retrieve-12');
  });

  it('meet the quality gate of supported events with the events played at the defaults', () => {
    const played = Object.values(registry).reduce((n, scn) => n + createPlayback(scn).length, 0);
    const registered = Object.values(registry).reduce((n, scn) => n + scn.events.length, 0);
    expect(played).toBeLessThan(registered);
    // 08-acceptance-tests.yaml quality_gates.min_supported_events (not bundled by the app).
    const acceptance = parse(acceptanceYaml) as {
      quality_gates: { min_supported_events: number };
    };
    const min = acceptance.quality_gates.min_supported_events;
    expect(min).toBeGreaterThan(0);
    expect(played).toBeGreaterThanOrEqual(min);
  });

  it('leave scenarios without derived events as they are', () => {
    const scn = scenario('mcp-balance');
    expect(rag.derive(scn, {})).toBe(scn.events);
    expect(plain(createPlayback(scn).events)).toEqual(plain(scn.events));
  });
});
