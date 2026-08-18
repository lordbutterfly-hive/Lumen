import { usdPrice } from '../../../market/format';
import { parseMoney } from '../../launch-money';
import type { MeritumLedgerRow } from './meritum-rail-ledger';
import { sanitizeOfferName } from './use-meritum-launch';
import type { MeritumLaunchStep, MeritumOffer } from './use-meritum-launch';

/**
 * THE LEDGER, DERIVED. This is the whole of "the tabs that fill up".
 *
 * ★★★ THERE IS NO PER-STEP ROW TABLE HERE ON PURPOSE. Every row is read off
 * the reader's own state:
 *
 *   BOUND TO       the handle, as soon as the session names one
 *   OFFER 1/2/3    each one fills the moment THAT offer carries a price
 *   OPENING PRICE  the curve's price at supply 0
 *   LUMEN TAKES    the contract's commission
 *
 * The last two appear at step 3, where the terms are on screen, and stay for
 * the struck panel. Nothing is ever filled in ahead of the reader.
 *
 * ★ THE LABEL IS "OFFER N", ALWAYS (2026-08-16, M7 fix). This used to swap the
 * label to the reader's own wording the moment an offer carried a name, so the
 * three rows read "OFFER 1 / OFFER 2 / OFFER 3" on step 1 (nothing named yet)
 * and then, by step 3, the same three rows in the same three positions no
 * longer said "OFFER" anywhere — a reader comparing the two views saw the
 * numbering itself vanish, not just fill in, which reads as "these are
 * different rows in a different order" even though the position and the
 * offers array are untouched throughout (`offers.map` below never sorts or
 * reindexes). Every writer typed their own name in a DIFFERENT order than the
 * three input rows are laid out in step 2, so the row that used to read
 * "OFFER 1" could end up captioned with whatever they typed third — visually
 * indistinguishable from a reorder. The name stays fully visible and editable
 * on step 2 (`LaunchStepOffers`'s own input); this rail's job is only "which
 * of the three slots has a price", and "Offer N" says that consistently in
 * every step that shows it, which is what step 1 already did.
 *
 * ★ THE NAME COMES BACK AS `detail`, BESIDE THE PRICE, NOT AS THE LABEL (C9-3).
 * This is the last screen before the strike registers a one-per-account,
 * un-renameable market on chain, and until now this rail showed only the
 * number ($1.00) with no way to check it was attached to the right promise —
 * a reader with three offers priced could not tell which price was which
 * without leaving this panel. Filling `detail` here with the SAME
 * `sanitizeOfferName` (`use-meritum-launch.ts`'s `pricedOffers` memo runs it
 * on every name before the on-chain write) means what this rail previews is
 * exactly what gets engraved, BIDI/zero-width tricks and all stripped the
 * same way — never a raw, uncommitted string. It only appears once the row
 * itself is real (a price attached); `label` is untouched, so the M7 fix
 * above still holds.
 *
 * Pure, and translated by its caller: the labels arrive already resolved so
 * this module can be reasoned about (and unit-tested) without i18n.
 */

export interface MeritumLedgerLabels {
  boundTo: string;
  /** Takes the 1-based offer number. */
  offer: (n: number) => string;
  openingPrice: string;
  lumenTakes: string;
}

export interface MeritumLedgerInput {
  /** `@name`, or '' while the session has not answered. */
  handle: string;
  offers: MeritumOffer[];
  /** The furthest step reached, so stepping back does not empty the ledger. */
  furthestStep: MeritumLaunchStep;
  /** True once the market is genuinely live. */
  struck: boolean;
  /** Already formatted, e.g. `$1.00`. */
  openingPrice: string;
  /** Already formatted, e.g. `12%`. */
  commission: string;
  labels: MeritumLedgerLabels;
}

export function buildMeritumLedger(input: MeritumLedgerInput): MeritumLedgerRow[] {
  const { handle, offers, furthestStep, struck, openingPrice, commission, labels } = input;

  const boundTo: MeritumLedgerRow = {
    id: 'bound-to',
    label: labels.boundTo,
    value: handle === '' ? null : handle
  };

  const terms: MeritumLedgerRow[] = [
    { id: 'opening-price', label: labels.openingPrice, value: openingPrice },
    { id: 'lumen-takes', label: labels.lumenTakes, value: commission, brand: true }
  ];

  /**
   * Struck drops the per-offer rows. By then the offers are posted and live on
   * the token page, and what a reader needs off this rail is the two numbers
   * the market itself now runs on.
   */
  if (struck) return [boundTo, ...terms];

  // `label` is always `labels.offer(i + 1)` -- see the M7 note above. The
  // offer's own wording comes back only as `detail`, beside the price.
  const offerRows: MeritumLedgerRow[] = offers.map((offer, i) => {
    const usd = parseMoney(offer.price);
    const priced = usd > 0;
    return {
      id: `offer-${i}`,
      label: labels.offer(i + 1),
      value: priced ? usdPrice(usd) : null,
      detail: priced ? sanitizeOfferName(offer.name) || null : null
    };
  });

  return furthestStep >= 3 ? [boundTo, ...offerRows, ...terms] : [boundTo, ...offerRows];
}
