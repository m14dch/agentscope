/**
 * Pure helpers for annotated payloads (02-ui-ux.yaml inspector.annotations): how a bullet
 * shows its value, and where a tracked value travels (annotations.travel).
 */
import type { Json, ScenarioEvent } from '../scenarios/types.ts';
import { trackedValues } from './json.ts';

/** A bullet's value in the code face: long strings cut, containers summarised. */
export function valueLabel(value: Json): string {
  if (Array.isArray(value)) return `[…] ${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  if (value !== null && typeof value === 'object') {
    const n = Object.keys(value).length;
    return `{…} ${n} ${n === 1 ? 'member' : 'members'}`;
  }
  if (typeof value === 'string' && value.length > 40)
    return JSON.stringify(`${value.slice(0, 36)}…`);
  return JSON.stringify(value);
}

/** Where a tracked value travels: event indices (0-based) in the played events. */
export interface Travel {
  /** The first played event that tracks the value. */
  first: number;
  /** The first LLM request that tracks the value, when it is later than `first`. */
  model?: number;
  /** The first MCP or HTTP event that tracks the value, when it is later than `first`. */
  tool?: number;
}

const tracks = (e: ScenarioEvent, value: string | number): boolean =>
  trackedValues(e.tracked_values).has(value);

/**
 * The travel of `value` if the event at `index` tracks it (02 inspector.annotations.travel),
 * else undefined. Only whole values match, never a value inside a longer string.
 */
export function travel(
  events: readonly ScenarioEvent[],
  index: number,
  value: Json,
): Travel | undefined {
  const event = events[index];
  if (!event || (typeof value !== 'string' && typeof value !== 'number')) return undefined;
  if (!tracks(event, value)) return undefined;
  const first = events.findIndex((e) => tracks(e, value));
  const after = (match: (e: ScenarioEvent) => boolean): number | undefined => {
    const i = events.findIndex((e, n) => n >= first && match(e) && tracks(e, value));
    // A value that first appears in such an event needs no second mention of it.
    return i > first ? i : undefined;
  };
  const model = after((e) => e.protocol === 'LLM_API' && e.message_type === 'REQUEST');
  const tool = after((e) => e.protocol === 'MCP' || e.protocol === 'HTTP');
  return {
    first,
    ...(model === undefined ? {} : { model }),
    ...(tool === undefined ? {} : { tool }),
  };
}
