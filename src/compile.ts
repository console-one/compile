// Hoist-aware compiler. Generic in the output type. Each node enumerates a
// set of *candidate* representations, each with a cost vector and fidelity
// score. Selection picks one candidate per required site under per-section
// budget constraints (greedy / beam / Lagrangian).
//
// The pipeline:
//
//   compile(handlers, roots) -> CandidateGraph
//                                  │
//   select(graph, opts) ───────────┤  picks one Candidate per site
//                                  ▼
//   emit(graph, selection) -> { body, sections, hoistedByKey }
//
// The orchestrator owns identity, dedupe, ref propagation, name allocation,
// and topo within sections. Renderers own the per-node enumeration of
// representation options and how to materialize each.

import { djb2hex, structuralHash } from './hash.js';
import { topoSort } from './topo.js';

// ── Public types ────────────────────────────────────────────────────────────

export type BucketPath = string[];
export type Cost = Record<string, number>;

// One legal representation of a node.
//
//   shape    'inline' charges cost to the parent's effective section, per
//            occurrence. 'hoisted' charges cost to bucket once, regardless
//            of how many places reference it.
//   refs     site keys this candidate transitively requires. The selector
//            propagates "required" through these.
//   materialize  given a resolver that returns the chosen output for a ref
//            site, produce this candidate's TOutput.
export type Candidate<TOutput> = {
  shape: 'inline' | 'hoisted';
  cost: Cost;
  fidelity: number;
  bucket?: string | BucketPath;
  name?: string;
  refs: string[];
  materialize: (resolve: (refKey: string) => TOutput) => TOutput;
};

// Renderer for one kind of input node. `compile(child)` returns the child's
// site key (a string). The parent embeds that key in its candidate's `refs`
// and resolves it via the materialize closure post-selection.
export type CandidateHandler<TInput, TOutput> = {
  type: string;
  matches(x: unknown): x is TInput;
  key?(x: TInput): string;
  candidates(
    x: TInput,
    compile: (child: unknown) => string,
  ): Candidate<TOutput>[];
  refName(x: TInput, name: string): TOutput;
};

// Per-site information in the compiled graph.
export type Site<TOutput> = {
  type: string;
  candidates: Candidate<TOutput>[];
  refName: (name: string) => TOutput;
  defaultBucket: string;
};

export type CandidateGraph<TOutput> = {
  sites: Map<string, Site<TOutput>>;
  roots: string[];
};

export type Selection<TOutput> = Map<string, Candidate<TOutput>>;

export type CompileOptions<TOutput> = {
  // What to do with nodes no handler matches. Default: throw.
  unhandled?: (node: unknown) => TOutput;
};

export type SelectorOptions = {
  // Per-section, per-cost-dimension cap. budget["ui"]["tokens"] = 4000 means:
  // the sum of cost.tokens across (a) hoisted candidates whose bucket is "ui"
  // and (b) inline candidates whose effective parent-section is "ui" must
  // stay under 4000.
  budget?: Record<string, Cost>;

  strategy: 'greedy' | 'beam' | 'lagrangian';

  // Beam search width. Default 8.
  beamWidth?: number;

  // Lagrangian relaxation parameters.
  lagrangianIterations?: number;     // default 30
  lagrangianStepSize?: number;       // default 0.5
};

export type Hoisted<TOutput> = {
  key: string;
  name: string;
  body: TOutput;
  bucket: BucketPath;
  deps: string[];
};

export type Sections<TOutput> = {
  nodes: Hoisted<TOutput>[];
  children: { [segment: string]: Sections<TOutput> };
};

export type EmitResult<TOutput> = {
  body: TOutput[];
  sections: Sections<TOutput>;
  hoistedByKey: Map<string, Hoisted<TOutput>>;
};

const ROOT_SECTION = '_root';

// ── compile ─────────────────────────────────────────────────────────────────

