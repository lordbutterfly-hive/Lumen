import { THexString } from '@hiveio/wax';

/**
 * Refuse to sign a transaction whose digest is not the one the caller built.
 *
 * ★★★ WHY THIS EXISTS — A SIGNATURE FOR THE WRONG CHAIN, SIGNED SILENTLY
 * (proven 2026-08-17).
 *
 * Every signer here receives BOTH the `digest` the caller computed and the
 * `transaction` proto. The four wallet-backed signers (Keychain, PeakVault,
 * MetaMask, Google Drive) cannot sign a bare digest — their providers take a
 * transaction OBJECT — so each one rebuilds it:
 *
 *     const authTx = (await getChain()).createTransactionFromProto(transaction);
 *
 * `getChain()` is the app's ONE GLOBAL chain. A Hive signature digest is bound
 * to the chain id, so that rebuild silently re-derives the digest against
 * whatever network the global chain points at — regardless of which network the
 * caller built the transaction for.
 *
 * That is not hypothetical. Meritum runs on Magi, an L2 over Hive — a write is
 * an ordinary Hive L1 `custom_json` that Magi reads back — so the signature must
 * be bound to THE L1 MAGI READS. For Magi testnet that is the Hive TESTNET.
 * Creator-tokens builds on exactly that chain
 * (`features/creator-tokens/lib/vsc/hive-chain.ts`) and passes the correct
 * digest down, while the global chain is Hive mainnet. Measured, same
 * transaction, same proto:
 *
 *     digest the broadcaster passes (testnet) : 77cc5e5c...
 *     digest the wallet actually signs (mainnet): 2f582dff...
 *     control, same proto rebuilt on testnet  : 77cc5e5c...   (matches)
 *
 * The control rebuilding to the identical digest is what proves the difference
 * is the chain id and not the rebuild. So every Meritum write went to the wallet
 * as a MAINNET-bound digest, the user approved a high-trust ACTIVE-key prompt,
 * and the testnet then had to reject the signature — with nothing anywhere
 * saying which network anything was for.
 *
 * `signer-wif.ts` and `signer-hbauth.ts` have carried exactly this check since
 * before any of that ("Digests do not match"); the four wallet signers never
 * got it. This is that check, shared, with a message that names the actual
 * problem instead of stating a hash mismatch.
 *
 * ★ IT CANNOT BREAK A WORKING FLOW. When the caller builds on the same chain the
 * signer rebuilds on — every ordinary Lumen operation — the digests are equal
 * and this is a no-op. When they differ, the signature was already invalid and
 * the chain was always going to reject it; the only change is that the user
 * finds out BEFORE approving a wallet prompt rather than after.
 *
 * ★ IT IS A GUARD, NOT THE FIX. It stops a doomed signature; it does not let a
 * transaction built for another network be signed. Enabling that needs the
 * signer to rebuild on the CALLER's chain (an optional chain on
 * `SignTransaction`), which is a change to shared signing that must be verified
 * against a real wallet before it ships.
 */
export function assertDigestMatches(expected: THexString, rebuilt: THexString, signerName: string): void {
  if (expected === rebuilt) return;
  throw new Error(
    `${signerName}: refusing to sign — this transaction was built for a different network than the app's ` +
      `default chain, so the signature would be rejected. (expected digest ${expected.slice(0, 16)}…, ` +
      `rebuilt ${rebuilt.slice(0, 16)}…)`
  );
}
