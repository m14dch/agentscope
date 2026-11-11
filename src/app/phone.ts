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
