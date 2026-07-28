import type { IBeekeeperUnlockedWallet } from '@hiveio/beekeeper';
import type { IHiveChainInterface } from '@hiveio/wax';
import { getLogger } from '@ui/lib/logging';
import { scrubSensitiveData } from '@ui/lib/sentry-scrub';
import { siteConfig } from '@ui/config/site';
import { liteConfig } from '../config';
import { AccountCreator, AccountPublicKeys, hasAccountCreator, setAccountCreator } from './account-creator';

const logger = getLogger('app');

/**
 * The real `AccountCreator` (spec §F.1/§F.3): claims Account Creation Tokens and
 * turns a lite account into a genuine Hive account with its own keys.
 *
 * Shaped deliberately after `publisher/hive-broadcaster.ts` — same in-memory
 * beekeeper wallet, same boot-time authority proof, same runtime-import escape
 * hatch — because that module already paid for every trap on this path. The one
 * structural difference is the key tier: the publisher signs with POSTING, which can
 * only publish. This module signs with ACTIVE, which can also move funds. That is
 * why it is a distinct account (`LITE_ACCOUNT_CREATOR_ACCOUNT_*`) holding no
 * balance, not a second role bolted onto the publisher account.
 *
 * Safety properties enforced before anything is ever broadcast:
 *  1. The imported key's public key MUST appear in the configured account's ACTIVE
 *     authority on-chain, with enough weight to meet its threshold on its own. A
 *     wrong, stale, or under-weighted key fails at bootstrap, loudly.
 *  2. Only well-formed, distinct PUBLIC keys are ever put into an authority. This
 *     module cannot check that they open anything — it never sees a private key, by
 *     design (see `account-creator.ts`). The browser that derived them owns that
 *     check, and does it twice: once at derivation, once against the chain after the
 *     account exists.
 *
 * CUSTODY NOTE FOR THE OPERATOR. Hive sets a newly created account's
 * `recovery_account` to its creator, so the configured creator account becomes the
 * recovery agent for every account Lumen mints. That is standard for account-creation
 * services and is what lets a user who loses their keys recover at all — but it is a
 * real, ongoing responsibility attached to this account, not a detail.
 */

interface Signer {
  wallet: IBeekeeperUnlockedWallet;
  publicKey: string;
  account: string;
}

/**
 * WHY THESE ARE RUNTIME IMPORTS, NOT TOP-LEVEL ONES — do not "tidy" them back.
 * The full reasoning lives in `publisher/hive-broadcaster.ts`; the short version is
 * that beekeeper's WASM build loads itself with `createRequire`, and the obvious fix
 * (`experimental.serverComponentsExternalPackages`) makes EVERY PAGE IN THE APP
 * return 500. `next.config.js` carries a DO-NOT-ADD comment saying the same thing.
 * `webpackIgnore` keeps the opt-out scoped to this one module.
 */
type WaxModule = typeof import('@hiveio/wax');
type BeekeeperFactory = (typeof import('@hiveio/beekeeper'))['default'];
type BeekeeperSignersModule = typeof import('@hiveio/wax-signers-beekeeper');

let waxPromise: Promise<WaxModule> | null = null;

function loadWax(): Promise<WaxModule> {
  if (!waxPromise) waxPromise = import(/* webpackIgnore: true */ '@hiveio/wax');
  return waxPromise;
}

/** Amount 0 in HIVE — claiming with a zero fee is what makes the claim RC-backed. */
const ZERO_HIVE = { amount: '0', precision: 3, nai: '@@000000021' };

