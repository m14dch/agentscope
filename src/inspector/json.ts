/**
 * JSON tree model for the inspector (02-ui-ux.yaml inspector.syntax, folding,
 * changed_fields, redaction). Pure: the tree's text is exactly JSON.stringify(value, null, 2),
 * so the rendered payload is provably the payload.
 */
import type { Json } from '../scenarios/types.ts';

export type Mark = 'changed' | 'tracked';

interface Base {
  /** Member name in an object; absent in arrays and at the root. */
  key?: string;
  /** Dotted path from the root, for example messages.2.content. */
  path: string;
  /** A comma follows this node. */
  comma: boolean;
  mark?: Mark;
}

export interface Leaf extends Base {
  kind: 'leaf';
  /** The value as JSON text, for example "123" with quotes, or 12500.75. */
  text: string;
  redacted: boolean;
}

export interface Branch extends Base {
  kind: 'branch';
  open: '{' | '[';
  close: '}' | ']';
  /** Members, with boilerplate grouped into folds. */
  children: TreeNode[];
}

/** Boilerplate members shown as one closed line naming them (02 inspector.folding). */
export interface Fold {
  kind: 'fold';
  label: string;
  children: TreeNode[];
}

export type TreeNode = Leaf | Branch | Fold;

export interface TreeOptions {
  /** Member names folded into one line wherever they appear. */
  fold?: ReadonlySet<string>;
  /** Paths whose node is marked changed. */
  changed?: ReadonlySet<string>;
  /** Leaf values marked tracked. */
  tracked?: ReadonlySet<string | number>;
}

const REDACTED = /<REDACTED[^>]*>/;

/** Builds the tree for a value. */
export function jsonTree(value: Json, options: TreeOptions = {}): TreeNode {
  return build(value, '', undefined, false, options, undefined);
}

function build(
  value: Json,
  path: string,
  key: string | undefined,
  comma: boolean,
  options: TreeOptions,
  inherited: Mark | undefined,
): Leaf | Branch {
  // A changed branch carries the mark once; its members are not marked again.
  const mark = options.changed?.has(path) && !inherited ? 'changed' : undefined;
  const within = inherited ?? mark;
  const base = { path, comma, ...(key === undefined ? {} : { key }) };
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    const tracked =
      (typeof value === 'string' || typeof value === 'number') && options.tracked?.has(value);
    const leafMark = mark ?? (tracked && !within ? 'tracked' : undefined);
    return {
      kind: 'leaf',
      ...base,
      text,
      redacted: typeof value === 'string' && REDACTED.test(value),
      ...(leafMark ? { mark: leafMark } : {}),
    };
  }
  const entries: [string | undefined, Json][] = Array.isArray(value)
    ? value.map((v) => [undefined, v])
    : Object.entries(value);
  const child = (k: string | undefined, v: Json, i: number): Leaf | Branch =>
    build(
      v,
      path ? `${path}.${k ?? i}` : String(k ?? i),
      k,
      i < entries.length - 1,
      options,
      within,
    );
  const nodes = entries.map(([k, v], i) => child(k, v, i));
  // Consecutive boilerplate members become one fold.
  const children: TreeNode[] = [];
  for (const node of nodes) {
    const folded = node.key !== undefined && options.fold?.has(node.key);
    const last = children[children.length - 1];
    if (folded && last?.kind === 'fold') {
      last.children.push(node);
      last.label = `${last.label}, ${node.key ?? ''}`;
    } else if (folded) children.push({ kind: 'fold', label: node.key ?? '', children: [node] });
    else children.push(node);
  }
  return {
    kind: 'branch',
    ...base,
    open: Array.isArray(value) ? '[' : '{',
    close: Array.isArray(value) ? ']' : '}',
    children,
    ...(mark ? { mark } : {}),
  };
}

/** The tree as text, ignoring folds: equal to JSON.stringify(value, null, 2). */
export function treeText(node: TreeNode, indent = 0): string {
  if (node.kind === 'fold') return node.children.map((c) => treeText(c, indent)).join('\n');
  const pad = '  '.repeat(indent);
  const key = node.key === undefined ? '' : `${JSON.stringify(node.key)}: `;
  const comma = node.comma ? ',' : '';
  if (node.kind === 'leaf') return `${pad}${key}${node.text}${comma}`;
  if (!node.children.length) return `${pad}${key}${node.open}${node.close}${comma}`;
  const inner = node.children.map((c) => treeText(c, indent + 1)).join('\n');
  return `${pad}${key}${node.open}\n${inner}\n${pad}${node.close}${comma}`;
}

/**
 * Paths new in an LLM request compared with the previous one (02 inspector.changed_fields):
 * appended messages and top-level members the previous request did not have.
 */
export function newInRequest(current: Json | undefined, previous: Json | undefined): Set<string> {
  const changed = new Set<string>();
  const obj = (v: Json | undefined): Record<string, Json> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const now = obj(current);
  const before = obj(previous);
  if (previous === undefined) return changed;
  for (const key of Object.keys(now)) if (!Object.hasOwn(before, key)) changed.add(key);
  const messages = now['messages'];
  const earlier = before['messages'];
  if (Array.isArray(messages) && Array.isArray(earlier)) {
    messages.forEach((m, i) => {
      if (i >= earlier.length || JSON.stringify(m) !== JSON.stringify(earlier[i])) {
        changed.add(`messages.${i}`);
      }
    });
  }
  return changed;
}

/** Tracked values of an event, flattened (lists contribute each element). */
export function trackedValues(tracked: Record<string, Json> | undefined): Set<string | number> {
  const out = new Set<string | number>();
  for (const value of Object.values(tracked ?? {})) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === 'string' || typeof v === 'number') out.add(v);
    }
  }
  return out;
}
