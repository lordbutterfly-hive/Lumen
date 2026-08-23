'use client';

import { FC, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Service } from '../../market/token-detail';
import { buyQuote, serviceQuote } from '../../market/curve';
import { displayHandle } from '../../live/adapt';
import { useLiveTokenMarket } from '../../live/use-live-token-market';
import { useCreatorFollow } from '../../live/use-creator-follow';
import { MarketLoading, MarketMissing, MarketReadFailed, MarketUnavailable } from '../../live/market-states';
import { pctLabel, pctValue, usdPrice, usdWhole } from '../../market/format';
import TokenShell from '../token-shell';
import PriceChart from './price-chart';
import TokenModals, { type TokenDialog } from './token-modals';
import { MeritumEligibilityNotice, useMeritumEligibility } from '../meritum-eligibility';

const tok = (n: number) => n.toFixed(2);

/**
 * A stable decorative fill per handle. NOT identity, NOT data — the chain
 * stores no avatar, and the Hive profile isn't read here yet, so this is
 * plainly a colour derived from the name rather than a picture we imply is
 * theirs. The demo hardcoded per-creator gradients in a fixture; deriving it
 * keeps every handle looking consistent without pretending to know anything.
 */
/**
 * The escrow's content reference. The chain stores a short opaque string and
 * NOTHING ELSE about the job — no question, no brief, no deliverable. That is
 * deliberate: this contract facilitates payment and reputation, not messaging.
 *
 * A short, stable, non-secret reference derived from what the buyer typed, so
 * both parties can name the same job ("re: ask 4f2a") when they talk. It must
 * never be treated as delivery: the creator gets paid for work arranged
 * elsewhere, and the buyer's protection is the rating they leave afterwards.
 */
function askReference(question: string): string {
  const trimmed = question.trim();
  if (trimmed.length === 0) return `ask-${Date.now().toString(36)}`;
  // A cheap stable digest — not cryptographic, and not meant to be: it only has
  // to be short, deterministic and free of the '|' the contract's key format
  // reserves.
  let h = 0;
  for (let i = 0; i < trimmed.length; i++) h = (Math.imul(31, h) + trimmed.charCodeAt(i)) | 0;
  return `ask-${(h >>> 0).toString(36)}`;
}

/**
 * Who has been shown the "before you trade" warning, for which market.
 *
 * ★ Keyed by VIEWER as well as handle (2026-08-07). It used to be handle-only,
 * so after one account dismissed the warning, a genuinely different account
 * signing in on the same tab never saw it at all — a risk disclosure silently
 * inherited by someone who never read it.
 */
function interstitialKey(handle: string, viewer: string | null): string {
  return `lumen-token-inter-${viewer ?? 'anon'}-${handle}`;
}

function avatarFill(handle: string): string {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) % 360;
  return `linear-gradient(135deg,hsl(${h} 42% 42%),hsl(${(h + 40) % 360} 38% 48%))`;
}