/**
 * Claims must be spaced, and not for a rate limit — for a correctness reason.
 *
 * Two `claim_account` operations from the same creator are BYTE-IDENTICAL: same
 * operation, same TaPoS reference block, and an expiration stamped only to the
 * second. They therefore hash to the same transaction id, and Hive rejects the
 * second as a duplicate transaction. Verified 2026-07-28 by building two back to
 * back offline and comparing `tx.id` — they matched exactly. A loop that topped the
 * pool up "quickly" would have landed one token and silently failed the rest.
 *
 * One block interval is enough to move both the reference block and the expiration
 * second, which makes each claim a distinct transaction.
 *
 * Process-local, exactly like the publisher's `pace.ts`. Two processes claiming at
 * once can still collide; the loser sees a duplicate-transaction rejection, and both
 * of its callers (the ops route and the in-line top-up) treat that as a retriable
 * failure rather than a lost token.
 */
const CLAIM_INTERVAL_MS = 3500;
let lastClaimAt = 0;

async function paceClaim(): Promise<void> {
  const wait = lastClaimAt + CLAIM_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  // Stamped on the ATTEMPT, not the success: a rejected broadcast still consumed
  // that transaction shape, so the next attempt must still be spaced from it.
  lastClaimAt = Date.now();
}

const ROLES = ['owner', 'active', 'posting', 'memo'] as const;

/**
 * Are these the same public key, ignoring the network prefix?
 *
 * A Hive public key is printed as a 3-letter network prefix plus a base58check body:
 * `STM…` on mainnet, `TST…` on testnets. The prefix is presentation only — it is not
 * part of the key and is stripped during serialisation — but the two sides of this
 * comparison come from different places: beekeeper renders the imported key with its
 * own prefix, while the authority comes back rendered with the NODE's prefix. On any
 * non-mainnet chain a plain string compare can therefore fail on two identical keys,
 * refusing to boot against a perfectly good account.
 *
 * Comparing bodies is no weaker: the body is the full key plus its checksum, so two
 * different keys can never share one.
 */
function sameKey(a: string, b: string): boolean {
  const body = (key: string) => (/^[A-Z]{3}[1-9A-HJ-NP-Za-km-z]+$/.test(key) ? key.slice(3) : key);
  return body(a) === body(b);
}

/* ────────────────────────── chain + signer bootstrap ────────────────────────── */

let chainPromise: Promise<IHiveChainInterface> | null = null;

/**
 * The chain handle alone, with no key material involved. Kept separate from the
 * signer so the read paths (`accountExists`, `pendingActCount`) never depend on a
 * private key being loadable — they are also the paths the upgrade service uses to
 * decide whether keys may be discarded.
 */
function getChain(): Promise<IHiveChainInterface> {
  if (!chainPromise) {
    chainPromise = loadWax()
      .then(({ createHiveChain }) => createHiveChain({ apiEndpoint: siteConfig.endpoint }))
      .catch((error) => {
        chainPromise = null; // a node outage must not poison the module for its lifetime
        throw error;
      });
  }
  return chainPromise;
}

let signerPromise: Promise<Signer> | null = null;

