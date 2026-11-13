/**
 * The Compare view (02-ui-ux.yaml compare_view): rag-query and mcp-balance side by side,
 * stepped in sync by semantic phase with one set of shared controls, then one sentence per
 * comparison aspect.
 */
import { type Clock, Player, type Speed, STEP_INTERVAL_MS } from '../engine/player.ts';
import { ControlRow } from '../app/controls.ts';
import { DiagramView } from '../diagram/view.ts';
import { operationLabel } from '../diagram/model.ts';
import {
  type Level,
  stageAt,
  stageSpans,
  stageStops,
  type StageSpan,
  zoomCursor,
  zoomed,
} from '../diagram/zoom.ts';
import { levelSuffix } from '../app/routes.ts';
import { createPlayback } from '../rag/bundled.ts';
import type { Compare, Scenario } from '../scenarios/types.ts';
import {
  type CompareStep,
  CompareTimeline,
  type PaneAt,
  type PaneInput,
  stageInput,
} from './timeline.ts';
import '../styles/compare.css';

/** One side of the comparison. */
export interface PaneSpec {
  scenario: Scenario;
  /** The tab label that heads the pane and names it (RAG, MCP). */
  label: string;
  /** The tab whose route opens the scenario for inspection. */
  tab: string;
}

export interface CompareOptions {
  compare: Compare;
  /** 06 semantic_phases, in order. */
  phases: readonly { id: string; label: string }[];
  panes: readonly [PaneSpec, PaneSpec];
  labels: Readonly<Record<string, string>>;
  /** Short participant labels, for the arrows' names (02 diagram.visibility.accessible_name). */
  shortLabels?: Readonly<Record<string, string>>;
  step: number;
  level: Level;
  /** Called after every change of position or level, to write the address. */
  onChange: (step: number, level: Level) => void;
  clock?: Clock;
}

const browserClock: Clock = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

interface Pane {
  spec: PaneSpec;
  player: Player;
  /** The stages with the spans of their events; Compare plays the defaults, so they are fixed. */
  spans: StageSpan[];
  /** Where the pane rests at the Overview: 0 and the end of each stage. */
  stops: number[];
  view: DiagramView;
  slider: HTMLInputElement;
  position: HTMLElement;
  message: HTMLElement;
  inspect: HTMLAnchorElement;
  root: HTMLElement;
}

export class CompareView {
  /** The timeline of events, for Architecture and Protocol. */
  private readonly events: CompareTimeline;
  /** The timeline of stages, for the Overview (02 compare_view.timeline). */
  private readonly stages: CompareTimeline;
  /** The shared control row. */
  readonly controls: ControlRow;
  private readonly options: CompareOptions;
  private readonly clock: Clock;
  private readonly panes: readonly [Pane, Pane];
  private readonly phaseLabels: ReadonlyMap<string, string>;
  private readonly phaseItems = new Map<string, HTMLElement>();
  private readonly announcer: HTMLElement;
  private position: number;
  private level: Level;
  private playing = false;
  private rate: Speed = 1;
  private timer: unknown;
  /**
   * The position last announced, so a change of level, a repeated render or a pause where the
   * position was already announced stays quiet.
   */
  private announced: number;
  /** The heading: the headline, or at the Overview the plain one (02 compare_view.layout). */
  private readonly heading: HTMLElement;
  /** Where RAG and MCP differ; shown from Architecture on. */
  private readonly aspects: HTMLElement;