export function compile<TOutput>(
  handlers: CandidateHandler<any, TOutput>[],
  roots: unknown[],
  opts: CompileOptions<TOutput> = {},
): CandidateGraph<TOutput> {
  const sites = new Map<string, Site<TOutput>>();
  const onUnhandled =
    opts.unhandled ??
    ((node: unknown): TOutput => {
      throw new Error(`No handler matched node: ${JSON.stringify(node)}`);
    });

  const findHandler = (node: unknown): CandidateHandler<any, TOutput> | undefined =>
    handlers.find((h) => h.matches(node));

  const computeKey = (handler: CandidateHandler<any, TOutput>, node: unknown): string =>
    handler.key?.(node) ?? `${handler.type}:${structuralHash(node)}`;

  // The visitor returns a site key. It also populates `sites` as it goes.
  // Cycles short-circuit because the site is reserved with a placeholder
  // entry before the handler is invoked.
  function visit(node: unknown): string {
    const handler = findHandler(node);
    if (!handler) {
      const key = `_unhandled:${structuralHash(node)}`;
      if (!sites.has(key)) {
        sites.set(key, {
          type: '_unhandled',
          candidates: [
            {
              shape: 'inline',
              cost: {},
              fidelity: 0,
              refs: [],
              materialize: () => onUnhandled(node),
            },
          ],
          refName: (name) => name as unknown as TOutput,
          defaultBucket: 'unhandled',
        });
      }
      return key;
    }

    const key = computeKey(handler, node);
    if (sites.has(key)) return key;

    // Reserve so cyclic refs short-circuit cleanly.
    const placeholder: Site<TOutput> = {
      type: handler.type,
      candidates: [],
      refName: (name) => handler.refName(node, name),
      defaultBucket: handler.type,
    };
    sites.set(key, placeholder);

    placeholder.candidates = handler.candidates(node, visit);

    return key;
  }

  const rootKeys = roots.map(visit);
  return { sites, roots: rootKeys };
}

// ── select ──────────────────────────────────────────────────────────────────

function bucketOf<TOutput>(c: Candidate<TOutput>, defaultBucket: string): string {
  if (c.bucket === undefined) return defaultBucket;
  if (typeof c.bucket === 'string') return c.bucket;
  return c.bucket[0] ?? defaultBucket;
}

function fullBucketPath<TOutput>(c: Candidate<TOutput>, defaultBucket: string): BucketPath {
  if (c.bucket === undefined) return [defaultBucket];
  if (typeof c.bucket === 'string') return [c.bucket];
  return c.bucket.length ? c.bucket.slice() : [defaultBucket];
}

function effectiveSection<TOutput>(
  c: Candidate<TOutput>,
  parentSection: string,
  defaultBucket: string,
): string {
  return c.shape === 'hoisted' ? bucketOf(c, defaultBucket) : parentSection;
}

function addCost(into: Record<string, Cost>, section: string, cost: Cost): void {
  const sec = into[section] ?? (into[section] = {});
  for (const [dim, v] of Object.entries(cost)) sec[dim] = (sec[dim] ?? 0) + v;
}

function cloneCosts(costs: Record<string, Cost>): Record<string, Cost> {
  const out: Record<string, Cost> = {};
  for (const [s, c] of Object.entries(costs)) out[s] = { ...c };
  return out;
}

function violatesBudget(
  costs: Record<string, Cost>,
  budget: Record<string, Cost> | undefined,
): boolean {
  if (!budget) return false;
  for (const [section, caps] of Object.entries(budget)) {
    const used = costs[section];
    if (!used) continue;
    for (const [dim, cap] of Object.entries(caps)) {
      if ((used[dim] ?? 0) > cap) return true;
    }
  }
  return false;
}

