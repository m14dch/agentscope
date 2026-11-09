import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, test } from './fixtures';

/**
 * Every colour the browser actually computes on the rendered pages must be a design token
 * (02-ui-ux.yaml → design.colour.tokens), transparent, none or a context paint. This catches
 * colours from any source, including named colours that a source scan cannot match reliably.
 */
const tokens = (
  parse(readFileSync('specifications/02-ui-ux.yaml', 'utf8')) as {
    design: { colour: { tokens: Record<string, string> } };
  }
).design.colour.tokens;

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 0xff}, ${n & 0xff})`;
}

const ALLOWED = new Set([
  ...Object.values(tokens).map(rgb),
  'rgba(0, 0, 0, 0)',
  'none',
  'context-stroke',
  'context-fill',
]);

const PROPERTIES = [
  'color',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'fill',
  'stroke',
  'caret-color',
  'column-rule-color',
];

for (const route of ['./', './#/design']) {
  test(`every computed colour on ${route} is a design token`, async ({ page }) => {
    await page.goto(route);
    await page.locator('#app > *').first().waitFor();
    // Expand folded content so it is checked too.
    for (const fold of await page.locator('[aria-expanded="false"]').all()) await fold.click();
    const used = await page.evaluate((properties) => {
      const found: Record<string, string[]> = {};
      for (const el of [document.documentElement, ...document.querySelectorAll('*')]) {
        for (const pseudo of [null, '::before', '::after', '::marker']) {
          const style = getComputedStyle(el, pseudo);
          if (pseudo && style.content === 'none' && pseudo !== '::marker') continue;
          for (const property of properties) {
            const value = style.getPropertyValue(property).trim();
            (found[value] ??= []).push(`${el.tagName.toLowerCase()}${pseudo ?? ''} ${property}`);
          }
        }
      }
      return found;
    }, PROPERTIES);
    const offenders = Object.entries(used)
      .filter(([value]) => !ALLOWED.has(value) && !/^url\(/.test(value))
      .map(([value, where]) => `${value}: ${where.slice(0, 3).join(', ')}`);
    expect(offenders).toEqual([]);
  });
}
