'use client';

import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { MarketUnavailable } from '../../../live/market-states';
import { usdWhole } from '../../../market/format';
import TokenShell from '../../token-shell';
import type { HoldToStrikeHandle, MeritumStrikePhase } from '../coin';
import { buildMeritumLedger } from './build-ledger';
import LaunchStepAccount from './launch-step-account';
import LaunchStepOffers from './launch-step-offers';
import LaunchStepTerms from './launch-step-terms';
import LaunchStruck from './launch-struck';
import MeritumCoinRail from './meritum-coin-rail';
import { MAX_PRICE_USD, MIN_PRICE_USD } from '../../launch-money';
import { LAUNCH_CONFIRM_MINUTES, MERITUM_COMMISSION_PCT, useMeritumLaunch } from './use-meritum-launch';
import type { MeritumLaunchBlock } from './use-meritum-launch';
import { offerTitleProblem } from '@/blog/features/creator-tokens/lib/vsc/op-builders';

/**
 * SCREEN 2 — THE MERITUM LAUNCH FLOW.
 *
 * Three steps in one card, then the strike. Copy on the left, the coin rail on
 * the right, one card around both.
 *
 * ★★★ THE CARD CLIPS WITH `clip-path`, NEVER `overflow: hidden`. This is
 * correctness, not taste: `overflow:hidden` makes the card the scrollport for
 * its own sticky descendant, so the coin can never pin to the viewport and the
 * whole right rail silently stops working. `clip-path: inset(0 round 18px)`
 * rounds the corners in both the side-by-side and the wrapped layout without
 * creating a scrolling box.
 *
 * ★★★ THE REVEAL IS GATED ON THE WRITE, NOT ON THE TIMER. `onCharged` fires
 * the real launch at 1100ms with 2400ms of strike still to run, which is the
 * whole point of that callback — the network gets the animation as its budget.
 * But a signature prompt can outlast 2400ms, so the struck panel waits for the
 * result, and a rejected write calls `reset()` on the coin. A coin sitting
 * there struck, describing a market that does not exist, is the one outcome
 * this screen must never produce.
 *
 * ★ THE `JUMP TO` ROW FROM THE REFERENCE IS NOT HERE. It was a prototype
 * switcher for clicking through states without filling anything in. Shipping it
 * would let a reader skip to the strike with nothing priced.
 */

/** Where the reader is in the strike, as far as this screen can observe it. */
type HoldStage = 'none' | 'charging' | 'striking' | 'revealed';

/**
 * ★ M9 — THE PRICE-BAND MINIMUM MUST NEVER DISPLAY BELOW THE REAL FLOOR
 * (2026-08-16).
 *
 * `MIN_PRICE_USD` / `MAX_PRICE_USD` are derived (`base units / 1000`), not
 * literals, so they carry ordinary floating-point noise (`577 / 1000` is
 * `0.57699999999999995737` under the hood). This formats both to the cent —
 * the finest grain a contract param expressed in base units can land on.
 *
 * The two edges round in OPPOSITE directions on purpose: `Math.ceil` for the
 * minimum, `Math.floor` for the maximum. The contract enforces `price >=
 * MIN_PRICE_USD` and `price <= MAX_PRICE_USD`. Rounding the minimum DOWN (or
 * to nearest) could print a cent value below the real floor — a reader who
 * types exactly what the copy told them would then get rejected on chain.
 * Rounding the maximum UP has the same failure mode in reverse. Ceil/floor at
 * the cent is the only pairing where the printed bound is always something
 * the form actually accepts. With today's params neither changes the digits
 * ($0.577 -> $0.58, $10,000 stays $10,000) — this only matters if the
 * contract's params move to a less round number later.
 */
const formatPriceBound = (n: number, edge: 'min' | 'max'): string => {
  const cents = edge === 'min' ? Math.ceil(n * 100) : Math.floor(n * 100);
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
};

