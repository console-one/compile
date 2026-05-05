// DJB2 string hash (Daniel J. Bernstein, 1991). Tiny, fast, non-cryptographic.
// Used as the underlying primitive for structural identity throughout this
// package. Wrapped by `structuralHash` for typical call sites; raw `djb2`
// remains available for callers that want the numeric form.

export function djb2(s: string): number {
  let h = 5381 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

export function djb2hex(s: string): string {
  return djb2(s).toString(36);
}

// Structural hash of any JSON-serializable value. NOTE: relies on
// `JSON.stringify` key order, which means object key permutations produce
// different hashes. Most call sites here pre-canonicalize before hashing, or
// use this only for collision suffixes where stability across runs is enough.
export function structuralHash(value: unknown): string {
  return djb2hex(JSON.stringify(value));
}
