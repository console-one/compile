// @console-one/compile — candidate-based hoist-aware compiler with
// budget-constrained selection (greedy / beam / Lagrangian relaxation).

export { compile, select, emit, walkSections } from './compile.js';

export type {
  BucketPath,
  Candidate,
  CandidateGraph,
  CandidateHandler,
  CompileOptions,
  Cost,
  EmitResult,
  Hoisted,
  Sections,
  SelectorOptions,
  Selection,
  Site,
} from './compile.js';

export { djb2, djb2hex, structuralHash } from './hash.js';
export { topoSort } from './topo.js';

// Codec — dictionary tree compaction implemented on top of compile().
export { compactTree, expandTree } from './codec.js';
export type { CompactedTree } from './codec.js';
