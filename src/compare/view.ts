/**
 * The Compare view (02-ui-ux.yaml compare_view): rag-query and mcp-balance side by side,
 * stepped in sync by semantic phase with one set of shared controls, then one sentence per
 * comparison aspect.
 */
import { type Clock, Player, SPEEDS, type Speed, STEP_INTERVAL_MS } from '../engine/player.ts';
import { DiagramView } from '../diagram/view.ts';
import { type Mode, operationLabel } from '../diagram/model.ts';
import { createPlayback } from '../rag/bundled.ts';
import type { Compare, Scenario } from '../scenarios/types.ts';
import { CompareTimeline, type PaneAt, type PaneInput } from './timeline.ts';
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
  mode: Mode;
  /** Called after every change of position or mode, to write the address. */
  onChange: (step: number, mode: Mode) => void;
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

function button(
  label: string,
  onClick: () => void,
  props: Partial<Record<string, string>> = {},
): HTMLButtonElement {
  const b = el('button', { type: 'button', ...props }, label);
  b.addEventListener('click', onClick);
  return b;
}

interface Pane {
  spec: PaneSpec;
  player: Player;
  view: DiagramView;
  slider: HTMLInputElement;
  position: HTMLElement;
  message: HTMLElement;
  inspect: HTMLAnchorElement;
  root: HTMLElement;
}

