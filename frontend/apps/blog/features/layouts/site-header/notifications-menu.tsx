'use client';

import { ReactNode, forwardRef, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleSpinner } from 'react-spinners-kit';
import { Popover, PopoverContent, PopoverTrigger } from '@ui/components/popover';
import { fetchAccountNotifications } from '@/blog/lib/chain-fetch';
import NotificationListItem from '@/blog/features/activity-log/list-item';
import { CreatorTokenLaurel } from '@/blog/features/creator-tokens/ui/creator-token-laurel';

/**
 * ★★★ CHAIN DATES ARE NAIVE UTC AND MUST BE SAID SO BEFORE THEY ARE COMPARED.
 *
 * `bridge.account_notifications` returns "2026-09-11T13:14:06" — no marker — and
 * `new Date()` reads an unmarked string as BROWSER-LOCAL, so in UTC+2 every chain
 * row would sort two hours earlier than it happened. Lumen's own rows carry a real
 * `Z`. Merging the two without this makes the order wrong by the reader's own
 * offset, which is invisible in London and obvious in Sydney. Same normalisation
 * `features/proposals/lib/proposals-format.ts parseChainDate` already applies for
 * the same reason.
 */
const notifiedAt = (d: string): number => {
  const zoned = d.indexOf('.') !== -1 || d.indexOf('+') !== -1 || d.endsWith('Z');
  return new Date(zoned ? d : `${d}.000Z`).getTime();
};
import { useMarkAllNotificationsAsReadMutation } from '@/blog/features/activity-log/hooks/use-notifications-read-mutation';
import BasePathLink from '@/blog/components/base-path-link';
import TimeAgo from '@ui/components/time-ago';
import { UserAvatarImg } from '@ui/components';
import type { LumenNotification } from './use-lumen-notifications';
import type { IAccountNotification } from '@hive/common-hiveio-packages/wax';
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
 *
 * ★★★ FORWARDS ITS REF (2026-08-11, audit item 7a). `app-header.tsx` renders
 * this as the child of `<TooltipContainer asChild>` (`packages/ui/components
 * /tooltip-container.tsx`), so Radix clones IT and hands it a ref to measure
 * for tooltip positioning — same shape as the bug fixed in
 * `components/dialog-login.tsx` (P0-4): React warned "Function components
 * cannot be given refs. Check the render method of `SlotClone`", and the ref
 * is aimed at THIS component, not at `children` (a plain `<Button>` two
 * levels in, which already forwards fine on its own). Forwarding to
 * `PopoverTrigger` puts the ref back on the real DOM node, exactly like
 * `DialogTrigger asChild ref={ref}` does in dialog-login.tsx.
 */
