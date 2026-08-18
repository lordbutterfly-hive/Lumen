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
 */

import { FC, useState } from 'react';
import { Link } from '@hive/ui';
import { useLivePortfolio } from '../../live/use-live-portfolio';
import { usdFromHbd } from '../../live/adapt';
import type { Ask, HolderPosition } from '../../types';
import { usdPrice } from '../../market/format';
import TokenShell from '../token-shell';
import { writeFailureMessage } from '../write-failure';
import { MeritumEligibilityNotice, useMeritumEligibility } from '../meritum-eligibility';

const tok = (n: number) => n.toFixed(1);

const Unavailable: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-card border border-dashed border-line-11 px-5 py-6 text-center text-[14px] leading-[22px] text-ink-14">{children}</div>
);

const HoldingRow: FC<{ h: HolderPosition }> = ({ h }) => (
  <div className="flex flex-wrap items-center gap-4 rounded-card border border-line-9 bg-surface-1 px-5 py-4">
    <span className="h-11 w-11 flex-shrink-0 rounded-control bg-surface-28" />
    <div className="min-w-0 flex-1">
      <Link href={`/creators/${h.creator}`} className="text-[15px] leading-[24px] font-bold text-ink-2 hover:text-ink-brand-6">
        @{h.creator}
      </Link>
      {/* No bio line: it is not contract state, and the Hive profile is not read on this route. */}
    </div>
    <div className="text-right tabular-nums">
      <div className="text-[15px] leading-[24px] font-bold text-ink-2">{tok(h.tokensHeld)} tokens</div>
      {/* The FLOOR is net of this position's own exit tax. The least you're
          guaranteed back. There is deliberately no "current value" line: that
          needs the creator's live curve price, which is a per-market read this
          list does not make. The token page shows it. */}
      <div className="text-[12px] text-ink-14">floor {usdPrice(usdFromHbd(h.floorValueHbd))}</div>
    </div>
    <div className="flex gap-2">
      {['Buy', 'Sell', 'Send'].map((label) => (
        <Link
          key={label}
          href={`/creators/${h.creator}?a=${label.toLowerCase()}`}
          className="rounded-control border border-line-11 bg-surface-1 px-3 py-2 text-[13px] leading-[20px] font-semibold text-ink-7 hover:bg-surface-23"
        >
          {label}
        </Link>
      ))}
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
  if (done) return <div className="mt-3 text-[13px] leading-[20px] font-semibold text-ink-ok-2">Thanks. Your rating is recorded on-chain.</div>;
  return (
    <div className="mt-3 border-t border-line-2 pt-3">
      <div className="mb-2 text-[13px] leading-[20px] text-ink-10">How did it go? Your rating is the creator’s public record.</div>
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
            className="h-8 w-8 rounded-control border border-line-11 bg-surface-1 text-[13px] leading-[20px] font-bold text-ink-7 hover:bg-surface-23 disabled:opacity-50"
          >
            {score}
          </button>
        ))}
        <span className="ml-1 text-[12px] text-ink-14">1 = poor · 5 = excellent</span>
      </div>
      {failure ? (
        <div className="mt-2 text-[12px] font-semibold text-ink-brand-6">{failure}</div>
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
          Ask · <span className="text-ink-8">@{a.creator}</span>
        </div>
        <div className={`text-[13px] leading-[20px] font-bold ${s.cls}`}>{s.label}</div>
      </div>
      <div className="mt-1 text-[13px] leading-[20px] tabular-nums text-ink-10">
        {a.tokensEscrowed.toFixed(2)} tokens{' '}
        {a.status === 'answered' ? 'paid to the creator' : a.status === 'reclaimed' || a.status === 'declined' ? 'returned to you' : 'in escrow'}
      </div>
      {/* The chain carries a REFERENCE, not the brief — this contract
          facilitates payment and reputation; the work is arranged between the
          two parties directly (USER RULING 2026-07-28). */}
      {a.contentHash ? <div className="mt-1 font-mono text-[12px] text-ink-14">ref {a.contentHash}</div> : null}
      {a.status === 'answered' ? <RateStrip onRate={onRate} busy={rating} /> : null}
      {reclaimable ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-[13px] leading-[20px] text-ink-warn-2">You get {a.tokensEscrowed.toFixed(2)} tokens back to your balance — in full.</div>
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
            className="rounded-control bg-surface-warn-11 px-4 py-2 text-[13px] leading-[20px] font-semibold text-ink-27 hover:bg-surface-warn-13 disabled:opacity-50"
          >
            {busy ? 'Confirm in your wallet…' : 'Get your tokens back'}
          </button>
        </div>
      ) : null}
      {failure ? (
        <div className="mt-2 text-[12px] font-semibold text-ink-brand-6">{failure}</div>
      ) : null}
    </div>
  );
};

