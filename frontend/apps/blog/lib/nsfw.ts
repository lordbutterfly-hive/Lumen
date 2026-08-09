import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { DEFAULT_PREFERENCES, Preferences } from '@/blog/lib/utils';
import { Entry } from '@hive/common-hiveio-packages/wax';

/**
 * ★ ONE DEFINITION OF "IS THIS POST NSFW", AND ONE PLACE TO READ THE READER'S
 * PREFERENCE (2026-08-09, owner report: "NSFW posts popping up").
 *
 * The whole redesigned surface — the home feed's three tabs, topic/tag pages
 * and the profile Posts tab — renders `MediumPostCard`, and that component had
 * NO NSFW handling of any kind (`grep -rn nsfw features/discovery-feed/` was
 * empty). The classic `PostListItem` has the full warn/hide/show machinery, so
 * the same NSFW post was gated in one list and rendered with its image, at
 * 190x132, in the other. The reader's `nsfw: 'warn'` default — which the
 * settings form still writes and still claims to honour — reached none of the
 * four redesigned surfaces.
 *
 * Measured against live mainnet the day this was written: the newest 10 posts
 * under `#nsfw` were all correctly tagged, and 4 of the first 5 carried a real
 * photograph in `json_metadata.image[0]` — which is exactly the field
 * `find_first_img` returns for the card thumbnail. `/topics/nsfw` is a
 * reachable URL that rendered them as a grid.
 *
 * Detection lives here rather than inline because the two existing readers
 * disagreed with each other AND with the ranker:
 *   - `post-list-item.tsx` / `post-img.tsx`: `tags.includes('nsfw')` — exact
 *     case, so an `NSFW` or `Nsfw` tag walked straight through;
 *   - `recsys/io/hafsql.py`: `any(tag.lower() == "nsfw" ...)` — case-insensitive.
 * A post the ranker considers NSFW must not be un-flagged by the client that
 * renders it, so this matches the ranker's rule and adds the category, which
 * on Hive is the post's first tag and is how a post lands in `/topics/nsfw`
 * (measured: `lilip`'s post is reachable that way while carrying no `nsfw`
 * entry in its own tags array).
 */
export function isNsfwPost(post: Pick<Entry, 'json_metadata' | 'category'>): boolean {
  const meta = post.json_metadata as { tags?: unknown } | undefined;
  const tags = Array.isArray(meta?.tags) ? meta!.tags : [];
  if (tags.some((tag) => typeof tag === 'string' && tag.trim().toLowerCase() === 'nsfw')) {
    return true;
  }
  return typeof post.category === 'string' && post.category.trim().toLowerCase() === 'nsfw';
}

/**
 * The reader's NSFW preference, read from the same
 * `user-preferences-{username}` localStorage key the settings form writes and
 * the classic list already uses — so one setting governs every surface.
 *
 * A signed-out reader has no stored preferences and therefore gets
 * `DEFAULT_PREFERENCES.nsfw` (`'warn'`), which is the same value the classic
 * list falls back to. That is deliberate: the anonymous home feed is the most
 * public surface Lumen has, and it should not be the one place explicit images
 * render unasked.
 */
/**
 * ★ FILTER AT THE LIST, NOT ONLY AT THE CARD (2026-08-09).
 *
 * The card honours `hide` by rendering `null`. On a list where EVERY post is
 * flagged that leaves a zero-height list, so the infinite-scroll sentinel never
 * leaves the viewport and `fetchNextPage` re-fires the instant each request
 * resolves. Two testers measured it independently on `/topics/nsfw`: a counter
 * climbing 30 → 1467 → 1917 in ~12s with nothing on screen, walking the tag's
 * entire history — bandwidth and battery spent downloading precisely the
 * content the reader asked never to see, and a self-inflicted load on the
 * shared backend.
 *
 * That regression was introduced BY the `hide` fix, which is the ordinary way
 * of these things: fixes are where bugs come from.
 *
 * Filtering here makes `entries.length` mean "posts you will actually see", so
 * the list's existing empty state and its `entries.length > 0` sentinel guard
 * both start telling the truth, with no new control flow. The card keeps its
 * own early return as defence in depth for any caller that does not filter.
 *
 * ★ SPLIT INTO A HOOK AND A PLAIN FUNCTION (2026-08-09) — this was a single
 * hook, and every caller needed it AFTER its `if (isLoading) return …` guards,
 * because the list it filters does not exist until then. A hook after an early
 * return is a CONDITIONAL hook: React threw #310 ("rendered more hooks than
 * during the previous render") and the home page died on hydration — it
 * server-rendered perfectly and then blanked to "Something went wrong".
 *
 * So the preference is read unconditionally at the top of the component with
 * `useNsfwPreference()`, and the filtering — which needs no hook at all — is
 * done by `filterVisiblePosts` wherever the data is ready.
 */
export function filterVisiblePosts<T extends Pick<Entry, 'json_metadata' | 'category'>>(
  entries: T[],
  preference: Preferences['nsfw']
): T[] {
  if (preference !== 'hide') return entries;
  return entries.filter((entry) => !isNsfwPost(entry));
}

export function useNsfwPreference(): Preferences['nsfw'] {
  const { user } = useUserClient();
  const [preferences] = useStorageWithTTL<Preferences>(
    user?.username ? `user-preferences-${user.username}` : '',
    DEFAULT_PREFERENCES,
    StorageTTL.PERMANENT
  );
  return preferences?.nsfw ?? DEFAULT_PREFERENCES.nsfw;
}
