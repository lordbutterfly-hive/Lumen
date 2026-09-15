import { getLogger } from '@ui/lib/logging';
import { getAccountFull } from '@transaction/lib/hive-api';
import type { FullAccount } from '@hive/common-hiveio-packages/wax';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { liteAccountAsProfile } from '@/blog/lib/lite/render/lite-account';
import { isKeylessLiteName } from '@/blog/lib/lite/render/lite-identity';
import { isSafeExternalHref } from '@/blog/components/safe-external-link';
import { HIVE_USERNAME, normalizeCreatorHandle } from '@/blog/lib/meritum/creator-handle';
import { sanitizeAbout, sanitizeProfileImage, type CreatorProfileFields } from '@/blog/lib/meritum/profile-fields';

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
 * `SafeExternalLink` applies (imported, not re-implemented). `about` and
 * `profileImage` go through `lib/meritum/profile-fields.ts` (see its header):
 * plain text with controls stripped and a length cap; an `https:` URL with a
 * host and nothing else. Defense in depth: a caller that skipped the
 * render-time gates must still never receive a `javascript:` string.
 *
 * ★ NEVER THROWS. A malformed handle, a chain read that throws, a lite lookup
 * that throws — every path answers the null shape. This is metadata ABOUT a
 * page; it must never take the page down.
 */
export const NULL_PROFILE: CreatorProfileFields = { website: null, displayName: null, about: null, profileImage: null };

const HIVE_TTL_MS = 60_000;

export async function readCreatorProfile(rawHandle: string): Promise<CreatorProfileFields> {
  const trimmed = (rawHandle ?? '').trim();
  if (!trimmed) return NULL_PROFILE;
  const handle = normalizeCreatorHandle(trimmed);
  if (!handle) return NULL_PROFILE;

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
      } else if (HIVE_USERNAME.test(lower)) {
        try {
          // Own namespaced cache key and TTL: sharing `/api/account`'s key would
          // couple two routes' freshness through one module-level Map.
          account = await cachedRead(`creator-profile:hive:${lower}`, HIVE_TTL_MS, () => getAccountFull(lower));
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
      }
    }

    const profile = (account?.profile ?? {}) as Record<string, unknown>;
    const rawWebsite = profile.website;
    const website = typeof rawWebsite === 'string' && rawWebsite && isSafeExternalHref(rawWebsite) ? rawWebsite : null;
    const rawName = (typeof profile.name === 'string' && profile.name) || account?.name;
    const displayName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;

    return {
      website,
      displayName,
      about: sanitizeAbout(profile.about),
      profileImage: sanitizeProfileImage(profile.profile_image)
    };
  } catch (error) {
    logger.error(error, 'creator-profile: unexpected failure for %s', handle);
    return NULL_PROFILE;
  }
}
