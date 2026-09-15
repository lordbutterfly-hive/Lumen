import type { Entry } from '@hive/common-hiveio-packages/wax';

/**
 * ★★ THE "SHOW N NEW POSTS" ACCEPTANCE SURVIVES LEAVING THE PAGE (owner,
 * 2026-09-15: "if i go anywhere else and come back I have to click it again").
 *
 * WHAT WAS WRONG. `ForYouFeed` kept the posts the reader accepted in a plain
 * `useState`. Leaving the home route unmounts the feed and that state with it.
 * On the way back the ranked page comes out of React Query untouched (its
 * `staleTime` is `Infinity` on purpose), and so does the silent poll's probe
 * page — `enabled: false` only stops a query FETCHING, it never stops it
 * RETURNING what it already holds. So `offered` was recomputed against a page
 * that no longer contained the accepted posts, and the same button came back
 * asking the reader to accept the same posts a second time. Nothing about the
 * ranking was wrong; the reader's own answer had simply been thrown away.
 *
 * ★★★ WHY `sessionStorage` AND NOT ONLY A MODULE VARIABLE (measured on the
 * production build, 2026-09-15). The first version of this was a module-scoped
 * slot, on the reasoning that "changing pages" is a client-side transition.
 * Instrumented on `next start`: `router.push('/topics/<tag>')` from `/` is a
 * FULL DOCUMENT NAVIGATION (`performance.navigation.type === 'navigate'`, no
 * RSC fetch recorded before it), which resets every module. A module slot
 * therefore survived nothing the reader actually does. `sessionStorage` is
 * per-tab and outlives a document load, which is exactly the scope asked for:
 * this tab, this session, until the browser is closed.
 *
 * The module slot is kept as the fast path and the hydration seed; storage is
 * the durable copy. Every storage access is wrapped, because `sessionStorage`
 * can throw (private browsing, quota) and the worst case must be the OLD
 * behaviour — asked again — never a broken feed.
 *
 * ★ NEVER READ DURING THE `useState` INITIALISER. On a hard load the server
 * renders `accepted = []`; a client initialiser that read storage would render
 * the accepted posts on top during HYDRATION and disagree with the server —
 * the exact mismatch `feed-tabs.tsx`'s `revealed` comment warns about, which
 * React 18 answers by discarding the boundary and re-rendering it from
 * scratch. The caller restores in a layout effect after hydration instead
 * (before paint, so there is no flash), where a state update is ordinary.
 *
 * ★ KEYED ON THE VIEWER. `queryClient.clear()` (app/layout.tsx, on an identity
 * change) reaches neither a module variable nor storage. Without the key,
 * signing out and back in as someone else in the same tab would hand the
 * second reader the first reader's accepted posts. A viewer mismatch reads
 * as empty, and a write for a new viewer replaces the old entry.
 *
 * ★ BOUNDED TWICE. The caller caps the list (FOR_YOU_LIMIT * 4). Here a TTL
 * keeps a tab left open overnight from pinning yesterday's accepted posts to
 * the top of a fresh morning feed: past `MAX_AGE_MS` the memory is treated as
 * empty and the ranking wins.
 *
 * ★ VISUAL ONLY. Nothing here touches what the poll fetches, what the server
 * ranks, what is recorded as seen, or the swap path (`acceptRanking` never
 * wrote `accepted` and still does not). The feed's own dedupe — accepted
 * first, then pages, keyed on author/permlink — is what makes restoring safe:
 * a post that later also arrives in page 1 renders once, never twice.
 */

const STORAGE_KEY = 'lumen.feed.acceptedNewPosts.v1';
/** Six hours: long enough for any real session, short enough that a stale
 *  acceptance never outlives the ranking it was made against. */
export const MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface Stored {
  viewer: string;
  at: number;
  entries: Entry[];
}

/** The minimal slice of the Storage interface this module uses — injectable for tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let slot: Stored | null = null;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    // Accessing `sessionStorage` itself can throw (sandboxed frames, some privacy modes).
    return null;
  }
}

function isFresh(s: Stored | null, viewer: string, now: number): s is Stored {
  return s !== null && s.viewer === viewer && now - s.at >= 0 && now - s.at <= MAX_AGE_MS;
}

/**
 * What this viewer already accepted in this tab, or `[]`.
 * Reads the module slot first; on a fresh document (slot empty) falls back to
 * storage and re-seeds the slot from it.
 */
export function readAcceptedNewPosts(
  viewer: string,
  storage: StorageLike | null = defaultStorage(),
  now: number = Date.now()
): Entry[] {
  if (isFresh(slot, viewer, now)) return slot.entries;
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<Stored> | null;
    if (!parsed || typeof parsed.viewer !== 'string' || typeof parsed.at !== 'number' || !Array.isArray(parsed.entries)) {
      return [];
    }
    const candidate: Stored = { viewer: parsed.viewer, at: parsed.at, entries: parsed.entries as Entry[] };
    if (!isFresh(candidate, viewer, now)) return [];
    slot = candidate;
    return candidate.entries;
  } catch {
    return [];
  }
}

/** Record this viewer's acceptance. Replaces, never appends — the caller owns the cap. */
export function writeAcceptedNewPosts(
  viewer: string,
  entries: Entry[],
  storage: StorageLike | null = defaultStorage(),
  now: number = Date.now()
): void {
  slot = { viewer, at: now, entries };
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(slot));
  } catch {
    // Quota or a privacy mode: the module slot still covers in-page
    // navigation; a document load falls back to asking again, as before.
  }
}

/** Test seam only: return the module to its freshly-loaded state. */
export function resetAcceptedNewPostsForTests(): void {
  slot = null;
}
