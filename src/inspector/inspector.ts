/**
 * Event inspector (02-ui-ux.yaml inspector): the step's message and what it carries first,
 * then tabs for the payload (with its annotations), the simulated transport envelope and the
 * security boundaries. A tab is shown only when the step has content for it. The inspector is
 * rebuilt only when the step changes, and focus stays on the equivalent control.
 */
import { operationLabel } from '../diagram/model.ts';
import {
  type JsonLine,
  parsePath,
  resolvePath,
  type SplitGroup,
  splitPayload,
} from '../scenarios/annotations.ts';
import type {
  EarlierMessage,
  EarlierRevision,
  HttpEnvelope,
  Json,
  ScenarioEvent,
} from '../scenarios/types.ts';
import { type Travel, travel, valueLabel } from './annotated.ts';
import { jsonTree, mcpBoilerplate, newInRequest, type TreeNode, trackedValues } from './json.ts';

export type TabId = 'payload' | 'transport' | 'security';
const TAB_LABELS: Record<TabId, string> = {
  payload: 'Payload',
  transport: 'Transport',
  security: 'Security',
};
const ORDER: TabId[] = ['payload', 'transport', 'security'];
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
  /** 04-mcp-scenarios.yaml protocol.earlier_revision_handshake, for server/discover. */
  earlierRevision?: EarlierRevision | undefined;
}

/** Whether a step offers the earlier-revision comparison (02 inspector.earlier_revision). */
export function offersEarlierRevision(event: ScenarioEvent): boolean {
  return (
    event.protocol === 'MCP' &&
    event.message_type === 'REQUEST' &&
    event.operation === 'server/discover'
  );
}

