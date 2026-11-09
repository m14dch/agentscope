/**
 * Vite plugin: converts the YAML specifications to a bundled JSON module
 * (`virtual:agentscope-specs`) and fails the build if the expanded scenarios are invalid.
 * The JSON is generated on every build and never committed.
 */
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { loadScenarios } from '../src/scenarios/validate.ts';
import { SPEC_FILES, readSpecSources } from './spec-sources.ts';

export const SPECS_MODULE = 'virtual:agentscope-specs';
const RESOLVED = `\0${SPECS_MODULE}`;

export class ScenarioBuildError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Invalid scenario specifications (${problems.length} problem(s)):\n${problems.join('\n')}`,
    );
    this.problems = problems;
    this.name = 'ScenarioBuildError';
  }
}

/** Reads, expands and validates the specifications; returns the module source. */
export function specsModule(specDir: string): string {
  const sources = readSpecSources(specDir);
  const { problems } = loadScenarios(sources);
  if (problems.length) throw new ScenarioBuildError(problems);
  // JSON.parse of a string literal is faster to load than an object literal of this size.
  return `export default JSON.parse(${JSON.stringify(JSON.stringify(sources))});`;
}

export function scenariosPlugin(specDir: string): Plugin {
  return {
    name: 'agentscope-scenarios',
    resolveId: (id) => (id === SPECS_MODULE ? RESOLVED : null),
    load(id) {
      if (id !== RESOLVED) return null;
      for (const file of Object.values(SPEC_FILES)) this.addWatchFile(join(specDir, file));
      return specsModule(specDir);
    },
  };
}
