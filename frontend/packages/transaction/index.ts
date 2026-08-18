// ★ RUNTIME-VS-TYPE SPLIT (2026-08-12) — this file is the reason an anonymous
// visitor who never signs anything downloaded @hiveio/wax's ~2.3 MB WASM chain
// module on every page. `@hiveio/wax` ships exactly ONE entry point
// (wasm/dist/bundle/web.js) that bundles that WASM module — there is no lighter
// "just the operation-builder classes" import path, so ANY plain, non-`type`
// import from '@hiveio/wax' anywhere in this file's static graph drags the whole
// thing along. Every name below that this file only ever uses as a TYPE is
// imported with the per-specifier `type` modifier, which TypeScript erases at
// compile time — it never reaches the emitted JS, so it can never do that.
//
// The names this file constructs at runtime (BlogPostOperation,
// CommunityOperation, EFollowBlogAction, FollowOperation, ReplyOperation,
// ResourceCreditsOperation) — plus the two names used BOTH as a type and as a
// value (AccountAuthorityUpdateOperation, EAvailableCommunityRoles) — are loaded
// on demand by `loadWax()` below, the only path left from this module into wax's
// WASM-backed runtime. `transactionService` (the singleton this file exports) is
// reachable from the root layout on every page load via `SignerProvider`
// (packages/smart-signer/components/signer-provider.tsx) — that reachability
// itself is fine and stays; what changes is that walking the static import graph
// no longer walks into wax's runtime bundle to get there.
import {
  type ApiAccount,
  type IArticle,
  type IReplyData,
  type ITransaction,
  type NaiAsset,
  type asset as IAsset,
  type authority,
  type future_extensions,
  type EAvailableCommunityRoles,
  type AccountAuthorityUpdateOperation,
  type ESupportedLanguages,
  type IHiveChainInterface,
  type GetDynamicGlobalPropertiesResponse
} from '@hiveio/wax';
// Type-only: `SignerOptions`/`SignTransaction` are interfaces, never touched as
// values here. Not just tidiness — `signer.ts` is the base class every one of the
// 7 signer backends extends, so a VALUE import here would give this file a second,
// independent static path into that whole subtree (`signTransaction()` below
// already covers the real one, via a dynamic `import('@smart-signer/lib/signer/
// get-signer')` on first actual signing call).
import type { SignerOptions, SignTransaction } from '@smart-signer/lib/signer/signer';
// Type-only for the same reason: `@hive/common-hiveio-packages/wax` re-exports
// `hive-chain-service.ts`, which statically imports `createHiveChain` from
// '@hiveio/wax' as a VALUE. `Beneficiarie`/`Preferences` are only ever used here
// as parameter types, so eliding this import removes that path too.
import type { Beneficiarie, Preferences } from '@hive/common-hiveio-packages/wax';
// Type-only: `IWorkerBee` is only ever the type of `this.bot`. The WorkerBee
// CLASS (the thing that actually needs the chain) is loaded on demand inside
// broadcastAndObserveTransaction(), the only method that ever constructs one.
import type { IWorkerBee } from '@hiveio/workerbee';
import { getLogger } from '@hive/ui/lib/logging';

const logger = getLogger('app');

/**
 * Lazily imports the pieces of `@hiveio/wax` this service constructs at
 * runtime — the operation-builder classes, plus the two names touched as a
 * VALUE (`EAvailableCommunityRoles.ADMIN`, `AccountAuthorityUpdateOperation
 * .createFor`). Every other name imported from '@hiveio/wax' above is
 * `type`-only and erased at compile time; this is deliberately the ONLY
 * reachable runtime path from this module into wax's WASM-backed bundle.
 *
 * Cached like `getModal()` in
 * apps/blog/features/lite-auth/wallet/appkit.ts: never cache a REJECTED
 * promise, or one transient chunk-load error would poison every later
 * attempt (e.g. every subsequent vote or follow click) for the rest of the
 * page session.
 */
let waxRuntimePromise: Promise<typeof import('@hiveio/wax')> | null = null;
const loadWax = (): Promise<typeof import('@hiveio/wax')> => {
  if (!waxRuntimePromise) {
    waxRuntimePromise = import('@hiveio/wax').catch((error) => {
      waxRuntimePromise = null;
      throw error;
    });
  }
  return waxRuntimePromise;
};

export type TransactionErrorCallback = (error: any) => any;

export type TransactionBroadcastCallback = (txBuilder: ITransaction) => Promise<TransactionBroadcastResult>;

export interface TransactionOptions {
  observe?: boolean;
  singleSignKeyType?: SignTransaction['singleSignKeyType'];
  requiredKeyType?: SignTransaction['requiredKeyType'];
}

export interface TransactionBroadcastResult {
  transactionId: string;
}

export interface Authorizes {
  weight_threshold: number;
  account_auths: { [key: string]: number };
  key_auths: { [key: string]: number };
}

