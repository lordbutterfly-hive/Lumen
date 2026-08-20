/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * Self-test for the signing shell. Run:
 *   cd apps/blog && npx tsx lib/lite/wallet/vsc-tx/signing-shell.selftest.ts
 *
 * These pin the interoperability contract with the node. A failure here is not a
 * cosmetic bug — it is a signature that will not verify, with no error anywhere to
 * explain why. Written as a plain script because the blog app has no unit-test
 * harness (only Playwright, which cannot reach a pure function), following the
 * precedent of features/prediction-market/lib/pool-series.selftest.ts.
 */

import { assertSignableShape, createSigningShell, sortKeys, type VscTxContainer } from './signing-shell';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) {
    console.log(`ok    ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got  ${a}\n      want ${e}`);
}

// The codec is injected, so a payload can be carried as a plain object and the
// "decode" is identity. That is the whole point of the seam: the sort contract is
// testable with no CBOR, no wallet and no network.
const identity = (p: unknown) => p as unknown;

function container(
  payload: Record<string, unknown>,
  headers?: Partial<VscTxContainer['headers']>
): VscTxContainer {
  return {
    __t: 'vsc-tx',
    __v: '0.2',
    headers: {
      nonce: 7,
      required_auths: ['did:pkh:eip155:1:0xabc'],
      rc_limit: 1000,
      net_id: 'vsc-mainnet',
      ...headers
    },
    // payload is typed Uint8Array in the real container; the identity decoder
    // means we can hand it an object here without pretending to encode.
    tx: [{ type: 'call', payload: payload as unknown as Uint8Array }]
  };
}

function payloadOf(c: VscTxContainer): string {
  return createSigningShell(c, identity).tx[0].payload;
}

// ── the sort contract ───────────────────────────────────────────────────────

eq('sortKeys sorts a flat object', sortKeys({ b: 1, a: 2 }), { a: 2, b: 1 });

eq('sortKeys recurses into nested objects', sortKeys({ z: { d: 1, c: 2 }, a: 3 }), {
  a: 3,
  z: { c: 2, d: 1 }
});

eq(
  'sortKeys keeps ARRAY ORDER while sorting the objects inside',
  sortKeys([
    { b: '2', a: '1' },
    { d: '4', c: '3' }
  ]),
  [
    { a: '1', b: '2' },
    { c: '3', d: '4' }
  ]
);

check(
  'sortKeys leaves primitives and null alone',
  sortKeys(5) === 5 && sortKeys('x') === 'x' && sortKeys(null) === null && sortKeys(true) === true
);

// ── the property that actually protects a signature ─────────────────────────

{
  // Two logically identical transactions, keys written in opposite orders. If the
  // sort were shallow or order-preserving these would hash differently — the same
  // transaction producing different signatures depending on how it was typed.
  const a = container({
    action: 'buy',
    contract_id: 'vsc1creator',
    intents: [{ type: 'transfer.allow', args: { limit: '25.000', token: 'hbd' } }]
  });
  const b = container({
    intents: [{ args: { token: 'hbd', limit: '25.000' }, type: 'transfer.allow' }],
    contract_id: 'vsc1creator',
    action: 'buy'
  });
  check(
    'key order in the source cannot change the signed bytes',
    payloadOf(a) === payloadOf(b),
    `a=${payloadOf(a)}\n      b=${payloadOf(b)}`
  );
}

{
  const flat = payloadOf(
    container({
      zeta: 'last',
      alpha: 'first',
      intents: [{ type: 'transfer.allow', args: { token: 'hbd', limit: '1.000' } }]
    })
  );
  // Nested sorting matters: the intents array holds objects holding an args
  // object, so a sort that stopped at the top level would still look right on a
  // flat payload and be wrong here.
  check(
    'sorted at EVERY level — args is limit-before-token',
    flat.indexOf('"limit"') < flat.indexOf('"token"'),
    flat
  );
  check(
    'sorted at the top level too',
    flat.indexOf('"alpha"') < flat.indexOf('"intents"') && flat.indexOf('"intents"') < flat.indexOf('"zeta"'),
    flat
  );
}

