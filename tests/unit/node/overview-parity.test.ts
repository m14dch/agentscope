import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jargon, overviewProblems } from '../../../src/scenarios/validate.ts';
import type { Scenario } from '../../../src/scenarios/types.ts';
import { readSpecSources } from '../../../scripts/spec-sources.ts';

const SPECS = join(import.meta.dirname, '../../../specifications');
const TOOLS = join(SPECS, 'tools');

/** check_overview of validate_specs.py for each scenario, in order. */
function pythonProblems(inputs: unknown[]): string[][] {
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'import validate_specs as v',
    'out = []',
    'for s in json.load(sys.stdin):',
    '    v.errors.clear()',
    '    v.check_overview(s)',
    '    out.append(list(v.errors))',
    'print(json.dumps(out))',
  ].join('\n');
  const out = execFileSync('python3', ['-c', script, TOOLS], {
    encoding: 'utf8',
    input: JSON.stringify(inputs),
  });
  return JSON.parse(out) as string[][];
}

describe('overview checks (03 scenario_format.overview_fields)', () => {
  it('validate_specs.py reports the same problems as the app for every malformed overview', () => {
    const mcp = readSpecSources(SPECS).mcp.scenarios[0] as Scenario;
    const variant = (change: (s: Scenario) => void): Scenario => {
      const s = structuredClone(mcp);
      change(s);
      return s;
    };
    const [prepare, ask, fetch] = mcp.overview.stages;
    const inputs: Scenario[] = [
      mcp,
      variant((s) => Object.assign(s, { overview: 'none' })),
      // One party, a party with a protocol name, a duplicate ID, members that miss one.
      variant((s) => {
        s.overview.parties = [{ id: 'all', label: 'Everyone', members: s.participants }];
      }),
      variant((s) => {
        (s.overview.parties[2] as { label: string }).label = 'Mcp servers';
      }),
      variant((s) => {
        (s.overview.parties[1] as { id: string }).id = 'you';
      }),
      variant((s) => {
        s.overview.parties[2]?.members.pop();
      }),
      // Two sentences, a question, a protocol name, too many stages, phases out of order.
      variant((s) => {
        (s.overview.stages[0] as { sentence: string }).sentence = 'One thing. Then another.';
      }),
      variant((s) => {
        (s.overview.stages[1] as { sentence: string }).sentence = 'Do you ask?';
      }),
      variant((s) => {
        (s.overview.stages[2] as { sentence: string }).sentence = 'The assistant calls the APIs.';
      }),
      variant((s) => {
        s.overview.stages = s.phases.slice(0, 6).map((p) => ({
          id: p.id,
          phases: [p.id],
          sentence: 'It happens.',
        }));
      }),
      variant((s) => {
        s.overview.stages = [ask, prepare, fetch, s.overview.stages[3]].map((t) => t as never);
      }),
      // Events that return to an earlier stage.
      variant((s) => {
        s.events.push({ ...(s.events[0] as Scenario['events'][number]), id: 'late' });
      }),
    ];
    const app = inputs.map((s) => overviewProblems(s).map((p) => `${p.where}: ${p.message}`));
    expect(app[0]).toEqual([]);
    // Every malformed overview reports at least one problem.
    expect(app.slice(1).every((p) => p.length > 0)).toBe(true);
    expect(pythonProblems(inputs)).toEqual(app);
  });

  it('both validators find the same technical words, in any case and with endings', () => {
    const texts = [
      'You ask the assistant for your balance.',
      'The assistant calls the APIs.',
      'It speaks JSON-RPC.',
      'The mcp client asks.',
      'The LLMs answer.',
      'The tool is called.',
      'Embedding the passages.',
      'The chunks are stored.',
      'The prompt is sent.',
      'The model answers.',
      'Servers and vectors.',
      'A token and a schema.',
      'It calls the REST interface.',
      'The rest of the answer follows.',
    ];
    const app = texts.map((t) => jargon(t) ?? null);
    expect(app).toEqual([
      null,
      'APIs',
      'JSON',
      'mcp',
      'LLMs',
      'tool',
      'Embedding',
      'chunks',
      'prompt',
      'model',
      'Servers',
      'token',
      'REST',
      null,
    ]);
    const script = [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'import validate_specs as v',
      'print(json.dumps([v.jargon(t) for t in json.load(sys.stdin)]))',
    ].join('\n');
    const out = execFileSync('python3', ['-c', script, TOOLS], {
      encoding: 'utf8',
      input: JSON.stringify(texts),
    });
    expect(JSON.parse(out)).toEqual(app);
  });
});
