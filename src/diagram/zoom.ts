/**
 * Zoom levels (02-ui-ux.yaml zoom_levels): Overview, Architecture and Protocol show the same
 * scenario with one cursor. Pure functions map the cursor between levels and give the stops of
 * the Overview, which steps stage by stage.
 */
import type { Overview, Stage } from '../scenarios/types.ts';

export type Level = 'overview' | 'architecture' | 'protocol';

/** From the very basics to the exact messages (02 zoom_levels.levels). */
export const LEVELS: readonly Level[] = ['overview', 'architecture', 'protocol'];

export const LEVEL_LABELS: Readonly<Record<Level, string>> = {
  overview: 'Overview',
  architecture: 'Architecture',
  protocol: 'Protocol',
};

/** The next level in (+1) or out (-1), or undefined past either end. */
export function zoomed(level: Level, direction: 1 | -1): Level | undefined {
  return LEVELS[LEVELS.indexOf(level) + direction];
}

/** A stage with the cursors of its first and last played event (1-based; 0 when it has none). */
export interface StageSpan {
  stage: Stage;
  /** Position in overview.stages. */
  index: number;
  first: number;
  last: number;
}

/** Each stage with the span of its events among `events` (the events as played). */
export function stageSpans(overview: Overview, events: readonly { phase: string }[]): StageSpan[] {
  return overview.stages.map((stage, index) => {
    const phases = new Set(stage.phases);
    let first = 0;
    let last = 0;
    events.forEach((e, i) => {
      if (!phases.has(e.phase)) return;
      if (!first) first = i + 1;
      last = i + 1;
    });
    return { stage, index, first, last };
  });
}

/** The stage holding the event at `cursor`; undefined at step 0. */
export function stageAt(spans: readonly StageSpan[], cursor: number): StageSpan | undefined {
  if (cursor < 1) return undefined;
  return spans.find((s) => s.first > 0 && s.first <= cursor && cursor <= s.last);
}

/**
 * Where the Overview's cursor rests (02 zoom_levels.stepping): step 0, then the last event of
 * every stage with played events.
 */
export function stageStops(spans: readonly StageSpan[]): number[] {
  return [0, ...spans.filter((s) => s.last > 0).map((s) => s.last)];
}

/**
 * The cursor after a change of level (02 zoom_levels.cursor_mapping): in from the Overview to the
 * first event of the current stage, out to the Overview to the last event of the stage holding
 * the event; between Architecture and Protocol, and at step 0, it stays.
 */
export function zoomCursor(
  spans: readonly StageSpan[],
  cursor: number,
  from: Level,
  to: Level,
): number {
  if (from === to || cursor < 1) return cursor;
  const stage = stageAt(spans, cursor);
  if (!stage) return cursor;
  if (to === 'overview') return stage.last;
  if (from === 'overview') return stage.first;
  return cursor;
}

/** The parties whose members the events touch, in the overview's order. */
export function partiesOf(
  overview: Overview,
  events: readonly { sender: string; receiver: string }[],
): string[] {
  const touched = new Set(events.flatMap((e) => [e.sender, e.receiver]));
  return overview.parties.filter((p) => p.members.some((m) => touched.has(m))).map((p) => p.id);
}
