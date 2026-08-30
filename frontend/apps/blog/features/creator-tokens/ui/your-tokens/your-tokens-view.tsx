'use client';

/**
 * Your Tokens — the cross-creator portfolio.
 *
 * WIRED TO THE REAL CHAIN LAYER (2026-07-28). It previously read
 * market/store.ts, an in-memory demo, and rendered a fabricated sparkline,
 * weekly change and creator bio per row.
 *
 * This view asks a holder -> creators question, and contract state is keyed the
 * other way, so it reads the Magi indexer's reverse index (lumen_ct_balances).
 * When that is unreachable or unconfigured the page SAYS SO rather than
 * rendering an empty portfolio as real — which would tell someone their tokens
 * are gone.
 *
 * Still deliberately absent: the sparkline and every "% this week" figure. Price
 * history IS available now (lumen_ct_price_history), but this list makes no
 * per-market read, so drawing one here would mean a query per row for a
 * decoration. The token page is where the chart belongs.
 *
 * ★ AND THAT IS ALSO WHY THE NEW PRICE-MOVEMENT INDICATOR IS NOT ON THESE ROWS
 * (2026-08-27). It is derived from the price history the chart already fetches
 * (../../market/price-change.ts), so putting it here would cost exactly the
 * per-row query this file has refused twice. The token page carries it, beside
 * the chart a reader can check it against.
 *
 * ★★ THE FLOOR FIGURES ON THIS SCREEN ARE HIDDEN FOR LAUNCH (owner, 2026-08-27),
 * behind ../../backing-visibility.ts: the headline total, the per-row figure and
 * the closing paragraph that defined it. Nothing is deleted and nothing about
 * what a redeem pays out changes.
 */

import { FC, useState } from 'react';
import { Link } from '@hive/ui';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useLivePortfolio } from '../../live/use-live-portfolio';
import { displayHandle, routeHandle, usdFromHbd } from '../../live/adapt';
import type { Ask, HolderPosition, MarketPrice } from '../../types';
import { useTokenPriceChips } from '../../live/use-token-price-chips';
import { healthWordFor } from '../../market/market-health';
import { usdPrice } from '../../market/format';
// ★★ THE FLOOR FIGURES ARE HIDDEN FOR LAUNCH (owner, 2026-08-27), on every
// surface at once, from one flag. This screen led with one, carried one per row
// and explained it in a closing paragraph; all three are behind the flag below.
import { SHOW_BACKING_FIGURES } from '../../backing-visibility';
import TokenShell from '../token-shell';
import { writeFailureMessage } from '../write-failure';
import { MeritumEligibilityNotice, useMeritumEligibility } from '../meritum-eligibility';

// ★ toFixed(2), matching token-market-view, token-modals and creator-studio (2026-08-23).
// This file alone printed 30.0 where the other three print 30.00 for the same balance,
// so the same holding read as two different numbers depending on which screen you were on.
const tok = (n: number) => n.toFixed(2);

/**
 * THE CLOSING EXIT DISCLOSURE, in both branches of the launch flag.
 *
 * ★ WHY IT IS UP HERE AND NOT INLINE. It is the only sentence on this screen
 * that both makes a claim about money and had to CHANGE when the figure was
 * hidden: it ended "redeem at the floor. The floor value is what the reserve
 * would pay out then", which points at a number this page no longer shows. A
 * string written inside the component is a string no test can read (the reason
 * ../token-page/disclosure-copy.ts exists); naming it here gives the self-test
 * something to assert on without moving wallet copy into a token-page module.
 *
 * ★ The shown branch is the ORIGINAL, verbatim, em dash included, because it is
 * pre-existing copy that returns unchanged when the flag flips. The house
 * no-dash rule binds copy written or changed today, which is the hidden branch,
 * and that one carries none.
 */
const EXIT_NOTE_WITH_BACKING =
  'Token prices float and you can lose money. You can exit two ways: sell on the curve while the market is open, at the curve’s price, after a 10% trade fee and any early-exit fee; or, once a market winds down, redeem at the floor. The floor value is what the reserve would pay out then; it is not a price you can sell at while the market is running.';

