// 02-ui-ux.yaml phone_steps: the rows of the phone column for each zoom level and Compare.
import { describe, expect, it } from 'vitest';
import {
  type CompareSide,
  compareColumn,
  direction,
  eventRows,
  groupAt,
  groupRows,
  participantsLine,
  stageItems,
} from '../../src/phone/rows.ts';
import { createPlayback } from '../../src/rag/bundled.ts';
import { loadRegistry, participantLabels, specSources } from '../../src/scenarios/registry.ts';
import type { Scenario } from '../../src/scenarios/types.ts';

const registry = loadRegistry();
const labels = participantLabels();
const { compare, semantic_phases } = specSources().comparison;

function scenario(id: string): Scenario {
  const scn = registry[id];
  if (!scn) throw new Error(`no scenario ${id}`);
  return scn;
}

const events = (id: string) => createPlayback(scenario(id)).events;

describe('direction glyphs (phone_steps.rows.glyph)', () => {
  it('sends requests and actions, answers responses and results, and sends nothing inside one participant', () => {
    const base = { sender: 'agent', receiver: 'mcp-client' } as const;
    expect(direction({ ...base, message_type: 'REQUEST' })).toBe('request');
    expect(direction({ ...base, message_type: 'ACTION' })).toBe('request');
    expect(direction({ ...base, message_type: 'RESPONSE' })).toBe('response');
    expect(direction({ ...base, message_type: 'RESULT' })).toBe('response');
    expect(direction({ sender: 'agent', receiver: 'agent', message_type: 'ACTION' })).toBe('local');
  });

  it('writes the participants out, and "nothing sent" for a computation', () => {
    expect(participantsLine({ sender: 'mcp-client', receiver: 'mcp-server' }, labels)).toBe(
      `${labels['mcp-client']} → ${labels['mcp-server']}`,
    );
    expect(participantsLine({ sender: 'agent', receiver: 'agent' }, labels)).toBe(
      `${labels['agent']} · nothing sent`,
    );
  });
});

describe('rows per level', () => {
  it('Protocol: one row per played event, numbered from 1', () => {
    const rows = eventRows(events('mcp-balance'), labels);
    expect(rows).toHaveLength(28);
    expect(rows[13]).toMatchObject({ step: 14, label: 'MCP · tools/call', direction: 'request' });
  });

  it('Architecture: one row per run of a phase; a continued run names its phase once', () => {
    const scn = scenario('mcp-balance');
    const groups = groupRows(scn, events('mcp-balance'), labels);
    expect(groups.flatMap((g) => g.events.map((e) => e.step))).toEqual(
      Array.from({ length: 28 }, (_, i) => i + 1),
    );
    const continued = groups.find((g) => g.key.includes('#'));
    expect(continued?.title).toMatch(/, continued$/);
    expect(continued?.caption).toMatch(/^\d+ steps?$/);
    expect(groups[0]?.title).toBe(scn.phases[0]?.takeaway);
    expect(groupAt(groups, 14)?.events.some((e) => e.step === 14)).toBe(true);
    expect(groupAt(groups, 0)).toBeUndefined();
  });

  it('Overview: every stage with the parties its events involve', () => {
    const items = stageItems(scenario('mcp-balance'), events('mcp-balance'));
    expect(items).toHaveLength(4);
    expect(items[0]?.parties).toBe('Assistant · Bank systems');
    expect(items.every((s) => s.first > 0 && s.last >= s.first)).toBe(true);
  });
});

describe('Compare as one column (phone_steps.compare)', () => {
  const side = (id: string, label: string): CompareSide => ({
    label,
    scenario: scenario(id),
    events: events(id),
    semanticOf: compare.phase_mapping[id] ?? {},
    placeholders: compare.placeholders?.[id] ?? {},
  });
  const sides = [side(compare.left_scenario, 'RAG'), side(compare.right_scenario, 'MCP')] as const;
  const column = compareColumn(semantic_phases, sides, (s) =>
    eventRows(s.events, labels).map((unit) => ({ unit, firstEvent: unit.event })),
  );

  it('lists every event of both scenarios once, left before right in each phase', () => {
    const steps = (i: 0 | 1) =>
      column.flatMap((p) =>
        p.entries.flatMap((e) => (e.side === i && e.kind === 'unit' ? [e.unit.step] : [])),
      );
    expect(steps(0)).toEqual(Array.from({ length: sides[0].events.length }, (_, i) => i + 1));
    expect(steps(1)).toEqual(Array.from({ length: sides[1].events.length }, (_, i) => i + 1));
    for (const phase of column) {
      const order = phase.entries.map((e) => e.side);
      expect(order).toEqual([...order].sort());
    }
  });

  it('shows a placeholder for a side without events in the phase, in semantic order', () => {
    expect(column.map((p) => p.id)).toEqual(
      semantic_phases.map((p) => p.id).filter((id) => column.some((c) => c.id === id)),
    );
    const preparation = column[0];
    expect(preparation?.entries[0]).toEqual({
      side: 0,
      kind: 'placeholder',
      text: compare.placeholders?.[compare.left_scenario]?.[preparation?.id ?? ''],
    });
  });
});
