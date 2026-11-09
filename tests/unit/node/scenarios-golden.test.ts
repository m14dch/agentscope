import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SPEC_FILES, readSpecSources } from '../../../scripts/spec-sources.ts';
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

/** PyYAML safe_load of every bundled file, as JSON. */
function pythonSources(): Record<string, unknown> {
  const script = [
    'import json, sys, yaml',
    'files = json.loads(sys.argv[2])',
    'out = {k: yaml.safe_load(open(sys.argv[1] + "/" + f, encoding="utf-8")) for k, f in files.items()}',
    'print(json.dumps(out, ensure_ascii=False, allow_nan=False))',
  ].join('\n');
  const out = execFileSync('python3', ['-c', script, SPECS, JSON.stringify(SPEC_FILES)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as Record<string, unknown>;
}

describe('scenario registry golden test', () => {
  it('bundles every file exactly as PyYAML safe_load reads it', () => {
    const bundled = JSON.parse(JSON.stringify(readSpecSources(SPECS))) as unknown;
    expect(bundled).toStrictEqual(pythonSources());
  });

  it('equals the registry of validate_specs.py', () => {
    const python = pythonRegistry();
    const { registry, problems } = buildRegistry(readSpecSources(SPECS));
    expect(problems).toEqual([]);
    expect(Object.keys(registry)).toEqual(Object.keys(python));
    // Round-trip through JSON so both sides hold plain data.
    expect(JSON.parse(JSON.stringify(registry))).toStrictEqual(python);
  });
});
