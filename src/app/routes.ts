/**
 * Hash routes (02-ui-ux.yaml navigation.routes): #/<tab>/<scenario>/<step>[/protocol].
 * Pure functions, so every link can be parsed, formatted and tested without a browser.
 */
import type { Mode } from '../diagram/model.ts';
import type { SpecSources } from '../scenarios/types.ts';

export const TABS = ['mcp', 'rag', 'compare', 'combined'] as const;
export type Tab = (typeof TABS)[number];

export const TAB_LABELS: Record<Tab, string> = {
  mcp: 'MCP',
  rag: 'RAG',
  compare: 'Compare',
  combined: 'Combined',
};

/** Scenario IDs per tab, in picker order (02 navigation.tab_contents). */
export function tabScenarios(sources: SpecSources): Record<Tab, string[]> {
  const ragBase = ['rag-query', 'rag-index'].filter((id) =>
    sources.rag.scenarios.some((s) => s.id === id),
  );
  return {
    mcp: [...sources.mcp.scenarios.map((s) => s.id), ...sources.mcp.variants.map((v) => v.id)],
    rag: [...ragBase, ...sources.rag.variants.map((v) => v.id)],
    compare: [],
    combined: [
      sources.comparison.combined.id,
      ...(sources.comparison.combined.variants ?? []).map((v) => v.id),
    ],
  };
}

export interface Route {
  tab: Tab;
  /** Absent only on the Compare tab. */
  scenario?: string;
  step: number;
  mode: Mode;
}

export type Parsed = { ok: true; route: Route } | { ok: false; tab: Tab; message: string };

/** Parses a location hash; missing parts take the tab's defaults. */
export function parseRoute(hash: string, tabs: Record<Tab, string[]>): Parsed {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [tabPart = 'mcp', scenarioPart, stepPart, modePart, ...rest] = parts;
  if (!(TABS as readonly string[]).includes(tabPart)) {
    return { ok: false, tab: 'mcp', message: `Unknown page: ${tabPart}` };
  }
  const tab = tabPart as Tab;
  if (tab === 'compare') {
    return scenarioPart === undefined
      ? { ok: true, route: { tab, step: 0, mode: 'architecture' } }
      : { ok: false, tab, message: `Unknown page: compare/${scenarioPart}` };
  }
  const scenario = scenarioPart ?? tabs[tab][0];
  if (scenario === undefined || !tabs[tab].includes(scenario)) {
    return { ok: false, tab, message: `Unknown scenario: ${scenarioPart ?? ''}` };
  }
  const step = stepPart === undefined ? 0 : /^\d+$/.test(stepPart) ? Number(stepPart) : Number.NaN;
  if (Number.isNaN(step) || (modePart !== undefined && modePart !== 'protocol') || rest.length) {
    return { ok: false, tab, message: `Unknown step: ${parts.slice(2).join('/')}` };
  }
  return {
    ok: true,
    route: { tab, scenario, step, mode: modePart === 'protocol' ? 'protocol' : 'architecture' },
  };
}

export function formatRoute(route: Route): string {
  if (route.tab === 'compare' || route.scenario === undefined) return `#/${route.tab}`;
  return `#/${route.tab}/${route.scenario}/${route.step}${route.mode === 'protocol' ? '/protocol' : ''}`;
}
