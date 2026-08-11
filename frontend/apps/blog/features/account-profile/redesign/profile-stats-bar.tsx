import { Link } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import TooltipContainer from '@ui/components/tooltip-container';
import { cn, numberWithCommas } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';

interface Stat {
  value: string;
  label: string;
  href?: string;
  /** Optional second line under the value — the HP tile's delegation-adjusted figure. */
  sub?: string;
  /** Longer explanation for `sub`, on hover and on keyboard focus. */
  subTooltip?: string;
}

// The row's two grey link-buttons. 14px, the system radius for a button; these
// were 11px, one of the several radii the pages carried side by side.
const ROW_BUTTON_CLASS =
  'flex items-center gap-2 rounded-[14px] border border-[#e4e6e9] bg-[#f4f5f7] px-5 py-2.5 font-sans text-[14px] font-semibold text-[#3f4650] transition-colors hover:bg-[#ebedf0]';

/** Followers / Posts / Following / HP stat row + grey Wallet button (design-handoff-v2, Profile.dc.html). */
export default function ProfileStatsBar({
  username,
  followerCount,
  postCount,
  followingCount,
  hp,
  hpEffective
}: {
  username: string;
  followerCount: number;
  postCount: number;
  followingCount: number;
  /** OWN staked HIVE — the headline figure, as Hive's own wallet shows it. */
  hp: string;
  /** Delegation-adjusted total, rendered underneath as "Tot:" like Hive does. */
  hpEffective?: string;
}) {
  const { t } = useTranslation('common_blog');

  const stats: Stat[] = [
    {
      value: numberWithCommas(String(followerCount)),
      // ★ "1 / Followers" (2026-08-08). The label was a fixed plural, so an
      // account with exactly one follower read as a typo on a page about that
      // person. Every other counted noun on this site already carries i18next
      // plural forms; this row was the miss. `count` selects
      // `followers_label_one` / `_other`; the base key is untouched, so the
      // legacy profile chrome that passes no count still renders "Followers".
      label: t('user_profile.lists.followers_label', { count: followerCount }),
      href: `/@${username}/followers`
    },
    {
      value: numberWithCommas(String(postCount)),
      // Same defect, same row, one tile across: "1 / Posts".
      label: t('user_profile.lists.posts_label', { count: postCount })
    },
    // "Following" is a gerund, not a countable noun — "1 Following" is correct.
    {
      value: numberWithCommas(String(followingCount)),
      label: t('user_profile.lists.following_label'),
      href: `/@${username}/followed`
    },
    {
      value: numberWithCommas(hp),
      label: t('profile.stats.hp'),
      // ★ THE "Tot:" CAPTION WAS NOT A TOTAL (2026-08-08).
      //
      // It is `vesting_shares - (delegated_out - received)` — the account's
      // EFFECTIVE Hive Power, what its vote actually weighs. Labelling that
      // "Tot" put a number smaller than the one directly above it under the
      // word "Total" (@oflyhigh: 262,804 headline, 231,860 caption), with no
      // unit and no tooltip, on a page showing someone's real token holdings.
      // It read as an unfinished placeholder or a bug, and the one reading it
      // could not tell which of the two numbers to believe.
      //
      // Both numbers are right; they answer different questions. The caption
      // now says which question it answers, in full, without needing the
      // tooltip — the tooltip is the long version for anyone who wants it.
      // Still omitted when the two are equal (no delegations either way): a
      // second identical number is noise.
      sub:
        hpEffective && hpEffective !== hp
          ? t('profile.stats.hp_effective', { value: numberWithCommas(hpEffective) })
          : undefined,
      subTooltip: t('profile.stats.hp_effective_tooltip')
    }
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
      // ★ items-START, not items-center (2026-08-07). Only the HP tile carries a
      // second line ("Tot:"), so centring made that one tile taller and shifted its
      // value and label 6px UP relative to Followers/Posts/Following — measured, and
      // exactly the "numbers arent properly in line" the owner reported. Top-aligning
      // puts every value/label pair on one baseline and lets the extra line hang below.
      className="mt-5 flex flex-wrap items-start gap-8 rounded-2xl border border-[#ebebeb] bg-white p-[18px_22px]"
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
            {stat.sub ? <StatSub sub={stat.sub} tooltip={stat.subTooltip} /> : null}
          </div>
        )
      )}

      {/* ★ THE CREATOR-TOKEN GHOST LINK THAT USED TO LIVE HERE IS GONE
          (creator-token-prominence pass, 2026-08-11). A tertiary grey button
          reading "View creator token" was the ONLY entry point to what the
          owner now ranks as the primary product — it is replaced by
          ProfileTokenCard (features/creator-tokens/ui/profile-token-card.tsx),
          a real data card between this row and the tabs, in profile-main.tsx.
          `self-center`: the row is items-start so the stat labels share a
          baseline, but Wallet belongs on the group's vertical centre. */}
      <div className="ml-auto flex flex-wrap items-center gap-2.5 self-center">
        <Link href="/wallet" className={ROW_BUTTON_CLASS}>
          <Icons.wallet className="h-[17px] w-[17px]" />
          {t('profile.wallet')}
        </Link>
      </div>
    </div>
  );
}

function StatValue({ value }: { value: string }) {
  return (
    <span className="font-sans text-[23px] font-bold tabular-nums tracking-[-0.02em] text-[#161511]">
      {value}
    </span>
  );
}

function StatLabel({ label }: { label: string }) {
  return <span className="font-sans text-[13px] font-medium text-[#6b7280]">{label}</span>;
}

/**
 * The HP tile's second line. `tabIndex={0}` is deliberate: a tooltip that only
 * opens on hover is unreachable by keyboard, and this one carries the only
 * explanation of why the two numbers differ. The caption itself is written to
 * stand alone, because a tooltip never opens on a touch screen at all.
 */
function StatSub({ sub, tooltip }: { sub: string; tooltip?: string }) {
  const text = (
    <span
      className={cn(
        'font-sans text-[11.5px] leading-[1.35] text-[#9ca3af]',
        tooltip && 'cursor-help decoration-dotted underline-offset-2 hover:underline focus:underline'
      )}
      tabIndex={tooltip ? 0 : undefined}
      data-testid="profile-hp-effective"
    >
      {sub}
    </span>
  );
  return tooltip ? <TooltipContainer title={tooltip}>{text}</TooltipContainer> : text;
}
