import { describe, expect, it } from 'vitest';
import { stepDelta } from '../../src/app/phone.ts';

// 02-ui-ux.yaml layout.phone.stepping_area: how far the page jumps to show a span above the bar.
describe('stepDelta', () => {
  const bar = 700;

  it('leaves a span that is already on screen above the bar', () => {
    expect(stepDelta({ top: 0, bottom: 700 }, bar)).toBe(0);
    expect(stepDelta({ top: 300, bottom: 500 }, bar)).toBe(0);
  });

  it('puts a span above the screen 8 px below the top', () => {
    expect(stepDelta({ top: -200, bottom: 100 }, bar)).toBe(-208);
  });

  it('puts a span that ends below the bar 8 px above it, when it fits', () => {
    expect(stepDelta({ top: 600, bottom: 900 }, bar)).toBe(208);
  });

  it('puts a span too tall for the screen at the top', () => {
    expect(stepDelta({ top: 600, bottom: 1400 }, bar)).toBe(592);
  });
});
