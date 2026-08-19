'use client';

import { useEffect, useMemo, useState } from 'react';
import { Link } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import { useTranslation } from '@/blog/i18n/client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { useViewerRetention } from '../hooks/use-viewer-retention';
import { weekTally, utcDayKey } from './retention-moments';

/**
 * Feedback moment 3 of 3: a Monday recap at the top of the feed.
 *
 * A CARD, not a toast and emphatically not a modal — it is the one moment that
 * carries numbers, and numbers deserve to sit still and be readable. Dismissible,
 * and the dismissal is persisted through storage-with-ttl (never raw
 * localStorage) keyed by the Monday it belongs to, so dismissing this week's
 * card does not suppress next week's.
 *
 * NOTHING HERE REACTS TO A RANK GOING DOWN. There is no demotion copy, no
 * "you slipped", no comparison to last week. It reports what happened.
 *
 * HONESTY: the act counts come from the client act-ledger (acts this browser saw
 * the server confirm), so they are a LOWER bound — the card never claims a total
 * it cannot back. "people engaged" is the route's own SAMPLED `distinctGivers`,
 * which is why the segment is worded as a plain count and not as "this week":
 * the route samples recent posts, it does not window by week. Any segment we
 * cannot state honestly is simply not rendered, and if that leaves nothing to
 * say, the card does not appear at all.
 */

const DISMISS_KEY = 'retention-recap-dismissed-v1';
/** Monday, per the viewer's own calendar. */
const MONDAY = 1;

export interface WeeklyRecapCardProps {
  className?: string;
}