export class CompareView {
  readonly timeline: CompareTimeline;
  /** The architecture/protocol switch, placed in the top bar by the shell. */
  readonly modeSwitch: HTMLElement;
  /** What the shell rearranges on phones (02 layout.phone.controls). */
  readonly phoneControls: {
    bar: HTMLElement;
    status: HTMLElement;
    speeds: HTMLElement;
    start: HTMLElement;
    reset: HTMLElement;
  };
  private readonly options: CompareOptions;
  private readonly clock: Clock;
  private readonly panes: readonly [Pane, Pane];
  private readonly phaseLabels: ReadonlyMap<string, string>;
  private readonly phaseItems = new Map<string, HTMLElement>();
  private readonly status: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly play: HTMLButtonElement;
  private readonly speeds: HTMLElement;
  private readonly announcer: HTMLElement;
  private position: number;
  private mode: Mode;
  private playing = false;
  private rate: Speed = 1;
  private timer: unknown;
  /**
   * The position last announced, so a mode switch, a repeated render or a pause where the
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
    this.mode = options.mode;
    const { compare, phases, panes } = options;
    this.phaseLabels = new Map(phases.map((p) => [p.id, p.label]));
    this.panes = [this.pane(panes[0], 0), this.pane(panes[1], 1)];
    this.timeline = new CompareTimeline(
      phases.map((p) => p.id),
      [this.input(this.panes[0]), this.input(this.panes[1])],
    );
    this.position = this.timeline.clamp(options.step);
    this.announced = this.position;

    this.modeSwitch = el('div', { class: 'segmented', role: 'group', 'aria-label': 'View' });
    for (const mode of ['architecture', 'protocol'] as const) {
      const b = button(mode === 'architecture' ? 'Architecture' : 'Protocol', () =>
        this.setMode(mode),
      );
      b.dataset['mode'] = mode;
      this.modeSwitch.append(b);
    }

    this.play = button('Play', () => this.toggle());
    this.speeds = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Speed' });
    for (const speed of SPEEDS) {
      const b = button(`${speed}×`, () => this.setSpeed(speed), {
        'aria-label': `Speed ${speed}×`,
      });
      b.dataset['speed'] = String(speed);
      this.speeds.append(b);
    }
    const start = button('Start', () => this.act(() => this.navigate(1)));
    const reset = button('Reset', () => this.reset());
    const controls = el(
      'div',
      { class: 'controls', role: 'group', 'aria-label': 'Playback of both panes' },
      start,
      button('Previous', () => this.previous()),
      this.play,
      button('Next', () => this.next()),
      reset,
      this.speeds,
    );

    this.slider = el('input', {
      type: 'range',
      min: '0',
      max: String(this.timeline.length),
      step: '1',
      'aria-label': 'Compare step',
    });
    this.slider.addEventListener('input', () =>
      this.act(() => this.navigate(Number(this.slider.value))),
    );
    this.status = el('span', { class: 'small muted compare-status' });
    this.bar = controls;
    this.phoneControls = { bar: controls, status: this.status, speeds: this.speeds, start, reset };
    const phaseList = el('ol', { class: 'compare-phases small', 'aria-label': 'Semantic phases' });
    for (const phase of phases) {
      const item = el('li', {}, phase.label);
      this.phaseItems.set(phase.id, item);
      phaseList.append(item);
    }
    this.announcer = el('div', { class: 'visually-hidden', 'aria-live': 'polite' });
    const timeline = el(
      'div',
      { class: 'compare-timeline' },
      this.slider,
      this.status,
      phaseList,
      this.announcer,
    );

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
      controls,
      timeline,
      el('div', { class: 'compare-panes' }, ...this.panes.map((p) => p.root)),
      aspects,
    );
    this.render();
  }

  get step(): number {
    return this.position;
  }

  get viewMode(): Mode {
    return this.mode;
  }

  /** Follows a step and mode read from the address. */
  follow(step: number, mode: Mode): void {
    this.position = this.timeline.clamp(step);
    this.setMode(mode);
    this.render();
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

  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const pane of this.panes) pane.view.setMode(mode);
    this.render();
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
      mode: this.mode,
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
    return { spec, player, view, slider, position, message, inspect, root };
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
    const event = pane.player.playback.event(at.cursor);
    if (!event) return [];
    const labels = this.options.labels;
    const from = labels[event.sender] ?? event.sender;
    const to = labels[event.receiver] ?? event.receiver;
    return [
      ...(at.status === 'done'
        ? [
            el(
              'p',
              { class: 'small compare-done' },
              `Done with ${this.phaseLabel(phase).toLowerCase()}; ${other.spec.label} continues.`,
            ),
          ]
        : []),
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
    this.status.textContent = where;
    this.slider.value = String(this.position);
    this.slider.setAttribute('aria-valuetext', where);
    for (const [id, item] of this.phaseItems) {
      if (id === step.phase) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    }
    this.play.textContent = this.playing ? 'Pause' : 'Play';
    for (const b of this.speeds.querySelectorAll<HTMLButtonElement>('button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset['speed']) === this.rate));
    }
    for (const b of this.modeSwitch.querySelectorAll<HTMLButtonElement>('button')) {
      b.setAttribute('aria-pressed', String(b.dataset['mode'] === this.mode));
    }
    const announcements: string[] = [];
    for (const side of [0, 1] as const) {
      const pane = this.panes[side];
      const at = step.panes[side];
      pane.view.setHeld(at.status === 'placeholder');
      pane.player.jump(at.cursor);
      const paneWhere = this.paneWhere(pane, at, step.phase);
      pane.position.textContent = paneWhere;
      pane.slider.value = String(at.cursor);
      pane.slider.setAttribute('aria-valuetext', paneWhere);
      pane.root.dataset['status'] = at.status;
      const other = this.panes[side === 0 ? 1 : 0];
      pane.message.replaceChildren(...this.paneMessage(pane, at, other, step.phase));
      const route = `#/${pane.spec.tab}/${pane.spec.scenario.id}/${at.cursor}${this.mode === 'protocol' ? '/protocol' : ''}`;
      pane.inspect.href = route;
      pane.inspect.textContent = `Inspect step ${at.cursor} in ${pane.spec.label}`;
      const n = pane.player.playback.length;
      announcements.push(
        at.status === 'placeholder'
          ? `${pane.spec.label}: ${this.placeholder(pane.spec.scenario.id, step.phase)}`
          : `${pane.spec.label} step ${at.cursor} of ${n}${at.status === 'done' ? ', done with this phase' : ''}.`,
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
    this.options.onChange(this.position, this.mode);
  }
}
