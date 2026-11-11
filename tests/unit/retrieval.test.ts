import { describe, expect, it } from 'vitest';
import { Player } from '../../src/engine/player.ts';
import {
  answerParts,
  evidence,
  layoutAt,
  projectedPoints,
  projectionLayout,
  positionLine,
  type ProjectionLayout,
  segmentCrosses,
  segmentsMeet,
  pointLabel,
  projection,
  promptParts,
  type RetrievalModel,
  retrievalModel,
  type SearchedIndex,
  thresholdLabel,
} from '../../src/inspector/retrieval.ts';
import { createPlayback, ragDerivation } from '../../src/rag/bundled.ts';
import { loadRegistry, specSources } from '../../src/scenarios/registry.ts';
import type { Json, Scenario, ScenarioEvent } from '../../src/scenarios/types.ts';
import type { Box } from '../../src/inspector/retrieval.ts';

const registry = loadRegistry();
const derivation = ragDerivation();
const { engine } = derivation;
const rag = specSources().rag as unknown as {
  fixtures: { projection_2d: { x: string; y: string } };
  reference_results: Record<string, Reference | string>;
};
const project = projection(rag.fixtures.projection_2d, engine.fixtures.embedding.dimensions);

interface Reference {
  parameters: Record<string, Json>;
  selected: { chunkId: string; score: number; rerankScore?: number }[];
  answer: string;
  sources: string[];
  ranking?: { chunkId: string; score: number; embedding: number[] }[];
}

function index(player: Player): SearchedIndex {
  const p = derivation.parameters(player.playback.retrievalConfig);
  const docs = engine.corpus();
  return { docs, chunks: engine.chunks(docs, p.chunkSize, p.overlap), project };
}

/** The rag-query player at a reference_results entry's parameters, at its last step. */
function run(ref: Reference): Player {
  const scenario = registry['rag-query'] as Scenario;
  const player = new Player(createPlayback(scenario));
  player.setParameters(
    Object.fromEntries(Object.entries(ref.parameters).filter(([k]) => scenario.parameters?.[k])),
  );
  player.jump(player.playback.length);
  return player;
}

function modelAt(name: string, cursor?: number): RetrievalModel | undefined {
  const scenario = registry[name] as Scenario;
  const player = new Player(createPlayback(scenario));
  player.jump(cursor ?? player.playback.length);
  return retrievalModel(player.playback.events, player.cursor, index(player));
}

const references = Object.entries(rag.reference_results).filter(
  (e): e is [string, Reference] => e[0] !== 'note',
);

