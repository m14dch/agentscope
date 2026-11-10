/**
 * RAG ingestion panel (02-ui-ux.yaml rag_ingestion): a source document beside its chunks
 * with the overlap marked in place, and the selected chunk's metadata, lexicon hits and
 * vector. Chunks and vectors are read from the played index-05 and index-07 events, so
 * the panel always equals them; the model is pure and the view renders it.
 */
import {
  type EmbeddingWorking,
  type IndexedDocument,
  pyRound,
  type RagDocument,
  words,
} from '../rag/engine.ts';
import type { Json, ScenarioEvent } from '../scenarios/types.ts';

/** One indexed document version with its metadata. */
export interface SourceDocument {
  documentId: string;
  version: string;
  title: string;
  visibility: string;
  /** The normalized words (05 fixtures.chunking.words). */
  words: string[];
}

export interface ChunkView {
  id: string;
  documentId: string;
  version: string;
  startWord: number;
  words: string[];
  /** From index-07, once that step is reached. */
  vector?: number[];
}

export interface DocumentView extends SourceDocument {
  chunks: ChunkView[];
}

/** Words of the document (indices from, to - 1) that the selected chunk shares with a neighbour. */
export interface SharedRange {
  neighbour: ChunkView;
  from: number;
  to: number;
}

export interface IngestionModel {
  documents: DocumentView[];
  /** The chunking request's parameters (index-04). */
  chunkSize: number;
  overlap: number;
  /** 1-based step that computes the vectors (index-07). */
  vectorStep: number;
  /** Whether the cursor has reached it. */
  vectors: boolean;
}

/** The learner's selection: a document and the first word of the selected chunk. */
export interface ChunkSelection {
  documentId: string;
  startWord: number;
}

type Obj = Record<string, Json>;
const obj = (v: Json | undefined): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
const list = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);

/** Index of the event with this local ID (with or without the '<scenario>:' prefix). */
function find(events: readonly ScenarioEvent[], id: string): number {
  return events.findIndex((e) => e.id === id || e.id.endsWith(`:${id}`));
}

/**
 * The panel's content at a cursor, or undefined before the chunks are returned (or in a
 * scenario without them).
 */
export function ingestionModel(
  events: readonly ScenarioEvent[],
  cursor: number,
  sources: readonly SourceDocument[],
): IngestionModel | undefined {
  const chunked = find(events, 'index-05');
  if (chunked < 0 || cursor < chunked + 1) return undefined;
  const request = obj(events[find(events, 'index-04')]?.payload as Json | undefined);
  const embedded = find(events, 'index-07');
  const vectors = embedded >= 0 && cursor >= embedded + 1;
  const embeddings = new Map(
    list(obj(events[embedded]?.payload as Json | undefined)['embeddings']).map((e) => [
      String(obj(e)['chunkId']),
      list(obj(e)['embedding']).map(Number),
    ]),
  );
  const chunks = list(obj(events[chunked]?.payload as Json | undefined)['chunks']).map(
    (raw): ChunkView => {
      const c = obj(raw);
      const id = String(c['chunkId']);
      const text = String(c['text']);
      const view: ChunkView = {
        id,
        documentId: String(c['documentId']),
        version: String(c['version']),
        startWord: Number(c['startWord']),
        words: text ? text.split(' ') : [],
      };
      const vector = embeddings.get(id);
      if (vectors && vector) view.vector = vector;
      return view;
    },
  );
  const documents = sources.flatMap((doc): DocumentView[] => {
    const own = chunks.filter((c) => c.documentId === doc.documentId && c.version === doc.version);
    return own.length ? [{ ...doc, chunks: own }] : [];
  });
  return {
    documents,
    chunkSize: Number(request['chunk_size_words']),
    overlap: Number(request['overlap_words']),
    vectorStep: embedded + 1,
    vectors,
  };
}

/**
 * The selected chunk: in the selected document (else the first), the last chunk that
 * starts at or before the selected first word, i.e. the one that holds it.
 */
