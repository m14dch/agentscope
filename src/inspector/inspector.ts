/**
 * Event inspector (02-ui-ux.yaml inspector): the step's message first, then tabs for the
 * payload, the simulated transport envelope, the security boundaries and the lineage.
 * A tab is shown only when the step has content for it.
 */
import { arrowLabel } from '../diagram/model.ts';
import type { Json, ScenarioEvent } from '../scenarios/types.ts';
import { jsonTree, newInRequest, type TreeNode, trackedValues } from './json.ts';

export type TabId = 'payload' | 'transport' | 'security' | 'lineage';
const TAB_LABELS: Record<TabId, string> = {
  payload: 'Payload',
  transport: 'Transport',
  security: 'Security',
  lineage: 'Lineage',
};
const ORDER: TabId[] = ['payload', 'transport', 'security', 'lineage'];
/** Boilerplate members of MCP messages (02 inspector.folding). */
const FOLDED = new Set(['jsonrpc', '_meta']);

export interface Boundary {
  id: string;
  risk: string;
  mitigation: string;
}

export interface InspectorContext {
  labels: Readonly<Record<string, string>>;
  boundaries: readonly Boundary[];
  /** Moves the cursor to a step (1-based). */
  jump: (step: number) => void;
}

/** What the inspector shows for one cursor position. */
export interface InspectorStep {
  events: readonly ScenarioEvent[];
  cursor: number;
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

function renderTree(node: TreeNode): HTMLElement {
  if (node.kind === 'fold') {
    const details = el('details', 'json-fold');
    details.append(el('summary', 'json-punct', node.label), ...node.children.map(renderTree));
    return details;
  }
  const key =
    node.key === undefined
      ? []
      : [el('span', 'json-key', JSON.stringify(node.key)), el('span', 'json-punct', ': ')];
  const comma = node.comma ? [el('span', 'json-punct', ',')] : [];
  if (node.kind === 'leaf') {
    const value = el('span', `json-value${node.mark ? ' json-mark' : ''}`, node.text);
    const redacted = node.redacted ? [el('span', 'json-label', ' redacted')] : [];
    return el('div', 'json-line', ...key, value, ...redacted, ...comma);
  }
  if (!node.children.length) {
    return el(
      'div',
      'json-line',
      ...key,
      el('span', 'json-punct', `${node.open}${node.close}`),
      ...comma,
    );
  }
  const details = el('details', `json-branch${node.mark ? ' json-mark' : ''}`);
  details.open = true;
  details.append(
    el('summary', 'json-line', ...key, el('span', 'json-punct', node.open)),
    el('div', 'json-children', ...node.children.map(renderTree)),
    el('div', 'json-line', el('span', 'json-punct', node.close), ...comma),
  );
  return details;
}

function codeBlock(value: Json, options: Parameters<typeof jsonTree>[1] = {}): HTMLElement {
  return el('div', 'json', renderTree(jsonTree(value, options)));
}

export class Inspector {
  private readonly root: HTMLElement;
  private readonly context: InspectorContext;
  private chosen: TabId = 'payload';

  constructor(root: HTMLElement, context: InspectorContext) {
    this.root = root;
    this.context = context;
    root.classList.add('inspector-body');
  }

  update(step: InspectorStep): void {
    const event = step.events[step.cursor - 1];
    if (!event) {
      this.root.replaceChildren();
      return;
    }
    const focusedTab = this.root.contains(document.activeElement)
      ? (document.activeElement as HTMLElement | null)?.dataset['tab']
      : undefined;
    const panels = new Map<TabId, () => Node[]>();
    if (event.payload !== undefined && event.payload !== null)
      panels.set('payload', () => this.payload(event, step));
    if (event.http) panels.set('transport', () => this.transport(event, step));
    if (event.security_boundaries?.length) panels.set('security', () => this.security(event));
    if (event.tracked_values && Object.keys(event.tracked_values).length) {
      panels.set('lineage', () => this.lineage(event, step));
    }
    const message = this.message(event);
    const available = ORDER.filter((t) => panels.has(t));
    if (!available.length) {
      this.root.replaceChildren(...message, ...this.notes(event));
      return;
    }
    // The chosen tab stays chosen while the step has content for it (02 inspector.tab_rules).
    const shown: TabId = panels.has(this.chosen) ? this.chosen : (available[0] as TabId);
    const tablist = el('div', 'tabs-bar');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Step details');
    const panel = el('div', 'tab-panel');
    panel.setAttribute('role', 'tabpanel');
    panel.id = 'inspector-panel';
    for (const id of available) {
      const tab = el('button', 'tab', TAB_LABELS[id]);
      tab.type = 'button';
      tab.id = `inspector-tab-${id}`;
      tab.dataset['tab'] = id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(id === shown));
      tab.setAttribute('aria-controls', panel.id);
      tab.tabIndex = id === shown ? 0 : -1;
      tab.addEventListener('click', () => this.choose(id, step));
      tab.addEventListener('keydown', (e) => this.onTabKey(e, available, step));
      tablist.append(tab);
    }
    panel.setAttribute('aria-labelledby', `inspector-tab-${shown}`);
    panel.replaceChildren(...(panels.get(shown)?.() ?? []));
    this.root.replaceChildren(...message, tablist, panel);
    if (focusedTab) this.root.querySelector<HTMLElement>(`[data-tab="${focusedTab}"]`)?.focus();
  }

  private choose(id: TabId, step: InspectorStep, focus = false): void {
    this.chosen = id;
    this.update(step);
    if (focus) this.root.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.focus();
  }

