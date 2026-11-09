/**
 * Playback controls (02-ui-ux.yaml controls): start, next, previous, play, pause, reset
 * and jump, with speeds. Holds the cursor and playback status; snapshots come from Playback.
 */
import type { Playback, Snapshot } from './playback.ts';

export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];
/** One step per STEP_INTERVAL_MS at 1×. */
export const STEP_INTERVAL_MS = 1500;

export type PlaybackStatus = 'paused' | 'playing';

export interface Clock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserClock: Clock = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Player {
  private position = 0;
  private playing = false;
  private rate: Speed = 1;
  private timer: unknown;
  /** Identifies the live timer; a callback from any other timer does nothing. */
  private token: object | undefined;
  private disposed = false;
  private readonly listeners = new Set<(player: Player) => void>();

  readonly playback: Playback;
  private readonly clock: Clock;

  constructor(playback: Playback, clock: Clock = browserClock) {
    this.playback = playback;
    this.clock = clock;
  }

  get cursor(): number {
    return this.position;
  }

  get status(): PlaybackStatus {
    return this.playing ? 'playing' : 'paused';
  }

  get speed(): Speed {
    return this.rate;
  }

  get snapshot(): Snapshot {
    return this.playback.snapshot(this.position);
  }

  get atEnd(): boolean {
    return this.position >= this.playback.length;
  }

  /** Calls the listener after every change; returns a function that removes it. */
  subscribe(listener: (player: Player) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Go to the first step; playback keeps its status. */
  start(): void {
    this.navigate(Math.min(1, this.playback.length));
  }

  next(): void {
    this.navigate(this.position + 1);
  }

  previous(): void {
    this.navigate(this.position - 1);
  }

  jump(cursor: number): void {
    this.navigate(cursor);
  }

  /** Return to the initial state before any step and pause. */
  reset(): void {
    this.stop();
    this.move(0);
    this.emit();
  }

  play(): void {
    if (this.disposed || this.playing || this.atEnd) return;
    this.playing = true;
    this.schedule();
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.stop();
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: Speed): void {
    if (!SPEEDS.includes(speed))
      throw new RangeError(`speed ${String(speed)} is not one of ${SPEEDS.join(', ')}`);
    this.rate = speed;
    if (this.playing) this.schedule();
    this.emit();
  }

  /** Changes parameters; the cursor stays, clamped to the new number of steps. */
  setParameters(values: Parameters<Playback['setParameters']>[0]): number {
    const changed = this.playback.setParameters(values);
    this.move(this.position);
    if (this.atEnd && this.playing) this.stop();
    this.emit();
    return changed;
  }

  /** Stops the timer and removes all listeners; play does nothing afterwards. */
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }

  /** Manual navigation keeps playback running and restarts the interval. */
  private navigate(cursor: number): void {
    if (!this.move(cursor)) return;
    if (this.playing) {
      if (this.atEnd) this.stop();
      else this.schedule();
    }
    this.emit();
  }

  /** Moves the cursor, clamped to 0..length; returns whether it changed. */
  private move(cursor: number): boolean {
    const target = Math.max(0, Math.min(this.playback.length, Math.trunc(cursor)));
    if (target === this.position) return false;
    this.playback.snapshot(target);
    this.position = target;
    return true;
  }

  /** Replaces any pending timer with one for the next step. */
  private schedule(): void {
    this.clock.clearTimeout(this.timer);
    const token = {};
    this.token = token;
    this.timer = this.clock.setTimeout(() => this.tick(token), STEP_INTERVAL_MS / this.rate);
  }

  private tick(token: object): void {
    if (!this.playing || token !== this.token) return;
    this.move(this.position + 1);
    if (this.atEnd) this.stop();
    else this.schedule();
    this.emit();
  }

  private stop(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.token = undefined;
    this.playing = false;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this);
  }
}
