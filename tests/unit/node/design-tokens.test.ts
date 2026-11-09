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

/** Values that style something: CSS declarations, style attributes, SVG paint attributes. */
function styleValues(path: string, text: string): string[] {
  if (path.endsWith('.css')) {
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
    return [...withoutComments.matchAll(/[\w-]+\s*:\s*([^;{}]+);/g)].map((m) => m[1] ?? '');
  }
  return [
    ...[...text.matchAll(/style="([^"]*)"/g)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(/\b(?:fill|stroke|color|stop-color|flood-color)="([^"]*)"/g)].map(
      (m) => m[1] ?? '',
    ),
  ];
}

describe('design tokens', () => {
  it('tokens.css defines exactly the colours in 02-ui-ux.yaml', () => {
    expect(cssTokens()).toEqual(specTokens);
  });

  it('no colour value appears outside tokens.css (src/, public/, index.html)', () => {
    const scanned = [
      ...files(join(ROOT, 'src')),
      ...files(join(ROOT, 'public')),
      join(ROOT, 'index.html'),
    ].filter((path) => /\.(css|ts|html|svg|json)$/.test(path) && !path.endsWith(TOKENS_CSS));
    const offenders: string[] = [];
    for (const path of scanned) {
      const text = readFileSync(path, 'utf8');
      const where = path.slice(ROOT.length);
      for (const [i, line] of text.split('\n').entries()) {
        const code = line.replace(/#\/[a-z]+/g, ''); // hash routes such as #/design
        if (HEX.test(code) || FUNCTION.test(code))
          offenders.push(`${where}:${i + 1}: ${line.trim()}`);
      }
      for (const value of styleValues(path, text)) {
        if (NAMED.test(value.replace(/var\([^)]*\)/g, '')))
          offenders.push(`${where}: ${value.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('meets the contrast rules of 02-ui-ux.yaml on paper', () => {
    const paper = specTokens.paper ?? '';
    for (const name of ['ink', 'ink-muted', 'error']) {
      expect(contrast(specTokens[name] ?? '', paper), name).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(specTokens.accent ?? '', paper), 'accent').toBeGreaterThanOrEqual(3);
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
