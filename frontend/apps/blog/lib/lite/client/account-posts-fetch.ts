'use client';

import { Entry } from '@hive/common-hiveio-packages/wax';

/**
 * ★★★ ONE HIVE ACCOUNT'S OWN POSTS/COMMENTS, ALWAYS THROUGH OUR OWN SERVER.
 *
 * Same reasoning as `fetchDiscussion` (discussion-fetch.ts) in this same
 * directory. Every profile Posts/Comments call site used to invoke
 * `getAccountPosts` from `@transaction`, which talks to a Hive node from the
 * browser. That is fine for the Posts tab (root posts carry no parent, so
 * there is nothing to filter) and wrong for the Comments tab, where a post
 * owner's block is supposed to keep the blocked account's replies off
 * EVERYONE's screen (effect B) -- a rule enforced only in the reader's own
 * browser is enforced by exactly the person it is meant to constrain.
 *
 * `/api/account-posts` returns `{ entries: Entry[] }`, so every consumer is
 * unchanged apart from swapping this in.
 *
 * Unlike `fetchDiscussion`, an empty array here is a LEGITIMATE answer (the
 * last page of a real pagination, or an account with nothing posted yet), so
 * this does not throw on `[]` the way the discussion fetch does on `{}`. It
 * throws on a genuine transport failure (matching what a rejected
 * `getAccountPosts` promise looked like to callers before), and now ALSO on
 * the route's own explicit `degraded` flag.
 *
 * ★★★ THROW ON `degraded` — DO NOT RETURN `[]` FOR IT (2026-08-13,
 * O4-stuck-states.md item 4; mirrors `discussion-fetch.ts:49`'s reasoning for
 * the identical class of bug). The route used to answer a genuinely failed
 * upstream read with the exact same `{ entries: null }` an empty account
 * produced — so this function, and every caller behind it, could not tell "no
 * posts" from "the read failed", and quietly turned the second one into the
 * first. Returning `[]` here instead of throwing would make that WORSE, not
 * better: it would turn a silent blank page into a confident false "@user
 * hasn't posted yet" instead of leaving it silently blank. Throwing routes the
 * failure into React Query's `isError`, which every consumer already renders
 * as `<NoDataError />` (`posts-content.tsx:98`, `feed-tabs.tsx`'s `EntryFeed`,
 * `profile-posts-list.tsx`, `profile-comments-list.tsx` — confirmed, all four
 * already wired and reachable; none of them checked for a literal `null`).
 * A true empty account is unaffected: the route never sets `degraded` for it.
 */
export async function fetchAccountPosts(
  sort: string,
  account: string,
  observer: string,
  startAuthor = '',
  startPermlink = '',
  limit?: number
): Promise<Entry[] | null> {
  const params = new URLSearchParams({ sort, account });
  if (observer) params.set('observer', observer);
  if (startAuthor) params.set('start_author', startAuthor);
  if (startPermlink) params.set('start_permlink', startPermlink);
  if (limit) params.set('limit', String(limit));

  const res = await fetch(`/api/account-posts?${params.toString()}`);
  if (!res.ok) throw new Error(`account posts ${res.status}`);
  const body = (await res.json().catch(() => null)) as
    | { entries?: Entry[] | null; degraded?: string | boolean }
    | null;
  if (body?.degraded) throw new Error(`account posts degraded: ${body.degraded}`);
  return body?.entries ?? null;
}
