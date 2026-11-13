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
import { type Boundary, Inspector } from '../inspector/inspector.ts';
import {
  projection,
  RetrievalPanel,
  retrievalModel,
  type RetrievalSection,
  type SearchedIndex,
  thresholdLabel,
} from '../inspector/retrieval.ts';
import { DiagramView } from '../diagram/view.ts';
import {
  loadRegistry,
  participantLabels,
  participantShortLabels,
  specSources,
} from '../scenarios/registry.ts';
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
import { isPhone, phoneQuery } from './phone.ts';
import { type InlinePanel, type PanelActions, PhoneSteps } from '../phone/steps.ts';
import { PhoneCompare } from '../phone/compare.ts';
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
/** The source repository, linked at the end of the header (02 layout.source_link). */
const SOURCE_URL = 'https://github.com/m14dch/agentscope';

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
  render: () => void;
  dispose: () => void;
}

export class Shell {
  private readonly registry = loadRegistry();
  private readonly sources = specSources();
  private readonly labels = participantLabels();
  private readonly shortLabels = participantShortLabels();
  private readonly tabs = tabScenarios(this.sources);
  private readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly content: HTMLElement;
  private current: ScenarioView | undefined;
  /** The Compare view while the Compare tab shows (02 compare_view). */
  private compare: CompareView | undefined;
  /** Removes the document listeners of the current header. */
  private headerListeners: AbortController | undefined;
  /** The column of steps of a scenario on phones (02 phone_steps). */
  private phone:
    | { scenario: Scenario; defaults: readonly ScenarioEvent[]; player: Player; view: PhoneSteps }
    | undefined;
  /** Compare on phones (02 phone_steps.compare). */
  private phoneCompare: PhoneCompare | undefined;
  /** Whether a page has been shown; the first one does not take focus. */
  private shown = false;
  private route: Route | undefined;
  /** Crossing 48rem lays the page out again at the same address (02 layout.phone.breakpoint). */
  private readonly phoneChange = (): void => {
    this.leaveScenario();
    this.render(location.hash);
    // As after a change of page, focus starts at the heading (02 layout.phone.breakpoint).
    this.content.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  };

  constructor(root: HTMLElement) {
    this.root = root;
    root.className = 'shell';
    this.header = el('header', { class: 'shell-header' });
    this.content = el('div', { class: 'shell-content' });
    root.replaceChildren(this.header, this.content);
    window.addEventListener('keydown', this.onKey);
    phoneQuery()?.addEventListener('change', this.phoneChange);
  }

