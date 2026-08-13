'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@ui/components/dropdown-menu';
import { ReactNode, useState } from 'react';
import { Link, UserAvatarImg } from '@hive/ui';
import BasePathLink from '../../../components/base-path-link';
import LangToggle from '../lang-toggle';
import { useLogout } from '@smart-signer/lib/auth/use-logout';
import { User } from '@smart-signer/types/common';
import { useTranslation } from '@/blog/i18n/client';
import { useTokenPriceChip } from '@/blog/features/creator-tokens/live/use-token-price-chip';
import { useLivePortfolio } from '@/blog/features/creator-tokens/live/use-live-portfolio';
import { usdPrice } from '@/blog/features/creator-tokens/market/format';

// TODO i18n — staged copy for the rows added in the creator-token-prominence
// pass (2026-08-11); same precedent as app-header.tsx's own LABELS one
// directory up. The three PRE-EXISTING rows below (Profile/Wallet/Logout)
// keep their real t('navigation.user_menu.*') keys unchanged.
const LITE_LABELS = {
  security: 'Sign-in & recovery',
  upgrade: 'Upgrade to a Hive account'
};
const LABELS = {
  yourTokens: 'Your tokens',
  creatorStudio: 'Creator Studio',
  settings: 'Settings'
};

const ROW_CLASS =
  'flex cursor-pointer items-center justify-between gap-2.5 rounded-[11px] px-3 py-2.5 font-sans text-[14px] font-medium text-[#3f4650] transition-colors hover:bg-[#f6f5f2] hover:text-[#161511] focus:bg-[#f6f5f2] focus:text-[#161511]';
// ★ Contrast fix (2026-08-13, O5 a11y build map item 4). Was `#a29a92` at
// 2.77:1 on white/against this row's `#f6f5f2` hover background — both fail
// the 4.5:1 floor for real informational text ("N held", "◈ @handle"). This
// row sits on the grey `#f6f5f2` hover ground, so it takes the darker
// "grey-ground" replacement rather than the plain-white one: `#6f6963` is
// 4.97:1 on `#f6f5f2` and 5.42:1 on white, independently measured.
const META_CLASS = 'shrink-0 font-sans text-[12.5px] tabular-nums text-[#6f6963]';

/**
 * A small, self-contained avatar for the menu's OWN header block — the app's
 * one avatar component (F6 item 22, converged), sized at 38px for this
 * block rather than app-header.tsx's HeaderAvatar (36px, manabar-ring
 * trigger). Previously called `getUserAvatarUrl` (our own `/api/avatar`
 * proxy) directly on every render; now tries `images.hive.blog` first and
 * only falls back to the proxy on error, same as everywhere else.
 */
const MenuAvatar = ({ username }: { username: string }) => (
  <UserAvatarImg username={username || ''} pixelSize={38} />
);

/**
 * The menu's real content — deliberately a SEPARATE component from
 * `UserMenu`, and mounted only while the dropdown is actually open. Radix's
 * `DropdownMenuContent` does not render its children to the DOM while closed
 * (no `forceMount` is set anywhere in this tree), so the two live reads this
 * component owns — this account's own token price, and its held-token count
 * — never fire on a page load where nobody opens the menu. `UserMenu` itself
 * is mounted on every single page for every signed-in reader (it's the
 * avatar in the header), so keeping those reads out of it is not a
 * micro-optimisation; it is the difference between "a wallet read on every
 * page view" and "a wallet read when someone opens their account menu".
 *
 * The token-price read also shares its cache key with the header's own
 * token pill (features/creator-tokens/live/use-token-price-chip.ts) and the
 * held-count read shares its cache with /wallet/tokens
 * (features/creator-tokens/live/use-live-portfolio.ts) — opening this menu
 * after either of those has already resolved is instant, not a new fetch.
 *
 * ★ ONE ELEMENT PER ROW (2026-08-13, O5 a11y build map item 1). Every row
 * used to be `<Link><DropdownMenuItem>…</DropdownMenuItem></Link>` — an
 * `<a>` (implicit `role=link`) wrapping a `<div role="menuitem">`. That is
 * not a valid `menu > menuitem` containment chain for a screen reader in
 * menu mode, and it duplicated the tab stop (both the anchor and the
 * roving-tabindex menuitem were independently focusable — measured live).
 * Every row is now `<DropdownMenuItem asChild><Link>…</Link></DropdownMenuItem>`,
 * Radix's own documented composition: the menuitem role, roving tabindex and
 * click-to-select behaviour all land on the single real `<a>`, and
 * `DropdownMenuItem`'s `className` merges onto that same element instead of
 * a wrapper div (`@radix-ui/react-slot`'s `mergeProps` composes `onClick`
 * and concatenates `className` — verified in the installed package, not
 * assumed).
 */
