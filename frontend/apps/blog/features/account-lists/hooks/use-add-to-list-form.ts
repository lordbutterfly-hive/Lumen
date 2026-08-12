'use client';

import { useCallback, useRef, useState } from 'react';
import { fetchAccountExists } from '@/blog/lib/chain-fetch';
import { joinAccountNames, parseAccountListInput } from '../lib/parse-account-list';

/**
 * State machine for the add-account form on the moderation lists pages
 * (blacklist, muted, followed-blacklists, followed-muted-lists).
 *
 * Fixes, together with parse-account-list.ts:
 *   B1 — comma-separated add now actually splits, dedupes, and submits ONE
 *        custom_json with the full array (see `submit` call at the bottom).
 *   B2 — the indefinite spinner is replaced with an explicit 'confirming'
 *        phase ("Confirm in Hive Keychain..."), a Cancel action, and a 30s
 *        timeout that produces a real inline error instead of spinning
 *        forever.
 *   B3 — every candidate is validated (offline format check, then an actual
 *        `checkAccountExists` chain lookup) and any name already on the list
 *        is rejected with an inline error BEFORE anything is submitted —
 *        no more silent optimistic row that vanishes 12s later.
 */

export type AddToListPhase = 'idle' | 'checking' | 'confirming' | 'error';

export type AddToListErrorKind =
  | 'empty_input'
  | 'already_on_list'
  | 'invalid_format'
  | 'not_found'
  | 'api_error'
  | 'timeout'
  | 'rejected'
  | 'broadcast_failed'
  | 'cancelled';

export interface AddToListErrorState {
  kind: AddToListErrorKind;
  names?: string[];
  message?: string;
}

const CONFIRM_TIMEOUT_MS = 30_000;

/** Heuristic for "the signer told us the user said no" vs. any other broadcast failure. */
function isLikelyUserRejection(message: string): boolean {
  return /reject|denied|cancel/i.test(message);
}

export function useAddToListForm(existingNames: string[], submit: (joinedNames: string) => Promise<unknown>) {
  const [phase, setPhase] = useState<AddToListPhase>('idle');
  const [error, setError] = useState<AddToListErrorState | null>(null);
  // Flipped by cancel(); read inside the in-flight submitRaw() closure so a
  // late resolve/reject from an abandoned confirm doesn't resurrect the UI.
  // NOTE this cannot actually abort the signer/broadcast call underneath —
  // there is no AbortController wired into TransactionService.signTransaction
  // or the individual Signer implementations (see packages/smart-signer/lib
  // /signer/signer.ts) — it only stops THIS form pretending to still be
  // waiting on it. See the G2 handoff notes for why that is the honest limit
  // of what a fix scoped to "the form and its submit path" can do.
  const abandonedRef = useRef(false);

  const reset = useCallback(() => {
    abandonedRef.current = true;
    setPhase('idle');
    setError(null);
  }, []);

  const cancel = useCallback(() => {
    abandonedRef.current = true;
    setPhase('error');
    setError({
      kind: 'cancelled',
      message:
        'Cancelled. If a Hive Keychain window is still open, closing it is safe — nothing has been submitted from this page.'
    });
  }, []);

  /** Returns true only if a real submission was made and it succeeded — the caller uses this to know whether to clear the input. */
  const submitRaw = useCallback(
    async (raw: string): Promise<boolean> => {
      abandonedRef.current = false;
      setError(null);

      const { candidates, alreadyOnList } = parseAccountListInput(raw, existingNames);

      if (alreadyOnList.length > 0) {
        // Reject the whole batch rather than silently submitting a partial
        // list — B3 explicitly asks for names already on the list to be
        // REJECTED with an inline error, not quietly dropped.
        setPhase('error');
        setError({ kind: 'already_on_list', names: alreadyOnList });
        return false;
      }
      if (candidates.length === 0) {
        setPhase('error');
        setError({ kind: 'empty_input' });
        return false;
      }

      setPhase('checking');

      // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
      // `isValidAccountNameFormat` then `checkAccountExists` directly — both
      // reach `getChain()` and download `wax.common.wasm`. `/api/account-
      // exists` does the same two checks server-side in one request; one
      // fetch per candidate replaces what used to be two waves of chain
      // calls. See `apps/blog/app/api/account-exists/route.ts`.
      const checks = await Promise.all(
        candidates.map(async (name) => ({ name, result: await fetchAccountExists(name) }))
      );
      if (abandonedRef.current) return false;
      const invalidFormat = checks.filter((r) => !r.result.validFormat).map((r) => r.name);
      if (invalidFormat.length > 0) {
        setPhase('error');
        setError({ kind: 'invalid_format', names: invalidFormat });
        return false;
      }

      const apiErrors = checks.filter((r) => r.result.status === 'api_error').map((r) => r.name);
      const notFound = checks.filter((r) => r.result.status === 'not_found').map((r) => r.name);

      if (apiErrors.length > 0) {
        setPhase('error');
        setError({ kind: 'api_error', names: apiErrors });
        return false;
      }
      if (notFound.length > 0) {
        setPhase('error');
        setError({ kind: 'not_found', names: notFound });
        return false;
      }

      // Every candidate is a real, validated, not-already-listed account.
      // Submit ONE call with the full array — transactionService's
      // `otherBlogs.split(', ')` turns this back into one custom_json.
      setPhase('confirming');
      const joined = joinAccountNames(candidates);

      let timedOut = false;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          timedOut = true;
          reject(new Error('add-to-list confirm timeout'));
        }, CONFIRM_TIMEOUT_MS);
      });

      try {
        await Promise.race([submit(joined), timeoutPromise]);
        if (abandonedRef.current) return false;
        setPhase('idle');
        setError(null);
        return true;
      } catch (err) {
        if (abandonedRef.current) return false;
        if (timedOut) {
          setPhase('error');
          setError({ kind: 'timeout' });
          return false;
        }
        const message = err instanceof Error ? err.message : String(err);
        setPhase('error');
        setError({
          kind: isLikelyUserRejection(message) ? 'rejected' : 'broadcast_failed',
          message
        });
        return false;
      }
    },
    [existingNames, submit]
  );

  return { phase, error, submitRaw, cancel, reset };
}