export function selectedChunk(
  model: IngestionModel,
  selection: ChunkSelection | undefined,
): { document: DocumentView; chunk: ChunkView } | undefined {
  const document =
    model.documents.find((d) => d.documentId === selection?.documentId) ?? model.documents[0];
  if (!document) return undefined;
  const start = selection?.documentId === document.documentId ? selection.startWord : 0;
  const chunk = document.chunks.filter((c) => c.startWord <= start).at(-1) ?? document.chunks[0];
  return chunk ? { document, chunk } : undefined;
}

/**
 * The words the chunk shares with its previous and its next chunk in the document
 * (02 rag_ingestion.overlap), in document word indices; none without overlap.
 */
export function sharedRanges(document: DocumentView, chunk: ChunkView): SharedRange[] {
  const i = document.chunks.findIndex((c) => c.id === chunk.id);
  if (i < 0) return [];
  const end = (c: ChunkView): number => c.startWord + c.words.length;
  return [document.chunks[i - 1], document.chunks[i + 1]].flatMap((n): SharedRange[] => {
    if (!n) return [];
    const from = Math.max(n.startWord, chunk.startWord);
    const to = Math.min(end(n), end(chunk));
    return to > from ? [{ neighbour: n, from, to }] : [];
  });
}

/** One sentence per shared range, so overlap does not depend on weight alone. */
export function sharedText(ranges: readonly SharedRange[]): string {
  if (!ranges.length) return 'The selected chunk shares no words with its neighbours.';
  return ranges.map((r) => `Words ${r.from}–${r.to - 1} are also in ${r.neighbour.id}.`).join(' ');
}

/** Runs of consecutive words that share the same marks, so the text needs few elements. */
export function runs(
  words: readonly string[],
  marks: (i: number) => { overlap: boolean; selected: boolean },
): { text: string; overlap: boolean; selected: boolean }[] {
  const out: { text: string; overlap: boolean; selected: boolean }[] = [];
  words.forEach((word, i) => {
    const m = marks(i);
    const last = out.at(-1);
    if (last && last.overlap === m.overlap && last.selected === m.selected) last.text += ` ${word}`;
    else out.push({ text: i ? ` ${word}` : word, ...m });
  });
  return out;
}

/** Rounds a sum of lexicon weights for display: 0.1 plus halves and wholes. */
export const sumText = (x: number): string => String(Number(x.toFixed(2)));

export interface IngestionContext {
  /** Every indexed document version of the scenario. */
  sources: readonly SourceDocument[];
  /** The demo embedding's working for a text (RagEngine.embedding). */
  embedding: (text: string) => EmbeddingWorking;
  /** 05-rag-scenarios.yaml principle that the demo embedding stands in for a learned model. */
  note: string;
  /** Moves the cursor to a step (1-based). */
  jump: (step: number) => void;
  /** Takes focus when the panel disappears while holding it (02 rag_ingestion.focus). */
  leave: () => void;
}

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

function focusKey<T extends HTMLElement>(node: T, key: string): T {
  node.dataset['focus'] = key;
  return node;
}

/** Text with overlap words in weight 600 and selected words marked, in place. */
function markedText(
  cls: string,
  words: readonly string[],
  marks: (i: number) => { overlap: boolean; selected: boolean },
): HTMLElement {
  const p = el('p', cls);
  for (const run of runs(words, marks)) {
    const classes = [run.overlap ? 'overlap' : '', run.selected ? 'chunk-mark' : '']
      .filter(Boolean)
      .join(' ');
    p.append(classes ? el('span', classes, run.text) : run.text);
  }
  return p;
}

const range = (c: ChunkView): string =>
  `words ${c.startWord}–${c.startWord + Math.max(c.words.length, 1) - 1}`;

/** The panel; rebuilt only when what it shows changes, keeping focus on the same control. */
export class IngestionPanel {
  readonly root: HTMLElement;
  private readonly context: IngestionContext;
  private selection: ChunkSelection | undefined;
  private model: IngestionModel | undefined;
  private shown = '';

