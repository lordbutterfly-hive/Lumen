import { getUserAvatarUrl, getDefaultImageUrl } from '@ui/lib/avatar-utils';

/**
 * Cover banner + overlapping rounded-square avatar (design-handoff-v2,
 * Profile.dc.html). Cover falls back to the brand gradient when the
 * account has no (safe) cover image set — never a broken image / empty box.
 */
export default function ProfileCover({ username, coverImageUrl }: { username: string; coverImageUrl: string }) {
  return (
    <div className="relative">
      <div className="h-[210px] overflow-hidden rounded-[22px] border border-[#ebebeb] bg-gradient-to-br from-[#c0392b] to-[#e07b3e]">
        {coverImageUrl ? <img src={coverImageUrl} alt="" className="h-full w-full object-cover" /> : null}
      </div>
      <div className="absolute bottom-[-48px] left-8 h-[120px] w-[120px] overflow-hidden rounded-[26px] border-[5px] border-white bg-gradient-to-br from-[#c0392b] to-[#e07b3e] shadow-[0_6px_22px_rgba(20,18,10,0.14)]">
        <img
          src={getUserAvatarUrl(username, 'large')}
          alt={username}
          className="h-full w-full object-cover"
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = getDefaultImageUrl();
          }}
        />
      </div>
    </div>
  );
}
