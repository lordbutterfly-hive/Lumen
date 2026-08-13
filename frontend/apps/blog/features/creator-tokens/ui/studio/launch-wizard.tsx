'use client';

import { FC, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import type { Service } from '../../market/token-detail';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useLiveStudio } from '../../live/use-live-studio';
import { MarketUnavailable } from '../../live/market-states';
import { buyQuote } from '../../market/curve';
import {
  MIN_FACE_BASE_UNITS,
  MAX_FACE_BASE_UNITS,
  MIN_CAP_CREDITS_BASE_UNITS,
  MAX_CAP_CREDITS_BASE_UNITS
} from '../../lib/contract-math';
import { usdWhole } from '../../market/format';
import TokenShell from '../token-shell';
import { writeFailureMessage } from '../write-failure';
import { UserAvatarImg } from '@ui/components';

const STEPS = ['Account', 'What you offer', 'Launch'];

const SERVICE_TEMPLATE: { key: string; name: string; desc: string; cta: string }[] = [
  { key: 'ask', name: 'Ask a question', desc: 'One question, answered within your deadline. If it is not, the buyer can reclaim their tokens once the deadline and a short grace period have passed.', cta: 'Ask' },
  { key: 'review', name: 'Review my work', desc: 'A written review of a repo, doc or plan.', cta: 'Request' }
];
/**
 * ★ ONE SUPPLY FOR EVERY TOKEN (owner ruling, 2026-08-08).
 *
 * The wizard used to make a creator choose between Tight / Balanced / Generous
 * (5,000 / 20,000 / 100,000) on a step of its own. That is a genuinely hard
 * question — it sets how fast the price climbs — asked of someone who has not yet
 * sold anything, and it bought nothing: the cap can be RAISED at any time from the
 * Studio, so a low start is strictly the safer default. The step is gone and every
 * token launches at the smallest of the three.
 */
const STANDARD_CAP = 5000;

/**
 * ★ A PRICE FIELD THAT ACCEPTS "banana".
 *
 * The service-price and first-buy inputs stored whatever was typed — `abc`,
 * `-50`, `999999999999` all survived into later steps and kept Continue
 * enabled. The Supply step one screen along already strips non-digits from its
 * own field, so the wizard disagreed with itself about whether its money inputs
 * are validated. Found by an exploratory UX tester 2026-08-06.
 *
 * Permissive on purpose: it never rejects a keystroke mid-typing (`1.` and ``
 * are both fine while the reader is still going), it only refuses what cannot
 * be a dollar amount — letters, symbols, a minus sign, a second decimal point,
 * and more than two decimal places.
 */
