/**
 * Structural and cross-reference checks on the expanded registry (03-simulation-engine.yaml
 * invariants, except schema.json validation and the RAG recomputation, which run in
 * specifications/tools/validate_specs.py). Every problem names its scenario and event.
 */
import { applyEvent, EngineError, initialSnapshot } from '../engine/reducer.ts';
import { buildRegistry, getPath } from './expand.ts';
import type { Json, Registry, Scenario, ScenarioEvent, SpecSources } from './types.ts';

export interface ValidationContext {
  participants: Set<string>;
  boundaries: Set<string>;
  semanticPhases: Set<string>;
  lineage: Set<string>;
  required: string[];
  scenarioRequired: string[];
  /** Allowed values of the enum event fields. */
  enums: Record<string, string[]>;
  revision: string;
}

/** agent_state is an append-only log; model_visible_messages is replaced by each LLM request. */
const CONTEXT_ACTIONS: Record<string, string> = {
  agent_state: 'append',
  model_visible_messages: 'set',
};

const ENUM_FIELDS = ['protocol', 'transport', 'execution_type', 'message_type'];

const PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';

export function contextFrom(sources: SpecSources): ValidationContext {
  return {
    participants: new Set(sources.architecture.participants.registry.map((p) => p.id)),
    boundaries: new Set(sources.security.trust_boundaries.map((b) => b.id)),
    semanticPhases: new Set(sources.comparison.semantic_phases.map((p) => p.id)),
    lineage: new Set(sources.engine.lineage.tracked),
    required: sources.engine.event_schema.required,
    scenarioRequired: sources.engine.scenario_format.required,
    // The spec writes enums as "A | B | C (note)".
    enums: Object.fromEntries(
      ENUM_FIELDS.map((f) => [
        f,
        text(sources.engine.event_schema.fields[f]).split(' (')[0]?.split(' | ') ?? [],
      ]),
    ),
    revision: sources.mcp.protocol.revision,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const sameList = (a: unknown[], b: unknown[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function checkMcp(
  e: ScenarioEvent,
  byId: Map<string, ScenarioEvent>,
  ctx: ValidationContext,
  where: string,
  err: (w: string, m: string) => void,
): void {
  const p = obj(e.payload);
  if (e.message_type === 'REQUEST') {
    const method = text(p['method']);
    const params = obj(p['params']);
    const version = obj(params['_meta'])[PROTOCOL_VERSION];
    const headers = obj(obj(e.http)['headers']);
    if (headers['MCP-Protocol-Version'] !== version)
      err(where, 'MCP-Protocol-Version header does not match _meta');
    if (version !== ctx.revision)
      err(
        where,
        `protocol version ${String(version)} differs from pinned revision ${ctx.revision}`,
      );
    if (headers['Mcp-Method'] !== method) err(where, 'Mcp-Method header does not match method');
    if (
      (method === 'tools/call' || method === 'resources/read') &&
      headers['Mcp-Name'] !== (params['name'] ?? params['uri'])
    ) {
      err(where, 'Mcp-Name header does not match body');
    }
    if (e.correlation_id !== String(p['id'])) err(where, 'correlation_id differs from JSON-RPC id');
  } else if (e.message_type === 'RESPONSE') {
    const req = obj(byId.get(e.pair_id ?? '')?.payload);
    if (p['id'] !== req['id'] || e.correlation_id !== String(p['id'])) {
      err(where, 'JSON-RPC response id does not match request');
    }
  }
}

/** Tool results and retrieved chunks reach the model only through an LLM request, and every
 * LLM request after a tool call carries the whole conversation. */
function checkVisibility(scn: Scenario, err: (w: string, m: string) => void): void {
  const seen: unknown[] = [];
  for (const e of scn.events) {
    const where = `${scn.id}/${e.id}`;
    const p = obj(e.payload);
    if (e.protocol === 'LLM_API' && e.message_type === 'RESPONSE') {
      seen.push(...list(obj(p['message'])['tool_calls']).map((c) => obj(c)['id']));
    }
    if (e.protocol === 'LLM_API' && e.message_type === 'REQUEST') {
      const msgs = list(p['messages']).map(obj);
      const toolMsgs = msgs.filter((m) => m['role'] === 'tool').map((m) => m['tool_call_id']);
      const calls = msgs
        .filter((m) => m['role'] === 'assistant')
        .flatMap((m) => list(m['tool_calls']).map((c) => obj(c)['id']));
      if (!sameList(toolMsgs, calls))
        err(where, 'every assistant tool call needs its tool message');
      if (seen.length && !sameList(toolMsgs, seen))
        err(where, 'LLM request does not resend the full conversation');
    }
    for (const ch of e.context_changes ?? []) {
      if (ch.target === 'model_visible_messages' && e.protocol !== 'LLM_API') {
        err(where, 'only LLM requests may change model-visible context');
      }
    }
  }
}

function checkScenario(
  scn: Scenario,
  ctx: ValidationContext,
  allIds: Set<string>,
  err: (w: string, m: string) => void,
): void {
  const sid = scn.id;
  for (const f of ctx.scenarioRequired) if (!Object.hasOwn(scn, f)) err(sid, `missing ${f}`);
  if (!text(scn.learning_question).trim()) err(sid, 'missing learning_question');
  if (!text(scn.headline).trim()) err(sid, 'missing headline');
  if (!text(scn.learning_question).trimEnd().endsWith('?'))
    err(sid, "learning_question must end with '?'");
  const phases = new Set<string>();
  for (const p of list(scn.phases).map(obj)) {
    phases.add(text(p['id']));
    if (!text(p['takeaway']).trim()) err(sid, `phase ${text(p['id'])} has no takeaway`);
    if (!ctx.semanticPhases.has(text(p['semantic_phase']))) {
      err(sid, `phase ${text(p['id'])} has unknown semantic_phase ${text(p['semantic_phase'])}`);
    }
  }
  const declared = new Set(list(scn.participants).map(text));
  for (const p of declared)
    if (!ctx.participants.has(p)) err(sid, `participant ${p} missing from registry`);

  const byId = new Map<string, ScenarioEvent>();
  const complete: ScenarioEvent[] = [];
  list(scn.events).forEach((raw, i) => {
    const e = obj(raw) as unknown as ScenarioEvent;
    const where = `${sid}/${typeof e.id === 'string' ? e.id : `events[${i}]`}`;
    const missing = ctx.required.filter((f) => !Object.hasOwn(e, f));
    if (missing.length) {
      err(where, `missing ${missing.join(', ')}`);
      return;
    }
    for (const [f, allowed] of Object.entries(ctx.enums)) {
      const value = (e as unknown as Obj)[f];
      if (!allowed.includes(text(value))) {
        err(where, `${f} ${String(value)} is not one of ${allowed.join(' | ')}`);
      }
    }
    if (
      Object.hasOwn(e, 'correlation_id') &&
      !(e.protocol === 'MCP' && (e.message_type === 'REQUEST' || e.message_type === 'RESPONSE'))
    ) {
      err(where, 'correlation_id outside an MCP request or response');
    }
    if (allIds.has(e.id)) err(where, 'duplicate event id');
    allIds.add(e.id);
    byId.set(e.id, e);
    complete.push(e);
    if (e.sequence !== i + 1 || e.scenario_id !== sid) err(where, 'bad sequence or scenario_id');
    if (!phases.has(e.phase)) err(where, `unknown phase ${e.phase}`);
    for (const p of [e.sender, e.receiver])
      if (!declared.has(p)) err(where, `participant ${p} not declared`);
    if (Object.hasOwn(e, 'prediction')) {
      const prompt = obj(e.prediction)['prompt'];
      if (
        typeof prompt !== 'string' ||
        prompt.trim().length < 10 ||
        !prompt.trimEnd().endsWith('?')
      ) {
        err(
          where,
          "prediction must be {prompt: <a question of at least 10 characters ending with '?'>}",
        );
      }
    }
    if (e.execution_type !== 'NETWORK' && Object.hasOwn(e, 'http'))
      err(where, 'HTTP envelope on non-network event');
    if (e.execution_type === 'IN_PROCESS' && e.transport !== 'in_process') {
      err(where, 'IN_PROCESS event must use transport in_process');
    }
    for (const b of list(e.security_boundaries)) {
      if (!ctx.boundaries.has(text(b))) err(where, `unknown security boundary ${String(b)}`);
    }
    for (const k of Object.keys(obj(e.tracked_values))) {
      if (!ctx.lineage.has(k)) err(where, `untracked lineage key ${k}`);
    }
    for (const ch of list(e.state_changes).map(obj)) {
      if (
        (ch['op'] !== 'set' && ch['op'] !== 'append') ||
        Object.hasOwn(ch, 'value') === Object.hasOwn(ch, 'value_ref')
      ) {
        err(where, 'state_change needs op set or append and exactly one of value and value_ref');
      }
    }
    for (const ch of list(e.context_changes).map(obj)) {
      const target = text(ch['target']);
      const rule = Object.hasOwn(CONTEXT_ACTIONS, target) ? CONTEXT_ACTIONS[target] : undefined;
      if (rule === undefined)
        err(where, `context_change has unknown target ${String(ch['target'])}`);
      else if (ch['action'] !== rule) {
        err(where, `context_change on ${String(ch['target'])} must use action ${rule}`);
      }
      if (!Object.hasOwn(ch, 'value_ref')) err(where, 'context_change needs a value_ref');
      if (
        ch['target'] === 'model_visible_messages' &&
        (e.protocol !== 'LLM_API' || e.message_type !== 'REQUEST')
      ) {
        err(where, 'model_visible_messages changes only on LLM requests');
      }
    }
    for (const ch of [...list(e.state_changes), ...list(e.context_changes)].map(obj)) {
      const ref = ch['value_ref'];
      if (ref !== undefined && getPath(e as unknown as Json, text(ref)) === undefined) {
        err(where, `value_ref ${text(ref)} does not resolve`);
      }
    }
  });
  for (const e of complete) {
    const where = `${sid}/${e.id}`;
    if (e.pair_id !== undefined && byId.get(e.pair_id)?.pair_id !== e.id) {
      err(where, `pair ${e.pair_id} not reciprocal`);
    }
    if (e.protocol === 'MCP') checkMcp(e, byId, ctx, where, err);
  }
  if (complete.length === list(scn.events).length) checkVisibility(scn, err);
  checkDerived(scn, byId, err);
}

/** derived_events and optional_steps name the scenario's events (03 scenario_format). */
function checkDerived(
  scn: Scenario,
  byId: Map<string, ScenarioEvent>,
  err: (w: string, m: string) => void,
): void {
  const sid = scn.id;
  const local = new Set(
    [...byId.keys()].map((id) => (id.startsWith(`${sid}:`) ? id.slice(sid.length + 1) : id)),
  );
  for (const id of list(scn.derived_events).map(text)) {
    if (!local.has(id)) err(sid, `derived_events names unknown event ${id}`);
  }
  const steps: unknown = (scn as unknown as Obj)['optional_steps'];
  if (steps === undefined) return;
  if (!Array.isArray(steps)) {
    err(sid, 'optional_steps must be a list');
    return;
  }
  const parameters = obj(scn.parameters);
  for (const step of steps.map(obj)) {
    const by = text(step['enabled_by']);
    const parameter = Object.hasOwn(parameters, by) ? obj(parameters[by]) : {};
    if (typeof parameter['default'] !== 'boolean')
      err(sid, `optional step enabled_by ${by} is not a boolean parameter`);
    const events = list(step['events']).map(text);
    for (const id of events) {
      if (!local.has(id)) {
        err(sid, `optional_steps names unknown event ${id}`);
        continue;
      }
      const pair = (byId.get(id) ?? byId.get(`${sid}:${id}`))?.pair_id;
      const partner = pair?.startsWith(`${sid}:`) ? pair.slice(sid.length + 1) : pair;
      if (partner !== undefined && !events.includes(partner))
        err(sid, `optional step ${id} and its pair ${partner} are in different entries`);
    }
  }
}

export function validateRegistry(registry: Registry, ctx: ValidationContext): string[] {
  const problems: string[] = [];
  const err = (where: string, msg: string): void => void problems.push(`${where}: ${msg}`);
  const allIds = new Set<string>();
  for (const scn of Object.values(registry)) checkScenario(scn, ctx, allIds, err);
  return problems;
}

/** Expands and validates the bundled specifications. An empty problem list means valid. */
export function loadScenarios(sources: SpecSources): { registry: Registry; problems: string[] } {
  const { registry, problems } = buildRegistry(sources);
  problems.push(...validateRegistry(registry, contextFrom(sources)));
  const err = (where: string, msg: string): void => void problems.push(`${where}: ${msg}`);
  for (const v of [
    ...sources.mcp.variants,
    ...sources.rag.variants,
    ...(sources.comparison.combined.variants ?? []),
  ]) {
    if (!text(v.lesson).trim()) err(v.id, 'variant has no lesson');
  }
  const comb = sources.comparison.combined;
  if (registry[comb.id]?.events.length !== comb.expanded_event_count) {
    err(
      comb.id,
      `expanded_event_count ${comb.expanded_event_count} differs from ${registry[comb.id]?.events.length}`,
    );
  }
  const q = sources.product.primary_questions;
  const asked: [string, string | undefined, string][] = [
    ['mcp-balance', registry['mcp-balance']?.question, q.mcp],
    ['rag-query', registry['rag-query']?.question, q.rag],
    [comb.id, comb.question, q.combined],
  ];
  for (const [sid, got, want] of asked) {
    if (got !== want) err(sid, 'question differs from 00-product.yaml primary_questions');
  }
  for (const [sid, mapping] of Object.entries(sources.comparison.compare.phase_mapping)) {
    const phases = registry[sid]?.phases ?? [];
    const actual = Object.fromEntries(phases.map((p) => [p.id, p.semantic_phase]));
    const keys = new Set([...Object.keys(actual), ...Object.keys(mapping)]);
    if ([...keys].some((k) => actual[k] !== mapping[k])) {
      err('compare.phase_mapping', `${sid} mapping differs from scenario phases`);
    }
  }
  if (!problems.length) problems.push(...replayProblems(registry));
  return { registry, problems };
}

/** Replays every scenario through the reducer; only run on structurally valid data. */
function replayProblems(registry: Registry): string[] {
  const problems: string[] = [];
  for (const scn of Object.values(registry)) {
    try {
      scn.events.reduce((snapshot, e) => applyEvent(snapshot, e, scn.id), initialSnapshot(scn));
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      problems.push(error.message);
    }
  }
  return problems;
}