async function initSigner(): Promise<Signer> {
  const account = liteConfig.accountCreatorAccount;
  const wif = liteConfig.accountCreatorActiveWif;

  if (!account) {
    throw new Error(
      `LITE_ACCOUNT_CREATOR_ACCOUNT_${liteConfig.chainEnv.toUpperCase()} is not configured — no account-creator account`
    );
  }
  if (!wif) throw new Error('LITE_ACCOUNT_CREATOR_ACTIVE_WIF is not set');

  const chain = await getChain();
  const createBeekeeper = (
    (await import(/* webpackIgnore: true */ '@hiveio/beekeeper')) as { default: BeekeeperFactory }
  ).default;

  // inMemory: the WIF is never persisted to the beekeeper storage root.
  const beekeeper = await createBeekeeper({ inMemory: true });
  const session = beekeeper.createSession('lumen-account-creator');
  const { wallet } = await session.createWallet('lumen-account-creator', undefined, true);

  let publicKey: string;
  try {
    publicKey = await wallet.importKey(wif);
  } catch (error) {
    // beekeeper echoes the offending key back in its error text, and pino has no
    // redaction — `scrubSensitiveData` is wired into Sentry only. So a malformed WIF
    // would otherwise write itself, in full, into the application log. Scrub here, at
    // the one place a raw key can appear in an exception.
    throw new Error(
      `Could not import the configured active key — it is not a valid WIF (${scrubSensitiveData(
        error instanceof Error ? error.message : String(error)
      )})`
    );
  }

  // Safety 1: prove this key really is an ACTIVE key of the configured account, and
  // that it can satisfy the authority on its own. A multisig active authority is a
  // perfectly valid thing for an operator to set up — it just means this signer
  // cannot work alone, and saying so at boot beats discovering it when a user is
  // mid-upgrade.
  const accounts = await chain.api.database_api.find_accounts({ accounts: [account] });
  const found = accounts.accounts?.[0];
  if (!found) {
    throw new Error(`Account-creator account @${account} does not exist on ${liteConfig.chainEnv}`);
  }
  const keyAuths = found.active?.key_auths ?? [];
  const entry = keyAuths.find((auth) => sameKey(String(auth[0]), publicKey));
  if (!entry) {
    throw new Error(
      `Configured key (${publicKey}) is not in @${account}'s ACTIVE authority — refusing to create accounts`
    );
  }
  const weight = Number(entry[1] ?? 0);
  const threshold = Number(found.active?.weight_threshold ?? 1);
  if (weight < threshold) {
    throw new Error(
      `Configured key (${publicKey}) has active weight ${weight} but @${account} requires ${threshold} — ` +
        'this key cannot sign alone. Point at a single-signature account or inject a multisig-aware creator.'
    );
  }

  if (account === liteConfig.frontendAccount) {
    // Not fatal — but it defeats the whole point of the split. Say it every boot.
    logger.warn(
      'Lite account creator is using the SAME account as the publisher (@%s): this server now holds both its posting AND its active key. A dedicated, balance-free creator account is the intended setup.',
      account
    );
  }

  logger.info('Lite account creator ready: @%s active key %s', account, publicKey);
  return { wallet, publicKey, account };
}

function getSigner(): Promise<Signer> {
  if (!signerPromise) {
    signerPromise = initSigner().catch((error) => {
      signerPromise = null; // let a later attempt retry after the config is fixed
      throw error;
    });
  }
  return signerPromise;
}

/** Sign with the creator's ACTIVE authority and broadcast. Returns the transaction id. */
async function signAndBroadcast(
  pushOp: (tx: Awaited<ReturnType<IHiveChainInterface['createTransaction']>>) => void,
  onBroadcast?: () => void
) {
  const signer = await getSigner();
  const chain = await getChain();

  const tx = await chain.createTransaction();
  pushOp(tx);

  const { BeekeeperProvider } = (await import(
    /* webpackIgnore: true */ '@hiveio/wax-signers-beekeeper'
  )) as BeekeeperSignersModule;
  const provider = await BeekeeperProvider.for(chain, signer.wallet, signer.account, 'active');
  await provider.signTransaction(tx);
  // The LAST line before the transaction leaves this process. Everything above —
  // building it (an API round trip for TaPoS), loading the signer module, signing —
  // can fail with nothing sent, and the caller uses this signal to decide whether it
  // may safely release the name and retry. Announcing it any earlier turns a routine
  // node blip into a 300-second name hold and a forced wait for the user.
  onBroadcast?.();
  await chain.broadcast(tx);

  return { trxId: tx.id };
}

/* ────────────────────────── the keys we are handed ────────────────────────── */

/** A single-key authority at weight 1 — the shape every fresh account gets. */
function singleKeyAuthority(publicKey: string) {
  return { weight_threshold: 1, account_auths: {}, key_auths: { [publicKey]: 1 } };
}

/**
 * A Hive public key as printed: a 3-letter network prefix and a base58check body.
 * Deliberately permissive about WHICH prefix — the browser derives with the chain's
 * own prefix (`TST…` on a testnet), and rejecting anything but `STM` here would make
 * every non-mainnet upgrade impossible.
 */
