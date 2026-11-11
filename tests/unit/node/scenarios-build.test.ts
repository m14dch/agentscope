import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseSpec } from '../../../scripts/spec-sources.ts';
import { ScenarioBuildError, specsModule } from '../../../scripts/vite-scenarios.ts';

const SPECS = join(import.meta.dirname, '../../../specifications');
let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Copies the specifications and applies one edit to the parsed MCP scenarios file. */
function brokenCopy(
  edit: (mcp: { scenarios: { events: Record<string, unknown>[] }[] }) => void,
): string {
  dir = mkdtempSync(join(tmpdir(), 'agentscope-specs-'));
  cpSync(SPECS, dir, { recursive: true });
  const file = join(dir, '04-mcp-scenarios.yaml');
  const mcp = parseSpec(readFileSync(file, 'utf8')) as Parameters<typeof edit>[0];
  edit(mcp);
  // Quote every string so dates such as 2026-07-28 stay strings.
  writeFileSync(
    file,
    stringify(mcp, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' }),
  );
  return dir;
}

function problemsOf(specDir: string): string[] {
  try {
    specsModule(specDir);
  } catch (error) {
    if (error instanceof ScenarioBuildError) return error.problems;
    throw error;
  }
  return [];
}

describe('scenario build step', () => {
  it('emits the specifications as a JSON module', () => {
    const source = specsModule(SPECS);
    expect(source.startsWith('export default JSON.parse(')).toBe(true);
  });

  it('fails on a broken event and names the scenario and event', () => {
    const specDir = brokenCopy((mcp) => {
      const event = mcp.scenarios[0]?.events[10];
      if (event) event['receiver'] = 'nobody';
    });
    expect(problemsOf(specDir)).toContain('mcp-balance/mcp-11: participant nobody not declared');
  });

  it('reports a broken event in every scenario that inherits it', () => {
    // mcp-23 answers mcp-14; the Combined scenario copies both.
    const specDir = brokenCopy((mcp) => {
      const event = mcp.scenarios[0]?.events[22];
      if (event) delete event['pair_id'];
    });
    const problems = problemsOf(specDir);
    expect(problems).toContain('mcp-balance/mcp-14: pair mcp-23 not reciprocal');
    expect(problems).toContain(
      'combined-balance-explanation/combined-balance-explanation:mcp-14: pair combined-balance-explanation:mcp-23 not reciprocal',
    );
  });
});
