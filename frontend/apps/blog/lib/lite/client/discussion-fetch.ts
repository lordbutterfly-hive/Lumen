'use client';

import type { Entry } from '@hive/common-hiveio-packages/wax';

/**
 * ★★★ THE COMMENT THREAD, ALWAYS THROUGH OUR OWN SERVER.
 *
 * Every client call site used to invoke `getDiscussion` from `@transaction`, which
 * talks to a Hive node from the browser. That is the right thing for a pure chain
 * read and the wrong thing the moment any part of the answer is Lumen's to decide —
 * and one part is: a post owner's block removes a commenter's replies for EVERY
 * reader (effect B). A rule enforced only in the reader's own browser is enforced by
 * the exact person it constrains, so the thread has to be assembled where the block
 * list lives.
 *
 * `/api/discussion` returns the identical `Record<'author/permlink', Entry>` map the
 * bridge returned, already carrying Lumen identities, so every consumer is unchanged
 * apart from swapping this in.
 *
 * FAILS TO AN EMPTY THREAD, never to a direct chain read. Falling back to the node
 * would mean any hiccup in this route silently re-published the comments the owner
 * blocked — a filter that turns itself off under load is not a filter.
 */
export async function fetchDiscussion(
  author: string,
  permlink: string,
  observer = ''
): Promise<Record<string, Entry>> {
  const params = new URLSearchParams({ author, permlink });
  if (observer) params.set('observer', observer);
  const res = await fetch(`/api/discussion?${params.toString()}`);
  if (!res.ok) throw new Error(`discussion ${res.status}`);
  const body = (await res.json().catch(() => null)) as
    | { discussion?: Record<string, Entry>; degraded?: string }
    | null;
  const discussion = body?.discussion ?? {};

  // ★ THROW ON AN EMPTY ANSWER — DO NOT RETURN ONE. (Measured in a browser, and it
  // was ugly.) `bridge.get_discussion` always includes the root post for a post that
  // exists, so an empty map means the upstream node declined, which public nodes do
  // intermittently. Returning `{}` made React Query treat that as a SUCCESSFUL result
  // and overwrite the server-rendered thread with nothing: a page that had rendered
  // its comments correctly went blank a second later. Throwing keeps the last good
  // data (the SSR seed, which is already block-filtered) and lets the query retry.
  //
  // This is not fail-open: what is kept was produced by the same filter on the
  // server. There is no path here that reaches a chain node directly.
  if (Object.keys(discussion).length === 0) {
    throw new Error(body?.degraded ? `discussion degraded: ${body.degraded}` : 'discussion empty');
  }
  return discussion;
}