/**
 * The same disclosure with every reference to the hidden figure gone.
 *
 * Both exit routes survive, both fees survive, and the sentence that mattered
 * most survives in the audited form `exitRoutesNote` already uses: neither route
 * is a fixed price. What goes is the definition of a number that is not on the
 * screen to be defined.
 */
// ★ 2026-08-30 (B3, copy set A): "redeem your share of the reserve" -> a pro-rata
// slice of whatever it holds then, less the fee, and below what you paid.
const EXIT_NOTE_BACKING_HIDDEN =
  'Token prices float and you can lose money. You can exit two ways: sell on the curve while the market is open, at the curve’s price, after a 10% trade fee and any early-exit fee; or, if a market winds down, redeem a pro-rata slice of whatever the reserve holds then, less any early-exit fee, which will be less than you paid. Neither is a fixed price.';

const Unavailable: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-card border border-dashed border-line-11 px-5 py-6 text-center text-[14px] leading-[22px] text-ink-14">{children}</div>
);

/**
 * ★★ THE SIXTH MARKET-HEALTH SURFACE (2026-08-30, B4; found by 57's UI sweep).
 * This row drew three hard-coded links, Buy / Sell / Send, for every holding,
 * with no phase check anywhere in this file: a holder of a frozen, retired,
 * paused, delinquent or sold-out market saw a live-looking Buy on their OWN
 * portfolio, clicked it, and the token page (token-market-view.tsx:174-191,
 * which only opens the dialog when `market.canBuy`) silently opened nothing.
 * A dead control with no explanation, on the one screen that is about the
 * holder's own money.
 *
 * It could not consult health as it stood: `HolderPosition` (types.ts) carries
 * no phase, no canBuy, no cap. Rather than widen the wallet read, the view
 * makes ONE batched `useTokenPriceChips` read over every creator it holds (the
 * same request the feed makes; six state keys per creator plus the head, one
 * POST for the whole list) and threads the answer in as `price`. That is one
 * extra chain read per /wallet/tokens visit; the alternative, one readMarket
 * per row, is N. Stated rather than absorbed: 57 asked to be told.
 *
 * `price` undefined or not 'ready' (loading, failed read) keeps the three links
 * exactly as before: the destination defends itself, and a failed read must
 * not read as a closed market. Sell becomes Redeem only when the market is
 * winding down (retired today; under the A1 shape, Retire only), the same
 * switch token-market-view.tsx:702 makes.
 */
const HoldingRow: FC<{ h: HolderPosition; price?: MarketPrice }> = ({ h, price }) => (
  <div className="flex flex-wrap items-center gap-4 rounded-card border border-line-9 bg-surface-1 px-5 py-4">
    <span className="h-11 w-11 flex-shrink-0 rounded-control bg-surface-28" />
    <div className="min-w-0 flex-1">
      <Link href={`/creators/${routeHandle(h.creator)}`} className="text-[15px] leading-[24px] font-bold text-ink-2 hover:text-ink-brand-6">
        @{displayHandle(h.creator)}
      </Link>
      {/* No bio line: it is not contract state, and the Hive profile is not read on this route. */}
    </div>
    <div className="text-right tabular-nums">
      <div className="text-[15px] leading-[24px] font-bold text-ink-2">{tok(h.tokensHeld)} tokens</div>
      {/* The FLOOR is net of this position's own exit tax. The least you're
          guaranteed back. There is deliberately no "current value" line: that
          needs the creator's live curve price, which is a per-market read this
          list does not make. The token page shows it. */}
      {/* ★ Hidden for launch (owner, 2026-08-27). The row keeps the token count,
          which is the fact this list exists to state, and the three actions. The
          figure returns here with the flag; nothing about it is deleted. */}
      {SHOW_BACKING_FIGURES ? (
        <div className="text-caption text-ink-14">floor {usdPrice(usdFromHbd(h.floorValueHbd))}</div>
      ) : null}
    </div>
    <div className="flex items-center gap-2">
      {price && price.status === 'ready' && price.health !== null && price.health !== 'open' ? (
        // The state word in the Buy slot, same words as every other surface
        // (market/market-health.ts). Not a link: there is nothing to buy.
        <span
          className="rounded-control border border-line-warn-4 bg-surface-warn-2 px-3 py-2 text-caption font-semibold text-ink-warn-3"
          data-testid="holding-health"
        >
          {healthWordFor(price.health)}
        </span>
      ) : (
        <Link
          href={`/creators/${routeHandle(h.creator)}?a=buy`}
          className="rounded-control border border-line-11 bg-surface-1 px-3 py-2 text-caption font-semibold text-ink-7 hover:bg-surface-23"
        >
          Buy
        </Link>
      )}
      <Link
        href={`/creators/${routeHandle(h.creator)}?a=${price?.health === 'closed' ? 'redeem' : 'sell'}`}
        className="rounded-control border border-line-11 bg-surface-1 px-3 py-2 text-caption font-semibold text-ink-7 hover:bg-surface-23"
      >
        {price?.health === 'closed' ? 'Redeem' : 'Sell'}
      </Link>
      <Link
        href={`/creators/${routeHandle(h.creator)}?a=send`}
        className="rounded-control border border-line-11 bg-surface-1 px-3 py-2 text-caption font-semibold text-ink-7 hover:bg-surface-23"
      >
        Send
      </Link>
    </div>
  </div>
);

