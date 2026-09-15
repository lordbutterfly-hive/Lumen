import { getLogger } from '@ui/lib/logging';
import { getAccountFull } from '@transaction/lib/hive-api';
import type { FullAccount } from '@hive/common-hiveio-packages/wax';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { liteAccountAsProfile } from '@/blog/lib/lite/render/lite-account';
import { isKeylessLiteName } from '@/blog/lib/lite/render/lite-identity';
import { isSafeExternalHref } from '@/blog/components/safe-external-link';
import { HIVE_USERNAME, isRoutableCreatorHandle, normalizeCreatorHandle } from '@/blog/lib/meritum/creator-handle';
import {
  sanitizeAbout,
  sanitizeDisplayName,
  sanitizeProfileImage,
  type CreatorProfileFields,
  type CreatorProfileSource
} from '@/blog/lib/meritum/profile-fields';

const logger = getLogger('app');

/**
 * The public profile facts a creator page shows: `website` (WORK-LINK spec
 * B2, 2026-08-30), `displayName`, and — for `/m/<handle>` (handoff §1/§2,
 * 2026-09-15) — `about` and `profileImage`, verbatim from the account's Hive
 * `json_metadata.profile` (a lite account's profile for a lite creator).
 *
 * This used to live inside `/api/creator-profile`; it is a module now because
 * the creator page's metadata and its share card need the SAME answer on the
 * server, and two resolvers for one identity is how the squatter bug below was
 * born. The route calls this and adds headers; nothing else.
 *
 * ★★ SECURITY. Every field here is attacker-controlled text from a chain
 * account with NO server-side validation on the broadcast path. `website` is
 * gated by the exact same `isSafeExternalHref` the render-time
 * `SafeExternalLink` applies (imported, not re-implemented). `about`,
 * `displayName` and `profileImage` go through `lib/meritum/profile-fields.ts`
 * (see its header): plain text with controls stripped and a length cap; an
 * `https:` URL with a host and nothing else. Defense in depth: a caller that
 * skipped the render-time gates must still never receive a `javascript:`
 * string.
 *
 * ★ `source` SAYS WHICH STORE ANSWERED (review, 2026-09-15). A name owned by
 * a lite account also exists as a Hive account (that is what squatting is),
 * and Hive's image proxy answers for the Hive one. Any surface that draws a
 * face for this profile must draw it from the store that answered, never
 * from the name alone — the exact `/api/avatar` incident of 2026-09-11.
 *
 * ★ NEVER THROWS. A malformed handle, a chain read that throws, a lite lookup
 * that throws — every path answers the null shape. This is metadata ABOUT a
 * page; it must never take the page down.
 *
 * ★ SHAPE FIRST, BEFORE ANY STORE IS TOUCHED (review, 2026-09-15): this used
 * to run a Postgres lookup and a Hive RPC for any string, then answer null.
 * Its own bounded cache for the Hive read, not the shared `cachedRead` memo
 * (one 500-entry map shared with `/api/account`, flushed by a crawl of /m/*).
 */
export const NULL_PROFILE: CreatorProfileFields = { website: null, displayName: null, about: null, profileImage: null, source: 'none' };

const HIVE_TTL_MS = 60_000;

const readHiveAccountCached = withTtlCache((name: string) => getAccountFull(name), (name: string) => name, {
  name: 'creator-profile-account',
  ttlMs: HIVE_TTL_MS,
  max: 500
});

export async function readCreatorProfile(rawHandle: string): Promise<CreatorProfileFields> {
  const trimmed = (rawHandle ?? '').trim();
  if (!trimmed) return NULL_PROFILE;
  const handle = normalizeCreatorHandle(trimmed);
  if (!handle || !isRoutableCreatorHandle(handle)) return NULL_PROFILE;
  let source: CreatorProfileSource = 'none';

  try {
    // ★★ CRITICAL, LOAD-BEARING: a did:pkh: identity must NEVER reach the Hive
    // chain lookup. It is not a Hive username, and handing it to
    // `getAccountFull` would send attacker-shaped input to a public RPC.
    // Wallet creators go straight to the lite path, unconditionally.
    const isWalletDid = /^did:pkh:/i.test(handle);
    let account: FullAccount | null = null;

    if (isWalletDid) {
      // KNOWN GAP (tracked: "wallet creator visibility"): there is no
      // did:pkh: -> lumen_user index yet, so this misses for essentially every
      // wallet creator today and degrades to the documented "absent renders
      // nothing" case — never a fabrication, never a throw.
      account = await liteAccountAsProfile(handle).catch((error) => {
        logger.warn(error, 'creator-profile: lite lookup failed for wallet handle %s', handle);
        return null;
      });
      if (account?.name) source = 'lite';
    } else {
      const bare = handle.startsWith('hive:') ? handle.slice('hive:'.length) : handle;
      const lower = bare.toLowerCase();

      /**
       * ★★★ LITE-FIRST FOR A SQUATTED NAME (2026-09-11, the `/api/avatar`
       * ordering bug). A Hive account of the same name as a lite user exists
       * for every squatted name, so "chain first, lite if empty" read the
       * squatter. Resolving ownership first is the whole point on a surface
       * whose job is vouching for an identity.
       */
      if (HIVE_USERNAME.test(lower) && (await isKeylessLiteName(lower))) {
        account = await liteAccountAsProfile(lower).catch((error) => {
          logger.warn(error, 'creator-profile: lite lookup failed for %s', lower);
          return null;
        });
        if (account?.name) source = 'lite';
      } else if (HIVE_USERNAME.test(lower)) {
        try {
          account = await readHiveAccountCached(lower);
          if (account?.name) source = 'hive';
        } catch (error) {
          logger.warn(error, 'creator-profile: chain lookup failed for %s', lower);
          account = null;
        }
      }

      if (!account?.name) {
        // A lite user has no Hive account, so the chain lookup either never
        // ran (bad shape) or came back empty; this is the only other place
        // their profile can live.
        account = await liteAccountAsProfile(lower).catch((error) => {
          logger.warn(error, 'creator-profile: lite lookup failed for %s', lower);
          return null;
        });
        if (account?.name) source = 'lite';
      }
    }

    const profile = (account?.profile ?? {}) as Record<string, unknown>;
    const rawWebsite = profile.website;
    const website = typeof rawWebsite === 'string' && rawWebsite && isSafeExternalHref(rawWebsite) ? rawWebsite : null;

    return {
      website,
      displayName: sanitizeDisplayName(profile.name) ?? sanitizeDisplayName(account?.name),
      about: sanitizeAbout(profile.about),
      profileImage: sanitizeProfileImage(profile.profile_image),
      source
    };
  } catch (error) {
    logger.error(error, 'creator-profile: unexpected failure for %s', handle);
    return NULL_PROFILE;
  }
}
