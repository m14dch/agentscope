import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { contrast, NON_TEXT_CONTRAST } from '../../../src/design/contrast';

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

/** Every innermost CSS rule under src/: its file, selector and declarations, without comments. */
function cssRules(): { path: string; selector: string; body: string }[] {
  return files(join(ROOT, 'src'))
    .filter((path) => path.endsWith('.css'))
    .flatMap((path) =>
      [...withoutComments(path, readFileSync(path, 'utf8')).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
        (m) => ({
          path: path.slice(ROOT.length),
          selector: (m[1] ?? '').trim().replace(/\s+/g, ' '),
          body: m[2] ?? '',
        }),
      ),
    );
}

/** A colour of 02-ui-ux.yaml by token name. */
function token(name: string): string {
  return specTokens[name] ?? '';
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

  // 02 design.colour.use: a control's border is its boundary and reaches 3:1 (WCAG 1.4.11);
  // rule is structure only. tests/e2e/colours.spec.ts checks the computed borders as rendered.
  it('draws the borders and outlines of controls only in tokens that reach 3:1', () => {
    const CONTROL = new RegExp(
      [
        String.raw`(?:^|[\s,>+~(])(?:button|select|input)(?![\w-])`,
        String.raw`\[aria-pressed`,
        ...[
          'tab',
          'icon-button',
          'chunk-select',
          'citation',
          'balance',
          'panel-toggle',
          'fold',
          'step-row',
          'projection-item',
        ].map((name) => String.raw`\.${name}(?![\w-])`),
      ].join('|'),
    );
    const found = cssRules()
      .filter((r) => CONTROL.test(r.selector))
      .flatMap((r) =>
        [...r.body.matchAll(/\b(?:border|outline)[a-z-]*:[^;]*var\(--color-([a-z-]+)\)/g)].map(
          (d) => ({ at: `${r.path} ${r.selector}`, token: d[1] ?? '' }),
        ),
      );
    expect(found.map((f) => f.at)).toContain('src/styles/base.css button');
    const offenders = found
      .filter((f) => contrast(token(f.token), token('paper')) < NON_TEXT_CONTRAST)
      .map((f) => `${f.at}: ${f.token}`);
    expect(offenders).toEqual([]);
  });

  // 02 design.colour.use: the focus ring reaches 3:1 on every background it can sit on. The
  // accent ring does on paper but not on Naples Yellow, so every selection background sets a
  // ring of its own, for itself and for the controls inside it.
  it('gives every selection background a focus ring that reaches 3:1 on it', () => {
    const rules = cssRules();
    const ring = (selector: string) =>
      /outline(?:-color)?:[^;]*var\(--color-([a-z-]+)\)/.exec(
        rules
          .filter((r) => r.selector.split(',').some((s) => s.trim() === selector))
          .map((r) => r.body)
          .join(';'),
      )?.[1];
    const reaches = (name: string | undefined) =>
      name !== undefined &&
      contrast(token(name), token('paper')) >= NON_TEXT_CONTRAST &&
      contrast(token(name), token('selection')) >= NON_TEXT_CONTRAST;
    expect(contrast(token(ring(':focus-visible') ?? ''), token('paper'))).toBeGreaterThanOrEqual(
      NON_TEXT_CONTRAST,
    );
    const selected = rules
      .filter((r) => /background(?:-color)?:\s*var\(--color-selection\)/.test(r.body))
      .flatMap((r) => r.selector.split(',').map((s) => s.trim()));
    expect(selected).toContain('.json-mark');
    const offenders = selected
      .flatMap((s) => [
        `${s}:focus-visible`,
        ...(s.includes('[aria-pressed') ? [] : [`${s} :focus-visible`]),
      ])
      .filter((f) => !reaches(ring(f)))
      .map((f) => `${f}: ${ring(f) ?? 'no ring of its own'}`);
    expect(offenders).toEqual([]);
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
