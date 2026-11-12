/**
 * RAG retrieval panel (02-ui-ux.yaml rag_retrieval): the scores as a dot plot with the
 * threshold, the fixed 2D projection, the prompt before and after retrieval, and the answer
 * whose citations open their evidence next to the source document. Scores, selection, prompt
 * and answer are read from the played events, so the panel always equals them; chunk text
 * and vectors come from the index the scenario searches. The models are pure; the views
 * render them.
 */
import { type Chunk, type IndexedDocument, sourceLines, words } from '../rag/engine.ts';
import { thresholdText } from '../rag/derive.ts';
import type { Json, ScenarioEvent } from '../scenarios/types.ts';
import type { Selection } from './inspector.ts';

type Obj = Record<string, Json>;
const obj = (v: Json | undefined): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
const list = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);

/** Index of the event with this local ID (with or without the '<scenario>:' prefix). */
function find(events: readonly ScenarioEvent[], id: string): number {
  return events.findIndex((e) => e.id === id || e.id.endsWith(`:${id}`));
}

export interface Point {
  x: number;
  y: number;
}

/** A fixed linear projection of a vector to 2D (05 fixtures.projection_2d). */
export type Projection = (vector: readonly number[]) => Point;

/**
 * Builds the projection from expressions such as 'cost - rules' over the named dimensions:
 * a sum of dimension names, each preceded by + or -.
 */
export function projection(
  spec: { x: string; y: string },
  dimensions: readonly string[],
): Projection {
  const axis = (expression: string): number[] => {
    const weights = dimensions.map(() => 0);
    const terms = expression.replace(/\s+/g, '').match(/[+-]?[^+-]+/g) ?? [];
    for (const term of terms) {
      const sign = term.startsWith('-') ? -1 : 1;
      const name = term.replace(/^[+-]/, '');
      const i = dimensions.indexOf(name);
      if (i < 0) throw new RangeError(`projection names unknown dimension ${name}`);
      weights[i] = (weights[i] ?? 0) + sign;
    }
    return weights;
  };
  const wx = axis(spec.x);
  const wy = axis(spec.y);
  const dot = (w: number[], v: readonly number[]): number =>
    w.reduce((s, x, i) => s + x * (v[i] ?? 0), 0);
  return (v) => ({ x: dot(wx, v), y: dot(wy, v) });
}

/** What retrieve-06 decided for a chunk. */
export type Outcome = { retained: true; rank: number } | { retained: false; reason: string };

export interface ScoreRow {
  chunkId: string;
  documentId: string;
  version: string;
  score: number;
  /** From hybrid-02, once reached, for keyword hits. */
  keyword?: number;
  /** From hybrid-03, once reached, for candidates at or above the threshold. */
  rerank?: number;
  /** From retrieve-06, once reached. */
  outcome?: Outcome;
  /** The chunk's vector, and its projection. */
  vector: number[];
  point: Point;
}

export interface PromptMessage {
  role: string;
  content: string;
}

export interface Source {
  citation: number;
  /** Absent for a parent document (fetch_full_documents). */
  chunkId?: string;
  documentId: string;
  version: string;
  /** The source line as 05 answer_rules writes it. */
  line: string;
}

export interface RetrievalModel {
  /** Every chunk in retrieve-05's order (descending score). */
  rows: ScoreRow[];
  /** retrieve-06's parameters, once it is played. */
  selection?: { threshold: number; topK: number; rerank: boolean };
  /** 1-based step that applies top K and the threshold (retrieve-06). */
  selectionStep: number;
  /** The question's projected vector (retrieve-03). */
  query: Point | undefined;
  prompt?: {
    before: PromptMessage[];
    after: PromptMessage[];
    /** 1-based step of the model request (retrieve-10). */
    sentStep: number;
    sent: boolean;
  };
  answer?: { text: string; sources: Source[] };
}

/** The index the scenario searches: its document versions and chunks with vectors. */
export interface SearchedIndex {
  docs: readonly IndexedDocument[];
  chunks: readonly Chunk[];
  project: Projection;
}

const reached = (index: number, cursor: number): boolean => index >= 0 && cursor >= index + 1;

function messages(v: Json | undefined): PromptMessage[] {
  return list(v).map((m) => ({
    role: String(obj(m)['role']),
    content: String(obj(m)['content'] ?? ''),
  }));
}

/**
 * retrieve-09's prompt_after filled in: its system message, and its user template with the
 * question and one document block per evidence item, written as retrieve-10 writes them.
 */
function assembledPrompt(
  event: ScenarioEvent | undefined,
  before: readonly PromptMessage[],
  chunks: ReadonlyMap<string, Chunk>,
): PromptMessage[] {
  const after = obj(obj(event?.payload as Json | undefined)['prompt_after']);
  const texts = list(event?.tracked_values?.['retrievedText']).map(String);
  const blocks = list(after['document_blocks']).map((raw, i) => {
    const b = obj(raw);
    const chunkId = b['chunkId'] === undefined ? undefined : String(b['chunkId']);
    const chunk = chunkId === undefined ? undefined : chunks.get(chunkId);
    const documentId = String(b['documentId'] ?? chunk?.documentId ?? '');
    const version = String(b['version'] ?? chunk?.version ?? '');
    const attr = chunkId === undefined ? '' : ` chunk="${chunkId}"`;
    return `<document id="${documentId}" version="${version}"${attr} trust="${String(b['trust'])}">\n${texts[i] ?? ''}\n</document>`;
  });
  const question = before.find((m) => m.role === 'user')?.content ?? '';
  // Function replacements, so a '$' in the question or a document is never a pattern.
  const user = String(after['user_template'] ?? '')
    .replace('<question>', () => question)
    .replace('<document blocks>', () => (blocks.length ? blocks.join('\n') : '(none)'));
  return [
    { role: 'system', content: String(after['system'] ?? '') },
    { role: 'user', content: user },
  ];
}

