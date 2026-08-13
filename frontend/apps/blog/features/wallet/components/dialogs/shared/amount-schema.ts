import Big from 'big.js';
import { z } from 'zod';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Hive carries HIVE/HBD/HP to exactly 3 decimal places. Anything finer is not
 * "rounded" by the chain — `getAsset` (`packages/transaction/lib/utils.ts:69`)
 * hard-throws on it, so a form that lets it through trades an inline field
 * message for a generic error toast at the signing boundary.
 *
 * ★ EXPORTED because Recurring Transfer cannot use `buildAmountSchema` (its
 * balance bound depends on a sibling field) and therefore shipped with NO
 * precision check at all — the one amount field in the wallet without one.
 * That was not a missing line, it was a missing SHARED PIECE: the two schemas
 * had no way to agree. Sharing the predicate is what stops them drifting
 * again. See recurring-transfer-dialog.tsx.
 *
 * `Number.isFinite` first is load-bearing, not defensive: `new Big(Infinity)`
 * THROWS (`[big.js] Invalid number`), and `register(..., { valueAsNumber:
 * true })` turns a typed `1e999` into `Infinity`. Without the short-circuit
 * this predicate would throw inside validation instead of returning false.
 */
export const isWithinAmountPrecision = (value: number): boolean =>
  Number.isFinite(value) && new Big(value).round(3, Big.roundDown).eq(new Big(value));

/**
 * Shared amount schema for every "spend against a balance" dialog: Send,
 * Power Up, Power Down, Convert, Delegate, Savings Deposit, Savings
 * Withdraw. Recurring Transfer is deliberately NOT one of these seven — its
 * balance bound depends on a sibling `currency` field, so it needs an
 * object-level `superRefine` instead (see recurring-transfer-dialog.tsx).
 *
 * ★ `amount_invalid` exists because of the `type="text"` fix in
 * amount-field.tsx (2026-08-12): typing a comma decimal ("1,5") now parses
 * to `NaN` instead of being silently mangled into 15 by `<input
 * type="number">`. Verified against the installed zod (3.25.76): a `NaN`
 * passed to `z.number({ message })` raises exactly ONE issue — the
 * `invalid_type` issue carrying THIS message — and aborts before `.positive
 * ()`/`.min()`/any `.refine()` ever runs. Without a message here, that NaN
 * used to reuse `.positive()`'s message ("Amount must be greater than 0"),
 * which is wrong on its face (1,5 IS greater than 0) and gives a
 * comma-locale user no clue the comma is the problem, on exactly the input
 * the type="text" fix was built to protect.
 *
 * ★ `Big`, not the `/^\d+(\.\d{1,3})?$/` regex some callers carried
 * individually. Two proven defects in that regex, both dodged by Big's exact
 * decimal comparison: (1) a negative number's `.toString()` starts with
 * "-", which fails `^\d+`, so a negative amount could raise a bogus
 * "too many decimal places" issue alongside the sign issue; (2)
 * `(1e21).toString()` is `"1e+21"`, which fails the regex even though it is
 * an exact whole number.
 *
 * ★ PRECEDENCE — CORRECTED 2026-08-13 (A1 review W-5). This block used to
 * claim that a failed `.positive()`/`.min()` ABORTS the chain, so the refines
 * below never run and exactly one message is ever produced. That is FALSE and
 * the opposite file was right: `ZodNumber._parse` calls `status.dirty()` on a
 * failed check, it does not abort, and `ZodEffects` skips a refinement only
 * when the inner status is *aborted*, never for *dirty* — which is exactly
 * what `recipient-schema.ts:11-23` states, and why its own length re-check
 * inside the refine is load-bearing. Re-probed against the installed zod
 * 3.25.76 using this very builder:
 *
 *   -5        -> ['amount_positive']
 *   -5.1234   -> ['amount_positive', 'amount_precision']        TWO issues
 *   -1.2345   -> ['amount_positive', 'amount_precision']        (allowZero)
 *   Infinity  -> ['amount_exceeds_balance', 'amount_precision'] TWO issues
 *
 * No user-visible harm today — react-hook-form surfaces only the first issue
 * per field — so this is a comment fix, not a code fix. It is worth making
 * because the false version is precisely the assumption under which someone
 * reorders these refines and reintroduces a real bug.
 *
 * What the same probe CONFIRMS does hold: `NaN`, `undefined` and `''` all
 * fail closed on `amount_invalid` and DO abort before the refines (the
 * `invalid_type` issue aborts, unlike a failed check), so the comma-decimal
 * case above behaves as described; `Infinity` fails closed on the balance
 * bound; and `0` passes only in the `allowZero` (Delegate) variant.
 */
export const buildAmountSchema = ({ max, allowZero = false }: { max: Big; allowZero?: boolean }, t: TFn) => {
  const base = z.number({ message: t('wallet.dialogs.common.amount_invalid') });
  return (
    allowZero
      ? base.min(0, { message: t('wallet.dialogs.common.amount_positive') })
      : base.positive({ message: t('wallet.dialogs.common.amount_positive') })
  )
    .refine((value) => value <= max.toNumber(), {
      message: t('wallet.dialogs.common.amount_exceeds_balance')
    })
    .refine(isWithinAmountPrecision, {
      message: t('wallet.dialogs.common.amount_precision')
    });
};
