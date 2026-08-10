'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import { getAccountNotifications, getUnreadNotifications } from '@transaction/lib/bridge-api';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { useTranslation } from '@/blog/i18n/client';
import { engagementCounts } from '@/blog/lib/moderation/engagement-exclusions';
import { useViewerRetention } from '../hooks/use-viewer-retention';
import { selectNudge, type Nudge } from '../lib/nudge';
import { utcDayKey } from './retention-moments';

/**
 * ★ THE IN-APP NUDGE (owner ruling, 2026-08-09: "build the in app nudge. i love that.
 * make it fun and sophisticated.")
 *
 * One line, top of the feed, dismissible, at most once a day. The selection rules and
 * the reasoning behind each candidate live in `lib/nudge.ts`, which is pure and
 * tested; this component owns only the once-a-day ledger, the translation, and the
 * one optional fetch.
 *
 * ★ IT RENDERS NOTHING FAR MORE OFTEN THAN IT RENDERS SOMETHING, AND THAT IS THE
 * DESIGN. `selectNudge` returns null when no candidate is true and interesting today,
 * and there is no fallback string to fill the gap. Web push is parked precisely
 * because a channel that must be fed every day becomes a nag; putting a fallback here
 * would reinvent the nag inside the app.
 *
 * ★ THE ONE EXTRA FETCH IS GATED ON A NUMBER WE ALREADY HAVE. The "@alice replied and
 * nobody has answered" candidate needs `bridge.account_notifications`, which is a real
 * upstream call and nothing on the home page makes it today. But
 * `['unreadNotifications', user]` IS already warm — the app header queries it on every
 * page — so the notification list is only fetched when that count says there is
 * something to find. No unread, no call.
 */

const DISMISS_KEY = 'retention-nudge-v1';
/** How many notifications to look through for an unanswered reply. */
const NOTIFICATION_SCAN = 12;

interface ShownLedger {
  /** UTC day the nudge was last shown or dismissed. */
  day: string;
  /** Which kind, so the same line does not reappear the next day. */
  kind: string;
}

/** A Hive notification, narrowed to the fields this reads. */
interface NotificationLike {
  type?: string;
  msg?: string;
  url?: string;
  date?: string;
}

/** "4 hours ago" style, kept short and never precise enough to imply a countdown. */
function agoLabel(iso: string, now: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const ms = now - Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (!Number.isFinite(ms) || ms < 0) return t('retention.nudge.ago_recent');
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return t('retention.nudge.ago_recent');
  if (hours < 24) return t('retention.nudge.ago_hours', { count: hours });
  return t('retention.nudge.ago_days', { count: Math.floor(hours / 24) });
}

