import { describe, expect, it } from 'vitest';
import { contrast, luminance } from '../../src/design/contrast';

describe('contrast', () => {
  it('matches the WCAG extremes', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
  });

  it('treats #rgb shorthand like #rrggbb (minified CSS uses it)', () => {
    expect(luminance('#111')).toBe(luminance('#111111'));
    expect(contrast('#fff', '#111')).toBeCloseTo(18.88, 2);
  });

  it('rejects anything that is not a hex colour', () => {
    expect(() => luminance('red')).toThrow(/#rrggbb/);
  });
});
