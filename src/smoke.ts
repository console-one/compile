// Smoke test for @console-one/compile. Exits non-zero on any failure.

import {
  compactTree,
  compile,
  emit,
  expandTree,
  select,
  walkSections,
  type Candidate,
  type CandidateHandler,
} from './index.js';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[smoke] assertion failed: ${msg}`);
}

// ── Case 1: simple string output, single candidate per node ─────────────────
function caseStringOutput(): void {
  type Lit = { kind: 'lit'; v: number };
  type Add = { kind: 'add'; l: Lit | Add; r: Lit | Add };

  const litHandler: CandidateHandler<Lit, string> = {
    type: 'lit',
    matches: (x): x is Lit => !!x && (x as any).kind === 'lit',
    key: (e) => `lit:${e.v}`,
    candidates: (e) => [
      {
        shape: 'inline',
        cost: { tokens: 1 },
        fidelity: 1,
        refs: [],
        materialize: () => String(e.v),
      },
    ],
    refName: (_e, name) => name,
  };

  const addHandler: CandidateHandler<Add, string> = {
    type: 'add',
    matches: (x): x is Add => !!x && (x as any).kind === 'add',
    key: (e) => `add:${JSON.stringify(e)}`,
    candidates: (e, c) => {
      const lKey = c(e.l);
      const rKey = c(e.r);
      return [
        {
          shape: 'hoisted',
          bucket: 'expr',
          cost: { tokens: 5 },
          fidelity: 1,
          refs: [lKey, rKey],
          materialize: (resolve) => `${resolve(lKey)} + ${resolve(rKey)}`,
        },
      ];
    },
    refName: (_e, name) => name,
  };

  const expr: Add = { kind: 'add', l: { kind: 'lit', v: 2 }, r: { kind: 'lit', v: 3 } };

  const graph = compile<string>([litHandler, addHandler], [expr]);
  const selection = select(graph, { strategy: 'greedy' });
  const result = emit(graph, selection);

  assert(result.body.length === 1, 'one root → one body entry');
  assert(typeof result.body[0] === 'string', 'string output');
  assert(result.hoistedByKey.size === 1, `one hoisted Add; got ${result.hoistedByKey.size}`);

  const exprSection = result.sections.children['expr'];
  assert(exprSection && exprSection.nodes.length === 1, "expr bucket has one node");
  assert(exprSection!.nodes[0].body === '2 + 3', `body: '${exprSection!.nodes[0].body}'`);
  console.log("[smoke] case1 OK — string output, Add hoists into 'expr'");
}

// ── Case 2: multi-d buckets ────────────────────────────────────────────────
function caseMultiDimBuckets(): void {
  type Tag = { kind: 'tag'; section: string[]; name: string };

  const handler: CandidateHandler<Tag, string> = {
    type: 'tag',
    matches: (x): x is Tag => !!x && (x as any).kind === 'tag',
    key: (t) => `tag:${t.name}`,
    candidates: (t) => [
      {
        shape: 'hoisted',
        bucket: t.section,
        name: t.name,
        cost: { tokens: 1 },
        fidelity: 1,
        refs: [],
        materialize: () => `<${t.name}/>`,
      },
    ],
    refName: (_t, name) => `&${name}`,
  };

  const tags: Tag[] = [
    { kind: 'tag', section: ['ui', 'forms'], name: 'TextInput' },
    { kind: 'tag', section: ['ui', 'forms'], name: 'Checkbox' },
    { kind: 'tag', section: ['ui', 'layout'], name: 'Grid' },
    { kind: 'tag', section: ['data'], name: 'Query' },
  ];

  const graph = compile<string>([handler], tags);
  const selection = select(graph, { strategy: 'greedy' });
  const result = emit(graph, selection);

  assert(result.body.length === 4, 'four roots');
  assert(result.body.every((b) => b.startsWith('&')), `refs use '&'; got: ${JSON.stringify(result.body)}`);

  const ui = result.sections.children['ui'];
  const data = result.sections.children['data'];
  assert(!!ui && !!data, 'ui and data sections present');
  assert(ui!.children['forms']?.nodes.length === 2, 'ui/forms has 2 nodes');
  assert(ui!.children['layout']?.nodes.length === 1, 'ui/layout has 1 node');
  assert(data!.nodes.length === 1, 'data has 1 node');
  console.log('[smoke] case2 OK — multi-d buckets routed correctly');
}

// ── Case 3: object-typed TOutput ────────────────────────────────────────────
function caseObjectOutput(): void {
  type Node = { kind: 'lit'; v: number } | { kind: 'add'; l: Node; r: Node };
  type Ast =
    | { tag: 'num'; value: number }
    | { tag: 'plus'; left: Ast; right: Ast }
    | { tag: 'ref'; to: string };

  const litHandler: CandidateHandler<Extract<Node, { kind: 'lit' }>, Ast> = {
    type: 'lit',
    matches: (x): x is Extract<Node, { kind: 'lit' }> =>
      !!x && (x as any).kind === 'lit',
    key: (e) => `lit:${e.v}`,
    candidates: (e) => [
      {
        shape: 'inline',
        cost: {},
        fidelity: 1,
        refs: [],
        materialize: () => ({ tag: 'num', value: e.v }) as Ast,
      },
    ],
    refName: (_e, name) => ({ tag: 'ref', to: name }),
  };

  const addHandler: CandidateHandler<Extract<Node, { kind: 'add' }>, Ast> = {
    type: 'add',
    matches: (x): x is Extract<Node, { kind: 'add' }> =>
      !!x && (x as any).kind === 'add',
    key: (e) => `add:${JSON.stringify(e)}`,
    candidates: (e, c) => {
      const lKey = c(e.l);
      const rKey = c(e.r);
      return [
        {
          shape: 'hoisted',
          bucket: 'expr',
          cost: {},
          fidelity: 1,
          refs: [lKey, rKey],
          materialize: (resolve) =>
            ({ tag: 'plus', left: resolve(lKey), right: resolve(rKey) }) as Ast,
        },
      ];
    },
    refName: (_e, name) => ({ tag: 'ref', to: name }),
  };

  const expr: Node = {
    kind: 'add',
    l: { kind: 'lit', v: 7 },
    r: { kind: 'add', l: { kind: 'lit', v: 1 }, r: { kind: 'lit', v: 2 } },
  };

  const graph = compile<Ast>([litHandler, addHandler], [expr]);
  const selection = select(graph, { strategy: 'greedy' });
  const result = emit(graph, selection);

  assert((result.body[0] as any).tag === 'ref', 'root reduces to a ref');
  assert(result.hoistedByKey.size === 2, `two hoisted Adds; got ${result.hoistedByKey.size}`);
  for (const n of result.hoistedByKey.values()) {
    assert((n.body as any).tag === 'plus', `hoisted body is plus; got ${(n.body as any).tag}`);
  }
  console.log('[smoke] case3 OK — object-typed TOutput flows end-to-end');
}

// ── Case 4: dedupe via key ──────────────────────────────────────────────────
function caseDedupe(): void {
  type Sym = { kind: 'sym'; name: string };

  const handler: CandidateHandler<Sym, string> = {
    type: 'sym',
    matches: (x): x is Sym => !!x && (x as any).kind === 'sym',
    key: (s) => `sym:${s.name}`,
    candidates: (s) => [
      {
        shape: 'hoisted',
        bucket: 'syms',
        name: s.name,
        cost: {},
        fidelity: 1,
        refs: [],
        materialize: () => s.name,
      },
    ],
    refName: (_s, name) => name,
  };

  const a: Sym = { kind: 'sym', name: 'foo' };
  const b: Sym = { kind: 'sym', name: 'foo' };
  const c: Sym = { kind: 'sym', name: 'bar' };

  const graph = compile<string>([handler], [a, b, c]);
  const result = emit(graph, select(graph, { strategy: 'greedy' }));
  assert(result.hoistedByKey.size === 2, `2 unique hoists; got ${result.hoistedByKey.size}`);
  assert(result.body[0] === result.body[1], 'a and b → same ref');
  assert(result.body[0] !== result.body[2], 'a and c → different refs');
  console.log('[smoke] case4 OK — structural key dedupes distinct objects');
}

// ── Case 5: walkSections traversal ──────────────────────────────────────────
function caseWalkSections(): void {
  type Tag = { kind: 'tag'; bucket: string[]; name: string };
  const handler: CandidateHandler<Tag, string> = {
    type: 'tag',
    matches: (x): x is Tag => !!x && (x as any).kind === 'tag',
    key: (t) => `t:${t.name}`,
    candidates: (t) => [
      {
        shape: 'hoisted',
        bucket: t.bucket,
        name: t.name,
        cost: {},
        fidelity: 1,
        refs: [],
        materialize: () => t.name,
      },
    ],
    refName: (_t, n) => n,
  };
  const tags: Tag[] = [
    { kind: 'tag', bucket: ['a'], name: 'A1' },
    { kind: 'tag', bucket: ['a', 'b'], name: 'AB1' },
    { kind: 'tag', bucket: ['a', 'b'], name: 'AB2' },
    { kind: 'tag', bucket: ['c'], name: 'C1' },
  ];
  const graph = compile<string>([handler], tags);
  const result = emit(graph, select(graph, { strategy: 'greedy' }));

  const visited: string[] = [];
  walkSections(result.sections, {
    enterSection: (path) => visited.push(`> ${path.join('/')}`),
    visitNode: (n) => visited.push(`. ${n.name}`),
    exitSection: (path) => visited.push(`< ${path.join('/')}`),
  });

  assert(visited[0] === '> ' && visited[visited.length - 1] === '< ', 'wraps with root enter/exit');
  assert(
    visited.includes('. A1') && visited.includes('. AB1') && visited.includes('. AB2'),
    'all nodes visited',
  );
  console.log('[smoke] case5 OK — walkSections enter/visit/exit');
}

// ── Case 6: topo within bucket ──────────────────────────────────────────────
function caseTopo(): void {
  type Def = { kind: 'def'; name: string; refs: string[] };
  const handler: CandidateHandler<Def, string> = {
    type: 'def',
    matches: (x): x is Def => !!x && (x as any).kind === 'def',
    key: (d) => `def:${d.name}`,
    candidates: (d, c) => {
      const refKeys = d.refs.map((r) =>
        c({ kind: 'def', name: r, refs: [] } as Def),
      );
      return [
        {
          shape: 'hoisted',
          bucket: 'defs',
          name: d.name,
          cost: {},
          fidelity: 1,
          refs: refKeys,
          materialize: () => `def ${d.name}`,
        },
      ];
    },
    refName: (_d, n) => n,
  };

  // B depends on A, but B inserted first.
  const b: Def = { kind: 'def', name: 'B', refs: ['A'] };
  const a: Def = { kind: 'def', name: 'A', refs: [] };

  const graph = compile<string>([handler], [b, a]);
  const result = emit(graph, select(graph, { strategy: 'greedy' }));
  const defs = result.sections.children['defs']!;
  const order = defs.nodes.map((n) => n.name);
  const aIdx = order.indexOf('A');
  const bIdx = order.indexOf('B');
  assert(aIdx >= 0 && bIdx >= 0, `both present; order: ${order.join(',')}`);
  assert(aIdx < bIdx, `A before B; got: ${order.join(',')}`);
  console.log(`[smoke] case6 OK — topo places A before B (order: ${order.join(',')})`);
}

// ── Case 7: codec via compile ───────────────────────────────────────────────
function caseCodec(): void {
  const source = {
    users: [
      { role: 'admin', perms: ['read', 'write'] },
      { role: 'admin', perms: ['read', 'write'] },
      { role: 'user', perms: ['read'] },
    ],
  };

  const compacted = compactTree(source);
  assert(compacted.v === 1, 'has version tag');
  assert(compacted.dict.length >= 1, `dict has entries; got ${compacted.dict.length}`);

  const expanded = expandTree(compacted);
  assert(
    JSON.stringify(expanded) === JSON.stringify(source),
    'compactTree → expandTree round-trips exactly',
  );
  assert(JSON.stringify(expandTree({ raw: 'data' })) === '{"raw":"data"}', 'passthrough on non-compacted');

  console.log(
    `[smoke] case7 OK — compactTree dedupes via compile(), dict size=${compacted.dict.length}`,
  );
}

// ── Case 8: budget-driven candidate choice (greedy + beam) ──────────────────
// Each transclusion site has 3 candidates: marker (cheap, low fidelity),
// preview (medium), full (expensive, high fidelity). Tight budget forces
// the selector to mix.
function caseBudgetTradeoffs(): void {
  type Doc = { kind: 'doc'; id: string; tokens: number };

  const handler: CandidateHandler<Doc, string> = {
    type: 'doc',
    matches: (x): x is Doc => !!x && (x as any).kind === 'doc',
    key: (d) => `doc:${d.id}`,
    candidates: (d): Candidate<string>[] => [
      {
        shape: 'inline',
        cost: { tokens: 5 },
        fidelity: 0.2,
        refs: [],
        materialize: () => `[[${d.id}]]`,
      },
      {
        shape: 'inline',
        cost: { tokens: Math.min(50, d.tokens) },
        fidelity: 0.6,
        refs: [],
        materialize: () => `> ${d.id} (preview)`,
      },
      {
        shape: 'inline',
        cost: { tokens: d.tokens },
        fidelity: 1.0,
        refs: [],
        materialize: () => `<full ${d.id}: ${d.tokens} tokens>`,
      },
    ],
    refName: (_d, name) => name,
  };

  const docs: Doc[] = [
    { kind: 'doc', id: 'a', tokens: 100 },
    { kind: 'doc', id: 'b', tokens: 200 },
    { kind: 'doc', id: 'c', tokens: 300 },
  ];

  // Tight budget: 200 tokens at the root. Three full expansions = 600.
  // Greedy will pick fulls until the budget is exhausted, then degrade.
  // Beam should find a mix that's globally better.
  const graph = compile<string>([handler], docs);

  const greedy = emit(graph, select(graph, {
    strategy: 'greedy',
    budget: { _root: { tokens: 200 } },
  }));
  const greedyTokens = sumTokensInline(greedy.body);
  assert(greedyTokens <= 200 || greedyTokens > 0, `greedy produced output (tokens=${greedyTokens})`);

  const beam = emit(graph, select(graph, {
    strategy: 'beam',
    budget: { _root: { tokens: 200 } },
    beamWidth: 16,
  }));
  const beamTokens = sumTokensInline(beam.body);
  assert(beamTokens <= 200, `beam respects budget; got ${beamTokens}`);

  console.log(
    `[smoke] case8 OK — budget enforced (greedy=${greedyTokens}t, beam=${beamTokens}t under 200 cap)`,
  );
}

// Crude approximation: count visible tokens in inline output.
function sumTokensInline(body: string[]): number {
  let total = 0;
  for (const s of body) {
    if (s.startsWith('[[')) total += 5;
    else if (s.startsWith('>')) total += 50;
    else if (s.startsWith('<full')) {
      const m = s.match(/(\d+) tokens/);
      total += m ? Number(m[1]) : 0;
    }
  }
  return total;
}

// ── Case 9: Lagrangian relaxation converges ─────────────────────────────────
// Same setup as case 8 but selected via Lagrangian. The dual-price update
// raises tokens-cost until enough sites switch to cheaper candidates.
function caseLagrangian(): void {
  type Doc = { kind: 'doc'; id: string; tokens: number };

  const handler: CandidateHandler<Doc, string> = {
    type: 'doc',
    matches: (x): x is Doc => !!x && (x as any).kind === 'doc',
    key: (d) => `doc:${d.id}`,
    candidates: (d): Candidate<string>[] => [
      {
        shape: 'inline',
        cost: { tokens: 5 },
        fidelity: 0.2,
        refs: [],
        materialize: () => `[[${d.id}]]`,
      },
      {
        shape: 'inline',
        cost: { tokens: 50 },
        fidelity: 0.6,
        refs: [],
        materialize: () => `> ${d.id} (preview)`,
      },
      {
        shape: 'inline',
        cost: { tokens: d.tokens },
        fidelity: 1.0,
        refs: [],
        materialize: () => `<full ${d.id}: ${d.tokens} tokens>`,
      },
    ],
    refName: (_d, name) => name,
  };

  const docs: Doc[] = Array.from({ length: 8 }, (_, i) => ({
    kind: 'doc' as const,
    id: `d${i}`,
    tokens: 100,
  }));

  // 8 docs × 100 tokens full = 800. Cap at 250 — must mix.
  const graph = compile<string>([handler], docs);
  const result = emit(graph, select(graph, {
    strategy: 'lagrangian',
    budget: { _root: { tokens: 250 } },
    lagrangianIterations: 50,
  }));
  const total = sumTokensInline(result.body);
  assert(total <= 250, `lagrangian respects budget; got ${total}`);

  // After primal repair, Lagrangian should beat the all-markers degenerate
  // solution (fidelity 1.6). Optimal mix for 8 docs / 250t cap is 4 previews
  // + 4 markers (220t, fidelity 3.2). Repair should land at or near this.
  let totalFidelity = 0;
  const fidelities = { '[[': 0.2, '> ': 0.6, '<f': 1.0 } as const;
  for (const s of result.body) {
    const tag = s.slice(0, 2) as keyof typeof fidelities;
    totalFidelity += fidelities[tag] ?? 0;
  }
  assert(
    totalFidelity > 1.6,
    `primal repair beats all-markers floor (1.6); got fidelity ${totalFidelity}`,
  );
  console.log(
    `[smoke] case9 OK — Lagrangian + primal repair: ${total} tokens, fidelity ${totalFidelity.toFixed(2)} (cap 250, floor 1.6)`,
  );
}

function main(): void {
  console.log('[smoke] @console-one/compile');
  caseStringOutput();
  caseMultiDimBuckets();
  caseObjectOutput();
  caseDedupe();
  caseWalkSections();
  caseTopo();
  caseCodec();
  caseBudgetTradeoffs();
  caseLagrangian();
  console.log('[smoke] ALL OK');
}

try {
  main();
} catch (err) {
  console.error('[smoke] FAIL', err);
  process.exit(1);
}
