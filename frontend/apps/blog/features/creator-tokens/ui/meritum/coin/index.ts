/**
 * MERITUM COIN + HOLD-TO-STRIKE — public surface.
 *
 * Two components:
 *   <MeritumCoin>    display only. Steps 1 and 2, where the coin is a picture.
 *   <HoldToStrike>   the same coin as a press target. Step 3.
 *
 * Either one can be driven from real flow state alone:
 *   handle         the bound account. Engraves the device.
 *   offersPriced   0..3. Lights one stud per offer that carries a price.
 *   step           1 | 2 | 3, the FURTHEST step reached. Cuts the rim reeding
 *                  at 2 and brings the legend up at 3.
 *   openingPrice   formatted, e.g. "$1.00". Sits under the handle once struck.
 *   phase          MeritumCoin only; HoldToStrike owns its own.
 *
 * And the strike needs three wires:
 *   heightLockRef  the launch CARD, so the page cannot collapse mid-strike
 *   onCharged      the real launch write, fired with 2400ms still to run
 *   onStruck       the reveal
 *   ref.reset()    if the write failed and the coin must not stay struck
 */

export { default as MeritumCoin } from './meritum-coin';
export type { MeritumCoinProps } from './meritum-coin';

export { default as HoldToStrike } from './hold-to-strike';
export type { HoldToStrikeProps, HoldToStrikeHandle } from './hold-to-strike';

export { useHoldToStrike } from './use-hold-to-strike';
export type { HoldToStrikeApi, UseHoldToStrikeOptions } from './use-hold-to-strike';

export {
  MERITUM_CHARGE_MS,
  MERITUM_STRIKE_MS,
  MERITUM_HEIGHT_RELEASE_MS,
  MERITUM_RING_RADIUS,
  MERITUM_RING_CIRCUMFERENCE,
  MERITUM_RING_DASH_UNITS,
  MERITUM_CHARGE_DURATION_STYLE
} from './timing';
export type { MeritumStrikePhase } from './timing';

export { deriveCoinDetail, coinDeviceName, MERITUM_STUD_COUNT, COIN_EDGE_PX } from './geometry';
export type { MeritumCoinFlowState, MeritumCoinDetail } from './geometry';
