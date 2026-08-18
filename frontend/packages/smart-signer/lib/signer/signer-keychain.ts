import { SignChallenge, SignTransaction, Signer, SignerOptions } from '@smart-signer/lib/signer/signer';
import { TTransactionPackType, IOnlineSignatureProvider } from '@hiveio/wax';
import KeychainProvider from '@hiveio/wax-signers-keychain';

import { getLogger } from '@hive/ui/lib/logging';
import { getChain } from '@transaction/lib/chain';
import { assertDigestMatches } from '@smart-signer/lib/signer/assert-digest';
import { verifyAuthorityOrThrow } from '@smart-signer/lib/signer/verify-authority';
const logger = getLogger('app');

// See https://github.com/hive-keychain/hive-keychain-extension/blob/master/documentation/README.md#requestsignbuffer

declare global {
  interface Window {
    hive_keychain: any;
  }
}

/**
 * Checks if Hive Keychain extension is available and compatible.
 * Uses defensive checks to prevent DOM clobbering attacks where user content
 * like `<a id="hive_keychain">` could shadow the extension object.
 */
export const hasCompatibleKeychain = () =>
  typeof window === 'object' &&
  typeof window.hive_keychain === 'object' &&
  window.hive_keychain !== null &&
  typeof window.hive_keychain.requestSignBuffer === 'function';

/**
 * Signs challenges (any strings) or Hive transactions with Hive private
 * keys, using [Keychain](https://hive-keychain.com/).
 *
 * @export
 * @class SignerKeychain
 * @extends {Signer}
 */
/**
 * Keychain's own `requestSignTx`, including the `rpc` argument that
 * `@hiveio/wax-signers-keychain` drops. Mirrors that provider's behaviour
 * exactly otherwise: same LEGACY api shape in, signatures pushed onto the
 * transaction, provider errors rethrown untouched.
 */
/**
 * ★★★ KEYCHAIN'S REJECTION IS NOT AN `Error` (2026-08-18).
 *
 * It calls back with a plain object — `{ success, error, message }`. Rejecting
 * with that object straight through meant `writeFailureMessage`
 * (creator-tokens/ui/write-failure.ts) read `''` for the message and printed
 * "Launch did not go through." with no reason at all, which is exactly what the
 * owner saw. Carry the wallet's own words across as a real Error so the reason
 * survives to the screen.
 */
function keychainError(res: KeychainSignTxResponse): Error {
  const detail =
    (typeof res?.message === 'string' && res.message) ||
    (typeof res?.error === 'string' && res.error) ||
    (() => {
      try {
        return JSON.stringify(res?.error ?? res);
      } catch {
        return 'unknown Keychain error';
      }
    })();
  return new Error(`Hive Keychain refused to sign: ${detail}`);
}

/**
 * Does this signed transaction verify on the APP'S GLOBAL chain (Hive mainnet)?
 *
 * Only ever asked after a verify failed on the chain we intend to broadcast to,
 * and only to tell two indistinguishable failures apart: a key that lacks the
 * authority, versus a good key whose signature was stamped for another network.
 * Never authorises anything — a `true` here makes the error MORE specific, it
 * does not let the transaction through.
 */
async function verifiesOnGlobalChain(txApiJson: Parameters<typeof verifyAuthorityOrThrow>[0], role: string): Promise<boolean> {
  try {
    await verifyAuthorityOrThrow(txApiJson, TTransactionPackType.LEGACY, role, 'Keychain(cross-chain probe)');
    return true;
  } catch {
    return false;
  }
}

async function signViaKeychainOnNode(
  username: string,
  authTx: { toLegacyApi(): string; transaction: { signatures: string[] } },
  role: string,
  rpcEndpoint: string,
  rpcChainId?: string
): Promise<void> {
  const keychain = (globalThis as unknown as { hive_keychain?: KeychainRequestSignTx }).hive_keychain;
  if (!keychain?.requestSignTx) {
    throw new Error('Hive Keychain is not available in this browser.');
  }
  /**
   * ★ Keychain's own RPC module does `HiveTxConfig.chain_id = rpc.chainId`
   * (hive-keychain-extension/src/background/rpc.module.ts), and its `Rpc` type is
   * `{ uri: string; chainId?: string }` — so the object form is the ONLY shape
   * that can move the signing chain id off mainnet. The PUBLIC docs for
   * `requestSignTx` type this argument as a plain String, so whether a dApp's
   * object survives the message boundary is undocumented; try the object first
   * and fall back to the bare URI rather than failing outright on wallets that
   * only accept the documented form.
   */
  const attempt = (rpcArg: string | { uri: string; chainId?: string }) =>
    new Promise<KeychainSignTxResponse>((resolve, reject) => {
      keychain.requestSignTx(
        username,
        JSON.parse(authTx.toLegacyApi()),
        role,
        (res: KeychainSignTxResponse) => (res?.error ? reject(keychainError(res)) : resolve(res)),
        rpcArg
      );
    });

  let response: KeychainSignTxResponse;
  try {
    response = await attempt(rpcChainId ? { uri: rpcEndpoint, chainId: rpcChainId } : rpcEndpoint);
  } catch (objectFormError) {
    if (!rpcChainId) throw objectFormError;
    response = await attempt(rpcEndpoint);
  }
  const signatures = response?.result?.signatures ?? [];
  if (signatures.length === 0) {
    throw new Error('Hive Keychain returned no signature.');
  }
  // The provider path mutates the transaction in place; match it so the
  // verify_authority call below and the caller both see the signature.
  authTx.transaction.signatures.push(...signatures);
}

