# @console-one/compile

A hoist-aware compiler, generic in the output type. Given an object graph, it answers the question every serializer eventually faces: **for each shared subexpression, do you inline it at every use site, or hoist it once into a named section and reference it?** — and treats that as the constrained-optimization problem it actually is. Zero runtime dependencies.

## Why this exists

Any time an object graph becomes a budgeted document — a prompt with per-section token caps, a generated source file, a compacted wire payload — the inline/hoist decision recurs:

- **Inline** is cheap once but charges the parent's section *per occurrence*.
- **Hoist** pays a one-time cost to a named bucket, and every reference becomes a name.

When subtrees are shared, sections have budgets, and representations vary in fidelity, picking well is a knapsack-shaped selection problem, not a formatting detail. Hand-rolled emitters bury that decision in ad-hoc heuristics, entangled with naming, dedupe, and ordering. This package extracts the whole mechanism so renderers only have to answer one local question: *what are the legal representations of this node, and what does each cost?*

## The pipeline

```
compile(handlers, roots) → CandidateGraph
                              │
select(graph, opts) ──────────┤   picks one Candidate per required site
                              ▼
emit(graph, selection) → { body, sections, hoistedByKey }
```

The orchestrator owns identity (structural hashing → site keys), dedupe, ref propagation, name allocation, and topological order within sections. **Handlers** own the per-node-type enumeration of representation options and how to materialize each.

### Candidates

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

A handler for one node kind supplies `matches`, an optional stable `key`, `candidates(node, compileChild)` (calling `compileChild` returns the child's site key to embed in `refs`), and `refName` (how a reference to a hoisted node reads in the output). Cycles short-circuit cleanly because sites are reserved before their handler runs.

### Selection

`select(graph, { strategy, budget })` picks one candidate per required site, where `budget["ui"]["tokens"] = 4000` caps the summed token cost charged to the `ui` section (hoisted candidates charge their bucket once; inline candidates charge the parent's effective section per occurrence). Three strategies:

- `greedy` — fast, good default
- `beam` — beam search over candidate assignments (`beamWidth`, default 8)
- `lagrangian` — Lagrangian relaxation of the budget constraints, for when greedy/beam wedge against tight budgets

### Emission

`emit` materializes the selection: roots become `body`, hoisted nodes land in a nested `Sections` tree by bucket path, topo-sorted so definitions precede uses, with allocated names threaded through each candidate's `materialize` resolver. `walkSections` traverses the result.

## The codec

`compactTree` / `expandTree` — dictionary-based tree compaction, implemented as the simplest possible consumer of `compile()`: a frequency pre-pass gives each subtree exactly one candidate (inline if it occurs once, hoisted if it repeats), so the selector has nothing to optimize. It doubles as the proof that the candidate API degrades gracefully to the trivial case.

```ts
import { compactTree, expandTree } from '@console-one/compile';

const compact = compactTree(bigRepetitiveJson); // { v: 1, dict: [...], root: ... }
const roundTripped = expandTree(compact);
```

## Utilities

- `structuralHash` / `djb2hex` — canonical structural hashing (the default site identity, hence the dedupe)
- `topoSort` — dependency-ordered emission within sections

## Status

`v0.1.0` — extracted and working (`npm run smoke` covers string output, multi-dim buckets, budget-constrained selection across all three strategies, and codec round-trips). No current downstream consumers among the live `@console-one` repos; kept for the next graph-to-budgeted-document problem. Tests run via `@console-one/assessable` (`file:../assessable` — flip to a semver range before publishing).

## Development

```sh
npm run build && npm run smoke   # assertion-based smoke suite
npm test                         # assessable-based tests
```

MIT © Andrew Chalmers