/**
 * The `images` wax wants for a post: real URLs only, or `undefined`.
 *
 * Returning `[]` would also make wax skip the key (it tests `length > 0`), but
 * `undefined` says "there is no image" at the type level too, so a future reader
 * of this call site cannot mistake an empty array for an intentional one. Blank
 * and whitespace-only entries are dropped rather than trusted — `[""]` on chain
 * is precisely the bug this exists to prevent.
 */
function normalizeImages(image?: string | string[]): string[] | undefined {
  const list = (Array.isArray(image) ? image : [image]).filter(
    (url): url is string => typeof url === 'string' && url.trim() !== ''
  );
  return list.length > 0 ? list : undefined;
}

export class TransactionService {
  /**
   * Options for Signer.
   *
   * @type {SignerOptions}
   * @memberof TransactionService
   */
  signerOptions!: SignerOptions;

  /**
   * The number of transactions observed.
   *
   * @memberof TransactionService
   */
  observedTransactionsCounter = 0;

  // WorkerBee instance for scanning Hive blockchain blocks.

  /**
   * Instance of WorkerBee Block Scanner.
   *
   * @type {(IWorkerBee | undefined)}
   * @memberof TransactionService
   */
  bot!: IWorkerBee | undefined;

  setSignerOptions(signerOptions: SignerOptions) {
    this.signerOptions = signerOptions;
  }

  /**
   * F-L12 — drop the signing identity when the session no longer has one.
   *
   * This service is a module singleton (`transactionService` below), so it
   * outlives any component. <SignerProvider> only ever SET these options: it
   * skips the call when `username === ''` (logout) and returns early for a
   * lite account, so both transitions left the PREVIOUS user's options in
   * place for the rest of the SPA session. Every operation this class builds
   * takes its actor from `this.signerOptions.username` (`voter`, `authorize`,
   * `reblog`, `followBlog`, community ops), so a stale value means ops built
   * in a logged-out session still name the account that logged out — at best
   * an unexplainable rejection, at worst a wallet prompt naming a stranger.
   *
   * Cleared to a BLANK identity rather than undefined so the many
   * `this.signerOptions.username` readers keep their type and fail loudly at
   * signing instead of throwing three frames deep. The creator-tokens and
   * prediction-market broadcasters already refuse on `!signerOptions.username`
   * with a named error — this makes that branch reachable, which is what they
   * were written to expect.
   */
  clearSignerOptions() {
    this.signerOptions = {
      username: '',
      loginType: this.signerOptions?.loginType,
      keyType: this.signerOptions?.keyType,
      storageType: this.signerOptions?.storageType
    } as SignerOptions;
  }

  /**
   * Create transaction and add operation to it (by running callback
   * `cb`), sign transaction, broadcast transaction and observe if
   * transaction has been applied in blockchain (if caller wants this).
   * The method runs `TransactionService.broadcastTransaction` and this
   * method does not observe if transaction has been applied in
   * blockchain – resolves just after sending transaction to API server.
   * When you want to observe transaction and resolve after applying it
   * in blockchain, pass `options.observe` set to true. Then method
   * `TransactionService.broadcastAndObserveTransaction` will be run and
   * this resolves after applying transaction in blockchain.
   *
   * @param {(opBuilder: ITransaction) => void} cb
   * @param {TransactionOptions} [transactionOptions={}]
   * @return {*}  {Promise<TransactionBroadcastResult>}
   * @memberof TransactionService
   */
  async processHiveAppOperation(
    cb: (opBuilder: ITransaction) => void,
    transactionOptions: TransactionOptions = {}
  ): Promise<TransactionBroadcastResult> {
    const defaultTransactionOptions = {
      observe: false,
      singleSignKeyType: undefined,
      transactionOptions: undefined
    };

    const { observe, singleSignKeyType, requiredKeyType } = {
      ...defaultTransactionOptions,
      ...transactionOptions
    };

    const txBuilder = await (await this.getChain()).createTransaction();

    // Create transaction from operation
    cb(txBuilder);

    // Validate transaction
    txBuilder.validate();

    const signature = await this.signTransaction(txBuilder, singleSignKeyType, requiredKeyType);

    // Add signature to transaction
    txBuilder.addSignature(signature);

    if (observe) {
      return await this.broadcastAndObserveTransaction(txBuilder);
    } else {
      return await this.broadcastTransaction(txBuilder);
    }
  }

