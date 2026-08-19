'use client';

import { Flame } from 'lucide-react';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useTranslation } from '@/blog/i18n/client';
import { useViewerRetention } from '../hooks/use-viewer-retention';

/**
 * ★ THE STREAK, AND NOTHING ELSE (owner ruling, 2026-08-18).
 *
 * Verbatim: "on right navbar theres daily goal part, strip that out compeletely. no
 * setting of anyhting. it should just show the streak, no additional features, no
 * freezes. dump that."
 *
 * This replaces `today-card.tsx` (the "Today" daily loop), which carried, in one card:
 * a progress ring drawn against a chosen daily GOAL, a three-way goal PICKER that wrote
 * to `/api/retention/goal`, a local deadline line ("You have until 01:00"), a banked
 * FREEZE count, a "a freeze covered yesterday" line, and a four-branch headline selector
 * in `copy-select.ts`. Every one of those existed to manage a consecutive-day streak's
 * all-or-nothing cliff. The streak decays now, so the cliff is gone and so is all of it —
 * the goal route, its table, the freeze ledger and its table are deleted, not hidden.
 *
 * WHAT IS LEFT IS ONE MEASURED NUMBER AND THE RULE THAT PRODUCES IT. The rule is on the
 * card rather than in a FAQ because a number that moves by +1 and -2 is unreadable
 * without it, and this feature has already learned that lesson once: the goal gate was
 * invisible on the card it gated, and a tester called it a trap.
 *
 * ★ NOTHING HERE PRESSURES ANYBODY. No countdown, no "don't lose your streak", no
 * exclamation marks. The decay is stated as arithmetic, once, in the present tense.
 */

/**
 * Which mount this is.
 *
 * ★★ BECAUSE BOTH MOUNTS EXIST IN THE DOM AT ONCE (found 2026-08-09 in a browser
 * session). The rail copy is `hidden xl:block` and the inline copy is `xl:hidden`, so
 * exactly one is VISIBLE at any width — but CSS visibility is not existence, and both
 * rendered the same `data-testid`, so every selector matched two elements and tripped
 * Playwright's strict mode: not a cosmetic problem, a whole surface that could not be
 * tested. The testids stay scoped per surface.
 */
export type StreakSurface = 'rail' | 'inline';

/**
 * ★★★ THE NARROW-VIEWPORT MOUNT, DEFINED ONCE ON PURPOSE (A0, 2026-08-18).
 *
 * THE BUG THIS FIXES: every shell in the app renders its right rail inside
 * `hidden … xl:block`, so below 1280px the rail — and the streak with it — is gone.
 * Exactly ONE shell (`home-shell.tsx`) had a hand-written `xl:hidden` inline copy to
 * compensate. So a signed-in reader on a laptop, a tablet or a phone saw their streak on
 * the home feed and NOWHERE ELSE: not on a post, not on a profile, not on a topic. A
 * retention mechanic that vanishes on the surfaces where people actually spend their
 * time is not a retention mechanic.
 *
 * ★ WHY A COMPONENT AND NOT FIVE COPIES OF THE CLASS STRING. The inline mount's
 * breakpoint MUST be the exact complement of the rails' `xl:block`. Written out by hand
 * in five files, that pairing drifts the first time someone changes one rail to `lg:` —
 * and it drifts SILENTLY, because the failure is "two copies visible at once" or "none",
 * neither of which throws. One definition means the invariant is checkable by reading a
 * single line.
 *
 * ★ NOT MOUNTED WHERE THE RAIL WAS DELIBERATELY DECLINED. `page-shell` and
 * `profile-subpage-shell` let a caller pass `rightRail={null}` — /settings does exactly
 * that. A caller that said "no feed rail here" has not asked for the rail's contents to
 * reappear in the content column instead, so those shells mount this only when they are
 * using the DEFAULT rail.
 *
 * ★ SURFACES THAT NEVER SHOWED IT ARE LEFT ALONE. Wallet, Witnesses and Proposals build
 * their own right rails, and none of those contains `StreakCard` at ANY width. That is
 * consistent behaviour, not a hidden instance of this bug, so adding a narrow mount
 * there would be a new product decision rather than a fix.
 */
