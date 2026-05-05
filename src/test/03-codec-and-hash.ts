// ─────────────────────────────────────────────────────────────────────────
// Codec on top of compile() — compactTree dedupes, expandTree restores.
// Hash helpers: djb2, djb2hex, structuralHash.
// ─────────────────────────────────────────────────────────────────────────

import { compactTree, expandTree, djb2, djb2hex, structuralHash } from '../index.js';

export default async (test: (name: string, body: (validator: any) => any) => any) => {
  await test('compactTree → expandTree round-trips an arbitrary nested object', async (validator: any) => {
    const source = {
      users: [
        { role: 'admin', perms: ['read', 'write'] },
        { role: 'admin', perms: ['read', 'write'] },
        { role: 'user', perms: ['read'] },
      ],
    };
    const compacted = compactTree(source);
    const expanded = expandTree(compacted);
    return validator.expect(expanded).toLookLike(source);
  });

  await test('compactTree tags v=1 and dict has at least one entry', async (validator: any) => {
    const source = { a: { kind: 'p', x: 1 }, b: { kind: 'p', x: 1 } };
    const compacted = compactTree(source);
    return validator.expect({
      version: compacted.v,
      hasDict: compacted.dict.length >= 1,
    }).toLookLike({ version: 1, hasDict: true });
  });

  await test('expandTree on raw (non-compacted) input passes through', async (validator: any) => {
    const result = expandTree({ raw: 'data' });
    return validator.expect(result).toLookLike({ raw: 'data' });
  });

  await test('djb2 is deterministic and case-sensitive', async (validator: any) => {
    return validator.expect({
      same: djb2('hello world') === djb2('hello world'),
      diff: djb2('hello world') !== djb2('hello worlD'),
    }).toLookLike({ same: true, diff: true });
  });

  await test('djb2hex returns a non-empty deterministic string', async (validator: any) => {
    const a = djb2hex('hello');
    const b = djb2hex('hello');
    const c = djb2hex('hellO');
    return validator.expect({
      isString: typeof a === 'string',
      nonEmpty: a.length > 0,
      deterministic: a === b,
      caseSensitive: a !== c,
    }).toLookLike({ isString: true, nonEmpty: true, deterministic: true, caseSensitive: true });
  });

  await test('structuralHash is deterministic for the same exact value', async (validator: any) => {
    const a = structuralHash({ x: 1, y: 2 });
    const b = structuralHash({ x: 1, y: 2 });
    const c = structuralHash({ x: 1, y: 3 });
    return validator.expect({
      same: a === b,
      diff: a !== c,
    }).toLookLike({ same: true, diff: true });
  });
};
