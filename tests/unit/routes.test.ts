import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute, type Route, tabScenarios } from '../../src/app/routes.ts';
import { specSources } from '../../src/scenarios/registry.ts';

const tabs = tabScenarios(specSources());

describe('tab contents', () => {
  it('list the base scenarios first, then the variants', () => {
    expect(tabs.mcp[0]).toBe('mcp-balance');
    expect(tabs.mcp).toContain('mcp-jsonrpc-error');
    expect(tabs.rag.slice(0, 2)).toEqual(['rag-query', 'rag-index']);
    expect(tabs.rag).toContain('rag-prompt-injection');
    expect(tabs.combined).toEqual(['combined-balance-explanation']);
    expect(tabs.compare).toEqual([]);
  });
});

describe('routes', () => {
  const ok = (hash: string): Route => {
    const parsed = parseRoute(hash, tabs);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.route;
  };

  it('fill in defaults', () => {
    expect(ok('')).toEqual({ tab: 'mcp', scenario: 'mcp-balance', step: 0, mode: 'architecture' });
    expect(ok('#/')).toEqual(ok(''));
    expect(ok('#/rag')).toEqual({
      tab: 'rag',
      scenario: 'rag-query',
      step: 0,
      mode: 'architecture',
    });
    expect(ok('#/compare')).toEqual({ tab: 'compare', step: 0, mode: 'architecture' });
  });

  it('read scenario, step and mode', () => {
    expect(ok('#/mcp/mcp-balance/14/protocol')).toEqual({
      tab: 'mcp',
      scenario: 'mcp-balance',
      step: 14,
      mode: 'protocol',
    });
    expect(ok('#/combined/combined-balance-explanation/3').mode).toBe('architecture');
  });

  it('round-trip through formatRoute', () => {
    for (const hash of ['#/mcp/mcp-balance/14/protocol', '#/rag/rag-hybrid/0', '#/compare']) {
      expect(formatRoute(ok(hash))).toBe(hash);
    }
  });

  it('name what is unknown', () => {
    expect(parseRoute('#/nope', tabs)).toEqual({
      ok: false,
      tab: 'mcp',
      message: 'Unknown page: nope',
    });
    expect(parseRoute('#/rag/mcp-balance', tabs)).toEqual({
      ok: false,
      tab: 'rag',
      message: 'Unknown scenario: mcp-balance',
    });
    expect(parseRoute('#/mcp/mcp-balance/x', tabs)).toMatchObject({
      ok: false,
      message: 'Unknown step: x',
    });
    expect(parseRoute('#/mcp/mcp-balance/3/sideways', tabs)).toMatchObject({ ok: false });
    expect(parseRoute('#/compare/rag-query', tabs)).toMatchObject({ ok: false, tab: 'compare' });
  });
});
