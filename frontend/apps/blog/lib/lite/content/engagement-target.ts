import type { LumenUser } from '@/blog/lib/lite/types';
import { liteConfig } from '@/blog/lib/lite/config';
import { resolveByHive } from '@/blog/lib/lite/repositories/post-repository';

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

/**
 * A published lite post's permlink, as buildPermlink() mints it: `lumen-<lc ULID>`.
 * Crockford base32 excludes i, l, o and u.
 */
const LITE_PERMLINK_RE = /^lumen-[0-9a-hjkmnp-tv-z]{26}$/;

/**
 * ★ B5 (2026-08-06). Whether a target that is ONE OF OUR OWN lite posts may
 * still be engaged with or reported on. `true` for everything else — a native
 * Hive post is not ours to gate, and requiring a `lumen_post` row in general
 * would reject the legitimate case this module's docstring protects.
 *
 * Shared by the WRITE path (`checkEngagementTarget`) and the READ path
 * (`GET /api/lite/engagement`) deliberately: QA found the two disagreeing —
 * `posts/:id` 404'd a hidden post while `engagement` happily served its live,
 * still-incrementable counts. Two call sites, one predicate, so they cannot
 * drift apart again.
 */
export async function liteTargetServable(author: string, permlink: string): Promise<boolean> {
  const a = author.trim().toLowerCase();
  const p = permlink.trim().toLowerCase();
  const frontend = liteConfig.frontendAccount.toLowerCase();
  if (!frontend || a !== frontend || !LITE_PERMLINK_RE.test(p)) return true;
  try {
    const target = await resolveByHive(liteConfig.frontendAccount, p);
    if (!target) return true; // not one of ours after all
    return target.feedVisibility === 'visible' && !target.deletedLocally;
  } catch {
    // Cannot prove it is hidden => do not silently hide it. The WRITE path is
    // the one that must fail closed, and it resolves the row itself.
    return true;
  }
}

export async function checkEngagementTarget(
  user: LumenUser,
  author: string,
  permlink: string
): Promise<TargetCheck> {
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

  // ★ THE SELF-CHECK ABOVE IS NOT ENOUGH FOR OUR OWN POSTS (found 2026-08-01).
  //
  // Every PUBLISHED lite post is authored on chain by the shared publishing
  // account, not by its lite author — so `own.has(a)` compares the caller's
  // handle against `frontendAccount` and never matches. The permlink is
  // `lumen-<own postId>` (publisher/permlink.ts), which the author can derive
  // from their own post. So a caller could self-vote simply by addressing their
  // post through its CHAIN coordinates instead of its Lumen ones, which is
  // precisely what this guard exists to refuse.
  //
  // The comment below still stands for TARGETS THAT ARE NOT OURS: we must not
  // require a lumen_post row in general, because a lite user legitimately votes
  // on native Hive posts. The fix is to resolve ONLY when the target looks like
  // one of ours — same author, and the exact permlink shape we mint — so this
  // costs one indexed lookup on that narrow shape and nothing at all otherwise.
  const frontend = liteConfig.frontendAccount.toLowerCase();
  if (frontend && a === frontend && LITE_PERMLINK_RE.test(p)) {
    const target = await resolveByHive(liteConfig.frontendAccount, p);
    if (target && target.userId === user.userId) {
      return { ok: false, code: 'self_engagement', status: 400 };
    }
    // ★★★ B5 (2026-08-06) — A TAKEN-DOWN POST STOPS EARNING.
    //
    // `lumen_vote`/`lumen_reblog` key on free-text `(author, permlink)` with no
    // FK to `lumen_post` and no visibility check anywhere, so a post a moderator
    // hid kept accruing votes and reblogs forever. Proven over HTTP during QA:
    // `GET /api/lite/posts/:id` returned 404 while `GET /api/lite/engagement`
    // returned 200 with live, still-incrementable counts for the same post.
    //
    // That is not a cosmetic leak. This project's ENTIRE abuse strategy is
    // report-and-take-down, so a hidden post that remains farmable means the
    // takedown does not stop the thing it exists to stop — and lite engagement
    // feeds the ranker's organic breadth, so those counts have a live consumer.
    //
    // The check costs NOTHING extra: the row is already fetched immediately
    // above for the self-engagement guard. It applies only to OUR OWN posts, so
    // the deliberate design note above still holds in full — a lite user voting
    // on a native Hive post is never resolved and never blocked.
    if (target && (target.feedVisibility !== 'visible' || target.deletedLocally)) {
      return { ok: false, code: 'target_unavailable', status: 404 };
    }
  }

  return { ok: true };
}