{
  // Intents must survive as text inside the string. If they were dropped, the
  // contract would be authorised to pull nothing and every buy would revert.
  const flat = payloadOf(
    container({ intents: [{ type: 'transfer.allow', args: { limit: '25.000', token: 'hbd' } }] })
  );
  check(
    'intents survive into the signed payload',
    flat.includes('transfer.allow') && flat.includes('25.000') && flat.includes('hbd'),
    flat
  );
}

// ── the guard is WIRED, not merely present ─────────────────────────────────
// A guard nothing calls protects nothing. These prove createSigningShell itself
// refuses an unsignable payload, so the check cannot be skipped by a future
// caller that forgets to run it. Each case also asserts the shell ACCEPTS the
// same container once the offending value is fixed — otherwise a shell that
// threw unconditionally would pass this block while breaking every signature.
{
  const unsignable: Array<[string, unknown]> = [
    ['NaN', { action: 'buy', amount: NaN }],
    ['Infinity', { action: 'buy', amount: Infinity }],
    ['an unsafe integer', { action: 'buy', amount: 9007199254740993 }],
    ['undefined', { action: 'buy', amount: undefined }],
    ['a numeric-string key', { action: 'buy', '10': 'x' }]
  ];
  for (const [label, payload] of unsignable) {
    let threw = false;
    try {
      createSigningShell(container(payload as Record<string, unknown>), identity);
    } catch {
      threw = true;
    }
    check(`createSigningShell REFUSES ${label}`, threw);
  }

  // Anti-vacuity: the same shape minus the offending value must still succeed,
  // proving the refusals above come from the guard and not from the fixture.
  let ok = true;
  try {
    createSigningShell(container({ action: 'buy', amount: '25.000' }), identity);
  } catch {
    ok = false;
  }
  check('createSigningShell still ACCEPTS an ordinary signable payload', ok);
}

// ── the shell's own shape ───────────────────────────────────────────────────

{
  const shell = createSigningShell(container({ action: 'buy' }), identity);
  eq('headers are carried through exactly', shell.headers, {
    nonce: 7,
    required_auths: ['did:pkh:eip155:1:0xabc'],
    rc_limit: 1000,
    net_id: 'vsc-mainnet'
  });
  check('the envelope tags are carried', shell.__t === 'vsc-tx' && shell.__v === '0.2');
  check('the op type is carried', shell.tx[0].type === 'call');
}

{
  // Headers are copied field by field so an extra property a caller happened to
  // attach can never silently become part of what gets signed.
  const c = container({ action: 'buy' });
  (c.headers as unknown as Record<string, unknown>).sneaky = 'should not be signed';
  const shell = createSigningShell(c, identity);
  check(
    'an unexpected header field is NOT signed',
    !Object.keys(shell.headers).includes('sneaky'),
    JSON.stringify(shell.headers)
  );
}

{
  // A nonce of 0 is legitimate (a brand-new account) and must not be dropped by
  // any falsy check on the way through.
  const shell = createSigningShell(container({ action: 'buy' }, { nonce: 0 }), identity);
  check('nonce 0 survives', shell.headers.nonce === 0, JSON.stringify(shell.headers));
}

{
  // Multiple ops must each flatten independently, in order.
  const c: VscTxContainer = {
    ...container({ action: 'first' }),
    tx: [
      { type: 'call', payload: { action: 'first' } as unknown as Uint8Array },
      { type: 'transfer', payload: { b: 2, a: 1 } as unknown as Uint8Array }
    ]
  };
  const shell = createSigningShell(c, identity);
  check(
    'each op flattens independently and keeps order',
    shell.tx.length === 2 &&
      shell.tx[0].payload === '{"action":"first"}' &&
      shell.tx[1].payload === '{"a":1,"b":2}',
    JSON.stringify(shell.tx)
  );
}

// ── the guard: each case is a proven TS-vs-Go divergence ────────────────────
// Every shape below was measured producing DIFFERENT bytes on the two sides, so a
// signature over it cannot verify. The guard refuses before anyone pays for it.

