import type { User } from '@smart-signer/types/common';
import { siteConfig } from '@ui/config/site';
import { configuredSiteDomain } from '@ui/config/public-vars';
import { quoteLinkLine, type QuoteTarget } from '@transaction/lib/quote-link';
import { DELETED_BODY } from '@transaction/lib/deleted-body';
import { getLogger } from '@ui/lib/logging';
import { QUOTE_MAX_CHARS } from '@/blog/lib/quote-reblog/quote-flow';
import { liteConfig } from '../config';
import { containerFamilyOf } from '../container-family';
import { hiveAllowsDelete } from '../hive-delete-rule';
import * as containers from '../repositories/container-repository';
import * as quotes from '../repositories/quote-repository';
import { isBlocked } from '../repositories/block-repository';
import { checkAndConsume } from '../repositories/rate-limit-repository';
import { resolvePostOwnerActor } from '../social/post-owner';
import { actorKey, type FollowActor } from '../social/follow-actor';
import { execOn, withTransaction } from '../db/pool';
import * as posts from '../repositories/post-repository';
import { findUserById } from '../repositories/user-repository';
import { reblog, unreblog } from '../repositories/engagement-repository';
import * as rateLimit from '../antispam/rate-limit';
import { checkLiteActor } from '../auth/account-status';
import { reserveContainerParent } from '../publisher/container';
import { buildPermlink } from '../publisher/permlink';
import { litePostIdOf } from '../render/lite-post-id';
import { createLitePost, createQuotePostRows, deleteLitePost } from './post-service';
import { preScreen } from './pre-screen';
import type { SessionRef } from '../types';

const logger = getLogger('app');

/**
 * Quote reblogs for HIVE users (spec v2 7.2): the server never signs for them. It
 * checks the rules and hands out where the comment goes (`prepareHiveQuote`), the user
 * signs the reblog and the comment in one transaction, then the server verifies the
 * comment ON CHAIN before indexing it (`confirmHiveQuote`). Every rule is re-checked at
 * confirm time, so a comment crafted with another tool is never indexed unless it passes
 * the same rules. Lite users go through the publisher instead (step 5).
 */

/** New quotes per person per day. Generous; it exists to stop a script, not a person. */
const QUOTES_PER_DAY = 100;

export type QuoteRefusal =
  | 'disabled'
  | 'empty'
  | 'account_restricted'
  | 'rejected'
  | 'not_found'
  | 'not_a_post'
  | 'is_a_quote'
  | 'blocked'
  | 'rate_limited'
  | 'no_container'
  | 'too_long'
  | 'not_on_chain'
  | 'wrong_author'
  | 'wrong_parent'
  | 'wrong_target'
  | 'still_on_chain';

export type QuoteResult<T> = { ok: true; value: T } | { ok: false; reason: QuoteRefusal };

interface ChainComment {
  author: string;
  permlink: string;
  title: string;
  category: string;
  parent_author: string;
  parent_permlink: string;
  depth: number;
  body: string;
  json_metadata: string;
  children: number;
  net_rshares: number | string;
  cashout_time: string;
}

const HIVE_READ_TIMEOUT_MS = 8000;

