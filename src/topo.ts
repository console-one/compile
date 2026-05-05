// Generic topological sort (Kahn's algorithm) with cycle-tolerant fallback.
// Cycles do not throw — nodes participating in a cycle are appended in
// original insertion order after all acyclic nodes have been emitted.

export function topoSort<T>(
  nodes: T[],
  getKey: (n: T) => string,
  getDeps: (n: T) => string[]
): T[] {
  const byKey = new Map<string, T>();
  for (const n of nodes) byKey.set(getKey(n), n);

  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    const key = getKey(node);
    if (!indegree.has(key)) indegree.set(key, 0);
    for (const depKey of getDeps(node)) {
      if (!byKey.has(depKey)) continue; // ignore deps outside this set
      indegree.set(key, (indegree.get(key) ?? 0) + 1);
      const adj = adjacency.get(depKey);
      if (adj) adj.push(key);
      else adjacency.set(depKey, [key]);
    }
  }

  const ready: string[] = [];
  for (const node of nodes) {
    if ((indegree.get(getKey(node)) ?? 0) === 0) ready.push(getKey(node));
  }

  const out: T[] = [];
  const emitted = new Set<string>();

  while (ready.length) {
    const key = ready.shift()!;
    const node = byKey.get(key);
    if (!node) continue;
    out.push(node);
    emitted.add(key);
    for (const downstream of adjacency.get(key) ?? []) {
      indegree.set(downstream, (indegree.get(downstream) ?? 1) - 1);
      if ((indegree.get(downstream) ?? 0) === 0) ready.push(downstream);
    }
  }

  // Cycle remnants: append in original insertion order
  for (const node of nodes) {
    if (!emitted.has(getKey(node))) out.push(node);
  }

  return out;
}
