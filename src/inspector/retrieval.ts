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
  threshold: number;
  topK: number;
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
    threshold: Number(selection['similarity_threshold']),
    topK: Number(selection['top_k']),
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

export interface PlacedLabel {
  x: number;
  y: number;
  anchor: 'start' | 'end';
  /** Whether the label moved away from its point and needs a leader line. */
  moved: boolean;
}

/**
 * Places a label beside each point (pixel coordinates), moving a label down a line at a
 * time while it would overlap one already placed. Labels go right of their point unless
 * that runs past `width`. Points are handled from top to bottom.
 */
export function placeLabels(
  points: readonly { x: number; y: number; width: number }[],
  width: number,
  line = 16,
  gap = 6,
  obstacles: readonly { left: number; right: number; top: number; bottom: number }[] = [],
): PlacedLabel[] {
  const placed: { left: number; right: number; top: number; bottom: number }[] = [...obstacles];
  const out: PlacedLabel[] = new Array<PlacedLabel>(points.length);
  const order = points
    .map((_, i) => i)
    .sort((a, b) => (points[a]?.y ?? 0) - (points[b]?.y ?? 0) || a - b);
  for (const i of order) {
    const p = points[i] as { x: number; y: number; width: number };
    const right = p.x + gap + p.width <= width;
    const left = right ? p.x + gap : p.x - gap - p.width;
    let y = p.y + 4;
    const box = () => ({ left, right: left + p.width, top: y - line + 4, bottom: y + 4 });
    let moved = false;
    for (let tries = 0; tries < 64; tries += 1) {
      const b = box();
      const hit = placed.some(
        (q) => b.left < q.right && b.right > q.left && b.top < q.bottom && b.bottom > q.top,
      );
      if (!hit) break;
      y += line;
      moved = true;
    }
    placed.push(box());
    out[i] = { x: right ? p.x + gap : p.x - gap, y, anchor: right ? 'start' : 'end', moved };
  }
  return out;
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

/** Width of a label in the code font at the small size (JetBrains Mono: 0.6 em per character). */
const CHAR = 13 * 0.6;

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
    const projection = this.projection(model);
    this.root.replaceChildren(
      Object.assign(el('h3', undefined, 'Why each chunk was kept or dropped'), {
        id: 'retrieval-title',
        tabIndex: -1,
      }),
      el('div', 'retrieval-columns', this.scores(model), projection),
      ...(model.prompt ? [this.prompt(model.prompt)] : []),
      ...(model.answer ? [this.answer(model.answer, index)] : []),
    );
    // Draw once attached, so the plot knows its width.
    const plot = this.plot as RetrievalPanel['plot'];
    if (plot) {
      this.observer?.observe(plot.node);
      plot.draw();
    }
    if (restore) {
      const target =
        this.root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(restore)}"]`) ??
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
    const threshold = thresholdLabel(model.threshold);
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
      li.append(
        el('span', `name${r.chunkId === marked ? ' chunk-mark' : ''}`, r.chunkId),
        el('span', 'track', el('span', 'dot'), el('span', 'value score-value', score4(r.score))),
        el('span', `outcome${retained ? '' : ' muted'}`, details.join(' · ')),
      );
      return li;
    });
    // The threshold's label above the tracks, and the axis below them.
    const label = el('span', 'threshold-label', `threshold ${threshold}`);
    const head = el('li', undefined, el('span'), el('span', 'scale scale--top', label), el('span'));
    head.setAttribute('aria-hidden', 'true');
    const plot = el('ol', 'dotplot', head, ...items);
    const foot = el('li');
    foot.setAttribute('aria-hidden', 'true');
    const zero = el('span', undefined, '0');
    const one = el('span', undefined, '1');
    zero.style.left = '0';
    one.style.left = '100%';
    foot.append(el('span'), el('span', 'scale', zero, one), el('span'));
    plot.append(foot);
    plot.style.setProperty('--threshold', String(Math.min(Math.max(model.threshold, 0), 1)));
    plot.setAttribute(
      'aria-label',
      `Cosine similarity of each chunk to the question, from 0 to 1, with the threshold at ${threshold}`,
    );
    const best = model.topK === 1 ? 'the best one' : `the ${model.topK} best`;
    const note = model.rows.some((r) => r.outcome)
      ? el(
          'p',
          'small muted',
          `Chunks scoring at least ${threshold} are candidates; ${best} are retained.`,
        )
      : el(
          'p',
          'small muted',
          'Top K and the threshold are applied at ',
          this.stepLink(model.selectionStep, 'selection-step'),
          '.',
        );
    return el('div', 'retrieval-column', el('h4', undefined, 'Scores'), plot, note);
  }

  private projection(model: RetrievalModel): HTMLElement {
    const node = el('div', 'projection');
    const figure = el(
      'figure',
      'retrieval-column',
      el('h4', undefined, 'Projection'),
      node,
      el(
        'figcaption',
        'small muted',
        'A fixed 2D projection: x = cost − rules, y = product − technical. Conceptual only: the scores are computed in all four dimensions.',
      ),
    );
    const marked = this.selection?.value;
    const draw = (): void => {
      const width = Math.max(node.clientWidth, 240);
      this.lastWidth = node.clientWidth;
      const points = [
        ...(model.query ? [{ ...model.query, label: 'question', id: '', retained: false }] : []),
        ...model.rows.map((r) => ({
          ...r.point,
          label: pointLabel(r.chunkId),
          id: r.chunkId,
          retained: r.outcome?.retained === true,
        })),
      ];
      const longest = Math.max(...points.map((p) => p.label.length), 8) * CHAR;
      const pad = 24;
      const side = Math.max(160, Math.min(560, width - 2 * pad - longest / 3));
      const left = pad;
      const top = 24;
      const px = (x: number): number => left + ((x + 1) / 2) * side;
      const py = (y: number): number => top + ((1 - y) / 2) * side;
      const pixels = points.map((p) => ({
        x: px(p.x),
        y: py(p.y),
        width: p.label.length * CHAR,
      }));
      // Axis names sit at the axes' ends; point labels move out of their way.
      const axisNames = [
        { text: '← rules', x: px(-1), y: py(0) + 18, anchor: 'start' },
        { text: 'cost →', x: px(1), y: py(0) + 18, anchor: 'end' },
        { text: '↑ product', x: px(0) + 6, y: py(1) - 8, anchor: 'start' },
        { text: '↓ technical', x: px(0) + 6, y: py(-1) + 18, anchor: 'start' },
      ];
      const nameWidth = (t: string): number => t.length * 7.5;
      const labels = placeLabels(
        pixels,
        width - 2,
        16,
        6,
        axisNames.map((a) => ({
          left: a.anchor === 'end' ? a.x - nameWidth(a.text) : a.x,
          right: a.anchor === 'end' ? a.x : a.x + nameWidth(a.text),
          top: a.y - 12,
          bottom: a.y + 4,
        })),
      );
      const height = Math.max(top + side + 32, ...labels.map((l) => l.y + 8));
      const root = svg('svg', {
        class: 'projection-plot',
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        role: 'group',
        'aria-label': 'Chunks and the question in the fixed 2D projection',
      });
      const cx = px(0);
      const cy = py(0);
      root.append(
        svg('line', { class: 'axis', x1: px(-1), y1: cy, x2: px(1), y2: cy }),
        svg('line', { class: 'axis', x1: cx, y1: py(1), x2: cx, y2: py(-1) }),
        ...axisNames.map((a) =>
          svg('text', { class: 'axis-name', x: a.x, y: a.y, 'text-anchor': a.anchor }, a.text),
        ),
      );
      points.forEach((p, i) => {
        const at = pixels[i] as { x: number; y: number; width: number };
        const l = labels[i] as PlacedLabel;
        const g = svg('g', {
          class: p.id ? (p.retained ? 'point retained' : 'point') : 'point query',
        });
        if (p.id) g.dataset['chunk'] = p.id;
        g.append(
          svg(
            'title',
            {},
            `${p.id || 'question'}: x ${p.x.toFixed(4)}, y ${p.y.toFixed(4)}${p.retained ? ', retained' : ''}`,
          ),
        );
        if (l.moved) {
          g.append(
            svg('line', {
              class: 'leader',
              x1: at.x,
              y1: at.y,
              x2: l.anchor === 'start' ? l.x - 2 : l.x + 2,
              y2: l.y - 4,
            }),
          );
        }
        if (p.id && p.id === marked) {
          const w = at.width;
          const x0 = l.anchor === 'start' ? l.x : l.x - w;
          g.append(
            svg('rect', { class: 'label-mark', x: x0 - 2, y: l.y - 12, width: w + 4, height: 16 }),
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
    for (const part of answerParts(answer.text)) {
      if (typeof part === 'string') {
        text.append(part);
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
      text.append(b);
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