/**
 * The panel's content at a cursor, or undefined before the scored chunks are returned (or
 * in a scenario without them).
 */
export function retrievalModel(
  events: readonly ScenarioEvent[],
  cursor: number,
  index: SearchedIndex,
): RetrievalModel | undefined {
  const scored = find(events, 'retrieve-05');
  if (!reached(scored, cursor)) return undefined;
  const payload = (i: number): Obj => obj(events[i]?.payload as Json | undefined);
  const chunks = new Map(index.chunks.map((c) => [c.id, c]));
  const hitsAt = find(events, 'hybrid-02');
  const keyword = new Map(
    reached(hitsAt, cursor)
      ? list(payload(hitsAt)['hits']).map((h) => [
          String(obj(h)['chunkId']),
          Number(obj(h)['keywordScore']),
        ])
      : [],
  );
  const rerankAt = find(events, 'hybrid-03');
  const rerank = new Map(
    reached(rerankAt, cursor)
      ? list(payload(rerankAt)['candidates']).map((c) => [
          String(obj(c)['chunkId']),
          Number(obj(c)['rerankScore']),
        ])
      : [],
  );
  const selectAt = find(events, 'retrieve-06');
  const selection = payload(selectAt);
  const outcomes = new Map<string, Outcome>();
  if (reached(selectAt, cursor)) {
    list(selection['retained']).forEach((id, i) =>
      outcomes.set(String(id), { retained: true, rank: i + 1 }),
    );
    for (const d of list(selection['discarded']))
      outcomes.set(String(obj(d)['chunkId']), {
        retained: false,
        reason: String(obj(d)['reason']),
      });
  }
  const rows = list(payload(scored)['matches']).map((raw): ScoreRow => {
    const m = obj(raw);
    const chunkId = String(m['chunkId']);
    const documentId = String(m['documentId']);
    const vector = chunks.get(chunkId)?.embedding ?? [];
    const row: ScoreRow = {
      chunkId,
      documentId,
      version: String(m['version']),
      score: Number(m['score']),
      vector,
      point: index.project(vector),
    };
    const k = keyword.get(chunkId);
    if (k !== undefined) row.keyword = k;
    const r = rerank.get(chunkId);
    if (r !== undefined) row.rerank = r;
    const o = outcomes.get(chunkId);
    if (o) row.outcome = o;
    return row;
  });
  const queryAt = find(events, 'retrieve-03');
  const queryVector = list(payload(queryAt)['embedding']).map(Number);
  const model: RetrievalModel = {
    rows,
    ...(reached(selectAt, cursor)
      ? {
          selection: {
            threshold: Number(selection['similarity_threshold']),
            topK: Number(selection['top_k']),
            rerank: selection['rerank'] === true,
          },
        }
      : {}),
    selectionStep: selectAt + 1,
    query: reached(queryAt, cursor) && queryVector.length ? index.project(queryVector) : undefined,
  };
  const assembled = find(events, 'retrieve-09');
  const sentAt = find(events, 'retrieve-10');
  if (reached(assembled, cursor)) {
    const before = messages(payload(assembled)['prompt_before']);
    model.prompt = {
      before,
      after: assembledPrompt(events[assembled], before, chunks),
      sentStep: sentAt + 1,
      sent: reached(sentAt, cursor),
    };
  }
  const shownAt = find(events, 'retrieve-12');
  if (reached(shownAt, cursor)) model.answer = shownAnswer(events[shownAt]);
  return model;
}

/** The answer an event shows the user (retrieve-12, c-08): its text and its sources. */
export function shownAnswer(event: ScenarioEvent | undefined): { text: string; sources: Source[] } {
  const payload = obj(event?.payload as Json | undefined);
  const raw = list(payload['sources']).map((s) => obj(s));
  const lines = sourceLines(
    raw.map((s) => ({
      id: String(s['chunkId'] ?? ''),
      documentId: String(s['documentId']),
      version: String(s['version']),
      text: '',
      document: s['chunkId'] === undefined,
    })),
  );
  return {
    text: String(payload['answer']),
    sources: raw.map((s, i) => ({
      citation: Number(s['citation']),
      ...(s['chunkId'] !== undefined ? { chunkId: String(s['chunkId']) } : {}),
      documentId: String(s['documentId']),
      version: String(s['version']),
      line: lines[i] ?? '',
    })),
  };
}

/** The answer split into text and citation numbers, in order. */
export function answerParts(text: string): (string | number)[] {
  return text
    .split(/\[(\d+)\]/)
    .map((part, i) => (i % 2 ? Number(part) : part))
    .filter((part) => part !== '');
}

/** One segment of a prompt message: plain text, or a document block with its attributes. */
export type PromptPart = { text: string } | { block: Record<string, string>; text: string };

/** Splits a message into plain text and its <document …> blocks. */
export function promptParts(content: string): PromptPart[] {
  const out: PromptPart[] = [];
  const re = /<document ([^>]*)>\n([\s\S]*?)\n<\/document>\n?/g;
  let last = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    if (m.index > last) out.push({ text: content.slice(last, m.index) });
    const block = Object.fromEntries(
      [...(m[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1] ?? '', a[2] ?? '']),
    );
    out.push({ block, text: m[2] ?? '' });
    last = re.lastIndex;
  }
  if (last < content.length) out.push({ text: content.slice(last) });
  return out;
}

/** What a citation opens: the chunk (if any) next to its source document. */
export interface EvidenceView {
  source: Source;
  documentWords: string[];
  /** Absent for a parent document. */
  chunk?: { startWord: number; words: string[] };
}

