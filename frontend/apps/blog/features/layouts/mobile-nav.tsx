'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@ui/components/button';
import { Icons } from '@ui/components/icons';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@ui/components/sheet';
import { useTranslation } from '@/blog/i18n/client';
import LeftRail from './left-rail';

/**
 * ★★★ THE ONLY WAY INTO /wallet, /creators, /witnesses AND /proposals ON A PHONE.
 *
 * `LeftRail` is the app's primary navigation, and every shell that renders it
 * does so inside `hidden ... md:block` (home-shell, wallet-shell, witnesses-shell,
 * proposals-content, token-shell, search, main-page-layout). Below 768px it was
 * simply absent, and `AppHeader` links to none of those four destinations — so on
 * the viewport most social traffic arrives on, Wallet (where a reader's money is)
 * was reachable only by typing the URL. There was no hamburger, drawer, sheet or
 * bottom bar anywhere in the tree.
 *
 * This is the house pattern, not a new one: upstream denser puts a Radix-backed
 * `Sheet` behind a single icon button at the end of the header's action cluster
 * (`apps/blog/features/layouts/sidebar.tsx` at the fork point, still live in
 * `apps/wallet/components/sidebar.tsx`). The panel renders the REAL `LeftRail`
 * rather than a second list of links, so the two can never drift: any row added
 * to the desktop rail appears here the same day, with the same active-state
 * logic, the same login gating and the same test ids.
 *
 * Radix's Dialog gives the focus trap, the Escape handler, `aria-modal`, the
 * inert background and the restore-focus-on-close — none of it hand-rolled.
 */
export default function MobileNav() {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // A client-side navigation does not unmount the drawer, so without this the
  // panel would still be sitting over the page the reader just asked for.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // …and tapping the row for the page you are already on changes no pathname,
  // so that effect never fires. Close on any link activation inside the panel.
  // Deliberately anchors only: the logged-out "Profile" row is a <button> that
  // opens the login dialog, which should stack over the drawer, not replace it.
  const closeOnLink = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement | null)?.closest('a')) setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          // md:hidden, because at >=768px the real rail is on the page and a
          // second door to the same seven rows would just be clutter.
          className="h-10 w-10 px-0 md:hidden"
          aria-label={t('navigation.mobile_nav.open')}
          data-testid="mobile-nav-trigger"
        >
          <Icons.menu className="h-6 w-6" />
        </Button>
      </SheetTrigger>

      <SheetContent
        position="right"
        size="content"
        // A real scrim: the shared default overlay is fully transparent, which
        // reads as "two pages at once" when the panel covers most of a phone.
        overlayClassName="bg-[#161511]/40"
        className="flex w-[290px] max-w-[85vw] flex-col overflow-y-auto px-3 pb-8 pt-12"
        data-testid="mobile-nav-content"
      >
        {/* Radix requires a labelled dialog; the panel's own rows are the
            visible label, so this is for screen readers only. */}
        <SheetTitle className="sr-only">{t('navigation.mobile_nav.title')}</SheetTitle>
        <SheetDescription className="sr-only">{t('navigation.mobile_nav.description')}</SheetDescription>
        <div onClick={closeOnLink}>
          <LeftRail />
        </div>
      </SheetContent>
    </Sheet>
  );
}
