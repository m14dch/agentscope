import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
// Source scan for hex values and colour functions. Named colours are not matched in source
// (word lists flag ordinary words such as "mark"); tests/e2e/colours.spec.ts checks every
// computed colour on the rendered pages instead.
const SCANNED = /\.(css|ts|js|mjs|html|svg|json|webmanifest)$/;
const HEX = /#[0-9a-f]{3,8}\b/i;
/**
 * The approved brand images keep their own colours (02-ui-ux.yaml design.colour.use and
 * layout brand); exactly these files are skipped, nothing else in public/brand/.
 */
const BRAND_ASSETS = [
  'public/brand/agentscope-silver-dark.svg',
  'public/brand/agentscope-silver-favicon.svg',
  'public/brand/agentscope-silver-light.svg',
];
const FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;

/** Code without comments, so prose such as "issue #123" is not mistaken for a colour. */
function withoutComments(path: string, text: string): string {
  const block = text.replace(/\/\*[\s\S]*?\*\//g, '');
  // Line comments only where "//" starts a line or follows whitespace, never inside "…//…".
  return /\.(ts|js|mjs)$/.test(path) ? block.replace(/(^|\s)\/\/.*$/gm, '$1') : block;
}

function colourOffenders(path: string, text: string): string[] {
  return withoutComments(path, text)
    .split('\n')
    .map((line, i) => ({ line, at: `${path}:${i + 1}` }))
    .filter(({ line }) => {
      const stripped = line.replace(/#\/[a-z]+/g, ''); // hash routes such as #/design
      return HEX.test(stripped) || FUNCTION.test(stripped);
    })
    .map(({ line, at }) => `${at}: ${line.trim()}`);
}

describe('colour guard (source scan)', () => {
  it.each([
    ['a.css', '.c { color: #f00 }'],
    ['a.ts', "el.style.color = '#ff0000';"],
    ['a.ts', 'const s = "//"; el.style.color = "#123456";'],
    ['a.js', "ctx.fillStyle = 'rgb(255 0 0)';"],
    ['a.css', '.c { color: color-mix(in srgb, var(--color-ink), white); }'],
    ['a.webmanifest', '{ "theme_color": "#000080" }'],
    ['a.html', '<meta name="theme-color" content="hsl(0 100% 50%)">'],
  ])('catches %s: %s', (path, text) => {
    expect(colourOffenders(path, text)).not.toEqual([]);
  });

  it.each([
    ['a.ts', '// see issue #123'],
    ['a.ts', "location.hash = '#/design';"],
    ['a.css', '.c { grid-area: mark; animation-name: highlight; }'],
    ['a.css', '.c { color: var(--color-ink); border: 0; }'],
    ['a.css', ".c::after { content: 'Highlight the red arrow'; }"],
  ])('allows %s: %s', (path, text) => {
    expect(colourOffenders(path, text)).toEqual([]);
  });

  it('finds no hex value or colour function outside tokens.css', () => {
    const scanned = [
      ...files(join(ROOT, 'src')),
      ...files(join(ROOT, 'public')),
      join(ROOT, 'index.html'),
    ].filter(
      (path) =>
        SCANNED.test(path) &&
        !path.endsWith(TOKENS_CSS) &&
        !BRAND_ASSETS.includes(path.slice(ROOT.length)),
    );
    expect(scanned.length).toBeGreaterThan(5);
    const offenders = scanned.flatMap((path) =>
      colourOffenders(path.slice(ROOT.length), readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('skips only the approved brand images, which exist and do carry colour values', () => {
    expect(
      files(join(ROOT, 'public/brand'))
        .map((path) => path.slice(ROOT.length))
        .sort(),
    ).toEqual(BRAND_ASSETS);
    for (const path of BRAND_ASSETS) {
      // Without the exception they would be offenders: the exception is not stale.
      expect(colourOffenders(path, readFileSync(join(ROOT, path), 'utf8')), path).not.toEqual([]);
    }
  });
});

// ---------------------------------------------------------------- tokens
describe('design tokens', () => {
  it('tokens.css defines exactly the colours in 02-ui-ux.yaml', () => {
    expect(cssTokens()).toEqual(specTokens);
  });

  it('meets the contrast rules of 02-ui-ux.yaml', () => {
    const t = (name: string) => specTokens[name] ?? '';
    for (const name of ['ink', 'ink-muted', 'accent-text', 'error']) {
      expect(contrast(t(name), t('paper')), `${name} on paper`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t('accent'), t('paper')), 'accent on paper').toBeGreaterThanOrEqual(3);
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