export function evidence(source: Source, index: SearchedIndex): EvidenceView | undefined {
  const doc = index.docs.find(
    (d) => d.documentId === source.documentId && d.version === source.version,
  );
  if (!doc) return undefined;
  const view: EvidenceView = { source, documentWords: words(doc.text) };
  if (source.chunkId === undefined) return view;
  const chunk = index.chunks.find((c) => c.id === source.chunkId);
  if (!chunk) return undefined;
  view.chunk = { startWord: chunk.startWord, words: chunk.text ? chunk.text.split(' ') : [] };
  return view;
}

/** Short point label: '<stem>@<version> · <nnn>' from a chunk ID. */
export function pointLabel(chunkId: string): string {
  const m = /^(.*)-c\d+o\d+-(\d+)$/.exec(chunkId);
  return m ? `${m[1] ?? ''} · ${m[2] ?? ''}` : chunkId;
}

/** An axis-aligned box in pixels. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A point of the projection to draw: its projected coordinates and label. */
export interface ProjectedPoint {
  x: number;
  y: number;
  label: string;
  /** The chunk ID; empty for the question. */
  id: string;
  retained: boolean;
}

export interface PlacedLabel {
  /** The text's anchor point (x) and baseline (y). */
  x: number;
  y: number;
  anchor: 'start' | 'end';
  box: Box;
  /** A leader line from the point to the label, when the label moved off its point's row. */
  leader?: [number, number, number, number];
}

export interface ProjectionLayout {
  width: number;
  height: number;
  /** Pixel position of each point, in input order. */
  pixels: { x: number; y: number }[];
  /** Each point's mark as a box (to keep labels off it). */
  marks: Box[];
  /** Each point's label, in input order; in the compact form only the question's. */
  labels: (PlacedLabel | undefined)[];
  /** The compact form of phones: only the question is labelled at its point. */
  compact: boolean;
  axes: { x: [number, number, number, number]; y: [number, number, number, number] };
  axisNames: { text: string; x: number; y: number; anchor: 'start' | 'end'; box: Box }[];
}

/** Width of a character of the code font at the small size (JetBrains Mono: 0.6 em). */
export const CODE_CHAR = 13 * 0.6;
/** Width of a character of the text font at the small size, generously. */
const TEXT_CHAR = 7.5;
/** A label's glyph box is 16 px tall; labels move by a line of 18 px. */
const GLYPH = 16;
const LINE = 18;
const GAP = 6;
const MARK = 6;

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Whether the segment crosses the box (Liang–Barsky clipping). */
export function segmentCrosses(s: readonly [number, number, number, number], b: Box): boolean {
  const [x1, y1, x2, y2] = s;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, x1 - b.left],
    [dx, b.right - x1],
    [-dy, y1 - b.top],
    [dy, b.bottom - y1],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/** Whether two segments meet (touching or overlapping counts). */
