/**
 * The wallet-signing rail's parity fixture.
 *
 * Run by hand: `npx tsx lib/lite/wallet/vsc-tx/vsc-tx.selftest.ts` from apps/blog.
 *
 * WHY A PINNED FIXTURE AND NOT JUST UNIT ASSERTIONS. Every value below was
 * produced by this code and then VERIFIED BY THE NODE'S OWN GO VERIFIER
 * (`lib/dids.EthDID.Verify`, pin 33adaeb5) returning true — and, in the same
 * run, returning FALSE for a tampered signature and FALSE for a payload whose
 * creator was swapped for another of identical byte length. So these bytes are
 * not "what the code happens to emit today"; they are a known-accepted
 * transaction. Any change that alters them breaks a real signature, and this
 * test is the only thing standing between such a change and a wallet user
 * signing something the node will silently refuse.
 *
 * ★ THE TWO ORDER RULES ARE BOTH VISIBLE IN THE FIXTURE, and they DIFFER:
 *   - the outer CBOR sorts LENGTH-FIRST: `tx`(2), `__t`(3), `__v`(3), `headers`(7)
 *   - the inner payload JSON string sorts ALPHABETICALLY: action, caller,
 *     contract_id, intents, payload, rc_limit
 * Applying either rule to the other layer is a signature the node cannot
 * verify, and nothing reports ordering as the cause. This is the single most
 * dangerous detail in the rail.
 */

import { buildCallOp, buildContainer, toBase64 } from './container';
import { encodeDagCbor, decodeDagCbor } from './dag-cbor';
import { convertCborToEip712TypedData } from './eip712';
import { assertEnvelopeMatchesAuths, buildSigEnvelope, assertEvmSignature } from './envelope';
import { hbdBaseUnitsToDecimalString, transferAllowIntent, assertIntentsShape } from './intents';
import { createSigningShell } from './signing-shell';
import { dagCborCid } from './cid';
import { assertBtcSignature, normalizeBip137Header } from './btc';
import { btcAddressFromDid, btcAddressType, evmAddressFromDid } from '@/blog/features/creator-tokens/lib/vsc/wallet-broadcaster';

const TEST_DID = 'did:pkh:eip155:1:0xB41fEE7B3a034a474ae8E0C41DA8B211b73A980B';
const CONTRACT = 'vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8';

/** Node-accepted signing shell for the fixture transaction below. */
const PINNED_SHELL_B64 =
  'pGJ0eIGiZHR5cGVkY2FsbGdwYXlsb2FkeQE3eyJhY3Rpb24iOiJidXkiLCJjYWxsZXIiOiJkaWQ6cGtoOmVpcDE1NToxOjB4QjQxZkVFN0IzYTAzNGE0NzRhZThFMEM0MURBOEIyMTFiNzNBOTgwQiIsImNvbnRyYWN0X2lkIjoidnNjMUJjYUQ4SnJ3SlBBQU41Y1UxY0hLQ0JkWnJkN2p6MldHdDgiLCJpbnRlbnRzIjpbeyJhcmdzIjp7ImRlY2ltYWxzIjoiMyIsImxpbWl0IjoiMjUuMDAwIiwidG9rZW4iOiJoYmQifSwidHlwZSI6InRyYW5zZmVyLmFsbG93In1dLCJwYXlsb2FkIjoie1wiY3JlYXRvclwiOlwiaGl2ZTpsdW1lbi5hcmlhXCIsXCJ0b2tlbnNcIjoxfSIsInJjX2xpbWl0IjozMDAwMH1jX190ZnZzYy10eGNfX3ZjMC4yZ2hlYWRlcnOkZW5vbmNlAGZuZXRfaWRrdnNjLXRlc3RuZXRocmNfbGltaXQZdTBucmVxdWlyZWRfYXV0aHOBeDtkaWQ6cGtoOmVpcDE1NToxOjB4QjQxZkVFN0IzYTAzNGE0NzRhZThFMEM0MURBOEIyMTFiNzNBOTgwQg==';

const failures: string[] = [];
/** Async checks the final gate must await before deciding pass/fail. */
const pending: Array<Promise<void>> = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) return;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

