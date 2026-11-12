// 03-simulation-engine.yaml annotation_rules; 08-acceptance-tests.yaml unit_tests on annotations.
import { describe, expect, it } from 'vitest';
import {
  annotationProblems,
  carriesProblem,
  formatPath,
  jsonLines,
  lineText,
  parsePath,
  resolvePath,
  splitPayload,
} from '../../src/scenarios/annotations.ts';
import specs from 'virtual:agentscope-specs';
import { loadRegistry } from '../../src/scenarios/registry.ts';
import { ragDerivation } from '../../src/rag/bundled.ts';
import { travel, valueLabel } from '../../src/inspector/annotated.ts';
import { ANNOTATED_PROTOCOLS } from '../../src/scenarios/validate.ts';
import type { AnnotationGroup, Json } from '../../src/scenarios/types.ts';

const group = (paths: string[], extra: Partial<AnnotationGroup> = {}): AnnotationGroup => ({
  heading: 'Group',
  sentence: 'Explains the group.',
  paths,
  ...extra,
});

const payload: Json = {
  jsonrpc: '2.0',
  id: 3,
  params: { name: 'get', arguments: { customerId: '123' }, _meta: { 'a.b': 1, empty: [] } },
};

describe('JSON paths', () => {
  it('reads dots, indexes, bracketed names and the root', () => {
    expect(parsePath('params._meta["a.b"]')).toEqual(['params', '_meta', 'a.b']);
    expect(parsePath('messages.0.content')).toEqual(['messages', '0', 'content']);
    expect(parsePath('$')).toEqual([]);
    for (const bad of ['', 'a..b', 'a.', 'a[', 'a["b"', '.a', 'a["b"]c']) {
      expect(parsePath(bad)).toBeUndefined();
    }
    expect(formatPath(['params', '_meta', 'a.b'])).toBe('params._meta["a.b"]');
    expect(formatPath([])).toBe('$');
  });
});

const whole = [group(['jsonrpc', 'id']), group(['params'])];

describe('annotation checks', () => {
  it('accepts groups that cover the payload in order', () => {
    expect(annotationProblems(payload, whole)).toEqual([]);
    expect(annotationProblems('text', [group(['$'])])).toEqual([]);
  });

  it('rejects paths that do not exist, overlapping groups, gaps and groups out of order', () => {
    expect(annotationProblems(payload, [group(['jsonrpc', 'id', 'params.nope', 'a..b'])])).toEqual([
      'annotations[0] path "params.nope" does not exist in the payload',
      'annotations[0] path "a..b" is not a JSON path',
    ]);
    expect(
      annotationProblems(payload, [group(['jsonrpc', 'id', 'params']), group(['params.name'])]),
    ).toEqual(['annotations[0] path "params" overlaps annotations[1] path "params.name"']);
    expect(
      annotationProblems(payload, [group(['jsonrpc', 'params.name', 'params._meta'])]),
    ).toEqual([
      "id lies under no group's path (a gap)",
      "params.arguments lies under no group's path (a gap)",
    ]);
    expect(annotationProblems(payload, [group(['params', 'id']), group(['jsonrpc'])])).toEqual([
      'annotations[0] follows annotations[1] in the payload: groups must be in payload order',
    ]);
  });

  it('rejects values outside their group, headings, sentences and malformed carries', () => {
    expect(
      annotationProblems(payload, [
        group(['jsonrpc', 'id'], {
          heading: '',
          sentence: 'Two sentences. Not one.',
          values: { 'params.name': 'the tool' },
        }),
        group(['params']),
      ]),
    ).toEqual([
      'annotations[0] heading must be a phrase of 1 to 40 characters',
      'annotations[0] sentence must be one sentence ending with a full stop',
      'annotations[0] value path "params.name" lies outside the group\'s paths',
    ]);
    expect(carriesProblem(['the tool name'])).toBeUndefined();
    expect(carriesProblem(['ends with a full stop.'])).toBeDefined();
    expect(carriesProblem([])).toBeDefined();
  });
});

