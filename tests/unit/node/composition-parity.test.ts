import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answerCompositionProblem } from '../../../src/rag/derive.ts';
import { readSpecSources } from '../../../scripts/spec-sources.ts';

const SPECS = join(import.meta.dirname, '../../../specifications');
const TOOLS = join(SPECS, 'tools');

/** answer_composition_problem of validate_specs.py for each input, in order. */
function pythonProblems(inputs: unknown[]): (string | null)[] {
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from validate_specs import answer_composition_problem',
    'print(json.dumps([answer_composition_problem(c) for c in json.loads(sys.argv[2])]))',
  ].join('\n');
  const out = execFileSync('python3', ['-c', script, TOOLS, JSON.stringify(inputs)], {
    encoding: 'utf8',
  });
  return JSON.parse(out) as (string | null)[];
}

describe('answer_composition checks', () => {
  it('validate_specs.py reports the same problem as the app for every malformed composition', () => {
    const composition = (
      readSpecSources(SPECS).comparison.combined as unknown as {
        answer_composition: Record<string, unknown>;
      }
    ).answer_composition;
    const comparisons = composition['comparisons'] as Record<string, unknown>[];
    const inputs: unknown[] = [
      composition,
      null,
      'text',
      { ...composition, intro: 'Your balance.' },
      { ...composition, intro: [] },
      { ...composition, intro: [{ source: 'guess', text: 'x' }] },
      { ...composition, intro: [{ source: 'tool', text: ' ' }] },
      { ...composition, comparisons: 'none' },
      { ...composition, comparisons: [{}] },
      { ...composition, comparisons: [{ ...comparisons[0], explanation: '' }] },
      { ...composition, comparisons: [{ ...comparisons[0], sentence: 3 }] },
      { ...composition, comparisons: [] },
      { ...composition, explanation: undefined },
      { ...composition, explanation: '  ' },
    ];
    const app = inputs.map((c) => answerCompositionProblem(c) ?? null);
    // Valid: the composition itself and one without comparisons; every other input is not.
    expect(app.map((p, i) => (p === null ? i : -1)).filter((i) => i >= 0)).toEqual([0, 11]);
    expect(pythonProblems(inputs)).toEqual(app);
  });
});
