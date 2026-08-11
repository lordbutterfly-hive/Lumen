'use client';

import { FC } from 'react';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Link, getUserAvatarUrl } from '@hive/ui';
import { Button, buttonVariants } from '@ui/components/button';
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
import MobileNav from '@/blog/features/layouts/mobile-nav';
import { SearchInput } from '@/blog/features/search/search-input';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import HeaderTokenPill from '@/blog/features/creator-tokens/ui/header-token-pill';

// TODO i18n - move into locales/*/common_blog.json once copy is final
const LABELS = {
  homeAriaLabel: 'Lumen home',
  write: 'Write',
  notifications: 'Notifications',
  login: 'Log in',
  yourProfile: 'Your profile',
  creatorTokens: 'Creator Tokens'
};

/**
 * ★★★ AN EMPTY BLUE RING IS NOT A FALLBACK (2026-08-10, N-4).
 *
 * This was a Radix `<Avatar>` whose `<AvatarFallback>` rendered AN `<img>` WITH
 * THE SAME `src` the `<AvatarImage>` had just failed on. So when the picture did
 * not load, the fallback loaded the identical broken URL: the reader got a hole
 * in the middle of the manabar ring, which reads as an account that is somehow
 * empty rather than as a picture that did not arrive. That is the whole header's
 * only piece of identity.
 *
 * Same shape as `features/witnesses/witness-identity-cell.tsx`: the monogram sits
 * UNDER the image and the image removes itself on error, so there is always a
 * letter and never a broken glyph. `alt=""` plus `aria-hidden` because the
 * control around it already carries the name ("Account menu" / "Your profile") —
 * an alt here would make screen readers say it twice.
 */
const HeaderAvatar: FC<{ username: string }> = ({ username }) => (
  <span
    aria-hidden="true"
    className="relative z-30 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#f1f3f5] font-sans text-[14px] font-bold uppercase leading-none text-[#6b7280]"
  >
    {username.slice(0, 1)}
    <img
      src={getUserAvatarUrl(username || '', 'small')}
      alt=""
      width={36}
      height={36}
      onError={(e) => {
        e.currentTarget.style.display = 'none';
      }}
      className="absolute inset-0 h-9 w-9 rounded-full object-cover"
    />
  </span>
);

/**
 * Minimal, Medium-style top header: wordmark far-left, a small icon
 * cluster far-right (search / write / notifications / avatar), nothing
 * in the center. Replaces MainBar's dense nav for a cleaner reading app.
 */
