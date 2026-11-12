// 01-architecture.yaml participants: every participant has a label and a unique short_label
// (02 phone_steps.rows), checked the same way by both validators.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { participantLabelProblems } from '../../../src/scenarios/validate.ts';

const TOOLS = join(import.meta.dirname, '../../../specifications/tools');

function python(registry: unknown[]): string[] {
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from validate_specs import participant_label_problems',
    'print(json.dumps(participant_label_problems(json.loads(sys.argv[2]))))',
  ].join('\n');
  const out = execFileSync('python3', ['-c', script, TOOLS, JSON.stringify(registry)], {
    encoding: 'utf8',
  });
  return JSON.parse(out) as string[];
}

describe('participant labels', () => {
  it('every participant of the registry has a label and a unique short label', () => {
    const architecture = parse(readFileSync(join(TOOLS, '../01-architecture.yaml'), 'utf8')) as {
      participants: { registry: unknown[] };
    };
    expect(participantLabelProblems(architecture.participants.registry)).toEqual([]);
  });

  it('validate_specs.py reports the same problems as the app', () => {
    const registry = [
      { id: 'a', label: 'Agent (host)', short_label: 'Agent' },
      { id: 'b', label: 'B', short_label: ' ' },
      { id: 'c', short_label: 'C' },
      { id: 'd', label: 'Another agent', short_label: 'Agent' },
      'not an entry',
    ];
    const app = participantLabelProblems(registry);
    expect(app).toEqual([
      'b needs a label and a short_label',
      'c needs a label and a short_label',
      'short_label Agent is not unique',
      ' needs a label and a short_label',
    ]);
    expect(python(registry)).toEqual(app);
  });
});
