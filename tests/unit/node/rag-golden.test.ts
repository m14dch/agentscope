import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readSpecSources } from '../../../scripts/spec-sources.ts';
import { RagDerivation } from '../../../src/rag/derive.ts';
import { corpusOverrides, parentDocuments, sourceLines } from '../../../src/rag/engine.ts';
import type { JsonObject } from '../../../src/scenarios/types.ts';

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
    const variants = [...sources.rag.variants, ...(sources.comparison.combined.variants ?? [])];
    const entries = pythonResults();
    expect(entries.length).toBeGreaterThan(2000);
    expect(
      entries.some(
        (e) => 'fetch' in e && e.fetch && e.sources.some((l) => l.endsWith('full document')),
      ),
    ).toBe(true);
    for (const entry of entries) {
      const overrides = variants.find((v) => v.id === entry.case)?.fixture_overrides as
        JsonObject | undefined;
      const docs = engine.corpus(corpusOverrides(overrides));
      const where = JSON.stringify({ ...entry, ranking: undefined, answer: undefined });
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
      expect(sourceLines(answer.cited), where).toEqual(entry.sources);
    }
  });
});
