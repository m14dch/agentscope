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

export interface DiagramOptions {
  labels: Readonly<Record<string, string>>;
  /** Short participant labels for the arrows' names (01 participants.registry short_label). */
  shortLabels?: Readonly<Record<string, string>>;
  level?: Level;
  /** Unique per page, for marker IDs. */
  id?: string;
  /** The region's name, for example "Sequence diagram"; its scrolling is appended. */
  name?: string;
  /**
   * Called with the width the region needs to show the diagram without scrolling sideways
   * (its natural width plus the region's scrollbar), whenever that changes. The workspace
   * widens up to it (02 layout.max_width).
   */
  onNaturalWidth?: (px: number) => void;
  /**
   * Moves the cursor to a step (1-based), by the same path as the step slider: called when the
   * learner clicks or activates an arrow (02 diagram.arrow_activation).
   */
  jump?: (cursor: number) => void;
}

/** The arrows' buttons, in reading order. */
const ARROW = '.step-button';

/** The step index (0-based) of the arrow holding an element, if any. */
function arrowIndex(target: EventTarget | null): number | undefined {
  if (!(target instanceof Element)) return undefined;
  const step = target.closest<SVGGElement>(ARROW)?.closest<SVGGElement>('[data-index]');
  const index = step ? Number(step.dataset['index']) : NaN;
  return Number.isInteger(index) ? index : undefined;
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
  private held = false;
  private readonly unsubscribe: () => void;
  private readonly root: HTMLElement;
  private readonly player: Player;
  private readonly options: DiagramOptions;
  private measure: Measure = estimate;
  private destroyed = false;
  /** The natural width last reported, and the widest layout it was derived from. */
  private reportedWidth = -1;
  /** Watches the region's width for the Overview, and the width it was laid out for. */
  private resize: ResizeObserver | undefined;
  private laidOutWidth = 0;
  private widest: { events: readonly unknown[]; measure: Measure; width: number } | undefined;
  /** Level and cursor the region last scrolled to. */
  private scrolledTo = '';

  constructor(root: HTMLElement, player: Player, options: DiagramOptions) {
    this.root = root;
    this.player = player;
    this.options = options;
    this.viewLevel = options.level ?? 'overview';
    root.classList.add('diagram-scroller');
    root.tabIndex = 0;
    root.addEventListener('click', this.onClick);
    root.addEventListener('keydown', this.onKey);
    this.unsubscribe = player.subscribe(() => this.render());
    // The Overview spreads its parties across the region, so it follows the region's width.
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(() => {
        if (this.viewLevel !== 'overview') return;
        if (Math.abs(this.root.clientWidth - this.laidOutWidth) > 16) this.render();
      });
      this.resize.observe(root);
    }
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
    this.resize?.disconnect();
    this.root.replaceChildren();
  }

  /**
   * Lays the diagram out again. Focus stays on the same group or arrow (or the region); the
   * region scrolls to the current step only when the cursor or the level changed.
   */
  private render(): void {
    // The events as played: derived from the parameters, without disabled optional steps.
    const scenario = { ...this.player.playback.scenario, events: [...this.player.playback.events] };
    const focused = document.activeElement;
    const inside =
      focused instanceof Element && focused !== this.root && this.root.contains(focused);
    const focusArrow = inside ? arrowIndex(focused) : undefined;
    const focusKey =
      inside && focusArrow === undefined
        ? (focused.closest<HTMLElement | SVGElement>('[data-group]')?.dataset['group'] ?? '')
        : undefined;
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
      held: this.held,
      available: this.root.clientWidth,
    });
    this.laidOutWidth = this.root.clientWidth;
    const title = this.title(scenario);
    this.root.innerHTML = renderSvg(
      model,
      title,
      this.options.id ?? 'diagram',
      // Arrow names use the short labels (02 diagram.visibility.accessible_name).
      this.options.shortLabels ?? this.options.labels,
    );
    this.root.dataset['presentation'] = 'diagram';
    this.reportWidth(Math.max(model.width, this.widestWidth(scenario)));
    // Focus moved by the keyboard scrolls clear of the sticky participant names too.
    const header = this.headerHeight();
    this.root.style.scrollPaddingTop = header ? `${header}px` : '';
    const name = this.options.name ?? 'Sequence diagram';
    this.root.setAttribute('aria-label', `${name}, scrolls in both directions`);
    // The focused arrow keeps focus and the tab stop; one the level no longer shows hands focus
    // to the region, as a group does.
    const arrow = this.rove(focusArrow);
    let focusedArrow: SVGGElement | undefined;
    if (focusArrow !== undefined) {
      focusedArrow = arrow && arrowIndex(arrow) === focusArrow ? arrow : undefined;
      (focusedArrow ?? this.root).focus({ preventScroll: true });
    }
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
      // While an arrow holds focus, a step keeps that arrow in view rather than the new current
      // step, so focus never leaves the screen (02 diagram.arrow_activation).
      if (focusedArrow) this.reveal(focusedArrow);
      else this.scrollToCurrent();
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

  /**
   * The scenario's widest layout at its current parameters: the Protocol level with every step
   * shown. Computed once per set of events and measure, so stepping does not change it.
   */
  private widestWidth(scenario: Parameters<typeof layout>[0]['scenario']): number {
    const events = this.player.playback.events;
    if (this.widest?.events !== events || this.widest.measure !== this.measure) {
      const { width } = layout({
        scenario,
        labels: this.options.labels,
        level: 'protocol',
        cursor: events.length,
        expanded: new Set(),
        measure: this.measure,
      });
      this.widest = { events, measure: this.measure, width };
    }
    return this.widest.width;
  }

  /** Tells the owner the width the region needs, only when it changes. */
  private reportWidth(natural: number): void {
    if (!this.options.onNaturalWidth || natural === this.reportedWidth) return;
    // The region's vertical scrollbar takes width from the diagram; read once per change,
    // and again at the next render while the region is not yet on the page.
    const connected = this.root.isConnected;
    this.reportedWidth = connected ? natural : -1;
    const scrollbar = natural && connected ? this.root.offsetWidth - this.root.clientWidth : 0;
    this.options.onNaturalWidth(natural ? natural + scrollbar : 0);
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
    this.root.scrollTo({ top, left, behavior: reducedMotion() ? 'instant' : 'smooth' });
  }

  /**
   * Makes one arrow the diagram's tab stop (02 diagram.arrow_activation): the arrow of step
   * `index` when it is shown, else the current step's, else the first. Returns it.
   */
  private rove(index?: number): SVGGElement | undefined {
    const arrows = [...this.root.querySelectorAll<SVGGElement>(ARROW)];
    const at = (i: number | undefined) => arrows.find((a) => arrowIndex(a) === i);
    const current = this.root.querySelector<SVGGElement>(`[data-current] > ${ARROW}`) ?? undefined;
    const stop = at(index) ?? current ?? arrows[0];
    for (const a of arrows) a.tabIndex = a === stop ? 0 : -1;
    return stop;
  }

  /** Moves focus to another arrow and scrolls the region, not the page, to show it. */
  private focusArrow(target: SVGGElement): void {
    this.rove(arrowIndex(target));
    target.focus({ preventScroll: true });
    this.reveal(target);
  }

  /** Scrolls the region, not the page, only as far as needed to show an arrow. */
  private reveal(target: SVGGElement): void {
    const region = this.root.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    const margin = 8;
    const top = region.top + this.headerHeight() + margin;
    let dy = 0;
    if (box.top < top) dy = box.top - top;
    else if (box.bottom > region.bottom - margin) dy = box.bottom - region.bottom + margin;
    let dx = 0;
    if (box.left < region.left + margin) dx = box.left - region.left - margin;
    else if (box.right > region.right - margin)
      dx = Math.min(box.right - region.right + margin, box.left - region.left - margin);
    if (dx || dy) this.root.scrollBy({ top: dy, left: dx, behavior: 'instant' });
  }

  /** Height of the participant names' band. */
  private headerHeight(): number {
    const header = this.root.querySelector<HTMLElement>('.diagram-head');
    return header ? Number(header.dataset['header'] ?? 0) : 0;
  }

  private readonly onClick = (event: Event): void => {
    const index = arrowIndex(event.target);
    if (index !== undefined) {
      const arrow = (event.target as Element).closest<SVGGElement>(ARROW);
      if (arrow) this.rove(index);
      arrow?.focus({ preventScroll: true });
      this.options.jump?.(index + 1);
      return;
    }
    const group = (event.target as Element).closest<HTMLElement | SVGElement>('[data-group]');
    if (!group?.dataset['group']) return;
    group.focus({ preventScroll: true });
    this.toggleGroup(group.dataset['group']);
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (arrowIndex(event.target) !== undefined) {
      this.arrowKey(event);
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const group = (event.target as Element).closest<SVGGElement>('[data-group]');
    if (!group?.dataset['group']) return;
    event.preventDefault();
    this.toggleGroup(group.dataset['group']);
  };

  /** Keys on a focused arrow: Enter and Space jump to it; Up, Down, Home and End move focus. */
  private arrowKey(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = arrowIndex(event.target);
    if (index === undefined) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.options.jump?.(index + 1);
      return;
    }
    const arrows = [...this.root.querySelectorAll<SVGGElement>(ARROW)];
    const at = arrows.findIndex((a) => arrowIndex(a) === index);
    const to =
      event.key === 'ArrowUp'
        ? at - 1
        : event.key === 'ArrowDown'
          ? at + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? arrows.length - 1
              : undefined;
    if (to === undefined) return;
    // At the first or last arrow the key does nothing, rather than scrolling the region.
    event.preventDefault();
    const target = arrows[to];
    if (target) this.focusArrow(target);
  }
}
