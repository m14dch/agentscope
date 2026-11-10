/**
 * Step numbers in the address (02-ui-ux.yaml navigation.route_steps): the route numbers
 * steps as played at the scenario's default parameters, while the cursor numbers the events
 * played now. Optional steps that parameters add or remove make the two differ.
 */
import type { ScenarioEvent } from '../scenarios/types.ts';

/**
 * The step at which the current event is played at the defaults; if it is not, the step of
 * the nearest earlier current event that is, else 0.
 */
export function toDefaultStep(
  defaults: readonly ScenarioEvent[],
  current: readonly ScenarioEvent[],
  cursor: number,
): number {
  const at = new Map(defaults.map((e, i) => [e.id, i + 1]));
  for (let k = Math.min(cursor, current.length); k >= 1; k -= 1) {
    const step = at.get(current[k - 1]?.id ?? '');
    if (step !== undefined) return step;
  }
  return 0;
}

/**
 * The cursor for a default-numbered step: the event played at that step at the defaults,
 * or if it is not played now the nearest earlier default event that is, else 0. Steps
 * beyond the defaults are clamped to the last one.
 */
export function fromDefaultStep(
  defaults: readonly ScenarioEvent[],
  current: readonly ScenarioEvent[],
  step: number,
): number {
  const at = new Map(current.map((e, i) => [e.id, i + 1]));
  for (let k = Math.min(Math.trunc(step), defaults.length); k >= 1; k -= 1) {
    const cursor = at.get(defaults[k - 1]?.id ?? '');
    if (cursor !== undefined) return cursor;
  }
  return 0;
}
