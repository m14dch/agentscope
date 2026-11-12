/**
 * The phone column of steps for one scenario (02-ui-ux.yaml phone_steps): the learning question,
 * the zoom control and Open all, then one row per unit of the zoom level. Opening a row shows
 * the step's message, its inspector and the panels it holds; several rows can be open. Only the
 * page scrolls, and only for an address or a jump link.
 */
import type { Player } from '../engine/player.ts';
import { levelAnnouncement, setZoom, zoomControl } from '../app/controls.ts';
import { type Level, stageSpans, zoomCursor, zoomed } from '../diagram/zoom.ts';
import { type Boundary, Inspector, occurrences, type Selection } from '../inspector/inspector.ts';
import type { EarlierRevision, Scenario, ScenarioEvent } from '../scenarios/types.ts';
import { type EventRow, eventRows, groupAt, type GroupRow, groupRows, stageItems } from './rows.ts';
import { allButtons, el, fold, groupEvent, rowItem, setOpen, stepNumber } from './dom.ts';

/** A panel inside a row (02 phone_steps.inline_panels). */
export interface InlinePanel {
  root: HTMLElement;
  destroy?: () => void;
}

/** What a panel inside a row may do. */
export interface PanelActions {
  /** Opens the row of a step (1-based) and scrolls it to the top of the screen. */
  jump: (step: number) => void;
  /** Takes focus when the panel loses the control that held it. */
  leave: () => void;
}

export interface PhoneStepsOptions {
  scenario: Scenario;
  /** Plays the events at the current parameters; its cursor is the address's step. */
  player: Player;
  labels: Readonly<Record<string, string>>;
  level: Level;
  boundaries: readonly Boundary[];
  earlierRevision?: EarlierRevision | undefined;
  /** The parameter controls, when the scenario has parameters (rag_controls). */
  parameters?: HTMLElement | undefined;
  /** The panels the event at `step` holds, as of that step. */
  panels: (event: ScenarioEvent, step: number, actions: PanelActions) => InlinePanel[];
  /** After the cursor or the level changed, to write the address. */
  onChange: () => void;
}

/** A row on the page with what its body holds while open. */
interface Row {
  key: string;
  /** The steps the row covers (1-based). */
  steps: number[];
  button: HTMLButtonElement;
  body: HTMLElement;
  /** Builds the body's content; returns what to dispose of when it closes. */
  fill: (reveal: boolean) => (() => void)[];
  dispose: (() => void)[];
  /** The step's inspector while open (Protocol), for a lineage selection. */
  inspector?: { view: Inspector; step: number } | undefined;
}

export class PhoneSteps {
  private readonly options: PhoneStepsOptions;
  private viewLevel: Level;
  /** Keys of the open rows, kept across a parameter change. */
  private readonly open = new Set<string>();
  /** Keys of rows whose prediction prompt was answered with "Show the step". */
  private readonly revealed = new Set<string>();
  private rows: Row[] = [];
  private selection: Selection | undefined;
  private readonly zoom: HTMLElement;
  private readonly announcer: HTMLElement;
  private readonly headline: HTMLElement;
  private readonly parameters: HTMLElement | undefined;
  private readonly all: HTMLElement;
  private readonly list: HTMLElement;

  constructor(root: HTMLElement, options: PhoneStepsOptions) {
    this.options = options;
    this.viewLevel = options.level;
    const { scenario } = options;
    this.headline = el('p', { class: 'headline' }, scenario.headline);
    this.zoom = zoomControl((level) => this.setLevel(level));
    this.announcer = el('div', { class: 'visually-hidden', 'aria-live': 'polite' });
    this.parameters = options.parameters
      ? fold('Parameters', 'phone-parameters', () => [options.parameters as HTMLElement]).root
      : undefined;
    this.all = allButtons(
      () => this.openAll(),
      () => this.closeAll(),
    );
    this.list = el('div', { class: 'steps-area' });
    root.replaceChildren(
      el(
        'section',
        { class: 'lesson' },
        el('h2', { tabindex: '-1' }, scenario.learning_question),
        this.headline,
      ),
      el('div', { class: 'phone-intro' }, this.zoom, this.announcer),
      ...(this.parameters ? [this.parameters] : []),
      this.all,
      this.list,
    );
    this.render();
    this.openAt(options.player.cursor, true);
  }

  get level(): Level {
    return this.viewLevel;
  }

  /** Follows a step and level read from the address: the row holding the step opens. */
  follow(cursor: number, level: Level): void {
    const player = this.options.player;
    player.jump(cursor);
    if (level !== this.viewLevel) {
      this.viewLevel = level;
      this.open.clear();
      this.render();
    }
    player.jump(zoomCursor(this.spans(), player.cursor, 'protocol', level));
    this.openAt(player.cursor, true);
  }