const NotificationsMenu = forwardRef<HTMLButtonElement, {
  username: string;
  lastRead: Date;
  children: ReactNode;
  /** False for a Lumen lite account — it has no chain notifications to fetch. */
  chainAccount?: boolean;
  /**
   * The bell's badge number — chain unread PLUS Lumen unread, so the panel and
   * the badge can never disagree. See `use-lumen-notifications.ts` for why that
   * used to be one half of the truth.
   */
  unreadCount?: number;
  /**
   * The CHAIN half alone. "Mark all as read" broadcasts a chain custom_json and
   * therefore only clears chain notifications; offering it because Lumen follows
   * are unread would be a button that visibly does nothing.
   */
  chainUnreadCount?: number;
  /** Lumen-native rows, fetched once by the header. */
  lumenItems?: LumenNotification[];
  /** Advances the Lumen read mark. Fired when the panel actually opens. */
  onOpened?: () => void;
}>(function NotificationsMenu(
  {
    username,
    lastRead,
    children,
    chainAccount = true,
    unreadCount = 0,
    chainUnreadCount = unreadCount,
    lumenItems = [],
    onOpened
  },
  ref
) {
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
  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
  // `getAccountNotifications` directly, which downloads `wax.common.wasm` —
  // mounted in the header on every page, and reachable by any signed-in Hive
  // reader who opens the bell. See
  // `apps/blog/app/api/notifications/account/route.ts`.
  const enabled = open && !!username && chainAccount;

  /**
   * ★★★ A FAILED LIST RENDERED AS AN EMPTY ONE (2026-08-18, owner: "shows 3 on
   * the bell and there's nothing inside").
   *
   * This destructured only `data` and `isLoading`. There was no error branch
   * anywhere in the component, so when `/api/notifications/account` failed the
   * query settled with `data === undefined` and the render fell through to the
   * SAME "No notifications yet" panel a reader with genuinely nothing sees.
   * The badge, meanwhile, is fed by a different endpoint
   * (`bridge.unread_notifications`) that had succeeded — so the two disagreed
   * and the panel blamed the reader's empty inbox for a network failure.
   *
   * Verified 2026-08-18 that the route itself is healthy for this account
   * (`unread: 3`, and 50 rows back from `/api/notifications/account`), which is
   * exactly why the silent-failure path is the defect worth fixing: the data is
   * there, so an empty panel can only ever mean the fetch did not land.
   *
   * `retry: 1` because the default 3 spends ~7s of backoff before the reader is
   * told anything, behind a panel that claims to be empty the whole time.
   */
  const {
    data: notifications,
    isLoading,
    isError,
    refetch
  } = useQuery({
    queryKey: ['AccountNotification', username],
    queryFn: () => fetchAccountNotifications(username),
    enabled,
    retry: 1
  });

  /**
   * ★ ONE FEED, ONE ORDERING. Lumen rows (follows, DMs, buys of your Meritum) and
   * chain rows are interleaved by TIME. See the render's own note on why they used
   * to be two stacked lists and what that did to a six-week-old follow.
   */
  const merged = useMemo(() => {
    const rows: Array<
      { kind: 'lumen'; at: number; item: LumenNotification } | { kind: 'chain'; at: number; item: IAccountNotification & { rep?: number } }
    > = [];
    for (const item of lumenItems) rows.push({ kind: 'lumen', at: notifiedAt(item.date), item });
    for (const item of notifications ?? []) rows.push({ kind: 'chain', at: notifiedAt(item.date), item });
    return rows.sort((a, b) => b.at - a.at);
  }, [lumenItems, notifications]);


  // ★★ LUMEN-NATIVE NOTIFICATIONS (2026-08-09, tester BASELINE-03). Following
  // someone on Lumen never reached the person followed: this bell had ONE data
  // source, the chain, and a Lumen follow is never written there. So a real
  // social action was silent for everyone — including a full Hive account
  // followed by a lite reader. Fetched for BOTH tiers for exactly that reason;
  // `chainAccount` gates only the CHAIN half.
  //
  // ★ THE FETCH MOVED UP TO THE HEADER (2026-08-16). It used to live here with
  // `enabled: open`, which meant the badge could not count these rows — it had
  // no way to know they existed until after the panel it labels was already
  // open. The header owns it now and passes the rows in.
  // ★ A DISABLED React Query still reports `isLoading: true` — status is
  //   'loading' whenever there is no data, whether or not it will ever fetch.
  //   Rendering the spinner off that alone left a lite reader's bell spinning
  //   forever on a query that was deliberately never going to run. Only show
  //   the spinner for a fetch that is actually in flight.
  const showSpinner = enabled && isLoading;

  // Only a chain account can sign the custom_json this broadcasts, and there is
  // nothing to mark when nothing is unread.
  const canMarkAllRead = chainAccount && chainUnreadCount > 0;

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
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // On OPEN only. Clearing on close would mean a panel dismissed by a
        // stray Escape counts as read, and clearing on both fires it twice.
        if (next) onOpened?.();
      }}
    >
      <PopoverTrigger asChild ref={ref}>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        // ★ A FLOATING PANEL NEEDS ELEVATION AND THE HOUSE RADIUS (2026-08-10,
        // owner item Q-1). This was `rounded-md` (6px) with the shared
        // `shadow-md`, which against Lumen's white page read as no shadow at
        // all: a white rectangle on a white page with a hairline border, hard
        // to tell from the page behind it. 14px is the product's row/button
        // radius, and `overflow-hidden` makes the first and last rows follow
        // the corner instead of squaring it off.
        className="w-[360px] overflow-hidden rounded-card border-line-9 p-0 shadow-[0_12px_32px_rgba(20,18,10,0.14)]"
        data-testid="notifications-popover-content"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-9 px-4 py-2.5">
          <span className="font-sans text-sm font-semibold text-ink-2">
            {t('navigation.user_menu.notifications')}
            {unreadCount > 0 ? (
              <span className="ml-1.5 font-normal text-ink-10">
                {t('navigation.profile_notifications_tab_navbar.unread_count', { count: unreadCount })}
              </span>
            ) : null}
          </span>
          {canMarkAllRead ? (
            <button
              type="button"
              onClick={handleMarkAllAsRead}
              disabled={markAllAsRead.isPending}
              className="shrink-0 rounded-card px-2 py-1 font-sans text-caption font-semibold text-ink-brand-6 transition-colors hover:bg-surface-brand-5 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="notifications-mark-all-read"
            >
              {markAllAsRead.isPending ? (
                // ★ NOT A LITERAL: this button is `text-ink-brand-6` while idle
                // (line above) — `rgb(var(--ink-brand-6))` keeps the spinner that
                // same red instead of reintroducing the stale `#c0392b` hex.
                <CircleSpinner loading size={14} color="rgb(var(--ink-brand-6))" />
              ) : (
                t('navigation.profile_notifications_tab_navbar.mark_all')
              )}
            </button>
          ) : null}
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {/* ★★★ ONE LIST, SORTED BY TIME (2026-09-11, owner: "chadmasters follow
              is stuck on top of my notifications forever... it doesn't go in the
              list, it's stuck on top").

              It was not stuck and it was not the lite account: Lumen's own rows
              were rendered in their OWN <ul> ABOVE the chain list, unconditionally.
              A follow from six weeks ago therefore outranked a reply from a minute
              ago forever, because the two lists never compared dates with each
              other — position encoded SOURCE, which the reader has no reason to
              care about, instead of TIME, which is the only thing a notification
              feed is ordered by.

              Now both are merged and sorted newest-first, and a Lumen row falls
              down the list as it ages exactly like a chain row. The renderers stay
              separate — a follow carries no score, no permalink and no chain id —
              but they live in one ordered list. */}
          {showSpinner ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-10">
              <CircleSpinner loading size={16} color="#71717a" />
              {t('global.loading')}
            </div>
          ) : merged.length > 0 ? (
            <div className="flex flex-col divide-y divide-border-secondary" data-testid="lumen-notifications">
              {merged.map((row) =>
                row.kind === 'lumen' ? (
                  <BasePathLink
                    key={`lumen-${row.item.url}-${row.item.date}`}
                    href={`/${row.item.url}`}
                    className="flex items-center gap-3 px-4 py-3 font-sans text-sm hover:bg-surface-21"
                  >
                    {/* ★ THE SAME FACE THE CHAIN ROWS SHOW (2026-08-16, owner).
                        `UserAvatarImg` resolves a lite account through /api/avatar
                        to their own initial rather than a shared default. */}
                    <UserAvatarImg
                      username={row.item.actor ?? row.item.url.replace(/^@/, '')}
                      pixelSize={40}
                      alt={`${row.item.actor ?? row.item.url.replace(/^@/, '')} profile picture`}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-ink-2">{row.item.msg}</span>
                      <span className="flex items-center gap-1.5 text-caption text-ink-10">
                        {/* The Meritum mark, at the 16px the timestamp line can
                            carry — the same glyph the left rail uses for the
                            feature, so a buy row is recognisable as one at a
                            glance the way a vote or a reply already is. Only on
                            BUY rows: a follow is not a Meritum event. */}
                        {row.item.type === 'buy' ? (
                          <CreatorTokenLaurel size={16} className="shrink-0 text-ink-brand-6" />
                        ) : null}
                        <TimeAgo date={row.item.date} numeric="always" />
                      </span>
                    </span>
                  </BasePathLink>
                ) : (
                  <NotificationListItem
                    key={`chain-${row.item.id}-${row.item.type}`}
                    date={row.item.date}
                    msg={row.item.msg}
                    rep={row.item.rep}
                    score={row.item.score}
                    type={row.item.type}
                    url={row.item.url}
                    id={row.item.id}
                    lastRead={lastRead}
                    // The bell only ever renders for the signed-in reader, so this
                    // list is always theirs — which the row cannot work out itself.
                    isOwner
                  />
                )
              )}
            </div>

          ) : isError || (unreadCount > 0 && !notifications && lumenItems.length === 0) ? (
            /* ★★★ THE PANEL MAY NEVER CONTRADICT ITS OWN BADGE (2026-08-18).
               The reported bug was "3 unread" over "No notifications yet", and
               it was NOT an error — the list query simply never ran, so it held
               no data and fell through to the same empty state a reader with
               genuinely nothing sees. An empty state that cannot tell "nothing
               to show" apart from "never fetched" is unfalsifiable: it looks
               calm while being wrong. If the badge counted something, this list
               owes the reader either those rows or an honest failure. */
            // Say what happened and offer the way out. Never the empty state:
            // "you have nothing" and "we could not load your things" are
            // different sentences and only one of them is ever true here.
            <div
              className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-sm text-ink-10"
              data-testid="notifications-popover-error"
            >
              <span>{t('navigation.profile_notifications_tab_navbar.notifications_error')}</span>
              <button
                type="button"
                onClick={() => refetch()}
                className="font-sans text-caption font-semibold text-ink-brand-6 underline-offset-2 hover:underline"
                data-testid="notifications-popover-retry"
              >
                {t('navigation.profile_notifications_tab_navbar.notifications_retry')}
              </button>
            </div>
          ) : lumenItems.length > 0 ? null : (
            <div
              className="flex flex-col items-center justify-center px-4 py-10 text-center text-sm italic text-ink-10"
              data-testid="notifications-popover-empty"
            >
              {t('navigation.profile_notifications_tab_navbar.no_notifications_yet')}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});

export default NotificationsMenu;
