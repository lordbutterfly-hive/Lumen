import env from '@beam-australia/react-env';

/// Contains list of public variables which can have safely set defaults and allow application build without explicit env. definition

export const configuredAIDomain = env('AI_DOMAIN') ?? 'https://api.syncad.com';
/**
 * ★ FALLBACK FIXED (2026-08-28). This is `siteConfig.url` — the renderer's
 * `baseUrl` (`features/post-rendering/lib/renderer.ts`) AND the trusted-origin
 * set for `isLinkSafe` there, AND the OIDC same-origin check
 * (`packages/smart-signer/lib/redirect-validation.ts`, `lib/oidc.ts`). An unset
 * `REACT_APP_SITE_DOMAIN` used to default here to hive.blog — inherited from
 * the upstream Denser/hive.blog fork — which would have classified hive.blog
 * links as "internal" to THIS site and lumensocial.net's own links as
 * external, and pointed the OIDC issuer/redirect allowlist at the wrong
 * origin. Production already sets `REACT_APP_SITE_DOMAIN=https://lumensocial.net`,
 * so this default only bites an env without that var set (a preview/staging
 * build), but the fallback should still name the site it is actually
 * falling back for.
 */
export const configuredSiteDomain = env('SITE_DOMAIN') ?? 'https://lumensocial.net/';
export const configuredImagesEndpoint = (env('IMAGES_ENDPOINT') ?? 'https://images.hive.blog').replace(/\/+$/, '');
export const configuredApiEndpoint = (env('API_ENDPOINT') ?? 'https://api.hive.blog').replace(/\/+$/, '');
export const configuredBlogDomain = (env('BLOG_DOMAIN') ?? 'https://hive.blog/').replace(/\/+$/, '');

/**
 * ★ AN ABSOLUTE URL TO A PATH ON THIS BLOG — use this, never string concatenation.
 *
 * `configuredBlogDomain` ALREADY CARRIES A SCHEME. Every environment sets it that
 * way (`.env.blog` and `.env.blog.example`: `https://blog.openhive.network`;
 * `stack/compose.wallet.yml` builds `https://${PUBLIC_HOSTNAME}:${BLOG_PORT}`), and
 * so does the fallback above. Its NAME says "domain", which is why six separate call
 * sites read it as a bare host and wrote `https://${configuredBlogDomain}${path}` —
 * producing `https://https://hive.blog//@author/permlink`, a URL that does not
 * resolve. Confirmed live: the share dialog's own URL field, its Markdown link, and
 * the Twitter, Reddit, Facebook and LinkedIn share targets were ALL broken. Every
 * way to share a Lumen post off Lumen was emitting a dead link.
 *
 * One helper, so the next person cannot get it wrong by reading the variable name.
 * The trailing-slash strip above (matching `configuredImagesEndpoint` and
 * `configuredApiEndpoint`, which already did this) also removes the `//` the default
 * value contributed. `apps/wallet`'s `getExternalLink` is unaffected — it uses
 * `new URL(path, base)`, which is slash-agnostic.
 */
export function blogUrl(path: string): string {
  return `${configuredBlogDomain}${path.startsWith('/') ? path : `/${path}`}`;
}
/**
 * ★ OPERATOR-PRECEDENCE BUG FIXED (2026-08-23). This read:
 *
 *   env('APP_SESSION_TIME') ?? configuredSiteDomain.includes('wallet') ? 900 : 64800
 *
 * `??` binds TIGHTER than the conditional operator, so it parsed as
 * `(env(...) ?? includes(...)) ? 900 : 64800` — the configured value was used only as a
 * truthiness test and its NUMBER was thrown away. The knob could only ever yield 900 or
 * 64800, and setting it to ANY non-empty value forced 900.
 *
 * ★★ THIS CHANGES A LIVE VALUE, AND THE OWNER SHOULD KNOW WHICH WAY.
 * `.env.blog.example` sets `REACT_APP_APP_SESSION_TIME=64800` (18 hours). Under the bug the
 * blog actually got 900 seconds (15 minutes) — 72x shorter than configured. With the
 * precedence fixed, the configured 64800 now applies, so hb-auth sessions become LONGER,
 * not shorter. That is the configured intent, but a longer session is more exposure: if 15
 * minutes was in fact preferred, change the env value rather than reverting this.
 *
 * Practical reach is small — the only consumer is the hb-auth worker
 * (`packages/common-hiveio-packages/src/hb-auth/hbauth-service.ts`), and Lumen's /login
 * offers Keychain and Google only.
 *
 * Parsed to a NUMBER here rather than left as a string, so the exported value matches its
 * name; a non-numeric or non-positive setting falls back to the per-domain default instead
 * of propagating NaN.
 */
const rawSessionTime = env('APP_SESSION_TIME');
const parsedSessionTime = rawSessionTime ? Number(rawSessionTime) : Number.NaN;
export const configuredSessionTime =
  Number.isFinite(parsedSessionTime) && parsedSessionTime > 0
    ? parsedSessionTime
    : configuredSiteDomain.includes('wallet')
      ? 900
      : 64800;