  /**
   * Sign transaction using smart-signer.
   *
   * `getSigner` (and, transitively, all 7 signer backends it registers — see
   * get-signer.ts) is loaded here, on first actual signing call, rather than
   * imported statically. Same reasoning as `loadWax()` above: this class is
   * a module singleton reachable from every page via SignerProvider, so a
   * static import here would have been just as much of a leak as the wax
   * operation-builder classes.
   *
   * @param {ITransaction} txBuilder
   * @return {*}  {Promise<string>}
   * @memberof TransactionService
   */
  /**
   * @param chain - the chain `txBuilder` was built on. Omit it (as every caller
   *   but creator-tokens does) and the signer uses the app's global chain, which
   *   is what it has always done. Pass it when the transaction belongs to a
   *   DIFFERENT Hive L1 than the global one: the wallet-backed signers rebuild
   *   the transaction to hand their provider an object, and rebuilding on the
   *   wrong chain re-stamps it with the wrong chain id, producing a signature
   *   that L1 must reject. See `SignTransaction.chain`.
   */
  async signTransaction(
    txBuilder: ITransaction,
    singleSignKeyType?: SignTransaction['singleSignKeyType'],
    requiredKeyType?: SignTransaction['requiredKeyType'],
    chain?: SignTransaction['chain'],
    /** The node `chain` belongs to — see SignTransaction.rpcEndpoint. */
    rpcEndpoint?: SignTransaction['rpcEndpoint'],
    /** Chain id of `rpcEndpoint` — see SignTransaction.rpcChainId. */
    rpcChainId?: SignTransaction['rpcChainId']
  ): Promise<string> {
    const { getSigner } = await import('@smart-signer/lib/signer/get-signer');
    const signer = getSigner(this.signerOptions);
    return signer.signTransaction({
      digest: txBuilder.sigDigest,
      transaction: txBuilder.transaction,
      singleSignKeyType,
      requiredKeyType,
      chain,
      rpcEndpoint,
      rpcChainId
    });
  }

  /**
   * Broadcasts transaction. Resolves after sending request to API
   * server. Does not wait for applying transaction in blockchain.
   *
   * @param {ITransaction} txBuilder
   * @return {*}  {Promise<TransactionBroadcastResult>}
   * @memberof TransactionService
   */
  async broadcastTransaction(txBuilder: ITransaction): Promise<TransactionBroadcastResult> {
    // Do broadcast
    const transactionId = txBuilder.id;
    logger.info('Broadcasting transaction id: %o, body: %o', transactionId, txBuilder.toApi());
    await (
      await this.getChain()
    ).api.network_broadcast_api.broadcast_transaction({ max_block_age: -1, trx: txBuilder.toApiJson() });
    return { transactionId };
  }

  /**
   * `./lib/chain` is loaded here rather than statically imported at module
   * scope. It is the ONLY chokepoint every other method in this class goes
   * through to reach the chain (directly, or via `this.getChain()` below),
   * so keeping the import lazy here is enough to keep it out of this file's
   * static graph entirely — no other method needs its own dynamic import.
   */
  async getChain(): Promise<IHiveChainInterface> {
    const { getChain } = await import('./lib/chain');
    return await getChain();
  }

  async getDynamicGlobalProperties(): Promise<GetDynamicGlobalPropertiesResponse> {
    return (await this.getChain()).api.database_api.get_dynamic_global_properties({});
  }

  /**
   * Create and start bot (block scanner) if needed, broadcast
   * transaction, wait until bot reports applying transaction into Hive
   * blockchain, stop and destroy bot if needed, then resolve. When bot
   * doesn't find the transaction, it will throw after transaction
   * expiration time plus `throwAfter`.
   *
   * @param {ITransaction} txBuilder
   * @param {number} [throwAfter=60 * 1000]
   * @return {*}  {Promise<TransactionBroadcastResult>}
   * @memberof TransactionService
   */
  async broadcastAndObserveTransaction(
    txBuilder: ITransaction,
    throwAfter = 60 * 1000
  ): Promise<TransactionBroadcastResult> {
    try {
      // Create bot
      if (!this.bot) {
        logger.info('Creating bot');
        const hiveChain = await this.getChain();
        // WorkerBee is loaded here rather than imported statically for the same
        // reason as loadWax() above — it is only ever needed once an observed
        // broadcast is actually requested, never merely because this singleton
        // was constructed.
        const { default: WorkerBee } = await import('@hiveio/workerbee');
        this.bot = new WorkerBee(hiveChain);
      }
      // Start bot
      if (this.observedTransactionsCounter++ === 0) {
        logger.info('Starting bot');
        this.bot.start();
      }

      // Do broadcast
      const transactionId = txBuilder.id;
      logger.info('Broadcasting transaction id: %o, body: %o', transactionId, txBuilder.toApi());

      // Broadcast and wait for block inclusion (irreversible with OBI)
      await this.bot.broadcast(txBuilder, { verifySignatures: true, expireInMs: 10_000 });

      return { transactionId };
    } catch (error) {
      logger.error('Got error, logging and rethrowing it: %o', error);
      throw error;
    } finally {
      if (--this.observedTransactionsCounter === 0) {
        // Stop bot
        if (this.bot) {
          logger.info('Stopping bot');
          this.bot.stop();
        }
        // Destroy bot
        logger.info('Destroying bot');
        this.bot = undefined;
      }
    }
  }

