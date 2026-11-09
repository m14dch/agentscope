/**
 * Reads the YAML specifications the app bundles. Parsed with YAML 1.1 rules, as PyYAML
 * does, so the TypeScript and Python registries see the same data.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { SpecSources } from '../src/scenarios/types.ts';

export const SPEC_FILES: Record<keyof SpecSources, string> = {
  product: '00-product.yaml',
  architecture: '01-architecture.yaml',
  engine: '03-simulation-engine.yaml',
  mcp: '04-mcp-scenarios.yaml',
  rag: '05-rag-scenarios.yaml',
  comparison: '06-comparison-scenarios.yaml',
  security: '07-security-protocols.yaml',
};

export function readSpecSources(specDir: string): SpecSources {
  const sources = {} as Record<string, unknown>;
  for (const [key, file] of Object.entries(SPEC_FILES)) {
    sources[key] = parse(readFileSync(join(specDir, file), 'utf8'), { version: '1.1' });
  }
  return sources as unknown as SpecSources;
}
