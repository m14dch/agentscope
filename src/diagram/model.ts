/**
 * Sequence diagram model (02-ui-ux.yaml diagram and zoom_levels): arrow labels and geometry as
 * pure functions of the scenario, the zoom level, the cursor and the expanded groups.
 */
import type { Phase, Scenario, ScenarioEvent, Stage } from '../scenarios/types.ts';
import { type Level, partiesOf, stageAt, stageSpans } from './zoom.ts';

export type { Level } from './zoom.ts';
export type LineKind = 'network' | 'in-process' | 'simulated';
export type Visibility = 'past' | 'current' | 'future';

const PREFIX: Partial<Record<ScenarioEvent['protocol'], string>> = {
  MCP: 'MCP',
  HTTP: 'HTTP',
  LLM_API: 'LLM API',
  DB: 'DB',
};

/** The arrow's direct text label: the operation, prefixed with its protocol (02 diagram.labels). */
export function operationLabel(e: Pick<ScenarioEvent, 'protocol' | 'operation'>): string {
  const prefix = PREFIX[e.protocol];
  return prefix && !e.operation.startsWith(prefix) ? `${prefix} · ${e.operation}` : e.operation;
}

export function lineKind(e: ScenarioEvent): LineKind {
  if (e.execution_type === 'NETWORK') return 'network';
  return e.execution_type === 'IN_PROCESS' ? 'in-process' : 'simulated';
}

/** Whether event `index` (0-based) is before, at or after the cursor. */
export function visibility(index: number, cursor: number): Visibility {
  if (index + 1 < cursor) return 'past';
  return index + 1 === cursor ? 'current' : 'future';
}

// Geometry. Text widths are estimated conservatively so labels never collide.
export const SIZES = {
  fontSize: 13,
  charWidth: 7.4, // upper bound for Inter at 13 px, weight 600
  minSpacing: 110,
  maxSpacing: 240,
  margin: 16,
  headerLine: 16,
  headerGap: 16,
  row: 36,
  labelGap: 6,
  headRoom: 18,
  selfWidth: 28,
  selfHeight: 12,
  groupPad: 10,
  groupGap: 8,
  groupMinText: 320,
  /** The Overview: text size 16/24 for the stage sentences, wider gaps between parties. */
  stageFont: 16,
  stageLine: 24,
  stageGap: 16,
  partySpacing: 200,
  /** The widest gap between parties when they spread across the region. */
  partySpacingMax: 360,
  stageMinText: 360,
} as const;

/** Width of a text at 13 px in px; `strong` for weight 600. */
export type Measure = (text: string, strong?: boolean) => number;

/** Conservative estimate, used when the browser cannot measure (tests, before fonts load). */
export const estimate: Measure = (text) => Math.ceil(text.length * SIZES.charWidth);

/** Splits text into lines no wider than `width`, breaking at spaces. */
export function wrap(text: string, width: number, measure: Measure = estimate): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export interface Lifeline {
  id: string;
  x: number;
  lines: string[];
}

export interface Arrow {
  index: number;
  event: ScenarioEvent;
  y: number;
  x1: number;
  x2: number;
  self: boolean;
  label: string;
  labelX: number;
  labelY: number;
  line: LineKind;
  visibility: Visibility;
  /** Current step or its pair. */
  emphasized: boolean;
  /** Carries the selected lineage value (02 lineage_selection.diagram). */
  selected: boolean;
  /** Measured label width, for the selection mark behind it. */
  labelWidth: number;
}

export interface Group {
  /** Unique within the layout: the phase ID, then #2, #3 for runs where the phase resumes. */
  key: string;
  phase: Phase;
  /** True for a run where the phase resumes after another phase. */
  continued: boolean;
  /** The takeaway wrapped to the group's width; empty for a continued run. */
  takeaway: string[];
  /** Disclosure marker, phase label and step count. */
  caption: string;
  y: number;
  height: number;
  x1: number;
  x2: number;
  expanded: boolean;
  current: boolean;
  /** Arrows shown inside the group when expanded (events up to the cursor). */
  arrows: Arrow[];
  /** A reached member carries the selected lineage value. */
  selected: boolean;
  /** Measured caption width, for the selection mark behind it. */
  captionWidth: number;
  /** Width of the widest line of the takeaway and caption, for the paper behind them. */
  textWidth: number;
}

