/**
 * Compare on a phone (02-ui-ux.yaml phone_steps.compare): one column interleaved by semantic
 * phase, RAG's units then MCP's under each phase heading, every unit marked RAG or MCP in text.
 * An opened row shows the explanation and a link to the scenario's own route.
 */
import { levelAnnouncement, setZoom, zoomControl } from '../app/controls.ts';
import { levelSuffix } from '../app/routes.ts';
import { type Level, zoomed } from '../diagram/zoom.ts';
import { createPlayback } from '../rag/bundled.ts';
import type { Compare, Scenario, ScenarioEvent } from '../scenarios/types.ts';
import { allButtons, el, groupEvent, rowItem, setOpen } from './dom.ts';
import {
  type CompareSide,
  compareColumn,
  type EventRow,
  eventRows,
  type GroupRow,
  groupRows,
  type StageItem,
  stageItems,
} from './rows.ts';

export interface PhoneCompareOptions {
  compare: Compare;
  /** 06 semantic_phases, in order. */
  phases: readonly { id: string; label: string }[];
  panes: readonly [
    { scenario: Scenario; label: string; tab: string },
    { scenario: Scenario; label: string; tab: string },
  ];
  labels: Readonly<Record<string, string>>;
  level: Level;
  /** After a change of level, to write the address. */
  onChange: (level: Level) => void;
}

type Unit =
  | { kind: 'stage'; item: StageItem }
  | { kind: 'group'; row: GroupRow }
  | { kind: 'event'; row: EventRow };

interface OpenRow {
  key: string;
  button: HTMLButtonElement;
  body: HTMLElement;
  fill: () => void;
}

export class PhoneCompare {
  private readonly options: PhoneCompareOptions;
  private readonly sides: readonly [CompareSide, CompareSide];
  private readonly tabs: readonly [string, string];
  private viewLevel: Level;
  private readonly open = new Set<string>();
  private rows: OpenRow[] = [];
  private readonly heading: HTMLElement;
  private readonly zoom: HTMLElement;
  private readonly announcer: HTMLElement;
  private readonly all: HTMLElement;
  private readonly column: HTMLElement;
  private readonly aspects: HTMLElement;

  constructor(root: HTMLElement, options: PhoneCompareOptions) {
    this.options = options;
    this.viewLevel = options.level;
    const { compare } = options;
    const side = (i: 0 | 1): CompareSide => {
      const pane = options.panes[i];
      return {
        label: pane.label,
        scenario: pane.scenario,
        // Compare plays the defaults (compare_view.defaults).
        events: createPlayback(pane.scenario).events,
        semanticOf: compare.phase_mapping[pane.scenario.id] ?? {},
        placeholders: compare.placeholders?.[pane.scenario.id] ?? {},
      };
    };
    this.sides = [side(0), side(1)];
    this.tabs = [options.panes[0].tab, options.panes[1].tab];
    this.heading = el('h2', { tabindex: '-1' });
    this.zoom = zoomControl((level) => this.setLevel(level));
    this.announcer = el('div', { class: 'visually-hidden', 'aria-live': 'polite' });
    this.all = allButtons(
      () => this.openAll(),
      () => this.closeAll(),
    );
    this.column = el('div', { class: 'steps-area' });
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
    root.replaceChildren(
      el('section', { class: 'lesson' }, this.heading),
      el('div', { class: 'phone-intro' }, this.zoom, this.announcer),
      this.all,
      this.column,
      this.aspects,
    );
    this.render();
  }

  /** Follows a level read from the address. */
  follow(level: Level): void {
    if (level === this.viewLevel) return;
    this.viewLevel = level;
    this.open.clear();
    this.render();
  }

  zoomBy(direction: 1 | -1): void {
    const level = zoomed(this.viewLevel, direction);
    if (level) this.setLevel(level);
  }

  setLevel(level: Level): void {
    if (level === this.viewLevel) return;
    const active = document.activeElement;
    const inRows = active instanceof HTMLElement && this.column.contains(active);
    this.viewLevel = level;
    this.open.clear();
    this.render();
    const n = this.rows.length;
    const where =
      level === 'overview'
        ? `${this.column.querySelectorAll('.stage-item').length} stages.`
        : `${n} ${level === 'protocol' ? 'step' : 'group'}${n === 1 ? '' : 's'}.`;
    this.announcer.textContent = levelAnnouncement(level, where);
    if (inRows)
      this.zoom.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
    this.options.onChange(level);
  }

  dispose(): void {
    this.rows = [];
  }

