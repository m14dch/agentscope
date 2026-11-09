/**
 * Deterministic playback of one scenario: random access to the snapshot at any cursor,
 * computed forward from the initial state and cached, never by reversing side effects.
 */
import type { Json, Scenario, ScenarioEvent } from '../scenarios/types.ts';
import { parameterProblem } from '../scenarios/parameters.ts';
import { applyEvent, type CoreSnapshot, deepFreeze, initialSnapshot } from './reducer.ts';

export type RetrievalConfig = Readonly<Record<string, Json>>;

export interface Snapshot extends CoreSnapshot {
  /** Each scenario parameter's current value. */
  readonly retrieval_config: RetrievalConfig;
}

/**
 * Regenerates the parameter-dependent (derived) events. The RAG engine supplies this;
 * by default the scenario's events are fixed.
 */
export type DeriveEvents = (
  scenario: Scenario,
  config: RetrievalConfig,
) => readonly ScenarioEvent[];

export interface PlaybackOptions {
  deriveEvents?: DeriveEvents;
}

function defaults(scenario: Scenario): Record<string, Json> {
  return Object.fromEntries(
    Object.entries(scenario.parameters ?? {}).map(([k, p]) => [k, p.default]),
  );
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class Playback {
  private config: RetrievalConfig;
  private events: readonly ScenarioEvent[];
  /** core[k] is the state after k events; holes are computed on demand. */
  private core: CoreSnapshot[];
  private views = new Map<number, Snapshot>();
  private readonly derive: DeriveEvents;

  readonly scenario: Scenario;

  constructor(scenario: Scenario, options: PlaybackOptions = {}) {
    this.scenario = scenario;
    this.derive = options.deriveEvents ?? ((s) => s.events);
    this.config = deepFreeze(structuredClone(defaults(scenario)));
    this.events = this.frozenEvents(this.config);
    this.core = [initialSnapshot(scenario)];
  }

  /** Number of events; valid cursors are 0 to length. */
  get length(): number {
    return this.events.length;
  }

  get retrievalConfig(): RetrievalConfig {
    return this.config;
  }

  /** A frozen copy, so later changes to the registry cannot reach the snapshots. */
  private frozenEvents(config: RetrievalConfig): readonly ScenarioEvent[] {
    return deepFreeze(structuredClone(this.derive(this.scenario, config)));
  }

  event(cursor: number): ScenarioEvent | undefined {
    return cursor >= 1 ? this.events[cursor - 1] : undefined;
  }

  snapshot(cursor: number): Snapshot {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.length) {
      throw new RangeError(`cursor ${cursor} is outside 0..${this.length}`);
    }
    const cached = this.views.get(cursor);
    if (cached) return cached;
    let k = cursor;
    while (!this.core[k]) k -= 1;
    for (; k < cursor; k += 1) {
      this.core[k + 1] = applyEvent(
        this.core[k] as CoreSnapshot,
        this.events[k] as ScenarioEvent,
        this.scenario.id,
      );
    }
    const view = Object.freeze({
      ...(this.core[cursor] as CoreSnapshot),
      retrieval_config: this.config,
    });
    this.views.set(cursor, view);
    return view;
  }

  /**
   * Changes parameter values (each must satisfy parameterProblem), regenerates the derived
   * events and drops the snapshots from the first changed event on. Returns that event's
   * cursor (length + 1 if none). When a Player owns this playback, call
   * Player.setParameters instead, which also clamps the player's cursor.
   */
  setParameters(values: Readonly<Record<string, Json>>): number {
    const known = this.scenario.parameters ?? {};
    for (const [name, value] of Object.entries(values)) {
      const spec = Object.hasOwn(known, name) ? known[name] : undefined;
      if (!spec) throw new RangeError(`${this.scenario.id} has no parameter ${name}`);
      const problem = parameterProblem(name, spec, value);
      if (problem) throw new RangeError(problem);
    }
    const config = deepFreeze({ ...this.config, ...structuredClone(values) });
    const events = this.frozenEvents(config);
    let first = 0;
    while (
      first < Math.min(events.length, this.events.length) &&
      same(events[first], this.events[first])
    )
      first += 1;
    const changed =
      first === events.length && first === this.events.length ? events.length + 1 : first + 1;
    this.config = config;
    this.events = events;
    // core[k] depends on events 1..k, so it stays valid for k < changed.
    this.core.length = Math.min(this.core.length, changed);
    this.views.clear();
    return changed;
  }
}
