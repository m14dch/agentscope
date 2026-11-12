/**
 * Wires the Combined answer's provenance (02-ui-ux.yaml combined_answer) into a scenario
 * view: the panel exists for scenarios that display the Combined answer (c-08). It reads the
 * played events, the answer's parts as the engine composes them, and the index searched.
 */
import type { Player } from '../engine/player.ts';
import { CombinedPanel, combinedModel } from '../inspector/combined.ts';
import { ragDerivation } from '../rag/bundled.ts';
import type { Scenario } from '../scenarios/types.ts';
import '../styles/combined.css';

export interface CombinedView {
  root: HTMLElement;
  /** Shows the panel for a step: the player's current one unless given. */
  update: (cursor?: number) => void;
}

export function combinedPanel(
  scenario: Scenario,
  player: Player,
  actions: { jump: (step: number) => void; leave: () => void },
): CombinedView | undefined {
  if (!scenario.derived_events?.includes('c-08')) return undefined;
  const derivation = ragDerivation();
  const { engine } = derivation;
  const docs = engine.corpus();
  // The Combined scenario has no parameters: its index, retrieval and answer use the defaults.
  const p = derivation.parameters(player.playback.retrievalConfig);
  const searched = {
    docs,
    chunks: engine.chunks(docs, p.chunkSize, p.overlap),
    // Citations open chunks only; nothing here is projected.
    project: () => ({ x: 0, y: 0 }),
  };
  const { parts } = derivation.combinedAnswer(player.playback.retrievalConfig);
  const panel = new CombinedPanel({ index: () => searched, ...actions });
  return {
    root: panel.root,
    update: (cursor = player.cursor) =>
      panel.update(combinedModel(player.playback.events, cursor, parts)),
  };
}