  constructor(root: HTMLElement, options: CompareOptions) {
    this.options = options;
    this.clock = options.clock ?? browserClock;
    this.level = options.level;
    const { compare, phases, panes } = options;
    this.phaseLabels = new Map(phases.map((p) => [p.id, p.label]));
    this.panes = [this.pane(panes[0], 0), this.pane(panes[1], 1)];
    const ids = phases.map((p) => p.id);
    const inputs = [this.input(this.panes[0]), this.input(this.panes[1])] as const;
    this.events = new CompareTimeline(ids, inputs);
    this.stages = new CompareTimeline(ids, [
      stageInput(inputs[0], this.panes[0].spans),
      stageInput(inputs[1], this.panes[1].spans),
    ]);
    this.position = this.fromAddress(options.step);
    this.announced = this.position;

    // The shared control row (02 compare_view.controls, controls.row).
    this.controls = new ControlRow({
      name: 'Playback of both panes',
      sliderName: 'Compare step',
      statusClass: 'compare-status',
      reset: () => this.reset(),
      previous: () => this.previous(),
      toggle: () => this.toggle(),
      next: () => this.next(),
      speed: (speed) => this.setSpeed(speed),
      jump: (step) => this.navigate(step),
      zoom: (level) => this.setLevel(level),
    });
    const steps = this.events.length;
    const ranges = phases.flatMap((a, i) =>
      phases.slice(i + 1).map((b) => `Stage ${steps} of ${steps} · ${a.label} to ${b.label}`),
    );
    this.controls.reserve([
      ...phases.map((p) => `Step ${steps} of ${steps} · ${p.label}`),
      ...ranges,
    ]);
    for (const pane of this.panes) pane.view.setLevel(this.level);
    const phaseList = el('ol', { class: 'compare-phases small', 'aria-label': 'Semantic phases' });
    for (const phase of phases) {
      const item = el('li', {}, phase.label);
      this.phaseItems.set(phase.id, item);
      phaseList.append(item);
    }
    this.announcer = el('div', { class: 'visually-hidden', 'aria-live': 'polite' });
    // The semantic phase labels below the control row (02 compare_view.phase_line).
    const phaseLine = el('div', { class: 'compare-phase-line' }, phaseList, this.announcer);

    this.aspects = el(
      'section',
      { class: 'compare-aspects', 'aria-labelledby': 'compare-aspects-title' },
      el('h3', { id: 'compare-aspects-title' }, 'Where RAG and MCP differ'),
      el(
        'dl',
        {},
        ...(compare.aspects ?? []).flatMap((a) => [
          el('dt', { class: 'small muted' }, a.label),
          el('dd', {}, a.sentence),
        ]),
      ),
    );

    this.heading = el('h2', { tabindex: '-1' });
    root.replaceChildren(
      el('section', { class: 'lesson' }, this.heading),
      this.controls.root,
      phaseLine,
      el('div', { class: 'compare-panes' }, ...this.panes.map((p) => p.root)),
      this.aspects,
    );
    this.render();
  }

  get step(): number {
    return this.position;
  }

  /** The shared timeline at the current level. */
  get timeline(): CompareTimeline {
    return this.level === 'overview' ? this.stages : this.events;
  }

  /** Follows a step and level read from the address. */
  follow(step: number, level: Level): void {
    this.level = level;
    for (const pane of this.panes) pane.view.setLevel(level);
    this.position = this.fromAddress(step);
    this.render();
  }

  /**
   * The pane whose place zooming keeps (02 compare_view.defaults): one that steps in the current
   * phase, the left first, else one that is done with it; undefined before the first step.
   */
  private leading(step: CompareStep): 0 | 1 | undefined {
    for (const status of ['stepping', 'done'] as const) {
      const side = step.panes.findIndex((p) => p.status === status);
      if (side === 0 || side === 1) return side;
    }
    return undefined;
  }

  /**
   * The position for a compare step read from the address, which counts the timeline of events
   * at every level (02 compare_view.route): at the Overview, the stage holding the leading
   * pane's event there.
   */
  private fromAddress(step: number): number {
    const at = this.events.at(step);
    if (this.level !== 'overview') return this.events.clamp(step);
    const side = this.leading(at);
    if (side === undefined) return 0;
    const pane = this.panes[side];
    const end = zoomCursor(pane.spans, at.panes[side].cursor, 'architecture', 'overview');
    return this.stages.stepOf(side, pane.stops.indexOf(end));
  }

  /**
   * The compare step the address holds: at the Overview the first step of events at which the
   * leading pane is at the end of its current stage.
   */
  private addressStep(): number {
    if (this.level !== 'overview') return this.position;
    const at = this.stages.at(this.position);
    const side = this.leading(at);
    if (side === undefined) return 0;
    const pane = this.panes[side];
    return this.events.stepOf(side, pane.stops[at.panes[side].cursor] ?? 0);
  }

