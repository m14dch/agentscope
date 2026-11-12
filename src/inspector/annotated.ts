/**
 * Pure helpers for annotated payloads (02-ui-ux.yaml inspector.annotations): how a bullet
 * shows its value, and where a tracked value travels (annotations.travel).
 */
import type { Json, ScenarioEvent } from '../scenarios/types.ts';
import { trackedValues } from './json.ts';

/** A bullet's value in the code face: long strings cut, containers summarised. */
export function valueLabel(value: Json): string {
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[…] ${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  }
  if (value !== null && typeof value === 'object') {
    const n = Object.keys(value).length;
    if (!n) return '{}';
    return `{…} ${n} ${n === 1 ? 'member' : 'members'}`;
  }
  if (typeof value === 'string' && value.length > 40)
    return JSON.stringify(`${value.slice(0, 36)}…`);
  return JSON.stringify(value);
}

/** The initial state and the tracked keys that can originate there (03 lineage.origins). */
export interface TravelSources {
  initialState: Readonly<Record<string, Json>>;
  origins: Readonly<Record<string, unknown>>;
}

export type HopKind = 'model' | 'repeats' | 'checks' | 'sent';

/** Where a tracked value travels; indices are 0-based into the played events. */
export interface Travel {
  /** The initial state (by its label) or the first played event that tracks the value. */
  origin: { label: string } | { index: number };
  /** The steps that matter after the origin, in step order. */
  hops: { index: number; kind: HopKind }[];
}

const tracks = (e: ScenarioEvent, value: string | number): boolean =>
  trackedValues(e.tracked_values).has(value);

/** The label of the value's origin in the initial state, if it has one. */
function stateOrigin(
  event: ScenarioEvent,
  value: string | number,
  sources: TravelSources | undefined,
): string | undefined {
  for (const [key, tracked] of Object.entries(event.tracked_values ?? {})) {
    if (!(Array.isArray(tracked) ? tracked : [tracked]).includes(value)) continue;
    const origin = sources?.origins[key];
    if (origin === null || typeof origin !== 'object') continue;
    const { state, label } = origin as { state?: unknown; label?: unknown };
    if (
      typeof state === 'string' &&
      typeof label === 'string' &&
      sources?.initialState[state] === value
    )
      return label;
  }
  return undefined;
}

/**
 * The travel of `value` if the event at `index` tracks it (02 inspector.annotations.travel),
 * else undefined. Only whole values match, never a value inside a longer string. A hop to a
 * later step that asks a prediction is left out, except "reaches the model": that says only
 * that the model receives the value, which no prediction asks, so no link answers one early.
 */
export function travel(
  events: readonly ScenarioEvent[],
  index: number,
  value: Json,
  sources?: TravelSources,
): Travel | undefined {
  const event = events[index];
  if (!event || (typeof value !== 'string' && typeof value !== 'number')) return undefined;
  if (!tracks(event, value)) return undefined;
  const label = stateOrigin(event, value, sources);
  const from = label === undefined ? events.findIndex((e) => tracks(e, value)) : -1;
  const next = (after: number, match: (e: ScenarioEvent) => boolean): number | undefined => {
    const i = events.findIndex((e, n) => n > after && match(e) && tracks(e, value));
    return i >= 0 ? i : undefined;
  };
  const repeats = next(from, (e) => e.protocol === 'LLM_API' && e.message_type === 'RESPONSE');
  const checks =
    repeats === undefined
      ? undefined
      : next(
          repeats,
          (e) => e.protocol === 'INTERNAL' && e.sender === 'agent' && e.receiver === 'agent',
        );
  const found: [number | undefined, HopKind][] = [
    [next(from, (e) => e.protocol === 'LLM_API' && e.message_type === 'REQUEST'), 'model'],
    [repeats, 'repeats'],
    [checks, 'checks'],
    [next(from, (e) => e.protocol === 'MCP' || e.protocol === 'HTTP'), 'sent'],
  ];
  const hops = found
    .filter((h): h is [number, HopKind] => h[0] !== undefined)
    .filter(([i, kind]) => kind === 'model' || !(i > index && events[i]?.prediction))
    .map(([i, kind]) => ({ index: i, kind }))
    .sort((a, b) => a.index - b.index);
  return { origin: label === undefined ? { index: from } : { label }, hops };
}
