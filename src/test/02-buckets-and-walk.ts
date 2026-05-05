// ─────────────────────────────────────────────────────────────────────────
// Multi-d bucket routing, walkSections traversal order, topo within bucket.
// ─────────────────────────────────────────────────────────────────────────

import {
  compile, select, emit, walkSections,
  type CandidateHandler,
} from '../index.js';

type Tag = { kind: 'tag'; section: string[]; name: string };

const tagHandler: CandidateHandler<Tag, string> = {
  type: 'tag',
  matches: (x): x is Tag => !!x && (x as any).kind === 'tag',
  key: (t) => `tag:${t.name}`,
  candidates: (t) => [{
    shape: 'hoisted', bucket: t.section, name: t.name,
    cost: { tokens: 1 }, fidelity: 1, refs: [],
    materialize: () => `<${t.name}/>`,
  }],
  refName: (_t, name) => `&${name}`,
};

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('multi-d buckets route nodes into nested sections', async (validator: any) => {
    const tags: Tag[] = [
      { kind: 'tag', section: ['ui', 'forms'], name: 'TextInput' },
      { kind: 'tag', section: ['ui', 'forms'], name: 'Checkbox' },
      { kind: 'tag', section: ['ui', 'layout'], name: 'Grid' },
      { kind: 'tag', section: ['data'], name: 'Query' },
    ];
    const graph = compile<string>([tagHandler], tags);
    const result = emit(graph, select(graph, { strategy: 'greedy' }));
    return validator.expect({
      bodyLen: result.body.length,
      allRefs: result.body.every((b) => b.startsWith('&')),
      uiForms: result.sections.children['ui']!.children['forms']?.nodes.length,
      uiLayout: result.sections.children['ui']!.children['layout']?.nodes.length,
      data: result.sections.children['data']!.nodes.length,
    }).toLookLike({ bodyLen: 4, allRefs: true, uiForms: 2, uiLayout: 1, data: 1 });
  });

  await test('walkSections wraps with empty-path enter/exit', async (validator: any) => {
    const tagBucketHandler: CandidateHandler<{ kind: 'tag'; bucket: string[]; name: string }, string> = {
      type: 'tag',
      matches: (x): x is { kind: 'tag'; bucket: string[]; name: string } =>
        !!x && (x as any).kind === 'tag',
      key: (t) => `t:${t.name}`,
      candidates: (t) => [{
        shape: 'hoisted', bucket: t.bucket, name: t.name,
        cost: {}, fidelity: 1, refs: [],
        materialize: () => t.name,
      }],
      refName: (_t, n) => n,
    };
    const tags = [
      { kind: 'tag' as const, bucket: ['a'], name: 'A1' },
      { kind: 'tag' as const, bucket: ['a', 'b'], name: 'AB1' },
      { kind: 'tag' as const, bucket: ['a', 'b'], name: 'AB2' },
      { kind: 'tag' as const, bucket: ['c'], name: 'C1' },
    ];
    const graph = compile<string>([tagBucketHandler], tags);
    const result = emit(graph, select(graph, { strategy: 'greedy' }));
    const visited: string[] = [];
    walkSections(result.sections, {
      enterSection: (path) => visited.push(`> ${path.join('/')}`),
      visitNode: (n) => visited.push(`. ${n.name}`),
      exitSection: (path) => visited.push(`< ${path.join('/')}`),
    });
    return validator.expect({
      first: visited[0],
      last: visited[visited.length - 1],
      hasA1: visited.includes('. A1'),
      hasAB1: visited.includes('. AB1'),
      hasAB2: visited.includes('. AB2'),
    }).toLookLike({
      first: '> ',
      last: '< ',
      hasA1: true, hasAB1: true, hasAB2: true,
    });
  });

  await test('topo orders deps within a bucket: A before B when B refs A', async (validator: any) => {
    type Def = { kind: 'def'; name: string; refs: string[] };
    const handler: CandidateHandler<Def, string> = {
      type: 'def',
      matches: (x): x is Def => !!x && (x as any).kind === 'def',
      key: (d) => `def:${d.name}`,
      candidates: (d, c) => {
        const refKeys = d.refs.map((r) =>
          c({ kind: 'def', name: r, refs: [] } as Def),
        );
        return [{
          shape: 'hoisted', bucket: 'defs', name: d.name,
          cost: {}, fidelity: 1, refs: refKeys,
          materialize: () => `def ${d.name}`,
        }];
      },
      refName: (_d, n) => n,
    };
    const b: Def = { kind: 'def', name: 'B', refs: ['A'] };
    const a: Def = { kind: 'def', name: 'A', refs: [] };
    const graph = compile<string>([handler], [b, a]);
    const result = emit(graph, select(graph, { strategy: 'greedy' }));
    const order = result.sections.children['defs']!.nodes.map((n) => n.name);
    return validator.expect({
      both: order.includes('A') && order.includes('B'),
      aBeforeB: order.indexOf('A') < order.indexOf('B'),
    }).toLookLike({ both: true, aBeforeB: true });
  });
};