export function segmentsMeet(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): boolean {
  const [x1, y1, x2, y2] = a;
  const [x3, y3, x4, y4] = b;
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const on = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    Math.min(ax, bx) - 0.5 <= cx &&
    cx <= Math.max(ax, bx) + 0.5 &&
    Math.min(ay, by) - 0.5 <= cy &&
    cy <= Math.max(ay, by) + 0.5;
  const d1 = cross(x3, y3, x4, y4, x1, y1);
  const d2 = cross(x3, y3, x4, y4, x2, y2);
  const d3 = cross(x1, y1, x2, y2, x3, y3);
  const d4 = cross(x1, y1, x2, y2, x4, y4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true;
  const eps = 1e-6;
  return (
    (Math.abs(d1) < eps && on(x3, y3, x4, y4, x1, y1)) ||
    (Math.abs(d2) < eps && on(x3, y3, x4, y4, x2, y2)) ||
    (Math.abs(d3) < eps && on(x1, y1, x2, y2, x3, y3)) ||
    (Math.abs(d4) < eps && on(x1, y1, x2, y2, x4, y4))
  );
}

/** Leaders longer than this many lines make a layout unacceptable where another fits. */
const MAX_LEADER_LINES = 8;

/** Places the labels in the given order (projectionLayout); cost counts unplaced labels first. */
function placeInOrder(
  order: readonly number[],
  points: readonly ProjectedPoint[],
  pixels: readonly { x: number; y: number }[],
  marks: readonly Box[],
  fixed: readonly Box[],
  names: readonly Box[],
  width: number,
): { labels: (PlacedLabel | undefined)[]; cost: number } {
  const placed: Box[] = [];
  const leaders: [number, number, number, number][] = [];
  const labels = new Array<PlacedLabel | undefined>(points.length).fill(undefined);
  let cost = 0;
  for (const i of order) {
    const p = pixels[i] as { x: number; y: number };
    const w = (points[i]?.label.length ?? 0) * CODE_CHAR;
    const own = marks[i] as Box;
    const others = marks.filter((_, j) => j !== i);
    // A leader starts at its point, so marks on top of that point cannot block it.
    const apart = others.filter((m) => !overlaps(m, own));
    let chosen: PlacedLabel | undefined;
    for (let k = 0; k <= MAX_LEADER_LINES && !chosen; k += 1) {
      for (const dy of k === 0 ? [0] : [-k * LINE, k * LINE]) {
        for (const anchor of ['start', 'end'] as const) {
          const x = anchor === 'start' ? p.x + GAP + 2 : p.x - GAP - 2;
          const left = anchor === 'start' ? x : x - w;
          const y = p.y + 4 + dy;
          const box = { left, right: left + w, top: y - GLYPH + 4, bottom: y + 4 };
          if (box.left < 0 || box.right > width || box.top < 0) continue;
          const leader: [number, number, number, number] | undefined = dy
            ? [p.x, p.y + (dy < 0 ? -MARK : MARK), anchor === 'start' ? left : left + w, y - 4]
            : undefined;
          const blocked =
            [...placed, ...fixed, ...others, own].some((b) => overlaps(box, b)) ||
            leaders.some((s) => segmentCrosses(s, box)) ||
            (leader !== undefined &&
              ([...placed, ...apart, ...names].some((b) => segmentCrosses(leader, b)) ||
                leaders.some((s) => segmentsMeet(s, leader))));
          if (blocked) continue;
          chosen = { x, y, anchor, box, ...(leader ? { leader } : {}) };
          cost += dy * dy;
          break;
        }
        if (chosen) break;
      }
    }
    if (!chosen) {
      // Keeps every point labelled if the search runs out; such a layout is never chosen
      // while another one places every label.
      cost += 1e6;
      chosen = {
        x: p.x + GAP + 2,
        y: p.y + 4,
        anchor: 'start',
        box: { left: p.x + GAP + 2, right: p.x + GAP + 2 + w, top: p.y - 8, bottom: p.y + 8 },
      };
    }
    placed.push(chosen.box);
    if (chosen.leader) leaders.push(chosen.leader);
    labels[i] = chosen;
  }
  return { labels, cost };
}

/** One layout of the plot with a given side, left edge and total width, and its leader cost. */
export function layoutAt(
  points: readonly ProjectedPoint[],
  side: number,
  margin: number,
  width: number,
  compact = false,
): { layout: ProjectionLayout; cost: number } {
  const top = 40;
  const px = (x: number): number => margin + ((x + 1) / 2) * side;
  const py = (y: number): number => top + ((1 - y) / 2) * side;
  const cx = px(0);
  const cy = py(0);
  const axes: ProjectionLayout['axes'] = {
    x: [px(-1), cy, px(1), cy],
    y: [cx, py(1), cx, py(-1)],
  };
  const name = (
    text: string,
    x: number,
    y: number,
    anchor: 'start' | 'end',
  ): ProjectionLayout['axisNames'][number] => {
    const w = text.length * TEXT_CHAR;
    const left = anchor === 'start' ? x : x - w;
    return { text, x, y, anchor, box: { left, right: left + w, top: y - 12, bottom: y + 4 } };
  };
  const axisNames = [
    name('← rules', px(-1), cy + 20, 'start'),
    name('cost →', px(1), cy + 20, 'end'),
    name('↑ product', cx + GAP, py(1) - 12, 'start'),
    name('↓ technical', cx + GAP, py(-1) + 20, 'start'),
  ];
  const pixels = points.map((p) => ({ x: px(p.x), y: py(p.y) }));
  const marks = pixels.map((p) => ({
    left: p.x - MARK,
    right: p.x + MARK,
    top: p.y - MARK,
    bottom: p.y + MARK,
  }));
  const names = axisNames.map((a) => a.box);
  const fixed: Box[] = [
    { left: axes.x[0], right: axes.x[2], top: cy - 1, bottom: cy + 1 },
    { left: cx - 1, right: cx + 1, top: axes.y[1], bottom: axes.y[3] },
    ...names,
  ];
  // Greedy placement depends on the order; try a few and keep the one with the fewest
  // unplaced labels, then the shortest leaders (squared, so no leader grows long).
  const near = (i: number): number =>
    pixels.filter(
      (q, j) =>
        j !== i &&
        Math.abs(q.x - (pixels[i]?.x ?? 0)) < 120 &&
        Math.abs(q.y - (pixels[i]?.y ?? 0)) < 40,
    ).length;
  const indices = points.map((_, i) => i);
  const by = (f: (i: number) => number) => [...indices].sort((a, b) => f(a) - f(b) || a - b);
  // The compact form labels the question only (02 rag_retrieval.projection).
  const labelled = compact ? indices.filter((i) => !points[i]?.id) : indices;
  const orders = compact
    ? [labelled]
    : [
        by((i) => pixels[i]?.y ?? 0),
        by((i) => -(pixels[i]?.y ?? 0)),
        by((i) => pixels[i]?.x ?? 0),
        by((i) => -(pixels[i]?.x ?? 0)),
        by((i) => -near(i)),
        by((i) => near(i)),
      ];
  let best: { labels: (PlacedLabel | undefined)[]; cost: number } | undefined;
  for (const order of orders) {
    const result = placeInOrder(order, points, pixels, marks, fixed, names, width);
    if (!best || result.cost < best.cost) best = result;
    if (best.cost === 0) break;
  }
  const labels = best?.labels ?? [];
  const height = Math.ceil(
    Math.max(
      py(-1) + 32,
      ...labels.map((l) => (l ? l.box.bottom + 4 : 0)),
      ...axisNames.map((a) => a.box.bottom + 4),
    ),
  );
  return {
    layout: { width, height, pixels, marks, labels, axes, axisNames, compact },
    cost: best?.cost ?? 0,
  };
}

/** The plot's smallest side (02 rag_retrieval.projection). */
const MIN_SIDE = 260;

/** Horizontal positions of the plot within the free width, as shares, tried in this order. */
const SHARES = [0.7, 0.5, 0.85, 0.3, 0.6, 0.4, 1, 0];

/**
 * Lays out the projection (02 rag_retrieval.projection) for an available width: a square
 * plot from −1 to 1, axes named at their ends, and a label beside every point. A label goes
 * right or left of its point; where it would overlap another label, a point mark, an axis,
 * an axis name or a leader line, it moves up or down by a line, nearest first, beside a
 * leader line that crosses nothing. The plot takes the largest side (at most 560 px, at
 * least 260 px) at which every label fits somewhere within the width; of the positions at
 * that side, the one with the shortest leaders (by squared length) is drawn, the earlier in
 * SHARES on a tie. When none fits (phones), it is the compact form (compactLayout), which
 * is never wider than `available` either.
 */
export function projectionLayout(
  points: readonly ProjectedPoint[],
  available: number,
): ProjectionLayout {
  for (let side = Math.min(560, Math.floor(available) - 16); side >= MIN_SIDE; side -= 20) {
    const free = Math.floor(available) - side;
    let best: { layout: ProjectionLayout; cost: number } | undefined;
    for (const share of SHARES) {
      const candidate = layoutAt(points, side, Math.round(free * share), Math.floor(available));
      if (candidate.cost < (best?.cost ?? 1e6)) best = candidate;
      if (best?.cost === 0) break;
    }
    if (best) return best.layout;
  }
  return compactLayout(points, available);
}

/** The compact form's largest side (02 rag_retrieval.projection). */
const COMPACT_SIDE = 360;

/**
 * The compact form for widths where no labelled layout fits (phones): the square plot at the
 * available width, at most 360 px, with only the question labelled at its point. The view
 * names the other points in a list below the plot (02 rag_retrieval.projection).
 */
export function compactLayout(
  points: readonly ProjectedPoint[],
  available: number,
): ProjectionLayout {
  const width = Math.floor(available);
  const side = Math.max(120, Math.min(COMPACT_SIDE, width - 2 * (GAP + MARK)));
  return layoutAt(points, side, Math.floor((width - side) / 2), width, true).layout;
}

/**
 * One line per chunk point of the compact form: its label, its position named by the axes
 * with 2 decimals, and whether it is retained (02 rag_retrieval.projection).
 */
export function positionLine(p: ProjectedPoint): string {
  // A coordinate that rounds to 0.00 lies on the other axis; it is named, not written as 0.
  const zero = (v: number): boolean => Math.abs(v) < 0.005;
  const x = zero(p.x)
    ? 'on the technical–product axis'
    : `${p.x < 0 ? 'rules' : 'cost'} ${Math.abs(p.x).toFixed(2)}`;
  const y = zero(p.y)
    ? 'on the rules–cost axis'
    : `${p.y < 0 ? 'technical' : 'product'} ${Math.abs(p.y).toFixed(2)}`;
  return `${p.label}: ${x}, ${y}${p.retained ? ' · retained' : ''}`;
}

// ---------------------------------------------------------------------------------------
// Views

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...children);
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