function buildFixture() {
  const op = buildCallOp({
    contractId: CONTRACT,
    action: 'buy',
    payload: { creator: 'hive:lumen.aria', tokens: 1 },
    rcLimit: 30_000,
    intents: [transferAllowIntent(25_000)],
    caller: TEST_DID
  });
  const container = buildContainer({
    netId: 'vsc-testnet',
    nonce: 0,
    rcLimit: 30_000,
    requiredAuths: [TEST_DID],
    ops: [op]
  });
  const shell = createSigningShell(container as never, (p) => decodeDagCbor(p as Uint8Array));
  return { container, shell, shellBytes: encodeDagCbor(shell as unknown as Record<string, unknown>) };
}

// ── the canonical ordering rule ─────────────────────────────────────────────
{
  // RFC 7049: shortest key FIRST, then bytewise. Not alphabetical.
  const bytes = encodeDagCbor({ aa: 1, c: 2, b: 3 });
  const keys = Object.keys(decodeDagCbor(bytes) as Record<string, unknown>);
  // Length first, THEN bytewise within a length class: b(1), c(1), aa(2).
  check('dag-cbor sorts length-first, then bytewise', keys.join(',') === 'b,c,aa', keys.join(','));

  // Insertion order must not survive into the encoding, or the hash depends on
  // how the object literal happened to be written.
  const a = toBase64(encodeDagCbor({ x: 1, yy: 2 }));
  const b = toBase64(encodeDagCbor({ yy: 2, x: 1 }));
  check('encoding is insertion-order independent', a === b, `${a} vs ${b}`);
}

// ── the codec round-trips its own value domain ──────────────────────────────
{
  const value = { s: 'hi', n: 7, t: true, f: false, arr: [1, 2, 3], nested: { k: 'v' } };
  // Compared field by field: the codec re-orders keys canonically on purpose,
  // so a JSON.stringify comparison would fail on ordering rather than value.
  const rt = decodeDagCbor(encodeDagCbor(value)) as Record<string, unknown>;
  check('round-trip preserves every scalar', rt.s === 'hi' && rt.n === 7 && rt.t === true && rt.f === false);
  check('round-trip preserves arrays', JSON.stringify(rt.arr) === '[1,2,3]', JSON.stringify(rt.arr));
  check('round-trip preserves nested maps', JSON.stringify(rt.nested) === '{"k":"v"}', JSON.stringify(rt.nested));

  // Refusals: each of these is a JS/Go divergence, not a stylistic choice.
  for (const [label, bad] of [
    ['a float', { a: 1.5 }],
    ['a negative', { a: -1 }],
    ['null', { a: null }],
    ['an unsafe integer', { a: 9007199254740993 }]
  ] as Array<[string, unknown]>) {
    let threw = false;
    try { encodeDagCbor(bad); } catch { threw = true; }
    check(`the codec REFUSES ${label}`, threw);
  }
}

// ── the pinned, node-accepted fixture ───────────────────────────────────────
{
  const { shellBytes, container } = buildFixture();
  const actual = toBase64(shellBytes);
  check('the signing shell matches the node-accepted fixture byte for byte', actual === PINNED_SHELL_B64, actual);

  // The op payload is a STRING holding the op body; the ACTION ARGUMENTS are a
  // second JSON string inside its own `payload` field. That is the
  // double-encoding the node unescapes exactly one layer of.
  const opBody = JSON.parse((decodeDagCbor(shellBytes) as { tx: Array<{ payload: string }> }).tx[0].payload);
  check('the op body is carried as a JSON string', typeof (decodeDagCbor(shellBytes) as { tx: Array<{ payload: unknown }> }).tx[0].payload === 'string');
  check('the action arguments are a SECOND JSON string inside it', typeof opBody.payload === 'string', typeof opBody.payload);
  check('those arguments decode to the creator we asked for', JSON.parse(opBody.payload).creator === 'hive:lumen.aria', String(JSON.parse(opBody.payload).creator));
  // Alphabetical inside that string...
  const inner = (decodeDagCbor(shellBytes) as { tx: Array<{ payload: string }> }).tx[0].payload;
  check('the inner payload string sorts ALPHABETICALLY', Object.keys(JSON.parse(inner)).join(',') === 'action,caller,contract_id,intents,payload,rc_limit', Object.keys(JSON.parse(inner)).join(','));
  // ...length-first outside it.
  check('the outer container sorts LENGTH-FIRST', Object.keys(decodeDagCbor(shellBytes) as object).join(',') === 'tx,__t,__v,headers', Object.keys(decodeDagCbor(shellBytes) as object).join(','));

  // net_id lives in the headers ONLY — putting it in the op body is a silent
  // signature mismatch, and the existing Hive rail does exactly that.
  check('net_id is in the headers', 'net_id' in (container.headers as object));
  check('net_id is NOT in the op body', !inner.includes('net_id'), inner.slice(0, 120));
  check('contract_id IS in the op body', inner.includes('contract_id'));
}

