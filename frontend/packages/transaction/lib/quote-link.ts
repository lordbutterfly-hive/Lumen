/**
 * The link line under a quote reblog's caption (spec v2 2.3), shared by BOTH publishing
 * paths: a full account's own comment (`quote-ops.ts`) and a lite quote the publisher
 * posts (apps/blog/lib/lite/content/quote-service.ts). Pure, and free of the full-account
 * attribution module, which the lite path must never import.
 */

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
