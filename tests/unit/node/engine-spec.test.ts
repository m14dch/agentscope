import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SPEEDS, STEP_INTERVAL_MS } from '../../../src/engine/player.ts';

const ui = parse(
  readFileSync(join(import.meta.dirname, '../../../specifications/02-ui-ux.yaml'), 'utf8'),
) as {
  controls: { speeds: number[]; step_interval_ms: number };
};

describe('player constants', () => {
  it('match 02-ui-ux.yaml controls', () => {
    expect([...SPEEDS]).toEqual(ui.controls.speeds);
    expect(STEP_INTERVAL_MS).toBe(ui.controls.step_interval_ms);
  });
});
