/**
 * The RAG engine (01-architecture.yaml modules.rag_engine): pure, deterministic functions
 * for normalization, chunking, the demo embedding, cosine scores, keyword retrieval,
 * reranking and evidence-based answer composition, as 05-rag-scenarios.yaml fixtures
 * define them. Mirrors rag_engine() in specifications/tools/validate_specs.py; its
 * results must equal reference_results exactly.
 */
import type { Json, JsonObject } from '../scenarios/types.ts';

export interface RagDocument {
  id: string;
  version: string;
  title: string;
  trust: 'official' | 'untrusted';
  visibility: string;
  text: string;
  /** Untrusted documents: the instruction addressed to the assistant that it must ignore. */
  injected_instruction?: string;
}

export interface PreviousVersion {
  id: string;
  version: string;
  derive_from: string;
  replace: { from: string; to: string };
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
  previous_versions: PreviousVersion[];
  untrusted_documents: RagDocument[];
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
  trust: 'official' | 'untrusted';
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

export interface Answer {
  text: string;
  /** Cited evidence in citation order: citation n is cited[n - 1]. */
  cited: EvidenceItem[];
  /** IDs of the answer facts the evidence supports. */
  supported: Set<string>;
}

/** Fixture changes of a variant (03 variant_format.fixture_overrides) the corpus honours. */
export interface CorpusOverrides {
  /** Index these versions of every document instead of its current one. */
  versions?: string[];
  /** Untrusted documents added to the index. */
  extra?: string[];
  /** Documents left out of the index. */
  exclude?: string[];
}

export const NO_EVIDENCE_ANSWER =
  'I could not find sufficiently relevant information in the indexed documents to answer this question.';

export const INJECTION_NOTE =
  'Note: a retrieved document contained instructions addressed to the assistant; they were treated as data and ignored.';

/**
 * Python's round(x, digits): the exact decimal value of the double, rounded half to even.
 * Math.round(x * 10 ** digits) / 10 ** digits and toFixed differ on some inputs.
 */
export function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`cannot round ${x}`);
  const sign = x < 0 ? -1 : 1;
  // Exact for the magnitudes used here: a double's decimal expansion near 1 has < 60 digits.
  const [int = '0', frac = ''] = Math.abs(x).toFixed(80).split('.');
  const kept = frac.slice(0, digits);
  const rest = frac.slice(digits);
  let units = BigInt(int + kept);
  const half = '5'.padEnd(rest.length, '0');
  if (rest > half || (rest === half && units % 2n === 1n)) units += 1n;
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

const vkey = (version: string): number[] => version.split('.').map(Number);

