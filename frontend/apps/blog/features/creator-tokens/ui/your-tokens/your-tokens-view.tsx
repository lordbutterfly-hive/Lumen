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

const tok = (n: number) => n.toFixed(1);

const Unavailable: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-[14px] border border-dashed border-[#e4e6e9] px-5 py-6 text-center text-[14px] leading-[22px] text-[#9ca3af]">{children}</div>
);

const HoldingRow: FC<{ h: HolderPosition }> = ({ h }) => (
  <div className="flex flex-wrap items-center gap-4 rounded-[16px] border border-[#ebebeb] bg-white px-5 py-4">
    <span className="h-11 w-11 flex-shrink-0 rounded-[12px] bg-[#e9ebee]" />
    <div className="min-w-0 flex-1">
      <Link href={`/creators/${h.creator}`} className="text-[15px] leading-[24px] font-bold text-[#161511] hover:text-[#c0392b]">
        @{h.creator}
      </Link>
      {/* No bio line: it is not contract state, and the Hive profile is not read on this route. */}
    </div>
    <div className="text-right tabular-nums">
      <div className="text-[15px] leading-[24px] font-bold text-[#161511]">{tok(h.tokensHeld)} tokens</div>
      {/* The FLOOR is net of this position's own exit tax — the least you're
          guaranteed back. There is deliberately no "current value" line: that
          needs the creator's live curve price, which is a per-market read this
          list does not make. The token page shows it. */}
      <div className="text-[12px] text-[#9ca3af]">floor {usdPrice(usdFromHbd(h.floorValueHbd))}</div>
    </div>
    <div className="flex gap-2">
      {['Buy', 'Sell', 'Send'].map((label) => (
        <Link
          key={label}
          href={`/creators/${h.creator}?a=${label.toLowerCase()}`}
          className="rounded-[9px] border border-[#e4e6e9] bg-white px-3 py-2 text-[13px] leading-[20px] font-semibold text-[#3f4650] hover:bg-[#f1f3f5]"
        >
          {label}
        </Link>
      ))}
    </div>
  </div>
);

const askStyle: Record<string, { label: string; cls: string }> = {
  awaiting: { label: 'Awaiting', cls: 'text-[#b45309]' },
  // The dead zone between the deadline and the reclaim window opening: nothing
  // is actionable yet, so it reads as awaiting to the holder.
  expired: { label: 'Awaiting', cls: 'text-[#b45309]' },
  answered: { label: 'Answered', cls: 'text-[#2f7d4f]' },
  reclaimable: { label: 'Reclaimable', cls: 'text-[#b45309]' },
  reclaimed: { label: 'Reclaimed', cls: 'text-[#9ca3af]' },
  // Distinct from `reclaimed` on purpose: the creator said no promptly and
  // handed everything back, including the commission.
  declined: { label: 'Declined & refunded', cls: 'text-[#9ca3af]' }
};

/**
 * The rating strip. It appears on every DELIVERED job, and it is the buyer's
 * only recourse: marking a job delivered is unilateral and pays the creator
 * immediately, so nothing but this records whether the work was real.
 */