  destroy(): void {
    this.leaveScenario();
    window.removeEventListener('keydown', this.onKey);
    phoneQuery()?.removeEventListener('change', this.phoneChange);
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
    // A page that placed focus itself (a phone row named by the address) keeps it.
    const now = document.activeElement;
    const placed = now instanceof HTMLElement && now !== document.body && now.isConnected;
    if (this.shown && lost && !placed) {
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
      else if (this.phoneCompare) {
        this.route = route;
        this.phoneCompare.follow(route.level);
      } else this.renderCompare(route);
      return;
    }
    const scenario = this.registry[route.scenario];
    if (!scenario) return;
    if (this.phone?.scenario.id === scenario.id) {
      const p = this.phone;
      this.route = route;
      p.view.follow(fromDefaultStep(p.defaults, p.player.playback.events, route.step), route.level);
      return;
    }
    if (isPhone()) {
      this.leaveScenario();
      this.route = route;
      this.renderHeader(route.tab, scenario);
      this.renderPhoneScenario(scenario, route);
      return;
    }
    if (this.current?.scenario.id === scenario.id) {
      // Same scenario: follow the step and level in the link.
      const c = this.current;
      c.player.jump(fromDefaultStep(c.defaults, c.player.playback.events, route.step));
      this.setLevel(c, route.level);
      // The Overview rests at the end of the stage (02 zoom_levels.cursor_mapping).
      c.player.jump(zoomCursor(this.spans(c), c.player.cursor, 'protocol', route.level));
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
    this.phone?.view.dispose();
    this.phone?.player.dispose();
    this.phone = undefined;
    this.phoneCompare?.dispose();
    this.phoneCompare = undefined;
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
    if (scenario && this.tabs[tab].length > 1) row.append(this.picker(tab, scenario));
    // The GitHub link ends the header row (02 layout.source_link); on phones it ends the
    // wordmark row (src/styles/phone.css).
    row.append(
      el(
        'span',
        { class: 'source-slot' },
        el('a', { class: 'source-link', href: SOURCE_URL }, 'GitHub'),
      ),
    );
    this.header.replaceChildren(
      row,
      el('p', { class: 'small muted simulated' }, SIMULATED, offlineIndicator()),
    );
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
      // Closing the menu is all this Escape does.
      e.preventDefault();
      details.open = false;
      details.querySelector('summary')?.focus();
    });
    document.addEventListener(
      'pointerdown',
      (e) => {
        // On phones the list is in the page's flow: closing it on a tap elsewhere would move the
        // page under the finger before the tap lands (02 layout.phone.header).
        if (details.open && !details.contains(e.target as Node) && !isPhone()) details.open = false;
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
    const target = zoomCursor(this.spans(c), c.player.cursor, from, level);
    this.setLevel(c, level);
    c.player.jump(target);
    c.render();
    c.row.announce(level, c.row.status.textContent ?? '');
    keepFocusVisible(c.row);
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
    if (isPhone()) {
      this.route = route;
      this.phoneCompare = new PhoneCompare(this.content, {
        compare,
        phases: semantic_phases,
        panes: [pane(compare.left_scenario), pane(compare.right_scenario)],
        labels: this.labels,
        shortLabels: this.shortLabels,
        level: route.level,
        onChange: (level) => {
          // The address keeps its compare step; only the level changes (phone_steps.compare).
          this.route = { ...(this.route ?? route), level };
          const hash = formatRoute(this.route);
          if (location.hash !== hash) history.replaceState(null, '', hash);
        },
      });
      return;
    }
    this.compare = new CompareView(this.content, {
      compare,
      phases: semantic_phases,
      panes: [pane(compare.left_scenario), pane(compare.right_scenario)],
      labels: this.labels,
      shortLabels: this.shortLabels,
      step: route.step,
      level: route.level,
      onChange: (step, level) => {
        this.route = { ...route, step, level };
        const hash = formatRoute(this.route);
        if (location.hash !== hash) history.replaceState(null, '', hash);
      },
    });
  }

  /**
   * A scenario on phones: the column of steps (02 phone_steps). The player plays the events at
   * the current parameters; its cursor is the address's step.
   */
  private renderPhoneScenario(scenario: Scenario, route: Route): void {
    const player = new Player(createPlayback(scenario));
    const defaults = player.playback.events;
    player.jump(route.step);
    const parameters = this.parameterControls(scenario, player, (name, value) => {
      player.setParameters({ [name]: value });
      parameters?.sync();
      view.rebuild();
      write();
    });
    parameters?.sync();
    const write = (): void => {
      if (!this.route) return;
      // The address numbers steps as played at the defaults (02 navigation.route_steps).
      const step = toDefaultStep(defaults, player.playback.events, player.cursor);
      this.route = { ...this.route, step, level: view.level };
      const hash = formatRoute(this.route);
      if (location.hash !== hash) history.replaceState(null, '', hash);
    };
    // Write nothing until the view exists.
    let ready = false;
    const view: PhoneSteps = new PhoneSteps(this.content, {
      scenario,
      player,
      labels: this.labels,
      shortLabels: this.shortLabels,
      level: route.level,
      boundaries: this.sources.security.trust_boundaries as unknown as Boundary[],
      earlierRevision: this.sources.mcp.protocol.earlier_revision_handshake,
      travel: {
        initialState: scenario.initial_state,
        origins: this.sources.engine.lineage.origins ?? {},
      },
      parameters: parameters?.root,
      panels: this.inlinePanels(scenario, player),
      onChange: () => {
        if (ready) write();
      },
    });
    ready = true;
    this.phone = { scenario, defaults, player, view };
    write();
  }

  /**
   * The panels a step holds on phones (02 phone_steps.inline_panels), each as of that step: the
   * model context at LLM requests, the ingestion panel at index-07, the retrieval sections at
   * retrieve-06, retrieve-10 and retrieve-12, the Combined answer at c-08.
   */
  private inlinePanels(
    scenario: Scenario,
    player: Player,
  ): (event: ScenarioEvent, step: number, actions: PanelActions) => InlinePanel[] {
    const context = hasContext(scenario.initial_state);
    const sections: Readonly<Record<string, readonly RetrievalSection[]>> = {
      'retrieve-06': ['scores', 'projection'],
      'retrieve-10': ['prompt'],
      'retrieve-12': ['answer'],
    };
    const local = (e: ScenarioEvent): string => e.id.slice(e.id.indexOf(':') + 1);
    return (event, step, actions) => {
      const events = player.playback.events;
      const panels: InlinePanel[] = [];
      if (context && event.protocol === 'LLM_API' && event.message_type === 'REQUEST') {
        const id = `step-${step}-context`;
        const area = el('div', { class: 'context-area' });
        const body = el('div', { id, class: 'context-panel', hidden: '' });
        const toggle = button(
          'Model context',
          () => {
            const open = toggle.getAttribute('aria-expanded') !== 'true';
            toggle.setAttribute('aria-expanded', String(open));
            body.hidden = !open;
            const playback = player.playback;
            body.replaceChildren(
              ...(open
                ? [
                    renderContext(
                      contextModel(events, playback.snapshot(step), playback.snapshot(step - 1)),
                    ),
                  ]
                : []),
            );
          },
          { 'aria-expanded': 'false', 'aria-controls': id, class: 'panel-toggle' },
        );
        area.append(toggle, body);
        panels.push({ root: area });
      }
      const id = local(event);
      if (id === 'index-07' && scenario.derived_events?.includes('index-05')) {
        const ingestion = this.ingestionPanel(actions.jump, actions.leave);
        ingestion.panel.update(ingestionModel(events, step, ingestion.sources));
        panels.push({ root: ingestion.panel.root });
      }
      const wanted = sections[id];
      if (wanted && scenario.derived_events?.includes('retrieve-12')) {
        const retrieval = this.retrievalPanel(player, actions.jump, actions.leave, {
          sections: wanted,
          id: `step-${step}-retrieval`,
        });
        retrieval.panel.update(retrievalModel(events, step, retrieval.index()));
        panels.push({ root: retrieval.panel.root, destroy: () => retrieval.panel.destroy() });
      }
      if (id === 'c-08') {
        const combined = combinedPanel(scenario, player, actions);
        if (combined) {
          combined.update(step);
          panels.push({ root: combined.root });
        }
      }
      return panels;
    };
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
      toggle: () => player.toggle(),
      next: () => this.go(() => player.next()),
      speed: (speed) => player.setSpeed(speed),
      // At the Overview the slider runs over the stages (02 zoom_levels.stepping).
      jump: (step) =>
        this.go(() =>
          player.jump(view.level === 'overview' ? (this.stops(state)[step] ?? 0) : step),
        ),
      zoom: (level) => this.zoom(level),
    });
    const { slider } = row;
    const steps = player.playback.length;
    row.reserve(scenario.phases.map((p) => `Step ${steps} of ${steps} · ${p.label}`));

