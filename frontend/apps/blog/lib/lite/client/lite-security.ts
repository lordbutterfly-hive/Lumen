'use client';

import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import type { WalletChain } from '@/blog/features/lite-auth/wallet/appkit';

/**
 * Client calls for account security: which sign-in methods are linked, and linking
 * another one.
 *
 * A lite account has no password and no recovery email, so its linked credentials are
 * the only way back in. The bind endpoint has existed since Phase 2 with nothing in the
 * product calling it, which meant every lite user was one lost wallet away from losing
 * their account and was never told.
 *
 * Linking is a two-step step-up: ask for a single-use, user-bound nonce, prove the NEW
 * credential against it, then bind. A plain login nonce is rejected (SEQ-1/XC-2), and
 * the message the wallet signs differs per chain, so the nonce request returns both and
 * the caller picks.
 */

const JSON_POST: HeadersInit = { 'Content-Type': 'application/json', [csrfHeaderName]: '1' };

export type LiteAuthMethodName = 'google_passkey' | 'btc_wallet' | 'evm_wallet';

export interface LiteAuthMethod {
  credentialId: string;
  method: LiteAuthMethodName;
  network: string | null;
  /** Truncated address, or null for Google (an opaque `sub` tells the user nothing). */
  hint: string | null;
  isPrimary: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface LiteAuthMethods {
  methods: LiteAuthMethod[];
  /** True while only one credential exists — a single point of account loss. */
  atRisk: boolean;
}

export interface StepUp {
  nonce: string;
  messages: { btc: string; evm: string };
}

export type BindResult = { status: 'ok' } | { status: 'error'; message: string };

function friendlyBindError(status: number, code?: string): string {
  if (status === 401 && code === 'invalid_or_expired_challenge') {
    return 'That took too long — please try again.';
  }
  if (status === 401 && (code === 'bad_signature' || code === 'nonce_mismatch')) {
    return 'That signature didn’t match. Please try again.';
  }
  if (status === 409) return 'That’s already linked to an account.';
  if (code === 'taproot_unsupported') {
    return 'Taproot addresses aren’t supported yet — use a SegWit (bc1q…) or legacy (1…) address.';
  }
  if (status === 401) return 'Please sign in again and retry.';
  return 'Could not link that method — please try again.';
}

export async function fetchAuthMethods(): Promise<LiteAuthMethods | null> {
  try {
    const res = await fetch('/api/lite/auth/methods', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as LiteAuthMethods;
  } catch {
    return null;
  }
}

export async function requestStepUp(): Promise<StepUp | null> {
  try {
    const res = await fetch('/api/lite/auth/stepup', { method: 'POST', headers: JSON_POST });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<StepUp> & { message?: string };
    if (!body.nonce) return null;
    // `messages` is the current shape; fall back to the legacy single BTC `message`
    // so a stale server does not break linking outright.
    return {
      nonce: body.nonce,
      messages: body.messages ?? { btc: body.message ?? '', evm: '' }
    };
  } catch {
    return null;
  }
}

async function bind(payload: Record<string, unknown>): Promise<BindResult> {
  try {
    const res = await fetch('/api/lite/auth/bind', {
      method: 'POST',
      headers: JSON_POST,
      body: JSON.stringify(payload)
    });
    const body = (await res.json().catch(() => null)) as { status?: string; error?: string } | null;
    if (res.ok && body?.status === 'ok') return { status: 'ok' };
    return { status: 'error', message: friendlyBindError(res.status, body?.error) };
  } catch {
    return { status: 'error', message: 'Network error — please try again.' };
  }
}

export function bindWallet(
  chain: WalletChain,
  address: string,
  signature: string,
  nonce: string
): Promise<BindResult> {
  return bind({ method: chain, address, signature, nonce });
}

export function bindGoogle(idToken: string, nonce: string): Promise<BindResult> {
  return bind({ method: 'google', idToken, nonce });
}
