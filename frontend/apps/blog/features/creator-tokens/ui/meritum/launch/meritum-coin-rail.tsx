'use client';

import type { FC, KeyboardEvent, PointerEvent, Ref, RefObject } from 'react';
import { COIN_EDGE_PX, HoldToStrike, MeritumCoin } from '../coin';
import type { HoldToStrikeHandle, MeritumStrikePhase } from '../coin';
import MeritumRailLedger from './meritum-rail-ledger';
import type { MeritumLedgerRow } from './meritum-rail-ledger';
import type { MeritumLaunchStep } from './use-meritum-launch';

/**
 * THE COIN RAIL — the right column of the launch card.
 *
 * Three things stacked: the coin, a two-line caption, and the ledger. The
 * whole group is `position: sticky; top: 96px` so it holds beside the copy
 * while the reader scrolls, which is why the CARD must clip with `clip-path`
 * and not `overflow: hidden` (see `meritum-launch-flow.tsx`).
 *
 * ★ THE COIN ITSELF IS NOT REBUILT HERE. `<MeritumCoin>` is the display coin
 * for steps 1 and 2; `<HoldToStrike>` is the same coin as a press target for
 * step 3 onwards. Both earn their detail from flow state — the handle, the
 * count of offers actually priced, the furthest step reached.
 *
 * ★ WHY THE HOLD IS DETECTED BY BUBBLING RATHER THAN BY A CALLBACK. The strike
 * exposes `onCharged` / `onStruck` / `onAbort` but nothing for "a hold has
 * begun", and the caption changes at that moment. Every EXIT from charging
 * fires one of the two callbacks the caller already owns, so a pointer-down on
 * the button is enough to open the state and the existing callbacks close it.
 * The strike's own timers are untouched by this; it is a caption, not a gate.
 */

export interface MeritumCoinRailProps {
  handle: string;
  offersPriced: number;
  furthestStep: MeritumLaunchStep;
  openingPrice: string;

  /** True at step 3 onwards, where the coin becomes a control. */
  strikeable: boolean;
  /** No hold may start. Must never be raised mid-charge by the caller. */
  strikeDisabled: boolean;
  strikeRef: Ref<HoldToStrikeHandle>;
  heightLockRef: RefObject<HTMLElement | null>;
  onHoldBegin: () => void;
  onCharged: () => void;
  onStruck: () => void;
  onAbort: () => void;

  /** True once the market is genuinely live, so the coin may read as struck. */
  struck: boolean;

  caption: string;
  captionSub: string;
  /** Brand ink on the caption from step 3 onwards. */
  captionBrand: boolean;
  holdLabel: string;
  statusLabels: Partial<Record<MeritumStrikePhase, string>>;
  /** The exergue before the strike. */
  blankLabel: string;
  unboundLabel: string;
  coinAlt: string;

  rows: MeritumLedgerRow[];
  ledgerEmptyLabel: string;
}

/** Sized off the coin so a change to the coin cannot leave these behind. */
const HINT_PX = COIN_EDGE_PX + 24;
const GLOW_PX = COIN_EDGE_PX + 50;