const AppHeader: FC = () => {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const pathname = usePathname();

  /**
   * ★★★ NEVER SHOW A SIGNED-IN READER A SIGNED-OUT HEADER (2026-08-10, N-3).
   *
   * `user` here cannot answer during SSR and answers "signed out" on the client
   * until React has mounted, localStorage has been read and `/api/users/me` has
   * returned. Measured on this box with a real session: on `/search` the header
   * still said "Log in" 4.6 seconds after the page appeared, with no avatar and
   * no bell, and the left rail still had no Settings row; on the home page the
   * avatar arrived between t=3s and t=8s, while a fetch of `/api/users/me` made
   * from the same page at t=3s already answered `isLoggedIn: true`. The answer
   * existed; the chrome was not using it.
   *
   * `identity` prefers the client the moment it has really answered and falls
   * back to the session the SERVER read from the cookie before then, so the
   * first paint is already correct and signing out still takes effect at once.
   *
   * ★ THE SEO INTENT BELOW IS UNCHANGED. A crawler carries no session cookie, so
   * `identity` is signed-out for it, and the real `<a href="/login">` is still in
   * the server-rendered HTML exactly as before. What is gone is showing that same
   * link to somebody who is already signed in.
   */
  const identity = useSessionIdentity();

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

  /**
   * ★★★ NOT ON /login, AND NOT MERELY HIDDEN (2026-08-10, fuckery list C1/C2/C3).
   *
   * `/login` is a standalone screen: `LumenLogin` covers the viewport with a
   * `fixed inset-0 z-50` layer, and this header is `z-40`, so it was painted over
   * completely. Invisible, still mounted, and that is worse than either state on
   * its own:
   *
   *   * Its TEN controls stayed tab-focusable behind the overlay. The first Tab on
   *     the login page moved focus into a search box nobody could see, and a
   *     keyboard or screen-reader user had to walk the entire header before
   *     reaching the sign-in form.
   *   * It contributed 71px of dead height above the overlay, pushing the card down
   *     for nothing.
   *   * It added a SECOND link to `/` (the wordmark) and a second "Log in" control
   *     on the one page where both are noise.
   *
   * Covering something is not removing it. The clean long-term fix is the route
   * group split the login component's own comment describes (move the header into a
   * `(shell)` group and leave `/login` outside it); this is the same outcome with a
   * one-line blast radius, and it deletes the reason that overlay exists at all.
   */
  if (pathname === '/login') return null;

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
          `auto` sizes the third column to the cluster.

          ★ NO MORE xl:312px OVERRIDE (creator-token-prominence pass,
          2026-08-11, design brief §1: "Header grid changes from 200px
          minmax(0,1fr) 312px to 200px minmax(0,1fr) auto so the right cluster
          sizes to content"). The action cluster now carries the "Creator
          Tokens" link plus the token pill/CTA on top of write/notifications/
          avatar, and that is reliably wider than 312px — a fixed column would
          either clip it or force it onto the second row the comment above
          this one already fixed once. `auto` from md upward, unconditionally,
          matches the reference mockup (Lumen.dc.html) exactly. This trades
          away the header search box's previous pixel-perfect alignment with
          the content grid's fixed 312px right rail at xl+; that grid is a
          separate element two rows down and was never coupled to this one
          structurally, only visually, and the brief calls this trade out by
          name. */}
      <div className="mx-auto grid max-w-[1720px] grid-cols-[1fr_auto] items-center gap-3 px-6 py-[14px] md:grid-cols-[200px_minmax(0,1fr)_auto] md:gap-11 md:px-11">
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

        {/* col 2 — search spans the center column (desktop). The ONLY search
            field in the product: /search has no box of its own any more, it
            reads the URL this one writes. Below md there is no third grid
            column to put it in (col 1 becomes 1fr, col 3 is the icon
            cluster, and the cluster already has zero horizontal slack at
            that width — see the write-button note above), so mobile gets
            its own full-width row underneath instead of a column here. */}
        <div className="hidden md:block">
          <SearchInput />
        </div>

        {/* col 3 — action cluster over the right rail */}
        <div className="flex items-center justify-end gap-2 md:gap-3.5">
          {/* ★★★ SEARCHBUTTON REMOVED (2026-08-11, audit item 9). This used to
              render its own `a[href="/search"]` + nested `<button>` here,
              `md:hidden`-ed only on the INNER button — so the outer anchor
              stayed in the DOM, unhidden, at every width: collapsed to 0x0 and
              invisible on desktop but still a real, tabbable, aria-label
              "Search" stop sitting right next to the real search field's own
              "Search posts" input and button, and at mobile the two nested
              INSIDE each other (a `<button>` inside an `<a href>`, the same
              invalid-HTML shape already fixed for the Write icon below,
              A-2). The owner's ruling was explicit: ONE search control, the
              header field. `SearchInput` now renders below at every width
              (see the row right after this grid), so this component has
              nothing left to do — deleted at `features/layouts/site-header/
              search-button.tsx` rather than left as dead code nobody imports. */}

          {/* Creator Tokens entry point (design brief §1) — owner ruling:
              this cluster is the part of the redesign he likes most, and
              creator tokens are the primary product, so it gets first claim
              on the header, ahead of Write/Notifications/Avatar.

              ★ HIDDEN BELOW xl, ON PURPOSE. The write-button note two blocks
              up already documents md (768-1279px) as having ZERO horizontal
              slack — 820px was a measured near-miss with three controls, one
              of them a two-word "Log in" button. Two more controls (a text
              link plus a pill) would reopen exactly that overflow. xl is also
              the one width tier that used to reserve a fixed 312px here, so
              it is the first width with genuine room. The design brief itself
              scopes this whole pass to desktop ("mobile is a separate task"),
              and md/lg are not "mobile" but are not where this fits either —
              xl is the honest floor, not a mobile cutoff by another name. */}
          <Link
            href="/creators"
            className="hidden shrink-0 whitespace-nowrap px-1 font-sans text-[14.5px] font-semibold text-[#3f4650] transition-colors hover:text-[#161511] xl:inline-block"
            data-testid="header-creator-tokens-link"
          >
            {LABELS.creatorTokens}
          </Link>
          <div className="hidden xl:block">
            <HeaderTokenPill />
          </div>

          <TooltipContainer title={LABELS.write}>
            {identity.isLoggedIn ? (
              /* ★★★ A <button> INSIDE AN <a href> IS INVALID HTML (2026-08-10, A-2).
                 Interactive content may not nest: the parser is free to
                 re-arrange it, the accessibility tree gets two focusable
                 controls where the reader sees one, and which of the two a
                 click or an Enter press lands on is not something the markup
                 decides. This is now ONE control — an anchor wearing the ghost
                 icon-button's classes, via `buttonVariants`, so it is pixel-wise
                 the same button it was. `data-testid="nav-pencil"` stays on an
                 element INSIDE the anchor on purpose:
                 playwright/tests/fixture/postCreateViaPencilIcon.spec.ts locates
                 `a[href="/submit.html"]` and filters it by `has:` that testid,
                 and `has:` matches descendants only — moving the testid onto the
                 anchor itself would silently stop that fixture finding the
                 pencil at all. A click on the span still lands on the anchor.

                 The href still points at `/submit.html`. That is the real route
                 (`app/submit.html/page.tsx`), not a dead legacy alias, and
                 renaming it is a routing change across the header, the
                 community new-post button, the editor's own `router.replace`
                 and a dozen Playwright specs — deliberately not bundled into a
                 composer-defects pass. */
              <Link
                href="/submit.html"
                aria-label={LABELS.write}
                className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'h-10 w-10 px-0' })}
              >
                <span data-testid="nav-pencil" className="flex items-center justify-center">
                  <Icons.pencil className="h-5 w-5" />
                </span>
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

          {identity.isLoggedIn ? (
            /* Item 12: the bell used to be a Link to /@{user}/notifications
               (now a deleted route). It's a NotificationsMenu popover
               trigger instead — notifications render inline, right here,
               nothing to navigate to. Badge behaviour is unchanged. */
            <TooltipContainer title={LABELS.notifications}>
              <NotificationsMenu
                username={identity.username}
                lastRead={lastRead}
                chainAccount={isChainAccount}
                unreadCount={data?.unread ?? 0}
              >
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
          {/* ★ ORDER MATTERS. The full menu needs the CLIENT's `user` object (it
              carries the tier, the avatar url and everything Logout needs), so it
              renders only once the client really knows who you are. Between the
              first paint and that moment, `identity` still knows from the cookie
              the server read, and draws the same avatar as a plain link to the
              reader's own profile rather than a "Log in" button that is a lie. */}
          {user?.isLoggedIn ? (
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
                      <HeaderAvatar username={user?.username || ''} />
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
          ) : identity.isLoggedIn ? (
            /* The cookie the server read says this reader is signed in and the
               client has not caught up yet. Same avatar in the same slot, so
               nothing moves when the real menu takes over, and it is a live link
               to their own profile rather than a control that does nothing while
               it waits. */
            <Link
              href={`/@${identity.username}`}
              aria-label={LABELS.yourProfile}
              data-testid="header-avatar-pending"
              className="inline-flex items-center justify-center"
            >
              <HeaderAvatar username={identity.username} />
            </Link>
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

      {/* ★ THE SAME FIELD, ITS OWN ROW, BELOW md (2026-08-11, audit item 9).
          Not a second search control — this is the identical `SearchInput`
          instance-type rendered in col 2 above, just placed where a phone
          has room for it instead of squeezed into the icon cluster. Only one
          of the two is ever on screen at a given width (`md:hidden` here,
          `hidden md:block` above), so there is still exactly one search
          field in the DOM's visible tree at any size. */}
      <div className="border-t border-[#ebebeb] px-6 pb-3 pt-2.5 md:hidden">
        <SearchInput />
      </div>
    </header>
  );
};

export default AppHeader;
