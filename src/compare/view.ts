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
import { CompareTimeline, type PaneAt, type PaneInput, stageInput } from './timeline.ts';
import { isPhone, type PageScroll, stepDelta } from '../app/phone.ts';
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
  step: number;
  level: Level;
  /** Called after every change of position or level, to write the address. */
  onChange: (step: number, level: Level) => void;
  clock?: Clock;
  /** Tells the learner's scrolling from the app's jumps (02 layout.phone.stepping_area). */
  pageScroll?: PageScroll;
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
  /** The shared control row, which the shell rearranges on phones (02 layout.phone.controls). */
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
  /** The bottom bar on phones: the shared controls. */
  private readonly bar: HTMLElement;
  /** Each pane's cursor at the last render, to tell which pane's step changed. */
  private cursors: [number, number] | undefined;

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
    this.position = this.timeline.clamp(options.step);
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
      jump: (step) => this.act(() => this.navigate(step)),
      zoom: (level) => this.setLevel(level),
    });
    const steps = this.events.length;
    this.controls.reserve(phases.map((p) => `Step ${steps} of ${steps} · ${p.label}`));
    for (const pane of this.panes) pane.view.setLevel(this.level);
    this.bar = this.controls.buttons;
    const phaseList = el('ol', { class: 'compare-phases small', 'aria-label': 'Semantic phases' });
    for (const phase of phases) {
      const item = el('li', {}, phase.label);
      this.phaseItems.set(phase.id, item);
      phaseList.append(item);
    }
    this.announcer = el('div', { class: 'visually-hidden', 'aria-live': 'polite' });
    // The semantic phase labels below the control row (02 compare_view.phase_line).
    const phaseLine = el('div', { class: 'compare-phase-line' }, phaseList, this.announcer);

    const aspects = el(
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

    root.replaceChildren(
      el('section', { class: 'lesson' }, el('h2', { tabindex: '-1' }, compare.headline)),
      this.controls.root,
      phaseLine,
      el('div', { class: 'compare-panes' }, ...this.panes.map((p) => p.root)),
      aspects,
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
    this.position = this.timeline.clamp(step);
    this.render();
  }

  /** Zooms in (+1) or out (-1) from the current level, if there is a level there. */
  zoomBy(direction: 1 | -1): void {
    const level = zoomed(this.level, direction);
    if (level) this.setLevel(level);
  }

  next(): void {
    this.act(() => this.navigate(this.position + 1));
  }

  previous(): void {
    this.act(() => this.navigate(this.position - 1));
  }

  /** Moves one pane to its own step; the other follows to the same phase. */
  stepPane(side: 0 | 1, cursor: number): void {
    this.act(() => this.navigate(this.timeline.stepOf(side, cursor)));
  }

  /** Return to the initial state before any step and pause (02 controls.action_rules). */
  reset(): void {
    this.act(() => {
      this.stop();
      this.position = 0;
      this.render();
    });
  }

  toggle(): void {
    this.act(() => {
      if (this.playing) {
        this.stop();
      } else if (this.position < this.timeline.length) {
        this.playing = true;
        this.schedule();
      }
      this.render();
    });
  }

  /** Runs an explicit step action of the learner (02 layout.phone.stepping_area). */
  private act(action: () => void): void {
    // The learner's scrolling counts until the next explicit step action.
    this.options.pageScroll?.reset();
    action();
  }

  /**
   * On phones, after a compare step, brings the panes whose step changed on screen above the
   * bar (02 layout.phone.stepping_area): both current rows when they fit together, else the
   * lower changed pane's message and current row.
   */
  private keepInView(changed: readonly Pane[]): void {
    const scroll = this.options.pageScroll;
    if (!scroll || !changed.length || !isPhone()) return;
    const current = (pane: Pane): Element | undefined => {
      const all = pane.root.querySelectorAll('.diagram-pane [data-current]');
      return all[all.length - 1];
    };
    const limit = this.bar.getBoundingClientRect().top;
    const rows = changed.flatMap((p) => {
      const row = current(p);
      return row ? [row.getBoundingClientRect()] : [];
    });
    const last = changed[changed.length - 1] as Pane;
    const lastRow = current(last)?.getBoundingClientRect();
    if (!lastRow) return;
    const both = { top: Math.min(...rows.map((r) => r.top)), bottom: lastRow.bottom };
    const span =
      rows.length > 1 && both.bottom - both.top <= limit - 16
        ? both
        : { top: last.message.getBoundingClientRect().top, bottom: lastRow.bottom };
    const delta = stepDelta(span, limit);
    if (delta) scroll.jumpBy(delta);
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
    this.act(() => {
      const step = this.timeline.at(this.position);
      const side = step.panes.findIndex((p) => p.status === 'stepping' || p.status === 'done');
      this.level = level;
      for (const pane of this.panes) pane.view.setLevel(level);
      if (side === 0 || side === 1) {
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
      this.render();
      const where = this.controls.status.textContent ?? '';
      this.controls.announce(level, where);
    });
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
      level: this.level,
      name: `${label} sequence diagram`,
      id: `compare-${side === 0 ? 'left' : 'right'}`,
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
    const phase = this.phaseLabel(step.phase);
    const where = phase
      ? `Step ${this.position} of ${this.timeline.length} · ${phase}`
      : `Step ${this.position} of ${this.timeline.length}`;
    this.controls.update({
      step: this.position,
      length: this.timeline.length,
      where,
      playing: this.playing,
      speed: this.rate,
    });
    for (const [id, item] of this.phaseItems) {
      if (id === step.phase) item.setAttribute('aria-current', 'step');
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
      pane.inspect.textContent = `Inspect step ${cursor} in ${pane.spec.label}`;
      const overview = this.level === 'overview';
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
    // An explicit step brings the panes back; a Play tick or a followed link only while the
    // learner has not scrolled the page since (02 layout.phone.stepping_area).
    const cursors: [number, number] = [step.panes[0].cursor, step.panes[1].cursor];
    const before = this.cursors;
    this.cursors = cursors;
    if (before) {
      const changed = this.panes.filter((_, i) => cursors[i] !== before[i]);
      if (changed.length) {
        if (!this.options.pageScroll?.userScrolled) this.keepInView(changed);
      }
    }
    this.options.onChange(this.position, this.level);
  }
}
