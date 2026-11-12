/**
 * Hash routes (02-ui-ux.yaml navigation.routes): #/<tab>/<scenario>/<step>[/architecture|/protocol],
 * the Overview without a level. Pure functions, so every link can be parsed, formatted and tested
 * without a browser.
 */
import type { Level } from '../diagram/zoom.ts';
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
  return {
    mcp: sources.mcp.scenarios.map((s) => s.id),
    // The question first, then the index it searches.
    rag: ['rag-query', 'rag-index'].filter((id) => sources.rag.scenarios.some((s) => s.id === id)),
    compare: [sources.comparison.compare.id],
    combined: [sources.comparison.combined.id],
  };
}

export interface Route {
  tab: Tab;
  /** On the Compare tab, the compare ID; its step counts the compare timeline. */
  scenario: string;
  step: number;
  level: Level;
}

/**
 * The level a route's last part names; the Overview has none, and /overview is read as it and
 * written without (02 navigation.routes).
 */
function levelOf(part: string | undefined): Level | undefined {
  if (part === undefined || part === 'overview') return 'overview';
  return part === 'architecture' || part === 'protocol' ? part : undefined;
}

export type Parsed = { ok: true; route: Route } | { ok: false; tab: Tab; message: string };

/**
 * The variants removed in issue 46, by tab, and the base scenario their addresses open
 * (02 navigation.removed_scenarios).
 */
export const REMOVED_SCENARIOS: Readonly<Partial<Record<Tab, Readonly<Record<string, string>>>>> = {
  mcp: {
    'mcp-resources': 'mcp-balance',
    'mcp-not-found': 'mcp-balance',
    'mcp-unauthorized': 'mcp-balance',
    'mcp-jsonrpc-error': 'mcp-balance',
    'mcp-multiple-tools': 'mcp-balance',
  },
  rag: {
    'rag-stale': 'rag-query',
    'rag-no-match': 'rag-query',
    'rag-conflict': 'rag-query',
    'rag-hybrid': 'rag-query',
    'rag-prompt-injection': 'rag-query',
  },
  combined: { 'combined-missing-terms': 'combined-balance-explanation' },
};

/** Parses a location hash; missing parts take the tab's defaults. */
export function parseRoute(hash: string, tabs: Record<Tab, string[]>): Parsed {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [tabPart = 'mcp', scenarioPart, stepPart, levelPart, ...rest] = parts;
  if (!(TABS as readonly string[]).includes(tabPart)) {
    return { ok: false, tab: 'mcp', message: `Unknown page: ${tabPart}` };
  }
  const tab = tabPart as Tab;
  const removed = REMOVED_SCENARIOS[tab];
  const base =
    scenarioPart !== undefined && removed && Object.hasOwn(removed, scenarioPart)
      ? removed[scenarioPart]
      : undefined;
  if (base !== undefined && tabs[tab].includes(base)) {
    // A removed variant's step numbers named other events, so its base opens at step 0.
    const level = levelOf(parts.slice(3).find((p) => levelOf(p) !== undefined));
    return { ok: true, route: { tab, scenario: base, step: 0, level: level ?? 'overview' } };
  }
  const scenario = scenarioPart ?? tabs[tab][0];
  if (scenario === undefined || !tabs[tab].includes(scenario)) {
    return { ok: false, tab, message: `Unknown scenario: ${scenarioPart ?? ''}` };
  }
  const step = stepPart === undefined ? 0 : /^\d+$/.test(stepPart) ? Number(stepPart) : Number.NaN;
  const level = levelOf(levelPart);
  if (Number.isNaN(step) || level === undefined || rest.length) {
    return { ok: false, tab, message: `Unknown step: ${parts.slice(2).join('/')}` };
  }
  return { ok: true, route: { tab, scenario, step, level } };
}

/** The address suffix of a level: none for the Overview. */
export function levelSuffix(level: Level): string {
  return level === 'overview' ? '' : `/${level}`;
}

export function formatRoute(route: Route): string {
  return `#/${route.tab}/${route.scenario}/${route.step}${levelSuffix(route.level)}`;
}
