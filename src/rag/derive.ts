/**
 * Derived RAG events (05-rag-scenarios.yaml derived_event_rules): recomputes the payload,
 * explanation and tracked values of every event a scenario lists in derived_events from
 * the fixtures and the current retrieval_config. Plugs
 * into Playback as its deriveEvents hook; scenarios without derived events pass through.
 */
import { type DeriveEvents, localId, type RetrievalConfig } from '../engine/playback.ts';
import type { Json, JsonObject, Scenario, ScenarioEvent, SpecSources } from '../scenarios/types.ts';
import {
  type Answer,
  type EvidenceItem,
  type IndexedDocument,
  type IntroSentence,
  type RagFixtures,
  type Retrieval,
  RagEngine,
  type ScoredChunk,
  modelMessage,
  parentDocuments,
  pyRound,
  sourceObjects,
  tokens,
  words,
} from './engine.ts';

/** One comparison sentence of the Combined answer (06 combined.answer_composition). */
export interface Comparison {
  /** Facts that must all be supported. */
  requires?: string[];
  sentence: string;
  /** Explanation of the model's answer event when this comparison applies. */
  explanation: string;
}

export interface AnswerComposition {
  /** The intro's sentences with their sources. */
  intro: IntroSentence[];
  comparisons: Comparison[];
  /** Explanation of the model's answer event when no comparison applies. */
  explanation: string;
}

/** Parameter values a derivation uses, from retrieval_config or the specs' defaults. */
export interface RagParameters {
  chunkSize: number;
  overlap: number;
  topK: number;
  threshold: number;
  rerank: boolean;
  keywordRetrieval: boolean;
  fetchFullDocuments: boolean;
}

interface Context {
  scenario: Scenario;
  params: RagParameters;
  docs: IndexedDocument[];
  retrieval: Retrieval;
  /** The parent documents of the retained chunks. */
  parents: EvidenceItem[];
  /** What the prompt carries and the answer is built from: the chunks or their parents. */
  evidence: EvidenceItem[];
  answer: () => Answer;
  combinedAnswer: () => { answer: Answer; explanation: string };
}

type Handler = (e: ScenarioEvent, ctx: Context) => void;

function payload(e: ScenarioEvent): JsonObject {
  if (!e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload))
    throw new Error(`${e.id}: a derived event needs an object payload`);
  return e.payload;
}

/** Sets a tracked value; an empty list removes the key, and an empty map the field. */
function track(e: ScenarioEvent, key: string, values: Json[]): void {
  // Keeps the key's place, so the inspector lists tracked values in the YAML's order.
  const entries = Object.entries(e.tracked_values ?? {});
  if (!entries.some(([k]) => k === key)) entries.push([key, values]);
  const tracked = Object.fromEntries(
    entries.flatMap(([k, v]) => (k !== key ? [[k, v]] : values.length ? [[k, values]] : [])),
  );
  if (Object.keys(tracked).length) e.tracked_values = tracked;
  else delete e.tracked_values;
}

const ids = (chunks: readonly ScoredChunk[]): string[] => chunks.map((c) => c.id);
const documentIds = (chunks: readonly ScoredChunk[]): string[] =>
  [...new Set(chunks.map((c) => c.documentId))].sort();
/** Thresholds in explanations are rounded to 2 decimals (05 derived_event_rules.inputs). */
/** Python's str(round(x, 2)) without a trailing '.0', as validate_specs.py writes it. */
export const thresholdText = (x: number): string => String(pyRound(x, 2));

/** The grounding instruction without chunk IDs, when the evidence is whole documents. */
const CHUNK_CITATION = 'document ID, version and chunk ID';
const DOCUMENT_CITATION = 'document ID and version';

const quoted = (items: string[]): string =>
  items.length === 1
    ? `'${items[0] as string}'`
    : `${items
        .slice(0, -1)
        .map((t) => `'${t}'`)
        .join(', ')} and '${items.at(-1) as string}'`;

/** retrieve-10's user message: the question and one document block per evidence item. */
export function groundedUserMessage(
  engine: RagEngine,
  question: string,
  evidence: readonly EvidenceItem[],
): string {
  const blocks = evidence.length
    ? evidence
        .map((c) => {
          const chunk = c.document ? '' : ` chunk="${c.id}"`;
          return `<document id="${c.documentId}" version="${c.version}"${chunk} trust="${engine.trustOf(c.documentId)}">\n${c.text}\n</document>`;
        })
        .join('\n')
    : '(none)';
  return `Question: ${question}\n\nRetrieved documents:\n${blocks}`;
}

