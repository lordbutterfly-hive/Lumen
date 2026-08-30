'use client';

import { useState } from 'react';
import { Icons } from '@ui/components/icons';
import TimeAgo from '@ui/components/time-ago';
import TooltipContainer from '@ui/components/tooltip-container';
import { Link } from '@hive/ui';
import { dateToShow } from '@ui/lib/parse-date';
import { accountReputation, accountReputationPrecise } from '@hive/ui';
import { cn, numberWithCommas } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { compareDates } from '@/blog/lib/utils';
import { ProfileLeagueChip } from '@/blog/features/retention/components/profile-league-chip';
import type { AccountProfile } from '@hive/common-hiveio-packages/wax';
// WORK-LINK spec B5 (2026-08-30): the `website` field has persisted since
// Settings existed (`account-settings/form.tsx:417-431`) but nothing in the
// app ever rendered it — see safe-external-link.tsx's own header for why a
// chain account's `website` is attacker-controlled and must never reach the
// DOM unsanitised.
import { SafeExternalLink, safeHostname } from '@/blog/components/safe-external-link';

interface ProfileIdentityProps {
  username: string;
  /** False for a Lumen lite account: it has no chain tenure to look up. */
  chainAccount?: boolean;

  profile?: AccountProfile;
  created: string;
  lastVoteTime: string;
  lastPost: string;
  /**
   * Hive reputation as `bridge.get_profile` returns it (already converted, e.g.
   * 79.77). Undefined for a lite account, which has no Hive account to have one.
   */
  reputation?: number;
  /**
   * E1 (BUILDMAP-FUCKERY-V2): the viewer has muted and/or blacklisted this account.
   * Dims the bio/handle block as a visual cue, matching the cover's own dimming.
   * The standalone `ProfileModerationBanner` that used to carry the actual
   * explanation in words was retired (2026-08-12, Block consolidation cleanup,
   * see `profile-main.tsx`) — `ProfileActions`' CTA-slot badge is the
   * explanation now.
   */
  moderated?: boolean;
  /**
   * ★ DEFECT FIX (2026-08-17): drives the "add a bio" prompt below when
   * `profile.about` is empty. Only the viewer's own profile gets a prompt —
   * an empty bio on someone else's profile is just a fact about them, not
   * something this page can offer to fix.
   */
  isOwnProfile?: boolean;
  /**
   * The stats line under the meta row. Replaces the standalone 112px
   * `ProfileStatsBar` card (2026-08-13) — same four numbers, one line, no card
   * chrome. Counts are OPTIONAL on purpose: `follow_stats` can be absent from
   * `bridge.get_profile`, and the spec is explicit that a missing number renders
   * as an em dash IN PLACE rather than dropping the item, so the line never
   * reflows between loads.
   */
  followerCount?: number;
  postCount?: number;
  followingCount?: number;
  /** Own staked HIVE, ungrouped fixed-point (e.g. "74886.174"). */
  hp?: string;
  /** Delegation-adjusted total; shown only in the tooltip. */
  hpEffective?: string;
}

