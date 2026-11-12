/**
 * The phone layout (02-ui-ux.yaml layout.phone): below 48rem each scenario and Compare is the
 * column of steps (phone_steps) instead of the control row, the diagram and the inspector.
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
