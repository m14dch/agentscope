import { describe, expect, it } from 'vitest';
import {
  arrowLabel,
  errorKind,
  estimate,
  layout,
  type DiagramLayout,
  type Mode,
  SIZES,
  wrap,
} from '../../src/diagram/model.ts';
import { renderSvg } from '../../src/diagram/render.ts';
import { loadRegistry, participantLabels } from '../../src/scenarios/registry.ts';
import type { Scenario, ScenarioEvent } from '../../src/scenarios/types.ts';

const registry = loadRegistry();
const labels = participantLabels();
const scenarios = Object.values(registry);

function scenario(id: string): Scenario {
  const scn = registry[id];
  if (!scn) throw new Error(`no scenario ${id}`);
  return scn;
}

const build = (
  scn: Scenario,
  mode: Mode,
  cursor: number,
  expanded: Iterable<string> = [],
): DiagramLayout => layout({ scenario: scn, labels, mode, cursor, expanded: new Set(expanded) });

describe('error arrows', () => {
  it('mark exactly where failures occur on the wire, with their kind', () => {
    const found: string[] = [];
    for (const scn of scenarios) {
      for (const e of scn.events) {
        const kind = errorKind(e);
        if (kind) found.push(`${e.id} ${kind}`);
      }
    }
    expect(found.sort()).toEqual([
      'mcp-jsonrpc-error:mcp-23 protocol',
      'mcp-not-found:mcp-21 transport',
      'mcp-not-found:mcp-23 tool execution',
      'mcp-unauthorized:mcp-21 transport',
      'mcp-unauthorized:mcp-23 tool execution',
    ]);
  });

  it('label the kind after ×', () => {
    const e = scenario('mcp-not-found').events.find((x) =>
      x.id.endsWith(':mcp-23'),
    ) as ScenarioEvent;
    expect(arrowLabel(e)).toBe('× tool execution error · MCP · tools/call result');
    const model = { ...e, protocol: 'LLM_API' as const, payload: {}, http: { status: 503 } };
    expect(errorKind(model)).toBe('model');
  });
});

describe('labels', () => {
  const events = scenario('mcp-balance').events;
  const label = (id: string): string =>
    arrowLabel(events.find((e) => e.id === id) as ScenarioEvent);

  it('prefix protocol messages and leave internal steps plain', () => {
    expect(label('mcp-14')).toBe('MCP · tools/call');
    expect(label('mcp-10')).toBe('LLM API · Submit messages and tool definitions');
    expect(label('mcp-19')).toBe('DB · Query current balance');
    expect(label('mcp-17')).toBe('HTTP · GET /customers/123/balance');
    expect(label('mcp-21')).toBe('HTTP 200 OK');
    expect(label('mcp-08')).toBe('Map tool schemas to provider format');
    expect(label('mcp-09')).toBe('Ask current balance');
  });

  it('wrap at spaces within the width', () => {
    const text = 'Agent (host application / RAG orchestrator)';
    const lines = wrap(text, 102);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(text);
    for (const line of lines) expect(estimate(line) <= 102 || !line.includes(' ')).toBe(true);
    for (const line of wrap('a b c d e f g h i j k l m n o p', 40))
      expect(estimate(line)).toBeLessThanOrEqual(40);
  });
});

describe('protocol mode', () => {
  const scn = scenario('mcp-balance');

  it('shows events up to the cursor and keeps every row in place', () => {
    const at5 = build(scn, 'protocol', 5);
    const at20 = build(scn, 'protocol', 20);
    expect(at5.arrows).toHaveLength(5);
    expect(at20.arrows.slice(0, 5).map((a) => a.y)).toEqual(at5.arrows.map((a) => a.y));
    expect(at5.height).toBe(at20.height);
    expect(build(scn, 'protocol', 0).arrows).toHaveLength(0);
  });

  it('emphasizes the current step and its pair, and nothing else', () => {
    const atResponse = build(scn, 'protocol', 15); // mcp-15 is internal; use the tools/call result
    expect(atResponse.arrows.filter((a) => a.emphasized).map((a) => a.event.id)).toEqual([
      'mcp-15',
    ]);
    const cursor = scn.events.findIndex((e) => e.id === 'mcp-23') + 1;
    const model = build(scn, 'protocol', cursor);
    expect(model.arrows.filter((a) => a.emphasized).map((a) => a.event.id)).toEqual([
      'mcp-14',
      'mcp-23',
    ]);
    expect(model.arrows.filter((a) => a.visibility === 'current').map((a) => a.event.id)).toEqual([
      'mcp-23',
    ]);
  });

  it('spaces lifelines between 110 and 240 px, in scenario order', () => {
    for (const s of scenarios) {
      const xs = build(s, 'protocol', s.events.length).lifelines.map((l) => l.x);
      for (let i = 1; i < xs.length; i += 1) {
        const gap = (xs[i] ?? 0) - (xs[i - 1] ?? 0);
        expect(gap, s.id).toBeGreaterThanOrEqual(SIZES.minSpacing);
        expect(gap, s.id).toBeLessThanOrEqual(SIZES.maxSpacing);
      }
      expect(build(s, 'protocol', 0).lifelines.map((l) => l.id)).toEqual(s.participants);
    }
  });
});

