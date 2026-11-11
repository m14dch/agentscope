/**
 * Event inspector (02-ui-ux.yaml inspector): the step's message first, then tabs for the
 * payload, the simulated transport envelope, the security boundaries and the lineage.
 * A tab is shown only when the step has content for it. The inspector is rebuilt only
 * when the step changes, and focus stays on the equivalent control.
 */
import { type ErrorKind, errorKind, operationLabel } from '../diagram/model.ts';
import type {
  EarlierMessage,
  EarlierRevision,
  HttpEnvelope,
  Json,
  ScenarioEvent,
} from '../scenarios/types.ts';
import { jsonTree, mcpBoilerplate, newInRequest, type TreeNode, trackedValues } from './json.ts';

export type TabId = 'payload' | 'transport' | 'security' | 'lineage';
const TAB_LABELS: Record<TabId, string> = {
  payload: 'Payload',
  transport: 'Transport',
  security: 'Security',
  lineage: 'Lineage',
};
const ORDER: TabId[] = ['payload', 'transport', 'security', 'lineage'];
const REDACTED = /<REDACTED[^>]*>/;

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
  /** Selects a tracked value, or clears the selection (02 lineage_selection.select). */
  select: (selection: Selection | undefined) => void;
  /** 07-security-protocols.yaml error_taxonomy, by key (tool_execution, protocol, ...). */
  errorTaxonomy?: Readonly<Record<string, string>> | undefined;
  /** 04-mcp-scenarios.yaml protocol.earlier_revision_handshake, for server/discover. */
  earlierRevision?: EarlierRevision | undefined;
}

/** Each error kind's key in 07-security-protocols.yaml error_taxonomy. */
const TAXONOMY_KEY: Record<ErrorKind, string> = {
  'tool execution': 'tool_execution',
  protocol: 'protocol',
  transport: 'transport',
  model: 'model',
};

/** The error line of a step (02 inspector.error_line); undefined unless it is an error arrow. */
export function errorLine(
  event: ScenarioEvent,
  taxonomy: Readonly<Record<string, string>> = {},
): { kind: ErrorKind; label: string; definition: string } | undefined {
  const kind = errorKind(event);
  if (!kind) return undefined;
  return { kind, label: `× ${kind} error`, definition: taxonomy[TAXONOMY_KEY[kind]] ?? '' };
}

/** Whether a step offers the earlier-revision comparison (02 inspector.earlier_revision). */
export function offersEarlierRevision(event: ScenarioEvent): boolean {
  return (
    event.protocol === 'MCP' &&
    event.message_type === 'REQUEST' &&
    event.operation === 'server/discover'
  );
}

/** A selected tracked value. */
export interface Selection {
  key: string;
  value: string | number;
}

/** Steps (0-based indices) whose tracked values under `key` include `value`. */
export function occurrences(events: readonly ScenarioEvent[], selection: Selection): number[] {
  const found: number[] = [];
  events.forEach((e, i) => {
    const t = e.tracked_values?.[selection.key];
    if (
      t !== undefined &&
      (Array.isArray(t) ? t.some((x) => x === selection.value) : t === selection.value)
    ) {
      found.push(i);
    }
  });
  return found;
}

/** What the inspector shows for one cursor position. */
export interface InspectorStep {
  events: readonly ScenarioEvent[];
  cursor: number;
  selection?: Selection | undefined;
}

export interface TransportLines {
  /** Request line (method and path) or status line. */
  start: string;
  /** Headers shown, in envelope order. */
  shown: [string, string][];
  /** Headers identical to the sender's previous network request, folded (02 inspector.folding). */
  folded: [string, string][];
}

/** The Transport tab's content for event `cursor` (1-based). Pure, so it can be tested. */
export function transportLines(
  events: readonly ScenarioEvent[],
  cursor: number,
): TransportLines | undefined {
  const event = events[cursor - 1];
  const http = event?.http;
  if (!event || !http) return undefined;
  const start = startLine(http);
  const previous =
    event.message_type === 'REQUEST'
      ? events
          .slice(0, cursor - 1)
          .filter((e) => e.sender === event.sender && e.http && e.message_type === 'REQUEST')
          .pop()?.http?.headers
      : undefined;
  const headers = Object.entries(http.headers ?? {});
  return {
    start,
    shown: headers.filter(([k, v]) => previous?.[k] !== v),
    folded: headers.filter(([k, v]) => previous?.[k] === v),
  };
}