/** Compares versions numerically, segment by segment. */
export function compareVersions(a: string, b: string): number {
  const x = vkey(a);
  const y = vkey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return 0;
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

/** In a conflict sentence a predicate stands alone, so its last comma becomes ' and '. */
function alone(predicate: string): string {
  const i = predicate.lastIndexOf(', ');
  return i < 0 ? predicate : `${predicate.slice(0, i)} and ${predicate.slice(i + 2)}`;
}

/** The engine over one set of fixtures. Every function is pure. */
export class RagEngine {
  readonly fixtures: RagFixtures;
  private readonly lexicon: Map<string, number[]>;
  private readonly stopwords: Set<string>;
  private readonly official: Map<string, RagDocument>;
  private readonly untrusted: Map<string, RagDocument>;
  private readonly injected: string[];

  constructor(fixtures: RagFixtures) {
    this.fixtures = fixtures;
    const dims = fixtures.embedding.dimensions;
    this.lexicon = new Map();
    for (const group of fixtures.embedding.lexicon) {
      const weights = dims.map((d) => group.weights[d] ?? 0);
      for (const w of group.words) this.lexicon.set(w, weights);
    }
    this.stopwords = new Set(fixtures.keyword_retrieval.stopwords);
    this.official = new Map(fixtures.documents.map((d) => [d.id, d]));
    this.untrusted = new Map(fixtures.untrusted_documents.map((d) => [d.id, d]));
    this.injected = fixtures.untrusted_documents.flatMap((d) =>
      d.injected_instruction ? [d.injected_instruction] : [],
    );
  }

  /** embedding.vector: 0.1 smoothing plus lexicon weights, L2-normalized, 4 decimals. */
  embed(text: string): number[] {
    const n = this.fixtures.embedding.dimensions.length;
    const v = new Array<number>(n).fill(0.1);
    for (const t of tokens(text)) {
      const w = this.lexicon.get(t);
      if (w) for (let i = 0; i < n; i += 1) v[i] = (v[i] as number) + (w[i] as number);
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => round4(x / norm));
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

  trustOf(documentId: string): 'official' | 'untrusted' {
    return this.untrusted.has(documentId) ? 'untrusted' : 'official';
  }

  /**
   * The indexed document versions: each official document in each requested version
   * (a previous version is derived by its replace rule; a version that does not exist is
   * not indexed), then the added untrusted documents, minus the excluded ones.
   */
  corpus(overrides: CorpusOverrides = {}): IndexedDocument[] {
    const versions = overrides.versions ?? [
      ...new Set(this.fixtures.documents.map((d) => d.version)),
    ];
    const exclude = new Set(overrides.exclude ?? []);
    const out: IndexedDocument[] = [];
    for (const d of this.fixtures.documents) {
      if (exclude.has(d.id)) continue;
      for (const v of versions) {
        if (v === d.version) {
          out.push({ documentId: d.id, version: v, text: d.text, trust: 'official' });
          continue;
        }
        const pv = this.fixtures.previous_versions.find((p) => p.id === d.id && p.version === v);
        if (pv)
          out.push({
            documentId: d.id,
            version: v,
            text: d.text.replaceAll(pv.replace.from, pv.replace.to),
            trust: 'official',
          });
      }
    }
    for (const id of overrides.extra ?? []) {
      const d = this.untrusted.get(id);
      if (!d) throw new RangeError(`unknown untrusted document ${id}`);
      if (!exclude.has(id))
        out.push({ documentId: id, version: d.version, text: d.text, trust: 'untrusted' });
    }
    return out;
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

  /** Whether a chunk contains an instruction injected into an untrusted document. */
  injectedIn(chunk: { text: string }): boolean {
    return this.injected.some((i) => chunk.text.includes(i));
  }

  /**
   * answer_rules: the evidence-based answer and its citations. `intro` is written before the
   * answer groups (the Combined scenario's balance sentence).
   */
  answer(selected: readonly EvidenceItem[], intro?: string): Answer {
    if (!selected.length) return { text: NO_EVIDENCE_ANSWER, cited: [], supported: new Set() };
    const marked = new Map<string, EvidenceItem>();
    // Placeholders are numbered by first appearance in the final text.
    const cite = (c: EvidenceItem): string => {
      marked.set(c.id, c);
      return `${MARK}${c.id}${MARK}`;
    };
    const official = selected.filter((c) => this.official.has(c.documentId));
    const parts: string[] = intro ? [intro] : [];
    const supported = new Set<string>();
    const missing: string[] = [];
    for (const group of this.fixtures.answer_groups) {
      const runs: { subject: string; preds: { pred: string; chunk: EvidenceItem }[] }[] = [];
      const conflicts: string[] = [];
      for (const f of this.fixtures.answer_facts.filter((x) => x.group === group.id)) {
        const vals = new Map<string, EvidenceItem[]>();
        for (const c of official) {
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
        if (vals.size === 1) {
          const [pred, cs] = [...vals][0] as [string, EvidenceItem[]];
          const best = [...cs].sort(
            (a, b) => compareVersions(b.version, a.version) || byId(a, b),
          )[0] as EvidenceItem;
          const last = runs.at(-1);
          if (last && last.subject === f.subject) last.preds.push({ pred, chunk: best });
          else runs.push({ subject: f.subject, preds: [{ pred, chunk: best }] });
        } else {
          const ordered = [...vals].sort((a, b) =>
            compareVersions((a[1][0] as EvidenceItem).version, (b[1][0] as EvidenceItem).version),
          );
          const alts = ordered
            .map(([pred, cs]) => {
              const c = cs[0] as EvidenceItem;
              return `version ${c.version}: ${f.subject} ${alone(pred)} [${cite(c)}]`;
            })
            .join('; ');
          const newest = (ordered.at(-1)?.[1][0] as EvidenceItem).version;
          conflicts.push(
            `The indexed documents conflict on ${f.aspect} (${alts}); version ${newest} is the newest.`,
          );
        }
      }
      const phrases = runs.map(({ subject, preds }) => {
        const items = preds.map(({ pred, chunk }, i) => {
          const next = preds[i + 1];
          return !next || next.chunk.id !== chunk.id ? `${pred} [${cite(chunk)}]` : pred;
        });
        return `${subject} ${joinAnd(items)}`;
      });
      if (phrases.length) parts.push(`${group.label}: ${phrases.join('; ')}.`);
      parts.push(...conflicts);
    }
    if (missing.length) parts.push(`The retrieved evidence does not cover ${joinAnd(missing)}.`);
    if (selected.some((c) => this.injectedIn(c))) parts.push(INJECTION_NOTE);
    const cited: EvidenceItem[] = [];
    const text = parts
      .join(' ')
      .replace(new RegExp(`${MARK}([^${MARK}]+)${MARK}`, 'g'), (_, id: string) => {
        const c = marked.get(id) as EvidenceItem;
        if (!cited.includes(c)) cited.push(c);
        return String(cited.indexOf(c) + 1);
      });
    return { text, cited, supported };
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

/** Translates a variant's fixture_overrides into corpus overrides (05 variants). */
export function corpusOverrides(fixtureOverrides: Readonly<Record<string, Json>> | undefined) {
  const fo = fixtureOverrides ?? {};
  const out: CorpusOverrides = {};
  const indexed = fo['indexed_versions'];
  if (indexed && typeof indexed === 'object' && !Array.isArray(indexed)) {
    const found = new Set<string>();
    for (const v of Object.values(indexed)) {
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string') found.add(x);
    }
    out.versions = [...found].sort();
  }
  const strings = (v: Json | undefined): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  if (strings(fo['add_documents']).length) out.extra = strings(fo['add_documents']);
  if (strings(fo['exclude_documents']).length) out.exclude = strings(fo['exclude_documents']);
  return out;
}