describe('retrieval panel model', () => {
  it('appears with the scored chunks, the selection from retrieve-06 on, prompt and answer later', () => {
    // rag-query at the defaults: retrieve-05 is step 5, retrieve-06 step 6, retrieve-09 step 7,
    // retrieve-10 step 8 and retrieve-12 step 10.
    expect(modelAt('rag-query', 4)).toBeUndefined();
    const scored = modelAt('rag-query', 5) as RetrievalModel;
    expect(scored.rows.some((r) => r.outcome)).toBe(false);
    expect(scored.selectionStep).toBe(6);
    // The threshold is read from retrieve-06 once it is played, not before.
    expect(scored.selection).toBeUndefined();
    expect(scored.prompt).toBeUndefined();
    const selected = modelAt('rag-query', 6) as RetrievalModel;
    expect(selected.rows.filter((r) => r.outcome?.retained)).toHaveLength(5);
    const assembled = modelAt('rag-query', 7) as RetrievalModel;
    expect(assembled.prompt?.sent).toBe(false);
    expect(assembled.prompt?.sentStep).toBe(8);
    expect(modelAt('rag-query', 8)?.prompt?.sent).toBe(true);
    expect(modelAt('rag-query', 9)?.answer).toBeUndefined();
    expect(modelAt('rag-query', 10)?.answer).toBeDefined();
  });

  it('scores every chunk as reference_results.rag-query ranks them, with its projected vector', () => {
    const ref = rag.reference_results['rag-query'] as Reference;
    const model = modelAt('rag-query') as RetrievalModel;
    expect(model.rows.map((r) => [r.chunkId, r.score])).toEqual(
      (ref.ranking ?? []).map((r) => [r.chunkId, r.score]),
    );
    for (const [i, r] of (ref.ranking ?? []).entries()) {
      const [product, cost, rules, technical] = r.embedding as [number, number, number, number];
      expect(model.rows[i]?.point.x).toBeCloseTo(cost - rules, 10);
      expect(model.rows[i]?.point.y).toBeCloseTo(product - technical, 10);
    }
    expect(model.selection).toEqual({ threshold: 0.7, topK: 5, rerank: false });
  });

  it.each(references)('reproduces the selection, scores, answer and sources of %s', (_, ref) => {
    const player = run(ref);
    const model = retrievalModel(
      player.playback.events,
      player.cursor,
      index(player),
    ) as RetrievalModel;
    // The prompt assembled at retrieve-09 is exactly what retrieve-10 sends.
    const sent = player.playback.events.find((e) => e.id.endsWith('retrieve-10'));
    expect(model.prompt?.after).toEqual((sent?.payload as { messages: unknown[] }).messages);
    const retained = model.rows
      .filter((r) => r.outcome?.retained)
      .sort(
        (a, b) =>
          (a.outcome?.retained ? a.outcome.rank : 0) - (b.outcome?.retained ? b.outcome.rank : 0),
      );
    expect(
      retained.map((r) => ({
        chunkId: r.chunkId,
        score: r.score,
        ...(ref.selected.some((s) => s.rerankScore !== undefined) ? { rerankScore: r.rerank } : {}),
      })),
    ).toEqual(ref.selected);
    expect(model.answer?.text).toBe(ref.answer);
    expect(model.answer?.sources.map((s) => s.line)).toEqual(ref.sources);
  });

  it('marks keyword scores once hybrid-02 is reached', () => {
    const player = new Player(createPlayback(registry['rag-query'] as Scenario));
    player.setParameters({ keyword_retrieval: true, rerank: true });
    player.jump(player.playback.length);
    const hybrid = retrievalModel(player.playback.events, player.cursor, index(player));
    expect(hybrid?.rows.find((r) => r.chunkId === 'savings-account@1.2-c50o10-002')?.keyword).toBe(
      0.4,
    );
  });

  it('opens a citation as its chunk within the source document', () => {
    const player = new Player(createPlayback(registry['rag-query'] as Scenario));
    player.jump(player.playback.length);
    const idx = index(player);
    const model = retrievalModel(player.playback.events, player.cursor, idx) as RetrievalModel;
    const second = model.answer?.sources[1];
    if (!second) throw new Error('no second source');
    const view = evidence(second, idx);
    expect(view?.chunk?.startWord).toBe(40);
    const words = view?.documentWords ?? [];
    expect(words.slice(40, 40 + (view?.chunk?.words.length ?? 0))).toEqual(view?.chunk?.words);
  });

  it('opens a parent document as the whole document', () => {
    const player = new Player(createPlayback(registry['rag-query'] as Scenario));
    player.setParameters({ fetch_full_documents: true });
    player.jump(player.playback.length);
    const idx = index(player);
    const model = retrievalModel(player.playback.events, player.cursor, idx) as RetrievalModel;
    const first = model.answer?.sources[0];
    expect(first?.chunkId).toBeUndefined();
    expect(first?.line).toBe('[1] account-opening.md v1.2, full document');
    expect(first && evidence(first, idx)?.chunk).toBeUndefined();
    const sent = player.playback.events.find((e) => e.id.endsWith('retrieve-10'));
    expect(model.prompt?.after).toEqual((sent?.payload as { messages: unknown[] }).messages);
  });
});