// ── the typed data the wallet will be shown ─────────────────────────────────
{
  const { shellBytes } = buildFixture();
  const td = convertCborToEip712TypedData(shellBytes);
  check('domain is name-only (no chainId, no version)', JSON.stringify(td.domain) === '{"name":"vsc.network"}', JSON.stringify(td.domain));
  check('primary type is tx_container_v0', td.primaryType === 'tx_container_v0');
  // viem RECOMPUTES the domain type; shipping our own would have to match the
  // node's re-added one byte for byte, so it is deliberately absent.
  check('types does NOT declare EIP712Domain', !('EIP712Domain' in td.types));
  check('the container type keeps length-first field order', td.types['tx_container_v0'].map((f) => f.name).join(',') === 'tx,__t,__v,headers', td.types['tx_container_v0'].map((f) => f.name).join(','));
  check('headers keep length-first field order', td.types['tx_container_v0_headers'].map((f) => f.name).join(',') === 'nonce,net_id,rc_limit,required_auths');
  check('numbers become uint256', td.types['tx_container_v0_headers'].find((f) => f.name === 'nonce')?.type === 'uint256');
  check('a scalar array becomes string[]', td.types['tx_container_v0_headers'].find((f) => f.name === 'required_auths')?.type === 'string[]');
  check('an array of objects becomes an _0_-keyed struct', td.types['tx_container_v0_tx'][0].name === '_0_');

  // Anti-vacuity: a different transaction must produce different typed data,
  // or the checks above would pass for any input at all.
  const other = buildCallOp({ contractId: CONTRACT, action: 'buy', payload: { creator: 'hive:lumen.jude', tokens: 1 }, rcLimit: 30_000, intents: [transferAllowIntent(25_000)], caller: TEST_DID });
  const otherShell = createSigningShell(buildContainer({ netId: 'vsc-testnet', nonce: 0, rcLimit: 30_000, requiredAuths: [TEST_DID], ops: [other] }) as never, (p) => decodeDagCbor(p as Uint8Array));
  check('a different creator produces different signed bytes', toBase64(encodeDagCbor(otherShell as unknown as Record<string, unknown>)) !== PINNED_SHELL_B64);
}

// ── intents ─────────────────────────────────────────────────────────────────
{
  check('base units format as 3-decimal HBD', hbdBaseUnitsToDecimalString(25_000) === '25.000', hbdBaseUnitsToDecimalString(25_000));
  check('a sub-unit amount keeps its zeros', hbdBaseUnitsToDecimalString(7) === '0.007', hbdBaseUnitsToDecimalString(7));
  check('a large amount stays exact', hbdBaseUnitsToDecimalString(123456789) === '123456.789');
  check('every intent arg is a string', Object.values(transferAllowIntent(1).args).every((v) => typeof v === 'string'));

  let threw = false;
  try { assertIntentsShape([{ type: 'transfer.allow', args: { limit: 25 as unknown as string } }]); } catch { threw = true; }
  check('a numeric intent arg is REFUSED', threw);
}

