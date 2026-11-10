/**
 * App shell (02-ui-ux.yaml navigation, layout, controls, learning): one quiet frame with
 * tabs, the scenario picker, the mode switch, the learning question, the playback controls,
 * the diagram beside the step's message, and the step timeline.
 */
import { Playback } from '../engine/playback.ts';
import { Player, SPEEDS, type Speed } from '../engine/player.ts';
import { arrowLabel, type Mode } from '../diagram/model.ts';
import { DiagramView } from '../diagram/view.ts';
import { loadRegistry, participantLabels, specSources } from '../scenarios/registry.ts';
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
  // The diagram region scrolls with the arrow keys; a focused group inside it does not.
  if (target.matches('.diagram-scroller')) return true;
  if (target.closest('input, select, textarea, [role="separator"], [contenteditable="true"]'))
    return true;
  return key === ' ' && !!target.closest('button, a, summary, [role="button"]');
}

interface ScenarioView {
  scenario: Scenario;
  player: Player;
  view: DiagramView;
  /** Index of the event whose prediction prompt is showing, if any. */
  prompt: number | undefined;
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
    this.root.replaceChildren();
    this.root.className = '';
  }

  /** Shows the page for a location hash. */
  show(hash: string): void {
    const parsed = parseRoute(hash, this.tabs);
    const tab = parsed.ok ? parsed.route.tab : parsed.tab;
    if (!parsed.ok) {
      this.leaveScenario();
      this.renderHeader(tab, undefined);
      const link = el('a', { href: `#/${tab}` }, `Go to ${TAB_LABELS[tab]}`);
      this.content.replaceChildren(
        el('p', { class: 'error', role: 'alert' }, `× ${parsed.message}. `, link),
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
    // Close the menu once a scenario is chosen.
    details.addEventListener('click', (e) => {
      if ((e.target as Element).closest('a')) details.open = false;
    });
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
        el('h2', {}, compare.headline),
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
    const player = new Player(new Playback(scenario));
    player.jump(route.step);

    const lesson = el(
      'section',
      { class: 'lesson' },
      el('h2', {}, scenario.learning_question),
      el('p', { class: 'headline' }, scenario.headline),
    );
    const status = el('span', { class: 'small muted status', 'aria-live': 'polite' });
    const play = button('Play', () => player.toggle(), { 'aria-pressed': 'false' });
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
      { class: 'controls', role: 'toolbar', 'aria-label': 'Playback' },
      button('Start', () => this.go(() => player.start())),
      button('Previous', () => this.go(() => player.previous())),
      play,
      button('Next', () => this.next()),
      button('Reset', () => this.go(() => player.reset())),
      speeds,
      status,
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
    const inspector = el('aside', { class: 'inspector', 'aria-label': 'Current step' });
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
    const sliderLabel = el('span', { class: 'small muted' });
    const timeline = el('footer', { class: 'timeline' }, slider, sliderLabel);

    const view = new DiagramView(diagram, player, { labels: this.labels, mode: route.mode });
    const state: ScenarioView = {
      scenario,
      player,
      view,
      prompt: undefined,
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
      sliderLabel.textContent = where;
      play.textContent = player.status === 'playing' ? 'Pause' : 'Play';
      play.setAttribute('aria-pressed', String(player.status === 'playing'));
      for (const b of speeds.querySelectorAll<HTMLButtonElement>('button')) {
        b.setAttribute('aria-pressed', String(Number(b.dataset['speed']) === player.speed));
      }
      for (const b of this.header.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
        b.setAttribute('aria-pressed', String(b.dataset['mode'] === view.mode));
      }
      inspector.replaceChildren(...this.inspectorContent(state));
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

  private inspectorContent(state: ScenarioView): Node[] {
    const { player, scenario } = state;
    const nodes: Node[] = [];
    const next = player.playback.event(player.cursor + 1);
    if (state.prompt === player.cursor && next?.prediction) {
      nodes.push(
        el(
          'div',
          { class: 'prediction', role: 'status' },
          el('p', { class: 'small muted' }, 'Before the next step'),
          el('p', { class: 'prompt' }, next.prediction.prompt),
          button('Continue', () => this.next()),
        ),
      );
    }
    const event = player.playback.event(player.cursor);
    if (!event) {
      nodes.push(
        el('p', { class: 'message' }, `${scenario.question ?? scenario.learning_question}`),
      );
      nodes.push(
        el('p', { class: 'small muted' }, 'Nothing has happened yet. Next runs the first step.'),
      );
      return nodes;
    }
    const from = this.labels[event.sender] ?? event.sender;
    const to = this.labels[event.receiver] ?? event.receiver;
    nodes.push(el('p', { class: 'message' }, event.explanation));
    nodes.push(el('p', { class: 'small muted' }, `${from} → ${to} · ${arrowLabel(event)}`));
    return nodes;
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
    const MAX_SHARE = 0.6;
    const rem = (): number => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const set = (px: number): void => {
      const total = workspace.clientWidth;
      const clamped = Math.round(Math.min(Math.max(px, MIN_REM * rem()), total * MAX_SHARE));
      workspace.style.setProperty('--inspector-width', `${clamped}px`);
      splitter.setAttribute('aria-valuenow', String(Math.round((clamped / total) * 100)));
      splitter.setAttribute('aria-valuemin', String(Math.round(((MIN_REM * rem()) / total) * 100)));
      splitter.setAttribute('aria-valuemax', String(MAX_SHARE * 100));
    };
    const width = (): number =>
      workspace.querySelector('.inspector')?.getBoundingClientRect().width ?? 0;
    splitter.addEventListener('pointerdown', (down) => {
      splitter.setPointerCapture(down.pointerId);
      const right = workspace.getBoundingClientRect().right;
      const move = (e: PointerEvent): void => set(right - e.clientX);
      const up = (): void => {
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', up);
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', up);
    });
    splitter.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      set(width() + (e.key === 'ArrowLeft' ? 2 : -2) * rem());
    });
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    const c = this.current;
    if (!c || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (keyBelongsToFocus(e.target, e.key)) return;
    if (e.key === 'ArrowRight') this.next();
    else if (e.key === 'ArrowLeft') this.go(() => c.player.previous());
    else if (e.key === ' ') {
      c.prompt = undefined;
      c.player.toggle();
    } else return;
    e.preventDefault();
  };
}