  constructor(context: IngestionContext) {
    this.context = context;
    this.root = el('section', 'ingestion');
    this.root.setAttribute('aria-labelledby', 'ingestion-title');
    this.root.hidden = true;
  }

  update(model: IngestionModel | undefined): void {
    this.model = model;
    const picked = model ? selectedChunk(model, this.selection) : undefined;
    // The selection follows parameter changes to the chunk holding its first word.
    if (picked) {
      this.selection = {
        documentId: picked.document.documentId,
        startWord: picked.chunk.startWord,
      };
    }
    const key = JSON.stringify([model, this.selection]);
    if (key === this.shown) return;
    this.shown = key;
    const active = document.activeElement;
    const restore =
      active instanceof HTMLElement && this.root.contains(active)
        ? (active.closest<HTMLElement>('[data-focus]')?.dataset['focus'] ?? '')
        : undefined;
    this.root.hidden = !picked;
    if (!model || !picked) {
      this.root.replaceChildren();
      if (restore !== undefined) this.context.leave();
      return;
    }
    this.root.replaceChildren(
      Object.assign(el('h3', undefined, 'Chunks and vectors'), { id: 'ingestion-title' }),
      el(
        'div',
        'ingestion-columns',
        this.documentColumn(model, picked.document, picked.chunk),
        this.chunksColumn(model, picked.document, picked.chunk),
        this.chunkColumn(model, picked.document, picked.chunk),
      ),
    );
    if (restore) {
      // A control that no longer exists (a chunk beyond the new count, the step link once
      // the vector is shown) hands focus to the selected chunk or its heading, not the page.
      const target =
        this.root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(restore)}"]`) ??
        (restore.startsWith('chunk:')
          ? this.root.querySelector<HTMLElement>('.chunk-select[aria-pressed="true"]')
          : this.root.querySelector<HTMLElement>('.chunk-id'));
      target?.focus({ preventScroll: true });
    }
  }

  private select(selection: ChunkSelection): void {
    this.selection = selection;
    this.update(this.model);
  }

  private documentColumn(model: IngestionModel, doc: DocumentView, chunk: ChunkView): HTMLElement {
    const menu = focusKey(el('select'), 'document');
    menu.id = 'ingestion-document';
    for (const d of model.documents) {
      const option = el('option', undefined, `${d.title} (${d.documentId})`);
      option.value = d.documentId;
      option.selected = d.documentId === doc.documentId;
      menu.append(option);
    }
    menu.addEventListener('change', () => this.select({ documentId: menu.value, startWord: 0 }));
    const label = el('label', 'small muted', 'Document');
    label.htmlFor = menu.id;
    const end = chunk.startWord + chunk.words.length;
    const shared = sharedRanges(doc, chunk);
    return el(
      'div',
      'ingestion-column',
      el('div', 'ingestion-field', label, menu),
      el('p', 'small muted', `${doc.documentId} v${doc.version} · ${doc.words.length} words`),
      markedText('ingestion-text', doc.words, (i) => ({
        overlap: shared.some((r) => i >= r.from && i < r.to),
        selected: i >= chunk.startWord && i < end,
      })),
    );
  }

  private chunksColumn(model: IngestionModel, doc: DocumentView, chunk: ChunkView): HTMLElement {
    const n = doc.chunks.length;
    const summary =
      `${n} ${n === 1 ? 'chunk' : 'chunks'} of up to ${model.chunkSize} words` +
      (model.overlap ? `, each sharing ${model.overlap} words with the next` : ', none shared');
    const shared = sharedRanges(doc, chunk);
    // The selected chunk marks every word it shares; a neighbour, the words shared with it.
    const marked = (c: ChunkView, j: number): boolean =>
      shared.some((r) => (c.id === chunk.id || r.neighbour.id === c.id) && j >= r.from && j < r.to);
    const items = doc.chunks.map((c, i) => {
      const selected = c.id === chunk.id;
      const button = focusKey(el('button', 'chunk-select', c.id), `chunk:${i}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(selected));
      button.addEventListener('click', () =>
        this.select({ documentId: doc.documentId, startWord: c.startWord }),
      );
      return el(
        'li',
        undefined,
        button,
        el('span', 'small muted', ` ${range(c)}`),
        markedText('ingestion-text', c.words, (k) => ({
          overlap: marked(c, c.startWord + k),
          selected: false,
        })),
      );
    });
    return el(
      'div',
      'ingestion-column',
      el('p', 'small muted', summary),
      el('p', 'small shared-note', sharedText(shared)),
      el('ol', 'chunk-list', ...items),
    );
  }

  private chunkColumn(model: IngestionModel, doc: DocumentView, chunk: ChunkView): HTMLElement {
    const meta: [string, string][] = [
      ['Document', chunk.documentId],
      ['Version', chunk.version],
      ['Visibility', doc.visibility],
      ['Start word', String(chunk.startWord)],
      ['Words', String(chunk.words.length)],
    ];
    const dl = el('dl', 'chunk-meta small');
    for (const [k, v] of meta) dl.append(el('dt', 'muted', k), el('dd', undefined, v));
    const column = el(
      'div',
      'ingestion-column',
      Object.assign(el('h4', 'chunk-id', chunk.id), { tabIndex: -1 }),
      dl,
      el('p', 'small', this.context.note),
    );
    if (!chunk.vector) {
      const link = focusKey(el('button', 'link', `step ${model.vectorStep}`), 'vector-step');
      link.type = 'button';
      link.addEventListener('click', () => this.context.jump(model.vectorStep));
      column.append(el('p', 'small muted', 'The vector is computed at ', link, '.'));
      return column;
    }
    column.append(this.vectorTable(chunk, chunk.vector));
    return column;
  }

  private vectorTable(chunk: ChunkView, vector: readonly number[]): Node {
    const working = this.context.embedding(chunk.words.join(' '));
    const table = el('table', 'vector small');
    table.append(
      el('caption', 'muted', 'Vector, from the lexicon words found in the chunk'),
      el(
        'thead',
        undefined,
        el(
          'tr',
          undefined,
          ...['Dimension', 'Lexicon words', 'Sum', 'Value'].map((h) => {
            const th = el('th', h === 'Sum' || h === 'Value' ? 'num' : undefined, h);
            th.scope = 'col';
            return th;
          }),
        ),
      ),
    );
    const body = el('tbody');
    working.dimensions.forEach((d, i) => {
      const value = vector[i] ?? 0;
      const head = el('th', undefined, d.name);
      head.scope = 'row';
      const words = d.hits.length
        ? d.hits
            .map(
              (h) =>
                `${h.word}${h.count > 1 ? ` ×${h.count}` : ''}${h.weight !== 1 ? ` (${h.weight})` : ''}`,
            )
            .join(', ')
        : 'none';
      body.append(
        el(
          'tr',
          undefined,
          head,
          el('td', d.hits.length ? undefined : 'muted', words),
          el('td', 'num', sumText(d.sum)),
          el('td', 'num vector-value', value.toFixed(4)),
        ),
      );
    });
    table.append(body);
    return el(
      'div',
      undefined,
      table,
      el(
        'p',
        'small muted',
        `Each sum starts at 0.1. Each value is its sum divided by the length of the vector of sums, ${pyRound(working.length, 4)}, rounded to 4 decimals.`,
      ),
    );
  }
}

/** The documents an ingestion run indexes, with their fixture metadata. */
export function sourceDocuments(
  corpus: readonly IndexedDocument[],
  fixtures: readonly Pick<RagDocument, 'id' | 'title' | 'visibility'>[],
): SourceDocument[] {
  return corpus.map((d) => {
    const f = fixtures.find((x) => x.id === d.documentId);
    return {
      documentId: d.documentId,
      version: d.version,
      title: f?.title ?? d.documentId,
      visibility: f?.visibility ?? '',
      words: words(d.text),
    };
  });
}
