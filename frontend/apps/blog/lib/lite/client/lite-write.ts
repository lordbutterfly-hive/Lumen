'use client';

import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';

/**
 * Client-side write/interaction calls for LITE-tier sessions. A lite account has
 * no Hive keys, so its posts, comments and follows cannot be signed in the
 * browser — they are handed to the `/api/lite/*` backend, which persists them and
 * enqueues a `publish_job` for the server-side frontend account to broadcast to
 * Hive (spec §C/§D). Full (Hive-account) sessions keep using the existing wax /
 * Keychain path; callers branch on `user.account_tier === 'lite'`.
 *
 * CSRF defense is the presence of the custom `x-csrf-token` header (same scheme
 * as the app's other authed fetches, see lib/lite/http/csrf.ts).
 */

const JSON_POST: HeadersInit = { 'Content-Type': 'application/json', [csrfHeaderName]: '1' };

export type LiteWriteResult = { status: 'ok'; postId?: string } | { status: 'error'; message: string };
export type LiteFollowResult = { status: 'ok'; following: boolean } | { status: 'error'; message: string };

function friendly(status: number, code?: string): string {
  if (status === 401) return 'Please sign in to continue.';
  if (status === 429 || code === 'rate_limited') return 'You’re going a bit fast — please wait a moment and try again.';
  if (status === 503) return 'Lumen accounts aren’t available right now.';
  if (code === 'not_found') return 'That account isn’t on Lumen.';
  if (code === 'cannot_follow_self') return 'You can’t follow yourself.';
  return 'Something went wrong — please try again.';
}

export interface LitePostInput {
  body: string;
  title?: string;
  summary?: string;
  tags?: string[];
  community?: string;
  tier?: 'normal' | 'advanced';
  /** Present for a comment/reply: the parent lite post or on-chain thread. */
  parentRef?: { type: 'lite'; id: string } | { type: 'chain'; author: string; permlink: string };
  /**
   * Set to edit an existing post instead of creating one. Without this the server
   * has no way to tell an edit from a new post, and an "edit" silently becomes a
   * duplicate — which is exactly what the lite composer did before this existed.
   */
  editOfPostId?: string;
}

/** Create a lite post or comment (identity comes from the session, never the body). */
export async function createLitePost(input: LitePostInput): Promise<LiteWriteResult> {
  try {
    const res = await fetch('/api/lite/posts', {
      method: 'POST',
      headers: JSON_POST,
      body: JSON.stringify({
        tier: input.tier ?? 'normal',
        body: input.body,
        title: input.title,
        summary: input.summary,
        tags: input.tags,
        community: input.community,
        parentRef: input.parentRef,
        editOfPostId: input.editOfPostId
      })
    });
    const b = (await res.json().catch(() => null)) as
      | { status?: string; post?: { id?: string; postId?: string }; code?: string; error?: string }
      | null;
    if (res.status === 201 && b?.status === 'ok') {
      return { status: 'ok', postId: b.post?.id ?? b.post?.postId };
    }
    return { status: 'error', message: friendly(res.status, b?.code || b?.error) };
  } catch {
    return { status: 'error', message: 'Network error — please try again.' };
  }
}

/** Cast/change/remove a Lumen-local vote (weight 0 removes it). */
export async function liteVote(author: string, permlink: string, weight: number): Promise<LiteWriteResult> {
  try {
    const res = await fetch('/api/lite/vote', {
      method: 'POST',
      headers: JSON_POST,
      body: JSON.stringify({ author, permlink, weight })
    });
    const b = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (res.ok && b?.ok) return { status: 'ok' };
    return { status: 'error', message: friendly(res.status, b?.error) };
  } catch {
    return { status: 'error', message: 'Network error — please try again.' };
  }
}

/** Reblog / un-reblog a post (Lumen-local). */
export async function liteReblog(author: string, permlink: string, undo = false): Promise<LiteWriteResult> {
  try {
    const res = await fetch('/api/lite/reblog', {
      method: 'POST',
      headers: JSON_POST,
      body: JSON.stringify({ author, permlink, undo })
    });
    const b = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (res.ok && b?.ok) return { status: 'ok' };
    return { status: 'error', message: friendly(res.status, b?.error) };
  } catch {
    return { status: 'error', message: 'Network error — please try again.' };
  }
}

/** Follow / unfollow another Lumen (lite) account by display name. */
export async function liteFollow(followeeName: string, unfollow = false): Promise<LiteFollowResult> {
  try {
    const res = await fetch(`/api/lite/${unfollow ? 'unfollow' : 'follow'}`, {
      method: 'POST',
      headers: JSON_POST,
      body: JSON.stringify({ followeeName })
    });
    const b = (await res.json().catch(() => null)) as
      | { ok?: boolean; following?: boolean; error?: string }
      | null;
    if (res.ok && b?.ok) return { status: 'ok', following: !!b.following };
    return { status: 'error', message: friendly(res.status, b?.error) };
  } catch {
    return { status: 'error', message: 'Network error — please try again.' };
  }
}

/**
 * Edit an existing lite post. The publisher re-broadcasts the same permlink, which
 * Hive treats as an edit; the on-chain parent is pinned server-side and never
 * changes (the chain forbids it).
 */
export async function editLitePost(
  postId: string,
  input: Omit<LitePostInput, 'editOfPostId'>
): Promise<LiteWriteResult> {
  return createLitePost({ ...input, editOfPostId: postId });
}

/**
 * Delete a lite post. Hidden from Lumen immediately; the on-chain object is removed
 * if Hive still allows it (no replies, no net-positive votes, not paid out) and
 * otherwise blanked. Either way this resolves as a success.
 */
export async function deleteLitePost(postId: string): Promise<LiteWriteResult> {
  try {
    const res = await fetch(`/api/lite/posts/${encodeURIComponent(postId)}`, {
      method: 'DELETE',
      headers: JSON_POST
    });
    const b = (await res.json().catch(() => null)) as
      | { status?: string; error?: string; message?: string }
      | null;
    if (!res.ok || b?.status !== 'ok') {
      return { status: 'error', message: b?.message || friendly(res.status, b?.error) };
    }
    return { status: 'ok' };
  } catch {
    return { status: 'error', message: 'Network error — please try again.' };
  }
}