/** A stage of the Overview (02 zoom_levels.overview): a block holding its sentence. */
export interface StageBlock {
  stage: Stage;
  /** 1-based position among the stages. */
  number: number;
  /** The sentence wrapped to the block's width. */
  sentence: string[];
  /** Labels of the parties its events touch, in order. */
  parties: string[];
  y: number;
  height: number;
  x1: number;
  x2: number;
  current: boolean;
  /** Width of the widest line of the sentence, for the paper behind it. */
  textWidth: number;
}

export interface DiagramLayout {
  width: number;
  height: number;
  top: number;
  /** Participants, or at the Overview the parties. */
  lifelines: Lifeline[];
  /** Protocol: every event up to the cursor. Otherwise empty. */
  arrows: Arrow[];
  /** Architecture only. */
  groups: Group[];
  /** Overview only. */
  stages: StageBlock[];
}

export interface LayoutInput {
  scenario: Scenario;
  labels: Readonly<Record<string, string>>;
  level: Level;
  /** Text measurement; defaults to a conservative estimate. */
  measure?: Measure;
  /** Indices of events whose tracked values include the selected lineage value. */
  selected?: ReadonlySet<number>;
  /** 0 to events.length (03 state_model.cursor). */
  cursor: number;
  expanded: ReadonlySet<string>;
  /**
   * Shows the events up to the cursor as past, with no current step or group: a Compare pane
   * waiting through a phase it has no events in (02 compare_view.timeline).
   */
  held?: boolean;
  /** The diagram region's width; the Overview spreads its parties across it. */
  available?: number;
}

/** Lifeline x positions: each gap is as wide as the labels of arrows that span only it. */
function lifelines(
  scenario: Scenario,
  labels: Readonly<Record<string, string>>,
  measure: Measure,
): Lifeline[] {
  const ids = scenario.participants;
  const gaps = ids.slice(1).map(() => SIZES.minSpacing as number);
  const col = new Map(ids.map((id, i) => [id, i]));
  for (const e of scenario.events) {
    const a = col.get(e.sender) ?? 0;
    const b = col.get(e.receiver) ?? 0;
    if (Math.abs(a - b) !== 1) continue;
    const need = measure(operationLabel(e), true) + 2 * SIZES.labelGap;
    const gap = Math.min(a, b);
    gaps[gap] = Math.min(SIZES.maxSpacing, Math.max(gaps[gap] ?? 0, need));
  }
  let x = SIZES.margin + SIZES.minSpacing / 2;
  return ids.map((id, i) => {
    if (i > 0) x += gaps[i - 1] ?? SIZES.minSpacing;
    const width = Math.min(gaps[i - 1] ?? SIZES.minSpacing, gaps[i] ?? SIZES.minSpacing) - 8;
    return { id, x, lines: wrap(labels[id] ?? id, width, (t) => measure(t, true)) };
  });
}

function pairOf(scenario: Scenario, cursor: number): number {
  const current = scenario.events[cursor - 1];
  if (!current?.pair_id) return -1;
  return scenario.events.findIndex((e) => e.id === current.pair_id);
}

export interface GroupRun {
  /** The phase ID, then "#2", "#3" … for each later run of the same phase. */
  key: string;
  phase: Phase;
  continued: boolean;
  /** The run's events with their indices in the scenario. */
  members: [ScenarioEvent, number][];
}

/** One group per consecutive run of a phase's events (02 zoom_levels.architecture_groups). */
export function groupRuns(scenario: Scenario): GroupRun[] {
  const phases = new Map(scenario.phases.map((p) => [p.id, p]));
  const runs: { phase: Phase; members: [ScenarioEvent, number][] }[] = [];
  scenario.events.forEach((e, i) => {
    const last = runs[runs.length - 1];
    if (last && last.phase.id === e.phase) last.members.push([e, i]);
    else {
      const phase = phases.get(e.phase);
      if (phase) runs.push({ phase, members: [[e, i]] });
    }
  });
  const seen = new Map<string, number>();
  return runs.map(({ phase, members }) => {
    const n = (seen.get(phase.id) ?? 0) + 1;
    seen.set(phase.id, n);
    return { key: n === 1 ? phase.id : `${phase.id}#${n}`, phase, continued: n > 1, members };
  });
}

