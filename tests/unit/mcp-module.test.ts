// Issue #12: the MCP module's earlier-revision comparison, as data.
import { describe, expect, it } from 'vitest';
import { offersEarlierRevision } from '../../src/inspector/inspector.ts';
import { loadRegistry, participantLabels, specSources } from '../../src/scenarios/registry.ts';
import type { Json } from '../../src/scenarios/types.ts';

const registry = loadRegistry();
const sources = specSources();

describe('earlier-revision comparison', () => {
  const earlier = sources.mcp.protocol.earlier_revision_handshake;

  it('is offered on the server/discover request only', () => {
    const offered = (registry['mcp-balance']?.events ?? []).filter(offersEarlierRevision);
    expect(offered.map((e) => e.id)).toEqual(['mcp-02']);
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

describe('MCP scenario', () => {
  it('ends at CHF 12,500.75 where the balance is read', () => {
    expect(registry['mcp-balance']?.events.at(-1)?.payload).toBe(
      'Your current account balance is CHF 12,500.75.',
    );
  });

  it('names the failure kinds on the tools/call result (issue 46)', () => {
    // The lesson of the removed failure variants, kept as one note on the step it concerns.
    const notes = registry['mcp-balance']?.events.find((e) => e.id === 'mcp-23')?.technical_notes;
    expect(notes?.join(' ')).toMatch(/tool execution error.*protocol error.*transport/);
  });
});
