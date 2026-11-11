/**
 * App shell (02-ui-ux.yaml navigation, layout, controls, learning, zoom_levels): one quiet frame
 * with tabs, the scenario picker, the learning question, the control row (zoom control, playback
 * buttons, play speed and step timeline), and the diagram beside the step's message.
 */
import { Player } from '../engine/player.ts';
import { ControlRow } from './controls.ts';
import {
  type Level,
  stageAt,
  stageSpans,
  stageStops,
  type StageSpan,
  zoomCursor,
  zoomed,
} from '../diagram/zoom.ts';
import { contextModel, hasContext, renderContext } from '../inspector/context.ts';
import { combinedPanel } from './combined.ts';
import {
  IngestionPanel,
  ingestionModel,
  type SourceDocument,
  sourceDocuments,
} from '../inspector/ingestion.ts';
import { type Boundary, Inspector, occurrences, type Selection } from '../inspector/inspector.ts';
import {
  projection,
  RetrievalPanel,
  retrievalModel,
  type SearchedIndex,
  thresholdLabel,
} from '../inspector/retrieval.ts';
import { DiagramView } from '../diagram/view.ts';
import { loadRegistry, participantLabels, specSources } from '../scenarios/registry.ts';
import { createPlayback, ragDerivation } from '../rag/bundled.ts';
import type { Chunk, RagFixtures } from '../rag/engine.ts';
import type { Json, ParameterSpec, Scenario, ScenarioEvent } from '../scenarios/types.ts';
import { fromDefaultStep, toDefaultStep } from '../engine/steps.ts';
import {
  formatRoute,
  parseRoute,
  type Route,
  TAB_LABELS,
  TABS,
  type Tab,
  tabScenarios,
} from './routes.ts';
import { offlineIndicator } from './offline.ts';
import { isPhone, PageScroll, relocate } from './phone.ts';
import { CompareView } from '../compare/view.ts';
import { appUrl } from '../base.ts';
import '../styles/diagram.css';
import '../styles/shell.css';
import '../styles/inspector.css';
import '../styles/ingestion.css';
import '../styles/retrieval.css';
import '../styles/phone.css';

const SIMULATED = 'Everything here is simulated. Nothing leaves your browser.';
/** The approved wordmark for the light paper (02 layout brand); the app is light only. */
const WORDMARK = 'brand/agentscope-silver-light.svg';

/** A parameter control (02 rag_controls.control_kinds). */
type ParameterControl =
  /** One pressed button per value: the parameter's options, else min to max. */
  | { kind: 'options'; name: string; label: string; unit: string }
  /** A slider from min to max with its value beside it. */
  | { kind: 'range'; name: string; label: string; step: number }
  /** A toggle button, pressed when on. */
  | { kind: 'toggle'; name: string; label: string };

/**
 * Parameters offered as controls, with their labels (02 rag_controls); a scenario offers
 * those it has. Parameters are not part of the route.
 */
const PARAMETER_CONTROLS: readonly ParameterControl[] = [
  { kind: 'options', name: 'chunk_size_words', label: 'Chunk size', unit: 'words' },
  { kind: 'options', name: 'overlap_words', label: 'Overlap', unit: 'words' },
  { kind: 'options', name: 'top_k', label: 'Top K', unit: 'chunks' },
  // 02 rag_controls.similarity_threshold.step
  { kind: 'range', name: 'similarity_threshold', label: 'Threshold', step: 0.01 },
  { kind: 'toggle', name: 'rerank', label: 'Reranking' },
  { kind: 'toggle', name: 'keyword_retrieval', label: 'Keyword retrieval' },
  { kind: 'toggle', name: 'fetch_full_documents', label: 'Fetch full documents' },
];