export function WeeklyRecapCard({ className }: WeeklyRecapCardProps) {
  const { t } = useTranslation('common_blog');
  /**
   * ★★★ THIS CARD WAS SHOWN TO LOGGED-OUT VISITORS, WITH THE PREVIOUS READER'S
   * NUMBERS (owner-reported 2026-08-17, from a screenshot of `/` while signed
   * out: "LAST WEEK · 3 posts · 6 replies · active 3 of 7 days").
   *
   * Two independent faults had to line up, and both are fixed here:
   *
   *  1. THE GATE READ A STALE ANSWER. It was raw `useUserClient()`'s
   *     `user.isLoggedIn`, which `use-user-core.ts` seeds from the localStorage
   *     `user` key written by the LAST successful login on this browser
   *     (`initialDataUpdatedAt: 0`). An explicit sign-out clears that seed, but a
   *     session that dies any other way — an expired or invalidated cookie, which
   *     `app/page.tsx` documents happening — leaves `isLoggedIn: true` sitting in
   *     storage. The card believed it.
   *
   *  2. IT COULD NEVER TAKE IT BACK. `visible` was a one-way latch: the effect
   *     early-returns when logged out, so once it had been set true on the stale
   *     seed, the real answer arriving moments later could not hide it again.
   *
   * ★ WHY `clientAnswered` AND NOT JUST `identity.isLoggedIn`. The sibling fix in
   * `streak-card.tsx` (G2) swapped to `useSessionIdentity()`, and that is the right
   * source — but read `server-session.tsx`: until `clientAnswered`, it FALLS BACK
   * to the same localStorage seed. For a card that hides a signed-in reader's
   * daily loop, an optimistic seed is the safe way to be wrong. For a card that
   * publishes one person's week to whoever opens the browser next, it is not.
   * So this one waits for the real answer. The cost is that the card appears a
   * beat later for a genuine returning reader; the alternative is showing their
   * activity to a stranger, which is not a trade worth making.
   *
   * ★ VISIBILITY IS DERIVED, NOT LATCHED, so it self-corrects the moment the
   * session answer changes — the same shape `streak-card.tsx` uses.
   */
  const identity = useSessionIdentity();
  const signedIn = identity.clientAnswered && identity.isLoggedIn;
  // Whichever ladder applies — a lite account's "N people engaged" is a real
  // measured number from our own database, and this card used to skip it purely
  // because the chain hook could not answer for them.
  const { summary } = useViewerRetention();

  // The clock and storage reads must not run during SSR — an unmounted first
  // paint keeps hydration deterministic. This resolves only the CLIENT-ONLY
  // facts (which day it is, whether this week's card was dismissed); whether the
  // reader is signed in is decided separately, above, and re-evaluated freely.
  const [today, setToday] = useState('');
  const [eligibleDay, setEligibleDay] = useState(false);

  useEffect(() => {
    const now = new Date();
    if (now.getDay() !== MONDAY) return;
    const day = utcDayKey(now);
    if (getStorageItem<string>(DISMISS_KEY) === day) return;
    setToday(day);
    setEligibleDay(true);
  }, []);

  const visible = signedIn && eligibleDay;

  const tally = useMemo(
    () => (visible ? weekTally(identity.username) : null),
    [visible, identity.username]
  );

  const segments = useMemo(() => {
    if (!tally) return [];
    const parts: string[] = [];
    // `count`, so "1 post" / "1 reply" / "1 person engaged" read as English.
    if (tally.posts > 0) parts.push(t('retention.recap.posts', { count: tally.posts }));
    if (tally.replies > 0) parts.push(t('retention.recap.replies', { count: tally.replies }));
    // ★★ THE PEOPLE LINE IS GONE FROM THE RECAP (found 2026-08-09 by a UX agent).
    //
    // It printed `1233 people voted on you` under a heading that says LAST WEEK. The figure is
    // chain-accurate — but it comes from the sampled posts, which on @gtg are dated 2026-07-18
    // and 2026-03-20, and Hive closes voting seven days after publication. So NONE of those votes
    // happened last week, and the heading made a time claim the number cannot support. Same class
    // as the read/voted mislabel, one axis over: right quantity, wrong WHEN.
    //
    // A weekly recap may only carry things that are genuinely weekly. What is left is exactly
    // that: posts and replies written in the week, feeds reached in the week, active days in the
    // week. `retention.recap.people` is deleted with it.
    // ★ REACH, WHICH IS THE ONE SEGMENT THAT IS GENUINELY ABOUT THE WEEK. The route
    // measures `feedsReached` over a 7-day window, unlike the giver figures, which are
    // a sample over 26 weeks. On a card titled "Last week" it is the only number that
    // matches the title, which is why it is here and why it is second.
    if (typeof summary?.stats?.feedsReached === 'number' && summary.stats.feedsReached > 0) {
      parts.push(t('retention.recap.feeds', { count: summary.stats.feedsReached }));
    }
    if (tally.activeDays > 0) {
      parts.push(t('retention.recap.active_days', { days: tally.activeDays, total: tally.windowDays }));
    }
    return parts;
  }, [tally, summary, t]);

  if (!visible || segments.length === 0) return null;

  const dismiss = () => {
    setStorageItem(DISMISS_KEY, today, StorageTTL.UI_STATE);
    // Clears the day-eligibility, not a separate visibility latch — `visible` is
    // derived, so dropping this is what hides the card, and it stays hidden for
    // the rest of the day via the persisted DISMISS_KEY above.
    setEligibleDay(false);
  };

  return (
    <section
      className={`relative rounded-panel border border-line-9 bg-surface-12 px-5 py-4 ${className ?? ''}`}
      data-testid="retention-weekly-recap"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('retention.recap.dismiss')}
        data-testid="retention-weekly-recap-dismiss"
        className="absolute right-3 top-3 rounded-full p-1.5 text-ink-14 transition-colors hover:bg-surface-23 hover:text-ink-7"
      >
        <Icons.close className="h-4 w-4" />
      </button>

      <p className="pr-8 font-sans text-label font-semibold uppercase tracking-label text-ink-14">
        {t('retention.recap.title')}
      </p>
      <p className="mt-1.5 font-sans text-[17px] font-semibold leading-[26px] text-ink-2" data-testid="retention-weekly-recap-line">
        {segments.join(' · ')}
      </p>
      {/* ★ THE "note" LINE IS DELETED (2026-08-09). It read: "No trophy, no
          streak-saver to buy, no guilt. Just what happened." Three of those four
          clauses describe things the card does not do, which is the system defending
          itself on a card whose entire job is to report four numbers. The numbers say
          it. */}
      <Link
        href="/ranks"
        className="mt-2.5 inline-block font-sans text-[14px] leading-[22px] font-semibold text-ink-brand-6 hover:underline"
        data-testid="retention-weekly-recap-link"
      >
        {t('retention.recap.link')}
      </Link>
    </section>
  );
}