export function StreakCardNarrow() {
  return <StreakCard className="mb-4 xl:hidden" surface="inline" />;
}

export function StreakCard({ className, surface = 'rail' }: { className?: string; surface?: StreakSurface }) {
  const { t } = useTranslation('common_blog');
  /**
   * ★ SAME RACE AS EVERY OTHER GATE THAT return-nulls A SIGNED-IN READER (2026-08-12,
   * G2). This was raw `useUserClient()`'s `user.isLoggedIn`, which cannot answer during
   * SSR and reports signed-out on the client until `/api/users/me` returns — so the
   * ENTIRE card silently disappeared for a signed-in reader for that window.
   * `identity.isLoggedIn` (server-session.tsx) answers immediately from the session
   * cookie the server already read.
   */
  const identity = useSessionIdentity();
  const { summary } = useViewerRetention();

  if (!identity.isLoggedIn || !summary) return null;

  const days = Math.max(0, summary.streakDays);
  /**
   * The walk could not accumulate all the way back to the day Lumen started counting
   * this account, so the number is a floor. The "+" travels with the figure and never
   * separately — a bare 12 where the server only proved "at least 12" is the same lie
   * the active-weeks line was fixed for.
   */
  // ★ AND NEVER AT ZERO. "0+ days" hedges a number with nothing under it — zero is the
  // floor of the scale, so there is no smaller value the "+" could be hiding. Same rule
  // the active-weeks line got at its own ceiling: a hedge that cannot be wrong in the
  // direction it hedges is noise.
  const isFloor = days > 0 && summary.provenance?.coverage?.streakDaysIsLowerBound === true;
  const base = surface === 'rail' ? 'retention-streak' : 'retention-streak-inline';
  const tid = (part: string) => `${base}-${part}`;

  const figure = isFloor
    ? t('retention.streak.days_floor', { count: days })
    : t('retention.streak.days', { count: days });

  return (
    <section
      className={`rounded-panel border border-line-9 bg-surface-1 ${surface === 'rail' ? 'p-5' : 'p-4'} ${className ?? ''}`}
      data-testid={base}
      data-surface={surface}
      data-streak={days}
      data-floor={isFloor || undefined}
    >
      <div className="flex items-center gap-3.5">
        <span
          className={`inline-flex shrink-0 items-center justify-center rounded-full ${
            days > 0 ? 'bg-surface-brand-5 text-ink-warn-10' : 'bg-surface-23 text-ink-14'
          }`}
          style={{ width: 44, height: 44 }}
        >
          {/* Filled only while the streak is alive. Never red: red means downvote or
              removed value everywhere else in this product. */}
          <Flame className="h-[22px] w-[22px]" fill={days > 0 ? 'currentColor' : 'none'} aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="font-sans text-label font-semibold uppercase tracking-[0.06em] text-ink-14">
            {t('retention.streak.title')}
          </p>
          <p
            className="mt-0.5 font-sans text-[20px] leading-[28px] font-semibold tabular-nums text-ink-2"
            data-testid={tid('figure')}
            title={isFloor ? t('retention.day_streak_floor_hint') : undefined}
          >
            {figure}
          </p>
        </div>
      </div>

      {/* ★ THE RULE, ON THE CARD. A number that can go DOWN has to say so where it is
          shown; discovering the decay by watching it happen is the trap the old goal
          gate was. Two sentences, no threat, no deadline.

          ★ AND IT IS THE ONLY SUPPORTING LINE. The card this replaces owned the entire
          first screen on a 390x844 phone (measured 2026-08-09: the first post started at
          y≈786 of 844), which is how a rail widget ends up displacing the feed it is
          meant to sit beside. */}
      <p className="mt-3 font-sans text-caption text-ink-10" data-testid={tid('rule')}>
        {days > 0 ? t('retention.streak.rule') : t('retention.streak.rule_zero')}
      </p>
    </section>
  );
}
