'use client';

import { ComponentType, useEffect, useState } from 'react';
import { Loader2, LucideProps } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { Icons } from '@ui/components/icons';
import { Separator } from '@ui/components/separator';
import { cn } from '@ui/lib/utils';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import BasePathLink from '../../components/base-path-link';
import DialogLogin from '@/blog/components/dialog-login';
import { LeagueShowcase } from '@/blog/features/retention/components/league-showcase';

// TODO: move to i18n (t('...'))
const LABELS = {
  primaryNav: 'Primary',
  home: 'Home',
  profile: 'Profile',
  wallet: 'Wallet',
  // ★ RENAMED (design brief "Also changed", creator-token-prominence pass,
  // 2026-08-11): "Creators" undersold what this row is — creator TOKENS, the
  // product's primary surface per owner ruling, not a people directory.
  creators: 'Creator Tokens',
  voteWitness: 'Witnesses',
  voteProposals: 'Proposals',
  settings: 'Settings'
};

type NavIcon = ComponentType<LucideProps>;

/**
 * ★ HOVER IS WARM, AND IT IS THE SAME WARM AS EVERYWHERE ELSE (2026-08-10, owner).
 *
 * These rows highlighted to `#f1f3f5`, a neutral grey, while the topic pills in the
 * right rail highlight to `#fdf2f0` with `#c0392b` text. Two hover languages on one
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
  'flex items-center gap-[14px] rounded-xl px-[14px] py-[11px] font-sans text-[15px] text-[#4b5563] transition-colors hover:bg-[#fdf2f0] hover:text-[#c0392b]';
const ROW_ACTIVE_CLASS = 'bg-[#f1f3f5] font-medium text-[#161511]';

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
    <span className={cn(ROW_CLASS, (isActive || isPending) && ROW_ACTIVE_CLASS)}>
      <IconTag className="h-5 w-5 shrink-0" />
      <span>{label}</span>
      {isPending ? (
        <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin text-[#c0392b]" aria-hidden="true" />
      ) : null}
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
    >
      <NavRowContent icon={icon} label={label} isActive={isActive} isPending={isPending} />
    </BasePathLink>
  </li>
);

export default function LeftRail() {
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
   */
  const activeUnder = (href: string, ...except: string[]) =>
    !navigatingTo &&
    !!pathname &&
    (pathname === href || (pathname.startsWith(`${href}/`) && !except.includes(pathname)));

  return (
    <nav aria-label={LABELS.primaryNav} className="flex flex-col py-4" data-testid="left-rail-nav">
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
            isActive={activeUnder(profileHref, settingsHref)}
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
          icon={Icons.creatorTokens}
          label={LABELS.creators}
          isActive={activeUnder('/creators')}
          isPending={navigatingTo === '/creators'}
          onNavigate={setPendingHref}
          testId="left-rail-creators"
        />

        <li aria-hidden="true">
          <Separator className="mx-[6px] my-[14px] w-auto bg-[#ebebeb]" />
        </li>

        <InternalNavRow
          href="/witnesses"
          icon={Icons.arrowBigUp}
          label={LABELS.voteWitness}
          isActive={activeIs('/witnesses')}
          isPending={navigatingTo === '/witnesses'}
          onNavigate={setPendingHref}
          testId="left-rail-vote-witness"
        />
        <InternalNavRow
          href="/proposals"
          icon={Icons.listChecks}
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
            isActive={activeIs(settingsHref)}
            isPending={navigatingTo === settingsHref}
            onNavigate={setPendingHref}
            testId="left-rail-settings"
          />
        )}
      </ul>
    </nav>
  );
}
