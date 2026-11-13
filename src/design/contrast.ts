/**
 * WCAG 2.1 SC 1.4.11 (Non-text Contrast): the boundary that identifies a control reaches 3:1
 * against what is next to it (02-ui-ux.yaml design.colour.use).
 */
export const NON_TEXT_CONTRAST = 3;

/** The red, green and blue channels (0 to 255) of #rrggbb, #rgb or a computed rgb()/rgba(). */
function channels(colour: string): [number, number, number] {
  const value = colour.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    const n = parseInt(digits, 16);
    return [n >> 16, (n >> 8) & 0xff, n & 0xff];
  }
  // Opaque colours only: a translucent one has no contrast of its own.
  const rgb = /^rgba?\((\d+), (\d+), (\d+)(?:, 1)?\)$/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`Expected #rrggbb, #rgb or an opaque computed RGB colour, got "${colour}"`);
}

/**
 * WCAG 2 relative luminance of a #rrggbb or #rgb colour (minifiers shorten the former), or of
 * an opaque rgb() as getComputedStyle reports it.
 */
export function luminance(colour: string): number {
  const [r, g, b] = channels(colour).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
