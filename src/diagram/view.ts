/**
 * Mounts the sequence diagram for one scenario and keeps it in step with a Player at a zoom
 * level: the group the cursor enters expands, groups expand or collapse on click, Enter or Space,
 * and the current step, group or stage stays in view (02-ui-ux.yaml diagram, zoom_levels).
 */
import type { Player } from '../engine/player.ts';
import { currentGroupKey, estimate, layout, type Level, type Measure } from './model.ts';
import { stageAt, stageSpans, stageStops } from './zoom.ts';
import { Expansion } from './expansion.ts';
import { renderSvg } from './render.ts';
import { renderList } from './list.ts';
import { phoneQuery } from '../app/phone.ts';

export interface DiagramOptions {
  labels: Readonly<Record<string, string>>;
  level?: Level;
  /** Unique per page, for marker IDs. */
  id?: string;
  /** The region's name, for example "Sequence diagram"; its scrolling is appended. */
  name?: string;
}

/** Measures text in the diagram's font with a canvas; falls back to the estimate. */
function canvasMeasure(): Measure {
  const context =
    typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!context) return estimate;
  const family =
    getComputedStyle(document.documentElement).getPropertyValue('--font-text') || 'sans-serif';
  const cache = new Map<string, number>();
  return (text, strong = false) => {
    const key = `${strong ? 1 : 0}${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      context.font = `${strong ? 600 : 400} 13px ${family}`;
      // Half a pixel per character absorbs rounding and kerning differences.
      width = Math.ceil(context.measureText(text).width + text.length * 0.5);
      cache.set(key, width);
    }
    return width;
  };
}

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class DiagramView {
  private viewLevel: Level;
  private readonly expansion = new Expansion();
  private selected: ReadonlySet<number> = new Set();
  private held = false;
  private readonly unsubscribe: () => void;
  private readonly root: HTMLElement;
  private readonly player: Player;
  private readonly options: DiagramOptions;
  private measure: Measure = estimate;
  private destroyed = false;
  /** Level and cursor the region last scrolled to. */
  private scrolledTo = '';
  /** Below 48rem the diagram is the step list (02 diagram.phone_list). */
  private readonly phone = phoneQuery();
  private readonly onPhoneChange = (): void => {
    this.scrolledTo = '';
    this.render();
  };

  constructor(root: HTMLElement, player: Player, options: DiagramOptions) {
    this.root = root;
    this.player = player;
    this.options = options;
    this.viewLevel = options.level ?? 'overview';
    root.classList.add('diagram-scroller');
    root.tabIndex = 0;
    root.addEventListener('click', this.onClick);
    root.addEventListener('keydown', this.onKey);
    this.phone?.addEventListener('change', this.onPhoneChange);
    this.unsubscribe = player.subscribe(() => this.render());
    // Measure with the real font once it has loaded, then lay out again.
    if (typeof document !== 'undefined' && document.fonts) {
      void document.fonts.ready.then(() => {
        if (this.destroyed) return;
        this.measure = canvasMeasure();
        // The real font changes the layout, so the current step may need scrolling to.
        this.scrolledTo = '';
        this.render();
        this.root.dataset['measured'] = 'true';
      });
    }
    this.render();
  }

  get level(): Level {
    return this.viewLevel;
  }

  /** Changes the zoom level; the caller moves the cursor (zoom.ts zoomCursor). */
  setLevel(level: Level): void {
    if (level === this.viewLevel) return;
    this.viewLevel = level;
    this.render();
  }

  /** Marks the steps carrying the selected lineage value (02 lineage_selection.diagram). */
  setSelected(indices: ReadonlySet<number>): void {
    this.selected = indices;
    this.render();
  }

  /** Shows no current step while true (02 compare_view.timeline: a waiting pane). */
  setHeld(held: boolean): void {
    if (held === this.held) return;
    this.held = held;
    this.render();
  }

  /** Expands or collapses a group by its key (data-group). */
  toggleGroup(key: string): void {
    this.expansion.toggle(key);
    this.render();
  }

  isExpanded(key: string): boolean {
    return this.expansion.has(key);
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('keydown', this.onKey);
    this.phone?.removeEventListener('change', this.onPhoneChange);
    this.root.replaceChildren();
  }

  /**
   * Lays the diagram out again. Focus stays on the same group (or the region); the region
   * scrolls to the current step only when the cursor or the mode changed.
   */
  private render(): void {
    // The events as played: derived from the parameters, without disabled optional steps.
    const scenario = { ...this.player.playback.scenario, events: [...this.player.playback.events] };
    const focused = document.activeElement;
    const focusKey =
      focused instanceof Element && focused !== this.root && this.root.contains(focused)
        ? (focused.closest<HTMLElement | SVGElement>('[data-group]')?.dataset['group'] ?? '')
        : undefined;
    const list = this.phone?.matches ?? false;
    // The group the cursor enters expands; a waiting Compare pane has no current group, and the
    // Overview none at all, so zooming in enters the current group again.
    const architecture = this.viewLevel === 'architecture' && !this.held;
    this.expansion.follow(architecture ? currentGroupKey(scenario, this.player.cursor) : undefined);
    const model = layout({
      scenario,
      labels: this.options.labels,
      level: this.viewLevel,
      cursor: this.player.cursor,
      expanded: this.expansion.expanded,
      measure: this.measure,
      selected: this.selected,
      held: this.held,
    });
    const title = this.title(scenario);
    this.root.innerHTML = list
      ? renderList(model, title, this.options.labels)
      : renderSvg(model, title, this.options.id ?? 'diagram', this.options.labels);
    this.root.dataset['presentation'] = list ? 'list' : 'diagram';
    // Focus moved by the keyboard scrolls clear of the sticky participant names too.
    const header = this.headerHeight();
    this.root.style.scrollPaddingTop = header ? `${header}px` : '';
    const name = this.options.name ?? 'Sequence diagram';
    this.root.setAttribute(
      'aria-label',
      list ? `${name}, a list of steps` : `${name}, scrolls in both directions`,
    );
    if (focusKey !== undefined) {
      const group = focusKey
        ? this.root.querySelector<HTMLElement | SVGElement>(
            `[data-group="${CSS.escape(focusKey)}"]`,
          )
        : null;
      // A group that no longer exists hands focus to the region, not to the page.
      (group ?? this.root).focus({ preventScroll: true });
    }
    const position = `${this.viewLevel}:${this.player.cursor}`;
    if (position !== this.scrolledTo) {
      this.scrolledTo = position;
      this.scrollToCurrent();
    }
  }

  /** The diagram's name: the scenario, the level and the position at that level. */
  private title(scenario: Parameters<typeof layout>[0]['scenario']): string {
    const k = this.player.cursor;
    if (this.viewLevel === 'overview') {
      const spans = stageSpans(scenario.overview, scenario.events);
      const stops = stageStops(spans);
      const stage = stageAt(spans, k);
      const where = stage
        ? `stage ${stops.indexOf(stage.last)} of ${stops.length - 1}`
        : 'before the first stage';
      return `${scenario.title}, overview, ${where}`;
    }
    return `${scenario.title}, ${this.viewLevel} view, step ${k} of ${this.player.playback.length}`;
  }

  /** Scrolls the region (never the page) so the current step, group or stage is in view. */
  private scrollToCurrent(): void {
    // The innermost current element: the step inside an expanded current group (it follows
    // the group in document order), else the collapsed group, the stage or the protocol step. A
    // group frame can be wider than the region, which would leave its step out of view.
    const all = this.root.querySelectorAll<Element>('[data-current]');
    const current = all[all.length - 1];
    if (!current) return;
    const region = this.root.getBoundingClientRect();
    const margin = 24;
    // The pinned participant names cover the top of the region.
    const header = this.headerHeight();
    const step = current.getBoundingClientRect();
    // A step inside an expanded group: show the group's start too when both fit (issue 51).
    const group = all.length > 1 ? all[0]?.getBoundingClientRect() : undefined;
    const box =
      group && step.bottom - group.top <= region.height - header - 2 * margin
        ? {
            top: group.top,
            bottom: step.bottom,
            height: step.bottom - group.top,
            left: step.left,
            right: step.right,
            width: step.width,
          }
        : step;
    let top = this.root.scrollTop;
    let left = this.root.scrollLeft;
    // Vertically: reveal the end only if the start stays in view; otherwise show the start.
    const fitsY = box.height <= region.height - header - 2 * margin;
    const near = region.top + header + margin;
    if (box.top < near || (!fitsY && box.top > near)) {
      top -= near - box.top;
    } else if (box.bottom > region.bottom - margin) top += box.bottom - region.bottom + margin;
    // Horizontally only as far as needed: the start into view, or, when the whole box fits, its
    // end. An arrow that fits keeps both ends (sender and receiver) in view; a group wider than
    // the region stays where it is once its start is in view, so the participants left of it
    // are not pushed out.
    const start = region.left + margin;
    const fitsX = box.width <= region.width - 2 * margin;
    if (box.left < start) left -= start - box.left;
    else if (fitsX && box.right > region.right - margin) left += box.right - region.right + margin;
    top = Math.max(0, top);
    left = Math.max(0, left);
    if (top === this.root.scrollTop && left === this.root.scrollLeft) return;
    // The step list scrolls at once, so the page can follow it (02 layout.phone.stepping_area).
    const instant = reducedMotion() || this.root.dataset['presentation'] === 'list';
    this.root.scrollTo({ top, left, behavior: instant ? 'instant' : 'smooth' });
  }

  /** Height of the participant names' band, 0 in the step list. */
  private headerHeight(): number {
    const header = this.root.querySelector<HTMLElement>('.diagram-head');
    return header ? Number(header.dataset['header'] ?? 0) : 0;
  }

  private readonly onClick = (event: Event): void => {
    const group = (event.target as Element).closest<HTMLElement | SVGElement>('[data-group]');
    if (!group?.dataset['group']) return;
    group.focus({ preventScroll: true });
    this.toggleGroup(group.dataset['group']);
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // A button in the step list activates itself, through onClick.
    if (event.target instanceof HTMLButtonElement) return;
    const group = (event.target as Element).closest<SVGGElement>('[data-group]');
    if (!group?.dataset['group']) return;
    event.preventDefault();
    this.toggleGroup(group.dataset['group']);
  };
}
