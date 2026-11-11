/**
 * The RAG engine (01-architecture.yaml modules.rag_engine): pure, deterministic functions
 * for normalization, chunking, the demo embedding, cosine scores, keyword retrieval,
 * reranking and evidence-based answer composition, as 05-rag-scenarios.yaml fixtures
 * define them. Mirrors rag_engine() in specifications/tools/validate_specs.py; its
 * results must equal reference_results exactly.
 */
import type { JsonObject } from '../scenarios/types.ts';

export interface RagDocument {
  id: string;
  version: string;
  title: string;
  trust: string;
  visibility: string;
  text: string;
}

export interface Evidence {
  span: string;
  predicate: string;
}

export interface AnswerFact {
  id: string;
  group: string;
  documentId: string;
  aspect: string;
  subject: string;
  /** Keyed by document version, or '*' for every version. */
  evidence: Record<string, Evidence>;
}

export interface RagFixtures {
  query: string;
  documents: RagDocument[];
  embedding: {
    model: string;
    dimensions: string[];
    lexicon: { weights: Record<string, number>; words: string[] }[];
  };
  keyword_retrieval: { stopwords: string[] };
  answer_groups: { id: string; label: string }[];
  answer_facts: AnswerFact[];
}

/** One document version as indexed: its ID, version and raw text. */
export interface IndexedDocument {
  documentId: string;
  version: string;
  text: string;
  trust: string;
}

/**
 * One piece of evidence the answer is composed from: a retained chunk, or with
 * fetch_full_documents a parent document (05 derived_event_rules.evidence).
 */
export interface EvidenceItem {
  /** The chunk ID, or <document stem>@<version> for a parent document. */
  id: string;
  documentId: string;
  version: string;
  text: string;
  /** True for a whole parent document. */
  document?: boolean;
}

export interface Chunk {
  id: string;
  documentId: string;
  version: string;
  /** Index of the chunk's first word in the normalized document. */
  startWord: number;
  text: string;
  embedding: number[];
}

/** embedding.vector: every dimension starts at this value (smoothing keeps vectors nonzero). */
export const SMOOTHING = 0.1;

/** A lexicon word found in a text, for one dimension. */
export interface LexiconHit {
  word: string;
  count: number;
  /** The word's weight in this dimension. */
  weight: number;
}

/** How a text's demo embedding comes about (RagEngine.embedding). */
export interface EmbeddingWorking {
  dimensions: { name: string; hits: LexiconHit[]; sum: number }[];
  /** Length of the vector of sums, which each sum is divided by. */
  length: number;
  vector: number[];
}

export interface ScoredChunk extends Chunk {
  /** Cosine similarity with the query vector, rounded to 4 decimals. */
  score: number;
  /** Share of query terms found in the chunk, rounded to 4 decimals. */
  keyword: number;
  /** 0.7 * score + 0.3 * keyword, rounded to 4 decimals. */
  rerank: number;
}

export interface RetrievalOptions {
  chunkSize: number;
  overlap: number;
  topK: number;
  threshold: number;
  rerank: boolean;
}

export interface Retrieval {
  queryVector: number[];
  /** Distinct query tokens that are not stopwords, sorted. */
  queryTerms: string[];
  /** Every chunk, by descending cosine score, ties by ascending chunk ID. */
  ranked: ScoredChunk[];
  /** Chunks at or above the threshold, ordered by score (or reranker score), cut to top K. */
  selected: ScoredChunk[];
}

/** Where an intro sentence of the Combined answer comes from (06 answer_composition.intro). */
export type IntroSource = 'tool' | 'session';

export interface IntroSentence {
  source: IntroSource;
  text: string;
}

/**
 * One part of an answer (05 answer_rules, 06 answer_composition.rule): the answer is the
 * parts' texts joined by single spaces. Views label parts by kind; they never parse the text.
 */
export type AnswerPart =
  | { kind: 'intro'; source: IntroSource; text: string }
  | { kind: 'group' | 'gap' | 'no-evidence' | 'comparison'; text: string };

export interface Answer {
  text: string;
  /** The parts the text is composed of, in order. */
  parts: AnswerPart[];
  /** Cited evidence in citation order: citation n is cited[n - 1]. */
  cited: EvidenceItem[];
  /** IDs of the answer facts the evidence supports. */
  supported: Set<string>;
}