const askStyle: Record<string, { label: string; cls: string }> = {
  awaiting: { label: 'Awaiting', cls: 'text-ink-warn-3' },
  // The dead zone between the deadline and the reclaim window opening: nothing
  // is actionable yet, so it reads as awaiting to the holder.
  expired: { label: 'Awaiting', cls: 'text-ink-warn-3' },
  answered: { label: 'Answered', cls: 'text-ink-ok-2' },
  reclaimable: { label: 'Reclaimable', cls: 'text-ink-warn-3' },
  reclaimed: { label: 'Reclaimed', cls: 'text-ink-14' },
  // Distinct from `reclaimed` on purpose: the creator said no promptly and
  // handed everything back, including the commission.
  declined: { label: 'Declined & refunded', cls: 'text-ink-14' }
};

/**
 * The rating strip. It appears on every DELIVERED job, and it is the buyer's
 * only recourse: marking a job delivered is unilateral and pays the creator
 * immediately, so nothing but this records whether the work was real.
 */
const RateStrip: FC<{ onRate: (score: number) => Promise<void>; busy: boolean }> = ({ onRate, busy }) => {
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (done) return <div className="mt-3 text-caption font-semibold text-ink-ok-2">Thanks. Your rating is recorded on-chain.</div>;
  return (
    <div className="mt-3 border-t border-line-2 pt-3">
      <div className="mb-2 text-caption text-ink-10">How did it go? Your rating is the creator’s public record.</div>
      <div className="flex items-center gap-1.5">
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            key={score}
            disabled={busy}
            onClick={async () => {
              setFailure(null);
              try {
                await onRate(score);
                setDone(true);
              } catch (err) {
                // The REAL reason, not a guess. See ../write-failure.ts.
                setFailure(writeFailureMessage(err, 'Your rating didn’t go through.'));
              }
            }}
            className="h-8 w-8 rounded-control border border-line-11 bg-surface-1 text-caption font-bold text-ink-7 hover:bg-surface-23 disabled:opacity-50"
          >
            {score}
          </button>
        ))}
        <span className="ml-1 text-caption text-ink-14">1 = poor · 5 = excellent</span>
      </div>
      {failure ? (
        <div className="mt-2 text-caption font-semibold text-ink-brand-6">{failure}</div>
      ) : null}
    </div>
  );
};

