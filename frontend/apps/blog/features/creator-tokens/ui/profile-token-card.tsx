'use client';

import { FC } from 'react';
import { Link } from '@hive/ui';
import MessageButton from '@/blog/features/direct-messages/ui/message-button';
import { useLiveTokenMarket } from '../live/use-live-token-market';
import { useTokenAccounts } from '../live/use-token-accounts';
import { pctLabel, usdPrice } from '../market/format';
import { SOLD_OUT_WORD, marketHealthOf, soldOutOf } from '../market/market-health';

// TODO i18n — staged copy, same precedent as the rest of this feature.
const COPY = {
  eyebrow: 'Meritum',
  currentPrice: 'current price',
  completionRate: 'Completion rate',
  medianReply: 'Median reply',
  buy: 'Buy',
  /**
   * ★ THE CARD HAD NO PHASE CHECK AT ALL (2026-08-30, B4): price + Buy on a
   * FROZEN, retired or delinquent market, identical to a healthy one, and the
   * only warning in the product was on the token page this card sits in
   * front of. One line per state, worded to make NO money claim: what a
   * wind-down pays out is the open A1 contract question, so these say only
   * what the contract does to BUYING today. The lapsed line keeps Buy, as the
   * token page does under its banner (the contract accepts the buy); the
   * other two drop it, as the token page disables it.
   */
  lapsed: 'This creator’s listing has lapsed. If it isn’t renewed, the market freezes and buying closes.',
  // ★ v1 gate (2026-08-31, cross-review): under v1 a lapse winds the market DOWN
  // — the whole curve closes, not only buying — so the buying-only line above
  // would let a v1 holder believe their sell survives. marketHealthOf returns
  // 'lapsed' under BOTH rulesets (OVERDUE is the grace state in each), so it needs
  // the gate. Still no money-amount claim, matching this block's design.
  lapsedWindDown: 'This creator’s listing has lapsed. If it isn’t renewed, the market winds down and the whole curve closes.',
  // Reader-facing only (2026-08-31, A5): the fact, and no claim about anyone's
  // money. What the creator can do about it is market/lapse.ts's sentence, on
  // the creator's own surfaces. Reachable only under the v2 contract rules.
  delisted: 'This creator’s listing has lapsed and the market is delisted. Buying is closed until the creator relists it.',
  closed: 'This market is winding down. Buying is closed.',
  pausedDelinquent: 'This creator has left too many paid asks unanswered, so buying is paused for now.',
  paused: 'Buying is paused for now.',
  launchTitle: 'No Meritum yet',
  launchBody: 'Let people hold your token and pay you for your time.',
  // Unified 2026-08-23 with header-token-pill and the studio h1 — see that file's note.
  launchCta: 'Launch your Meritum'
};

/**
 * The profile page's creator-token surface (design brief §3). Sits between
 * the stats row and the league/rank card (features/account-profile/redesign
 * /profile-main.tsx) — replaces the old tertiary "View creator token" ghost
 * button that used to live in profile-stats-bar.tsx (see that file's own
 * note on the removal).
 *
 * Deliberately reuses useLiveTokenMarket — the SAME hook the token page
 * itself runs — rather than a bespoke read: a profile page renders at most
 * one of these, so the heavier hook (position/offerings/delivery/history) is
 * cheap here, and a reader who came from a feed chip or is about to click
 * through to the full token page gets a warm cache either direction.
 *
 * ★ "Holders" from the mockup is NOT rendered. No read anywhere in this
 * feature's data layer (types.ts, adapt.ts, hasura.ts) produces a holder
 * COUNT — only a wallet holds -> creators reverse index for one holder at a
 * time (readWallet), which cannot answer "how many holders does @x have"
 * without enumerating every account on the network. Completion rate and
 * median reply are the two the brief calls "the trust signals — keep both",
 * and both are real reads (market.delivery); Holders is invented in every
 * mockup and is omitted here rather than shipped as a placeholder number.
 *
 * THREE RENDER STATES, and no fourth:
 *  - The profile HAS a token (any viewer): price + (when the indexer answered)
 *    the two trust stats + one Buy button, all live.
 *  - This is the SIGNED-IN VIEWER'S OWN profile, confirmed no token: a small
 *    prompt to launch one. No price, no stats — there is nothing to show yet,
 *    and this is not the same card wearing a different label.
 *  - Anything else (someone else's profile with no token, still loading, the
 *    read failed, or the feature isn't provisioned): nothing. A stranger's
 *    profile is not the place to pitch a token that does not exist, and a
 *    profile page is not the place for a half-drawn widget about a read that
 *    has not resolved.
 */
