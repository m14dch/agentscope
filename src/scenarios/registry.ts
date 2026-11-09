/**
 * The scenario registry the app plays: expanded and validated once at startup from the
 * specifications bundled at build time.
 */
import sources from 'virtual:agentscope-specs';
import type { Registry, SpecSources } from './types.ts';
import { loadScenarios } from './validate.ts';

export class ScenarioError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid scenario data: ${problems.join('; ')}`);
    this.problems = problems;
    this.name = 'ScenarioError';
  }
}

let cached: Registry | undefined;

export function loadRegistry(): Registry {
  cached ??= checked(sources);
  return cached;
}

export function checked(specs: SpecSources): Registry {
  const { registry, problems } = loadScenarios(specs);
  if (problems.length) throw new ScenarioError(problems);
  return registry;
}
