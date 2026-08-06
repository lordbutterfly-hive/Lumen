import type { IBeekeeperUnlockedWallet } from '@hiveio/beekeeper';
import type { IHiveChainInterface } from '@hiveio/wax';
import { getLogger } from '@ui/lib/logging';
import { siteConfig } from '@ui/config/site';
import { liteConfig } from '../config';
import { CommentOp, PostBroadcaster, setBroadcaster } from './broadcaster';

const logger = getLogger('app');

/**
 * The real `PostBroadcaster` (spec §D.2): signs the comment op with the publisher
 * account's POSTING key and broadcasts it to Hive.
 *
 * The key is held in an IN-MEMORY beekeeper wallet — it is imported once at
 * bootstrap and never written to disk, never logged, and never leaves this module.
 * The WIF comes from `LITE_PUBLISHER_POSTING_WIF`. In production that path
 * requires the operator to opt in explicitly with
 * `LITE_PUBLISHER_ALLOW_WIF_IN_PROD=yes` (see `installWifBroadcaster` for why
 * refusing outright was worse than the risk it avoided); a KMS-backed
 * implementation injected via `setBroadcaster` remains the destination.
 *
 * Two safety properties this module enforces before it will ever broadcast:
 *  1. The imported key's public key MUST be listed in the configured account's
 *     POSTING authority on-chain. A wrong/stale key fails at bootstrap, loudly,
 *     instead of producing a stream of rejected transactions.
 *  2. Every op's `author` MUST equal the configured publisher account. A job whose
 *     payload names a different author is rejected, not signed.
 */

interface Signer {
  chain: IHiveChainInterface;
  wallet: IBeekeeperUnlockedWallet;
  publicKey: string;
  account: string;
}

/**
 * WHY THESE ARE RUNTIME IMPORTS, NOT TOP-LEVEL ONES — do not "tidy" them back.
 *
 * beekeeper's WASM build loads itself with `createRequire`, which breaks when
 * webpack bundles it ("createRequire is not a function"). The obvious fix,
 * `experimental.serverComponentsExternalPackages: ['@hiveio/beekeeper','@hiveio/wax']`,
 * DOES fix the publisher — and simultaneously makes EVERY PAGE IN THE APP return
 * 500 ("Element type is invalid… got: undefined"), because externalising those
 * packages changes the module shape the SSR'd smart-signer/wax component chain
 * receives. Verified 2026-07-27 on clean builds: with either package listed, `/`
 * and `/login` 500; with the list removed, both render.
 *
 * `webpackIgnore` keeps the opt-out scoped to this one module: webpack leaves the
 * import alone and Node resolves it at runtime, so the publisher gets an unbundled
 * beekeeper while the rest of the app keeps its normal bundling.
 *
 * Deploy note: `output: 'standalone'` traces static imports only, so these three
 * packages must be present in the deployed node_modules (add them to
 * `experimental.outputFileTracingIncludes` for the drain route if tracing prunes
 * them).
 */
type WaxModule = typeof import('@hiveio/wax');
type BeekeeperFactory = typeof import('@hiveio/beekeeper')['default'];
type BeekeeperSignersModule = typeof import('@hiveio/wax-signers-beekeeper');

let waxPromise: Promise<WaxModule> | null = null;

function loadWax(): Promise<WaxModule> {
  if (!waxPromise) waxPromise = import(/* webpackIgnore: true */ '@hiveio/wax');
  return waxPromise;
}

let signerPromise: Promise<Signer> | null = null;

async function initSigner(): Promise<Signer> {
  const account = liteConfig.frontendAccount;
  const wif = liteConfig.publisherPostingWif;

  if (!account) throw new Error('LITE_FRONTEND_ACCOUNT_* is not configured — no publisher account');
  if (!wif) throw new Error('LITE_PUBLISHER_POSTING_WIF is not set');

  const { createHiveChain } = await loadWax();
  const createBeekeeper = ((await import(/* webpackIgnore: true */ '@hiveio/beekeeper')) as {
    default: BeekeeperFactory;
  }).default;

  const chain = await createHiveChain({ apiEndpoint: siteConfig.endpoint });

  // inMemory: the WIF is never persisted to the beekeeper storage root.
  const beekeeper = await createBeekeeper({ inMemory: true });
  const session = beekeeper.createSession('lumen-publisher');
  const { wallet } = await session.createWallet('lumen-publisher', undefined, true);
  const publicKey = await wallet.importKey(wif);

  // Safety 1: prove this key really is a POSTING key of the configured account.
  const accounts = await chain.api.database_api.find_accounts({ accounts: [account] });
  const found = accounts.accounts?.[0];
  if (!found) {
    throw new Error(`Publisher account @${account} does not exist on ${liteConfig.chainEnv}`);
  }
  const postingKeys = (found.posting?.key_auths ?? []).map((auth) => String(auth[0]));
  if (!postingKeys.includes(publicKey)) {
    throw new Error(
      `Configured key (${publicKey}) is not in @${account}'s posting authority — refusing to broadcast`
    );
  }

  logger.info('Lite publisher signer ready: @%s posting key %s', account, publicKey);
  return { chain, wallet, publicKey, account };
}