const PUBLIC_KEY_PATTERN = /^[A-Z]{3}[1-9A-HJ-NP-Za-km-z]{45,55}$/;

/**
 * Refuse to broadcast anything but four well-formed, distinct public keys.
 *
 * This is a smaller guarantee than the one this module used to make, and that is the
 * point: it no longer receives a master password, so it cannot verify that the keys
 * open anything. That check moved to where the secret lives — the browser derives all
 * four for the exact name it submits, and verifies the owner key against the chain
 * once the account exists.
 *
 * What is still worth refusing here is a request that would create a permanently
 * broken account: a malformed key the node might accept into an authority, or the
 * same key in several roles (which would quietly make the posting key — the one that
 * lives in browsers and third-party apps — able to move funds).
 */
function validatePublicKeys(accountName: string, keys: AccountPublicKeys): void {
  for (const role of ROLES) {
    const key = keys?.[role];
    if (typeof key !== 'string' || !PUBLIC_KEY_PATTERN.test(key)) {
      throw new Error(`Refusing to create @${accountName}: the ${role} public key is missing or malformed.`);
    }
  }
  const distinct = new Set(ROLES.map((role) => sameKeyBody(keys[role])));
  if (distinct.size !== ROLES.length) {
    throw new Error(
      `Refusing to create @${accountName}: the four keys must be distinct — reusing one across roles would ` +
        'give a lesser key the authority of a greater one.'
    );
  }
}

/** The prefix-independent body of a public key (see sameKey). */
function sameKeyBody(key: string): string {
  return /^[A-Z]{3}[1-9A-HJ-NP-Za-km-z]+$/.test(key) ? key.slice(3) : key;
}

/**
 * Block until the creator actually holds a token, or give up with a message that
 * names the real cause.
 *
 * Bounded at roughly four Hive blocks. Longer than that and the claim did not fail
 * slowly — it failed, and the honest answer is that the creator account cannot claim,
 * which for a balance-free account almost always means it has no delegated Hive Power
 * (or delegated RC) to pay with.
 */
const ACT_POLL_INTERVAL_MS = 1500;
const ACT_POLL_ATTEMPTS = 8;

async function waitForActPool(): Promise<void> {
  for (let attempt = 0; attempt < ACT_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, ACT_POLL_INTERVAL_MS));
    if ((await hiveAccountCreator.pendingActCount()) >= 1) return;
  }
  throw new Error(
    `@${liteConfig.accountCreatorAccount} claimed an account creation token but it has not appeared after ` +
      `${(ACT_POLL_INTERVAL_MS * ACT_POLL_ATTEMPTS) / 1000}s — the claim did not take effect. ` +
      'A balance-free creator account needs delegated Hive Power (or delegated RC) to claim with a zero fee.'
  );
}

/* ──────────────────────────────── the creator ───────────────────────────────── */

