import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { annotationProblems, carriesProblem } from '../../../src/scenarios/annotations.ts';
import type { Json } from '../../../src/scenarios/types.ts';

const TOOLS = join(import.meta.dirname, '../../../specifications/tools');

interface Case {
  payload: Json;
  annotations: unknown;
  carries: unknown;
}

/** annotation_problems and carries_problem of validate_specs.py for each case, in order. */
function python(cases: Case[]): { annotations: string[]; carries: string | null }[] {
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from validate_specs import annotation_problems, carries_problem',
    'cases = json.loads(sys.argv[2])',
    'print(json.dumps([{"annotations": annotation_problems(c["payload"], c["annotations"]),',
    '                   "carries": carries_problem(c["carries"])} for c in cases]))',
  ].join('\n');
  const out = execFileSync('python3', ['-c', script, TOOLS, JSON.stringify(cases)], {
    encoding: 'utf8',
  });
  return JSON.parse(out) as { annotations: string[]; carries: string | null }[];
}

const g = (paths: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  heading: 'Group',
  sentence: 'Explains the group.',
  paths,
  ...extra,
});

describe('annotation checks', () => {
  it('validate_specs.py reports the same problems as the app', () => {
    const payload: Json = {
      jsonrpc: '2.0',
      id: 1,
      params: { name: 'x', 'a.b': [1, { c: [] }], _meta: {} },
    };
    const annotations: unknown[] = [
      [g(['jsonrpc', 'id']), g(['params'])],
      [g(['jsonrpc', 'id', 'params.name', 'params["a.b"]', 'params._meta'])],
      [g(['jsonrpc', 'nope', 'a..b', 'params["a.b"].5', '$'])],
      [g(['jsonrpc', 'id', 'params']), g(['params.name'])],
      [g(['jsonrpc', 'params.name'])],
      [g(['params', 'id']), g(['jsonrpc'])],
      [g(['jsonrpc', 'id'], { values: { 'params.name': 'x', id: ' ', nope: 'y' } }), g(['params'])],
      [g(['$'], { heading: 'H'.repeat(41), sentence: 'No stop' })],
      [g(['$'], { sentence: 'Two. Sentences.' })],
      [g([])],
      [g('jsonrpc')],
      [],
      'none',
      [3],
      [g(['$'], { values: 'x' })],
    ];
    const carries: unknown[] = [['ok'], [], ['full stop.'], ['x'.repeat(101)], 'no', [' ']];
    const cases: Case[] = annotations.map((a, i) => ({
      payload,
      annotations: a,
      carries: carries[i % carries.length],
    }));
    cases.push({ payload: null, annotations: [g(['$'])], carries: ['ok'] });
    const app = cases.map((c) => ({
      annotations: annotationProblems(c.payload, c.annotations),
      carries: carriesProblem(c.carries) ?? null,
    }));
    // Only the first two annotation sets fit the payload.
    expect(app.map((r, i) => (r.annotations.length ? -1 : i)).filter((i) => i >= 0)).toEqual([
      0, 1,
    ]);
    expect(python(cases)).toEqual(app);
  });
});
