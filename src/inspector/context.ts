/**
 * Model-context panel (02-ui-ux.yaml context_panel): the agent's working memory beside
 * what the model saw in its latest request. The model is pure; the view renders it.
 */
import type { Snapshot } from '../engine/playback.ts';
import type { Json, ScenarioEvent } from '../scenarios/types.ts';
import { promptParts } from './retrieval.ts';

/** Where an item came from (02 context_panel.provenance): a tool, or retrieved documents. */
export type Source = 'tool' | 'documents';

/** The label naming each source in agent state. */
export const SOURCE_LABELS: Readonly<Record<Source, string>> = {
  tool: 'Tool data',
  documents: 'Document evidence',
};

/** The label of a tool message in the model-visible context, naming its tool. */
export function toolMessageLabel(tool: string): string {
  return `Tool data · ${tool} result`;
}

export interface MemoryEntry {
  step: number;
  description: string;
  /** Tool data or document evidence; absent for anything else. */
  source?: Source;
  value?: Json;
  /** Not yet sent to the model by a later LLM request. */
  unseen: boolean;
  /** Added at this step. */
  added: boolean;
}

/** A document block of a model-visible message. */
export interface DocumentBlock {
  documentId: string;
  version: string;
  chunkId?: string;
  text: string;
}

export interface VisibleMessage {
  role: string;
  /** The message text without its document blocks, or a summary of its tool calls. */
  text: string;
  /** For a tool message, the tool its call named. */
  tool?: string;
  /** The message's document blocks, in prompt order. */
  documents: DocumentBlock[];
  /** New since the previous step. */
  added: boolean;
}

export interface ContextModel {
  memory: MemoryEntry[];
  /** Undefined before the first LLM request. */
  messages: VisibleMessage[] | undefined;
  tools: number;
}

type Obj = Record<string, Json>;
const obj = (v: Json | undefined): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};

/** Whether a scenario has anything for the panel (02 context_panel.shown_when). */
export function hasContext(initial: Readonly<Obj>): boolean {
  return Object.hasOwn(initial, 'agent_state') || Object.hasOwn(initial, 'model_visible_messages');
}

function messageText(message: Obj): string {
  const content = message['content'];
  if (typeof content === 'string') return content;
  const calls = Array.isArray(message['tool_calls']) ? message['tool_calls'] : [];
  if (calls.length) {
    return calls
      .map((c) => {
        const call = obj(c);
        return `Tool call ${String(call['name'])}(${JSON.stringify(call['arguments'] ?? {})})`;
      })
      .join('; ');
  }
  return JSON.stringify(content ?? null);
}

/** Whether a stored value is a tool result or a tool message. */
function isToolData(value: Json | undefined): boolean {
  const v = obj(value);
  return (
    v['role'] === 'tool' ||
    Object.hasOwn(v, 'structuredContent') ||
    typeof v['isError'] === 'boolean'
  );
}

/** A memory entry's source: tool data, or a non-empty list of retained chunks from a retrieval step. */
function memorySource(
  events: readonly ScenarioEvent[],
  index: number,
  value: Json | undefined,
): Source | undefined {
  if (isToolData(value)) return 'tool';
  const stored = events[index];
  if (stored?.protocol === 'RAG_INTERNAL' && Array.isArray(value) && value.length)
    return 'documents';
  return undefined;
}

/** Splits a message's text from its document blocks. */
function withDocuments(text: string): { text: string; documents: DocumentBlock[] } {
  const parts = promptParts(text);
  const documents: DocumentBlock[] = [];
  let own = '';
  for (const part of parts) {
    if (!('block' in part)) {
      own += part.text;
      continue;
    }
    const b = part.block;
    documents.push({
      documentId: b['id'] ?? '',
      version: b['version'] ?? '',
      ...(b['chunk'] !== undefined ? { chunkId: b['chunk'] } : {}),
      text: part.text,
    });
  }
  return documents.length ? { text: own.trimEnd(), documents } : { text, documents };
}

/** String leaves of a value. */
function strings(value: Json | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return (Array.isArray(value) ? value : Object.values(value)).flatMap(strings);
}

/** Text an entry must share with a request to count as seen: strings of 8+ characters. */
const MIN_SHARED = 8;

/**
 * Whether a stored entry is still unseen (02 context_panel.agent_state): the model's own
 * output and entries with nothing to send are never labelled; others are seen once a later
 * LLM request contains one of their strings.
 */
function unseen(
  stored: ScenarioEvent | undefined,
  values: string[],
  index: number,
  requests: { index: number; text: string[] }[],
): boolean {
  if (stored?.protocol === 'LLM_API' && stored.message_type === 'RESPONSE') return false;
  const shared = values.filter((t) => t.length >= MIN_SHARED);
  if (!shared.length) return false;
  return !requests.some(
    (r) => r.index > index && shared.some((t) => r.text.some((s) => s.includes(t))),
  );
}

/**
 * The panel's content at a cursor: an entry stays unseen until an LLM request after the
 * step that stored it contains its value (02 context_panel.agent_state).
 */
