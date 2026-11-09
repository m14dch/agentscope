/**
 * Variant expansion and scenario composition (03-simulation-engine.yaml variant_format
 * and composition_format). Mirrors specifications/tools/validate_specs.py exactly; a
 * golden test compares both registries.
 */
import type {
  Composition,
  Json,
  Registry,
  Scenario,
  ScenarioEvent,
  SpecSources,
  Variant,
} from './types.ts';

type Node = Json | ScenarioEvent | undefined;

/** An array index segment: decimal digits only, within bounds. */
function arrayIndex(list: unknown[], part: string): number | undefined {
  const i = /^(?:0|[1-9][0-9]*)$/.test(part) ? Number(part) : -1;
  return i >= 0 && i < list.length ? i : undefined;
}

function child(node: Node, part: string): Node {
  if (Array.isArray(node)) {
    const i = arrayIndex(node, part);
    return i === undefined ? undefined : node[i];
  }
  if (node !== null && typeof node === 'object' && Object.hasOwn(node, part)) {
    return (node as Record<string, Json>)[part];
  }
  return undefined;
}

/** Resolves a dotted path; numeric segments index arrays. Returns undefined if absent. */
export function getPath(obj: Node, path: string): Node {
  let node = obj;
  for (const part of path.split('.')) {
    node = child(node, part);
    if (node === undefined) return undefined;
  }
  return node;
}

/** Replaces the value at a dotted path. Returns false if the parent does not exist. */
export function setPath(obj: Node, path: string, value: Json): boolean {
  const parts = path.split('.');
  const last = parts.pop() as string;
  const parent = parts.length ? getPath(obj, parts.join('.')) : obj;
  if (Array.isArray(parent)) {
    const i = arrayIndex(parent, last);
    if (i === undefined) return false;
    parent[i] = value;
    return true;
  }
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') return false;
  if (parent !== null && typeof parent === 'object') {
    (parent as Record<string, Json>)[last] = value;
    return true;
  }
  return false;
}

/** Sets scenario_id and sequence, and prefixes event and pair IDs with the scenario ID. */
function finalize(scn: Scenario, id: string): Scenario {
  scn.events.forEach((e, i) => {
    e.scenario_id = id;
    e.sequence = i + 1;
    // A missing or non-string ID stays as it is, so validation reports it.
    if (typeof e.id === 'string') e.id = `${id}:${e.id}`;
    if (typeof e.pair_id === 'string') e.pair_id = `${id}:${e.pair_id}`;
  });
  scn.id = id;
  return scn;
}

export function expandVariant(base: Scenario, variant: Variant, problems: string[]): Scenario {
  const scn = structuredClone(base);
  const events = scn.events;
  const index = (eid: string, op: string): number => {
    const i = events.findIndex((e) => e.id === eid);
    if (i < 0) problems.push(`${variant.id}: ${op} names unknown event ${eid}`);
    return i;
  };
  for (const op of variant.operations ?? []) {
    switch (op.op) {
      case 'patch': {
        const i = index(op.event, 'patch');
        if (i < 0) break;
        for (const [path, value] of Object.entries(op.set)) {
          if (!setPath(events[i], path, structuredClone(value))) {
            problems.push(`${variant.id}: patch path ${path} does not exist in ${op.event}`);
          }
        }
        break;
      }
      case 'replace': {
        const i = index(op.event, 'replace');
        if (i >= 0) events[i] = structuredClone(op.with);
        break;
      }
      case 'remove':
        for (const eid of op.events) {
          const i = index(eid, 'remove');
          if (i >= 0) events.splice(i, 1);
        }
        break;
      case 'insert_after': {
        const i = index(op.event, 'insert_after');
        if (i >= 0) events.splice(i + 1, 0, ...structuredClone(op.events));
        break;
      }
      default:
        problems.push(`${variant.id}: unknown operation ${(op as { op: string }).op}`);
    }
  }
  if (variant.question !== undefined) scn.question = variant.question;
  scn.title = variant.title;
  // A variant is presented by its lesson.
  scn.headline = variant.lesson ?? '';
  return finalize(scn, variant.id);
}

const COMPOSED_FIELDS = [
  'title',
  'question',
  'learning_question',
  'headline',
  'participants',
  'phases',
  'initial_state',
] as const;

export function compose(comp: Composition, registry: Registry, problems: string[]): Scenario {
  const events: ScenarioEvent[] = [];
  for (const step of comp.compose) {
    if ('copy' in step) {
      const c = step.copy;
      const src = registry[c.scenario]?.events;
      if (!Array.isArray(src)) {
        problems.push(`${comp.id}: copy names unknown scenario ${c.scenario}`);
        continue;
      }
      const from = src.findIndex((e) => e.id === c.from);
      const to = src.findIndex((e) => e.id === c.to);
      if (from < 0 || to < from) {
        problems.push(`${comp.id}: copy range ${c.from}..${c.to} not found in ${c.scenario}`);
        continue;
      }
      for (const e of structuredClone(src.slice(from, to + 1))) {
        if (c.phase_map && Object.hasOwn(c.phase_map, e.phase))
          e.phase = c.phase_map[e.phase] as string;
        const patch = c.patch && Object.hasOwn(c.patch, e.id) ? c.patch[e.id] : undefined;
        for (const [path, value] of Object.entries(patch ?? {})) {
          if (!setPath(e, path, structuredClone(value))) {
            problems.push(`${comp.id}: patch path ${path} does not exist in ${e.id}`);
          }
        }
        events.push(e);
      }
    } else {
      events.push(...structuredClone(step.insert));
    }
  }
  const scn = {} as Record<string, unknown>;
  for (const k of COMPOSED_FIELDS) {
    if (Object.hasOwn(comp, k)) scn[k] = structuredClone(comp[k]);
  }
  scn['events'] = events;
  return finalize(scn as unknown as Scenario, comp.id);
}

/** Builds the registry: base scenarios, expanded variants, then the Combined composition. */
export function buildRegistry(sources: SpecSources): { registry: Registry; problems: string[] } {
  const problems: string[] = [];
  const registry: Registry = {};
  for (const scn of [...sources.mcp.scenarios, ...sources.rag.scenarios]) {
    if (!Array.isArray(scn.events)) {
      problems.push(`${scn.id}: events must be a list`);
      continue;
    }
    // A copy, so consumers of the registry cannot change the bundled sources.
    registry[scn.id] = structuredClone(scn);
  }
  for (const variant of [...sources.mcp.variants, ...sources.rag.variants]) {
    const base = Object.hasOwn(registry, variant.extends) ? registry[variant.extends] : undefined;
    if (!base) {
      problems.push(`${variant.id}: extends unknown scenario ${variant.extends}`);
      continue;
    }
    registry[variant.id] = expandVariant(base, variant, problems);
  }
  const comb = sources.comparison.combined;
  registry[comb.id] = compose(comb, registry, problems);
  return { registry, problems };
}
