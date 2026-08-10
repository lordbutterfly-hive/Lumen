'use client';

import { FC, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, getUserAvatarUrl } from '@hive/ui';
import { Avatar, AvatarFallback, AvatarImage } from '@ui/components';
import { Button } from '@ui/components/button';
import { Icons } from '@ui/components/icons';
import TooltipContainer from '@ui/components/tooltip-container';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getUnreadNotifications } from '@transaction/lib/bridge-api';
import { useLoggedUserContext } from '@/blog/features/votes/hooks/use-logged-user';
import { useTranslation } from '@/blog/i18n/client';
import { hoursAndMinutes } from '@/blog/lib/utils';
import DialogLogin from '@/blog/components/dialog-login';
import UserMenu from '@/blog/features/layouts/site-header/user-menu';
import NotificationsMenu from '@/blog/features/layouts/site-header/notifications-menu';
import { ManabarRing } from '@/blog/features/layouts/site-header/manabar-ring';
import SearchButton from '@/blog/features/layouts/site-header/search-button';
import MobileNav from '@/blog/features/layouts/mobile-nav';
import { ModeSwitchInput } from '@ui/components/mode-switch-input';

// TODO i18n - move into locales/*/common_blog.json once copy is final
const LABELS = {
  homeAriaLabel: 'Lumen home',
  write: 'Write',
  notifications: 'Notifications',
  login: 'Log in'
};

/**
 * Minimal, Medium-style top header: wordmark far-left, a small icon
 * cluster far-right (search / write / notifications / avatar), nothing
 * in the center. Replaces MainBar's dense nav for a cleaner reading app.
 */
