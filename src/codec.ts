// Dictionary-based tree compaction, implemented on top of the candidate-
// based `compile()`. The codec is the simplest possible consumer of the
// new API: each subtree offers exactly one candidate (inline if it appears
// once, hoisted if it appears more than once). The frequency pre-pass
// decides; the selector has nothing to optimize.

import {
  compile,
  emit,
  select,
  type Candidate,
  type CandidateHandler,
} from './compile.js';

export type CompactedTree = { v: 1; dict: unknown[]; root: unknown };

// ── Canonicalization ────────────────────────────────────────────────────────

function canonicalKey(node: unknown): string {
  if (node === null || typeof node !== 'object') return JSON.stringify(node);
  const obj = node as { toJSON?: () => unknown };
  if (typeof obj.toJSON === 'function') return canonicalKey(obj.toJSON());
  if (Array.isArray(node)) return '[' + node.map(canonicalKey).join(',') + ']';
  const rec = node as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalKey(rec[k])).join(',') +
    '}'
  );
}

function countFrequencies(value: unknown): Map<string, number> {
  const freq = new Map<string, number>();
  function walk(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    const obj = node as { toJSON?: () => unknown };
    if (typeof obj.toJSON === 'function') return walk(obj.toJSON());
    const k = canonicalKey(node);
    freq.set(k, (freq.get(k) ?? 0) + 1);
    if (Array.isArray(node)) for (const c of node) walk(c);
    else for (const v of Object.values(node as Record<string, unknown>)) walk(v);
  }
  walk(value);
  return freq;
}

// ── compactTree ─────────────────────────────────────────────────────────────

export function compactTree(value: unknown): CompactedTree {
  const freq = countFrequencies(value);
  let nextIndex = 0;
  const indexByKey = new Map<string, number>();

  function indexFor(canonKey: string): number {
    const cached = indexByKey.get(canonKey);
    if (cached !== undefined) return cached;
    const i = nextIndex++;
    indexByKey.set(canonKey, i);
    return i;
  }

  const handler: CandidateHandler<object, unknown> = {
    type: 'tree',
    matches: (x): x is object => x !== null && typeof x === 'object',
    key: canonicalKey,
    candidates: (node, c) => {
      const obj = node as { toJSON?: () => unknown };
      const coerced = typeof obj.toJSON === 'function' ? obj.toJSON() : node;

      const childRefs: string[] = [];
      const childResolverKeys: Array<string | null> = [];

      // Walk children once to collect ref site keys (for any non-primitive
      // children) and primitive markers (null) for things that pass through.
      const walkChildren = (): { keys: string[]; placeholders: Array<string | null> } => {
        const placeholders: Array<string | null> = [];
        const keys: string[] = [];
        if (Array.isArray(coerced)) {
          for (const child of coerced) {
            if (child === null || typeof child !== 'object') {
              placeholders.push(null);
            } else {
              const k = c(child);
              keys.push(k);
              placeholders.push(k);
            }
          }
        } else {
          const rec = coerced as Record<string, unknown>;
          for (const key of Object.keys(rec)) {
            const child = rec[key];
            if (child === null || typeof child !== 'object') {
              placeholders.push(null);
            } else {
              const k = c(child);
              keys.push(k);
              placeholders.push(k);
            }
          }
        }
        return { keys, placeholders };
      };

      const { keys: refs, placeholders } = walkChildren();
      childRefs.push(...refs);
      childResolverKeys.push(...placeholders);

      // Re-materialize the transformed node, substituting child outputs at
      // the sites where they originally appeared. We re-walk `coerced`
      // because the placeholder list only knows whether a slot was a child
      // ref or a primitive — not which slot.
      const materialize = (resolve: (key: string) => unknown): unknown => {
        if (Array.isArray(coerced)) {
          return coerced.map((child) =>
            child === null || typeof child !== 'object' ? child : resolve(c(child)),
          );
        }
        const rec = coerced as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(rec)) {
          const child = rec[k];
          out[k] =
            child === null || typeof child !== 'object' ? child : resolve(c(child));
        }
        return out;
      };

      const k = canonicalKey(coerced);
      const isDuplicate = (freq.get(k) ?? 0) > 1;

      // Deterministic policy: hoist iff duplicate. Single candidate either
      // way — selection is structural, not optimization-driven.
      const candidate: Candidate<unknown> = isDuplicate
        ? {
            shape: 'hoisted',
            cost: {},
            fidelity: 0,
            refs: childRefs,
            name: String(indexFor(k)),
            materialize,
          }
        : {
            shape: 'inline',
            cost: {},
            fidelity: 0,
            refs: childRefs,
            materialize,
          };

      return [candidate];
    },
    refName: (_n, name) => ({ $: Number(name) }),
  };

  const graph = compile<unknown>([handler], [value], { unhandled: (n) => n });
  const selection = select(graph, { strategy: 'greedy' });
  const emitted = emit(graph, selection);

  // Build dict array, indexed by name (which we set to the structural index).
  const dict: unknown[] = [];
  for (const h of emitted.hoistedByKey.values()) {
    dict[Number(h.name)] = h.body;
  }

  return { v: 1, dict, root: emitted.body[0] };
}

// ── expandTree ──────────────────────────────────────────────────────────────

function isCompactedTree(x: unknown): x is CompactedTree {
  return (
    !!x &&
    typeof x === 'object' &&
    (x as CompactedTree).v === 1 &&
    Array.isArray((x as CompactedTree).dict) &&
    'root' in (x as object)
  );
}

function deepClone(x: unknown): unknown {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(deepClone);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(x as Record<string, unknown>)) {
    out[k] = deepClone((x as Record<string, unknown>)[k]);
  }
  return out;
}

export function expandTree(data: unknown): unknown {
  if (!isCompactedTree(data)) return data;
  const dict = data.dict;
  const memo = new Map<number, unknown>();

  function expand(node: unknown): unknown {
    if (node === null || typeof node !== 'object') return node;
    const rec = node as Record<string, unknown>;
    if (typeof rec.$ === 'number' && Object.keys(rec).length === 1) {
      const idx = rec.$;
      if (idx < 0 || idx >= dict.length) {
        throw new Error(`Invalid tree ref: ${idx}, dict size: ${dict.length}`);
      }
      if (memo.has(idx)) return deepClone(memo.get(idx));
      memo.set(idx, null);
      const v = expand(dict[idx]);
      memo.set(idx, v);
      return deepClone(v);
    }
    if (Array.isArray(node)) return node.map(expand);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec)) out[k] = expand(rec[k]);
    return out;
  }

  return expand(data.root);
}
