'use client';

import { FC } from 'react';
import { Link, Skeleton } from '@hive/ui';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useTokenPriceChip } from '../live/use-token-price-chip';
import { usdPrice } from '../market/format';
import { CreatorTokenRocket } from './creator-token-rocket';

// TODO i18n — staged copy, same precedent as the rest of this feature.
// ★ "Meritum tokens" is the product name as of 2026-08-16 (owner) — the left
// rail says the same. Singular here only because a creator launches exactly one.
const COPY = { launch: 'Launch your Meritum token' };

/**
 * The header's creator-token entry point (design brief §1) — owner ruling:
 * this is the part of the redesign he likes most, and creator tokens are the
 * primary product, so this gets first claim on the header's right cluster.
 *
 * TWO STATES, both real, never a fabricated third:
 *  - Has a token: a warm pill with the live price, straight to Creator
 *    Studio.
 *  - No token yet: an outlined CTA straight to the launch flow.
 *
 * Renders NOTHING while signed out, while the read hasn't resolved, or if
 * the feature isn't provisioned — the header must never show "Launch your
 * token" for a moment and then swap to a price once the real answer lands;
 * see use-token-price-chip.ts's own doc for why 'loading' and 'unknown' are
 * kept apart from 'none' rather than treated as the same "no" this control
 * would otherwise flash.
 *
 * ★ IDENTITY VIA `useSessionIdentity`, NOT a fresh `useUserClient()` call
 * (found live, 2026-08-11). `useUserClient()` cannot answer during SSR and
 * stays "signed out" on the client until `/api/users/me` returns — the exact
 * N-3 defect app-header.tsx's own HeaderAvatar doc measures at up to 4.6s.
 * A first build of this component called it directly and the pill vanished
 * on every fresh navigation for that whole window, popping back in once
 * hydration finished — on a heavier route (a token page, five extra queries
 * of its own) that was long enough to see with the naked eye. `identity`
 * is the same server-cookie-then-client answer the rest of this header
 * already draws Write/Notifications/Avatar from, so this pill now appears
 * or disappears in the same frame those do, never a beat later.
 */
const HeaderTokenPill: FC = () => {
  const identity = useSessionIdentity();
  // Hooks cannot be conditional — always called, with an empty handle while
  // signed out (use-token-price-chip.ts treats that as 'unknown' and this
  // component never renders on 'unknown' anyway).
  const chip = useTokenPriceChip(identity.isLoggedIn ? identity.username : '');

  if (!identity.isLoggedIn) return null;
  if (chip.status === 'unknown') return null;

  if (chip.status === 'loading') {
    // 2026-08-17: reserve the pill's footprint instead of returning null.
    // app-header.tsx's action cluster sits in the grid's `auto`-sized third
    // column, right next to the search bar's `minmax(0,1fr)` column — so
    // collapsing to zero width here and then popping in the real pill/CTA a
    // moment later (both states resolve fast; see use-token-price-chip.ts)
    // forced that `auto` column to grow on the spot and the search bar to
    // shrink by ~260px out from under the reader on every load. 260px/h-10
    // approximate the wider of the two real states — the "Launch your
    // Meritum token" CTA (also the more common one: most accounts have not
    // registered a market) — so a reader who turns out to have a market
    // sees the slot shrink to the narrower price pill rather than grow.
    // Loading -> resolved can still shift by a few px either way; what this
    // removes is the old nothing -> ~260px pop. `Skeleton` (packages/ui) is
    // this codebase's own "reserve the space, don't collapse to zero" loading
    // primitive (see its doc), so this reuses it rather than a bespoke pulse.
    return <Skeleton className="h-10 w-[260px] rounded-full" aria-hidden="true" data-testid="header-token-pill-skeleton" />;
  }

  if (chip.status === 'ready' && chip.priceUsd !== null) {
    return (
      <Link
        href="/creators/studio"
        className="flex items-center gap-2.5 rounded-full border border-line-16 bg-surface-warn-2 py-[7px] pl-3 pr-2 transition-colors hover:border-line-23 hover:bg-surface-warn-7"
        data-testid="header-token-pill"
      >
        {/* Same mark as the launch state above: this is one control in two
            states, and showing it a rocket in one and a glyph in the other is
            the kind of twin this codebase has been clearing out all day. */}
        <CreatorTokenRocket size={20} className="shrink-0 text-ink-brand-6" />
        <span className="font-sans text-[14px] leading-[22px] font-bold leading-none text-ink-2">@{identity.username}</span>
        <span aria-hidden="true" className="h-[15px] w-px bg-surface-32" />
        <span className="pr-1.5 font-sans text-[14px] leading-[22px] font-bold leading-none tabular-nums text-ink-2">
          {usdPrice(chip.priceUsd)}
        </span>
      </Link>
    );
  }

  // status === 'none' — resolved, and confirmed this account has never
  // registered a market.
  return (
    <Link
      /*
       * ★ THE HEADER CTA AND THE LEFT RAIL LAND ON THE SAME PAGE (2026-08-16,
       * owner). The rail's "Meritum tokens" opened the tokens landing page while
       * this one jumped straight into the launch flow, so the product's two most
       * prominent Meritum entry points disagreed about where Meritum starts. The
       * landing page is the one that explains what a Meritum is, and it carries
       * its own launch call to action, so nobody loses a step by arriving there.
       */
      href="/creators"
      className="flex items-center gap-2 whitespace-nowrap rounded-full border border-line-brand-10 bg-surface-1 px-4 py-[9px] font-sans text-[14px] leading-[22px] font-bold text-ink-brand-6 transition-colors hover:bg-surface-brand-12 hover:text-ink-27"
      data-testid="header-token-launch-cta"
    >
      {/* ★ The Creator Tokens rocket replaces the ◈ glyph here (design handoff,
          2026-08-13). 20px is the handoff's own floor — below it the three speed
          lines fuse — and it fits the pill's 40px box (22px line + 9px padding
          each side) without changing the pill's height. `currentColor` is why it
          follows the hover state from `ink-brand-6` to white; the glyph could not. */}
      <CreatorTokenRocket size={20} className="shrink-0" />
      <span>{COPY.launch}</span>
    </Link>
  );
};

export default HeaderTokenPill;