/** One comment as the node sees it now (node state, not an indexer). Null when absent. */
async function readChainComment(author: string, permlink: string): Promise<ChainComment | null> {
  const res = await fetch(siteConfig.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_content', params: [author, permlink], id: 1 }),
    signal: AbortSignal.timeout(HIVE_READ_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`get_content failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    result?: ChainComment;
    error?: { data?: { extension?: { assertion_expression?: string } } };
  };
  if (data.error) {
    // Current nodes answer a missing comment with this exact assertion, not an empty
    // result (the publisher's `postExists` reads it the same way). Anything else is a
    // real failure and must not be read as "absent".
    if (data.error.data?.extension?.assertion_expression === `Post ${author}/${permlink} does not exist`) return null;
    throw new Error(`get_content error: ${JSON.stringify(data.error).slice(0, 200)}`);
  }
  const post = data.result;
  // get_content answers an empty shell (author '') for a comment that does not exist.
  return post && post.author ? post : null;
}

function parseMeta(raw: unknown): Record<string, unknown> {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Can this be quoted at all? A top-level Hive post, or a Lumen post (a depth-1 child
 * of a `lumen-c-` container). Never a comment (decision D5) and never a quote
 * (decision 8: no quoting a quote).
 */
function quotable(target: ChainComment): QuoteRefusal | null {
  const family = containerFamilyOf(target.parent_permlink);
  if (target.depth === 1 && family === 'quote') return 'is_a_quote';
  if (target.depth === 0) return null;
  if (target.depth === 1 && family === 'lite') return null;
  return 'not_a_post';
}

type QuoteMarker = { format: 'markdown'; type: 'lumen_quote'; quote_of: { author: string; permlink: string }; tags: string[] };

/** The json_metadata every quote comment carries (the client adds `app`). */
function quoteMarker(targetAuthor: string, targetPermlink: string): QuoteMarker {
  return { format: 'markdown', type: 'lumen_quote', quote_of: { author: targetAuthor, permlink: targetPermlink }, tags: ['lumen'] };
}

/** Removed on chain: a real delete leaves nothing; a blank leaves DELETED_BODY and/or `deleted`. */
function isBlanked(comment: ChainComment): boolean {
  const body = comment.body.trim();
  return body === '' || body === DELETED_BODY || parseMeta(comment.json_metadata).deleted === true;
}

/** Their comment at the deterministic permlink is under one of OUR quote containers. */
function underQuoteContainer(comment: ChainComment): boolean {
  return comment.parent_author === liteConfig.frontendAccount && containerFamilyOf(comment.parent_permlink) === 'quote';
}

export interface HiveQuotePlan {
  /**
   * Where the comment goes. A new comment: the newest published quote container. When
   * their comment is already on chain (a live quote, a blanked one, or a broadcast whose
   * outcome was unknown): its OWN parent, because a comment's parent can never change.
   */
  parentAuthor: string;
  parentPermlink: string;
  /** Deterministic from the target: one quote per person per post. */
  permlink: string;
  jsonMetadata: QuoteMarker;
  /** Their comment is already on chain: sign an EDIT (no reward options; Hive fixed them). */
  edit: boolean;
  /** Their current quote on this post, when they already have one (the popup edits it). */
  existing: { state: quotes.QuoteState; body: string } | null;
}

/**
 * Step 1 for a Hive user: check the rules, say where the comment goes. Writes nothing
 * except the daily rate counter.
 *
 * `quoter` is the identity Lumen keys social edges on (`sessionActor`): a Lumen id for an
 * upgraded account, the Hive name otherwise, so an upgrade never splits their quotes from
 * their follows and blocks. `hiveName` is the account that signs on chain.
 */
export async function prepareHiveQuote(
  quoter: FollowActor,
  hiveName: string,
  targetAuthor: string,
  targetPermlink: string
): Promise<QuoteResult<HiveQuotePlan>> {
  if (!liteConfig.quoteReblogsEnabled) return { ok: false, reason: 'disabled' };
  const permlink = quotes.quotePermlinkFor(targetAuthor, targetPermlink);
  const [target, own] = await Promise.all([
    readChainComment(targetAuthor, targetPermlink),
    readChainComment(hiveName.toLowerCase(), permlink)
  ]);
  if (!target) return { ok: false, reason: 'not_found' };
  const refusal = quotable(target);
  if (refusal) return { ok: false, reason: refusal };
  // Something else of theirs already uses this permlink (not a quote): it cannot be one.
  if (own && !underQuoteContainer(own)) return { ok: false, reason: 'wrong_parent' };

  // Decision D7: the post's owner (the lite writer for a Lumen post) has blocked them.
  const owner = await resolvePostOwnerActor(targetAuthor, targetPermlink);
  if (owner && (await isBlocked(owner, quoter))) return { ok: false, reason: 'blocked' };

  const existing = await quotes.findActive(quoter, targetAuthor, targetPermlink);
  if (!existing) {
    const day = new Date().toISOString().slice(0, 10);
    if (!(await checkAndConsume(actorKey(quoter), 'quote', QUOTES_PER_DAY, day))) {
      return { ok: false, reason: 'rate_limited' };
    }
  }

  let parent: { author: string; permlink: string };
  if (own) {
    parent = { author: own.parent_author, permlink: own.parent_permlink };
  } else {
    const container = await containers.latestPublished(liteConfig.frontendAccount, 'quote');
    if (!container) return { ok: false, reason: 'no_container' };
    parent = { author: container.hiveAuthor, permlink: container.hivePermlink };
  }

  return {
    ok: true,
    value: {
      parentAuthor: parent.author,
      parentPermlink: parent.permlink,
      permlink,
      jsonMetadata: quoteMarker(targetAuthor, targetPermlink),
      edit: !!own,
      existing: existing ? { state: existing.state, body: existing.bodyCache } : null
    }
  };
}

export interface HiveQuoteRemovalPlan {
  permlink: string;
  parentAuthor: string;
  parentPermlink: string;
  /** The marker, so a blanked comment still says what it was (the client adds `deleted`). */
  jsonMetadata: QuoteMarker;
  /** Hive would accept `delete_comment` now; otherwise the comment is blanked. */
  mode: 'delete' | 'blank';
}

/**
 * What removing their quote on this post takes, from the node's state now. Null when
 * there is nothing of theirs on chain to remove (never broadcast, already deleted or
 * already blanked). Deliberately NOT gated on the switch, the target or blocks: a person
 * can always take their own words down.
 */
export async function planHiveQuoteRemoval(
  hiveName: string,
  targetAuthor: string,
  targetPermlink: string
): Promise<HiveQuoteRemovalPlan | null> {
  const permlink = quotes.quotePermlinkFor(targetAuthor, targetPermlink);
  const own = await readChainComment(hiveName.toLowerCase(), permlink);
  if (!own || !underQuoteContainer(own) || isBlanked(own)) return null;
  return {
    permlink,
    parentAuthor: own.parent_author,
    parentPermlink: own.parent_permlink,
    jsonMetadata: quoteMarker(targetAuthor, targetPermlink),
    mode: hiveAllowsDelete(own) ? 'delete' : 'blank'
  };
}

/**
 * The caption without the link line Lumen appends on chain ("Reblogged from ..."),
 * for the card cache. The chain body stays the source of truth.
 */
export function captionOf(body: string): string {
  const cut = body.search(/\n\s*\n(?:Reblogged from |Reblogged by |\[Reblogged)/);
  return (cut >= 0 ? body.slice(0, cut) : body).trim().slice(0, QUOTE_MAX_CHARS);
}

/**
 * Step 3 for a Hive user: after they broadcast, verify the comment on chain and index
 * it. Everything checked at prepare time is checked again against what is actually on
 * chain now: its author is the viewer, its parent is one of OUR quote containers, its
 * marker names this target, the target is still quotable and the owner has not blocked
 * them. Idempotent: confirming twice returns the same row.
 */
export async function confirmHiveQuote(
  quoter: FollowActor,
  hiveName: string,
  targetAuthor: string,
  targetPermlink: string
): Promise<QuoteResult<quotes.LumenQuote>> {
  if (!liteConfig.quoteReblogsEnabled) return { ok: false, reason: 'disabled' };
  const author = hiveName.toLowerCase();
  const permlink = quotes.quotePermlinkFor(targetAuthor, targetPermlink);
  const comment = await readChainComment(author, permlink);
  if (!comment) return { ok: false, reason: 'not_on_chain' };
  if (comment.author !== author) return { ok: false, reason: 'wrong_author' };
  if (!underQuoteContainer(comment)) return { ok: false, reason: 'wrong_parent' };
  // A blanked comment is a removed quote, never a live one.
  if (isBlanked(comment)) return { ok: false, reason: 'not_on_chain' };
  const meta = parseMeta(comment.json_metadata);
  const of = meta.quote_of as { author?: unknown; permlink?: unknown } | undefined;
  if (meta.type !== 'lumen_quote' || of?.author !== targetAuthor || of?.permlink !== targetPermlink) {
    return { ok: false, reason: 'wrong_target' };
  }
  const target = await readChainComment(targetAuthor, targetPermlink);
  if (!target) return { ok: false, reason: 'not_found' };
  const refusal = quotable(target);
  if (refusal) return { ok: false, reason: refusal };
  const owner = await resolvePostOwnerActor(targetAuthor, targetPermlink);
  if (owner && (await isBlocked(owner, quoter))) return { ok: false, reason: 'blocked' };

  const caption = captionOf(comment.body);
  // A re-quote after a blank edits the SAME comment, already counted toward its container
  // the first time; only a comment new to that container is counted.
  const before = await quotes.findByCoords(author, permlink);
  const seenBefore = before !== null && before.containerPermlink === comment.parent_permlink;
  const { quote, created } = await quotes.insertQuote({
    quoter,
    targetAuthor,
    targetPermlink,
    quoteAuthor: author,
    quotePermlink: permlink,
    containerAuthor: comment.parent_author,
    containerPermlink: comment.parent_permlink,
    bodyCache: caption,
    state: 'live'
  });
  if (created && !seenBefore) {
    await containers.incrementChildCount(comment.parent_author, comment.parent_permlink);
  } else if (quote.state === 'live' && quote.bodyCache !== caption) {
    // An edit: the chain text changed, refresh the card cache.
    await quotes.setState(quote.quoteId, 'live', caption);
  }
  logger.info({ quoter: author, target: `${targetAuthor}/${targetPermlink}`, created }, 'quote confirmed');
  return { ok: true, value: (await quotes.findById(quote.quoteId)) ?? quote };
}

/**
 * The quoter removed their comment (deleted, or blanked when Hive would not allow a
 * delete) or undid the reblog. Verified on chain: gone, or its body is empty.
 */
export async function confirmHiveQuoteRemoved(
  quoter: FollowActor,
  targetAuthor: string,
  targetPermlink: string
): Promise<QuoteResult<{ removed: boolean }>> {
  const existing = await quotes.findActive(quoter, targetAuthor, targetPermlink);
  if (!existing) return { ok: true, value: { removed: false } };
  const comment = await readChainComment(existing.quoteAuthor, existing.quotePermlink);
  if (comment && !isBlanked(comment)) return { ok: false, reason: 'still_on_chain' };
  await quotes.setState(existing.quoteId, 'removed', '');
  return { ok: true, value: { removed: true } };
}

// ── Lite users (spec v2 8): Lumen publishes the quote for them ─────────────────

/**
 * What the link line under the caption points at. A Lumen post is named by its
 * writer's handle (never `@`: a handle is not a Hive account) and linked at its Lumen
 * address; a Hive post by `@author`.
 */
async function linkTargetFor(target: ChainComment): Promise<QuoteTarget> {
  const origin = configuredSiteDomain.replace(/\/+$/, '');
  const litePostId =
    target.author === liteConfig.frontendAccount ? litePostIdOf({ permlink: target.permlink }) : undefined;
  const row = litePostId ? await posts.getPostById(litePostId) : null;
  const writer = row ? await findUserById(row.userId) : null;
  const shown = writer?.displayName ?? target.author;
  return {
    author: target.author,
    permlink: target.permlink,
    title: target.title,
    url: `${origin}/${target.category || 'hive'}/@${shown}/${target.permlink}`,
    lite: writer ? { handle: writer.displayName } : null
  };
}

/** Thrown inside the transaction to roll it back when a quote already exists (A15). */
class AlreadyQuoted extends Error {
  constructor(readonly quote: quotes.LumenQuote) {
    super('already quoted');
  }
}

/**
 * A LITE user's quote on a post: create it, or edit their existing one. Lumen publishes
 * it through the publisher under a quote container (8.1), so it shows at once as
 * `pending` and turns `live` when it reaches Hive. The post row, its pinned parent, its
 * publish job, the quote index row and the reblog are written in ONE database
 * transaction: all of it lands or none does, and a double submit gets the first one.
 */
export async function saveLiteQuote(
  sessionUser: User | undefined,
  session: SessionRef,
  targetAuthor: string,
  targetPermlink: string,
  rawCaption: string
): Promise<QuoteResult<quotes.LumenQuote>> {
  if (!liteConfig.quoteReblogsEnabled) return { ok: false, reason: 'disabled' };
  const actor = await checkLiteActor(sessionUser, session);
  if (!actor.ok) return { ok: false, reason: 'account_restricted' };
  const { userId, displayName } = actor.user;
  const caption = rawCaption.trim();
  if (!caption) return { ok: false, reason: 'empty' };
  if (caption.length > QUOTE_MAX_CHARS) return { ok: false, reason: 'too_long' };

  const target = await readChainComment(targetAuthor, targetPermlink);
  if (!target) return { ok: false, reason: 'not_found' };
  const refusal = quotable(target);
  if (refusal) return { ok: false, reason: refusal };
  const quoter = { userId };
  const owner = await resolvePostOwnerActor(targetAuthor, targetPermlink);
  if (owner && (await isBlocked(owner, quoter))) return { ok: false, reason: 'blocked' };
  const screen = preScreen({ title: '', body: caption });
  if (screen.action === 'reject') return { ok: false, reason: 'rejected' };
  const body = `${caption}\n\n${quoteLinkLine(await linkTargetFor(target))}`;

  const existing = await quotes.findActive(quoter, targetAuthor, targetPermlink);
  if (existing) {
    // Their quote from before an upgrade to a Hive account is theirs to edit with their keys.
    if (!existing.litePostId) return { ok: false, reason: 'wrong_author' };
    const edited = await createLitePost(
      sessionUser,
      { tier: 'normal', body, editOfPostId: existing.litePostId, quoteEdit: true },
      session
    );
    if (edited.status === 'error') {
      return { ok: false, reason: edited.code === 'edit_rate_limited' ? 'rate_limited' : 'rejected' };
    }
    return { ok: true, value: (await quotes.setState(existing.quoteId, existing.state, caption)) ?? existing };
  }

  // A quote counts against the daily comment allowance (8.1).
  const rate = await rateLimit.enforcePostRate(userId, 'comment');
  if (!rate.ok) return { ok: false, reason: 'rate_limited' };
  const parent = await reserveContainerParent('quote');
  try {
    const quote = await withTransaction(async (client) => {
      const exec = execOn(client);
      const post = await createQuotePostRows(
        exec,
        { userId, displayName, body, target: { author: targetAuthor, permlink: targetPermlink }, feedVisibility: screen.feedVisibility },
        parent
      );
      const { quote: row, created } = await quotes.insertQuote(
        {
          quoter,
          targetAuthor,
          targetPermlink,
          quoteAuthor: liteConfig.frontendAccount,
          quotePermlink: buildPermlink(post.postId),
          containerAuthor: parent.author,
          containerPermlink: parent.permlink,
          litePostId: post.postId,
          bodyCache: caption,
          state: 'pending'
        },
        exec
      );
      if (!created) throw new AlreadyQuoted(row);
      // A quote is a reblog with a comment: the reblog comes with it.
      await reblog(userId, targetAuthor, targetPermlink, exec);
      return row;
    });
    logger.info({ userId, target: `${targetAuthor}/${targetPermlink}` }, 'lite quote queued');
    return { ok: true, value: quote };
  } catch (error) {
    if (error instanceof AlreadyQuoted) return { ok: true, value: error.quote };
    throw error;
  }
}

/**
 * A lite user removes their quote on a post (its post is deleted: cancelled if still
 * queued, deleted or blanked on Hive otherwise), and undoes the reblog too when asked.
 * Like every withdrawal, not gated on the switch, the target, blocks or suspension.
 */
export async function removeLiteQuote(
  userId: string,
  targetAuthor: string,
  targetPermlink: string,
  undoReblog: boolean
): Promise<{ removed: boolean }> {
  const existing = await quotes.findActive({ userId }, targetAuthor, targetPermlink);
  let removed = false;
  if (existing?.litePostId) {
    removed = (await deleteLitePost(userId, existing.litePostId)).status === 'ok';
  }
  if (undoReblog) await unreblog(userId, targetAuthor, targetPermlink);
  return { removed };
}

