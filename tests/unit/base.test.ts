import { describe, expect, it } from 'vitest';
import { appUrl, normalizeBase } from '../../src/base';

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

describe('normalizeBase', () => {
  it('adds missing leading and trailing slashes', () => {
    expect(normalizeBase('agentscope')).toBe('/agentscope/');
    expect(normalizeBase('/agentscope')).toBe('/agentscope/');
    expect(normalizeBase('/agentscope/')).toBe('/agentscope/');
  });

  it('keeps a root base', () => {
    expect(normalizeBase('/')).toBe('/');
  });

  it('rejects an empty base', () => {
    expect(() => normalizeBase('')).toThrow(/must not be empty/);
    expect(() => normalizeBase('  ')).toThrow(/must not be empty/);
  });

  it('rejects relative and full-URL bases', () => {
    expect(() => normalizeBase('./')).toThrow(/absolute path/);
    expect(() => normalizeBase('https://cdn.example/x/')).toThrow(/absolute path/);
    expect(() => normalizeBase('//cdn.example/x/')).toThrow(/absolute path/);
  });

  it('accepts unusual but valid path segments', () => {
    expect(normalizeBase('/foo:bar/')).toBe('/foo:bar/');
    expect(normalizeBase('/v1.0/')).toBe('/v1.0/');
  });
});
