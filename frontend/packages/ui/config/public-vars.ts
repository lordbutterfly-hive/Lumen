import env from '@beam-australia/react-env';

/// Contains list of public variables which can have safely set defaults and allow application build without explicit env. definition

export const configuredAIDomain = env('AI_DOMAIN') ?? 'https://api.syncad.com';
export const configuredSiteDomain = env('SITE_DOMAIN') ?? 'https://hive.blog/';
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
export const configuredSessionTime = env('APP_SESSION_TIME') ?? configuredSiteDomain.includes('wallet') ? 900 : 64800;
