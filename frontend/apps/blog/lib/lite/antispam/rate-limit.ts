import { liteConfig } from '../config';
import * as users from '../repositories/user-repository';
import * as rateRepo from '../repositories/rate-limit-repository';
import * as posts from '../repositories/post-repository';
import { getUserCaps } from './trust';
import { ageDays, dayKey, hourKey } from './windows';

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
 * Per-IP cap on cheap read lookups — the SIGNUP-FUNNEL reads: name availability,
 * name suggestions, follow state.
 *
 * Those endpoints were completely uncapped and fan out to Hive API calls per
 * request, so they were free ammunition against Hive as well as an enumeration
 * surface. Generous, because a real person typing a name triggers it repeatedly.
 *
 * ★ DO NOT ADD NEW CALLERS TO THIS BUCKET WITHOUT READING enforceStreakRate BELOW.
 * A shared bucket means the noisiest caller decides whether the quietest one is
 * allowed to run — see the streak-route incident recorded there.
 */
export async function enforceLookupRate(ip: string): Promise<boolean> {
  return rateRepo.checkAndConsume(`ip:${ip}`, 'lookup', liteConfig.lookupPerIpPerDay, dayKey());
}

/**
 * Per-IP daily cap on the chain-derived retention lookup (`/api/streak/[user]`).
 *
 * ★ WHY THIS IS NOT `enforceLookupRate`. It used to be, and that was a
 * self-inflicted outage waiting for traffic. The `lookup` bucket is the
 * SIGNUP-FUNNEL budget (name check, name suggest, follow state), default 300 per
 * IP per day. The retention card fires on essentially every logged-in page load,
 * which is one to two orders of magnitude more traffic than the whole signup
 * funnel — so the streak route would spend the entire shared budget and then
 * 429 the site's own name-availability check. New users could not pick a
 * username because existing users were reading their profiles. Two endpoints
 * with completely different call rates must never share one counter; this is the
 * same fault as F-L14 (vote/reblog draining the `follow` budget), one layer up.
 *
 * SIZING. After the cache/limiter reorder in the streak route, this meters only
 * cache MISSES — the path that actually fans ~50 upstream Hive calls (bounded by
 * a 6s per-call timeout and a 20s whole-route budget). Warm reads are free and
 * unmetered, so the honest browsing rate barely touches this; the ceiling exists
 * to bound a script, and to keep one NAT'd office or mobile-carrier egress IP
 * from being locked out by its own neighbours.
 *
 * CONFIG NOTE: read straight from the environment rather than from `liteConfig`
 * only because `lib/lite/config.ts` is owned by another lane right now. It
 * belongs beside `lookupPerIpPerDay` and should move there when that file is
 * free — same name, same default, no behaviour change.
 */
const STREAK_PER_IP_PER_DAY = envPositiveInt('LITE_STREAK_PER_IP_PER_DAY', 1000);

export async function enforceStreakRate(ip: string): Promise<boolean> {
  return rateRepo.checkAndConsume(`ip:${ip}`, 'streak', STREAK_PER_IP_PER_DAY, dayKey());
}

