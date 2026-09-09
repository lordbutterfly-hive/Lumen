'use client';

import { ComponentType, useEffect, useState } from 'react';
import { Loader2, LucideProps } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { Icons } from '@ui/components/icons';
import { Separator } from '@ui/components/separator';
import { cn } from '@ui/lib/utils';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import BasePathLink from '../../components/base-path-link';
import { useTranslation } from '@/blog/i18n/client';
import DialogLogin from '@/blog/components/dialog-login';
import { LeagueShowcase } from '@/blog/features/retention/components/league-showcase';
import { CreatorTokenLaurel } from '@/blog/features/creator-tokens/ui/creator-token-laurel';
import styles from './left-rail.module.css';

/**
 * ★★★ THESE WERE THE REASON THE LANGUAGE SWITCHER "DID NOTHING" (2026-08-14).
 *
 * The switcher works — cookie, localStorage and `<html lang>` all change, and
 * strings that go through `t()` translate. But a capture of every header, nav,
 * aside and footer line on `/` before and after switching to Polish came back
 * **30 lines before, 30 after, 30 identical**, because the primary navigation —
 * the most visible text on the page — never went through `t()` at all. It was
 * this object, carrying its own "TODO: move to i18n" note.
 *
 * Now keyed off `navigation.left_rail.*`. English values are unchanged, so this
 * is a no-op in the default locale and the only observable difference is that a
 * translated locale can finally reach the nav.
 */
const labels = (t: (k: string) => string) => ({
  primaryNav: t('navigation.left_rail.primary_nav'),
  home: t('navigation.left_rail.home'),
  profile: t('navigation.left_rail.profile'),
  wallet: t('navigation.left_rail.wallet'),
  // ★ RENAMED (design brief "Also changed", creator-token-prominence pass,
  // 2026-08-11): "Creators" undersold what this row is — creator TOKENS, the
  // product's primary surface per owner ruling, not a people directory.
  creators: t('navigation.left_rail.creators'),
  voteWitness: t('navigation.left_rail.vote_witness'),
  voteProposals: t('navigation.left_rail.proposals'),
  settings: t('navigation.left_rail.settings')
});

type NavIcon = ComponentType<LucideProps>;

/**
 * ★ THE RAIL AND THE HEADER NOW SHOW THE SAME MARK (2026-08-16, owner). The rail
 * carried `Icons.creatorTokens` (the ◈ coin) while the header pill carried the
 * product mark — one product wearing two faces on one screen, which is the exact
 * twin this codebase keeps clearing out. Both now carry the laurel wreath
 * (owner's asset, 2026-09-06), which replaced the rocket in all three places it
 * appeared; see `creator-token-laurel.tsx` for the trace and the sizing.
 *
 * An adapter rather than a direct assignment because `NavIcon` is lucide's
 * `LucideProps`, whose `size` is `string | number`, and the mark takes a
 * `number` — passing the component straight in does not typecheck.
 *
 * `size={22}` matches the `h-[22px] w-[22px]` the row applies below, so the
 * className cannot fight the prop.
 */
const MeritumTokensIcon: NavIcon = ({ className }) => (
  <CreatorTokenLaurel size={22} className={className} />
);

/**
 * ★ HOVER IS WARM, AND IT IS THE SAME WARM AS EVERYWHERE ELSE (2026-08-10, owner).
 *
 * These rows highlighted to `#f1f3f5`, a neutral grey, while the topic pills in the
 * right rail highlight to `#fdf2f0` with `ink-brand-6` text. Two hover languages on one
 * screen, six inches apart: the grey read as system chrome and the warm one as the
 * product, so the nav felt like something the page was wearing rather than part of
 * it. Now both rails answer the cursor the same way, which is also the ink the red
 * ruler and the masthead marks are drawn in.
 *
 * The icons pick this up for free: lucide draws in `currentColor`, so the glyph and
 * the label warm together instead of the label moving alone.
 *
 * ACTIVE stays neutral grey on purpose. Hover is a question ("this one?") and active
 * is a statement ("you are here"); if both are warm, the row under your cursor and
 * the page you are on look identical, and the rail stops telling you where you are.
 */
