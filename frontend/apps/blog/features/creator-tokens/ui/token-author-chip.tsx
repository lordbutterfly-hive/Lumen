'use client';

import { FC } from 'react';
import { Link } from '@hive/ui';
import { useTokenPriceChip } from '../live/use-token-price-chip';
import { usdPrice } from '../market/format';

// TODO i18n — staged copy, same precedent as the rest of this feature's UI
// strings (labels.ts's own doc explains why: the visual design track owns
// this feature's copy right now).
const COPY = { buy: 'Buy' };

/**
 * The small "this author has a creator token" chip for a byline row — feed
 * card or post page, after the timestamp. Owner ruling (creator-token-
 * prominence pass, 2026-08-11): a token price indicator belongs next to every
 * post and every name.
 *
 * ★ RENDERS NOTHING for THREE different situations, not one: the author
 * genuinely has no token, the read hasn't resolved yet, or it failed. A
 * reader scanning a feed of twenty posts cannot tell any of those apart from
 * one small pill — an "unavailable" chip or a flash of a placeholder on every
 * row that hasn't resolved yet would read as broken far more often than it
 * would read as informative, since most authors on any given feed have not
 * launched a token. So the chip stays invisible until the answer is a
 * confident yes, then appears; it never renders an empty or disabled state.
 * This mirrors live/use-creator-follow.ts's own `available` gate, which
 * hides that button for the identical reason.
 *
 * ★ NO "has not launched" TEXT, deliberately (the other option the design
 * brief offered). A feed row is dense — avatar, name, community, timestamp
 * already compete for the same 13.5px line — and a negative label on most
 * rows (most authors have no token) would out-shout the positive signal on
 * the few rows that matter, which is the opposite of what a product whose
 * whole point is "creator tokens are the primary surface" should do. Silence
 * on "no" and a warm pill on "yes" makes the yes rows the ones that stand
 * out, which is the point.
 */
const TokenAuthorChip: FC<{ handle: string }> = ({ handle }) => {
  const { status, priceUsd } = useTokenPriceChip(handle);
  if (status !== 'ready' || priceUsd === null) return null;

  return (
    <Link
      href={`/creators/${handle}`}
      className="inline-flex shrink-0 items-center gap-[7px] rounded-full border border-[#e6dcd6] bg-[#FBF7F2] py-[3px] pl-[9px] pr-[4px] transition-colors hover:border-[#d9c8bf] hover:bg-[#f8f1ea]"
      data-testid="token-author-chip"
    >
      <span aria-hidden="true" className="text-[11px] leading-none text-[#c0392b]">
        ◈
      </span>
      <span className="font-sans text-[12.5px] font-bold leading-none tabular-nums text-[#161511]">
        {usdPrice(priceUsd)}
      </span>
      <span className="rounded-full border border-[#ecdfd8] bg-white px-[9px] py-[2px] font-sans text-[11.5px] font-bold leading-none text-[#c0392b]">
        {COPY.buy}
      </span>
    </Link>
  );
};

export default TokenAuthorChip;
