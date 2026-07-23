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
  recsysToken: process.env.LITE_RECSYS_TOKEN || ''
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
