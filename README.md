# @console-one/compile

## What it is

A hoist-aware compiler, generic in the output type and with zero runtime dependencies.
Given an object graph, it answers the question every serializer eventually faces: for each
shared subexpression, do you inline it at every use site, or hoist it once into a named
section and reference it? — and treats that as the constrained-optimization problem it
actually is. This repo is part of a multi-year investigation into typed, budgeted,
event-sourced coordination substrates; each package in the family isolates one question.

## The question it answers

What does a per-section token cap demand that truncation can't deliver? The answer this
package found: it is not a cap problem, it is a **pricing** problem. You are not blocking
tokens; you are maximizing fidelity under cost pressure, and the price of a token in one
section is discovered, not declared — budgets behave as prices (Lagrangian duals) and
selection is optimization. Three strategies implement that, in increasing sophistication:

- `greedy` — fast, good default
- `beam` — beam search over candidate assignments (`beamWidth`, default 8)
- `lagrangian` — dual prices λ per (section, dimension), score = fidelity − Σ λ·cost,
  subgradient updates raising prices on violated sections, then primal repair swapping
  toward fidelity — for when greedy/beam wedge against tight budgets

Hoisted candidates charge their bucket once; inline candidates charge the parent's
section per occurrence. Elision is priced, never silent.

## The pipeline

```
compile(handlers, roots) → CandidateGraph
                              │
select(graph, opts) ──────────┤   picks one Candidate per required site
                              ▼
emit(graph, selection) → { body, sections, hoistedByKey }
```

The orchestrator owns identity (structural hashing → site keys), dedupe, ref propagation,
name allocation, and topological order within sections. **Handlers** own the per-node-type
enumeration of representation options and how to materialize each.

```ts
type Candidate<TOutput> = {
  shape: 'inline' | 'hoisted'; // who gets charged, and how often
  cost: Cost;                  // multi-dimensional, e.g. { tokens: 5, bytes: 120 }
  fidelity: number;            // selection prefers higher when budget allows
  bucket?: string | string[];  // hoist target — buckets nest (multi-dim sections)
  refs: string[];              // site keys this representation requires
  materialize: (resolve: (refKey: string) => TOutput) => TOutput;
};
```

A handler supplies `matches`, an optional stable `key`, `candidates(node, compileChild)`,
and `refName`. Cycles short-circuit cleanly because sites are reserved before their
handler runs. `select(graph, { strategy, budget })` caps summed cost per section
(`budget["ui"]["tokens"] = 4000`). `emit` materializes the selection topo-sorted so
definitions precede uses; `walkSections` traverses the result.

## The codec

`compactTree` / `expandTree` — dictionary-based tree compaction, implemented as the
simplest possible consumer of `compile()`: a frequency pre-pass gives each subtree exactly
one candidate, so the selector has nothing to optimize. It doubles as proof that the
candidate API degrades gracefully to the trivial case.

```ts
import { compactTree, expandTree } from '@console-one/compile';
const compact = compactTree(bigRepetitiveJson); // { v: 1, dict: [...], root: ... }
const roundTripped = expandTree(compact);
```

## Utilities

- `structuralHash` / `djb2hex` — canonical structural hashing (default site identity)
- `topoSort` — dependency-ordered emission within sections

## Status, stated plainly

v0.1.0, complete and smoke-tested (`npm run smoke` covers string output, multi-dim
buckets, budget-constrained selection across all three strategies, and codec round-trips).
The package itself is **archived** — no longer developed under this name. Its
implementation, however, is not dead: the core (`hash` / `topo` / `compile`) is vendored
verbatim into a shipping product, where it powers budgeted document rendering today — the
greedy strategy is live in production; beam and Lagrangian are present in the vendored
code but not yet exercised there.

## Where the idea lives now

Vendored into a private product's budget-constrained renderer (greedy live). The pricing
formulation — budgets as discovered prices rather than declared caps — carries forward
into the successor kernel,
[`@console-one/sequence`](https://github.com/console-one/sequence).

## Development

```sh
npm run build && npm run smoke   # assertion-based smoke suite
npm test                         # assessable-based tests
```

MIT © Andrew Chalmers