  /**
   * The semantic phases a compare step covers (02 compare_view.timeline): its phase, and at the
   * Overview every semantic phase of the stages its panes are at, from the first to the last.
   */
  private covered(step: CompareStep): string[] {
    if (step.phase === undefined) return [];
    if (this.level !== 'overview') return [step.phase];
    const order = this.options.phases.map((p) => p.id);
    const indices = [order.indexOf(step.phase)];
    step.panes.forEach((at, side) => {
      if (at.status !== 'stepping' && at.status !== 'done') return;
      const pane = this.panes[side as 0 | 1];
      const stage = stageAt(pane.spans, this.cursorOf(pane, 'overview', at.cursor));
      const mapping = this.options.compare.phase_mapping[pane.spec.scenario.id] ?? {};
      for (const phase of stage?.stage.phases ?? [])
        indices.push(order.indexOf(mapping[phase] ?? ''));
    });
    const valid = indices.filter((i) => i >= 0);
    return order.slice(Math.min(...valid), Math.max(...valid) + 1);
  }

  /** Zooms in (+1) or out (-1) from the current level, if there is a level there. */
  zoomBy(direction: 1 | -1): void {
    const level = zoomed(this.level, direction);
    if (level) this.setLevel(level);
  }

  next(): void {
    this.navigate(this.position + 1);
  }

  previous(): void {
    this.navigate(this.position - 1);
  }

  /** Moves one pane to its own step; the other follows to the same phase. */
  stepPane(side: 0 | 1, cursor: number): void {
    this.navigate(this.timeline.stepOf(side, cursor));
  }

  /** Return to the initial state before any step and pause (02 controls.action_rules). */
  reset(): void {
    this.stop();
    this.position = 0;
    this.render();
  }

  toggle(): void {
    if (this.playing) {
      this.stop();
    } else if (this.position < this.timeline.length) {
      this.playing = true;
      this.schedule();
    }
    this.render();
  }

  setSpeed(speed: Speed): void {
    this.rate = speed;
    if (this.playing) this.schedule();
    this.render();
  }

  /**
   * Changes the zoom level of both panes, keeping the place of the first pane with a step in the
   * current semantic phase; the other follows to the same phase (02 compare_view.defaults).
   */
  setLevel(level: Level): void {
    if (level === this.level) return;
    const from = this.level;
    const step = this.timeline.at(this.position);
    const side = this.leading(step);
    this.level = level;
    for (const pane of this.panes) pane.view.setLevel(level);
    if (side !== undefined) {
      const pane = this.panes[side];
      const cursor = zoomCursor(
        pane.spans,
        this.cursorOf(pane, from, step.panes[side].cursor),
        from,
        level,
      );
      // On the stage timeline a pane's cursor counts stages.
      const at = level === 'overview' ? pane.stops.indexOf(cursor) : cursor;
      this.position = this.timeline.stepOf(side, at);
    } else this.position = 0;
    if (this.playing) {
      if (this.position >= this.timeline.length) this.stop();
      else this.schedule();
    }
    // The control row announces the change of level; the phase line stays quiet.
    this.announced = this.position;
    this.render();
    const where = this.controls.status.textContent ?? '';
    this.controls.announce(level, where);
  }

  /** A pane's event cursor for its position on the timeline of `level`. */
  private cursorOf(pane: Pane, level: Level, at: number): number {
    return level === 'overview' ? (pane.stops[at] ?? 0) : at;
  }

  dispose(): void {
    this.stop();
    for (const pane of this.panes) {
      pane.view.destroy();
      pane.player.dispose();
    }
  }

  /** Manual navigation keeps playback running and restarts the interval. */
  private navigate(step: number): void {
    const target = this.timeline.clamp(step);
    if (target === this.position) return;
    this.position = target;
    if (this.playing) {
      if (this.position >= this.timeline.length) this.stop();
      else this.schedule();
    }
    this.render();
  }

