'use client';

import { FC, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, getUserAvatarUrl } from '@hive/ui';
import { Avatar, AvatarFallback, AvatarImage, Skeleton } from '@ui/components';
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
import { ManabarRing } from '@/blog/features/layouts/site-header/manabar-ring';
import SearchButton from '@/blog/features/layouts/site-header/search-button';
import { ModeSwitchInput } from '@ui/components/mode-switch-input';

// TODO i18n - move into locales/*/common_blog.json once copy is final
const LABELS = {
  homeAriaLabel: 'Lumen home',
  write: 'Write',
  notifications: 'Notifications',
  login: 'Log in',
  hiveKeys: 'Use Hive keys'
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
  const { data } = useQuery({
    queryKey: ['unreadNotifications', user.username],
    queryFn: () => getUnreadNotifications(user.username),
    enabled: !!user.username
  });
  const upvotePercent = manabarsData?.upvote.percentageValue ?? 0;
  const downvotePercent = manabarsData?.downvote.percentageValue ?? 0;
  const rcPercent = manabarsData?.rc.percentageValue ?? 0;

  return (
    <header
      className="sticky top-0 z-40 w-full border-b border-[#ebebeb] bg-white/90 font-sans backdrop-blur-md"
      translate="no"
    >
      <div className="mx-auto grid max-w-[1720px] grid-cols-[1fr_auto] items-center gap-11 px-6 py-[14px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
        {/* col 1 — Open Sans wordmark over the nav column (design-handoff-v2: no
            serif display face). The 14px inset matches the left-rail rows' own
            px-[14px], so the wordmark's left edge lands on the nav icons' left
            edge instead of sitting 14px proud of the column. */}
        <Link href="/" aria-label={LABELS.homeAriaLabel} className="flex items-center md:pl-[14px]">
          <span className="font-sans text-[28px] font-bold leading-none tracking-[-0.025em] text-[#161511] lg:text-[34px]">
            Lumen
          </span>
        </Link>

        {/* col 2 — search spans the center column (desktop) */}
        <div className="hidden md:block">
          <ModeSwitchInput aiAvailable={false} />
        </div>

        {/* col 3 — action cluster over the right rail */}
        <div className="flex items-center justify-end gap-3.5">
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
            <TooltipContainer title={LABELS.notifications}>
              <Link href={`/@${user.username}/notifications`} data-testid="nav-notifications">
                <Button
                  variant="ghost"
                  size="sm"
                  className="relative h-10 w-10 px-0"
                  aria-label={
                    data && data.unread > 0
                      ? `${LABELS.notifications} (${data.unread} unread)`
                      : LABELS.notifications
                  }
                >
                  <Icons.bell className="h-5 w-5" />
                  {data && data.unread !== 0 ? (
                    <span className="absolute right-0 top-0.5 z-10 inline-block -translate-y-1/2 translate-x-2/4 rounded-full bg-destructive-icon px-1.5 py-1 text-center align-baseline text-xs font-bold leading-none text-white">
                      {data.unread}
                    </span>
                  ) : null}
                </Button>
              </Link>
            </TooltipContainer>
          ) : null}

          {!isClient ? (
            <Skeleton className="h-9 w-9 rounded-full" />
          ) : user?.isLoggedIn ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger data-testid="profile-avatar-button" className="cursor-pointer">
                  <UserMenu user={user} notifications={data?.unread}>
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
                  </UserMenu>
                </TooltipTrigger>
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
            /* /login is the Lumen entry point (Google / Bitcoin / EVM / Keychain).
               Nothing in the site linked to it, which made the whole lite-account
               journey unreachable for a real visitor. The keys-only DialogLogin stays
               for existing Hive users. */
            <>
              <Link href="/login" data-testid="login-link">
                <Button variant="ghost" className="whitespace-nowrap text-base hover:text-destructive">
                  {LABELS.login}
                </Button>
              </Link>
              <DialogLogin>
                <Button
                  variant="ghost"
                  className="hidden whitespace-nowrap text-base hover:text-destructive md:inline-flex"
                  data-testid="login-btn"
                >
                  {LABELS.hiveKeys}
                </Button>
              </DialogLogin>
            </>
          )}
        </div>
      </div>
    </header>
  );
};

export default AppHeader;
