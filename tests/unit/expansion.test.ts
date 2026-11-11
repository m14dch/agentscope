import { describe, expect, it } from 'vitest';
import { currentGroupKey } from '../../src/diagram/model.ts';
import { Expansion } from '../../src/diagram/expansion.ts';
import { loadRegistry } from '../../src/scenarios/registry.ts';

// mcp-balance groups by step: setup 1-3, discovery 4-8, question 9, planning 10-12,
// tool 13-16, backend 17-21, tool#2 22-24, context 25, generation 26-27, answer 28.
const found = loadRegistry()['mcp-balance'];
if (!found) throw new Error('no scenario mcp-balance');
const scn = found;

/** An Expansion driven by the cursor, as DiagramView drives it on every render. */
function at(expansion: Expansion, cursor: number): string[] {
  expansion.follow(currentGroupKey(scn, cursor));
  return [...expansion.expanded].sort();
}

describe('current group', () => {
  it('names the group holding the step at the cursor, none at step 0', () => {
    expect(currentGroupKey(scn, 0)).toBeUndefined();
    expect(currentGroupKey(scn, 12)).toBe('planning');
    expect(currentGroupKey(scn, 23)).toBe('tool#2');
  });
});

describe('expansion as the cursor moves (02 zoom_levels.architecture_groups)', () => {
  it('opens the group the cursor enters and closes it when the cursor leaves', () => {
    const e = new Expansion();
    expect(at(e, 0)).toEqual([]);
    // Forward through every step: exactly the current group is open.
    for (let cursor = 1; cursor <= scn.events.length; cursor++) {
      expect(at(e, cursor)).toEqual([currentGroupKey(scn, cursor)]);
    }
    // Back, a jump and Reset.
    expect(at(e, 27)).toEqual(['generation']);
    expect(at(e, 12)).toEqual(['planning']);
    expect(at(e, 0)).toEqual([]);
  });

  it('keeps a group the learner collapsed closed until the cursor enters it again', () => {
    const e = new Expansion();
    at(e, 10);
    e.toggle('planning');
    expect(at(e, 11)).toEqual([]);
    expect(at(e, 12)).toEqual([]);
    expect(at(e, 13)).toEqual(['tool']);
    // Back into the group: it reopens.
    expect(at(e, 12)).toEqual(['planning']);
  });

  it('keeps the groups the learner expanded, wherever the cursor goes', () => {
    const e = new Expansion();
    at(e, 1);
    e.toggle('answer');
    expect(at(e, 4)).toEqual(['answer', 'discovery']);
    // Collapsing the cursor's group and expanding it again makes it the learner's.
    e.toggle('discovery');
    e.toggle('discovery');
    expect(at(e, 9)).toEqual(['answer', 'discovery', 'question']);
    // Entering and leaving a learner's group leaves it open.
    expect(at(e, 28)).toEqual(['answer', 'discovery']);
    expect(at(e, 0)).toEqual(['answer', 'discovery']);
    // The learner can collapse it while it is current; it stays closed there.
    at(e, 28);
    e.toggle('answer');
    expect(at(e, 28)).toEqual(['discovery']);
  });
});