const MeritumLaunchFlow: FC = () => {
  const { t } = useTranslation('common_blog');
  const flow = useMeritumLaunch();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const strikeRef = useRef<HoldToStrikeHandle>(null);
  const [stage, setStage] = useState<HoldStage>('none');

  const { write, launch } = flow;

  /**
   * ★ THE WRITE FAILED, SO THE COIN MUST NOT STAY STRUCK. `reset()` drops the
   * strike timer too, so a rejection that arrives mid-animation also cancels
   * the reveal that was already scheduled.
   *
   * ★★ DEPEND ON `stage` TOO (2026-09-01). A same-tab retry after a
   * REGISTER_UNCONFIRMED keeps `write === 'failed'` and calls `setWrite('failed')`
   * again — a same-value set that React bails out of, so an effect keyed on
   * `[write]` alone never re-fired and the coin sat on "Striking" forever beside
   * the failure banner. `onCharged` moves `stage` to 'striking' on every hold,
   * so keying on `stage` too re-runs this and resets the coin on the retry. The
   * guard still means it only ever acts while the write is failed, so a genuine
   * first strike (write 'pending' during 'striking') is untouched.
   */
  useEffect(() => {
    if (write !== 'failed') return;
    strikeRef.current?.reset();
    setStage('none');
  }, [write, stage]);

  const onHoldBegin = useCallback(() => setStage('charging'), []);
  const onCharged = useCallback(() => {
    setStage('striking');
    launch();
  }, [launch]);
  const onStruck = useCallback(() => setStage('revealed'), []);
  const onAbort = useCallback(() => setStage('none'), []);

  /**
   * ★ A HOLD THAT IS UNMOUNTED IS A HOLD THAT ENDED (2026-08-15, council).
   *
   * `BackAction` stays clickable while a hold is charging. Hold the coin with
   * Enter, click Back with the mouse, and `strikeable` (step === 3) flips false,
   * so the rail swaps `<HoldToStrike>` out for a plain coin and React discards
   * the hook. Its unmount cleanup correctly clears every timer and the height
   * lock — but it does NOT call `onAbort`, because nothing aborted; the tree was
   * simply thrown away. `stage` was left at 'charging', so steps 1 and 2 then
   * showed "Holding. Let go before the ring closes and nothing happens." with
   * nothing being held.
   *
   * Leaving step 3 ends any hold this screen believes is in progress.
   */
  useEffect(() => {
    if (flow.step === 3) return;
    setStage((s) => (s === 'charging' || s === 'striking' ? 'none' : s));
  }, [flow.step]);

  /**
   * The left-column button drives the coin's machine, never a second one.
   *
   * ★ AND IT MUST ALSO MOVE `stage` (2026-08-15, council). The coin rail sets
   * `stage='charging'` from its own pointer/key capture handlers, which only see
   * events inside the COIN's subtree. Holding this button instead called
   * `begin()` directly and bypassed them, so the machine genuinely charged —
   * ring sweeping, coin trembling — while the caption sat on "Ready" for the
   * whole 1100ms and then jumped straight to "Striking". 100% reproducible via
   * the documented second press target. Abort already self-healed through the
   * shared `onAbort`, so only the charging window was wrong.
   */
  /*
   * ★★ AND IT MUST REFUSE WHEN THE STRIKE IS DISABLED (2026-08-16, found by a
   * QA pass driving the flow as a lite creator).
   *
   * This set `stage` unconditionally. The coin's own `useHoldToStrike.begin()`
   * correctly no-ops while the strike is disabled, so the internal phase machine
   * stayed `idle` — but the CAPTION had already been moved to "charging", and on
   * release `abort()` also no-ops (it only acts on `phase === 'charging'`), so
   * `onAbort` never fired and nothing ever put the caption back.
   *
   * The result on a screen captioned "Everything below is honest": a lite
   * creator presses the visibly disabled control, and the panel reads
   * "HOLDING... let go before the ring closes and nothing happens" FOREVER —
   * recoverable only by leaving step 3 and coming back. No signature was ever at
   * risk; the lie was.
   *
   * Read through a ref rather than a dependency so the handler keeps the stable
   * identity the coin's memoised subtree relies on.
   */
  const strikeDisabledRef = useRef(false);
  const holdFromButton = useCallback(() => {
    if (strikeDisabledRef.current) return;
    setStage('charging');
    strikeRef.current?.begin();
  }, []);
  const releaseFromButton = useCallback(() => strikeRef.current?.abort(), []);

  if (flow.unavailable) return <MarketUnavailable />;

  const account = flow.handle === '' ? '' : flow.handle.slice(1);
  const commission = `${MERITUM_COMMISSION_PCT}%`;
  const live = stage === 'revealed' && write === 'ok';
  /**
   * ★ THE COIN NOW WAITS FOR THE CHAIN TOO (2026-08-15, adversarial council).
   *
   * `coinStruck` used to be `stage === 'revealed'` — i.e. driven purely by the
   * coin's own MERITUM_STRIKE_MS timer. Since `HoldToStrike` omits `phase`, that
   * timer alone turned the coin oxblood, embossed its legend, engraved the price
   * and announced "Struck. Your token is live." to screen readers, while this
   * very component rendered the `landing` caption — "waiting for the chain to
   * answer" — directly underneath it. An unanswered signature prompt outlasts
   * 2400ms as a matter of course, so that contradiction was the ordinary path.
   *
   * It is now the WRITE. Passed down as `revealWhen`, it holds the coin at
   * `striking` until the market genuinely exists, which is what this prop's own
   * documentation always claimed it meant. No deadlock: it depends on `write`,
   * never on `stage`, so nothing waits on the reveal it is gating.
   */
  const coinStruck = write === 'ok';
  /**
   * And `landing` moves with it. It used to require `stage === 'revealed'`,
   * which after the gate can no longer happen before the write lands — so left
   * as it was, the "waiting for the chain" copy would never render at all and a
   * reader with a pending signature would watch a silent striking coin.
   */
  const landing = (stage === 'striking' || stage === 'revealed') && write === 'pending';
  // Item B: the two sub-phases of the landing window — 'signing' (waiting for the
  // single wallet signature) then 'confirming' (signed, waiting for the chain).
  // Sourced from the hook so the copy tracks the real write, never a timer.
  const launchPhase = flow.launchPhase;
  /**
   * Never raised while the ring is closing — the coin aborts a hold the moment
   * it is disabled, and `write` only leaves `idle` after the strike has already
   * committed. `ok` keeps it down for good: the chain enforces one market per
   * account, so a second hold could only buy a guaranteed on-chain failure.
   */
  const strikeDisabled = flow.block !== null || write === 'pending' || write === 'ok';
  // Mirrored into the ref the hold handler reads — see `holdFromButton` above.
  strikeDisabledRef.current = strikeDisabled;

  const blockMessage = (block: MeritumLaunchBlock | null): string | null => {
    switch (block) {
      case 'no-offer':
        return t('meritum_launch.error_needs_one_offer');
      case 'offer-needs-name':
        return t('meritum_launch.error_offer_needs_name');
      case 'offer-duplicate-name':
        return t('meritum_launch.error_offer_duplicate_name');
      case 'offer-bad-title':
        // ★ The validator's OWN sentence, not a translated paraphrase. It names
        // the specific rule broken ("cannot contain a comma. Try a dash or a
        // colon instead."), and it is generated from the same mirror of
        // core/offerings.go that decides the block — so the reason shown and the
        // reason enforced cannot drift apart the way a hand-written copy string
        // would. Deliberately untranslated for that reason; a translated variant
        // must come from the validator too, never from a second list of rules.
        return (
          flow.offers.map((o) => offerTitleProblem(o.name)).find((m) => m !== null) ??
          t('meritum_launch.error_offer_needs_name')
        );
      case 'offer-supply-share':
        // The validator's OWN sentence, for the same reason 'offer-bad-title'
        // uses one: it names the creator's actual numbers (this price, this
        // token count, this cap) and it is produced by the code that decides
        // the block, so shown and enforced cannot drift. Untranslated for that
        // reason; a translated variant must come from the validator too.
        return flow.offerSupplyShareMessage;
      case 'price-band':
        // Bounds come from the contract's own params, never from copy. They
        // used to be formatted two different ways: the max through `usdWhole`,
        // the min interpolated raw ($0.577, whatever `MIN_PRICE_USD` happened
        // to stringify to). `formatPriceBound` below replaces both so the pair
        // reads consistently and neither side risks printing floating-point
        // noise (`577 / 1000` is clean; not every contract param will be).
        return t('meritum_launch.error_price_band', {
          min: formatPriceBound(MIN_PRICE_USD, 'min'),
          max: formatPriceBound(MAX_PRICE_USD, 'max')
        });
      case 'first-buy-max':
        return t('meritum_launch.error_first_buy_max', { max: usdWhole(MAX_PRICE_USD) });
      default:
        // signed-out / lite / unknown-market / has-market each render their own
        // block with a way out of it, so a second line here would just repeat.
        return null;
    }
  };

  const header = live
    ? {
        eyebrow: t('meritum_launch.eyebrow_struck'),
        headline: t('meritum_launch.headline_struck'),
        subline: t('meritum_launch.subline_struck', { handle: flow.handle, price: flow.openingPrice })
      }
    : landing
      ? {
          eyebrow: t('meritum_launch.eyebrow_landing'),
          headline:
            launchPhase === 'confirming'
              ? t('meritum_launch.headline_confirming')
              : t('meritum_launch.headline_landing'),
          subline:
            launchPhase === 'confirming'
              ? t('meritum_launch.subline_confirming', { minutes: LAUNCH_CONFIRM_MINUTES })
              : t('meritum_launch.subline_landing')
        }
      : flow.step === 1
        ? {
            eyebrow: t('meritum_launch.eyebrow_step1'),
            headline: t('meritum_launch.headline_step1'),
            subline: t('meritum_launch.subline_step1', { handle: flow.handle || t('meritum_launch.account_unknown') })
          }
        : flow.step === 2
          ? {
              eyebrow: t('meritum_launch.eyebrow_step2'),
              headline: t('meritum_launch.headline_step2'),
              subline: t('meritum_launch.subline_step2')
            }
          : {
              /*
                ★ NO EYEBROW ON STEP 3 (2026-08-17, verified UX defect #5).
                `eyebrow_step3` reads "Everything below is honest" directly
                above a screen whose own `subline_step3` reads "Nothing here
                is hidden in a tooltip." Saying that about yourself is the
                opposite of proving it — an honest screen does not need to
                announce its own honesty, it just has to BE the terms list
                underneath. The key stays in the locale file (unused here on
                purpose); only the render drops it, and only for step 3.
              */
              eyebrow: '',
              headline: t('meritum_launch.headline_step3'),
              // ★ NO SUBLINE ON STEP 3 (owner, 2026-09-04). The "nothing is
              // hidden in a tooltip" line announced its own honesty; the terms
              // list below is the honesty. Empty string, guarded at the render.
              subline: ''
            };

  const caption = live
    ? { text: t('meritum_launch.caption_struck'), sub: t('meritum_launch.caption_struck_sub'), brand: true }
    : landing
      ? {
          text: t('meritum_launch.caption_landing'),
          sub:
            launchPhase === 'signing'
              ? t('meritum_launch.caption_signing_sub')
              : t('meritum_launch.caption_landing_sub'),
          brand: true
        }
      : stage === 'striking'
        ? { text: t('meritum_launch.caption_striking'), sub: t('meritum_launch.caption_striking_sub'), brand: true }
        : stage === 'charging'
          ? { text: t('meritum_launch.caption_holding'), sub: t('meritum_launch.caption_holding_sub'), brand: true }
          : flow.step === 3
            ? { text: t('meritum_launch.caption_ready'), sub: t('meritum_launch.caption_ready_sub'), brand: true }
            : flow.furthestStep >= 2
              ? {
                  text: t('meritum_launch.caption_engraving'),
                  sub: t('meritum_launch.caption_engraving_sub'),
                  brand: false
                }
              : { text: t('meritum_launch.caption_blank'), sub: t('meritum_launch.caption_blank_sub'), brand: false };

  const statusLabels: Partial<Record<MeritumStrikePhase, string>> = {
    charging: t('meritum_launch.status_charging'),
    // Item B: while the coin is in its 'striking' phase AND the write is
    // confirming on chain, the screen-reader status is the on-chain wait, not
    // "hold still" — nothing is being held any more.
    striking:
      landing && launchPhase === 'confirming'
        ? t('meritum_launch.status_confirming', { minutes: LAUNCH_CONFIRM_MINUTES })
        : t('meritum_launch.status_striking'),
    struck: t('meritum_launch.status_struck')
  };

  const rows = buildMeritumLedger({
    handle: flow.handle,
    offers: flow.offers,
    furthestStep: flow.furthestStep,
    // The ledger's struck shape means "the market exists", so it follows the
    // WRITE, not the animation.
    struck: write === 'ok',
    openingPrice: flow.openingPrice,
    commission,
    labels: {
      boundTo: t('meritum_launch.ledger_bound_to'),
      offer: (n: number) => t('meritum_launch.ledger_offer', { n }),
      openingPrice: t('meritum_launch.ledger_opening_price'),
      lumenTakes: t('meritum_launch.ledger_lumen_takes')
    }
  });

  return (
    <TokenShell back={{ href: '/creators', label: '← All creators' }}>
      <div className="min-w-0 max-w-[940px]">
        {flow.restoredFromDraft && !live ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-meritum-line-card bg-meritum-rail px-4 py-3 text-caption text-meritum-ink-3 font-ui">
            <span>{t('meritum_launch.draft_restored', { step: flow.step })}</span>
            <button
              type="button"
              onClick={flow.startOver}
              // ★ 44x44 MINIMUM TAP TARGET (2026-08-31, verified UX defect).
              // Same fix as `BackAction` in launch-controls.tsx: text-only and
              // borderless, so the padding only grows the hit area.
              className="inline-flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center px-2 text-caption font-medium text-meritum-ink-link font-ui hover:underline"
            >
              {t('meritum_launch.draft_start_over')}
            </button>
          </div>
        ) : null}

        {/* ★ `clip-path`, NOT `overflow-hidden`. See the file header. */}
        <div
          ref={cardRef}
          className="flex flex-wrap items-stretch rounded-panel border border-meritum-line-card bg-meritum-card [clip-path:inset(0_round_18px)]"
        >
          {/*
            ★ BASIS PAIR IS MEASURED, NOT COPIED FROM THE MOCK (2026-08-15).
            `flex-wrap` decides wrapping on each item's HYPOTHETICAL main size —
            its flex-basis — BEFORE any shrinking is applied. So the pair must
            sum under the real card width or the rail wraps no matter how
            shrinkable the columns are.

            Measured in a browser: the app shell gives this page a 750px card at
            a 1440px viewport. The original 420 + 360 = 780 exceeded it, so the
            coin rail dropped BELOW the copy at the commonest desktop width —
            and at exactly the width the design mock shows side by side. It only
            held from ~1728px up. The mock was ~940px wide with no right rail;
            this page has one.

            380 + 330 = 710 leaves 40px of slack at 750. The rail cannot go below
            330: the coin is 268px inside px-[30px], so 328px is its hard floor.
          */}
          <div className="min-w-[min(100%,340px)] flex-1 basis-[380px] px-9 pb-9 pt-[34px]">
            {/*
              ★ "STEP X OF 3" (2026-08-17, verified UX defect #3). There was no
              indicator anywhere in this flow telling a reader how much of it
              was left — only three panels that silently swap for each other
              inside the same card. Shown for the three real steps only: once
              a signature is landing or the coin has struck, "step" is no
              longer the right frame for what is on screen.
            */}
            {!live && !landing ? (
              <div className="text-label font-medium uppercase tracking-label tabular-nums text-meritum-ink-faint font-ui">
                {t('meritum_launch.step_indicator', { step: flow.step })}
              </div>
            ) : null}
            {header.eyebrow ? (
              <span className="mt-2 inline-block text-label font-medium uppercase tracking-label text-meritum-ink-brand font-ui">
                {header.eyebrow}
              </span>
            ) : null}
            <h1 className="mt-3 max-w-[22ch] font-ui text-34 font-medium tracking-[-0.02em] text-meritum-ink">
              {header.headline}
            </h1>
            {header.subline ? (
              <p className="mt-3 max-w-[52ch] font-ui text-15 text-meritum-ink-3">{header.subline}</p>
            ) : null}

            {live ? (
              <LaunchStruck
                account={account}
                openingPrice={flow.openingPrice}
                commission={commission}
                offersFailed={flow.offersFailed}
                firstBuySkipped={flow.firstBuySkipped}
              />
            ) : landing ? (
              /* ★ ITEM B — LIVE PROGRESS, phase-aware, with an aria-live region.
                 signing: "approve in your wallet"; confirming: "up to N min,
                 leave open" plus a looping indicator so the wait never looks
                 frozen (the coin's own 1.5s impact is a one-shot). The "N min"
                 is sourced from the confirm-timeout const (LAUNCH_CONFIRM_MINUTES)
                 so it cannot drift from the real ceiling. */
              <div className="mt-[26px]" role="status" aria-live="polite">
                <p className="max-w-[52ch] font-ui text-15 text-meritum-ink-3">
                  {launchPhase === 'signing'
                    ? t('meritum_launch.landing_signing')
                    : t('meritum_launch.landing_confirming', { minutes: LAUNCH_CONFIRM_MINUTES })}
                </p>
                {launchPhase === 'confirming' ? (
                  <div className="mt-4 flex items-center gap-2 font-ui text-caption text-meritum-ink-muted">
                    <span className="inline-flex items-center gap-1" aria-hidden="true">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-meritum-ink-brand [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-meritum-ink-brand [animation-delay:200ms]" />
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-meritum-ink-brand [animation-delay:400ms]" />
                    </span>
                    <span>{t('meritum_launch.landing_working')}</span>
                  </div>
                ) : null}
              </div>
            ) : flow.step === 1 ? (
              <LaunchStepAccount
                handle={flow.handle}
                account={account}
                isLite={flow.block === 'lite'}
                onConfirm={flow.goNext}
              />
            ) : flow.step === 2 ? (
              <LaunchStepOffers
                account={account}
                offers={flow.offers}
                onName={flow.setOfferName}
                onPrice={flow.setOfferPrice}
                block={flow.stepBlock}
                blockMessage={blockMessage(flow.stepBlock)}
                onContinue={flow.goNext}
                onBack={flow.goBack}
              />
            ) : (
              <LaunchStepTerms
                rules={flow.rules}
                commission={commission}
                firstBuy={flow.firstBuy}
                onFirstBuy={flow.setFirstBuy}
                block={flow.block}
                blockMessage={blockMessage(flow.block)}
                canRetryRead={flow.canRetryRead}
                onRetryRead={flow.retryRead}
                alreadyHasMarket={flow.alreadyHasMarket}
                pending={write === 'pending'}
                failure={flow.failure}
                launchUnconfirmed={flow.launchUnconfirmed}
                spending={flow.spending}
                launchRcMessage={flow.launchRcMessage}
                account={account}
                onHoldBegin={holdFromButton}
                onHoldRelease={releaseFromButton}
                onBack={flow.goBack}
              />
            )}
          </div>

          {/* Basis lowered 360 -> 330 with the copy column; see the note above.
              330 is the floor: 268px coin + 2 x 30px padding = 328. */}
          <div className="min-w-[min(100%,330px)] flex-1 basis-[330px] border-l border-meritum-line-card bg-meritum-rail px-[30px] pb-9">
            {/* ★ 96px on desktop — the app's own sticky offset, unchanged — and 141px on a
                phone, where the header is 126px tall and a bare `top-24` pinned this rail
                THIRTY PIXELS INSIDE the header instead of below it, taking the "Yes,
                that's me" button with it. See `--header-h` in globals.css. The card above
                must not clip with `overflow`, or this never pins. */}
            <div className="lm-sticky-below-header">
              <MeritumCoinRail
                handle={flow.handle}
                offersPriced={flow.offersPriced}
                furthestStep={flow.furthestStep}
                openingPrice={flow.openingPrice}
                strikeable={flow.step === 3}
                strikeDisabled={strikeDisabled}
                strikeRef={strikeRef}
                heightLockRef={cardRef}
                onHoldBegin={onHoldBegin}
                onCharged={onCharged}
                onStruck={onStruck}
                onAbort={onAbort}
                struck={coinStruck}
                caption={caption.text}
                captionSub={caption.sub}
                captionBrand={caption.brand}
                holdLabel={t('meritum_launch.hold_aria')}
                statusLabels={statusLabels}
                blankLabel={t('meritum_launch.coin_unstruck')}
                unboundLabel={t('meritum_launch.coin_unbound')}
                coinAlt={t('meritum_launch.coin_alt')}
                rows={rows}
                ledgerEmptyLabel={t('meritum_launch.ledger_empty')}
              />
            </div>
          </div>
        </div>

        {/*
          ★ THE CLASSIC FORM AND ITS ESCAPE HATCH ARE GONE (2026-08-16, owner).
          There is one launch flow now. Two doors to the same chain calls meant
          two screens to keep correct, and the fallback link advertised that the
          screen you were on was the unfinished one.
        */}
      </div>
    </TokenShell>
  );
};

export default MeritumLaunchFlow;