// ── the signature envelope ──────────────────────────────────────────────────
{
  const env = buildSigEnvelope([{ alg: 'eth-eip712', sig: '0x' + 'ab'.repeat(65), kid: TEST_DID }]);
  check('the envelope is tagged vsc-sig', env.__t === 'vsc-sig');

  let threw = false;
  try { assertEnvelopeMatchesAuths(env, [TEST_DID, 'did:pkh:eip155:1:0xother']); } catch { threw = true; }
  check('a signature count mismatch is REFUSED (mapping is positional)', threw);

  threw = false;
  try { assertEvmSignature('0xdeadbeef'); } catch { threw = true; }
  check('a short EVM signature is REFUSED', threw);
  // Anti-vacuity: a well-formed one must pass, or the check above is vacuous.
  let ok = true;
  try { assertEvmSignature('0x' + 'cd'.repeat(65)); } catch { ok = false; }
  check('a well-formed EVM signature is ACCEPTED', ok);
}


// ── BTC: the CID is the message, and the header must be rewritten ───────────
// Both values below came from the node's own Go code and were confirmed by
// running `lib/dids.BtcDID.Verify`: the raw segwit-header signature was
// REJECTED ("recovery code 40 is not in the valid range [27, 34]") and the
// normalised one VERIFIED true, for a real mainnet bc1q address.
{
  const shellBytes = Uint8Array.from(Buffer.from(PINNED_SHELL_B64, 'base64'));
  // ★ AWAITED BY THE FINAL GATE, not fired and forgotten. `dagCborCid` is async
  // (Web Crypto), and an un-awaited check would resolve AFTER the pass/fail
  // line below had already printed — a check that can never fail the run is
  // worse than no check at all.
  pending.push(
    dagCborCid(shellBytes).then((cid) => {
      // Produced by Go: cid.Prefix{Version:1, Codec:DagCbor, MhType:SHA2_256}.Sum
      check('the CID matches the one Go computes', cid === 'bafyreicwavdvlemeirgr7yr7jwggmudop7w2xcfegercfuq72bt2nzh6ym', cid);
    })
  );

  // A native-segwit wallet emits 39-42; Go accepts only 27-34.
  const walletSig = 'KPLZDmOXnf/9ZtQBxZhV9FESTod2LUWwliI16rut+ZVWHxfxIYLA72IhKzxF3vgvAJE+xh6ErEZ2tnBj8sssTFY=';
  const fixed = normalizeBip137Header(walletSig);
  check('a native-segwit header 40 is rewritten to 32', Buffer.from(fixed, 'base64')[0] === 32, String(Buffer.from(fixed, 'base64')[0]));
  check('only the header byte changes', Buffer.from(fixed, 'base64').subarray(1).equals(Buffer.from(walletSig, 'base64').subarray(1)));

  let threw = false;
  try { assertBtcSignature(walletSig, 'p2wpkh'); } catch { threw = true; }
  check('an un-normalised segwit signature is REFUSED', threw);
  let ok = true;
  try { assertBtcSignature(fixed, 'p2wpkh'); } catch { ok = false; }
  check('the normalised signature is ACCEPTED', ok);

  // BIP-322 is p2wpkh-only at the node (btc.go:125-129).
  threw = false;
  try { assertBtcSignature(Buffer.from('x'.repeat(107)).toString('base64'), 'p2sh'); } catch { threw = true; }
  check('a BIP-322-length signature is REFUSED for p2sh', threw);
}


