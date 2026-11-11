import { describe, expect, it } from 'vitest';
import { activeWorkerReady, STATUS_MESSAGE } from '../../src/app/offline.ts';

/** A service worker that answers the status question with `ready`. */
class FakeWorker extends EventTarget {
  state: ServiceWorkerState;
  readonly ready: boolean;
  asked = 0;
  constructor(state: ServiceWorkerState, ready = true) {
    super();
    this.state = state;
    this.ready = ready;
  }
  postMessage(_message: unknown, [port]: MessagePort[]): void {
    this.asked += 1;
    port?.postMessage({ type: STATUS_MESSAGE, ready: this.ready });
  }
  to(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

const asWorker = (w: FakeWorker | null) => w as unknown as ServiceWorker | null;

describe('offline readiness (01 deployment offline_mechanics readiness)', () => {
  it('asks the active worker once it is activated', async () => {
    const worker = new FakeWorker('activating');
    const pending = activeWorkerReady({ active: asWorker(worker) });
    worker.to('activated');
    expect(await pending).toBe(true);
    expect(worker.asked).toBe(1);
  });

  it('does not show readiness the worker does not confirm', async () => {
    const worker = new FakeWorker('activated', false);
    expect(await activeWorkerReady({ active: asWorker(worker) })).toBe(false);
  });

  it('asks the new active worker when the one it waited for becomes redundant', async () => {
    const old = new FakeWorker('activating');
    const registration = { active: asWorker(old) };
    const pending = activeWorkerReady(registration);
    const replacement = new FakeWorker('activated');
    registration.active = asWorker(replacement);
    old.to('redundant');
    expect(await pending).toBe(true);
    expect(old.asked).toBe(0);
    expect(replacement.asked).toBe(1);
  });

  it('gives up without a worker, or when the redundant worker is still the active one', async () => {
    expect(await activeWorkerReady({ active: null })).toBe(false);
    const worker = new FakeWorker('redundant');
    expect(await activeWorkerReady({ active: asWorker(worker) })).toBe(false);
    expect(worker.asked).toBe(0);
  });
});
