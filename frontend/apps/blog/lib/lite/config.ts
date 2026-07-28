import { siteConfig } from '@ui/config/site';

/**
 * Lite-accounts feature configuration.
 *
 * SECRETS ARE NEVER READ HERE. The frontend Hive account's posting/active WIFs
 * live in KMS and are loaded only by the server-side signer (spec §D.2). This
 * module holds public config: which datastore to talk to, which (public) Hive
 * account is the on-chain author per network, and feature flags.
 */

// One frontend Hive account per network — it is the on-chain author for every
// proxy post and appends the `Posted via Lumen by {name}` footer (spec §D.1).
// The account *name* is public; its keys are not and never appear in this file.
const FRONTEND_ACCOUNTS: Record<string, string> = {
  mainnet: process.env.LITE_FRONTEND_ACCOUNT_MAINNET || '',
  mirrornet: process.env.LITE_FRONTEND_ACCOUNT_MIRRORNET || '',
  testnet: process.env.LITE_FRONTEND_ACCOUNT_TESTNET || ''
};

export const liteConfig = {
  /** Postgres connection string. Empty until infra is provisioned. */
  databaseUrl: process.env.LITE_DATABASE_URL || '',
  /** The on-chain author account for this network (public name only). */
  frontendAccount: FRONTEND_ACCOUNTS[siteConfig.chainEnv] || '',
  chainEnv: siteConfig.chainEnv,
  /** Master kill-switch — lite accounts stay dark until infra + legal sign-off. */
  enabled: process.env.LITE_ACCOUNTS_ENABLED === 'yes',
  /** Session lifetime — matches the oidc.ts 14-day convention (spec §A.5). */
  sessionTtlDays: 14,
  dbPoolMax: Number(process.env.LITE_DB_POOL_MAX || 10),
  /**
   * Hybrid storage: after a post is published to Hive (the source of truth), drop
   * the stored body and keep only the mapping (author/permlink -> user_id). Trades
   * feed speed (more Hive reads) for minimal content-at-rest. Off by default —
   * the DB doubles as a fast, rebuildable read-cache until you opt in.
   */
  pruneBodyAfterPublish: process.env.LITE_PRUNE_BODY_AFTER_PUBLISH !== 'no', // default TRUE — Hive is source of truth (decision 2026-07-22)
  /** Cloudflare Turnstile secret for signup CAPTCHA (empty = disabled). */
  turnstileSecret: process.env.LITE_TURNSTILE_SECRET || '',
  /**
   * Per-account daily EDIT cap. Every edit is another broadcast competing for the
   * publishing account's ~20-per-minute budget, and Hive itself imposes no edit
   * limit, so this is the only bound. Generous: real editing never hits it.
   */
  editsPerDay: Number(process.env.LITE_EDITS_PER_DAY || 40),
  /**
   * Per-IP daily cap on wallet challenge/verify attempts. Separate from (and much
   * larger than) the signup cap: proving wallet ownership is cheap and repeated on
   * every login, so sharing the signup budget locked out NAT'd users.
   */
  challengePerIpPerDay: Number(process.env.LITE_CHALLENGE_PER_IP_PER_DAY || 200),
  /**
   * Per-IP daily cap on name-availability lookups. Uncapped it was free ammunition
   * against Hive's API (two upstream calls per request) and an enumeration surface.
   */
  lookupPerIpPerDay: Number(process.env.LITE_LOOKUP_PER_IP_PER_DAY || 300),
  /** Per-IP signup cap per day (anti-Sybil, §H). */
  signupPerIpPerDay: Number(process.env.LITE_SIGNUP_PER_IP_PER_DAY || 20),
  /**
   * GLOBAL signup velocity cap per day — a platform-wide backstop against
   * distributed IP rotation (ECON-1 hardening, PRUNED 2026-07-22). Mirrors the
   * Reddit/Facebook "new-account velocity" ceiling: even if an attacker rotates
   * IPs past the per-IP cap, total new lite accounts per day are bounded. Set
   * generously above real organic signup — it is a circuit-breaker, not a quota.
   */
  signupGlobalPerDay: Number(process.env.LITE_SIGNUP_GLOBAL_PER_DAY || 5000),
  /**
   * Number of trusted reverse proxies in front (e.g. a single Caddy). The client
   * IP is read as the X-Forwarded-For entry this many hops from the right — the
   * value OUR infrastructure appended — never the attacker-controllable leftmost
   * token (ECON-1, PRUNED 2026-07-22). Must match the real deployment topology.
   */
  trustedProxyCount: Math.max(1, Number(process.env.LITE_TRUSTED_PROXY_COUNT || 1)),
  // Lite posts REJECT all rewards (decision 2026-07-23): no per-user earnings
  // ledger, no platform beneficiary. A lite user earns only on their own Hive
  // account after upgrading, so there is no money to collect, hold, or settle
  // here — the entire earnings subsystem was removed.
  /** Shared secret for the recsys ingestion endpoints (empty = endpoints disabled). */
  recsysToken: process.env.LITE_RECSYS_TOKEN || '',
  /**
   * DEV-ONLY posting WIF for the publisher account. Production MUST leave this
   * empty and inject a KMS-backed broadcaster via `setBroadcaster` instead — an
   * env-var private key is a dev convenience, not a deployment pattern. The
   * bootstrap refuses to use this in production (see publisher/hive-broadcaster).
   */
  publisherPostingWif: process.env.LITE_PUBLISHER_POSTING_WIF || '',
  /**
   * Publishing stops below this percentage of the account's resource credits, so a
   * funding problem becomes a delay instead of a queue of permanently failed posts.
   * The queue is durable — waiting costs nothing.
   */
  rcFloorPercent: Number(process.env.LITE_RC_FLOOR_PERCENT || 10),
  /** Shared secret for the moderation endpoints (empty = endpoints disabled). */
  moderatorToken: process.env.LITE_MODERATOR_TOKEN || '',
  /** Shared secret for the publisher drain endpoint (empty = endpoint disabled). */
  publisherToken: process.env.LITE_PUBLISHER_TOKEN || '',
  /**
   * How long a freshly created account's keys stay in the encrypted reveal outbox
   * (migration 0015) before the ciphertext is dropped. This is a straight trade: too
   * short and a user who closed the tab loses an account nobody can recover; too long
   * and private keys sit at rest for no reason. Three days covers "I'll do it tomorrow"
   * without becoming storage.
   */
  keyRevealTtlHours: Number(process.env.LITE_KEY_REVEAL_TTL_HOURS || 72),
  /**
   * Children per container post before rotating to a fresh one (decision
   * 2026-07-27: 1000, matching the ~1000-reply pattern observed on LeoThreads).
   * Rotation costs one root post, so it is bounded by Hive's 5-minute root-post
   * rule — keep this high enough that rotation is rare.
   */
  containerMaxChildren: Number(process.env.LITE_CONTAINER_MAX_CHILDREN || 1000)
} as const;

/**
 * Fail-closed guard for any code path that requires a live lite-account backend.
 * Call at the top of API routes/workers so a misconfigured deploy errors loudly
 * instead of silently half-working.
 */
export function assertLiteEnabled(): void {
  if (!liteConfig.enabled) {
    throw new Error('Lite accounts are disabled (set LITE_ACCOUNTS_ENABLED=yes to enable)');
  }
  if (!liteConfig.databaseUrl) {
    throw new Error('LITE_DATABASE_URL is not configured');
  }
  // LS-2 (PRUNED 2026-07-22): never open public signup without CAPTCHA in
  // production. verifyCaptcha() fails OPEN when the secret is unset, so a prod
  // deploy that enables lite but forgets the Turnstile secret would run signup
  // with zero bot protection. Fail closed, loudly.
  if (process.env.NODE_ENV === 'production' && !liteConfig.turnstileSecret) {
    throw new Error('LITE_TURNSTILE_SECRET is required in production before public signup can open (captcha must not fail open)');
  }
}