/** What the inspector shows for one cursor position. */
export interface InspectorStep {
  events: readonly ScenarioEvent[];
  cursor: number;
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

/** A JSON path of an annotation as segments (the paths were checked by splitPayload). */
function pathOf(path: string): string[] {
  return parsePath(path) ?? [];
}

/** One line of an annotated payload: indented by depth, marked as in the closed payload. */
function annotatedLine(
  line: JsonLine,
  changed: ReadonlySet<string>,
  tracked: ReadonlySet<string | number>,
): HTMLElement {
  const dotted = line.segments.join('.');
  const isChanged = [...changed].some((p) => dotted === p || dotted.startsWith(`${p}.`));
  const key =
    line.key === undefined
      ? []
      : [el('span', 'json-key', JSON.stringify(line.key)), el('span', 'json-punct', ': ')];
  const comma = line.comma ? [el('span', 'json-punct', ',')] : [];
  let text: Node[] = [el('span', 'json-punct', line.text)];
  if (line.kind === 'leaf' && !/^[[{]/.test(line.text)) {
    const value = JSON.parse(line.text) as Json;
    const mark =
      !isChanged && (typeof value === 'string' || typeof value === 'number') && tracked.has(value);
    text = [el('span', `json-value${mark ? ' json-mark' : ''}`, line.text)];
    if (typeof value === 'string' && REDACTED.test(value))
      text.push(el('span', 'json-label', ' redacted'));
  }
  const node = el('div', `json-line${isChanged ? ' json-mark' : ''}`, ...key, ...text, ...comma);
  node.dataset['depth'] = String(line.depth);
  node.style.setProperty('--depth', String(line.depth));
  return node;
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
  /** The Annotations toggle (02 inspector.annotations.toggle): closed at start, kept while stepping. */
  private annotated = false;
  /** The step last rendered, so unrelated player changes keep folds and focus. */
  private rendered: InspectorStep | undefined;

  constructor(root: HTMLElement, context: InspectorContext) {
    this.root = root;
    this.context = context;
    root.classList.add('inspector-body');
  }

  update(step: InspectorStep, force = false): void {
    const same = this.rendered?.events === step.events && this.rendered.cursor === step.cursor;
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
    // Reachable by keyboard even when it holds nothing focusable (Security).
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
    // What the message carries, under its explanation (02 inspector.carries). Not a <p>, so
    // the phone's stepping area still ends at the message line.
    const carries = event.carries?.length
      ? [
          el(
            'div',
            'carries',
            el('span', 'small muted', 'It carries'),
            el('ul', undefined, ...event.carries.map((c) => el('li', undefined, c))),
          ),
        ]
      : [];
    return [
      el('p', 'message', event.explanation),
      el('p', 'small muted', `${from} → ${to} · ${operationLabel(event)}`),
      ...carries,
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
    const split = splitPayload(event.payload, event.annotations);
    const block = 'inspector-json';
    if (split) {
      const toggle = focusKey(el('button', 'annotations-toggle', 'Annotations'), 'annotations');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(this.annotated));
      toggle.setAttribute('aria-controls', block);
      toggle.addEventListener('click', () => {
        this.annotated = !this.annotated;
        this.update(step, true);
      });
      tools.append(toggle);
    }
    tools.append(status, copy);
    let changed = new Set<string>();
    if (event.protocol === 'LLM_API' && event.message_type === 'REQUEST') {
      const before = step.events
        .slice(0, step.cursor - 1)
        .filter((e) => e.protocol === 'LLM_API' && e.message_type === 'REQUEST')
        .pop();
      changed = newInRequest(event.payload, before?.payload);
    }
    const tracked = trackedValues(event.tracked_values);
    const earlier =
      offersEarlierRevision(event) && this.context.earlierRevision
        ? [this.earlierRevision(this.context.earlierRevision)]
        : [];
    let body: HTMLElement;
    if (split && this.annotated) {
      body = el(
        'div',
        'annotated',
        ...split.flatMap((g, i) => this.annotationGroup(g, i, step, changed, tracked)),
      );
    } else {
      const tree = jsonTree(event.payload as Json, {
        ...(event.protocol === 'MCP' ? { fold: mcpBoilerplate } : {}),
        changed,
        tracked,
      });
      body = el('div', 'json', renderTree(tree));
    }
    body.id = block;
    return [tools, body, ...this.notes(event), ...earlier];
  }

  /**
   * One annotation group: its JSON lines as in the payload, then its callout with heading,
   * sentence and one bullet per value (02 inspector.annotations.open).
   */
  private annotationGroup(
    group: SplitGroup,
    index: number,
    step: InspectorStep,
    changed: ReadonlySet<string>,
    tracked: ReadonlySet<string | number>,
  ): HTMLElement[] {
    const event = step.events[step.cursor - 1];
    const lines = el(
      'div',
      'json',
      ...group.lines.map((line) => annotatedLine(line, changed, tracked)),
    );
    const bullets = Object.entries(group.annotation.values ?? {}).map(([path, meaning], n) => {
      const found = resolvePath(event?.payload ?? null, pathOf(path));
      const value = found?.value ?? null;
      const item = el(
        'li',
        undefined,
        el('code', 'annotation-value', valueLabel(value)),
        ` – ${meaning}`,
      );
      const where = travel(step.events, step.cursor - 1, value);
      if (where) item.append(this.travelLine(where, step.cursor - 1, step, `${index}:${n}`));
      return item;
    });
    const callout = el(
      'div',
      'annotation',
      el('h3', 'annotation-heading', group.annotation.heading),
      el('p', undefined, group.annotation.sentence),
      ...(bullets.length ? [el('ul', 'annotation-values', ...bullets)] : []),
    );
    return [lines, callout];
  }

  /**
   * "First seen at step k (A → B) · sent to C at step t · reaches the model at step m"
   * (02 inspector.annotations.travel).
   */
  private travelLine(
    where: Travel,
    current: number,
    step: InspectorStep,
    key: string,
  ): HTMLElement {
    const line = el('span', 'travel small');
    const at = (i: number, what: string): (Node | string)[] =>
      i === current
        ? ['here']
        : ['at ', this.stepLink(i + 1, `step ${i + 1}`, `travel:${key}:${what}`)];
    line.append('First seen ', ...at(where.first, 'first'));
    // Registry labels without their parenthetical: "Agent", not "Agent (host application …)".
    const short = (id: string): string => (this.context.labels[id] ?? id).replace(/ \(.*\)$/, '');
    const first = step.events[where.first];
    if (first && where.first !== current) {
      const from = short(first.sender);
      line.append(
        ` (${first.sender === first.receiver ? from : `${from} → ${short(first.receiver)}`})`,
      );
    }
    const later: [number, string, string][] = [];
    if (where.model !== undefined) later.push([where.model, 'reaches the model', 'model']);
    const tool = where.tool === undefined ? undefined : step.events[where.tool];
    if (where.tool !== undefined && tool)
      later.push([where.tool, `sent to ${short(tool.receiver)}`, 'tool']);
    for (const [i, what, id] of later.sort((a, b) => a[0] - b[0]))
      line.append(` · ${what} `, ...at(i, id));
    return line;
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
}
