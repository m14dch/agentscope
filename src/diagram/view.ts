/**
 * Mounts the sequence diagram for one scenario and keeps it in step with a Player:
 * mode switching keeps the cursor, groups expand on click, Enter or Space, and the current
 * step stays in view (02-ui-ux.yaml diagram, modes).
 */
import type { Player } from '../engine/player.ts';
import { estimate, layout, type Measure, type Mode } from './model.ts';
import { renderSvg } from './render.ts';

export interface DiagramOptions {
  labels: Readonly<Record<string, string>>;
  mode?: Mode;
  /** Unique per page, for marker IDs. */
  id?: string;
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
  private readonly expanded = new Set<string>();
  private selected: ReadonlySet<number> = new Set();
  private readonly unsubscribe: () => void;
  private readonly root: HTMLElement;
  private readonly player: Player;
  private readonly options: DiagramOptions;
  private measure: Measure = estimate;
  private destroyed = false;
  /** Mode and cursor the region last scrolled to. */
  private scrolledTo = '';

  constructor(root: HTMLElement, player: Player, options: DiagramOptions) {
    this.root = root;
    this.player = player;
    this.options = options;
    this.viewMode = options.mode ?? 'architecture';
    root.classList.add('diagram-scroller');
    root.tabIndex = 0;
    root.addEventListener('click', this.onClick);
    root.addEventListener('keydown', this.onKey);
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

  /** Expands or collapses a group by its key (data-group). */
  toggleGroup(key: string): void {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    this.render();
  }

  isExpanded(key: string): boolean {
    return this.expanded.has(key);
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('keydown', this.onKey);
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
      focused instanceof SVGElement && this.root.contains(focused)
        ? focused.closest<SVGGElement>('[data-group]')?.dataset['group']
        : undefined;
    const model = layout({
      scenario,
      labels: this.options.labels,
      mode: this.viewMode,
      cursor: this.player.cursor,
      expanded: this.expanded,
      measure: this.measure,
      selected: this.selected,
    });
    const title = `${scenario.title}, ${this.viewMode} view, step ${this.player.cursor} of ${this.player.playback.length}`;
    this.root.innerHTML = renderSvg(
      model,
      title,
      this.options.id ?? 'diagram',
      this.options.labels,
    );
    if (focusKey) {
      const group = this.root.querySelector<SVGGElement>(`[data-group="${CSS.escape(focusKey)}"]`);
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
    const current = this.root.querySelector<SVGGElement>('[data-current]');
    if (!current) return;
    const region = this.root.getBoundingClientRect();
    const box = current.getBoundingClientRect();
    const margin = 24;
    let top = this.root.scrollTop;
    let left = this.root.scrollLeft;
    // Reveal the far edge only if the near edge stays in view; otherwise show the start.
    const fitsY = box.height <= region.height - 2 * margin;
    const fitsX = box.width <= region.width - 2 * margin;
    if (box.top < region.top + margin || (!fitsY && box.top > region.top + margin)) {
      top -= region.top + margin - box.top;
    } else if (box.bottom > region.bottom - margin) top += box.bottom - region.bottom + margin;
    if (box.left < region.left + margin || (!fitsX && box.left > region.left + margin)) {
      left -= region.left + margin - box.left;
    } else if (box.right > region.right - margin) left += box.right - region.right + margin;
    top = Math.max(0, top);
    left = Math.max(0, left);
    if (top === this.root.scrollTop && left === this.root.scrollLeft) return;
    this.root.scrollTo({ top, left, behavior: reducedMotion() ? 'instant' : 'smooth' });
  }

  private readonly onClick = (event: Event): void => {
    const group = (event.target as Element).closest<SVGGElement>('[data-group]');
    if (!group?.dataset['group']) return;
    group.focus({ preventScroll: true });
    this.toggleGroup(group.dataset['group']);
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const group = (event.target as Element).closest<SVGGElement>('[data-group]');
    if (!group?.dataset['group']) return;
    event.preventDefault();
    this.toggleGroup(group.dataset['group']);
  };
}
