import { liteConfig } from '../config';
import * as users from '../repositories/user-repository';
import * as rateRepo from '../repositories/rate-limit-repository';
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
  const caps = getUserCaps(user.trustScore, ageDays(user.createdAt));
  const limit = action === 'comment' ? caps.commentsPerDay : caps.postsPerDay;
  const allowed = await rateRepo.checkAndConsume(`user:${userId}`, action, limit, dayKey());
  return allowed ? { ok: true } : { ok: false, reason: 'daily_cap' };
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
export async function enforceChallengeRate(ip: string): Promise<boolean> {
  return rateRepo.checkAndConsume(`ip:${ip}`, 'btc_challenge', liteConfig.signupPerIpPerDay, dayKey());
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