function sanitizeMoneyInput(raw: string): string {
  const cleaned = (raw ?? '').replace(/[^\d.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  // ★ THREE decimals, not two (2026-08-07). HBD carries 3dp and the contract's
  // own minimum posted price is 577 base units = $0.577 — at 2dp a creator
  // could not type the legal minimum at all; `0.577` silently became `0.57`,
  // which is BELOW the floor and would be rejected on chain after signing.
  return rest.length ? `${whole}.${rest.join('').slice(0, 3)}` : whole;
}

const LaunchWizard: FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const studio = useLiveStudio();
  /**
   * ★★★ STEP 1 DISPLAY ONLY — NOT THE LAUNCH GATE (2026-08-11).
   *
   * `studio.loggedIn` (`use-live-studio.ts`) waits for `useUserClient()` to
   * hydrate from localStorage, which on this app trails the server by 3-5s —
   * so a genuinely signed-in reader who opened this wizard was shown "Not
   * signed in" at the top of step 1 of their own launch flow. The server
   * already read the session cookie to render this page; `useSessionIdentity`
   * (same helper `app-header.tsx` and `left-rail.tsx` use) hands that answer
   * down instead of guessing "signed out" until the client catches up.
   *
   * This is used for STEP 1's account confirmation copy only. The step-2
   * launch button below keeps gating on `studio.loggedIn` and `studio.isLite`
   * exactly as before — those decide whether an actual signed, money-moving
   * transaction fires, and that must stay conservative: wait for the real
   * client answer, never act on the server's cookie-only guess. A stale
   * "disabled" button for an extra second is safe; broadcasting on a guess is
   * not.
   */
  const identity = useSessionIdentity();
  // A failed read is NOT "no market" — see the launch button below.
  const cannotConfirmMarket = studio.status === 'error';
  const alreadyHasMarket = Boolean(studio.market);
  const [step, setStep] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({ ask: '10', review: '80' });
  const [cap] = useState(STANDARD_CAP);
  const [firstBuy, setFirstBuy] = useState('');
  const [launching, setLaunching] = useState(false);
  // True once launchToken() reports the requested anti-snipe first buy was
  // silently skipped (budget under one whole token, or it would have breached
  // the cap) — DEFECT FIX: launchToken used to mark the token launched and
  // report success unconditionally even then, dropping the creator's first
  // buy with no signal anywhere. The launch itself still completed; we hold
  // here instead of navigating away so the creator sees that before leaving.
  const [firstBuySkipped, setFirstBuySkipped] = useState(false);
  // ★★★ THE FINAL STEP MUST BE CONFIRMED, NOT JUST CLICKED (2026-08-11, audit
  // item 5). `launch()` fires a real, irreversible on-chain registration —
  // and a restored draft (below) could drop a reader straight onto this step
  // with "Launch my token" as the ONLY visible action. Requiring a second,
  // explicit confirmation before `launch()` runs means arriving here already
  // on step 3 is no longer one click from spending real money, whether that
  // arrival was a restored draft or a normal walk-through.
  const [confirmArmed, setConfirmArmed] = useState(false);

  // ★ DRAFT PERSISTENCE (2026-08-07, found in live QA). Every field lived in
  // plain useState with no history entry and no storage, so a refresh, a single
  // browser Back (which leaves the wizard entirely — there is no per-step URL),
  // or following the "upgrade to a full account" link and coming back silently
  // threw away everything the creator had typed, with no warning. That last
  // path is the cruel one: the wizard TELLS a lite account to go upgrade, and
  // discards their work when they do.
  //
  // sessionStorage, not localStorage: a draft should not outlive the tab.
  // ★ PER ACCOUNT (2026-08-07, second pass). A single global key meant a second
  // account signing in on the same tab opened the wizard on the FIRST account's
  // step, with their prices pre-filled and no indication whose they were. The
  // interstitial was keyed per viewer in the same fix wave; this was missed.
  const DRAFT_KEY = `lumen-launch-wizard-draft-${studio.creator ?? 'anon'}`;
  const [restored, setRestored] = useState(false);
  // ★★★ VISIBLE, NOT SILENT (2026-08-11, audit item 5). A fresh navigation to
  // `/creators/launch` with a saved draft used to cold-boot straight onto
  // whichever step the draft last held — often the final, irreversible one —
  // with nothing on screen explaining why, no way to tell it apart from a
  // normal walk-through, and no way to clear it short of opening devtools.
  // Set only when a real draft was actually found, so a genuinely fresh
  // wizard never shows a banner about a draft that does not exist.
  const [restoredFromDraft, setRestoredFromDraft] = useState(false);
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as { step?: number; prices?: Record<string, string>; cap?: number; firstBuy?: string };
        if (typeof d.step === 'number') setStep(Math.min(2, Math.max(0, d.step)));
        if (d.prices && typeof d.prices === 'object') setPrices(d.prices);
        if (typeof d.firstBuy === 'string') setFirstBuy(d.firstBuy);
        setRestoredFromDraft(true);
      }
    } catch {
      // A corrupt or unreadable draft must never block the wizard — start fresh.
    }
    setRestored(true);
    // Re-reads when the signed-in account changes, so a switch loads THAT
    // account's draft (or a clean wizard) instead of keeping the previous one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DRAFT_KEY]);
  useEffect(() => {
    // Only write AFTER the restore pass, or the initial defaults would
    // overwrite a real saved draft before it was ever read back.
    if (!restored) return;
    try {
      window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ step, prices, cap, firstBuy }));
    } catch {
      // Storage full or blocked (private mode) — persistence is a convenience,
      // never a precondition for launching.
    }
  }, [restored, step, prices, cap, firstBuy, DRAFT_KEY]);

  // ★ THE STEP IN THE URL (2026-08-11, audit item 5). Reflection only — a
  // `?step=` param the reader can see, refresh on, and land on with the
  // browser's Back button, without turning the step into a second source of
  // truth. `router.replace` (not `push`) so paging through 3 short steps does
  // not pile up history entries, and it never READS the param back on mount:
  // the actual restore above (sessionStorage, keyed per account) stays the
  // only thing that decides where a reader lands, so there is exactly one
  // place that logic can drift. A full `/creators/launch/[step]` route (the
  // audit's other suggestion) was considered and rejected: every field here
  // (prices, first buy) lives in this component's own state, not in the URL
  // or a route-keyed cache, and Next's app router unmounts a client
  // component across a dynamic-segment change — chasing that state through
  // route transitions is a materially bigger, riskier rewrite than what this
  // bug actually needs.
  useEffect(() => {
    if (!restored) return;
    const params = new URLSearchParams(window.location.search);
    params.set('step', String(step + 1));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, step]);

  /** Clears the saved draft and every field it carried, back to a blank wizard. */
  const startOver = () => {
    try {
      window.sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Nothing to undo if storage was never reachable.
    }
    setRestoredFromDraft(false);
    setStep(0);
    setPrices({ ask: '10', review: '80' });
    setFirstBuy('');
    setFailed(null);
    setConfirmArmed(false);
  };

  // ★ RANGE VALIDATION (2026-08-07, found in live QA against the deployed
  // contract). Before this, the wizard had NO upper bound and NO lower bound on
  // either field: a supply cap of 50,000,000,000 (50x the contract maximum) was
  // accepted and echoed back as "Up to 50,000,000,000 tokens", and an empty or
  // $0 price kept Continue enabled. Both would be rejected on chain AFTER the
  // creator had approved a signature — the worst possible moment to find out.
  //
  // Bounds come from contract-math.ts's mirrors of core/params.go, never from
  // literals here, so they cannot drift from the contract.
  const MIN_PRICE_USD = MIN_FACE_BASE_UNITS / 1000;
  const MAX_PRICE_USD = MAX_FACE_BASE_UNITS / 1000;
  const capError =
    cap < MIN_CAP_CREDITS_BASE_UNITS || cap > MAX_CAP_CREDITS_BASE_UNITS
      ? `Choose between ${MIN_CAP_CREDITS_BASE_UNITS.toLocaleString('en-US')} and ${MAX_CAP_CREDITS_BASE_UNITS.toLocaleString('en-US')} tokens.`
      : null;
  // A blank price means "I am not offering this one" and is allowed; a price
  // that is present but outside the contract's band is not.
  const priceError = SERVICE_TEMPLATE.some((t) => {
    const raw = (prices[t.key] ?? '').trim();
    if (raw === '' || raw === '.') return false;
    const n = parseFloat(raw.replace(/,/g, ''));
    return !Number.isFinite(n) || n <= 0 || n < MIN_PRICE_USD || n > MAX_PRICE_USD;
  })
    ? `Each price must be between $${MIN_PRICE_USD} and $${MAX_PRICE_USD.toLocaleString('en-US')}, or left blank.`
    : null;
  // ★ THE ANTI-SNIPE FIRST BUY HAD NO CEILING (2026-08-09, tester CT-CREATOR-04).
  // `sanitizeMoneyInput` strips letters and minus signs, so the field looked
  // guarded — but `99999999` was accepted and the primary button relabelled
  // itself to "Launch my token · first buy $99,999,999" and stayed ENABLED.
  // Its sibling price fields two steps earlier enforce $0.577–$10,000; this one,
  // which spends REAL money at launch, enforced nothing at all. Bounded to the
  // same ceiling, for the same reason, with the same wording.
  const firstBuyRaw = firstBuy.trim();
  const firstBuyNum = parseFloat(firstBuyRaw.replace(/,/g, ''));
  const firstBuyError =
    firstBuyRaw !== '' && firstBuyRaw !== '.' && (!Number.isFinite(firstBuyNum) || firstBuyNum > MAX_PRICE_USD)
      ? `Your first buy can be at most $${MAX_PRICE_USD.toLocaleString('en-US')}, or left blank.`
      : null;
  const stepError = step === 1 ? priceError : null;
  // ★ NOT step-scoped (2026-08-07, second pass). `stepError` only guards the
  // Continue button on the step that owns each field, so a restored draft could
  // land straight on the final step carrying a cap the contract rejects — and the
  // Launch button's own condition checked only account type, never validity. That
  // is the exact failure this validation was added to prevent: a creator approving
  // a signature for a transaction the chain was always going to refuse.
  // firstBuyError joins the LAUNCH gate (not the per-step Continue gate) for the
  // reason the comment above gives: this button is the one that asks for a
  // signature, so every field the chain can reject must be checked here.
  const formError = priceError ?? capError ?? firstBuyError;

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

    // The token is launched either way past this point, so the saved draft is
    // spent — leaving it would re-open a stale wizard over a live market.
    try {
      window.sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Never let a storage failure swallow a successful launch.
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
              <span className={`text-[13px] leading-[20px] font-semibold ${i === step ? 'text-[#161511]' : 'text-[#9ca3af]'}`}>{s}</span>
              {i < STEPS.length - 1 ? <span className="h-px flex-1 bg-[#ececec]" /> : null}
            </div>
          ))}
        </div>

        {/* ★ THE RESTORED-DRAFT / START-OVER AFFORDANCE (2026-08-11, audit
            item 5). Only shown when a real draft was actually read back, so a
            reader who lands here mid-progress knows why (a saved draft, not a
            bug), and has an explicit way out of it rather than the page's
            state being the only place that knowledge lives. */}
        {restoredFromDraft ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-[12px] border border-[#e4e6e9] bg-[#f6f7f8] px-4 py-3 text-[13px] leading-[20px] text-[#4b5563]">
            <span>
              Picked up your saved draft at step {step + 1} of {STEPS.length}.
            </span>
            <button
              onClick={startOver}
              className="flex-shrink-0 text-[13px] leading-[20px] font-semibold text-[#c0392b] hover:underline"
            >
              Start over
            </button>
          </div>
        ) : null}

        <div className="rounded-[18px] border border-[#ebebeb] bg-white p-6 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
          {step === 0 ? (
            <>
              <h1 className="font-serif text-2xl font-semibold text-[#161511]">Confirm your account</h1>
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-[#e4e6e9] px-4 py-3.5">
                {/* ★ CONVERGED (F6 item 22). This was a flat gradient square that never
                    attempted a real avatar at all — every creator, regardless of
                    account, saw the same orange box on the first screen of their own
                    launch flow. Falls back to the brand gradient (no letter guess)
                    only for the genuinely signed-out case, where there is no account
                    to draw an avatar OR an initial for. */}
                {identity.isLoggedIn && (studio.creator ?? identity.username) ? (
                  <UserAvatarImg
                    username={(studio.creator ?? identity.username) as string}
                    apiSize="medium"
                    pixelSize={44}
                    radiusClassName="rounded-[13px]"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="h-11 w-11 rounded-[13px]"
                    style={{ background: 'linear-gradient(135deg,#c0392b,#e07b3e)' }}
                  />
                )}
                <div>
                  <div className="text-[15px] leading-[24px] font-bold text-[#161511]">
                    {/* ★ `@—` and "@your account" are placeholder strings that
                        reached real readers: a signed-OUT visitor was walked
                        through all four steps of a wizard whose entire premise
                        is "a token bound to your account", and the first thing
                        they saw was a dash where their name should be. */}
                    {identity.isLoggedIn ? `@${studio.creator ?? identity.username ?? '—'}` : 'Not signed in'}
                  </div>
                  {/* ★ REMOVED 2026-08-06: this line was HARDCODED "Hive reputation 68 ·
                      1,240 followers". It rendered before the username had even
                      resolved (@—) and kept the same numbers afterwards, so a
                      brand-new account with no Hive history was shown someone
                      else's standing. Inventing a number next to a real handle is
                      the one thing this product must never do. Restore only when
                      it reads live reputation/followers for the actual account. */}
                </div>
              </div>
              <p className="mt-3 font-serif text-[14px] leading-[22px] text-[#4b5563]">
                {identity.isLoggedIn && studio.isLite ? (
                  <>
                    {/* ★ SAY IT ON STEP 1, NOT STEP 4.
                        Creator Studio tells a lite account the truth the moment
                        it loads. This wizard let the same account name a token,
                        price four services and choose a supply cap — three
                        steps of real work — before mentioning it at the last
                        screen. The effort is the cost; disclose before it is
                        spent, exactly as the Studio one click away already does. */}
                    Your token is bound to <strong>@{studio.creator}</strong> — one per account. But this account
                    can’t sign transactions yet, so it can’t launch one. You can look through the steps;{' '}
                    <a href="/upgrade" className="font-semibold text-[#c0392b] hover:underline">
                      upgrade to a full account
                    </a>{' '}
                    when you want to go ahead.
                  </>
                ) : identity.isLoggedIn ? (
                  <>
                    Your token is bound to <strong>@{studio.creator ?? identity.username}</strong> — one per account.
                    It can’t be moved or renamed, and nobody can create one pretending to be you.
                  </>
                ) : (
                  <>
                    A creator token is bound to one account, so you’ll need to be signed in to launch one. You can
                    look through the steps first —{' '}
                    <a href="/login" className="font-semibold text-[#c0392b] hover:underline">
                      sign in
                    </a>{' '}
                    when you’re ready.
                  </>
                )}
              </p>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <h1 className="font-serif text-2xl font-semibold text-[#161511]">What you offer</h1>
              <p className="mt-1.5 text-[14px] leading-[22px] text-[#6b7280]">Set each service’s price in dollars — that is the total the buyer pays. 88% of it is spent in your token at the live price; the other 12% goes to Lumen as a commission, paid in HBD.</p>
              <div className="mt-4 flex flex-col gap-3">
                {SERVICE_TEMPLATE.map((t) => (
                  <div key={t.key} className="flex items-center justify-between gap-3 rounded-xl border border-[#e4e6e9] px-4 py-3">
                    <div className="text-[14px] leading-[22px] font-semibold text-[#161511]">{t.name}</div>
                    <div className="flex items-center rounded-[10px] border border-[#e4e6e9] px-3 py-2">
                      <span className="font-bold text-[#9ca3af]">$</span>
                      <input
                        value={prices[t.key] ?? ''}
                        // ★ Named for assistive tech (2026-08-07). Chromium's
                        // accessibility tree reported every money field in this
                        // wizard as name:"" — two adjacent, identical, blank
                        // textboxes for two different service prices.
                        aria-label={`${t.name} price in dollars`}
                        onChange={(e) => setPrices({ ...prices, [t.key]: sanitizeMoneyInput(e.target.value) })}
                        inputMode="decimal"
                        className="ml-1 w-[70px] border-0 text-[15px] leading-[24px] font-bold tabular-nums text-[#161511] outline-none"
                      />
                    </div>
                  </div>
                ))}
                {['Unlock a post', 'Book a session', 'Tip'].map((n) => (
                  <div key={n} className="flex items-center justify-between rounded-xl border border-dashed border-[#e4e6e9] px-4 py-3 opacity-60">
                    <span className="text-[14px] leading-[22px] text-[#6b7280]">{n}</span>
                    <span className="rounded-full bg-[#f1f3f5] px-2.5 py-1 text-[12px] leading-[18px] font-semibold text-[#9ca3af]">Rolling out</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <h1 className="font-serif text-2xl font-semibold text-[#161511]">Launch</h1>
              {/* ★ STATE THE CAP, DON'T ASK FOR IT (2026-08-08).
                  Choosing a supply was deliberately removed as a step — it is a
                  hard question to put to someone who has not launched anything
                  yet, and the number is raisable later anyway. But removing the
                  QUESTION is not the same as hiding the ANSWER: a tester walked
                  this whole wizard and was never told a cap existed at all,
                  then met it for the first time in the Studio after launching.
                  One sentence, no extra step, no decision to make. */}
              <div className="mt-4 rounded-xl bg-[#f6f7f8] px-4 py-3.5 text-[14px] leading-[22px] text-[#4b5563]">
                <strong>Launching is free.</strong> Staying listed is <strong>~$10/month</strong> — first month included.
                <br />
                Your token starts capped at <strong>{STANDARD_CAP.toLocaleString()} tokens</strong>, the standard for
                every new creator. You can raise it later from your Studio.
              </div>
              <div className="mt-4">
                <label className="mb-1.5 block text-[13px] leading-[20px] font-semibold text-[#6b7280]">Optional anti-snipe first buy</label>
                <div className="flex items-center rounded-xl border border-[#e4e6e9] px-4 py-3">
                  <span className="text-[18px] leading-[28px] font-bold text-[#161511]">$</span>
                  <input value={firstBuy} aria-label="Your own first buy, in dollars" onChange={(e) => setFirstBuy(sanitizeMoneyInput(e.target.value))} placeholder="0" inputMode="decimal" className="ml-1 flex-1 border-0 text-[18px] leading-[28px] font-bold tabular-nums outline-none" />
                </div>
                <div className="mt-1.5 text-[12px] text-[#9ca3af]">Buy some of your own token at launch, at full price — this stops a bot grabbing the cheap first tokens ahead of you.</div>
              </div>
              <p className="mt-4 font-serif text-[13px] leading-[20px] text-[#9ca3af]">
                If you ever stop paying, your token’s market winds down, holders are refunded at the floor, and your delivery record resets — coming back means a new token.
              </p>
              {firstBuySkipped ? (
                <div className="mt-4 rounded-[12px] border border-[#f6e2c4] bg-[#fdf6ec] px-4 py-3.5 text-[14px] leading-[22px] font-semibold text-[#b45309]">
                  Your token launched, but the first buy didn’t go through — that amount was too small to afford one whole
                  token, or it would have pushed past your cap. Nothing was charged; you can buy from the Studio.
                </div>
              ) : null}
              {failed ? (
                // A failed launch must be LOUD and must not navigate: registering
                // is the irreversible step, and a creator who lands in the Studio
                // after a rejected signature would think they had a market.
                <div className="mt-4 rounded-[12px] border border-[#f0c9c2] bg-[#fef2f0] px-4 py-3.5 text-[14px] leading-[22px] font-semibold text-[#c0392b]">
                  Your token wasn’t launched. Nothing was charged. {failed}
                </div>
              ) : null}
              {studio.isLite ? (
                <div className="mt-4 rounded-[12px] border border-[#e4e6e9] bg-[#f6f7f8] px-4 py-3.5 text-[14px] leading-[22px] text-[#6b7280]">
                  This account can’t sign transactions yet, so it can’t launch a token. Upgrade to a full account first.
                </div>
              ) : null}
              {/* ★ The same courtesy for a signed-out visitor. The button was
                  already correctly disabled for them (`!studio.loggedIn`) but
                  said nothing about why — a dead control with no explanation,
                  in the one flow where the lite path explains itself perfectly
                  one condition away. */}
              {!studio.loggedIn ? (
                <div className="mt-4 rounded-[12px] border border-[#e4e6e9] bg-[#f6f7f8] px-4 py-3.5 text-[14px] leading-[22px] text-[#6b7280]">
                  You’ll need to be signed in to launch a token —{' '}
                  <a href="/login" className="font-semibold text-[#c0392b] hover:underline">
                    sign in
                  </a>{' '}
                  and your choices here stay as you set them.
                </div>
              ) : null}
              {/* ★★★ DO NOT BROADCAST WHAT WE CANNOT CHECK (2026-08-09).
                  `register` enforces one market per account on chain, so
                  launching when the creator ALREADY has one costs a real signed
                  transaction to buy a guaranteed on-chain failure. The wizard
                  guarded `status === 'unavailable'` (line ~245) but not
                  `'error'` — and a failed read is exactly the case where we do
                  not know whether a market exists. The studio deliberately
                  refuses to fall through to "you have no token" on a failed
                  read; the wizard must refuse to act on that same uncertainty,
                  or the two screens disagree about the same unknown. */}
              {cannotConfirmMarket ? (
                <div className="mt-4 rounded-[12px] border border-[#f6e2c4] bg-[#fdf6ec] px-4 py-3.5 text-[14px] leading-[22px] text-[#b45309]">
                  We can’t reach the chain to check whether you already have a token, so launching is held back —
                  signing now could spend a transaction on a launch that cannot succeed. Nothing is wrong with your
                  account.{' '}
                  <button onClick={studio.retry} className="font-semibold text-[#c0392b] underline">
                    Try again
                  </button>
                </div>
              ) : null}
              {alreadyHasMarket ? (
                <div className="mt-4 rounded-[12px] border border-[#e4e6e9] bg-[#f6f7f8] px-4 py-3.5 text-[14px] leading-[22px] text-[#6b7280]">
                  You already have a live token — a creator can only have one.{' '}
                  <a href="/creators/studio" className="font-semibold text-[#c0392b] hover:underline">
                    Open your studio
                  </a>{' '}
                  to manage it.
                </div>
              ) : null}
              {/* ★★★ AN EXPLICIT CONFIRM BEFORE THE IRREVERSIBLE CALL
                  (2026-08-11, audit item 5). The button below used to call
                  `launch()` directly on click — one click, no way back, and
                  the ONLY primary action on a step a restored draft can drop
                  a reader onto without them ever seeing steps 1 or 2. Arming
                  first and asking again, in words, is the smaller gate than a
                  second dialog and keeps the whole flow on one screen. */}
              {confirmArmed && !firstBuySkipped ? (
                <div className="mt-5 rounded-[12px] border border-[#e4e6e9] bg-[#f6f7f8] px-4 py-3.5">
                  <p className="text-[14px] leading-[22px] font-semibold text-[#161511]">
                    This launches your token on the chain. It can’t be undone.
                  </p>
                  <div className="mt-3 flex gap-2.5">
                    <button
                      onClick={() => setConfirmArmed(false)}
                      disabled={launching}
                      className="flex-1 rounded-[11px] border border-[#e4e6e9] bg-white py-2.5 text-[14px] leading-[22px] font-semibold text-[#3f4650] disabled:opacity-60"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={launch}
                      disabled={launching}
                      className="flex-1 rounded-[11px] bg-[#c0392b] py-2.5 text-[14px] leading-[22px] font-bold text-white hover:bg-[#96271b] disabled:opacity-60"
                    >
                      {launching ? 'Launching…' : 'Yes, launch my token'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={firstBuySkipped ? () => router.push('/creators/studio') : () => setConfirmArmed(true)}
                  disabled={
                    launching ||
                    studio.isLite ||
                    !studio.loggedIn ||
                    formError !== null ||
                    cannotConfirmMarket ||
                    alreadyHasMarket
                  }
                  // Every sibling control in this feature exposes its disabled
                  // reason to assistive tech via `title`; this one did not.
                  title={
                    formError ??
                    (!studio.loggedIn
                      ? 'Sign in to launch a token.'
                      : studio.isLite
                        ? 'This account can’t sign transactions yet. Upgrade to a full account first.'
                        : cannotConfirmMarket
                          ? 'We can’t check whether you already have a token right now.'
                          : alreadyHasMarket
                            ? 'You already have a token. A creator can only have one.'
                            : undefined)
                  }
                  className="mt-5 w-full rounded-[13px] bg-[#c0392b] py-[15px] text-[15px] leading-[24px] font-bold text-white hover:bg-[#96271b] disabled:opacity-60"
                >
                  {firstBuySkipped
                    ? 'Continue to Studio'
                    : `Launch my token${firstBuy && parseFloat(firstBuy.replace(/,/g, '')) > 0 ? ` · first buy ${usdWhole(parseFloat(firstBuy.replace(/,/g, '')) || 0)}` : ''}`}
                </button>
              )}
            </>
          ) : null}

          {/* ★ The reason a control is disabled must be VISIBLE, not a hover-only
              `title` — a tooltip never appears on touch and is not read out.
              (Same defect was filed against the Ask button in the same QA round.) */}
          {step < 2 && stepError ? (
            <p className="mt-5 text-[13px] leading-[20px] font-semibold text-[#c0392b]">{stepError}</p>
          ) : null}
          {step === 2 && formError ? (
            <p className="mt-4 text-[13px] leading-[20px] font-semibold text-[#c0392b]">
              {formError} Go back and correct it before launching.
            </p>
          ) : null}

          {/* Nav */}
          {step < 2 ? (
            <div className="mt-6 flex items-center justify-between">
              <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} className="text-[14px] leading-[22px] font-semibold text-[#6b7280] disabled:opacity-0">Back</button>
              <button
                onClick={() => setStep((s) => Math.min(2, s + 1))}
                disabled={stepError !== null}
                title={stepError ?? undefined}
                className="rounded-[11px] bg-[#161511] px-6 py-2.5 text-[14px] leading-[22px] font-semibold text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue
              </button>
            </div>
          ) : (
            <div className="mt-4 text-center">
              <button
                onClick={() => {
                  setConfirmArmed(false);
                  setStep(1);
                }}
                className="text-[14px] leading-[22px] font-semibold text-[#6b7280]"
              >
                Back
              </button>
            </div>
          )}
        </div>
      </div>
    </TokenShell>
  );
};

export default LaunchWizard;
