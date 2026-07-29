'use client';

import { FC, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Service } from '../../market/token-detail';
import { useLiveStudio } from '../../live/use-live-studio';
import { MarketUnavailable } from '../../live/market-states';
import { buyQuote } from '../../market/curve';
import { usdWhole } from '../../market/format';
import TokenShell from '../token-shell';
import { writeFailureMessage } from '../write-failure';

const STEPS = ['Account', 'What you offer', 'Supply', 'Launch'];

const SERVICE_TEMPLATE: { key: string; name: string; desc: string; cta: string }[] = [
  { key: 'ask', name: 'Ask a question', desc: 'One private question, answered within your deadline — or your tokens back.', cta: 'Ask' },
  { key: 'review', name: 'Review my work', desc: 'A written review of a repo, doc or plan.', cta: 'Request' }
];
const CAP_PRESETS = [
  { label: 'Tight', value: 5000, note: 'more scarcity' },
  { label: 'Balanced', value: 20000, note: 'a middle ground' },
  { label: 'Generous', value: 100000, note: 'more buyers' }
];

const LaunchWizard: FC = () => {
  const router = useRouter();
  const studio = useLiveStudio();
  const [step, setStep] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({ ask: '10', review: '80' });
  const [cap, setCap] = useState(20000);
  const [firstBuy, setFirstBuy] = useState('');
  const [launching, setLaunching] = useState(false);
  // True once launchToken() reports the requested anti-snipe first buy was
  // silently skipped (budget under one whole token, or it would have breached
  // the cap) — DEFECT FIX: launchToken used to mark the token launched and
  // report success unconditionally even then, dropping the creator's first
  // buy with no signal anywhere. The launch itself still completed; we hold
  // here instead of navigating away so the creator sees that before leaving.
  const [firstBuySkipped, setFirstBuySkipped] = useState(false);

  /**
   * REGISTER, then post the services as SHOP OFFERINGS.
   *
   * Two chain calls, not one, and deliberately in that order: `register` takes
   * a single `face` price (the creator's legacy default) plus the cap, and the
   * named catalogue is a separate `createOffering` per service. Registration is
   * the irreversible part, so it goes first and alone — if an offering fails
   * afterwards the creator has a live market with one price and can add the
   * rest from the Studio, which is a far better failure than a half-registered
   * market that cannot be retried.
   *
   * The first service's price becomes the market's `face`, so a creator who
   * posts nothing still has one working price.
   */
  const launch = async () => {
    if (launching) return; // #7: no double-submit
    setLaunching(true);
    setFailed(null);
    const services: Service[] = SERVICE_TEMPLATE.map((t) => {
      const n = parseFloat((prices[t.key] ?? '0').replace(/,/g, ''));
      return { ...t, status: 'live' as const, usd: Number.isFinite(n) && n > 0 ? n : 0 }; // #5: no Infinity/NaN
    }).filter((s) => s.usd > 0);

    // The optional anti-snipe first buy is a DOLLAR budget in this wizard but a
    // whole-TOKEN count on-chain. Convert with the same curve math the contract
    // runs; a budget too small for one whole token buys nothing, and the
    // creator is told rather than silently launched without it.
    const fb = parseFloat(firstBuy.replace(/,/g, ''));
    const budget = Number.isFinite(fb) && fb > 0 ? fb : 0;
    const firstBuyTokens = budget > 0 ? buyQuote(budget, { supply: 0, cap, position: null }).tokens : 0;
    const skipped = budget > 0 && firstBuyTokens <= 0;

    try {
      await studio.register({
        faceHbd: services[0]?.usd ?? 0,
        capTokens: cap,
        firstBuyTokens: skipped ? 0 : firstBuyTokens
      });
      // Everything past the first price is a named offering. Sequential, not
      // parallel: they share one nonce and one signer, and a creator being
      // asked to sign four prompts at once is worse than four in a row.
      for (const sv of services.slice(1)) {
        await studio.createOffering({ title: sv.name, priceUsd: sv.usd });
      }
    } catch (e) {
      setLaunching(false);
      // Was the RAW message, including the CREATOR_TOKENS_* machine code and
      // whatever text a signer chose to throw. Routed through the shared
      // formatter so the code is stripped and any key-shaped text is redacted
      // before it is painted into the DOM (see ../write-failure.ts).
      setFailed(writeFailureMessage(e, 'Launch didn’t go through.'));
      return;
    }

    if (skipped) {
      // The token IS launched — only the first buy could not be filled. Stay
      // here and say so rather than landing in the Studio as if the whole
      // thing, first buy included, had gone through.
      setLaunching(false);
      setFirstBuySkipped(true);
      return;
    }
    router.push('/creators/studio');
  };

  if (studio.status === 'unavailable') return <MarketUnavailable />;

  return (
    <TokenShell>
      <div className="mx-auto max-w-[640px] pt-[26px]">
        {/* Progress rail */}
        <div className="mb-6 flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className="flex flex-1 items-center gap-2">
              <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${i <= step ? 'bg-[#c0392b] text-white' : 'bg-[#f1f3f5] text-[#9ca3af]'}`}>{i + 1}</span>
              <span className={`text-[12.5px] font-semibold ${i === step ? 'text-[#161511]' : 'text-[#9ca3af]'}`}>{s}</span>
              {i < STEPS.length - 1 ? <span className="h-px flex-1 bg-[#ececec]" /> : null}
            </div>
          ))}
        </div>

        <div className="rounded-[18px] border border-[#ebebeb] bg-white p-6 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
          {step === 0 ? (
            <>
              <h1 className="font-serif text-2xl font-semibold text-[#161511]">Confirm your account</h1>
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-[#e4e6e9] px-4 py-3.5">
                <span className="h-11 w-11 rounded-[13px]" style={{ background: 'linear-gradient(135deg,#c0392b,#e07b3e)' }} />
                <div>
                  <div className="text-[15px] font-bold text-[#161511]">@{studio.creator ?? '—'}</div>
                  <div className="text-[12.5px] text-[#6b7280]">Hive reputation 68 · 1,240 followers</div>
                </div>
              </div>
              <p className="mt-3 font-serif text-[14px] leading-[1.55] text-[#4b5563]">
                Your token is bound to <strong>@{studio.creator ?? 'your account'}</strong> — one per account. It can’t be moved or renamed, and nobody can create one pretending to be you.
              </p>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <h1 className="font-serif text-2xl font-semibold text-[#161511]">What you offer</h1>
              <p className="mt-1.5 text-[13.5px] text-[#6b7280]">Set each service’s price in dollars. Buyers pay this in your token at the live price.</p>
              <div className="mt-4 flex flex-col gap-3">
                {SERVICE_TEMPLATE.map((t) => (
                  <div key={t.key} className="flex items-center justify-between gap-3 rounded-xl border border-[#e4e6e9] px-4 py-3">
                    <div className="text-[14px] font-semibold text-[#161511]">{t.name}</div>
                    <div className="flex items-center rounded-[10px] border border-[#e4e6e9] px-3 py-2">
                      <span className="font-bold text-[#9ca3af]">$</span>
                      <input
                        value={prices[t.key] ?? ''}
                        onChange={(e) => setPrices({ ...prices, [t.key]: e.target.value })}
                        inputMode="decimal"
                        className="ml-1 w-[70px] border-0 text-[15px] font-bold tabular-nums text-[#161511] outline-none"
                      />
                    </div>
                  </div>
                ))}
                {['Unlock a post', 'Book a session', 'Tip'].map((n) => (
                  <div key={n} className="flex items-center justify-between rounded-xl border border-dashed border-[#e4e6e9] px-4 py-3 opacity-60">
                    <span className="text-[14px] text-[#6b7280]">{n}</span>
                    <span className="rounded-full bg-[#f1f3f5] px-2.5 py-1 text-[11px] font-semibold text-[#9ca3af]">Rolling out</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <h1 className="font-serif text-2xl font-semibold text-[#161511]">Supply</h1>
              <p className="mt-1.5 text-[13.5px] text-[#6b7280]">How many tokens can ever exist?</p>
              <div className="mt-4 grid grid-cols-3 gap-2.5">
                {CAP_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => setCap(p.value)}
                    className={`rounded-xl border px-3 py-3 text-left ${cap === p.value ? 'border-[#c0392b] bg-[#fefaf9]' : 'border-[#e4e6e9]'}`}
                  >
                    <div className="text-[13.5px] font-bold text-[#161511]">{p.label}</div>
                    <div className="text-[12px] tabular-nums text-[#6b7280]">{p.value.toLocaleString('en-US')}</div>
                    <div className="text-[11px] text-[#9ca3af]">{p.note}</div>
                  </button>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-2">
                <span className="text-[13px] text-[#6b7280]">Custom cap</span>
                <input
                  value={String(cap)}
                  onChange={(e) => setCap(Math.max(1, parseInt(e.target.value.replace(/[^\d]/g, ''), 10) || 0))}
                  inputMode="numeric"
                  className="w-[130px] rounded-[10px] border border-[#e4e6e9] px-3 py-2 text-[14px] font-semibold tabular-nums outline-none"
                />
              </div>
              <p className="mt-4 font-serif text-[13px] leading-[1.55] text-[#6b7280]">
                Up to {cap.toLocaleString('en-US')} tokens. Lower cap = more scarcity and price appreciation, fewer direct buyers; higher cap = more buyers, less scarcity. You can raise it any time; you can only lower it down to what’s already been bought.
              </p>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <h1 className="font-serif text-2xl font-semibold text-[#161511]">Launch</h1>
              <div className="mt-4 rounded-xl bg-[#f6f7f8] px-4 py-3.5 text-[13.5px] leading-[1.6] text-[#4b5563]">
                <strong>Launching is free.</strong> Staying listed is <strong>~$10/month</strong> — first month included.
              </div>
              <div className="mt-4">
                <label className="mb-1.5 block text-[12.5px] font-semibold text-[#6b7280]">Optional anti-snipe first buy</label>
                <div className="flex items-center rounded-xl border border-[#e4e6e9] px-4 py-3">
                  <span className="text-[18px] font-bold text-[#161511]">$</span>
                  <input value={firstBuy} onChange={(e) => setFirstBuy(e.target.value)} placeholder="0" inputMode="decimal" className="ml-1 flex-1 border-0 text-[18px] font-bold tabular-nums outline-none" />
                </div>
                <div className="mt-1.5 text-[11.5px] text-[#9ca3af]">Buy some of your own token at launch, at full price — this stops a bot grabbing the cheap first tokens ahead of you.</div>
              </div>
              <p className="mt-4 font-serif text-[12.5px] leading-[1.55] text-[#9ca3af]">
                If you ever stop paying, your token’s market winds down, holders are refunded at the floor, and your delivery record resets — coming back means a new token.
              </p>
              {firstBuySkipped ? (
                <div className="mt-4 rounded-[12px] border border-[#f6e2c4] bg-[#fdf6ec] px-4 py-3.5 text-[13.5px] font-semibold text-[#b45309]">
                  Your token launched, but the first buy didn’t go through — that amount was too small to afford one whole
                  token, or it would have pushed past your cap. Nothing was charged; you can buy from the Studio.
                </div>
              ) : null}
              {failed ? (
                // A failed launch must be LOUD and must not navigate: registering
                // is the irreversible step, and a creator who lands in the Studio
                // after a rejected signature would think they had a market.
                <div className="mt-4 rounded-[12px] border border-[#f0c9c2] bg-[#fef2f0] px-4 py-3.5 text-[13.5px] font-semibold text-[#c0392b]">
                  Your token wasn’t launched. Nothing was charged. {failed}
                </div>
              ) : null}
              {studio.isLite ? (
                <div className="mt-4 rounded-[12px] border border-[#e4e6e9] bg-[#f6f7f8] px-4 py-3.5 text-[13.5px] text-[#6b7280]">
                  This account can’t sign transactions yet, so it can’t launch a token. Upgrade to a full account first.
                </div>
              ) : null}
              <button
                onClick={firstBuySkipped ? () => router.push('/creators/studio') : launch}
                disabled={launching || studio.isLite || !studio.loggedIn}
                className="mt-5 w-full rounded-[13px] bg-[#c0392b] py-[15px] text-[15px] font-bold text-white hover:bg-[#96271b] disabled:opacity-60"
              >
                {firstBuySkipped
                  ? 'Continue to Studio'
                  : launching
                    ? 'Launching…'
                    : `Launch my token${firstBuy && parseFloat(firstBuy.replace(/,/g, '')) > 0 ? ` · first buy ${usdWhole(parseFloat(firstBuy.replace(/,/g, '')) || 0)}` : ''}`}
              </button>
            </>
          ) : null}

          {/* Nav */}
          {step < 3 ? (
            <div className="mt-6 flex items-center justify-between">
              <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} className="text-[13.5px] font-semibold text-[#6b7280] disabled:opacity-0">Back</button>
              <button onClick={() => setStep((s) => Math.min(3, s + 1))} className="rounded-[11px] bg-[#161511] px-6 py-2.5 text-[14px] font-semibold text-white hover:bg-black">Continue</button>
            </div>
          ) : (
            <div className="mt-4 text-center">
              <button onClick={() => setStep(2)} className="text-[13.5px] font-semibold text-[#6b7280]">Back</button>
            </div>
          )}
        </div>
      </div>
    </TokenShell>
  );
};

export default LaunchWizard;
