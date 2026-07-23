import { cookies } from 'next/headers';
import { User } from '@smart-signer/types/common';
import { checkAccountExists } from '@transaction/lib/validation/existence/account';
import { AuthMethod, LumenUser } from '../types';
import { buildLiteSessionUser } from '../session/lite-session';
import { getLiteSession } from '../http/session';
import { vetNameFormat } from '../names/vetting';
import * as users from '../repositories/user-repository';
import * as creds from '../repositories/credential-repository';
import * as names from '../repositories/name-reservation-repository';

/**
 * Shared login/signup orchestration for both auth methods (Google, BTC). The
 * per-method routes only prove identity; everything after — resolve-or-signup,
 * session issuance, name-pick, second-binder recovery — lives here (spec §A.1).
 */

const PENDING_TTL_MS = 30 * 60 * 1000; // provisional signup window
const RESERVE_TTL_S = 15 * 60; // pending name reservation

export interface AuthExtras {
  network?: string;
  emailCiphertextB64?: string;
  emailHash?: string;
}

export type ResolveResult =
  | { status: 'authenticated'; user: User }
  | { status: 'needs_name' };

export type SignupResult =
  | { status: 'ok'; user: User }
  | { status: 'error'; code: string; message: string };

export type BindResult =
  | { status: 'ok' }
  | { status: 'error'; code: string; message: string };

async function issueSession(u: LumenUser): Promise<User> {
  const sessionUser = buildLiteSessionUser(u);
  const session = await getLiteSession();
  session.user = sessionUser;
  session.liteSignup = undefined;
  await session.save();
  // Analytics parity with the Hive login path (spec §A.5): a lightweight,
  // httpOnly cookie the Edge visit-logger can read without decryption.
  cookies().set('account_info', `${u.displayName}:lite`, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
  return sessionUser;
}

/**
 * A verified credential resolves to an existing account (-> session) or, if the
 * binder is unknown, stashes a provisional signup and asks for a name.
 */
export async function resolveLogin(
  method: AuthMethod,
  externalRef: string,
  extras: AuthExtras = {}
): Promise<ResolveResult> {
  const binder = await creds.findByMethodAndRef(method, externalRef);
  if (binder) {
    const user = await users.findUserById(binder.userId);
    if (!user) throw new Error('Auth binder references a missing user');
    if (user.status === 'banned' || user.status === 'suspended') {
      throw new Error(`account_${user.status}`);
    }
    // XC-1 (PRUNED 2026-07-22): once upgraded to a full Hive account, the lite
    // credential must NOT mint a keyless 'full'-tier lite session under the Lumen
    // handle — the user has real keys now and must sign in via the Hive-account
    // path. Refuse the lite login for an upgraded account.
    if (user.accountTier === 'full' || user.hiveAccountName) {
      throw new Error('account_upgraded');
    }
    await creds.touchLastUsed(binder.credentialId);
    const sessionUser = await issueSession(user);
    return { status: 'authenticated', user: sessionUser };
  }

  const session = await getLiteSession();
  session.user = undefined;
  session.liteSignup = {
    method,
    externalRef,
    network: extras.network,
    emailCiphertextB64: extras.emailCiphertextB64,
    emailHash: extras.emailHash,
    issuedAt: Date.now()
  };
  await session.save();
  return { status: 'needs_name' };
}

/**
 * Completes a provisional signup with a chosen name. Two-phase claim: DB
 * pending reservation -> Lumen-namespace + live Hive existence (fail-closed) ->
 * create user + binder + promote reservation -> session (spec §B.2).
 */
export async function completeSignup(displayNameRaw: string): Promise<SignupResult> {
  const session = await getLiteSession();
  const pending = session.liteSignup;
  if (!pending) {
    return { status: 'error', code: 'no_pending_signup', message: 'No sign-up is in progress.' };
  }
  if (Date.now() - pending.issuedAt > PENDING_TTL_MS) {
    session.liteSignup = undefined;
    await session.save();
    return { status: 'error', code: 'signup_expired', message: 'Sign-up expired, please sign in again.' };
  }

  const displayName = displayNameRaw.trim().toLowerCase();
  const vet = vetNameFormat(displayName);
  if (!vet.ok) return { status: 'error', code: 'invalid_name', message: vet.error };

  // One external_ref -> at most one name ever (spec §B.3): if the binder now
  // exists (e.g. a concurrent tab finished signup), resolve to it instead.
  const existingBinder = await creds.findByMethodAndRef(pending.method, pending.externalRef);
  if (existingBinder) {
    const u = await users.findUserById(existingBinder.userId);
    if (u) return { status: 'ok', user: await issueSession(u) };
  }

  const reserved = await names.reservePending(displayName, RESERVE_TTL_S);
  if (!reserved) {
    return { status: 'error', code: 'name_taken', message: 'That name is taken.' };
  }

  try {
    if (await users.findUserByDisplayName(displayName)) {
      await names.releasePending(displayName);
      return { status: 'error', code: 'name_taken', message: 'That name is taken.' };
    }

    const existence = await checkAccountExists(displayName);
    if (existence.status === 'exists') {
      await names.releasePending(displayName);
      return { status: 'error', code: 'name_on_chain', message: 'That name already exists on Hive.' };
    }
    if (existence.status === 'api_error') {
      // Fail closed — never let a node outage let someone grab a real name.
      await names.releasePending(displayName);
      return { status: 'error', code: 'vetting_unavailable', message: 'Could not verify the name right now, please retry.' };
    }

    const emailCiphertext = pending.emailCiphertextB64
      ? Buffer.from(pending.emailCiphertextB64, 'base64')
      : null;

    const user = await users.createUser({ displayName });
    await names.promoteToActive(displayName, user.userId);
    await creds.createCredential({
      userId: user.userId,
      method: pending.method,
      externalRef: pending.externalRef,
      network: pending.network ?? null,
      emailCiphertext,
      emailHash: pending.emailHash ?? null,
      isPrimary: true
    });
    return { status: 'ok', user: await issueSession(user) };
  } catch (error) {
    await names.releasePending(displayName);
    // SEQ-2 (PRUNED 2026-07-22): a concurrent signup can promote the same name
    // between reservePending and createUser (the display_name UNIQUE constraint
    // then fires) — surface it as a clean 'name_taken' rather than an uncaught 500.
    if (error && typeof error === 'object' && (error as { code?: string }).code === '23505') {
      return { status: 'error', code: 'name_taken', message: 'That name is taken.' };
    }
    throw error;
  }
}

/**
 * Link a second auth method to the signed-in account — the account-recovery
 * mechanism (spec §A.1). Refuses a credential already bound elsewhere.
 */
export async function bindMethod(
  userId: string,
  method: AuthMethod,
  externalRef: string,
  extras: AuthExtras = {}
): Promise<BindResult> {
  const existing = await creds.findByMethodAndRef(method, externalRef);
  if (existing) {
    if (existing.userId === userId) return { status: 'ok' }; // idempotent
    return {
      status: 'error',
      code: 'already_bound',
      message: 'That credential is already linked to another account.'
    };
  }
  const emailCiphertext = extras.emailCiphertextB64
    ? Buffer.from(extras.emailCiphertextB64, 'base64')
    : null;
  await creds.createCredential({
    userId,
    method,
    externalRef,
    network: extras.network ?? null,
    emailCiphertext,
    emailHash: extras.emailHash ?? null,
    isPrimary: false
  });
  return { status: 'ok' };
}
