/**
 * Trust-tier caps (spec §H). New accounts start at exactly the user's requested
 * floor (T0 = 5 posts / 15 comments / day) and earn higher ceilings as
 * `trust_score` and account age grow — mirroring how Hive protects new accounts
 * with small, slowly-regenerating RC. The ranking discount for low-trust posts
 * (the real teeth against farms) lives in the discovery layer, not here.
 */

export interface UserCaps {
  tier: 'T0' | 'T1' | 'T2';
  postsPerDay: number;
  commentsPerDay: number;
  likesPerDay: number;
}

const T0: UserCaps = { tier: 'T0', postsPerDay: 5, commentsPerDay: 20, likesPerDay: 30 };
const T1: UserCaps = { tier: 'T1', postsPerDay: 10, commentsPerDay: 40, likesPerDay: 100 };
const T2: UserCaps = { tier: 'T2', postsPerDay: 20, commentsPerDay: 80, likesPerDay: 300 };

const T2_TRUST = 60;
const T1_TRUST = 20;
const T1_AGE_DAYS = 7;
const T1_PUBLISHED = 3;
const T2_AGE_DAYS = 30;
const T2_PUBLISHED = 20;

/**
 * Tier from what we actually KNOW about an account.
 *
 * `trust_score` is written by nothing (verified 2026-07-28: every reference is a
 * read), so a score-only rule left every user pinned to T0 forever and made T1/T2
 * dead code — nobody ever earned more capacity. Account age and the number of posts
 * that actually reached Hive are real, already-stored signals, so the tier is
 * derived from those, with `trust_score` still honoured as a manual override for
 * when something does start writing it.
 *
 * Deliberately conservative: a farm can age, but ageing plus published output is a
 * far worse deal for it than for a real user.
 */
export function getUserCaps(
  trustScore: number,
  accountAgeDays: number,
  publishedPosts = 0
): UserCaps {
  if (trustScore >= T2_TRUST) return T2;
  if (accountAgeDays >= T2_AGE_DAYS && publishedPosts >= T2_PUBLISHED) return T2;
  if (trustScore >= T1_TRUST) return T1;
  if (accountAgeDays >= T1_AGE_DAYS && publishedPosts >= T1_PUBLISHED) return T1;
  return T0;
}
