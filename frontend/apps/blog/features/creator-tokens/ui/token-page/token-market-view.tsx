'use client';

import { FC, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Service } from '../../market/token-detail';
import { buyQuote, serviceQuote } from '../../market/curve';
import { useLiveTokenMarket } from '../../live/use-live-token-market';
import { useCreatorFollow } from '../../live/use-creator-follow';
import { MarketLoading, MarketMissing, MarketReadFailed, MarketUnavailable } from '../../live/market-states';
import { usdPrice, usdWhole } from '../../market/format';
import TokenShell from '../token-shell';
import PriceChart from './price-chart';
import TokenModals, { type TokenDialog } from './token-modals';

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

function avatarFill(handle: string): string {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) % 360;
  return `linear-gradient(135deg,hsl(${h} 42% 42%),hsl(${(h + 40) % 360} 38% 48%))`;
}

const TokenMarketView: FC<{ handle: string }> = ({ handle }) => {
  const live = useLiveTokenMarket(handle);
  const { market, status } = live;
  const { following, toggle: toggleFollow } = useCreatorFollow(handle);
  const [dialog, setDialog] = useState<TokenDialog>(null);
  const [service, setService] = useState<Service | null>(null);
  const searchParams = useSearchParams();
  // Extracted so the effects below depend on a plain boolean rather than a
  // complex expression React cannot statically check.
  const hasMarket = market !== null;

  // Deep-link an action from the Your-Tokens row buttons (?a=buy|sell|spend|send).
  // buy.go/ask.go RequireInflowOpen (RULING K3): a winding-down market refuses
  // every new inflow, so a deep link must not silently open Buy/Ask around the
  // gate the main Buy button and the Services CTAs already close. Sell/Send
  // are outflows and stay open in every state (the rail-switch doc).
  useEffect(() => {
    if (!market) return;
    const a = searchParams?.get('a');
    if (a === 'buy') {
      // buy.go/ask.go RequireInflowOpen: a deep link must respect the SAME gate
      // the buttons do, including delinquency — canBuy/canAsk already fold in
      // pause, wind-down and delivery standing.
      if (market.canBuy) setDialog('buy');
    } else if (a === 'sell' || a === 'send') {
      setDialog(a);
    } else if (a === 'spend' && market.services[0] && market.canAsk) {
      setService(market.services[0]);
      setDialog('ask');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, hasMarket]);

  // Market interstitial — first view per creator, per session. Only once there
  // is a real market: interrupting someone to explain a market that failed to
  // load, or does not exist, is noise.
  useEffect(() => {
    if (typeof window === 'undefined' || !market) return;
    const key = `lumen-token-inter-${handle}`;
    if (!window.sessionStorage.getItem(key)) {
      setDialog('inter');
      window.sessionStorage.setItem(key, '1');
    }
    // `market` itself is deliberately NOT a dependency: it is a fresh object on
    // every 30s poll, and depending on it would re-open this dialog over and
    // over. hasMarket is the only thing that actually gates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, hasMarket]);

  if (status === 'unavailable') return <MarketUnavailable />;
  if (status === 'loading') return <MarketLoading />;
  if (status === 'error' || !market) return <MarketReadFailed />;
  if (status === 'missing') return <MarketMissing handle={handle} />;

  const d = market.delivery;
  const supplyPct = market.cap > 0 ? Math.min(100, Math.round((market.supply / market.cap) * 100)) : 0;
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
  const writeBlockedReason: string | null = !live.loggedIn
    ? 'Sign in to trade this token.'
    : live.isLite
      ? 'This account has no Hive keys yet, so it can’t sign a transaction. Upgrade to a full account to trade.'
      : null;
  const writesBlocked = writeBlockedReason !== null;

  const handleBuy = async (usd: number, maxTotalUsd?: number): Promise<void> => {
    const local = buyQuote(usd, market);
    if (local.tokens <= 0) throw new Error('That budget does not cover a whole token at the current price.');
    const authoritative = await live.quoteBuy(local.tokens);
    // The user's own ceiling wins. If live state has moved past it between the
    // preview and this click, REFUSE here rather than signing an allowance
    // above what they agreed to — a transfer.allow is the buyer's only
    // slippage protection on this rail.
    if (maxTotalUsd !== undefined && authoritative.totalDueHbd > maxTotalUsd) {
      throw new Error('The price moved above your limit.');
    }
    await live.buy(local.tokens, maxTotalUsd ?? authoritative.totalDueHbd);
  };

  /**
   * No minNet is passed, deliberately. sell.go treats an absent minNet as NO
   * floor, which is the escape hatch that keeps an exit from ever being
   * trapped; binding it to the previewed number would make a sell REVERT
   * whenever the price ticked between preview and execution, which is strictly
   * worse for a seller than filling a few cents lower. quoteSell is still
   * called first so a closed rail (a market in wind-down, where refund() is the
   * door instead) fails HERE with its real reason rather than on-chain.
   */
  const handleSell = async (tokens: number): Promise<void> => {
    await live.quoteSell(tokens);
    await live.sell(tokens);
  };

  const rightRail = (
    <div className="flex flex-col gap-5 pt-[26px]">
      <div className="rounded-[18px] border border-[#ebebeb] bg-white p-5">
        <div className="mb-3 text-[14.5px] font-bold text-[#161511]">How this works</div>
        <div className="flex flex-col gap-3.5">
          {[
            'Buy the creator’s token — the price rises as more is bought.',
            'Spend tokens on their work — a question, a code review, a day of building — priced in dollars.',
            'As more people buy in, the token can appreciate; the floor is the least you’re guaranteed back.'
          ].map((line, i) => (
            <div key={i} className="flex gap-3">
              <span className="font-serif font-bold text-[#c0392b]">{i + 1}</span>
              <span className="text-[13px] leading-[1.5] text-[#3f4650]">{line}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-[18px] border border-[#ebebeb] bg-white p-5">
        <div className="mb-1.5 text-xs text-[#6b7280]">Reserve backing</div>
        <div className="mb-0.5 text-[20px] font-bold tabular-nums text-[#161511]">{usdWhole(market.reserveUsd)}</div>
        <p className="font-serif text-[12.5px] leading-[1.5] text-[#9ca3af]">Held in reserve behind every token — the source of the floor.</p>
      </div>
    </div>
  );

  return (
    <TokenShell rightRail={rightRail}>
      {/* 1. Creator header */}
      <div className="mb-5 flex items-center gap-4">
        <span className="h-[60px] w-[60px] flex-shrink-0 rounded-2xl" style={{ background: avatarColor }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className="text-xl font-bold text-[#161511]">@{handle}</span>
          </div>
          {/* No bio and no reputation score here: neither is contract state, and
              the Hive profile is not read on this route yet. The demo showed
              both from a fixture. Rendering a made-up one-liner under someone's
              name is the worst kind of fabrication — it reads as their words. */}
        </div>
        <button
          onClick={toggleFollow}
          className={`rounded-[11px] border px-5 py-2.5 text-sm font-semibold ${following ? 'border-[#c0392b] bg-[#fef2f0] text-[#c0392b]' : 'border-[#e4e6e9] bg-white text-[#3f4650] hover:bg-[#f6f7f8]'}`}
        >
          {following ? 'Following' : 'Follow'}
        </button>
      </div>

      {/* Wind-down banner (design brief ui-prompts/tokens/1-TOKEN-PAGE.md,
          WIND-DOWN/FROZEN state): tells a visitor WHY buying/asking is closed
          and that selling stays open, rather than leaving the disabled Buy
          button to speak for itself. */}
      {market.windingDown ? (
        <div className="mb-4 rounded-[14px] border border-[#f6e2c4] bg-[#fdf6ec] px-5 py-3.5 text-[13.5px] font-semibold text-[#b45309]">
          This creator’s market is winding down — buying and new asks are closed; sell/refund at the floor stays open.
        </div>
      ) : market.delinquentUntilBlock !== null ? (
        // delivery.go: RequireInflowOpen also refuses while a creator is
        // DELINQUENT. Without this the Buy button would simply be dead with no
        // reason given, which reads as a broken page — and saying it out loud is
        // also what makes the gate do its job.
        <div className="mb-4 rounded-[14px] border border-[#f6e2c4] bg-[#fdf6ec] px-5 py-3.5 text-[13.5px] font-semibold text-[#b45309]">
          This creator has left too many paid asks unanswered, so buying and new asks are paused for now. Selling,
          refunds and reclaims are unaffected.
        </div>
      ) : null}

      {/* 2. Token market — centerpiece */}
      <div className="mb-4 rounded-[20px] border border-[#ebebeb] bg-white p-[26px] shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
        <div className="mb-[18px] flex items-center gap-2.5">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[12px] font-extrabold text-white"
            style={{ background: avatarColor }}
          >
            ◆
          </span>
          <span className="text-[15px] font-bold text-[#161511]">@{market.handle} token</span>
        </div>
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <div>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-[44px] font-extrabold tabular-nums tracking-[-0.02em] text-[#161511]">{usdPrice(market.priceUsd)}</span>
              {/* Weekly change needs price HISTORY, which only the indexer can
                  serve — the client method now exists (MagiIndexerClient
                  .priceHistoryOf) but this view is not wired to it yet, and
                  live/adapt.ts keeps
                  changePctWeek null for exactly this reason). An arrow computed
                  from a single current price would be invented. */}
              {market.changePctWeek !== null ? (
                <span className={`inline-flex items-center gap-1 text-[15px] font-bold ${market.changePctWeek >= 0 ? 'text-[#2f7d4f]' : 'text-[#c0392b]'}`}>
                  {market.changePctWeek >= 0 ? '▲' : '▼'} {Math.abs(market.changePctWeek)}%
                </span>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-[18px]">
              <div>
                <div className="mb-0.5 text-xs text-[#6b7280]">Market cap</div>
                <div className="text-[19px] font-bold tabular-nums text-[#161511]">{usdWhole(market.marketCapUsd)}</div>
              </div>
              <div className="h-[34px] w-px bg-[#ececec]" />
              <div>
                <div className="mb-0.5 flex items-center gap-1.5 text-xs text-[#6b7280]">
                  Floor
                  <span
                    title="The least you'd get back if the market wound down — the reserve behind each token. Your honest downside."
                    className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-[#f1f3f5] text-[9px] text-[#9ca3af]"
                  >
                    ?
                  </span>
                </div>
                {/* Floor beside price, equal size, muted — never colored. */}
                <div className="text-[19px] font-bold tabular-nums text-[#6b7280]">{usdPrice(market.floorUsd)}</div>
              </div>
            </div>
            <div className="mt-[18px]">
              <div className="mb-1.5 flex justify-between text-xs tabular-nums text-[#6b7280]">
                <span>
                  {market.supply.toLocaleString('en-US')} of {market.cap.toLocaleString('en-US')} tokens issued
                </span>
                <span>{supplyPct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-md bg-[#f1f3f5]">
                <div className="h-full bg-[#3a5a80]" style={{ width: `${supplyPct}%` }} />
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setDialog('buy')}
                disabled={!market.canBuy || market.supply >= market.cap || writesBlocked}
                title={writeBlockedReason ?? undefined}
                className="flex-1 rounded-xl bg-[#c0392b] py-3.5 text-[15px] font-bold text-white hover:bg-[#a5301f] disabled:opacity-50"
              >
                Buy
              </button>
              <button
                onClick={() => setDialog('sell')}
                disabled={writesBlocked}
                title={writeBlockedReason ?? undefined}
                className="flex-1 rounded-xl border border-[#e4e6e9] bg-white py-3.5 text-[15px] font-semibold text-[#3f4650] hover:bg-[#f6f7f8] disabled:opacity-50"
              >
                Sell
              </button>
            </div>
            {writeBlockedReason ? (
              <div className="mt-2.5 text-center text-[12.5px] text-[#6b7280]">{writeBlockedReason}</div>
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
                <div className="mt-2 text-center text-[11.5px] text-[#9ca3af]">
                  {market.chart.length} trades · price is set by the curve, not by a last-traded quote
                </div>
              </>
            ) : (
              <div className="flex h-full min-h-[160px] flex-col justify-center rounded-[14px] border border-dashed border-[#e4e6e9] px-5 py-6 text-center">
                <div className="text-[13.5px] font-semibold text-[#6b7280]">No price history yet</div>
                <p className="mt-1 text-[12.5px] leading-[1.5] text-[#9ca3af]">
                  The price above is live from the curve. A chart appears once this market has traded more than once.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3. Trust record */}
      <div className="mb-4 rounded-[18px] border border-[#ebebeb] bg-white p-6 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
        <div className="mb-3.5 font-serif text-[19px] font-semibold text-[#161511]">Delivery record</div>
        {d.available ? (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {d.marks.map((answered, i) => (
                <span key={i} className={`h-[18px] w-[18px] rounded-[5px] ${answered ? 'bg-[#2f7d4f]' : 'border-[1.5px] border-[#d5d8dd] bg-white'}`} />
              ))}
            </div>
            <div className="text-base tabular-nums text-[#2a2822]">
              <strong>{d.completionPct}% completion rate</strong> — completed {d.answered} of {d.total} · usually within{' '}
              <strong>{d.typicalResponse}</strong>.
            </div>
            <div className="mt-1.5 text-[12.5px] text-[#9ca3af]">Why the token is worth holding — this is what you’re really buying.</div>
          </>
        ) : (
          <div className="rounded-[11px] border border-dashed border-[#e4e6e9] px-4 py-3 text-[13px] text-[#9ca3af]">Delivery record unavailable</div>
        )}
      </div>

      {/* 4. Services */}
      <div className="mb-4 rounded-[18px] border border-[#ebebeb] bg-white p-6 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
        <div className="mb-3.5 text-xs font-bold uppercase tracking-[0.05em] text-[#9ca3af]">What you can do with the token</div>
        <div className="mb-3.5 flex flex-col gap-2.5">
          {market.services.map((sv) => (
            <div key={sv.key} className="flex items-center gap-3.5 rounded-[14px] border border-[#ebebeb] px-[18px] py-4">
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[11px] bg-[#f4f5f7] text-[#c0392b]">◆</span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-bold text-[#161511]">{sv.name}</div>
                <div className="text-[13px] text-[#6b7280]">{sv.desc}</div>
              </div>
              <div className="flex-shrink-0 text-right">
                <div className="text-[15px] font-bold tabular-nums text-[#161511]">{usdWhole(sv.usd)}</div>
                {/* The TOKEN LEG only (88% of the posted price) — the other 12% is a
                    separate HBD commission (serviceQuote/ask.go splitFace, USER RULING
                    2026-07-27), never itself paid in tokens. */}
                <div className="text-xs tabular-nums text-[#9ca3af]">≈ {tok(serviceQuote(sv.usd, market.priceUsd).tokens)} tokens</div>
              </div>
              {market.windingDown ? (
                // ask.go Ask -> RequireInflowOpen: closed for the whole wind-down, the same gate Buy is behind.
                <span className="flex-shrink-0 rounded-full bg-[#fdf6ec] px-3 py-1.5 text-[12px] font-semibold text-[#b45309]">Winding down</span>
              ) : !market.canAsk ? (
                <span className="flex-shrink-0 rounded-full bg-[#fdf6ec] px-3 py-1.5 text-[12px] font-semibold text-[#b45309]">Paused</span>
              ) : (
                <button
                  onClick={() => openAsk(sv)}
                  disabled={writesBlocked}
                  title={writeBlockedReason ?? undefined}
                  className="flex-shrink-0 rounded-[11px] bg-[#1a1a17] px-[18px] py-2.5 text-[13.5px] font-semibold text-white hover:bg-black disabled:opacity-40"
                >
                  {sv.cta}
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="font-serif text-[13px] leading-[1.55] text-[#6b7280]">
          Prices are set in dollars — the total you’ll pay. 12% goes to Lumen as a separate platform commission, paid in
          HBD; the rest is spent in tokens, and as the token’s price rises a service costs fewer of them.
        </p>
      </div>

      {/* 5. Your position */}
      {market.position ? (
        <div className="mb-4 rounded-[18px] border border-[#ebebeb] bg-[#faf9f6] px-6 py-[22px]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="text-[15px] tabular-nums text-[#3f4650]">
              You hold <strong className="text-[#161511]">{tok(market.position.tokens)} tokens</strong> · worth{' '}
              <strong className="text-[#161511]">{usdPrice(market.position.valueUsd)}</strong> · floor value{' '}
              <strong className="text-[#161511]">{usdPrice(market.position.floorValueUsd)}</strong>
            </div>
            <div className="flex gap-2.5">
              <button
                onClick={() => setDialog('sell')}
                disabled={writesBlocked}
                title={writeBlockedReason ?? undefined}
                className="rounded-[10px] border border-[#e4e6e9] bg-white px-4 py-2.5 text-[13px] font-semibold text-[#3f4650] hover:bg-[#f1f3f5] disabled:opacity-50"
              >
                Sell
              </button>
              <button
                onClick={() => setDialog('send')}
                disabled={writesBlocked}
                title={writeBlockedReason ?? undefined}
                className="rounded-[10px] border border-[#e4e6e9] bg-white px-4 py-2.5 text-[13px] font-semibold text-[#3f4650] hover:bg-[#f1f3f5] disabled:opacity-50"
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
      <p className="font-serif text-[12.5px] leading-[1.6] text-[#9ca3af]">
        This token’s price floats — it can go up or down. The floor above is the least you’re guaranteed back. If you sell
        soon after buying, an early-exit fee applies (it fades to zero over 6 weeks).
      </p>

      <TokenModals
        dialog={dialog}
        market={market}
        service={service}
        onBuy={handleBuy}
        onSell={handleSell}
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
        onClose={() => setDialog(null)}
      />
    </TokenShell>
  );
};

export default TokenMarketView;