describe('architecture mode', () => {
  const scn = scenario('mcp-balance');

  it('collapses each phase into one group and marks the current one', () => {
    const cursor = scn.events.findIndex((e) => e.id === 'mcp-14') + 1;
    const model = build(scn, 'architecture', cursor);
    expect(model.groups.map((g) => g.phase.id)).toEqual(scn.phases.map((p) => p.id));
    expect(model.groups.filter((g) => g.current).map((g) => g.phase.id)).toEqual(['tool']);
    expect(model.groups.every((g) => g.arrows.length === 0)).toBe(true);
    expect(model.arrows).toHaveLength(0);
    expect(model.groups[0]?.caption).toBe('▸ Client setup and optional discovery · 3 steps');
  });

  it("shows an expanded group's events up to the cursor", () => {
    const cursor = scn.events.findIndex((e) => e.id === 'mcp-14') + 1;
    const model = build(scn, 'architecture', cursor, ['tool', 'answer']);
    const tool = model.groups.find((g) => g.phase.id === 'tool');
    expect(tool?.arrows.map((a) => a.event.id)).toEqual(['mcp-13', 'mcp-14']);
    expect(tool?.caption.startsWith('▾ ')).toBe(true);
    expect(model.groups.find((g) => g.phase.id === 'answer')?.arrows).toEqual([]);
  });
});

/** Estimated label boxes never overlap; real fonts are checked in the browser tests. */
function boxes(
  model: DiagramLayout,
): { name: string; x1: number; x2: number; y1: number; y2: number }[] {
  const arrows = [...model.arrows, ...model.groups.flatMap((g) => g.arrows)];
  const out = arrows.map((a) => ({
    name: a.label,
    x1: a.labelX,
    x2: a.labelX + estimate(a.label),
    y1: a.labelY - SIZES.fontSize,
    y2: a.labelY + 3,
  }));
  for (const g of model.groups) {
    out.push({ name: g.phase.id, x1: g.x1, x2: g.x2, y1: g.y, y2: g.y + g.height });
  }
  return out;
}

describe('no overlapping labels', () => {
  it('in any scenario, mode and expansion', () => {
    for (const scn of scenarios) {
      const all = scn.phases.map((p) => p.id);
      for (const model of [
        build(scn, 'protocol', scn.events.length),
        build(scn, 'architecture', scn.events.length, all),
      ]) {
        const items = boxes(model).filter((b) => !model.groups.some((g) => g.phase.id === b.name));
        for (let i = 0; i < items.length; i += 1) {
          for (let j = i + 1; j < items.length; j += 1) {
            const a = items[i];
            const b = items[j];
            if (!a || !b) continue;
            const overlap = a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
            expect(overlap, `${scn.id}: "${a.name}" and "${b.name}"`).toBe(false);
          }
          expect((items[i]?.x2 ?? 0) <= model.width, `${scn.id}: ${items[i]?.name} fits`).toBe(
            true,
          );
        }
        for (let i = 1; i < model.groups.length; i += 1) {
          const prev = model.groups[i - 1];
          const next = model.groups[i];
          if (prev && next) expect(next.y, scn.id).toBeGreaterThanOrEqual(prev.y + prev.height);
        }
      }
    }
  });
});

describe('render', () => {
  it('escapes text and marks the current step', () => {
    const scn = structuredClone(scenario('mcp-balance'));
    (scn.events[0] as ScenarioEvent).operation = '<script>alert(1)</script> & "x"';
    const svg = renderSvg(build(scn, 'protocol', 1), 'Title <b>');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
    expect(svg).toContain('aria-label="Title &lt;b&gt;"');
    expect(svg.match(/data-current=""/g)).toHaveLength(1);
    expect(svg).toContain('arrow--current');
  });

  it('gives requests a filled head and responses an open one', () => {
    const scn = scenario('mcp-balance');
    const svg = renderSvg(build(scn, 'protocol', 3), 'T', 'd');
    expect(svg).toContain('marker-end="url(#d-request)"');
    expect(svg).toContain('marker-end="url(#d-response)"');
  });
});
