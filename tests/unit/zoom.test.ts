// Zoom levels (02-ui-ux.yaml zoom_levels): the cursor mapping between levels, the Overview's
// stops, its layout, and Compare stepping stage by stage.
import { describe, expect, it } from 'vitest';
import {
  partiesOf,
  stageAt,
  stageSpans,
  stageStops,
  zoomCursor,
  zoomed,
} from '../../src/diagram/zoom.ts';
import { layout } from '../../src/diagram/model.ts';
import { renderSvg } from '../../src/diagram/render.ts';
import { renderList } from '../../src/diagram/list.ts';
import { loadRegistry, participantLabels, specSources } from '../../src/scenarios/registry.ts';
import { createPlayback } from '../../src/rag/bundled.ts';
import { Player } from '../../src/engine/player.ts';
import { CompareTimeline, stageInput } from '../../src/compare/timeline.ts';

const registry = loadRegistry();
const labels = participantLabels();

describe('cursor mapping (02 zoom_levels.cursor_mapping)', () => {
  // Every scenario and every cursor: the mapping is cheap, and a stage boundary off by one in
  // any scenario would put the learner on the wrong event.
  for (const scn of Object.values(registry)) {
    it(`${scn.id}: in to the stage's first event, out to its last, kept between the others`, () => {
      const spans = stageSpans(scn.overview, scn.events);
      for (let k = 0; k <= scn.events.length; k += 1) {
        const stage = stageAt(spans, k);
        const out = zoomCursor(spans, k, 'protocol', 'overview');
        expect(zoomCursor(spans, k, 'architecture', 'overview')).toBe(out);
        expect(zoomCursor(spans, k, 'architecture', 'protocol')).toBe(k);
        expect(zoomCursor(spans, k, 'protocol', 'architecture')).toBe(k);
        if (k === 0) {
          expect(stage).toBeUndefined();
          expect(out).toBe(0);
          continue;
        }
        // The event lies in the stage that holds its phase.
        expect(stage?.stage.phases).toContain(scn.events[k - 1]?.phase);
        expect(out).toBe(stage?.last);
        const back = zoomCursor(spans, out, 'overview', 'architecture');
        expect(back).toBe(stage?.first);
        expect(zoomCursor(spans, out, 'overview', 'protocol')).toBe(back);
        // Zooming in and out again keeps the stage.
        expect(zoomCursor(spans, back, 'architecture', 'overview')).toBe(out);
      }
    });
  }

  it('stops at step 0 and at the end of every stage, which together cover every event', () => {
    for (const scn of Object.values(registry)) {
      const spans = stageSpans(scn.overview, scn.events);
      const stops = stageStops(spans);
      expect(stops[0]).toBe(0);
      expect(stops.at(-1)).toBe(scn.events.length);
      expect(stops.length - 1).toBe(scn.overview.stages.length);
      // Consecutive: each stage starts right after the previous one ends.
      spans.forEach((s, i) => expect(s.first).toBe((stops[i] ?? 0) + 1));
    }
  });

  it('zooms one level at a time and stops at either end', () => {
    expect(zoomed('overview', 1)).toBe('architecture');
    expect(zoomed('architecture', 1)).toBe('protocol');
    expect(zoomed('protocol', 1)).toBeUndefined();
    expect(zoomed('protocol', -1)).toBe('architecture');
    expect(zoomed('overview', -1)).toBeUndefined();
  });

  it('follows parameter changes: a stage spans the events as played', () => {
    const scn = registry['rag-query'];
    if (!scn) throw new Error('no rag-query');
    const playback = createPlayback(scn);
    const before = stageStops(stageSpans(scn.overview, playback.events));
    playback.setParameters({ rerank: true, keyword_retrieval: true });
    const after = stageStops(stageSpans(scn.overview, playback.events));
    // The optional steps lie in the search stage: it ends later, and so does everything after it.
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBeGreaterThan(before[2] ?? 0);
    expect(after.at(-1)).toBe(playback.length);
  });
});

describe('Overview stepping (02 zoom_levels.stepping)', () => {
  it('Next, Previous and Play stop at the end of each stage; without stops at every event', () => {
    const scn = registry['mcp-balance'];
    if (!scn) throw new Error('no mcp-balance');
    let fire: (() => void) | undefined;
    const player = new Player(createPlayback(scn), {
      setTimeout: (callback) => (fire = callback),
      clearTimeout: () => (fire = undefined),
    });
    const stops = stageStops(stageSpans(scn.overview, player.playback.events));
    player.setStops(() => stops);
    player.next();
    expect(player.cursor).toBe(stops[1]);
    player.next();
    expect(player.cursor).toBe(stops[2]);
    player.previous();
    expect(player.cursor).toBe(stops[1]);
    player.play();
    fire?.();
    expect(player.cursor).toBe(stops[2]);
    player.setStops(undefined);
    player.pause();
    player.next();
    expect(player.cursor).toBe((stops[2] ?? 0) + 1);
  });
});

