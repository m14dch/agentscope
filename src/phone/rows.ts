/**
 * The rows of the phone column of steps (02-ui-ux.yaml phone_steps): pure functions of the
 * scenario as played, so the rows are tested without a browser. Overview: the stages; Architecture:
 * one row per group of consecutive phase events; Protocol: one row per event.
 */
import { groupRuns, operationLabel } from '../diagram/model.ts';
import { partiesOf, stageSpans } from '../diagram/zoom.ts';
import type { Scenario, ScenarioEvent } from '../scenarios/types.ts';

/** Sent to another participant, answered by it, or computed inside one participant. */
export type Direction = 'request' | 'response' | 'local';

/** The direction glyph of a row (02 phone_steps.rows.glyph). */
export const GLYPHS: Readonly<Record<Direction, string>> = {
  request: '→',
  response: '←',
  local: '±',
};

/** What assistive technology hears in place of the glyph. */
export const DIRECTION_WORDS: Readonly<Record<Direction, string>> = {
  request: 'request',
  response: 'response',
  local: 'nothing sent',
};

/**
 * The row's direction, from the diagram's encoding: a computation inside one participant sends
 * nothing; otherwise responses and results (the open arrowhead) answer, the rest is sent.
 */
export function direction(
  e: Pick<ScenarioEvent, 'sender' | 'receiver' | 'message_type'>,
): Direction {
  if (e.sender === e.receiver) return 'local';
  return e.message_type === 'RESPONSE' || e.message_type === 'RESULT' ? 'response' : 'request';
}

/** "Agent → MCP server", or "Agent · nothing sent" for a computation inside the agent. */
export function participantsLine(
  e: Pick<ScenarioEvent, 'sender' | 'receiver'>,
  labels: Readonly<Record<string, string>>,
): string {
  const from = labels[e.sender] ?? e.sender;
  if (e.sender === e.receiver) return `${from} · ${DIRECTION_WORDS.local}`;
  return `${from} → ${labels[e.receiver] ?? e.receiver}`;
}

/** A Protocol row: one played event. */
export interface EventRow {
  /** The event's ID, which keeps the row open across a parameter change. */
  key: string;
  /** 0-based index among the played events. */
  index: number;
  /** 1-based step number, the cursor at this event. */
  step: number;
  event: ScenarioEvent;
  direction: Direction;
  label: string;
  participants: string;
}

/** An Architecture row: a consecutive run of one phase's events. */
export interface GroupRow {
  key: string;
  /** The takeaway, or for a continued run the phase label and "continued". */
  title: string;
  /** The phase label and the number of steps; only the number for a continued run. */
  caption: string;
  events: EventRow[];
}

/** An Overview stage: its sentence and the parties its events involve. */
export interface StageItem {
  key: string;
  /** 1-based. */
  number: number;
  sentence: string;
  parties: string;
  /** Cursor of the stage's first and last played event; 0 when it has none. */
  first: number;
  last: number;
}

export function eventRow(
  event: ScenarioEvent,
  index: number,
  labels: Readonly<Record<string, string>>,
): EventRow {
  return {
    key: event.id,
    index,
    step: index + 1,
    event,
    direction: direction(event),
    label: operationLabel(event),
    participants: participantsLine(event, labels),
  };
}

/** One row per played event. */
export function eventRows(
  events: readonly ScenarioEvent[],
  labels: Readonly<Record<string, string>>,
): EventRow[] {
  return events.map((e, i) => eventRow(e, i, labels));
}

/** One row per group of 02 zoom_levels.architecture_groups, over the events as played. */
export function groupRows(
  scenario: Scenario,
  events: readonly ScenarioEvent[],
  labels: Readonly<Record<string, string>>,
): GroupRow[] {
  return groupRuns({ ...scenario, events: [...events] }).map((run) => {
    const steps = run.members.length === 1 ? '1 step' : `${run.members.length} steps`;
    const name = run.continued ? `${run.phase.label}, continued` : run.phase.label;
    return {
      key: run.key,
      title: run.continued ? name : run.phase.takeaway,
      caption: run.continued ? steps : `${name} · ${steps}`,
      events: run.members.map(([e, i]) => eventRow(e, i, labels)),
    };
  });
}

/** The stages of the Overview with the parties their events involve, by party label. */
export function stageItems(scenario: Scenario, events: readonly ScenarioEvent[]): StageItem[] {
  const { overview } = scenario;
  const labels = new Map(overview.parties.map((p) => [p.id, p.label]));
  return stageSpans(overview, events).map((span) => {
    const own = span.first ? events.slice(span.first - 1, span.last) : [];
    return {
      key: span.stage.id,
      number: span.index + 1,
      sentence: span.stage.sentence,
      parties: partiesOf(overview, own)
        .map((p) => labels.get(p) ?? p)
        .join(' · '),
      first: span.first,
      last: span.last,
    };
  });
}

/** The row holding the step at `cursor` (1-based) at Architecture, if any. */
export function groupAt(groups: readonly GroupRow[], cursor: number): GroupRow | undefined {
  return groups.find((g) => g.events.some((r) => r.step === cursor));
}

/** One side of Compare on a phone. */
export interface CompareSide {
  /** RAG or MCP. */
  label: string;
  scenario: Scenario;
  events: readonly ScenarioEvent[];
  /** Scenario phase ID → semantic phase ID (06 compare.phase_mapping). */
  semanticOf: Readonly<Record<string, string>>;
  /** 06 compare.placeholders for this scenario. */
  placeholders: Readonly<Record<string, string>>;
}

/** What one side shows in a semantic phase: its units, or its placeholder when it has none. */
export type CompareEntry<T> =
  { side: 0 | 1; kind: 'unit'; unit: T } | { side: 0 | 1; kind: 'placeholder'; text: string };

export interface ComparePhase<T> {
  id: string;
  label: string;
  entries: CompareEntry<T>[];
}

/**
 * Compare as one column interleaved by semantic phase (02 phone_steps.compare): each semantic
 * phase lists the units of the left side, then those of the right. A side without events in the
 * phase shows its placeholder; a unit belongs to the semantic phase of its first event. Phases
 * with nothing to show are left out.
 */
export function compareColumn<T>(
  phases: readonly { id: string; label: string }[],
  sides: readonly [CompareSide, CompareSide],
  units: (side: CompareSide) => readonly { unit: T; firstEvent: ScenarioEvent | undefined }[],
): ComparePhase<T>[] {
  const semantic = (side: CompareSide, e: ScenarioEvent | undefined): string | undefined =>
    e ? side.semanticOf[e.phase] : undefined;
  const listed = sides.map((side) => units(side));
  return phases
    .map((phase) => {
      const entries: CompareEntry<T>[] = [];
      sides.forEach((side, i) => {
        const s = i as 0 | 1;
        const own = (listed[i] ?? []).filter((u) => semantic(side, u.firstEvent) === phase.id);
        const any = side.events.some((e) => side.semanticOf[e.phase] === phase.id);
        if (own.length) for (const u of own) entries.push({ side: s, kind: 'unit', unit: u.unit });
        else if (!any) {
          const text = side.placeholders[phase.id] ?? `No step in ${phase.label}.`;
          entries.push({ side: s, kind: 'placeholder', text });
        }
      });
      return { id: phase.id, label: phase.label, entries };
    })
    .filter((p) => p.entries.some((e) => e.kind === 'unit'));
}
