// ─────────────────────────────────────────────────────────────────────────
// compile() builds a CandidateGraph; select() chooses one candidate per
// node; emit() materializes them into body + sections.
// ─────────────────────────────────────────────────────────────────────────

import {
  compile, select, emit,
  type CandidateHandler,
} from '../index.js';

type Lit = { kind: 'lit'; v: number };
type Add = { kind: 'add'; l: Lit | Add; r: Lit | Add };

const litHandler: CandidateHandler<Lit, string> = {
  type: 'lit',
  matches: (x): x is Lit => !!x && (x as any).kind === 'lit',
  key: (e) => `lit:${e.v}`,
  candidates: (e) => [{
    shape: 'inline',
    cost: { tokens: 1 },
    fidelity: 1,
    refs: [],
    materialize: () => String(e.v),
  }],
  refName: (_e, name) => name,
};

const addHandler: CandidateHandler<Add, string> = {
  type: 'add',
  matches: (x): x is Add => !!x && (x as any).kind === 'add',
  key: (e) => `add:${JSON.stringify(e)}`,
  candidates: (e, c) => {
    const lKey = c(e.l);
    const rKey = c(e.r);
    return [{
      shape: 'hoisted',
      bucket: 'expr',
      cost: { tokens: 5 },
      fidelity: 1,
      refs: [lKey, rKey],
      materialize: (resolve) => `${resolve(lKey)} + ${resolve(rKey)}`,
    }];
  },
  refName: (_e, name) => name,
};

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('one root → one body entry; non-simple node hoists into bucket', async (validator: any) => {
    const expr: Add = { kind: 'add', l: { kind: 'lit', v: 2 }, r: { kind: 'lit', v: 3 } };
    const graph = compile<string>([litHandler, addHandler], [expr]);
    const result = emit(graph, select(graph, { strategy: 'greedy' }));
    return validator.expect({
      bodyLen: result.body.length,
      bodyType: typeof result.body[0],
      hoistedSize: result.hoistedByKey.size,
    }).toLookLike({ bodyLen: 1, bodyType: 'string', hoistedSize: 1 });
  });

  await test("hoisted body inlines simple children: '2 + 3'", async (validator: any) => {
    const expr: Add = { kind: 'add', l: { kind: 'lit', v: 2 }, r: { kind: 'lit', v: 3 } };
    const graph = compile<string>([litHandler, addHandler], [expr]);
    const result = emit(graph, select(graph, { strategy: 'greedy' }));
    const exprSection = result.sections.children['expr'];
    return validator.expect(exprSection!.nodes[0].body).toLookLike('2 + 3');
  });

  await test('object-typed TOutput flows through emit', async (validator: any) => {
    type Ast =
      | { tag: 'num'; value: number }
      | { tag: 'plus'; left: Ast; right: Ast }
      | { tag: 'ref'; to: string };

    const litH: CandidateHandler<Lit, Ast> = {
      type: 'lit',
      matches: (x): x is Lit => !!x && (x as any).kind === 'lit',
      key: (e) => `lit:${e.v}`,
      candidates: (e) => [{
        shape: 'inline', cost: {}, fidelity: 1, refs: [],
        materialize: () => ({ tag: 'num', value: e.v } as Ast),
      }],
      refName: (_e, name) => ({ tag: 'ref', to: name } as Ast),
    };
    const addH: CandidateHandler<Add, Ast> = {
      type: 'add',
      matches: (x): x is Add => !!x && (x as any).kind === 'add',
      key: (e) => `add:${JSON.stringify(e)}`,
      candidates: (e, c) => {
        const lKey = c(e.l);
        const rKey = c(e.r);
        return [{
          shape: 'hoisted', bucket: 'expr', cost: {}, fidelity: 1,
          refs: [lKey, rKey],
          materialize: (resolve) => ({ tag: 'plus', left: resolve(lKey), right: resolve(rKey) } as Ast),
        }];
      },
      refName: (_e, name) => ({ tag: 'ref', to: name } as Ast),
    };
    const expr: Add = {
      kind: 'add',
      l: { kind: 'lit', v: 7 },
      r: { kind: 'add', l: { kind: 'lit', v: 1 }, r: { kind: 'lit', v: 2 } },
    };
    const graph = compile<Ast>([litH, addH], [expr]);
    const result = emit(graph, select(graph, { strategy: 'greedy' }));
    return validator.expect({
      rootTag: (result.body[0] as any).tag,
      hoistedCount: result.hoistedByKey.size,
    }).toLookLike({ rootTag: 'ref', hoistedCount: 2 });
  });

  await test('structural key dedupes distinct objects with same content', async (validator: any) => {
    type Sym = { kind: 'sym'; name: string };
    const handler: CandidateHandler<Sym, string> = {
      type: 'sym',
      matches: (x): x is Sym => !!x && (x as any).kind === 'sym',
      key: (s) => `sym:${s.name}`,
      candidates: (s) => [{
        shape: 'hoisted', bucket: 'syms', name: s.name,
        cost: {}, fidelity: 1, refs: [],
        materialize: () => s.name,
      }],
      refName: (_s, name) => name,
    };
    const a: Sym = { kind: 'sym', name: 'foo' };
    const b: Sym = { kind: 'sym', name: 'foo' };
    const c: Sym = { kind: 'sym', name: 'bar' };
    const graph = compile<string>([handler], [a, b, c]);
    const result = emit(graph, select(graph, { strategy: 'greedy' }));
    return validator.expect({
      uniques: result.hoistedByKey.size,
      sameRef: result.body[0] === result.body[1],
      diffRef: result.body[0] !== result.body[2],
    }).toLookLike({ uniques: 2, sameRef: true, diffRef: true });
  });
};