interface KeychainSignTxResponse {
  error?: unknown;
  message?: string;
  result?: { signatures?: string[] };
}

interface KeychainRequestSignTx {
  requestSignTx(
    account: string,
    tx: unknown,
    keyType: string,
    callback: (response: KeychainSignTxResponse) => void,
    rpc?: string | { uri: string; chainId?: string; testnet?: boolean }
  ): void;
}

export class SignerKeychain extends Signer {
  constructor(signerOptions: SignerOptions, pack: TTransactionPackType = TTransactionPackType.LEGACY) {
    super(signerOptions, pack);
  }

  async destroy(): Promise<void> {}

  async signChallenge({ message }: SignChallenge): Promise<string> {
    const { username, keyType } = this;
    logger.info('in SignerKeychain.signChallenge %o', { message, username, keyType });
    try {
      const provider = KeychainProvider.for(this.username, keyType);

      const signature = provider.encryptData(message, username);

      logger.info('keychain', { signature });
      return signature;
    } catch (error) {
      throw error;
    }
  }

  async signTransaction({
    digest,
    transaction,
    requiredKeyType,
    chain,
    rpcEndpoint,
    rpcChainId
  }: SignTransaction): Promise<string> {
    try {
      // `chain` is the chain the CALLER built on; omitted by every caller but
      // creator-tokens, which is on a different Hive L1. Falling back to the
      // global chain keeps every existing path byte-identical.
      const authTx = (chain ?? (await getChain())).createTransactionFromProto(transaction);
      assertDigestMatches(digest, authTx.sigDigest, 'Keychain');

      const role = requiredKeyType ?? this.keyType;

      if (rpcEndpoint) {
        // ★★★ SIGN AGAINST THE NODE WE WILL BROADCAST TO (2026-08-18).
        //
        // `KeychainProvider` calls requestSignTx WITHOUT its 5th `rpc` argument
        // (wax-signers-keychain/dist/index.js:142), so Keychain signs against
        // whatever node the EXTENSION is pointed at — Hive mainnet. Building on
        // Hive testnet and signing for mainnet yields a signature whose
        // recovered key is not the account's active key, and the testnet node
        // rejects it with `tx_missing_active_auth`. Passing `rpc` is the only
        // way to make Keychain derive the digest on the right chain id.
        await signViaKeychainOnNode(this.username, authTx, role, rpcEndpoint, rpcChainId);
      } else {
        const provider: IOnlineSignatureProvider = KeychainProvider.for(this.username, role);
        await provider.signTransaction(authTx);
      }

      /**
       * Verify on the SAME chain we will broadcast to. Verifying a testnet
       * transaction against mainnet is what let the bad signature through.
       *
       * ★★★ AND IF IT FAILS, FIND OUT *WHY* BEFORE BLAMING THE KEY (2026-08-18).
       *
       * "The provided key does not have active authority for this account" is
       * the right message when the key genuinely lacks the authority, and a
       * completely misleading one when the key is fine but the SIGNATURE WAS
       * MADE FOR A DIFFERENT CHAIN. A Hive digest is bound to the chain id, so a
       * signature Keychain produced against mainnet cannot satisfy an authority
       * check on another L1 — the recovered public key is simply a different key.
       *
       * Both look identical from a single failed check, so ask the other chain
       * too: if the app's global chain ACCEPTS this exact signed transaction,
       * the authority was never the problem and the chain id was. That turns an
       * unfalsifiable "your key is wrong" into a named, fixable condition.
       */
      try {
        await verifyAuthorityOrThrow(authTx.toApiJson(), TTransactionPackType.LEGACY, role, 'Keychain', chain);
      } catch (verifyError) {
        if (chain) {
          const signedForGlobalChain = await verifiesOnGlobalChain(authTx.toApiJson(), role);
          if (signedForGlobalChain) {
            throw new Error(
              'CREATOR_TOKENS_WRONG_CHAIN_SIGNATURE: your key is fine — Hive Keychain signed this for the wrong network. ' +
                'Meritum lives on Magi, which reads a different Hive L1 than the one Keychain is pointed at, and a Hive ' +
                'signature is bound to the network it was made for. Add that network as a custom RPC in Keychain ' +
                '(Settings -> Preferences -> RPC nodes), including its chain id, then select it and launch again.'
            );
          }
        }
        throw verifyError;
      }
      // F-L13 (sibling site) — logged the raw login signature at info.
      // This transaction is NEVER broadcast: it is the off-chain auth proof
      // the backend verifies, so the signature IS the credential and pino has
      // no redaction on this path. Log that one was produced, not its value.
      logger.info('Keychain signTransaction produced %d signature(s)', authTx.transaction.signatures.length);
      return authTx.transaction.signatures[0];
    } catch (error) {
      logger.error('SignerKeychain.signTransaction error: %s', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
