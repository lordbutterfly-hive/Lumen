import { Link } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import { numberWithCommas } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';

interface Stat {
  value: string;
  label: string;
  href?: string;
}

/** Followers / Posts / Following / HP stat row + grey Wallet button (design-handoff-v2, Profile.dc.html). */
export default function ProfileStatsBar({
  username,
  followerCount,
  postCount,
  followingCount,
  hp
}: {
  username: string;
  followerCount: number;
  postCount: number;
  followingCount: number;
  hp: string;
}) {
  const { t } = useTranslation('common_blog');

  const stats: Stat[] = [
    { value: numberWithCommas(String(followerCount)), label: t('user_profile.lists.followers_label'), href: `/@${username}/followers` },
    { value: numberWithCommas(String(postCount)), label: t('user_profile.lists.posts_label') },
    { value: numberWithCommas(String(followingCount)), label: t('user_profile.lists.following_label'), href: `/@${username}/followed` },
    { value: numberWithCommas(hp), label: t('profile.stats.hp') }
  ];

  return (
    // Same data-testid the legacy chrome's stats block used
    // (layouts/user-profile/profile-layout.tsx). The redesign renders bare on
    // the profile ROOT path, so that legacy node no longer exists there and the
    // smoke suite's SMOKE-08/09 were timing out on a selector for markup we
    // deliberately replaced. Reusing the id points those tests at the live
    // component instead of muting them.
    <div
      data-testid="profile-stats"
      className="mt-5 flex flex-wrap items-center gap-8 rounded-2xl border border-[#ebebeb] bg-white p-[18px_22px]"
    >
      {stats.map((stat) =>
        stat.href ? (
          <Link key={stat.label} href={stat.href} className="flex flex-col gap-0.5 hover:opacity-80">
            <StatValue value={stat.value} />
            <StatLabel label={stat.label} />
          </Link>
        ) : (
          <div key={stat.label} className="flex flex-col gap-0.5">
            <StatValue value={stat.value} />
            <StatLabel label={stat.label} />
          </div>
        )
      )}

      <Link
        href="/wallet"
        className="ml-auto flex items-center gap-2 rounded-[11px] border border-[#e4e6e9] bg-[#f4f5f7] px-5 py-2.5 font-sans text-[14px] font-semibold text-[#3f4650] hover:bg-[#ebedf0]"
      >
        <Icons.wallet className="h-[17px] w-[17px]" />
        {t('profile.wallet')}
      </Link>
    </div>
  );
}

function StatValue({ value }: { value: string }) {
  return (
    <span className="font-sans text-[23px] font-bold tabular-nums tracking-[-0.02em] text-[#161511]">{value}</span>
  );
}

function StatLabel({ label }: { label: string }) {
  return <span className="font-sans text-[13px] font-medium text-[#6b7280]">{label}</span>;
}
