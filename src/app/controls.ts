/**
 * The control row (02-ui-ux.yaml controls.row): the zoom control, Reset, Previous step, Play or
 * Pause and Next step as media icons, the play speed, then the timeline (step slider and position
 * line).
 * The scenario view and Compare build the same row; below 48rem there is no row, only the
 * zoom control in the column of steps (phone_steps).
 */
import { SPEEDS, type Speed } from '../engine/player.ts';
import { type Level, LEVEL_LABELS, LEVELS } from '../diagram/zoom.ts';

const SVG = 'http://www.w3.org/2000/svg';

/** The icons, 24 × 24, filled or stroked in the button's colour (ink). */
const ICONS = {
  // A circular arrow turning back.
  reset: [
    ['path', { d: 'M4.5 4.5v5h5', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }],
    [
      'path',
      {
        d: 'M5 9.5 7.2 7.2a7.5 7.5 0 1 1-1.94 7.24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
      },
    ],
  ],
  // A bar and a triangle pointing left.
  previous: [
    ['rect', { x: '5', y: '6', width: '2', height: '12' }],
    ['path', { d: 'M19 6v12L9 12Z' }],
  ],
  play: [['path', { d: 'M8 5v14l11-7Z' }]],
  pause: [
    ['rect', { x: '7', y: '5', width: '3.5', height: '14' }],
    ['rect', { x: '13.5', y: '5', width: '3.5', height: '14' }],
  ],
  // A triangle pointing right and a bar.
  next: [
    ['path', { d: 'M5 6v12l10-6Z' }],
    ['rect', { x: '17', y: '6', width: '2', height: '12' }],
  ],
} as const satisfies Record<string, readonly (readonly [string, Record<string, string>])[]>;

type IconName = keyof typeof ICONS;

function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    width: '24',
    height: '24',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'icon',
  }))
    svg.setAttribute(key, value);
  for (const [tag, attrs] of ICONS[name]) {
    const shape = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}

/** The key of controls.keyboard: its ARIA name and how the label writes it. */
interface Key {
  aria: string;
  shown: string;
}

const KEYS = {
  previous: { aria: 'ArrowLeft', shown: '←' },
  next: { aria: 'ArrowRight', shown: '→' },
  play: { aria: 'Space', shown: 'Space' },
} as const satisfies Record<string, Key>;

/**
 * Sets an icon button's face: the icon, and its name in text, shown with its key while the
 * button has focus. The key is hidden from the accessible name; aria-keyshortcuts states it.
 */
function setFace(b: HTMLButtonElement, iconName: IconName, name: string, key?: Key): void {
  const label = document.createElement('span');
  // Hidden like every visually hidden text until the button has focus (shell.css).
  label.className = 'control-label visually-hidden small';
  label.append(name);
  if (key) {
    const shown = document.createElement('span');
    shown.setAttribute('aria-hidden', 'true');
    shown.textContent = ` (${key.shown})`;
    label.append(shown);
    b.setAttribute('aria-keyshortcuts', key.aria);
  }
  b.dataset['icon'] = iconName;
  b.replaceChildren(icon(iconName), label);
}

function iconButton(
  iconName: IconName,
  name: string,
  onClick: () => void,
  key?: Key,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-button';
  setFace(b, iconName, name, key);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * The zoom control (02 zoom_levels.control): a group "Zoom" of three buttons, Overview,
 * Architecture and Protocol, the current one pressed (setZoom).
 */
export function zoomControl(zoom: (level: Level) => void): HTMLElement {
  const group = document.createElement('div');
  group.className = 'segmented zoom';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Zoom');
  for (const level of LEVELS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = LEVEL_LABELS[level];
    b.dataset['level'] = level;
    b.dataset['label'] = LEVEL_LABELS[level];
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => zoom(level));
    group.append(b);
  }
  return group;
}

/** Presses the button of the current level. */
export function setZoom(group: HTMLElement, level: Level): void {
  for (const b of group.querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-pressed', String(b.dataset['level'] === level));
  }
}

/** What a polite live region says after a change of level, for example "Overview. Stage 2 of 4." */
export function levelAnnouncement(level: Level, where: string): string {
  return `${LEVEL_LABELS[level]}. ${where}${/[.?!]$/.test(where) ? '' : '.'}`;
}

export interface ControlRowOptions {
  /** The name of the buttons' group. */
  name: string;
  /** The step slider's name. */
  sliderName: string;
  /** The position line's class. */
  statusClass: string;
  reset: () => void;
  previous: () => void;
  toggle: () => void;
  next: () => void;
  speed: (speed: Speed) => void;
  jump: (step: number) => void;
  /** Changes the zoom level (02 zoom_levels.control). */
  zoom: (level: Level) => void;
}

