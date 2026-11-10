import { describe, expect, it } from 'vitest';
import { Player } from '../../src/engine/player.ts';
import {
  answerStatements,
  combinedModel,
  type Composition,
  money,
} from '../../src/inspector/combined.ts';
import { createPlayback } from '../../src/rag/bundled.ts';
import { loadRegistry, specSources } from '../../src/scenarios/registry.ts';
import type { Scenario } from '../../src/scenarios/types.ts';

const registry = loadRegistry();
interface Case {
  id: string;
  expected_answer: string;
  expected_sources: string[];
}
const combined = specSources().comparison.combined as unknown as Case & {
  answer_composition: Composition;
  variants: Case[];
};
const composition = combined.answer_composition;

/** The model at a step, or at the last step. */
function at(id: string, step?: number) {
  const player = new Player(createPlayback(registry[id] as Scenario));
  player.jump(step ?? player.playback.length);
  return combinedModel(player.playback.events, player.cursor, composition);
}

describe('Combined answer statements (02 combined_answer.statements)', () => {
  it('labels each statement of both Combined answers by its source', () => {
    for (const c of [combined, ...combined.variants]) {
      const statements = answerStatements(c.expected_answer, composition);
      expect(statements.map((s) => s.source)).toEqual([
        'tool',
        'session',
        'documents',
        'gap',
        'comparison',
      ]);
      // Joined by single spaces they are exactly the answer.
      expect(statements.map((s) => s.text).join(' ')).toBe(c.expected_answer);
      expect(statements[0]?.text).toBe(
        'Your current balance is CHF 12,500.75 (source: get_customer_balance tool).',
      );
      expect(statements[1]?.text).toBe('You have an Everyday account.');
      expect(statements[2]?.text).toMatch(/^Opening an account: .*\[\d\]\.$/);
      expect(statements[3]?.text).toMatch(/^The retrieved evidence does not cover .*\.$/);
    }
    const [base, gap] = [combined, ...combined.variants].map((c) =>
      answerStatements(c.expected_answer, composition),
    );
    expect(base?.[4]?.text).toBe(composition.comparisons[0]?.sentence);
    // The missing Savings terms are stated, and no comparison is made.
    expect(gap?.[3]?.text).toContain("the Savings account's fee and interest");
    expect(gap?.[4]?.text).toBe(
      "Without the Savings account terms I can't say whether another account type would offer better conditions.",
    );
  });

  it('keeps an answer without the intro, the gap or a comparison as cited statements', () => {
    expect(answerStatements('Fees are low [1].', composition)).toEqual([
      { source: 'documents', text: 'Fees are low [1].' },
    ]);
    expect(answerStatements('The retrieved evidence does not cover fees.', composition)).toEqual([
      { source: 'gap', text: 'The retrieved evidence does not cover fees.' },
    ]);
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

  it.each([combined, ...combined.variants])(
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
      const events = createPlayback(registry[c.id] as Scenario).events;
      expect(events[29]?.operation).toBe('tools/call result');
      expect(events[32]?.id).toBe(`${c.id}:c-06`);
    },
  );
});
