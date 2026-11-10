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
  private readonly unsubscribe: () => void;
  private readonly root: HTMLElement;
  private readonly player: Player;
  private readonly options: DiagramOptions;
  private measure: Measure = estimate;
  private destroyed = false;

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
        this.render();
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

  toggleGroup(phase: string): void {
    if (this.expanded.has(phase)) this.expanded.delete(phase);
    else this.expanded.add(phase);
    this.render(phase);
  }

  isExpanded(phase: string): boolean {
    return this.expanded.has(phase);
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe();
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('keydown', this.onKey);
    this.root.replaceChildren();
  }

  private render(focusPhase?: string): void {
    const scenario = this.player.playback.scenario;
    const model = layout({
      scenario,
      labels: this.options.labels,
      mode: this.viewMode,
      cursor: this.player.cursor,
      expanded: this.expanded,
      measure: this.measure,
    });
    const title = `${scenario.title}, ${this.viewMode} view, step ${this.player.cursor} of ${this.player.playback.length}`;
    this.root.innerHTML = renderSvg(model, title, this.options.id ?? 'diagram');
    if (focusPhase) {
      this.root.querySelector<SVGGElement>(`[data-phase="${CSS.escape(focusPhase)}"]`)?.focus();
    }
    const current = this.root.querySelector<SVGGElement>('[data-current]');
    current?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  }

  private readonly onClick = (event: Event): void => {
    const group = (event.target as Element).closest<SVGGElement>('[data-phase]');
    if (group?.dataset['phase']) this.toggleGroup(group.dataset['phase']);
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const group = (event.target as Element).closest<SVGGElement>('[data-phase]');
    if (!group?.dataset['phase']) return;
    event.preventDefault();
    this.toggleGroup(group.dataset['phase']);
  };
}
