/**
 * Trade creator tokens as any QA wallet identity, EVM or Bitcoin.
 *
 *   npx tsx qa/harness/ct-trade.ts --as evm0 --action buy  --creator hive:lumen.aria --tokens 3 --go
 *   npx tsx qa/harness/ct-trade.ts --as btc1 --action sell --creator hive:lumen.aria --tokens 2 --go
 *   npx tsx qa/harness/ct-trade.ts --as evm0 --action register --face 25000 --cap 500 --go
 *   npx tsx qa/harness/ct-trade.ts --as btc3 --action state --creator hive:lumen.aria
 *
 * Run from `apps/blog` so imports resolve:
 *   cd apps/blog && npx tsx ../../qa/harness/ct-trade.ts ...
 *
 * ★ IT PRINTS BEFORE AND AFTER, ALWAYS. The point of this harness is not that a
 * button worked — it is whether the NUMBERS moved the way the curve says they
 * should. Every run reports the actor's HBD and token balance and the market's
 * supply and reserve on both sides of the action, so a discrepancy is visible
 * without a second tool.
 *
 * ★ `--go` IS REQUIRED TO SPEND. Without it this is a dry run: it builds and
 * signs, prints what it would send, and stops. Signing is free; submitting is
 * not.
 *
 * Keys live in `~/lumen-qa-wallets.json`, outside the repo. Testnet only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

import { buildCallOp, buildContainer, serializeContainer, toBase64 } from '../../apps/blog/lib/lite/wallet/vsc-tx/container';
import { encodeDagCbor, decodeDagCbor } from '../../apps/blog/lib/lite/wallet/vsc-tx/dag-cbor';
import { convertCborToEip712TypedData, toWalletTypedData } from '../../apps/blog/lib/lite/wallet/vsc-tx/eip712';
import { ALG_BIP137, ALG_EIP712, buildSigEnvelope, serializeSigEnvelope } from '../../apps/blog/lib/lite/wallet/vsc-tx/envelope';
import { assertBtcSignature, btcSigningMessage, normalizeBip137Header } from '../../apps/blog/lib/lite/wallet/vsc-tx/btc';
import { transferAllowIntent } from '../../apps/blog/lib/lite/wallet/vsc-tx/intents';
import { createSigningShell } from '../../apps/blog/lib/lite/wallet/vsc-tx/signing-shell';
import { buyPayload, sellPayload, registerPayload, transferTokensPayload } from '../../apps/blog/features/creator-tokens/lib/vsc/op-builders';

const GQL = 'https://magi-test.techcoderx.com/api/v1/graphql';
const CONTRACT = 'vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8';
const NET_ID = 'vsc-testnet';
/**
 * ★ rc_limit IS A CEILING THE CALLER MUST BE ABLE TO AFFORD. For a did:pkh
 * account RC *is* the HBD balance, so the node refuses ingest with
 * "not enough RCS available: <balance> < <rc_limit>" whenever rc_limit exceeds
 * what the wallet holds — even though the transaction would only consume ~100.
 * The app's DEFAULT_RC_LIMIT is 30_000, which means a wallet holding under 30
 * HBD cannot submit ANYTHING through the product. Worth its own report; here we
 * just size it to what the actor actually has.
 */
const RC_CEILING = 30_000;

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (d !== undefined) return d;
  throw new Error(`missing --${n}`);
};
const GO = argv.includes('--go');

interface Trader { id: string; chain: 'evm' | 'btc'; did: string; address: string; privateKey?: string; privateKeyHex?: string }

function trader(id: string): Trader {
  const cfg = JSON.parse(readFileSync(`${process.env.HOME}/lumen-qa-wallets.json`, 'utf8')) as {
    evm: Trader; btc: Trader; traders?: Trader[];
  };
  if (id === 'evm') return { ...cfg.evm, id: 'evm', chain: 'evm' };
  if (id === 'btc') return { ...cfg.btc, id: 'btc', chain: 'btc' };
  const t = (cfg.traders ?? []).find((x) => x.id === id);
  if (!t) throw new Error(`no trader "${id}" in ~/lumen-qa-wallets.json`);
  return t;
}

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch(GQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  return r.json();
}

/** Actor HBD, their token balance on `creator`, and that market's supply/reserve. */
async function snapshot(did: string, creator: string): Promise<Record<string, number>> {
  const keys = [`mb|${creator}|${did}`, `m|${creator}|sup`, `m|${creator}|res`];
  const [bal, state] = await Promise.all([
    gql(`query($a:String!){getAccountBalance(account:$a){hbd}}`, { a: did }),
    gql(`query($c:String!,$k:[String!]!){getStateByKeys(contractId:$c,keys:$k)}`, { c: CONTRACT, k: keys })
  ]);
  const s = state.data?.getStateByKeys ?? {};
  return {
    hbd: bal.data?.getAccountBalance?.hbd ?? 0,
    tokens: Number(s[keys[0]] ?? 0),
    supply: Number(s[keys[1]] ?? 0),
    reserve: Number(s[keys[2]] ?? 0)
  };
}

