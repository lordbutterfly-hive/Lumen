'use client';

import { FC } from 'react';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Link, UserAvatarImg } from '@hive/ui';
import { Button, buttonVariants } from '@ui/components/button';
import { cn } from '@ui/lib/utils';
import { Icons } from '@ui/components/icons';
import TooltipContainer from '@ui/components/tooltip-container';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12).
 *
 * This called `getUnreadNotifications` here in the browser. That reaches
 * `getChain()`, which INSTANTIATES `@hiveio/wax` at runtime and fetches
 * `wax.common.wasm` — 2.34 MB — on every page, for every signed-in Hive reader.
 * The bell is mounted on every route, so this was the single widest instance of
 * it. Anonymous visitors never hit it (`enabled: isChainAccount`), which is
 * exactly how an anonymous-only measurement missed it. See
 * `app/api/notifications/unread/route.ts` for the full note and the rule.
 *
 * `fetchUnreadNotifications` moved into `lib/chain-fetch.ts` (2026-08-12):
 * `features/retention/components/retention-nudge.tsx` needed the identical
 * fetch (same route, same shape) and was carrying its own direct
 * `getUnreadNotifications` import as a second, unfixed path into the same
 * bug — sharing one fetcher is what actually closes that off, a local copy
 * here would not have.
 */