const RateStrip: FC<{ onRate: (score: number) => Promise<void>; busy: boolean }> = ({ onRate, busy }) => {
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (done) return <div className="mt-3 text-[13px] leading-[20px] font-semibold text-[#2f7d4f]">Thanks — your rating is recorded on-chain.</div>;
  return (
    <div className="mt-3 border-t border-[#f1f3f5] pt-3">
      <div className="mb-2 text-[13px] leading-[20px] text-[#6b7280]">How did it go? Your rating is the creator’s public record.</div>
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
            className="h-8 w-8 rounded-[9px] border border-[#e4e6e9] bg-white text-[13px] leading-[20px] font-bold text-[#3f4650] hover:bg-[#f1f3f5] disabled:opacity-50"
          >
            {score}
          </button>
        ))}
        <span className="ml-1 text-[12px] text-[#9ca3af]">1 = poor · 5 = excellent</span>
      </div>
      {failure ? (
        <div className="mt-2 text-[12px] font-semibold text-[#c0392b]">{failure}</div>
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
    <div className={`rounded-[16px] border bg-white px-5 py-4 ${reclaimable ? 'border-[#f6e2c4] bg-[#fdf6ec]' : 'border-[#ebebeb]'}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[15px] leading-[24px] font-semibold text-[#161511]">
          Ask · <span className="text-[#4b5563]">@{a.creator}</span>
        </div>
        <div className={`text-[13px] leading-[20px] font-bold ${s.cls}`}>{s.label}</div>
      </div>
      <div className="mt-1 text-[13px] leading-[20px] tabular-nums text-[#6b7280]">
        {a.tokensEscrowed.toFixed(2)} tokens{' '}
        {a.status === 'answered' ? 'paid to the creator' : a.status === 'reclaimed' || a.status === 'declined' ? 'returned to you' : 'in escrow'}
      </div>
      {/* The chain carries a REFERENCE, not the brief — this contract
          facilitates payment and reputation; the work is arranged between the
          two parties directly (USER RULING 2026-07-28). */}
      {a.contentHash ? <div className="mt-1 font-mono text-[12px] text-[#9ca3af]">ref {a.contentHash}</div> : null}
      {a.status === 'answered' ? <RateStrip onRate={onRate} busy={rating} /> : null}
      {reclaimable ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-[13px] leading-[20px] text-[#8a5a20]">You get {a.tokensEscrowed.toFixed(2)} tokens back to your balance — in full.</div>
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
            className="rounded-[10px] bg-[#b45309] px-4 py-2 text-[13px] leading-[20px] font-semibold text-white hover:bg-[#8a4207] disabled:opacity-50"
          >
            {busy ? 'Confirm in your wallet…' : 'Get your tokens back'}
          </button>
        </div>
      ) : null}
      {failure ? (
        <div className="mt-2 text-[12px] font-semibold text-[#c0392b]">{failure}</div>
      ) : null}
    </div>
  );
};

const YourTokensView: FC = () => {
  const [tab, setTab] = useState<'holdings' | 'asks'>('holdings');
  const p = useLivePortfolio();

  const floorTotalUsd = p.holdings.reduce((sum, h) => sum + usdFromHbd(h.floorValueHbd), 0);
  const reclaimable = p.asks.filter((a) => a.status === 'reclaimable').length;

  const rightRail = (
    <div className="flex flex-col gap-5 pt-[26px]">
      <div className="rounded-[18px] border border-[#ebebeb] bg-white p-5">
        <div className="mb-1.5 font-serif text-lg font-semibold text-[#161511]">Find more creators</div>
        <p className="mb-4 font-serif text-[14px] leading-[22px] text-[#6b7280]">Hold their token, spend it on their work.</p>
        <Link href="/creators" className="block rounded-[11px] bg-[#c0392b] py-3 text-center text-sm font-semibold text-white hover:bg-[#a5301f]">
          Discover creators →
        </Link>
      </div>
    </div>
  );

  return (
    <TokenShell rightRail={rightRail}>
      <h1 className="font-serif text-[34px] font-semibold tracking-[-0.015em] text-[#161511]">Your tokens</h1>

      {p.unavailable ? (
        <div className="mt-5">
          <Unavailable>Creator tokens aren’t available on this build yet.</Unavailable>
        </div>
      ) : !p.loggedIn ? (
        <div className="mt-5">
          <Unavailable>Sign in to see the creator tokens you hold.</Unavailable>
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
        <div className="mt-5">
          <Unavailable>
            This account signs in with Google only, so there is no wallet to hold creator tokens in. Link a Bitcoin or
            Ethereum wallet, or upgrade to a full Hive account.
          </Unavailable>
        </div>
      ) : (
        <>
          {/* Viewing works, signing does not — yet. A wallet identity holds tokens
              at its own `did:pkh` and can be paid, but initiating a transaction
              needs a signature over the transaction itself, which is a rail that
              is not ported. Stated up front rather than discovered on a click. */}
          {p.isLite && !p.canSign ? (
            <div className="mt-5 rounded-[14px] border border-[#f6e2c4] bg-[#fdf6ec] px-4 py-3 text-[13px] leading-[20px] text-[#b45309]">
              These are the tokens held by the wallet you signed in with. Selling and spending them from Lumen isn’t
              available yet — the wallet signing for it is still being built.
            </div>
          ) : null}
          {/* The headline is the FLOOR total, not a market value: a market value
              needs each creator's live curve price and this list makes no
              per-market read. The floor is a number we actually have — and it is
              the honest one to lead with anyway. */}
          <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-1">
            <div className="text-[34px] leading-[44px] font-extrabold tabular-nums text-[#161511]">{p.holdingsUnavailable ? '—' : usdPrice(floorTotalUsd)}</div>
            <div className="pb-1.5 text-[15px] leading-[24px] tabular-nums text-[#6b7280]">Floor value — what the reserve would pay out if the market wound down</div>
          </div>
          <p className="mt-1 text-[14px] leading-[22px] text-[#6b7280]">
            {p.holdingsUnavailable ? 'Your holdings can’t be loaded right now.' : `You hold tokens from ${p.holdings.length} creators.`}
          </p>

          {reclaimable > 0 ? (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-[12px] border border-[#f6e2c4] bg-[#fdf6ec] px-4 py-3">
              <span className="text-[14px] leading-[22px] font-semibold text-[#b45309]">
                You have {reclaimable} ask{reclaimable > 1 ? 's' : ''} with tokens to reclaim.
              </span>
              <button onClick={() => setTab('asks')} className="text-[13px] leading-[20px] font-semibold text-[#b45309] underline">
                View
              </button>
            </div>
          ) : null}

          <div className="mb-4 mt-5 inline-flex gap-1.5 rounded-xl border border-[#ebedf0] bg-[#f4f5f7] p-[5px]">
            {(['holdings', 'asks'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
                className={`rounded-lg px-[18px] py-2 text-[14px] leading-[22px] font-semibold capitalize ${
                  tab === t ? 'bg-white text-[#161511] shadow-[0_1px_2px_rgba(20,18,10,0.08)]' : 'text-[#6b7280]'
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
                  <p className="py-8 text-center font-serif text-sm text-[#9ca3af]">
                    You don’t hold any creator tokens yet. Browse creators and buy in to start.
                  </p>
                ) : (
                  p.holdings.map((h) => <HoldingRow key={h.creator} h={h} />)
                )}
              </div>
              <p className="mt-4 font-serif text-[13px] leading-[20px] text-[#9ca3af]">
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
                <p className="py-8 text-center font-serif text-sm text-[#9ca3af]">
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
