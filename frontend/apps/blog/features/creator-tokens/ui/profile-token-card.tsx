'use client';

import { FC } from 'react';
import { Link } from '@hive/ui';
import { useLiveTokenMarket } from '../live/use-live-token-market';
import { usdPrice } from '../market/format';

// TODO i18n — staged copy, same precedent as the rest of this feature.
const COPY = {
  eyebrow: 'Creator token',
  currentPrice: 'current price',
  completionRate: 'Completion rate',
  medianReply: 'Median reply',
  buy: 'Buy',
  launchTitle: 'No creator token yet',
  launchBody: 'Let people hold your token and pay you for your time.',
  launchCta: 'Launch your token'
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
  const { status, market } = useLiveTokenMarket(username);

  if (status === 'ready' && market) {
    const d = market.delivery;
    return (
      <div
        className="mt-4 flex flex-wrap items-start justify-between gap-6 rounded-[18px] border border-[#EFE7DE] bg-[#FBF7F2] px-6 py-[22px]"
        data-testid="profile-token-card"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-[9px]">
            <span aria-hidden="true" className="text-[13px] leading-none text-[#c0392b]">
              ◈
            </span>
            <span className="font-sans text-[11.5px] font-bold uppercase tracking-[0.14em] text-[#c0392b]">
              {COPY.eyebrow}
            </span>
            <span className="font-sans text-[13px] font-semibold text-[#8a827a]">@{username}</span>
          </div>
          <div className="mt-[11px] flex flex-wrap items-baseline gap-3.5">
            <span className="font-sans text-[34px] font-bold tabular-nums tracking-[-0.02em] text-[#161511]">
              {usdPrice(market.priceUsd)}
            </span>
            <span className="font-sans text-[13.5px] font-medium text-[#8a827a]">{COPY.currentPrice}</span>
          </div>
          {/* Completion rate / median reply — indexer-backed (live/adapt.ts's
              adaptDelivery). Omitted entirely rather than shown as "unavailable"
              dashes: this compact card has no room for an explanatory fallback,
              and price + Buy on their own are still a complete, honest card. */}
          {d.available ? (
            <div className="mt-4 flex flex-wrap gap-[26px]">
              <div className="flex flex-col gap-0.5">
                <span className="font-sans text-[17px] font-bold tabular-nums text-[#161511]">{d.completionPct}%</span>
                <span className="text-[12.5px] text-[#8a827a]">{COPY.completionRate}</span>
              </div>
              {d.typicalResponse ? (
                <div className="flex flex-col gap-0.5">
                  <span className="font-sans text-[17px] font-bold tabular-nums text-[#161511]">{d.typicalResponse}</span>
                  <span className="text-[12.5px] text-[#8a827a]">{COPY.medianReply}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <Link
          href={`/creators/${username}?a=buy`}
          className="shrink-0 rounded-xl bg-[#c0392b] px-7 py-3 font-sans text-[14.5px] font-bold text-white transition-colors hover:bg-[#a5301f]"
          data-testid="profile-token-buy"
        >
          {COPY.buy}
        </Link>
      </div>
    );
  }

  if (status === 'missing' && isOwnProfile) {
    return (
      <div
        className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-[18px] border border-[#EFE7DE] bg-[#FBF7F2] px-6 py-5"
        data-testid="profile-token-card-launch"
      >
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="text-[15px] leading-none text-[#c0392b]">
            ◈
          </span>
          <div>
            <div className="font-sans text-[14.5px] font-bold text-[#161511]">{COPY.launchTitle}</div>
            <p className="mt-0.5 font-sans text-[13px] text-[#8a827a]">{COPY.launchBody}</p>
          </div>
        </div>
        <Link
          href="/creators/launch"
          className="shrink-0 rounded-xl bg-[#c0392b] px-6 py-2.5 font-sans text-[13.5px] font-bold text-white transition-colors hover:bg-[#a5301f]"
        >
          {COPY.launchCta}
        </Link>
      </div>
    );
  }

  return null;
};

export default ProfileTokenCard;
