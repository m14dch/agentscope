import { describe, expect, it } from 'vitest';
import { transportLines } from '../../src/inspector/inspector.ts';
import {
  jsonTree,
  mcpBoilerplate,
  newInRequest,
  treeText,
  trackedValues,
  type TreeNode,
} from '../../src/inspector/json.ts';
import { loadRegistry } from '../../src/scenarios/registry.ts';

const registry = loadRegistry();

function find(node: TreeNode, predicate: (n: TreeNode) => boolean): TreeNode[] {
  const own = predicate(node) ? [node] : [];
  const kids = node.kind === 'leaf' ? [] : node.children;
  return [...own, ...kids.flatMap((c) => find(c, predicate))];
}

describe('payload trees', () => {
  it('reproduce every payload exactly', () => {
    let count = 0;
    for (const scn of Object.values(registry)) {
      for (const e of scn.events) {
        for (const value of [e.payload]) {
          if (value === undefined || value === null) continue;
          const tree = jsonTree(value, { fold: mcpBoilerplate });
          expect(treeText(tree), e.id).toBe(JSON.stringify(value, null, 2));
          count += 1;
        }
      }
    }
    expect(count).toBeGreaterThan(250);
  });

  it('fold jsonrpc and _meta into one line naming them', () => {
    const tree = jsonTree(
      { jsonrpc: '2.0', id: 1, params: { name: 'x', _meta: { a: 1 } } },
      { fold: mcpBoilerplate },
    );
    const folds = find(tree, (n) => n.kind === 'fold');
    expect(folds.map((f) => (f.kind === 'fold' ? f.label : ''))).toEqual(['jsonrpc', '_meta']);
    const both = jsonTree({ jsonrpc: '2.0', _meta: {}, id: 1 }, { fold: mcpBoilerplate });
    expect(
      find(both, (n) => n.kind === 'fold').map((f) => (f.kind === 'fold' ? f.label : '')),
    ).toEqual(['jsonrpc, _meta']);
  });

  it('mark tracked values, redacted values, and a changed branch once', () => {
    const tree = jsonTree(
      {
        messages: [
          { role: 'user', content: 'a' },
          { role: 'tool', content: '123' },
        ],
        token: 'Bearer <REDACTED_X>',
        id: '123',
      },
      { changed: new Set(['messages.1']), tracked: new Set(['123']) },
    );
    const marked = find(tree, (n) => n.kind !== 'fold' && n.mark !== undefined).map((n) =>
      n.kind === 'fold' ? '' : `${n.path}:${n.mark}`,
    );
    expect(marked).toEqual(['messages.1:changed', 'id:tracked']);
    expect(
      find(tree, (n) => n.kind === 'leaf' && n.redacted).map((n) =>
        n.kind === 'fold' ? '' : n.path,
      ),
    ).toEqual(['token']);
  });
});

describe('transport lines', () => {
  it('show every header of every envelope exactly once, shown or folded', () => {
    let count = 0;
    for (const scn of Object.values(registry)) {
      scn.events.forEach((e, i) => {
        const lines = transportLines(scn.events, i + 1);
        if (!e.http) {
          expect(lines).toBeUndefined();
          return;
        }
        count += 1;
        const http = e.http;
        expect(lines?.start, e.id).toBe(
          http.status !== undefined ? `HTTP ${http.status}` : `${http.method} ${http.path}`,
        );
        const all = [...(lines?.shown ?? []), ...(lines?.folded ?? [])];
        expect(Object.fromEntries(all), e.id).toEqual(http.headers ?? {});
        expect(all).toHaveLength(Object.keys(http.headers ?? {}).length);
      });
    }
    expect(count).toBe(68);
  });

  it('fold the headers a sender repeats from its previous request', () => {
    const events = registry['mcp-balance']?.events ?? [];
    const at = (id: string): number => events.findIndex((e) => e.id === id) + 1;
    expect(transportLines(events, at('mcp-02'))?.folded).toEqual([]);
    expect(transportLines(events, at('mcp-14'))?.folded.map(([k]) => k)).toEqual([
      'Accept',
      'Content-Type',
      'MCP-Protocol-Version',
      'Authorization',
    ]);
    expect(transportLines(events, at('mcp-14'))?.shown.map(([k]) => k)).toEqual([
      'Mcp-Method',
      'Mcp-Name',
    ]);
  });
});

describe('changed fields', () => {
  it('are the messages and members new since the previous LLM request', () => {
    const before = { messages: [{ role: 'system' }, { role: 'user' }], tools: [] };
    const after = {
      messages: [{ role: 'system' }, { role: 'user' }, { role: 'assistant' }],
      tools: [],
      stream: false,
    };
    expect([...newInRequest(after, before)].sort()).toEqual(['messages.2', 'stream']);
    expect(newInRequest(after, undefined).size).toBe(0);
  });

  it('match the real second MCP request: the tool call and its result are new', () => {
    const events = registry['mcp-balance']?.events ?? [];
    const requests = events.filter((e) => e.protocol === 'LLM_API' && e.message_type === 'REQUEST');
    expect([...newInRequest(requests[1]?.payload, requests[0]?.payload)]).toEqual([
      'messages.2',
      'messages.3',
    ]);
  });

  it('flatten tracked values', () => {
    expect([...trackedValues({ customerId: '123', chunkId: ['a', 'b'], balance: 1.5 })]).toEqual([
      '123',
      'a',
      'b',
      1.5,
    ]);
  });
});
