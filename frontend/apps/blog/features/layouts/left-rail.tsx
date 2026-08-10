'use client';

import { ComponentType } from 'react';
import { LucideProps, Users } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { Icons } from '@ui/components/icons';
import { Separator } from '@ui/components/separator';
import { cn } from '@ui/lib/utils';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import BasePathLink from '../../components/base-path-link';
import DialogLogin from '@/blog/components/dialog-login';
import { LeagueShowcase } from '@/blog/features/retention/components/league-showcase';

// TODO: move to i18n (t('...'))
const LABELS = {
  primaryNav: 'Primary',
  home: 'Home',
  profile: 'Profile',
  wallet: 'Wallet',
  creators: 'Creators',
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

const NavRowContent = ({ icon, label, isActive }: { icon: NavIcon; label: string; isActive: boolean }) => {
  const IconTag = icon;
  return (
    <span className={cn(ROW_CLASS, isActive && ROW_ACTIVE_CLASS)}>
      <IconTag className="h-5 w-5 shrink-0" />
      <span>{label}</span>
    </span>
  );
};

const InternalNavRow = ({
  href,
  icon,
  label,
  isActive,
  testId
}: {
  href: string;
  icon: NavIcon;
  label: string;
  isActive: boolean;
  testId: string;
}) => (
  <li>
    <BasePathLink href={href} data-testid={testId}>
      <NavRowContent icon={icon} label={label} isActive={isActive} />
    </BasePathLink>
  </li>
);

export default function LeftRail() {
  const { user } = useUserClient();
  const pathname = usePathname();

  const homeHref = '/';
  const profileHref = `/@${user.username}`;
  const settingsHref = `/@${user.username}/settings`;

  return (
    <nav aria-label={LABELS.primaryNav} className="flex flex-col py-4" data-testid="left-rail-nav">
      <ul className="flex flex-col gap-1">
        {/* League status block — gates on logged-in internally, renders null otherwise. */}
        <LeagueShowcase />
        <InternalNavRow
          href={homeHref}
          icon={Icons.house}
          label={LABELS.home}
          isActive={pathname === homeHref}
          testId="left-rail-home"
        />
        {user.isLoggedIn ? (
          <InternalNavRow
            href={profileHref}
            icon={Icons.user}
            label={LABELS.profile}
            isActive={pathname === profileHref}
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
          isActive={pathname === '/wallet'}
          testId="left-rail-wallet"
        />
        {/* Creators — the creator-token discovery surface (design handoff-v2). */}
        <InternalNavRow
          href="/creators"
          icon={Users}
          label={LABELS.creators}
          isActive={pathname === '/creators' || !!pathname?.startsWith('/creators/')}
          testId="left-rail-creators"
        />

        <li aria-hidden="true">
          <Separator className="mx-[6px] my-[14px] w-auto bg-[#ebebeb]" />
        </li>

        <InternalNavRow
          href="/witnesses"
          icon={Icons.arrowBigUp}
          label={LABELS.voteWitness}
          isActive={pathname === '/witnesses'}
          testId="left-rail-vote-witness"
        />
        <InternalNavRow
          href="/proposals"
          icon={Icons.listChecks}
          label={LABELS.voteProposals}
          isActive={pathname === '/proposals'}
          testId="left-rail-vote-proposals"
        />
        {user.isLoggedIn && (
          <InternalNavRow
            href={settingsHref}
            icon={Icons.settings}
            label={LABELS.settings}
            isActive={pathname === settingsHref}
            testId="left-rail-settings"
          />
        )}
      </ul>
    </nav>
  );
}
