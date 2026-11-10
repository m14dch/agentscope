import { describe, expect, it } from 'vitest';
import { Playback } from '../../src/engine/playback.ts';
import {
  contextModel,
  hasContext,
  SOURCE_LABELS,
  toolMessageLabel,
} from '../../src/inspector/context.ts';
import { createPlayback } from '../../src/rag/bundled.ts';
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

describe('labels the review asked for', () => {
  it('never labels the model own tool call as unseen', () => {
    const entry = at('mcp-balance', 'mcp-11').memory.find(
      (m) => m.description === 'Assistant tool-call message stored',
    );
    expect(entry?.unseen).toBe(false);
  });

  it('holds retained chunks unseen from retrieval until the grounded prompt', () => {
    const held = (id: string) =>
      at('rag-query', id).memory.find(
        (m) => m.description === 'Retained chunks held for the prompt',
      );
    expect(held('retrieve-06')).toMatchObject({ step: 6, unseen: true, added: true });
    expect(held('retrieve-09')?.unseen).toBe(true);
    expect(held('retrieve-10')?.unseen).toBe(false);
  });

  it('stores the Combined question and assembled prompt before the model sees them', () => {
    const scn = scenario('combined-balance-explanation');
    const p = new Playback(scn);
    const k = p.events.findIndex((e) => e.id.endsWith(':c-03')) + 1;
    const model = contextModel(p.events, p.snapshot(k), p.snapshot(k - 1));
    expect(model.memory.map((m) => m.description)).toEqual([
      'User question received',
      'Retained chunks held for the prompt',
      'Prompt assembled with evidence and tool names',
    ]);
    expect(model.memory.every((m) => m.unseen)).toBe(true);
    expect(model.messages).toBeUndefined();
  });

  it('labels tool data and document evidence by source (02 context_panel.provenance)', () => {
    const scn = scenario('combined-balance-explanation');
    const p = createPlayback(scn);
    const k = p.events.findIndex((e) => e.id.endsWith(':c-06')) + 1;
    const model = contextModel(p.events, p.snapshot(k), p.snapshot(k - 1));
    expect(model.memory.map((m) => [m.description, m.source])).toEqual([
      ['User question received', undefined],
      ['Retained chunks held for the prompt', 'documents'],
      ['Prompt assembled with evidence and tool names', undefined],
      ['Tool result received', 'tool'],
      ['Tool message stored in conversation', 'tool'],
    ]);
    const [system, user, call, tool] = model.messages ?? [];
    expect(system?.documents).toEqual([]);
    expect(user?.text).toBe(
      'Question: What is my current account balance, and would another account type offer better conditions?\n\nRetrieved documents:',
    );
    expect(user?.documents.map((d) => [d.documentId, d.version, d.chunkId, d.untrusted])).toEqual([
      ['account-opening.md', '1.2', 'account-opening@1.2-c50o10-001', false],
      ['everyday-account.md', '1.2', 'everyday-account@1.2-c50o10-002', false],
      ['everyday-account.md', '1.2', 'everyday-account@1.2-c50o10-001', false],
      ['account-opening.md', '1.2', 'account-opening@1.2-c50o10-002', false],
      ['savings-account.md', '1.2', 'savings-account@1.2-c50o10-001', false],
    ]);
    expect(user?.documents[0]?.text).toMatch(/^Opening an account Anyone aged 18/);
    expect(call?.tool).toBeUndefined();
    expect(tool).toMatchObject({ role: 'tool', tool: 'get_customer_balance', documents: [] });
    expect(tool?.text).toContain('12500.75');
  });

  it('labels an untrusted document block in the model-visible context', () => {
    const scn = scenario('rag-prompt-injection');
    const p = createPlayback(scn);
    const k = p.events.findIndex((e) => e.id.endsWith(':retrieve-10')) + 1;
    const user = contextModel(p.events, p.snapshot(k), undefined).messages?.find(
      (m) => m.role === 'user',
    );
    expect(user?.documents.filter((d) => d.untrusted).map((d) => d.documentId)).toEqual([
      'community-faq.md',
    ]);
  });

  it('labels a call to an unknown tool as failed, not as tool data', () => {
    const scn = scenario('mcp-jsonrpc-error');
    const p = createPlayback(scn);
    const k = p.events.findIndex((e) => e.id.endsWith(':mcp-26')) + 1;
    const model = contextModel(p.events, p.snapshot(k), p.snapshot(k - 1));
    const tool = model.messages?.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ tool: 'get_balance', source: 'tool-failed' });
    expect(toolMessageLabel('tool-failed', 'get_balance')).toBe('Tool call failed · get_balance');
    expect(
      model.memory.find((m) => m.description === 'Tool message stored in conversation')?.source,
    ).toBe('tool-failed');
    expect(SOURCE_LABELS['tool-failed']).toBe('Tool call failed');
  });

  it('labels an isError result of an existing tool as its error result, still tool data', () => {
    const scn = scenario('mcp-not-found');
    const p = createPlayback(scn);
    const k = p.events.findIndex((e) => e.id.endsWith(':mcp-26')) + 1;
    const model = contextModel(p.events, p.snapshot(k), p.snapshot(k - 1));
    const tool = model.messages?.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ tool: 'get_customer_balance', source: 'tool-error' });
    expect(toolMessageLabel('tool-error', 'get_customer_balance')).toBe(
      'Tool data · get_customer_balance error result',
    );
    expect(
      model.memory
        .filter((m) => m.description.startsWith('Tool '))
        .map((m) => [m.description, m.source]),
    ).toEqual([
      ['Tool result received', 'tool-error'],
      ['Tool message stored in conversation', 'tool-error'],
    ]);
    // A successful call stays plain tool data.
    const ok = createPlayback(scenario('mcp-balance'));
    const end = contextModel(ok.events, ok.snapshot(ok.length), undefined);
    expect(end.messages?.find((m) => m.role === 'tool')?.source).toBe('tool');
  });

  it('does not label an empty list of retained chunks as document evidence', () => {
    const p = createPlayback(scenario('rag-query'));
    p.setParameters({ similarity_threshold: 1 });
    const k = p.events.findIndex((e) => e.id === 'retrieve-06') + 1;
    expect(k).toBeGreaterThan(0);
    const entry = contextModel(p.events, p.snapshot(k), undefined).memory.find(
      (m) => m.description === 'Retained chunks held for the prompt',
    );
    expect(entry?.value).toEqual([]);
    expect(entry?.source).toBeUndefined();
  });

  it('does not label an entry with nothing to send', () => {
    expect(
      contextModel(
        [],
        {
          cursor: 0,
          lineage: {},
          state: { agent_state: [{ event: 'x', description: 'Empty', value: [] }] },
          retrieval_config: {},
        },
        undefined,
      ).memory[0]?.unseen,
    ).toBe(false);
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
