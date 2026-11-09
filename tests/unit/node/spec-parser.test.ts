import { describe, expect, it } from 'vitest';
import { parseSpec } from '../../../scripts/spec-sources.ts';

describe('specification parser', () => {
  it('types plain scalars as PyYAML safe_load does', () => {
    const text = [
      'a: y',
      'b: n',
      'c: 1e3',
      'd: yes',
      'e: On',
      'f: OFF',
      'g: 0x1F',
      'h: 010',
      'i: 1_000',
      'j: ~',
      'k:',
      'l: 1.5',
      "m: '1.5'",
      'n: 123e4567',
      'o: -3',
      'p: 0b11',
      'q: .5',
      'r: 1.0e+3',
      's: "2026-07-28"',
    ].join('\n');
    expect(parseSpec(text)).toStrictEqual({
      a: 'y',
      b: 'n',
      c: '1e3',
      d: true,
      e: true,
      f: false,
      g: 31,
      h: 8,
      i: 1000,
      j: null,
      k: null,
      l: 1.5,
      m: '1.5',
      n: '123e4567',
      o: -3,
      p: 3,
      q: 0.5,
      r: 1000,
      s: '2026-07-28',
    });
  });

  it.each([
    'd: 2026-07-28',
    'x: .inf',
    'x: -.Inf',
    'x: .nan',
    'x: 1:30',
    'x: 2026-07-28 10:00:00Z',
  ])('rejects %s, which JSON cannot carry', (text) => {
    expect(() => parseSpec(text, 'f.yaml')).toThrow(/^f\.yaml: .*JSON cannot carry; quote it/);
  });

  it('rejects duplicate keys', () => {
    expect(() => parseSpec('a: 1\na: 2', 'f.yaml')).toThrow(/^f\.yaml: Map keys must be unique/);
  });
});
