import { describe, expect, it } from 'vitest';
import { guardViolations, isBuildFile } from '../e2e/guard-check';

describe('guardViolations', () => {
  it('reports every blocked request, connection and runtime request in fail mode', () => {
    expect(
      guardViolations(
        'fail',
        ['https://example.com/a'],
        ['example.com:443'],
        ['http://localhost:4173/agentscope/api/balance'],
      ),
    ).toEqual([
      'request outside the app origin: https://example.com/a',
      'connection refused by the egress proxy: example.com:443',
      'runtime API request (not a file of the build): http://localhost:4173/agentscope/api/balance',
    ]);
  });

  it('passes a clean test in fail mode', () => {
    expect(guardViolations('fail', [], [], [])).toEqual([]);
  });

  it('never fails in record mode', () => {
    expect(
      guardViolations('record', ['https://example.com/a'], ['example.com:443'], ['/x']),
    ).toEqual([]);
  });
});

describe('isBuildFile', () => {
  const files = ['index.html', 'assets/index-abc.js'];
  const at = (path: string) => new URL(path, 'http://localhost:4173');

  it('accepts the base URL, the service worker, the manifest and listed files', () => {
    for (const path of [
      '/agentscope/',
      '/agentscope/sw.js',
      '/agentscope/asset-manifest.json',
      '/agentscope/index.html',
      '/agentscope/assets/index-abc.js',
    ]) {
      expect(isBuildFile(at(path), '/agentscope/', files), path).toBe(true);
    }
  });

  it('rejects unlisted paths, paths outside the base and query strings', () => {
    for (const path of [
      '/agentscope/api/balance',
      '/assets/index-abc.js',
      '/agentscope/index.html?x=1',
      '/agentscope',
    ]) {
      expect(isBuildFile(at(path), '/agentscope/', files), path).toBe(false);
    }
  });
});