export const hiveAccountCreator: AccountCreator = {
  /**
   * Does this name exist on Hive?
   *
   * FAILS LOUD, NEVER CLOSED. `database_api.find_accounts` answers "absent" with an
   * empty array rather than an error, so there is no missing-account exception to
   * swallow here — and swallowing a TRANSPORT error into `false` would be
   * catastrophic. `upgrade-service.resumeOutstandingReveal` reads a `false` from this
   * method as proof that a pending creation never landed and DISCARDS the stored
   * ciphertext, which is the user's only copy of their keys. A node hiccup answered
   * with `false` would therefore destroy the keys to an account that exists. Every
   * error propagates; the caller already treats a throw as "keep the keys".
   */
  async accountExists(name: string): Promise<boolean> {
    const chain = await getChain();
    const res = await chain.api.database_api.find_accounts({ accounts: [name] });
    return (res.accounts ?? []).some((account) => account.name === name);
  },

  /**
   * The account's OWNER public key, or null when the account does not exist.
   *
   * Exists so an ambiguous creation can be settled by asking "is that account ours?"
   * rather than "is that name used?". After a timed-out broadcast the name may have
   * been taken by somebody else entirely, and existence alone would then be read as
   * success — handing our user a master password that opens nothing.
   *
   * Fails loud like `accountExists`, for the same reason: the caller treats a throw
   * as "keep the keys", and a swallowed transport error here would decide someone's
   * account custody on a network hiccup.
   */
  async accountOwnerKeys(name: string): Promise<string[] | null> {
    const chain = await getChain();
    const res = await chain.api.database_api.find_accounts({ accounts: [name] });
    const found = (res.accounts ?? []).find((account) => account.name === name);
    if (!found) return null;
    // ALL of them, not just the first. `key_auths` is stored sorted by key, so an
    // account that later adds a second owner key can push ours off index 0 — and
    // reading only index 0 would then answer "this is not our account", which is a
    // DESTRUCTIVE verdict: it fails the attempt, frees the name, and lets a second
    // account be created while the first is orphaned.
    return (found.owner?.key_auths ?? []).map((auth) => String(auth[0]));
  },

  /** Account Creation Tokens currently held by the creator account. */
  async pendingActCount(): Promise<number> {
    const chain = await getChain();
    const account = liteConfig.accountCreatorAccount;
    if (!account) throw new Error('No account-creator account configured');

    const res = await chain.api.database_api.find_accounts({ accounts: [account] });
    const found = res.accounts?.[0];
    if (!found) throw new Error(`Account-creator account @${account} does not exist on ${liteConfig.chainEnv}`);
    // wax types this as `number | string` because the node returns it either way.
    return Number(found.pending_claimed_accounts ?? 0);
  },

  /**
   * Claim one ACT with `fee: 0.000 HIVE`, which tells Hive to charge Resource Credits
   * instead of taking the 3.000 HIVE account creation fee. That is what lets the
   * creator account hold no balance at all: it needs delegated HP (or delegated RC)
   * for capacity, and nothing spendable. Claiming is RC-expensive by design — this is
   * the operation the ACT pool exists to run ahead of demand rather than in-line.
   */
  async claimAct(): Promise<{ trxId: string }> {
    const signer = await getSigner();
    await paceClaim(); // see CLAIM_INTERVAL_MS — back-to-back claims are the same transaction
    return signAndBroadcast((tx) => {
      tx.pushOperation({
        claim_account_operation: { creator: signer.account, fee: ZERO_HIVE, extensions: [] }
      });
    });
  },

  /**
   * Broadcast `create_claimed_account`, signed with the creator's ACTIVE authority.
   * Irreversible: once this returns, the account exists and only the private keys held
   * by the user's browser will ever open it — this process never had them.
   *
   * Everything that can be checked offline is checked BEFORE the ACT pre-flight, so a
   * malformed request costs nothing — no token spent, no transaction attempted.
   */
  async createClaimedAccount(
    newName: string,
    keys: AccountPublicKeys,
    onBroadcast?: () => void
  ): Promise<{ trxId: string }> {
    // Offline and free: a malformed or duplicated key must cost no token.
    validatePublicKeys(newName, keys);

    const signer = await getSigner();

    // Pre-flight the token pool. `create_claimed_account` fails with a bare chain
    // assertion when the creator holds none, which reads as an opaque broadcast
    // failure; claiming one here turns the common "the pool ran dry" case into a
    // short delay instead of a failed upgrade. Same account, same authority, no
    // extra blast radius — a claim only converts RC into a token. Two upgrades racing
    // here may claim one each; the surplus simply stays in the pool for the next user.
    if ((await hiveAccountCreator.pendingActCount()) < 1) {
      logger.warn('ACT pool is empty at upgrade time — claiming one inline for @%s', newName);
      await hiveAccountCreator.claimAct();
      // A successful broadcast is NOT an applied state change. `claimAct` returns as
      // soon as the node accepts the transaction into its mempool, and
      // `pending_claimed_accounts` does not move until the block containing it is
      // produced and the node we read from has applied it. Checking immediately would
      // therefore report "still no token" on a claim that worked perfectly, fail the
      // upgrade, and look like flakiness. Wait for the token to actually exist.
      await waitForActPool();
    }

    return signAndBroadcast((tx) => {
      tx.pushOperation({
        create_claimed_account_operation: {
          creator: signer.account,
          new_account_name: newName,
          owner: singleKeyAuthority(keys.owner),
          active: singleKeyAuthority(keys.active),
          posting: singleKeyAuthority(keys.posting),
          memo_key: keys.memo,
          json_metadata: '',
          extensions: []
        }
      });
    }, onBroadcast);
  }
};

