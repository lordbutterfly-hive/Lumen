/**
 * Quote reblog for a FULL Hive account, the client side (spec v2 section 4): ask the
 * server where the comment goes, sign the reblog and the comment in ONE transaction,
 * then have the server verify it on chain. Removal is the same shape.
 *
 * Pure: every effect (the API, the signer, the clock) comes in through `QuoteFlowDeps`,
 * so the retry rules are testable without a browser, a wallet or a chain
 * (lib/__tests__/quote-flow.test.ts). The popup (step 6) supplies the real ones.
 */

/** Caption length (decision D4). The server's card cache clips to the same number. */
export const QUOTE_MAX_CHARS = 280;

/**
 * A reblog comment's own words: its body up to the link line Lumen appends on chain
 * ("Reblogged from ..."), which also drops the "Posted via Lumen" footer after it. ONE
 * rule for the server's card cache and the comment's page.
 */
export function quoteCaption(body: string): string {
  const cut = body.search(/\n\s*\n(?:Reblogged from |Reblogged by |\[Reblogged)/);
  return (cut >= 0 ? body.slice(0, cut) : body).trim();
}

/** Hive's "one comment every 3 seconds per account" (hive_evaluator_social.cpp:213). */
const COMMENT_INTERVAL_WAIT_MS = 3500;
/** The node answering the server may be a block behind the one that took the broadcast. */
const CONFIRM_TRIES = 4;
const CONFIRM_GAP_MS = 1500;

/** A post's ON-CHAIN coordinates (for a Lumen post: the publishing account, never the handle). */
export interface ChainRef {
  author: string;
  permlink: string;
}

export interface QuotePlan {
  parentAuthor: string;
  parentPermlink: string;
  permlink: string;
  jsonMetadata: Record<string, unknown>;
  edit: boolean;
  existing: { state: string; body: string } | null;
}

export interface RemovalPlan {
  permlink: string;
  parentAuthor: string;
  parentPermlink: string;
  jsonMetadata: Record<string, unknown>;
  mode: 'delete' | 'blank';
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export interface QuoteFlowDeps {
  prepare(target: ChainRef): Promise<ApiResult<QuotePlan>>;
  confirm(target: ChainRef): Promise<ApiResult<{ bodyCache: string; state: string }>>;
  removePlan(target: ChainRef): Promise<ApiResult<{ plan: RemovalPlan | null }>>;
  removed(target: ChainRef): Promise<ApiResult<{ removed: boolean }>>;
  signQuote(input: {
    reblog: ChainRef | null;
    comment: { parentAuthor: string; parentPermlink: string; permlink: string; body: string; jsonMetadata: Record<string, unknown>; edit: boolean };
  }): Promise<void>;
  signRemove(input: RemovalPlan & { undoReblog: ChainRef | null }): Promise<void>;
  signUnreblog(target: ChainRef): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** A refusal or failure the popup shows; `code` is the server's reason when there is one. */
export class QuoteFlowError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'QuoteFlowError';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hive refused because the account commented less than 3 seconds ago. */
export function isCommentIntervalError(error: unknown): boolean {
  return /only comment once every|HIVE_MIN_REPLY_INTERVAL/i.test(messageOf(error));
}

function refused<T>(result: ApiResult<T>): never {
  if (result.ok) throw new Error('refused() called on a success');
  throw new QuoteFlowError(result.error, `The server refused: ${result.error}`);
}

/** Sign, and wait out Hive's 3-second comment rule once, silently (spec v2 4). */
async function signWithIntervalRetry(deps: QuoteFlowDeps, sign: () => Promise<void>): Promise<void> {
  try {
    await sign();
  } catch (error) {
    if (!isCommentIntervalError(error)) throw error;
    await deps.sleep(COMMENT_INTERVAL_WAIT_MS);
    await sign();
  }
}

/** Ask until the server sees it on chain (node lag), then give its answer. */
async function confirmWithLag(deps: QuoteFlowDeps, target: ChainRef) {
  let last = await deps.confirm(target);
  for (let i = 1; i < CONFIRM_TRIES && !last.ok && last.error === 'not_on_chain'; i++) {
    await deps.sleep(CONFIRM_GAP_MS);
    last = await deps.confirm(target);
  }
  return last;
}

/**
 * Publish (or edit) their comment on a post, with the reblog in the same transaction
 * unless they already reblogged it. Returns the server's verified record.
 *
 * When signing fails for any reason other than the 3-second rule, the server is asked
 * ONCE whether this exact text is on chain now: a timeout can hide a transaction that
 * landed, and the permlink is deterministic, so this can never duplicate anything. A
 * cancelled approval simply is not on chain and the original error is rethrown (the
 * popup keeps the text).
 */
export async function publishQuote(
  deps: QuoteFlowDeps,
  input: { target: ChainRef; caption: string; bodyFor: (caption: string) => string; alreadyReblogged: boolean }
): Promise<{ bodyCache: string; state: string }> {
  const caption = input.caption.trim();
  if (!caption) throw new QuoteFlowError('empty', 'A reblog without a comment is a plain reblog.');
  if (caption.length > QUOTE_MAX_CHARS) throw new QuoteFlowError('too_long', `Keep the comment to ${QUOTE_MAX_CHARS} characters.`);

  const prepared = await deps.prepare(input.target);
  if (!prepared.ok) refused(prepared);
  const plan = prepared.value;
  const sign = () =>
    deps.signQuote({
      reblog: input.alreadyReblogged ? null : input.target,
      comment: {
        parentAuthor: plan.parentAuthor,
        parentPermlink: plan.parentPermlink,
        permlink: plan.permlink,
        body: input.bodyFor(caption),
        jsonMetadata: plan.jsonMetadata,
        edit: plan.edit
      }
    });

  try {
    await signWithIntervalRetry(deps, sign);
  } catch (error) {
    const landed = await deps.confirm(input.target).catch(() => null);
    if (landed?.ok && landed.value.state === 'live' && landed.value.bodyCache === caption) return landed.value;
    throw error;
  }

  const confirmed = await confirmWithLag(deps, input.target);
  if (!confirmed.ok) refused(confirmed);
  return confirmed.value;
}

/**
 * Remove their comment on a post (deleted when Hive allows it, blanked otherwise), and
 * undo the reblog in the same transaction when `undoReblog` is set. With no comment on
 * chain, undoing the reblog is all there is to do.
 *
 * A delete that fails is re-planned, not blindly retried: if the plan now says `blank`
 * (a vote or reply landed in between, and Hive refused the whole transaction) it is
 * signed as a blank; otherwise the error is rethrown (a cancelled approval must never
 * reopen the wallet).
 */
export async function removeQuote(deps: QuoteFlowDeps, input: { target: ChainRef; undoReblog: boolean }): Promise<void> {
  const planned = await deps.removePlan(input.target);
  if (!planned.ok) refused(planned);
  const plan = planned.value.plan;
  const undoReblog = input.undoReblog ? input.target : null;

  if (!plan) {
    if (undoReblog) await deps.signUnreblog(undoReblog);
  } else {
    try {
      await signWithIntervalRetry(deps, () => deps.signRemove({ ...plan, undoReblog }));
    } catch (error) {
      if (plan.mode !== 'delete') throw error;
      const again = await deps.removePlan(input.target).catch(() => null);
      const next = again?.ok ? again.value.plan : null;
      if (next?.mode !== 'blank') throw error;
      await signWithIntervalRetry(deps, () => deps.signRemove({ ...next, undoReblog }));
    }
  }

  let done = await deps.removed(input.target);
  for (let i = 1; i < CONFIRM_TRIES && !done.ok && done.error === 'still_on_chain'; i++) {
    await deps.sleep(CONFIRM_GAP_MS);
    done = await deps.removed(input.target);
  }
  if (!done.ok) refused(done);
}