/**
 * Per-IP daily cap on the Magi (VSC) GraphQL proxy routes — creator-tokens and
 * prediction-market (`app/api/creator-tokens/gql`, `app/api/prediction-market/gql`).
 *
 * Adversarial review, 2026-08-11: those two routes forward a client-chosen
 * `variables` payload to a real upstream node on every call, holding a server
 * connection for up to 10s (their own `UPSTREAM_TIMEOUT_MS`), with no cap on
 * how fast a caller could drive them. Not an open relay — the upstream host is
 * read from `process.env` only and the query itself is exact-match allowlisted
 * — but with nothing metering the RATE, anyone on the internet could drive our
 * server into hammering the Magi node as fast as they could send requests.
 *
 * SCOPED, NOT SHARED — same shape as `enforceChallengeRate`'s `btc`/`evm`/`google`
 * split, and for the same reason `enforceStreakRate` above got its own bucket
 * instead of joining `lookup`: these two routes are NOT equally hot. Read
 * `enforceStreakRate`'s doc for the incident this caused once already (the
 * streak route briefly shared the signup funnel's `lookup` bucket and 429'd the
 * site's own name-availability check). The creator-tokens price chip and the
 * prediction-market poll refetch on their own 15-45s intervals
 * (`use-token-price-chip.ts`, `use-market.ts`, `use-live-token-market.ts`, …)
 * with `cache: 'no-store'` and NO server-side cache in front of either proxy —
 * unlike the streak route, every single client refetch reaches this limiter,
 * not just cache misses — so a shared counter would let one feature's normal
 * polling volume 429 the other's.
 *
 * SIZING. No cache to lean on, so this has to clear honest continuous polling
 * at the hottest known interval (15s ⇒ 5,760/day for one tab left open and
 * focused all day) with headroom for more than one hook per page and more than
 * one real user behind a shared/NAT IP, while still being a real ceiling
 * against a script. Generous by the same philosophy as every other cap in this
 * file — it exists to bound cost, not to meter honest use.
 *
 * FAIL-OPEN ON A LIMITER OUTAGE, deliberately, same posture as
 * `enforceStreakRate`. Both GQL proxy routes work independently of the
 * lite-accounts feature (they gate only on their own `REACT_APP_*_GQL_URL`,
 * never on `liteConfig.enabled`/`assertLiteEnabled`), so a Postgres hiccup — or
 * a deploy that has creator-tokens/prediction-market provisioned but the
 * lite-accounts datastore not yet — must not take chain reads offline. Callers
 * are expected to wrap this in the same try/catch-and-proceed the streak route
 * uses.
 *
 * Bounding `variables.keys` itself (the upstream's own documented 1..100 range,
 * `getStateByKeys`, schema.graphql:813) is a SEPARATE control enforced directly
 * in each route — this function only bounds how often a caller may ask at all.
 */
const MAGI_GQL_PER_IP_PER_DAY = envPositiveInt('LITE_MAGI_GQL_PER_IP_PER_DAY', 10_000);

/**
 * ★ SUBMITS GET THEIR OWN, MUCH SMALLER BUDGET (2026-08-20). The 10,000/day
 * above is sized for READS — 15-45s polling from every open tab. A wallet-signed
 * SUBMIT is a different animal: it is non-idempotent, it consumes a nonce slot,
 * it costs the signer resource credits, and every real one requires a human to
 * approve a wallet prompt. Nobody legitimately signs 10,000 transactions a day,
 * and sharing the read bucket would mean a submit flood silently eats the read
 * budget for the same IP and takes that user's chain reads offline with it.
 */
const MAGI_SUBMIT_PER_IP_PER_DAY = envPositiveInt('LITE_MAGI_SUBMIT_PER_IP_PER_DAY', 500);

export type MagiGqlScope = 'creator_tokens' | 'prediction_market' | 'creator_tokens_submit';

export async function enforceMagiGqlRate(ip: string, scope: MagiGqlScope): Promise<boolean> {
  const limit = scope === 'creator_tokens_submit' ? MAGI_SUBMIT_PER_IP_PER_DAY : MAGI_GQL_PER_IP_PER_DAY;
  return rateRepo.checkAndConsume(`ip:${ip}`, `${scope}_gql`, limit, dayKey());
}

/**
 * Per-IP daily cap on the Hivesense REST proxy (`app/api/hivesense`) — same
 * shape and same reason as `enforceMagiGqlRate` above (2026-08-11): that route
 * used to call a cross-origin third-party API straight from the browser (CORS
 * broke the status probe permanently), fixed with a same-origin proxy that now
 * needs its own rate floor, since nothing upstream of it bounds request rate
 * either.
 *
 * OWN BUCKET, NOT `enforceMagiGqlRate`'s — deliberately, for the same reason
 * `enforceStreakRate` and `enforceMagiGqlRate` itself don't share one: this
 * route is called on every post-detail page view (a status probe cached
 * app-wide with `staleTime: Infinity`, cheap — plus one "similar posts" fetch
 * per post navigated to, NOT cached across posts), which is a different
 * traffic shape than the two GQL proxies' 15-45s polling. A shared counter
 * would let one feature's normal volume 429 the other's.
 *
 * FAIL-OPEN ON A LIMITER OUTAGE, same posture as every other best-effort call
 * site in this file — "similar posts" is a read-only enhancement, not core
 * functionality, and a Postgres hiccup must not take it offline.
 */
