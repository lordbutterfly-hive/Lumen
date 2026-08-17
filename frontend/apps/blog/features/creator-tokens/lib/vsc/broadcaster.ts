import { transactionService } from '@transaction/index';
import { getCreatorTokensConfig } from '../creator-tokens-data-source';
import { getCreatorTokensHiveChain } from './hive-chain';
import { LoginType } from '@smart-signer/types/common';
import type { CustomJsonOp } from './op-builders';
import type { Broadcaster } from '../vsc-data-source';

// Finding C-B: the real broadcaster. VscCreatorTokensDataSource's
// broadcaster dependency existed (VscCreatorTokensDataSourceDeps.broadcaster)
// but was never supplied by getCreatorTokensDataSource() — every write threw
// NO_BROADCASTER_MSG on any real (provisioned) build. This file is the
// missing implementation.
//
// SIGNING STACK, verified directly against this repo's own code (not
// guessed): `transactionService` (packages/transaction/index.ts, imported
// here via the `@transaction/index` path alias apps/blog/tsconfig.json
// already maps to packages/transaction/index.ts — the same specifier
// apps/blog/features/wallet/lib/broadcast-raw-operation.ts already uses) is
// a plain module-level singleton, NOT a React hook — it does not need to be
// called from component scope. Its `signerOptions` are populated as a side
// effect by <SignerProvider>, mounted once at the app root
// (apps/blog/features/layouts/providers.tsx), so by the time ANY write here
// actually runs, whichever signing method (Keychain/HiveAuth/PeakVault/
// MetaMask/Google Drive/hbauth/WIF) the logged-in user configured is already
// wired — this function reads `transactionService` fresh on every call rather
// than capturing anything at construction time, so it works correctly
// regardless of whether getCreatorTokensDataSource()'s singleton was created
// before or after the user logged in.
//
// custom_json SHAPE: confirmed against packages/transaction/index.ts's own
// existing custom_json call (markAllNotificationAsRead,
// `builder.pushOperation({ custom_json_operation: { id, json,
// required_auths, required_posting_auths } })`) — @hiveio/wax's
// `ITransaction.pushOperation` wants a `{ custom_json_operation: {...} }`
// envelope with EXACTLY the four fields op-builders.ts's CustomJsonOp
// already produces, so `op` is passed straight through with no reshaping.
//
// ─────────────────────────────────────────────────────────────────────────
// ACTIVE AUTHORITY (2026-07-29 fix — the last open item in
// creator-tokens/STATUS.md "What is left" §3)
// ─────────────────────────────────────────────────────────────────────────
//
// THE BUG THIS FIXES. op-builders.ts already builds the RIGHT ENVELOPE:
// `required_auths: [account]`, `required_posting_auths: []` (op-builders.ts:
// 93-94). But an envelope is not a signature. `processHiveAppOperation` was
// called here with NO transaction options, so `requiredKeyType` arrived at
// packages/transaction/index.ts:122 as `undefined`, and every signer resolves
// `requiredKeyType ?? this.keyType` (signer-keychain.ts:65,
// signer-peakvault.ts:54, signer-metamask.ts:63, signer-google-drive.ts:478).
// `this.keyType` is whatever the user logged in with — for a blog session
// that is POSTING. So every creator-token write asked the wallet for a
// POSTING-key signature on an op whose `required_auths` demands ACTIVE.
//
// The Hive L1 would have rejected that signature outright ("missing required
// active authority"), so this was never a fund-loss vector — the chain is the
// backstop and it holds. It was a 100%-failure vector: not one write on this
// feature could ever have landed, and the user would have seen an opaque
// node error after being prompted for the wrong key. That is the same class
// of bug already fixed in creator-tokens/keeper/wire.go (which had shipped a
// posting-only envelope, with a test asserting the defect was correct), and
// it is fixed the same way: CHANGE THE CALLER. contract/main.go's
// requireActiveAuth (main.go:206-212) is not touched, and must not be — it
// refuses an empty `RequiredAuths` on all 25 of its state-changing
// entrypoints, and that refusal is exactly what stops a posting key (the
// low-trust key users delegate to every dApp, including this frontend) from
// moving another holder's money.
//
// WHAT IS ADDED, in order, before anything is signed:
//
//  1. `requiredKeyType: 'active'` is passed through. That is the RUNTIME
//     instruction — not a comment — that makes Keychain/PeakVault/MetaMask/
//     Google Drive/hbauth request the ACTIVE key regardless of the key type
//     the session logged in with.
//
//  2. The op is re-checked for active-auth shape HERE, unconditionally.
//     op-builders.ts's assertAuthContract already does this, but only when
//     `NODE_ENV !== 'production'` — i.e. it is off in the only build that
//     handles real money. This check is cheap (two array lengths) and runs
//     always. Nothing signed by this function can carry posting auth.
//
//  3. The signer's identity is checked against the op's own
//     `required_auths[0]`. <SignerProvider> deliberately does NOT call
//     `transactionService.setSignerOptions` for a lite account, and skips it
//     when `username === ''` (signer-provider.tsx:32-40) — so on logout, or
//     on a full -> lite account switch, the module-level singleton KEEPS THE
//     PREVIOUS USER'S signerOptions. Without this check the app would build
//     an op requiring bob's authority and hand it to a signer configured for
//     alice: at best an unexplainable rejection, at worst a wallet prompt
//     naming a stranger's account. It also converts the missing-signerOptions
//     case (a lite account that reached a money path) from
//     `TypeError: Cannot destructure property 'loginType' of 'undefined'`
//     three frames deep in getSigner() into a named, catchable error.
//
//  4. The signer is checked for the CAPABILITY to produce an active-authority
//     signature at all. Two of the shipped login types cannot, and both fail
//     late and confusingly without this:
//       - `hiveauth`: SignerHiveauth.signTransaction is
//         `throw new Error('Not implemented')` (signer-hiveauth.ts:34-36). It
//         cannot sign ANY transaction, of any key type.
//       - `hivesigner`: declared in the LoginType enum but never registered
//         in get-signer.ts's `registeredSigners`, so getSigner() throws
//         'Invalid loginType'.
//       - `wif`: REFUSED OUTRIGHT as of 2026-08-09. It used to be admitted
//         when the session had logged in with the active key, because
//         SignerWif.signDigest ignores `_requiredKeyType` and always signs with
//         `this.keyType`. But that is precisely the configuration in which the
//         creator's RAW ACTIVE KEY lives inside the page — SignerWif reads it
//         from `window.localStorage`, where "Store key" wrote it unencrypted —
//         and an active key is total control of the account. Keychain, the only
//         Hive login Lumen offers, already signs inside the extension and never
//         hands the key over, so this path bought nothing. See the refusal
//         below.
//     Everything else honours `requiredKeyType` and is admitted.
//
// These are refusals, never fallbacks. There is deliberately no path here
// that downgrades a write to posting authority, and no path that submits an
// op it could not verify. The trade-off is explicit: a HiveAuth or
// posting-WIF user is now told plainly that they cannot buy, instead of
// being walked through a wallet prompt that was always going to fail. That
// is the honest outcome, but it IS a hard block on those two login types —
// see the closeout report for what it would take to lift it.

