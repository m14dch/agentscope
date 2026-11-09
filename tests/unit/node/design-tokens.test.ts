import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import colorNames from 'color-name';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { contrast } from '../../../src/design/contrast';

const ROOT = new URL('../../../', import.meta.url).pathname;
const TOKENS_CSS = 'src/styles/tokens.css';
const spec = parse(readFileSync(join(ROOT, 'specifications/02-ui-ux.yaml'), 'utf8')) as {
  design: { colour: { tokens: Record<string, string> } };
};
const specTokens = spec.design.colour.tokens;

function cssTokens(): Record<string, string> {
  const css = readFileSync(join(ROOT, TOKENS_CSS), 'utf8');
  return Object.fromEntries(
    [...css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]+);/gi)].map((m) => [m[1], m[2]]),
  );
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

// ---------------------------------------------------------------- colour guard
const SCANNED = /\.(css|ts|js|mjs|html|svg|json|webmanifest)$/;
const HEX = /#[0-9a-f]{3,8}\b/i;
const FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const SYSTEM = [
  'accentcolor',
  'accentcolortext',
  'activetext',
  'buttonborder',
  'buttonface',
  'buttontext',
  'canvas',
  'canvastext',
  'field',
  'fieldtext',
  'graytext',
  'highlight',
  'highlighttext',
  'linktext',
  'mark',
  'marktext',
  'selecteditem',
  'selecteditemtext',
  'visitedtext',
];
const NAMED = new RegExp(`\\b(?:${[...Object.keys(colorNames), ...SYSTEM].join('|')})\\b`, 'i');
const PAINT =
  '(?:fill|stroke|color|stop-color|flood-color|lighting-color|background|theme_color|background_color)';
const QUOTED = `(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`)`;

/** Code without comments, so prose such as "issue #123" is not mistaken for a colour. */
function withoutComments(path: string, text: string): string {
  const block = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return /\.(ts|js|mjs)$/.test(path) ? block.replace(/(^|[^:])\/\/.*$/gm, '$1') : block;
}

/** Values that style something: declarations, style attributes, SVG paint, DOM style writes. */
function styleValues(path: string, code: string): string[] {
  const values: string[] = [];
  const add = (pattern: string) => {
    for (const m of code.matchAll(new RegExp(pattern, 'g'))) {
      values.push(m.slice(1).find((group) => group !== undefined) ?? '');
    }
  };
  if (path.endsWith('.css')) add('[\\w-]+\\s*:\\s*([^;{}]+)[;}]');
  add(`style\\s*=\\s*${QUOTED}`);
  add(`\\b${PAINT}\\s*=\\s*${QUOTED}`);
  add(`"${PAINT}"\\s*:\\s*"([^"]*)"`);
  add(`\\.style\\.[a-zA-Z]+\\s*=\\s*${QUOTED}`);
  add(`setProperty\\(\\s*['"][^'"]+['"]\\s*,\\s*${QUOTED}`);
  add(`setAttribute\\(\\s*['"](?:fill|stroke|color|style)['"]\\s*,\\s*${QUOTED}`);
  return values;
}

/** Drops var() names but keeps their fallbacks: var(--x, red) leaves "red". */
function withoutVariableNames(value: string): string {
  return value.replace(/var\(\s*--[\w-]+\s*,?/g, '(');
}

function colourOffenders(path: string, text: string): string[] {
  const offenders: string[] = [];
  const code = withoutComments(path, text);
  for (const [i, line] of code.split('\n').entries()) {
    const stripped = line.replace(/#\/[a-z]+/g, ''); // hash routes such as #/design
    if (HEX.test(stripped) || FUNCTION.test(stripped)) {
      offenders.push(`${path}:${i + 1}: ${line.trim()}`);
    }
  }
  for (const value of styleValues(path, code)) {
    if (NAMED.test(withoutVariableNames(value))) offenders.push(`${path}: ${value.trim()}`);
  }
  return offenders;
}

describe('colour guard', () => {
  it.each([
    ['a.css', '.c { color: var(--color-ink, red); }'],
    ['a.css', '.c { color: red }'],
    ['a.css', '.c{background:blue}'],
    ['a.ts', "el.innerHTML = `<p style='color: red'>x</p>`;"],
    ['a.ts', "svg = `<path fill='green' />`;"],
    ['a.ts', "el.style.color = 'orange';"],
    ['a.ts', "el.setAttribute('fill', 'purple');"],
    ['a.ts', "el.style.setProperty('color', 'teal');"],
    ['a.js', "const c = '#ff0000';"],
    ['a.webmanifest', '{ "theme_color": "navy" }'],
    ['a.css', '.c { color: color-mix(in srgb, var(--color-ink), white); }'],
    ['a.css', '.c { outline-color: CanvasText; }'],
  ])('catches %s: %s', (path, text) => {
    expect(colourOffenders(path, text)).not.toEqual([]);
  });

  it.each([
    ['a.ts', '// see issue #123'],
    ['a.ts', 'const lead = "Peach Red marks the current step; red never stands alone";'],
    ['a.ts', "location.hash = '#/design';"],
    ['a.css', '.c { color: var(--color-ink); border: 0; }'],
    ['a.css', '.c { stroke: context-stroke; fill: none; }'],
  ])('allows %s: %s', (path, text) => {
    expect(colourOffenders(path, text)).toEqual([]);
  });

  it('finds no colour value outside tokens.css (src/, public/, index.html)', () => {
    const scanned = [
      ...files(join(ROOT, 'src')),
      ...files(join(ROOT, 'public')),
      join(ROOT, 'index.html'),
    ].filter((path) => SCANNED.test(path) && !path.endsWith(TOKENS_CSS));
    expect(scanned.length).toBeGreaterThan(5);
    const offenders = scanned.flatMap((path) =>
      colourOffenders(path.slice(ROOT.length), readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------- tokens
describe('design tokens', () => {
  it('tokens.css defines exactly the colours in 02-ui-ux.yaml', () => {
    expect(cssTokens()).toEqual(specTokens);
  });

  it('meets the contrast rules of 02-ui-ux.yaml', () => {
    const t = (name: string) => specTokens[name] ?? '';
    for (const background of ['paper', 'surface']) {
      for (const name of ['ink', 'ink-muted', 'accent-text', 'information', 'success', 'error']) {
        expect(contrast(t(name), t(background)), `${name} on ${background}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      expect(
        contrast(t('accent'), t(background)),
        `accent on ${background}`,
      ).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(t('ink'), t('selection')), 'ink on selection').toBeGreaterThanOrEqual(4.5);
  });
});

describe('bundled font licences', () => {
  it('public/licenses/fonts.txt contains each font package licence', () => {
    const shipped = readFileSync(join(ROOT, 'public/licenses/fonts.txt'), 'utf8');
    for (const pkg of ['inter', 'jetbrains-mono']) {
      const licence = readFileSync(
        join(ROOT, `node_modules/@fontsource-variable/${pkg}/LICENSE`),
        'utf8',
      );
      expect(shipped, pkg).toContain(licence.trim());
    }
  });
});
