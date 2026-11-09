import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readSpecSources } from '../../../scripts/spec-sources.ts';
import { buildRegistry } from '../../../src/scenarios/expand.ts';

const ROOT = join(import.meta.dirname, '../../..');
const SPECS = join(ROOT, 'specifications');
const dir = mkdtempSync(join(tmpdir(), 'agentscope-golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function pythonRegistry(): Record<string, unknown> {
  const out = join(dir, 'registry.json');
  execFileSync(
    'python3',
    [
      join(SPECS, 'tools/validate_specs.py'),
      '--mcp-schema',
      join(SPECS, 'tools/mcp-schema-2026-07-28.json'),
      '--dump-registry',
      out,
    ],
    { stdio: 'pipe' },
  );
  return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
}

describe('scenario registry golden test', () => {
  it('equals the registry of validate_specs.py', () => {
    const python = pythonRegistry();
    const { registry, problems } = buildRegistry(readSpecSources(SPECS));
    expect(problems).toEqual([]);
    expect(Object.keys(registry)).toEqual(Object.keys(python));
    // Round-trip through JSON so both sides hold plain data.
    expect(JSON.parse(JSON.stringify(registry))).toStrictEqual(python);
  });
});
