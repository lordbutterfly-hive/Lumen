import { Entry } from '@hive/common-hiveio-packages/wax';
import * as posts from '../repositories/post-repository';
import { isLumenProxiedEntry, litePostIdOf } from './lite-post-id';
import { resolvePublicNames } from './current-name';

/**
 * Attach Lumen identities to chain-sourced entries, on the SERVER.
 *
 * Feeds and comment threads come from Hivemind, where every Lumen post is authored by
 * the one shared publishing account. The client hook `use-lite-overlay` can fix that
 * per card, but only after a round trip — so the first paint showed the publishing
 * account and each card visibly corrected itself. Resolving here means the name is
 * already right in the HTML the browser receives.
 *
 * TWO queries for a whole page, regardless of how many entries: one for the posts,
 * one for their authors. Ordinary Hive entries cost nothing — they never match the
 * Lumen permlink pattern, so a feed with no lite posts issues no queries at all.
 *
 * Mutates the entries in place and returns them. They are plain JSON on their way to
 * the client, and cloning a feed page to add one field each would be waste.
 *
 * NEVER THROWS. A lite identity is a nicety; a feed that 500s because Postgres
 * hiccuped is not. On failure the entries pass through untouched and the client hook
 * resolves them the old way.
 */
export async function attachLiteIdentities<T extends Entry>(entries: T[]): Promise<T[]> {
  try {
    const byPostId = new Map<string, T[]>();
    for (const entry of entries) {
      if (!isLumenProxiedEntry(entry)) continue;
      const postId = litePostIdOf(entry);
      if (!postId) continue;
      const bucket = byPostId.get(postId);
      // The same post can appear more than once on a page (a feed plus a
      // "suggested" rail, say), so keep every entry that maps to this id.
      if (bucket) bucket.push(entry);
      else byPostId.set(postId, [entry]);
    }
    if (byPostId.size === 0) return entries;

    const rows = await posts.getPostsByIds([...byPostId.keys()]);
    const names = await resolvePublicNames(rows);

    for (const row of rows) {
      // A post hidden or deleted on Lumen keeps whatever the chain still shows; this
      // function only relabels, it is not a moderation gate.
      const targets = byPostId.get(row.postId);
      if (!targets) continue;
      for (const entry of targets) {
        // ★ THE ENTRY MUST ACTUALLY BE THE POST IT CLAIMS TO BE.
        //
        // Both signals that got us here — the permlink and `json_metadata.lumen_post_id`
        // — are on-chain fields that ANY Hive account can write. Without this check,
        // anyone could broadcast a comment carrying a real Lumen post id and have Lumen
        // render their text under that lite user's name, avatar and profile link, in
        // server-rendered HTML. Permlinks are unique per author, not globally, so the
        // permlink route is just as forgeable as the metadata one.
        //
        // The row records who really signed the post. If the entry in front of us was
        // signed by anyone else, it is not that post — leave it exactly as the chain
        // presented it.
        if (!row.hiveAuthor || row.hiveAuthor.toLowerCase() !== (entry.author ?? '').toLowerCase()) {
          continue;
        }
        entry._lite = {
          author: names.get(row.postId) ?? row.displayNameSnapshot,
          // Hivemind synthesises "RE: <parent title>" for every comment, and every
          // lite post is a comment on chain, so the chain entry's title is useless.
          // Our row kept the real one — only the body is pruned after publish.
          title: row.title || entry.title,
          chainAuthor: row.hiveAuthor,
          // The exact writer. Carried because the two names either side of it are
          // both ambiguous for identity purposes — `author` is a handle, and
          // `chainAuthor` is the SHARED publishing account that signs for everybody.
          // Without this the block filters would have to guess.
          userId: row.userId
        };
      }
    }
    return entries;
  } catch {
    return entries;
  }
}

/** Same, for the keyed map `bridge.get_discussion` returns. */
export async function attachLiteIdentitiesToDiscussion<T extends Entry>(
  discussion: Record<string, T> | null
): Promise<Record<string, T> | null> {
  if (!discussion) return discussion;
  await attachLiteIdentities(Object.values(discussion));
  return discussion;
}
