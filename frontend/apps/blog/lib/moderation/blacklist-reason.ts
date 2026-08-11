/**
 * ════ WHY "(blacklisted)" WAS A LIE ════
 *
 * `Entry.blacklists` (Hivemind's own field, populated from the `observer` passed to
 * `bridge.get_discussion` / `get_account_posts`) is NOT purely "which of the
 * observer's blacklists matched this author." Measured directly against
 * api.hive.blog 2026-08-11, on the POB thread this file was written to fix:
 *
 *   bpcvoter1 (author_reputation -13.12): blacklists = ["reputation-0"]
 *   bpcvoter3 (author_reputation -12.24): blacklists = ["reputation-0"]
 *   bpcvoter2 (confirmed BY bridge.get_follow_list ON lordbutterfly's OWN
 *             follow_type:"blacklisted" list): blacklists = ["my blacklist", "reputation-0"]
 *
 * So Hivemind injects a synthetic `reputation-N` token into `blacklists` for any
 * near-zero/negative-reputation author, REGARDLESS of whether anyone ever put them
 * on a real list. `apps/blog/features/post-rendering/comment-list-item.tsx` used to
 * compute `isBlacklisted = comment.blacklists.length > 0`, which is true for both
 * cases above — so a merely low-reputation author (bpcvoter1, bpcvoter3: on NO list,
 * personal or followed — confirmed directly via `bridge.get_follow_list
 * {observer:"lordbutterfly", follow_type:"blacklisted"}` -> `[bpcvoter2, daylaykay]`
 * and `follow_type:"follow_blacklist"` -> `[]`) rendered the exact same "Reveal
 * Comment (blacklisted)" tag as an author on a REAL blacklist. The owner's point:
 * that makes the real blacklist feature look like it works when it usually does not
 * — most gray comments are gray because of `reputation-N`, not a list.
 *
 * `"my blacklist"` is confirmed (by the bpcvoter2 cross-check above) to be
 * Hivemind's fixed label for the OBSERVER'S OWN personal blacklist. Any other
 * non-`reputation-N` token is therefore attributed to a list the observer FOLLOWS
 * (per `bridge.get_account_posts`'s own doc comment: "Optional Hive account name
 * with blacklists ... Useful for content moderation" and `IFollowList`'s
 * `follow_type: "follow_blacklist"`) — there is no third category Hivemind's
 * bridge API defines for this field. No thread in hand ever exercised that branch
 * (`follow_blacklist` was empty for every observer checked), so treat that inference
 * as UNVERIFIED-BY-EXAMPLE and re-confirm if it ever matters for a decision more
 * consequential than a label.
 */

const REPUTATION_SYNTHETIC = /^reputation-\d+$/i;
const OWN_BLACKLIST_LABEL = 'my blacklist';

export type BlacklistReason =
  | 'own' // a REAL match on the observer's OWN blacklist
  | 'followed' // a REAL match on a blacklist the observer follows (unverified-by-example, see above)
  | 'reputation' // ONLY the synthetic low/negative-reputation token — not a list match at all
  | 'none'; // no blacklist signal of any kind

/**
 * Classifies Hivemind's `Entry.blacklists` into what actually caused it, so a
 * caller can label a low-reputation author "low reputation" instead of the
 * damaging (and here, false) "blacklisted".
 */
export function classifyBlacklist(blacklists: string[] | null | undefined): BlacklistReason {
  const list = blacklists ?? [];
  const real = list.filter((entry) => !REPUTATION_SYNTHETIC.test(entry));
  if (real.length > 0) return real.includes(OWN_BLACKLIST_LABEL) ? 'own' : 'followed';
  return list.length > 0 ? 'reputation' : 'none';
}
