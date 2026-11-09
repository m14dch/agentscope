import { describe, expect, it } from 'vitest';
import { appUrl } from '../../src/base';

describe('appUrl', () => {
  it('resolves paths under a project-site base', () => {
    expect(appUrl('sw.js', '/agentscope/')).toBe('/agentscope/sw.js');
    expect(appUrl('/assets/app.js', '/agentscope/')).toBe('/agentscope/assets/app.js');
  });

  it('accepts a base without a trailing slash', () => {
    expect(appUrl('sw.js', '/agentscope')).toBe('/agentscope/sw.js');
  });

  it('works for a root site', () => {
    expect(appUrl('#/rag', '/')).toBe('/#/rag');
  });
});
