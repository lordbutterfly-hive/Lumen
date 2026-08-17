import { LoginType } from '@smart-signer/types/common';
import { KeyType } from '@smart-signer/types/common';
import { StorageType } from '@smart-signer/lib/storage-mixin';
// Type-only: this file is the abstract base every one of the 7 signer backends
// extends, AND it is reachable statically from `use-signer.ts` (SignerProvider's
// `useSigner()` hook, mounted on every page) — so unlike the signer subclasses
// themselves (which only load behind get-signer.ts's dynamic import), this file's
// own '@hiveio/wax' names have to stay type-only or they reopen the same leak.
// `TTransactionPackType` in particular IS a real runtime enum elsewhere
// (auth/utils.ts builds a zod schema from it) — here it is only ever a type.
import type { THexString, transaction, TTransactionPackType, IHiveChainInterface } from '@hiveio/wax';

import { getLogger } from '@hive/ui/lib/logging';
const logger = getLogger('app');

export interface SignTransaction {
  digest: THexString;
  transaction: transaction;
  // if singleSign is defined, this is required
  // so we need to get the private key from the user
  singleSignKeyType?: 'owner' | 'active' | 'posting';
  requiredKeyType?: 'owner' | 'active' | 'posting';
  /**
   * The chain this transaction was BUILT on. Omit it — as every caller but one
   * does — and the signer keeps using the app's global chain exactly as before.
   *
   * ★ WHY IT EXISTS (2026-08-17). A Hive signature digest is bound to the chain
   * id, and the four wallet-backed signers cannot sign a bare digest: their
   * providers take a transaction OBJECT, so each rebuilds one from the proto via
   * `getChain()` — the single global chain. That silently re-stamps the
   * transaction with the global network's id no matter which network the caller
   * built it for.
   *
   * Meritum runs on Magi, an L2 over Hive: a write is an ordinary Hive L1
   * `custom_json` that Magi reads back. So the signature must be bound to the
   * L1 THAT MAGI READS — for Magi testnet that is the Hive TESTNET, not Hive
   * mainnet. Creator-tokens builds on exactly that chain; the global chain is
   * Hive mainnet, so every Meritum write reached the wallet stamped for the
   * wrong L1 and could never be picked up. Measured, same transaction:
   * testnet digest 77cc5e5c…, what the wallet signed 2f582dff…, and the same
   * proto rebuilt on the testnet reproduced 77cc5e5c… exactly — the control that
   * proves the chain id was the only variable.
   *
   * Passing the builder's own chain here makes the rebuild faithful. It is
   * OPTIONAL and additive on purpose: no existing caller sets it, so no existing
   * signature path changes by a single byte.
   *
   * Type-only import, like every other wax name in this file — see the note
   * above; this module is statically reachable from every page.
   */
  chain?: IHiveChainInterface;
}
export interface SignChallenge {
  message: string | ArrayBufferView | ArrayBuffer;
  password?: string; // private key or password to unlock hbauth key
  translateFn?: (v: string) => string;
}

export interface SignerOptions {
  username: string;
  loginType: LoginType;
  keyType: KeyType;
  storageType: StorageType;
  authorityUsername?: string;
}

/**
 * Signs challenges (any strings) or Hive transactions with Hive private
 * keys.
 *
 * @export
 * @abstract
 * @class Signer
 */
export abstract class Signer {
  username: string;
  loginType: LoginType;
  keyType: KeyType;
  storageType: StorageType;
  pack: TTransactionPackType;
  authorityUsername?: string;
  constructor(
    { username, loginType, keyType, storageType }: SignerOptions,
    pack: TTransactionPackType
  ) {
    logger.info('Starting Signer constructor with options: %o and pack: %s', arguments[0], arguments[1]);
    if (pack) {
      this.pack = pack;
    } else {
      throw new Error('Signer constructor: pack must be non-empty string');
    }
    if (username) {
      this.username = username;
    } else {
      throw new Error('Signer constructor: username must be non-empty string');
    }
    if (loginType) {
      this.loginType = loginType;
    } else {
      throw new Error('Signer constructor: loginType must be non-empty string');
    }
    if (keyType) {
      this.keyType = keyType;
    } else {
      throw new Error('Signer constructor: keyType must be non-empty string');
    }
    if (storageType) {
      this.storageType = storageType;
    } else {
      throw new Error('Signer constructor: storageType must be non-empty string');
    }
  }

  /**
   * Clears all user data in storages and memory, does other things
   * required before destroying auth session.
   *
   * @abstract
   * @returns {Promise<void>}
   * @memberof Signer
   */
  abstract destroy(): Promise<void>;

  /**
   * Calculates sha256 digest (hash) of any string (challenge) and signs
   * it with Hive private key. It's good for verifying private keys, in
   * login procedure for instance. However it's bad for signing Hive
   * transactions, because this needs other hashing method and other
   * special treatment.
   *
   * @abstract
   * @param {SignChallenge} arg
   * @returns {Promise<string>}
   * @memberof Signer
   */
  abstract signChallenge(arg: SignChallenge): Promise<string>;

  /**
   * Signs Hive transaction with Hive private key and returns signature.
   *
   * @abstract
   * @param {SignTransaction} arg
   * @returns {Promise<string>}
   * @memberof Signer
   */
  abstract signTransaction(arg: SignTransaction): Promise<string>;
}