  async upVote(
    author: string,
    permlink: string,
    weight = 10000,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        vote_operation: {
          voter: this.signerOptions.username,
          author,
          permlink,
          weight
        }
      });
    }, transactionOptions);
  }

  async downVote(
    author: string,
    permlink: string,
    weight = -10000,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        vote_operation: {
          voter: this.signerOptions.username,
          author,
          permlink,
          weight
        }
      });
    }, transactionOptions);
  }

  async subscribe(community: string, transactionOptions: TransactionOptions = {}) {
    const { CommunityOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new CommunityOperation().subscribe(community).authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async unsubscribe(community: string, transactionOptions: TransactionOptions = {}) {
    const { CommunityOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new CommunityOperation().unsubscribe(community).authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async flag(
    community: string,
    username: string,
    permlink: string,
    notes: string,
    transactionOptions: TransactionOptions = {}
  ) {
    const { CommunityOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new CommunityOperation()
          .flagPost(community, username, permlink, notes)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async setRole(
    community: string,
    username: string,
    role: EAvailableCommunityRoles,
    transactionOptions: TransactionOptions = {}
  ) {
    const { CommunityOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new CommunityOperation().setRole(community, username, role).authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async pin(
    community: string,
    username: string,
    permlink: string,
    transactionOptions: TransactionOptions = {}
  ) {
    const { CommunityOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new CommunityOperation().pinPost(community, username, permlink).authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }
  async unpin(
    community: string,
    username: string,
    permlink: string,
    transactionOptions: TransactionOptions = {}
  ) {
    const { CommunityOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new CommunityOperation()
          .unpinPost(community, username, permlink)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async mutePost(
    community: string,
    username: string,
    permlink: string,
    notes: string,
    transactionOptions: TransactionOptions = {}
  ) {
    const { CommunityOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new CommunityOperation()
          .mutePost(community, username, permlink, notes)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async unmutePost(
    community: string,
    username: string,
    permlink: string,
    notes: string,
    transactionOptions: TransactionOptions = {}
  ) {
    const { CommunityOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new CommunityOperation()
          .unmutePost(community, username, permlink, notes)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async setUserTitle(
    community: string,
    username: string,
    title: string,
    transactionOptions: TransactionOptions = {}
  ) {
    const { CommunityOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new CommunityOperation()
          .setUserTitle(community, username, title)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async reblog(username: string, permlink: string, transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .reblog(this.signerOptions.username, username, permlink)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async follow(username: string, transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .followBlog(this.signerOptions.username, username)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async unfollow(username: string, transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .unfollowBlog(this.signerOptions.username, username)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async mute(otherBlogs: string, blog = '', transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .muteBlog(this.signerOptions.username, blog, ...otherBlogs.split(', '))
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async unmute(blog: string, transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .unmuteBlog(this.signerOptions.username, blog)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async resetBlogList(transactionOptions: TransactionOptions = {}) {
    const { FollowOperation, EFollowBlogAction } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .resetBlogList(EFollowBlogAction.MUTE_BLOG, this.signerOptions.username, 'all')
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async blacklistBlog(otherBlogs: string, blog = '', transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .blacklistBlog(this.signerOptions.username, blog, ...otherBlogs.split(', '))
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async unblacklistBlog(blog: string, transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .unblacklistBlog(this.signerOptions.username, blog)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async followBlacklistBlog(otherBlogs: string, blog = '', transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .followBlacklistBlog(this.signerOptions.username, blog, ...otherBlogs.split(', '))
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async unfollowBlacklistBlog(blog: string, transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .unfollowBlacklistBlog(this.signerOptions.username, blog)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async followMutedBlog(otherBlogs: string, blog = '', transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .followMutedBlog(this.signerOptions.username, blog, ...otherBlogs.split(', '))
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async resetAllBlog(transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .resetAllBlog(this.signerOptions.username, 'all')
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async resetBlacklistBlog(transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .resetBlacklistBlog(this.signerOptions.username, 'all')
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async resetFollowBlacklistBlog(transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .resetFollowBlacklistBlog(this.signerOptions.username, 'all')
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async resetFollowMutedBlog(transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .resetFollowMutedBlog(this.signerOptions.username, 'all')
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async unfollowMutedBlog(blog: string, transactionOptions: TransactionOptions = {}) {
    const { FollowOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new FollowOperation()
          .unfollowMutedBlog(this.signerOptions.username, blog)
          .authorize(this.signerOptions.username)
      );
    }, transactionOptions);
  }

  async comment(
    parentAuthor: string,
    parentPermlink: string,
    body: string,
    preferences: Preferences,
    transactionOptions: TransactionOptions = {}
  ) {
    const { ReplyOperation } = await loadWax();
    const replyOperationData: IReplyData = {
      parentAuthor,
      parentPermlink,
      author: this.signerOptions.username,
      body,
      permlink: `re-${parentAuthor.replaceAll('.', '-')}-${Date.now()}`
    };

    if (preferences.comment_rewards === '100%') {
      replyOperationData.percentHbd = 0;
    }
    if (preferences.comment_rewards === '50%' || preferences.comment_rewards === '0%') {
      replyOperationData.percentHbd = 10000;
    }
    if (preferences.comment_rewards === '0%') {
      // ./lib/utils re-imports the chain itself (createAsset needs chain.ASSETS
      // for NAI/precision), so it is loaded here too rather than statically —
      // same reasoning as getChain() above.
      const { createAsset } = await import('./lib/utils');
      replyOperationData.maxAcceptedPayout = await createAsset('0', 'HBD');
    }

    const reply = new ReplyOperation(replyOperationData);

    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(reply);
    }, transactionOptions);
  }

  async updateComment(
    parentAuthor: string,
    parentPermlink: string,
    permlink: string,
    body: string,
    transactionOptions: TransactionOptions = {}
  ) {
    const { ReplyOperation } = await loadWax();
    const reply = new ReplyOperation({
      parentAuthor,
      parentPermlink,
      author: this.signerOptions.username,
      body,
      jsonMetadata: {},
      permlink
    });

    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(reply);
    }, transactionOptions);
  }

  /**
   * ★★★ EMPTY IS NOT A VALUE — OMIT IT (2026-08-14, composer audit findings 9 and
   * §9.6).
   *
   * This used to hand wax `images: [image ? image : '']`, `alternativeAuthor: ''`
   * and `jsonMetadata: { summary: '' }` whenever the caller had nothing to put in
   * them, and wax faithfully wrote all three onto the chain. Measured on the live
   * :4100 build by capturing the transaction at the Keychain boundary (never
   * broadcast), a plain note published:
   *
   *   json_metadata = {"format":"markdown+html","summary":"","app":"lumen/1.0",
   *                    "tags":["lumen"],"image":[""],"author":""}
   *
   * `image: [""]` is the damaging one: it is a NON-EMPTY array, so every thumbnail
   * reader downstream reads element 0 and gets an empty `src`. `author: ""` and
   * `summary: ""` are merely noise, but they are noise permanently written to a
   * public blockchain.
   *
   * wax only skips a field it is given as `undefined`, or an array it is given
   * EMPTY (`CommentOperation`'s constructor: `void 0 !== data.images &&
   * data.images.length > 0`) — so the fix is to pass nothing rather than to pass
   * emptiness. `jsonMetadata` is `Object.assign`ed wholesale by wax, so an empty
   * `summary` has to be dropped by us before it gets there.
   *
   * @param image one URL, or several. Several is what the short-form composer
   *   needs; a single string is what the long-form editor already passed and it
   *   keeps working byte-for-byte.
   * @param extraJsonMetadata extra top-level `json_metadata` keys. The short-form
   *   composer uses it for `type: 'note'`, the marker the permalink page and the
   *   feed card read to choose a compact layout instead of an article one.
   */
  async post(
    permlink: string,
    title: string,
    body: string,
    beneficiaries: Beneficiarie[],
    maxAcceptedPayout: NaiAsset,
    tags: string[],
    category: string,
    summary: string,
    altAuthor: string,
    percentHbd: number,
    image?: string | string[],
    extraJsonMetadata?: Record<string, unknown>,
    transactionOptions: TransactionOptions = {}
  ) {
    const { BlogPostOperation } = await loadWax();
    const images = normalizeImages(image);
    const blogPost = new BlogPostOperation({
      category: category !== 'blog' ? category : tags[0],
      beneficiaries,
      maxAcceptedPayout,
      percentHbd,
      tags,
      author: this.signerOptions.username,
      title,
      body,
      permlink,
      alternativeAuthor: altAuthor ? altAuthor : undefined,
      images,
      jsonMetadata: {
        ...(summary ? { summary } : {}),
        // ★ This fork is Lumen, and every post it broadcasts says so. It read
        // `hive.blog/0.9`, inherited from the upstream denser codebase, so every
        // post published from a Hive-keyed account announced itself on chain as
        // somebody else's frontend. Lite posts already carried the lumen/1.0 tag
        // (lib/lite/publisher/footer.ts, container.ts), so the two tiers disagreed
        // about what app the reader was using. Changed 2026-08-06 at the owner's
        // instruction, kept identical to the lite string so anything grouping by
        // `app` sees one product.
        app: 'lumen/1.0',
        ...(extraJsonMetadata ?? {})
      }
    });
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(blogPost);
    }, transactionOptions);
  }
  async updatePost(
    permlink: string,
    title: string,
    body: string,
    tags: string[],
    category: string,
    summary: string,
    altAuthor: string,
    image?: string | string[],
    extraJsonMetadata?: Record<string, unknown>,
    transactionOptions: TransactionOptions = {}
  ) {
    const { BlogPostOperation } = await loadWax();
    const images = normalizeImages(image);
    const blogPost = new BlogPostOperation({
      category: category !== 'blog' ? category : tags[0],
      tags,
      author: this.signerOptions.username,
      title,
      body,
      permlink,
      alternativeAuthor: altAuthor ? altAuthor : undefined,
      images,
      jsonMetadata: {
        ...(summary ? { summary } : {}),
        // Same string as post() above — an edit must not relabel the post.
        app: 'lumen/1.0',
        ...(extraJsonMetadata ?? {})
      }
    });

    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(blogPost);
    }, transactionOptions);
  }

  /**
   * Update comment/post options (payout settings).
   * Can only make settings MORE restrictive (lower max_accepted_payout, lower percent_hbd).
   * Must be called before payout.
   */
  async updatePostOptions(
    permlink: string,
    maxAcceptedPayout: NaiAsset,
    percentHbd: number,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        comment_options_operation: {
          author: this.signerOptions.username,
          permlink,
          max_accepted_payout: maxAcceptedPayout,
          percent_hbd: percentHbd,
          allow_votes: true,
          allow_curation_rewards: true,
          extensions: []
        }
      });
    }, transactionOptions);
  }

  async updateWalletProfile(
    username: string,
    memo_key: string,
    json_metadata: string,
    owner: Authorizes | undefined,
    active: Authorizes | undefined,
    posting: Authorizes | undefined,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        account_update_operation: {
          account: username,
          memo_key: memo_key,
          json_metadata: json_metadata,
          owner: owner,
          active: active,
          posting: posting
        }
      });
    }, transactionOptions);
  }

  async updateAuthority(
    operations: AccountAuthorityUpdateOperation,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(operations);
    }, transactionOptions);
  }

  async updateProfile(
    profile_image?: string,
    cover_image?: string,
    name?: string,
    about?: string,
    location?: string,
    website?: string,
    witness_owner?: string,
    witness_description?: string,
    blacklist_description?: string,
    muted_list_description?: string,
    version: number = 2, // signal upgrade to posting_json_metadata
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        account_update2_operation: {
          account: this.signerOptions.username,
          extensions: [],
          json_metadata: '',
          posting_json_metadata: JSON.stringify({
            profile: {
              profile_image,
              cover_image,
              name,
              about,
              location,
              website,
              witness_owner,
              witness_description,
              blacklist_description,
              muted_list_description,
              version
            }
          })
        }
      });
    }, transactionOptions);
  }

  async deleteComment(permlink: string, transactionOptions: TransactionOptions = {}) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        delete_comment_operation: {
          author: this.signerOptions.username,
          permlink: permlink
        }
      });
    }, transactionOptions);
  }

  async updateProposalVotes(
    proposal_ids: string[],
    approve: boolean,
    extensions: future_extensions[],
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        update_proposal_votes_operation: {
          voter: this.signerOptions.username,
          proposal_ids,
          approve,
          extensions
        }
      });
    }, transactionOptions);
  }

  async markAllNotificationAsRead(date: string, transactionOptions: TransactionOptions = {}) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        custom_json_operation: {
          id: 'notify',
          json: JSON.stringify(['setLastRead', { date: date }]),
          required_auths: [],
          required_posting_auths: [this.signerOptions.username]
        }
      });
    }, transactionOptions);
  }

  async claimRewards(account: ApiAccount, transactionOptions: TransactionOptions = {}) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        claim_reward_balance_operation: {
          account: this.signerOptions.username,
          reward_hive: account.reward_hive_balance,
          reward_hbd: account.reward_hbd_balance,
          reward_vests: account.reward_vesting_balance
        }
      });
    }, transactionOptions);
  }

  async witnessVote(
    account: string,
    witness: string,
    approve: boolean,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        account_witness_vote_operation: {
          account,
          witness,
          approve
        }
      });
    }, transactionOptions);
  }

  async witnessProxy(proxy: string, transactionOptions: TransactionOptions = {}) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        account_witness_proxy_operation: {
          account: this.signerOptions.username,
          proxy: proxy
        }
      });
    }, transactionOptions);
  }
  async transferToSavings(
    amount: IAsset,
    fromAccount: string,
    memo: string,
    toAccount: string,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        transfer_to_savings_operation: {
          amount,
          from: fromAccount,
          memo,
          to: toAccount
        }
      });
    }, transactionOptions);
  }

  async transferFromSavings(
    amount: IAsset,
    fromAccount: string,
    memo: string,
    toAccount: string,
    requestId: number,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        transfer_from_savings_operation: {
          amount,
          from: fromAccount,
          memo,
          to: toAccount,
          request_id: requestId
        }
      });
    }, transactionOptions);
  }

  async transfer(
    amount: IAsset,
    fromAccount: string,
    memo: string,
    toAccount: string,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        transfer_operation: {
          amount,
          from: fromAccount,
          memo,
          to: toAccount
        }
      });
    }, transactionOptions);
  }

  async transferToVesting(
    amount: IAsset,
    fromAccount: string,
    toAccount: string,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        transfer_to_vesting_operation: {
          amount,
          from: fromAccount,
          to: toAccount
        }
      });
    }, transactionOptions);
  }

  async withdrawFromVesting(account: string, hp: IAsset, transactionOptions: TransactionOptions = {}) {
    const { total_vesting_fund_hive, total_vesting_shares } = await this.getDynamicGlobalProperties();
    const vestingShares = (await this.getChain()).hpToVests(
      hp,
      total_vesting_fund_hive,
      total_vesting_shares
    );

    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        withdraw_vesting_operation: {
          account,
          vesting_shares: vestingShares
        }
      });
    }, transactionOptions);
  }

  async delegateVestingShares(
    delegator: string,
    delegatee: string,
    hp: IAsset,
    transactionOptions: TransactionOptions = {}
  ) {
    const { total_vesting_fund_hive, total_vesting_shares } = await this.getDynamicGlobalProperties();
    const vestingShares = (await this.getChain()).hpToVests(
      hp,
      total_vesting_fund_hive,
      total_vesting_shares
    );
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        delegate_vesting_shares_operation: {
          delegator,
          delegatee,
          vesting_shares: vestingShares
        }
      });
    }, transactionOptions);
  }

  async changeMasterPassword(
    account: string,
    keys: Record<'owner' | 'active' | 'posting', { old: string; new: string }>,
    transactionOptions: TransactionOptions
  ) {
    try {
      const { AccountAuthorityUpdateOperation } = await loadWax();
      const accountAuthorityUpdateOp = await AccountAuthorityUpdateOperation.createFor(
        await this.getChain(),
        account
      );

      if (!keys.owner || !keys.active || !keys.posting) {
        throw new Error('Missing required keys for master password change');
      }

      const { owner, active, posting } = keys;

      if (
        !accountAuthorityUpdateOp.role('owner').has(owner.old) ||
        !accountAuthorityUpdateOp.role('active').has(active.old) ||
        !accountAuthorityUpdateOp.role('posting').has(posting.old)
      ) {
        throw new Error('Wrong master password');
      }

      accountAuthorityUpdateOp.role('owner').replace(owner.old, 1, owner.new);
      accountAuthorityUpdateOp.role('active').replace(active.old, 1, active.new);
      accountAuthorityUpdateOp.role('posting').replace(posting.old, 1, posting.new);

      return await this.processHiveAppOperation(async (builder) => {
        builder.pushOperation(accountAuthorityUpdateOp);
      }, transactionOptions);
    } catch (error) {
      const isKeyError = error instanceof Error && error.message.includes('import key');

      if (isKeyError) {
        throw new Error('One time signing failed, invalid key.');
      }

      throw new Error(`One time signing failed: ${(error as Error)?.message || 'Unknown error'}`);
    }
  }

  async createClaimedAccount(
    creator: string,
    memoKey: string,
    newAccountName: string,
    jsonMetadata: string,
    active?: authority,
    owner?: authority,
    posting?: authority,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        create_claimed_account_operation: {
          creator,
          active,
          owner,
          posting,
          memo_key: memoKey,
          new_account_name: newAccountName,
          json_metadata: jsonMetadata,
          extensions: []
        }
      });
    }, transactionOptions);
  }

  async accountCreate(
    memo_key: string,
    new_account_name: string,
    creator: string,
    json_metadata: string,
    active?: authority,
    owner?: authority,
    posting?: authority,
    transactionOptions: TransactionOptions = {}
  ) {
    const { median_props } = await (
      await this.getChain()
    ).api.database_api.get_witness_schedule({});

    // Transform NAI format to amount string
    const feeAmount = (
      parseInt(median_props.account_creation_fee.amount) /
      Math.pow(10, median_props.account_creation_fee.precision)
    ).toString();
    const { getAsset } = await import('./lib/utils');
    const fee = await getAsset(feeAmount, 'HIVE');
    return (
      await this.processHiveAppOperation((builder) => {
        builder.pushOperation({
          account_create_operation: {
            fee,
            active,
            owner,
            posting,
            creator,
            memo_key,
            new_account_name,
            json_metadata
          }
        });
      }),
      transactionOptions
    );
  }

  async newCommunityUpdate(
    communityTag: string,
    title: string,
    about: string,
    creator: string,
    lang: ESupportedLanguages,
    is_nsfw: boolean,
    flag_text: string,
    description: string,
    transactionOptions: TransactionOptions = {}
  ) {
    const { CommunityOperation, EAvailableCommunityRoles } = await loadWax();
    return await this.processHiveAppOperation(async (builder) => {
      builder.pushOperation(
        new CommunityOperation()
          .updateProps(communityTag, { title, about, is_nsfw, lang, description, flag_text })
          .setRole(communityTag, creator, EAvailableCommunityRoles.ADMIN)
          .authorize(communityTag)
          .subscribe(communityTag)
          .authorize(creator)
      );
    }, transactionOptions);
  }

  async updateCommunityProps(
    communityName: string,
    title: string,
    about: string,
    is_nsfw: boolean,
    lang: ESupportedLanguages,
    flag_text: string,
    description: string,
    admin: string,
    transactionOptions: TransactionOptions = {}
  ) {
    const { CommunityOperation } = await loadWax();
    return await this.processHiveAppOperation(async (builder) => {
      builder.pushOperation(
        new CommunityOperation()
          .updateProps(communityName, { title, about, is_nsfw, lang, flag_text, description })
          .authorize(admin)
      );
    }, transactionOptions);
  }

  async limitOrderCreate(
    amountToSell: IAsset,
    owner: string,
    minToReceive: IAsset,
    orderId: number,
    fillOrKill: boolean,
    expiration: string,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        limit_order_create_operation: {
          amount_to_sell: amountToSell,
          owner,
          min_to_receive: minToReceive,
          fill_or_kill: fillOrKill,
          orderid: orderId,
          expiration
        }
      });
    }, transactionOptions);
  }

  async limitOrderCancel(owner: string, orderId: number, transactionOptions: TransactionOptions = {}) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        limit_order_cancel_operation: {
          owner,
          orderid: orderId
        }
      });
    }, transactionOptions);
  }

  async cancelTransferFromSavings(
    fromAccount: string,
    requestId: number,
    transactionOptions: TransactionOptions = {}
  ) {
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation({
        cancel_transfer_from_savings_operation: {
          from: fromAccount,
          request_id: requestId
        }
      });
    }, transactionOptions);
  }

  async delegateRC(
    fromAccount: string,
    amount: string,
    toAccount: string,
    transactionOptions: TransactionOptions = {}
  ) {
    const { ResourceCreditsOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new ResourceCreditsOperation().delegate(fromAccount, amount, toAccount).authorize(fromAccount)
      );
    }, transactionOptions);
  }
  async undelegateRC(fromAccount: string, toAccount: string, transactionOptions: TransactionOptions = {}) {
    const { ResourceCreditsOperation } = await loadWax();
    return await this.processHiveAppOperation((builder) => {
      builder.pushOperation(
        new ResourceCreditsOperation().removeDelegation(fromAccount, toAccount).authorize(fromAccount)
      );
    }, transactionOptions);
  }
}
export const transactionService = new TransactionService();

