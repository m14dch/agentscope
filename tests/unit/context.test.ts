import { describe, expect, it } from 'vitest';
import { Playback } from '../../src/engine/playback.ts';
import { contextModel, hasContext } from '../../src/inspector/context.ts';
import { loadRegistry } from '../../src/scenarios/registry.ts';
import type { Scenario } from '../../src/scenarios/types.ts';

const registry = loadRegistry();

function scenario(id: string): Scenario {
  const scn = registry[id];
  if (!scn) throw new Error(`no scenario ${id}`);
  return scn;
}

function at(id: string, eventId: string) {
  const scn = scenario(id);
  const p = new Playback(scn);
  const k = p.events.findIndex((e) => e.id === eventId) + 1;
  return contextModel(p.events, p.snapshot(k), p.snapshot(k - 1));
}

describe('context panel model', () => {
  it('holds the balance in agent state, unseen, until the follow-up model request', () => {
    const stored = at('mcp-balance', 'mcp-24');
    const entry = stored.memory.find((m) => JSON.stringify(m.value).includes('12500.75'));
    expect(entry).toMatchObject({ step: 24, unseen: true, added: true });
    expect(JSON.stringify(stored.messages)).not.toContain('12500.75');

    const sent = at('mcp-balance', 'mcp-26');
    expect(
      sent.memory
        .filter((m) => JSON.stringify(m.value).includes('12500.75'))
        .every((m) => !m.unseen),
    ).toBe(true);
    expect(JSON.stringify(sent.messages)).toContain('12500.75');
    expect(sent.messages?.filter((m) => m.added).map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(sent.tools).toBeGreaterThan(0);
  });

  it('never counts content the agent keeps to itself as seen', () => {
    const scn = scenario('mcp-resources');
    const p = new Playback(scn);
    const end = contextModel(p.events, p.snapshot(p.length), p.snapshot(p.length - 1));
    expect(end.memory.find((m) => m.description === 'OpenAPI resource stored')?.unseen).toBe(true);
    expect(end.memory.find((m) => m.description === 'User question received')?.unseen).toBe(false);
  });

  it('shows nothing seen before the first model request, and nothing for the index scenario', () => {
    expect(at('mcp-balance', 'mcp-09').messages).toBeUndefined();
    expect(hasContext(scenario('rag-index').initial_state)).toBe(false);
    expect(hasContext(scenario('rag-query').initial_state)).toBe(true);
  });

  it('keeps retrieved text unseen until the grounded prompt is sent', () => {
    const assembled = at('rag-query', 'retrieve-09');
    expect(assembled.memory.at(-1)?.unseen).toBe(true);
    expect(at('rag-query', 'retrieve-10').memory.at(-1)?.unseen).toBe(false);
  });
});

describe('tracked values', () => {
  it('keep customerId and balance consistent in every scenario', () => {
    const seen = { customerId: new Set<unknown>(), balance: new Set<unknown>() };
    for (const scn of Object.values(registry)) {
      for (const e of scn.events) {
        for (const key of ['customerId', 'balance'] as const) {
          const value = e.tracked_values?.[key];
          for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value])
            seen[key].add(v);
        }
      }
    }
    expect([...seen.customerId]).toEqual(['123']);
    expect([...seen.balance]).toEqual([12500.75]);
  });
});