// ── branches the fixture alone never exercises ─────────────────────────────
// Both of these survived a mutation pass (adversarial review, 2026-08-20): the
// fixture pins rcLimit=30000 so the default branch never ran, and no shell it
// builds contains an empty array. A branch no test reaches is a branch free to
// change silently.
{
  // rc_limit 0 means "use the protocol default" — and the default belongs in
  // the HEADERS only. The op BODY keeps the 0 it was given (crafter.go:641-644).
  // ★ rc_limit 0 is now REFUSED, not defaulted. The header would have been 500
  // (admitted, RC charged, nonce consumed) while the signed body stayed 0, and
  // the node takes the contract's GAS from the body — so it executed with zero
  // gas and failed silently. Audit A1, F1.
  let zeroThrew = false;
  try { buildCallOp({ contractId: CONTRACT, action: 'register', payload: { face: 1 }, rcLimit: 0, caller: TEST_DID }); } catch { zeroThrew = true; }
  check('rc_limit 0 is REFUSED at build time', zeroThrew);
  const op = buildCallOp({ contractId: CONTRACT, action: 'register', payload: { face: 1 }, rcLimit: 500, caller: TEST_DID });
  const c = buildContainer({ netId: 'vsc-testnet', nonce: 0, rcLimit: 500, requiredAuths: [TEST_DID], ops: [op] });
  const body = decodeDagCbor(op.payload) as { rc_limit: number };
  check('the header and the op body carry the SAME rc_limit', c.headers.rc_limit === body.rc_limit, `${c.headers.rc_limit} vs ${body.rc_limit}`);
  // Anti-vacuity: a real limit must pass straight through, not be defaulted.
  const c2 = buildContainer({ netId: 'vsc-testnet', nonce: 0, rcLimit: 30_000, requiredAuths: [TEST_DID], ops: [op] });
  check('a real rc_limit is NOT overwritten by the default', c2.headers.rc_limit === 30_000, String(c2.headers.rc_limit));

  // Multi-auth is refused: it produces an orphan EIP-712 type that ethers (and
  // therefore, in all likelihood, MetaMask) will not display, so it can never
  // be signed even though the node would verify it.
  let multiThrew = false;
  try {
    buildContainer({ netId: 'vsc-testnet', nonce: 0, rcLimit: 500, requiredAuths: [TEST_DID, 'did:pkh:eip155:1:0x000000000000000000000000000000000000dEaD'], ops: [op] });
  } catch { multiThrew = true; }
  check('a multi-auth container is REFUSED', multiThrew);
  // Anti-vacuity: a duplicate auth collapses to one and must still build.
  let dupOk = true;
  try { buildContainer({ netId: 'vsc-testnet', nonce: 0, rcLimit: 500, requiredAuths: [TEST_DID, TEST_DID], ops: [op] }); } catch { dupOk = false; }
  check('a duplicated auth collapses to one and still builds', dupOk);

  // An empty array contributes NO EIP-712 type. Emitting one changes the hash.
  const withEmpty = encodeDagCbor({ a: 'x', e: [] });
  const td = convertCborToEip712TypedData(withEmpty, 'probe');
  check('an empty array contributes no type entry', !td.types['probe']?.some((f) => f.name === 'e'), JSON.stringify(td.types['probe']));
  check('a non-empty sibling still gets its type', td.types['probe']?.some((f) => f.name === 'a' && f.type === 'string') === true);
}


// ── the DID → address split that decides which rail signs ──────────────────
{
  const EVM = 'did:pkh:eip155:1:0xB41fEE7B3a034a474ae8E0C41DA8B211b73A980B';
  const BTC = 'did:pkh:bip122:000000000019d6689c085ae165831e93:bc1qewdludr3fpy3k903hqave02ue4xm9ha83c9c0m';

  check('an EVM DID yields its address', evmAddressFromDid(EVM) === '0xB41fEE7B3a034a474ae8E0C41DA8B211b73A980B');
  check('an EVM DID is NOT read as Bitcoin', btcAddressFromDid(EVM) === null);
  check('a BTC DID yields its address', btcAddressFromDid(BTC) === 'bc1qewdludr3fpy3k903hqave02ue4xm9ha83c9c0m');
  check('a BTC DID is NOT read as EVM', evmAddressFromDid(BTC) === null, String(evmAddressFromDid(BTC)));

  // ★ Routing by the WRONG rail is the failure this split exists to prevent:
  // an EVM DID sent down the BTC path would sign a CID with typed data, or
  // vice versa, and the node would simply refuse with "signature invalid".
  check('native segwit is p2wpkh', btcAddressType('bc1qewdludr3fpy3k903hqave02ue4xm9ha83c9c0m') === 'p2wpkh');
  check('a 3… address is p2sh', btcAddressType('3FZbgi29cpjq2GjdwV8eyHuJJnkLtktZc5') === 'p2sh');
  check('a 1… address is p2pkh', btcAddressType('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2') === 'p2pkh');
  // Taproot is refused at DID parse by the node, so guessing a type for it
  // would send a signature that can never verify.
  check('taproot is refused, not guessed', btcAddressType('bc1p5cyxnuxmeuwuvkwfem96l0i') === null);
}


