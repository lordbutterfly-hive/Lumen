import type { Entry } from '@hive/common-hiveio-packages/wax';
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

        /**
         * ★★★ AND THE ENTRY ITSELF, NOT JUST THE OVERLAY (2026-08-17).
         *
         * Owner: "lite account posts still look like comments on Lumen." They did.
         * Every lite post is broadcast as a chain COMMENT on purpose — Hive caps root
         * posts at one per 5 minutes per account but allows replies every 3 seconds,
         * so `post-service.ts` nests them under a rolling container (the same trick
         * as PeakD Snaps / Ecency Waves / InLeo Threads). That is permanent:
         * `parent_author` cannot be edited on Hive.
         *
         * `db-post-to-entry.ts` already compensates — it derives `depth` from the
         * row and restores the real title — which is why the author's own profile
         * and the permalink page look right. This function did not: it wrote only
         * `_lite`, leaving `depth: 1` and Hivemind's synthesised `"RE: <container
         * title>"` on the entry. Everything that reads those raw fields therefore
         * treated a person's post as a reply — the ranked feed, `/api/discussion`,
         * and any comment thread — which is exactly the surfaces the owner sees.
         *
         * Corrected here rather than in each consumer because there is one truth and
         * several readers, and because it repairs every ALREADY-PUBLISHED post the
         * moment it ships: the values come from the row, not from the chain, so no
         * backfill and no chain edit is possible or needed.
         *
         * Only the fields the chain got wrong ABOUT THE SHAPE are touched. Everything
         * else the entry carries is left exactly as Hivemind presented it.
         *
         * ★ `parent_author`/`parent_permlink` ARE DELIBERATELY LEFT ALONE. Clearing
         * them would describe the shape more truthfully and break real things: the
         * comment tree nests children on the parent permlink, replies address a
         * parent, and `bridge.get_discussion`'s map is keyed on it. `depth` is what
         * the render paths actually branch on, and the title is what the reshare
         * heuristic in `medium-post-card.tsx` misreads — those two are the whole
         * defect. Narrow beats thorough on a shared read path.
         */
        if (!row.parentRef) entry.depth = 0;
        if (row.title) entry.title = row.title;
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