export function RetentionNudge({ className }: { className?: string }) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const { summary } = useViewerRetention();

  // Everything below depends on the clock and on storage, so it must not run during
  // SSR — an unmounted first paint keeps hydration deterministic.
  const [today, setToday] = useState('');
  const [dismissedKinds, setDismissedKinds] = useState<string[]>([]);

  useEffect(() => {
    if (!user.isLoggedIn) return;
    const day = utcDayKey(new Date());
    const stored = getStorageItem<ShownLedger>(DISMISS_KEY);
    setToday(day);
    // A nudge already shown TODAY suppresses everything for the rest of the day.
    // Yesterday's kind is remembered too, so the same line never lands twice running.
    setDismissedKinds(stored && stored.day === day ? ['*'] : stored ? [stored.kind] : []);
  }, [user.isLoggedIn]);

  // Warm from the app header on every page; costs nothing to read here.
  const { data: unread } = useQuery({
    queryKey: ['unreadNotifications', user.username],
    queryFn: () => getUnreadNotifications(user.username),
    enabled: Boolean(user.isLoggedIn && user.username),
    staleTime: 5 * 60 * 1000
  });

  // ONLY fetched when the count above says there is something to find.
  const { data: notifications } = useQuery({
    queryKey: ['retention-nudge-notifications', user.username],
    queryFn: () => getAccountNotifications(user.username, undefined, NOTIFICATION_SCAN),
    enabled: Boolean(user.isLoggedIn && user.username && (unread?.unread ?? 0) > 0),
    staleTime: 5 * 60 * 1000
  });

  // The reply's own permalink, resolved in the same memo that picks the nudge so the two cannot
  // disagree about WHICH reply is being talked about.
  const [nudge, replyHref] = useMemo<[Nudge | null, string | null]>(() => {
    if (!today || !summary || dismissedKinds.includes('*')) return [null, null];

    const stats = summary.stats;
    const coverage = summary.provenance?.coverage;
    const now = new Date();

    // The newest reply TO this reader. `bridge.account_notifications` types replies as
    // 'reply' / 'reply_comment'; anything else (vote, mention, follow) is not an
    // unfinished conversation and must not be dressed as one.
    // ★★ AND NOT FROM A BOT (owner ruling, 2026-08-09: "the comments get spammed").
    //
    // `pizzabot`, `hivebuzz` and the rest of the engagement exclusion list reply to
    // hundreds of posts a day. Unfiltered, the single most valuable line in this whole
    // feature — the one a UX tester called "the only thing here that would bring me back
    // tomorrow", because it is about a PERSON — would regularly be an invitation to answer
    // a bot. That is worse than showing nothing: it teaches the reader the nudge is noise.
    //
    // Both lists apply, same predicate as the giver headcount, so "who counts as a person"
    // has exactly one definition in this feature. The author is resolved BEFORE the filter
    // because the name is what gets tested — a reply we cannot attribute is dropped too,
    // since `engagementCounts(undefined)` is false and an unattributable reply cannot be
    // answered anyway.
    const reply = (notifications as NotificationLike[] | undefined)?.find((n) => {
      if (n.type !== 'reply' && n.type !== 'reply_comment') return false;
      return engagementCounts(n.msg?.match(/@([a-z0-9.-]{3,16})/)?.[1]);
    });
    const replyAuthor = reply?.msg?.match(/@([a-z0-9.-]{3,16})/)?.[1];

    const picked = selectNudge({
      streakDays: summary.streakDays,
      streakIsLowerBound: coverage?.streakDaysIsLowerBound === true,
      actsToday: summary.today?.acts ?? 0,
      freezesAvailable: summary.today?.freezesAvailable ?? 0,
      // The reader's LOCAL weekday, not UTC. "It is Tuesday" has to be true where the
      // person reading it is standing; the pattern itself is computed in UTC, and a
      // one-day disagreement at the edges is a far smaller lie than telling somebody
      // in Auckland it is Monday.
      todayWeekday: now.getDay(),
      busiestWeekday: stats?.busiestWeekday,
      people: stats?.people,
      newPeopleThisWeek: stats?.newPeople,
      firstTimeGiverName: stats?.newestGiverName,
      feedsReached: stats?.feedsReached,
      unansweredReply:
        reply?.date && replyAuthor ? { author: replyAuthor, ago: agoLabel(reply.date, now.getTime(), t) } : undefined
    });

    // Never the same line two days running, even when it is still the best candidate.
    if (picked && dismissedKinds.includes(picked.kind)) return [null, null];
    // `url` is `@author/permlink` with no leading slash. Guarded rather than trusted: a
    // notification without one must produce no link, not `/undefined`.
    const href = reply?.url && /^@[a-z0-9.-]+\/[a-z0-9-]+$/i.test(reply.url) ? `/${reply.url}` : null;
    return [picked, href];
  }, [today, summary, notifications, dismissedKinds, t]);

  if (!nudge || !today) return null;

  const dismiss = () => {
    setStorageItem<ShownLedger>(DISMISS_KEY, { day: today, kind: nudge.kind }, StorageTTL.UI_STATE);
    setDismissedKinds(['*']);
  };

  // The weekday candidate needs the day NAME twice: once as the pattern ("Tuesdays")
  // and once as the flat statement ("It is Tuesday").
  const vars =
    nudge.kind === 'weekday_today'
      ? {
          day: t(`retention.weekday.${nudge.vars.weekday}`),
          day_short: t(`retention.weekday_one.${nudge.vars.weekday}`)
        }
      : nudge.kind === 'milestone'
        ? { days: nudge.vars.days }
        : nudge.vars;

  const key =
    nudge.kind === 'milestone' && Number(nudge.vars.month) === 1
      ? 'retention.nudge.milestone_month'
      : `retention.nudge.${nudge.kind}`;

  return (
    <section
      className={`relative flex items-start gap-3 rounded-[16px] border border-[#ebebeb] bg-[#faf9f6] px-5 py-3.5 ${className ?? ''}`}
      data-testid="retention-nudge"
      data-nudge-kind={nudge.kind}
    >
      <p className="min-w-0 flex-1 pr-6 font-sans text-[15px] leading-snug text-[#3f4650]">
        {t(key, vars)}
        {/* ★★ IT LINKED TO `/notifications`, WHICH DOES NOT EXIST (found 2026-08-09 by a UX
            agent: "the nudge's only CTA 404s"). Not a typo — `app/notifications` was never
            created, and `notifications-menu.tsx` records that the old `/@{user}/notifications`
            PAGE was deliberately deleted in favour of a popover. So the single line two testers
            named as the best thing in this feature, the only one that gives anybody a reason to
            come back, ended at a 404.
            The right target was never a notifications page anyway: the notification carries
            `url` = `@author/permlink`, so this goes to THE ACTUAL UNANSWERED REPLY. Lumen 302s
            `/@author/permlink` to the canonical category URL (verified: 302 ->
            /hive-163772/@olga.maslievich/tjh3ne -> 200), so one hop and the reader is looking at
            the comment they were told about. Absent when the notification carried no url — the
            sentence stands on its own and a dead link is worse than no link. */}
        {nudge.kind === 'unanswered' && replyHref ? (
          <>
            {' '}
            <Link href={replyHref} className="font-semibold text-[#c0392b] hover:underline">
              {t('retention.nudge.open')}
            </Link>
          </>
        ) : null}
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('retention.nudge.dismiss')}
        data-testid="retention-nudge-dismiss"
        className="absolute right-3 top-3 rounded-full p-1.5 text-[#9ca3af] transition-colors hover:bg-[#f1f3f5] hover:text-[#3f4650]"
      >
        <Icons.close className="h-4 w-4" />
      </button>
    </section>
  );
}
