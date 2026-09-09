import { z } from 'zod';
import { fetchAccountExists } from '@/blog/lib/chain-fetch';
import { isPayableBtcAddress, parseMagiRecipient, recipientShapeHint } from '../../../lib/magi-ops';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Shared "@account" recipient schema for every dialog that sends to another
 * account (Send, Delegate, Recurring Transfer) — previously copy-pasted
 * three times with no messages on the length checks.
 *
 * ★★★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-13, A1 review W-3).
 * This called `getAccount(value)` — i.e. `getChain().api.database_api
 * .find_accounts` (`packages/transaction/lib/hive-api.ts:153-157`) — straight
 * from the browser, on the submit path of a money form, while today's other
 * work removed exactly that pattern everywhere else. `/api/account-exists`
 * already existed for this precise job and returns the very distinction this
 * refine is written to make (`apps/blog/lib/chain-fetch.ts`,
 * `AccountExistsResult`), so it is used here instead. Three things change:
 *
 * 1. The chain round trip moves off the reader's connection, so it no longer
 *    fails on a node CORS/outage the server would have survived.
 * 2. It is faster, and this call is what stretched W-1's double-click window
 *    from milliseconds to hundreds of milliseconds. (W-1 is fixed by a real
 *    re-entrancy guard in `wallet-dialog-shell.tsx`, not by this — but a
 *    shorter window is still strictly better on a form that moves funds.)
 * 3. It distinguishes "could not ask" (`api_error`) from "asked, no such
 *    account" (`not_found`) as data, rather than inferring it from whether a
 *    promise rejected.
 *
 * ★ Why the length guard inside the refine is load-bearing, not decorative.
 * A failed zod `.min()`/`.max()` on a string does not ABORT validation — it
 * adds an issue and marks the value "dirty", and `ZodEffects` (what a
 * `.refine()`/`.superRefine()` chain compiles to) only skips a refinement
 * when the inner status is "aborted", never for "dirty". So a >16-char name
 * reaches the async check below anyway. It matters slightly less now that
 * the WASM `assert_exception` happens server-side (the route answers 502
 * rather than rejecting in the reader's tab), but it is KEPT: it is still
 * wrong to spend a network round trip on a name we already know is invalid,
 * and the `.min`/`.max` messages below own that case entirely.
 *
 * Two independent defenses remain, both required:
 * 1. The length re-check above short-circuits an out-of-range name to `true`.
 * 2. The try/catch turns ANY rejection — a 502 from the route, a dropped
 *    connection, a dev-server restart — into a normal zod issue instead of an
 *    uncaught rejection. This is the more important half in practice: an
 *    outage hits every valid-length name on the most common path, not just
 *    the 17-character edge case.
 * `wallet-dialog-shell.tsx` also nets any resolver crash that still slips
 * through a different path, as defense in depth.
 */
export const buildRecipientSchema = (t: TFn, opts: { self?: string } = {}) =>
  z
    .string({ message: t('wallet.dialogs.common.recipient_required') })
    .transform((v) => v.trim().replace(/^@/, '').toLowerCase())
    .pipe(z.string().min(3, { message: t('wallet.dialogs.common.recipient_length') }).max(16, { message: t('wallet.dialogs.common.recipient_length') }))
    .superRefine(async (value, ctx) => {
      if (typeof window === 'undefined') return;
      if (value.length < 3 || value.length > 16) return; // owned by .min/.max above
      // ★ Self-send refused (owner, 2026-09-09). A transfer to yourself is never
      // what a person meant on a send form, and on Magi the ledger refuses it.
      if (opts.self && value === opts.self.toLowerCase()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.dialogs.common.recipient_self') });
        return;
      }
      try {
        const result = await fetchAccountExists(value);
        // Only 'exists' is an accepted recipient. `api_error` is deliberately
        // NOT folded in with `not_found`: a rejected/failed lookup is not the
        // same fact as "no such account" — it usually means the account
        // service could not be reached at all, and labelling that "Account
        // not found" would be a lie on a money form. `validFormat: false`
        // (a name the chain's own validator rejects) is a genuine
        // "no such account" and correctly lands in the not-found branch.
        if (result.status === 'api_error') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.dialogs.common.recipient_check_failed') });
        } else if (result.status !== 'exists') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.dialogs.common.recipient_not_found') });
        }
      } catch {
        // `fetchJson` throws on a non-2xx (the route's own 502) and on a
        // dropped connection. Same reasoning as above: report that we could
        // not check, never that the account does not exist.
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.dialogs.common.recipient_check_failed') });
      }
    });

/**
 * A Magi recipient: a Hive name (checked to exist on chain, exactly as above),
 * an EIP-55-checksummed Ethereum address, a checksummed Bitcoin address, or a
 * qualified `hive:` / `did:pkh:` id. FAILS CLOSED on both failure kinds, the
 * owner's explicit choice over Altera's warn-and-allow (RecipientCard.svelte).
 */
export const buildMagiRecipientSchema = (selfId: string, t: TFn) =>
  z
    .string({ message: t('wallet.dialogs.common.recipient_required') })
    .min(1, { message: t('wallet.dialogs.common.recipient_required') })
    .superRefine(async (value, ctx) => {
      const parsed = parseMagiRecipient(value);
      if (!parsed) {
        const shape = recipientShapeHint(value);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            shape === 'evm'
              ? t('wallet.dialogs.common.recipient_invalid_evm')
              : shape === 'btc'
                ? t('wallet.dialogs.common.recipient_invalid_btc')
                : t('wallet.dialogs.common.recipient_invalid_any')
        });
        return;
      }
      if (parsed.id === selfId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.dialogs.common.recipient_self') });
        return;
      }
      if (parsed.kind !== 'hive' || typeof window === 'undefined') return;
      try {
        const result = await fetchAccountExists(parsed.hiveName ?? '');
        if (result.status === 'api_error') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.dialogs.common.recipient_check_failed') });
        } else if (result.status !== 'exists') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.dialogs.common.recipient_not_found') });
        }
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('wallet.dialogs.common.recipient_check_failed') });
      }
    });

/** A raw Bitcoin address for a withdrawal: checksummed and payable by the bridge; optionally not the account's own deposit address. */
export const buildBtcAddressSchema = (t: TFn, opts: { ownDeposit?: string | null } = {}) =>
  z
    .string({ message: t('wallet.dialogs.common.recipient_required') })
    .trim()
    .refine((v) => isPayableBtcAddress(v), { message: t('wallet.dialogs.common.recipient_invalid_btc') })
    .refine((v) => !opts.ownDeposit || v !== opts.ownDeposit, { message: t('wallet.magi.withdraw.to_btc_own_deposit') });
