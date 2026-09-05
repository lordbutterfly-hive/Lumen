'use client';

import type React from 'react';
import { Link, UserAvatarImg } from '@hive/ui';
import { cn } from '@ui/lib/utils';
import { routeHandle } from '@/blog/features/creator-tokens/live/adapt';
import type { MarketPrice } from '@/blog/features/creator-tokens/types';
import { usdPrice } from '@/blog/features/creator-tokens/market/format';
import styles from './post-card.module.css';
import { buyWordFor } from '@/blog/features/creator-tokens/market/market-health';
import { useIntentPrefetch } from '@/blog/components/intent-prefetch';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE POST CARD'S IDENTITY CLUSTER — face, handle, price, Buy as ONE object.
 * Built to `handoff_identity_pill/SPEC.md`, option **N1** (owner's choice).
 *
 * ★★★ WHY THE FACE SITS OUTSIDE THE PILL AND UNDERLAPS IT. N1's whole argument
 * is that a 40px face "reads as a person, not a badge" — 40px being what
 * hive.blog and peakd use. Putting it inside the pill (option K2) makes the
 * person part of the chrome. So the face is its own element and the pill's LEFT
 * end is cut flat and slid underneath it, which hides the seam between the two
 * shapes behind the circle rather than leaving it beside them.
 *
 * ★★ THE 16px OVERLAP IS ARITHMETIC, NOT TASTE, and the spec shows its working:
 * a 38px pill against a 40px circle needs at least
 *     r - sqrt(r^2 - (h/2)^2) = 20 - sqrt(400 - 361) ≈ 13.75px
 * of overlap before the pill's square corner is inside the curve. Less than that
 * and the corner poked out past the circle and the seam was visible again. 16px
 * leaves 2.2px of margin. DO NOT reduce it without redoing that sum against the
 * face and pill sizes actually shipped.
 *
 * ★★★ THE PILL IS TWO CLICK TARGETS, NOT ONE. The spec is explicit: left half
 * (the handle) goes to the creator's profile, right half (price + Buy) opens
 * their Meritum market, each with its own `aria-label`, and hovering one half
 * must not light the other — "hovering the price/Buy side should never suggest
 * the whole pill navigates to one place".
 *
 * ★★ THE FACE IS NOT A THIRD TAB STOP, which is the open question the spec
 * asked engineering to settle. The face and the handle go to the SAME place, so
 * offering both to the keyboard means tabbing twice to reach one destination and
 * hearing the account name read out twice. The face is therefore decorative —
 * `aria-hidden` and out of the tab order — and the handle beside it is the one
 * focusable link to the profile. It is still a real `<a>` so a pointer user can
 * click the picture, which is the behaviour people expect from an avatar; it
 * simply is not announced or focused separately.
 *
 * ★ NO MARKET, NO RIGHT HALF. Almost every author has no creator token, and a
 * Buy button for a token that cannot be bought is a dead control. Those authors
 * get a handle-only pill: one target, both ends rounded, no seam. Confirmed with
 * the owner of the creator-tokens subsystem before building.
 *
 * ★ THIS REPLACES `TokenAuthorChip` IN THIS BYLINE rather than sitting beside
 * it. That chip renders `null` when there is no market, so running both would
 * put two handle treatments on the same row for creators and one for everyone
 * else — and, worse, two components each deciding "does this author have a
 * token". One answer, one place.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface IdentityPillProps {
  /** The name a reader sees, and the profile route. */
  handle: string;
  /**
   * This author's market, read ONCE FOR THE WHOLE PAGE by the list that mounts
   * these cards — never here.
   *
   * ★★★ WHY THIS IS A PROP AND NOT A HOOK CALL. The price comes from
   * `useTokenPriceChips(handles)`, which asks the chain for every author on the
   * page in ONE request (3 state keys per creator, chunked at 33 creators
   * internally). A pill that fetched its own price would turn that back into one
   * request per card — the exact N+1 this feature already paid for once, measured
   * at 5+ concurrent GraphQL posts of 4.2-4.5s each on a single feed load, every
   * one returning "no market" (2026-08-11, owner: "the page takes 30 seconds to
   * load"). Threading it matches how `mark` already reaches this card from
   * `useRankMarks`.
   *
   * `undefined` means the caller has not wired the lookup yet, and renders the
   * same as `none`.
   */
  price?: MarketPrice;
  /**
   * This author's rank luminosity, 0.06 (rank 1) to 1 (rank 9), from §2's ramp.
   * Undefined for an unranked author, which renders unlit. Read once per page by
   * the list that mounts these cards — see `useRankLuminosity`.
   */
  luminosity?: number;
}