/** Stands in for the wallet extension: BIP-137, native-segwit header. */
function btcSign(privHex: string, message: string): string {
  const prefix = Buffer.from('\x18Bitcoin Signed Message:\n', 'binary');
  const msg = Buffer.from(message, 'utf8');
  const vi = msg.length < 0xfd ? Buffer.from([msg.length]) : Buffer.concat([Buffer.from([0xfd]), Buffer.from([msg.length & 0xff, msg.length >> 8])]);
  const digest = sha256(sha256(Buffer.concat([prefix, vi, msg])));
  const sig = secp256k1.sign(digest, privHex);
  const out = new Uint8Array(65);
  out[0] = 27 + (sig.recovery ?? 0) + 4 + 8; // native segwit; the client rewrites it
  out.set(sig.toCompactRawBytes(), 1);
  return Buffer.from(out).toString('base64');
}

(async () => {
  const me = trader(arg('as'));
  const action = arg('action');
  const creator = arg('creator', me.did);

  const before = await snapshot(me.did, creator);
  if (action === 'state') {
    console.log(JSON.stringify({ who: me.id, did: me.did, creator, ...before }));
    return;
  }

  let payload: Record<string, unknown>;
  let allow = 0;
  let onChainAction = action;
  switch (action) {
    case 'buy': payload = buyPayload(creator, Number(arg('tokens', '1'))); allow = Number(arg('allow', '400000')); break;
    case 'sell': payload = sellPayload(creator, Number(arg('tokens', '1'))); break;
    case 'register': payload = registerPayload(Number(arg('face', '25000')), Number(arg('cap', '500'))); break;
    case 'send':
      // ★ THE ON-CHAIN ACTION IS `transfer`, NOT `send`. The wasm export is
      // named transfer; passing the CLI verb straight through produced
      // `wasm_function_not_found` and burned the caller's RC for nothing.
      // vsc-data-source.ts hardcodes 'transfer' and says so in a comment; this
      // harness did not. A QA tool that fails differently from the product is
      // worse than no tool.
      onChainAction = 'transfer';
      payload = transferTokensPayload(creator, arg('to'), Number(arg('tokens', '1')));
      break;
    default: throw new Error(`unsupported --action ${action}`);
  }

  // Leave a margin so the limit is affordable even as the balance moves.
  const rcLimit = Number(arg('rc', String(Math.max(1_000, Math.min(RC_CEILING, Math.floor(before.hbd * 0.8))))));
  const nonce = (await gql(`query($a:String!){getAccountNonce(account:$a){nonce}}`, { a: me.did })).data.getAccountNonce.nonce;
  const op = buildCallOp({
    contractId: CONTRACT, action: onChainAction, payload, rcLimit,
    intents: allow > 0 ? [transferAllowIntent(allow)] : [], caller: me.did
  });
  const container = buildContainer({ netId: NET_ID, nonce, rcLimit, requiredAuths: [me.did], ops: [op] });
  const shell = createSigningShell(container as never, (p) => decodeDagCbor(p as Uint8Array));
  const shellBytes = encodeDagCbor(shell as unknown as Record<string, unknown>);

  let sig: string; let alg: string;
  if (me.chain === 'evm') {
    const td = toWalletTypedData(convertCborToEip712TypedData(shellBytes));
    sig = await privateKeyToAccount(me.privateKey as `0x${string}`).signTypedData({
      domain: td.domain, types: td.types as never, primaryType: td.primaryType as never, message: td.message as never
    });
    alg = ALG_EIP712;
  } else {
    const raw = btcSign(me.privateKeyHex as string, await btcSigningMessage(shellBytes));
    sig = normalizeBip137Header(raw);
    assertBtcSignature(sig, 'p2wpkh');
    alg = ALG_BIP137;
  }

  if (!GO) {
    console.log(JSON.stringify({ dryRun: true, who: me.id, action, creator, payload, before }));
    return;
  }

  const res = await gql(`query($tx:String!,$sig:String!){submitTransactionV1(tx:$tx,sig:$sig){id}}`, {
    tx: toBase64(serializeContainer(container)),
    sig: serializeSigEnvelope(buildSigEnvelope([{ alg, sig, kid: me.did }]))
  });
  const id = res.data?.submitTransactionV1?.id;
  if (!id) {
    console.log(JSON.stringify({ who: me.id, action, creator, submitted: false, error: res.errors?.[0]?.message ?? 'unknown' }));
    process.exit(1);
  }

  // Wait for the chain to say what happened, then re-read. "Submitted" is not
  // "executed" — a transaction can be accepted and then dropped or fail.
  // ★ INCLUDED IS NOT TERMINAL. A transaction reads INCLUDED before the chain
  // has settled it, and can still land on CONFIRMED or FAILED afterwards.
  // Stopping at INCLUDED reports "nothing changed" for a buy that then works,
  // and "worked" for one that then fails. Only CONFIRMED and FAILED are answers.
  let status = 'UNCONFIRMED';
  for (let i = 0; i < 30 && !['CONFIRMED', 'FAILED'].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 6000));
    const q = await gql(`query($id:String!){findTransaction(filterOptions:{byId:$id}){status}}`, { id });
    status = q.data?.findTransaction?.[0]?.status ?? status;
  }
  await new Promise((r) => setTimeout(r, 8000));
  const after = await snapshot(me.did, creator);

  console.log(JSON.stringify({
    who: me.id, chain: me.chain, action, creator, tx: id, status,
    before, after,
    delta: { hbd: after.hbd - before.hbd, tokens: after.tokens - before.tokens, supply: after.supply - before.supply, reserve: after.reserve - before.reserve }
  }));
})();