function focusKey<T extends HTMLElement>(node: T, key: string): T {
  node.dataset['focus'] = key;
  return node;
}

/** A threshold as the controls and the plot write it: 2 decimals, Python rounding. */
export const thresholdLabel = (x: number): string => Number(thresholdText(x)).toFixed(2);

const score4 = (x: number): string => x.toFixed(4);

/**
 * The projected points to draw: the question (if reached), then every chunk in score order,
 * each with its own label (02 rag_retrieval.projection).
 */
export function projectedPoints(model: RetrievalModel): ProjectedPoint[] {
  return [
    ...(model.query ? [{ ...model.query, label: 'question', id: '', retained: false }] : []),
    ...model.rows.map((row) => ({
      ...row.point,
      label: pointLabel(row.chunkId),
      id: row.chunkId,
      retained: row.outcome?.retained === true,
    })),
  ];
}

export interface RetrievalContext {
  /** The index the scenario searches at the current parameters. */
  index: () => SearchedIndex;
  /** Moves the cursor to a step (1-based). */
  jump: (step: number) => void;
  /** Takes focus when the panel disappears while holding it. */
  leave: () => void;
  /**
   * The sections shown, all by default; a phone row shows those of its step
   * (02 phone_steps.inline_panels).
   */
  sections?: readonly RetrievalSection[];
  /** Prefix of the element IDs, unique per page; "retrieval". */
  id?: string;
}

export type RetrievalSection = 'scores' | 'projection' | 'prompt' | 'answer';

/** Each section's heading, which names the panel when it shows without the scores. */
const SECTION_TITLES: Readonly<Record<RetrievalSection, string>> = {
  scores: 'Scores',
  projection: 'Projection',
  prompt: 'Prompt before and after retrieval',
  answer: 'Answer',
};

/** The panel; rebuilt only when what it shows changes, keeping focus on the same control. */
export class RetrievalPanel {
  readonly root: HTMLElement;
  private readonly context: RetrievalContext;
  private model: RetrievalModel | undefined;
  private selection: Selection | undefined;
  /** The open citation's number. */
  private open: number | undefined;
  private shown = '';
  private plot: { node: HTMLElement; draw: () => void } | undefined;
  /** The chunk whose line is pressed in the compact projection, marked on the plot. */
  private pointed: string | undefined;
  private readonly observer: ResizeObserver | undefined;
  private lastWidth = 0;

