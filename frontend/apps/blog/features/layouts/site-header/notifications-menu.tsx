'use client';

import { ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleSpinner } from 'react-spinners-kit';
import { Popover, PopoverContent, PopoverTrigger } from '@ui/components/popover';
import { getAccountNotifications } from '@transaction/lib/bridge-api';
import NotificationList from '@/blog/features/activity-log/list';
import { useMarkAllNotificationsAsReadMutation } from '@/blog/features/activity-log/hooks/use-notifications-read-mutation';
import BasePathLink from '@/blog/components/base-path-link';
import TimeAgo from '@ui/components/time-ago';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';

/**
 * Item 12 (Lane A follow-up, 2026-08-06): the standalone Notifications page
 * at /@{user}/notifications is gone — an unstyled inherited page the owner
 * asked to remove outright, not just unlink. Lumen now surfaces
 * notifications in exactly one place: this popover on the header bell.
 *
 * Reuses the SAME data the deleted page fetched (getAccountNotifications,
 * keyed ['AccountNotification', username] — identical to the page's own
 * query) and the SAME per-row renderer (NotificationList -> its
 * NotificationListItem, from features/activity-log) instead of
 * reimplementing notification rendering a second time.
 *
 * Deliberately NOT carried over from the page: the type tabs (all/replies/
 * mentions/follows/upvotes/reblogs), pagination, and the unclaimed-rewards
 * banner. Those are page-scale features that don't fit a header popover.
 *
 * ★ "Mark all as read" IS carried over now (2026-08-10, owner item Q-3),
 * because it turned out not to be a page-scale feature at all: it is one
 * on-chain custom_json, the mutation already exists
 * (`useMarkAllNotificationsAsReadMutation`), and without it the bell's unread
 * badge had no way to ever return to zero once the standalone page was
 * deleted. There is still NO "see all" link, and there should not be one: the
 * page it would point at does not exist. Hive's own API caps this list at the
 * last 90 days.
 */