const ROW_CLASS =
  /*
   * ★ EVERYTHING IN THIS RAIL IS 10% LARGER (2026-08-16, owner).
   *
   * Applied to the row's own metrics rather than by scaling the container: a
   * `transform: scale()` would blur text and would not move the hit target, and
   * a font-size bump alone would leave the icon and padding behind, so the row
   * would grow unevenly.
   *
   * 14 -> 15.4px gap, 14 -> 15.4px inline padding, 11 -> 12.1px block padding,
   * 15 -> 16.5px text with leading raised 24 -> 26.4px to keep the same ratio.
   * The icon moves with them (h-5 w-5 = 20px -> 22px) at the call site below.
   * Fractional pixels are deliberate: rounding each one would drift the row off
   * a clean 10%.
   */
  'flex items-center gap-[15.4px] rounded-xl px-[15.4px] py-[12.1px] font-ui text-[16.5px] leading-[26.4px] text-ink-8 transition-colors';
/*
 * ★ THE ACTIVE TREATMENT MOVED TO left-rail.module.css (owner design `nav-2a`,
 * 2026-08-18): a brand-tinted seat, the brand label, and a 2px rule that grows in at the
 * row's left edge. Hover moved with it, from warm to neutral - see that file for why the
 * inversion answers the objection the comment above raises rather than overruling it.
 * Nothing is left here: a second source of truth for the same state is how the two
 * treatments drift apart.
 */

/**
 * ★★★ TWO ROWS CANNOT BOTH BE "WHERE YOU ARE" (2026-08-10, measured).
 *
 * `isActive` is `pathname === href`, and in the App Router `usePathname()` does not
 * change until the destination has finished rendering — which on this app is 8-20s.
 * For that whole window the OLD page kept the grey active treatment while the row
 * under the cursor showed the warm red hover, so the rail said "you are here" about
 * one page and "this one?" about another, with the previous page still fully
 * painted underneath. The only thing that actually reported the navigation was the
 * 2px progress bar at the very top of the window, which is easy to miss and nowhere
 * near where the click happened.
 *
 * `pending` is the row the reader just clicked. It takes the active treatment
 * immediately and carries a spinner, and the real active row drops to normal for as
 * long as it lasts — so there is exactly one highlighted row at every instant, and
 * the feedback appears under the cursor rather than at the top of the screen.
 */