  constructor(context: RetrievalContext) {
    this.context = context;
    this.root = el('section', 'retrieval');
    if (this.shows('scores')) this.root.setAttribute('aria-labelledby', `${this.prefix}-title`);
    else {
      const first = context.sections?.[0];
      this.root.setAttribute('aria-label', first ? SECTION_TITLES[first] : 'Retrieval');
    }
    this.root.hidden = true;
    this.observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            const width = this.plot?.node.clientWidth ?? 0;
            if (width && width !== this.lastWidth) this.plot?.draw();
          });
  }

  destroy(): void {
    this.observer?.disconnect();
  }

  private get prefix(): string {
    return this.context.id ?? 'retrieval';
  }

  private shows(section: RetrievalSection): boolean {
    return !this.context.sections || this.context.sections.includes(section);
  }

  update(model: RetrievalModel | undefined, selection: Selection | undefined): void {
    this.model = model;
    this.selection = selection?.key === 'chunkId' ? selection : undefined;
    // A citation that no longer exists closes.
    if (this.open !== undefined && !model?.answer?.sources.some((s) => s.citation === this.open))
      this.open = undefined;
    const key = JSON.stringify([model, this.selection, this.open]);
    if (key === this.shown) return;
    this.shown = key;
    const active = document.activeElement;
    // The focused control's key, '' for an element without one, undefined outside the panel.
    const restore =
      active instanceof HTMLElement && this.root.contains(active)
        ? (active.closest<HTMLElement>('[data-focus]')?.dataset['focus'] ?? '')
        : undefined;
    this.observer?.disconnect();
    this.plot = undefined;
    this.root.hidden = !model;
    if (!model) {
      this.root.replaceChildren();
      if (restore !== undefined) this.context.leave();
      return;
    }
    const index = this.context.index();
    const scores = this.shows('scores')
      ? [
          Object.assign(el('h3', undefined, 'Why each chunk was kept or dropped'), {
            id: `${this.prefix}-title`,
            tabIndex: -1,
          }),
          this.scores(model),
        ]
      : [];
    this.root.replaceChildren(
      ...scores,
      ...(this.shows('projection') ? [this.projection(model)] : []),
      ...(model.prompt && this.shows('prompt') ? [this.prompt(model.prompt)] : []),
      ...(model.answer && this.shows('answer') ? [this.answer(model.answer, index)] : []),
    );
    // Draw once attached, so the plot knows its width.
    const plot = this.plot as RetrievalPanel['plot'];
    if (plot) {
      this.observer?.observe(plot.node);
      plot.draw();
    }
    if (restore !== undefined) {
      // A control that is gone (or one without a key) hands focus to the panel's heading.
      const target =
        (restore &&
          this.root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(restore)}"]`)) ||
        this.root.querySelector<HTMLElement>(`#${this.prefix}-title`);
      target?.focus({ preventScroll: true });
    }
  }

  private stepLink(step: number, key: string): HTMLButtonElement {
    const link = focusKey(el('button', 'link', `step ${step}`), key);
    link.type = 'button';
    link.addEventListener('click', () => this.context.jump(step));
    return link;
  }

  private scores(model: RetrievalModel): HTMLElement {
    const sel = model.selection;
    const marked = this.selection?.value;
    const items = model.rows.map((r) => {
      const retained = r.outcome?.retained === true;
      const li = el('li', retained ? 'retained' : undefined);
      li.dataset['chunk'] = r.chunkId;
      li.style.setProperty('--x', String(Math.min(Math.max(r.score, 0), 1)));
      const details: string[] = [];
      if (r.outcome)
        details.push(r.outcome.retained ? `retained, rank ${r.outcome.rank}` : r.outcome.reason);
      if (r.rerank !== undefined) details.push(`rerank ${score4(r.rerank)}`);
      if (r.keyword !== undefined) details.push(`keyword ${String(r.keyword)}`);
      // The value sits on the side away from the threshold, so the line stays continuous.
      const below = sel !== undefined && r.score < sel.threshold;
      li.append(
        el('span', `name${r.chunkId === marked ? ' chunk-mark' : ''}`, r.chunkId),
        el(
          'span',
          'track',
          el('span', 'dot'),
          el('span', `value score-value${below ? ' value--left' : ''}`, score4(r.score)),
        ),
        el('span', `outcome${retained ? '' : ' muted'}`, details.join(' · ')),
      );
      return li;
    });
    // The threshold's label above the tracks (from retrieve-06), and the axis below them.
    const threshold = sel ? thresholdLabel(sel.threshold) : undefined;
    const head = el(
      'li',
      undefined,
      el('span'),
      el(
        'span',
        'scale scale--top',
        ...(threshold ? [el('span', 'threshold-label', `threshold ${threshold}`)] : []),
      ),
      el('span'),
    );
    head.setAttribute('aria-hidden', 'true');
    const plot = el('ol', `dotplot${sel ? ' dotplot--threshold' : ''}`, head, ...items);
    const foot = el('li');
    foot.setAttribute('aria-hidden', 'true');
    const zero = el('span', undefined, '0');
    const one = el('span', undefined, '1');
    zero.style.left = '0';
    one.style.left = '100%';
    foot.append(el('span'), el('span', 'scale', zero, one), el('span'));
    plot.append(foot);
    if (sel) plot.style.setProperty('--threshold', String(Math.min(Math.max(sel.threshold, 0), 1)));
    plot.setAttribute(
      'aria-label',
      `Cosine similarity of each chunk to the question, from 0 to 1${threshold ? `, with the threshold at ${threshold}` : ''}`,
    );
    const notes: HTMLElement[] = [];
    if (!sel)
      notes.push(
        el(
          'p',
          'small muted',
          'Top K and the threshold are applied at ',
          this.stepLink(model.selectionStep, 'selection-step'),
          '.',
        ),
      );
    else if (sel.rerank)
      notes.push(
        el(
          'p',
          'small muted rerank-note',
          `With reranking, the ${sel.topK === 1 ? 'best chunk' : `${sel.topK} best chunks`} by reranker score ${sel.topK === 1 ? 'is' : 'are'} retained, so a retained chunk can have a lower cosine score than a dropped one.`,
        ),
      );
    return el(
      'div',
      'retrieval-scores',
      el('h4', undefined, SECTION_TITLES.scores),
      plot,
      ...notes,
    );
  }

  private projection(model: RetrievalModel): HTMLElement {
    const node = el('div', 'projection');
    const figure = el(
      'figure',
      'retrieval-projection',
      el('h4', undefined, SECTION_TITLES.projection),
      node,
      el(
        'figcaption',
        'small muted',
        'A fixed 2D projection: x = cost − rules, y = product − technical. Conceptual only: the scores are computed in all four dimensions.',
      ),
    );
    const marked = this.selection?.value;
    const points = projectedPoints(model);
    const draw = (): void => {
      this.lastWidth = node.clientWidth;
      const active = document.activeElement;
      const restore =
        active instanceof HTMLElement && node.contains(active)
          ? active.dataset['focus']
          : undefined;
      const point = (id: string): void => {
        this.pointed = this.pointed === id ? undefined : id;
        draw();
      };
      const layout = projectionLayout(points, Math.max(node.clientWidth, 240));
      // Too narrow for the plot and its labels: the plot scrolls in a named, focusable region.
      if (layout.width > node.clientWidth) {
        node.setAttribute('role', 'region');
        node.setAttribute('aria-label', 'Projection, scrolls horizontally');
        node.tabIndex = 0;
      } else {
        node.removeAttribute('role');
        node.removeAttribute('aria-label');
        node.removeAttribute('tabindex');
      }
      const root = svg('svg', {
        class: 'projection-plot',
        width: layout.width,
        height: layout.height,
        viewBox: `0 0 ${layout.width} ${layout.height}`,
        role: 'group',
        'aria-label': 'Chunks and the question in the fixed 2D projection',
      });
      // In the compact form the list below carries the points for assistive technology.
      if (layout.compact) {
        root.removeAttribute('role');
        root.removeAttribute('aria-label');
        root.setAttribute('aria-hidden', 'true');
      }
      const [ax1, ay1, ax2, ay2] = layout.axes.x;
      const [bx1, by1, bx2, by2] = layout.axes.y;
      root.append(
        svg('line', { class: 'axis', x1: ax1, y1: ay1, x2: ax2, y2: ay2 }),
        svg('line', { class: 'axis', x1: bx1, y1: by1, x2: bx2, y2: by2 }),
        ...layout.axisNames.map((a) => {
          const t = svg(
            'text',
            { class: 'axis-name', x: a.x, y: a.y, 'text-anchor': a.anchor },
            a.text,
          );
          t.setAttribute('aria-hidden', 'true');
          return t;
        }),
      );
      points.forEach((p, i) => {
        const at = layout.pixels[i] as { x: number; y: number };
        const l = layout.labels[i];
        const name = (id: string): string =>
          `${id || 'The question'}: x ${p.x.toFixed(4)}, y ${p.y.toFixed(4)}${p.retained ? ', retained' : ''}`;
        const g = svg('g', {
          class: p.id ? (p.retained ? 'point retained' : 'point') : 'point query',
          ...(layout.compact
            ? {}
            : {
                role: 'img',
                'aria-label': name(p.id),
              }),
        });
        if (p.id) g.dataset['chunk'] = p.id;
        if (l?.leader) {
          const [x1, y1, x2, y2] = l.leader;
          g.append(svg('line', { class: 'leader', x1, y1, x2, y2 }));
        }
        const selected = !!p.id && p.id === marked;
        if (l && selected) {
          // Selection background plus an ink underline (02 design.colour.use).
          const { left, right, top, bottom } = l.box;
          g.append(
            svg('rect', {
              class: 'label-mark',
              x: left - 2,
              y: top,
              width: right - left + 4,
              height: bottom - top,
            }),
            svg('line', {
              class: 'label-underline',
              x1: left - 2,
              y1: bottom - 0.5,
              x2: right + 2,
              y2: bottom - 0.5,
            }),
          );
        }
        // The compact form: the pressed line's point, and the lineage-selected one, get an
        // ink ring; tapping a point presses its line.
        if (layout.compact && p.id) {
          if (p.id === this.pointed || selected)
            g.append(svg('circle', { class: 'point-ring', cx: at.x, cy: at.y, r: 9 }));
          g.addEventListener('click', () => point(p.id));
        }
        if (p.id) g.append(svg('circle', { class: 'mark', cx: at.x, cy: at.y, r: 4 }));
        else
          g.append(
            svg('path', {
              class: 'mark',
              d: `M${at.x - 5},${at.y} h10 M${at.x},${at.y - 5} v10`,
            }),
          );
        if (l)
          g.append(
            svg('text', { class: 'point-label', x: l.x, y: l.y, 'text-anchor': l.anchor }, p.label),
          );
        root.append(g);
      });
      // The compact form names every chunk point in a list below the plot, in score order.
      const list = layout.compact
        ? [
            el(
              'ol',
              'projection-list small',
              ...points
                .filter((p) => p.id)
                .map((p) => {
                  const selected = p.id === marked;
                  const [label, rest] = [p.label, positionLine(p).slice(p.label.length)];
                  const toggle = focusKey(
                    el(
                      'button',
                      'projection-item',
                      el('span', selected ? 'chunk-mark' : undefined, label),
                      rest,
                    ),
                    `point:${p.id}`,
                  );
                  toggle.type = 'button';
                  toggle.setAttribute('aria-pressed', String(p.id === this.pointed));
                  toggle.addEventListener('click', () => point(p.id));
                  const item = el('li', p.retained ? 'retained' : undefined, toggle);
                  item.dataset['chunk'] = p.id;
                  return item;
                }),
            ),
          ]
        : [];
      node.replaceChildren(root, ...list);
      if (restore)
        node
          .querySelector<HTMLElement>(`[data-focus="${CSS.escape(restore)}"]`)
          ?.focus({ preventScroll: true });
    };
    this.plot = { node, draw };
    return figure;
  }

  private prompt(prompt: NonNullable<RetrievalModel['prompt']>): HTMLElement {
    const column = (title: string, msgs: PromptMessage[]): HTMLElement =>
      el(
        'div',
        'retrieval-column',
        el('h5', 'small muted', title),
        ...msgs.map((m) =>
          el('div', 'prompt-message', el('p', 'small muted role', m.role), this.messageText(m)),
        ),
      );
    const status = prompt.sent
      ? el(
          'p',
          'small muted',
          'Sent to the model at ',
          this.stepLink(prompt.sentStep, 'sent-step'),
          ': only now does the model see the retrieved text.',
        )
      : el(
          'p',
          'small muted',
          'Assembled by the agent; the model has not seen it yet. It is sent at ',
          this.stepLink(prompt.sentStep, 'sent-step'),
          '.',
        );
    return el(
      'div',
      'retrieval-prompt',
      el('h4', undefined, SECTION_TITLES.prompt),
      status,
      el(
        'div',
        'retrieval-columns',
        column('Before retrieval', prompt.before),
        column('After retrieval', prompt.after),
      ),
    );
  }

  private messageText(m: PromptMessage): HTMLElement {
    const out = el('div', 'prompt-text');
    for (const part of promptParts(m.content)) {
      if (!('block' in part)) {
        out.append(el('pre', 'code-text', part.text.replace(/\n$/, '')));
        continue;
      }
      const block = el('div', 'document-block');
      const head = Object.entries(part.block)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      block.append(
        el('p', 'small muted code-text', `<document ${head}>`),
        el('p', 'code-text', part.text),
      );
      out.append(block);
    }
    return out;
  }

  private answer(answer: NonNullable<RetrievalModel['answer']>, index: SearchedIndex): HTMLElement {
    const sources = new Map(answer.sources.map((s) => [s.citation, s]));
    const text = el('p', 'answer-text');
    appendCited(text, answer.text, new Map(), (n, nth) =>
      citationButton(n, nth, sources.get(n), this.open === n, `${this.prefix}-evidence`, () => {
        this.open = this.open === n ? undefined : n;
        this.update(this.model, this.selection);
      }),
    );
    const lines = answer.sources.length
      ? el('ol', 'sources small', ...answer.sources.map((s) => el('li', 'source-line', s.line)))
      : el('p', 'small muted', 'No sources: the answer cites nothing.');
    const open = this.open === undefined ? undefined : sources.get(this.open);
    const view = open ? evidence(open, index) : undefined;
    const holder = el('div', 'evidence');
    holder.id = `${this.prefix}-evidence`;
    if (view) holder.append(renderEvidence(view));
    return el(
      'div',
      'retrieval-answer',
      el('h4', undefined, SECTION_TITLES.answer),
      el('p', 'small muted', 'Simulated model output, shown to the user with its sources.'),
      text,
      lines,
      holder,
    );
  }
}