/**
 * The handle, the Hive reputation, the bio and the tenure line.
 *
 * ★ THE DISPLAY NAME MOVED OUT (P-1, 2026-08-10). This file used to own the
 * `<h1>`, which is why the profile was the one page with no masthead: its title
 * was buried three components deep. The name is now the shared masthead's
 * `title` slot in profile-main.tsx and this component is the meta that hangs
 * under it. The rank chip came down with it, from beside the name to beside the
 * handle, so that the h1 is the person's name and only that — inside the
 * masthead's title the chip would have been read out as part of the heading.
 * It is still directly next to the reputation badge, which is the pairing the
 * note below is about.
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
  profile,
  created,
  lastVoteTime,
  lastPost,
  chainAccount = true,
  reputation,
  moderated = false,
  isOwnProfile = false,
  followerCount,
  postCount,
  followingCount,
  hp,
  hpEffective}: ProfileIdentityProps) {
  const { t } = useTranslation('common_blog');
  // The explanation is collapsed by default. It opens on click as well as hover, because
  // a `title` is invisible on touch — see the badge below.
  const [repOpen, setRepOpen] = useState(false);
  // Absent, never defaulted to 25: a lite account has no reputation at all, and
  // printing the floor value would state a Hive fact about somebody who is not on
  // Hive. `typeof` rather than truthiness, because 0 is a real (if unusual) value.
  const showReputation = chainAccount && typeof reputation === 'number';

  return (
    <div className={cn('min-w-0', moderated && 'opacity-60 grayscale')} data-testid="profile-identity-block">
      <div className="flex flex-wrap items-center gap-2 font-sans text-[15px] leading-[24px] text-ink-10">
        <span className="font-semibold text-ink-7">@{username}</span>
        {/* ★ ILLUMINATION SPEC §2 ("Rank as luminosity") LANDS INSIDE THIS CHIP, NOT HERE
            (2026-08-20). `ProfileLeagueChip` is the one thing in this row with a real
            1..9 rank, and it now self-derives `--l` from that rank and applies its own
            `.repBadge` fill internally — see `profile-league-chip.tsx` /
            `profile-league-chip.module.css` in `features/retention/components/`. The
            reputation pill just below is fed by Hive `reputation` instead, a different
            quantity the doc block above this component already spends several
            paragraphs keeping distinct from rank; spec §2 forbids driving `--l` from it
            ("do not fall back to reputation"). `.repBadge` is written to spec in the
            sibling `profile-identity.module.css` too, and stays unwired there — see
            that file's header for the full reasoning. */}
        <ProfileLeagueChip username={username} chainAccount={chainAccount} />
        {showReputation ? (
          <button
            type="button"
            onClick={() => setRepOpen((v) => !v)}
            aria-expanded={repOpen}
            // The accessible name carries what the pill cannot: what the number IS.
            // ★ ROUNDED, LIKE THE PILL (2026-08-13, audit §7). This read
            // `accountReputationPrecise` — measured live: the label said "Hive
            // reputation 79.77" while the visible pill said "REP 80". A screen
            // reader heard two decimal places nobody else was shown, and the
            // two never matched. The accessible name must name what is on
            // screen; the precise value is still one hover (`title`) or one tap
            // (the explainer below) away, which is where it belongs.
            aria-label={`${t('user_profile.reputation_label')} ${accountReputation(reputation)}`}
            // ★ ink-8, NOT ink-10 (2026-08-16, measured by a QA pass on /@holozing).
            // `text-ink-10` (#6b7280) on `bg-surface-23` (#f1f3f5) measures
            // 4.35:1 — under the 4.5:1 AA floor for normal text, and this is
            // 13px text, so it is normal text by the standard's definition.
            // ink-10 clears AA on WHITE (4.83:1); it is the grey chip ground
            // underneath that costs the remaining margin, which is exactly the
            // case a global token check on a white page never catches. ink-8
            // (#4b5563) measures 6.79:1 on the same ground and is one step on
            // the same ramp, so the pill stays secondary to the handle above it.
            className="rounded-full bg-surface-23 px-2 py-0.5 font-sans text-caption font-semibold tabular-nums text-ink-8 transition-colors hover:bg-surface-29"
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
            <span className="mr-1 font-medium uppercase tracking-[0.04em] text-ink-14">
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
          className="mt-1.5 max-w-[440px] font-sans text-caption text-ink-10"
          data-testid="profile-reputation-explainer"
        >
          {t('user_profile.reputation_title', {
            value: accountReputationPrecise(reputation),
            username
          })}
        </p>
      ) : null}

      {profile?.about ? (
        <p className="mt-3 max-w-[520px] font-serif text-[17px] leading-[26px] text-ink-7">{profile.about}</p>
      ) : isOwnProfile ? (
        // ★ DEFECT FIX (2026-08-17): an empty bio on your own profile rendered
        // nothing at all — no cue that a bio exists as a field, let alone that
        // it's empty.
        //
        // ★★★ ONE FIELD, ONE NAME (2026-08-27, owner: "on profile page says add
        // bio but in settings theres only about, no bio"). There is only ever one
        // field: `profile.about`, Hive's own `posting_json_metadata.profile.about`
        // key, rendered two lines up and edited by the single `id="about"` input in
        // `account-settings/form.tsx` under the label `settings_page.profile_about`
        // ("About"). This prompt was the ONLY surface in the product calling it a
        // bio — grep for "bio" in `locales/en/common_blog.json` and this string was
        // the sole hit — so the reader was sent to look for a control that, by that
        // name, is not there. The chain metadata key is `about` and both other
        // labels already say About, so the prompt is what moves.
        //
        // ★ AND IT NOW LANDS ON THE CONTROL, not merely on the page. `#about` is the
        // input's own id; `SettingsContent`'s `useHashLanding` re-applies the jump
        // for 4s while the form mounts and rings the target on arrival, which is
        // exactly the case it was built for (the same mechanism `/lists/*` uses to
        // land on `#blocked-accounts`). The Edit-profile CTA in `profile-actions.tsx`
        // deliberately keeps the bare `/settings` destination — it opens the whole
        // form, this one asks for a named field.
        <Link
          href={`/@${username}/settings#about`}
          className="mt-3 inline-block max-w-[520px] font-serif text-[17px] leading-[26px] text-ink-14 underline-offset-2 hover:text-ink-10 hover:underline"
          data-testid="profile-add-about-prompt"
        >
          {t('user_profile.add_about_prompt')}
        </Link>
      ) : null}

      <div className="mt-3.5 flex flex-wrap gap-4 font-sans text-[14px] leading-[22px] text-ink-10">
        {profile?.location ? (
          <span className="flex items-center gap-1.5">
            <Icons.mapPin className="h-[15px] w-[15px] text-ink-14" />
            {profile.location}
          </span>
        ) : null}
        {/*
          ★ WORK-LINK spec B5 (2026-08-30, owner: "People check your profile
          before they hold anything... I dont see it in Settings" — the field
          was never dead, nothing rendered it). `profile.website` is
          attacker-controlled on the chain path (see the import header) and
          already validated on the lite path, but SafeExternalLink runs the
          same gate on both regardless of source — see its own doc.

          HOSTNAME ONLY, matching the Meritum token page (B3): a full URL
          in a 14px meta row wraps and dwarfs the reputation pill above it.
          Absent or unsafe both render nothing, same as an absent location —
          no placeholder, nothing fabricated.
        */}
        {profile?.website && safeHostname(profile.website) ? (
          <SafeExternalLink href={profile.website} className="flex items-center gap-1.5 hover:underline">
            <Icons.link2 className="h-[15px] w-[15px] text-ink-14" />
            {/* Icon + bare hostname reads as location-shaped to a sighted
                reader (same row, same treatment as the pin above); a screen
                reader gets no such visual cue, so the accessible name states
                what this actually is. Reuses the Settings label rather than
                a new string — same field, same name, everywhere it appears. */}
            <span className="sr-only">{t('settings_page.profile_website')}: </span>
            {safeHostname(profile.website)}
          </SafeExternalLink>
        ) : null}
        {created ? (
          <span className="flex items-center gap-1.5">
            <Icons.calendarHeart className="h-[15px] w-[15px] text-ink-14" />
            {t('user_profile.joined')} {dateToShow(created, t)}
          </span>
        ) : null}
        <span className="flex items-center gap-1.5">
          <span className="h-[7px] w-[7px] rounded-full bg-surface-ok-7" />
          {t('user_profile.active')} <TimeAgo date={compareDates([created, lastVoteTime, lastPost])} />
        </span>
      </div>

      {/*
        ★ THE STATS CARD IS NOW A LINE (2026-08-13).
        Replaces `ProfileStatsBar`'s 831x112 card: 132px of vertical height
        (112 card + 20 margin) and ~236px of dead horizontal space removed, so
        the first post sits correspondingly higher.

        A SIBLING of the meta row, not a child, so it wraps onto its own row and
        the icon spacing above is untouched.

        14px/22px, matching the meta row it sits under. The spec asked for
        13.5px/20.25px, which were that row's values BEFORE the same day's
        typography pass rounded every fractional size away; re-introducing them
        would put this line back off the pixel grid on its own.

        Numbers are weight 600 in #161511 against the #6b7280 label — the
        weight/colour contrast is what makes them read as data, so they stay the
        same SIZE as the labels. `tabular-nums` stops the digits jittering when a
        count revalidates.
      */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-[14px] leading-[22px] text-ink-10">
        <Link href={`/@${username}/followers`} className="underline-offset-2 hover:underline">
          <StatNumber value={followerCount} />{' '}
          {t('user_profile.stats_line.followers', { count: followerCount ?? 0 })}
        </Link>
        <StatDot />
        <span>
          <StatNumber value={postCount} /> {t('user_profile.stats_line.posts', { count: postCount ?? 0 })}
        </span>
        <StatDot />
        {/* `/following`, not `/followed`: the old path is a permanent redirect as
            of the same day's route rename, and an internal link that knowingly
            points at a redirect costs every reader a round trip. */}
        <Link href={`/@${username}/following`} className="underline-offset-2 hover:underline">
          <StatNumber value={followingCount} /> {t('user_profile.stats_line.following')}
        </Link>
        {hp ? (
          <>
            <StatDot />
            {/* The exact three-decimal figure and the delegation-adjusted total
                live ONLY here — that is where the deleted card's sub-line went. */}
            <TooltipContainer
              title={`${numberWithCommas(hp)} ${t('profile.stats.hp')}${
                hpEffective && hpEffective !== hp
                  ? ` · ${t('profile.stats.hp_effective', { value: numberWithCommas(hpEffective) })}`
                  : ''
              }`}
            >
              <span
                className="cursor-help underline-offset-2 decoration-dotted hover:underline focus:underline"
                tabIndex={0}
                data-testid="profile-hp-effective"
              >
                <span className="font-semibold tabular-nums tracking-[-0.01em] text-ink-2">
                  {numberWithCommas(String(Math.round(Number(hp))))}
                </span>{' '}
                {t('profile.stats.hp')}
              </span>
            </TooltipContainer>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** A count, or an em dash when the API did not return one — never a dropped item. */
function StatNumber({ value }: { value?: number }) {
  return (
    <span className="font-semibold tabular-nums tracking-[-0.01em] text-ink-2">
      {typeof value === 'number' ? value.toLocaleString('en-US') : '—'}
    </span>
  );
}

/** `aria-hidden` + `select-none` so copying the line yields clean text. */
function StatDot() {
  return (
    <span aria-hidden className="select-none text-ink-23">
      ·
    </span>
  );
}
