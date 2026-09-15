'use client';

import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Link } from '@hive/ui';
import { UserAvatarImg } from '@ui/components';
import MessageButton from '@/blog/features/direct-messages/ui/message-button';
import type { Service } from '../../market/token-detail';
import { buyQuote, serviceQuote } from '../../market/curve';
import { displayHandle } from '../../live/adapt';
import { useLiveTokenMarket } from '../../live/use-live-token-market';
import { useCreatorPublicStats } from '../../live/use-creator-public-stats';
import { MarketLoading, MarketMissing, MarketRateLimited, MarketReadFailed, MarketUnavailable } from '../../live/market-states';
import { pctLabel, ratingStars, usdMoney, usdPrice, usdWholeNonZero } from '../../market/format';
import { healthWordFor, marketHealthOf } from '../../market/market-health';
import { buyerOracleNotice } from '../../market/oracle-copy';
import { HOW_IT_WORKS_RESERVE_LINE, MARKET_CAP_LABEL, MARKET_CAP_NOTE, WIND_DOWN_BANNER, honestNote } from '../token-page/disclosure-copy';
import { MeritumEligibilityNotice, useMeritumEligibility } from '../meritum-eligibility';
import TokenModals, { type TokenDialog } from '../token-page/token-modals';
import { askReference, interstitialKey } from '../token-page/token-page-helpers';
import CreatorTokenLaurel from '../creator-token-laurel';
import TokenShell from '../token-shell';
import CurvePanel from './curve-panel';
import ShareSheet from './share-sheet';
import { MERITUM_PAGE_COPY as COPY } from './meritum-copy';
import { creatorPagePath, loginThenReturnTo, routeHandleOf, type CreatorPageAction } from '@/blog/lib/meritum/creator-handle';
import { holdersHeadline, monthLabel, shapeHolders } from '@/blog/lib/meritum/holders';
import type { CreatorProfileFields } from '@/blog/lib/meritum/profile-fields';

/**
 * ★★★ THE MERITUM CREATOR PAGE — `/m/<handle>` (owner, 2026-09-15, from the
 * "Creator Landing" handoff). One public page per creator: who they are (the
 * Hive profile, verbatim), the price at the curve's price, what you can buy
 * from them, their delivery record, who holds the token, and one way to
 * share it all.
 *
 * WHAT IT REUSES, DELIBERATELY. Every read and every write goes through the
 * hooks and modals the token page already proved on mainnet:
 * `useLiveTokenMarket` (price, chart, delivery, asks, position, the gates),
 * `TokenModals` (Buy / Sell / Redeem / Ask / Send / the risk interstitial /
 * DM), `disclosure-copy.ts` (every sentence that makes a money claim, and the
 * right-rail cards — owner: "the text on right side navbar is kept"). This
 * file is the layout and the page's own rules; it invents no number.
 *
 * ★ FONTS FOLLOW THE SITE, NOT THE HANDOFF (owner: "make sure you follow our
 * font convention"): Merriweather (`font-ui`) for headings, labels and
 * buttons; Fira (`font-num`) for every number; Lora (`font-lora`) for the
 * one piece of prose on the page, the creator's own `about`.
 *
 * ★ SIGNED OUT, PRECISELY (handoff §5). Everything is readable. Buy, Sell and
 * Request are enabled and, when pressed, send the reader to `/login` with
 * `next=` pointing back at THIS page with the action in the query
 * (`?a=buy`, `?a=spend&o=<id>`), which the effect below turns back into the
 * open dialog — the reader resumes what they asked for, not the top of the
 * page. Share needs no session at all. A signed-in reader whose account
 * cannot sign (a keyless lite account) sees the eligibility notice instead,
 * exactly as the token page shows it.
 *
 * ★ NEVER PAYOUT GREEN on the price or the change (handoff §7); the delivery
 * record's completion strip keeps the token page's own colours.
 *
 * ★ DROP, DON'T ZERO. A stat that is unknown (holders during an indexer
 * outage, a first-trade date on an untraded market) is not rendered; the
 * holders section is not rendered when nobody holds; the asks section is not
 * rendered when there are none; the about line is not rendered when the
 * account has none. No placeholder copy anywhere.
 */

