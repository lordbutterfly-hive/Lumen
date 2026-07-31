'use client';

import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEY } from '@smart-signer/lib/query-keys';
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';

/**
 * Client wiring for the standalone /login page (Lumen Lite path). Talks to the
 * already-built `/api/lite/*` backend (lib/lite, Phase 2/5) — this is the
 * Phase-3b client piece that was deferred in the lib/lite tracker.
 *
 * Result shapes mirror lib/lite/auth/auth-service.ts + names/vetting.ts:
 *   resolveLogin  -> { status:'authenticated' } | { status:'needs_name' }
 *   completeSignup-> { status:'ok' } | { status:'error', code, message }
 *   nameCheck     -> { available:true } | { available:false, reason }
 *
 * The lite feature is dark (503) until infra is provisioned + LITE_ACCOUNTS_ENABLED=yes;
 * every helper degrades to friendly copy rather than throwing, so the page still
 * renders and the Hive-account path stays usable when Lite is off.
 */

export type ResolveOutcome =
  | { status: 'authenticated' }
  | { status: 'needs_name' }
  | { status: 'error'; message: string };

export type SignupOutcome = { status: 'ok' } | { status: 'error'; message: string };

export type NameStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'unavailable'; reason: string };

export interface WalletChallenge {
  nonce: string;
  message: string;
}

/** @deprecated use WalletChallenge — kept so existing imports keep compiling. */
export type BtcChallenge = WalletChallenge;

/** Which wallet family a proof came from; picks the /api/lite/auth/{btc,evm} pair. */
export type WalletChain = 'btc' | 'evm';

// CSRF defense is the presence of this custom header (see lib/lite/http/csrf.ts);
// the app's other authed fetches send the same [name, '1'] pair.
const JSON_POST: HeadersInit = { 'Content-Type': 'application/json', [csrfHeaderName]: '1' };

const DISABLED = 'Lumen accounts aren’t available just yet — you can still sign in with a Hive account below.';
const GENERIC = 'Something went wrong. Please try again.';

async function friendlyError(res: Response): Promise<string> {
  const code = await res
    .clone()
    .json()
    .then((b) => (b && typeof b.error === 'string' ? (b.error as string) : ''))
    .catch(() => '');
  if (res.status === 503) return DISABLED;
  if (res.status === 429 || code === 'signup_rate_limited' || code === 'rate_limited')
    return 'Too many sign-ups from your network right now — try again in a minute.';
  if (code === 'captcha_failed') return 'Please complete the “I’m human” check and try again.';
  if (code === 'taproot_unsupported')
    return 'Taproot addresses aren’t supported yet — use a SegWit (bc1q…) or legacy (1…) address.';
  if (code === 'bad_signature') return 'That signature didn’t match — try again.';
  if (code === 'address_mismatch' || code === 'invalid_or_expired_challenge')
    return 'That sign-in request expired — please try again.';
  if (code === 'invalid_token' || code === 'email_not_verified')
    return 'Couldn’t verify your Google sign-in — try again.';
  return GENERIC;
}

