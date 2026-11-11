/**
 * The phone layout (02-ui-ux.yaml layout.phone): below 48rem some controls move into the
 * header's menu or the bottom bar. They are moved, not copied, so every control exists once
 * and keeps its listeners, state and accessible name.
 */

/** Below 48rem (768 px): 02 layout.phone.breakpoint. Matches the 47.99rem queries in CSS. */
export const PHONE_QUERY = '(max-width: 47.99rem)';

/** The phone media query, or undefined where there is no matchMedia (unit tests). */
export function phoneQuery(): MediaQueryList | undefined {
  return typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY) : undefined;
}

/** Whether the phone layout applies now. */
export function isPhone(): boolean {
  return phoneQuery()?.matches ?? false;
}

/**
 * Moves `nodes` to the end of `target` while the phone layout applies and back to their own
 * places otherwise, until `signal` aborts. Focus on a moved control is kept.
 */
export function relocate(nodes: readonly Element[], target: Element, signal: AbortSignal): void {
  const query = phoneQuery();
  if (!query) return;
  const marks = nodes.map((node) => {
    const mark = document.createComment('');
    node.before(mark);
    return mark;
  });
  const place = (): void => {
    const active = document.activeElement;
    nodes.forEach((node, i) => {
      if (query.matches) target.append(node);
      else marks[i]?.after(node);
    });
    if (active instanceof HTMLElement && !active.isConnected) return;
    if (active instanceof HTMLElement && nodes.some((n) => n.contains(active)))
      active.focus({ preventScroll: true });
  };
  place();
  query.addEventListener('change', place, { signal });
}

/** Keys that scroll the page when nothing on the page handles them. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

/** How long after the learner's input a scroll of the page counts as theirs, in ms. */
const INPUT_WINDOW = 1000;

/**
 * Tells the learner's own scrolling of the page (02 layout.phone.stepping_area): a scroll of
 * the page counts as theirs only when it follows their input, a wheel, a touch that moves
 * (a tap that only steps does not count), a scrolling
 * key nothing else handled, or a press on the scrollbar. Scrolls the browser makes by itself
 * (scroll anchoring, clamping when content shrinks) and the app's own jumps never count.
 */
export class PageScroll {
  private user = false;
  /** Until when a scroll of the page follows the learner's input (performance.now()). */
  private armedUntil = 0;
  /** A press on the scrollbar arms until it is released. */
  private pressing = false;
  private readonly controller = new AbortController();

  constructor() {
    if (typeof window === 'undefined') return;
    const signal = this.controller.signal;
    const arm = (): void => {
      this.armedUntil = performance.now() + INPUT_WINDOW;
    };
    // A touch counts once it moves: a tap on Next must not make the next scroll the learner's.
    for (const type of ['wheel', 'touchmove'] as const)
      window.addEventListener(type, arm, { passive: true, signal });
    window.addEventListener(
      'keydown',
      (e) => {
        if (!SCROLL_KEYS.has(e.key)) return;
        // Decide after every handler ran: a key the app used for stepping is not a scroll.
        setTimeout(() => {
          if (!e.defaultPrevented) arm();
        });
      },
      { signal },
    );
    // The scrollbar belongs to the root element: a press there, not on the page's content.
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target === document.documentElement) this.pressing = true;
      },
      { signal },
    );
    window.addEventListener(
      'pointerup',
      () => {
        if (!this.pressing) return;
        this.pressing = false;
        arm();
      },
      { signal },
    );
    // The browser took the pointer over (for example to scroll): the press has ended.
    window.addEventListener(
      'pointercancel',
      () => {
        this.pressing = false;
      },
      { signal },
    );
    window.addEventListener(
      'scroll',
      () => {
        if (this.pressing || performance.now() <= this.armedUntil) this.user = true;
      },
      { passive: true, signal },
    );
  }

  /** Whether the learner scrolled the page since the last explicit step action. */
  get userScrolled(): boolean {
    return this.user;
  }

  /** An explicit step action: the stepping area may be brought back. */
  reset(): void {
    this.user = false;
    this.armedUntil = 0;
    this.pressing = false;
  }

  /** Scrolls the page by `delta` at once, as the app's own jump, which never counts. */
  jumpBy(delta: number): void {
    this.armedUntil = 0;
    window.scrollTo({ top: window.scrollY + delta, behavior: 'instant' });
  }

  destroy(): void {
    this.controller.abort();
  }
}

/** A span of the page in viewport coordinates. */
export interface Span {
  top: number;
  bottom: number;
}

/** Top margin of the stepping area after a jump (02 layout.phone.stepping_area). */
const MARGIN = 8;

/**
 * How far to scroll so `span` lies between the screen's top (plus a margin) and `limit`, the
 * top of the bottom bar: 0 when it already does; otherwise the span's top goes to the margin,
 * or, when only its end is below the bar and it fits, its end just above the bar.
 */
export function stepDelta(span: Span, limit: number): number {
  if (span.top >= 0 && span.bottom <= limit) return 0;
  const fits = span.bottom - span.top <= limit - 2 * MARGIN;
  if (span.top < 0 || !fits) return span.top - MARGIN;
  return span.bottom - limit + MARGIN;
}