// ── the BTC guards the review found unguarded ──────────────────────────────
// Every case below was reported by adversarial review as passing our gate and
// being refused by the node, i.e. a wasted wallet prompt and a burnt submit.
{
  const b64 = (bytes: number[]): string => Buffer.from(Uint8Array.from(bytes)).toString('base64');
  const refuses = (label: string, sig: string, type: 'p2pkh' | 'p2sh' | 'p2wpkh' = 'p2wpkh'): void => {
    let threw = false;
    try { assertBtcSignature(sig, type); } catch { threw = true; }
    check(`btc REFUSES ${label}`, threw);
  };

  // F2: the BIP-322 branch (Leather's default) accepted literally anything.
  refuses('an empty signature', '');
  refuses('a 3-byte blob', 'AAAA');
  refuses('a wallet error string instead of a signature', Buffer.from('user rejected').toString('base64'));
  refuses('a witness claiming 3 items', b64([3, 1, 0x30, 33, ...Array(33).fill(2)]));
  refuses('a witness with an empty signature item', b64([2, 0, 33, ...Array(33).fill(2)]));
  refuses('a witness with a 32-byte (uncompressed-ish) key', b64([2, 2, 0x30, 0x06, 32, ...Array(32).fill(2)]));
  refuses('a truncated witness', b64([2, 10, 1, 2]));
  // Anti-vacuity: a well-formed 2-item P2WPKH witness must still be ACCEPTED,
  // or the branch is simply closed rather than validated.
  let ok = true;
  try { assertBtcSignature(b64([2, 71, ...Array(71).fill(0x30), 33, ...Array(33).fill(2)]), 'p2wpkh'); } catch { ok = false; }
  check('btc ACCEPTS a well-formed BIP-322 witness', ok);

  // F3: the decode used to throw a raw DOMException before any guard ran.
  for (const bad of ['not base64 !!!', '0x1234abcd', '']) {
    let threw = false;
    try { normalizeBip137Header(bad); } catch { threw = true; }
    check(`normalizeBip137Header does not throw on ${JSON.stringify(bad)}`, !threw);
  }
  refuses('a 7-byte blob that happens to be base64', '0x1234abcd');

  // F9: the high-S check had no coverage at all. S = N/2 is the last legal
  // value; S = N/2 + 1 is the first the node refuses.
  const HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
  const compact = (sv: bigint): string => {
    const out = new Uint8Array(65);
    out[0] = 32;
    for (let i = 0; i < 32; i++) out[33 + i] = Number((sv >> BigInt(8 * (31 - i))) & 0xffn);
    return Buffer.from(out).toString('base64');
  };
  let lowOk = true;
  try { assertBtcSignature(compact(HALF), 'p2wpkh'); } catch { lowOk = false; }
  check('btc ACCEPTS canonical S exactly at N/2', lowOk);
  refuses('high-S at N/2 + 1', compact(HALF + 1n));
  refuses('S = 0', compact(0n));

  // F4: bc1q covers BOTH witness-v0 types; P2WSH is 62 chars and the node
  // refuses it by TYPE, so classifying it as p2wpkh sent an unverifiable sig.
  check('a 62-char bc1q (P2WSH) is NOT classified p2wpkh',
    btcAddressType('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3') === null,
    String(btcAddressType('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3')));

  // F5: a testnet-genesis DID can never verify (the node only parses mainnet),
  // so it must not route to the BTC rail and prompt a wallet.
  check('a testnet-genesis BTC DID does not route',
    btcAddressFromDid('did:pkh:bip122:000000000933ea01ad0ee984209779ba:bc1qewdludr3fpy3k903hqave02ue4xm9ha83c9c0m') === null);
  check('the mainnet-genesis BTC DID still routes',
    btcAddressFromDid('did:pkh:bip122:000000000019d6689c085ae165831e93:bc1qewdludr3fpy3k903hqave02ue4xm9ha83c9c0m') === 'bc1qewdludr3fpy3k903hqave02ue4xm9ha83c9c0m');
}

void (async () => {
  await Promise.all(pending);
  if (failures.length > 0) {
    console.error(`vsc-tx self-test FAILED:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('vsc-tx self-test: all checks passed');
})();