  private render(): void {
    const overview = this.viewLevel === 'overview';
    const { compare, phases, labels } = this.options;
    this.heading.textContent = overview
      ? String(compare['overview_headline'] ?? compare.headline)
      : compare.headline;
    setZoom(this.zoom, this.viewLevel);
    this.all.hidden = overview;
    // The aspects name the protocols, so they show from Architecture on (compare_view.layout).
    this.aspects.hidden = overview;
    this.rows = [];
    const units = (side: CompareSide): { unit: Unit; firstEvent: ScenarioEvent | undefined }[] => {
      if (this.viewLevel === 'overview') {
        return stageItems(side.scenario, side.events)
          .filter((s) => s.first > 0)
          .map((item) => ({
            unit: { kind: 'stage', item },
            firstEvent: side.events[item.first - 1],
          }));
      }
      if (this.viewLevel === 'architecture') {
        return groupRows(side.scenario, side.events, labels).map((row) => ({
          unit: { kind: 'group', row },
          firstEvent: row.events[0]?.event,
        }));
      }
      return eventRows(side.events, labels).map((row) => ({
        unit: { kind: 'event', row },
        firstEvent: row.event,
      }));
    };
    const column = compareColumn(phases, this.sides, units);
    this.column.replaceChildren(
      ...column.map((phase) => {
        const list = el('ol', { class: overview ? 'stages' : 'steps' });
        for (const entry of phase.entries) {
          const mark = (this.sides[entry.side] as CompareSide).label;
          if (entry.kind === 'placeholder') {
            list.append(
              el(
                'li',
                { class: 'stage-item compare-placeholder' },
                el('p', {}, el('span', { class: 'small muted' }, `${mark} `), entry.text),
              ),
            );
          } else list.append(this.unit(entry.side, entry.unit));
        }
        return el(
          'section',
          { class: 'compare-phase', 'aria-labelledby': `phase-${phase.id}` },
          el('h3', { id: `phase-${phase.id}` }, phase.label),
          list,
        );
      }),
    );
    for (const row of this.rows) if (this.open.has(row.key)) this.show(row);
  }

  private unit(side: 0 | 1, unit: Unit): HTMLElement {
    const mark = (this.sides[side] as CompareSide).label;
    if (unit.kind === 'stage') {
      return el(
        'li',
        { class: 'stage-item' },
        el('p', {}, el('span', { class: 'small muted' }, `${mark} `), unit.item.sentence),
        el('p', { class: 'small muted' }, unit.item.parties),
      );
    }
    const id = `${mark.toLowerCase()}-${unit.kind}-${unit.kind === 'event' ? unit.row.step : unit.row.key.replace(/\W/g, '-')}`;
    const face =
      unit.kind === 'event'
        ? {
            lead: [mark],
            glyph: unit.row.direction,
            title: unit.row.label,
            sub: `Step ${unit.row.step} · ${unit.row.participants}`,
          }
        : { lead: [mark], title: unit.row.title, sub: unit.row.caption };
    const { item, button, body } = rowItem(id, face, () => this.toggle(row));
    const row: OpenRow = {
      key: id,
      button,
      body,
      fill: () => body.replaceChildren(...this.body(side, unit)),
    };
    this.rows.push(row);
    return item;
  }

  /** An opened row: the explanation (a group: its events) and a link to inspect it. */
  private body(side: 0 | 1, unit: Unit): Node[] {
    if (unit.kind === 'stage') return [];
    const s = this.sides[side] as CompareSide;
    const step = unit.kind === 'event' ? unit.row.step : (unit.row.events[0]?.step ?? 0);
    const href = `#/${this.tabs[side]}/${s.scenario.id}/${step}${levelSuffix(this.viewLevel)}`;
    const link = el('a', { href, class: 'small' }, `Inspect step ${step} in ${s.label}`);
    const content =
      unit.kind === 'event'
        ? [el('p', { class: 'message' }, unit.row.event.explanation)]
        : [el('ol', { class: 'group-events' }, ...unit.row.events.map((r) => groupEvent(r)))];
    return [...content, el('p', {}, link)];
  }

  private toggle(row: OpenRow): void {
    if (this.open.has(row.key)) {
      this.open.delete(row.key);
      this.close(row);
    } else {
      this.open.add(row.key);
      this.show(row);
    }
  }

  private show(row: OpenRow): void {
    setOpen(row, true);
    row.fill();
  }

  private close(row: OpenRow): void {
    setOpen(row, false);
    row.body.replaceChildren();
  }

  private openAll(): void {
    for (const row of this.rows) {
      this.open.add(row.key);
      if (row.body.hidden) this.show(row);
    }
  }

  private closeAll(): void {
    this.open.clear();
    for (const row of this.rows) this.close(row);
  }
}
