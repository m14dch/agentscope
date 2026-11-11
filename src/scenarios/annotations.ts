/**
 * Payload annotations (03-simulation-engine.yaml annotation_rules): JSON paths, the checks
 * both validators run, and the split of a payload's text into its annotation groups.
 * Mirrors annotation_problems and carries_problem in specifications/tools/validate_specs.py,
 * with the same messages (tests/unit/node/annotations-parity.test.ts).
 */
import type { AnnotationGroup, Json } from './types.ts';

/** A path's member names and array indexes, from the root. */
export type Segments = readonly string[];

const STRING = /^"(?:[^"\\]|\\.)*"/;
const PLAIN = /^[^.[\]]+/;

/** Parses a JSON path ('$', 'a.b.0', 'a["x.y"].c'); undefined if it is not one. */
export function parsePath(path: string): string[] | undefined {
  if (path === '$') return [];
  const out: string[] = [];
  let rest = path;
  let first = true;
  while (rest.length) {
    if (rest.startsWith('[')) {
      const m = STRING.exec(rest.slice(1));
      if (!m || rest[1 + m[0].length] !== ']') return undefined;
      out.push(JSON.parse(m[0]) as string);
      rest = rest.slice(m[0].length + 2);
    } else {
      if (!first) {
        if (!rest.startsWith('.')) return undefined;
        rest = rest.slice(1);
      }
      const m = PLAIN.exec(rest);
      if (!m) return undefined;
      out.push(m[0]);
      rest = rest.slice(m[0].length);
    }
    first = false;
  }
  return out.length ? out : undefined;
}