export class ControlRow {
  /** The whole row, placed below the learning question. */
  readonly root: HTMLElement;
  /** The zoom control: Overview, Architecture, Protocol. */
  readonly zoom: HTMLElement;
  /** Reset, Previous step, Play or Pause, Next step. */
  readonly buttons: HTMLElement;
  /** The play speed with its label. */
  readonly speed: HTMLElement;
  readonly slider: HTMLInputElement;
  /** The position line. */
  readonly status: HTMLElement;
  private readonly play: HTMLButtonElement;
  private readonly select: HTMLSelectElement;
  private playing: boolean | undefined;
  /** Announces a change of level (02 zoom_levels.control); quiet while stepping. */
  private readonly announcer: HTMLElement;

  constructor(options: ControlRowOptions) {
    this.zoom = zoomControl(options.zoom);
    this.announcer = document.createElement('div');
    this.announcer.className = 'visually-hidden';
    this.announcer.setAttribute('aria-live', 'polite');

    this.play = iconButton('play', 'Play', options.toggle, KEYS.play);
    this.buttons = document.createElement('div');
    this.buttons.className = 'controls';
    this.buttons.setAttribute('role', 'group');
    this.buttons.setAttribute('aria-label', options.name);
    this.buttons.append(
      iconButton('reset', 'Reset', options.reset),
      iconButton('previous', 'Previous step', options.previous, KEYS.previous),
      this.play,
      iconButton('next', 'Next step', options.next, KEYS.next),
    );

    this.select = document.createElement('select');
    this.select.id = 'play-speed';
    for (const speed of SPEEDS) {
      const option = document.createElement('option');
      option.value = String(speed);
      option.textContent = `${speed}×`;
      this.select.append(option);
    }
    this.select.addEventListener('change', () => {
      const speed = SPEEDS.find((s) => String(s) === this.select.value);
      if (speed !== undefined) options.speed(speed);
    });
    const label = document.createElement('label');
    label.htmlFor = this.select.id;
    label.className = 'small muted';
    label.textContent = 'Play speed';
    this.speed = document.createElement('span');
    this.speed.className = 'speed';
    this.speed.append(label, this.select);

    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.step = '1';
    this.slider.setAttribute('aria-label', options.sliderName);
    this.slider.addEventListener('input', () => options.jump(Number(this.slider.value)));
    this.status = document.createElement('span');
    this.status.className = `small muted status ${options.statusClass}`.trim();
    const timeline = document.createElement('div');
    timeline.className = 'timeline';
    timeline.append(this.slider, this.status);

    this.root = document.createElement('div');
    this.root.className = 'control-row';
    this.root.append(this.zoom, this.buttons, this.speed, timeline, this.announcer);
  }

  /** Presses the current level's button. */
  setLevel(level: Level): void {
    setZoom(this.zoom, level);
  }

  /** Says the new level and the position once, after a change of level. */
  announce(level: Level, where: string): void {
    this.announcer.textContent = levelAnnouncement(level, where);
  }

  /**
   * Shows the position: the slider's value and range, and the position line, which the slider
   * carries for assistive technology.
   */
  update(state: { step: number; length: number; where: string; playing: boolean; speed: Speed }) {
    this.slider.max = String(state.length);
    this.slider.value = String(state.step);
    this.slider.setAttribute('aria-valuetext', state.where);
    this.status.textContent = state.where;
    if (this.select.value !== String(state.speed)) this.select.value = String(state.speed);
    if (state.playing !== this.playing) {
      this.playing = state.playing;
      setFace(
        this.play,
        state.playing ? 'pause' : 'play',
        state.playing ? 'Pause' : 'Play',
        KEYS.play,
      );
    }
  }

  /**
   * Keeps the slider's length steady while the position line changes: the line is as wide as
   * the longest of `lines` in its own font, measured once it is on the page and again once the
   * fonts have loaded.
   */
  reserve(lines: readonly string[]): void {
    const measure = (): void => {
      if (!this.status.isConnected) return;
      const context = document.createElement('canvas').getContext('2d');
      if (!context) return;
      context.font = getComputedStyle(this.status).font;
      const width = Math.max(0, ...lines.map((l) => context.measureText(l).width));
      this.status.style.setProperty('--status-width', `${Math.ceil(width)}px`);
    };
    requestAnimationFrame(measure);
    void document.fonts?.ready.then(measure);
  }
}
