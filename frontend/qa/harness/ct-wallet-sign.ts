/**
 * Sign a creator-tokens action as an EVM or BITCOIN wallet, on Magi testnet.
 *
 * WHY THIS EXISTS. `ct-broadcast.mjs` signs as a HIVE account, and the
 * creator-tokens charter still tells agents that "no browser can sign". That
 * stopped being true on 2026-08-20: a `did:pkh:eip155` (Ethereum) or
 * `did:pkh:bip122` (Bitcoin) identity now signs Magi transactions natively, and
 * every one of the 24 write actions is reachable from a wallet. This is the
 * harness for that path, so a QA agent can put a wallet-signed market into a
 * known state instead of asking the coordinator to do it by hand.
 *
 *   npx tsx qa/harness/ct-wallet-sign.ts --chain evm --action buy --creator hive:lumen.aria --tokens 1
 *   npx tsx qa/harness/ct-wallet-sign.ts --chain btc --action buy --creator hive:lumen.cole --tokens 1 --broadcast
 *
 * DRY RUN IS THE DEFAULT, deliberately: this spends real testnet HBD, consumes a
 * nonce slot, and mutates contract state that other charters are reading.
 *
 * ★ KEYS LIVE OUTSIDE THE REPO, at `~/lumen-qa-wallets.json` (mode 600). They are
 * throwaway testnet identities holding no mainnet value — but a private key in a
 * git tree is a private key in a git tree, so it does not go in one. The BTC key
 * is a MAINNET-FORMAT address by necessity: the node only ever parses mainnet
 * Bitcoin DIDs (`dids.Parse` never calls `ParseBtcTestnetDID`). That does NOT
 * mean bitcoin is at stake — a Magi transaction signed with a Bitcoin key never
 * touches the Bitcoin chain and moves only HBD on Magi.
 */
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

import {
  buildCallOp,
  buildContainer,
  serializeContainer,
  toBase64
} from '../../apps/blog/lib/lite/wallet/vsc-tx/container';
import { encodeDagCbor, decodeDagCbor } from '../../apps/blog/lib/lite/wallet/vsc-tx/dag-cbor';
import { convertCborToEip712TypedData, toWalletTypedData } from '../../apps/blog/lib/lite/wallet/vsc-tx/eip712';
import {
  ALG_BIP137,
  ALG_EIP712,
  assertEvmSignature,
  buildSigEnvelope,
  serializeSigEnvelope
} from '../../apps/blog/lib/lite/wallet/vsc-tx/envelope';
import { assertBtcSignature, btcSigningMessage, normalizeBip137Header } from '../../apps/blog/lib/lite/wallet/vsc-tx/btc';
import { transferAllowIntent } from '../../apps/blog/lib/lite/wallet/vsc-tx/intents';
import { createSigningShell } from '../../apps/blog/lib/lite/wallet/vsc-tx/signing-shell';
import {
  buyPayload,
  sellPayload,
  registerPayload,
  createOfferingPayload,
  askPayload
} from '../../apps/blog/features/creator-tokens/lib/vsc/op-builders';
import { rcLimitForAction } from '../../apps/blog/features/creator-tokens/lib/vsc/rc-budget';

const GQL = 'https://magi-test.techcoderx.com/api/v1/graphql';
const CONTRACT = 'vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8';
const NET_ID = 'vsc-testnet';
// ★ NOT A STATIC 30,000 (fixed 2026-08-23). `rc_limit` is RESERVED against the same
// HBD the call spends from, so a flat 30,000 reserves 30 HBD for every action and made
// this harness warn "balance below rc_limit" — and refuse to submit — for any wallet
// under 30 HBD that could comfortably afford the actual call. That is the exact static
// limit the client dropped in favour of `rcLimitForAction`; the harness kept it and so
// stopped matching what the app really sends. A harness that declares a different
// rc_limit than the client is not testing the client.
const rcLimitFor = (action: string) => rcLimitForAction(action);

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string): string => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
};
const BROADCAST = argv.includes('--broadcast');

interface Wallets {
  evm: { privateKey: string; address: string; did: string };
  btc: { privateKeyHex: string; address: string; did: string };
}
function wallets(): Wallets {
  const path = `${process.env.HOME}/lumen-qa-wallets.json`;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Wallets;
  } catch {
    throw new Error(
      `ct-wallet-sign: no QA wallets at ${path}. This file is deliberately outside the repo; ` +
        'see the header for its shape.'
    );
  }
}

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const r = await fetch(GQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return r.json() as Promise<Record<string, any>>;
}

/** Stands in for Leather/Xverse: BIP-137 compact, native-segwit header. */
function btcWalletSign(privHex: string, message: string): string {
  const digest = (() => {
    // BitcoinMessageHash: double-SHA256 over the varint-prefixed message.
    const prefix = Buffer.from('\x18Bitcoin Signed Message:\n', 'binary');
    const msg = Buffer.from(message, 'utf8');
    const vi = msg.length < 0xfd ? Buffer.from([msg.length]) : Buffer.concat([Buffer.from([0xfd]), Buffer.from([msg.length & 0xff, msg.length >> 8])]);
    return sha256(sha256(Buffer.concat([prefix, vi, msg])));
  })();

  const sig = secp256k1.sign(digest, privHex);
  const compact = new Uint8Array(65);
  // 27 + recid + 4 (compressed), then +8 to emit what a NATIVE SEGWIT wallet
  // emits — which the client rewrites back into the range Go accepts.
  compact[0] = 27 + (sig.recovery ?? 0) + 4 + 8;
  compact.set(sig.toCompactRawBytes(), 1);
  return Buffer.from(compact).toString('base64');
}

