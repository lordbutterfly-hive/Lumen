'use client';

import { FC } from 'react';
import { Link } from '@hive/ui';
import { useTokenPriceChip } from '../live/use-token-price-chip';
import { useLiveDiscovery } from '../live/use-live-discovery';
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
/**
 * ★★★ ONE DISCOVERY READ FOR THE WHOLE PAGE, NOT ONE MARKET READ PER AUTHOR
 * (measured 2026-08-11, owner reported "the page takes 30 seconds to load").
 *
 * This chip renders on EVERY byline. It used to call `useTokenPriceChip(handle)`
 * unconditionally, and that hook issues `readMarket(handle)` — one GraphQL POST
 * per author, keyed per author so React Query cannot dedupe them, with a
 * `refetchInterval` so they repeat forever. Measured on the home feed: FIVE-PLUS
 * concurrent `POST /api/creator-tokens/gql` at 4.2-4.5 SECONDS EACH on a single
 * load, against a testnet node that is slow and intermittently 502s. A 30-author
 * feed means up to thirty of them, on every load, on a timer.
 *
 * And every one of those calls returned "no market", because a market only
 * exists for accounts that have actually launched a token — currently none.
 * Thirty round-trips to render nothing.
 *
 * `readDiscovery` answers "who has a token at all" in ONE call, shared across
 * every chip on the page (same query key, so React Query issues it once). Only a
 * handle that appears in that list is worth a price read. When discovery is
 * unavailable the set is empty and NO per-author call is made at all — which is
 * also the honest behaviour, since without discovery we cannot know who has a
 * token and this chip's whole contract (see below) is to stay silent unless the
 * answer is a confident yes.
 *
 * The hook is still called unconditionally, with an empty handle when the author
 * is not a known creator — `useTokenPriceChip` already treats `''` as disabled,
 * and calling it conditionally would break React's rules of hooks.
 */
// ★ A SEPARATE, DELIBERATELY LARGER, STILL-SHARED CACHE KEY (2026-08-11).
// creators-view.tsx calls `useLiveDiscovery()` with the default limit (60) —
// correct THERE, because that page is an intentional top-60 ranked browse
// list (creators-view.tsx's own doc: the indexer's SQL ordering IS the
// product's ranking, and a browse page is allowed to cut off).
//
// This chip is not a ranked list — it is a per-byline YES/NO membership
// check ("does this author have a market at all"), run on every post by
// every author. Sharing creators-view's capped key would mean an author
// ranked 61st+ in `lumen_ct_discovery` never gets a chip even with a live
// market, silently, with no error — indistinguishable from "no token".
// `useLiveDiscovery(CHIP_DISCOVERY_LIMIT)` below creates its OWN query key
// (`['creatorTokens','live','discovery', CHIP_DISCOVERY_LIMIT]`), so it is
// still exactly ONE shared request across every chip mounted on a page
// (React Query dedupes by key, same mechanism as the original fix) — the
// per-author storm this file exists to prevent does not come back. The one
// cost is that a page showing BOTH the browse view and a chip issues two
// discovery requests instead of one; that is a fair price for correctness,
// and both are still capped, shared, and polled at the same slow interval.
//
// 1000 is a reasoned choice, not a measured one: `lumen_ct_discovery` is
// EMPTY on testnet right now (queried directly, 2026-08-11), so there is
// nothing to measure against. It mirrors the existing "large but bounded"
// convention this codebase already uses for a similar full-coverage read —
// see buttons-container.tsx's `get_following(limit=1000)`. Revisit this
// constant if the creator count ever approaches it.
const CHIP_DISCOVERY_LIMIT = 1000;

const TokenAuthorChip: FC<{ handle: string }> = ({ handle }) => {
  const { creators, unavailable } = useLiveDiscovery(CHIP_DISCOVERY_LIMIT);
  // Matches BOTH a bare handle and a `hive:`-prefixed one on purpose, not
  // provisionally: creator-tokens' `register` action never sends an explicit
  // `creator` field (payload-contract.ts) — the identity is `currentCaller()`,
  // which go-vsc's state engine rewrites to `"hive:" + auth` for every
  // L1-originated transaction BEFORE any contract runs (already proven
  // against go-vsc source + a live mainnet query — see memory
  // reference_vsc_contract_identity_and_encoding). So the canonical creator
  // identity flowing into this contract, and presumably into whatever this
  // view's `creator` column mirrors, is `hive:${handle}`-shaped. Both
  // `lumen_ct_discovery` and its underlying raw event table
  // (`lumen_ct_registered_events`) are EMPTY on testnet right now (queried
  // directly, 2026-08-11), so this could not be confirmed against a real row
  // today — this comment records the reasoning, not a measurement. Keep both
  // branches until a real row settles it.
  const isKnownCreator =
    !unavailable && creators.some((c) => c.creator === handle || c.creator === `hive:${handle}`);
  const { status, priceUsd } = useTokenPriceChip(isKnownCreator ? handle : '');
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
