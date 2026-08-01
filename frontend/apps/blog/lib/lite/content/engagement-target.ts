import type { LumenUser } from '@/blog/lib/lite/types';

/**
 * F-L34 — validation for a Lumen-local engagement target (`castVote`, `reblog`).
 *
 * Both routes accepted ANY `(author, permlink)` pair: no shape check, and no
 * check that the target was not the caller's own content. Those rows are read
 * back as displayed counts and are a reach signal for the recsys, so a caller
 * could inflate their own reach for free and in bulk (the per-user rate limit
 * bounds the speed, not the direction).
 *
 * ★ WHY SELF-ENGAGEMENT IS REFUSED RATHER THAN FLAGGED. The audit left this as
 * "reject vs flag for the recsys", pending the vote-target SCOPE question. The
 * scope question does not actually bear on the self case, and the self case has
 * an unambiguous answer here specifically because these votes are Lumen-LOCAL:
 * lite posts decline all rewards, so a self-vote moves no money and confers no
 * benefit except ranking. It has no legitimate use to protect. (On Hive proper a
 * self-vote is legal because it pays — that reasoning does not transfer to a
 * counter that only feeds ranking.)
 *
 * ★ WHAT IS DELIBERATELY *NOT* CHECKED: whether the target exists in
 * `lumen_post`. A lite user can legitimately vote on a NATIVE Hive post shown in
 * their feed, so requiring one of our own rows would reject real engagement.
 * That is the ambiguity the audit flagged, and it stays open by design — the
 * format check below still removes the "any string at all" surface.
 */

/** Hive account-name grammar, which every legitimate target author obeys. */
const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
/** Hive permlink grammar: lowercase alphanumerics and dashes, bounded. */
const PERMLINK_RE = /^[a-z0-9-]{1,256}$/;

export type TargetCheck = { ok: true } | { ok: false; code: string; status: number };

export function checkEngagementTarget(user: LumenUser, author: string, permlink: string): TargetCheck {
  const a = author.trim().toLowerCase();
  const p = permlink.trim().toLowerCase();

  if (!ACCOUNT_RE.test(a)) return { ok: false, code: 'invalid_author', status: 400 };
  if (!PERMLINK_RE.test(p)) return { ok: false, code: 'invalid_permlink', status: 400 };

  // Every name this account answers to: its Lumen handle, its on-chain name once
  // upgraded, and any handle it used previously (renaming must not unlock
  // self-engagement on the back catalogue).
  const own = new Set(
    [user.displayName, user.hiveAccountName, ...(user.displayNameHistory ?? [])]
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .map((n) => n.toLowerCase())
  );
  if (own.has(a)) return { ok: false, code: 'self_engagement', status: 400 };

  return { ok: true };
}