    const parameters = this.parameterControls(scenario, player, (name, value) =>
      this.setParameter(name, value),
    );

    // DiagramView names the region and states how it scrolls.
    const diagram = el('div', { class: 'diagram-pane', role: 'region' });
    const splitter = el('div', {
      class: 'splitter',
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize the inspector',
    });
    const messageSlot = el('div');
    const details = el('div');
    const inspectorView = new Inspector(details, {
      labels: this.labels,
      boundaries: this.sources.security.trust_boundaries as unknown as Boundary[],
      jump: (k) => this.go(() => player.jump(k)),
      travel: {
        initialState: scenario.initial_state,
        origins: this.sources.engine.lineage.origins ?? {},
      },
      earlierRevision: this.sources.mcp.protocol.earlier_revision_handshake,
    });
    const inspector = el(
      'aside',
      { class: 'inspector', 'aria-label': 'Current step' },
      messageSlot,
      details,
    );
    const workspace = el('div', { class: 'workspace' }, diagram, splitter, inspector);
    this.attachSplitter(workspace, splitter, inspector);

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
      shortLabels: this.shortLabels,
      level: route.level,
      name: 'Sequence diagram',
      onNaturalWidth: (px) => workspace.style.setProperty('--diagram-width', `${px}px`),
      // An arrow moves the cursor by the slider's path (02 diagram.arrow_activation).
      jump: (step) => this.go(() => player.jump(step)),
    });
    const state: ScenarioView = {
      scenario,
      defaults: player.playback.events,
      player,
      view,
      row,
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
      if (parameters) parameters.root.hidden = overview;
      details.hidden = overview;
      if (context) context.hidden = overview;
      const shown = overview ? 0 : k;
      parameters?.sync();
      // At the Overview each panel shows what it shows before the first step: nothing.
      ingestion?.panel.update(ingestionModel(player.playback.events, shown, ingestion.sources));
      retrieval?.panel.update(retrievalModel(player.playback.events, shown, retrieval.index()));
      combined?.update(shown);
      row.setLevel(view.level);
      messageSlot.replaceChildren(...this.introContent(state));
      inspectorView.update({ events: player.playback.events, cursor: k });
      if (!contextBody.hidden) {
        const previous = k > 0 ? player.playback.snapshot(k - 1) : undefined;
        contextBody.replaceChildren(
          renderContext(contextModel(player.playback.events, player.snapshot, previous)),
        );
      }
      this.syncUrl();
    };

    const unsubscribe = player.subscribe(() => state.render());
    state.dispose = (): void => {
      unsubscribe();
      retrieval?.panel.destroy();
      view.destroy();
      player.dispose();
    };

    this.content.replaceChildren(
      lesson,
      row.root,
      ...(parameters ? [parameters.root] : []),
      workspace,
      ...(context ? [context] : []),
      ...(ingestion ? [ingestion.panel.root] : []),
      ...(retrieval ? [retrieval.panel.root] : []),
      ...(combined ? [combined.root] : []),
    );
    this.setLevel(state, route.level);
    // The Overview rests at the end of the stage (02 zoom_levels.cursor_mapping).
    player.jump(zoomCursor(this.spans(state), player.cursor, 'protocol', route.level));
    state.render();
    return state;
  }

  /**
   * The parameter controls a scenario offers (02 rag_controls), with a function that shows the
   * player's current values; undefined when it offers none.
   */
  private parameterControls(
    scenario: Scenario,
    player: Player,
    set: (name: string, value: Json) => void,
  ): { root: HTMLElement; sync: () => void } | undefined {
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
        const b = button(label, () => set(name, player.playback.retrievalConfig[name] !== true));
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
          if (Number.isFinite(value)) set(name, value);
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
        const b = button(String(value), () => set(name, value), {
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

    if (!offered.length) return undefined;
    const sync = (): void => {
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
    };
    return { root: parameters, sync };
  }

  /** Where the Overview's cursor rests: 0 and the end of each stage. */
  private stops(c: ScenarioView): number[] {
    return stageStops(this.spans(c));
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
      el(
        'p',
        { class: 'small muted' },
        `Nothing has happened yet. Next runs the first ${state.view.level === 'overview' ? 'stage' : 'step'}.`,
      ),
    ];
  }

  /** Runs a navigation and renders its result. */
  private go(action: () => void): void {
    action();
    this.current?.render();
  }

  private attachSplitter(
    workspace: HTMLElement,
    splitter: HTMLElement,
    inspector: HTMLElement,
  ): void {
    const MIN_REM = 20;
    const MAX_SHARE = 60;
    const rem = (): number => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    // The inspector's width is a share of the workspace up to the column's width, the
    // header's, so a widened workspace gives its extra width to the diagram (02 layout.splitter).
    const base = (): number =>
      Math.max(1, Math.min(workspace.clientWidth, this.header.clientWidth));
    const minShare = (): number => Math.min(MAX_SHARE, ((MIN_REM * rem()) / base()) * 100);
    let share = 30;
    // shell.css turns the share into the inspector's width, clamped to 20rem and 60% of the
    // workspace, so it stays within limits when the window is resized.
    const set = (value: number): void => {
      share = Math.round(Math.min(Math.max(value, minShare()), MAX_SHARE));
      workspace.style.setProperty('--inspector-share', String(share / 100));
    };
    // The value and label give the share the inspector takes on screen, measured after each
    // layout: in a widened workspace it is less than the share of the column.
    const describe = (): void => {
      const total = workspace.clientWidth;
      if (!total) return;
      const shown = String(Math.round((inspector.offsetWidth / total) * 100));
      splitter.setAttribute('aria-valuenow', shown);
      splitter.setAttribute(
        'aria-valuemin',
        String(Math.round(Math.min(MAX_SHARE, ((MIN_REM * rem()) / total) * 100))),
      );
      splitter.setAttribute('aria-valuemax', String(MAX_SHARE));
      splitter.setAttribute('aria-valuetext', `Inspector ${shown}% of the width`);
    };
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(describe);
      observer.observe(workspace);
      observer.observe(inspector);
      (this.headerListeners ??= new AbortController()).signal.addEventListener('abort', () =>
        observer.disconnect(),
      );
    }
    requestAnimationFrame(() => {
      set(share);
      describe();
    });
    splitter.addEventListener('pointerdown', (down) => {
      splitter.setPointerCapture(down.pointerId);
      const move = (e: PointerEvent): void =>
        set(((workspace.getBoundingClientRect().right - e.clientX) / base()) * 100);
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
    only: { sections?: readonly RetrievalSection[]; id?: string } = {},
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
    const panel = new RetrievalPanel({ index, jump, leave, ...only });
    return { panel, index };
  }

  /**
   * Changes a parameter (02 controls.action_rules.parameter_change): the player keeps the
   * cursor on the same event.
   */
  private setParameter(name: string, value: Json): void {
    const c = this.current;
    if (!c) return;
    c.player.setParameters({ [name]: value });
    c.render();
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    // On phones only + and - act: the arrow keys and Space keep their browser meaning
    // (02 phone_steps.keyboard).
    const phone = this.phone?.view ?? this.phoneCompare;
    if (phone) {
      const direction = ZOOM_KEYS.get(e.key);
      if (!direction || keyBelongsToFocus(e.target, e.key)) return;
      phone.zoomBy(direction);
      e.preventDefault();
      return;
    }
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
    if (keyBelongsToFocus(e.target, e.key)) return;
    const direction = ZOOM_KEYS.get(e.key);
    const level = direction ? zoomed(c.view.level, direction) : undefined;
    if (e.key === 'ArrowRight') this.go(() => c.player.next());
    else if (e.key === 'ArrowLeft') this.go(() => c.player.previous());
    else if (e.key === ' ') c.player.toggle();
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
