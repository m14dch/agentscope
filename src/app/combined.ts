/**
 * Wires the Combined answer's provenance (02-ui-ux.yaml combined_answer) into a scenario
 * view: the panel exists for scenarios that display the Combined answer (c-08), and reads
 * the played events and the index the scenario searches.
 */
import type { Player } from '../engine/player.ts';
import { CombinedPanel, type Composition, combinedModel } from '../inspector/combined.ts';
import { ragDerivation } from '../rag/bundled.ts';
import { corpusOverrides } from '../rag/engine.ts';
import type { Scenario, SpecSources } from '../scenarios/types.ts';
import '../styles/combined.css';

export interface CombinedView {
  root: HTMLElement;
  /** Shows the panel for the player's current step. */
  update: () => void;
}

export function combinedPanel(
  scenario: Scenario,
  player: Player,
  sources: SpecSources,
  actions: { jump: (step: number) => void; leave: () => void },
): CombinedView | undefined {
  if (!scenario.derived_events?.includes('c-08')) return undefined;
  const composition = (
    sources.comparison.combined as unknown as { answer_composition: Composition }
  ).answer_composition;
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
  const panel = new CombinedPanel({ composition, index: () => searched, ...actions });
  return {
    root: panel.root,
    update: () => panel.update(combinedModel(player.playback.events, player.cursor, composition)),
  };
}
