import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { parse } from 'yaml';
import { expect, test } from './fixtures';

/**
 * Every colour the browser actually computes on the rendered pages must be a design token
 * (02-ui-ux.yaml → design.colour.tokens), transparent, none or a context paint, and no shadow
 * or gradient may be used. Checked in the default state, with folded content expanded, for
 * each focusable element while it has keyboard focus, and for pseudo-elements including
 * ::selection. This catches colours from any source, including named colours.
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

const COLOURS = new Set([
  ...Object.values(tokens).map(rgb),
  'rgba(0, 0, 0, 0)',
  'none',
  'context-stroke',
  'context-fill',
  'auto', // accent-color and caret-color default; resolves to the text colour
]);

/** Colour properties whose computed value must be one of COLOURS. */
const COLOUR_PROPERTIES = [
  'color',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'text-emphasis-color',
  'column-rule-color',
  'caret-color',
  'accent-color',
];
/** Paint properties that only take effect on specific SVG elements (default black or white elsewhere). */
const ELEMENT_PROPERTIES: Record<string, string[]> = {
  stop: ['stop-color'],
  feflood: ['flood-color'],
  fedropshadow: ['flood-color'],
  fediffuselighting: ['lighting-color'],
  fespecularlighting: ['lighting-color'],
};
/** SVG paint may also reference a gradient or marker; its stops are checked as elements. */
const PAINT_PROPERTIES = ['fill', 'stroke'];
/** The only properties that apply to ::selection and ::placeholder. */
const HIGHLIGHT_PROPERTIES = ['color', 'background-color', 'text-decoration-color'];
/** Decoration the spec bans outright. */
const NONE_PROPERTIES = ['box-shadow', 'text-shadow', 'background-image'];

type Found = Record<string, string[]>;

async function computedColours(page: Page, onlyActive: boolean): Promise<Found> {
  return page.evaluate(
    ({ onlyActive, colour, paint, none, perElement, highlight }) => {
      const found: Record<string, string[]> = {};
      const record = (value: string, where: string) => (found[value] ??= []).push(where);
      const elements = onlyActive
        ? [document.activeElement].filter((el): el is Element => el !== null)
        : [document.documentElement, ...document.querySelectorAll('*')];
      for (const el of elements) {
        for (const pseudo of [
          null,
          '::before',
          '::after',
          '::marker',
          '::selection',
          '::placeholder',
        ]) {
          const style = getComputedStyle(el, pseudo);
          if ((pseudo === '::before' || pseudo === '::after') && style.content === 'none') continue;
          const where = `${el.tagName.toLowerCase()}${pseudo ?? ''}`;
          if (pseudo === '::selection' || pseudo === '::placeholder') {
            for (const p of highlight) record(style.getPropertyValue(p).trim(), `${where} ${p}`);
            const shadow = style.getPropertyValue('text-shadow').trim();
            record(shadow === 'none' ? 'none' : `text-shadow: ${shadow}`, `${where} text-shadow`);
            continue;
          }
          for (const p of [
            ...colour,
            ...(pseudo === null ? (perElement[el.tagName.toLowerCase()] ?? []) : []),
          ]) {
            record(style.getPropertyValue(p).trim(), `${where} ${p}`);
          }
          for (const p of paint) {
            const value = style.getPropertyValue(p).trim();
            record(/^url\(/.test(value) ? 'none' : value, `${where} ${p}`);
          }
          for (const p of none) {
            const value = style.getPropertyValue(p).trim();
            record(value === 'none' ? 'none' : `${p}: ${value}`, `${where} ${p}`);
          }
        }
      }
      return found;
    },
    {
      onlyActive,
      colour: COLOUR_PROPERTIES,
      paint: PAINT_PROPERTIES,
      none: NONE_PROPERTIES,
      perElement: ELEMENT_PROPERTIES,
      highlight: HIGHLIGHT_PROPERTIES,
    },
  );
}

function offenders(found: Found): string[] {
  return Object.entries(found)
    .filter(([value]) => !COLOURS.has(value))
    .map(([value, where]) => `${value}: ${where.slice(0, 3).join(', ')}`);
}

// Below 48rem each page is the column of steps (02 phone_steps); those pages are checked at a
// phone's width too, with their rows open.
const PHONE_ROUTES = new Set([
  './#/mcp/mcp-balance/23/protocol',
  './#/mcp/mcp-balance/14/architecture',
  './#/rag/rag-query/10/architecture',
  './#/compare/compare-rag-mcp/16/architecture',
]);

for (const route of [
  './',
  './#/design',
  './#/mcp/mcp-balance/23/protocol',
  './#/mcp/mcp-balance/14/architecture',
  './#/mcp/mcp-balance/2/protocol',
  // The ingestion panel with a selected chunk, overlap and the vector's dots.
  './#/rag/rag-index/10/architecture',
  // The retrieval panel: retained dots, the projection, the prompt and the answer with citations.
  './#/rag/rag-query/10/architecture',
  // Both compare panes, one of them done with its phase.
  './#/compare/compare-rag-mcp/16/architecture',
  // The combined answer with its provenance labels, sources and the evidence gap.
  './#/combined/combined-balance-explanation/35/protocol',
  // An unknown route: the error line and its link back to the tab.
  './#/compare/unknown',
]) {
  for (const phone of PHONE_ROUTES.has(route) ? [false, true] : [false])
    test(`every computed colour on ${route}${phone ? ' on a phone' : ''} is a design token`, async ({
      page,
    }) => {
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(route);
      await page.locator('#app > *').first().waitFor();
      // Expand folded content so it is checked too, then move the pointer away (no hover).
      // Query again after each click: expanding can re-render the content.
      const folded = page.locator('[aria-expanded="false"]:visible');
      for (let i = 0; i < 50 && (await folded.count()) > 0; i += 1) await folded.first().click();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(offenders(await computedColours(page, false))).toEqual([]);

      // Each focusable element while it has keyboard focus. Reload so Tab starts at the top
      // of the page instead of after the element that was clicked above.
      await page.reload();
      await page.locator('#app > *').first().waitFor();
      const focusable = await page
        .locator('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
        .count();
      for (let i = 0; i < focusable; i++) {
        await page.keyboard.press('Tab');
        const name = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60));
        expect(offenders(await computedColours(page, true)), `focus on ${name}`).toEqual([]);
      }
    });
}
