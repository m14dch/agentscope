/**
 * Mounts the sequence diagram for one scenario and keeps it in step with a Player:
 * mode switching keeps the cursor, the group the cursor enters expands, groups expand or
 * collapse on click, Enter or Space, and the current step stays in view (02-ui-ux.yaml diagram, modes).
 */
import type { Player } from '../engine/player.ts';
import { currentGroupKey, estimate, layout, type Measure, type Mode } from './model.ts';
import { Expansion } from './expansion.ts';
import { renderSvg } from './render.ts';
import { renderList } from './list.ts';
import { phoneQuery } from '../app/phone.ts';

export interface DiagramOptions {
  labels: Readonly<Record<string, string>>;
  mode?: Mode;
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
  private viewMode: Mode;
  private readonly expansion = new Expansion();
  private selected: ReadonlySet<number> = new Set();
  private held = false;
  private readonly unsubscribe: () => void;
  private readonly root: HTMLElement;
  private readonly player: Player;
  private readonly options: DiagramOptions;
  private measure: Measure = estimate;
  private destroyed = false;
  /** Mode and cursor the region last scrolled to. */
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
    this.viewMode = options.mode ?? 'architecture';
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

  get mode(): Mode {
    return this.viewMode;
  }

  /** Switches between architecture and protocol mode; the cursor stays where it is. */
  setMode(mode: Mode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
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
    // The group the cursor enters expands; a waiting Compare pane has no current group.
    this.expansion.follow(this.held ? undefined : currentGroupKey(scenario, this.player.cursor));
    const model = layout({
      scenario,
      labels: this.options.labels,
      mode: this.viewMode,
      cursor: this.player.cursor,
      expanded: this.expansion.expanded,
      measure: this.measure,
      selected: this.selected,
      held: this.held,
    });
    const title = `${scenario.title}, ${this.viewMode} view, step ${this.player.cursor} of ${this.player.playback.length}`;
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
    const position = `${this.viewMode}:${this.player.cursor}`;
    if (position !== this.scrolledTo) {
      this.scrolledTo = position;
      this.scrollToCurrent();
    }
  }

  /** Scrolls the region (never the page) so the current step or group is in view. */
  private scrollToCurrent(): void {
    // The innermost current element: the step inside an expanded current group (it follows
    // the group in document order), else the collapsed group or the protocol step. A group
    // frame can be wider than the region, which would leave its step out of view.
    const all = this.root.querySelectorAll<Element>('[data-current]');
    const current = all[all.length - 1];
    if (!current) return;
    const region = this.root.getBoundingClientRect();
    const box = current.getBoundingClientRect();
    const margin = 24;
    // The pinned participant names cover the top of the region.
    const header = this.headerHeight();
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