/** Key of the group holding the step at the cursor; undefined at step 0. */
export function currentGroupKey(scenario: Scenario, cursor: number): string | undefined {
  if (cursor < 1) return undefined;
  return groupRuns(scenario).find((r) => r.members.some(([, i]) => i === cursor - 1))?.key;
}

/** Sentence width at the Overview's text size, from a measure at 13 px. */
function stageMeasure(measure: Measure): Measure {
  return (text, strong) => Math.ceil((measure(text, strong) * SIZES.stageFont) / SIZES.fontSize);
}

/**
 * The Overview (02 zoom_levels.overview): one lifeline per party, then one block per stage that
 * spans the parties its events touch and holds its sentence; the current stage is marked.
 */
function overviewLayout(input: LayoutInput, measure: Measure): DiagramLayout {
  const { scenario, cursor } = input;
  const { overview } = scenario;
  const big = stageMeasure(measure);
  // The parties spread across the region, from 200 px to 360 px apart (02 zoom_levels.overview).
  const n = overview.parties.length;
  const room = (input.available ?? 0) - 2 * SIZES.margin - SIZES.minSpacing;
  const gap =
    n > 1
      ? Math.max(SIZES.partySpacing, Math.min(SIZES.partySpacingMax, Math.floor(room / (n - 1))))
      : SIZES.partySpacing;
  let x = SIZES.margin + SIZES.minSpacing / 2;
  const lines: Lifeline[] = overview.parties.map((party, i) => {
    if (i > 0) x += gap;
    return {
      id: party.id,
      x,
      lines: wrap(party.label, gap - 8, (t) => measure(t, true)),
    };
  });
  const at = new Map(lines.map((l) => [l.id, l.x]));
  const labels = new Map(overview.parties.map((p) => [p.id, p.label]));
  const headerLines = Math.max(1, ...lines.map((l) => l.lines.length));
  const top = SIZES.margin + headerLines * SIZES.headerLine + SIZES.headerGap;
  const spans = stageSpans(overview, scenario.events);
  const current = input.held ? undefined : stageAt(spans, cursor)?.index;
  let right = Math.max(...lines.map((l) => l.x)) + SIZES.minSpacing / 2;
  let y = top;
  const stages = spans.map((span): StageBlock => {
    const events = span.first ? scenario.events.slice(span.first - 1, span.last) : [];
    const touched = partiesOf(overview, events);
    const xs = (touched.length ? touched : overview.parties.map((p) => p.id)).map(
      (id) => at.get(id) ?? 0,
    );
    const left = Math.min(...xs) - SIZES.minSpacing / 2 + 8;
    const spanRight = Math.max(...xs) + SIZES.minSpacing / 2 - 8;
    const isCurrent = span.index === current;
    const textX = left + 2 * SIZES.groupPad;
    const strong = (t: string): number => big(t, isCurrent);
    const sentence = wrap(
      span.stage.sentence,
      Math.max(SIZES.stageMinText, spanRight - textX - SIZES.groupPad),
      // The layout reserves the bold width, so nothing moves when a stage becomes current.
      (t) => big(t, true),
    );
    const textWidth = Math.max(0, ...sentence.map(strong));
    const start = y + SIZES.stageGap;
    const height = 2 * SIZES.groupPad + sentence.length * SIZES.stageLine;
    const x2 = Math.max(
      spanRight,
      textX + Math.max(...sentence.map((t) => big(t, true))) + SIZES.groupPad,
    );
    right = Math.max(right, x2 + SIZES.margin);
    y = start + height;
    return {
      stage: span.stage,
      number: span.index + 1,
      sentence,
      parties: touched.map((id) => labels.get(id) ?? id),
      y: start,
      height,
      x1: left,
      x2,
      current: isCurrent,
      textWidth,
    };
  });
  return {
    width: Math.ceil(right),
    height: Math.ceil(y + SIZES.row),
    top,
    lifelines: lines,
    arrows: [],
    groups: [],
    stages,
  };
}