describe('retrieval panel helpers', () => {
  it("keeps a '$' in the question and the documents literal in the assembled prompt", () => {
    const event = (id: string, payload: Json, extra: Partial<ScenarioEvent> = {}) =>
      ({ id: `s:${id}`, payload, ...extra }) as ScenarioEvent;
    const events = [
      event('retrieve-05', { matches: [] }),
      event(
        'retrieve-09',
        {
          prompt_before: [{ role: 'user', content: "Costs $& or $1, $' and $$?" }],
          prompt_after: {
            system: 'S',
            user_template: 'Question: <question>\n\n<document blocks>',
            document_blocks: [{ chunkId: 'fees@1.2-c50o10-001', trust: 'official' }],
          },
        },
        { tracked_values: { retrievedText: ['Pay $` or $<document blocks> now, $$ 5.'] } },
      ),
    ];
    const stub: SearchedIndex = { docs: [], chunks: [], project: () => ({ x: 0, y: 0 }) };
    expect(retrievalModel(events, 2, stub)?.prompt?.after[1]?.content).toBe(
      "Question: Costs $& or $1, $' and $$?\n\n" +
        '<document id="" version="" chunk="fees@1.2-c50o10-001" trust="official">\n' +
        'Pay $` or $<document blocks> now, $$ 5.\n</document>',
    );
  });

  it('splits an answer into text and citations', () => {
    expect(answerParts('a [1]; b [12].')).toEqual(['a ', 1, '; b ', 12, '.']);
  });

  it('finds the document blocks of a prompt with their attributes', () => {
    const player = new Player(createPlayback(registry['rag-query'] as Scenario));
    const event = player.playback.events.find((e) => e.id.endsWith('retrieve-10'));
    const messages = (event?.payload as { messages: { content: string }[] }).messages;
    const parts = promptParts(messages[1]?.content ?? '');
    const blocks = parts.flatMap((p) => ('block' in p ? [p.block] : []));
    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toEqual({
      id: 'account-opening.md',
      version: '1.2',
      chunk: 'account-opening@1.2-c50o10-001',
      trust: 'official',
    });
    expect(parts[0]).toEqual({
      text: 'Question: What are the conditions for opening and maintaining a bank account?\n\nRetrieved documents:\n',
    });
  });

  const answered = Object.values(registry).filter((s) => s.derived_events?.includes('retrieve-12'));
  it.each(answered.flatMap((s) => [328, 358, 720, 752, 928, 1344].map((w) => [s.id, w] as const)))(
    'lays out the projection of %s at %d px with no label over a label, mark, axis or leader',
    (id, width) => {
      const model = modelAt(id, 6) as RetrievalModel;
      const layout = projectionLayout(projectedPoints(model), width);
      const overlap = (a: Box, b: Box): boolean =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const axisBoxes: Box[] = [
        {
          left: layout.axes.x[0],
          right: layout.axes.x[2],
          top: layout.axes.x[1] - 1,
          bottom: layout.axes.x[1] + 1,
        },
        {
          left: layout.axes.y[0] - 1,
          right: layout.axes.y[0] + 1,
          top: layout.axes.y[1],
          bottom: layout.axes.y[3],
        },
        ...layout.axisNames.map((a) => a.box),
      ];
      layout.labels.forEach((l, i) => {
        if (!l) return;
        const box = l.box;
        expect(box.bottom - box.top).toBeGreaterThanOrEqual(16);
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(layout.width);
        expect(box.bottom).toBeLessThanOrEqual(layout.height);
        layout.labels.forEach((o, j) => {
          if (j === i || !o) return;
          expect(overlap(box, o.box), `label ${i} over label ${j}`).toBe(false);
          if (o.leader)
            expect(segmentCrosses(o.leader, box), `leader ${j} through label ${i}`).toBe(false);
        });
        layout.marks.forEach((m, j) => {
          if (j !== i || l.leader) expect(overlap(box, m), `label ${i} over mark ${j}`).toBe(false);
        });
        for (const a of axisBoxes) expect(overlap(box, a), `label ${i} over an axis`).toBe(false);
        // Leaders stay short and cross no axis name and no other leader.
        const leader = l.leader;
        if (leader) {
          expect(Math.abs(leader[3] - leader[1])).toBeLessThanOrEqual(8 * 18);
          for (const a of layout.axisNames)
            expect(segmentCrosses(leader, a.box), `leader ${i} through an axis name`).toBe(false);
          layout.labels.forEach((o, j) => {
            if (j !== i && o?.leader)
              expect(segmentsMeet(leader, o.leader), `leaders ${i} and ${j} meet`).toBe(false);
          });
        }
      });
      // Nothing scrolls at any width (02 labels_and_charts); from a 768 px viewport (720 px of
      // content) every point is labelled at its place, below it the compact form labels only
      // the question and names the points in a list.
      expect(layout.width).toBeLessThanOrEqual(width);
      if (width >= 720) {
        expect(layout.compact).toBe(false);
        expect(layout.labels.every((l) => l !== undefined)).toBe(true);
      } else {
        expect(layout.compact).toBe(true);
        const points = projectedPoints(model);
        expect(
          layout.labels.map((l, i) => (l ? points[i]?.label : undefined)).filter(Boolean),
        ).toEqual(points.filter((p) => !p.id).map((p) => p.label));
        const side = layout.axes.x[2] - layout.axes.x[0];
        expect(side).toBeLessThanOrEqual(360);
        expect(side).toBeGreaterThanOrEqual(width - 2 * 12 - 1);
      }
    },
  );

  it('draws the candidate layout with the shortest leaders at the largest side that fits', () => {
    const leaderCost = (l: ProjectionLayout): number =>
      l.labels.reduce((n, x) => n + (x?.leader ? (x.leader[3] - x.leader[1]) ** 2 : 0), 0);
    for (const s of answered) {
      const points = projectedPoints(modelAt(s.id, 6) as RetrievalModel);
      for (const width of [720, 1344]) {
        const layout = projectionLayout(points, width);
        const side = layout.axes.x[2] - layout.axes.x[0];
        const free = width - side;
        // Every horizontal position of the plot at that side (in 5 % steps) costs as much or more.
        for (let share = 0; share <= 1; share += 0.05) {
          const other = layoutAt(points, side, Math.round(free * share), width);
          if (other.cost < 1e6)
            expect(leaderCost(layout), `${s.id} ${width} ${share}`).toBeLessThanOrEqual(other.cost);
        }
      }
    }
  });

  it('names each point of the compact form by its label, its position on the axes and its outcome', () => {
    const base = { label: 'everyday-account@1.2 · 001', id: 'x', retained: true };
    expect(positionLine({ ...base, x: -0.3149, y: 0.6151 })).toBe(
      'everyday-account@1.2 · 001: rules 0.31, product 0.62 · retained',
    );
    expect(positionLine({ ...base, x: 0.5, y: -0.25, retained: false })).toBe(
      'everyday-account@1.2 · 001: cost 0.50, technical 0.25',
    );
    // A coordinate that rounds to 0.00 names the axis the point lies on.
    expect(positionLine({ ...base, x: 0.004, y: -0.95, retained: false })).toBe(
      'everyday-account@1.2 · 001: on the technical–product axis, technical 0.95',
    );
    expect(positionLine({ ...base, x: -0.2, y: -0.001, retained: false })).toBe(
      'everyday-account@1.2 · 001: rules 0.20, on the rules–cost axis',
    );
  });

  it('finds where segments meet', () => {
    expect(segmentsMeet([0, 0, 10, 10], [0, 10, 10, 0])).toBe(true);
    expect(segmentsMeet([0, 0, 10, 0], [0, 1, 10, 1])).toBe(false);
    // Overlapping collinear leaders from one point meet.
    expect(segmentsMeet([0, 0, 0, 20], [0, 0, 0, 40])).toBe(true);
  });

  it('labels points briefly and thresholds with 2 decimals', () => {
    expect(pointLabel('everyday-account@1.0-c50o10-002')).toBe('everyday-account@1.0 · 002');
    expect(thresholdLabel(0.7)).toBe('0.70');
    expect(thresholdLabel(0.95)).toBe('0.95');
    expect(thresholdLabel(0.125)).toBe('0.12');
  });
});
