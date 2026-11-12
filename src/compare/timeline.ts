/**
 * The Compare view's shared timeline (02-ui-ux.yaml compare_view.timeline): two scenarios
 * stepped in sync by semantic phase. Pure, so the sync rules are tested without a browser.
 */

/** One pane's scenario: its events in play order and each scenario phase's semantic phase. */
export interface PaneInput {
  events: readonly { id: string; phase: string }[];
  /** Scenario phase ID → semantic phase ID (06 compare.phase_mapping). */
  semanticOf: Readonly<Record<string, string>>;
}

/**
 * What a pane does at a compare step: before any event (start), at its j-th event of the
 * phase (stepping), resting on its last event of the phase while the other pane continues
 * (done), or without events in the phase (placeholder).
 */
export type PaneStatus = 'start' | 'stepping' | 'done' | 'placeholder';

export interface PaneAt {
  /** The pane's own cursor: 0 before any event, k at its k-th event. */
  cursor: number;
  status: PaneStatus;
}

export interface CompareStep {
  /** The semantic phase both panes show; undefined at step 0. */
  phase: string | undefined;
  panes: readonly [PaneAt, PaneAt];
}

/** Compare step 0: before any event, both panes at their step 0. */
const START: CompareStep = {
  phase: undefined,
  panes: [
    { cursor: 0, status: 'start' },
    { cursor: 0, status: 'start' },
  ],
};

export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineError';
  }
}

export class CompareTimeline {
  readonly steps: readonly CompareStep[];

  /**
   * @param phases semantic phase IDs in order (06 semantic_phases)
   * @param panes the left and right scenarios
   * @throws TimelineError if a pane's events do not visit the semantic phases in order
   */
  constructor(phases: readonly string[], panes: readonly [PaneInput, PaneInput]) {
    const order = new Map(phases.map((p, i) => [p, i]));
    // For each pane, the semantic phase index of each event, checked to be non-decreasing.
    const indicesOf = (pane: PaneInput, side: number): number[] => {
      let last = -1;
      return pane.events.map((e) => {
        const semantic = pane.semanticOf[e.phase];
        const index = semantic === undefined ? undefined : order.get(semantic);
        if (index === undefined) {
          throw new TimelineError(`pane ${side}: event ${e.id} has no semantic phase`);
        }
        if (index < last) {
          throw new TimelineError(
            `pane ${side}: event ${e.id} returns to ${semantic} after a later semantic phase`,
          );
        }
        last = index;
        return index;
      });
    };
    const left = indicesOf(panes[0], 0);
    const right = indicesOf(panes[1], 1);
    const steps: CompareStep[] = [START];
    phases.forEach((phase, p) => {
      // Events before the phase, and events in it, per pane.
      const range = (list: number[]) => ({
        before: list.filter((i) => i < p).length,
        count: list.filter((i) => i === p).length,
      });
      const ranges = [range(left), range(right)] as const;
      const place = ({ before, count }: { before: number; count: number }, j: number): PaneAt =>
        count === 0
          ? { cursor: before, status: 'placeholder' }
          : { cursor: before + Math.min(j, count), status: j > count ? 'done' : 'stepping' };
      const length = Math.max(ranges[0].count, ranges[1].count);
      for (let j = 1; j <= length; j += 1) {
        steps.push({ phase, panes: [place(ranges[0], j), place(ranges[1], j)] });
      }
    });
    this.steps = steps;
  }

  /** The last compare step; valid steps are 0 to length. */
  get length(): number {
    return this.steps.length - 1;
  }

  /** The step, clamped to 0..length. */
  at(step: number): CompareStep {
    return this.steps[this.clamp(step)] ?? START;
  }

  clamp(step: number): number {
    return Math.max(0, Math.min(this.length, Math.trunc(Number.isFinite(step) ? step : 0)));
  }

  /**
   * The compare step a pane's own slider moves to (02 compare_view.controls): the first step
   * at which that pane is at its cursor, so the other pane follows to the same phase.
   */
  stepOf(side: 0 | 1, cursor: number): number {
    if (cursor <= 0) return 0;
    const found = this.steps.findIndex(
      (s) => s.panes[side].status === 'stepping' && s.panes[side].cursor >= cursor,
    );
    return found === -1 ? this.length : found;
  }
}

/**
 * A pane's stages as the events of the Overview's timeline (02 compare_view.timeline): each stage
 * with played events counts as one event of the semantic phase of its first phase, so the panes
 * step stage by stage. A pane's cursor on this timeline counts stages.
 */
export function stageInput(
  pane: PaneInput,
  stages: readonly { stage: { id: string; phases: readonly string[] }; last: number }[],
): PaneInput {
  return {
    semanticOf: pane.semanticOf,
    events: stages
      .filter((s) => s.last > 0)
      .map((s) => ({ id: s.stage.id, phase: s.stage.phases[0] ?? '' })),
  };
}