const NotificationsMenu = ({
  username,
  lastRead,
  children,
  chainAccount = true,
  unreadCount = 0
}: {
  username: string;
  lastRead: Date;
  children: ReactNode;
  /** False for a Lumen lite account — it has no chain notifications to fetch. */
  chainAccount?: boolean;
  /**
   * From the header's own `bridge.unread_notifications` query — the same number
   * the bell's badge shows, so the panel and the badge can never disagree.
   */
  unreadCount?: number;
}) => {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('common_blog');
  const markAllAsRead = useMarkAllNotificationsAsReadMutation();

  // Fetch only once the popover is actually opened — no reason to pull the
  // full notification list on every page load just because the bell is
  // in the header.
  // ★ Never ask the chain about a lite handle: `bridge.account_notifications`
  //   asserts "Account <name> does not exist", React Query retries, and the
  //   popover sits on "Loading" while it does. The empty state below is the
  //   correct and final answer for a lite reader today.
  const enabled = open && !!username && chainAccount;
  const { data: notifications, isLoading } = useQuery({
    queryKey: ['AccountNotification', username],
    queryFn: () => getAccountNotifications(username),
    enabled
  });

  // ★★ LUMEN-NATIVE NOTIFICATIONS (2026-08-09, tester BASELINE-03). Following
  // someone on Lumen never reached the person followed: this bell had ONE data
  // source, the chain, and a Lumen follow is never written there. So a real
  // social action was silent for everyone — including a full Hive account
  // followed by a lite reader. Fetched for BOTH tiers for exactly that reason;
  // `chainAccount` gates only the CHAIN half.
  const { data: liteNotifications } = useQuery({
    queryKey: ['LumenNotifications', username],
    queryFn: async (): Promise<{ msg: string; url: string; date: string }[]> => {
      const res = await fetch(`/api/lite/notifications?hive=${encodeURIComponent(username)}`);
      if (!res.ok) return [];
      const body = (await res.json()) as { notifications?: { msg: string; url: string; date: string }[] };
      return body.notifications ?? [];
    },
    enabled: open && !!username
  });
  const lumenItems = liteNotifications ?? [];
  // ★ A DISABLED React Query still reports `isLoading: true` — status is
  //   'loading' whenever there is no data, whether or not it will ever fetch.
  //   Rendering the spinner off that alone left a lite reader's bell spinning
  //   forever on a query that was deliberately never going to run. Only show
  //   the spinner for a fetch that is actually in flight.
  const showSpinner = enabled && isLoading;

  // Only a chain account can sign the custom_json this broadcasts, and there is
  // nothing to mark when nothing is unread.
  const canMarkAllRead = chainAccount && unreadCount > 0;

  const handleMarkAllAsRead = async () => {
    if (markAllAsRead.isPending) return;
    // The API wants a naive timestamp, matching what the deleted page sent.
    const now = new Date().toISOString();
    const date = now.slice(0, now.length - 5);
    try {
      await markAllAsRead.mutateAsync({ date });
    } catch (error) {
      handleError(error, { method: 'markAllNotificationsAsRead', params: { date } });
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        // ★ A FLOATING PANEL NEEDS ELEVATION AND THE HOUSE RADIUS (2026-08-10,
        // owner item Q-1). This was `rounded-md` (6px) with the shared
        // `shadow-md`, which against Lumen's white page read as no shadow at
        // all: a white rectangle on a white page with a hairline border, hard
        // to tell from the page behind it. 14px is the product's row/button
        // radius, and `overflow-hidden` makes the first and last rows follow
        // the corner instead of squaring it off.
        className="w-[360px] overflow-hidden rounded-[14px] border-[#ebebeb] p-0 shadow-[0_12px_32px_rgba(20,18,10,0.14)]"
        data-testid="notifications-popover-content"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#ebebeb] px-4 py-2.5">
          <span className="font-sans text-sm font-semibold text-[#161511]">
            {t('navigation.user_menu.notifications')}
            {unreadCount > 0 ? (
              <span className="ml-1.5 font-normal text-[#6b7280]">
                {t('navigation.profile_notifications_tab_navbar.unread_count', { count: unreadCount })}
              </span>
            ) : null}
          </span>
          {canMarkAllRead ? (
            <button
              type="button"
              onClick={handleMarkAllAsRead}
              disabled={markAllAsRead.isPending}
              className="shrink-0 rounded-[14px] px-2 py-1 font-sans text-[12.5px] font-semibold text-[#c0392b] transition-colors hover:bg-[#fdf2f0] disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="notifications-mark-all-read"
            >
              {markAllAsRead.isPending ? (
                <CircleSpinner loading size={14} color="#c0392b" />
              ) : (
                t('navigation.profile_notifications_tab_navbar.mark_all')
              )}
            </button>
          ) : null}
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {/* Lumen's own events first: they are the ones this reader can act on
              inside Lumen, and for a lite account they are the ONLY ones there
              will ever be. Rendered as their own rows rather than coerced into
              the chain notification type, which carries chain-only fields. */}
          {lumenItems.length > 0 ? (
            <ul data-testid="lumen-notifications">
              {lumenItems.map((n) => (
                <li key={`${n.url}-${n.date}`} className="border-b border-[#ebebeb] last:border-0">
                  <BasePathLink
                    href={`/${n.url}`}
                    className="flex flex-col gap-0.5 px-4 py-3 font-sans text-sm hover:bg-[#f4f5f7]"
                  >
                    <span className="text-[#161511]">{n.msg}</span>
                    <span className="text-xs text-[#6b7280]">
                      {/* Same single format as the chain rows below. */}
                      <TimeAgo date={n.date} numeric="always" />
                    </span>
                  </BasePathLink>
                </li>
              ))}
            </ul>
          ) : null}
          {showSpinner ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#6b7280]">
              <CircleSpinner loading size={16} color="#71717a" />
              {t('global.loading')}
            </div>
          ) : notifications && notifications.length > 0 ? (
            // The bell only ever renders for the signed-in reader, so this list
            // is always theirs — which the row itself has no way to know.
            <NotificationList data={notifications} lastRead={lastRead} isOwner />
          ) : lumenItems.length > 0 ? null : (
            <div
              className="flex flex-col items-center justify-center px-4 py-10 text-center text-sm text-[#6b7280]"
              data-testid="notifications-popover-empty"
            >
              {t('navigation.profile_notifications_tab_navbar.no_notifications_yet')}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default NotificationsMenu;
