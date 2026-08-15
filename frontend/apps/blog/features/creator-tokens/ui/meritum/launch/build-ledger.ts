import { usdPrice } from '../../../market/format';
import { parseMoney } from '../../launch-money';
import type { MeritumLedgerRow } from './meritum-rail-ledger';
import type { MeritumLaunchStep, MeritumOffer } from './use-meritum-launch';

/**
 * THE LEDGER, DERIVED. This is the whole of "the tabs that fill up".
 *
 * ★★★ THERE IS NO PER-STEP ROW TABLE HERE ON PURPOSE. Every row is read off
 * the reader's own state:
 *
 *   BOUND TO       the handle, as soon as the session names one
 *   OFFER 1/2/3    each one fills the moment THAT offer carries a price, and
 *                  takes the reader's own wording as its label once they have
 *                  written one
 *   OPENING PRICE  the curve's price at supply 0
 *   LUMEN TAKES    the contract's commission
 *
 * The last two appear at step 3, where the terms are on screen, and stay for
 * the struck panel. Nothing is ever filled in ahead of the reader.
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

/** A reader's own wording is theirs, but the label column has a width. */
const LABEL_MAX = 16;

function offerLabel(offer: MeritumOffer, index: number, labels: MeritumLedgerLabels): string {
  const named = offer.name.trim();
  if (named === '') return labels.offer(index + 1);
  return named.length > LABEL_MAX ? `${named.slice(0, LABEL_MAX - 1)}…` : named;
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

  const offerRows: MeritumLedgerRow[] = offers.map((offer, i) => {
    const usd = parseMoney(offer.price);
    return {
      id: `offer-${i}`,
      label: offerLabel(offer, i, labels),
      value: usd > 0 ? usdPrice(usd) : null
    };
  });

  return furthestStep >= 3 ? [boundTo, ...offerRows, ...terms] : [boundTo, ...offerRows];
}
