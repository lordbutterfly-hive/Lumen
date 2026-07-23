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

export function getUserCaps(trustScore: number, accountAgeDays: number): UserCaps {
  if (trustScore >= T2_TRUST) return T2;
  if (accountAgeDays >= T1_AGE_DAYS || trustScore >= T1_TRUST) return T1;
  return T0;
}
