import { liteConfig } from '../config';
import * as users from '../repositories/user-repository';
import * as rateRepo from '../repositories/rate-limit-repository';
import * as posts from '../repositories/post-repository';
import { getUserCaps } from './trust';
import { ageDays, dayKey } from './windows';

/**
 * High-level rate enforcement (spec §H). Per-account intake caps are the bot-farm
 * control; per-IP signup caps are the second, independent limiter. Both enforced
 * at DB-intake so spam can't even land in the feed.
 */

export type RateResult = { ok: true } | { ok: false; reason: string };

export async function enforcePostRate(
  userId: string,
  action: 'post' | 'comment'
): Promise<RateResult> {
  const user = await users.findUserById(userId);
  if (!user) return { ok: false, reason: 'unknown_user' };
  // publishedPosts is a real signal (trust_score is written by nothing), so the tier
  // can actually grow instead of everyone sitting on T0 forever.
  const published = await posts.countPublishedByUser(userId);
  const caps = getUserCaps(user.trustScore, ageDays(user.createdAt), published);
  const limit = action === 'comment' ? caps.commentsPerDay : caps.postsPerDay;
  const allowed = await rateRepo.checkAndConsume(`user:${userId}`, action, limit, dayKey());
  return allowed ? { ok: true } : { ok: false, reason: 'daily_cap' };
}

/**
 * Per-account daily cap on EDITS.
 *
 * Edits were exempt from every limit, which made them a queue-starvation vector:
 * every edit is another broadcast, the publishing account can only broadcast about
 * 20 things a minute in total, and Hive imposes no edit limit of its own (the old
 * 24-hour edit window is dead code past HF17). So an edit loop could stall every
 * other user's posts. Generous enough that real editing never notices.
 */
export async function enforceEditRate(userId: string): Promise<RateResult> {
  const allowed = await rateRepo.checkAndConsume(
    `user:${userId}`,
    'edit',
    liteConfig.editsPerDay,
    dayKey()
  );
  return allowed ? { ok: true } : { ok: false, reason: 'daily_edit_cap' };
}

/**
 * Per-account daily cap on image uploads.
 *
 * Every lite upload is signed by the shared publishing account, so a flood is spent
 * against OUR standing with the image host and would degrade uploads for every other
 * lite user — the cost does not land on the account causing it. That asymmetry is
 * the whole reason this cap exists.
 */
export async function enforceUploadRate(userId: string): Promise<RateResult> {
  const allowed = await rateRepo.checkAndConsume(
    `user:${userId}`,
    'upload',
    liteConfig.uploadsPerDay,
    dayKey()
  );
  return allowed ? { ok: true } : { ok: false, reason: 'daily_upload_cap' };
}

/**
 * Per-account daily cap on upgrade attempts (both the status check and the create).
 *
 * Every attempt that reaches the account creator can trigger an on-chain `claim_account`
 * to top up the token pool, which spends the creator account's Resource Credits — a
 * shared, exhaustible resource that every other user's upgrade depends on. Generous:
 * a real person upgrades once, with a few retries at worst.
 */
export async function enforceUpgradeRate(userId: string): Promise<boolean> {
  return rateRepo.checkAndConsume(`user:${userId}`, 'upgrade', liteConfig.upgradeAttemptsPerDay, dayKey());
}

/**
 * Per-IP cap on cheap read lookups — currently the name-availability check.
 *
 * That endpoint was completely uncapped and fans out to TWO Hive API calls per
 * request, so it was free ammunition against Hive as well as an enumeration
 * surface. Generous, because a real person typing a name triggers it repeatedly.
 */
export async function enforceLookupRate(ip: string): Promise<boolean> {
  return rateRepo.checkAndConsume(`ip:${ip}`, 'lookup', liteConfig.lookupPerIpPerDay, dayKey());
}

/** Per-IP signup cap — an independent limiter from the per-account caps (§H). */
export async function enforceSignupRate(ip: string): Promise<boolean> {
  return rateRepo.checkAndConsume(`ip:${ip}`, 'signup', liteConfig.signupPerIpPerDay, dayKey());
}

/**
 * Per-IP cap on the BTC challenge/verify funnel steps (ECON-1-SIBLING, PRUNED
 * 2026-07-22) — the two most-upstream endpoints previously had NO per-source
 * cap, allowing unbounded challenge-row creation. Keyed on the trusted-boundary
 * IP, using the same daily budget as signup.
 */
export async function enforceChallengeRate(
  ip: string,
  scope: 'btc' | 'evm' | 'google' = 'btc'
): Promise<boolean> {
  // Per-chain bucket. This used to be one hardcoded 'btc_challenge' counter shared
  // by BOTH chains AND consumed twice per login (challenge + verify), so the real
  // ceiling was ~10 logins/day/IP across all wallets — which blocks legitimate
  // users behind office/mobile NAT long before it inconveniences an attacker.
  // Also given its own budget, an order of magnitude above signup: proving you own
  // a wallet is cheap and repeatable, creating an account is not.
  return rateRepo.checkAndConsume(
    `ip:${ip}`,
    `${scope}_challenge`,
    liteConfig.challengePerIpPerDay,
    dayKey()
  );
}

/**
 * Platform-wide signup velocity backstop (ECON-1 hardening, PRUNED 2026-07-22) —
 * bounds TOTAL new accounts per day even if an attacker rotates IPs past the
 * per-IP cap. The Reddit/Facebook-style global new-account ceiling; a
 * circuit-breaker set well above organic volume, not a per-user quota.
 */
export async function enforceGlobalSignupRate(): Promise<boolean> {
  return rateRepo.checkAndConsume('global', 'signup', liteConfig.signupGlobalPerDay, dayKey());
}

/** Off-chain follows feed ranking, so they are capped too (§H). Uses the likes tier. */
export async function enforceFollowRate(userId: string): Promise<boolean> {
  const user = await users.findUserById(userId);
  if (!user) return false;
  const caps = getUserCaps(user.trustScore, ageDays(user.createdAt));
  return rateRepo.checkAndConsume(`user:${userId}`, 'follow', caps.likesPerDay, dayKey());
}

/**
 * Follow cap for a full Hive account acting on Lumen — following a lite user, which
 * cannot be a chain operation.
 *
 * It gets its own counter because there is no Lumen row to read trust or age from,
 * and a flat, generous cap is honest about that. The Sybil pressure is also lower
 * here: a Hive account costs real money or a creation token to make, whereas a lite
 * account is free, which is exactly what the tiered caps above exist to bound.
 */
export async function enforceHiveFollowRate(hiveName: string): Promise<boolean> {
  return rateRepo.checkAndConsume(
    `hive:${hiveName}`,
    'follow',
    liteConfig.hiveFollowsPerDay,
    dayKey()
  );
}