function payloadFor(action: string): Record<string, unknown> {
  switch (action) {
    case 'buy':
      return buyPayload(arg('creator'), Number(arg('tokens', '1')));
    case 'sell':
      return sellPayload(arg('creator'), Number(arg('tokens', '1')));
    case 'register':
      return registerPayload(Number(arg('face', '25000')), Number(arg('cap', '30')));
    case 'createOffering':
      return createOfferingPayload(arg('title'), Number(arg('price', '15000')));
    case 'ask': {
      // ★ THE ARGUMENT ORDER WAS STALE AND THIS HANDLER COULD NEVER HAVE WORKED
      // (fixed 2026-08-23, found by a decorrelated session trying to seed an ask).
      // `askPayload(creator, contentHash, deadlineBlocks, maxCreditsBaseUnits, offeringId?)`.
      // This passed the OFFERING as `contentHash` (a number, which
      // `assertHashField` refuses outright), the HASH as `deadlineBlocks`, and
      // omitted `maxCredits` entirely — which `core.Ask` requires and refuses when
      // absent, precisely so a creator cannot spike `face` between signing and
      // execution. Every field after the first was wrong.
      const offering = arg('offering', '');
      return askPayload(
        arg('creator'),
        arg('hash', ''.padEnd(64, 'a')),
        Number(arg('deadlineBlocks', String(28_800))),
        Number(arg('maxCredits', '50000')),
        offering === '' ? undefined : Number(offering)
      );
    }
    default:
      throw new Error(`ct-wallet-sign: unsupported --action ${action}. Add it here if a charter needs it.`);
  }
}

(async () => {
  const chain = arg('chain');
  if (chain !== 'evm' && chain !== 'btc') throw new Error('--chain must be evm or btc');
  const action = arg('action');
  const w = wallets();
  const did = chain === 'evm' ? w.evm.did : w.btc.did;

  const state = await gql(
    `query($a:String!){ getAccountBalance(account:$a){hbd} getAccountNonce(account:$a){nonce} }`,
    { a: did }
  );
  const nonce = state.data?.getAccountNonce?.nonce ?? 0;
  const hbd = state.data?.getAccountBalance?.hbd ?? 0;
  console.log(`identity : ${did}`);
  console.log(`balance  : ${hbd} base units  |  nonce: ${nonce}`);
  const RC_LIMIT = rcLimitFor(action);
  if (hbd < RC_LIMIT) {
    // RC IS the HBD balance for a did:pkh account — there is no free tier, so a
    // thin balance fails at ingest with "not enough RCS available" and nothing
    // explains why.
    console.log(`WARNING  : balance is below rc_limit ${RC_LIMIT}; the node will refuse this submit.`);
  }

  const payload = payloadFor(action);
  const hbdLeg = action === 'buy' ? Number(arg('allow', '60000')) : 0;
  const op = buildCallOp({
    contractId: CONTRACT,
    action,
    payload,
    rcLimit: RC_LIMIT,
    intents: hbdLeg > 0 ? [transferAllowIntent(hbdLeg)] : [],
    caller: did
  });
  const container = buildContainer({ netId: NET_ID, nonce, rcLimit: RC_LIMIT, requiredAuths: [did], ops: [op] });
  const shell = createSigningShell(container as never, (p) => decodeDagCbor(p as Uint8Array));
  const shellBytes = encodeDagCbor(shell as unknown as Record<string, unknown>);

  let sig: string;
  let alg: string;
  if (chain === 'evm') {
    const td = toWalletTypedData(convertCborToEip712TypedData(shellBytes));
    console.log(`signing  : EIP-712 typed data, primaryType ${td.primaryType}`);
    sig = await privateKeyToAccount(w.evm.privateKey as `0x${string}`).signTypedData({
      domain: td.domain,
      types: td.types as never,
      primaryType: td.primaryType as never,
      message: td.message as never
    });
    assertEvmSignature(sig);
    alg = ALG_EIP712;
  } else {
    const message = await btcSigningMessage(shellBytes);
    console.log(`signing  : Bitcoin Signed Message over the container CID`);
    console.log(`           the wallet prompt shows exactly: ${message}`);
    const raw = btcWalletSign(w.btc.privateKeyHex, message);
    sig = normalizeBip137Header(raw);
    console.log(`           wallet header ${Buffer.from(raw, 'base64')[0]} -> rewritten to ${Buffer.from(sig, 'base64')[0]}`);
    assertBtcSignature(sig, 'p2wpkh');
    alg = ALG_BIP137;
  }

  const tx = toBase64(serializeContainer(container));
  const envelope = serializeSigEnvelope(buildSigEnvelope([{ alg, sig, kid: did }]));

  if (!BROADCAST) {
    console.log(`\nDRY RUN — nothing sent. action=${action} payload=${JSON.stringify(payload)}`);
    console.log('Re-run with --broadcast to submit.');
    return;
  }

  const res = await gql(
    `query($tx:String!,$sig:String!){ submitTransactionV1(tx:$tx,sig:$sig){ id } }`,
    { tx, sig: envelope }
  );
  const id = res.data?.submitTransactionV1?.id;
  if (!id) {
    console.log('SUBMIT FAILED:', JSON.stringify(res));
    process.exit(1);
  }
  console.log(`\nSUBMITTED: ${id}`);
  console.log('Poll findTransaction for status; INCLUDED means it executed.');
})();
