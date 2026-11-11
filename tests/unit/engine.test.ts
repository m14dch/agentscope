import { describe, expect, it } from 'vitest';
import { Playback, type Snapshot } from '../../src/engine/playback.ts';
import { type Clock, Player, SPEEDS, STEP_INTERVAL_MS } from '../../src/engine/player.ts';
import { applyEvent, EngineError, initialSnapshot } from '../../src/engine/reducer.ts';
import { loadRegistry } from '../../src/scenarios/registry.ts';
import type { Scenario, ScenarioEvent } from '../../src/scenarios/types.ts';

const registry = loadRegistry();
const scenarios = Object.values(registry);

const all = (p: Playback): Snapshot[] =>
  Array.from({ length: p.length + 1 }, (_, k) => p.snapshot(k));
const plain = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function scenario(id: string): Scenario {
  const scn = registry[id];
  if (!scn) throw new Error(`no scenario ${id}`);
  return scn;
}

function cursorOf(p: Playback, eventId: string): number {
  for (let k = 1; k <= p.length; k += 1) if (p.event(k)?.id === eventId) return k;
  throw new Error(`no event ${eventId}`);
}

describe('snapshots', () => {
  it('start from the initial state at cursor 0', () => {
    const p = new Playback(scenario('mcp-balance'));
    const s = p.snapshot(0);
    expect(s.cursor).toBe(0);
    expect(s.selected_event_id).toBeUndefined();
    expect(s.state).toEqual(scenario('mcp-balance').initial_state);
    expect(s.lineage).toEqual({});
  });

  it('are identical whatever the order of access, and across instances', () => {
    for (const scn of scenarios) {
      const forward = plain(all(new Playback(scn)));
      const p = new Playback(scn);
      const order = Array.from({ length: p.length + 1 }, (_, k) => (k * 7919) % (p.length + 1));
      const shuffled: unknown[] = [];
      for (const k of order) shuffled[k] = plain(p.snapshot(k));
      expect(shuffled, scn.id).toEqual(forward);
    }
  });

  it('are deeply frozen and never share state with the scenario', () => {
    const scn = scenario('mcp-balance');
    const p = new Playback(scn);
    const s = p.snapshot(p.length);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.state['mcp_state'])).toBe(true);
    expect(() => (s.state['agent_state'] as unknown[]).push(1)).toThrow(TypeError);
    expect(Object.isFrozen(scn.initial_state)).toBe(false);
  });

  it('fill the MCP state, agent working memory and model-visible context', () => {
    const p = new Playback(scenario('mcp-balance'));
    const s = p.snapshot(p.length);
    const mcp = s.state['mcp_state'] as {
      server: { supportedVersions: string[] };
      discovered_tools: unknown[];
    };
    expect(mcp.server.supportedVersions).toEqual(['2026-07-28']);
    expect(mcp.discovered_tools.length).toBeGreaterThan(0);
    const memory = s.state['agent_state'] as { event: string; description: string }[];
    expect(memory[0]).toEqual({
      event: 'mcp-09',
      description: 'User question received',
      value: 'What is the current balance of my bank account?',
    });
    expect(memory.map((m) => m.event)).toEqual(expect.arrayContaining(['mcp-24', 'mcp-25']));
    expect(s.lineage['balance']?.map((l) => l.value)).toContain(12500.75);
  });

  it('show a tool result to the model only from the LLM request that submits it', () => {
    const p = new Playback(scenario('mcp-balance'));
    const visible = (id: string): string =>
      JSON.stringify(p.snapshot(cursorOf(p, id)).state['model_visible_messages']);
    const memory = (id: string): string =>
      JSON.stringify(p.snapshot(cursorOf(p, id)).state['agent_state']);
    expect(memory('mcp-25')).toContain('12500.75');
    expect(visible('mcp-25')).not.toContain('12500.75');
    expect(visible('mcp-26')).toContain('12500.75');
  });

  it('show retrieved text to the model only from the LLM request that submits it', () => {
    const p = new Playback(scenario('rag-query'));
    const retained = p.snapshot(cursorOf(p, 'retrieve-06')).state['retrieval'] as {
      retained: string[];
    };
    expect(retained.retained).toHaveLength(5);
    const prompt = JSON.stringify(p.snapshot(cursorOf(p, 'retrieve-09')).state['agent_state']);
    // The assembled prompt names the retrieved chunks; their text reaches the model at retrieve-10.
    expect(prompt).toContain('account-opening@1.2-c50o10-001');
    const text = 'Anyone aged 18 or over';
    expect(
      JSON.stringify(p.snapshot(cursorOf(p, 'retrieve-09')).state['model_visible_messages']),
    ).not.toContain(text);
    expect(
      JSON.stringify(p.snapshot(cursorOf(p, 'retrieve-10')).state['model_visible_messages']),
    ).toContain(text);
  });

  it('show the model exactly the latest LLM request, in every scenario', () => {
    for (const scn of scenarios) {
      const p = new Playback(scn);
      let latest: unknown = scn.initial_state['model_visible_messages'];
      let requests = 0;
      for (let k = 1; k <= p.length; k += 1) {
        const e = p.event(k) as ScenarioEvent;
        if (e.protocol === 'LLM_API' && e.message_type === 'REQUEST') {
          latest = e.payload;
          requests += 1;
        }
        expect(plain(p.snapshot(k).state['model_visible_messages']), `${scn.id} at ${k}`).toEqual(
          plain(latest),
        );
      }
      if (scn.initial_state['model_visible_messages'] !== undefined)
        expect(requests, scn.id).toBeGreaterThan(0);
    }
  });
});

