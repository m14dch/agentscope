// 03-simulation-engine.yaml annotation_rules; 08-acceptance-tests.yaml unit_tests on annotations.
import { describe, expect, it } from 'vitest';
import {
  annotationProblems,
  carriesProblem,
  formatPath,
  jsonLines,
  lineText,
  parsePath,
  splitPayload,
} from '../../src/scenarios/annotations.ts';
import { loadRegistry } from '../../src/scenarios/registry.ts';
import { ragDerivation } from '../../src/rag/bundled.ts';
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
