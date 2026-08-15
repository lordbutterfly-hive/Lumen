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
import { MERITUM_COMMISSION_PCT, useMeritumLaunch } from './use-meritum-launch';
import type { MeritumLaunchBlock } from './use-meritum-launch';

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
   */
  useEffect(() => {
    if (write !== 'failed') return;
    strikeRef.current?.reset();
    setStage('none');
  }, [write]);

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
  const holdFromButton = useCallback(() => {
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
  /**
   * Never raised while the ring is closing — the coin aborts a hold the moment
   * it is disabled, and `write` only leaves `idle` after the strike has already
   * committed. `ok` keeps it down for good: the chain enforces one market per
   * account, so a second hold could only buy a guaranteed on-chain failure.
   */
  const strikeDisabled = flow.block !== null || write === 'pending' || write === 'ok';

  const blockMessage = (block: MeritumLaunchBlock | null): string | null => {
    switch (block) {
      case 'no-offer':
        return t('meritum_launch.error_needs_one_offer');
      case 'offer-needs-name':
        return t('meritum_launch.error_offer_needs_name');
      case 'offer-duplicate-name':
        return t('meritum_launch.error_offer_duplicate_name');
      case 'price-band':
        // Bounds come from the contract's own params, never from copy. The
        // minimum is printed at its own precision ($0.577, three decimals like
        // HBD) — rounding it to $0.58 would hide a price the chain accepts.
        return t('meritum_launch.error_price_band', {
          min: `$${MIN_PRICE_USD}`,
          max: usdWhole(MAX_PRICE_USD)
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
          headline: t('meritum_launch.headline_landing'),
          subline: t('meritum_launch.subline_landing')
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
              eyebrow: t('meritum_launch.eyebrow_step3'),
              headline: t('meritum_launch.headline_step3'),
              subline: t('meritum_launch.subline_step3')
            };

  const caption = live
    ? { text: t('meritum_launch.caption_struck'), sub: t('meritum_launch.caption_struck_sub'), brand: true }
    : landing
      ? { text: t('meritum_launch.caption_landing'), sub: t('meritum_launch.caption_landing_sub'), brand: true }
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
    striking: t('meritum_launch.status_striking'),
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
    <TokenShell>
      <div className="min-w-0 max-w-[940px]">
        {flow.restoredFromDraft && !live ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-meritum-line-card bg-meritum-rail px-4 py-3 text-13 text-meritum-ink-3">
            <span>{t('meritum_launch.draft_restored', { step: flow.step })}</span>
            <button
              type="button"
              onClick={flow.startOver}
              className="flex-shrink-0 text-13 font-semibold text-meritum-ink-link hover:underline"
            >
              {t('meritum_launch.draft_start_over')}
            </button>
          </div>
        ) : null}

        {/* ★ `clip-path`, NOT `overflow-hidden`. See the file header. */}
        <div
          ref={cardRef}
          className="flex flex-wrap items-stretch rounded-[18px] border border-meritum-line-card bg-meritum-card [clip-path:inset(0_round_18px)]"
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
            <span className="text-12 font-bold uppercase tracking-[0.18em] text-meritum-ink-brand">
              {header.eyebrow}
            </span>
            <h1 className="mt-3 max-w-[22ch] font-serif text-34 font-semibold tracking-[-0.02em] text-meritum-ink">
              {header.headline}
            </h1>
            <p className="mt-3 max-w-[52ch] font-serif text-15 text-meritum-ink-3">{header.subline}</p>

            {live ? (
              <LaunchStruck
                account={account}
                openingPrice={flow.openingPrice}
                commission={commission}
                offersFailed={flow.offersFailed}
                firstBuySkipped={flow.firstBuySkipped}
              />
            ) : landing ? (
              <p className="mt-[26px] max-w-[52ch] font-serif text-15 text-meritum-ink-3">
                {t('meritum_launch.landing_body')}
              </p>
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
                cap={flow.cap}
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
                onHoldBegin={holdFromButton}
                onHoldRelease={releaseFromButton}
                onBack={flow.goBack}
              />
            )}
          </div>

          {/* Basis lowered 360 -> 330 with the copy column; see the note above.
              330 is the floor: 268px coin + 2 x 30px padding = 328. */}
          <div className="min-w-[min(100%,330px)] flex-1 basis-[330px] border-l border-meritum-line-card bg-meritum-rail px-[30px] pb-9">
            {/* ★ 96px, the app's own sticky offset. The card above must not clip
                with `overflow`, or this never pins. */}
            <div className="sticky top-24">
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
          ★ THE FORM THIS SCREEN REPLACED IS STILL REACHABLE. It is the flow
          that has been launching real tokens, and it stays one click away until
          this one has the same mileage.
        */}
        {live ? null : (
          <p className="mt-6 text-13 text-meritum-ink-muted">
            {t('meritum_launch.classic_prompt')}{' '}
            <a href="/creators/launch/classic" className="font-semibold text-meritum-ink-link hover:underline">
              {t('meritum_launch.classic_link')}
            </a>
          </p>
        )}
      </div>
    </TokenShell>
  );
};

export default MeritumLaunchFlow;
