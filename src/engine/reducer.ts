/**
 * Pure reducer (03-simulation-engine.yaml state_model.reducer_rules): one event turns one
 * snapshot into the next. Snapshots are deeply frozen; nothing is ever undone in place.
 */
import { getPath, setPath } from '../scenarios/expand.ts';
import type { Json, JsonObject, Scenario, ScenarioEvent } from '../scenarios/types.ts';

/** One entry of the agent's working memory. */
export interface AgentStateEntry {
  event: string;
  description: string;
  value?: Json;
}

export interface LineageEntry {
  event: string;
  value: Json;
}

/** State after `cursor` events, without the parameter-dependent retrieval_config. */
export interface CoreSnapshot {
  readonly cursor: number;
  /** ID of event `cursor`; absent at 0. */
  readonly selected_event_id?: string;
  readonly lineage: Readonly<Record<string, readonly LineageEntry[]>>;
  /** The scenario's initial_state fields, such as agent_state, mcp_state and retrieval. */
  readonly state: Readonly<JsonObject>;
}

export class EngineError extends Error {
  constructor(
    readonly where: string,
    message: string,
  ) {
    super(`${where}: ${message}`);
    this.name = 'EngineError';
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function resolve(e: ScenarioEvent, ref: string, where: string): Json {
  const value = getPath(e as unknown as Json, ref);
  if (value === undefined) throw new EngineError(where, `value_ref ${ref} does not resolve`);
  return structuredClone(value as Json);
}

export function initialSnapshot(scenario: Scenario): CoreSnapshot {
  return deepFreeze({ cursor: 0, lineage: {}, state: structuredClone(scenario.initial_state) });
}

/** Applies event number `prev.cursor + 1` of the scenario. */
export function applyEvent(prev: CoreSnapshot, e: ScenarioEvent, scenarioId: string): CoreSnapshot {
  const where = `${scenarioId}/${e.id}`;
  const state = structuredClone(prev.state) as JsonObject;

  for (const ch of e.state_changes ?? []) {
    const value =
      ch.value_ref !== undefined
        ? resolve(e, ch.value_ref, where)
        : structuredClone(ch.value ?? null);
    if (ch.op === 'set') {
      const parent = ch.path.includes('.')
        ? getPath(state, ch.path.slice(0, ch.path.lastIndexOf('.')))
        : state;
      if (
        parent === undefined ||
        parent === null ||
        typeof parent !== 'object' ||
        !setPath(state, ch.path, value)
      ) {
        throw new EngineError(where, `state_change path ${ch.path} has no parent in the snapshot`);
      }
    } else {
      const target = getPath(state, ch.path);
      if (!Array.isArray(target))
        throw new EngineError(where, `state_change append to ${ch.path}, which is not a list`);
      target.push(value);
    }
  }

  for (const ch of e.context_changes ?? []) {
    const target = state[ch.target];
    if (ch.target === 'agent_state') {
      if (!Array.isArray(target))
        throw new EngineError(where, 'agent_state is not a list in the initial state');
      const entry: JsonObject = { event: e.id, description: ch.description };
      if (ch.value_ref !== undefined) entry['value'] = resolve(e, ch.value_ref, where);
      target.push(entry);
    } else {
      if (target === undefined)
        throw new EngineError(where, 'model_visible_messages is not in the initial state');
      if (ch.value_ref === undefined)
        throw new EngineError(where, 'model_visible_messages change needs a value_ref');
      state['model_visible_messages'] = resolve(e, ch.value_ref, where);
    }
  }

  let lineage = prev.lineage;
  const tracked = Object.entries(e.tracked_values ?? {});
  if (tracked.length) {
    const next: Record<string, LineageEntry[]> = structuredClone(prev.lineage) as Record<
      string,
      LineageEntry[]
    >;
    for (const [key, value] of tracked)
      (next[key] ??= []).push({ event: e.id, value: structuredClone(value) });
    lineage = next;
  }

  return deepFreeze({ cursor: prev.cursor + 1, selected_event_id: e.id, lineage, state });
}