const MeritumCoinRail: FC<MeritumCoinRailProps> = ({
  handle,
  offersPriced,
  furthestStep,
  openingPrice,
  strikeable,
  strikeDisabled,
  strikeRef,
  heightLockRef,
  onHoldBegin,
  onCharged,
  onStruck,
  onAbort,
  struck,
  caption,
  captionSub,
  captionBrand,
  holdLabel,
  statusLabels,
  blankLabel,
  unboundLabel,
  coinAlt,
  rows,
  ledgerEmptyLabel
}) => {
  const coinState = { handle, offersPriced, step: furthestStep, openingPrice };
  const armed = strikeable && !strikeDisabled && !struck;

  /* Only a real, accepted hold opens the caption. A right-click, a stray key
     or a disabled control must not claim the reader is holding anything. */
  const noteHold = (): void => {
    if (armed) onHoldBegin();
  };
  const onPointerDownCapture = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button === 0) noteHold();
  };
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') noteHold();
  };

  return (
    <div className="flex flex-col items-center gap-[22px] pt-10">
      <div className="relative grid place-items-center">
        {/* Ambient light the coin sits in. Static, one paint, no animation. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute rounded-full"
          style={{
            width: GLOW_PX,
            height: GLOW_PX,
            background: `radial-gradient(circle, rgb(var(--meritum-surface-brand) / ${
              struck ? 0.16 : strikeable ? 0.09 : 0.04
            }) 0%, rgb(var(--meritum-rail) / 0) 66%)`
          }}
        />

        {/* The "this is a control" pulse. Only while a hold could actually start. */}
        {armed ? (
          <span
            aria-hidden="true"
            className="mt-coin-hint pointer-events-none absolute rounded-full border-[1.5px] border-meritum-line-brand"
            style={{ width: HINT_PX, height: HINT_PX }}
          />
        ) : null}

        <div onPointerDownCapture={onPointerDownCapture} onKeyDownCapture={onKeyDownCapture}>
          {strikeable ? (
            <HoldToStrike
              {...coinState}
              ref={strikeRef}
              disabled={strikeDisabled}
              heightLockRef={heightLockRef}
              /*
                ★ THE COIN REVEALS ON THE RESULT, NOT ON THE CLOCK.
                `struck` already meant "the market is genuinely live" (see the
                prop's own doc above) but was only wired to the ambient glow, so
                the coin turned oxblood, embossed its legend, engraved the price
                and announced "Struck. Your token is live." purely on
                MERITUM_STRIKE_MS — at the same moment the caption underneath it
                still read "Landing · waiting for the chain to answer". A
                signature prompt routinely outlasts 2400ms, so that was the
                ordinary path. Passing it as the reveal gate holds the coin at
                `striking` until the write actually lands.
              */
              revealWhen={struck}
              onCharged={onCharged}
              onStruck={onStruck}
              onAbort={onAbort}
              holdLabel={holdLabel}
              statusLabels={statusLabels}
              blankLabel={blankLabel}
              unboundLabel={unboundLabel}
            />
          ) : (
            <MeritumCoin {...coinState} blankLabel={blankLabel} unboundLabel={unboundLabel} alt={coinAlt} />
          )}
        </div>
      </div>

      <div className="text-center">
        {/* ★ SPEC §5.8 APPLIED (2026-08-20): Lora 16 w400 ITALIC — `font-bold`,
            `uppercase` and the 0.2em tracking are all dropped, so the state word
            stops being a label and becomes quiet prose.

            ★ THE SPEC'S OWN "CURRENT" COLUMN IS WRONG FOR THIS ROW, and that was
            checked before applying rather than after. §5.8 describes the current
            state as "Lora 15 w400" — plain prose. It was not: it was a 12px BOLD
            UPPERCASE label tracked at 0.2em, a different visual class entirely.
            So the row was written against a baseline that did not exist, and the
            change is a bigger step than the spec implies: it demotes a status
            indicator to running text and costs some at-a-glance scannability of
            the coin's state. Applied on the owner's instruction to clear the
            ledger; if the state word stops reading as a state, this row is why
            and reverting it is a three-class change. */}
        <div
          className={`text-body font-text italic ${
 captionBrand ? 'text-meritum-ink-brand' : 'text-meritum-ink-faint'
 }`}
        >
          {caption}
        </div>
        {/* §4's own literal example of editorial voice ("Only your handle is
            engraved so far"), so it is italic too. */}
        <p className="mx-auto mt-1.5 max-w-[30ch] font-text text-caption italic text-meritum-ink-muted">{captionSub}</p>
      </div>

      <MeritumRailLedger rows={rows} emptyLabel={ledgerEmptyLabel} />
    </div>
  );
};

export default MeritumCoinRail;