describe('isolation', () => {
  it('copies the events, so later changes to the registry do not reach snapshots', () => {
    const scn = structuredClone(scenario('mcp-balance'));
    const p = new Playback(scn);
    (scn.events[2] as ScenarioEvent).state_changes = [
      { path: 'mcp_state.server', op: 'set', value: 'changed' },
    ];
    expect(JSON.stringify(p.snapshot(3).state['mcp_state'])).not.toContain('changed');
    expect(Object.isFrozen(p.event(1))).toBe(true);
    expect(Object.isFrozen(p.retrievalConfig)).toBe(true);
  });
});

describe('reducer errors', () => {
  const base = scenario('mcp-balance');
  const first = base.events[0] as ScenarioEvent;

  it('names the scenario and event of a change it cannot apply', () => {
    const bad = {
      ...first,
      id: 'x',
      state_changes: [{ path: 'nowhere.deep', op: 'set' as const, value: 1 }],
    };
    expect(() => applyEvent(initialSnapshot(base), bad, 'mcp-balance')).toThrow(
      new EngineError(
        'mcp-balance/x',
        'state_change path nowhere.deep has no parent in the snapshot',
      ),
    );
    const append = {
      ...first,
      id: 'y',
      state_changes: [{ path: 'mcp_state.server', op: 'append' as const, value: 1 }],
    };
    expect(() => applyEvent(initialSnapshot(base), append, 'mcp-balance')).toThrow(
      /mcp-balance\/y: .*not a list/,
    );
  });
});

describe('parameter changes', () => {
  it('keep snapshots before the first changed event and recompute the rest', () => {
    const scn = scenario('rag-query');
    // The derived event's state change depends on top_k, so a stale snapshot would show.
    const derive = (s: Scenario, config: Readonly<Record<string, unknown>>): ScenarioEvent[] =>
      s.events.map((e) =>
        e.id === 'retrieve-06'
          ? {
              ...e,
              explanation: `top_k ${String(config['top_k'])}`,
              state_changes: [
                { path: 'retrieval.retained', op: 'set', value: [`k${String(config['top_k'])}`] },
              ],
            }
          : e,
      );
    const p = new Playback(scn, { deriveEvents: derive });
    const before = all(p);
    expect(before[0]?.retrieval_config['top_k']).toBe(5);
    const changed = p.setParameters({ top_k: 4 });
    expect(changed).toBe(cursorOf(p, 'retrieve-06'));
    const after = all(p);
    expect(after[changed - 1]?.state).toBe(before[changed - 1]?.state);
    expect(after[changed - 1]?.retrieval_config['top_k']).toBe(4);
    expect(p.event(changed)?.explanation).toBe('top_k 4');
    expect(after[changed]?.state['retrieval']).toEqual({ retained: ['k4'] });
    expect(after[p.length]?.state['retrieval']).toEqual({ retained: ['k4'] });
    expect(p.setParameters({ top_k: 4 })).toBe(p.length + 1);
    expect(() => p.setParameters({ nope: 1 })).toThrow(/has no parameter nope/);
    expect(() => p.setParameters({ top_k: 99 })).toThrow(/top_k 99 is outside 1..8/);
    expect(() => p.setParameters({ rerank: 'yes' })).toThrow(/rerank must be a boolean/);
    expect(() => p.setParameters({ top_k: Number.NaN })).toThrow(/top_k must be a finite number/);
    expect(() => p.setParameters({ top_k: 2.5 })).toThrow(/top_k must be a whole number/);
    expect(p.retrievalConfig['top_k']).toBe(4);
    const index = new Playback(scenario('rag-index'));
    expect(() => index.setParameters({ chunk_size_words: 37 })).toThrow(
      /chunk_size_words 37 is not one of 25, 50, 100/,
    );
    expect(index.setParameters({ chunk_size_words: 100 })).toBeGreaterThan(0);
  });
});

class FakeClock implements Clock {
  readonly timers = new Set<{ callback: () => void; ms: number }>();
  setTimeout(callback: () => void, ms: number): unknown {
    const timer = { callback, ms };
    this.timers.add(timer);
    return timer;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as { callback: () => void; ms: number });
  }
  get pending(): { callback: () => void; ms: number } | undefined {
    return [...this.timers][0];
  }
  fire(): void {
    const timer = this.pending;
    if (!timer) return;
    this.timers.delete(timer);
    timer.callback();
  }
}

