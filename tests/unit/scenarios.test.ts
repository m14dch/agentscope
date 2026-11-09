import { describe, expect, it } from 'vitest';
import { compose, expandVariant, getPath, setPath } from '../../src/scenarios/expand.ts';
import { loadRegistry } from '../../src/scenarios/registry.ts';
import type { Composition, Scenario, ScenarioEvent } from '../../src/scenarios/types.ts';
import { validateRegistry, type ValidationContext } from '../../src/scenarios/validate.ts';

function event(id: string, extra: Partial<ScenarioEvent> = {}): ScenarioEvent {
  return {
    id,
    scenario_id: 'base',
    phase: 'p1',
    sequence: 0,
    sender: 'agent',
    receiver: 'llm',
    operation: 'op',
    protocol: 'INTERNAL',
    transport: 'in_process',
    execution_type: 'IN_PROCESS',
    message_type: 'ACTION',
    explanation: 'Explains the step.',
    ...extra,
  };
}

function base(): Scenario {
  const events = [
    event('e1', { pair_id: 'e2' }),
    event('e2', { pair_id: 'e1', payload: { n: [1, 2] } }),
    event('e3'),
  ];
  events.forEach((e, i) => (e.sequence = i + 1));
  return {
    id: 'base',
    title: 'Base',
    question: 'Base question?',
    learning_question: 'What does the base teach?',
    headline: 'The base teaches one thing.',
    participants: ['agent', 'llm'],
    phases: [{ id: 'p1', label: 'Phase', semantic_phase: 'preparation', takeaway: 'One message.' }],
    events,
    initial_state: {},
  };
}

const ctx: ValidationContext = {
  participants: new Set(['agent', 'llm', 'mcp-client', 'mcp-server']),
  boundaries: new Set(['b1']),
  semanticPhases: new Set(['preparation']),
  lineage: new Set(['customerId']),
  required: [
    'id',
    'scenario_id',
    'phase',
    'sequence',
    'sender',
    'receiver',
    'operation',
    'protocol',
    'transport',
    'execution_type',
    'message_type',
    'explanation',
  ],
  revision: '2026-07-28',
};

describe('paths', () => {
  it('reads and writes dotted paths with array indexes', () => {
    const obj = { a: { b: [{ c: 1 }] } };
    expect(getPath(obj, 'a.b.0.c')).toBe(1);
    expect(getPath(obj, 'a.b.1.c')).toBeUndefined();
    expect(setPath(obj, 'a.b.0.c', 2)).toBe(true);
    expect(obj.a.b[0]?.c).toBe(2);
    expect(setPath(obj, 'a.x.y', 1)).toBe(false);
  });
});