/**
 * The publisher's in-memory signer, for other server-side features that must act as
 * the publishing account. Currently that is image hosting (`media/hive-image-uploader`):
 * Hive's image host authenticates uploads with a posting-key signature, and a lite
 * account has no key, so the publishing account signs on its behalf.
 *
 * Exported rather than duplicated so there is exactly one place a key is imported,
 * one place the key is proved to belong to the configured account, and one wallet in
 * memory.
 */
export function getPublisherSigner(): Promise<Signer> {
  return getSigner();
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

/** Build the wax operation for a job payload. Root posts and replies differ. */
async function buildOperation(op: CommentOp) {
  const { BlogPostOperation, ReplyOperation } = await loadWax();
  const shared = {
    author: op.author,
    permlink: op.permlink,
    body: op.body,
    title: op.title,
    jsonMetadata: JSON.parse(op.jsonMetadata) as object,
    // Lite posts decline ALL rewards (decision 2026-07-23). Setting this makes
    // wax emit the accompanying comment_options operation.
    ...(op.declinePayout ? { maxAcceptedPayout: { amount: '0', precision: 3, nai: '@@000000013' } } : {})
  };

  return op.parentAuthor
    ? new ReplyOperation({ ...shared, parentAuthor: op.parentAuthor, parentPermlink: op.parentPermlink })
    : new BlogPostOperation({ ...shared, category: op.parentPermlink });
}

export const hiveBroadcaster: PostBroadcaster = {
  async broadcastComment(op: CommentOp): Promise<{ trxId: string }> {
    const signer = await getSigner();

    // Safety 2: never sign an op that claims a different author.
    if (op.author !== signer.account) {
      throw new Error(
        `Refusing to broadcast: op author @${op.author} != publisher account @${signer.account}`
      );
    }

    const tx = await signer.chain.createTransaction();
    tx.pushOperation(await buildOperation(op));

    const { BeekeeperProvider } = (await import(
      /* webpackIgnore: true */ '@hiveio/wax-signers-beekeeper'
    )) as BeekeeperSignersModule;
    const provider = await BeekeeperProvider.for(signer.chain, signer.wallet, signer.account, 'posting');
    await provider.signTransaction(tx);
    await signer.chain.broadcast(tx);

    return { trxId: tx.id };
  },

  /**
   * Hard-delete the comment. Hive refuses if it has replies, net-positive votes, or
   * already paid out (hive_evaluator_social.cpp:60,66,68-69) — the caller falls back
   * to blanking the content in that case.
   */
  async deleteComment(author: string, permlink: string): Promise<{ trxId: string }> {
    const signer = await getSigner();
    if (author !== signer.account) {
      throw new Error(`Refusing to delete: @${author} != publisher account @${signer.account}`);
    }
    // wax ships no DeleteCommentOperation helper class (it has BlogPost, Reply,
    // Comment, Reblog, Follow… but nothing for delete), so push the raw protocol
    // operation. Shape from wax's own `delete_comment` proto interface.
    const tx = await signer.chain.createTransaction();
    tx.pushOperation({ delete_comment_operation: { author, permlink } });

    const { BeekeeperProvider } = (await import(
      /* webpackIgnore: true */ '@hiveio/wax-signers-beekeeper'
    )) as BeekeeperSignersModule;
    const provider = await BeekeeperProvider.for(signer.chain, signer.wallet, signer.account, 'posting');
    await provider.signTransaction(tx);
    await signer.chain.broadcast(tx);
    return { trxId: tx.id };
  },

  /**
   * Whether Hive would currently allow a hard delete: no replies, no net-positive
   * vote weight, not yet cashed out. Read from the node rather than guessed, and
   * fail CLOSED (false -> soft delete) on any doubt: a soft delete always works,
   * a refused hard delete burns retries.
   */
  async canDelete(author: string, permlink: string): Promise<boolean> {
    try {
      const res = await fetch(siteConfig.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'condenser_api.get_content',
          params: [author, permlink],
          id: 1
        })
      });
      if (!res.ok) return false;
      const data = (await res.json()) as {
        result?: { children?: number; net_rshares?: number | string; cashout_time?: string };
      };
      const post = data.result;
      if (!post) return false;
      const netRshares = Number(post.net_rshares ?? 0);
      const cashedOut = post.cashout_time === '1969-12-31T23:59:59';
      return (post.children ?? 0) === 0 && netRshares <= 0 && !cashedOut;
    } catch {
      return false;
    }
  },

  async postExists(author: string, permlink: string): Promise<boolean> {
    // A missing post is the NORMAL case here (the guard runs before publishing),
    // but the node signals it with an assert_exception rather than an empty
    // result. Treat that one specific assertion as "absent" and let every other
    // error propagate — a node outage must stay retriable, never be read as
    // "not published", which would cause a double-post.
    const res = await fetch(siteConfig.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'condenser_api.get_content',
        params: [author, permlink],
        id: 1
      })
    });
    if (!res.ok) throw new Error(`get_content failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      result?: { author?: string; permlink?: string };
      error?: { data?: { extension?: { assertion_expression?: string } } };
    };

    if (data.error) {
      const assertion = data.error.data?.extension?.assertion_expression ?? '';
      if (assertion === `Post ${author}/${permlink} does not exist`) return false;
      throw new Error(`get_content error: ${JSON.stringify(data.error).slice(0, 300)}`);
    }
    return data.result?.author === author && data.result?.permlink === permlink;
  }
};

/**
 * Wire the WIF-backed publisher. Returns false (and stays dark) when no WIF is
 * configured. Production requires an explicit opt-in — see below.
 *
 * ★★★ RENAMED FROM `installDevBroadcaster` + PRODUCTION OPT-IN ADDED 2026-08-06.
 *
 * This used to throw unconditionally under `NODE_ENV=production`, telling the
 * operator to "inject a KMS-backed broadcaster via setBroadcaster". **Nothing in
 * this repository ever calls `setBroadcaster` with a production implementation.**
 * So a normal production build had NO broadcaster at all: posts accumulated in
 * Postgres, the author saw their post in Lumen, and nothing anywhere reported a
 * problem — which `docker/lumen-publisher.yml` itself calls "the single most
 * silent failure mode in the lite-accounts feature". The guard was written to
 * stop an accident and instead guaranteed a silent outage on every real deploy.
 *
 * A KMS-backed signer is still the right end state and is NOT what this is. This
 * is the honest interim: the WIF path may run in production if the operator says
 * so out loud with `LITE_PUBLISHER_ALLOW_WIF_IN_PROD=yes`, and it screams in the
 * log every time it arms so nobody forgets it is there.
 *
 * Why this is an acceptable trade for a soft launch, stated plainly rather than
 * assumed: the key is a POSTING key, not active and not owner. Its worst case is
 * that someone who reads the environment can post, comment and vote as the
 * publisher account — bad, recoverable, and revocable on Hive with a single
 * `account_update` that rotates the posting authority. It cannot move funds,
 * cannot change keys, and cannot touch any other account.
 *
 * The two guards are INDEPENDENT and both must be passed to publish to mainnet
 * from a production process. They answer different questions — "may this process
 * hold a raw key at all?" and "may it write to the permanent public ledger?" —
 * and collapsing them into one flag is how one careless export becomes both.
 *
 * ★ MAINNET GUARD, added 2026-07-28 after a real incident: an automated audit hit
 * `POST /api/lite/publisher/drain` believing it was a read-only wiring check, and
 * because a dev box can be pointed at `api.hive.blog`, it broadcast a genuine comment
 * to Hive mainnet with a plaintext key. "Development mode" said nothing about WHICH
 * CHAIN the key was for, and that was the whole hole.
 *
 * Publishing to mainnet from a dev process now requires saying so out loud:
 * `LITE_PUBLISHER_ALLOW_MAINNET=yes`. Anything else refuses, loudly, before a key is
 * ever loaded. Wanting to test the publisher is not the same as wanting to write to a
 * public permanent ledger.
 */
export function installWifBroadcaster(): boolean {
  if (!liteConfig.publisherPostingWif) return false;
  if (process.env.NODE_ENV === 'production') {
    if (process.env.LITE_PUBLISHER_ALLOW_WIF_IN_PROD !== 'yes') {
      throw new Error(
        'Refusing to arm the WIF publisher in production. Nothing in this repo injects a ' +
          'KMS-backed broadcaster, so leaving this unset means posts queue in Postgres ' +
          'FOREVER and no error is ever reported — set LITE_PUBLISHER_ALLOW_WIF_IN_PROD=yes ' +
          'to run on the raw posting key (revocable on Hive with one account_update), or ' +
          'inject a real signer via setBroadcaster.'
      );
    }
    logger.warn(
      'lite publisher: ARMED IN PRODUCTION WITH A RAW POSTING WIF ' +
        '(LITE_PUBLISHER_ALLOW_WIF_IN_PROD=yes). This is the interim path, not the ' +
        'destination — replace it with a KMS-backed broadcaster via setBroadcaster, and ' +
        'rotate the publisher posting authority if this key is ever exposed.'
    );
  }
  const endpoint = siteConfig.endpoint ?? '';
  const looksLikeMainnet =
    liteConfig.chainEnv === 'mainnet' || /api\.hive\.blog|api\.openhive\.network|hived\.emre\.sh/i.test(endpoint);
  if (looksLikeMainnet && process.env.LITE_PUBLISHER_ALLOW_MAINNET !== 'yes') {
    throw new Error(
      `Refusing to arm the publisher against MAINNET (${endpoint || liteConfig.chainEnv}): a broadcast here is public and permanent. ` +
        'Point the app at a testnet, or set LITE_PUBLISHER_ALLOW_MAINNET=yes to state the intent explicitly.'
    );
  }
  setBroadcaster(hiveBroadcaster);
  return true;
}