const AskCard: FC<{ a: Ask; onReclaim: () => Promise<void>; onRate: (score: number) => Promise<void>; busy: boolean; rating: boolean }> = ({
  a,
  onReclaim,
  onRate,
  busy,
  rating
}) => {
  const s = askStyle[a.status] ?? askStyle.awaiting;
  const reclaimable = a.status === 'reclaimable';
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className={`rounded-card border bg-surface-1 px-5 py-4 ${reclaimable ? 'border-line-warn-2 bg-surface-warn-4' : 'border-line-9'}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[15px] leading-[24px] font-semibold text-ink-2">
          Ask · <span className="text-ink-8">@{displayHandle(a.creator)}</span>
        </div>
        <div className={`text-caption font-bold ${s.cls}`}>{s.label}</div>
      </div>
      <div className="mt-1 text-caption tabular-nums text-ink-10">
        {a.tokensEscrowed.toFixed(2)} tokens{' '}
        {a.status === 'answered' ? 'paid to the creator' : a.status === 'reclaimed' || a.status === 'declined' ? 'returned to you' : 'in escrow'}
      </div>
      {/* The chain carries a REFERENCE, not the brief — this contract
          facilitates payment and reputation; the work is arranged between the
          two parties directly (USER RULING 2026-07-28). */}
      {a.contentHash ? <div className="mt-1 font-mono text-caption text-ink-14">ref {a.contentHash}</div> : null}
      {a.status === 'answered' ? <RateStrip onRate={onRate} busy={rating} /> : null}
      {reclaimable ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-caption text-ink-warn-2">You get {a.tokensEscrowed.toFixed(2)} tokens back to your balance, in full.</div>
          <button
            onClick={async () => {
              if (busy) return;
              setFailure(null);
              try {
                await onReclaim();
              } catch (err) {
                // The REAL reason, not a guess. See ../write-failure.ts.
                setFailure(writeFailureMessage(err, 'That reclaim didn’t go through.'));
              }
            }}
            disabled={busy}
            className="rounded-control bg-surface-warn-11 px-4 py-2 text-caption font-semibold text-ink-27 hover:bg-surface-warn-13 disabled:opacity-50"
          >
            {busy ? 'Confirm in your wallet…' : 'Get your tokens back'}
          </button>
        </div>
      ) : null}
      {failure ? (
        <div className="mt-2 text-caption font-semibold text-ink-brand-6">{failure}</div>
      ) : null}
    </div>
  );
};

const YourTokensView: FC = () => {
  const eligibility = useMeritumEligibility();
  const [tab, setTab] = useState<'holdings' | 'asks'>('holdings');
  const p = useLivePortfolio();
  // One batched health+price read for every creator held (see HoldingRow's
  // doc). Empty list -> the query is disabled and costs nothing.
  const { prices } = useTokenPriceChips(p.holdings.map((h) => h.creator));
  // F14 fix: the retry affordance for p.sessionUnavailable below — re-fires
  // /api/users/me itself, matching feed-tabs.tsx's established
  // identity.retrySession pattern for the identical third state.
  const { retrySession } = useUserClient();

  const floorTotalUsd = p.holdings.reduce((sum, h) => sum + usdFromHbd(h.floorValueHbd), 0);
  const reclaimable = p.asks.filter((a) => a.status === 'reclaimable').length;

  const rightRail = (
    <div className="flex flex-col gap-5 pt-[26px]">
      <div className="rounded-panel border border-line-9 bg-surface-1 p-5">
        <div className="mb-1.5 font-serif text-lg font-semibold text-ink-2">Find more creators</div>
        <p className="mb-4 font-serif text-[14px] leading-[22px] text-ink-10">Hold their token, spend it on their work.</p>
        <Link href="/creators" className="block rounded-control bg-surface-brand-12 py-3 text-center text-sm font-semibold text-ink-27 hover:bg-surface-brand-16">
          Discover creators →
        </Link>
      </div>
    </div>
  );

  return (
    <TokenShell rightRail={rightRail}>
      <h1 className="font-serif text-[34px] font-semibold tracking-[-0.015em] text-ink-2">Your Meritum tokens</h1>

      {p.unavailable ? (
        <div className="mt-5">
          <Unavailable>Meritum isn’t available on this build yet.</Unavailable>
        </div>
      ) : !p.loggedIn && p.sessionUnavailable ? (
        // F14 fix: OUR session check failed, not a genuine sign-out — checked
        // before the `!p.loggedIn` branch below, which would otherwise tell an
        // already-verified holder to sign in. Driven live: this persisted
        // until the next focus/reconnect, not a flicker (use-user-core.ts's
        // own doc on the flag).
        <div className="mt-5">
          <Unavailable>
            We couldn’t check your account, so we can’t show what you hold.{' '}
            <button onClick={retrySession} className="font-semibold text-ink-brand-6 underline">
              Try again
            </button>
          </Unavailable>
        </div>
      ) : !p.loggedIn ? (
        <div className="mt-5">
          <Unavailable>Sign in to see the Meritum you hold.</Unavailable>
        </div>
      ) : p.accountsFailed ? (
        // The wallet lookup itself failed. NOT "you hold nothing" — that would
        // tell someone their tokens are gone.
        <div className="mt-5">
          <Unavailable>
            We couldn’t check which wallets are linked to this account, so we can’t show what you hold. Nothing is
            wrong with your tokens. Reload in a moment.
          </Unavailable>
        </div>
      ) : p.accountsLoading ? (
        // ★ STILL LOOKING (2026-08-07). Without this branch, the "Google only"
        // verdict below fired while the wallet lookup was merely IN FLIGHT — an
        // EVM-wallet account was told for ~9 seconds that it signs in with Google
        // and cannot hold tokens. `canHold` defaults to false before the answer
        // arrives, which is indistinguishable from a real "no wallet" verdict
        // unless loading is checked first.
        <div className="mt-5">
          <Unavailable>Checking which wallets are linked to this account…</Unavailable>
        </div>
      ) : p.isLite && !p.canHold ? (
        // ONLY a Google-only lite account genuinely cannot hold: there is no
        // keypair behind it, so Magi has no account to key a balance to.
        //
        // This branch used to fire for EVERY lite account, which became wrong the
        // moment balances started resolving per bound wallet: a Bitcoin- or
        // Ethereum-wallet holder was told they could not hold tokens while the
        // data layer was correctly reading the ones they did hold.
        // ★ 2026-08-16, owner: one notice, one source of copy, and it names BOTH
        // ways out (link a wallet to hold, upgrade to launch) instead of leaving
        // the reader to work out which one they want.
        <div className="mt-5">
          <MeritumEligibilityNotice surface="hold" who={eligibility} />
        </div>
      ) : (
        <>
          {/* Signing is live per chain (chainCanSign: evm and btc), so this is
              no longer "wallets cannot sign". It is the remaining case: an
              identity that holds tokens at its own `did:pkh` but has no chain
              bound that can sign — a Google-only account, or a chain not yet
              enabled. Stated up front rather than discovered on a click. */}
          {p.isLite && !p.canSign ? (
            <div className="mt-5">
              <MeritumEligibilityNotice surface="hold" who={eligibility} />
            </div>
          ) : null}
          {/* The headline is the FLOOR total, not a market value: a market value
              needs each creator's live curve price and this list makes no
              per-market read. The floor is a number we actually have — and it is
              the honest one to lead with anyway. */}
          {/* ★★ HIDDEN FOR LAUNCH (owner, 2026-08-27) — the figure AND its label
              together. The label is a definition of the number beside it, so
              hiding one without the other leaves a sentence describing a blank.

              ★ AND NOTHING REPLACES IT, deliberately. The obvious substitute is a
              total at today's price, and this list cannot compute one: it makes
              no per-market read, which is the whole reason the floor led here in
              the first place (see the note above, and the file header's refusal
              to query per row). Inventing a headline would be worse than having
              none. The count line below still leads the page, and the
              holdings-unavailable case still says so in words rather than through
              a placeholder dash. */}
          {SHOW_BACKING_FIGURES ? (
            <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-1">
              <div className="text-display font-bold tabular-nums text-ink-2">{p.holdingsUnavailable ? '—' : usdPrice(floorTotalUsd)}</div>
              <div className="pb-1.5 text-[15px] leading-[24px] tabular-nums text-ink-10">Floor value: what the reserve would pay out if the market wound down</div>
            </div>
          ) : null}
          <p className="mt-1 text-[14px] leading-[22px] text-ink-10">
            {p.holdingsUnavailable ? 'Your holdings can’t be loaded right now.' : `You hold tokens from ${p.holdings.length} ${p.holdings.length === 1 ? 'creator' : 'creators'}.`}
          </p>

          {reclaimable > 0 ? (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-control border border-line-warn-2 bg-surface-warn-4 px-4 py-3">
              <span className="text-[14px] leading-[22px] font-semibold text-ink-warn-3">
                You have {reclaimable} ask{reclaimable > 1 ? 's' : ''} with tokens to reclaim.
              </span>
              <button onClick={() => setTab('asks')} className="text-caption font-semibold text-ink-warn-3 underline">
                View
              </button>
            </div>
          ) : null}

          {/* ★ WARM TAB TREATMENT (illumination SPEC.md §1, owner 2026-08-21: "fill the
             creators, wallet tokens and proposals tab bar gap"). Track on --amb-1 so it
             "follows the ground it sits on, never lighter" (§3); active pill on --lum-1
             with --lift-1 plus a soft warm glow. One step weaker than the nav rail (§4) —
             the rail is the anchor and the only surface at full strength.
          
             ★ THE GLOW IS AN INLINE STYLE, NOT A TAILWIND CLASS, and that is not a
             preference: a `/` inside a Tailwind arbitrary value is the OPACITY shorthand,
             so `shadow-[...rgb(var(--lum)/.85)]` never compiles and no rule is emitted at
             all. Measured on the feed's own tab bar, which shipped with `box-shadow: none`
             until it was caught. */}
          <div className="mb-4 mt-5 inline-flex gap-1.5 rounded-xl border border-line-6 bg-[var(--amb-1)] p-[5px]">
            {(['holdings', 'asks'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
                style={tab === t ? { boxShadow: 'var(--lift-1), 0 0 12px -5px rgb(var(--lum) / 0.85)' } : undefined}
                className={`rounded-lg px-[18px] py-2 text-[14px] leading-[22px] font-semibold capitalize ${
                  tab === t ? 'bg-[var(--lum-1)] text-ink-2' : 'text-ink-10'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'holdings' ? (
            <>
              <div className="flex flex-col gap-2.5">
                {p.isLoading ? (
                  <Unavailable>Loading…</Unavailable>
                ) : p.holdingsUnavailable ? (
                  // NOT "you hold nothing" — this is exactly the distinction the
                  // discriminated read exists to preserve.
                  <Unavailable>
                    We can’t load your holdings right now. The index that lists every market you’re in is
                    unreachable. Your tokens are safe on-chain; each creator’s own token page still shows your balance.
                  </Unavailable>
                ) : p.holdings.length === 0 ? (
                  <p className="py-8 text-center font-serif text-sm italic text-ink-14">
                    You don’t hold any Meritum yet. Browse creators and buy in to start.
                  </p>
                ) : (
                  p.holdings.map((h) => <HoldingRow key={`${h.holder}:${h.creator}`} h={h} price={prices.get(h.creator)} />)
                )}
              </div>
              {/* ★ The one sentence on this screen that had to change with the
                  figure, not just disappear: it ended by DEFINING the floor
                  value. Both branches are named constants at the top of this
                  file so a self-test can read them. */}
              <p className="mt-4 font-serif text-caption text-ink-14">
                {SHOW_BACKING_FIGURES ? EXIT_NOTE_WITH_BACKING : EXIT_NOTE_BACKING_HIDDEN}
              </p>
            </>
          ) : (
            <div className="flex flex-col gap-2.5">
              {p.isLoading ? (
                <Unavailable>Loading…</Unavailable>
              ) : p.asksUnavailable ? (
                <Unavailable>
                  We can’t load your asks right now. The index that lists them is unreachable. Nothing is lost; a
                  creator’s own page still shows the asks made to them.
                </Unavailable>
              ) : p.asks.length === 0 ? (
                <p className="py-8 text-center font-serif text-sm italic text-ink-14">
                  No asks yet. Spend your tokens on a creator’s service from their token page.
                </p>
              ) : (
                p.asks.map((a) => (
                  <AskCard
                    key={a.id}
                    a={a}
                    busy={p.isReclaiming}
                    rating={p.isRating}
                    onReclaim={() => p.reclaim({ creator: a.creator, seq: a.seq, deadlineBlock: a.deadlineBlock })}
                    onRate={(score) => p.rate({ creator: a.creator, seq: a.seq, score })}
                  />
                ))
              )}
            </div>
          )}
        </>
      )}
    </TokenShell>
  );
};

export default YourTokensView;