// ★ NO MORE BARREL RE-EXPORTS OF VALIDATION HELPERS HERE (2026-08-12).
//
// This file used to end with:
//   export { isHiveAccountNameValid } from './lib/validate-hive-account';
//   export * from './lib/validation';
//
// Both are STATIC (non-`type`) re-exports, so — unlike every name at the top
// of this file, which is careful to stay `type`-only or behind `loadWax()` —
// they pulled `./lib/validate-hive-account` and `./lib/validation/*` into
// THIS module's own static graph. `validate-hive-account.ts` statically
// imports `./chain`, which statically imports `@hiveio/wax` as a VALUE (not
// `type`), and `./lib/validation/existence/{account,community}.ts` import
// `./bridge-api`/`./hive-api`, which do the same. Since `transactionService`
// (this file) is reachable from the root layout on every page via
// `SignerProvider`, these two lines were a second and third runtime path
// into wax's bundle from the one file whose own top-of-file comment claims
// `loadWax()` is the ONLY one — found by an adversarial review that read this
// file to the end.
//
// Fixed at the root rather than by re-auditing the re-export: every browser
// call site that reached these through `@transaction/index` (`checkAccountExists`
// in `features/witnesses/set-proxy-dialog.tsx` and `features/account-lists/
// hooks/use-add-to-list-form.ts`; `isValidAccountNameFormat` in the same
// hook) was ALSO a genuine `getChain()`-reaching browser read on its own
// merits — moved to `/api/account-exists` (see that route). Once none of
// them needed the barrel, removing it was correct, not just convenient.
// Everything that still needs these validators imports them directly from
// `@transaction/lib/validate-hive-account` / `@transaction/lib/validation`
// (already the pattern every SERVER caller used — `app/api/avatar/route.ts`,
// `app/[param]/(user-profile)/layout.tsx`, `lib/lite/auth/auth-service.ts`),
// which never touches this file's graph at all.
