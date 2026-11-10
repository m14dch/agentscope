/**
 * The Combined answer's provenance (02-ui-ux.yaml combined_answer): the answer of c-08 as
 * statements, each labelled with its source in a column of its own; the balance opens the
 * tool result and each citation its chunk. The model is pure and read from the played
 * events; the view renders it.
 */
import type { AnswerPart } from '../rag/engine.ts';
import type { Json, ScenarioEvent } from '../scenarios/types.ts';
import {
  appendCited,
  citationButton,
  evidence,
  renderEvidence,
  type SearchedIndex,
  shownAnswer,
  type Source,
} from './retrieval.ts';

type Obj = Record<string, Json>;
const obj = (v: Json | undefined): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
const list = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);

/** Where a statement of the answer comes from. */
export type StatementSource = 'tool' | 'session' | 'documents' | 'gap' | 'note' | 'comparison';

/** The label of each source, in the column beside its statements. */
export const STATEMENT_LABELS: Readonly<Record<StatementSource, string>> = {
  tool: 'Tool data · MCP',
  session: 'Session context',
  documents: 'Document evidence · RAG',
  gap: 'Not in the evidence',
  note: 'Note',
  comparison: 'Comparison',
};

export interface Statement {
  /** Absent only when the parts do not compose the shown answer (then it is one statement). */
  source?: StatementSource;
  text: string;
}

/** The source of an answer part, by its kind (02 combined_answer.statements). */
export function partSource(part: AnswerPart): StatementSource {
  switch (part.kind) {
    case 'intro':
      return part.source;
    case 'group':
    case 'conflict':
      return 'documents';
    case 'gap':
    case 'no-evidence':
      return 'gap';
    case 'note':
      return 'note';
    case 'comparison':
      return 'comparison';
  }
}

/**
 * The shown answer as statements: the parts the engine composed it from, each labelled by
 * its kind. If their join is not the shown answer, the answer is one unlabelled statement.
 */
export function answerStatements(answer: string, parts: readonly AnswerPart[]): Statement[] {
  if (parts.map((p) => p.text).join(' ') !== answer) return [{ text: answer }];
  return parts.map((p) => ({ source: partSource(p), text: p.text }));
}

/** The tool result the answer's live data comes from. */
export interface ToolResult {
  tool: string;
  arguments: Json;
  /** The result's structuredContent. */
  result: Json;
  /** The balance as the answer writes it, for example 'CHF 12,500.75', if the result has one. */
  balance?: string;
  /** 1-based step of the tools/call result. */
  step: number;
  /** 1-based step of the first model request that contains the result, if any. */
  sentStep?: number;
}

export interface CombinedModel {
  statements: Statement[];
  /** The document sources, as the answer cites them. */
  sources: Source[];
  tool?: ToolResult;
}

/** String leaves of a value. */
function strings(value: Json | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return (Array.isArray(value) ? value : Object.values(value)).flatMap(strings);
}