function setUserMessage(e: ScenarioEvent, content: string): void {
  const messages = payload(e)['messages'];
  const user = Array.isArray(messages)
    ? messages.find(
        (m): m is JsonObject =>
          m !== null && typeof m === 'object' && !Array.isArray(m) && m['role'] === 'user',
      )
    : undefined;
  if (!user) throw new Error(`${e.id}: no user message to derive`);
  user['content'] = content;
}

function trackRetained(e: ScenarioEvent, ctx: Context, text: boolean): void {
  const sel = ctx.retrieval.selected;
  track(e, 'sourceDocumentId', documentIds(sel));
  track(e, 'chunkId', ids(sel));
  if (text)
    track(
      e,
      'retrievedText',
      ctx.evidence.map((c) => c.text),
    );
}

/** The system instruction for the evidence: chunk citations, or document citations. */
function systemFor(system: Json | undefined, ctx: Context): string {
  const text = typeof system === 'string' ? system : '';
  return ctx.params.fetchFullDocuments
    ? text.replace(CHUNK_CITATION, () => DOCUMENT_CITATION)
    : text.replace(DOCUMENT_CITATION, () => CHUNK_CITATION);
}

function makeHandlers(engine: RagEngine): Record<string, Handler> {
  const chunks = (ctx: Context) =>
    engine.chunks(ctx.docs, ctx.params.chunkSize, ctx.params.overlap);
  return {
    // rag-index
    'index-04': (e, { params }) => {
      Object.assign(payload(e), {
        chunk_size_words: params.chunkSize,
        overlap_words: params.overlap,
      });
    },
    'index-05': (e, ctx) => {
      const cs = chunks(ctx);
      payload(e)['chunks'] = cs.map((c) => ({
        chunkId: c.id,
        documentId: c.documentId,
        version: c.version,
        startWord: c.startWord,
        text: c.text,
      }));
      e.explanation = `${cs.length} chunks, each pointing back to its source document.`;
      track(
        e,
        'chunkId',
        cs.map((c) => c.id),
      );
    },
    'index-06': (e, ctx) => {
      payload(e)['inputs'] = chunks(ctx).map((c) => c.id);
    },
    'index-07': (e, ctx) => {
      payload(e)['embeddings'] = chunks(ctx).map((c) => ({
        chunkId: c.id,
        embedding: c.embedding,
      }));
    },
    'index-08': (e, ctx) => {
      payload(e)['records'] = chunks(ctx).length;
    },
    'index-09': (e, ctx) => {
      payload(e)['upserted'] = chunks(ctx).length;
    },
    'index-10': (e, ctx) => {
      Object.assign(payload(e), {
        documents: new Set(ctx.docs.map((d) => d.documentId)).size,
        chunks: chunks(ctx).length,
      });
    },

    // rag-query and the Combined scenario
    'retrieve-05': (e, { retrieval }) => {
      payload(e)['matches'] = retrieval.ranked.map((c) => ({
        chunkId: c.id,
        documentId: c.documentId,
        version: c.version,
        score: c.score,
      }));
      track(e, 'chunkId', ids(retrieval.ranked));
    },
    'hybrid-02': (e, { retrieval, params }) => {
      const hits = retrieval.ranked
        .filter((c) => c.keyword > 0)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      payload(e)['hits'] = hits.map((c) => ({
        chunkId: c.id,
        keywordScore: c.keyword,
        score: c.score,
      }));
      const below = hits.filter((c) => c.score < params.threshold);
      const lowest = [...below].sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : 1))[0];
      const threshold = thresholdText(params.threshold);
      if (!hits.length) e.explanation = 'No chunk contains a query term.';
      else if (!lowest)
        e.explanation = `Exact-term hits. All of them reach the similarity threshold of ${threshold}.`;
      else {
        const present = new Set(tokens(lowest.text));
        const terms = quoted(retrieval.queryTerms.filter((t) => present.has(t)));
        e.explanation =
          below.length === 1
            ? `Exact-term hits. One hit scores below the similarity threshold of ${threshold}: ` +
              `${lowest.id}, a lexical false positive that matches only ${terms} and that the ` +
              'threshold later removes.'
            : `Exact-term hits. ${below.length} hits score below the similarity threshold of ` +
              `${threshold}: lexical false positives that the threshold later removes, such as ` +
              `${lowest.id}, which matches only ${terms}.`;
      }
    },
    'hybrid-03': (e, { retrieval, params }) => {
      const candidates = retrieval.ranked
        .filter((c) => c.score >= params.threshold)
        .sort((a, b) => b.rerank - a.rerank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      payload(e)['candidates'] = candidates.map((c) => ({
        chunkId: c.id,
        score: c.score,
        keywordScore: c.keyword,
        rerankScore: c.rerank,
      }));
      e.explanation = params.keywordRetrieval
        ? 'Union both candidate lists, drop chunks below the similarity threshold, then order by the reranker score.'
        : 'Drop chunks below the similarity threshold, then order by the reranker score, which also counts the query terms in each chunk.';
    },
    'retrieve-06': (e, { retrieval, params }) => {
      const kept = new Set(ids(retrieval.selected));
      Object.assign(payload(e), {
        top_k: params.topK,
        similarity_threshold: params.threshold,
        rerank: params.rerank,
        retained: ids(retrieval.selected),
        discarded: retrieval.ranked
          .filter((c) => !kept.has(c.id))
          .map((c) => ({
            chunkId: c.id,
            score: c.score,
            reason: c.score < params.threshold ? 'below threshold' : 'outside topK',
          })),
      });
      const best = params.topK === 1 ? 'the best one' : `the ${params.topK} best`;
      const by = params.rerank ? ' by reranker score' : '';
      const threshold = thresholdText(params.threshold);
      e.explanation =
        `Keep chunks with a score of at least ${threshold}, then ${best}${by}. ` +
        'Ties are broken by chunk ID.' +
        (kept.size ? '' : ` No chunk reaches ${threshold}, so nothing is retained.`);
      track(e, 'chunkId', ids(retrieval.selected));
    },
    'retrieve-07': (e, { parents }) => {
      payload(e)['documents'] = parents.map((d) => ({
        documentId: d.documentId,
        version: d.version,
      }));
    },
    'retrieve-08': (e, { parents }) => {
      payload(e)['documents'] = parents.map((d) => ({
        documentId: d.documentId,
        version: d.version,
        words: words(d.text).length,
        text: d.text,
      }));
    },
    'retrieve-09': (e, ctx) => {
      const after = payload(e)['prompt_after'];
      if (!after || typeof after !== 'object' || Array.isArray(after))
        throw new Error(`${e.id}: no prompt_after to derive`);
      after['system'] = systemFor(after['system'], ctx);
      after['document_blocks'] = ctx.evidence.map((c) =>
        c.document
          ? { documentId: c.documentId, version: c.version, trust: engine.trustOf(c.documentId) }
          : { chunkId: c.id, trust: engine.trustOf(c.documentId) },
      );
      e.explanation = !ctx.evidence.length
        ? 'No chunk was retained, so the prompt gets the grounding instructions but no document blocks. The model has not seen any of it yet.'
        : ctx.params.fetchFullDocuments
          ? 'Wrap each fetched document in a document block with its ID, version and trust level, and add grounding instructions. The documents replace the retained chunks, so the model sees their full context. The model has not seen any of it yet.'
          : 'Wrap each retained chunk in a document block with its ID, version, chunk ID and trust level, and add grounding instructions. The model has not seen any of it yet.';
      trackRetained(e, ctx, true);
    },
    'retrieve-10': (e, ctx) => {
      const messages = payload(e)['messages'];
      const system = Array.isArray(messages)
        ? messages.find(
            (m): m is JsonObject =>
              m !== null && typeof m === 'object' && !Array.isArray(m) && m['role'] === 'system',
          )
        : undefined;
      if (system) system['content'] = systemFor(system['content'], ctx);
      setUserMessage(
        e,
        groundedUserMessage(engine, ctx.scenario.question ?? engine.fixtures.query, ctx.evidence),
      );
      e.explanation = !ctx.evidence.length
        ? 'The model receives the question and the grounding instructions without any retrieved text.'
        : ctx.params.fetchFullDocuments
          ? 'The fetched documents become model-visible only now, in place of the retained chunks.'
          : 'Retrieved text becomes model-visible only now.';
      trackRetained(e, ctx, true);
    },
    'retrieve-11': (e, ctx) => {
      const answer = ctx.answer();
      const message = payload(e)['message'];
      if (!message || typeof message !== 'object' || Array.isArray(message))
        throw new Error(`${e.id}: no message to derive`);
      message['content'] = modelMessage(answer);
      e.explanation = !ctx.evidence.length
        ? 'Simulated model output: without retained chunks there is no evidence, so the answer says so.'
        : ctx.params.fetchFullDocuments
          ? 'Simulated model output built from the facts supported by the fetched documents.'
          : 'Simulated model output built from the facts supported by the retained chunks.';
      trackRetained(e, ctx, false);
    },
    'retrieve-12': (e, ctx) => {
      const answer = ctx.answer();
      Object.assign(payload(e), { answer: answer.text, sources: sourceObjects(answer.cited) });
      e.explanation = !ctx.evidence.length
        ? 'Show the answer. Nothing was retrieved, so it cites no source and says that the documents do not cover the question.'
        : `Show the answer with clickable citations. Each statement comes from a cited ${ctx.params.fetchFullDocuments ? 'document' : 'chunk'}; what the evidence does not cover is stated, not guessed.`;
      trackRetained(e, ctx, false);
    },

    // Combined scenario
    'c-03': (e, { retrieval }) => {
      payload(e)['document_blocks'] = ids(retrieval.selected);
      track(e, 'chunkId', ids(retrieval.selected));
    },
    'c-04': (e, ctx) => {
      setUserMessage(
        e,
        groundedUserMessage(engine, ctx.scenario.question ?? '', ctx.retrieval.selected),
      );
      track(e, 'chunkId', ids(ctx.retrieval.selected));
    },
    'c-06': (e, ctx) => {
      setUserMessage(
        e,
        groundedUserMessage(engine, ctx.scenario.question ?? '', ctx.retrieval.selected),
      );
      track(e, 'chunkId', ids(ctx.retrieval.selected));
    },
    'c-07': (e, ctx) => {
      const { answer, explanation } = ctx.combinedAnswer();
      const message = payload(e)['message'];
      if (!message || typeof message !== 'object' || Array.isArray(message))
        throw new Error(`${e.id}: no message to derive`);
      message['content'] = modelMessage(answer);
      e.explanation = explanation;
      track(e, 'chunkId', ids(ctx.retrieval.selected));
    },
    'c-08': (e, ctx) => {
      const { answer } = ctx.combinedAnswer();
      Object.assign(payload(e), { answer: answer.text, sources: sourceObjects(answer.cited) });
      track(e, 'chunkId', ids(ctx.retrieval.selected));
    },
  };
}

