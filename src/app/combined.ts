/**
 * Wires the Combined answer's provenance (02-ui-ux.yaml combined_answer) into a scenario
 * view: the panel exists for scenarios that display the Combined answer (c-08). It reads the
 * played events, the answer's parts as the engine composes them for the scenario, and the
 * index the scenario searches.
 */
import type { Player } from '../engine/player.ts';
import { CombinedPanel, combinedModel } from '../inspector/combined.ts';
import { ragDerivation } from '../rag/bundled.ts';
import { type AnswerPart, corpusOverrides } from '../rag/engine.ts';
import type { Scenario } from '../scenarios/types.ts';
import '../styles/combined.css';

export interface CombinedView {
  root: HTMLElement;
  /** Shows the panel for the player's current step. */
  update: () => void;
}

export function combinedPanel(
  scenario: Scenario,
  player: Player,
  actions: { jump: (step: number) => void; leave: () => void },
): CombinedView | undefined {
  if (!scenario.derived_events?.includes('c-08')) return undefined;
  const derivation = ragDerivation();
  const { engine } = derivation;
  const docs = engine.corpus(corpusOverrides(scenario.fixture_overrides));
  // The Combined scenario has no parameters: its index is chunked at the defaults.
  const p = derivation.parameters(player.playback.retrievalConfig);
  const searched = {
    docs,
    chunks: engine.chunks(docs, p.chunkSize, p.overlap),
    trustOf: (id: string) => engine.trustOf(id),
    // Citations open chunks only; nothing here is projected.
    project: () => ({ x: 0, y: 0 }),
  };
  // The answer's parts at the current parameters, computed once per configuration.
  let parts: { key: string; parts: readonly AnswerPart[] } | undefined;
  const partsNow = (): readonly AnswerPart[] => {
    const config = player.playback.retrievalConfig;
    const key = JSON.stringify(config);
    if (parts?.key !== key)
      parts = { key, parts: derivation.combinedAnswer(scenario, config).parts };
    return parts.parts;
  };
  const panel = new CombinedPanel({ index: () => searched, ...actions });
  return {
    root: panel.root,
    update: () => panel.update(combinedModel(player.playback.events, player.cursor, partsNow())),
  };
}
