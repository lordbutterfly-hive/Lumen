import { appendAttributionFooter } from './attribution';
import { DELETED_BODY } from './deleted-body';
import { mergeEditJsonMetadata } from './edit-metadata';

/**
 * Quote reblogs ("reblog with a comment", spec v2 2.3 and 4): the pure parts of what a
 * FULL Hive account signs. No chain, no wax, so it is testable under mocha; the
 * transaction itself is assembled in `TransactionService.quoteReblog` / `removeQuote`.
 */

export { DELETED_BODY };

/** What the quote points at, for the link line under the caption. */
export interface QuoteTarget {
  author: string;
  permlink: string;
  title: string;
  /** Absolute Lumen URL of the post. */
  url: string;
  /**
   * A Lumen (lite) post: its author on chain is Lumen's publishing account and its
   * handle is NOT a Hive account, so it is named without `@` (an `@handle` would notify
   * whichever Hive account happens to hold that name: the squatter case).
   */
  lite?: { handle: string } | null;
}

const LINK_TEXT_MAX = 120;

/** A title as markdown link text: one line, brackets escaped, never empty. */
export function linkText(title: string): string {
  const oneLine = title.replace(/\s+/g, ' ').trim();
  const clipped = oneLine.length > LINK_TEXT_MAX ? `${oneLine.slice(0, LINK_TEXT_MAX - 1).trimEnd()}…` : oneLine;
  const safe = clipped.replace(/([\\[\]])/g, '\\$1');
  return safe || 'this post';
}

/**
 * The line under the caption. `Reblogged from` is also what `captionOf` (the server's
 * card cache, lib/lite/content/quote-service.ts) cuts at, so the two must agree.
 */
export function quoteLinkLine(target: QuoteTarget): string {
  const who = target.lite ? `a post by ${target.lite.handle} on Lumen` : `@${target.author}`;
  return `Reblogged from ${who}: [${linkText(target.title)}](${target.url})`;
}

/** The full on-chain body: caption, the link line, then Lumen's attribution footer. */
export function quoteCommentBody(caption: string, target: QuoteTarget): string {
  return appendAttributionFooter(`${caption.trim()}\n\n${quoteLinkLine(target)}`);
}

/**
 * Hive's reblog is a `follow` custom_json; with `delete: 'delete'` it removes one
 * (hivemind `massive_sync.sql`, the reblog branch). wax's `FollowOperation.reblog` has
 * no delete form, so the undo is built here, in the exact wire shape wax emits for a
 * reblog (`HiveAppsOperation.authorize`).
 */
export function undoReblogOperation(account: string, author: string, permlink: string) {
  return {
    custom_json_operation: {
      id: 'follow',
      json: JSON.stringify(['reblog', { account, author, permlink, delete: 'delete' }]),
      required_auths: [] as string[],
      required_posting_auths: [account]
    }
  };
}

/**
 * The metadata of a blanked quote: everything it said about itself is kept (the
 * `lumen_quote` marker, so the parent AND the marker still say what it was), `app` is
 * refreshed and `deleted: true` is added, as the lite publisher's soft delete does.
 */
export function blankedJsonMetadata(existing: unknown, app: string): Record<string, unknown> {
  return { ...mergeEditJsonMetadata(existing, app), deleted: true };
}