/** The Combined answer: intro, the RAG answer, then the first comparison that applies. */
export function combinedAnswer(
  engine: RagEngine,
  selected: readonly ScoredChunk[],
  composition: AnswerComposition,
): { answer: Answer; explanation: string } {
  const answer = engine.answer(selected, composition.intro);
  const applies = composition.comparisons.find((c) =>
    (c.requires ?? []).every((f) => answer.supported.has(f)),
  );
  return applies
    ? {
        answer: {
          ...answer,
          text: `${answer.text} ${applies.sentence}`,
          parts: [...answer.parts, { kind: 'comparison', text: applies.sentence }],
        },
        explanation: applies.explanation,
      }
    : { answer, explanation: composition.explanation };
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** What is wrong with an answer_composition (06 combined), or undefined if nothing. */
export function answerCompositionProblem(raw: unknown): string | undefined {
  if (!record(raw)) return 'missing';
  const { intro, comparisons, explanation } = raw;
  if (
    !Array.isArray(intro) ||
    !intro.length ||
    !intro.every(
      (s) =>
        record(s) && (s['source'] === 'tool' || s['source'] === 'session') && isText(s['text']),
    )
  )
    return 'intro must list sentences, each with source tool or session and a text';
  if (
    !Array.isArray(comparisons) ||
    !comparisons.every((c) => record(c) && isText(c['sentence']) && isText(c['explanation']))
  )
    return 'each comparison needs a sentence and an explanation';
  if (!isText(explanation)) return 'explanation is missing';
  return undefined;
}

/** The Combined answer composition of the specifications, checked; a problem is an error naming it. */
export function answerComposition(sources: SpecSources): AnswerComposition {
  const raw = (sources.comparison.combined as unknown as { answer_composition?: unknown })
    .answer_composition;
  const problem = answerCompositionProblem(raw);
  if (problem) throw new Error(`06 combined.answer_composition: ${problem}`);
  return raw as AnswerComposition;
}

const num = (v: Json | undefined, fallback: number): number =>
  typeof v === 'number' ? v : fallback;
const bool = (v: Json | undefined, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;

/** The RAG engine as the specifications define it, with Playback's deriveEvents hook. */
export class RagDerivation {
  readonly engine: RagEngine;
  private readonly composition: AnswerComposition;
  private readonly defaults: RagParameters;
  private readonly handlers: Record<string, Handler>;

  constructor(sources: SpecSources) {
    const rag = sources.rag as unknown as {
      fixtures: RagFixtures;
      scenarios: Scenario[];
    };
    this.engine = new RagEngine(rag.fixtures);
    this.composition = answerComposition(sources);
    const param = (scenario: string, name: string): Json | undefined =>
      rag.scenarios.find((s) => s.id === scenario)?.parameters?.[name]?.default;
    this.defaults = {
      chunkSize: num(param('rag-index', 'chunk_size_words'), 50),
      overlap: num(param('rag-index', 'overlap_words'), 10),
      topK: num(param('rag-query', 'top_k'), 5),
      threshold: num(param('rag-query', 'similarity_threshold'), 0.7),
      rerank: bool(param('rag-query', 'rerank'), false),
      keywordRetrieval: bool(param('rag-query', 'keyword_retrieval'), false),
      fetchFullDocuments: bool(param('rag-query', 'fetch_full_documents'), false),
    };
    this.handlers = makeHandlers(this.engine);
  }

  /** Parameter values for a configuration; parameters it lacks keep the specs' defaults. */
  parameters(config: RetrievalConfig): RagParameters {
    const d = this.defaults;
    return {
      chunkSize: num(config['chunk_size_words'], d.chunkSize),
      overlap: num(config['overlap_words'], d.overlap),
      topK: num(config['top_k'], d.topK),
      threshold: num(config['similarity_threshold'], d.threshold),
      rerank: bool(config['rerank'], d.rerank),
      keywordRetrieval: bool(config['keyword_retrieval'], d.keywordRetrieval),
      fetchFullDocuments: bool(config['fetch_full_documents'], d.fetchFullDocuments),
    };
  }

  /** The scenario's events with every derived event recomputed. */
  derive(scenario: Scenario, config: RetrievalConfig): ScenarioEvent[] {
    const derived = new Set(scenario.derived_events ?? []);
    if (!derived.size) return scenario.events;
    const params = this.parameters(config);
    const docs = this.engine.corpus();
    const retrieval = this.engine.retrieve(docs, params);
    const parents = parentDocuments(retrieval.selected, docs);
    const evidence = params.fetchFullDocuments ? parents : retrieval.selected;
    let answer: Answer | undefined;
    let combined: { answer: Answer; explanation: string } | undefined;
    const ctx: Context = {
      scenario,
      params,
      docs,
      retrieval,
      parents,
      evidence,
      answer: () => (answer ??= this.engine.answer(evidence)),
      combinedAnswer: () =>
        (combined ??= combinedAnswer(this.engine, retrieval.selected, this.composition)),
    };
    return scenario.events.map((e) => {
      const id = localId(scenario, e);
      if (!derived.has(id)) return e;
      const handler = this.handlers[id];
      if (!handler) throw new Error(`${scenario.id}/${e.id}: no rule derives this event`);
      const copy = structuredClone(e);
      handler(copy, ctx);
      return copy;
    });
  }

  /**
   * The Combined answer with its parts, computed as the scenario's derived c-07 and c-08 are
   * (02 combined_answer.statements).
   */
  combinedAnswer(config: RetrievalConfig): Answer {
    const { selected } = this.engine.retrieve(this.engine.corpus(), this.parameters(config));
    return combinedAnswer(this.engine, selected, this.composition).answer;
  }

  /** Playback's deriveEvents hook. */
  readonly deriveEvents: DeriveEvents = (scenario, config) => this.derive(scenario, config);
}
