import { describe, expect, it } from 'vitest';
import {
  estimate,
  layout,
  type DiagramLayout,
  type Level,
  operationLabel,
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
  level: Level,
  cursor: number,
  expanded: Iterable<string> = [],
): DiagramLayout => layout({ scenario: scn, labels, level, cursor, expanded: new Set(expanded) });

describe('labels', () => {
  const events = scenario('mcp-balance').events;
  const label = (id: string): string =>
    operationLabel(events.find((e) => e.id === id) as ScenarioEvent);

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

describe('Protocol level', () => {
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

describe('Architecture level', () => {
  const scn = scenario('mcp-balance');

  it('collapses each phase into one group and marks the current one', () => {
    const cursor = scn.events.findIndex((e) => e.id === 'mcp-14') + 1;
    const model = build(scn, 'architecture', cursor);
    // The tool call resumes after its backend call: groups follow the events.
    expect(model.groups.map((g) => g.key)).toEqual([
      'setup',
      'discovery',
      'question',
      'planning',
      'tool',
      'backend',
      'tool#2',
      'context',
      'generation',
      'answer',
    ]);
    const resumed = model.groups.find((g) => g.key === 'tool#2');
    expect(resumed?.continued).toBe(true);
    expect(resumed?.takeaway).toEqual([]);
    expect(resumed?.caption).toBe('▸ MCP tool call, continued · 3 steps');
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
    // Expansion is per group: the resumed run stays collapsed.
    expect(model.groups.find((g) => g.key === 'tool#2')?.expanded).toBe(false);
    expect(tool?.caption.startsWith('▾ ')).toBe(true);
    expect(model.groups.find((g) => g.phase.id === 'answer')?.arrows).toEqual([]);
  });
});

describe('architecture groups in every scenario', () => {
  it('put causes before effects when every group is expanded', () => {
    for (const scn of scenarios) {
      const keys = new Set(build(scn, 'architecture', 0).groups.map((g) => g.key));
      const model = build(scn, 'architecture', scn.events.length, keys);
      const order = model.groups.flatMap((g) => g.arrows.map((a) => a.index));
      expect(order, scn.id).toEqual(scn.events.map((_, i) => i));
    }
  });

  it('frame their expanded labels and keep labels clear of leftward heads', () => {
    for (const scn of scenarios) {
      const keys = new Set(build(scn, 'architecture', 0).groups.map((g) => g.key));
      for (const g of build(scn, 'architecture', scn.events.length, keys).groups) {
        for (const a of g.arrows) {
          expect(a.labelX + estimate(a.label), `${scn.id} ${a.label}`).toBeLessThanOrEqual(
            g.x2 + 1,
          );
          if (!a.self && a.x2 < a.x1)
            expect(a.labelX - a.x2).toBeGreaterThanOrEqual(SIZES.headRoom);
        }
      }
    }
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
    out.push({ name: g.key, x1: g.x1, x2: g.x2, y1: g.y, y2: g.y + g.height });
  }
  return out;
}

describe('no overlapping labels', () => {
  it('in any scenario, level and expansion', () => {
    for (const scn of scenarios) {
      const all = build(scn, 'architecture', 0).groups.map((g) => g.key);
      for (const model of [
        build(scn, 'protocol', scn.events.length),
        build(scn, 'architecture', scn.events.length, all),
      ]) {
        const items = boxes(model).filter((b) => !model.groups.some((g) => g.key === b.name));
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

  it('names each group by its visible text, takeaway then caption (WCAG 2.5.3)', () => {
    const model = build(scenario('mcp-balance'), 'architecture', 23);
    const svg = renderSvg(model, 'T');
    for (const g of model.groups) {
      const visible = [g.takeaway.join(' '), g.caption.slice(2)].filter(Boolean).join(' ');
      expect(svg).toContain(
        `data-group="${g.key}" data-phase="${g.phase.id}"${g.current ? ' data-current=""' : ''} role="button" tabindex="0" aria-expanded="${g.expanded}" aria-label="${visible.replace(/'/g, '&#39;')}"`,
      );
    }
    expect(model.groups.some((g) => g.takeaway.length > 1)).toBe(true);
    // Wrapped lines are separate words, not run together.
    expect(svg).toMatch(/<\/tspan> <tspan/);
  });

  it('draws the participant names first, in a sticky header above the diagram', () => {
    const model = build(scenario('mcp-balance'), 'protocol', 5);
    const html = renderSvg(model, 'T');
    const head = model.top - 8;
    // Assistive technology meets the names before the steps.
    expect(html.startsWith(`<div class="diagram-head" data-header="${head}">`)).toBe(true);
    const diagram = html.indexOf('<svg class="diagram"');
    expect(html.slice(0, diagram).match(/class="participant"/g)).toHaveLength(
      model.lifelines.length,
    );
    expect(html.slice(diagram)).not.toContain('class="participant"');
    // The diagram continues below the header in the same coordinates.
    expect(html.slice(diagram)).toContain(
      `height="${model.height - head}" viewBox="0 ${head} ${model.width} ${model.height - head}"`,
    );
  });

  it("puts paper behind each group's text, so lifelines do not run through it", () => {
    const model = build(scenario('mcp-balance'), 'architecture', 12);
    const html = renderSvg(model, 'T');
    for (const g of model.groups) {
      expect(g.textWidth).toBeGreaterThan(0);
      expect(html).toContain(
        `<rect class="group-text-band" x="${g.x1 + 2 * SIZES.groupPad - 4}" y="${g.y + SIZES.groupPad}" width="${g.textWidth + 8}"`,
      );
    }
  });
});
