import { transactionService } from '@transaction/index';
import { LoginType, KeyType } from '@smart-signer/types/common';
import type { CustomJsonOp } from '../op-builders';
import type { Broadcaster } from '../vsc-market-data-source';

// The real broadcaster for the prediction market. VscMarketDataSource's
// broadcaster dependency existed (VscMarketDataSourceDeps.broadcaster) but was
// never supplied by getMarketDataSource() — so on any real (provisioned) build
// placeBet/claim threw NO_BROADCASTER_MSG. This file is the missing
// implementation, mirroring creator-tokens' lib/vsc/broadcaster.ts.
//
// ─────────────────────────────────────────────────────────────────────────
// F-L9 — SIGN WITH THE AUTHORITY THE OP ACTUALLY DECLARES (2026-07-31)
// ─────────────────────────────────────────────────────────────────────────
//
// THE BUG THIS FIXES. `processHiveAppOperation` was called with NO transaction
// options, so `requiredKeyType` arrived at packages/transaction/index.ts as
// `undefined`, and every signer resolves `requiredKeyType ?? this.keyType` —
// `this.keyType` being whatever the session logged in with (POSTING for a blog
// session). op-builders.ts builds MIXED-tier envelopes: `buildBetOp` demands
// ACTIVE authority (`required_auths:[user]`, because the contract does
// `sdk.HiveDraw`), while `buildClaimOp`/`buildReclaimOp` are POSTING-only. So
// every BET asked the wallet for a POSTING signature on an op whose
// `required_auths` demands ACTIVE — the Hive L1 rejects that ("missing required
// active authority"), a 100%-failure vector for betting, exactly the class of
// bug already fixed in the creator-tokens broadcaster this mirrors.
//
// Unlike creator-tokens (every write is active), the required key is DERIVED
// per-op from the envelope, then (1) passed through as the runtime instruction
// and (2) guarded — the signer must be the account the op names, and for an
// ACTIVE op must be capable of producing an active signature. These are refusals,
// never fallbacks: no path downgrades a bet to posting authority, and none
// submits an op it could not verify. contract-side `requireActiveAuth` is the
// on-chain backstop and is untouched.

/**
 * Login types whose signer honours `requiredKeyType` and will therefore request
 * the ACTIVE key even when the session logged in with posting. Verified one file
 * at a time against packages/smart-signer/lib/signer/ (same set the creator-tokens
 * broadcaster documents). `wif` is deliberately ABSENT — SignerWif ignores
 * `requiredKeyType` and signs with the session key, so it is admitted separately
 * and only when the session itself is active.
 */
const ACTIVE_CAPABLE_LOGIN_TYPES: ReadonlySet<string> = new Set<string>([
  LoginType.keychain,
  LoginType.peakvault,
  LoginType.metamask,
  LoginType.google,
  LoginType.hbauth
]);

/** Strip the `hive:` DID prefix so two spellings of one account compare equal. */
function bareAccount(name: string): string {
  return name.startsWith('hive:') ? name.slice('hive:'.length) : name;
}

/**
 * Derives the authority the op declares and refuses, with a named reason, any
 * write that cannot be correctly signed under it. Returns the key type to sign
 * with; never repairs the op and never downgrades the key type.
 */
function assertCanSign(op: CustomJsonOp): KeyType {
  const needsActive = op.required_auths.length > 0;
  const needsPosting = op.required_posting_auths.length > 0;
  // Exactly one authority tier. op-builders sets one and leaves the other empty;
  // both-or-neither is a malformed envelope the chain would reject.
  if (needsActive && needsPosting) {
    throw new Error(
      'PREDICTION_MARKET_MIXED_AUTH: this op carries BOTH active and posting authority. An op declares exactly one tier; refusing a malformed envelope rather than signing it.'
    );
  }
  if (!needsActive && !needsPosting) {
    throw new Error(
      'PREDICTION_MARKET_NO_AUTH: this op carries no authority (both auth arrays empty). Every market entrypoint is gated on the contract requiring an auth; this op would be rejected on chain.'
    );
  }
  const requiredKeyType = needsActive ? KeyType.active : KeyType.posting;
  const opSigner = bareAccount(needsActive ? op.required_auths[0] : op.required_posting_auths[0]);

  const signerOptions = transactionService.signerOptions as
    | { username?: string; loginType?: string; keyType?: string }
    | undefined;

  // A signer must exist, and must be the account the op names. <SignerProvider>
  // skips setSignerOptions for a lite account / on logout, so the module-level
  // singleton can retain the previous user's options — refuse rather than prompt
  // the wrong account's wallet, and turn a missing-signer into a named error.
  if (!signerOptions || !signerOptions.username || !signerOptions.loginType) {
    throw new Error(
      'PREDICTION_MARKET_NO_SIGNER: no Hive signer is configured for this session. A lite account has no Hive keys and never reaches this path; if you are on a full account, sign out and back in.'
    );
  }
  if (bareAccount(signerOptions.username) !== opSigner) {
    throw new Error(
      `PREDICTION_MARKET_SIGNER_MISMATCH: this op requires ${opSigner}'s authority but the session's signer is configured for ${bareAccount(
        signerOptions.username
      )}. Refusing rather than prompting the wrong account's wallet — sign out and back in.`
    );
  }

  const loginType = signerOptions.loginType;
  // HiveAuth's signTransaction is unimplemented — it cannot sign ANY tier.
  if (loginType === LoginType.hiveauth) {
    throw new Error(
      'PREDICTION_MARKET_SIGNER_UNSUPPORTED: HiveAuth cannot sign transactions in this app yet. Use Hive Keychain, PeakVault, MetaMask (Hive Snap), Google Drive keys, or sign in with the required key.'
    );
  }

  // Posting-tier ops (claim/reclaim) use the delegated session key every dApp
  // already holds — no capability problem beyond the HiveAuth block above.
  if (requiredKeyType === KeyType.posting) return requiredKeyType;

  // ACTIVE-tier ops (bet): the signer must actually be able to produce an active
  // signature under `requiredKeyType`.
  if (ACTIVE_CAPABLE_LOGIN_TYPES.has(loginType)) return requiredKeyType;
  if (loginType === LoginType.wif) {
    // SignerWif ignores requiredKeyType and signs with the session key type, so
    // the session key must already be active.
    if (signerOptions.keyType === KeyType.active) return requiredKeyType;
    throw new Error(
      'PREDICTION_MARKET_ACTIVE_KEY_REQUIRED: placing a bet moves funds and needs your ACTIVE key, but you are signed in with a posting private key. Sign back in with your active key, or use Hive Keychain / PeakVault, which can request it for a single transaction.'
    );
  }
  throw new Error(
    `PREDICTION_MARKET_SIGNER_UNSUPPORTED: the "${loginType}" sign-in method cannot produce an active-authority signature, which placing a bet requires. Use Hive Keychain, PeakVault, MetaMask (Hive Snap), Google Drive keys, or sign in with your active key.`
  );
}

export const hiveTransactionBroadcaster: Broadcaster = async (op: CustomJsonOp) => {
  const requiredKeyType = assertCanSign(op);
  const result = await transactionService.processHiveAppOperation(
    (builder) => {
      builder.pushOperation({ custom_json_operation: op });
    },
    // THE RUNTIME REQUIREMENT, not a comment: reaches the signer as
    // SignTransaction.requiredKeyType so a bet requests ACTIVE even from a
    // posting session (packages/transaction/index.ts).
    { requiredKeyType }
  );
  return result.transactionId;
};