describe('Overview layout (02 zoom_levels.overview)', () => {
  const scn = registry['mcp-balance'];
  if (!scn) throw new Error('no mcp-balance');
  const at = (cursor: number) =>
    layout({ scenario: scn, labels, level: 'overview', cursor, expanded: new Set() });

  it('draws one lifeline per party and one block per stage, the current one marked', () => {
    const model = at(14);
    expect(model.lifelines.map((l) => l.lines.join(' '))).toEqual([
      'You',
      'Assistant',
      'Bank systems',
    ]);
    expect(model.arrows).toEqual([]);
    expect(model.groups).toEqual([]);
    expect(model.stages.map((s) => s.stage.id)).toEqual(['prepare', 'ask', 'fetch', 'answer']);
    expect(model.stages.filter((s) => s.current).map((s) => s.stage.id)).toEqual(['fetch']);
    expect(at(0).stages.some((s) => s.current)).toBe(false);
    // A block spans the parties its events touch.
    const ask = model.stages[1];
    const [you, assistant, bank] = model.lifelines;
    expect(ask?.parties).toEqual(['You', 'Assistant']);
    expect(ask && you && ask.x1 < you.x && ask.x2 > (assistant?.x ?? 0)).toBe(true);
    expect(ask && bank && ask.x2 < bank.x).toBe(true);
    // Blocks follow each other without overlapping.
    for (const [a, b] of model.stages.slice(1).map((s, i) => [model.stages[i], s] as const))
      expect((a?.y ?? 0) + (a?.height ?? 0)).toBeLessThan(b.y);
  });

  it('names no protocol and no operation, in the SVG and in the step list', () => {
    const model = at(14);
    const svg = renderSvg(model, 'Overview', 'o', labels);
    const list = renderList(model, 'Overview', labels);
    for (const html of [svg, list]) {
      expect(html).not.toMatch(/\b(MCP|HTTP|JSON-RPC|LLM|REST|tools\/call)\b/);
      expect(html).toContain('aria-current="step"');
      expect(html).toContain('Stage 3 of 4');
    }
    expect(list).toContain('Assistant · Bank systems');
  });

  it('a waiting Compare pane marks no stage', () => {
    const model = layout({
      scenario: scn,
      labels,
      level: 'overview',
      cursor: 14,
      expanded: new Set(),
      held: true,
    });
    expect(model.stages.some((s) => s.current)).toBe(false);
  });

  it('lists the parties a run of events touches, in the overview order', () => {
    expect(partiesOf(scn.overview, [{ sender: 'database', receiver: 'user' }])).toEqual([
      'you',
      'bank-systems',
    ]);
  });
});

describe('Compare at the Overview (02 compare_view.timeline)', () => {
  it('steps the two stories stage by stage on the same semantic phase', () => {
    const { comparison } = specSources();
    const { compare, semantic_phases } = comparison;
    const ids = semantic_phases.map((p) => p.id);
    const panes = [compare.left_scenario, compare.right_scenario].map((id) => {
      const scn = registry[id];
      if (!scn) throw new Error(`no ${id}`);
      const input = { events: scn.events, semanticOf: compare.phase_mapping[id] ?? {} };
      return { scn, input, spans: stageSpans(scn.overview, scn.events) };
    });
    const [left, right] = panes as [(typeof panes)[number], (typeof panes)[number]];
    const timeline = new CompareTimeline(ids, [
      stageInput(left.input, left.spans),
      stageInput(right.input, right.spans),
    ]);
    // One compare step per stage of the longer story in each phase: MCP's preparation, then the
    // question, the information and the answer side by side.
    expect(timeline.length).toBe(4);
    expect(timeline.steps.map((s) => s.phase)).toEqual([
      undefined,
      'preparation',
      'user-request',
      'information-acquisition',
      'context-assembly',
    ]);
    // RAG waits during preparation (its index was built earlier).
    expect(timeline.at(1).panes[0].status).toBe('placeholder');
    expect(timeline.at(4).panes.map((p) => p.cursor)).toEqual([
      left.scn.overview.stages.length,
      right.scn.overview.stages.length,
    ]);
  });
});