describe('payload lines and the split', () => {
  it('writes exactly JSON.stringify(value, null, 2), line by line', () => {
    const text = jsonLines(payload).map(lineText).join('\n');
    expect(text).toBe(JSON.stringify(payload, null, 2));
  });

  it('gives unheld brackets to the neighbouring group and reproduces the payload', () => {
    const split = splitPayload(payload, whole)?.map((g) => g.lines.map(lineText)) ?? [];
    expect(split[0]).toEqual(['{', '  "jsonrpc": "2.0",', '  "id": 3,']);
    expect(split[1]?.[0]).toBe('  "params": {');
    expect(split[1]?.at(-1)).toBe('}');
    expect(split.flat().join('\n')).toBe(JSON.stringify(payload, null, 2));
    expect(splitPayload(payload, [group(['jsonrpc'])])).toBeUndefined();
  });
});

describe('bundled annotations', () => {
  const registry = loadRegistry();

  it('every MCP, LLM and HTTP event has carries, and annotations when it has a body', () => {
    let annotated = 0;
    for (const scn of Object.values(registry)) {
      for (const e of scn.events) {
        if (!ANNOTATED_PROTOCOLS.includes(e.protocol)) continue;
        expect(e.carries?.length, e.id).toBeGreaterThan(0);
        if (e.payload !== null && typeof e.payload === 'object') {
          expect(e.annotations?.length, e.id).toBeGreaterThan(0);
          annotated += 1;
        }
      }
    }
    expect(annotated).toBeGreaterThanOrEqual(20);
  });

  it('the lines of the groups, taken in order, are exactly each annotated payload', () => {
    for (const scn of Object.values(registry)) {
      for (const e of scn.events.filter((x) => x.annotations)) {
        const split = splitPayload(e.payload, e.annotations);
        expect(split, e.id).toBeDefined();
        const text = (split ?? []).flatMap((g) => g.lines.map(lineText)).join('\n');
        expect(text, e.id).toBe(JSON.stringify(e.payload, null, 2));
      }
    }
  });

  it('derived annotations fit every parameter combination (03 annotation_rules.derived_events)', () => {
    // A sweep, not one case: the paths must hold for array lengths and optional members that
    // only some combinations produce (no match, keyword hits, whole documents).
    const derive = ragDerivation().deriveEvents;
    const grids: Record<string, Record<string, Json[]>> = {
      'rag-index': { chunk_size_words: [25, 50, 100], overlap_words: [0, 10, 20] },
      'rag-query': {
        top_k: [1, 2, 3, 4, 5, 6, 7, 8],
        similarity_threshold: [0, 0.5, 0.7, 0.9, 1],
        rerank: [false, true],
        keyword_retrieval: [false, true],
        fetch_full_documents: [false, true],
      },
    };
    const combos = (grid: Record<string, Json[]>): Record<string, Json>[] =>
      Object.entries(grid).reduce<Record<string, Json>[]>(
        (acc, [name, values]) => acc.flatMap((c) => values.map((v) => ({ ...c, [name]: v }))),
        [{}],
      );
    const comb = Object.values(registry).find((s) => s.id.startsWith('combined'));
    let checked = 0;
    for (const [sid, grid] of Object.entries(grids)) {
      const targets = [registry[sid], ...(sid === 'rag-query' && comb ? [comb] : [])];
      for (const config of combos(grid)) {
        for (const scn of targets) {
          if (!scn) continue;
          for (const e of derive(scn, config)) {
            if (!e.annotations) continue;
            const problems = annotationProblems(e.payload, e.annotations);
            expect(problems, `${e.id} at ${JSON.stringify(config)}`).toEqual([]);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('annotation bullets', () => {
  const registry = loadRegistry();
  const scn = registry['mcp-balance'];
  const events = scn?.events ?? [];
  const at = (id: string): number => events.findIndex((e) => e.id === id);
  const origins = specs.engine.lineage.origins ?? {};
  const sources = { initialState: scn?.initial_state ?? {}, origins };

  it('show a value in the code face, long strings cut and containers summarised', () => {
    expect(valueLabel('123')).toBe('"123"');
    expect(valueLabel('x'.repeat(41))).toBe(`"${'x'.repeat(36)}…"`);
    expect(valueLabel([1, 2])).toBe('[…] 2 items');
    expect(valueLabel({ a: 1 })).toBe('{…} 1 member');
    expect(valueLabel({})).toBe('{}');
    expect(valueLabel([])).toBe('[]');
  });

  it('say where a tracked value comes from and the steps that matter after it', () => {
    // The customer ID comes from the signed-in session; the model writes it into its tool
    // call, the agent checks it, and the MCP client sends it.
    expect(travel(events, at('mcp-14'), '123', sources)).toEqual({
      origin: { label: 'the signed-in session' },
      hops: [
        { index: at('mcp-10'), kind: 'model' },
        { index: at('mcp-11'), kind: 'repeats' },
        { index: at('mcp-12'), kind: 'checks' },
        { index: at('mcp-14'), kind: 'sent' },
      ],
    });
    // The balance comes from the core ledger. Step 26 asks a prediction about statelessness,
    // which "reaches the model" does not answer, so it is named.
    expect(travel(events, at('mcp-23'), 12500.75, sources)).toEqual({
      origin: { index: at('mcp-20') },
      hops: [
        { index: at('mcp-21'), kind: 'sent' },
        { index: at('mcp-26'), kind: 'model' },
        { index: at('mcp-27'), kind: 'repeats' },
      ],
    });
    // Step 14 asks who sends the tool call: from step 11 its "sent to" hop is left out.
    expect(travel(events, at('mcp-11'), '123', sources)?.hops.map((h) => h.kind)).toEqual([
      'model',
      'repeats',
      'checks',
    ]);
    // Untracked values and values inside longer strings get no travel line.
    expect(travel(events, at('mcp-14'), 'tools/call', sources)).toBeUndefined();
    expect(travel(events, at('mcp-23'), '{"customerId":"123"}', sources)).toBeUndefined();
  });

  it("never link from a step before a prediction to that prediction's step, except to say the value reaches the model", () => {
    let lines = 0;
    for (const s of Object.values(registry)) {
      const src = { initialState: s.initial_state, origins };
      s.events.forEach((e, index) => {
        for (const group of e.annotations ?? []) {
          for (const path of Object.keys(group.values ?? {})) {
            const value = resolvePath(e.payload ?? null, parsePath(path) ?? [])?.value ?? null;
            const where = travel(s.events, index, value, src);
            if (!where) continue;
            lines += 1;
            const linked = [
              ...('index' in where.origin ? [where.origin.index] : []),
              ...where.hops.filter((h) => h.kind !== 'model').map((h) => h.index),
            ];
            for (const i of linked)
              expect(i > index && !!s.events[i]?.prediction, `${e.id} links to ${i + 1}`).toBe(
                false,
              );
          }
        }
      });
    }
    expect(lines).toBeGreaterThan(5);
  });
});

describe('derived wording', () => {
  // 03 annotation_rules.derived_events: parameter-neutral wording, checked at the extremes
  // where it could break: no evidence at all, and whole documents instead of chunks.
  const scn = loadRegistry()['rag-query'];
  const derive = ragDerivation().deriveEvents;
  const extremes: Record<string, Json>[] = [
    { similarity_threshold: 1 },
    { fetch_full_documents: true },
  ];
  const promises = [
    /\bthe retained chunks\b/,
    /\bcites each\b/,
    /^(the answer )?with numbered citations/,
    /\b\d+ (chunks|documents|citations|items)\b/,
  ];

  it('holds where nothing is retained and where whole documents replace the chunks', () => {
    if (!scn) throw new Error('no rag-query');
    for (const config of extremes) {
      const events = derive(scn, config);
      for (const id of scn.derived_events ?? []) {
        const e = events.find((x) => x.id === id);
        const texts = [
          ...(e?.carries ?? []),
          ...(e?.annotations ?? []).flatMap((g) => [g.sentence, ...Object.values(g.values ?? {})]),
        ];
        for (const text of texts)
          for (const promise of promises)
            expect(promise.test(text), `${id} at ${JSON.stringify(config)}: ${text}`).toBe(false);
      }
    }
    // The extremes are real: no citation at a threshold of 1, whole documents when fetching.
    const none = derive(scn, extremes[0] ?? {}).find((e) => e.id === 'retrieve-11');
    expect(JSON.stringify(none?.payload)).not.toContain('[1]');
    const whole = derive(scn, extremes[1] ?? {}).find((e) => e.id === 'retrieve-10');
    expect(JSON.stringify(whole?.payload)).not.toContain('chunk=');
  });
});
