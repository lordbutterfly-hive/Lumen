import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

/**
 * ★★★ DETECTION DOES NOT REACH THE READER UNTIL THE EDGE AGREES (2026-09-11).
 *
 * The squatter sweep runs every 60s and, on a find, calls `resetSquatterList()` so every
 * worker reloads. That fixes the ORIGIN. It does nothing about the copy Cloudflare is
 * already holding.
 *
 * `lib/anonymous-cache-policy.ts` marks the affected URLs shared-cacheable:
 *   `/@name`                     s-maxage 300,  stale-while-revalidate 3600
 *   `/@name/wallet`              s-maxage 60,   stale-while-revalidate 300
 *   `/@name/<sub-page>`          s-maxage 600,  stale-while-revalidate 3600
 * and Cloudflare does cache them (measured 2026-09-11: `cf-cache-status: EXPIRED` then
 * `HIT` on `/@chadmasters`). A grep of the whole tree for `revalidateTag`,
 * `revalidatePath` or any purge call returns nothing, so a page rendered BEFORE a
 * squatter was detected keeps being served to anonymous readers for up to
 * s-maxage + stale-while-revalidate after the origin has already corrected itself --
 * roughly an hour for a profile. The 60s sweep interval makes the system look far more
 * responsive than a reader actually experiences.
 *
 * ★ THIS IS INERT WITHOUT CREDENTIALS, ON PURPOSE, AND IT SAYS SO EVERY TIME.
 * Purging needs a Cloudflare zone id and an API token, which are deployment secrets and
 * are not in this repo. Rather than leave the gap silent, an unconfigured deployment
 * logs a WARN naming the exact stale window it is accepting, once per detection. Set
 * `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN` (token needs `Zone.Cache Purge`) and
 * `PUBLIC_SITE_ORIGIN`, and it starts working with no code change.
 */
const PURGE_TIMEOUT_MS = 8000;

/** The URLs whose cached copy becomes wrong the moment a name is flagged. */
function urlsFor(origin: string, name: string): string[] {
  const at = `${origin}/@${encodeURIComponent(name)}`;
  // ★ Every sub-path `lib/anonymous-cache-policy.ts` marks shared-cacheable for an
  // account. `/communities` was missing from the first cut (it is in PROFILE_SUBPAGES
  // and cached 600s/3600s, the longest of the lot).
  //
  // ★ KNOWN GAP, STATED RATHER THAN HIDDEN: individual post pages
  // (`/<category>/@name/<permlink>`) are ALSO shared-cacheable and cannot be enumerated
  // from a name alone, so they are not purged here and expire on their own schedule.
  return [at, `${at}/wallet`, `${at}/followers`, `${at}/following`, `${at}/comments`, `${at}/communities`];
}

export async function purgeEdgeCacheForNames(names: string[]): Promise<void> {
  if (names.length === 0) return;

  const zone = process.env.CLOUDFLARE_ZONE_ID ?? '';
  const token = process.env.CLOUDFLARE_PURGE_TOKEN ?? '';
  const origin = (process.env.PUBLIC_SITE_ORIGIN ?? '').replace(/\/+$/, '');

  if (!zone || !token || !origin) {
    logger.warn(
      'edge cache: NOT purged for %d newly flagged name(s) (%s) — CLOUDFLARE_ZONE_ID / CLOUDFLARE_PURGE_TOKEN / PUBLIC_SITE_ORIGIN unset. ' +
        'Cloudflare will keep serving the pre-detection profile to anonymous readers for up to s-maxage + stale-while-revalidate ' +
        '(~65 min for /@name, ~6 min for /@name/wallet). See lib/lite/moderation/purge-edge-cache.ts.',
      names.length,
      names.join(', ')
    );
    return;
  }

  const files = names.flatMap((name) => urlsFor(origin, name));
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
      signal: AbortSignal.timeout(PURGE_TIMEOUT_MS)
    });
    if (!res.ok) {
      logger.warn('edge cache: purge rejected (HTTP %d) for %s', res.status, names.join(', '));
      return;
    }
    logger.warn('edge cache: purged %d URL(s) for newly flagged name(s): %s', files.length, names.join(', '));
  } catch (error) {
    // A purge failure must never take the sweep down; the stale window is the cost.
    logger.warn(error, 'edge cache: purge failed for %s', names.join(', '));
  }
}