/** An amount as the answer writes it: currency, thousands separators and 2 decimals. */
export function money(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** The last tools/call result up to the cursor, with its request and the request that sent it on. */
function toolResult(events: readonly ScenarioEvent[], cursor: number): ToolResult | undefined {
  let at = -1;
  for (let i = Math.min(cursor, events.length) - 1; i >= 0 && at < 0; i -= 1) {
    const e = events[i] as ScenarioEvent;
    if (e.protocol === 'MCP' && e.operation === 'tools/call result') at = i;
  }
  if (at < 0) return undefined;
  const response = events[at] as ScenarioEvent;
  const request = events.find((e) => e.id === response.pair_id);
  const params = obj(obj(request?.payload as Json | undefined)['params']);
  const result = obj(obj(response.payload as Json | undefined)['result']);
  const structured = result['structuredContent'] ?? null;
  const content = list(result['content'])
    .map((c) => obj(c)['text'])
    .filter((t): t is string => typeof t === 'string');
  const sent = events.findIndex(
    (e, i) =>
      i > at &&
      e.protocol === 'LLM_API' &&
      e.message_type === 'REQUEST' &&
      strings(e.payload).some((s) => content.some((c) => s.includes(c))),
  );
  const { currency, balance } = obj(structured);
  return {
    tool: String(params['name'] ?? ''),
    arguments: params['arguments'] ?? {},
    result: structured,
    ...(typeof currency === 'string' && typeof balance === 'number'
      ? { balance: money(currency, balance) }
      : {}),
    step: at + 1,
    ...(content.length && sent >= 0 ? { sentStep: sent + 1 } : {}),
  };
}

/**
 * The panel's content at a cursor, or undefined before the answer is displayed (c-08) or in
 * a scenario without it.
 */
export function combinedModel(
  events: readonly ScenarioEvent[],
  cursor: number,
  parts: readonly AnswerPart[],
): CombinedModel | undefined {
  const shown = events.findIndex((e) => e.id === 'c-08' || e.id.endsWith(':c-08'));
  if (shown < 0 || cursor < shown + 1) return undefined;
  const answer = shownAnswer(events[shown]);
  const tool = toolResult(events, cursor);
  return {
    statements: answerStatements(answer.text, parts),
    sources: answer.sources,
    ...(tool ? { tool } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// View

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

export interface CombinedContext {
  /** The index the scenario searches, for the chunks the citations open. */
  index: () => SearchedIndex;
  /** Moves the cursor to a step (1-based). */
  jump: (step: number) => void;
  /** Takes focus when the panel disappears while holding it. */
  leave: () => void;
}

/** What is open below the statements: the tool result or a citation's chunk. */
type Open = 'tool' | number | undefined;

const EVIDENCE_ID = 'combined-evidence';

/** The panel; rebuilt only when what it shows changes, keeping focus on the same control. */
export class CombinedPanel {
  readonly root: HTMLElement;
  private readonly context: CombinedContext;
  private model: CombinedModel | undefined;
  private open: Open;
  private shown = '';

  constructor(context: CombinedContext) {
    this.context = context;
    this.root = el('section', 'combined');
    this.root.setAttribute('aria-labelledby', 'combined-title');
    this.root.hidden = true;
  }

  update(model: CombinedModel | undefined): void {
    this.model = model;
    // What is open and no longer exists closes.
    if (
      (this.open === 'tool' && !model?.tool) ||
      (typeof this.open === 'number' && !model?.sources.some((s) => s.citation === this.open))
    )
      this.open = undefined;
    const key = JSON.stringify([model, this.open]);
    if (key === this.shown) return;
    this.shown = key;
    const active = document.activeElement;
    const restore =
      active instanceof HTMLElement && this.root.contains(active)
        ? (active.closest<HTMLElement>('[data-focus]')?.dataset['focus'] ?? '')
        : undefined;
    this.root.hidden = !model;
    if (!model) {
      this.root.replaceChildren();
      if (restore !== undefined) this.context.leave();
      return;
    }
    this.root.replaceChildren(
      Object.assign(el('h3', undefined, 'Where each part of the answer comes from'), {
        id: 'combined-title',
        tabIndex: -1,
      }),
      el(
        'p',
        'small muted',
        'Simulated model output, shown to the user. Each statement is labelled with its source.',
      ),
      this.statements(model),
      this.sources(model),
      this.evidence(model),
    );
    if (restore !== undefined) {
      const target =
        (restore &&
          this.root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(restore)}"]`)) ||
        this.root.querySelector<HTMLElement>('#combined-title');
      target?.focus({ preventScroll: true });
    }
  }

  private toggle(open: Exclude<Open, undefined>): void {
    this.open = this.open === open ? undefined : open;
    this.update(this.model);
  }

  private stepLink(step: number, key: string): HTMLButtonElement {
    const link = focusKey(el('button', 'link', `step ${step}`), key);
    link.type = 'button';
    link.addEventListener('click', () => this.context.jump(step));
    return link;
  }

  private statements(model: CombinedModel): HTMLElement {
    const sources = new Map(model.sources.map((s) => [s.citation, s]));
    const seen = new Map<number, number>();
    const items = model.statements.map((st) => {
      const text = el('p', 'statement-text');
      const balance = model.tool?.balance;
      const at = st.source === 'tool' && balance ? st.text.indexOf(balance) : -1;
      if (at >= 0 && model.tool && balance) {
        const b = focusKey(el('button', 'balance', balance), 'balance');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(this.open === 'tool'));
        b.setAttribute(
          'aria-label',
          `${balance}: the ${model.tool.tool} tool result, returned at step ${model.tool.step}`,
        );
        b.setAttribute('aria-controls', EVIDENCE_ID);
        b.addEventListener('click', () => this.toggle('tool'));
        text.append(st.text.slice(0, at), b, st.text.slice(at + balance.length));
      } else {
        appendCited(text, st.text, seen, (n, nth) =>
          citationButton(n, nth, sources.get(n), this.open === n, EVIDENCE_ID, () =>
            this.toggle(n),
          ),
        );
      }
      const item = el(
        'li',
        'statement',
        el('span', 'statement-source small', st.source ? STATEMENT_LABELS[st.source] : ''),
        text,
      );
      if (st.source) item.dataset['source'] = st.source;
      return item;
    });
    const statements = el('ol', 'statements', ...items);
    statements.setAttribute('aria-label', 'The answer, statement by statement, with its sources');
    return statements;
  }

  private sources(model: CombinedModel): HTMLElement {
    const groups: HTMLElement[] = [];
    if (model.tool)
      groups.push(
        el(
          'div',
          'combined-source',
          el('h5', 'small muted', 'Tool data'),
          el(
            'p',
            'small',
            `${model.tool.tool} result, returned at `,
            this.stepLink(model.tool.step, 'tool-step'),
          ),
        ),
      );
    groups.push(
      el(
        'div',
        'combined-source',
        el('h5', 'small muted', 'Documents'),
        model.sources.length
          ? el('ol', 'sources small', ...model.sources.map((s) => el('li', 'source-line', s.line)))
          : el('p', 'small muted', 'No document is cited.'),
      ),
    );
    return el('div', 'combined-sources', el('h4', undefined, 'Sources'), ...groups);
  }

  private evidence(model: CombinedModel): HTMLElement {
    const holder = el('div', 'evidence');
    holder.id = EVIDENCE_ID;
    const tool = model.tool;
    if (this.open === 'tool' && tool) {
      const sent = tool.sentStep
        ? [' The model first saw it at ', this.stepLink(tool.sentStep, 'tool-sent-step'), '.']
        : [' The model has not seen it.'];
      holder.append(
        el('h5', 'evidence-title', `Tool result · ${tool.tool}`),
        el(
          'p',
          'small',
          `Called through MCP tools/call with ${JSON.stringify(tool.arguments)}; returned at `,
          this.stepLink(tool.step, 'tool-result-step'),
          '.',
          ...sent,
        ),
        el('pre', 'code-text', JSON.stringify(tool.result, null, 2)),
      );
    } else if (typeof this.open === 'number') {
      const source = model.sources.find((s) => s.citation === this.open);
      const view = source ? evidence(source, this.context.index()) : undefined;
      if (view) holder.append(renderEvidence(view));
    }
    return holder;
  }
}
