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
    // RAG's step 6 is its 5th event of information acquisition: compare step 14, where MCP is
    // at its 5th event of that phase too (its step 14).
    const rest = timeline.stepOf(0, 6);
    expect(rest).toBe(14);
    expect(timeline.at(rest)).toMatchObject({
      phase: 'information-acquisition',
      panes: [
        { cursor: 6, status: 'stepping' },
        { cursor: 14, status: 'stepping' },
      ],
    });
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
  type Change = (copy: SpecSources, compare: Record<string, unknown>) => void;
  const problems = (change: Change): string[] => {
    const copy = structuredClone(sources) as SpecSources;
    change(copy, copy.comparison.compare as unknown as Record<string, unknown>);
    return loadScenarios(copy).problems.filter((p) => p.startsWith('compare.'));
  };

  it('accepts the bundled data', () => {
    expect(problems(() => undefined)).toEqual([]);
  });

  it('needs a placeholder exactly for each semantic phase a scenario plays no event in', () => {
    expect(problems((_, c) => (c['placeholders'] = {}))).toEqual([
      'compare.placeholders: rag-query placeholders must cover exactly: preparation',
    ]);
    expect(
      problems((_, c) => (c['placeholders'] = { 'rag-query': { preparation: 'x', answer: 'y' } })),
    ).toEqual(['compare.placeholders: rag-query placeholders must cover exactly: preparation']);
    expect(problems((_, c) => (c['placeholders'] = { 'rag-query': { preparation: ' ' } }))).toEqual(
      ['compare.placeholders: rag-query placeholder for preparation is empty'],
    );
    expect(
      problems(
        (_, c) =>
          (c['placeholders'] = { 'rag-query': { preparation: 'x' }, 'rag-index': { answer: 'y' } }),
      ),
    ).toEqual(['compare.placeholders: rag-index is not in phase_mapping']);
    expect(problems((_, c) => (c['placeholders'] = 'x'))).toContainEqual(
      'compare.placeholders: must map scenario IDs to placeholders',
    );
  });

  it('counts only the events played at the default parameters', () => {
    // With its only context event optional and off by default, rag-query plays nothing in
    // context assembly, so that phase needs a placeholder too.
    expect(
      problems((copy) => {
        const scn = copy.rag.scenarios.find((s) => s.id === 'rag-query');
        scn?.optional_steps?.push({ events: ['retrieve-09'], enabled_by: 'rerank' });
      }),
    ).toEqual([
      'compare.placeholders: rag-query placeholders must cover exactly: preparation, context-assembly',
    ]);
  });

  it('states every aspect as one sentence with its label', () => {
    expect(compare.aspects?.map((a) => a.label)).toEqual([
      'Data source',
      'Freshness expectations',
      'Model-visible context',
      'Actions vs retrieval',
      'Trust boundaries',
    ]);
    for (const a of compare.aspects ?? [])
      expect(a.sentence).toMatch(/^[A-Z][^.]*(\.[^ .][^.]*)*\.$/);
    const wrong = (aspects: unknown) => problems((_, c) => (c['aspects'] = aspects));
    expect(wrong([])).toEqual(['compare.aspects: needs at least one aspect']);
    expect(wrong(undefined)).toEqual(['compare.aspects: needs at least one aspect']);
    for (const aspect of [
      { label: 'Data source', sentence: ' ' },
      { label: 'Data source' },
      { label: 'Data source', sentence: 3 },
      { label: 'Data source', sentence: 'A sentence.', note: 'extra' },
      'Data source',
    ]) {
      expect(wrong([aspect]), JSON.stringify(aspect)).toEqual([
        'compare.aspects: aspect 0 needs exactly a label and a sentence',
      ]);
    }
  });
});
