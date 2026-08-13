'use client';

import { useEffect, useMemo, useState } from 'react';
import { Link } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
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
  const { user } = useUserClient();
  // Whichever ladder applies — a lite account's "N people engaged" is a real
  // measured number from our own database, and this card used to skip it purely
  // because the chain hook could not answer for them.
  const { summary } = useViewerRetention();

  // Everything below depends on the clock and on storage, so it must not run
  // during SSR — an unmounted first paint keeps hydration deterministic.
  const [visible, setVisible] = useState(false);
  const [today, setToday] = useState('');

  useEffect(() => {
    if (!user.isLoggedIn) return;
    const now = new Date();
    if (now.getDay() !== MONDAY) return;
    const day = utcDayKey(now);
    if (getStorageItem<string>(DISMISS_KEY) === day) return;
    setToday(day);
    setVisible(true);
  }, [user.isLoggedIn]);

  const tally = useMemo(() => (visible ? weekTally() : null), [visible]);

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
    setVisible(false);
  };

  return (
    <section
      className={`relative rounded-[18px] border border-[#ebebeb] bg-[#faf9f6] px-5 py-4 ${className ?? ''}`}
      data-testid="retention-weekly-recap"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('retention.recap.dismiss')}
        data-testid="retention-weekly-recap-dismiss"
        className="absolute right-3 top-3 rounded-full p-1.5 text-[#9ca3af] transition-colors hover:bg-[#f1f3f5] hover:text-[#3f4650]"
      >
        <Icons.close className="h-4 w-4" />
      </button>

      <p className="pr-8 font-sans text-[13px] leading-[20px] font-semibold uppercase tracking-[0.06em] text-[#9ca3af]">
        {t('retention.recap.title')}
      </p>
      <p className="mt-1.5 font-sans text-[17px] font-semibold leading-[26px] text-[#161511]" data-testid="retention-weekly-recap-line">
        {segments.join(' · ')}
      </p>
      {/* ★ THE "note" LINE IS DELETED (2026-08-09). It read: "No trophy, no
          streak-saver to buy, no guilt. Just what happened." Three of those four
          clauses describe things the card does not do, which is the system defending
          itself on a card whose entire job is to report four numbers. The numbers say
          it. */}
      <Link
        href="/ranks"
        className="mt-2.5 inline-block font-sans text-[14px] leading-[22px] font-semibold text-[#c0392b] hover:underline"
        data-testid="retention-weekly-recap-link"
      >
        {t('retention.recap.link')}
      </Link>
    </section>
  );
}