  private onTabKey(e: KeyboardEvent, available: TabId[], step: InspectorStep): void {
    const i = available.indexOf((e.currentTarget as HTMLElement).dataset['tab'] as TabId);
    const target =
      e.key === 'ArrowRight'
        ? available[(i + 1) % available.length]
        : e.key === 'ArrowLeft'
          ? available[(i - 1 + available.length) % available.length]
          : e.key === 'Home'
            ? available[0]
            : e.key === 'End'
              ? available[available.length - 1]
              : undefined;
    if (!target) return;
    e.preventDefault();
    this.choose(target, step, true);
  }

  private message(event: ScenarioEvent): Node[] {
    const from = this.context.labels[event.sender] ?? event.sender;
    const to = this.context.labels[event.receiver] ?? event.receiver;
    return [
      el('p', 'message', event.explanation),
      el('p', 'small muted', `${from} → ${to} · ${arrowLabel(event)}`),
    ];
  }

  private notes(event: ScenarioEvent): Node[] {
    if (!event.technical_notes?.length) return [];
    return [el('ul', 'notes small', ...event.technical_notes.map((n) => el('li', undefined, n)))];
  }

  private stepLink(step: number, text: string): HTMLButtonElement {
    const b = el('button', 'link', text);
    b.type = 'button';
    b.addEventListener('click', () => this.context.jump(step));
    return b;
  }

  private payload(event: ScenarioEvent, step: InspectorStep): Node[] {
    const nodes: Node[] = [];
    const tools = el('div', 'panel-tools');
    if (event.pair_id) {
      const pair = step.events.findIndex((e) => e.id === event.pair_id);
      if (pair >= 0) {
        const kind = event.message_type === 'RESPONSE' ? 'Request' : 'Response';
        tools.append(this.stepLink(pair + 1, `${kind}: step ${pair + 1}`));
      }
    }
    const copy = el('button', undefined, 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(JSON.stringify(event.payload, null, 2)).then(
        () => (copy.textContent = 'Copied'),
        () => (copy.textContent = 'Copy failed'),
      );
    });
    tools.append(copy);
    nodes.push(tools);
    let changed = new Set<string>();
    if (event.protocol === 'LLM_API' && event.message_type === 'REQUEST') {
      const before = step.events
        .slice(0, step.cursor - 1)
        .filter((e) => e.protocol === 'LLM_API' && e.message_type === 'REQUEST')
        .pop();
      changed = newInRequest(event.payload, before?.payload);
    }
    nodes.push(
      codeBlock(event.payload as Json, {
        fold: event.protocol === 'MCP' ? FOLDED : new Set(),
        changed,
        tracked: trackedValues(event.tracked_values),
      }),
    );
    nodes.push(...this.notes(event));
    return nodes;
  }

  private transport(event: ScenarioEvent, step: InspectorStep): Node[] {
    const http = event.http ?? {};
    const nodes: Node[] = [
      el('p', 'small muted', 'Simulated exchange: nothing is sent over a network.'),
    ];
    const start =
      http.status !== undefined
        ? `HTTP ${http.status}`
        : `${http.method ?? ''} ${http.path ?? ''}`.trim();
    nodes.push(el('p', 'code-line', start));
    const headers = Object.entries(http.headers ?? {});
    // Headers unchanged since the sender's previous network request fold to one line.
    const previous =
      event.message_type === 'REQUEST'
        ? step.events
            .slice(0, step.cursor - 1)
            .filter((e) => e.sender === event.sender && e.http && e.message_type === 'REQUEST')
            .pop()?.http?.headers
        : undefined;
    const same = headers.filter(([k, v]) => previous?.[k] === v);
    const different = headers.filter(([k, v]) => previous?.[k] !== v);
    const line = ([k, v]: [string, string]): HTMLElement => {
      const redacted = /<REDACTED[^>]*>/.test(v) ? [el('span', 'json-label', ' redacted')] : [];
      return el(
        'div',
        'json-line',
        el('span', 'json-key', `${k}: `),
        el('span', 'json-value', v),
        ...redacted,
      );
    };
    const list = el('div', 'json', ...different.map(line));
    if (same.length) {
      const fold = el('details', 'json-fold');
      const label = same.length === 1 ? '1 header unchanged' : `${same.length} headers unchanged`;
      fold.append(el('summary', 'json-punct', label), ...same.map(line));
      list.append(fold);
    }
    nodes.push(list);
    if (http.body_ref) nodes.push(el('p', 'small muted', 'Body: the payload in the Payload tab.'));
    return nodes;
  }

  private security(event: ScenarioEvent): Node[] {
    const items = (event.security_boundaries ?? []).map((id) => {
      const b = this.context.boundaries.find((x) => x.id === id);
      return el(
        'div',
        'boundary',
        el('p', 'boundary-id', id),
        el('p', undefined, el('span', 'muted', 'Risk: '), b?.risk ?? ''),
        el('p', undefined, el('span', 'muted', 'Mitigation: '), b?.mitigation ?? ''),
      );
    });
    return items;
  }

  private lineage(event: ScenarioEvent, step: InspectorStep): Node[] {
    const rows: Node[] = [];
    for (const [key, value] of Object.entries(event.tracked_values ?? {})) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        const first = step.events.findIndex((e) => {
          const t = e.tracked_values?.[key];
          return t !== undefined && (Array.isArray(t) ? t.some((x) => x === v) : t === v);
        });
        const origin =
          first >= 0 && first + 1 < step.cursor
            ? this.stepLink(first + 1, `first at step ${first + 1}`)
            : el('span', 'muted', 'first here');
        rows.push(
          el(
            'div',
            'lineage-row',
            el('span', 'json-key', key),
            el('span', 'json-value json-mark', JSON.stringify(v)),
            origin,
          ),
        );
      }
    }
    return rows;
  }
}
