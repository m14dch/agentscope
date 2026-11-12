import { describe, expect, it } from 'vitest';
import { buildRegistry, compose, getPath, setPath } from '../../src/scenarios/expand.ts';
import { loadRegistry } from '../../src/scenarios/registry.ts';
import { createPlayback } from '../../src/rag/bundled.ts';
import type {
  Composition,
  ContextChange,
  Json,
  Scenario,
  ScenarioEvent,
} from '../../src/scenarios/types.ts';
import {
  contextFrom,
  loadScenarios,
  validateRegistry,
  type ValidationContext,
} from '../../src/scenarios/validate.ts';
import sources from 'virtual:agentscope-specs';
import type { SpecSources } from '../../src/scenarios/types.ts';

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

function phase(id: string): Scenario['phases'][number] {
  return { id, label: 'Phase', semantic_phase: 'preparation', takeaway: 'One message.' };
}

/** An overview of two parties (agent, llm) and one stage per phase. */
function overview(phases: string[]): Scenario['overview'] {
  return {
    parties: [
      { id: 'a', label: 'Assistant', members: ['agent'] },
      { id: 'm', label: 'Helper', members: ['llm'] },
    ],
    stages: phases.map((id) => ({ id, phases: [id], sentence: `Stage ${id} happens.` })),
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
    phases: ['p1', 'p2', 'p3'].map((id) => phase(id)),
    overview: overview(['p1', 'p2', 'p3']),
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
  scenarioRequired: [
    'id',
    'title',
    'learning_question',
    'headline',
    'participants',
    'phases',
    'events',
    'initial_state',
    'overview',
  ],
  enums: {
    protocol: ['MCP', 'HTTP', 'LLM_API', 'RAG_INTERNAL', 'UI', 'DB', 'INTERNAL'],
    transport: ['streamable_http', 'https', 'in_process', 'simulated'],
    execution_type: ['NETWORK', 'IN_PROCESS', 'SIMULATED_INTERNAL'],
    message_type: ['REQUEST', 'RESPONSE', 'NOTIFICATION', 'ACTION', 'RESULT'],
  },
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

describe('composition', () => {
  it('copies inclusive ranges with phase maps and patches, then inserts', () => {
    const comp: Composition = {
      id: 'c',
      title: 'Combined',
      question: 'Q?',
      learning_question: 'What composes?',
      headline: 'Composition reuses events.',
      participants: ['agent', 'llm'],
      phases: ['q', 'r', 's'].map((id) => phase(id)),
      overview: overview(['q', 'r', 's']),
      initial_state: {},
      expanded_event_count: 3,
      derived_events: ['own'],
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
    expect(scn.derived_events).toEqual(['own']);
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
    scn.overview.parties[0]?.members.push('mcp-client', 'mcp-server');
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

describe('more validation rules', () => {
  function llm(id: string, message_type: 'REQUEST' | 'RESPONSE', payload: Json): ScenarioEvent {
    return event(id, {
      protocol: 'LLM_API',
      transport: 'https',
      execution_type: 'NETWORK',
      message_type,
      payload,
    });
  }

  it('requires every LLM request to resend the assistant tool calls with their tool messages', () => {
    const scn = base();
    const call = { role: 'assistant', tool_calls: [{ id: 't1' }] };
    scn.events = [
      llm('a', 'RESPONSE', { message: call }),
      llm('b', 'REQUEST', { messages: [{ role: 'user' }, call] }),
      llm('c', 'REQUEST', { messages: [{ role: 'user' }] }),
      llm('d', 'REQUEST', {
        messages: [{ role: 'user' }, call, { role: 'tool', tool_call_id: 't1' }],
      }),
    ];
    scn.events.forEach((e, i) => (e.sequence = i + 1));
    expect(validateRegistry({ base: scn }, ctx)).toEqual([
      'base/b: every assistant tool call needs its tool message',
      'base/b: LLM request does not resend the full conversation',
      'base/c: LLM request does not resend the full conversation',
    ]);
  });

  it('lets only LLM requests change model-visible context', () => {
    const scn = base();
    (scn.events[2] as ScenarioEvent).context_changes = [
      { target: 'model_visible_messages', action: 'set', description: 'Leak.', value_ref: 'id' },
    ];
    expect(validateRegistry({ base: scn }, ctx)).toEqual([
      'base/e3: model_visible_messages changes only on LLM requests',
      'base/e3: only LLM requests may change model-visible context',
    ]);
  });

  it('keeps agent_state append-only and requires well-formed state changes', () => {
    const scn = base();
    const e3 = scn.events[2] as ScenarioEvent;
    e3.context_changes = [
      { target: 'agent_state', action: 'set', description: 'Replace.', value_ref: 'id' },
      { target: 'agent_state', action: 'append', description: 'No value.' } as ContextChange,
    ];
    e3.state_changes = [
      { path: 'a', op: 'set' },
      { path: 'a', op: 'set', value: 1, value_ref: 'id' },
      { path: 'a', op: 'merge' as 'set', value: 1 },
    ];
    expect(validateRegistry({ base: scn }, ctx)).toEqual([
      'base/e3: state_change needs op set or append and exactly one of value and value_ref',
      'base/e3: state_change needs op set or append and exactly one of value and value_ref',
      'base/e3: state_change needs op set or append and exactly one of value and value_ref',
      'base/e3: context_change on agent_state must use action append',
      'base/e3: context_change needs a value_ref',
    ]);
  });

  it('checks that derived events and optional steps name events and boolean parameters', () => {
    const scn = base();
    scn.parameters = { top_k: { default: 5 }, on: { default: false } };
    scn.derived_events = ['e2', 'nope'];
    scn.optional_steps = [
      { events: ['e1', 'e2'], enabled_by: 'on' },
      { events: ['gone'], enabled_by: 'top_k' },
    ];
    expect(validateRegistry({ base: scn }, ctx)).toEqual([
      'base: derived_events names unknown event nope',
      'base: optional step enabled_by top_k is not a boolean parameter',
      'base: optional_steps names unknown event gone',
    ]);
  });

  it('keeps both events of a pair in one optional-step entry', () => {
    const scn = base();
    scn.parameters = { on: { default: false } };
    scn.optional_steps = [
      { events: ['e1'], enabled_by: 'on' },
      { events: ['e2'], enabled_by: 'on' },
    ];
    expect(validateRegistry({ base: scn }, ctx)).toEqual([
      'base: optional step e1 and its pair e2 are in different entries',
      'base: optional step e2 and its pair e1 are in different entries',
    ]);
  });

  it('checks boundaries, enums, correlation IDs, prediction length and scenario fields', () => {
    const scn = base();
    delete (scn as Partial<Scenario>).initial_state;
    const [e1, e2, e3] = scn.events as [ScenarioEvent, ScenarioEvent, ScenarioEvent];
    e1.security_boundaries = ['b1', 'nowhere'];
    (e2 as unknown as Record<string, unknown>)['protocol'] = 'MCPX';
    e3.correlation_id = '1';
    e3.prediction = { prompt: 'Short?' };
    expect(validateRegistry({ base: scn }, ctx)).toEqual([
      'base: missing initial_state',
      'base/e1: unknown security boundary nowhere',
      'base/e2: protocol MCPX is not one of MCP | HTTP | LLM_API | RAG_INTERNAL | UI | DB | INTERNAL',
      'base/e3: correlation_id outside an MCP request or response',
      "base/e3: prediction must be {prompt: <a question of at least 10 characters ending with '?'>}",
    ]);
  });

  it('reports duplicate event IDs across the registry', () => {
    const other = base();
    other.id = 'other';
    other.events.forEach((e) => (e.scenario_id = 'other'));
    expect(validateRegistry({ base: base(), other }, ctx)).toEqual([
      'other/e1: duplicate event id',
      'other/e2: duplicate event id',
      'other/e3: duplicate event id',
    ]);
  });

  it('reports an event without an ID', () => {
    const b = base();
    delete (b.events[2] as Partial<ScenarioEvent>).id;
    expect(validateRegistry({ base: b }, ctx)).toEqual(['base/events[2]: missing id']);
  });

  it('rejects a variants key (03 one_scenario_per_use_case)', () => {
    const specs = structuredClone(sources) as SpecSources;
    (specs.rag as Record<string, unknown>)['variants'] = [];
    (specs.comparison.combined as unknown as Record<string, unknown>)['variants'] = [];
    expect(loadScenarios(specs).problems).toEqual([
      '05: variants are not allowed: one scenario per use case',
      '06 combined: variants are not allowed: one scenario per use case',
    ]);
    expect(loadScenarios(sources).problems).toEqual([]);
  });

  it('reports a base scenario without events instead of crashing', () => {
    const specs = structuredClone(sources) as SpecSources;
    delete (specs.mcp.scenarios[0] as Partial<Scenario>).events;
    const { problems } = buildRegistry(specs);
    expect(problems[0]).toBe('mcp-balance: events must be a list');
    expect(problems).toContain(
      'combined-balance-explanation: copy names unknown scenario mcp-balance',
    );
  });

  it('ignores inherited keys and non-decimal indexes in paths', () => {
    expect(getPath({ a: [1, 2] }, 'a.1e0')).toBeUndefined();
    expect(getPath({ a: [1, 2] }, 'a.')).toBeUndefined();
    expect(getPath({}, 'toString')).toBeUndefined();
    const obj = {};
    expect(setPath(obj, '__proto__', { polluted: true })).toBe(false);
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
  });

  it('reads the enum values from 03-simulation-engine.yaml', () => {
    expect(contextFrom(sources).enums).toEqual(ctx.enums);
    expect(contextFrom(sources).scenarioRequired).toEqual(ctx.scenarioRequired);
  });
});

describe('bundled registry', () => {
  it('loads one scenario per use case without problems (03 one_scenario_per_use_case)', () => {
    const registry = loadRegistry();
    expect(Object.keys(registry)).toEqual([
      'mcp-balance',
      'rag-index',
      'rag-query',
      'combined-balance-explanation',
    ]);
    expect(Object.values(registry).reduce((n, s) => n + s.events.length, 0)).toBe(88);
    expect(registry['mcp-balance']?.question).toBe(
      'What is the current balance of my bank account?',
    );
  });

  it('labels every response the model sends as simulated (02 learning.simulated_behaviour)', () => {
    // 08 definition_of_done: no fictional model output represented as real inference. Every
    // scenario, Combined included, as written and as played (derived events too).
    const fromModel = (e: { protocol: string; message_type: string; sender: string }) =>
      e.protocol === 'LLM_API' && e.message_type === 'RESPONSE' && e.sender === 'llm';
    const scenarios = Object.values(loadRegistry());
    const responses = scenarios.flatMap((s) => [
      ...s.events.filter(fromModel),
      ...createPlayback(s).events.filter(fromModel),
    ]);
    // Each scenario but rag-index (no model) has at least its answer; MCP ones a tool call too.
    for (const s of scenarios.filter((s) => s.id !== 'rag-index'))
      expect(
        responses.some((e) => e.scenario_id === s.id),
        s.id,
      ).toBe(true);
    expect(
      new Set(responses.filter((e) => /tool call/.test(e.operation)).map((e) => e.scenario_id)),
    ).toEqual(new Set(['mcp-balance', 'combined-balance-explanation']));
    for (const e of responses) expect(e.explanation, e.id).toMatch(/^Simulated model output/);
  });
});
