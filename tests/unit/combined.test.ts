import { describe, expect, it } from 'vitest';
import { Player } from '../../src/engine/player.ts';
import {
  answerStatements,
  combinedModel,
  money,
  partSource,
  STATEMENT_LABELS,
} from '../../src/inspector/combined.ts';
import { createPlayback, ragDerivation } from '../../src/rag/bundled.ts';
import { answerComposition, answerCompositionProblem } from '../../src/rag/derive.ts';
import type { AnswerPart } from '../../src/rag/engine.ts';
import { loadRegistry, specSources } from '../../src/scenarios/registry.ts';
import type { Scenario } from '../../src/scenarios/types.ts';

const registry = loadRegistry();
const derivation = ragDerivation();
interface Case {
  id: string;
  expected_answer: string;
  expected_sources: string[];
}
const combined = specSources().comparison.combined as unknown as Case & { variants: Case[] };
const cases = [combined, ...combined.variants];
const composition = answerComposition(specSources());

const scenario = (id: string): Scenario => registry[id] as Scenario;
const partsOf = (id: string): AnswerPart[] => derivation.combinedAnswer(scenario(id), {}).parts;

/** The model at a step, or at the last step. */
function at(id: string, step?: number) {
  const player = new Player(createPlayback(scenario(id)));
  player.jump(step ?? player.playback.length);
  const parts = registry[id]?.derived_events?.includes('c-08') ? partsOf(id) : [];
  return combinedModel(player.playback.events, player.cursor, parts);
}

describe('Combined answer parts (06 answer_composition.rule, 05 answer_rules)', () => {
  it.each(cases)('$id: the parts compose exactly the expected answer', (c) => {
    const parts = partsOf(c.id);
    expect(parts.map((p) => p.text).join(' ')).toBe(c.expected_answer);
    // The intro sentences come first, with the sources the specifications give them.
    expect(parts.slice(0, composition.intro.length)).toEqual(
      composition.intro.map((s) => ({ kind: 'intro', source: s.source, text: s.text })),
    );
    // Each answer group is its own part, then the gap sentence, then the comparison.
    const kinds = parts.map((p) => p.kind);
    expect(kinds.filter((k) => k === 'group').length).toBeGreaterThan(1);
    expect(kinds.slice(-2)).toEqual(['gap', 'comparison']);
  });

  it('states the missing Savings terms instead of comparing', () => {
    const parts = partsOf('combined-missing-terms');
    expect(parts.find((p) => p.kind === 'gap')?.text).toContain(
      "the Savings account's fee and interest",
    );
    expect(parts.at(-1)?.text).toBe(composition.comparisons[1]?.sentence);
    expect(partsOf(combined.id).at(-1)?.text).toBe(composition.comparisons[0]?.sentence);
  });

  it('reports a malformed composition by name', () => {
    expect(answerCompositionProblem(composition)).toBeUndefined();
    expect(answerCompositionProblem({ ...composition, intro: 'Your balance.' })).toMatch(/^intro/);
    expect(
      answerCompositionProblem({ ...composition, intro: [{ source: 'guess', text: 'x' }] }),
    ).toMatch(/^intro/);
    expect(answerCompositionProblem({ ...composition, comparisons: [{}] })).toMatch(/comparison/);
    expect(answerCompositionProblem(undefined)).toBe('missing');
  });
});

describe('Combined answer statements (02 combined_answer.statements)', () => {
  it.each(cases)('$id: one statement per part, labelled by its kind', (c) => {
    const parts = partsOf(c.id);
    const statements = answerStatements(c.expected_answer, parts);
    expect(statements).toEqual(parts.map((p) => ({ source: partSource(p), text: p.text })));
    expect(statements.map((s) => s.text).join(' ')).toBe(c.expected_answer);
    const labels = statements.map((s) => STATEMENT_LABELS[s.source ?? 'gap']);
    expect(labels.slice(0, 2)).toEqual(['Tool data · MCP', 'Session context']);
    expect(labels.at(-2)).toBe('Not in the evidence');
    expect(labels.at(-1)).toBe('Comparison');
    expect(labels.slice(2, -2).every((l) => l === 'Document evidence · RAG')).toBe(true);
  });

  it('labels every kind of part', () => {
    expect(
      (
        [
          { kind: 'intro', source: 'tool', text: '' },
          { kind: 'intro', source: 'session', text: '' },
          { kind: 'group', text: '' },
          { kind: 'conflict', text: '' },
          { kind: 'gap', text: '' },
          { kind: 'no-evidence', text: '' },
          { kind: 'note', text: '' },
          { kind: 'comparison', text: '' },
        ] as AnswerPart[]
      ).map(partSource),
    ).toEqual(['tool', 'session', 'documents', 'documents', 'gap', 'gap', 'note', 'comparison']);
  });

  it('shows an answer its parts do not compose as one unlabelled statement', () => {
    const parts = partsOf(combined.id);
    expect(answerStatements('Something else.', parts)).toEqual([{ text: 'Something else.' }]);
  });

  it('writes amounts as the answer does', () => {
    expect(money('CHF', 12500.75)).toBe('CHF 12,500.75');
    expect(money('CHF', 5)).toBe('CHF 5.00');
  });
});

describe('Combined answer model', () => {
  it('appears only once the answer is displayed (c-08)', () => {
    expect(at(combined.id, 34)).toBeUndefined();
    expect(at(combined.id, 35)).toBeDefined();
    // Scenarios without the Combined answer have none.
    expect(at('rag-query')).toBeUndefined();
    expect(at('mcp-balance')).toBeUndefined();
  });

  it.each(cases)(
    '$id: links the balance to the tool result and cites the expected sources',
    (c) => {
      const model = at(c.id);
      expect(model?.tool).toEqual({
        tool: 'get_customer_balance',
        arguments: { customerId: '123' },
        result: { customerId: '123', currency: 'CHF', balance: 12500.75 },
        balance: 'CHF 12,500.75',
        // The tools/call result, and the follow-up model request that contains it (c-06).
        step: 30,
        sentStep: 33,
      });
      expect(model?.sources.map((s) => s.line)).toEqual(c.expected_sources);
      expect(model?.statements.map((s) => s.text).join(' ')).toBe(c.expected_answer);
      expect(model?.statements.every((s) => s.source)).toBe(true);
      const events = createPlayback(scenario(c.id)).events;
      expect(events[29]?.operation).toBe('tools/call result');
      expect(events[32]?.id).toBe(`${c.id}:c-06`);
    },
  );
});
