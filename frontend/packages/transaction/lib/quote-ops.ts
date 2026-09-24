import { appendAttributionFooter } from './attribution';
import { DELETED_BODY } from './deleted-body';
import { mergeEditJsonMetadata } from './edit-metadata';
import { linkText, quoteLinkLine, type QuoteTarget } from './quote-link';

/**
 * Quote reblogs ("reblog with a comment", spec v2 2.3 and 4): the pure parts of what a
 * FULL Hive account signs. No chain, no wax, so it is testable under mocha; the
 * transaction itself is assembled in `TransactionService.quoteReblog` / `removeQuote`.
 */

export { DELETED_BODY };

export { linkText, quoteLinkLine, type QuoteTarget };

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