  /** Zooms in (+1) or out (-1), if there is a level there. */
  zoomBy(direction: 1 | -1): void {
    const level = zoomed(this.viewLevel, direction);
    if (level) this.setLevel(level);
  }

  /**
   * Changes the level, keeping the place (02 phone_steps.zoom): the row holding the mapped step
   * opens, the others close, and the level is announced. The page does not scroll.
   */
  setLevel(level: Level): void {
    if (level === this.viewLevel) return;
    const player = this.options.player;
    const target = zoomCursor(this.spans(), player.cursor, this.viewLevel, level);
    const active = document.activeElement;
    const inRows = active instanceof HTMLElement && this.list.contains(active);
    this.viewLevel = level;
    this.open.clear();
    player.jump(target);
    this.render();
    this.openAt(player.cursor, false);
    this.announcer.textContent = levelAnnouncement(level, this.count());
    // Focus in the rows that were rebuilt moves to the zoom control.
    if (inRows || (active instanceof HTMLElement && !active.isConnected))
      this.zoom.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
  }

  /** After a parameter change: the rows of events still played stay open. */
  rebuild(): void {
    if (this.selection && !occurrences(this.options.player.playback.events, this.selection).length)
      this.selection = undefined;
    this.render();
  }

  dispose(): void {
    for (const row of this.rows) this.close(row);
  }

  /** "Protocol. 28 steps.", "Architecture. 9 groups." or "Overview. 4 stages." */
  private count(): string {
    const n =
      this.viewLevel === 'overview'
        ? stageItems(this.options.scenario, this.events).length
        : this.rows.length;
    const unit = { overview: 'stage', architecture: 'group', protocol: 'step' }[this.viewLevel];
    return `${n} ${unit}${n === 1 ? '' : 's'}.`;
  }

  private get events(): readonly ScenarioEvent[] {
    return this.options.player.playback.events;
  }

  private spans() {
    return stageSpans(this.options.scenario.overview, this.events);
  }

  /** Lays out the intro and the rows of the level; open rows stay open. */
  private render(): void {
    const overview = this.viewLevel === 'overview';
    setZoom(this.zoom, this.viewLevel);
    // The headline names the protocol, so it shows from Architecture on (zoom_levels.overview).
    this.headline.hidden = overview;
    if (this.parameters) this.parameters.hidden = overview;
    this.all.hidden = overview;
    for (const row of this.rows) this.close(row);
    this.rows = [];
    if (overview) {
      this.list.replaceChildren(this.stages());
      return;
    }
    const { labels, scenario } = this.options;
    const list = el('ol', { class: 'steps', 'aria-label': scenario.title });
    if (this.viewLevel === 'protocol') {
      for (const r of eventRows(this.events, labels)) list.append(this.eventRow(r));
    } else {
      groupRows(scenario, this.events, labels).forEach((g, i) => list.append(this.groupRow(g, i)));
    }
    this.list.replaceChildren(list);
    const keys = new Set(this.rows.map((r) => r.key));
    for (const key of [...this.open]) if (!keys.has(key)) this.open.delete(key);
    for (const row of this.rows) if (this.open.has(row.key)) this.show(row);
  }

  /** The Overview: the stages as a numbered list; nothing opens (phone_steps.rows.overview). */
  private stages(): HTMLElement {
    const items = stageItems(this.options.scenario, this.events);
    return el(
      'ol',
      { class: 'stages', 'aria-label': 'Stages' },
      ...items.map((s) =>
        el(
          'li',
          { class: 'stage-item' },
          el('p', {}, s.sentence),
          el('p', { class: 'small muted' }, s.parties),
        ),
      ),
    );
  }

  private eventRow(r: EventRow): HTMLElement {
    const id = `step-${r.step}`;
    const { item, button, body } = rowItem(
      id,
      { lead: stepNumber(r.step), glyph: r.direction, title: r.label, sub: r.participants },
      () => this.toggle(row),
    );
    const row: Row = {
      key: r.key,
      steps: [r.step],
      button,
      body,
      dispose: [],
      fill: (reveal) => this.eventBody(row, r, reveal),
    };
    this.rows.push(row);
    return item;
  }

  private groupRow(g: GroupRow, i: number): HTMLElement {
    const { item, button, body } = rowItem(
      `group-${i + 1}`,
      { title: g.title, sub: g.caption },
      () => this.toggle(row),
    );
    const row: Row = {
      key: g.key,
      steps: g.events.map((e) => e.step),
      button,
      body,
      dispose: [],
      fill: () => this.groupBody(g),
    };
    this.rows.push(row);
    return item;
  }