/**
 * Appends text whose '[n]' citations become the given controls; a citation and the
 * punctuation right after it never break apart. `seen` counts each number's occurrences
 * (shared across calls for one answer), so focus can return to the same occurrence.
 */
export function appendCited(
  parent: HTMLElement,
  text: string,
  seen: Map<number, number>,
  control: (n: number, nth: number) => HTMLElement,
): void {
  let group: HTMLElement | undefined;
  for (const part of answerParts(text)) {
    if (typeof part === 'string') {
      const punctuation = group ? (/^[.,;:)]+/.exec(part)?.[0] ?? '') : '';
      if (group && punctuation) group.append(punctuation);
      if (part.length > punctuation.length) parent.append(part.slice(punctuation.length));
      group = undefined;
      continue;
    }
    const nth = (seen.get(part) ?? 0) + 1;
    seen.set(part, nth);
    group = el('span', 'citation-group', control(part, nth));
    parent.append(group);
  }
}

/** A citation button: pressed while open; it controls the element that shows its evidence. */
export function citationButton(
  n: number,
  nth: number,
  source: Source | undefined,
  open: boolean,
  controls: string,
  toggle: () => void,
): HTMLButtonElement {
  const b = focusKey(el('button', 'citation', `[${n}]`), `citation:${n}:${nth}`);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(open));
  b.setAttribute('aria-label', `Citation ${n}: ${source?.line.replace(/^\[\d+\] /, '') ?? ''}`);
  b.setAttribute('aria-controls', controls);
  b.addEventListener('click', toggle);
  return b;
}

