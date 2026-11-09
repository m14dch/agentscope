import { describe, expect, it } from 'vitest';
import { guardViolations } from '../e2e/guard-check';

describe('guardViolations', () => {
  it('reports every blocked request and connection in fail mode', () => {
    expect(guardViolations('fail', ['https://example.com/a'], ['example.com:443'])).toEqual([
      'request outside the app origin: https://example.com/a',
      'connection refused by the egress proxy: example.com:443',
    ]);
  });

  it('passes a clean test in fail mode', () => {
    expect(guardViolations('fail', [], [])).toEqual([]);
  });

  it('never fails in record mode', () => {
    expect(guardViolations('record', ['https://example.com/a'], ['example.com:443'])).toEqual([]);
  });
});
