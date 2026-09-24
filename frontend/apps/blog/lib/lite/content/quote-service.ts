import { siteConfig } from '@ui/config/site';
import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '../config';
import { containerFamilyOf } from '../container-family';
import * as containers from '../repositories/container-repository';
import * as quotes from '../repositories/quote-repository';
import { isBlocked } from '../repositories/block-repository';
import { checkAndConsume } from '../repositories/rate-limit-repository';
import { resolvePostOwnerActor } from '../social/post-owner';
import { actorKey, type FollowActor } from '../social/follow-actor';

const logger = getLogger('app');

/**
 * Quote reblogs for HIVE users (spec v2 7.2): the server never signs for them. It
 * checks the rules and hands out where the comment goes (`prepareHiveQuote`), the user
 * signs the reblog and the comment in one transaction, then the server verifies the
 * comment ON CHAIN before indexing it (`confirmHiveQuote`). Every rule is re-checked at
 * confirm time, so a comment crafted with another tool is never indexed unless it passes
 * the same rules. Lite users go through the publisher instead (step 5).
 */

/** Caption length (decision D4). Hive allows far more; this is Lumen's product limit. */
export const QUOTE_MAX_CHARS = 280;
/** New quotes per person per day. Generous; it exists to stop a script, not a person. */
const QUOTES_PER_DAY = 100;

export type QuoteRefusal =
  | 'disabled'
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
  const data = (await res.json()) as { result?: ChainComment; error?: unknown };
  if (data.error) throw new Error(`get_content error: ${JSON.stringify(data.error).slice(0, 200)}`);
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

export interface HiveQuotePlan {
  /** Where the comment goes: the newest published quote container. */
  parentAuthor: string;
  parentPermlink: string;
  /** Deterministic from the target: one quote per person per post. */
  permlink: string;
  /** The json_metadata the comment must carry (the client adds `app`). */
  jsonMetadata: { format: 'markdown'; type: 'lumen_quote'; quote_of: { author: string; permlink: string }; tags: string[] };
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
  const target = await readChainComment(targetAuthor, targetPermlink);
  if (!target) return { ok: false, reason: 'not_found' };
  const refusal = quotable(target);
  if (refusal) return { ok: false, reason: refusal };

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

  const container = await containers.latestPublished(liteConfig.frontendAccount, 'quote');
  if (!container) return { ok: false, reason: 'no_container' };

  return {
    ok: true,
    value: {
      parentAuthor: container.hiveAuthor,
      parentPermlink: container.hivePermlink,
      permlink: quotes.quotePermlinkFor(targetAuthor, targetPermlink),
      jsonMetadata: { format: 'markdown', type: 'lumen_quote', quote_of: { author: targetAuthor, permlink: targetPermlink }, tags: ['lumen'] },
      existing: existing ? { state: existing.state, body: existing.bodyCache } : null
    }
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
  if (comment.parent_author !== liteConfig.frontendAccount || containerFamilyOf(comment.parent_permlink) !== 'quote') {
    return { ok: false, reason: 'wrong_parent' };
  }
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
  if (created) {
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
  const gone = !comment || comment.body.trim() === '' || parseMeta(comment.json_metadata).deleted === true;
  if (!gone) return { ok: false, reason: 'still_on_chain' };
  await quotes.setState(existing.quoteId, 'removed', '');
  return { ok: true, value: { removed: true } };
}