const AccountMenuContent = ({ user }: { user: User }) => {
  const { t } = useTranslation('common_blog');
  const onLogout = useLogout();
  const chip = useTokenPriceChip(user.username);
  const portfolio = useLivePortfolio();
  const hasToken = chip.status === 'ready' && chip.priceUsd !== null;
  const heldCountKnown = !portfolio.isLoading && !portfolio.holdingsUnavailable;

  return (
    <>
      {/* Header block (design brief §4): avatar + handle, plus
          "◈ @handle · $price" only once this account is confirmed to have a
          token — never while that read is still in flight or unknown (same
          rule as the header pill). No display name: `User`
          (smart-signer/types/common.ts) carries none, and inventing one here
          would be exactly the placeholder text rule 5 forbids. */}
      <div className="flex items-center gap-[11px] px-2.5 pb-3 pt-2.5">
        <MenuAvatar username={user.username} />
        <div className="min-w-0">
          <div
            className="truncate font-sans text-[14.5px] font-bold text-[#161511]"
            data-testid="user-name-in-profile-menu"
          >
            {user.username}
          </div>
          {chip.status === 'ready' && chip.priceUsd !== null ? (
            // ★ Contrast fix (item 4): `#8a827a` was 3.78:1, below the 4.5:1
            // floor. This block sits on the header's plain white background
            // (not the `#f6f5f2` hover row), so it takes the plain-white
            // replacement: `#7a7268` measures 4.74:1 on white.
            <div className="truncate font-sans text-[12.5px] text-[#7a7268]">
              ◈ @{user.username} · {usdPrice(chip.priceUsd)}
            </div>
          ) : null}
        </div>
      </div>
      <DropdownMenuSeparator className="mx-1 my-0 mb-1.5 h-px bg-[#f0f0ee]" />

      <DropdownMenuGroup className="flex flex-col gap-0.5">
        <DropdownMenuItem asChild className={ROW_CLASS}>
          <BasePathLink href={`/@${user.username}`} data-testid="user-profile-menu-profile-link">
            <span>{t('navigation.user_menu.profile')}</span>
          </BasePathLink>
        </DropdownMenuItem>

        {/*
          The two doors a lite account needs and could not previously find. Both
          pages existed with nothing anywhere linking to them — the same way /login
          was unreachable for weeks. Lite-only: a full Hive account already has its
          own keys and has nothing to upgrade to.
        */}
        {user.account_tier === 'lite' ? (
          <>
            <DropdownMenuItem asChild className={ROW_CLASS}>
              <Link href="/security" data-testid="user-profile-menu-security-link">
                <span>{LITE_LABELS.security}</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className={ROW_CLASS}>
              <Link href="/upgrade" data-testid="user-profile-menu-upgrade-link">
                <span>{LITE_LABELS.upgrade}</span>
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}

        {/* Your tokens (design brief §4) — the held-token count, real from
            useLivePortfolio, omitted (not rendered as "0 held" or a spinner)
            for as long as the read hasn't confidently answered. */}
        <DropdownMenuItem asChild className={ROW_CLASS}>
          <Link href="/wallet/tokens" data-testid="user-profile-menu-your-tokens-link">
            <span>{LABELS.yourTokens}</span>
            {heldCountKnown ? <span className={META_CLASS}>{portfolio.holdings.length} held</span> : null}
          </Link>
        </DropdownMenuItem>

        {/* Creator Studio (design brief §4) — always a real destination
            (it's also where a reader without a token yet would go to launch
            one), the "◈ @handle" meta only once they are confirmed to have
            one. */}
        <DropdownMenuItem asChild className={ROW_CLASS}>
          <Link href="/creators/studio" data-testid="user-profile-menu-creator-studio-link">
            <span>{LABELS.creatorStudio}</span>
            {hasToken ? <span className={META_CLASS}>◈ @{user.username}</span> : null}
          </Link>
        </DropdownMenuItem>

        {/* ★ NOW A DropdownMenu.Sub, NOT A LIFTED-OUT <div> (2026-08-13, QA
            V3-a11y item 2, replacing the 1c fix above). The 1c fix removed the
            "`<button>` inside `role=menuitem`" shape, but the plain wrapper
            `<div>` it left behind sits outside this menu's roving-focus/
            typeahead collection entirely — confirmed live, twice: 12
            consecutive ArrowDown presses through the open menu never once
            focused it, jumping straight from Creator Studio to Wallet. `Tab`
            didn't reach it either — it closed the whole menu instead, same as
            from any other row.
            `renderAs="submenu"` (see `lang-toggle.tsx`) fixes the actual root
            cause: it uses Radix's `DropdownMenu.Sub`, built on the same
            `MenuItemImpl` as every plain `DropdownMenuItem`, so this row IS a
            real collection member of THIS menu's roving-focus group — no
            second Root, no duplicate tab stop. Reachable and operable,
            verified by tracing the installed
            `@radix-ui/react-menu@2.1.4` source rather than assumed (see the
            comment in `lang-toggle.tsx`): open the account menu, ArrowDown
            four times lands here (Profile → Your tokens → Creator Studio →
            Language), then ArrowRight or Enter opens the 9-language list with
            focus auto-landing on its first entry; ArrowLeft or Escape returns
            to this row. The Tab-close handler below needed NO changes — its
            `data-radix-menu-content` guard already treats this submenu's own
            content the same way it already treats a truly separate one. */}
        <LangToggle logged={true} renderAs="submenu" className={ROW_CLASS} />

        <DropdownMenuItem asChild className={ROW_CLASS}>
          <Link href="/wallet" data-testid="user-profile-menu-wallet-link">
            <span>{t('navigation.user_menu.wallet')}</span>
          </Link>
        </DropdownMenuItem>

        {/* Settings (design brief §4: "was missing from the old menu — it is
            required"). Same destination the left rail's own Settings row
            uses (features/layouts/left-rail.tsx's settingsHref). */}
        <DropdownMenuItem asChild className={ROW_CLASS}>
          <Link href={`/@${user.username}/settings`} data-testid="user-profile-menu-settings-link">
            <span>{LABELS.settings}</span>
          </Link>
        </DropdownMenuItem>

        <DropdownMenuItem asChild className={ROW_CLASS}>
          <Link
            href=""
            onClick={async (e) => {
              e.preventDefault();
              await onLogout();
            }}
            data-testid="user-profile-menu-logout-link"
          >
            <span>{t('navigation.user_menu.logout')}</span>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  );
};

const UserMenu = ({ children, user }: { children: ReactNode; user: User }) => {
  // ★ Controlled open state (2026-08-13, O5 a11y build map item 1a) — needed
  // so the Tab handler below can close the menu itself rather than relying
  // on Radix's own (Tab-swallowing) keyboard handling.
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      {/* 262px / radius 16 / border #ebebeb / shadow / 8px padding (design
          brief §4). Close-on-outside-click and close-on-Escape are Radix's
          own DropdownMenu.Content behaviour — nothing hand-rolled here, so
          both requirements the brief calls out at the end of §4 are already
          satisfied by using this primitive rather than a custom popover. */}
      <DropdownMenuContent
        align="end"
        className="w-[262px] rounded-2xl border border-[#ebebeb] bg-white p-2 shadow-[0_12px_34px_rgba(20,18,10,0.12)]"
        data-testid="user-profile-menu-content"
        onKeyDown={(e) => {
          // ★ TAB TRAP FIX (2026-08-13, O5 a11y build map item 1a). Radix's
          // own `@radix-ui/react-menu@2.1.4` swallows every Tab keypress by
          // design (ARIA menu pattern: arrow keys navigate a menu, not Tab)
          // — `node_modules/.../react-menu/dist/index.mjs`, the
          // `onKeyDown: composeEventHandlers(contentProps.onKeyDown, ...)`
          // wiring on its Content: `if (event.key === "Tab")
          // event.preventDefault();` unconditionally, with no escape hatch.
          // Measured live: five Tab presses from inside the open menu landed
          // on the exact same node five times. No markup change fixes this;
          // `composeEventHandlers` (verified in
          // `@radix-ui/primitive`) always runs the CALLER's handler
          // (`contentProps.onKeyDown`, i.e. this one) before Radix's own,
          // and skips Radix's handler once `event.defaultPrevented` is true.
          // So: catch Tab here, prevent it ourselves, and close the menu —
          // Radix's default `onCloseAutoFocus` then returns focus to the
          // trigger. The keypress is "spent" closing the menu rather than
          // moving focus, so the user's NEXT physical Tab continues through
          // the page from the trigger, normally. One wasted keypress,
          // trap fully removed.
          //
          // ★ GUARD AGAINST THE NESTED MENU (caught in review, not measured
          // live). `LangToggle` below renders its OWN separate `DropdownMenu`
          // (its own Trigger + Content). React's synthetic events bubble
          // through the REACT tree even across a Radix `Portal`, so a Tab
          // press inside LangToggle's own open language list would reach
          // this handler too and collapse the OUTER menu out from under it.
          // Mirror Radix's own internal guard exactly (same check, same
          // source file, a few lines below the swallow this fix targets):
          // only act when the Tab originated inside THIS content, not a
          // nested one.
          if (e.key !== 'Tab') return;
          const target = e.target as HTMLElement;
          if (target.closest('[data-radix-menu-content]') !== e.currentTarget) return;
          e.preventDefault();
          setOpen(false);
        }}
      >
        <AccountMenuContent user={user} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
export default UserMenu;
