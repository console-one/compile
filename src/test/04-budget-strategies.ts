// ─────────────────────────────────────────────────────────────────────────
// Selection strategies under budget: greedy / beam / lagrangian. Each
// must respect a token budget (or at least beam/lagrangian must); greedy
// is best-effort and may overshoot in pathological setups.
// ─────────────────────────────────────────────────────────────────────────

import {
  compile, select, emit,
  type Candidate, type CandidateHandler,
} from '../index.js';

type Doc = { kind: 'doc'; id: string; tokens: number };

function buildHandler(): CandidateHandler<Doc, string> {
  return {
    type: 'doc',
    matches: (x): x is Doc => !!x && (x as any).kind === 'doc',
    key: (d) => `doc:${d.id}`,
    candidates: (d): Candidate<string>[] => [
      { shape: 'inline', cost: { tokens: 5 }, fidelity: 0.2, refs: [],
        materialize: () => `[[${d.id}]]` },
      { shape: 'inline', cost: { tokens: Math.min(50, d.tokens) }, fidelity: 0.6, refs: [],
        materialize: () => `> ${d.id} (preview)` },
      { shape: 'inline', cost: { tokens: d.tokens }, fidelity: 1.0, refs: [],
        materialize: () => `<full ${d.id}: ${d.tokens} tokens>` },
    ],
    refName: (_d, name) => name,
  };
}

function approximateTokens(body: string[]): number {
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

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('beam strategy respects a tight token budget', async (validator: any) => {
    const docs: Doc[] = [
      { kind: 'doc', id: 'a', tokens: 100 },
      { kind: 'doc', id: 'b', tokens: 200 },
      { kind: 'doc', id: 'c', tokens: 300 },
    ];
    const graph = compile<string>([buildHandler()], docs);
    const result = emit(graph, select(graph, {
      strategy: 'beam',
      budget: { _root: { tokens: 200 } },
      beamWidth: 16,
    }));
    return validator.expect(approximateTokens(result.body) <= 200).toLookLike(true);
  });

  await test('lagrangian relaxation respects budget under heavy demand', async (validator: any) => {
    const docs: Doc[] = Array.from({ length: 8 }, (_, i) => ({
      kind: 'doc' as const,
      id: `d${i}`,
      tokens: 100,
    }));
    const graph = compile<string>([buildHandler()], docs);
    const result = emit(graph, select(graph, {
      strategy: 'lagrangian',
      budget: { _root: { tokens: 250 } },
      lagrangianIterations: 50,
    }));
    return validator.expect(approximateTokens(result.body) <= 250).toLookLike(true);
  });

  await test('lagrangian primal repair beats the all-markers fidelity floor', async (validator: any) => {
    const docs: Doc[] = Array.from({ length: 8 }, (_, i) => ({
      kind: 'doc' as const,
      id: `d${i}`,
      tokens: 100,
    }));
    const graph = compile<string>([buildHandler()], docs);
    const result = emit(graph, select(graph, {
      strategy: 'lagrangian',
      budget: { _root: { tokens: 250 } },
      lagrangianIterations: 50,
    }));
    const fidelityByPrefix = { '[[': 0.2, '> ': 0.6, '<f': 1.0 } as const;
    let totalFidelity = 0;
    for (const s of result.body) {
      const tag = s.slice(0, 2) as keyof typeof fidelityByPrefix;
      totalFidelity += fidelityByPrefix[tag] ?? 0;
    }
    return validator.expect(totalFidelity > 1.6).toLookLike(true);
  });
};
