import Big from 'big.js';
import type { WalletFigures, WalletPowerDown } from './wallet-derived';

/**
 * The JSON shape `WalletFigures` travels in between `/api/wallet/summary` and
 * the browser.
 *
 * ★★★ WHY THIS FILE EXISTS (2026-08-13, browser audit §1.5). `/wallet` made
 * **19 direct requests to api.hive.blog from the reader's browser** — measured,
 * and enumerated by request body:
 *
 *   1x database_api.get_dynamic_global_properties      536ms
 *   2x database_api.find_accounts                      539, 541ms
 *   1x bridge.get_profile                              131ms
 *  12x bridge.get_relationship_between_accounts        140-280ms
 *   1x database_api.list_vesting_delegations           138ms
 *   1x hafah-api/operation-types                       133ms
 *   1x hivemind-api/accounts/<name>/operations         216ms
 *
 * — plus `wax.common.wasm`, 2.34 MB, because `useWalletAccount` called
 * `getChain()` to do the vests->HP arithmetic. (The twelve relationship calls are
 * `bannedFollowEdges` inside `getAccountFull`: two per banned account, six banned
 * accounts. They are invisible at the call site, which is exactly why a page that
 * "makes three chain reads" made nineteen requests.)
 *
 * No server cache, no compression control, no batching, and a public node seeing
 * every reader's browser directly. The arithmetic is the part that forced it:
 * `convertToHP` needs a wax `Chain` instance, so any page that derives HP had to
 * download wax. Doing the derivation on the server and sending the RESULT is what
 * lets the browser off the chain entirely — but `Big` and `Date` do not survive
 * JSON, so the crossing needs an explicit shape rather than a cast.
 *
 * Deliberately its own module and not part of `wallet-derived.ts`: that file
 * imports `Chain` from `@transaction/lib/chain`, and importing it from a client
 * component is how wax gets pulled back into the browser bundle by accident.
 * Everything here is `big.js` and `Date` only.
 */

type BigString = string;

export interface WalletPowerDownWire extends Omit<
  WalletPowerDown,
  'nextPaymentHp' | 'remainingHp' | 'nextPaymentDate'
> {
  nextPaymentHp: BigString;
  remainingHp: BigString;
  /** ISO-8601, or null when no power-down is scheduled. */
  nextPaymentDate: string | null;
}

const BIG_FIELDS = [
  'liquidHive',
  'liquidHbd',
  'savingsHive',
  'savingsHbd',
  'vestingHp',
  'delegatedOutHp',
  'receivedHp',
  'netHp',
  'movableHp',
  'hpApr',
  'rewardHive',
  'rewardHbd',
  'rewardVestingHp'
] as const;

type BigFieldName = (typeof BIG_FIELDS)[number];

export type WalletFiguresWire = Omit<WalletFigures, BigFieldName | 'powerDown'> & {
  [K in BigFieldName]: BigString;
} & { powerDown: WalletPowerDownWire };

/** Server side: `WalletFigures` -> JSON. */
export function toWalletFiguresWire(figures: WalletFigures): WalletFiguresWire {
  const wire = { ...figures } as unknown as Record<string, unknown>;
  for (const key of BIG_FIELDS) wire[key] = figures[key].toString();
  wire.powerDown = {
    ...figures.powerDown,
    nextPaymentHp: figures.powerDown.nextPaymentHp.toString(),
    remainingHp: figures.powerDown.remainingHp.toString(),
    nextPaymentDate: figures.powerDown.nextPaymentDate
      ? figures.powerDown.nextPaymentDate.toISOString()
      : null
  };
  return wire as unknown as WalletFiguresWire;
}

/** Browser side: JSON -> `WalletFigures`, identical to what `deriveWalletFigures` returned. */
export function fromWalletFiguresWire(wire: WalletFiguresWire): WalletFigures {
  const figures = { ...wire } as unknown as Record<string, unknown>;
  for (const key of BIG_FIELDS) figures[key] = new Big(wire[key]);
  figures.powerDown = {
    ...wire.powerDown,
    nextPaymentHp: new Big(wire.powerDown.nextPaymentHp),
    remainingHp: new Big(wire.powerDown.remainingHp),
    nextPaymentDate: wire.powerDown.nextPaymentDate ? new Date(wire.powerDown.nextPaymentDate) : null
  };
  return figures as unknown as WalletFigures;
}