function refuses(name: string, value: unknown, expectFragment: string): void {
  let threw = '';
  try {
    assertSignableShape(value);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check(
    `refuses ${name}`,
    threw.includes(expectFragment),
    threw === '' ? 'it did NOT throw' : `threw: ${threw}`
  );
}

refuses('a BigInt value', { limit: 10n }, 'BigInt');
refuses('an undefined value', { action: 'buy', memo: undefined }, 'undefined value');
refuses('a numeric-string key', { '1': 'a', '10': 'b' }, 'numeric-string key');
refuses('a key outside the BMP', { ['x\u{1F600}']: 1 }, 'Basic Multilingual Plane');
refuses('a bad shape nested inside an array', { intents: [{ args: { limit: 5n } }] }, 'BigInt');
refuses('a bad shape nested deep in objects', { a: { b: { c: undefined } } }, 'undefined value');

// And it must NOT refuse anything we actually send. A guard that fires on real
// traffic is worse than no guard: it would block every buy.
{
  let threw = '';
  try {
    assertSignableShape({
      contract_id: 'vsc1creator',
      action: 'buy',
      payload: '{"creator":"hive:alice","tokens":10}',
      rc_limit: 1000,
      caller: 'did:pkh:eip155:1:0xabc',
      intents: [{ type: 'transfer.allow', args: { limit: '25.000', token: 'hbd', decimals: '3' } }]
    });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check('accepts a real buy payload untouched', threw === '', threw);
}

// Zero, null, empty string and false are all legitimate values and must pass —
// only `undefined` is the problem.
{
  let threw = '';
  try {
    assertSignableShape({ n: 0, nul: null, s: '', f: false, arr: [] });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check('accepts 0 / null / empty string / false / empty array', threw === '', threw);
}

// A key that merely CONTAINS digits is fine — only a wholly integer-like key
// reorders. Over-refusing here would block ordinary field names.
{
  let threw = '';
  try {
    assertSignableShape({ token1: 'a', a1b: 'b', '1a': 'c' });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check('accepts keys that merely contain digits', threw === '', threw);
}

// ── Divergences 4-7 (added 2026-08-19) ──────────────────────────────────────
// Each was proven by running go-vsc-node's own packages at 33adaeb5 and diffing
// the signed string against this file's algorithm. None was guarded before, and
// the HTML-escaping one hits ORDINARY CONTENT — a memo, an offering title, any
// URL with a query string — so it is the likeliest of the whole set to bite.
{
  const refuses = (label: string, v: unknown): void => {
    let threw = '';
    try {
      assertSignableShape(v);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check(`refuses ${label}`, threw !== '', 'was accepted');
  };
  const accepts = (label: string, v: unknown): void => {
    let threw = '';
    try {
      assertSignableShape(v);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check(`accepts ${label}`, threw === '', threw);
  };

  refuses('NaN (the node signs an EMPTY payload and the signature stops binding it)', { a: NaN });
  refuses('Infinity', { a: Infinity });
  refuses('-Infinity', { a: -Infinity });
  refuses('an integer past 2^53 (already rounded before stringify)', { a: 9007199254740993 });
  refuses('"<" in a value (Go escapes it, JS does not)', { memo: 'a<b' });
  refuses('">" in a value', { memo: 'a>b' });
  refuses('"&" in a value', { memo: 'a & b' });
  refuses('U+2028 in a value', { memo: 'a\u2028b' });
  refuses('U+2029 in a value', { memo: 'a\u2029b' });

  // ANTI-VACUITY: the guard must not refuse ordinary content, or every write breaks.
  accepts('a plain space', { memo: 'a b' });
  accepts('an ordinary sentence with a comma', { memo: 'Song feedback, 1k words' });
  accepts('a safe integer', { price: 25000 });
  accepts('a negative and a float', { a: -1, b: 1.5 });
  accepts('an explicit null (matches on both sides)', { a: null });
  accepts('an emoji in a VALUE (only KEYS outside the BMP diverge)', { memo: 'nice \u{1F3B5}' });
  accepts('a realistic ask payload', {
    creator: 'hive:alice',
    tokens: '30',
    price: 25000,
    title: 'Song feedback'
  });
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
