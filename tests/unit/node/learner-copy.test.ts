// 03 scenario_format.learner_copy (issue 76): learner-facing text names no internal identifier
// and does not repeat that the app is simulated; each trust boundary has a label. Both validators
// check this the same way.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSpecSources } from '../../../scripts/spec-sources.ts';
import { buildRegistry } from '../../../src/scenarios/expand.ts';
import {
  learnerCopyProblems,
  learnerIdentifiers,
  learnerTexts,
} from '../../../src/scenarios/validate.ts';

const SPECS = join(import.meta.dirname, '../../../specifications');

function python(args: unknown[]): string[] {
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from validate_specs import learner_copy_problems',
    'print(json.dumps(learner_copy_problems(*json.loads(sys.argv[2]))))',
  ].join('\n');
  const out = execFileSync('python3', ['-c', script, join(SPECS, 'tools'), JSON.stringify(args)], {
    encoding: 'utf8',
  });
  return JSON.parse(out) as string[];
}

describe('learner copy', () => {
  const sources = readSpecSources(SPECS);
  const { registry } = buildRegistry(sources);

  it('the specifications pass, with the tool names and stop reasons as the only identifiers', () => {
    expect(learnerIdentifiers(sources)).toEqual([
      'get_customer',
      'get_customer_balance',
      'tool_use',
      'end_turn',
    ]);
    expect(
      learnerCopyProblems(
        Object.values(registry),
        sources.comparison.compare,
        sources.architecture.participants.registry,
        sources.security.trust_boundaries,
        learnerIdentifiers(sources),
      ),
    ).toEqual([]);
  });

  it('the MCP tab never mentions RAG, not even in a participant label', () => {
    const mcp = registry['mcp-balance'];
    if (!mcp) throw new Error('mcp-balance is missing');
    const participants = sources.architecture.participants.registry.filter((p) =>
      mcp.participants.includes(p.id),
    );
    const texts = learnerTexts([mcp], {}, participants, []).map((t) => t.text);
    expect(texts.filter((t) => /\bRAG\b/.test(t))).toEqual([]);
  });

  it('validate_specs.py reports the same problems as the app', () => {
    const scenario = {
      id: 's',
      title: 'A simulated tour',
      phases: [{ id: 'p', label: 'Ask', takeaway: 'The simulated model answers.' }],
      overview: { parties: [{ id: 'you', label: 'You' }], stages: [] },
      events: [
        // A model response may start with the label; another sender may not, nor may the rest.
        {
          id: 'e1',
          sender: 'llm',
          explanation: 'Simulated model output: it asks for get_customer_balance.',
          carries: ['end_turn: the model is done'],
        },
        { id: 'e2', sender: 'agent', explanation: 'Simulated model output, simulated twice.' },
        {
          id: 'e3',
          sender: 'agent',
          explanation: 'Only when fetch_full_documents is on.',
          technical_notes: ['Crosses agent-to-mcp; agent-to-mcp-extra is another word.'],
          annotations: [{ heading: 'Tool', sentence: 'Why.', values: { a: 'top_k of 5' } }],
        },
      ],
    };
    const compare = {
      headline: 'Compare.',
      aspects: [{ label: 'Tools', sentence: 'A similarity_threshold.' }],
      placeholders: { s: { p: 'Nothing here.' } },
    };
    const participants = [{ id: 'agent', label: 'Agent', short_label: 'Agent' }];
    const boundaries = [{ id: 'agent-to-mcp', label: 'Agent → MCP server' }, { id: 'x-to-y' }];
    const args = [
      [scenario],
      compare,
      participants,
      boundaries,
      ['get_customer_balance', 'end_turn'],
    ];
    const app = learnerCopyProblems(...(args as Parameters<typeof learnerCopyProblems>));
    expect(app).toEqual([
      '07 x-to-y: trust boundary needs a label',
      's: title says simulated, which the header already says',
      's/p: takeaway says simulated, which the header already says',
      's/e2: explanation says simulated, which the header already says',
      's/e3: explanation names the identifier fetch_full_documents',
      's/e3: technical_notes names the trust boundary ID agent-to-mcp',
      's/e3: annotations names the identifier top_k',
      'compare: aspects names the identifier similarity_threshold',
    ]);
    expect(python(args)).toEqual(app);
  });
});