export function useLiteLogin() {
  const queryClient = useQueryClient();
  const [nameStatus, setNameStatus] = useState<NameStatus>({ state: 'idle' });
  const checkTimer = useRef<ReturnType<typeof setTimeout>>();
  const checkSeq = useRef(0);

  // Write the fresh lite user into the React-Query ['user'] cache (mirrors the
  // real Hive login's use-sign-in.onSuccess) so header/composer/vote/follow
  // re-render as logged-in immediately. router.refresh() alone can't — ['user']
  // has refetchOnMount:false and initialData from localStorage (L1).
  const applyUser = useCallback(
    (user: unknown) => {
      if (!user || typeof user !== 'object') return;
      queryClient.setQueryData([QUERY_KEY.user], user);
      const username = (user as { username?: string }).username;
      if (username) {
        const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = `observer=${username}; path=/; SameSite=Lax${secure}`;
      }
      queryClient.invalidateQueries();
    },
    [queryClient]
  );

  const resolveFrom = useCallback(
    async (res: Response): Promise<ResolveOutcome> => {
      if (!res.ok) return { status: 'error', message: await friendlyError(res) };
      const body = (await res.json().catch(() => null)) as { status?: string; user?: unknown } | null;
      if (body?.status === 'authenticated') {
        applyUser(body.user);
        return { status: 'authenticated' };
      }
      if (body?.status === 'needs_name') return { status: 'needs_name' };
      return { status: 'error', message: GENERIC };
    },
    [applyUser]
  );

  const google = useCallback(
    async (idToken: string, nonce: string): Promise<ResolveOutcome> => {
      const res = await fetch('/api/lite/auth/google', {
        method: 'POST',
        headers: JSON_POST,
        // F-L11: the server now requires the single-use `login` nonce this token was
        // minted with (echoed as the OIDC `nonce` claim) — a captured token is no
        // longer replayable.
        body: JSON.stringify({ idToken, nonce })
      });
      return resolveFrom(res);
    },
    [resolveFrom]
  );

  // F-L11: fetch the single-use `login` nonce the Google button must be initialised
  // with, so Google embeds it in the ID token. Mirrors the wallet challenge step;
  // returns null on failure so the caller can show an honest error, not a doomed flow.
  const googleChallenge = useCallback(async (): Promise<string | null> => {
    const res = await fetch('/api/lite/auth/google/challenge', { method: 'POST', headers: JSON_POST });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { nonce?: string } | null;
    return data?.nonce ?? null;
  }, []);

  // BTC and EVM share one flow (challenge -> sign the exact message -> verify);
  // only the route pair and the signature encoding differ, and the server owns
  // the encoding. One helper each, chain-parameterised.
  const walletChallenge = useCallback(
    async (
      chain: WalletChain,
      address: string
    ): Promise<WalletChallenge | { status: 'error'; message: string }> => {
      const res = await fetch(`/api/lite/auth/${chain}/challenge`, {
        method: 'POST',
        headers: JSON_POST,
        body: JSON.stringify({ address })
      });
      if (!res.ok) return { status: 'error', message: await friendlyError(res) };
      return (await res.json()) as WalletChallenge;
    },
    []
  );

  const walletVerify = useCallback(
    async (chain: WalletChain, address: string, signature: string, nonce: string): Promise<ResolveOutcome> => {
      const res = await fetch(`/api/lite/auth/${chain}/verify`, {
        method: 'POST',
        headers: JSON_POST,
        body: JSON.stringify({ address, signature, nonce })
      });
      return resolveFrom(res);
    },
    [resolveFrom]
  );

  const btcChallenge = useCallback(
    (address: string) => walletChallenge('btc', address),
    [walletChallenge]
  );

  const btcVerify = useCallback(
    (address: string, signature: string, nonce: string) => walletVerify('btc', address, signature, nonce),
    [walletVerify]
  );

  const createAccount = useCallback(
    async (displayName: string, captchaToken?: string): Promise<SignupOutcome> => {
      const res = await fetch('/api/lite/auth/name', {
        method: 'POST',
        headers: JSON_POST,
        body: JSON.stringify({ displayName, captchaToken })
      });
      const body = (await res.json().catch(() => null)) as { status?: string; message?: string; user?: unknown } | null;
      if (!res.ok) return { status: 'error', message: body?.message || (await friendlyError(res)) };
      if (body?.status === 'ok') {
        applyUser(body.user);
        return { status: 'ok' };
      }
      return { status: 'error', message: body?.message || GENERIC };
    },
    [applyUser]
  );

  // Debounced availability check for live name-pick feedback (read-only route).
  const checkName = useCallback((name: string) => {
    if (checkTimer.current) clearTimeout(checkTimer.current);
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) {
      setNameStatus({ state: 'idle' });
      return;
    }
    setNameStatus({ state: 'checking' });
    const seq = ++checkSeq.current;
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/lite/name/check?name=${encodeURIComponent(trimmed)}`);
        if (seq !== checkSeq.current) return;
        if (!res.ok) {
          setNameStatus({ state: 'unavailable', reason: await friendlyError(res) });
          return;
        }
        const body = (await res.json()) as { available?: boolean; reason?: string };
        setNameStatus(
          body.available
            ? { state: 'available' }
            : { state: 'unavailable', reason: body.reason || 'That name isn’t available.' }
        );
      } catch {
        if (seq === checkSeq.current)
          setNameStatus({ state: 'unavailable', reason: 'Could not verify availability right now — retry.' });
      }
    }, 350);
  }, []);

  return {
    nameStatus,
    checkName,
    google,
    googleChallenge,
    walletChallenge,
    walletVerify,
    btcChallenge,
    btcVerify,
    createAccount
  };
}
