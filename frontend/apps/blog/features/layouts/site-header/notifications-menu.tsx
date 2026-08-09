'use client';

import { ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleSpinner } from 'react-spinners-kit';
import { Popover, PopoverContent, PopoverTrigger } from '@ui/components/popover';
import { getAccountNotifications } from '@transaction/lib/bridge-api';
import NotificationList from '@/blog/features/activity-log/list';
import BasePathLink from '@/blog/components/base-path-link';
import TimeAgo from '@ui/components/time-ago';
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
 * mentions/follows/upvotes/reblogs), "mark all as read", pagination, and
 * the unclaimed-rewards banner. Those are page-scale features that don't
 * fit a ~320px header popover — ask for any of them back explicitly if
 * wanted.
 *
 * Known limitation: NotificationListItem derives "is this notification for
 * the page owner" from the URL path (it was built for a route shaped like
 * /@{username}/notifications). This popover renders on every page, not
 * just that one, so on any page other than the user's own profile the
 * per-row unread highlighting will not activate — the row still renders
 * correctly (avatar, message, link, timestamp), it just won't get the
 * "unread" tint. The bell's own unread-count badge (in app-header.tsx) is
 * unaffected — it comes from a separate query and isn't touched by this.
 */
const NotificationsMenu = ({
  username,
  lastRead,
  children,
  chainAccount = true
}: {
  username: string;
  lastRead: Date;
  children: ReactNode;
  /** False for a Lumen lite account — it has no chain notifications to fetch. */
  chainAccount?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('common_blog');

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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="notifications-popover-content">
        <div className="border-b border-border px-4 py-2 text-sm font-semibold">
          {t('navigation.user_menu.notifications')}
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {/* Lumen's own events first: they are the ones this reader can act on
              inside Lumen, and for a lite account they are the ONLY ones there
              will ever be. Rendered as their own rows rather than coerced into
              the chain notification type, which carries chain-only fields. */}
          {lumenItems.length > 0 ? (
            <ul data-testid="lumen-notifications">
              {lumenItems.map((n) => (
                <li key={`${n.url}-${n.date}`} className="border-b border-border last:border-0">
                  <BasePathLink
                    href={`/${n.url}`}
                    className="flex flex-col gap-0.5 px-4 py-3 text-sm hover:bg-accent"
                  >
                    <span className="text-foreground">{n.msg}</span>
                    <span className="text-xs text-gray-500">
                      <TimeAgo date={n.date} />
                    </span>
                  </BasePathLink>
                </li>
              ))}
            </ul>
          ) : null}
          {showSpinner ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
              <CircleSpinner loading size={16} color="#71717a" />
              {t('global.loading')}
            </div>
          ) : notifications && notifications.length > 0 ? (
            <NotificationList data={notifications} lastRead={lastRead} />
          ) : lumenItems.length > 0 ? null : (
            <div
              className="flex flex-col items-center justify-center px-4 py-10 text-center text-sm text-gray-500"
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