/** The request line (method and path) or the status line of an envelope. */
function startLine(http: HttpEnvelope): string {
  return http.status !== undefined
    ? `HTTP ${http.status}`
    : `${http.method ?? ''} ${http.path ?? ''}`.trim();
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

/** Marks an element so focus can return to its equivalent after a rebuild. */
function focusKey<T extends HTMLElement>(node: T, key: string): T {
  node.dataset['focus'] = key;
  return node;
}

function renderTree(node: TreeNode): HTMLElement {
  if (node.kind === 'fold') {
    const details = el('details', 'json-fold');
    // A fold's members are never folds themselves; the first one's path identifies it.
    const first = node.children[0];
    const id = first && first.kind !== 'fold' ? first.path : node.label;
    details.append(
      focusKey(el('summary', 'json-punct', node.label), `fold:${id}`),
      ...node.children.map(renderTree),
    );
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
    focusKey(
      el('summary', 'json-line', ...key, el('span', 'json-punct', node.open)),
      `branch:${node.path}`,
    ),
    el('div', 'json-children', ...node.children.map(renderTree)),
    el('div', 'json-line', el('span', 'json-punct', node.close), ...comma),
  );
  return details;
}

function headerLine([k, v]: [string, string]): HTMLElement {
  const redacted = REDACTED.test(v) ? [el('span', 'json-label', ' redacted')] : [];
  return el(
    'div',
    'json-line',
    el('span', 'json-key', `${k}: `),
    el('span', 'json-value', v),
    ...redacted,
  );
}

export class Inspector {
  private readonly root: HTMLElement;
  private readonly context: InspectorContext;
  private chosen: TabId = 'payload';
  /** Phones fold the tabs behind "Step details" (02 layout.phone.inspector); kept while stepping. */
  private collapsed = true;
  /** The step last rendered, so unrelated player changes keep folds and focus. */
  private rendered: InspectorStep | undefined;

  constructor(root: HTMLElement, context: InspectorContext) {
    this.root = root;
    this.context = context;
    root.classList.add('inspector-body');
  }

  update(step: InspectorStep, force = false): void {
    const same =
      this.rendered?.events === step.events &&
      this.rendered.cursor === step.cursor &&
      this.rendered.selection?.key === step.selection?.key &&
      this.rendered.selection?.value === step.selection?.value;
    if (!force && same) return;
    this.rendered = { ...step };
    const active = document.activeElement;
    const restore =
      active instanceof HTMLElement && this.root.contains(active)
        ? (active.closest<HTMLElement>('[data-focus]')?.dataset['focus'] ?? 'tab')
        : undefined;
    this.build(step);
    if (restore !== undefined) {
      const target =
        this.root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(restore)}"]`) ??
        this.root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
        this.root.querySelector<HTMLElement>('[role="tabpanel"]');
      target?.focus({ preventScroll: true });
    }
  }

  private build(step: InspectorStep): void {
    const event = step.events[step.cursor - 1];
    if (!event) {
      this.root.replaceChildren();
      return;
    }
    const panels = new Map<TabId, () => Node[]>();
    if (event.payload !== undefined && event.payload !== null)
      panels.set('payload', () => this.payload(event, step));
    if (event.http) panels.set('transport', () => this.transport(step));
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
    // Reachable by keyboard even when it holds nothing focusable (Security, Lineage).
    panel.tabIndex = 0;
    focusKey(panel, 'panel');
    for (const id of available) {
      const tab = focusKey(el('button', 'tab', TAB_LABELS[id]), `tab:${id}`);
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
    // From 48rem the toggle is not shown and the tabs always are (src/styles/inspector.css).
    const details = el('div', 'inspector-details', tablist, panel);
    details.id = 'inspector-details';
    const toggle = focusKey(el('button', 'details-toggle', 'Step details'), 'details-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', details.id);
    const fold = (): void => {
      toggle.setAttribute('aria-expanded', String(!this.collapsed));
      details.toggleAttribute('data-collapsed', this.collapsed);
    };
    fold();
    toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      fold();
    });
    this.root.replaceChildren(...message, toggle, details);
  }

  private choose(id: TabId, step: InspectorStep, focus = false): void {
    this.chosen = id;
    this.update(step, true);
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
    const error = errorLine(event, this.context.errorTaxonomy);
    return [
      el('p', 'message', event.explanation),
      el('p', 'small muted', `${from} → ${to} · ${operationLabel(event)}`),
      ...(error
        ? [
            el(
              'p',
              'error-line small',
              el('span', 'error-kind', error.label),
              ...(error.definition ? [`. ${error.definition}`] : []),
            ),
          ]
        : []),
    ];
  }

  private notes(event: ScenarioEvent): Node[] {
    if (!event.technical_notes?.length) return [];
    return [el('ul', 'notes small', ...event.technical_notes.map((n) => el('li', undefined, n)))];
  }

  private stepLink(step: number, text: string, key: string): HTMLButtonElement {
    const b = focusKey(el('button', 'link', text), key);
    b.type = 'button';
    b.addEventListener('click', () => this.context.jump(step));
    return b;
  }

  private payload(event: ScenarioEvent, step: InspectorStep): Node[] {
    const tools = el('div', 'panel-tools');
    if (event.pair_id) {
      const pair = step.events.findIndex((e) => e.id === event.pair_id);
      if (pair >= 0) {
        const kind = event.message_type === 'RESPONSE' ? 'Request' : 'Response';
        tools.append(this.stepLink(pair + 1, `${kind}: step ${pair + 1}`, 'pair'));
      }
    }
    const status = el('span', 'small muted');
    status.setAttribute('role', 'status');
    const copy = focusKey(el('button', undefined, 'Copy'), 'copy');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      const text = JSON.stringify(event.payload, null, 2);
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard) {
        status.textContent = 'Copy failed';
        return;
      }
      clipboard.writeText(text).then(
        () => (status.textContent = 'Copied'),
        () => (status.textContent = 'Copy failed'),
      );
    });
    tools.append(status, copy);
    let changed = new Set<string>();
    if (event.protocol === 'LLM_API' && event.message_type === 'REQUEST') {
      const before = step.events
        .slice(0, step.cursor - 1)
        .filter((e) => e.protocol === 'LLM_API' && e.message_type === 'REQUEST')
        .pop();
      changed = newInRequest(event.payload, before?.payload);
    }
    const tree = jsonTree(event.payload as Json, {
      ...(event.protocol === 'MCP' ? { fold: mcpBoilerplate } : {}),
      changed,
      // With a selection only its fields are highlighted (02 lineage_selection.payload).
      tracked: step.selection
        ? new Set(
            trackedValues(event.tracked_values).has(step.selection.value)
              ? [step.selection.value]
              : [],
          )
        : trackedValues(event.tracked_values),
    });
    const earlier =
      offersEarlierRevision(event) && this.context.earlierRevision
        ? [this.earlierRevision(this.context.earlierRevision)]
        : [];
    return [tools, el('div', 'json', renderTree(tree)), ...this.notes(event), ...earlier];
  }

  /** The initialize handshake of an earlier revision, collapsed (02 inspector.earlier_revision). */
  private earlierRevision(earlier: EarlierRevision): HTMLElement {
    const details = el('details', 'json-fold earlier');
    details.append(
      focusKey(
        el(
          'summary',
          'small',
          'Compare with the initialize handshake of revision ',
          // The revision date never breaks at its hyphens.
          el('span', 'nowrap', earlier.revision),
        ),
        'earlier',
      ),
      el('p', 'small', earlier.summary),
      ...earlier.messages.map((m) => this.earlierMessage(m, earlier.revision)),
    );
    return details;
  }

  private earlierMessage(m: EarlierMessage, revision: string): HTMLElement {
    const from = this.context.labels[m.sender] ?? m.sender;
    const to = this.context.labels[m.receiver] ?? m.receiver;
    // A JSON-RPC body makes it an MCP message; a bare response is plain HTTP.
    const operation = operationLabel({
      protocol: m.payload === null ? 'HTTP' : 'MCP',
      operation: m.operation,
    });
    const body =
      m.payload === null
        ? el('p', 'small muted', 'No body')
        : el('div', 'json', renderTree(jsonTree(m.payload, { fold: mcpBoilerplate })));
    return el(
      'div',
      'earlier-message',
      el('p', 'small muted', `Revision ${revision} · ${from} → ${to} · ${operation}`),
      el('p', 'code-line', startLine(m.http)),
      el('div', 'json', ...Object.entries(m.http.headers ?? {}).map(headerLine)),
      body,
    );
  }

  private transport(step: InspectorStep): Node[] {
    const lines = transportLines(step.events, step.cursor);
    if (!lines) return [];
    const list = el('div', 'json', ...lines.shown.map(headerLine));
    if (lines.folded.length) {
      const fold = el('details', 'json-fold');
      const label =
        lines.folded.length === 1
          ? '1 header unchanged'
          : `${lines.folded.length} headers unchanged`;
      fold.append(
        focusKey(el('summary', 'json-punct', label), 'fold:headers'),
        ...lines.folded.map(headerLine),
      );
      list.append(fold);
    }
    return [
      el('p', 'small muted', 'Simulated exchange: nothing is sent over a network.'),
      el('p', 'code-line', lines.start),
      list,
    ];
  }

  private security(event: ScenarioEvent): Node[] {
    return (event.security_boundaries ?? []).map((id) => {
      const b = this.context.boundaries.find((x) => x.id === id);
      return el(
        'div',
        'boundary',
        el('p', 'boundary-id', id),
        el('p', undefined, el('span', 'muted', 'Risk: '), b?.risk ?? ''),
        el('p', undefined, el('span', 'muted', 'Mitigation: '), b?.mitigation ?? ''),
      );
    });
  }

  /**
   * Each tracked key once, its values with the steps where they occurred up to this one,
   * and a toggle that selects the value (02 inspector.lineage_tab, lineage_selection).
   */
  private lineage(event: ScenarioEvent, step: InspectorStep): Node[] {
    return Object.entries(event.tracked_values ?? {}).map(([key, value]) => {
      const values = (Array.isArray(value) ? value : [value]).filter(
        (v): v is string | number => typeof v === 'string' || typeof v === 'number',
      );
      const items = values.map((v, i) => {
        // Steps after the current one are not revealed.
        const earlier = occurrences(step.events, { key, value: v }).filter(
          (k) => k < step.cursor - 1,
        );
        const where: (Node | string)[] = [];
        if (!earlier.length) where.push(el('span', 'muted', 'first here'));
        // At most five later steps by number; selecting the value marks them all.
        const LATER = 5;
        earlier.slice(0, LATER + 1).forEach((k, n) => {
          if (n === 1) where.push(el('span', 'muted', '; also '));
          else if (n > 1) where.push(', ');
          const link = this.stepLink(
            k + 1,
            n === 0 ? `first at step ${k + 1}` : `${k + 1}`,
            `lineage:${key}:${i}:${n}`,
          );
          if (n > 0) link.setAttribute('aria-label', `step ${k + 1}`);
          where.push(link);
        });
        const more = earlier.length - (LATER + 1);
        if (more > 0) where.push(el('span', 'muted', ` and ${more} more`));
        const selected = step.selection?.key === key && step.selection.value === v;
        const toggle = focusKey(
          el('button', 'select-value', selected ? 'Selected' : 'Select'),
          `select:${key}:${i}`,
        );
        toggle.type = 'button';
        toggle.setAttribute('aria-pressed', String(selected));
        // A stable name; aria-pressed carries the state.
        toggle.setAttribute('aria-label', `Select ${key} ${JSON.stringify(v)}`);
        toggle.addEventListener('click', () =>
          this.context.select(selected ? undefined : { key, value: v }),
        );
        return el(
          'li',
          undefined,
          el('span', 'json-value json-mark', JSON.stringify(v)),
          ' ',
          ...where,
          ' ',
          toggle,
        );
      });
      return el(
        'div',
        'lineage-row',
        el('span', 'json-key', key),
        el('ul', 'lineage-values', ...items),
      );
    });
  }
}