export default function IdentityPill({ handle, price, luminosity }: IdentityPillProps) {
  /*
   * ★★ THREE STATES, AND `unknown` IS NOT `none`. `ready` means there is a market
   * and a figure. `none` means this author has no token. `unknown` means the read
   * FAILED — and it must not render as "no token", because that would quietly
   * demote a real creator to a plain handle whenever the chain hiccuped, with
   * nothing on screen to say the answer was missing rather than negative.
   *
   * Both non-ready states collapse to the handle-only pill visually, which is the
   * honest rendering: we do not claim a market we cannot confirm. What differs is
   * that `unknown` is a transient we expect to resolve, so nothing here caches or
   * remembers it.
   *
   * ★ THE FIGURE IS WHAT A BUY WOULD CHARGE — `Area(S+1) - Area(S)` off the bonding
   * curve — NOT the market's `face`, which is the service ask price. They differ
   * per market and are easy to confuse: lumen.aria and lumen.cole carry different
   * `face` (25000 vs 30000) and the identical token price. Nothing here derives
   * it; `usdPrice` only formats what the data source resolved.
   */
  const priceLabel =
    price && price.status === 'ready' && price.priceUsd !== null ? usdPrice(price.priceUsd) : null;
  /*
   * ★★ THE BUY SLOT IS NOT HARD-WIRED TO "Buy" ANY MORE (2026-08-30, B4). This
   * pill drew "$1.41 · Buy" on every card for a FROZEN, retired or delinquent
   * market, because `readMarketPrices` priced a market without ever reading
   * its phase. It now carries `health` (market/market-health.ts, the token
   * page's own canBuy + wind-down rules as one word), and the slot draws the
   * STATE when the market cannot take money: Lapsed / Closed / Paused. Same
   * width, same place, no sentence — a reader scanning a feed sees the
   * difference without stopping. `health` is null only when `status` is not
   * 'ready', so a ready price without a word cannot happen; the guard is
   * there so the type says so too.
   */
  const buyWord = price && price.status === 'ready' && price.health !== null ? buyWordFor(price.health) : null;

  const profileHref = `/@${handle}`;
  const hasMarket = priceLabel !== null && buyWord !== null;

  /*
   * ★★ THE FACE AND THE HANDLE WARM THE PROFILE THEY BOTH POINT AT (2026-09-05,
   * snappiness phase 4b). This is the click the owner measured as the slow one:
   * a byline in the feed goes to a page whose server render is an account read
   * plus that account's first page of posts, and a client-side navigation pays
   * every millisecond of it AFTER the press with nothing moving on screen. A
   * pointer resting 80 ms on either half of this cluster prefetches that route
   * in full, so the press lands on a page already in the router cache.
   *
   * ONE hook for both links, because they are one destination: the module-level
   * once-a-minute guard in `intent-prefetch.tsx` is keyed by href, so sliding off
   * the picture and onto the name (they overlap by 16 px) re-arms the timer but
   * cannot fire a second render. The market half is NOT wired: `/creators/…` is
   * a different, cheaper page and no one asked for it — a prefetch there would be
   * cost with no measured complaint behind it.
   */
  const profileIntent = useIntentPrefetch(profileHref);

  return (
    <span className={styles.idCluster} data-testid="identity-pill">
      {/* The face. Decorative to assistive tech (see the tab-stop note above) —
          the handle link immediately after it carries the accessible name. */}
      {/* ★ THE GLOW GOES ON THE FACE (§2). `--l` is set inline because it is
          per-author data, not a style; the CSS defaults it to 0 so an unranked
          author is unlit rather than invalid. Decorative: no aria, no title. */}
      <Link
        href={profileHref}
        className={styles.idFace}
        style={luminosity ? ({ '--l': luminosity } as React.CSSProperties) : undefined}
        tabIndex={-1}
        aria-hidden="true"
        {...profileIntent}
      >
        <UserAvatarImg username={handle} pixelSize={40} alt="" />
      </Link>

      <span className={cn(styles.idPill, hasMarket && styles.idPillSplit)}>
        <Link
          href={profileHref}
          className={styles.idHandle}
          aria-label={`Profile of ${handle}`}
          data-testid="identity-pill-profile"
          {...profileIntent}
        >
          @{handle}
        </Link>

        {hasMarket ? (
          <>
            <span className={styles.idSeam} aria-hidden="true" />
            <Link
              href={`/creators/${routeHandle(handle)}`}
              className={styles.idMarket}
              aria-label={`Meritum market for ${handle}`}
              data-testid="identity-pill-market"
            >
              {/* The glyph is brand-coloured and the figure is not, so the number
                  stays the thing you read. `tabular-nums` because a price that
                  ticks must not resize the pill it sits in. */}
              <span className={styles.idPriceGlyph} aria-hidden="true">
                ◈
              </span>
              <span className={styles.idPriceFigure}>{priceLabel}</span>
              <span className={styles.idBuy}>{buyWord}</span>
            </Link>
          </>
        ) : null}
      </span>
    </span>
  );
}
