/** The RAG engine over the bundled specifications, and playbacks that use it. */
import { Playback } from '../engine/playback.ts';
import { specSources } from '../scenarios/registry.ts';
import type { Scenario } from '../scenarios/types.ts';
import { RagDerivation } from './derive.ts';

let cached: RagDerivation | undefined;

export function ragDerivation(): RagDerivation {
  cached ??= new RagDerivation(specSources());
  return cached;
}

/** A playback whose derived events (RAG and Combined scenarios) come from the RAG engine. */
export function createPlayback(scenario: Scenario): Playback {
  return new Playback(scenario, { deriveEvents: ragDerivation().deriveEvents });
}