const ProfileTokenCard: FC<{ username: string; isOwnProfile: boolean }> = ({ username, isOwnProfile }) => {
  const byName = useLiveTokenMarket(username);

  /**
   * ★ A WALLET CREATOR'S OWN TOKEN WAS INVISIBLE TO THEM (found 2026-08-21 by an
   * agent signing in as a wallet that owns a live, tradeable market).
   *
   * The market is keyed by the identity that REGISTERED it. For a Hive user that
   * is `hive:<username>`, so looking it up by the profile handle works. For a
   * wallet-backed account it is a `did:pkh:…`, and `toDid` (lib/vsc/reads.ts:32)
   * turns a bare handle into `hive:<handle>` — a key that market was never
   * stored under. The read came back 'missing', and 'missing' on your own
   * profile renders "No Meritum yet. Launch your token." So a creator whose
   * token strangers could buy that very moment was invited to create it.
   *
   * Same identity drift as `use-live-token-market.ts:162`, which already derives
   * its position account as `isLite ? signingAccount?.id : viewer` for exactly
   * this reason. Reads and writes must name the identity with the SAME string.
   *
   * Only the viewer's OWN profile can be repaired here, because only the viewer's
   * own wallet ids are in the client. A VISITOR to a wallet creator's
   * `/@handle` page still sees nothing, since resolving someone else's handle to
   * their did needs a server-side index that does not exist yet. That gap is
   * real and is deliberately left visible rather than half-closed.
   */
  const accounts = useTokenAccounts();
  const ownWalletDid = isOwnProfile ? (accounts.accounts.find((a) => a.kind !== 'hive')?.id ?? null) : null;
  // Empty string disables the query (use-live-token-market gates on Boolean(creator)),
  // so this costs nothing for a Hive user or a visitor.
  const byDid = useLiveTokenMarket(ownWalletDid ?? '');

  // ★ FALL BACK ONLY ON AN ACTUAL HIT, never merely because the first read was
  // not ready. `byDid` is DISABLED when there is no wallet did to try (a Hive
  // user, or anyone else's profile), and a disabled query does not report
  // 'missing' — so handing its status through unconditionally would have
  // suppressed the "Launch your token" prompt for every Hive creator who has
  // not launched one. `byName` stays the source of the not-found state.
  const resolved =
    byName.status === 'ready' && byName.market
      ? byName
      : ownWalletDid && byDid.status === 'ready' && byDid.market
        ? byDid
        : byName;
  const { status, market } = resolved;
  // When the market resolved via the wallet-DID fallback it lives under the DID,
  // so a link must target /creators/<did>; the bare username resolves 'missing'
  // and the Buy button would land on "this creator has no market". Read and
  // write name the identity with the SAME string.
  const resolvedHandle = resolved === byDid && ownWalletDid ? ownWalletDid : username;

  if (status === 'ready' && market) {
    const d = market.delivery;
    // The token page's own rules as one word (market/market-health.ts);
    // LiveTokenMarket already carries the three inputs.
    const health = marketHealthOf(market);
    const healthLine =
      health === 'lapsed'
        ? (market.rules === 'v2' ? COPY.lapsed : COPY.lapsedWindDown)
        : health === 'delisted'
          ? COPY.delisted
        : health === 'closed'
          ? COPY.closed
          : health === 'paused'
            ? market.delinquentUntilBlock !== null
              ? COPY.pausedDelinquent
              : COPY.paused
            : null;
    // Not a health and not a warning (owner, 2026-08-30; market-health.ts
    // soldOutOf): a paid-up creator whose legacy cap is full. It only decides
    // what sits in the Buy slot.
    const soldOut = soldOutOf(market);
    return (
      <div
        className="mt-4 flex flex-wrap items-start justify-between gap-6 rounded-panel border border-line-warn-1 bg-surface-warn-2 px-6 py-[22px]"
        data-testid="profile-token-card"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-[9px]">
            <span aria-hidden="true" className="text-caption leading-none text-ink-brand-6">
              ◈
            </span>
            <span className="font-ui text-label font-medium uppercase tracking-label text-ink-brand-6">
              {COPY.eyebrow}
            </span>
            <span className="font-ui text-caption font-medium text-ink-12">@{username}</span>
          </div>
          <div className="mt-[11px] flex flex-wrap items-baseline gap-3.5">
            <span className="text-[34px] leading-[52px] tabular-nums tracking-[-0.02em] text-ink-2 font-num">
              {usdPrice(market.priceUsd)}
            </span>
            <span className="font-ui text-[14px] leading-[22px] font-medium text-ink-12">{COPY.currentPrice}</span>
          </div>
          {/* Completion rate / median reply — indexer-backed (live/adapt.ts's
              adaptDelivery). Omitted entirely rather than shown as "unavailable"
              dashes: this compact card has no room for an explanatory fallback,
              and price + Buy on their own are still a complete, honest card. */}
          {d.available ? (
            <div className="mt-4 flex flex-wrap gap-[26px]">
              {/* Omitted, not shown as "0%", when there is no record yet — this
                  card has no room to explain, and an unexplained 0% is read as a
                  failure to deliver. Same rule as `typicalResponse` below. */}
              {d.completionPct !== null ? (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[17px] leading-[26px] tabular-nums text-ink-2 font-num">{pctLabel(d.answered, d.total) ?? '0%'}</span>
                  <span className="text-caption text-ink-12 font-ui">{COPY.completionRate}</span>
                </div>
              ) : null}
              {d.typicalResponse ? (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[17px] leading-[26px] tabular-nums text-ink-2 font-num">{d.typicalResponse}</span>
                  <span className="text-caption text-ink-12 font-ui">{COPY.medianReply}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          {healthLine ? (
            <p
              className="mt-3 max-w-[52ch] font-ui text-caption font-medium text-ink-warn-3"
              data-testid="profile-token-health"
            >
              {healthLine}
            </p>
          ) : null}
        </div>
        {/* Message + Buy sit together on the right. Message is offered on any
            launched creator's card EXCEPT the viewer's own (you cannot DM
            yourself); Buy carries the same gates as before. Both can be
            present, one, or (own profile with buying closed) neither. */}
        <div className="flex shrink-0 items-center gap-3">
          {/* Buy has no self-gate, but DM does: a creator viewing their own card
              gets no Message button (the compose target would be themselves). */}
          {!isOwnProfile ? <MessageButton handle={username} /> : null}
          {/* Buy only when buy.go would take it (`canBuy` is RequireInflowOpen,
              the same gate the token page disables its own button on). A lapsed
              market keeps it, under the line above. */}
          {market.canBuy && !soldOut ? (
            <Link
              href={`/creators/${resolvedHandle}?a=buy`}
              className="shrink-0 rounded-xl bg-surface-brand-12 px-7 py-3 font-ui text-[15px] leading-[24px] font-medium text-ink-27 transition-colors hover:bg-surface-brand-16"
              data-testid="profile-token-buy"
            >
              {COPY.buy}
            </Link>
          ) : market.canBuy && soldOut ? (
            // The token page's own disabled-button word, in the Buy slot, with no
            // warning styling: every buy would revert (buy.go refuses past the
            // cap), so the control is not offered, and nothing is said about the
            // creator, who is fine.
            <span
              className="shrink-0 rounded-xl bg-surface-brand-12 px-7 py-3 font-ui text-[15px] leading-[24px] font-medium text-ink-27 opacity-50"
              aria-disabled="true"
              data-testid="profile-token-sold-out"
            >
              {SOLD_OUT_WORD}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (status === 'missing' && isOwnProfile) {
    return (
      <div
        className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-panel border border-line-warn-1 bg-surface-warn-2 px-6 py-5"
        data-testid="profile-token-card-launch"
      >
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="text-[15px] leading-[24px] leading-none text-ink-brand-6">
            ◈
          </span>
          <div>
            <div className="font-ui text-[15px] leading-[24px] font-medium text-ink-2">{COPY.launchTitle}</div>
            <p className="mt-0.5 font-ui text-caption text-ink-12">{COPY.launchBody}</p>
          </div>
        </div>
        <Link
          href="/creators/launch"
          className="shrink-0 rounded-xl bg-surface-brand-12 px-6 py-2.5 font-ui text-[14px] leading-[22px] font-medium text-ink-27 transition-colors hover:bg-surface-brand-16"
        >
          {COPY.launchCta}
        </Link>
      </div>
    );
  }

  return null;
};

export default ProfileTokenCard;