/** What a citation opens: the chunk beside its source document, with the chunk marked. */
export function renderEvidence(view: EvidenceView): HTMLElement {
  const { source, chunk } = view;
  const end = chunk ? chunk.startWord + chunk.words.length : 0;
  const docText = el('p', 'evidence-text');
  if (chunk) {
    const before = view.documentWords.slice(0, chunk.startWord).join(' ');
    const inside = view.documentWords.slice(chunk.startWord, end).join(' ');
    const after = view.documentWords.slice(end).join(' ');
    docText.append(
      before ? `${before} ` : '',
      el('span', 'chunk-mark', inside),
      after ? ` ${after}` : '',
    );
  } else docText.append(view.documentWords.join(' '));
  const documentColumn = el(
    'div',
    'retrieval-column',
    el('h5', 'small muted', `Source document ${source.documentId} v${source.version}`),
    docText,
  );
  const title = chunk
    ? `[${source.citation}] chunk ${source.chunkId ?? ''}`
    : `[${source.citation}] ${source.documentId} v${source.version}, full document`;
  const columns: HTMLElement[] = [documentColumn];
  if (chunk)
    columns.unshift(
      el(
        'div',
        'retrieval-column',
        el(
          'h5',
          'small muted',
          `Chunk, words ${chunk.startWord}–${Math.max(end - 1, chunk.startWord)}`,
        ),
        el('p', 'evidence-text evidence-chunk', chunk.words.join(' ')),
      ),
    );
  return el(
    'div',
    undefined,
    el('h5', 'evidence-title', title),
    el('div', 'retrieval-columns', ...columns),
  );
}
