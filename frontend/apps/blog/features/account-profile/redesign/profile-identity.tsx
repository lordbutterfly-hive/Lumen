'use client';

import { Icons } from '@ui/components/icons';
import TimeAgo from '@ui/components/time-ago';
import { dateToShow } from '@ui/lib/parse-date';
import { useTranslation } from '@/blog/i18n/client';
import { compareDates } from '@/blog/lib/utils';
import { LeagueEmblem, divisionToRoman } from '@/blog/features/retention/emblems/league-emblem';
import { TIERS } from '@/blog/features/retention/lib/tiers';
import { useRetention } from '@/blog/features/retention/hooks/use-retention';
import type { AccountProfile } from '@hive/common-hiveio-packages/wax';

interface ProfileIdentityProps {
  username: string;
  /** False for a Lumen lite account: it has no chain tenure to look up. */
  chainAccount?: boolean;

  displayName: string;
  profile?: AccountProfile;
  created: string;
  lastVoteTime: string;
  lastPost: string;
}

/** Small league chip pairing the real emblem + tier name — replaces the handoff's placeholder "79" badge. */
function LeagueChip({ username, chainAccount }: { username: string; chainAccount: boolean }) {
  const { t } = useTranslation('common_blog');
  const { data: summary } = useRetention(username, chainAccount);
  if (!summary) return null;

  const { rank } = summary;
  const info = TIERS[rank.tier];
  const tierName = t(info.labelKey);
  const divisionLabel = info.hasDivisions && rank.division ? divisionToRoman(rank.division) : null;

  return (
    <span
      title={t('profile.league.title', { tier: tierName })}
      className="inline-flex items-center gap-2 rounded-[13px] border border-[#ebebeb] bg-[#faf9f6] py-1 pl-1.5 pr-3"
      data-testid="profile-league-chip"
    >
      <LeagueEmblem tier={rank.tier} division={rank.division} size="nav" />
      <span className="font-sans text-[14px] font-bold tabular-nums text-[#161511]">
        {tierName}
        {divisionLabel ? <span className="ml-1 font-medium text-[#6b7280]">{divisionLabel}</span> : null}
      </span>
    </span>
  );
}

export default function ProfileIdentity({
  username,
  displayName,
  profile,
  created,
  lastVoteTime,
  lastPost,
  chainAccount = true
}: ProfileIdentityProps) {
  const { t } = useTranslation('common_blog');

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-sans text-[32px] font-bold leading-tight tracking-[-0.02em] text-[#161511]">
          {displayName}
        </h1>
        <LeagueChip username={username} chainAccount={chainAccount} />
      </div>

      <div className="mt-1 font-sans text-[14.5px] text-[#6b7280]">
        <span className="font-semibold text-[#3f4650]">@{username}</span>
      </div>

      {profile?.about ? (
        <p className="mt-3 max-w-[520px] font-serif text-[16.5px] leading-normal text-[#3f4650]">{profile.about}</p>
      ) : null}

      <div className="mt-3.5 flex flex-wrap gap-4 font-sans text-[13.5px] text-[#6b7280]">
        {profile?.location ? (
          <span className="flex items-center gap-1.5">
            <Icons.mapPin className="h-[15px] w-[15px] text-[#9ca3af]" />
            {profile.location}
          </span>
        ) : null}
        {created ? (
          <span className="flex items-center gap-1.5">
            <Icons.calendarHeart className="h-[15px] w-[15px] text-[#9ca3af]" />
            {t('user_profile.joined')} {dateToShow(created, t)}
          </span>
        ) : null}
        <span className="flex items-center gap-1.5">
          <span className="h-[7px] w-[7px] rounded-full bg-[#2f7d4f]" />
          {t('user_profile.active')} <TimeAgo date={compareDates([created, lastVoteTime, lastPost])} />
        </span>
      </div>
    </div>
  );
}
