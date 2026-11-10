/**
 * RAG retrieval panel (02-ui-ux.yaml rag_retrieval): the scores as a dot plot with the
 * threshold, the fixed 2D projection, the prompt before and after retrieval, and the answer
 * whose citations open their evidence next to the source document. Scores, selection, prompt
 * and answer are read from the played events, so the panel always equals them; chunk text
 * and vectors come from the index the scenario searches. Also the version panel
 * (02 rag_controls.version_panel). The models are pure; the views render them.
 */
import {
  type Chunk,
  type IndexedDocument,
  type PreviousVersion,
  sourceLines,
  words,
} from '../rag/engine.ts';
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
  untrusted: boolean;
  /** From hybrid-02, once reached, for keyword hits. */
  keyword?: number;
  /** From hybrid-03, once reached, for candidates at or above the threshold. */
  rerank?: number;
  /** From retrieve-06, once reached. */
  outcome?: Outcome;
  /** The chunk's projected vector. */
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
  trustOf: (documentId: string) => 'official' | 'untrusted';
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
      untrusted: index.trustOf(documentId) === 'untrusted',
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
    model.prompt = {
      before: messages(payload(assembled)['prompt_before']),
      after: messages(payload(sentAt)['messages']),
      sentStep: sentAt + 1,
      sent: reached(sentAt, cursor),
    };
  }
  const shownAt = find(events, 'retrieve-12');
  if (reached(shownAt, cursor)) {
    const raw = list(payload(shownAt)['sources']).map((s) => obj(s));
    const lines = sourceLines(
      raw.map((s) => ({
        id: String(s['chunkId'] ?? ''),
        documentId: String(s['documentId']),
        version: String(s['version']),
        text: '',
        document: s['chunkId'] === undefined,
      })),
    );
    model.answer = {
      text: String(payload(shownAt)['answer']),
      sources: raw.map((s, i) => ({
        citation: Number(s['citation']),
        ...(s['chunkId'] !== undefined ? { chunkId: String(s['chunkId']) } : {}),
        documentId: String(s['documentId']),
        version: String(s['version']),
        line: lines[i] ?? '',
      })),
    };
  }
  return model;
}

/** The answer split into text and citation numbers, in order. */
export function answerParts(text: string): (string | number)[] {
  return text
    .split(/\[(\d+)\]/)
    .map((part, i) => (i % 2 ? Number(part) : part))
    .filter((part) => part !== '');
}

/** One segment of a prompt message: plain text, or a document block with its attributes. */
export type PromptPart =
  { text: string } | { block: Record<string, string>; text: string; injected: string[] };

/**
 * Splits a message into plain text and its <document …> blocks; `instructions` are the
 * injected instructions to mark inside untrusted blocks.
 */