const HOW_THIS_WORKS_LINES: readonly string[] = [
  'Buy the creator’s token. The price rises as more is bought.',
  'Spend tokens on their work. A question, a code review, a day of building, priced in dollars.',
  HOW_IT_WORKS_RESERVE_LINE
];

const CANNOT_SIGN =
  'This account has no key that can sign a transaction yet. Connect an Ethereum wallet, or upgrade to a full Hive account, to trade.';

const tok = (n: number) => n.toFixed(2);

/** Service.key IS the on-chain offeringId ('0' = the creator's face price); anything else has no id to deep-link. */
function offeringIdOf(sv: Service): number | undefined {
  return /^\d+$/.test(sv.key) ? Number(sv.key) : undefined;
}

const MeritumLanding: FC<{ handle: string; profile: CreatorProfileFields; shareUrl: string }> = ({ handle, profile, shareUrl }) => {
  const live = useLiveTokenMarket(handle);
  const { market, status } = live;
  const { stats } = useCreatorPublicStats(handle);
  const eligibility = useMeritumEligibility();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [dialog, setDialog] = useState<TokenDialog>(null);
  const [service, setService] = useState<Service | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const pendingAction = useRef<TokenDialog>(null);
  // ★ A DEEP LINK OPENS ITS DIALOG ONCE (review, 2026-09-15). The effect below
  // depends on `loggedIn` and `writesBlocked`, both of which settle after
  // mount; without this, closing the dialog and having one of them flip
  // re-opened it. Keyed on the query string so a NEW deep link still works.
  const consumedDeepLink = useRef<string | null>(null);
  const hasMarket = market !== null;
  const shown = displayHandle(handle);
  const routeHandle = routeHandleOf(handle);

  // ONE reason, shared by every write entry point (the token page's rule).
  // Signed out is NOT a blocked write here: the button is enabled and prompts
  // to log in (handoff §5). Only a signed-in account that cannot sign is blocked.
  const writeBlockedReason: string | null = live.loggedIn && !live.canTrade ? CANNOT_SIGN : null;
  const writesBlocked = writeBlockedReason !== null;
  const soldOut = market !== null && market.supply >= market.cap;
  const isOwner = live.signingIdentity === handle;

  /** Signed out: go log in and come back to this exact action. Returns whether the action may proceed now. */
  const requireSession = (action: CreatorPageAction, offeringId?: number): boolean => {
    if (live.loggedIn) return true;
    router.push(loginThenReturnTo(creatorPagePath(handle, action, offeringId)));
    return false;
  };

  const openBuy = () => {
    if (!requireSession('buy') || writesBlocked || !market || !market.canBuy || soldOut) return;
    setDialog('buy');
  };
  const openSell = () => {
    if (!requireSession(market?.windingDown ? 'redeem' : 'sell') || writesBlocked || !market) return;
    setDialog(market.windingDown ? 'redeem' : 'sell');
  };
  const openAsk = (sv: Service) => {
    if (!requireSession('spend', offeringIdOf(sv)) || writesBlocked) return;
    setService(sv);
    setDialog('ask');
  };

  // ★ THE WAY BACK FROM LOGIN, AND EVERY OTHER DEEP LINK (`?a=`). Honours the
  // SAME gates as the buttons (the token page's rule: a deep link must not
  // open a flow the button would refuse). `share` and `dm` need no key.
  useEffect(() => {
    if (!market) return;
    const a = searchParams?.get('a');
    if (!a) return;
    const key = searchParams?.toString() ?? '';
    if (consumedDeepLink.current === key) return;
    const consume = () => {
      consumedDeepLink.current = key;
    };
    if (a === 'share') {
      consume();
      setShareOpen(true);
      return;
    }
    if (a === 'dm') {
      consume();
      setDialog('dm');
      return;
    }
    // Not consumed yet: the reader may sign in and come back through this same URL.
    if (!live.loggedIn || writesBlocked) return;
    if (a === 'buy') {
      consume();
      if (market.canBuy && !soldOut) setDialog('buy');
    } else if (a === 'sell' || a === 'redeem') {
      consume();
      setDialog(market.windingDown ? 'redeem' : 'sell');
    } else if (a === 'send') {
      consume();
      setDialog('send');
    } else if (a === 'spend' && market.canAsk) {
      consume();
      // ★ NO SUBSTITUTION (review, 2026-09-15): an `o` that names no offering
      // opens nothing, rather than the first offering under a different name.
      const wanted = searchParams?.get('o');
      const sv = wanted ? market.services.find((s) => s.key === wanted) : market.services[0];
      if (sv) {
        setService(sv);
        setDialog('ask');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, hasMarket, writesBlocked, live.loggedIn]);

  // The risk interstitial — first view per creator, per viewer, per session —
  // only for someone who can actually act, and without losing what a deep link
  // just opened (see the token page for the history of both rules).
  useEffect(() => {
    if (typeof window === 'undefined' || !market || !live.loggedIn || writesBlocked) return;
    const key = interstitialKey(handle, live.viewer);
    let seen = false;
    try {
      seen = Boolean(window.sessionStorage.getItem(key));
    } catch {
      seen = false;
    }
    if (!seen) {
      setDialog((current) => {
        if (current && current !== 'inter') pendingAction.current = current;
        return 'inter';
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, hasMarket, writesBlocked, live.viewer, live.loggedIn]);

  const holders = useMemo(() => (stats && stats.source === 'indexer' ? shapeHolders(stats.holders, stats.holderCount) : null), [stats]);
  const firstTrade = stats && stats.source === 'indexer' ? monthLabel(stats.firstTradeTs) : null;

  if (status === 'unavailable') return <MarketUnavailable />;
  if (status === 'loading') return <MarketLoading />;
  if (status === 'missing') return <MarketMissing handle={handle} isOwner={isOwner} />;
  if (status === 'rate-limited') return <MarketRateLimited />;
  if (status === 'error' || !market) return <MarketReadFailed onRetry={live.retry} />;

  const d = market.delivery;
  const health = marketHealthOf({ phase: market.phase, canBuy: market.canBuy, windingDown: market.windingDown });
  const oracleOff = Boolean(live.servicesOracleStatus && live.servicesOracleStatus !== 'ok');
  const cardSrc = `/api/og/meritum?u=${encodeURIComponent(handle)}&v=${Math.round(Math.max(0, market.priceUsd) * 100)}`;
  const blockedNotice = writeBlockedReason ? <MeritumEligibilityNotice surface="trade" who={eligibility} inline /> : null;

  const stat = (label: string, value: string, testId: string) => (
    <div className="bg-surface-1 px-[18px] py-4" data-testid={testId}>
      <div className="font-ui text-[11px] font-bold uppercase tracking-[0.13em] text-ink-14">{label}</div>
      <div className="mt-1.5 text-[22px] leading-[28px] font-semibold text-ink-2 font-num">{value}</div>
    </div>
  );
  const stats5 = [
    stat(COPY.stats.price, usdPrice(market.priceUsd), 'meritum-stat-price'),
    stat(COPY.stats.marketCap, usdWholeNonZero(market.marketCapUsd), 'meritum-stat-cap'),
    stat(COPY.stats.issued, market.supply.toLocaleString('en-US'), 'meritum-stat-issued'),
    holders ? stat(COPY.stats.holders, holders.count.toLocaleString('en-US'), 'meritum-stat-holders') : null,
    firstTrade ? stat(COPY.stats.firstTrade, firstTrade, 'meritum-stat-first-trade') : null
  ].filter(Boolean);

  const shareButton = (className: string, testId: string) => (
    <button type="button" onClick={() => setShareOpen(true)} className={className} data-testid={testId}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M6.4 7.6 12 1.4l5.6 6.2h-3.9v7.8h-3.4V7.6Z" />
        <path d="M3.4 12.6h3.4v6.2h10.4v-6.2h3.4v9.6H3.4Z" />
      </svg>
      {COPY.share}
    </button>
  );

  const handleBuy = async (usd: number, maxTotalUsd?: number): Promise<void> => {
    const local = buyQuote(usd, market);
    if (local.tokens <= 0) throw new Error('That budget does not cover a whole token at the current price.');
    const authoritative = await live.quoteBuy(local.tokens);
    const cap = maxTotalUsd ?? usd;
    if (authoritative.totalDueHbd > cap) throw new Error('The price moved above your limit.');
    await live.buy(local.tokens, cap);
  };
  const handleSell = async (tokens: number, minNetUsd?: number): Promise<void> => {
    await live.quoteSell(tokens);
    await live.sell(tokens, minNetUsd);
  };
  const handleRedeem = async (tokens: number, minNetUsd?: number): Promise<void> => {
    await live.refund(tokens, minNetUsd);
  };

  // The handoff's pills: 52px tall, brand with a warm shadow for Buy, ghost for the rest.
  const pill = 'inline-flex h-[52px] items-center gap-2.5 rounded-full px-7 font-ui text-[16px] leading-none font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const ghost = `${pill} border border-ink-2/20 bg-surface-1/70 text-ink-2 hover:border-ink-2 hover:bg-surface-1`;
  const card = 'rounded-[14px] border border-line-9 bg-surface-1';

  // ★ THE RAIL CARDS, text verbatim from disclosure-copy (owner: "the text on
  // right side navbar is kept"). Shown in the shell's right rail from `xl` up
  // and inline below the body under that width, exactly as the token page
  // does, so the figure appears once at every width.
  const howThisWorks = (
    <div className={`${card} p-[22px]`}>
      <h3 className="font-ui text-[16px] font-bold text-ink-2">How this works</h3>
      <div className="mt-3.5 flex flex-col gap-3.5">
        {HOW_THIS_WORKS_LINES.map((line, i) => (
          <div key={i} className="flex gap-[11px]">
            <span className="w-5 shrink-0 text-[13px] font-bold text-ink-brand-6 font-num">{i + 1}</span>
            <p className="font-ui text-[13.5px] leading-[1.58] text-ink-4">{line}</p>
          </div>
        ))}
      </div>
    </div>
  );
  const marketCapCard = (
    <div className={`${card} p-[22px]`}>
      <h3 className="font-ui text-[13px] font-bold uppercase tracking-[0.1em] text-ink-14">{MARKET_CAP_LABEL}</h3>
      <div className="mt-2 text-[30px] leading-[36px] tracking-[-0.02em] text-ink-2 font-num">{usdWholeNonZero(market.marketCapUsd)}</div>
      <p className="mt-2.5 font-ui text-[13.5px] leading-[1.58] text-ink-4">{MARKET_CAP_NOTE}</p>
      {shareButton(
        'mt-[18px] flex h-[42px] w-full items-center justify-center gap-2 rounded-full border border-ink-2/20 bg-surface-1 font-ui text-[14.5px] font-medium text-ink-2 hover:border-ink-2 hover:bg-surface-11',
        'meritum-share-rail'
      )}
    </div>
  );
  const rightRail = (
    <div className="flex flex-col gap-[18px] pt-[26px]">
      {howThisWorks}
      {marketCapCard}
    </div>
  );

  return (
    // ★ INSIDE THE APP'S SHELL — both rails (owner, 2026-09-15: "you cut the
    // whole left navbar... put it back", "you cut the right one as well. you
    // cant do that"). The handoff's page is drawn on a 1280px canvas; here it
    // lives in the content column between the two rails, so the hero's curve
    // panel sits beside the name only where the column is wide enough (2xl)
    // and stacks under the actions elsewhere.
    <TokenShell rightRail={rightRail} back={{ href: '/creators', label: COPY.back }}>
    <div data-testid="meritum-landing" data-handle={handle}>

      {/* ── hero: the warm wash, the eyebrow, the person, the actions, the curve, the stat strip ── */}
      <section
        className="relative overflow-hidden rounded-[20px] border border-line-9 border-l-[3px] border-l-line-brand-10 bg-[linear-gradient(112deg,#FAEEEB_0%,#FBF7F2_46%,#FCFAF7_100%)] px-6 pb-8 pt-10 md:px-10 md:pt-[54px]"
        data-testid="meritum-hero"
      >
        {/* Share sits in the card's top-right corner (owner, 2026-09-15: "Put share
            top right in the card header and put message where the share is"). */}
        <div className="absolute right-5 top-5 md:right-8 md:top-7">
          {shareButton(
            'inline-flex h-9 items-center gap-2 rounded-full border border-ink-2/20 bg-surface-1/70 px-4 font-ui text-[13.5px] leading-none font-medium text-ink-2 hover:border-ink-2 hover:bg-surface-1',
            'meritum-share-hero'
          )}
        </div>
        <div className="grid grid-cols-1 items-end gap-8 2xl:grid-cols-[minmax(0,1fr)_400px] 2xl:gap-10">
          <div className="min-w-0">
            <div className="mb-6 flex items-center gap-3 pr-24 font-ui text-[15px] font-bold uppercase tracking-[0.2em] text-ink-brand-6 md:text-[17px]">
              <CreatorTokenLaurel size={24} />
              {COPY.eyebrow}
            </div>
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:gap-5">
              <UserAvatarImg
                username={routeHandle}
                pixelSize={76}
                apiSize="large"
                radiusClassName="rounded-full"
                className="shrink-0 border-2 border-line-brand-10"
                alt={`@${shown} profile picture`}
                // A lite-owned name must not wear the Hive squatter's face (see user-avatar-img.tsx).
                lite={profile.source === 'lite'}
              />
              <div className="min-w-0 max-w-full">
                <h1 className="break-words font-lora text-[34px] leading-[1.02] font-bold tracking-[-0.03em] text-ink-2 md:text-[54px]" data-testid="meritum-handle">
                  @{shown}
                </h1>
                {profile.about ? (
                  <p className="mt-2.5 max-w-[560px] font-lora text-[16.5px] leading-[1.52] text-ink-4" data-testid="meritum-about">
                    {profile.about}
                  </p>
                ) : null}
              </div>
            </div>

            {market.windingDown ? (
              <div className="mt-5 rounded-card border border-line-warn-2 bg-surface-warn-4 px-5 py-3.5 font-ui text-[14px] leading-[22px] font-medium text-ink-warn-3">
                {WIND_DOWN_BANNER}
              </div>
            ) : market.delinquentUntilBlock !== null ? (
              <div className="mt-5 rounded-card border border-line-warn-2 bg-surface-warn-4 px-5 py-3.5 font-ui text-[14px] leading-[22px] font-medium text-ink-warn-3">
                This creator has left too many paid asks unanswered, so buying and new asks are paused for now. Selling, refunds and reclaims are unaffected.
              </div>
            ) : null}

            <div className="mt-[30px] flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={openBuy}
                disabled={!market.canBuy || soldOut || writesBlocked}
                title={soldOut ? 'Every token on this curve has been issued.' : writeBlockedReason ?? undefined}
                className={`${pill} bg-surface-brand-12 px-[30px] text-ink-27 shadow-[0_4px_14px_rgba(192,57,43,0.34)] hover:bg-surface-brand-16 hover:shadow-[0_6px_22px_rgba(192,57,43,0.46)]`}
                data-testid="meritum-buy"
              >
                {soldOut ? COPY.soldOut : COPY.buy}
                {!soldOut ? <span className="font-num font-normal opacity-80">{usdPrice(market.priceUsd)}</span> : null}
              </button>
              <button type="button" onClick={openSell} disabled={writesBlocked} title={writeBlockedReason ?? undefined} className={ghost} data-testid="meritum-sell">
                {market.windingDown ? COPY.redeem : COPY.sell}
              </button>
              {!isOwner ? <MessageButton handle={routeHandle} label={COPY.message} className={ghost} /> : null}
            </div>
            {writeBlockedReason ? <div className="mt-3 font-ui text-caption text-ink-10">{blockedNotice}</div> : null}
          </div>

          <CurvePanel market={market} historyUnavailable={live.historyUnavailable} />
        </div>

        {/* stat strip: five cells at most, an unknown one dropped rather than zeroed */}
        <div
          className="mt-[38px] grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-ink-2/10 bg-ink-2/10 sm:grid-cols-3 lg:grid-cols-5"
          data-testid="meritum-stats"
        >
          {stats5}
        </div>
      </section>

      {market.position ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-[14px] border border-line-9 bg-surface-12 px-6 py-[18px]" data-testid="meritum-position">
          <div className="font-ui text-[15px] leading-[24px] text-ink-7">
            {COPY.yourPosition}: <strong className="text-ink-2 font-num">{tok(market.position.tokens)}</strong> tokens
          </div>
          <div className="flex gap-2.5">
            <button type="button" onClick={openSell} disabled={writesBlocked} className="rounded-full border border-line-11 bg-surface-1 px-4 py-2.5 font-ui text-caption font-medium text-ink-7 hover:bg-surface-23 disabled:opacity-50">
              {market.windingDown ? COPY.redeem : COPY.sell}
            </button>
            <button type="button" onClick={() => setDialog('send')} disabled={writesBlocked} className="rounded-full border border-line-11 bg-surface-1 px-4 py-2.5 font-ui text-caption font-medium text-ink-7 hover:bg-surface-23 disabled:opacity-50">
              {COPY.send}
            </button>
          </div>
        </div>
      ) : null}

      {/* ── body: the asks, the record, the holders; the rail is the shell's ── */}
      <div className="mt-[34px]">
        <div className="flex min-w-0 flex-col gap-[26px]">
          {market.services.length > 0 ? (
            <section data-testid="meritum-asks">
              <div className="mb-4 flex flex-wrap items-baseline gap-3">
                <h2 className="font-lora text-[26px] leading-[32px] font-semibold tracking-[-0.015em] text-ink-2">{COPY.asksTitle}</h2>
                <span className="font-ui text-[13.5px] text-ink-14">{COPY.asksSub}</span>
              </div>
              {oracleOff ? (
                <div className="mb-3 rounded-control border border-line-warn-2 bg-surface-warn-4 px-4 py-3 font-ui text-caption text-ink-warn-1">
                  {buyerOracleNotice(live.servicesOracleStatus!, shown)}
                </div>
              ) : null}
              <div className="flex flex-col gap-3">
                {market.services.map((sv) => {
                  const quote = market.priceUsd > 0 ? serviceQuote(sv.usd, market.priceUsd) : null;
                  return (
                    <article
                      key={sv.key}
                      className={`${card} grid grid-cols-1 gap-5 p-[22px] shadow-[0_1px_2px_rgba(26,22,18,0.04),0_2px_8px_rgba(26,22,18,0.04)] transition-shadow hover:border-line-brand-10/40 hover:shadow-[0_2px_4px_rgba(26,22,18,0.06),0_8px_24px_rgba(26,22,18,0.08)] sm:grid-cols-[minmax(0,1fr)_150px_124px] sm:items-start sm:gap-6`}
                      data-testid="meritum-ask"
                    >
                      <div className="min-w-0">
                        <h3 className="font-lora text-[19px] leading-[28px] font-semibold tracking-[-0.01em] text-ink-2">{sv.name}</h3>
                        <p className="mt-2 font-lora text-[15px] leading-[1.58] text-ink-4">{sv.desc}</p>
                      </div>
                      <div className="sm:text-right">
                        <div className="text-[26px] leading-[28px] tracking-[-0.02em] text-ink-2 font-num">{usdMoney(sv.usd)}</div>
                        {quote && quote.tokens > 0 ? (
                          <div className="mt-1 font-ui text-[13px] text-ink-14">
                            ≈ <span className="font-num">{tok(quote.tokens)}</span> tokens
                          </div>
                        ) : (
                          <div className="mt-1 font-ui text-[13px] text-ink-14">{COPY.tokenCostUnavailable}</div>
                        )}
                      </div>
                      <div>
                        {market.windingDown ? (
                          <span className="inline-flex whitespace-nowrap rounded-full bg-surface-warn-4 px-2.5 py-1.5 font-ui text-[12px] font-medium text-ink-warn-3">{COPY.windingDown}</span>
                        ) : !market.canAsk ? (
                          <span className="inline-flex whitespace-nowrap rounded-full bg-surface-warn-4 px-2.5 py-1.5 font-ui text-[12px] font-medium text-ink-warn-3">{healthWordFor(health) ?? 'Paused'}</span>
                        ) : sv.status !== 'live' ? (
                          <span className="inline-flex whitespace-nowrap rounded-full bg-surface-11 px-2.5 py-1.5 font-ui text-[12px] font-medium text-ink-10">{COPY.rollingOut}</span>
                        ) : oracleOff ? (
                          <span className="inline-flex whitespace-nowrap rounded-full bg-surface-warn-4 px-2.5 py-1.5 font-ui text-[12px] font-medium text-ink-warn-3">{COPY.notPriceable}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openAsk(sv)}
                            disabled={writesBlocked}
                            title={writeBlockedReason ?? undefined}
                            className="h-10 w-full rounded-full border border-line-brand-10/40 bg-surface-1 font-ui text-[14px] font-bold text-ink-brand-6 hover:border-line-brand-10 hover:bg-surface-brand-3 disabled:opacity-50"
                            data-testid="meritum-request"
                          >
                            {COPY.request}
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              {writeBlockedReason ? <p className="mt-3 font-ui text-caption font-medium text-ink-10">{blockedNotice}</p> : null}
              <p className="mt-3 font-ui text-[13px] leading-[1.58] text-ink-14">
                Prices are set in dollars: the total you’ll pay. 12% goes to Lumen as a separate platform commission, paid in HBD; the rest is spent in
                tokens, and as the token’s price rises a service costs fewer of them.
              </p>
            </section>
          ) : null}

          {/* ── delivery record ── */}
          <section className={`${card} p-[26px]`} data-testid="meritum-delivery">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="font-lora text-[22px] leading-[30px] font-semibold tracking-[-0.01em] text-ink-2">{COPY.deliveryTitle}</h2>
              <span className="ml-auto font-ui text-[13.5px] text-ink-14">{COPY.deliverySub}</span>
            </div>
            {d.available ? (
              <>
                {d.marks.length > 0 ? (
                  <div className="mt-[18px] flex flex-wrap gap-1.5">
                    {d.marks.map((answered, i) => (
                      <span key={i} className={`h-[18px] w-[18px] rounded-control ${answered ? 'bg-surface-ok-7' : 'border-2 border-line-20 bg-surface-1'}`} />
                    ))}
                  </div>
                ) : null}
                <div className="mt-3.5 font-lora text-[15.5px] leading-[1.58] text-ink-4">
                  {d.completionPct === null ? (
                    <strong className="font-semibold">No deliveries yet</strong>
                  ) : (
                    <>
                      <strong className="font-semibold">{pctLabel(d.answered, d.total) ?? '0%'} completion rate</strong>: completed <span className="font-num">{d.answered}</span> of{' '}
                      <span className="font-num">{d.total}</span>
                      {d.typicalResponse ? (
                        <>
                          {' '}
                          · usually within <strong className="font-num font-semibold">{d.typicalResponse}</strong>
                        </>
                      ) : null}
                      .
                    </>
                  )}
                </div>
                {d.ratingCount > 0 && d.avgRating !== null ? (
                  <div className="mt-1.5 font-ui text-[13px] text-ink-4">
                    <span className="mr-1 text-ink-warn-3" aria-hidden="true">
                      {ratingStars(d.avgRating)}
                    </span>
                    Rated <strong className="font-num">{d.avgRating.toFixed(1)}/5</strong> by <span className="font-num">{d.ratingCount}</span>{' '}
                    {d.ratingCount === 1 ? 'buyer' : 'buyers'}
                    {d.declinedCount > 0 ? (
                      <>
                        {' '}
                        · declined <span className="font-num">{d.declinedCount}</span>
                      </>
                    ) : null}
                  </div>
                ) : d.declinedCount > 0 ? (
                  <div className="mt-1.5 font-ui text-[13px] text-ink-14">
                    Declined <span className="font-num">{d.declinedCount}</span> {d.declinedCount === 1 ? 'request' : 'requests'}
                  </div>
                ) : null}
                <p className="mt-3.5 font-ui text-[13px] text-ink-14">{d.completionPct !== null ? COPY.deliveryWhy : COPY.deliveryEmpty}</p>
              </>
            ) : (
              <div className="mt-[18px] rounded-control border border-dashed border-line-11 px-4 py-3 font-ui text-caption text-ink-14">{COPY.deliveryUnavailable}</div>
            )}
          </section>

          {/* ── holders ── */}
          {holders && holders.count > 0 ? (
            <section className={`${card} p-[26px]`} data-testid="meritum-holders">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-lora text-[22px] leading-[30px] font-semibold tracking-[-0.01em] text-ink-2">{COPY.holdersTitle}</h2>
                <span className="ml-auto font-ui text-[13.5px] text-ink-14" data-testid="meritum-holders-count">
                  {holdersHeadline(holders.count)}
                </span>
              </div>
              <div className="mt-[18px] flex flex-col gap-px overflow-hidden rounded-[10px] bg-line-9">
                {holders.rows.map((h) => (
                  <div key={h.handle} className="grid grid-cols-[minmax(0,1fr)_92px] items-center gap-4 bg-surface-1 px-3.5 py-[11px]" data-testid="meritum-holder">
                    <span className="flex min-w-0 items-center gap-[11px]">
                      <UserAvatarImg username={h.handle} pixelSize={32} radiusClassName="rounded-full" />
                      {h.hasProfile ? (
                        <Link href={`/@${h.handle}`} className="truncate font-ui text-[14.5px] font-semibold text-ink-2 hover:text-ink-brand-6">
                          @{h.handle}
                        </Link>
                      ) : (
                        <span className="truncate font-ui text-[14.5px] font-semibold text-ink-2">@{displayHandle(h.handle)}</span>
                      )}
                    </span>
                    <span className="text-right text-[14px] text-ink-4 font-num">{h.tokensLabel}</span>
                  </div>
                ))}
              </div>
              {holders.truncated ? (
                <p className="mt-2.5 font-ui text-[13px] text-ink-14">
                  Showing the <span className="font-num">{holders.rows.length}</span> largest.
                </p>
              ) : null}
            </section>
          ) : null}

          <p className="font-ui text-[13px] leading-[1.58] text-ink-14">{honestNote()}</p>
        </div>

        {/* The rail cards, for every width the shell's right rail does not reach (the token page's rule). */}
        <div className="mt-[26px] flex flex-col gap-[18px] xl:hidden">
          {howThisWorks}
          {marketCapCard}
        </div>
      </div>

      <TokenModals
        dialog={dialog}
        market={market}
        service={service}
        positionUnavailable={live.positionUnavailable}
        onBuy={handleBuy}
        onSell={handleSell}
        onRedeem={handleRedeem}
        onSpend={({ offeringId, deadlineDays, usd, question }) =>
          live.ask({ offeringId, contentHash: askReference(question), deadlineDays, maxCostUsd: usd })
        }
        onTransfer={(to, tokens) => live.transfer(to, tokens)}
        quoteAsk={live.quoteAsk}
        onClose={() => {
          if (dialog === 'inter' && typeof window !== 'undefined') {
            try {
              window.sessionStorage.setItem(interstitialKey(handle, live.viewer), '1');
            } catch {
              // Storage blocked: showing the warning again is the safe failure.
            }
          }
          const queued = pendingAction.current;
          pendingAction.current = null;
          setDialog(queued ?? null);
        }}
      />
      {shareOpen ? <ShareSheet handle={shown} url={shareUrl} cardSrc={cardSrc} onClose={() => setShareOpen(false)} /> : null}
    </div>
    </TokenShell>
  );
};

export default MeritumLanding;
