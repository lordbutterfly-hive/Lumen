'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@ui/components/dropdown-menu';
import { ReactNode } from 'react';
import { Link, getUserAvatarUrl } from '@hive/ui';
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
const META_CLASS = 'shrink-0 font-sans text-[12.5px] tabular-nums text-[#a29a92]';

/**
 * A small, self-contained avatar for the menu's OWN header block — same
 * "letter under the image, image removes itself on error" shape as
 * app-header.tsx's HeaderAvatar (N-4: an empty ring/broken image reads as an
 * account that vanished, not a picture that failed to load), kept as its own
 * tiny copy here rather than importing that one, since HeaderAvatar is sized
 * and composed specifically for the manabar-ring trigger it sits inside.
 */
const MenuAvatar = ({ username }: { username: string }) => (
  <span
    aria-hidden="true"
    className="relative flex h-[38px] w-[38px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#f1f3f5] font-sans text-[13px] font-bold uppercase leading-none text-[#6b7280]"
  >
    {username.slice(0, 1)}
    <img
      src={getUserAvatarUrl(username || '', 'small')}
      alt=""
      width={38}
      height={38}
      onError={(e) => {
        e.currentTarget.style.display = 'none';
      }}
      className="absolute inset-0 h-[38px] w-[38px] rounded-full object-cover"
    />
  </span>
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
            <div className="truncate font-sans text-[12.5px] text-[#8a827a]">
              ◈ @{user.username} · {usdPrice(chip.priceUsd)}
            </div>
          ) : null}
        </div>
      </div>
      <DropdownMenuSeparator className="mx-1 my-0 mb-1.5 h-px bg-[#f0f0ee]" />

      <DropdownMenuGroup className="flex flex-col gap-0.5">
        <BasePathLink href={`/@${user.username}`} data-testid="user-profile-menu-profile-link">
          <DropdownMenuItem className={ROW_CLASS}>
            <span>{t('navigation.user_menu.profile')}</span>
          </DropdownMenuItem>
        </BasePathLink>

        {/*
          The two doors a lite account needs and could not previously find. Both
          pages existed with nothing anywhere linking to them — the same way /login
          was unreachable for weeks. Lite-only: a full Hive account already has its
          own keys and has nothing to upgrade to.
        */}
        {user.account_tier === 'lite' ? (
          <>
            <Link href="/security" data-testid="user-profile-menu-security-link">
              <DropdownMenuItem className={ROW_CLASS}>
                <span>{LITE_LABELS.security}</span>
              </DropdownMenuItem>
            </Link>
            <Link href="/upgrade" data-testid="user-profile-menu-upgrade-link">
              <DropdownMenuItem className={ROW_CLASS}>
                <span>{LITE_LABELS.upgrade}</span>
              </DropdownMenuItem>
            </Link>
          </>
        ) : null}

        {/* Your tokens (design brief §4) — the held-token count, real from
            useLivePortfolio, omitted (not rendered as "0 held" or a spinner)
            for as long as the read hasn't confidently answered. */}
        <Link href="/wallet/tokens" data-testid="user-profile-menu-your-tokens-link">
          <DropdownMenuItem className={ROW_CLASS}>
            <span>{LABELS.yourTokens}</span>
            {heldCountKnown ? <span className={META_CLASS}>{portfolio.holdings.length} held</span> : null}
          </DropdownMenuItem>
        </Link>

        {/* Creator Studio (design brief §4) — always a real destination
            (it's also where a reader without a token yet would go to launch
            one), the "◈ @handle" meta only once they are confirmed to have
            one. */}
        <Link href="/creators/studio" data-testid="user-profile-menu-creator-studio-link">
          <DropdownMenuItem className={ROW_CLASS}>
            <span>{LABELS.creatorStudio}</span>
            {hasToken ? <span className={META_CLASS}>◈ @{user.username}</span> : null}
          </DropdownMenuItem>
        </Link>

        {/* Item 9's replacement stays a nested control, not a link — unchanged
            behaviour from before this pass, just re-padded to sit inside the
            redesigned row list without LangToggle's own button chrome
            fighting ROW_CLASS's hover background. */}
        <DropdownMenuItem className="cursor-pointer rounded-[11px] px-1.5 py-0.5">
          <LangToggle logged={true} />
        </DropdownMenuItem>

        <Link href="/wallet" data-testid="user-profile-menu-wallet-link">
          <DropdownMenuItem className={ROW_CLASS}>
            <span>{t('navigation.user_menu.wallet')}</span>
          </DropdownMenuItem>
        </Link>

        {/* Settings (design brief §4: "was missing from the old menu — it is
            required"). Same destination the left rail's own Settings row
            uses (features/layouts/left-rail.tsx's settingsHref). */}
        <Link href={`/@${user.username}/settings`} data-testid="user-profile-menu-settings-link">
          <DropdownMenuItem className={ROW_CLASS}>
            <span>{LABELS.settings}</span>
          </DropdownMenuItem>
        </Link>

        <Link
          href=""
          onClick={async (e) => {
            e.preventDefault();
            await onLogout();
          }}
          data-testid="user-profile-menu-logout-link"
        >
          <DropdownMenuItem className={ROW_CLASS}>
            <span>{t('navigation.user_menu.logout')}</span>
          </DropdownMenuItem>
        </Link>
      </DropdownMenuGroup>
    </>
  );
};

const UserMenu = ({ children, user }: { children: ReactNode; user: User }) => {
  return (
    <DropdownMenu>
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
      >
        <AccountMenuContent user={user} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
export default UserMenu;