// Compute totals charged to each section for a complete (or partial) Selection.
// Hoisted candidates: charged once at their bucket. Inline candidates: charged
// per occurrence at the parent's effective section.
function computeCosts<TOutput>(
  graph: CandidateGraph<TOutput>,
  selection: Selection<TOutput>,
): Record<string, Cost> {
  const costs: Record<string, Cost> = {};
  const hoistedCharged = new Set<string>();

  function walk(siteKey: string, parentSection: string): void {
    const c = selection.get(siteKey);
    if (!c) return;
    const site = graph.sites.get(siteKey);
    if (!site) return;

    const section = effectiveSection(c, parentSection, site.defaultBucket);

    if (c.shape === 'hoisted') {
      if (hoistedCharged.has(siteKey)) return; // already accounted; don't recurse twice
      hoistedCharged.add(siteKey);
      addCost(costs, section, c.cost);
      for (const r of c.refs) walk(r, section);
    } else {
      // Inline charged per occurrence; recurse per occurrence.
      addCost(costs, section, c.cost);
      for (const r of c.refs) walk(r, section);
    }
  }

  for (const root of graph.roots) walk(root, ROOT_SECTION);
  return costs;
}

function totalFidelity<TOutput>(selection: Selection<TOutput>): number {
  let f = 0;
  for (const c of selection.values()) f += c.fidelity;
  return f;
}