/** The one key type every creator-tokens write must be signed with. Never widen this. */
const REQUIRED_KEY_TYPE = 'active' as const;

/**
 * Login types whose signer honours `requiredKeyType` and will therefore
 * request the ACTIVE key even when the session logged in with posting.
 * Verified one file at a time against packages/smart-signer/lib/signer/ —
 * do not add a login type here without reading its signTransaction.
 *
 * `wif` is deliberately ABSENT: SignerWif drops the parameter on the floor
 * (signer-wif.ts:47-48). It is admitted separately, and only when the session
 * itself is an active-key session.
 */
const ACTIVE_CAPABLE_LOGIN_TYPES: ReadonlySet<string> = new Set<string>([
  LoginType.keychain, // signer-keychain.ts:63-65   KeychainProvider.for(user, requiredKeyType ?? this.keyType)
  LoginType.peakvault, // signer-peakvault.ts:52-54  PeakVaultProvider.for(...)
  LoginType.metamask, // signer-metamask.ts:61-64   MetaMaskProvider.for(0, requiredKeyType ?? this.keyType, ...)
  LoginType.google, // signer-google-drive.ts:478 getWallet(user, requiredKeyType ?? this.keyType)
  LoginType.hbauth // signer-hbauth.ts:216-218   requireOtherKey(requiredKeyType, ...) when it differs from the session key
]);

