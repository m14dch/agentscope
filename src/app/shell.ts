/**
 * App shell (02-ui-ux.yaml navigation, layout, controls, learning): one quiet frame with
 * tabs, the scenario picker, the mode switch, the learning question, the playback controls,
 * the diagram beside the step's message, and the step timeline.
 */
import { Player, SPEEDS, type Speed } from '../engine/player.ts';
import type { Mode } from '../diagram/model.ts';
import { contextModel, hasContext, renderContext } from '../inspector/context.ts';
import { type Boundary, Inspector, occurrences, type Selection } from '../inspector/inspector.ts';
import { DiagramView } from '../diagram/view.ts';
import { loadRegistry, participantLabels, specSources } from '../scenarios/registry.ts';
import { createPlayback } from '../rag/bundled.ts';
import type { Scenario } from '../scenarios/types.ts';
import {
  formatRoute,
  parseRoute,
  type Route,
  TAB_LABELS,
  TABS,
  type Tab,
  tabScenarios,
} from './routes.ts';
import '../styles/diagram.css';
import '../styles/shell.css';
import '../styles/inspector.css';

const SIMULATED = 'Everything here is simulated. Nothing leaves your browser.';

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

/** Whether the focused element needs this key for itself (02 controls.keyboard_scope). */
function keyBelongsToFocus(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('textarea, select, [contenteditable="true"]')) return true;
  if (key === ' ') {
    // Space activates buttons, links and menus and types into text fields.
    return !!target.closest('button, a, summary, [role="button"], input:not([type="range"])');
  }
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
  player: Player;
  view: DiagramView;
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
  private readonly lessons = new Map<string, string>(
    [...this.sources.mcp.variants, ...this.sources.rag.variants].map((v) => [v.id, v.lesson]),
  );
  private readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly content: HTMLElement;
  private current: ScenarioView | undefined;
  /** Removes the document listeners of the current header. */
  private headerListeners: AbortController | undefined;
  /** Whether a page has been shown; the first one does not take focus. */
  private shown = false;
  private route: Route | undefined;

  constructor(root: HTMLElement) {
    this.root = root;
    root.className = 'shell';
    this.header = el('header', { class: 'shell-header' });
    this.content = el('div', { class: 'shell-content' });
    root.replaceChildren(this.header, this.content);
    window.addEventListener('keydown', this.onKey);
  }

  destroy(): void {
    this.current?.dispose();
    this.current = undefined;
    window.removeEventListener('keydown', this.onKey);
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
    if (route.tab === 'compare' || route.scenario === undefined) {
      this.leaveScenario();
      this.route = route;
      this.renderHeader(route.tab, undefined);
      this.renderCompare();
      return;
    }
    const scenario = this.registry[route.scenario];
    if (!scenario) return;
    if (this.current?.scenario.id === scenario.id) {
      // Same scenario: follow the step and mode in the link.
      this.current.player.jump(route.step);
      this.current.view.setMode(route.mode);
      this.current.prompt = undefined;
      this.route = { ...route, step: this.current.player.cursor };
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
  }

  /** Writes the current position into the address without adding a history entry. */
  private syncUrl(): void {
    const c = this.current;
    if (!c || !this.route) return;
    this.route = { ...this.route, step: c.player.cursor, mode: c.view.mode };
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
    const brand = el('h1', { class: 'brand' }, el('a', { href: '#/' }, 'AgentScope'));
    const row = el('div', { class: 'shell-bar' }, brand, nav);
    if (scenario && this.tabs[tab].length > 1) row.append(this.picker(tab, scenario));
    if (scenario) row.append(this.modeSwitch());
    this.header.replaceChildren(row, el('p', { class: 'small muted simulated' }, SIMULATED));
  }

  private picker(tab: Tab, scenario: Scenario): HTMLElement {
    const items = this.tabs[tab].map((id) => {
      const s = this.registry[id];
      const lesson = this.lessons.get(id);
      const link = el(
        'a',
        { href: `#/${tab}/${id}/0`, 'aria-current': id === scenario.id ? 'true' : undefined },
        s?.title ?? id,
      );
      return el('li', {}, link, ...(lesson ? [el('span', { class: 'small muted' }, lesson)] : []));
    });
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

  private modeSwitch(): HTMLElement {
    const group = el('div', { class: 'segmented', role: 'group', 'aria-label': 'View' });
    for (const mode of ['architecture', 'protocol'] as const) {
      const b = button(mode === 'architecture' ? 'Architecture' : 'Protocol', () =>
        this.setMode(mode),
      );
      b.dataset['mode'] = mode;
      group.append(b);
    }
    return group;
  }

  private setMode(mode: Mode): void {
    if (!this.current) return;
    this.current.view.setMode(mode);
    this.current.render();
  }

  private renderCompare(): void {
    const compare = this.sources.comparison.compare as unknown as {
      headline: string;
      left_scenario: string;
      right_scenario: string;
      left_question: string;
      right_question: string;
    };
    const side = (tab: Tab, id: string, label: string, question: string): HTMLElement =>
      el(
        'li',
        {},
        el('span', { class: 'small muted' }, label),
        el('a', { href: `#/${tab}/${id}/0` }, question),
      );
    this.content.replaceChildren(
      el(
        'section',
        { class: 'lesson' },
        el('h2', { tabindex: '-1' }, compare.headline),
        el(
          'ul',
          { class: 'compare-sides' },
          side('rag', compare.left_scenario, 'RAG', compare.left_question),
          side('mcp', compare.right_scenario, 'MCP', compare.right_question),
        ),
      ),
    );
  }

  private renderScenario(scenario: Scenario, route: Route): ScenarioView {
    const player = new Player(createPlayback(scenario));
    player.jump(route.step);

    const lesson = el(
      'section',
      { class: 'lesson' },
      el('h2', { tabindex: '-1' }, scenario.learning_question),
      el('p', { class: 'headline' }, scenario.headline),
    );
    const play = button('Play', () => player.toggle());
    const speeds = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Speed' });
    for (const speed of SPEEDS) {
      const b = button(`${speed}×`, () => player.setSpeed(speed as Speed), {
        'aria-label': `Speed ${speed}×`,
      });
      b.dataset['speed'] = String(speed);
      speeds.append(b);
    }
    const controls = el(
      'div',
      { class: 'controls', role: 'group', 'aria-label': 'Playback' },
      button('Start', () => this.go(() => player.start())),
      button('Previous', () => this.go(() => player.previous())),
      play,
      button('Next', () => this.next()),
      button('Reset', () => this.go(() => player.reset())),
      speeds,
    );

    const diagram = el('div', {
      class: 'diagram-pane',
      role: 'region',
      'aria-label': 'Sequence diagram, scrolls in both directions',
    });
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
    });
    const inspector = el(
      'aside',
      { class: 'inspector', 'aria-label': 'Current step' },
      promptSlot,
      messageSlot,
      details,
    );
    let shownPrompt: number | undefined;
    const workspace = el('div', { class: 'workspace' }, diagram, splitter, inspector);
    this.attachSplitter(workspace, splitter);

    const slider = el('input', {
      type: 'range',
      min: '0',
      max: String(player.playback.length),
      step: '1',
      'aria-label': 'Step',
    });
    slider.addEventListener('input', () => this.go(() => player.jump(Number(slider.value))));
    // The one place that states the step and its phase; the slider carries it for assistive tech.
    const status = el('span', { class: 'small muted status' });
    const timeline = el('footer', { class: 'timeline' }, slider, status);
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
    if (hasContext(scenario.initial_state)) timeline.append(contextToggle, contextBody);

    const view = new DiagramView(diagram, player, { labels: this.labels, mode: route.mode });
    const state: ScenarioView = {
      scenario,
      player,
      view,
      prompt: undefined,
      selection: undefined,
      render: () => undefined,
      dispose: () => undefined,
    };

    state.render = (): void => {
      const n = player.playback.length;
      const k = player.cursor;
      const event = player.playback.event(k);
      const phase = event ? scenario.phases.find((p) => p.id === event.phase) : undefined;
      const where = phase ? `Step ${k} of ${n} · ${phase.label}` : `Step ${k} of ${n}`;
      status.textContent = where;
      slider.value = String(k);
      slider.setAttribute('aria-valuetext', where);
      play.textContent = player.status === 'playing' ? 'Pause' : 'Play';
      for (const b of speeds.querySelectorAll<HTMLButtonElement>('button')) {
        b.setAttribute('aria-pressed', String(Number(b.dataset['speed']) === player.speed));
      }
      for (const b of this.header.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
        b.setAttribute('aria-pressed', String(b.dataset['mode'] === view.mode));
      }
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
    };

    const unsubscribe = player.subscribe(() => {
      // Play pauses before a step that asks for a prediction (02 learning.prediction_rules).
      const next = player.playback.event(player.cursor + 1);
      if (player.status === 'playing' && next?.prediction && state.prompt !== player.cursor) {
        player.pause();
        state.prompt = player.cursor;
      }
      state.render();
    });
    state.dispose = (): void => {
      unsubscribe();
      view.destroy();
      player.dispose();
    };

    this.content.replaceChildren(lesson, controls, workspace, timeline);
    state.render();
    return state;
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

  /** Before the first step: the question the scenario answers. */
  private introContent(state: ScenarioView): Node[] {
    if (state.player.cursor > 0) return [];
    const { scenario } = state;
    return [
      el('p', { class: 'message' }, `${scenario.question ?? scenario.learning_question}`),
      el('p', { class: 'small muted' }, 'Nothing has happened yet. Next runs the first step.'),
    ];
  }

  /** Runs a navigation that never shows a prediction prompt. */
  private go(action: () => void): void {
    if (this.current) this.current.prompt = undefined;
    action();
    this.current?.render();
  }

  /** Next: show a pending prediction first, then run the step (02 learning.prediction_rules). */
  private next(): void {
    const c = this.current;
    if (!c) return;
    const upcoming = c.player.playback.event(c.player.cursor + 1);
    if (upcoming?.prediction && c.prompt !== c.player.cursor) {
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
    const c = this.current;
    if (!c || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape' && c.selection) {
      this.select(undefined);
      e.preventDefault();
      return;
    }
    if (keyBelongsToFocus(e.target, e.key)) return;
    if (e.key === 'ArrowRight') this.next();
    else if (e.key === 'ArrowLeft') this.go(() => c.player.previous());
    else if (e.key === ' ') c.player.toggle();
    else return;
    e.preventDefault();
  };
}
