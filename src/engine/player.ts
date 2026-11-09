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
  private readonly listeners = new Set<(player: Player) => void>();

  constructor(
    readonly playback: Playback,
    private readonly clock: Clock = browserClock,
  ) {}

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

  /** Go to the first step. */
  start(): void {
    this.go(Math.min(1, this.playback.length));
  }

  next(): void {
    this.go(this.position + 1);
  }

  previous(): void {
    this.go(this.position - 1);
  }

  jump(cursor: number): void {
    this.go(cursor);
  }

  /** Return to the initial state before any step and pause. */
  reset(): void {
    this.stop();
    this.go(0);
  }

  play(): void {
    if (this.playing || this.atEnd) return;
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
    if (this.playing) {
      this.clock.clearTimeout(this.timer);
      this.schedule();
    }
    this.emit();
  }

  /** Moves the cursor, clamped to 0..length. Manual navigation keeps playback running. */
  private go(cursor: number): void {
    const target = Math.max(0, Math.min(this.playback.length, Math.trunc(cursor)));
    if (target === this.position) return;
    this.playback.snapshot(target);
    this.position = target;
    if (this.atEnd && this.playing) this.stop();
    this.emit();
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => this.tick(), STEP_INTERVAL_MS / this.rate);
  }

  private tick(): void {
    if (!this.playing) return;
    this.go(this.position + 1);
    if (this.playing) this.schedule();
  }

  private stop(): void {
    this.clock.clearTimeout(this.timer);
    this.playing = false;
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this);
  }
}