import { fetchUnreadNotifications } from '@/blog/lib/chain-fetch';
import { useLoggedUserContext } from '@/blog/features/votes/hooks/use-logged-user';
import { useTranslation } from '@/blog/i18n/client';
import { hoursAndMinutes } from '@/blog/lib/utils';
import DialogLogin from '@/blog/components/dialog-login';
import UserMenu from '@/blog/features/layouts/site-header/user-menu';
import { useLumenNotifications } from '@/blog/features/layouts/site-header/use-lumen-notifications';
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
  yourProfile: 'Your profile'
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
 * Same shape as `features/witnesses/witness-identity-cell.tsx`, and now the
 * SAME COMPONENT (F6 item 22, converged): the monogram sits UNDER the image
 * and the image removes itself on error, so there is always a letter and
 * never a broken glyph. `alt=""` (the component's default) because the
 * control around it already carries the name ("Account menu" / "Your profile") —
 * an alt here would make screen readers say it twice.
 *
 * ★ This used to call `getUserAvatarUrl` directly — our own `/api/avatar`
 * proxy — on every render, unconditionally. That is the header, so it is on
 * every single page for every signed-in reader; it never had the direct-host
 * fast path the feed got on 2026-08-10. `UserAvatarImg` tries
 * `images.hive.blog` first and only falls back to the proxy on error.
 */
const HeaderAvatar: FC<{ username: string }> = ({ username }) => (
  <UserAvatarImg
    username={username || ''}
    pixelSize={36}
    className="z-30"
  />
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
  // ★ POSITIVE CHECK, NOT `!== 'lite'` (2026-08-15). `account_tier` is undefined
  // until the session resolves, and `undefined !== 'lite'` is TRUE — so for the
  // first render of every page a lite reader DID fire this query, got
  // `Account <name> does not exist`, and the route answered 502. Measured on
  // production: 6 of them per page load on home/trending/hot/created/payout and
  // even /login. The guard above was correct in intent and inverted in effect.
  // `'full'` and `'lite'` are the only two tiers, so asking for the one that has
  // a chain account is both narrower and honest about the undefined window.
  /**
   * ★★★ ONE IDENTITY FOR THE BELL, NOT TWO (2026-08-18, owner: badge said "3
   * unread" over a panel reading "No notifications yet").
   *
   * The badge and the panel were driven by DIFFERENT sources. The badge's chain
   * query keyed off `user.username` (this hook), while the panel below was
   * handed `identity.username` (the cookie/localStorage-reconciled one) and
   * gated additionally on `isChainAccount`. Whenever those two disagreed — the
   * window before the client has answered, a cookie the client has not caught
   * up with — the badge still rendered a COUNT from its own cached query while
   * the panel's list query never became `enabled` at all, so it never fetched,
   * held no data, and fell through to the same empty state a reader with
   * nothing genuinely sees. Not an error, so no error state could catch it.
   *
   * ★ AND THE TIER TEST WAS THE OUTLIER. `=== 'full'` appears in exactly ONE
   * place in this app — this line — while `!== 'lite'` is what the other five
   * call sites use (content.tsx, the lite API routes, the feed route). The two
   * are NOT equivalent: `account_tier` is absent on some sessions, and an
   * `undefined` tier is a real Hive account everywhere else in the product but
   * was "not a chain account" here, silently disabling both notification reads.
   * Matching the majority spelling is what makes an undefined tier behave the
   * same way here as it does everywhere else.
   */
  const bellUsername = user.username || identity.username;
  const isChainAccount = !!bellUsername && user.account_tier !== 'lite';
  const { data } = useQuery({
    queryKey: ['unreadNotifications', bellUsername],
    queryFn: () => fetchUnreadNotifications(bellUsername),
    enabled: isChainAccount
  });
  /**
   * ★★★ THE BELL'S OTHER HALF (2026-08-16, owner). `data.unread` above is the
   * CHAIN's count and nothing else, while the panel below also lists Lumen-native
   * events — which is exactly how the badge came to say 1 over a list of 4, and
   * why a lite reader's badge never left 0. Fetched HERE rather than inside the
   * popover so the badge can count before anything is opened, and passed down so
   * there is one request and one number behind both.
   */
  const lumen = useLumenNotifications(bellUsername ?? '');
  const chainUnread = data?.unread ?? 0;
  const unreadTotal = chainUnread + lumen.unread;
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
      /* ★ OPAQUE, NO BACKDROP-BLUR (2026-08-13, typography audit item 2). Was
         `bg-surface-1/90 backdrop-blur-md`. `position: sticky` already promotes
         this header to its own composited layer, and Chrome will not use
         LCD/subpixel antialiasing for text painted into a composited layer that
         has no opaque background — it falls back to greyscale AA, which reads
         thinner and greyer. So the wordmark, the search field and every header
         control were being antialiased by a DIFFERENT method than the centre
         column on every page. `backdrop-filter` forces the promotion on its own
         even without sticky, and 90% white over a 97% grey page background is a
         ~0.3% tint nobody can see, so both are dropped for a flat `bg-surface-1`. */
      className="sticky top-0 z-40 w-full border-b border-line-9 bg-surface-1 font-sans"
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
        {/* col 1 — the wordmark over the nav column. (This line said "Open Sans
            wordmark (design-handoff-v2: no serif display face)" until 2026-08-19,
            while the note 10 lines below it — newer, dated 2026-08-11 — already
            documented the wordmark as Lora. The file had corrected itself once
            and left the old claim standing at the top, which is the worst place
            for it.) The 14px inset matches the left-rail rows' own
            px-[14px], so the wordmark's left edge lands on the nav icons' left
            edge instead of sitting 14px proud of the column. */}
        <Link href="/" aria-label={LABELS.homeAriaLabel} className="flex items-center md:pl-[14px]">
          {/* One extra responsive step below sm. The size ladder was already
              28 -> 34; a phone is the one width where the wordmark competes with
              the controls for room, and 24px buys 16 of the ~48 needed for the
              menu button. Unchanged at every width the design was drawn for. */}
          {/* ★ THE WORDMARK IS LORA (owner, 2026-08-11: "our logo is not fucking
              Lora, you need to set it Lora"). `font-serif` binds to `--font-lora`,
              which layout.tsx loads at 400/500/600/700.

              ★ THIS NOTE SAID "NOT THE UI FACE" AND NAMED `--font-source-serif`
              UNTIL 2026-08-19 — a variable name TWO renames stale (it went
              `--font-source-serif` -> `--font-serif` -> `--font-lora`), and a
              distinction that no longer exists, because the UI face is now Lora
              too. Both halves were wrong in the same sentence, which is how a
              comment that was right when written ends up misleading three
              readers in a row.

              600 rather than the old 700: Lora's bold is considerably heavier in
              colour than Open Sans's at the same nominal weight, and at 34px a
              serif bold reads as shouting where the sans bold read as confident.
              Swap `font-semibold` for `font-medium` if 500 is preferred — both
              weights are already in the loaded subset, so it costs no extra fetch.

              Tracking relaxed from -0.025em to -0.01em. The tight negative tracking
              was tuned for Open Sans; a serif with real bracketed serifs collides
              at that value, and "Lumen" has an m-n pair that shows it first. */}
          <span className="font-text text-[24px] font-semibold leading-none tracking-[-0.01em] text-ink-2 sm:text-[30px] lg:text-[34px] lg:leading-[52px]">
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
          {/* ★ ONE CONTROL, NOT TWO (owner, 2026-08-11: "you now have creator
              tokens next to launch your token — two pills of the same thing
              next to each other").

              A "Creator Tokens" text link used to sit here, immediately left of
              this pill. Both pointed at the same feature and, for the common
              case of an account with no token, they read as one instruction
              said twice: "Creator Tokens" beside "Launch your token".

              The link is DELETED rather than restyled or moved, because its
              destination is not orphaned: `/creators` is already a primary
              nav row in left-rail.tsx:225. The pill is the only header control
              this feature needs, and it carries the state the link never could
              — a live price straight to Studio if you have a token, the launch
              CTA if you do not. The owner's brief asked for exactly one pill in
              the top right. */}
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
                 composer-defects pass.

                 ★ `rounded-control`, ADDED 2026-08-13 (audit §4.2). The audit
                 reported "three elements on the followers page still compute a
                 6px radius: the Previous and Next buttons, and one link", on a
                 surface whose own scale is 10/12/18px. Two of those three
                 attributions were wrong — measured on the shipped build, both
                 pager buttons compute 12px — and the 6px elements it did find
                 are not part of the followers page at all: they are these
                 header icon controls, which inherit `rounded-md` from
                 `buttonVariants`, and which appear on EVERY page. Overridden at
                 the three call sites rather than in the shared primitive,
                 because 6px is still the default everywhere else and this is a
                 header-chrome decision, not a global one. */
              <Link
                href="/submit.html"
                aria-label={LABELS.write}
                className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-10 w-10 rounded-control px-0')}
              >
                <span data-testid="nav-pencil" className="flex items-center justify-center">
                  <Icons.pencil className="h-5 w-5 text-ink-2" />
                </span>
              </Link>
            ) : (
              <DialogLogin redirectTo="/submit.html">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-10 w-10 rounded-control px-0"
                  aria-label={LABELS.write}
                  data-testid="nav-pencil"
                >
                  <Icons.pencil className="h-5 w-5 text-ink-2" />
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
                // The SAME name the badge counted with — see `bellUsername`.
                username={bellUsername}
                lastRead={lastRead}
                chainAccount={isChainAccount}
                unreadCount={unreadTotal}
                chainUnreadCount={chainUnread}
                lumenItems={lumen.items}
                onOpened={lumen.markSeen}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="relative h-10 w-10 rounded-control px-0"
                  aria-label={
                    unreadTotal > 0
                      ? `${LABELS.notifications} (${unreadTotal} unread)`
                      : LABELS.notifications
                  }
                  data-testid="nav-notifications"
                >
                  <Icons.bell className="h-5 w-5 text-ink-2" />
                  {unreadTotal > 0 ? (
                    <span className="absolute right-0 top-0.5 z-10 inline-block -translate-y-1/2 translate-x-2/4 rounded-full bg-destructive-icon px-1.5 py-1 text-center align-baseline text-caption font-bold leading-none text-ink-27">
                      {unreadTotal}
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
                      {/* ★ THE COUNT LIVES ON THE BELL, ONCE (2026-08-16, owner:
                          "profile image top right shows 1 notification for some
                          reason? why if the bell shows it"). This drew the SAME
                          `data.unread` a hand's width from the bell's own badge,
                          so one unread reply was reported twice by two different
                          controls, and the avatar — which opens the account menu,
                          not notifications — appeared to carry news of its own.
                          The bell is the control that answers it. */}
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
                    <div className="flex flex-col text-ink-info-5">
                      <span>(RC) level: {manabarsData.rc.percentageValue}%</span>
                      {manabarsData.rc.percentageValue !== 100 ? (
                        <span>Full in: {hoursAndMinutes(manabarsData.rc.cooldown, t)}</span>
                      ) : null}
                    </div>
                    <div className="flex flex-col text-ink-ok-4">
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
            /* ★★★ ONE LOGIN SURFACE, EVERYWHERE (owner ruling 2026-09-03). This was
               a `<Link href="/login">` to the full page while the Profile row, every
               upvote/reply/composer and ~24 other triggers open the `DialogLogin`
               POPUP — so the header was the one place that logged in differently,
               and the owner saw "the popup from Profile isn't the same as the
               top-right Log in". The two render the SAME four methods (Google,
               Bitcoin wallet, Ethereum wallet, Hive Keychain — `LumenLogin`), the
               only difference was page-vs-popup plus the popup's signup footer.
               Now the header opens the identical popup, so every entry point is
               the same thing, and the reader keeps their place instead of being
               navigated away. `/login` still exists as a standalone URL (deep links,
               the popup's own "Create a free account" link, the `next=` flow).

               History: the 2026-08-01 ruling removed a second "Use Hive keys"
               button from here; the comment that lived here also said DialogLogin
               was "Keychain-only" — stale since 2026-08-07, when the popup gained
               all four methods. */
            <DialogLogin>
              <Button
                variant="ghost"
                className="whitespace-nowrap text-base hover:text-destructive"
                data-testid="login-link"
              >
                {LABELS.login}
              </Button>
            </DialogLogin>
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
      <div className="border-t border-line-9 px-6 pb-3 pt-2.5 md:hidden">
        <SearchInput />
      </div>
    </header>
  );
};

export default AppHeader;
