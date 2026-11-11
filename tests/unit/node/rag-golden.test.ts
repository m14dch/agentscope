import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readSpecSources } from '../../../scripts/spec-sources.ts';
import { RagDerivation } from '../../../src/rag/derive.ts';
import { parentDocuments, sourceLines } from '../../../src/rag/engine.ts';

const ROOT = join(import.meta.dirname, '../../..');
const SPECS = join(ROOT, 'specifications');
const dir = mkdtempSync(join(tmpdir(), 'agentscope-rag-golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Entry =
  | {
      case: string;
      size: number;
      overlap: number;
      ranking: [string, number, number, number, number[]][];
    }
  | {
      case: string;
      size: number;
      overlap: number;
      top_k: number;
      threshold: number;
      rerank: boolean;
      fetch: boolean;
      selected: string[];
      evidence: string[];
      answer: string;
      /** The answer's parts as [kind, text] (05 answer_rules). */
      parts: [string, string][];
      sources: string[];
    };

function pythonResults(): Entry[] {
  const out = join(dir, 'rag.json');
  execFileSync(
    'python3',
    [
      join(SPECS, 'tools/validate_specs.py'),
      '--mcp-schema',
      join(SPECS, 'tools/mcp-schema-2026-07-28.json'),
      '--dump-rag',
      out,
    ],
    { stdio: 'pipe' },
  );
  return JSON.parse(readFileSync(out, 'utf8')) as Entry[];
}

describe('RAG engine golden test', () => {
  it('equals the reference implementation in validate_specs.py over a parameter grid', () => {
    const sources = readSpecSources(SPECS);
    const { engine } = new RagDerivation(sources);
    const entries = pythonResults();
    // Per chunking: its ranking, then top K × threshold × rerank × fetch.
    expect(entries.length).toBe(9 * (1 + 3 * 3 * 2 * 2));
    expect(
      entries.some(
        (e) => 'fetch' in e && e.fetch && e.sources.some((l) => l.endsWith('full document')),
      ),
    ).toBe(true);
    for (const entry of entries) {
      const docs = engine.corpus();
      const where = JSON.stringify({
        ...entry,
        ranking: undefined,
        answer: undefined,
        parts: undefined,
      });
      if ('ranking' in entry) {
        const r = engine.retrieve(docs, {
          chunkSize: entry.size,
          overlap: entry.overlap,
          topK: 1,
          threshold: 0,
          rerank: false,
        });
        expect(
          r.ranked.map((c) => [c.id, c.score, c.keyword, c.rerank, c.embedding]),
          where,
        ).toEqual(entry.ranking);
        continue;
      }
      const r = engine.retrieve(docs, {
        chunkSize: entry.size,
        overlap: entry.overlap,
        topK: entry.top_k,
        threshold: entry.threshold,
        rerank: entry.rerank,
      });
      expect(
        r.selected.map((c) => c.id),
        where,
      ).toEqual(entry.selected);
      const evidence = entry.fetch ? parentDocuments(r.selected, docs) : r.selected;
      expect(
        evidence.map((c) => c.id),
        where,
      ).toEqual(entry.evidence);
      const answer = engine.answer(evidence);
      expect(answer.text, where).toBe(entry.answer);
      expect(
        answer.parts.map((p) => [p.kind, p.text]),
        where,
      ).toEqual(entry.parts);
      expect(sourceLines(answer.cited), where).toEqual(entry.sources);
    }
  }, 30_000); // Runs a Python grid of 2000+ cases; 5 s is too tight under parallel load.
});
