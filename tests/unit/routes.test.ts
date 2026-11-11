import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute, type Route, tabScenarios } from '../../src/app/routes.ts';
import { specSources } from '../../src/scenarios/registry.ts';

const tabs = tabScenarios(specSources());

describe('tab contents', () => {
  it('hold exactly one scenario per use case; only RAG has two (02 navigation.tab_contents)', () => {
    expect(tabs).toEqual({
      mcp: ['mcp-balance'],
      rag: ['rag-query', 'rag-index'],
      compare: ['compare-rag-mcp'],
      combined: ['combined-balance-explanation'],
    });
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
    expect(ok('#/compare')).toEqual({
      tab: 'compare',
      scenario: 'compare-rag-mcp',
      step: 0,
      mode: 'architecture',
    });
    expect(ok('#/compare/compare-rag-mcp/12/protocol')).toMatchObject({
      step: 12,
      mode: 'protocol',
    });
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

  it("open a removed variant's base scenario at step 0, keeping the mode (02 removed_scenarios)", () => {
    expect(ok('#/mcp/mcp-not-found/3')).toEqual({
      tab: 'mcp',
      scenario: 'mcp-balance',
      step: 0,
      mode: 'architecture',
    });
    expect(ok('#/rag/rag-hybrid/12/protocol')).toEqual({
      tab: 'rag',
      scenario: 'rag-query',
      step: 0,
      mode: 'protocol',
    });
    expect(ok('#/combined/combined-missing-terms').scenario).toBe('combined-balance-explanation');
    // Only on its own tab.
    expect(parseRoute('#/rag/mcp-not-found', tabs)).toMatchObject({
      ok: false,
      message: 'Unknown scenario: mcp-not-found',
    });
  });

  it('round-trip through formatRoute', () => {
    for (const hash of [
      '#/mcp/mcp-balance/14/protocol',
      '#/rag/rag-index/0',
      '#/compare/compare-rag-mcp/12/protocol',
    ]) {
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
    expect(parseRoute('#/compare/rag-query', tabs)).toMatchObject({
      ok: false,
      tab: 'compare',
      message: 'Unknown scenario: rag-query',
    });
  });
});