describe('player', () => {
  const make = (): [Player, FakeClock] => {
    const clock = new FakeClock();
    return [new Player(new Playback(scenario('mcp-balance')), clock), clock];
  };

  it('starts, steps, jumps and resets within bounds', () => {
    const [player] = make();
    const n = player.playback.length;
    player.previous();
    expect(player.cursor).toBe(0);
    player.start();
    expect(player.cursor).toBe(1);
    player.next();
    player.next();
    expect(player.snapshot.selected_event_id).toBe('mcp-03');
    player.jump(n + 10);
    expect(player.cursor).toBe(n);
    player.next();
    expect(player.cursor).toBe(n);
    player.reset();
    expect(player.cursor).toBe(0);
    expect(player.status).toBe('paused');
  });

  it('reconstructs the same snapshot after previous, jump and reset', () => {
    const [player] = make();
    player.jump(12);
    const at12 = plain(player.snapshot);
    player.next();
    player.previous();
    expect(plain(player.snapshot)).toEqual(at12);
    player.reset();
    player.jump(12);
    expect(plain(player.snapshot)).toEqual(at12);
  });

  it('plays one step per interval at each speed and pauses at the end', () => {
    const [player, clock] = make();
    player.play();
    expect(player.status).toBe('playing');
    expect(clock.pending?.ms).toBe(STEP_INTERVAL_MS);
    clock.fire();
    expect(player.cursor).toBe(1);
    player.setSpeed(4);
    expect(clock.pending?.ms).toBe(STEP_INTERVAL_MS / 4);
    while (clock.pending) clock.fire();
    expect(player.cursor).toBe(player.playback.length);
    expect(player.status).toBe('paused');
    player.play();
    expect(player.status).toBe('paused');
  });

  it('pauses, toggles and notifies listeners', () => {
    const [player, clock] = make();
    const seen: string[] = [];
    const stop = player.subscribe((p) => seen.push(`${p.status}@${p.cursor}`));
    player.toggle();
    player.toggle();
    expect(clock.pending).toBeUndefined();
    player.next();
    stop();
    player.next();
    expect(seen).toEqual(['playing@0', 'paused@0', 'paused@1']);
    expect(() => player.setSpeed(3 as 1)).toThrow(RangeError);
    expect(SPEEDS).toEqual([0.5, 1, 2, 4]);
  });
});

describe('player edge cases', () => {
  const make = (scn = scenario('mcp-balance')): [Player, FakeClock] => {
    const clock = new FakeClock();
    return [new Player(new Playback(scn), clock), clock];
  };

  it('tells listeners when reset pauses playback at the initial state', () => {
    const [player, clock] = make();
    const seen: string[] = [];
    player.subscribe((p) => seen.push(`${p.status}@${p.cursor}`));
    player.play();
    player.reset();
    expect(seen).toEqual(['playing@0', 'paused@0']);
    expect(clock.timers.size).toBe(0);
  });

  it('keeps one timer when a listener changes speed during a tick', () => {
    const [player, clock] = make();
    player.subscribe((p) => {
      if (p.cursor === 1 && p.speed === 1) p.setSpeed(2);
    });
    player.play();
    clock.fire();
    expect(clock.timers.size).toBe(1);
    expect(clock.pending?.ms).toBe(STEP_INTERVAL_MS / 2);
  });

  it('restarts the interval after manual navigation while playing', () => {
    const [player, clock] = make();
    player.play();
    const first = clock.pending;
    player.next();
    expect(clock.timers.size).toBe(1);
    expect(clock.pending).not.toBe(first);
    expect(player.status).toBe('playing');
    player.jump(player.playback.length);
    expect(player.status).toBe('paused');
    expect(clock.timers.size).toBe(0);
  });

  it('clamps the cursor when a parameter change shortens the scenario', () => {
    const scn = scenario('rag-query');
    const derive = (s: Scenario, config: Readonly<Record<string, unknown>>): ScenarioEvent[] =>
      config['top_k'] === 1 ? s.events.slice(0, 5) : s.events;
    const player = new Player(new Playback(scn, { deriveEvents: derive }), new FakeClock());
    const seen: number[] = [];
    player.subscribe((p) => seen.push(p.cursor));
    player.jump(10);
    player.setParameters({ top_k: 1 });
    expect(player.cursor).toBe(5);
    expect(player.snapshot.cursor).toBe(5);
    expect(seen).toEqual([10, 5]);
  });

  it('stops and forgets listeners on dispose', () => {
    const [player, clock] = make();
    let calls = 0;
    player.subscribe(() => (calls += 1));
    player.play();
    player.dispose();
    expect(clock.timers.size).toBe(0);
    expect(player.status).toBe('paused');
    player.next();
    player.play();
    expect(calls).toBe(1);
    expect(clock.timers.size).toBe(0);
  });
});

describe('performance', () => {
  it('computes every snapshot of every scenario quickly', () => {
    const t0 = performance.now();
    let steps = 0;
    for (const scn of scenarios) steps += all(new Playback(scn)).length;
    const perStep = (performance.now() - t0) / steps;
    // A step must render well within one frame (16 ms); the reducer gets a small share.
    expect(perStep).toBeLessThan(2);
  });
});