export function promptParts(content: string, instructions: readonly string[]): PromptPart[] {
  const out: PromptPart[] = [];
  const re = /<document ([^>]*)>\n([\s\S]*?)\n<\/document>\n?/g;
  let last = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    if (m.index > last) out.push({ text: content.slice(last, m.index) });
    const block = Object.fromEntries(
      [...(m[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1] ?? '', a[2] ?? '']),
    );
    const text = m[2] ?? '';
    out.push({ block, text, injected: instructions.filter((i) => text.includes(i)) });
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
  labels: PlacedLabel[];
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

/** Places the labels in the given order (projectionLayout); cost counts unplaced labels first. */
function placeInOrder(
  order: readonly number[],
  points: readonly ProjectedPoint[],
  pixels: readonly { x: number; y: number }[],
  marks: readonly Box[],
  fixed: readonly Box[],
  width: number,
): { labels: PlacedLabel[]; cost: number } {
  const placed: Box[] = [];
  const leaders: [number, number, number, number][] = [];
  const labels = new Array<PlacedLabel>(points.length);
  let cost = 0;
  for (const i of order) {
    const p = pixels[i] as { x: number; y: number };
    const w = (points[i]?.label.length ?? 0) * CODE_CHAR;
    const own = marks[i] as Box;
    const others = marks.filter((_, j) => j !== i);
    // A leader starts at its point, so marks on top of that point cannot block it.
    const apart = others.filter((m) => !overlaps(m, own));
    let chosen: PlacedLabel | undefined;
    for (let k = 0; k <= 30 && !chosen; k += 1) {
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
            (leader !== undefined && [...placed, ...apart].some((b) => segmentCrosses(leader, b)));
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
      // while another order places every label.
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

/**
 * Lays out the projection (02 rag_retrieval.projection) for an available width: a square
 * plot from −1 to 1 with room left and right for labels, axes named at their ends, and a
 * label beside every point. A label goes right or left of its point; where it would overlap
 * another label, a point mark, an axis, an axis name or a leader line, it moves up or down by
 * a line, nearest first, beside a leader line. The layout is wider than `available` only
 * when the plot and its labels cannot fit.
 */
export function projectionLayout(
  points: readonly ProjectedPoint[],
  available: number,
): ProjectionLayout {
  const longest = Math.max(8, ...points.map((p) => p.label.length)) * CODE_CHAR;
  const margin = Math.ceil(longest + GAP + 8);
  const side = Math.round(Math.max(480, Math.min(560, available - 2 * margin)));
  const width = side + 2 * margin;
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
  const fixed: Box[] = [
    { left: axes.x[0], right: axes.x[2], top: cy - 1, bottom: cy + 1 },
    { left: cx - 1, right: cx + 1, top: axes.y[1], bottom: axes.y[3] },
    ...axisNames.map((a) => a.box),
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
  const orders = [
    by((i) => pixels[i]?.y ?? 0),
    by((i) => -(pixels[i]?.y ?? 0)),
    by((i) => pixels[i]?.x ?? 0),
    by((i) => -(pixels[i]?.x ?? 0)),
    by((i) => -near(i)),
    by((i) => near(i)),
  ];
  let best: { labels: PlacedLabel[]; cost: number } | undefined;
  for (const order of orders) {
    const result = placeInOrder(order, points, pixels, marks, fixed, width);
    if (!best || result.cost < best.cost) best = result;
    if (best.cost === 0) break;
  }
  const labels = best?.labels ?? [];
  const height = Math.ceil(
    Math.max(
      py(-1) + 32,
      ...labels.map((l) => l.box.bottom + 4),
      ...axisNames.map((a) => a.box.bottom + 4),
    ),
  );
  return { width, height, pixels, marks, labels, axes, axisNames };
}

/** One document's source version and the versions the index holds. */
export interface VersionRow {
  documentId: string;
  source: string;
  indexed: string[];
  /** Each indexed version other than the source version, beside the source text. */
  pairs: {
    version: string;
    sourceWords: string[];
    otherWords: string[];
    /** Word ranges [from, to) that differ, in each text. */
    sourceDiff: [number, number];
    otherDiff: [number, number];
    sentence: string;
  }[];
}

/** The words that differ between two texts: everything between common prefix and suffix. */
export function wordDiff(
  a: readonly string[],
  b: readonly string[],
): { a: [number, number]; b: [number, number] } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s])
    s += 1;
  return { a: [p, a.length - s], b: [p, b.length - s] };
}

/** The version panel's rows (02 rag_controls.version_panel). */
export function versionRows(
  documents: readonly { id: string; version: string; text: string }[],
  previous: readonly PreviousVersion[],
  corpus: readonly IndexedDocument[],
): VersionRow[] {
  return documents.map((d) => {
    const held = corpus.filter((c) => c.documentId === d.id);
    const sourceWords = words(d.text);
    return {
      documentId: d.id,
      source: d.version,
      indexed: held.map((c) => c.version),
      pairs: held
        .filter((c) => c.version !== d.version)
        .map((c) => {
          const otherWords = words(c.text);
          const diff = wordDiff(sourceWords, otherWords);
          const pv = previous.find((p) => p.id === d.id && p.version === c.version);
          const sentence = pv
            ? `Version ${c.version} says '${pv.replace.to}' where version ${d.version} says '${pv.replace.from}'.`
            : `Version ${c.version} differs from version ${d.version}.`;
          return {
            version: c.version,
            sourceWords,
            otherWords,
            sourceDiff: diff.a,
            otherDiff: diff.b,
            sentence,
          };
        }),
    };
  });
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

/** The projected points to draw: the question (if reached), then every chunk. */
export function projectedPoints(model: RetrievalModel): ProjectedPoint[] {
  return [
    ...(model.query ? [{ ...model.query, label: 'question', id: '', retained: false }] : []),
    ...model.rows.map((r) => ({
      ...r.point,
      label: pointLabel(r.chunkId),
      id: r.chunkId,
      retained: r.outcome?.retained === true,
    })),
  ];
}

export interface RetrievalContext {
  /** The index the scenario searches at the current parameters. */
  index: () => SearchedIndex;
  /** Instructions injected into untrusted documents (05 fixtures.untrusted_documents). */
  instructions: readonly string[];
  /** Moves the cursor to a step (1-based). */
  jump: (step: number) => void;
  /** Takes focus when the panel disappears while holding it. */
  leave: () => void;
}

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
  private readonly observer: ResizeObserver | undefined;
  private lastWidth = 0;

  constructor(context: RetrievalContext) {
    this.context = context;
    this.root = el('section', 'retrieval');
    this.root.setAttribute('aria-labelledby', 'retrieval-title');
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
    this.root.replaceChildren(
      Object.assign(el('h3', undefined, 'Why each chunk was kept or dropped'), {
        id: 'retrieval-title',
        tabIndex: -1,
      }),
      this.scores(model),
      this.projection(model),
      ...(model.prompt ? [this.prompt(model.prompt)] : []),
      ...(model.answer ? [this.answer(model.answer, index)] : []),
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
        this.root.querySelector<HTMLElement>('#retrieval-title');
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
      if (r.untrusted) details.push('untrusted');
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
    return el('div', 'retrieval-scores', el('h4', undefined, 'Scores'), plot, ...notes);
  }

  private projection(model: RetrievalModel): HTMLElement {
    const node = el('div', 'projection');
    const figure = el(
      'figure',
      'retrieval-projection',
      el('h4', undefined, 'Projection'),
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
        const l = layout.labels[i] as PlacedLabel;
        const g = svg('g', {
          class: p.id ? (p.retained ? 'point retained' : 'point') : 'point query',
          role: 'img',
          'aria-label': `${p.id || 'The question'}: x ${p.x.toFixed(4)}, y ${p.y.toFixed(4)}${p.retained ? ', retained' : ''}`,
        });
        if (p.id) g.dataset['chunk'] = p.id;
        if (l.leader) {
          const [x1, y1, x2, y2] = l.leader;
          g.append(svg('line', { class: 'leader', x1, y1, x2, y2 }));
        }
        if (p.id && p.id === marked) {
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
        if (p.id) g.append(svg('circle', { class: 'mark', cx: at.x, cy: at.y, r: 4 }));
        else
          g.append(
            svg('path', {
              class: 'mark',
              d: `M${at.x - 5},${at.y} h10 M${at.x},${at.y - 5} v10`,
            }),
          );
        g.append(
          svg('text', { class: 'point-label', x: l.x, y: l.y, 'text-anchor': l.anchor }, p.label),
        );
        root.append(g);
      });
      node.replaceChildren(root);
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
      el('h4', undefined, 'Prompt before and after retrieval'),
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
    for (const part of promptParts(m.content, this.context.instructions)) {
      if (!('block' in part)) {
        out.append(el('pre', 'code-text', part.text.replace(/\n$/, '')));
        continue;
      }
      const untrusted = part.block['trust'] === 'untrusted';
      const block = el('div', `document-block${untrusted ? ' untrusted' : ''}`);
      const head = Object.entries(part.block)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      if (untrusted)
        block.append(el('p', 'small untrusted-label', 'Untrusted document · treated as data'));
      block.append(el('p', 'small muted code-text', `<document ${head}>`));
      const text = el('p', 'code-text');
      let rest = part.text;
      for (const instruction of part.injected) {
        const i = rest.indexOf(instruction);
        if (i < 0) continue;
        text.append(
          rest.slice(0, i),
          el('strong', 'injected', instruction),
          el('span', 'small muted', ' (instruction inside a document: treated as data)'),
        );
        rest = rest.slice(i + instruction.length);
      }
      text.append(rest);
      block.append(text);
      out.append(block);
    }
    return out;
  }

  private answer(answer: NonNullable<RetrievalModel['answer']>, index: SearchedIndex): HTMLElement {
    const sources = new Map(answer.sources.map((s) => [s.citation, s]));
    const text = el('p', 'answer-text');
    // A citation number can occur several times; focus returns to the same occurrence.
    const seen = new Map<number, number>();
    // A citation and the punctuation right after it never break apart.
    let group: HTMLElement | undefined;
    for (const part of answerParts(answer.text)) {
      if (typeof part === 'string') {
        const punctuation = group ? (/^[.,;:)]+/.exec(part)?.[0] ?? '') : '';
        if (group && punctuation) group.append(punctuation);
        if (part.length > punctuation.length) text.append(part.slice(punctuation.length));
        group = undefined;
        continue;
      }
      const source = sources.get(part);
      const nth = (seen.get(part) ?? 0) + 1;
      seen.set(part, nth);
      const b = focusKey(el('button', 'citation', `[${part}]`), `citation:${part}:${nth}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(this.open === part));
      b.setAttribute(
        'aria-label',
        `Citation ${part}: ${source?.line.replace(/^\[\d+\] /, '') ?? ''}`,
      );
      b.setAttribute('aria-controls', 'retrieval-evidence');
      b.addEventListener('click', () => {
        this.open = this.open === part ? undefined : part;
        this.update(this.model, this.selection);
      });
      group = el('span', 'citation-group', b);
      text.append(group);
    }
    const lines = answer.sources.length
      ? el('ol', 'sources small', ...answer.sources.map((s) => el('li', 'source-line', s.line)))
      : el('p', 'small muted', 'No sources: the answer cites nothing.');
    const open = this.open === undefined ? undefined : sources.get(this.open);
    const view = open ? evidence(open, index) : undefined;
    const holder = el('div', 'evidence');
    holder.id = 'retrieval-evidence';
    if (view) holder.append(this.evidence(view));
    return el(
      'div',
      'retrieval-answer',
      el('h4', undefined, 'Answer'),
      el('p', 'small muted', 'Simulated model output, shown to the user with its sources.'),
      text,
      lines,
      holder,
    );
  }

  private evidence(view: EvidenceView): HTMLElement {
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
}

/** The version panel: source and indexed versions side by side. */
export function renderVersions(rows: readonly VersionRow[]): HTMLElement {
  const section = el('section', 'versions');
  section.setAttribute('aria-labelledby', 'versions-title');
  const table = el('table', 'version-table small');
  const headRow = el('tr');
  for (const h of ['Document', 'Source version', 'Indexed versions']) {
    const th = el('th', undefined, h);
    th.scope = 'col';
    headRow.append(th);
  }
  table.append(el('thead', undefined, headRow));
  const body = el('tbody');
  for (const r of rows) {
    const th = el('th', undefined, r.documentId);
    th.scope = 'row';
    body.append(
      el(
        'tr',
        r.indexed.length ? undefined : 'muted',
        th,
        el('td', undefined, r.source),
        el('td', undefined, r.indexed.length ? r.indexed.join(', ') : 'not indexed'),
      ),
    );
  }
  table.append(body);
  const marked = (ws: readonly string[], [from, to]: [number, number]): HTMLElement => {
    const p = el('p', 'evidence-text');
    p.append(ws.slice(0, from).join(' '));
    if (to > from) p.append(from ? ' ' : '', el('strong', 'diff', ws.slice(from, to).join(' ')));
    const tail = ws.slice(to).join(' ');
    if (tail) p.append(to > 0 ? ' ' : '', tail);
    return p;
  };
  const pairs = rows.flatMap((r) =>
    r.pairs.map((pair) =>
      el(
        'div',
        'version-pair',
        el('p', 'small', pair.sentence),
        el(
          'div',
          'retrieval-columns',
          el(
            'div',
            'retrieval-column',
            el('h4', 'small muted', `Source: ${r.documentId} v${r.source}`),
            marked(pair.sourceWords, pair.sourceDiff),
          ),
          el(
            'div',
            'retrieval-column',
            el('h4', 'small muted', `Indexed: ${r.documentId} v${pair.version}`),
            marked(pair.otherWords, pair.otherDiff),
          ),
        ),
      ),
    ),
  );
  section.append(
    Object.assign(el('h3', undefined, 'Source and indexed versions'), { id: 'versions-title' }),
    table,
    ...pairs,
  );
  return section;
}