const AppHeader: FC = () => {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  const { manabarsData } = useLoggedUserContext();
  // ★ A LITE ACCOUNT HAS NO CHAIN NOTIFICATIONS, BECAUSE IT HAS NO CHAIN ACCOUNT.
  //
  // `bridge.unread_notifications({account})` asserts `Account <name> does not
  // exist` for a Lumen handle, and React Query retried it — measured FOUR
  // failing cross-origin calls on every single page load for every lite reader,
  // which is also why the bell could sit on "Loading". The bell degrades to
  // "No notifications yet" either way; this just stops asking a question whose
  // answer cannot exist.
  const isChainAccount = !!user.username && user.account_tier !== 'lite';
  const { data } = useQuery({
    queryKey: ['unreadNotifications', user.username],
    queryFn: () => getUnreadNotifications(user.username),
    enabled: isChainAccount
  });
  const upvotePercent = manabarsData?.upvote.percentageValue ?? 0;
  const downvotePercent = manabarsData?.downvote.percentageValue ?? 0;
  const rcPercent = manabarsData?.rc.percentageValue ?? 0;
  // Same fallback the deleted notifications page used: if nothing's been
  // read yet, treat "now" as the cutoff so nothing is retroactively unread.
  const lastRead = data?.lastread ? new Date(data.lastread) : new Date();

  return (
    <header
      className="sticky top-0 z-40 w-full border-b border-[#ebebeb] bg-white/90 font-sans backdrop-blur-md"
      translate="no"
    >
      {/* ★ gap-3 BELOW md, not gap-11 (2026-08-08). 44px is the desktop grid's
          GUTTER — the distance between the nav column and the content column —
          and it was being applied between the wordmark and the icon cluster on a
          phone too. Measured at 390px: wordmark 111 + gutter 44 + cluster 187 =
          342, which is exactly the 342px of content box available inside px-6.
          Zero slack: the header could not accept one more control at any width
          below 768px. The gutter has nothing to line up with here (the nav
          column does not exist below md), so it is just spent space. */}
      {/* ★ THREE CHILDREN, THREE COLUMNS AT md (2026-08-08). The md track list
          declared only TWO (`[200px_minmax(0,1fr)]`) while the header renders
          three visible children between 768px and 1279px — wordmark, search,
          action cluster — so the cluster was pushed onto an implicit SECOND ROW:
          at 820px the header rendered as "Lumen | Search…" over "✏ Log in",
          doubling its height and leaving Log in floating under the wordmark.
          Verified pre-existing (screenshotted at 820px before any change here).
          `auto` sizes the third column to the cluster; xl's explicit 312px
          right-rail column takes over unchanged above 1280px. */}
      <div className="mx-auto grid max-w-[1720px] grid-cols-[1fr_auto] items-center gap-3 px-6 py-[14px] md:grid-cols-[200px_minmax(0,1fr)_auto] md:gap-11 md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
        {/* col 1 — Open Sans wordmark over the nav column (design-handoff-v2: no
            serif display face). The 14px inset matches the left-rail rows' own
            px-[14px], so the wordmark's left edge lands on the nav icons' left
            edge instead of sitting 14px proud of the column. */}
        <Link href="/" aria-label={LABELS.homeAriaLabel} className="flex items-center md:pl-[14px]">
          {/* One extra responsive step below sm. The size ladder was already
              28 -> 34; a phone is the one width where the wordmark competes with
              the controls for room, and 24px buys 16 of the ~48 needed for the
              menu button. Unchanged at every width the design was drawn for. */}
          <span className="font-sans text-[24px] font-bold leading-none tracking-[-0.025em] text-[#161511] sm:text-[28px] lg:text-[34px]">
            Lumen
          </span>
        </Link>

        {/* col 2 — search spans the center column (desktop) */}
        <div className="hidden md:block">
          <ModeSwitchInput aiAvailable={false} />
        </div>

        {/* col 3 — action cluster over the right rail */}
        <div className="flex items-center justify-end gap-2 md:gap-3.5">
          <SearchButton aiTag={false} className="md:hidden" />

          <TooltipContainer title={LABELS.write}>
            {user?.isLoggedIn ? (
              <Link href="/submit.html">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-10 w-10 px-0"
                  aria-label={LABELS.write}
                  data-testid="nav-pencil"
                >
                  <Icons.pencil className="h-5 w-5" />
                </Button>
              </Link>
            ) : (
              <DialogLogin redirectTo="/submit.html">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-10 w-10 px-0"
                  aria-label={LABELS.write}
                  data-testid="nav-pencil"
                >
                  <Icons.pencil className="h-5 w-5" />
                </Button>
              </DialogLogin>
            )}
          </TooltipContainer>

          {user?.isLoggedIn ? (
            /* Item 12: the bell used to be a Link to /@{user}/notifications
               (now a deleted route). It's a NotificationsMenu popover
               trigger instead — notifications render inline, right here,
               nothing to navigate to. Badge behaviour is unchanged. */
            <TooltipContainer title={LABELS.notifications}>
              <NotificationsMenu username={user.username} lastRead={lastRead} chainAccount={isChainAccount}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="relative h-10 w-10 px-0"
                  aria-label={
                    data && data.unread > 0
                      ? `${LABELS.notifications} (${data.unread} unread)`
                      : LABELS.notifications
                  }
                  data-testid="nav-notifications"
                >
                  <Icons.bell className="h-5 w-5" />
                  {data && data.unread !== 0 ? (
                    <span className="absolute right-0 top-0.5 z-10 inline-block -translate-y-1/2 translate-x-2/4 rounded-full bg-destructive-icon px-1.5 py-1 text-center align-baseline text-xs font-bold leading-none text-white">
                      {data.unread}
                    </span>
                  ) : null}
                </Button>
              </NotificationsMenu>
            </TooltipContainer>
          ) : null}

          {/* ★ The sign-in link MUST exist in the server-rendered HTML.
              This branch used to render a <Skeleton/> until hydration, so a
              crawler, a link-preview bot, or anyone on a slow connection saw a
              header with NO way into the product — /login appeared only after
              JS ran. The signup path being invisible to search engines is an
              acquisition bug, not a cosmetic one.

              Rendering the login link pre-hydration makes the logged-OUT case
              byte-identical on both sides (no flash, no hydration mismatch),
              which is the overwhelming majority of first visits. A logged-IN
              user sees it for the single frame before hydration swaps in their
              avatar — a far cheaper trade than an unreachable front door. */}
          {!isClient ? (
            <Link href="/login" data-testid="login-link">
              <Button variant="ghost" className="whitespace-nowrap text-base hover:text-destructive">
                {LABELS.login}
              </Button>
            </Link>
          ) : user?.isLoggedIn ? (
            <TooltipProvider>
              <Tooltip>
                {/* ★★★ THE MENU TRIGGER MUST BE THE FOCUSABLE ELEMENT.
                    This was `<TooltipTrigger><UserMenu><div>…`: the tooltip
                    rendered the real <button>, and the dropdown's own trigger
                    was a plain <div> INSIDE it. A mouse click landed on the div
                    and worked; a keyboard Enter fired on the outer button and
                    never reached the menu, so the dropdown could not be opened
                    by keyboard at all — and it is the ONLY route to Logout,
                    Language, Sign-in & recovery and Upgrade, none of which are
                    in the sidebar. A keyboard-only user could not log out.
                    Now the menu wraps the tooltip, so the button Radix makes
                    focusable is the one that opens the menu. */}
                <UserMenu user={user}>
                  <TooltipTrigger
                    data-testid="profile-avatar-button"
                    aria-label="Account menu"
                    className="cursor-pointer"
                  >
                    <div className="group relative inline-flex w-fit cursor-pointer items-center justify-center">
                      {data && data.unread !== 0 ? (
                        <div className="absolute bottom-auto left-auto right-0 top-0.5 z-50 inline-block -translate-y-1/2 translate-x-2/4 rotate-0 skew-x-0 skew-y-0 scale-x-100 scale-y-100 whitespace-nowrap rounded-full bg-destructive-icon px-1.5 py-1 text-center align-baseline text-xs font-bold leading-none text-white">
                          {data.unread}
                        </div>
                      ) : null}
                      {/* Default state: RC ring only */}
                      <ManabarRing
                        percentage={rcPercent}
                        color="#0088FE"
                        size={48}
                        thickness={6}
                        className="absolute z-20 group-hover:invisible group-hover:delay-300 group-hover:duration-300 group-hover:animate-out group-hover:zoom-out-75"
                      />

                      {/* Hover state: Three concentric rings */}
                      <ManabarRing
                        percentage={downvotePercent}
                        color="#C01000"
                        size={43}
                        thickness={3.5}
                        className="invisible absolute z-20 group-hover:visible group-hover:delay-300 group-hover:duration-300 group-hover:animate-in group-hover:zoom-in-50"
                      />
                      <ManabarRing
                        percentage={upvotePercent}
                        color="#00C040"
                        size={50}
                        thickness={3.5}
                        className="invisible absolute z-10 group-hover:visible group-hover:delay-300 group-hover:duration-300 group-hover:animate-in group-hover:zoom-in-50"
                      />
                      <ManabarRing
                        percentage={rcPercent}
                        color="#0088FE"
                        size={57}
                        thickness={3.5}
                        className="invisible absolute group-hover:visible group-hover:delay-300 group-hover:duration-300 group-hover:animate-in group-hover:zoom-in-50"
                      />
                      <Avatar className="z-30 flex h-9 w-9 items-center justify-center overflow-hidden rounded-full">
                        <AvatarImage
                          className="h-full w-full object-cover"
                          src={getUserAvatarUrl(user?.username || '', 'small')}
                          alt="Profile picture"
                        />
                        <AvatarFallback>
                          <img
                            className="h-full w-full object-cover"
                            src={getUserAvatarUrl(user?.username || '', 'small')}
                            alt="Profile picture"
                          />
                        </AvatarFallback>
                      </Avatar>
                    </div>
                  </TooltipTrigger>
                </UserMenu>
                {manabarsData && (
                  <TooltipContent className="flex flex-col bg-background-tertiary">
                    <span>Resource Credits</span>
                    <div className="flex flex-col text-blue-600">
                      <span>(RC) level: {manabarsData.rc.percentageValue}%</span>
                      {manabarsData.rc.percentageValue !== 100 ? (
                        <span>Full in: {hoursAndMinutes(manabarsData.rc.cooldown, t)}</span>
                      ) : null}
                    </div>
                    <div className="flex flex-col text-green-600">
                      <span> Voting Power: {manabarsData.upvote.percentageValue}%</span>
                      {manabarsData?.upvote.percentageValue !== 100 ? (
                        <span>Full in: {hoursAndMinutes(manabarsData.upvote.cooldown, t)}</span>
                      ) : null}
                    </div>
                    <div className="flex flex-col text-destructive">
                      <span> Downvote power: {manabarsData.downvote.percentageValue}%</span>
                      {manabarsData.downvote.percentageValue !== 100 ? (
                        <span>Full in: {hoursAndMinutes(manabarsData.downvote.cooldown, t)}</span>
                      ) : null}
                    </div>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          ) : (
            /* /login is the ONE entry point, and it carries all four ways in:
               Google, Hive Keychain, a Bitcoin wallet and an EVM wallet.

               ★ OPERATOR RULING 2026-08-01 — the second "Use Hive keys" button
               that used to sit here is gone. Two adjacent, undifferentiated login
               buttons is a coin toss for anyone who has not used Hive before, and
               the one it opened asked a first-time visitor for a private key.
               DialogLogin still exists and still opens from the ~24 in-context
               places (upvote, reply, composer) — it is now Keychain-only and
               links onward to /login for people without an account. */
            <Link href="/login" data-testid="login-link">
              <Button variant="ghost" className="whitespace-nowrap text-base hover:text-destructive">
                {LABELS.login}
              </Button>
            </Link>
          )}

          {/* Last in the cluster, the same slot upstream denser gives its own
              Sheet trigger (main-bar.tsx renders <Sidebar/> as the final child
              of the header nav). Below md only — see mobile-nav.tsx. */}
          <MobileNav />
        </div>
      </div>
    </header>
  );
};

export default AppHeader;
