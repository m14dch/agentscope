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

describe('design tokens', () => {
  it('tokens.css defines exactly the colours in 02-ui-ux.yaml', () => {
    expect(cssTokens()).toEqual(specTokens);
  });

  it('no colour value appears in src/ outside tokens.css', () => {
    const colour = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i;
    const offenders = files(join(ROOT, 'src'))
      .filter((path) => /\.(css|ts|html)$/.test(path) && !path.endsWith(TOKENS_CSS))
      .flatMap((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${path.slice(ROOT.length)}:${i + 1}` }))
          .filter(({ line }) => colour.test(line.replace(/#\/[a-z]+/g, '')))
          .map(({ at, line }) => `${at}: ${line.trim()}`),
      );
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