/** Strip the `hive:` DID prefix reads.ts's toDid() adds, so two spellings of one account compare equal. */
function bareAccount(name: string): string {
  return name.startsWith('hive:') ? name.slice('hive:'.length) : name;
}

/**
 * Refuses, with a named and actionable reason, any write that cannot be
 * correctly signed under ACTIVE authority. Throws or returns; never repairs
 * the op and never downgrades the key type.
 */
function assertCanSignWithActiveAuthority(op: CustomJsonOp): void {
  // (2) The envelope itself. Unconditional — op-builders.ts's own copy of
  // this check is dev-only.
  if (op.required_auths.length === 0) {
    throw new Error(
      'CREATOR_TOKENS_NOT_ACTIVE_AUTH: this write carries no active authority (required_auths is empty). Every creator-tokens write entrypoint is gated on contract/main.go requireActiveAuth, which refuses an empty RequiredAuths — this op would be rejected on chain.'
    );
  }
  if (op.required_posting_auths.length > 0) {
    throw new Error(
      'CREATOR_TOKENS_POSTING_AUTH_REFUSED: this write carries posting authority (required_posting_auths is non-empty). A posting key is delegated to every dApp including this one; it must never be able to authorize a creator-tokens state change.'
    );
  }

  const signerOptions = transactionService.signerOptions as
    | { username?: string; loginType?: string; keyType?: string }
    | undefined;

  // (3) A signer must exist, and must be the account the op names.
  if (!signerOptions || !signerOptions.username || !signerOptions.loginType) {
    throw new Error(
      'CREATOR_TOKENS_NO_SIGNER: no Hive signer is configured for this session, so nothing can be signed. A lite account has no Hive keys and never reaches this path; if you are on a full account, sign out and back in.'
    );
  }
  const opSigner = bareAccount(op.required_auths[0]);
  const sessionSigner = bareAccount(signerOptions.username);
  if (opSigner !== sessionSigner) {
    throw new Error(
      `CREATOR_TOKENS_SIGNER_MISMATCH: this write requires ${opSigner}'s active authority but the session's signer is configured for ${sessionSigner}. Refusing rather than prompting the wrong account's wallet — sign out and back in.`
    );
  }

  // (4) The signer must actually be able to produce an ACTIVE signature.
  const loginType = signerOptions.loginType;
  if (ACTIVE_CAPABLE_LOGIN_TYPES.has(loginType)) return;

  if (loginType === LoginType.wif) {
    // ★★★ A RAW ACTIVE KEY MUST NEVER REACH THIS APP'S JAVASCRIPT (2026-08-09).
    //
    // This branch used to ACCEPT a wif session whose key type was already
    // active. That is the one configuration in which the creator's ACTIVE key
    // exists as a string inside the page: `SignerWif.signDigest` reads it from
    // `window.localStorage` and `password-form.tsx`'s "Store key" writes it
    // there UNENCRYPTED and PERSISTENT. An active key is total control of the
    // account — funds, authorities, everything — and localStorage is readable
    // by any XSS, any extension with page access, and anyone who dumps the
    // profile directory. Sentry's `WIF_PATTERN` scrubber does not help: it
    // filters error payloads, not a deliberate storage write.
    //
    // The owner's requirement is that the active key used to launch a token is
    // never visible anywhere in the client, and Keychain — the only Hive login
    // Lumen offers — already satisfies it by keeping the key inside the
    // extension and returning only a signature. So this path buys nothing and
    // risks everything: refuse it outright rather than leaving it one mounted
    // route away from being live.
    //
    // Note this is a REFUSAL, not a downgrade: it fails closed, and the message
    // names the two ways in that never expose the key.
    throw new Error(
      'CREATOR_TOKENS_KEY_IN_BROWSER_REFUSED: signing a Meritum operation with a private key held in this browser is not allowed — an active key pasted here would be stored in the browser in clear text. Use Hive Keychain or PeakVault, which sign inside the extension and never hand the key to this page.'
    );
  }

  if (loginType === LoginType.hiveauth) {
    throw new Error(
      'CREATOR_TOKENS_SIGNER_UNSUPPORTED: HiveAuth cannot sign transactions in this app yet (its signTransaction is unimplemented), so it cannot authorize a Meritum operation. Use Hive Keychain, PeakVault, MetaMask (Hive Snap), Google Drive keys, or sign in with your active key.'
    );
  }

  throw new Error(
    `CREATOR_TOKENS_SIGNER_UNSUPPORTED: the "${loginType}" sign-in method cannot produce an active-authority signature, which every Meritum operation requires. Use Hive Keychain, PeakVault, MetaMask (Hive Snap), Google Drive keys, or sign in with your active key.`
  );
}