const HIVESENSE_PER_IP_PER_DAY = envPositiveInt('LITE_HIVESENSE_PER_IP_PER_DAY', 10_000);

export async function enforceHivesenseRate(ip: string): Promise<boolean> {
  return rateRepo.checkAndConsume(`ip:${ip}`, 'hivesense', HIVESENSE_PER_IP_PER_DAY, dayKey());
}

/**
 * Read a positive integer from the environment, falling back on anything that is
 * not one. The empty string matters here: `.env` files ship these keys PRESENT
 * AND EMPTY as documentation, and `Number('')` is 0 — which `checkAndConsume`
 * treats as "deny everything". An unset limit must mean "use the default", never
 * "429 every caller".
 */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Per-IP signup cap — an independent limiter from the per-account caps (§H). */
export async function enforceSignupRate(ip: string): Promise<boolean> {
  if (!(await rateRepo.checkAndConsume(`ip:${ip}`, 'signup', liteConfig.signupPerIpPerDay, dayKey()))) {
    return false;
  }
  // F-L33: hourly sub-cap blunts the 00:00-UTC boundary burst the daily fixed window allows.
  return rateRepo.checkAndConsume(`ip:${ip}`, 'signup', hourlySubCap(liteConfig.signupPerIpPerDay), hourKey());
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

// F-L33: an hourly sub-cap alongside the daily one blunts the boundary burst a
// fixed-window daily counter allows (up to 2× the daily limit spent across 00:00 UTC).
// ~1/6 of the daily budget, so steady honest use is never touched.
function hourlySubCap(dailyLimit: number): number {
  return Math.max(1, Math.ceil(dailyLimit / 6));
}

async function enforceGlobalDaily(action: string, dailyLimit: number): Promise<boolean> {
  if (!(await rateRepo.checkAndConsume('global', action, dailyLimit, dayKey()))) return false;
  return rateRepo.checkAndConsume('global', action, hourlySubCap(dailyLimit), hourKey());
}

/**
 * F-L30: the SCARCE new-account velocity cap — consumed ONLY when an account is
 * actually created (inside completeSignup), so failed name attempts (name_taken,
 * name_on_chain, vetting retries) can no longer drain it and deny real users.
 */
export async function enforceSignupSuccessRate(): Promise<boolean> {
  return enforceGlobalDaily('signup_success', liteConfig.signupGlobalPerDay);
}

/**
 * F-L30: the every-attempt global ceiling (success OR failure). Restores an aggregate
 * bound on the upstream Hive-API amplification that doomed-name retries cause, without
 * the "failed attempts deny real users" bug of the old single shared counter.
 */
export async function enforceSignupAttemptRate(): Promise<boolean> {
  return enforceGlobalDaily('signup_attempt', liteConfig.signupAttemptGlobalPerDay);
}

/**
 * F-L31: aggregate daily cap on the RC-expensive account-creation consumption point
 * (`create_claimed_account`). The per-user enforceUpgradeRate cannot bound a Sybil
 * fleet; this is the platform-wide backstop, consumed in upgrade-service right before
 * the create. Gates DEMAND only — pool top-up (supply) is deliberately NOT gated here.
 */
export async function enforceActSpend(): Promise<boolean> {
  return enforceGlobalDaily('act_spend', liteConfig.actSpendPerDay);
}

/** Off-chain follows feed ranking, so they are capped too (§H). Uses the likes tier. */
export async function enforceFollowRate(userId: string): Promise<boolean> {
  const user = await users.findUserById(userId);
  if (!user) return false;
  const caps = getUserCaps(user.trustScore, ageDays(user.createdAt));
  return rateRepo.checkAndConsume(`user:${userId}`, 'follow', caps.likesPerDay, dayKey());
}

// F-L14: vote and reblog each get their OWN daily bucket. They shared the 'follow'
// key, so casting votes drained the follow budget (and vice versa) — one engagement
// type could exhaust an unrelated one. Same per-user cap shape, distinct action keys.
export async function enforceVoteRate(userId: string): Promise<boolean> {
  const user = await users.findUserById(userId);
  if (!user) return false;
  const caps = getUserCaps(user.trustScore, ageDays(user.createdAt));
  return rateRepo.checkAndConsume(`user:${userId}`, 'vote', caps.likesPerDay, dayKey());
}

export async function enforceReblogRate(userId: string): Promise<boolean> {
  const user = await users.findUserById(userId);
  if (!user) return false;
  const caps = getUserCaps(user.trustScore, ageDays(user.createdAt));
  return rateRepo.checkAndConsume(`user:${userId}`, 'reblog', caps.likesPerDay, dayKey());
}

/**
 * Blocking gets its OWN daily bucket — not the follow one.
 *
 * F-L14's lesson, applied before it can bite again: vote and reblog once shared the
 * `follow` key, so casting votes silently exhausted an unrelated budget. A block is
 * far more consequential than a follow (it removes other people's comments from a
 * page), so a user must never find they cannot block because they spent the day
 * following. Capped all the same: every block writes a row and re-draws a sequence,
 * and unblock is capped for the same reason follows are — churn is the abuse shape.
 */
export async function enforceBlockRate(userId: string): Promise<boolean> {
  const user = await users.findUserById(userId);
  if (!user) return false;
  const caps = getUserCaps(user.trustScore, ageDays(user.createdAt));
  return rateRepo.checkAndConsume(`user:${userId}`, 'block', caps.likesPerDay, dayKey());
}

/** As above, for a full Hive account: no Lumen row to score, so a flat cap. */
export async function enforceHiveBlockRate(hiveName: string): Promise<boolean> {
  return rateRepo.checkAndConsume(`hive:${hiveName}`, 'block', liteConfig.hiveFollowsPerDay, dayKey());
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

/**
 * The platform-wide daily ceiling on chain broadcasts by the shared publisher
 * key. See `liteConfig.publisherGlobalPerDay` for the sizing argument.
 *
 * Consumed at the moment a broadcast is about to happen — not when a post is
 * accepted — so a queued job that never broadcasts (deleted, moderated, parent
 * vanished) does not spend the budget, and a retry of a failed broadcast does
 * not spend it twice for one post.
 *
 * Returns false to mean "hold": the caller should leave the job queued rather
 * than fail it. A daily ceiling is a pacing signal, not a rejection.
 */
export async function enforcePublisherGlobalRate(): Promise<boolean> {
  return enforceGlobalDaily('publisher_broadcast', liteConfig.publisherGlobalPerDay);
}

/**
 * ★ EACH OF THESE HAS ITS OWN BUCKET, AND THAT IS THE WHOLE POINT.
 *
 * The first version of these four limits reused `enforceLookupRate`, which is
 * the SIGNUP-FUNNEL budget (`lookup`, 300 per IP per day — name check, name
 * suggest, follow state). This file already documents, twenty lines above, why
 * that is wrong: the streak route was moved OFF that bucket precisely because a
 * high-traffic endpoint sharing it "would spend the entire shared budget and
 * then deny real signups". Feed refresh and follower-list browsing are exactly
 * that kind of traffic. Reusing the bucket would have limited the routes AND
 * broken signup, which is a worse outcome than the missing limit it replaced.
 *
 * Sized by what each endpoint actually costs and how often an honest user hits
 * it, not by a shared round number.
 */

/** Feed refresh fans out to Hive (up to MAX_CHAIN_AUTHORS bridge calls). Costly, user-initiated. */
export async function enforceFeedRefreshRate(ip: string): Promise<boolean> {
  return rateRepo.checkAndConsume(
    `ip:${ip}`,
    'feed_refresh',
    envPositiveInt('LITE_FEED_REFRESH_PER_IP_PER_DAY', 1_000),
    dayKey()
  );
}

/** Public follower/following browsing. Cheap per call, but unbounded scraping is the concern. */
export async function enforceFollowListRate(ip: string): Promise<boolean> {
  return rateRepo.checkAndConsume(
    `ip:${ip}`,
    'follow_list',
    envPositiveInt('LITE_FOLLOW_LIST_PER_IP_PER_DAY', 3_000),
    dayKey()
  );
}

/** Profile and interests writes. One parameterised UPDATE each; nobody edits these often. */
export async function enforceProfileWriteRate(userId: string): Promise<boolean> {
  return rateRepo.checkAndConsume(
    `user:${userId}`,
    'profile_write',
    envPositiveInt('LITE_PROFILE_WRITE_PER_DAY', 200),
    dayKey()
  );
}
