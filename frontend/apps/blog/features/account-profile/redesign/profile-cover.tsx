import { UserAvatarImg } from '@ui/components';

/**
 * Cover banner + overlapping rounded-square avatar (design-handoff-v2,
 * Profile.dc.html). Cover falls back to the brand gradient when the
 * account has no (safe) cover image set — never a broken image / empty box.
 *
 * ★ CONVERGED (F6 item 22). The avatar used to go straight to `/api/avatar`
 * (our own proxy, on every profile page view) and fall back to a generic,
 * non-personalised default picture on error. Now the app's one avatar
 * component: `images.hive.blog` directly, the proxy only as the error path
 * (which itself generates a real per-username initial), and the same brand
 * gradient as the cover sits behind it the whole time instead of a bare
 * default photo that has nothing to do with this account.
 */
/**
 * ★★★ `avatarUrl` EXISTS BECAUSE THE DIRECT IMAGE HOST CANNOT BE TRUSTED FOR A
 * CONTESTED NAME (2026-09-11).
 *
 * `UserAvatarImg` tries `images.hive.blog/u/<name>/avatar/<size>` FIRST and only falls
 * back to our own `/api/avatar` when that errors. For a squatted name the host answers
 * 200 with the SQUATTER's picture, so the fallback never runs and the guard on our
 * side never gets a say. Measured on production 2026-09-11: `/@chadmasters` rendered
 * `<img src="https://images.hive.blog/u/chadmasters/avatar/large">` -- the attacker's
 * image -- at 120px, directly above the lite account's correct name and bio, while
 * that account's own uploaded picture sat unused in the very same page payload.
 *
 * The component already supports being handed a known-good picture; this page is the
 * one place that unambiguously HAS one, because `profileData` has already been through
 * the squatter guard (`/api/account` + the profile layout both resolve a contested
 * name to its lite owner). So we pass it, and the untrusted name-keyed lookup stops
 * being the first thing tried on the most prominent avatar in the product.
 */
export default function ProfileCover({
  username,
  coverImageUrl,
  avatarUrl,
  lite
}: {
  username: string;
  coverImageUrl: string;
  avatarUrl?: string;
  /** This profile is a Lumen account — see UserAvatarImg's `lite`. */
  lite?: boolean;
}) {
  return (
    <div className="relative">
      <div className="h-[210px] overflow-hidden rounded-panel border border-line-9 bg-gradient-to-br from-surface-brand-12 to-surface-warn-10">
        {coverImageUrl ? <img src={coverImageUrl} alt="" className="h-full w-full object-cover" /> : null}
      </div>
      <div className="absolute bottom-[-48px] left-8">
        <UserAvatarImg
          username={username}
          src={avatarUrl || undefined}
          lite={lite}
          apiSize="large"
          pixelSize={120}
          radiusClassName="rounded-panel"
          className="border-[5px] border-line-1 bg-gradient-to-br from-surface-brand-12 to-surface-warn-10 text-ink-27/90 shadow-[0_6px_22px_rgba(20,18,10,0.14)]"
          alt={username}
        />
      </div>
    </div>
  );
}
