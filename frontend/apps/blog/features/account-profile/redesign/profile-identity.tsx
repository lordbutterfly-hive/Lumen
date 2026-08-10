'use client';

import { useState } from 'react';
import { Icons } from '@ui/components/icons';
import TimeAgo from '@ui/components/time-ago';
import { dateToShow } from '@ui/lib/parse-date';
import { accountReputation, accountReputationPrecise } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import { compareDates } from '@/blog/lib/utils';
import { ProfileLeagueChip } from '@/blog/features/retention/components/profile-league-chip';
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
  /**
   * Hive reputation as `bridge.get_profile` returns it (already converted, e.g.
   * 79.77). Undefined for a lite account, which has no Hive account to have one.
   */
  reputation?: number;
}

/**
 * The name, the Hive reputation, and the Lumen rank chip.
 *
 * ★ THE REPUTATION BADGE IS BACK (owner ruling, 2026-08-09). This file used to carry
 * the comment "Small league chip pairing the real emblem + tier name — replaces the
 * handoff's placeholder '79' badge". It was not a placeholder. It was the reputation
 * every other Hive frontend shows, and removing it left the redesigned profile as the
 * only place on the site where you could not see it.
 *
 * TWO DIFFERENT THINGS, DELIBERATELY SIDE BY SIDE AND DELIBERATELY UNALIKE. The badge
 * is a HIVE fact: a stake-weighted lifetime total that Lumen neither computes nor
 * scores anything with — reputation was removed from the retention metric on the same
 * day this went back in, and that is not a coincidence; it belongs on a profile as a
 * fact, and it did not belong inside a ladder. The chip is the LUMEN rank. They must
 * never read as two versions of the same number, so the badge is a quiet grey pill and
 * the chip carries the emblem.
 *
 * ★ THE BADGE ROUNDS AND THE HOVER DOES NOT — matching hive.blog exactly, which is the
 * requirement. 79.77 shows as 80 on the badge and 79.77 on hover. `accountReputation`
 * was floored until 2026-08-09 and was therefore one too low on roughly half of all
 * accounts, everywhere in the app; it now rounds, so this badge and the feed byline
 * agree with each other and with hive.blog.
 */

export default function ProfileIdentity({
  username,
  displayName,
  profile,
  created,
  lastVoteTime,
  lastPost,
  chainAccount = true,
  reputation
}: ProfileIdentityProps) {
  const { t } = useTranslation('common_blog');
  // The explanation is collapsed by default. It opens on click as well as hover, because
  // a `title` is invisible on touch — see the badge below.
  const [repOpen, setRepOpen] = useState(false);
  // Absent, never defaulted to 25: a lite account has no reputation at all, and
  // printing the floor value would state a Hive fact about somebody who is not on
  // Hive. `typeof` rather than truthiness, because 0 is a real (if unusual) value.
  const showReputation = chainAccount && typeof reputation === 'number';

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-sans text-[32px] font-bold leading-tight tracking-[-0.02em] text-[#161511]">
          {displayName}
        </h1>
        <ProfileLeagueChip username={username} chainAccount={chainAccount} />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2 font-sans text-[14.5px] text-[#6b7280]">
        <span className="font-semibold text-[#3f4650]">@{username}</span>
        {showReputation ? (
          <button
            type="button"
            onClick={() => setRepOpen((v) => !v)}
            aria-expanded={repOpen}
            // The accessible name carries what the pill cannot: what the number IS.
            aria-label={`${t('user_profile.reputation_label')} ${accountReputationPrecise(reputation)}`}
            className="rounded-full bg-[#f1f3f5] px-2 py-0.5 font-sans text-[12.5px] font-semibold tabular-nums text-[#6b7280] transition-colors hover:bg-[#e8eaed]"
            data-testid="profile-reputation"
            // A native title, on purpose: it is the same affordance hive.blog uses for
            // the same number, it survives without JS, and it needs no positioned
            // primitive. The precise value leads, because that is what somebody
            // hovering a rounded number is asking for.
            title={t('user_profile.reputation_title', {
              value: accountReputationPrecise(reputation),
              username
            })}
          >
            {/* ★★ THE WORD, AND A TAP TARGET (2026-08-09). The pill was a bare "76" whose
                only explanation was a `title` — so on a phone, where there is no hover,
                the number had NO explanation at all, and a tester rated it 1 of 5: "I only
                learned what it was by hovering; on my phone I'd never have found out."
                Two changes, neither of which touches the number: the pill says what it is,
                and it is a button, so the sentence behind it is reachable by tapping.
                The owner's spec is unaffected — the badge still shows the ROUNDED value
                (76) and the precise one (76.11) is still what the hover reveals. */}
            <span className="mr-1 font-medium uppercase tracking-[0.04em] text-[#9ca3af]">
              {t('user_profile.reputation_short')}
            </span>
            {accountReputation(reputation)}
          </button>
        ) : null}
      </div>

      {/* The explanation, on demand rather than on hover. Same string as the title, so
          the touch and pointer paths can never drift apart. */}
      {showReputation && repOpen ? (
        <p
          className="mt-1.5 max-w-[440px] font-sans text-[12.5px] leading-snug text-[#6b7280]"
          data-testid="profile-reputation-explainer"
        >
          {t('user_profile.reputation_title', {
            value: accountReputationPrecise(reputation),
            username
          })}
        </p>
      ) : null}

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