export function layout(input: LayoutInput): DiagramLayout {
  const { scenario, level, cursor, expanded } = input;
  const measure = input.measure ?? estimate;
  if (level === 'overview') return overviewLayout(input, measure);
  const lines = lifelines(scenario, input.labels, measure);
  const x = new Map(lines.map((l) => [l.id, l.x]));
  const headerLines = Math.max(1, ...lines.map((l) => l.lines.length));
  const top = SIZES.margin + headerLines * SIZES.headerLine + SIZES.headerGap;
  const pair = input.held ? -1 : pairOf(scenario, cursor);
  let right = Math.max(...lines.map((l) => l.x)) + SIZES.minSpacing / 2;

  const arrow = (e: ScenarioEvent, index: number, y: number): Arrow => {
    const xs = x.get(e.sender) ?? 0;
    const xr = x.get(e.receiver) ?? 0;
    const self = e.sender === e.receiver;
    const label = operationLabel(e);
    // A leftward arrow's head sits at its left end; its label starts past the head.
    const labelX = self
      ? xs + SIZES.selfWidth + SIZES.labelGap
      : xr < xs
        ? xr + SIZES.headRoom
        : xs + SIZES.labelGap;
    // The layout reserves the bold width, so nothing moves when a label becomes current.
    right = Math.max(right, labelX + measure(label, true) + SIZES.margin);
    const shown = visibility(index, cursor);
    const vis = input.held && shown === 'current' ? 'past' : shown;
    const emphasized = vis === 'current' || (index === pair && index < cursor);
    const labelWidth = measure(label, emphasized);
    return {
      index,
      event: e,
      y,
      x1: xs,
      x2: self ? xs : xr,
      self,
      label,
      labelX,
      labelY: self ? y + SIZES.selfHeight / 2 + 4 : y - SIZES.labelGap,
      line: lineKind(e),
      visibility: vis,
      emphasized,
      selected: index < cursor && !!input.selected?.has(index),
      labelWidth,
    };
  };

  const arrows: Arrow[] = [];
  const groups: Group[] = [];
  let y = top;
  if (level === 'protocol') {
    scenario.events.forEach((e, i) => {
      y += SIZES.row;
      if (i < cursor) arrows.push(arrow(e, i, y));
    });
  } else {
    const current = cursor >= 1 && !input.held ? cursor - 1 : -1;
    for (const { key, phase, continued, members } of groupRuns(scenario)) {
      const xs = members.flatMap(([e]) => [x.get(e.sender) ?? 0, x.get(e.receiver) ?? 0]);
      const left = Math.min(...xs) - SIZES.minSpacing / 2 + 8;
      const spanRight = Math.max(...xs) + SIZES.minSpacing / 2 - 8;
      const open = expanded.has(key);
      const isCurrent = members.some(([, i]) => i === current);
      const start = y + SIZES.groupGap;
      const textX = left + 2 * SIZES.groupPad;
      const strong = (t: string): number => measure(t, isCurrent);
      const takeaway = continued
        ? []
        : wrap(
            phase.takeaway,
            Math.max(SIZES.groupMinText, spanRight - textX - SIZES.groupPad),
            strong,
          );
      const steps = members.length === 1 ? '1 step' : `${members.length} steps`;
      const name = continued ? `${phase.label}, continued` : phase.label;
      const caption = `${open ? '▾' : '▸'} ${name} · ${steps}`;
      const header = SIZES.groupPad + (takeaway.length + 1) * SIZES.headerLine + SIZES.groupPad;
      let inner = start + header;
      const shown: Arrow[] = [];
      // Every member's label counts, so the frame keeps its width as the cursor advances.
      let labelsRight = 0;
      if (open) {
        for (const [e, i] of members) {
          inner += SIZES.row;
          const a = arrow(e, i, inner);
          labelsRight = Math.max(labelsRight, a.labelX + measure(a.label, true));
          if (i < cursor) shown.push(a);
        }
        inner += SIZES.row / 2;
      }
      const textWidth = Math.max(0, ...takeaway.map(strong), measure(caption));
      const textRight = Math.max(labelsRight, textX + textWidth);
      right = Math.max(right, textRight + SIZES.margin);
      groups.push({
        key,
        phase,
        continued,
        takeaway,
        caption,
        y: start,
        height: inner - start,
        x1: left,
        x2: Math.max(spanRight, textRight + SIZES.groupPad),
        expanded: open,
        current: isCurrent,
        selected: members.some(([, i]) => i < cursor && !!input.selected?.has(i)),
        captionWidth: measure(caption),
        textWidth,
        arrows: shown,
      });
      y = inner;
    }
  }
  return {
    width: Math.ceil(right),
    height: Math.ceil(y + SIZES.row),
    top,
    lifelines: lines,
    arrows,
    groups,
    stages: [],
  };
}
