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
export default function ProfileCover({ username, coverImageUrl }: { username: string; coverImageUrl: string }) {
  return (
    <div className="relative">
      <div className="h-[210px] overflow-hidden rounded-panel border border-line-9 bg-gradient-to-br from-surface-brand-12 to-surface-warn-10">
        {coverImageUrl ? <img src={coverImageUrl} alt="" className="h-full w-full object-cover" /> : null}
      </div>
      <div className="absolute bottom-[-48px] left-8">
        <UserAvatarImg
          username={username}
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