export const hiveTransactionBroadcaster: Broadcaster = async (op: CustomJsonOp) => {
  assertCanSignWithActiveAuthority(op);

  // ★ WHICH HIVE CHAIN? (2026-08-07) — see lib/vsc/hive-chain.ts.
  //
  // The Magi network this contract lives on is fed by a specific Hive L1. When
  // that is NOT the L1 the rest of Lumen uses (the deployed case today: contract
  // on Magi testnet, Lumen's posts on Hive mainnet), a write built on the app's
  // global chain is signed against the wrong chain id and broadcast to a node no
  // Magi testnet witness reads — it is accepted by Hive and then silently
  // ignored forever. Reads were fine, so nothing looked wrong.
  const config = getCreatorTokensConfig();
  const override =
    config?.hiveApi || config?.hiveChainId
      ? { apiEndpoint: config?.hiveApi ?? '', chainId: config?.hiveChainId ?? '' }
      : null;

  if (override) {
    // Build, sign and broadcast on OUR chain. Deliberately not
    // transactionService.processHiveAppOperation / .broadcastTransaction —
    // both resolve the app's global chain internally, which is the whole
    // problem. `signTransaction` is the one piece that IS reusable: it signs
    // `txBuilder.sigDigest`, a digest this builder derived from this chain's
    // own id, so the user's existing signer works untouched.
    const chain = await getCreatorTokensHiveChain(override);
    const txBuilder = await chain.createTransaction();
    txBuilder.pushOperation({ custom_json_operation: op });
    txBuilder.validate();
    // ★ `chain` PASSED (2026-08-17) — without it this whole override was defeated
    // one step before the wallet. The four wallet-backed signers cannot sign a
    // bare digest, so they rebuild the transaction to hand their provider an
    // object, and they rebuilt it on the app's GLOBAL chain (Hive mainnet). That
    // re-stamped it with mainnet's chain id, so the signature could never be
    // valid on the Hive L1 that Magi testnet actually reads — verified live:
    // Magi testnet's last_processed_block tracks the Hive TESTNET head, not
    // mainnet's. Measured digests: this builder 77cc5e5c…, what the wallet was
    // handed 2f582dff…, same proto rebuilt here 77cc5e5c… (the control).
    const signature = await transactionService.signTransaction(txBuilder, undefined, REQUIRED_KEY_TYPE, chain);
    txBuilder.addSignature(signature);
    await chain.api.network_broadcast_api.broadcast_transaction({
      max_block_age: -1,
      trx: txBuilder.toApiJson()
    });
    return txBuilder.id;
  }

  const result = await transactionService.processHiveAppOperation(
    (builder) => {
      builder.pushOperation({ custom_json_operation: op });
    },
    // THE RUNTIME REQUIREMENT, not a comment. Reaches the signer as
    // SignTransaction.requiredKeyType (packages/transaction/index.ts:122,141-152).
    { requiredKeyType: REQUIRED_KEY_TYPE }
  );
  return result.transactionId;
};
