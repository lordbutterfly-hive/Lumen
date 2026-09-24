import type { Entry, QuoteOverlay } from '@hive/common-hiveio-packages/wax';
import * as quotes from '../repositories/quote-repository';
import { findUsersByHiveAccountNames } from '../repositories/user-repository';
import { blockedPairsAmong, pairKey } from '../repositories/block-repository';

/**
 * Quote reblogs (spec v2 3.2): give each reblog entry its reblogger's live comment, so
 * the card shows it above the post. ONE quote query for the whole page (plus one to map
 * upgraded accounts, whose quotes are keyed by their Lumen id). Decoration only: the
 * caller keeps the page as it was if this throws.
 *
 * The post's ON-CHAIN coordinates are what quotes are keyed on (`_lite.chainAuthor` for
 * a Lumen post), never the handle a card shows. Returns the page WITHOUT any quote whose
 * post's owner has blocked the quoter (decision D7).
 */
export async function attachQuotes<T extends Entry>(entries: T[]): Promise<T[]> {
  const reblogs = entries.filter((e) => (e.reblogged_by?.length ?? 0) > 0);
  if (reblogs.length === 0) return entries;
  const names = [...new Set(reblogs.map((e) => e.reblogged_by![0].toLowerCase()))];
  const keyOf = new Map(names.map((n) => [n, `h:${n}`]));
  for (const u of await findUsersByHiveAccountNames(names)) {
    if (u.hiveAccountName) keyOf.set(u.hiveAccountName.toLowerCase(), `u:${u.userId}`);
  }
  const pairs = reblogs.map((e) => ({
    quoterKey: keyOf.get(e.reblogged_by![0].toLowerCase())!,
    targetAuthor: e._lite?.chainAuthor ?? e.author,
    targetPermlink: e.permlink
  }));
  const live = await quotes.liveQuotesForPairs(pairs);
  const quoted: { entry: T; ownerKey: string; quoterKey: string }[] = [];
  reblogs.forEach((e, i) => {
    const p = pairs[i];
    const q = live.get(`${p.quoterKey}|${p.targetAuthor}/${p.targetPermlink}`);
    if (!q) return;
    const overlay: QuoteOverlay = { quoter: e.reblogged_by![0], author: q.quoteAuthor, permlink: q.quotePermlink, body: q.bodyCache };
    e._quote = overlay;
    // The post's owner as a block-graph node: the writer for a Lumen post, else its author.
    quoted.push({ entry: e, ownerKey: e._lite?.userId ? `u:${e._lite.userId}` : `h:${e.author.toLowerCase()}`, quoterKey: p.quoterKey });
  });
  if (quoted.length === 0) return entries;

  // Decision D7: when the post's owner has blocked the person quoting it, the post is
  // not shown under their comment. The quote is withheld, not just its comment.
  const blocked = await blockedPairsAmong(
    quoted.map((q) => q.ownerKey),
    quoted.map((q) => q.quoterKey)
  );
  if (blocked.size === 0) return entries;
  const withheld = new Set(quoted.filter((q) => blocked.has(pairKey(q.ownerKey, q.quoterKey))).map((q) => q.entry));
  return entries.filter((e) => !withheld.has(e));
}