const YourTokensView: FC = () => {
  const eligibility = useMeritumEligibility();
  const [tab, setTab] = useState<'holdings' | 'asks'>('holdings');
  const p = useLivePortfolio();

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
            wrong with your tokens — reload in a moment.
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
          {/* Viewing works, signing does not — yet. A wallet identity holds tokens
              at its own `did:pkh` and can be paid, but initiating a transaction
              needs a signature over the transaction itself, which is a rail that
              is not ported. Stated up front rather than discovered on a click. */}
          {p.isLite && !p.canSign ? (
            <div className="mt-5">
              <MeritumEligibilityNotice surface="hold" who={eligibility} />
            </div>
          ) : null}
          {/* The headline is the FLOOR total, not a market value: a market value
              needs each creator's live curve price and this list makes no
              per-market read. The floor is a number we actually have — and it is
              the honest one to lead with anyway. */}
          <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-1">
            <div className="text-[34px] leading-[44px] font-extrabold tabular-nums text-ink-2">{p.holdingsUnavailable ? '—' : usdPrice(floorTotalUsd)}</div>
            <div className="pb-1.5 text-[15px] leading-[24px] tabular-nums text-ink-10">Floor value: what the reserve would pay out if the market wound down</div>
          </div>
          <p className="mt-1 text-[14px] leading-[22px] text-ink-10">
            {p.holdingsUnavailable ? 'Your holdings can’t be loaded right now.' : `You hold tokens from ${p.holdings.length} creators.`}
          </p>

          {reclaimable > 0 ? (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-control border border-line-warn-2 bg-surface-warn-4 px-4 py-3">
              <span className="text-[14px] leading-[22px] font-semibold text-ink-warn-3">
                You have {reclaimable} ask{reclaimable > 1 ? 's' : ''} with tokens to reclaim.
              </span>
              <button onClick={() => setTab('asks')} className="text-[13px] leading-[20px] font-semibold text-ink-warn-3 underline">
                View
              </button>
            </div>
          ) : null}

          <div className="mb-4 mt-5 inline-flex gap-1.5 rounded-xl border border-line-6 bg-surface-21 p-[5px]">
            {(['holdings', 'asks'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
                className={`rounded-lg px-[18px] py-2 text-[14px] leading-[22px] font-semibold capitalize ${
                  tab === t ? 'bg-surface-1 text-ink-2 shadow-[0_1px_2px_rgba(20,18,10,0.08)]' : 'text-ink-10'
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
                    We can’t load your holdings right now — the index that lists every market you’re in is
                    unreachable. Your tokens are safe on-chain; each creator’s own token page still shows your balance.
                  </Unavailable>
                ) : p.holdings.length === 0 ? (
                  <p className="py-8 text-center font-serif text-sm text-ink-14">
                    You don’t hold any Meritum yet. Browse creators and buy in to start.
                  </p>
                ) : (
                  p.holdings.map((h) => <HoldingRow key={h.creator} h={h} />)
                )}
              </div>
              <p className="mt-4 font-serif text-[13px] leading-[20px] text-ink-14">
                Token prices float and you can lose money. You can exit two ways: sell on the curve while the market is
                open — at the curve’s price, after a 10% trade fee and any early-exit fee — or, once a market winds down,
                redeem at the floor. The floor value is what the reserve would pay out then; it is not a price you can
                sell at while the market is running.
              </p>
            </>
          ) : (
            <div className="flex flex-col gap-2.5">
              {p.isLoading ? (
                <Unavailable>Loading…</Unavailable>
              ) : p.asksUnavailable ? (
                <Unavailable>
                  We can’t load your asks right now — the index that lists them is unreachable. Nothing is lost; a
                  creator’s own page still shows the asks made to them.
                </Unavailable>
              ) : p.asks.length === 0 ? (
                <p className="py-8 text-center font-serif text-sm text-ink-14">
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