/**
 * Wire the account creator in DEVELOPMENT only. Returns false (and stays dark) when
 * no WIF is configured — production must call `setAccountCreator` with a KMS-backed
 * implementation from its own bootstrap.
 *
 * ★ MAINNET GUARD. Same shape as `installDevBroadcaster()`, and for a sharper reason.
 * That guard exists because an automated run broadcast a real comment to Hive mainnet
 * believing an endpoint was read-only (2026-07-28). A comment can at least be deleted.
 * An account creation cannot: it permanently consumes a token, permanently occupies a
 * name, and makes the creator account the new account's recovery agent forever.
 * Arming this against mainnet therefore has to be said out loud:
 * `LITE_ACCOUNT_CREATOR_ALLOW_MAINNET=yes`.
 *
 * Note that `siteConfig.chainEnv` defaults to MAINNET when `CHAIN_ID` is unset, so an
 * unconfigured dev box lands on the refusing side of this check, not the permissive one.
 */
export function installDevAccountCreator(): boolean {
  if (!liteConfig.accountCreatorActiveWif) return false;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'LITE_ACCOUNT_CREATOR_ACTIVE_WIF must not be used in production — inject a KMS-backed creator via setAccountCreator'
    );
  }
  const endpoint = siteConfig.endpoint ?? '';
  const looksLikeMainnet =
    liteConfig.chainEnv === 'mainnet' || /api\.hive\.blog|api\.openhive\.network|hived\.emre\.sh/i.test(endpoint);
  if (looksLikeMainnet && process.env.LITE_ACCOUNT_CREATOR_ALLOW_MAINNET !== 'yes') {
    throw new Error(
      `Refusing to arm the dev account creator against MAINNET (${endpoint || liteConfig.chainEnv}): ` +
        'creating an account there is irreversible and spends a real token. Point the app at a testnet, ' +
        'or set LITE_ACCOUNT_CREATOR_ALLOW_MAINNET=yes to state the intent explicitly.'
    );
  }
  setAccountCreator(hiveAccountCreator);
  return true;
}

/**
 * Best-effort lazy wiring for request paths, mirroring how the drain route installs
 * the publisher. Deliberately does NOT throw or short-circuit its caller:
 *
 *  - `upgradeToFullAccount` checks the creator only AFTER it has checked whether the
 *    user is suspended, so that a suspended user is told the real reason instead of a
 *    misleading "not configured yet". A hard 503 here would undo that ordering.
 *  - The status path must keep working even with no creator at all: reporting where an
 *    account stands is more useful than a blanket failure because a node is down.
 */
export function ensureAccountCreator(): void {
  if (hasAccountCreator()) return;
  try {
    installDevAccountCreator();
  } catch (error) {
    logger.error(error, 'Lite account creator: refusing to install the dev creator');
  }
}

/** Test/ops hook: drop the memoised chain and signer so config changes take effect. */
export function resetAccountCreatorSigner(): void {
  chainPromise = null;
  signerPromise = null;
}