  /**
   * A Protocol row's body (02 phone_steps.body.protocol): a prediction prompt first, then the
   * inspector without the line the row already shows, then the panels of the step.
   */
  private eventBody(row: Row, r: EventRow, reveal: boolean): (() => void)[] {
    const prompt = r.event.prediction?.prompt;
    const gated = prompt !== undefined && !reveal && !this.revealed.has(row.key);
    const before = prompt
      ? [
          el(
            'div',
            { class: 'prediction' },
            el('p', { class: 'small muted' }, 'Before this step'),
            el('p', { class: 'prompt' }, prompt),
          ),
        ]
      : [];
    if (gated) {
      const show = el('button', { type: 'button' }, 'Show the step');
      show.addEventListener('click', () => {
        this.revealed.add(row.key);
        this.close(row);
        this.show(row);
        row.body.querySelector<HTMLElement>('.message')?.focus({ preventScroll: true });
      });
      (before[0] as HTMLElement).append(show);
      row.body.replaceChildren(...before);
      return [];
    }
    const holder = el('div');
    const view = new Inspector(holder, {
      labels: this.options.labels,
      boundaries: this.options.boundaries,
      earlierRevision: this.options.earlierRevision,
      jump: (k) => this.jump(k),
      select: (selection) => this.select(selection),
      id: `step-${r.step}-inspector`,
      name: `Step ${r.step} details`,
      route: false,
    });
    view.update({ events: this.events, cursor: r.step, selection: this.selection });
    // The message can take focus after "Show the step", so the reader continues there.
    holder.querySelector('.message')?.setAttribute('tabindex', '-1');
    row.inspector = { view, step: r.step };
    const panels = this.panelsAt(row, r);
    row.body.replaceChildren(...before, holder, ...panels.map((p) => p.root));
    return panels.flatMap((p) => (p.destroy ? [p.destroy] : []));
  }

  /** An Architecture row's body: its events with their explanations, then their panels. */
  private groupBody(g: GroupRow): (() => void)[] {
    const row = this.rows.find((r) => r.key === g.key) as Row;
    const list = el('ol', { class: 'group-events' });
    const disposers: (() => void)[] = [];
    for (const r of g.events) {
      const item = groupEvent(r);
      const panels = this.panelsAt(row, r);
      item.append(...panels.map((p) => p.root));
      disposers.push(...panels.flatMap((p) => (p.destroy ? [p.destroy] : [])));
      list.append(item);
    }
    row.body.replaceChildren(list);
    return disposers;
  }

  private panelsAt(row: Row, r: EventRow) {
    return this.options.panels(r.event, r.step, {
      jump: (k) => this.jump(k),
      leave: () => row.button.focus({ preventScroll: true }),
    });
  }

  private toggle(row: Row): void {
    if (this.open.has(row.key)) {
      this.open.delete(row.key);
      this.close(row);
      return;
    }
    this.open.add(row.key);
    this.show(row);
    // The address names the last row opened (phone_steps.address).
    this.options.player.jump(row.steps[0] ?? 0);
    this.options.onChange();
  }

  private show(row: Row, reveal = false): void {
    if (!row.body.hidden) return;
    setOpen(row, true);
    row.dispose = row.fill(reveal);
  }

  private close(row: Row): void {
    for (const d of row.dispose) d();
    row.dispose = [];
    row.inspector = undefined;
    setOpen(row, false);
    row.body.replaceChildren();
  }

  /** Open all shows every body in full, prompts above their steps (phone_steps.predictions). */
  private openAll(): void {
    for (const row of this.rows) {
      this.open.add(row.key);
      if (!row.body.hidden && row.body.querySelector('.prediction button')) this.close(row);
      this.show(row, true);
    }
  }

  private closeAll(): void {
    this.open.clear();
    for (const row of this.rows) this.close(row);
  }

  /** The row holding the step at `cursor`, if any. */
  private rowAt(cursor: number): Row | undefined {
    if (this.viewLevel === 'architecture') {
      const groups = groupRows(this.options.scenario, this.events, this.options.labels);
      const key = groupAt(groups, cursor)?.key;
      return this.rows.find((r) => r.key === key);
    }
    return this.rows.find((r) => r.steps.includes(cursor));
  }

  /**
   * Opens the row holding `cursor` and, for an address, scrolls the page at once so it starts at
   * the top of the screen (phone_steps.address); writes the address.
   */
  private openAt(cursor: number, scroll: boolean): void {
    const row = cursor > 0 ? this.rowAt(cursor) : undefined;
    if (row) {
      this.open.add(row.key);
      this.show(row);
      if (scroll) row.button.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
    this.options.onChange();
  }

  /** A jump link: the row of the step opens at the top of the screen. */
  private jump(step: number): void {
    this.options.player.jump(step);
    this.openAt(step, true);
    this.rowAt(step)?.button.focus({ preventScroll: true });
  }

  /** A lineage selection marks the fields in the open payloads (02 lineage_selection.payload). */
  private select(selection: Selection | undefined): void {
    this.selection = selection;
    for (const row of this.rows) {
      const i = row.inspector;
      if (i) i.view.update({ events: this.events, cursor: i.step, selection });
    }
  }
}
