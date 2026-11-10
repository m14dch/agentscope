// 08-acceptance-tests.yaml unit_tests: every Compare step, and stepping either pane, keeps
// both panes on the same semantic phase (02-ui-ux.yaml compare_view.timeline).
import { describe, expect, it } from 'vitest';
import { CompareTimeline, type PaneInput, TimelineError } from '../../src/compare/timeline.ts';
import { createPlayback } from '../../src/rag/bundled.ts';
import { loadRegistry, specSources } from '../../src/scenarios/registry.ts';
import { loadScenarios } from '../../src/scenarios/validate.ts';
import type { SpecSources } from '../../src/scenarios/types.ts';

const sources = specSources();
const registry = loadRegistry();
const { compare, semantic_phases } = sources.comparison;
const phases = semantic_phases.map((p) => p.id);

function pane(id: string): PaneInput {
  const scenario = registry[id];
  if (!scenario) throw new Error(`no scenario ${id}`);
  return { events: createPlayback(scenario).events, semanticOf: compare.phase_mapping[id] ?? {} };
}

const left = pane(compare.left_scenario);
const right = pane(compare.right_scenario);
const timeline = new CompareTimeline(phases, [left, right]);
const inputs = [left, right] as const;

/** The semantic phase a pane shows at a compare step, from its own current event. */
function shownPhase(step: number, side: 0 | 1): string | undefined {
  const at = timeline.at(step).panes[side];
  if (at.status === 'start') return undefined;
  if (at.status === 'placeholder') {
    // The pane has no event in the step's phase.
    const phase = timeline.at(step).phase;
    expect(inputs[side].events.some((e) => inputs[side].semanticOf[e.phase] === phase)).toBe(false);
    return phase;
  }
  const event = inputs[side].events[at.cursor - 1];
  return event ? inputs[side].semanticOf[event.phase] : undefined;
}

