// Issue #12: the MCP module's error kinds and the earlier-revision comparison, as data.
import { describe, expect, it } from 'vitest';
import { operationLabel } from '../../src/diagram/model.ts';
import { errorLine, offersEarlierRevision } from '../../src/inspector/inspector.ts';
import { loadRegistry, participantLabels, specSources } from '../../src/scenarios/registry.ts';
import type { Json, ScenarioEvent } from '../../src/scenarios/types.ts';

const registry = loadRegistry();
const sources = specSources();
const taxonomy = sources.security.error_taxonomy ?? {};
const mcpIds = [
  ...sources.mcp.scenarios.map((s) => s.id),
  ...sources.mcp.variants.map((v) => v.id),
];

function event(id: string): ScenarioEvent {
  // Base scenario events keep their own IDs; expanded variants prefix the scenario ID.
  const [scn, own] = id.split(':') as [string, string];
  const e = registry[scn]?.events.find((x) => x.id === id || x.id === own);
  if (!e) throw new Error(`no event ${id}`);
  return e;
}

describe('error line', () => {
  it('names the kind and its error_taxonomy definition on every error step', () => {
    const cases: [string, string, string][] = [
      ['mcp-not-found:mcp-21', 'transport', 'transport'],
      ['mcp-not-found:mcp-23', 'tool execution', 'tool_execution'],
      ['mcp-unauthorized:mcp-21', 'transport', 'transport'],
      ['mcp-unauthorized:mcp-23', 'tool execution', 'tool_execution'],
      ['mcp-jsonrpc-error:mcp-23', 'protocol', 'protocol'],
    ];
    for (const [id, kind, key] of cases) {
      const line = errorLine(event(id), taxonomy);
      expect(line?.label, id).toBe(`× ${kind} error`);
      expect(line?.definition, id).toBe(taxonomy[key]);
      expect(line?.definition.length, id).toBeGreaterThan(0);
    }
    expect(taxonomy['tool_execution']).toContain('isError=true');
    expect(taxonomy['protocol']).toContain('JSON-RPC error object');
  });

  it('is absent on steps that only hand a failure on, and on successful steps', () => {
    for (const id of ['mcp-not-found:mcp-24', 'mcp-jsonrpc-error:mcp-24', 'mcp-balance:mcp-23']) {
      expect(errorLine(event(id), taxonomy), id).toBeUndefined();
    }
  });

  it('leaves the error mark out of the operation label, so the kind is stated once', () => {
    expect(operationLabel(event('mcp-not-found:mcp-23'))).toBe('MCP · tools/call result');
    expect(operationLabel(event('mcp-not-found:mcp-21'))).toBe('HTTP 404 Not Found');
  });
});

describe('earlier-revision comparison', () => {
  const earlier = sources.mcp.protocol.earlier_revision_handshake;

  it('is offered on server/discover requests only, in every MCP scenario', () => {
    for (const id of mcpIds) {
      const offered = (registry[id]?.events ?? []).filter(offersEarlierRevision).map((e) => e.id);
      expect(
        offered.map((e) => e.replace(`${id}:`, '')),
        id,
      ).toEqual(['mcp-02']);
    }
  });

  it('holds a consistent handshake of a revision before the pinned one', () => {
    expect(earlier).toBeDefined();
    if (!earlier) return;
    const pinned = sources.mcp.protocol.revision;
    expect(earlier.revision < pinned).toBe(true);
    expect(earlier.summary).toContain(earlier.revision);
    const labels = participantLabels();
    const versions: Json[] = [];
    const collect = (v: Json): void => {
      if (v === null || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) {
        if (k === 'protocolVersion') versions.push(x);
        collect(x);
      }
    };
    for (const m of earlier.messages) {
      expect(labels[m.sender], m.operation).toBeDefined();
      expect(labels[m.receiver], m.operation).toBeDefined();
      collect(m.payload);
      const header = m.http.headers?.['MCP-Protocol-Version'];
      if (header !== undefined) versions.push(header);
    }
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions)).toEqual(new Set([earlier.revision]));
    const [init, result, initialized, accepted] = earlier.messages;
    expect(init?.operation).toBe('initialize');
    expect((init?.payload as { id: number }).id).toBe((result?.payload as { id: number }).id);
    // A notification has no id and is answered with an empty 202.
    expect(Object.hasOwn(initialized?.payload as object, 'id')).toBe(false);
    expect(accepted?.http.status).toBe(202);
    expect(accepted?.payload).toBeNull();
    const session = result?.http.headers?.['Mcp-Session-Id'];
    expect(session).toBeTruthy();
    expect(initialized?.http.headers?.['Mcp-Session-Id']).toBe(session);
  });
});

describe('MCP scenarios', () => {
  it('end at CHF 12,500.75 where the balance is read, and present each variant by its lesson', () => {
    const last = (id: string): Json | undefined => registry[id]?.events.at(-1)?.payload;
    expect(last('mcp-balance')).toBe('Your current account balance is CHF 12,500.75.');
    expect(String(last('mcp-multiple-tools'))).toContain('CHF 12,500.75');
    expect(String(last('mcp-resources'))).toContain('CHF 12,500.75');
    for (const v of sources.mcp.variants) {
      expect(registry[v.id]?.headline, v.id).toBe(v.lesson);
    }
  });
});
