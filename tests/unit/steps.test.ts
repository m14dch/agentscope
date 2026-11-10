import { describe, expect, it } from 'vitest';
import { fromDefaultStep, toDefaultStep } from '../../src/engine/steps.ts';
import { createPlayback } from '../../src/rag/bundled.ts';
import { loadRegistry } from '../../src/scenarios/registry.ts';
import type { Scenario, ScenarioEvent } from '../../src/scenarios/types.ts';

const registry = loadRegistry();
const ids = (events: readonly ScenarioEvent[]) => events.map((e) => e.id);

describe('route steps numbered at the default parameters (02 navigation.route_steps)', () => {
  const playback = createPlayback(registry['rag-query'] as Scenario);
  const defaults = playback.events;
  // Fetching full documents adds retrieve-07 and retrieve-08 after retrieve-06.
  playback.setParameters({ fetch_full_documents: true });
  const current = playback.events;
  const added = current.length - defaults.length;
  const at = (events: readonly ScenarioEvent[], id: string) => ids(events).indexOf(id) + 1;

  it('adds steps that are not played at the defaults', () => {
    expect(added).toBe(2);
    expect(at(defaults, 'retrieve-07')).toBe(0);
  });

  it('writes the current event at its default step', () => {
    for (const id of ['retrieve-01', 'retrieve-06', 'retrieve-09', 'retrieve-12']) {
      expect(toDefaultStep(defaults, current, at(current, id))).toBe(at(defaults, id));
    }
    expect(toDefaultStep(defaults, current, 0)).toBe(0);
  });

  it('writes an event not played at the defaults as the nearest earlier one that is', () => {
    const six = at(defaults, 'retrieve-06');
    expect(toDefaultStep(defaults, current, at(current, 'retrieve-07'))).toBe(six);
    expect(toDefaultStep(defaults, current, at(current, 'retrieve-08'))).toBe(six);
  });

  it('reads a default step as the event played there at the defaults', () => {
    for (const id of ['retrieve-01', 'retrieve-06', 'retrieve-09', 'retrieve-12']) {
      expect(fromDefaultStep(defaults, current, at(defaults, id))).toBe(at(current, id));
    }
    expect(fromDefaultStep(defaults, current, 0)).toBe(0);
    // Beyond the scenario is clamped to its last event.
    expect(fromDefaultStep(defaults, current, 999)).toBe(current.length);
  });

  it('reads a default event that is not played now as the nearest earlier one that is', () => {
    // Numbered with fetch_full_documents on and read against the true defaults:
    // retrieve-07 is not played there, so the cursor goes to retrieve-06.
    const p = createPlayback(registry['rag-query'] as Scenario);
    p.setParameters({ fetch_full_documents: true });
    const withFetch = p.events;
    expect(fromDefaultStep(withFetch, defaults, at(withFetch, 'retrieve-07'))).toBe(
      at(defaults, 'retrieve-06'),
    );
  });

  it('is the identity at the defaults', () => {
    for (let k = 0; k <= defaults.length; k += 1) {
      expect(toDefaultStep(defaults, defaults, k)).toBe(k);
      expect(fromDefaultStep(defaults, defaults, k)).toBe(k);
    }
  });
});