/** The values an option control offers: the parameter's options, else min to max. */
function optionValues(spec: ParameterSpec | undefined): Json[] {
  if (!spec) return [];
  if (spec.options) return spec.options;
  const { min, max } = spec;
  if (min === undefined || max === undefined || !Number.isInteger(spec.default)) return [];
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

/** The principle that the demo embedding stands in for a learned model (05 principles). */
function embeddingNote(principles: Json | undefined): string {
  const all = Array.isArray(principles) ? principles.map(String) : [];
  const note = all.find((p) => p.startsWith('The demo embedding')) ?? '';
  // Principles are written as list items without a closing period; here it is a sentence.
  return note && !note.endsWith('.') ? `${note}.` : note;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function button(
  label: string,
  onClick: () => void,
  props: Partial<Record<string, string>> = {},
): HTMLButtonElement {
  const b = el('button', { type: 'button', ...props }, label);
  b.addEventListener('click', onClick);
  return b;
}

/** The keys that zoom in (+, and = for + without Shift) and out (02 controls.keyboard). */
const ZOOM_KEYS = new Map<string, 1 | -1>([
  ['+', 1],
  ['=', 1],
  ['-', -1],
]);

/** Whether the focused element needs this key for itself (02 controls.keyboard_scope). */
function keyBelongsToFocus(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('textarea, select, [contenteditable="true"]')) return true;
  if (key === ' ') {
    // Space activates buttons, links and menus and types into text fields.
    return !!target.closest('button, a, summary, [role="button"], input:not([type="range"])');
  }
  // + and - type into text fields; elsewhere they zoom (02 controls.keyboard_scope).
  if (ZOOM_KEYS.has(key)) return !!target.closest('input:not([type="range"])');
  // The arrow keys move text cursors, the step slider and the splitter, and scroll the
  // diagram region; a focused group inside the region leaves them to stepping.
  return (
    !!target.closest('input, [role="separator"], [role="tab"]') ||
    target.matches('.diagram-scroller')
  );
}

/** Decodes percent-encoding for display; text is inserted with textContent only. */
function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

interface ScenarioView {
  scenario: Scenario;
  /** The events played at the default parameters, which number the route's steps. */
  defaults: readonly ScenarioEvent[];
  player: Player;
  view: DiagramView;
  row: ControlRow;
  /** Index of the event whose prediction prompt is showing, if any. */
  prompt: number | undefined;
  /** The selected lineage value; cleared when the scenario changes. */
  selection: Selection | undefined;
  render: () => void;
  dispose: () => void;
}

export class Shell {
  private readonly registry = loadRegistry();
  private readonly sources = specSources();
  private readonly labels = participantLabels();
  private readonly tabs = tabScenarios(this.sources);
  private readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly content: HTMLElement;
  private current: ScenarioView | undefined;
  /** The Compare view while the Compare tab shows (02 compare_view). */
  private compare: CompareView | undefined;
  /** Removes the document listeners of the current header. */
  private headerListeners: AbortController | undefined;
  /** The header's menu on phones (02 layout.phone.header). */
  private menu: { toggle: HTMLButtonElement; body: HTMLElement } | undefined;
  /** Whether a page has been shown; the first one does not take focus. */
  private shown = false;
  private route: Route | undefined;
  /** True while a parameter changes, which never scrolls the page (02 layout.phone.stepping_area). */
  private adjusting = false;
  /** Tells the learner's own scrolling from the app's jumps. */
  private readonly pageScroll = new PageScroll();

  constructor(root: HTMLElement) {
    this.root = root;
    root.className = 'shell';
    this.header = el('header', { class: 'shell-header' });
    this.content = el('div', { class: 'shell-content' });
    root.replaceChildren(this.header, this.content);
    window.addEventListener('keydown', this.onKey);
  }

  destroy(): void {
    this.leaveScenario();
    window.removeEventListener('keydown', this.onKey);
    this.pageScroll.destroy();
    this.headerListeners?.abort();
    this.root.replaceChildren();
    this.root.className = '';
  }

  /** Shows the page for a location hash. */
  show(hash: string): void {
    // When the focused element is replaced by the new page (a header link, a link in the
    // page, Back), focus moves to the new page's heading instead of the document.
    const active = document.activeElement;
    this.render(hash);
    const lost = !active || active === document.body || !active.isConnected;
    if (this.shown && lost) {
      this.content
        .querySelector<HTMLElement>('h2, [role="alert"] a')
        ?.focus({ preventScroll: true });
    }
    this.shown = true;
  }

  private render(hash: string): void {
    const parsed = parseRoute(hash, this.tabs);
    const tab = parsed.ok ? parsed.route.tab : parsed.tab;
    if (!parsed.ok) {
      this.leaveScenario();
      this.renderHeader(tab, undefined);
      const link = el('a', { href: `#/${tab}` }, `Go to ${TAB_LABELS[tab]}`);
      this.content.replaceChildren(
        el('p', { class: 'error', role: 'alert' }, `× ${decode(parsed.message)}. `, link),
      );
      this.route = undefined;
      return;
    }
    const route = parsed.route;
    if (route.tab === 'compare') {
      if (this.compare) this.compare.follow(route.step, route.level);
      else this.renderCompare(route);
      return;
    }
    const scenario = this.registry[route.scenario];
    if (!scenario) return;
    if (this.current?.scenario.id === scenario.id) {
      // Same scenario: follow the step and level in the link.
      const c = this.current;
      c.player.jump(fromDefaultStep(c.defaults, c.player.playback.events, route.step));
      this.setLevel(c, route.level);
      // The Overview rests at the end of the stage (02 zoom_levels.cursor_mapping).
      c.player.jump(zoomCursor(this.spans(c), c.player.cursor, 'protocol', route.level));
      this.current.prompt = undefined;
      this.route = {
        ...route,
        step: toDefaultStep(c.defaults, c.player.playback.events, c.player.cursor),
      };
      this.current.render();
      return;
    }
    this.leaveScenario();
    this.route = route;
    this.renderHeader(route.tab, scenario);
    this.current = this.renderScenario(scenario, route);
    // Write the defaults into the address, now that the view exists.
    this.current.render();
  }

  private leaveScenario(): void {
    this.current?.dispose();
    this.current = undefined;
    this.compare?.dispose();
    this.compare = undefined;
  }

  /** Writes the current position into the address without adding a history entry. */
  private syncUrl(): void {
    const c = this.current;
    if (!c || !this.route) return;
    // The address numbers steps as played at the defaults (02 navigation.route_steps).
    const step = toDefaultStep(c.defaults, c.player.playback.events, c.player.cursor);
    this.route = { ...this.route, step, level: c.view.level };
    const hash = formatRoute(this.route);
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  private renderHeader(tab: Tab, scenario: Scenario | undefined): void {
    this.headerListeners?.abort();
    this.headerListeners = new AbortController();
    const nav = el(
      'nav',
      { class: 'tabs', 'aria-label': 'Modules' },
      ...TABS.map((t) =>
        el('a', { href: `#/${t}`, 'aria-current': t === tab ? 'page' : undefined }, TAB_LABELS[t]),
      ),
    );
    const wordmark = el('img', {
      src: appUrl(WORDMARK),
      alt: 'AgentScope',
      width: '340',
      height: '88',
    });
    const brand = el('h1', { class: 'brand' }, el('a', { href: '#/' }, wordmark));
    const row = el('div', { class: 'shell-bar' }, brand, nav);
    this.menu = this.phoneMenu(row);
    if (scenario && this.tabs[tab].length > 1) {
      const picker = this.picker(tab, scenario);
      row.append(picker);
      // On phones the picker's own list moves into the menu, shown in place.
      const list = picker.querySelector('ul');
      if (list) {
        list.classList.add('menu-scenarios');
        this.toMenu('Scenario', [list]).classList.add('menu-row--scenarios');
      }
    }
    this.header.replaceChildren(
      row,
      el('p', { class: 'small muted simulated' }, SIMULATED, offlineIndicator()),
    );
  }

  /**
   * The menu that holds the scenario picker, the zoom control and the play speed on
   * phones (02 layout.phone.header); hidden from 48rem, where they sit in their own places.
   * It is shown once something is in it.
   */
  private phoneMenu(row: HTMLElement): { toggle: HTMLButtonElement; body: HTMLElement } {
    const signal = (this.headerListeners ??= new AbortController()).signal;
    const body = el('div', { id: 'menu', class: 'menu-body', hidden: '' });
    const toggle = button(
      'Menu',
      () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(open));
        body.hidden = !open;
      },
      { class: 'menu-toggle', 'aria-expanded': 'false', 'aria-controls': 'menu', hidden: '' },
    );
    const close = (focus: boolean): void => {
      toggle.setAttribute('aria-expanded', 'false');
      body.hidden = true;
      if (focus) toggle.focus();
    };
    // A scenario choice closes it; so does a change of level, with focus back on the menu.
    body.addEventListener('click', (e) => {
      const target = e.target as Element;
      if (target.closest('a')) close(false);
      else if (target.closest('[data-level]')) close(true);
    });
    // Escape anywhere on the page closes the open menu, and does nothing else (it does not
    // clear a lineage selection: the window's key handler skips a handled event).
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || body.hidden) return;
        e.preventDefault();
        close(true);
      },
      { signal },
    );
    document.addEventListener(
      'pointerdown',
      (e) => {
        const target = e.target as Node;
        if (!body.hidden && !body.contains(target) && !toggle.contains(target)) close(false);
      },
      { signal },
    );
    row.append(toggle, body);
    return { toggle, body };
  }

  /** A labelled row of the menu. */
  private menuRow(label: string | undefined, ...children: Node[]): HTMLElement {
    return el(
      'div',
      { class: 'menu-row' },
      ...(label ? [el('span', { class: 'small muted' }, label)] : []),
      ...children,
    );
  }

  /**
   * Puts a control into the menu while the phone layout applies (02 layout.phone.header);
   * `parent` is where it sits otherwise. The control moves; it is never copied.
   */
  private toMenu(label: string | undefined, nodes: Element[], parent?: Element): HTMLElement {
    const row = this.menuRow(label);
    if (!this.menu) return row;
    parent?.append(...nodes);
    // The scenario list, the longest, comes last.
    this.menu.body.insertBefore(row, this.menu.body.querySelector('.menu-row--scenarios'));
    this.menu.toggle.hidden = false;
    relocate(nodes, row, (this.headerListeners ??= new AbortController()).signal);
    return row;
  }

  private picker(tab: Tab, scenario: Scenario): HTMLElement {
    const items = this.tabs[tab].map((id) =>
      el(
        'li',
        {},
        el(
          'a',
          { href: `#/${tab}/${id}/0`, 'aria-current': id === scenario.id ? 'true' : undefined },
          this.registry[id]?.title ?? id,
        ),
      ),
    );
    const details = el(
      'details',
      { class: 'picker' },
      el('summary', {}, el('span', { class: 'muted' }, 'Scenario: '), scenario.title),
      el('ul', {}, ...items),
    );
    // Close the menu once a scenario is chosen, on Escape and on a click elsewhere.
    details.addEventListener('click', (e) => {
      if ((e.target as Element).closest('a')) details.open = false;
    });
    details.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !details.open) return;
      // Closing the menu is all this Escape does; it does not clear a lineage selection.
      e.preventDefault();
      details.open = false;
      details.querySelector('summary')?.focus();
    });
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (details.open && !details.contains(e.target as Node)) details.open = false;
      },
      { signal: (this.headerListeners ??= new AbortController()).signal },
    );
    return details;
  }

  /** The stages of the scenario with the spans of their events as played now. */
  private spans(c: ScenarioView): StageSpan[] {
    return stageSpans(c.scenario.overview, c.player.playback.events);
  }

  /**
   * Sets the zoom level of the diagram, the control and the stepping: the Overview steps stage
   * by stage (02 zoom_levels.stepping). The caller moves the cursor.
   */
  private setLevel(c: ScenarioView, level: Level): void {
    c.view.setLevel(level);
    c.row.setLevel(level);
    c.player.setStops(level === 'overview' ? () => stageStops(this.spans(c)) : undefined);
  }

  /**
   * Zooms to a level, keeping the learner's place (02 zoom_levels.cursor_mapping), and announces
   * the level and the position (zoom_levels.control).
   */
  private zoom(level: Level): void {
    const c = this.current;
    if (!c || level === c.view.level) return;
    const from = c.view.level;
    this.act(() => {
      c.prompt = undefined;
      const target = zoomCursor(this.spans(c), c.player.cursor, from, level);
      this.setLevel(c, level);
      c.player.jump(target);
      c.render();
      c.row.announce(level, c.row.status.textContent ?? '');
      keepFocusVisible(c.row);
    });
  }

  /** The Compare tab: both scenarios side by side, in sync by semantic phase. */
  private renderCompare(route: Route): void {
    this.leaveScenario();
    this.renderHeader(route.tab, undefined);
    const { compare, semantic_phases } = this.sources.comparison;
    const pane = (id: string) => {
      const tab = TABS.find((t) => t !== 'compare' && this.tabs[t].includes(id)) ?? 'mcp';
      return { scenario: this.registry[id] as Scenario, label: TAB_LABELS[tab], tab };
    };
    this.compare = new CompareView(this.content, {
      pageScroll: this.pageScroll,
      compare,
      phases: semantic_phases,
      panes: [pane(compare.left_scenario), pane(compare.right_scenario)],
      labels: this.labels,
      step: route.step,
      level: route.level,
      onChange: (step, level) => {
        this.route = { ...route, step, level };
        const hash = formatRoute(this.route);
        if (location.hash !== hash) history.replaceState(null, '', hash);
      },
    });
    this.toPhoneControls(this.compare.controls);
  }

  /**
   * On phones the playback buttons become the bottom bar with the position line and the step
   * slider, and the zoom control and the play speed move into the menu (02 layout.phone.controls).
   */
  private toPhoneControls(row: ControlRow): void {
    const signal = (this.headerListeners ??= new AbortController()).signal;
    relocate([row.status, row.slider], row.buttons, signal);
    this.toMenu('Zoom', [row.zoom]);
    this.toMenu(undefined, [row.speed]);
  }

  private renderScenario(scenario: Scenario, route: Route): ScenarioView {
    const player = new Player(createPlayback(scenario));
    player.jump(route.step);

    // The headline names the mechanism, so it is shown from Architecture on; the Overview names
    // no protocol (02 zoom_levels.overview).
    const headline = el('p', { class: 'headline' }, scenario.headline);
    const lesson = el(
      'section',
      { class: 'lesson' },
      el('h2', { tabindex: '-1' }, scenario.learning_question),
      headline,
    );
    // The control row (02 controls.row): the buttons, the play speed and the timeline.
    const row = new ControlRow({
      name: 'Playback',
      sliderName: 'Step',
      statusClass: '',
      reset: () => this.go(() => player.reset()),
      previous: () => this.go(() => player.previous()),
      toggle: () => this.act(() => player.toggle()),
      next: () => this.next(),
      speed: (speed) => player.setSpeed(speed),
      // At the Overview the slider runs over the stages (02 zoom_levels.stepping).
      jump: (step) =>
        this.go(() =>
          player.jump(view.level === 'overview' ? (this.stops(state)[step] ?? 0) : step),
        ),
      zoom: (level) => this.zoom(level),
    });
    const { slider, buttons: controls } = row;
    const steps = player.playback.length;
    row.reserve(scenario.phases.map((p) => `Step ${steps} of ${steps} · ${p.label}`));

    const parameterButtons: HTMLButtonElement[] = [];
    const sliders: { input: HTMLInputElement; output: HTMLOutputElement; name: string }[] = [];
    const offered = PARAMETER_CONTROLS.filter((c) => scenario.parameters?.[c.name]);
    const parameters = el('div', {
      class: 'parameters',
      role: 'group',
      'aria-label': 'Parameters',
    });
    for (const control of offered) {
      const { name, label } = control;
      const spec = scenario.parameters?.[name];
      if (control.kind === 'toggle') {
        const b = button(label, () =>
          this.setParameter(name, player.playback.retrievalConfig[name] !== true),
        );
        b.dataset['parameter'] = name;
        b.dataset['value'] = 'true';
        parameterButtons.push(b);
        parameters.append(el('span', { class: 'parameter' }, b));
        continue;
      }
      if (control.kind === 'range') {
        const id = `parameter-${name}`;
        const input = el('input', {
          id,
          type: 'range',
          min: String(spec?.min ?? 0),
          max: String(spec?.max ?? 1),
          step: String(control.step),
          class: 'parameter-range',
        });
        const output = el('output', { for: id, class: 'small parameter-value' });
        input.addEventListener('input', () => {
          const value = Number(input.value);
          if (Number.isFinite(value)) this.setParameter(name, value);
        });
        sliders.push({ input, output, name });
        parameters.append(
          el(
            'span',
            { class: 'parameter' },
            el('label', { for: id, class: 'small muted' }, label),
            input,
            output,
          ),
        );
        continue;
      }
      const { unit } = control;
      const group = el('div', {
        class: 'segmented',
        role: 'group',
        'aria-label': `${label} in ${unit}`,
      });
      for (const value of optionValues(spec)) {
        const b = button(String(value), () => this.setParameter(name, value), {
          'aria-label': `${label} ${String(value)} ${unit}`,
        });
        b.dataset['parameter'] = name;
        b.dataset['value'] = JSON.stringify(value);
        parameterButtons.push(b);
        group.append(b);
      }
      parameters.append(
        el('span', { class: 'parameter' }, el('span', { class: 'small muted' }, label), group),
      );
    }

    // DiagramView names the region and states how it scrolls.
    const diagram = el('div', { class: 'diagram-pane', role: 'region' });
    const splitter = el('div', {
      class: 'splitter',
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize the inspector',
    });
    // The prompt slot announces a prediction once; the message slot is quiet.
    const promptSlot = el('div', { 'aria-live': 'polite' });
    const messageSlot = el('div');
    const details = el('div');
    const inspectorView = new Inspector(details, {
      labels: this.labels,
      boundaries: this.sources.security.trust_boundaries as unknown as Boundary[],
      jump: (k) => this.go(() => player.jump(k)),
      select: (selection) => this.select(selection),
      earlierRevision: this.sources.mcp.protocol.earlier_revision_handshake,
    });
    const inspector = el(
      'aside',
      { class: 'inspector', 'aria-label': 'Current step' },
      promptSlot,
      messageSlot,
      details,
    );
    let shownPrompt: number | undefined;
    /** The step and prompt last rendered, to tell a change of step from other renders. */
    let rendered: string | undefined;
    const workspace = el('div', { class: 'workspace' }, diagram, splitter, inspector);
    this.attachSplitter(workspace, splitter);

    // The model-context panel, collapsed at start (02 layout, context_panel).
    const contextBody = el('div', { id: 'context-panel', class: 'context-panel', hidden: '' });
    const contextToggle = button(
      'Model context',
      () => {
        const open = contextToggle.getAttribute('aria-expanded') !== 'true';
        contextToggle.setAttribute('aria-expanded', String(open));
        contextBody.hidden = !open;
        state.render();
      },
      { 'aria-expanded': 'false', 'aria-controls': 'context-panel', class: 'panel-toggle' },
    );
    const context = hasContext(scenario.initial_state)
      ? el('div', { class: 'context-area' }, contextToggle, contextBody)
      : undefined;
    // The ingestion panel (02 rag_ingestion), below the workspace so nothing above it moves.
    const ingestion = scenario.derived_events?.includes('index-05')
      ? this.ingestionPanel(
          (k) => this.go(() => player.jump(k)),
          () => slider.focus({ preventScroll: true }),
        )
      : undefined;
    // The retrieval panel (02 rag_retrieval).
    const retrieval = scenario.derived_events?.includes('retrieve-12')
      ? this.retrievalPanel(
          player,
          (k) => this.go(() => player.jump(k)),
          () => slider.focus({ preventScroll: true }),
        )
      : undefined;
    // The Combined answer's provenance (02 combined_answer).
    const combined = combinedPanel(scenario, player, {
      jump: (k) => this.go(() => player.jump(k)),
      leave: () => slider.focus({ preventScroll: true }),
    });

    const view = new DiagramView(diagram, player, {
      labels: this.labels,
      level: route.level,
      name: 'Sequence diagram',
    });
    const state: ScenarioView = {
      scenario,
      defaults: player.playback.events,
      player,
      view,
      row,
      prompt: undefined,
      selection: undefined,
      render: () => undefined,
      dispose: () => undefined,
    };

    state.render = (): void => {
      const n = player.playback.length;
      const k = player.cursor;
      const overview = view.level === 'overview';
      const event = player.playback.event(k);
      const phase = event ? scenario.phases.find((p) => p.id === event.phase) : undefined;
      const stops = this.stops(state);
      // At the Overview the position counts stages (02 zoom_levels.stepping).
      const stage = Math.max(
        0,
        stops.findIndex((s) => s >= k),
      );
      const where = overview
        ? `Stage ${stage} of ${stops.length - 1}`
        : phase
          ? `Step ${k} of ${n} · ${phase.label}`
          : `Step ${k} of ${n}`;
      row.update({
        step: overview ? stage : k,
        length: overview ? stops.length - 1 : n,
        where,
        playing: player.status === 'playing',
        speed: player.speed,
      });
      // The Overview shows the very basics: no headline naming the protocol, no parameters, step
      // details or panels (02 zoom_levels.overview).
      headline.hidden = overview;
      parameters.hidden = overview;
      details.hidden = overview;
      if (context) context.hidden = overview;
      const shown = overview ? 0 : k;
      const config = player.playback.retrievalConfig;
      for (const b of parameterButtons) {
        const current = JSON.stringify(config[b.dataset['parameter'] ?? '']);
        b.setAttribute('aria-pressed', String(b.dataset['value'] === current));
      }
      for (const { input, output, name } of sliders) {
        const value = Number(config[name]);
        const text = thresholdLabel(value);
        // Leave the slider alone while it already shows the value, so dragging is not disturbed.
        if (Number(input.value) !== value) input.value = String(value);
        input.setAttribute('aria-valuetext', text);
        output.textContent = text;
      }
      // At the Overview each panel shows what it shows before the first step: nothing.
      ingestion?.panel.update(ingestionModel(player.playback.events, shown, ingestion.sources));
      retrieval?.panel.update(
        retrievalModel(player.playback.events, shown, retrieval.index()),
        state.selection,
      );
      combined?.update(shown);
      row.setLevel(view.level);
      const promptAt =
        state.prompt === k && player.playback.event(k + 1)?.prediction ? k : undefined;
      if (promptAt !== shownPrompt) {
        shownPrompt = promptAt;
        promptSlot.replaceChildren(...this.promptContent(state));
      }
      messageSlot.replaceChildren(...this.introContent(state));
      inspectorView.update({
        events: player.playback.events,
        cursor: k,
        selection: state.selection,
      });
      if (!contextBody.hidden) {
        const previous = k > 0 ? player.playback.snapshot(k - 1) : undefined;
        contextBody.replaceChildren(
          renderContext(contextModel(player.playback.events, player.snapshot, previous)),
        );
      }
      this.syncUrl();
      const position = `${k}:${promptAt ?? ''}`;
      // An explicit step brings the stepping area back; a Play tick (or a link followed) only
      // while the learner has not scrolled the page since (02 layout.phone.stepping_area).
      if (rendered !== undefined && position !== rendered && !this.adjusting) {
        if (!this.pageScroll.userScrolled) this.keepInView(diagram, inspector, controls);
      }
      rendered = position;
    };

    const unsubscribe = player.subscribe(() => {
      // Play pauses before a step that asks for a prediction (02 learning.prediction_rules), not
      // at the Overview, which steps by stage and shows no prompts (zoom_levels.overview).
      const next = player.playback.event(player.cursor + 1);
      if (
        player.status === 'playing' &&
        view.level !== 'overview' &&
        next?.prediction &&
        state.prompt !== player.cursor
      ) {
        player.pause();
        state.prompt = player.cursor;
      }
      state.render();
    });
    state.dispose = (): void => {
      unsubscribe();
      retrieval?.panel.destroy();
      view.destroy();
      player.dispose();
    };

    this.content.replaceChildren(
      lesson,
      row.root,
      ...(offered.length ? [parameters] : []),
      workspace,
      ...(context ? [context] : []),
      ...(ingestion ? [ingestion.panel.root] : []),
      ...(retrieval ? [retrieval.panel.root] : []),
      ...(combined ? [combined.root] : []),
    );
    this.toPhoneControls(row);
    this.setLevel(state, route.level);
    // The Overview rests at the end of the stage (02 zoom_levels.cursor_mapping).
    player.jump(zoomCursor(this.spans(state), player.cursor, 'protocol', route.level));
    state.render();
    return state;
  }

  /** Where the Overview's cursor rests: 0 and the end of each stage. */
  private stops(c: ScenarioView): number[] {
    return stageStops(this.spans(c));
  }

  private promptContent(state: ScenarioView): Node[] {
    const next = state.player.playback.event(state.player.cursor + 1);
    if (state.prompt !== state.player.cursor || !next?.prediction) return [];
    return [
      el(
        'div',
        { class: 'prediction' },
        el('p', { class: 'small muted' }, 'Before the next step'),
        el('p', { class: 'prompt' }, next.prediction.prompt),
        button('Continue', () => this.next()),
      ),
    ];
  }

  /**
   * Before the first step: the question the scenario answers. At the Overview, then the current
   * stage's sentence (02 zoom_levels.overview).
   */
  private introContent(state: ScenarioView): Node[] {
    const { scenario } = state;
    if (state.player.cursor > 0) {
      if (state.view.level !== 'overview') return [];
      const stage = stageAt(this.spans(state), state.player.cursor);
      return stage ? [el('p', { class: 'message' }, stage.stage.sentence)] : [];
    }
    return [
      el('p', { class: 'message' }, `${scenario.question ?? scenario.learning_question}`),
      el('p', { class: 'small muted' }, 'Nothing has happened yet. Next runs the first step.'),
    ];
  }

  /** Runs an explicit step action of the learner (02 layout.phone.stepping_area). */
  private act(action: () => void): void {
    // The learner's scrolling counts until the next explicit step action.
    this.pageScroll.reset();
    action();
  }

  /** Runs a navigation that never shows a prediction prompt. */
  private go(action: () => void): void {
    this.act(() => {
      if (this.current) this.current.prompt = undefined;
      action();
      this.current?.render();
    });
  }

  /** Next: show a pending prediction first, then run the step (02 learning.prediction_rules). */
  private next(): void {
    this.act(() => this.nextStep());
  }

  private nextStep(): void {
    const c = this.current;
    if (!c) return;
    const upcoming = c.player.playback.event(c.player.cursor + 1);
    if (c.view.level !== 'overview' && upcoming?.prediction && c.prompt !== c.player.cursor) {
      c.prompt = c.player.cursor;
      c.render();
      return;
    }
    c.prompt = undefined;
    c.player.next();
    c.render();
  }

  private attachSplitter(workspace: HTMLElement, splitter: HTMLElement): void {
    const MIN_REM = 20;
    const MAX_SHARE = 60;
    const rem = (): number => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const minShare = (): number =>
      Math.min(MAX_SHARE, ((MIN_REM * rem()) / Math.max(1, workspace.clientWidth)) * 100);
    let share = 30;
    // The width is a share of the workspace, clamped in CSS too, so it stays within limits
    // when the window is resized (02 layout.splitter).
    const set = (value: number): void => {
      share = Math.round(Math.min(Math.max(value, minShare()), MAX_SHARE));
      workspace.style.setProperty(
        '--inspector-width',
        `clamp(${MIN_REM}rem, ${share}%, ${MAX_SHARE}%)`,
      );
      splitter.setAttribute('aria-valuenow', String(share));
      splitter.setAttribute('aria-valuemin', String(Math.round(minShare())));
      splitter.setAttribute('aria-valuemax', String(MAX_SHARE));
      splitter.setAttribute('aria-valuetext', `Inspector ${share}% of the width`);
    };
    requestAnimationFrame(() => set(share));
    splitter.addEventListener('pointerdown', (down) => {
      splitter.setPointerCapture(down.pointerId);
      const box = workspace.getBoundingClientRect();
      const move = (e: PointerEvent): void => set(((box.right - e.clientX) / box.width) * 100);
      const up = (): void => {
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
    });
    splitter.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: 2, ArrowRight: -2, Home: MAX_SHARE, End: -MAX_SHARE }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      set(share + step);
    });
  }

  /** The ingestion panel over the documents the scenario indexes (02 rag_ingestion). */
  private ingestionPanel(
    jump: (step: number) => void,
    leave: () => void,
  ): { panel: IngestionPanel; sources: SourceDocument[] } {
    const { engine } = ragDerivation();
    const sources = sourceDocuments(engine.corpus(), engine.fixtures.documents);
    const panel = new IngestionPanel({
      sources,
      embedding: (text) => engine.embedding(text),
      note: embeddingNote(this.sources.rag['principles']),
      jump,
      leave,
    });
    return { panel, sources };
  }

  /**
   * The retrieval panel over the index the scenario searches (02 rag_retrieval); its chunks
   * follow the current chunking parameters.
   */
  private retrievalPanel(
    player: Player,
    jump: (step: number) => void,
    leave: () => void,
  ): { panel: RetrievalPanel; index: () => SearchedIndex } {
    const derivation = ragDerivation();
    const { engine } = derivation;
    const fixtures = this.sources.rag['fixtures'] as unknown as RagFixtures & {
      projection_2d: { x: string; y: string };
    };
    const project = projection(fixtures.projection_2d, engine.fixtures.embedding.dimensions);
    const docs = engine.corpus();
    const cache = new Map<string, Chunk[]>();
    const index = (): SearchedIndex => {
      const p = derivation.parameters(player.playback.retrievalConfig);
      const key = `${p.chunkSize}/${p.overlap}`;
      let chunks = cache.get(key);
      if (!chunks) {
        chunks = engine.chunks(docs, p.chunkSize, p.overlap);
        cache.set(key, chunks);
      }
      return { docs, chunks, project };
    };
    const panel = new RetrievalPanel({ index, jump, leave });
    return { panel, index };
  }

  /**
   * Changes a parameter (02 controls.action_rules.parameter_change): the player keeps the
   * cursor on the same event, and the lineage marks follow the recomputed events; a selected
   * value that no longer occurs is cleared.
   */
  private setParameter(name: string, value: Json): void {
    const c = this.current;
    if (!c) return;
    this.adjusting = true;
    try {
      c.prompt = undefined;
      c.player.setParameters({ [name]: value });
      if (c.selection) {
        const found = occurrences(c.player.playback.events, c.selection);
        // A value no longer played (a chunk ID of other parameters) is no longer selected.
        if (!found.length) c.selection = undefined;
        c.view.setSelected(new Set(found));
      }
      c.render();
    } finally {
      this.adjusting = false;
    }
  }

  /**
   * On phones, after a change of step, brings the stepping area on screen: the step list's
   * region, then the prediction prompt, the message line and the error line, above the bottom
   * bar. If any of it is off screen, the page scrolls at once so the region starts 8 px below
   * the top (02 layout.phone.stepping_area).
   */
  private keepInView(region: HTMLElement, inspector: HTMLElement, bar: HTMLElement): void {
    if (!isPhone()) return;
    const top = region.getBoundingClientRect().top;
    const lines = inspector.querySelectorAll('.prediction, .message, .message ~ p');
    const bottom = Math.max(0, ...[...lines].map((l) => l.getBoundingClientRect().bottom));
    if (top >= 0 && bottom <= bar.getBoundingClientRect().top) return;
    this.pageScroll.jumpBy(top - 8);
  }

  /** Selects a lineage value or clears the selection (02 lineage_selection). */
  private select(selection: Selection | undefined): void {
    const c = this.current;
    if (!c) return;
    c.selection = selection;
    const events = c.player.playback.events;
    c.view.setSelected(new Set(selection ? occurrences(events, selection) : []));
    c.render();
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const compare = this.compare;
    if (compare) {
      if (keyBelongsToFocus(e.target, e.key)) return;
      // CompareView treats these as the learner's explicit step actions.
      const direction = ZOOM_KEYS.get(e.key);
      if (e.key === 'ArrowRight') compare.next();
      else if (e.key === 'ArrowLeft') compare.previous();
      else if (e.key === ' ') compare.toggle();
      else if (direction) compare.zoomBy(direction);
      else return;
      e.preventDefault();
      return;
    }
    const c = this.current;
    if (!c) return;
    if (e.key === 'Escape' && c.selection) {
      this.select(undefined);
      e.preventDefault();
      return;
    }
    if (keyBelongsToFocus(e.target, e.key)) return;
    const direction = ZOOM_KEYS.get(e.key);
    const level = direction ? zoomed(c.view.level, direction) : undefined;
    if (e.key === 'ArrowRight') this.next();
    else if (e.key === 'ArrowLeft') this.go(() => c.player.previous());
    else if (e.key === ' ') this.act(() => c.player.toggle());
    else if (direction) {
      if (level) this.zoom(level);
    } else return;
    e.preventDefault();
  };
}

/**
 * After a change of level, focus that sat in what the level hides (the step details, a panel)
 * moves to the zoom control's pressed button, so it is never lost.
 */
export function keepFocusVisible(row: ControlRow): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return;
  if (active.isConnected && !active.closest('[hidden]')) return;
  row.zoom.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
}