export function contextModel(
  events: readonly ScenarioEvent[],
  snapshot: Snapshot,
  previous: Snapshot | undefined,
): ContextModel {
  const state = snapshot.state as Obj;
  const before = (previous?.state ?? {}) as Obj;
  const memory = Array.isArray(state['agent_state']) ? state['agent_state'] : [];
  const earlier = Array.isArray(before['agent_state']) ? before['agent_state'].length : 0;
  const requests = events
    .map((e, i) => (e.protocol === 'LLM_API' && e.message_type === 'REQUEST' ? i : -1))
    .filter((i) => i >= 0 && i < snapshot.cursor)
    .map((i) => ({ index: i, text: strings(events[i]?.payload) }));
  const entries = memory.map((raw, i): MemoryEntry => {
    const entry = obj(raw);
    const index = events.findIndex((e) => e.id === entry['event']);
    const source = memorySource(events, index, entry['value']);
    const entryOut: MemoryEntry = {
      step: index + 1,
      description: String(entry['description'] ?? ''),
      ...(source ? { source } : {}),
      unseen: unseen(events[index], strings(entry['value']), index, requests),
      added: i >= earlier,
    };
    if (Object.hasOwn(entry, 'value')) entryOut.value = entry['value'] as Json;
    return entryOut;
  });
  const visible = state['model_visible_messages'];
  const visibleBefore = before['model_visible_messages'];
  const list = Array.isArray(obj(visible)['messages'])
    ? (obj(visible)['messages'] as Json[])
    : undefined;
  const listBefore = Array.isArray(obj(visibleBefore)['messages'])
    ? (obj(visibleBefore)['messages'] as Json[])
    : [];
  // Tool names by tool call ID, from the assistant messages' tool calls.
  const tools = new Map<string, string>();
  for (const m of list ?? []) {
    const calls = obj(m)['tool_calls'];
    for (const c of Array.isArray(calls) ? calls : [])
      tools.set(String(obj(c)['id']), String(obj(c)['name']));
  }
  const messages = list?.map((m, i): VisibleMessage => {
    const message = obj(m);
    const role = String(message['role'] ?? '');
    const tool = role === 'tool' ? tools.get(String(message['tool_call_id'])) : undefined;
    return {
      role,
      ...withDocuments(messageText(message)),
      ...(role === 'tool' ? { tool: tool ?? 'unknown tool' } : {}),
      added: i >= listBefore.length || JSON.stringify(m) !== JSON.stringify(listBefore[i]),
    };
  });
  const definitions = obj(visible)['tools'];
  return {
    memory: entries,
    messages,
    tools: Array.isArray(definitions) ? definitions.length : 0,
  };
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

/** A source label: weight 600 in ink, so it does not depend on colour. */
function sourceLabel(text: string): HTMLElement {
  return el('strong', 'source-label', text);
}

/** A source label and the separator after it, which never break apart. */
function sourceTag(text: string): (Node | string)[] {
  return [sourceLabel(text), '\u00a0· '];
}

/** Renders the panel's two columns. */
export function renderContext(model: ContextModel): HTMLElement {
  const memory = el('section', 'context-column');
  memory.setAttribute('aria-label', 'Agent state');
  memory.append(el('h3', undefined, 'Agent state'));
  if (!model.memory.length)
    memory.append(el('p', 'small muted', 'The agent has stored nothing yet.'));
  const list = el('ol', 'context-list');
  for (const entry of model.memory) {
    const item = el(
      'li',
      entry.added ? 'context-added' : undefined,
      el('span', 'small muted', `Step ${entry.step} · `),
      ...(entry.source ? sourceTag(SOURCE_LABELS[entry.source]) : []),
      entry.description,
    );
    if (entry.unseen) item.append(el('span', 'unseen', ' · not yet seen by the model'));
    if (entry.value !== undefined) {
      const value = el('details', 'context-value');
      value.append(
        el('summary', 'small', 'Value'),
        el('pre', undefined, JSON.stringify(entry.value, null, 2)),
      );
      item.append(value);
    }
    list.append(item);
  }
  memory.append(list);

  const visible = el('section', 'context-column');
  visible.setAttribute('aria-label', 'Model-visible context');
  visible.append(el('h3', undefined, 'Seen by the model'));
  if (!model.messages) {
    visible.append(el('p', 'small muted', 'The model has not seen anything yet.'));
  } else {
    const messages = el('ol', 'context-list');
    for (const m of model.messages) {
      const item = el(
        'li',
        m.added ? 'context-added' : undefined,
        el('span', 'small muted', `${m.role} · `),
        ...(m.tool !== undefined ? sourceTag(toolMessageLabel(m.tool)) : []),
        m.text,
      );
      // Document blocks below the message's own text, in prompt order.
      if (m.documents.length) {
        const blocks = el('ol', 'context-documents');
        for (const d of m.documents) {
          const where = [
            `${d.documentId} v${d.version}`,
            ...(d.chunkId !== undefined ? [`chunk ${d.chunkId}`] : []),
          ].join(' · ');
          blocks.append(
            el(
              'li',
              undefined,
              el('p', 'small', ...sourceTag(SOURCE_LABELS.documents), where),
              el('p', 'context-document-text', d.text),
            ),
          );
        }
        item.append(blocks);
      }
      messages.append(item);
    }
    visible.append(messages);
    if (model.tools) {
      visible.append(
        el(
          'p',
          'small muted',
          model.tools === 1 ? '1 tool definition' : `${model.tools} tool definitions`,
        ),
      );
    }
  }
  return el('div', 'context-columns', memory, visible);
}
