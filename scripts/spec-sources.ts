/**
 * Reads the YAML specifications the app bundles. Plain scalars are typed exactly as
 * PyYAML safe_load types them, so the bundled data equals what validate_specs.py checks
 * (03-simulation-engine.yaml scenario_format.encoding; a golden test compares both).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type ScalarTag } from 'yaml';
import type { SpecSources } from '../src/scenarios/types.ts';

export const SPEC_FILES: Record<keyof SpecSources, string> = {
  product: '00-product.yaml',
  architecture: '01-architecture.yaml',
  engine: '03-simulation-engine.yaml',
  mcp: '04-mcp-scenarios.yaml',
  rag: '05-rag-scenarios.yaml',
  comparison: '06-comparison-scenarios.yaml',
  security: '07-security-protocols.yaml',
};

// PyYAML's implicit resolvers (resolver.py), YAML 1.1.
const BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const NULL = /^(?:~|null|Null|NULL|)$/;
const INT = /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+)$/;
const FLOAT =
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?)$/;
// Types PyYAML resolves that JSON cannot carry: sexagesimal numbers, infinities, NaN, timestamps.
const UNSUPPORTED =
  /^(?:[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)?)$/;

function parseInt11(source: string): number {
  const text = source.replace(/_/g, '');
  const sign = text.startsWith('-') ? -1 : 1;
  const digits = text.replace(/^[-+]/, '');
  if (digits.startsWith('0b')) return sign * Number.parseInt(digits.slice(2), 2);
  if (digits.startsWith('0x')) return sign * Number.parseInt(digits.slice(2), 16);
  if (digits.length > 1 && digits.startsWith('0'))
    return sign * Number.parseInt(digits.slice(1), 8);
  return sign * Number.parseInt(digits, 10);
}

const PYYAML_TAGS: ScalarTag[] = [
  { tag: 'tag:yaml.org,2002:null', default: true, test: NULL, resolve: () => null },
  {
    tag: 'tag:yaml.org,2002:bool',
    default: true,
    test: BOOL,
    resolve: (s) => /^(?:yes|true|on)$/i.test(s),
  },
  { tag: 'tag:yaml.org,2002:int', default: true, test: INT, resolve: parseInt11 },
  {
    tag: 'tag:yaml.org,2002:float',
    default: true,
    test: FLOAT,
    resolve: (s) => Number(s.replace(/_/g, '')),
  },
  {
    tag: 'tag:agentscope,unsupported',
    default: true,
    test: UNSUPPORTED,
    resolve: (s, onError) => {
      onError(
        `"${s}" is a timestamp, infinity, NaN or sexagesimal number, which JSON cannot carry; quote it`,
      );
      return s;
    },
  },
];

/** Parses one specification file with PyYAML's typing of plain scalars. */
export function parseSpec(text: string, file = 'specification'): unknown {
  try {
    return parse(text, {
      schema: 'failsafe',
      customTags: PYYAML_TAGS,
      merge: false,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export function readSpecSources(specDir: string): SpecSources {
  const sources = {} as Record<string, unknown>;
  for (const [key, file] of Object.entries(SPEC_FILES)) {
    sources[key] = parseSpec(readFileSync(join(specDir, file), 'utf8'), file);
  }
  return sources as unknown as SpecSources;
}