const TokenMarketView: FC<{ handle: string }> = ({ handle }) => {
  const live = useLiveTokenMarket(handle);
  const { market, status } = live;
  const { following, busy: followBusy, available: followAvailable, toggle: toggleFollow } = useCreatorFollow(handle);
  const [dialog, setDialog] = useState<TokenDialog>(null);
  const [service, setService] = useState<Service | null>(null);
  const searchParams = useSearchParams();
  // Extracted so the effects below depend on a plain boolean rather than a
  // complex expression React cannot statically check.
  const hasMarket = market !== null;
  const eligibility = useMeritumEligibility();

  // ★ GATED ON CAPABILITY, NOT TIER (2026-08-20). This used to refuse every
  // lite account outright — correct while no wallet could sign, and wrong the
  // moment one could. A lite account with a live wallet chain now trades
  // natively on Magi, signing as its own DID; a lite account WITHOUT one still
  // cannot, and is told the actual fix rather than being sent to upgrade.
  const writeBlockedReason: string | null = !live.loggedIn
    ? 'Sign in to trade this token.'
    : !live.canTrade
      ? 'This account has no key that can sign a transaction yet. Connect an Ethereum wallet, or upgrade to a full Hive account, to trade.'
      : null;
  const writesBlocked = writeBlockedReason !== null;
  // Same predicate the Buy button has always disabled on, named once so the label, the
  // tooltip and the disable cannot drift apart. `>=` not `==`: a cap lowered below supply
  // must not re-enable buying.
  const soldOut = market !== null && market.supply >= market.cap;
  // ★ The way OUT of the gate must be clickable (2026-08-07). This page told a
  // lite reader "Upgrade to a full account to trade" as flat text, right where
  // they had just formed the intent to trade — while Studio and Wallet both
  // link to /upgrade. The only working route from here was an unrelated menu
  // three clicks away, which a reader has no reason to go looking for.
  // ★ 2026-08-16, owner. One notice for every identity, derived from the rail's
  // capability flags — a Google-only account is told it has no wallet at all,
  // a wallet-bound account is told its tokens are safely held and only TRADING
  // is unported. The old single sentence said "no Hive keys" to both.
  // ★ SIGNED-OUT GOES THROUGH THE SAME NOTICE (2026-08-16, second pass). It was
  // routed around it, which had two costs: the signed-out reader got "Sign in to
  // trade this token." as flat text with nothing to click, exactly the defect the
  // 08-07 note above fixed for lite readers; and the component's signed-out
  // branch was unreachable from every call site — dormant code that no test
  // could have caught, because the other two surfaces 307 to /login.
  const blockedNotice = writeBlockedReason ? (
    <MeritumEligibilityNotice surface="trade" who={eligibility} inline />
  ) : null;

  // Set when the interstitial pre-empts a deep-linked action, so the action can
  // run once the reader dismisses it instead of being lost.
  const pendingAction = useRef<TokenDialog>(null);

  // Deep-link an action from the Your-Tokens row buttons (?a=buy|sell|spend|send).
  // buy.go/ask.go RequireInflowOpen (RULING K3): a winding-down market refuses
  // every new inflow, so a deep link must not silently open Buy/Ask around the
  // gate the main Buy button and the Services CTAs already close. Sell/Send
  // are outflows and stay open in every state (the rail-switch doc).
  useEffect(() => {
    if (!market) return;
    // ★ A DEEP LINK MUST HONOUR THE SAME GATE AS THE BUTTON IT MIRRORS.
    //
    // `writeBlockedReason` disables every write control on this page and states
    // why, BEFORE the reader invests anything. The `?a=` links the portfolio
    // generates skipped it, so a lite account could open Buy, type a budget,
    // read a live quote and press submit — and only then be told it has no keys.
    // The one disclosure this feature is otherwise careful to put first was the
    // one thing put last.
    if (writesBlocked) return;
    const a = searchParams?.get('a');
    if (a === 'buy') {
      // buy.go/ask.go RequireInflowOpen: a deep link must respect the SAME gate
      // the buttons do, including delinquency — canBuy/canAsk already fold in
      // pause, wind-down and delivery standing.
      if (market.canBuy) setDialog('buy');
    } else if (a === 'sell') {
      // ★ THE SAME RAIL THE BUTTON WOULD PICK, NOT ALWAYS THE CURVE.
      //
      // The visible Sell button is `market.windingDown ? 'redeem' : 'sell'`,
      // because once a market winds down the curve is CLOSED and the only exit
      // is a pro-rata redeem at the floor. This deep link — which the portfolio
      // page generates for every holding's "Sell" — set 'sell' literally, so a
      // holder arriving from their own wallet was shown the curve dialog with
      // a "Curve proceeds" line and a 10% trade fee for a sale that cannot
      // execute. On a mock holder that renders as $0.00; on a real one it is a
      // plausible dollar figure for a transaction the contract will refuse, on
      // the exit screen, which is precisely where trust matters most.
      setDialog(market.windingDown ? 'redeem' : 'sell');
    } else if (a === 'send') {
      setDialog('send');
    } else if (a === 'spend' && market.services[0] && market.canAsk) {
      setService(market.services[0]);
      setDialog('ask');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, hasMarket, writesBlocked]);

  // Market interstitial — first view per creator, per session. Only once there
  // is a real market: interrupting someone to explain a market that failed to
  // load, or does not exist, is noise.
  useEffect(() => {
    if (typeof window === 'undefined' || !market) return;
    // ★ Not for an account that cannot trade (2026-08-07). The interstitial
    // explains price risk and the early-exit fee, then the page immediately
    // tells a signed-out/lite reader they cannot trade at all — a modal to
    // dismiss about a decision they are not being offered. It fires as soon
    // as they can actually act (writesBlocked is in the dep list).
    if (writesBlocked) return;
    const key = interstitialKey(handle, live.viewer);
    if (!window.sessionStorage.getItem(key)) {
      // ★ DO NOT THROW AWAY WHAT THEY ASKED FOR.
      //
      // This effect is declared AFTER the deep-link effect above, so on a first
      // visit it overwrote the dialog that link had just opened — clicking
      // "Buy" on a holding in /wallet/tokens showed the "Before you trade"
      // interstitial instead, and dismissing it landed on the plain market page
      // with the original intent silently gone. Remember it, and honour it once
      // the reader has read the warning they were shown for a reason.
      setDialog((current) => {
        if (current && current !== 'inter') pendingAction.current = current;
        return 'inter';
      });
      // ★ NOT marked seen here (2026-08-07). This used to run in the same effect
      // that OPENS the dialog, so the warning counted as read the instant it
      // rendered: refreshing while it was still on screen retired it for the
      // rest of the session, unread. It is marked when the reader dismisses it.

    }
    // `market` itself is deliberately NOT a dependency: it is a fresh object on
    // every 30s poll, and depending on it would re-open this dialog over and
    // over. hasMarket is the only thing that actually gates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, hasMarket, writesBlocked, live.viewer]);

  if (status === 'unavailable') return <MarketUnavailable />;
  if (status === 'loading') return <MarketLoading />;
  // ★ ORDER IS LOAD-BEARING (2026-08-07). `missing` MUST be tested before the
  // `|| !market` guard: on a missing market `market` is null by construction,
  // so an error-first check swallowed every unlaunched creator and told them
  // "we couldn't reach the chain" — the exact empty-as-error lie
  // live/market-states.tsx exists to prevent. Found live against the deployed
  // testnet contract, where a correct read of an unregistered creator rendered
  // as a node outage.
  if (status === 'missing') return <MarketMissing handle={handle} />;
  if (status === 'error' || !market) return <MarketReadFailed onRetry={live.retry} />;

  const d = market.delivery;
  const supplyPct = pctValue(market.supply, market.cap);
  /**
   * What the reader sees next to the bar. `supplyPct` drives the BAR width and
   * must stay a number; this is the LABEL.
   *
   * ★ "0%" IS NOT THE SAME CLAIM AS "NONE" (QA, 2026-08-20). 31 of 100,000
   * rounds to 0, so a market that has genuinely issued tokens announced itself
   * as untouched. The rounding was arithmetically right and the sentence it
   * produced was wrong, which is the worse kind of wrong on a number about
   * money. Anything above zero but below half a percent now reads "<1%".
   */
  const supplyPctLabel = pctLabel(market.supply, market.cap) ?? '0%';
  const avatarColor = avatarFill(handle);

  const openAsk = (sv: Service) => {
    setService(sv);
    setDialog('ask');
  };

  /**
   * The modal collects a DOLLAR budget; the chain buys a WHOLE TOKEN COUNT at
   * an exact curve cost. buyQuote turns the budget into the largest affordable
   * count using the same ported curve math the contract runs, then quoteBuy
   * re-prices that count against LIVE state — and that authoritative total, not
   * the local estimate, is what the user's transfer.allow is signed for
   * (RULING F: the quote is mandatory before signing).
   */
  // ONE reason, shared by every write entry point on this page. Buy and Ask
  // already checked `live.isLite`; Sell and Send checked nothing at all, so a
  // signed-out visitor got an enabled Sell button, a modal, a filled-in
  // amount, and only then the refusal from the hook's requireSigner. The gate
  // now sits with the control that offers the action, and states WHY — the
  // hook's throw remains the backstop for a stale render or a deep link, per
  // its own doc.

  const handleBuy = async (usd: number, maxTotalUsd?: number): Promise<void> => {
    const local = buyQuote(usd, market);
    if (local.tokens <= 0) throw new Error('That budget does not cover a whole token at the current price.');
    const authoritative = await live.quoteBuy(local.tokens);
    // The user's own ceiling wins. If live state has moved past it between the
    // preview and this click, REFUSE here rather than signing an allowance
    // above what they agreed to — a transfer.allow is the buyer's only
    // slippage protection on this rail.
    // F-C14: when Advanced is collapsed (maxTotalUsd undefined) the ENTERED BUDGET
    // `usd` is the ceiling. Previously the guard was skipped in that default case and
    // the buy was signed for the fresh, possibly-higher live total — so the budget the
    // user saw was never actually a spend cap. buyQuote guarantees totalDueHbd <= usd
    // under no drift, so this never self-rejects the common (unmoved-price) case.
    const cap = maxTotalUsd ?? usd;
    if (authoritative.totalDueHbd > cap) {
      throw new Error('The price moved above your limit.');
    }
    await live.buy(local.tokens, cap);
  };

  /**
   * F5 fix (2026-08-19), superseding this comment's old rationale: `minNetUsd`
   * is no longer "not passed, deliberately". SellModal now defaults it ON,
   * derived from the SAME quote shown as "you receive" plus a small tolerance
   * (MIN_NET_DEFAULT_TOLERANCE_BPS, market/curve.ts) — exactly wide enough
   * that an ordinary same-block price tick does not trip it, but a real
   * front-run or price move still does. Absent (the reader cleared the field)
   * is still the honest escape hatch sell.go's own absent-minNet convention
   * preserves. quoteSell is still called first so a closed rail (a market in
   * wind-down, where refund() is the door instead) fails HERE with its real
   * reason rather than on-chain.
   */
  const handleSell = async (tokens: number, minNetUsd?: number): Promise<void> => {
    await live.quoteSell(tokens);
    // H-FE-7 / F5: pass the net floor SellModal computed (undefined only when
    // the reader explicitly cleared it; the backend already threads minNetHbd).
    await live.sell(tokens, minNetUsd);
  };

  /**
   * The wind-down exit. Deliberately does NOT pre-flight with quoteSell: that
   * quote walks the CURVE, and the curve rail is exactly what is closed here —
   * asking for it would fail with "sell is closed" and block the one exit that
   * still works. The refund amount is derived from the position's own already-
   * taxed floor value in the dialog, and the contract recomputes it at execution.
   */
  const handleRedeem = async (tokens: number, minNetUsd?: number): Promise<void> => {
    await live.refund(tokens, minNetUsd); // H-FE-7: optional net-refund floor (undefined = no floor)
  };

  const rightRail = (
    <div className="flex flex-col gap-5 pt-[26px]">
      <div className="rounded-panel border border-line-9 bg-surface-1 p-5">
        <div className="mb-3 text-[15px] leading-[24px] font-bold text-ink-2">How this works</div>
        <div className="flex flex-col gap-3.5">
          {[
            'Buy the creator’s token. The price rises as more is bought.',
            'Spend tokens on their work. A question, a code review, a day of building — priced in dollars.',
            'As more people buy in, the token can appreciate. The floor is what the reserve would pay out per token if the market wound down. Selling on the curve is a separate thing, at the curve’s price.'
          ].map((line, i) => (
            <div key={i} className="flex gap-3">
              <span className="font-serif font-bold text-ink-brand-6">{i + 1}</span>
              <span className="text-caption text-ink-7">{line}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-panel border border-line-9 bg-surface-1 p-5">
        <div className="mb-1.5 text-caption text-ink-10">Reserve backing</div>
        <div className="mb-0.5 text-[20px] font-bold tabular-nums text-ink-2">{usdWhole(market.reserveUsd)}</div>
        <p className="font-serif text-caption text-ink-14">Held in reserve behind every token: the source of the floor.</p>
      </div>
    </div>
  );

  return (
    <TokenShell rightRail={rightRail} back={{ href: '/creators', label: '← All creators' }}>
      {/* 1. Creator header */}
      <div className="mb-5 flex items-center gap-4">
        <span className="h-[60px] w-[60px] flex-shrink-0 rounded-2xl" style={{ background: avatarColor }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className="text-xl font-bold text-ink-2">@{displayHandle(handle)}</span>
          </div>
          {/* No bio and no reputation score here: neither is contract state, and
              the Hive profile is not read on this route yet. The demo showed
              both from a fixture. Rendering a made-up one-liner under someone's
              name is the worst kind of fabrication — it reads as their words. */}
        </div>
        {/* Only offered to someone who can actually follow, and disabled while the
            real state is unknown — this button used to be pure browser memory and
            reported success without doing anything. */}
        {followAvailable ? (
          <button
            onClick={toggleFollow}
            disabled={followBusy}
            aria-busy={followBusy}
            className={`rounded-control border px-5 py-2.5 text-sm font-semibold disabled:opacity-50 ${following ? 'border-line-brand-10 bg-surface-brand-3 text-ink-brand-6' : 'border-line-11 bg-surface-1 text-ink-7 hover:bg-surface-16'}`}
          >
            {following ? 'Following' : 'Follow'}
          </button>
        ) : null}
      </div>

      {/* Wind-down banner (design brief ui-prompts/tokens/1-TOKEN-PAGE.md,
          WIND-DOWN/FROZEN state): tells a visitor WHY buying/asking is closed
          and that selling stays open, rather than leaving the disabled Buy
          button to speak for itself. */}
      {market.windingDown ? (
        <div className="mb-4 rounded-card border border-line-warn-2 bg-surface-warn-4 px-5 py-3.5 text-[14px] leading-[22px] font-semibold text-ink-warn-3">
          This creator’s market is winding down — buying and new asks are closed. Selling on the curve is closed too;
          use Redeem to take your pro-rata share of the reserve at the floor.
        </div>
      ) : market.phase === 'OVERDUE' ? (
        // ★ OVERDUE WAS COMPLETELY SILENT TO A BUYER.
        //
        // The page was textually and functionally identical to a healthy market:
        // Buy enabled, no banner, no badge. The only place this state appeared
        // anywhere in the product was the creator's OWN dashboard — which a
        // buyer has no reason to open. Yet it is the one state where the
        // downside is about to change shape: when grace runs out the market
        // FREEZES, the curve closes, and the only exit becomes a redeem at the
        // floor. On the fixture that surfaced this the spot price was $3.04 and
        // the floor $2.00 — a third of the position, turning on a clock nobody
        // was shown. This page already discloses wind-down and delinquency
        // plainly; overdue is the state that most needs it.
        <div className="mb-4 rounded-card border border-line-warn-2 bg-surface-warn-4 px-5 py-3.5 text-[14px] leading-[22px] font-semibold text-ink-warn-3">
          This creator’s listing has lapsed. If it isn’t renewed the market freezes: buying and selling on the curve
          close, and the only way out becomes Redeem at the floor
          {market.floorUsd ? ` (currently ${usdPrice(market.floorUsd)} a token, against ${usdPrice(market.priceUsd)} now)` : ''}.
        </div>
      ) : market.delinquentUntilBlock !== null ? (
        // delivery.go: RequireInflowOpen also refuses while a creator is
        // DELINQUENT. Without this the Buy button would simply be dead with no
        // reason given, which reads as a broken page — and saying it out loud is
        // also what makes the gate do its job.
        <div className="mb-4 rounded-card border border-line-warn-2 bg-surface-warn-4 px-5 py-3.5 text-[14px] leading-[22px] font-semibold text-ink-warn-3">
          This creator has left too many paid asks unanswered, so buying and new asks are paused for now. Selling,
          refunds and reclaims are unaffected.
        </div>
      ) : null}

      {/* 2. Token market — centerpiece */}
      <div className="mb-4 rounded-panel border border-line-9 bg-surface-1 p-[26px] shadow-[0_1px_2px_rgba(26,22,18,0.035),0_3px_12px_-6px_rgba(70,46,30,0.13)]">
        <div className="mb-[18px] flex items-center gap-2.5">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-control text-caption font-bold text-ink-27"
            style={{ background: avatarColor }}
          >
            ◆
          </span>
          {/* ★ A real h1 (2026-08-07). This page had NO heading element at all —
              every other page in the feature has exactly one — so a screen-reader
              user navigating by headings had nothing to land on for the single
              most important screen here. Styling unchanged; only the element is. */}
          <h1 className="text-[15px] leading-[24px] font-bold text-ink-2">@{displayHandle(market.handle)} token</h1>
        </div>
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <div>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-[44px] font-bold tabular-nums tracking-hero text-ink-2">{usdPrice(market.priceUsd)}</span>
              {/* Weekly change needs price HISTORY, which only the indexer can
                  serve — the client method now exists (MagiIndexerClient
                  .priceHistoryOf) but this view is not wired to it yet, and
                  live/adapt.ts keeps
                  changePctWeek null for exactly this reason). An arrow computed
                  from a single current price would be invented. */}
              {market.changePctWeek !== null ? (
                <span className={`inline-flex items-center gap-1 text-[15px] leading-[24px] font-bold tabular-nums ${market.changePctWeek >= 0 ? 'text-ink-ok-2' : 'text-ink-brand-6'}`}>
                  {market.changePctWeek >= 0 ? '▲' : '▼'} {Math.abs(market.changePctWeek)}%
                </span>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-[18px]">
              <div>
                <div className="mb-0.5 text-caption text-ink-10">Market cap</div>
                <div className="text-[20px] leading-[30px] font-bold tabular-nums text-ink-2">{usdWhole(market.marketCapUsd)}</div>
              </div>
              <div className="h-[34px] w-px bg-surface-26" />
              <div>
                <div className="mb-0.5 flex items-center gap-1.5 text-caption text-ink-10">
                  Floor
                  {/* Reachable and announced (2026-08-07): this explainer was a bare
                      <span title>, so it existed for a mouse and for nobody else. */}
                  <span
                    role="note"
                    tabIndex={0}
                    aria-label="What the floor means: what the reserve would pay out per token if the market wound down. It is not a price you can sell at on demand."
                    title="What the reserve would pay out per token if the market wound down. Not a price you can sell at on demand."
                    className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-surface-23 text-caption text-ink-14"
                  >
                    ?
                  </span>
                </div>
                {/* Floor beside price, equal size, muted — never colored. */}
                <div className="text-[20px] leading-[30px] font-bold tabular-nums text-ink-10">{usdPrice(market.floorUsd)}</div>
              </div>
            </div>
            <div className="mt-[18px]">
              <div className="mb-1.5 flex justify-between text-caption tabular-nums text-ink-10">
                <span>
                  {market.supply.toLocaleString('en-US')} of {market.cap.toLocaleString('en-US')} tokens issued
                </span>
                <span>{supplyPctLabel}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-md bg-surface-23">
                <div className="h-full bg-surface-info-9" style={{ width: `${supplyPct}%` }} />
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              {/* ★★★ THE SOLD-OUT REASON BELONGS HERE, NOT IN THE MODAL (corrected 2026-08-23).
                  `market.supply >= market.cap` has disabled this button for a long time and said
                  NOTHING about why — a greyed control with the ordinary label, indistinguishable
                  from a bug. My first pass at this put the explanation on the BuyModal's submit
                  button, which a sold-out visitor can never reach: the modal only opens from this
                  button, and this button is disabled. A label on an unreachable branch is not a
                  fix. Verified live on a 30/30 market by a decorrelated session, which is how the
                  miss was caught.

                  The modal's own guard stays — supply can cross the cap while the modal is open,
                  and that race is a real one — but it is a guard, not the disclosure. */}
              <button
                onClick={() => setDialog('buy')}
                disabled={!market.canBuy || soldOut || writesBlocked}
                title={soldOut ? 'Every token on this curve has been issued.' : (writeBlockedReason ?? undefined)}
                className="flex-1 rounded-xl bg-surface-brand-12 py-3.5 text-[15px] leading-[24px] font-bold text-ink-27 hover:bg-surface-brand-16 disabled:opacity-50"
              >
                {soldOut ? 'Sold out' : 'Buy'}
              </button>
              {/* ★ Sell is CLOSED during wind-down — sell.go's curve rail refuses
                  once the market is retired/frozen/closed, and this button used
                  to open the sell dialog anyway, fail every time, and leave the
                  holder with no reachable exit. The pro-rata rail (refund.go) is
                  the exit in that state, so the button becomes it. */}
              <button
                onClick={() => setDialog(market.windingDown ? 'redeem' : 'sell')}
                disabled={writesBlocked}
                title={writeBlockedReason ?? undefined}
                className="flex-1 rounded-xl border border-line-11 bg-surface-1 py-3.5 text-[15px] leading-[24px] font-semibold text-ink-7 hover:bg-surface-16 disabled:opacity-50"
              >
                {market.windingDown ? 'Redeem' : 'Sell'}
              </button>
            </div>
            {writeBlockedReason ? (
              <div className="mt-2.5 text-center text-caption text-ink-10">{blockedNotice}</div>
            ) : null}
          </div>
          <div>
            {/* REAL history, from the Magi indexer's lumen_ct_price_history view
                (supply per trade -> price through the same ported curve the buy
                button uses, never a second copy of the formula).
                `chart` is null when the history could not be read OR when there
                is only one point — one point would draw a flat line, which
                claims the price held steady when we only know one moment. There
                are no range buttons: the view returns trades, not a time series,
                so "1D / 1W / 1M" would be filters over data we cannot honestly
                bucket by time yet. */}
            {market.chart ? (
              <>
                <PriceChart points={market.chart} />
                <div className="mt-2 text-center text-caption tabular-nums text-ink-14">
                  {market.chart.length} trades · price is set by the curve, not by a last-traded quote
                </div>
              </>
            ) : (
              <div className="flex h-full min-h-[160px] flex-col justify-center rounded-card border border-dashed border-line-11 px-5 py-6 text-center">
                <div className="text-[14px] leading-[22px] font-semibold text-ink-10">No price history yet</div>
                <p className="mt-1 text-caption italic text-ink-14">
                  The price above is live from the curve. A chart appears once this market has traded more than once.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3. Trust record */}
      <div className="mb-4 rounded-panel border border-line-9 bg-surface-1 p-6 shadow-[0_1px_2px_rgba(26,22,18,0.035),0_3px_12px_-6px_rgba(70,46,30,0.13)]">
        <div className="mb-3.5 font-serif text-[20px] leading-[30px] font-semibold text-ink-2">Delivery record</div>
        {d.available ? (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {d.marks.map((answered, i) => (
                <span key={i} className={`h-[18px] w-[18px] rounded-control ${answered ? 'bg-surface-ok-7' : 'border-2 border-line-20 bg-surface-1'}`} />
              ))}
            </div>
            <div className="text-base tabular-nums text-ink-4">
              {d.completionPct === null ? (
                /* Read fine, nothing to report yet — never "0%", which reads as a
                   failure to deliver and is what every brand-new market would say. */
                <strong>No deliveries yet</strong>
              ) : (
                <>
                  <strong>{pctLabel(d.answered, d.total) ?? '0%'} completion rate</strong> — completed {d.answered} of {d.total}
                  {/* Guarded: an empty median left the sentence ending "usually within ." */}
                  {d.typicalResponse ? (
                    <>
                      {' '}
                      · usually within <strong>{d.typicalResponse}</strong>
                    </>
                  ) : null}
                  .
                </>
              )}
            </div>
            <div className="mt-1.5 text-caption text-ink-14">Why the token is worth holding. This is what you’re really buying.</div>
          </>
        ) : (
          <div className="rounded-control border border-dashed border-line-11 px-4 py-3 text-caption text-ink-14">Delivery record unavailable</div>
        )}
      </div>

      {/* 4. Services */}
      <div className="mb-4 rounded-panel border border-line-9 bg-surface-1 p-6 shadow-[0_1px_2px_rgba(26,22,18,0.035),0_3px_12px_-6px_rgba(70,46,30,0.13)]">
        <div className="mb-3.5 text-label font-bold uppercase tracking-label text-ink-14">What you can do with the token</div>
        <div className="mb-3.5 flex flex-col gap-2.5">
          {market.services.map((sv) => (
            <div
              // ★ STACKS ON A PHONE (2026-08-08). At 390px this row kept all four
              // children side by side, so the description column was squeezed to
              // 30px wide and 848px tall — one word per line — burying the price
              // and the Ask button. Measured on a real 390x844 viewport. Below
              // `sm` it stacks; from `sm` up the original row is unchanged.
              key={sv.key}
              className="flex flex-col gap-3 rounded-card border border-line-9 px-[18px] py-4 sm:flex-row sm:items-center sm:gap-3.5"
            >
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-control bg-surface-21 text-ink-brand-6">◆</span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] leading-[24px] font-bold text-ink-2">{sv.name}</div>
                <div className="text-caption text-ink-10">{sv.desc}</div>
              </div>
              <div className="flex-shrink-0 text-left sm:text-right">
                <div className="text-[15px] leading-[24px] font-bold tabular-nums text-ink-2">{usdWhole(sv.usd)}</div>
                {/* The TOKEN LEG only (88% of the posted price) — the other 12% is a
                    separate HBD commission (serviceQuote/ask.go splitFace, USER RULING
                    2026-07-27), never itself paid in tokens. */}
                {/* ★ Never render a paid service as costing "0.00 tokens"
                    (2026-08-07). serviceQuote() returns tokens: 0 whenever it
                    cannot price — so when the token price was briefly wrong,
                    a real $25 service advertised itself as free-ish. A price we
                    do not have must read as absent, never as zero. */}
                {market.priceUsd > 0 ? (
                  <div className="text-caption tabular-nums text-ink-14">≈ {tok(serviceQuote(sv.usd, market.priceUsd).tokens)} tokens</div>
                ) : (
                  <div className="text-caption text-ink-14">token cost unavailable</div>
                )}
              </div>
              {market.windingDown ? (
                // ask.go Ask -> RequireInflowOpen: closed for the whole wind-down, the same gate Buy is behind.
                <span className="flex-shrink-0 rounded-full bg-surface-warn-4 px-3 py-1.5 text-caption font-semibold text-ink-warn-3">Winding down</span>
              ) : !market.canAsk ? (
                <span className="flex-shrink-0 rounded-full bg-surface-warn-4 px-3 py-1.5 text-caption font-semibold text-ink-warn-3">Paused</span>
              ) : (
                <button
                  onClick={() => openAsk(sv)}
                  disabled={writesBlocked}
                  title={writeBlockedReason ?? undefined}
                  className="flex-shrink-0 rounded-control bg-surface-42 px-[18px] py-2.5 text-[14px] leading-[22px] font-semibold text-ink-27 hover:bg-surface-44 disabled:opacity-40"
                >
                  {sv.cta}
                </button>
              )}
            </div>
          ))}
        </div>
        {/* ★ Visible, not title-only (2026-08-07). The services CTAs carried the
            same disabled reason as Buy/Sell but ONLY in a `title` tooltip, which
            never appears on touch and is not announced. Buy/Sell state it in
            copy; this section now does too. */}
        {writeBlockedReason ? (
          <p className="text-caption font-semibold text-ink-10">{blockedNotice}</p>
        ) : null}
        <p className="font-serif text-caption text-ink-10">
          Prices are set in dollars — the total you’ll pay. 12% goes to Lumen as a separate platform commission, paid in
          HBD; the rest is spent in tokens, and as the token’s price rises a service costs fewer of them.
        </p>
      </div>

      {/* 5. Your position */}
      {market.position ? (
        <div className="mb-4 rounded-panel border border-line-9 bg-surface-12 px-6 py-[22px]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="text-[15px] leading-[24px] tabular-nums text-ink-7">
              You hold <strong className="text-ink-2">{tok(market.position.tokens)} tokens</strong> · worth{' '}
              <strong className="text-ink-2">{usdPrice(market.position.valueUsd)}</strong> · floor value{' '}
              <strong className="text-ink-2">{usdPrice(market.position.floorValueUsd)}</strong>
            </div>
            <div className="flex gap-2.5">
              <button
                onClick={() => setDialog('sell')}
                disabled={writesBlocked}
                title={writeBlockedReason ?? undefined}
                className="rounded-control border border-line-11 bg-surface-1 px-4 py-2.5 text-caption font-semibold text-ink-7 hover:bg-surface-23 disabled:opacity-50"
              >
                Sell
              </button>
              <button
                onClick={() => setDialog('send')}
                disabled={writesBlocked}
                title={writeBlockedReason ?? undefined}
                className="rounded-control border border-line-11 bg-surface-1 px-4 py-2.5 text-caption font-semibold text-ink-7 hover:bg-surface-23 disabled:opacity-50"
              >
                Send
              </button>
              {/* ask.go Ask -> RequireInflowOpen: closed for the whole wind-down, same gate as Buy. */}
              {/* Spend is hidden entirely rather than shown disabled: the
                  Services list above already explains why asking is off, and a
                  second dead button here would just read as breakage. */}
            </div>
          </div>
        </div>
      ) : null}

      {/* 6. Honest note */}
      <p className="font-serif text-caption text-ink-14">
        This token’s price floats — it can go up or down, and you can lose money. Every trade pays a 10% fee (5% to the
        creator, 5% to Lumen), and selling soon after buying adds an early-exit fee on top, which fades to zero over 6
        weeks. The floor above is what the reserve would pay out per token if the market wound down — it is not a price
        you can sell at on demand.
      </p>

      <TokenModals
        dialog={dialog}
        market={market}
        service={service}
        onBuy={handleBuy}
        onSell={handleSell}
        onRedeem={handleRedeem}
        onSpend={({ offeringId, deadlineDays, usd, question }) =>
          // THE CONTRACT DOES NOT CARRY THE BRIEF, by design (USER RULING
          // 2026-07-28): it facilitates the payment and the relationship, and
          // the two parties arrange delivery between themselves. contentHash is
          // therefore a RECEIPT, not a delivery channel — a short reference the
          // buyer can quote when they contact the creator, and a stable id both
          // sides can point at. It is not secret and is not a message.
          live.ask({ offeringId, contentHash: askReference(question), deadlineDays, maxCostUsd: usd })
        }
        onTransfer={(to, tokens) => live.transfer(to, tokens)}
        onClose={() => {
          // The risk warning counts as read only once it is dismissed — see the
          // interstitial effect above for why it is not marked on render.
          if (dialog === 'inter' && typeof window !== 'undefined') {
            try {
              window.sessionStorage.setItem(interstitialKey(handle, live.viewer), '1');
            } catch {
              // Storage blocked (private mode): showing the warning again is the
              // safe failure, so swallow and carry on.
            }
          }
          // Hand back the action the interstitial interrupted, if any.
          const queued = pendingAction.current;
          pendingAction.current = null;
          setDialog(queued ?? null);
        }}
      />
    </TokenShell>
  );
};

export default TokenMarketView;