  private schedule(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      if (!this.playing) return;
      this.position = this.timeline.clamp(this.position + 1);
      if (this.position >= this.timeline.length) this.stop();
      else this.schedule();
      this.render();
    }, STEP_INTERVAL_MS / this.rate);
  }

  private stop(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.playing = false;
  }

  private input(pane: Pane): PaneInput {
    return {
      events: pane.player.playback.events,
      semanticOf: this.options.compare.phase_mapping[pane.spec.scenario.id] ?? {},
    };
  }

  private pane(spec: PaneSpec, side: 0 | 1): Pane {
    const { scenario, label } = spec;
    const player = new Player(createPlayback(scenario));
    const spans = stageSpans(scenario.overview, player.playback.events);
    const slider = el('input', {
      type: 'range',
      min: '0',
      max: String(player.playback.length),
      step: '1',
      'aria-label': `${label} step`,
    });
    slider.addEventListener('input', () => this.stepPane(side, Number(slider.value)));
    const position = el('p', { class: 'small muted' });
    const message = el('div', { class: 'compare-message' });
    const inspect = el('a', { class: 'small' });
    const diagram = el('div', { class: 'diagram-pane', role: 'region' });
    const view = new DiagramView(diagram, player, {
      labels: this.options.labels,
      ...(this.options.shortLabels ? { shortLabels: this.options.shortLabels } : {}),
      level: this.level,
      name: `${label} sequence diagram`,
      id: `compare-${side === 0 ? 'left' : 'right'}`,
      // An arrow steps its pane as the pane's own slider does (02 diagram.arrow_activation).
      jump: (cursor) => this.stepPane(side, cursor),
    });
    const root = el(
      'section',
      { class: 'compare-pane', role: 'region', 'aria-label': label },
      el('h3', {}, label),
      el('p', { class: 'compare-question' }, scenario.question ?? scenario.learning_question),
      el('div', { class: 'compare-position' }, position, slider),
      message,
      diagram,
      el('p', {}, inspect),
    );
    const stops = stageStops(spans);
    return { spec, player, spans, stops, view, slider, position, message, inspect, root };
  }

  private phaseLabel(id: string | undefined): string {
    return id === undefined ? '' : (this.phaseLabels.get(id) ?? id);
  }

  /**
   * The pane's position line, e.g. "Step 6 of 10 · Search and filter". A waiting pane names
   * no step of an earlier phase: "No step in Preparation · 0 of 10 played".
   */
  private paneWhere(pane: Pane, at: PaneAt, semantic: string | undefined): string {
    const { player, spec } = pane;
    const k = player.cursor;
    if (this.level === 'overview') {
      const m = pane.stops.length - 1;
      return at.status === 'placeholder'
        ? `No stage in ${this.phaseLabel(semantic)} · ${at.cursor} of ${m} played`
        : `Stage ${at.cursor} of ${m}`;
    }
    if (at.status === 'placeholder') {
      return `No step in ${this.phaseLabel(semantic)} · ${k} of ${player.playback.length} played`;
    }
    const event = player.playback.event(k);
    const phase = event ? spec.scenario.phases.find((p) => p.id === event.phase) : undefined;
    const n = player.playback.length;
    return phase ? `Step ${k} of ${n} · ${phase.label}` : `Step ${k} of ${n}`;
  }

  /** What a pane without events in the phase shows (06 compare.placeholders). */
  private placeholder(scenario: string, phase: string | undefined): string {
    return (
      this.options.compare.placeholders?.[scenario]?.[phase ?? ''] ??
      `No step in ${this.phaseLabel(phase)}.`
    );
  }

  private paneMessage(pane: Pane, at: PaneAt, other: Pane, phase: string | undefined): Node[] {
    const { scenario } = pane.spec;
    if (at.status === 'start') {
      return [el('p', { class: 'message' }, 'Nothing has happened yet.')];
    }
    if (at.status === 'placeholder') {
      return [el('p', { class: 'message' }, this.placeholder(scenario.id, phase))];
    }
    const cursor = pane.player.cursor;
    const event = pane.player.playback.event(cursor);
    if (!event) return [];
    const done =
      at.status === 'done'
        ? [
            el(
              'p',
              { class: 'small compare-done' },
              `Done with ${this.phaseLabel(phase).toLowerCase()}; ${other.spec.label} continues.`,
            ),
          ]
        : [];
    // The Overview names the stage, not the event (02 compare_view.pane).
    if (this.level === 'overview') {
      const stage = stageAt(pane.spans, cursor);
      return [...done, el('p', { class: 'message' }, stage?.stage.sentence ?? '')];
    }
    const labels = this.options.labels;
    const from = labels[event.sender] ?? event.sender;
    const to = labels[event.receiver] ?? event.receiver;
    return [
      ...done,
      el('p', { class: 'message' }, event.explanation),
      el('p', { class: 'small muted' }, `${from} → ${to} · ${operationLabel(event)}`),
    ];
  }

  private render(): void {
    const step = this.timeline.at(this.position);
    const overview = this.level === 'overview';
    const covered = this.covered(step);
    const first = this.phaseLabel(covered[0]);
    const last = this.phaseLabel(covered[covered.length - 1]);
    const phase = covered.length > 1 ? `${first} to ${last}` : first;
    const unit = overview ? 'Stage' : 'Step';
    const where = phase
      ? `${unit} ${this.position} of ${this.timeline.length} · ${phase}`
      : `${unit} ${this.position} of ${this.timeline.length}`;
    // At the Overview a plain heading, and the aspects, which name the protocols, from
    // Architecture on (02 compare_view.layout).
    const { compare } = this.options;
    const heading = overview ? String(compare['overview_headline'] ?? '') : compare.headline;
    if (this.heading.textContent !== heading) this.heading.textContent = heading;
    this.aspects.hidden = overview;
    this.controls.update({
      step: this.position,
      length: this.timeline.length,
      where,
      playing: this.playing,
      speed: this.rate,
    });
    for (const [id, item] of this.phaseItems) {
      if (covered.includes(id)) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    }
    this.controls.setLevel(this.level);
    const announcements: string[] = [];
    for (const side of [0, 1] as const) {
      const pane = this.panes[side];
      const at = step.panes[side];
      const cursor = this.cursorOf(pane, this.level, at.cursor);
      pane.view.setHeld(at.status === 'placeholder');
      pane.player.jump(cursor);
      const paneWhere = this.paneWhere(pane, at, step.phase);
      pane.position.textContent = paneWhere;
      // At the Overview a pane's slider runs over its stages.
      pane.slider.max = String(
        this.level === 'overview' ? pane.stops.length - 1 : pane.player.playback.length,
      );
      pane.slider.value = String(at.cursor);
      pane.slider.setAttribute('aria-valuetext', paneWhere);
      pane.root.dataset['status'] = at.status;
      const other = this.panes[side === 0 ? 1 : 0];
      pane.message.replaceChildren(...this.paneMessage(pane, at, other, step.phase));
      const route = `#/${pane.spec.tab}/${pane.spec.scenario.id}/${cursor}${levelSuffix(this.level)}`;
      pane.inspect.href = route;
      // The Overview shows no step numbers (02 compare_view.pane).
      pane.inspect.textContent = overview
        ? `Inspect in ${pane.spec.label}`
        : `Inspect step ${cursor} in ${pane.spec.label}`;
      const n = overview ? pane.stops.length - 1 : pane.player.playback.length;
      announcements.push(
        at.status === 'placeholder'
          ? `${pane.spec.label}: ${this.placeholder(pane.spec.scenario.id, step.phase)}`
          : `${pane.spec.label} ${overview ? 'stage' : 'step'} ${at.cursor} of ${n}${at.status === 'done' ? ', done with this phase' : ''}.`,
      );
    }
    // Quiet while playing; the position is announced once playback pauses or ends, and after
    // each manual step while paused (02 compare_view.accessibility).
    if (!this.playing && this.announced !== this.position) {
      this.announced = this.position;
      this.announcer.textContent = [
        phase ? `${phase}.` : 'Before the first step.',
        ...announcements,
      ].join(' ');
    }
    this.options.onChange(this.addressStep(), this.level);
  }
}