const NavRowContent = ({
  icon,
  label,
  isActive,
  isPending = false
}: {
  icon: NavIcon;
  label: string;
  isActive: boolean;
  isPending?: boolean;
}) => {
  const IconTag = icon;
  return (
    <span className={cn(ROW_CLASS, styles.row)} data-active={isActive || isPending ? 'true' : undefined}>
      {/* ★★★ THE SPINNER TAKES THE ICON'S SLOT; IT DOES NOT ADD A THIRD ONE
          (2026-09-06, owner: "sometimes when I click Meritum Tokens on the
          navbar, the word Tokens slips below Meritum").

          Measured on production, `/` -> `/creators`, rail column 200px:

            idle     label 126.00px intrinsic, 131.80px available -> 1 line, row 50.59px
            pending  label 128.00px intrinsic,  94.05px available -> 2 LINES, row 77.00px
            active   label 128.00px intrinsic, 131.80px available -> 1 line, row 50.59px

          Two things moved at the click, and they compounded. `.row[data-active]`
          in left-rail.module.css sets `font-weight: 600`, which widens the label
          126 -> 128px; and `data-active` is `isActive || isPending`, so it fires
          on the CLICK, not on arrival. At the same instant the spinner appeared
          as a THIRD flex child, costing its own 16px plus a second 15.4px `gap`
          — 31.4px off the label's share, 131.8 -> 100.4px of room for a 128px
          word pair. It wrapped, the row grew by exactly one 26.4px line, and
          every row below it was shoved down for as long as the navigation took.
          Then it silently un-wrapped on arrival, which is why it read as
          "sometimes".

          Putting the spinner IN the icon's 22px slot means the row has the same
          two children at the same two widths in every state: nothing reflows,
          nothing below moves, and the feedback still lands under the cursor
          (the point the `pending` doc above makes) rather than at the top of the
          window. `animate-spin` is a transform, so it does not affect layout.

          `min-w-0 truncate` on the label is the belt to that braces. `truncate`
          carries `white-space: nowrap`, so the label can no longer wrap in ANY
          state — which matters because even the fixed ACTIVE state clears its
          131.8px slot by only 3.8px, and any locale whose "Meritum tokens" runs
          a hair longer than English's would wrap permanently rather than just
          while pending. In that case it now ellipsises, which is survivable,
          instead of wrapping or spilling out of the 200px rail. English fits
          (128 <= 131.8), so nothing is clipped today. */}
      {isPending ? (
        <Loader2 className="h-[22px] w-[22px] shrink-0 animate-spin text-ink-brand-6" aria-hidden="true" />
      ) : (
        <IconTag className="h-[22px] w-[22px] shrink-0" />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
};

const InternalNavRow = ({
  href,
  icon,
  label,
  isActive,
  isPending = false,
  onNavigate,
  testId
}: {
  href: string;
  icon: NavIcon;
  label: string;
  isActive: boolean;
  isPending?: boolean;
  onNavigate?: (href: string) => void;
  testId: string;
}) => (
  <li>
    <BasePathLink
      href={href}
      data-testid={testId}
      aria-current={isActive ? 'page' : undefined}
      aria-busy={isPending || undefined}
      onNavigate={() => onNavigate?.(href)}
      prefetchOnIntent
    >
      <NavRowContent icon={icon} label={label} isActive={isActive} isPending={isPending} />
    </BasePathLink>
  </li>
);

export default function LeftRail() {
  const { t } = useTranslation('common_blog');
  const LABELS = labels(t);
  /**
   * ★★★ THE RAIL KNEW WHO YOU WERE LAST (2026-08-10, N-3).
   *
   * This read `useUserClient()`, which cannot answer during SSR and answers
   * "signed out" on the client until `/api/users/me` returns. Measured: the
   * Settings row was still missing 4.6 seconds into `/search` for a reader whose
   * session was valid the whole time, and the Profile row was a sign-in dialog
   * trigger rather than a link to their own page. The server had already read the
   * cookie to render the page; `useSessionIdentity` uses that until the client
   * has a real answer of its own, and hands over the moment it does.
   */
  const identity = useSessionIdentity();
  const pathname = usePathname();

  // Cleared by the pathname change, which is the moment the destination is really
  // on screen — so the spinner lasts exactly as long as the wait does.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);
  const navigatingTo = pendingHref && pendingHref !== pathname ? pendingHref : null;
  // While a navigation is in flight the page you are LEAVING stops claiming the
  // rail; without this the old row and the pending row would both look active,
  // which is the bug this is here to fix.
  const activeIs = (href: string) => pathname === href && !navigatingTo;

  const homeHref = '/';
  const profileHref = `/@${identity.username}`;
  const settingsHref = `/@${identity.username}/settings`;
  // Blacklisted/muted/followed-blacklists/followed-muted-lists — reached only via
  // a link ON the settings page (`moderation-lists.tsx`: "they live in settings
  // with the rest of the housekeeping"), not from the profile itself. A whole
  // family of sub-paths, not one page, so this is a PREFIX like `settingsHref`
  // is an exact page — see the exception handling below.
  const listsHref = `/@${identity.username}/lists`;

  /**
   * ★ A SUB-PAGE IS STILL THAT PAGE, WITH ONE EXCEPTION.
   *
   * `pathname === href` meant NO row was highlighted on `/@you/comments`,
   * `/@you/followers`, `/@you/communities` or `/wallet/tokens` — the rail simply
   * stopped saying where you were as soon as you opened a tab of the page it had
   * just sent you to. The exception is the one that matters: `/@you/settings` is
   * its OWN row, so Profile must NOT claim it, or both light up at once, which is
   * exactly the "two rows are active and one of them is wrong" this rail is being
   * fixed for.
   *
   * ★★ THE EXCEPTION HAS TO BE A PREFIX TOO (this fix). `except` used to be
   * matched with `===`, which only ever worked for `settingsHref` because
   * settings has no sub-pages of its own. `listsHref` is not one page but four
   * (`/lists/blacklisted`, `/lists/muted`, `/lists/followed_blacklists`,
   * `/lists/followed_muted_lists`) — an exact-match exception would let every one
   * of them fall through and re-claim the Profile row, which is exactly what was
   * happening: Profile lit up on every moderation-list page. Each excepted href
   * now excludes itself AND anything nested under it, the same rule `href` itself
   * already gets one line up.
   */
  const activeUnder = (href: string, ...except: string[]) =>
    !navigatingTo &&
    !!pathname &&
    (pathname === href ||
      (pathname.startsWith(`${href}/`) &&
        !except.some((ex) => pathname === ex || pathname.startsWith(`${ex}/`))));

  return (
    <nav
      aria-label={LABELS.primaryNav}
      className={cn('flex flex-col py-4', styles.rail)}
      data-testid="left-rail-nav"
    >
      <ul className="flex flex-col gap-1">
        {/* League status block — gates on logged-in internally, renders null otherwise. */}
        <LeagueShowcase />
        <InternalNavRow
          href={homeHref}
          icon={Icons.house}
          label={LABELS.home}
          isActive={activeIs(homeHref)}
          isPending={navigatingTo === homeHref}
          onNavigate={setPendingHref}
          testId="left-rail-home"
        />
        {identity.isLoggedIn ? (
          <InternalNavRow
            href={profileHref}
            icon={Icons.user}
            label={LABELS.profile}
            isActive={activeUnder(profileHref, settingsHref, listsHref)}
            isPending={navigatingTo === profileHref}
            onNavigate={setPendingHref}
            testId="left-rail-profile"
          />
        ) : (
          <li data-testid="left-rail-profile">
            {/* A real <button>, not a <span>. Radix's asChild forwards its props to
                whatever it wraps but does not make a non-interactive element
                focusable, so a span here was skipped by Tab entirely — a total
                lockout of this row for anyone navigating by keyboard or switch.
                Every other DialogLogin trigger in the app wraps a real button. */}
            <DialogLogin>
              <button type="button" className="w-full cursor-pointer text-left">
                <NavRowContent icon={Icons.user} label={LABELS.profile} isActive={false} />
              </button>
            </DialogLogin>
          </li>
        )}
        {/* Wallet / Witnesses / Proposals are now first-class in-app pages (design
            handoff-v2), not external links to wallet.openhive.network. Internal rows
            so the active page auto-highlights via the pathname check. */}
        <InternalNavRow
          href="/wallet"
          icon={Icons.wallet}
          label={LABELS.wallet}
          isActive={activeUnder('/wallet')}
          isPending={navigatingTo === '/wallet'}
          onNavigate={setPendingHref}
          testId="left-rail-wallet"
        />
        {/* Creator Tokens — the creator-token discovery surface (design
            handoff-v2). Icon: Icons.creatorTokens (custom-icons.tsx) — a coin
            carrying the product's own ◈ glyph, replacing a lucide `Users`
            icon the owner flagged as reading like a dollar sign and
            "shitty" (2026-08-11); see that icon's own doc for the reasoning. */}
        <InternalNavRow
          href="/creators"
          icon={MeritumTokensIcon}
          label={LABELS.creators}
          isActive={activeUnder('/creators')}
          isPending={navigatingTo === '/creators'}
          onNavigate={setPendingHref}
          testId="left-rail-creators"
        />

        <li aria-hidden="true">
          <Separator className="mx-[6px] my-[14px] w-auto bg-surface-27" />
        </li>

        <InternalNavRow
          href="/witnesses"
          icon={Icons.witnessVoteFilled}
          label={LABELS.voteWitness}
          isActive={activeIs('/witnesses')}
          isPending={navigatingTo === '/witnesses'}
          onNavigate={setPendingHref}
          testId="left-rail-vote-witness"
        />
        <InternalNavRow
          href="/proposals"
          icon={Icons.proposalsFilled}
          label={LABELS.voteProposals}
          isActive={activeIs('/proposals')}
          isPending={navigatingTo === '/proposals'}
          onNavigate={setPendingHref}
          testId="left-rail-vote-proposals"
        />
        {identity.isLoggedIn && (
          <InternalNavRow
            href={settingsHref}
            icon={Icons.settings}
            label={LABELS.settings}
            // Moderation lists (`/@you/lists/*`) are reached only from a link on
            // this page and nowhere on the profile — see `listsHref` above — so
            // this row has to claim that whole prefix too, not just its own href.
            isActive={activeUnder(settingsHref) || activeUnder(listsHref)}
            isPending={navigatingTo === settingsHref}
            onNavigate={setPendingHref}
            testId="left-rail-settings"
          />
        )}
      </ul>
    </nav>
  );
}