/** Writes segments as a path: dots, brackets for names with a dot or bracket, '$' for the root. */
export function formatPath(segments: Segments): string {
  if (!segments.length) return '$';
  return segments
    .map((s, i) => (/[.[\]"]/.test(s) || !s ? `[${JSON.stringify(s)}]` : i ? `.${s}` : s))
    .join('');
}

const INDEX = /^(0|[1-9][0-9]*)$/;

/** The value at a path, or undefined when the path does not exist. */
export function resolvePath(value: Json, segments: Segments): { value: Json } | undefined {
  let node: Json = value;
  for (const s of segments) {
    if (Array.isArray(node)) {
      if (!INDEX.test(s) || Number(s) >= node.length) return undefined;
      node = node[Number(s)] as Json;
    } else if (node !== null && typeof node === 'object' && Object.hasOwn(node, s)) {
      node = node[s] as Json;
    } else return undefined;
  }
  return { value: node };
}

const startsWith = (path: Segments, prefix: Segments): boolean =>
  prefix.length <= path.length && prefix.every((s, i) => path[i] === s);

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Members of a container, as [segment, value], in document order. */
function members(value: Json): [string, Json][] {
  if (Array.isArray(value)) return value.map((v, i) => [String(i), v]);
  if (value !== null && typeof value === 'object') return Object.entries(value);
  return [];
}

const ONE_SENTENCE = (s: string): boolean => {
  const t = s.trim();
  return t.endsWith('.') && !/[.!?]\s+[A-Z]/.test(t);
};

/** Why `carries` is malformed, or undefined (03 annotation_rules.checks). */
export function carriesProblem(carries: unknown): string | undefined {
  const ok =
    Array.isArray(carries) &&
    carries.length > 0 &&
    carries.every(
      (c) =>
        typeof c === 'string' && c.trim() !== '' && c.length <= 100 && !c.trimEnd().endsWith('.'),
    );
  return ok
    ? undefined
    : 'carries must be a non-empty list of phrases of at most 100 characters without a final full stop';
}

/** Problems of an event's annotations against its payload (03 annotation_rules.checks). */
export function annotationProblems(payload: Json | undefined, annotations: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(annotations) || !annotations.length)
    return ['annotations must be a non-empty list of groups'];
  if (payload === undefined || payload === null) return ['annotations need a payload'];
  const paths: { group: number; text: string; segments: string[] }[] = [];
  annotations.forEach((raw: unknown, g) => {
    const at = `annotations[${g}]`;
    if (!isObject(raw)) {
      problems.push(`${at} must be a group {heading, sentence, paths, values}`);
      return;
    }
    const heading = raw['heading'];
    if (typeof heading !== 'string' || !heading.trim() || heading.length > 40)
      problems.push(`${at} heading must be a phrase of 1 to 40 characters`);
    const sentence = raw['sentence'];
    if (typeof sentence !== 'string' || !ONE_SENTENCE(sentence))
      problems.push(`${at} sentence must be one sentence ending with a full stop`);
    const list = raw['paths'];
    if (!Array.isArray(list) || !list.length || !list.every((p) => typeof p === 'string')) {
      problems.push(`${at} needs a non-empty list of paths`);
      return;
    }
    const own: string[][] = [];
    for (const text of list as string[]) {
      const segments = parsePath(text);
      if (!segments) problems.push(`${at} path ${JSON.stringify(text)} is not a JSON path`);
      else if (!resolvePath(payload, segments))
        problems.push(`${at} path ${JSON.stringify(text)} does not exist in the payload`);
      else {
        paths.push({ group: g, text, segments });
        own.push(segments);
      }
    }
    const values = raw['values'];
    if (values === undefined) return;
    if (!isObject(values)) {
      problems.push(`${at} values must map paths to meanings`);
      return;
    }
    for (const [text, meaning] of Object.entries(values)) {
      const segments = parsePath(text);
      if (!segments) problems.push(`${at} value path ${JSON.stringify(text)} is not a JSON path`);
      else if (!resolvePath(payload, segments))
        problems.push(`${at} value path ${JSON.stringify(text)} does not exist in the payload`);
      else if (!own.some((p) => startsWith(segments, p)))
        problems.push(`${at} value path ${JSON.stringify(text)} lies outside the group's paths`);
      if (typeof meaning !== 'string' || !meaning.trim())
        problems.push(`${at} value ${JSON.stringify(text)} needs a meaning`);
    }
  });
  paths.forEach((a, i) =>
    paths.forEach((b, j) => {
      if (i < j && (startsWith(a.segments, b.segments) || startsWith(b.segments, a.segments)))
        problems.push(
          `annotations[${a.group}] path ${JSON.stringify(a.text)} overlaps annotations[${b.group}] path ${JSON.stringify(b.text)}`,
        );
    }),
  );
  if (problems.length) return problems;
  // Walk the payload in document order: every member is held by a path, in group order.
  let last = -1;
  let ordered = true;
  const walk = (value: Json, segments: string[]): void => {
    const held = paths.find((p) => startsWith(segments, p.segments));
    if (held) {
      if (held.group < last && ordered) {
        ordered = false;
        problems.push(
          `annotations[${held.group}] follows annotations[${last}] in the payload: groups must be in payload order`,
        );
      }
      last = Math.max(last, held.group);
      return;
    }
    if (!paths.some((p) => startsWith(p.segments, segments))) {
      problems.push(`${formatPath(segments)} lies under no group's path (a gap)`);
      return;
    }
    for (const [k, v] of members(value)) walk(v, [...segments, k]);
  };
  walk(payload, []);
  return problems;
}

/** One line of JSON.stringify(value, null, 2), with where it lies in the payload. */
export interface JsonLine {
  /** Indentation level (two spaces each). */
  depth: number;
  /** Member name in an object. */
  key?: string;
  /** The value as JSON text, or the bracket that opens or closes a container. */
  text: string;
  /** A comma follows. */
  comma: boolean;
  /** Path of the member the line belongs to; for a closing bracket, its container. */
  segments: string[];
  kind: 'leaf' | 'open' | 'close';
}

/** The lines of JSON.stringify(value, null, 2), in order. */
export function jsonLines(value: Json): JsonLine[] {
  const out: JsonLine[] = [];
  const visit = (
    v: Json,
    segments: string[],
    depth: number,
    key: string | undefined,
    comma: boolean,
  ) => {
    const base = { depth, segments, ...(key === undefined ? {} : { key }) };
    const entries = members(v);
    if (v === null || typeof v !== 'object' || !entries.length) {
      const text =
        v !== null && typeof v === 'object' ? (Array.isArray(v) ? '[]' : '{}') : JSON.stringify(v);
      out.push({ ...base, text, comma, kind: 'leaf' });
      return;
    }
    const array = Array.isArray(v);
    out.push({ ...base, text: array ? '[' : '{', comma: false, kind: 'open' });
    entries.forEach(([k, child], i) =>
      visit(child, [...segments, k], depth + 1, array ? undefined : k, i < entries.length - 1),
    );
    out.push({ depth, segments, text: array ? ']' : '}', comma, kind: 'close' });
  };
  visit(value, [], 0, undefined, false);
  return out;
}

/** A line as text, as JSON.stringify writes it. */
export function lineText(line: JsonLine): string {
  const key = line.key === undefined ? '' : `${JSON.stringify(line.key)}: `;
  return `${'  '.repeat(line.depth)}${key}${line.text}${line.comma ? ',' : ''}`;
}

export interface SplitGroup {
  annotation: AnnotationGroup;
  /** Paths of the group, parsed. */
  paths: string[][];
  lines: JsonLine[];
}

/**
 * Splits the payload's lines into its annotation groups (03 annotation_rules.lines): a line
 * of a held member belongs to the group holding it, an unheld opening line to the group of
 * the next line, an unheld closing line to that of the line before. Undefined when the
 * annotations do not fit the payload, so the inspector shows it without them.
 */
export function splitPayload(
  payload: Json | undefined,
  annotations: readonly AnnotationGroup[] | undefined,
): SplitGroup[] | undefined {
  if (payload === undefined || !annotations?.length) return undefined;
  if (annotationProblems(payload, annotations).length) return undefined;
  const parsed = annotations.map((a) => a.paths.map((p) => parsePath(p) ?? []));
  const lines = jsonLines(payload);
  const owner = lines.map((line) =>
    parsed.findIndex((paths) => paths.some((p) => startsWith(line.segments, p))),
  );
  // Unheld opening lines take the next line's group, unheld closing lines the previous one's.
  for (let i = lines.length - 1; i >= 0; i--)
    if (owner[i] === -1 && lines[i]?.kind === 'open') owner[i] = owner[i + 1] ?? -1;
  for (let i = 0; i < lines.length; i++)
    if (owner[i] === -1 && lines[i]?.kind === 'close') owner[i] = owner[i - 1] ?? -1;
  const groups: SplitGroup[] = annotations.map((annotation, g) => ({
    annotation,
    paths: parsed[g] ?? [],
    lines: [],
  }));
  let previous = 0;
  for (const [i, line] of lines.entries()) {
    const g = owner[i] ?? -1;
    if (g < previous) return undefined;
    previous = g;
    groups[g]?.lines.push(line);
  }
  return groups.every((g) => g.lines.length) ? groups : undefined;
}