describe('variant expansion', () => {
  it('applies operations in order, then prefixes IDs and renumbers', () => {
    const problems: string[] = [];
    const scn = expandVariant(
      base(),
      {
        id: 'v',
        title: 'Variant',
        extends: 'base',
        lesson: 'The variant teaches one thing.',
        operations: [
          { op: 'patch', event: 'e2', set: { 'payload.n.1': 5, explanation: 'Patched.' } },
          { op: 'insert_after', event: 'e1', events: [event('new')] },
          { op: 'remove', events: ['e3'] },
          { op: 'replace', event: 'new', with: event('swapped') },
        ],
      },
      problems,
    );
    expect(problems).toEqual([]);
    expect(scn.id).toBe('v');
    expect(scn.title).toBe('Variant');
    expect(scn.question).toBe('Base question?');
    expect(scn.headline).toBe('The variant teaches one thing.');
    expect(scn.events.map((e) => [e.id, e.sequence, e.scenario_id, e.pair_id])).toEqual([
      ['v:e1', 1, 'v', 'v:e2'],
      ['v:swapped', 2, 'v', undefined],
      ['v:e2', 3, 'v', 'v:e1'],
    ]);
    expect(scn.events[2]?.payload).toEqual({ n: [1, 5] });
    expect(scn.events[2]?.explanation).toBe('Patched.');
  });

  it('leaves the base untouched', () => {
    const b = base();
    expandVariant(
      b,
      {
        id: 'v',
        title: 'V',
        extends: 'base',
        lesson: 'L.',
        operations: [{ op: 'remove', events: ['e1'] }],
      },
      [],
    );
    expect(b.events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('reports operations on unknown events', () => {
    const problems: string[] = [];
    expandVariant(
      base(),
      {
        id: 'v',
        title: 'V',
        extends: 'base',
        lesson: 'L.',
        operations: [{ op: 'remove', events: ['zz'] }],
      },
      problems,
    );
    expect(problems).toEqual(['v: remove names unknown event zz']);
  });
});

describe('composition', () => {
  it('copies inclusive ranges with phase maps and patches, then inserts', () => {
    const comp: Composition = {
      id: 'c',
      title: 'Combined',
      question: 'Q?',
      learning_question: 'What composes?',
      headline: 'Composition reuses events.',
      participants: ['agent', 'llm'],
      phases: [{ id: 'q', label: 'Q', semantic_phase: 'preparation', takeaway: 'One message.' }],
      initial_state: {},
      expanded_event_count: 3,
      compose: [
        {
          copy: {
            scenario: 'base',
            from: 'e1',
            to: 'e2',
            phase_map: { p1: 'q' },
            patch: { e2: { explanation: 'Reused.' } },
          },
        },
        { insert: [event('own', { phase: 'q' })] },
      ],
    };
    const problems: string[] = [];
    const scn = compose(comp, { base: base() }, problems);
    expect(problems).toEqual([]);
    expect(scn.events.map((e) => [e.id, e.phase, e.sequence])).toEqual([
      ['c:e1', 'q', 1],
      ['c:e2', 'q', 2],
      ['c:own', 'q', 3],
    ]);
    expect(scn.events[1]?.explanation).toBe('Reused.');
    expect(validateRegistry({ c: scn }, ctx)).toEqual([]);
  });
});

describe('validation', () => {
  it('accepts a valid scenario', () => {
    expect(validateRegistry({ base: base() }, ctx)).toEqual([]);
  });

  it('names the scenario and event of each problem', () => {
    const scn = base();
    const [e1, e2, e3] = scn.events as [ScenarioEvent, ScenarioEvent, ScenarioEvent];
    e1.phase = 'nowhere';
    e2.pair_id = 'e3';
    e3.prediction = { prompt: 'No question' };
    e3.http = { method: 'POST' };
    e3.tracked_values = { secret: 'x' };
    e3.state_changes = [{ path: 'a', op: 'set', value_ref: 'payload.missing' }];
    expect(validateRegistry({ base: scn }, ctx)).toEqual([
      'base/e1: unknown phase nowhere',
      "base/e3: prediction must be {prompt: <a question of at least 10 characters ending with '?'>}",
      'base/e3: HTTP envelope on non-network event',
      'base/e3: untracked lineage key secret',
      'base/e3: value_ref payload.missing does not resolve',
      'base/e1: pair e2 not reciprocal',
      'base/e2: pair e3 not reciprocal',
    ]);
  });

  it('reports missing required fields and learning fields', () => {
    const scn = base();
    scn.headline = ' ';
    scn.learning_question = 'No question mark';
    delete (scn.events[2] as Partial<ScenarioEvent>).explanation;
    expect(validateRegistry({ base: scn }, ctx)).toEqual([
      'base: missing headline',
      "base: learning_question must end with '?'",
      'base/e3: missing explanation',
    ]);
  });

  it('checks that MCP headers mirror the body', () => {
    const scn = base();
    scn.participants.push('mcp-client', 'mcp-server');
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_balance',
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
    };
    scn.events = [
      event('r', {
        scenario_id: 'base',
        sequence: 1,
        sender: 'mcp-client',
        receiver: 'mcp-server',
        protocol: 'MCP',
        transport: 'streamable_http',
        execution_type: 'NETWORK',
        message_type: 'REQUEST',
        correlation_id: '2',
        payload,
        http: {
          headers: {
            'MCP-Protocol-Version': '2025-06-18',
            'Mcp-Method': 'tools/list',
            'Mcp-Name': 'other',
          },
        },
      }),
    ];
    expect(validateRegistry({ base: scn }, ctx)).toEqual([
      'base/r: MCP-Protocol-Version header does not match _meta',
      'base/r: Mcp-Method header does not match method',
      'base/r: Mcp-Name header does not match body',
      'base/r: correlation_id differs from JSON-RPC id',
    ]);
  });
});

describe('bundled registry', () => {
  it('loads the specifications without problems', () => {
    const registry = loadRegistry();
    expect(Object.keys(registry)).toHaveLength(14);
    expect(Object.values(registry).reduce((n, s) => n + s.events.length, 0)).toBe(294);
    expect(registry['mcp-balance']?.question).toBe(
      'What is the current balance of my bank account?',
    );
  });
});