// Pick best candidate at a site under linear pricing (Lagrangian dual).
// score = fidelity - Σ λ[section(c)][dim] · cost[dim]
function priceAdjustedBest<TOutput>(
  site: Site<TOutput>,
  parentSection: string,
  lambda: Record<string, Cost>,
): Candidate<TOutput> {
  let best = site.candidates[0];
  let bestScore = -Infinity;
  for (const c of site.candidates) {
    const section = effectiveSection(c, parentSection, site.defaultBucket);
    const prices = lambda[section] ?? {};
    let penalty = 0;
    for (const [dim, v] of Object.entries(c.cost)) penalty += (prices[dim] ?? 0) * v;
    const score = c.fidelity - penalty;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// Greedy: BFS from roots; at each site pick highest-fidelity candidate that
// keeps the running cost under budget. Falls back to cheapest if no
// candidate fits. Single-pass, deterministic, no backtracking.
function selectGreedy<TOutput>(
  graph: CandidateGraph<TOutput>,
  opts: SelectorOptions,
): Selection<TOutput> {
  const selection: Selection<TOutput> = new Map();
  const queue: Array<{ site: string; parentSection: string }> = graph.roots.map(
    (s) => ({ site: s, parentSection: ROOT_SECTION }),
  );
  const costs: Record<string, Cost> = {};

  while (queue.length) {
    const { site, parentSection } = queue.shift()!;
    if (selection.has(site)) continue;
    const siteData = graph.sites.get(site);
    if (!siteData || siteData.candidates.length === 0) continue;

    const sorted = [...siteData.candidates].sort((a, b) => b.fidelity - a.fidelity);
    let chosen: Candidate<TOutput> | undefined;

    for (const c of sorted) {
      const section = effectiveSection(c, parentSection, siteData.defaultBucket);
      const tentative = cloneCosts(costs);
      addCost(tentative, section, c.cost);
      if (!violatesBudget(tentative, opts.budget)) {
        chosen = c;
        break;
      }
    }

    if (!chosen) {
      // Budget can't accommodate anything; pick the cheapest by total cost.
      chosen = [...siteData.candidates].sort(
        (a, b) =>
          Object.values(a.cost).reduce((s, v) => s + v, 0) -
          Object.values(b.cost).reduce((s, v) => s + v, 0),
      )[0];
    }

    selection.set(site, chosen);
    const section = effectiveSection(chosen, parentSection, siteData.defaultBucket);
    addCost(costs, section, chosen.cost);

    for (const r of chosen.refs) {
      if (!selection.has(r)) queue.push({ site: r, parentSection: section });
    }
  }

  return selection;
}

// Beam search: maintain top-K partial selections, expanding one site at a
// time. Each state explores all candidates at the next frontier site, prunes
// budget violations, and the beam keeps the K highest-fidelity successors.
//
// Order of expansion is deterministic (queue order from roots), which means
// two states see frontier sites in the same order. That makes their
// fidelity comparable at every step.
function selectBeam<TOutput>(
  graph: CandidateGraph<TOutput>,
  opts: SelectorOptions,
): Selection<TOutput> {
  type State = {
    selection: Selection<TOutput>;
    frontier: Array<{ site: string; parentSection: string }>;
    costs: Record<string, Cost>;
    fidelity: number;
  };

  const K = Math.max(1, opts.beamWidth ?? 8);

  let beam: State[] = [
    {
      selection: new Map(),
      frontier: graph.roots.map((s) => ({ site: s, parentSection: ROOT_SECTION })),
      costs: {},
      fidelity: 0,
    },
  ];

  while (beam.some((s) => s.frontier.length > 0)) {
    const expanded: State[] = [];

    for (const state of beam) {
      if (state.frontier.length === 0) {
        expanded.push(state);
        continue;
      }
      const [head, ...rest] = state.frontier;

      if (state.selection.has(head.site)) {
        expanded.push({ ...state, frontier: rest });
        continue;
      }

      const siteData = graph.sites.get(head.site);
      if (!siteData || siteData.candidates.length === 0) {
        expanded.push({ ...state, frontier: rest });
        continue;
      }

      for (const c of siteData.candidates) {
        const section = effectiveSection(c, head.parentSection, siteData.defaultBucket);
        const newCosts = cloneCosts(state.costs);
        addCost(newCosts, section, c.cost);
        if (violatesBudget(newCosts, opts.budget)) continue;

        const newSelection = new Map(state.selection);
        newSelection.set(head.site, c);

        const newFrontier = rest.slice();
        for (const r of c.refs) {
          if (!newSelection.has(r) && !newFrontier.some((f) => f.site === r)) {
            newFrontier.push({ site: r, parentSection: section });
          }
        }

        expanded.push({
          selection: newSelection,
          frontier: newFrontier,
          costs: newCosts,
          fidelity: state.fidelity + c.fidelity,
        });
      }
    }

    if (expanded.length === 0) {
      // Beam dead-ended: every branch violated budget. Fall back to greedy
      // so the caller gets *some* selection rather than an exception.
      return selectGreedy(graph, opts);
    }

    expanded.sort((a, b) => b.fidelity - a.fidelity);
    beam = expanded.slice(0, K);
  }

  return beam[0]!.selection;
}

// Lagrangian relaxation: dualize the per-section budget constraints. Per
// site, pick the candidate maximizing (fidelity - λ·cost). Compute realized
// costs, update λ via subgradient (raise prices on over-budget sections,
// relax on under-budget). Iterate. Track the best feasible selection seen.
//
// Convergence is subgradient — not monotone — so we always return the best
// feasible iterate, falling back to the final iterate if no feasible one
// was found within the iteration budget.
function selectLagrangian<TOutput>(
  graph: CandidateGraph<TOutput>,
  opts: SelectorOptions,
): Selection<TOutput> {
  const iterations = Math.max(1, opts.lagrangianIterations ?? 30);
  const stepSize = opts.lagrangianStepSize ?? 0.5;
  const budget = opts.budget ?? {};

  // Initialize λ = 0 for every (section, dim) that has a budget constraint.
  const lambda: Record<string, Cost> = {};
  for (const [section, caps] of Object.entries(budget)) {
    lambda[section] = {};
    for (const dim of Object.keys(caps)) lambda[section][dim] = 0;
  }

  // Solve relaxed (per-site independent) problem under current prices.
  const solveRelaxed = (): Selection<TOutput> => {
    const selection: Selection<TOutput> = new Map();
    const queue: Array<{ site: string; parentSection: string }> = graph.roots.map(
      (s) => ({ site: s, parentSection: ROOT_SECTION }),
    );
    while (queue.length) {
      const { site, parentSection } = queue.shift()!;
      if (selection.has(site)) continue;
      const siteData = graph.sites.get(site);
      if (!siteData || siteData.candidates.length === 0) continue;
      const c = priceAdjustedBest(siteData, parentSection, lambda);
      selection.set(site, c);
      const section = effectiveSection(c, parentSection, siteData.defaultBucket);
      for (const r of c.refs) {
        if (!selection.has(r)) queue.push({ site: r, parentSection: section });
      }
    }
    return selection;
  };

  let bestFeasible: Selection<TOutput> | null = null;
  let bestFidelity = -Infinity;
  let last: Selection<TOutput> = solveRelaxed();

  for (let iter = 0; iter < iterations; iter++) {
    const selection = solveRelaxed();
    last = selection;
    const realized = computeCosts(graph, selection);

    if (!violatesBudget(realized, budget)) {
      const fid = totalFidelity(selection);
      if (fid > bestFidelity) {
        bestFidelity = fid;
        bestFeasible = new Map(selection);
      }
    }

    // Subgradient update on λ. Each cap-violation increases its dual price;
    // slack lowers it (clamped at 0). Step is normalized by cap so dimensions
    // with very different magnitudes converge at similar rates.
    let anyChange = false;
    for (const [section, caps] of Object.entries(budget)) {
      for (const [dim, cap] of Object.entries(caps)) {
        const used = realized[section]?.[dim] ?? 0;
        const subgradient = used - cap; // > 0 when over-budget
        const norm = Math.max(1, Math.abs(cap));
        const updated = Math.max(0, lambda[section][dim] + (stepSize * subgradient) / norm);
        if (updated !== lambda[section][dim]) {
          lambda[section][dim] = updated;
          anyChange = true;
        }
      }
    }

    if (!anyChange) break; // fixed point
  }

  const candidate = bestFeasible ?? last;
  return primalRepair(graph, candidate, budget);
}

// Primal repair: a feasible Lagrangian iterate is often a uniform "all-X"
// selection because every site sees the same dual prices and flips
// together. Repair walks the selection and greedily upgrades individual
// sites to higher-fidelity candidates as long as budget holds. Skips
// swaps that introduce previously-unrequired refs (those would need a
// cascading re-solve, which negates the relaxation's value).
function primalRepair<TOutput>(
  graph: CandidateGraph<TOutput>,
  initial: Selection<TOutput>,
  budget: Record<string, Cost>,
): Selection<TOutput> {
  if (Object.keys(budget).length === 0) return initial;

  const selection = new Map(initial);
  let improved = true;
  let guard = graph.sites.size * 4; // bound just in case fidelity ties cycle

  while (improved && guard-- > 0) {
    improved = false;
    for (const [siteKey, current] of selection) {
      const site = graph.sites.get(siteKey);
      if (!site) continue;

      // Best alternative: highest fidelity among candidates that (a) don't
      // expand the required-site set and (b) keep the budget feasible.
      let bestSwap: Candidate<TOutput> | null = null;
      let bestFidelity = current.fidelity;

      for (const c of site.candidates) {
        if (c === current) continue;
        if (c.fidelity <= bestFidelity) continue;

        // Skip if this candidate's refs introduce sites not currently in the
        // selection — we'd need to also pick candidates for those, which
        // breaks the local-swap simplicity.
        const introducesNewRefs = c.refs.some((r) => !selection.has(r));
        if (introducesNewRefs) continue;

        const trial = new Map(selection);
        trial.set(siteKey, c);
        const realized = computeCosts(graph, trial);
        if (violatesBudget(realized, budget)) continue;

        bestSwap = c;
        bestFidelity = c.fidelity;
      }

      if (bestSwap) {
        selection.set(siteKey, bestSwap);
        improved = true;
      }
    }
  }

  return selection;
}

export function select<TOutput>(
  graph: CandidateGraph<TOutput>,
  opts: SelectorOptions,
): Selection<TOutput> {
  switch (opts.strategy) {
    case 'greedy':
      return selectGreedy(graph, opts);
    case 'beam':
      return selectBeam(graph, opts);
    case 'lagrangian':
      return selectLagrangian(graph, opts);
  }
}

// ── emit ────────────────────────────────────────────────────────────────────

function emptySections<TOutput>(): Sections<TOutput> {
  return { nodes: [], children: {} };
}

function insertIntoSections<TOutput>(
  root: Sections<TOutput>,
  path: BucketPath,
  node: Hoisted<TOutput>,
): void {
  let cursor = root;
  for (const segment of path) {
    if (!cursor.children[segment]) cursor.children[segment] = emptySections();
    cursor = cursor.children[segment];
  }
  cursor.nodes.push(node);
}

function sortSectionTree<TOutput>(sections: Sections<TOutput>): void {
  sections.nodes = topoSort(
    sections.nodes,
    (n) => n.key,
    (n) => n.deps,
  );
  for (const child of Object.values(sections.children)) sortSectionTree(child);
}

// Reachable hoisted descendants of a site, traversing through inline ones.
function reachableHoisted<TOutput>(
  startKey: string,
  selection: Selection<TOutput>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  function walk(key: string): void {
    const c = selection.get(key);
    if (!c) return;
    for (const r of c.refs) {
      const rc = selection.get(r);
      if (!rc) continue;
      if (rc.shape === 'hoisted') {
        if (!seen.has(r)) {
          seen.add(r);
          out.push(r);
        }
      } else {
        walk(r);
      }
    }
  }
  walk(startKey);
  return out;
}

function defaultNameFor(key: string, defaultBucket: string): string {
  const tag = (defaultBucket[0] ?? 'T').toUpperCase();
  return `${tag}_${djb2hex(key).slice(0, 6)}`;
}

export function emit<TOutput>(
  graph: CandidateGraph<TOutput>,
  selection: Selection<TOutput>,
): EmitResult<TOutput> {
  const hoistedByKey = new Map<string, Hoisted<TOutput>>();
  const sections = emptySections<TOutput>();
  const usedNames = new Set<string>();
  const namesByKey = new Map<string, string>();

  // Ref-form cache: every materialization of the same hoisted site returns
  // the same TOutput (refName(name)). Prevents redundant work and ensures
  // referential identity for downstream consumers.
  const refFormCache = new Map<string, TOutput>();

  function nameFor(siteKey: string): string {
    const cached = namesByKey.get(siteKey);
    if (cached !== undefined) return cached;

    const candidate = selection.get(siteKey)!;
    const site = graph.sites.get(siteKey)!;
    const base = candidate.name ?? defaultNameFor(siteKey, site.defaultBucket);

    let chosen = base;
    let i = 2;
    while (usedNames.has(chosen)) chosen = `${base}_${i++}`;
    usedNames.add(chosen);
    namesByKey.set(siteKey, chosen);
    return chosen;
  }

  // Materialization. Hoisted sites resolve to refName(name) in the parent's
  // output; their bodies are materialized once and registered in the
  // section tree. Inline sites materialize per occurrence.
  function resolve(siteKey: string): TOutput {
    const candidate = selection.get(siteKey);
    if (!candidate) {
      throw new Error(`emit: no selection for site ${siteKey}`);
    }
    const site = graph.sites.get(siteKey);
    if (!site) {
      throw new Error(`emit: missing site ${siteKey}`);
    }

    if (candidate.shape === 'inline') {
      return candidate.materialize(resolve);
    }

    const cached = refFormCache.get(siteKey);
    if (cached !== undefined) return cached;

    // First materialization: register the hoisted node and cache the ref.
    const name = nameFor(siteKey);
    const ref = site.refName(name);
    refFormCache.set(siteKey, ref);

    const body = candidate.materialize(resolve);
    const bucket = fullBucketPath(candidate, site.defaultBucket);
    const node: Hoisted<TOutput> = {
      key: siteKey,
      name,
      body,
      bucket,
      deps: reachableHoisted(siteKey, selection),
    };
    hoistedByKey.set(siteKey, node);
    insertIntoSections(sections, bucket, node);

    return ref;
  }

  const body = graph.roots.map(resolve);
  sortSectionTree(sections);

  return { body, sections, hoistedByKey };
}

// ── Section tree helper ─────────────────────────────────────────────────────

export function walkSections<TOutput>(
  sections: Sections<TOutput>,
  visitor: {
    enterSection?(path: BucketPath): void;
    visitNode?(node: Hoisted<TOutput>, path: BucketPath): void;
    exitSection?(path: BucketPath): void;
  },
  path: BucketPath = [],
): void {
  visitor.enterSection?.(path);
  for (const node of sections.nodes) visitor.visitNode?.(node, path);
  for (const [segment, child] of Object.entries(sections.children)) {
    walkSections(child, visitor, [...path, segment]);
  }
  visitor.exitSection?.(path);
}