describe('compare timeline', () => {
  it('compares rag-query on the left with mcp-balance on the right', () => {
    expect([compare.left_scenario, compare.right_scenario]).toEqual(['rag-query', 'mcp-balance']);
  });

  it('lasts as many steps per phase as the pane with more events in it', () => {
    const count = (input: PaneInput, phase: string) =>
      input.events.filter((e) => input.semanticOf[e.phase] === phase).length;
    const expected = phases.reduce((sum, p) => sum + Math.max(count(left, p), count(right, p)), 0);
    expect(timeline.length).toBe(expected);
    // Preparation has only MCP events, so RAG shows its placeholder there.
    expect(timeline.at(1)).toMatchObject({
      phase: 'preparation',
      panes: [
        { cursor: 0, status: 'placeholder' },
        { cursor: 1, status: 'stepping' },
      ],
    });
    expect(compare.placeholders?.['rag-query']?.['preparation']).toBe(
      'Index built earlier by rag-index.',
    );
  });

  it('keeps both panes on the same semantic phase at every step', () => {
    expect(timeline.at(0).panes).toEqual([
      { cursor: 0, status: 'start' },
      { cursor: 0, status: 'start' },
    ]);
    for (let s = 1; s <= timeline.length; s += 1) {
      const phase = timeline.at(s).phase;
      expect(shownPhase(s, 0), `left at step ${s}`).toBe(phase);
      expect(shownPhase(s, 1), `right at step ${s}`).toBe(phase);
    }
  });

  it('reaches every event of both panes, and both ends together', () => {
    for (const side of [0, 1] as const) {
      const seen = new Set(timeline.steps.map((s) => s.panes[side].cursor));
      for (let k = 0; k <= inputs[side].events.length; k += 1) expect(seen.has(k)).toBe(true);
      expect(timeline.at(timeline.length).panes[side].cursor).toBe(inputs[side].events.length);
    }
  });

  it('Next and Previous move each pane by at most one event, never back in phase order', () => {
    for (let s = 0; s < timeline.length; s += 1) {
      const [a, b] = [timeline.at(s), timeline.at(s + 1)];
      for (const side of [0, 1] as const) {
        const delta = b.panes[side].cursor - a.panes[side].cursor;
        expect(delta === 0 || delta === 1, `step ${s} side ${side}`).toBe(true);
      }
      const order = (p: string | undefined) => (p === undefined ? -1 : phases.indexOf(p));
      expect(order(b.phase)).toBeGreaterThanOrEqual(order(a.phase));
      // Next moves the panes that still have events in the phase, or both into the next one.
      if (a.phase === b.phase) {
        for (const side of [0, 1] as const) {
          const moved = b.panes[side].cursor !== a.panes[side].cursor;
          expect(moved).toBe(b.panes[side].status === 'stepping');
        }
      }
    }
  });

  it('stepping either pane moves the other to the same semantic phase', () => {
    for (const side of [0, 1] as const) {
      for (let k = 0; k <= inputs[side].events.length; k += 1) {
        const step = timeline.stepOf(side, k);
        expect(timeline.at(step).panes[side].cursor, `side ${side} cursor ${k}`).toBe(k);
        const other = side === 0 ? 1 : 0;
        expect(shownPhase(step, other)).toBe(shownPhase(step, side));
      }
    }
    // The left pane's last retrieval event moves MCP back to its start of the phase.
    const rest = timeline.stepOf(0, 6);
    expect(timeline.at(rest).phase).toBe('information-acquisition');
    expect(timeline.stepOf(0, 999)).toBe(timeline.length);
    expect(timeline.stepOf(1, -1)).toBe(0);
  });

  it('clamps steps beyond the timeline', () => {
    expect(timeline.clamp(-3)).toBe(0);
    expect(timeline.clamp(10_000)).toBe(timeline.length);
    expect(timeline.clamp(Number.NaN)).toBe(0);
  });

  it('refuses a pane that returns to an earlier semantic phase', () => {
    const bad: PaneInput = {
      events: [
        { id: 'a', phase: 'x' },
        { id: 'b', phase: 'y' },
        { id: 'c', phase: 'x' },
      ],
      semanticOf: { x: 'user-request', y: 'answer' },
    };
    expect(() => new CompareTimeline(phases, [bad, right])).toThrow(TimelineError);
    expect(
      () =>
        new CompareTimeline(phases, [{ events: [{ id: 'a', phase: 'z' }], semanticOf: {} }, right]),
    ).toThrow(/no semantic phase/);
  });

  it('every scenario that has a phase mapping visits the semantic phases in order', () => {
    for (const id of Object.keys(compare.phase_mapping)) {
      expect(() => new CompareTimeline(phases, [pane(id), pane(id)])).not.toThrow();
    }
  });
});

describe('compare data', () => {
  const broken = (change: (c: SpecSources['comparison']['compare']) => void): string[] => {
    const copy = structuredClone(sources) as SpecSources;
    change(copy.comparison.compare);
    return loadScenarios(copy).problems;
  };

  it('needs a placeholder exactly for each semantic phase a scenario has no events in', () => {
    expect(
      broken((c) => {
        c.placeholders = {};
      }),
    ).toContainEqual(expect.stringContaining('compare.placeholders'));
    expect(
      broken((c) => {
        c.placeholders = { 'rag-query': { preparation: 'x', answer: 'y' } };
      }),
    ).toContainEqual(expect.stringContaining('compare.placeholders'));
  });

  it('states every aspect as a sentence', () => {
    expect(compare.aspects?.map((a) => a.label)).toEqual([
      'Data source',
      'Freshness expectations',
      'Model-visible context',
      'Actions vs retrieval',
      'Trust boundaries',
    ]);
    for (const a of compare.aspects ?? []) expect(a.sentence).toMatch(/^[A-Z].*\.$/);
    expect(
      broken((c) => {
        c.aspects = [{ label: 'Data source', sentence: ' ' }];
      }),
    ).toContainEqual(expect.stringContaining('compare.aspects'));
  });
});