export const NO_EVIDENCE_ANSWER =
  'I could not find sufficiently relevant information in the indexed documents to answer this question.';

/**
 * Python's round(x, digits): the exact decimal value of the double, rounded half to even.
 * Math.round(x * 10 ** digits) / 10 ** digits and toFixed differ on some inputs.
 */
export function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`cannot round ${x}`);
  if (!Number.isInteger(digits) || digits < 0 || digits > 20)
    throw new RangeError(`cannot round to ${digits} digits`);
  const sign = x < 0 ? -1 : 1;
  // Exact for the magnitudes used here: a double's decimal expansion near 1 has < 60 digits.
  const [int = '0', frac = ''] = Math.abs(x).toFixed(80).split('.');
  const kept = frac.slice(0, digits);
  const rest = frac.slice(digits);
  let units = BigInt(int + kept);
  const half = '5'.padEnd(rest.length, '0');
  if (rest > half || (rest === half && units % 2n === 1n)) units += 1n;
  if (digits === 0) return sign * Number(units);
  const text = units.toString().padStart(digits + 1, '0');
  return sign * Number(`${text.slice(0, -digits)}.${text.slice(-digits)}`);
}

/** Python's round(x, 4). */
export function round4(x: number): number {
  return pyRound(x, 4);
}

/** chunking.normalize: drop leading heading markers on each line, then join lines. */
export function normalize(text: string): string {
  return text.replace(/^#+\s*/gm, '').replace(/\n/g, ' ');
}

/** chunking.words: whitespace-separated words of the normalized text. */
export function words(text: string): string[] {
  return normalize(text)
    .split(/\s+/)
    .filter((w) => w !== '');
}

/** embedding.tokens: runs of [a-z0-9] in the lowercased text. */
export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Delimits a citation placeholder; a private-use character no fixture contains. */
const MARK = '\uE000';

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function joinAnd(items: string[]): string {
  return items.length === 1
    ? (items[0] as string)
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1) as string}`;
}

/** The engine over one set of fixtures. Every function is pure. */
export class RagEngine {
  readonly fixtures: RagFixtures;
  private readonly lexicon: Map<string, number[]>;
  private readonly stopwords: Set<string>;
  private readonly documents: Map<string, RagDocument>;

  constructor(fixtures: RagFixtures) {
    this.fixtures = fixtures;
    const dims = fixtures.embedding.dimensions;
    this.lexicon = new Map();
    for (const group of fixtures.embedding.lexicon) {
      const weights = dims.map((d) => group.weights[d] ?? 0);
      for (const w of group.words) this.lexicon.set(w, weights);
    }
    this.stopwords = new Set(fixtures.keyword_retrieval.stopwords);
    this.documents = new Map(fixtures.documents.map((d) => [d.id, d]));
  }

  /** embedding.vector: 0.1 smoothing plus lexicon weights, L2-normalized, 4 decimals. */
  embed(text: string): number[] {
    const sums = this.sums(text);
    const length = Math.sqrt(sums.reduce((s, x) => s + x * x, 0));
    return sums.map((x) => round4(x / length));
  }

  /** Per dimension: 0.1 plus the weights of the lexicon words in the text; counts them in `found`. */
  private sums(text: string, found?: Map<string, number>): number[] {
    const n = this.fixtures.embedding.dimensions.length;
    const sums = new Array<number>(n).fill(SMOOTHING);
    for (const t of tokens(text)) {
      const w = this.lexicon.get(t);
      if (!w) continue;
      found?.set(t, (found.get(t) ?? 0) + 1);
      for (let i = 0; i < n; i += 1) sums[i] = (sums[i] as number) + (w[i] as number);
    }
    return sums;
  }

  /**
   * embedding.vector with its working, for the ingestion view: per dimension the lexicon
   * words found in the text (with counts and weights) and the sum before normalizing, the
   * vector's length, and the vector itself (equal to embed).
   */
  embedding(text: string): EmbeddingWorking {
    const found = new Map<string, number>();
    const sums = this.sums(text, found);
    const length = Math.sqrt(sums.reduce((s, x) => s + x * x, 0));
    return {
      dimensions: this.fixtures.embedding.dimensions.map((name, i) => ({
        name,
        hits: [...found]
          .filter(([word]) => (this.lexicon.get(word)?.[i] ?? 0) > 0)
          .map(([word, count]) => ({ word, count, weight: this.lexicon.get(word)?.[i] ?? 0 })),
        sum: sums[i] as number,
      })),
      length,
      vector: sums.map((x) => round4(x / length)),
    };
  }

  /** embedding.score: cosine similarity, 4 decimals. */
  static cosine(a: readonly number[], b: readonly number[]): number {
    const dot = a.reduce((s, x, i) => s + x * (b[i] as number), 0);
    const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
    return round4(dot / na / nb);
  }

  /** keyword_retrieval.query_terms. */
  queryTerms(query = this.fixtures.query): string[] {
    return [...new Set(tokens(query))].filter((t) => !this.stopwords.has(t)).sort();
  }

  /** The trust level of a document (05 fixtures.documents trust). */
  trustOf(documentId: string): string {
    const d = this.documents.get(documentId);
    if (!d) throw new RangeError(`unknown document ${documentId}`);
    return d.trust;
  }

  /** The indexed documents: every document of the fixtures at its version (05 inputs). */
  corpus(): IndexedDocument[] {
    return this.fixtures.documents.map((d) => ({
      documentId: d.id,
      version: d.version,
      text: d.text,
      trust: d.trust,
    }));
  }

  /** chunking.windows and chunking.chunk_id, with each chunk's vector. */
  chunks(docs: readonly IndexedDocument[], size: number, overlap: number): Chunk[] {
    if (!Number.isInteger(size) || !Number.isInteger(overlap) || overlap < 0 || size <= overlap)
      throw new RangeError(`chunk size ${size} must exceed overlap ${overlap}`);
    const out: Chunk[] = [];
    for (const doc of docs) {
      const w = words(doc.text);
      const dot = doc.documentId.lastIndexOf('.');
      const stem = dot < 0 ? doc.documentId : doc.documentId.slice(0, dot);
      for (let i = 0, n = 1; ; i += size - overlap, n += 1) {
        const text = w.slice(i, i + size).join(' ');
        out.push({
          id: `${stem}@${doc.version}-c${size}o${overlap}-${String(n).padStart(3, '0')}`,
          documentId: doc.documentId,
          version: doc.version,
          startWord: i,
          text,
          embedding: this.embed(text),
        });
        if (i + size >= w.length) break;
      }
    }
    return out;
  }

  /** Scores every chunk and selects by threshold, then top K (by reranker score if on). */
  retrieve(docs: readonly IndexedDocument[], options: RetrievalOptions): Retrieval {
    const queryVector = this.embed(this.fixtures.query);
    const queryTerms = this.queryTerms();
    const scored: ScoredChunk[] = this.chunks(docs, options.chunkSize, options.overlap).map((c) => {
      const score = RagEngine.cosine(queryVector, c.embedding);
      const present = new Set(tokens(c.text));
      const keyword = round4(queryTerms.filter((t) => present.has(t)).length / queryTerms.length);
      return { ...c, score, keyword, rerank: round4(0.7 * score + 0.3 * keyword) };
    });
    const byScore = (a: ScoredChunk, b: ScoredChunk): number => b.score - a.score || byId(a, b);
    const byRerank = (a: ScoredChunk, b: ScoredChunk): number => b.rerank - a.rerank || byId(a, b);
    const ranked = [...scored].sort(byScore);
    const selected = scored
      .filter((c) => c.score >= options.threshold)
      .sort(options.rerank ? byRerank : byScore)
      .slice(0, options.topK);
    return { queryVector, queryTerms, ranked, selected };
  }

  /**
   * answer_rules: the evidence-based answer, its parts and its citations. `intro` is written
   * before the answer groups (the Combined scenario's balance and account sentences).
   */
  answer(selected: readonly EvidenceItem[], intro: readonly IntroSentence[] = []): Answer {
    if (!selected.length)
      return {
        text: NO_EVIDENCE_ANSWER,
        parts: [{ kind: 'no-evidence', text: NO_EVIDENCE_ANSWER }],
        cited: [],
        supported: new Set(),
      };
    const marked = new Map<string, EvidenceItem>();
    // Placeholders are numbered by first appearance in the final text.
    const cite = (c: EvidenceItem): string => {
      marked.set(c.id, c);
      return `${MARK}${c.id}${MARK}`;
    };
    const parts: AnswerPart[] = intro.map((s) => ({
      kind: 'intro',
      source: s.source,
      text: s.text,
    }));
    const supported = new Set<string>();
    const missing: string[] = [];
    for (const group of this.fixtures.answer_groups) {
      const runs: { subject: string; preds: { pred: string; chunk: EvidenceItem }[] }[] = [];
      for (const f of this.fixtures.answer_facts.filter((x) => x.group === group.id)) {
        const vals = new Map<string, EvidenceItem[]>();
        for (const c of selected) {
          const ev = f.evidence[c.version] ?? f.evidence['*'];
          if (ev && c.documentId === f.documentId && c.text.includes(ev.span)) {
            const list = vals.get(ev.predicate) ?? [];
            list.push(c);
            vals.set(ev.predicate, list);
          }
        }
        if (!vals.size) {
          missing.push(f.aspect);
          continue;
        }
        supported.add(f.id);
        // One version per document, so one predicate; of several chunks, the lowest ID.
        const [pred, cs] = [...vals][0] as [string, EvidenceItem[]];
        const best = [...cs].sort(byId)[0] as EvidenceItem;
        const last = runs.at(-1);
        if (last && last.subject === f.subject) last.preds.push({ pred, chunk: best });
        else runs.push({ subject: f.subject, preds: [{ pred, chunk: best }] });
      }
      const phrases = runs.map(({ subject, preds }) => {
        const items = preds.map(({ pred, chunk }, i) => {
          const next = preds[i + 1];
          return !next || next.chunk.id !== chunk.id ? `${pred} [${cite(chunk)}]` : pred;
        });
        return `${subject} ${joinAnd(items)}`;
      });
      if (phrases.length)
        parts.push({ kind: 'group', text: `${group.label}: ${phrases.join('; ')}.` });
    }
    if (missing.length)
      parts.push({
        kind: 'gap',
        text: `The retrieved evidence does not cover ${joinAnd(missing)}.`,
      });
    // Numbered part by part in order, which numbers them as the joined text would.
    const cited: EvidenceItem[] = [];
    const placeholder = new RegExp(`${MARK}([^${MARK}]+)${MARK}`, 'g');
    const numbered = parts.map((p) => ({
      ...p,
      text: p.text.replace(placeholder, (_, id: string) => {
        const c = marked.get(id) as EvidenceItem;
        if (!cited.includes(c)) cited.push(c);
        return String(cited.indexOf(c) + 1);
      }),
    }));
    return { text: numbered.map((p) => p.text).join(' '), parts: numbered, cited, supported };
  }
}

/**
 * answer_rules: '[n] <documentId> v<version>, chunk <chunkId>', or ', full document' for
 * a parent document.
 */
export function sourceLines(cited: readonly EvidenceItem[]): string[] {
  return cited.map(
    (c, i) =>
      `[${i + 1}] ${c.documentId} v${c.version}, ${c.document ? 'full document' : `chunk ${c.id}`}`,
  );
}

/** The structured sources of the answer event; a parent document has no chunkId. */
export function sourceObjects(cited: readonly EvidenceItem[]): JsonObject[] {
  return cited.map((c, i) => ({
    citation: i + 1,
    ...(c.document ? {} : { chunkId: c.id }),
    documentId: c.documentId,
    version: c.version,
  }));
}

/**
 * The parent documents of the retained chunks: each document version once, in the order
 * of its first retained chunk, with its normalized text (the parent-document pattern).
 */
export function parentDocuments(
  selected: readonly EvidenceItem[],
  docs: readonly IndexedDocument[],
): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const c of selected) {
    if (out.some((p) => p.documentId === c.documentId && p.version === c.version)) continue;
    const doc = docs.find((d) => d.documentId === c.documentId && d.version === c.version);
    if (!doc) throw new RangeError(`no indexed document ${c.documentId} v${c.version}`);
    const dot = c.documentId.lastIndexOf('.');
    const stem = dot < 0 ? c.documentId : c.documentId.slice(0, dot);
    out.push({
      id: `${stem}@${c.version}`,
      documentId: c.documentId,
      version: c.version,
      text: words(doc.text).join(' '),
      document: true,
    });
  }
  return out;
}

/** The model message: the answer, then its sources after 'Sources:' when there are any. */
export function modelMessage(answer: Answer): string {
  return answer.cited.length
    ? `${answer.text}\n\nSources:\n${sourceLines(answer.cited).join('\n')}`
    : answer.text;
}
