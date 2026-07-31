import { cookies } from 'next/headers';
import { User } from '@smart-signer/types/common';
import { checkAccountExists } from '@transaction/lib/validation/existence/account';
import { AuthMethod, LumenUser } from '../types';
import { buildLiteSessionUser } from '../session/lite-session';
import { getLiteSession } from '../http/session';
import { vetNameFormat } from '../names/vetting';
import { enforceSignupSuccessRate } from '../antispam/rate-limit';
import { execOn, withTransaction } from '../db/pool';
import * as users from '../repositories/user-repository';
import * as creds from '../repositories/credential-repository';
import { siblingBtcAddresses } from './btc-key-fingerprint';
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
  /** BTC only: hash160(compressed pubkey) — one key, one account. */
  keyFingerprint?: string;
  emailCiphertextB64?: string;
  emailHash?: string;
}

export type ResolveResult =
  | { status: 'authenticated'; user: User }
  | { status: 'needs_name' }
  // F-L27: a REFUSAL (banned/suspended/upgraded) is a typed result, not a thrown
  // Error — the login routes were catching these throws and returning HTTP 500,
  // so a suspended user saw "server error" instead of the honest 403.
  | { status: 'error'; code: string; httpStatus: number };

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
  // F-L3: stamp the current epoch into the cookie. Every acting request re-reads
  // the row's epoch and refuses a mismatch, so bumping it (upgrade/suspend/ban/
  // logout-all) instantly invalidates every cookie issued before the bump.
  session.sessionEpoch = u.sessionEpoch ?? 0;
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
/**
 * Find a pre-fingerprint credential belonging to the same key, by looking up the
 * other addresses that key can produce. An address cannot be reversed into a public
 * key, so old NULL-fingerprint rows are unreachable any other way.
 */
async function findBySiblingAddress(method: AuthMethod, keyFingerprint?: string, network?: string) {
  if (method !== 'btc_wallet' || !keyFingerprint) return null;
  // F-L29: derive siblings on the login's OWN network. Without this the heal-path
  // was mainnet-only too, so a legacy NULL-fingerprint testnet row could never be
  // matched and the one-key-one-account guarantee lapsed for that tier.
  const net = network === 'testnet' ? 'testnet' : network === 'regtest' ? 'regtest' : 'bitcoin';
  for (const sibling of siblingBtcAddresses(keyFingerprint, net)) {
    const found = await creds.findByMethodAndRef(method, sibling);
    if (found) return found;
  }
  return null;
}

export async function resolveLogin(
  method: AuthMethod,
  externalRef: string,
  extras: AuthExtras = {}
): Promise<ResolveResult> {
  // Address first, then the KEY. One Bitcoin key yields three address formats, so
  // without the fingerprint check the same key would create a second account when a
  // wallet presents a different encoding of it. Matching the key logs them into the
  // account they already have.
  const binder =
    (await creds.findByMethodAndRef(method, externalRef)) ??
    (extras.keyFingerprint ? await creds.findByFingerprint(method, extras.keyFingerprint) : null) ??
    (await findBySiblingAddress(method, extras.keyFingerprint, extras.network));
  if (binder) {
    // Heal credentials created before fingerprints existed: they hold NULL, which no
    // fingerprint lookup can ever match, so without this a legacy key keeps its
    // ability to claim one extra account forever.
    if (extras.keyFingerprint && !binder.keyFingerprint) {
      await creds.setKeyFingerprint(binder.credentialId, extras.keyFingerprint);
    }
    const user = await users.findUserById(binder.userId);
    if (!user) throw new Error('Auth binder references a missing user');
    // F-L27: refusals RETURN a typed 403 rather than throwing into the route's
    // catch-all (which rendered them as 500). This is a genuine "not a server
    // fault" answer — the account exists and is simply not permitted to sign in.
    if (user.status === 'banned' || user.status === 'suspended') {
      return { status: 'error', code: `account_${user.status}`, httpStatus: 403 };
    }
    // XC-1 (PRUNED 2026-07-22): once upgraded to a full Hive account, the lite
    // credential must NOT mint a keyless 'full'-tier lite session under the Lumen
    // handle — the user has real keys now and must sign in via the Hive-account
    // path. Refuse the lite login for an upgraded account.
    if (user.accountTier === 'full' || user.hiveAccountName) {
      return { status: 'error', code: 'account_upgraded', httpStatus: 403 };
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
    keyFingerprint: extras.keyFingerprint,
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

  // One external_ref -> at most one name ever (spec §B.3): if the binder now exists
  // (a concurrent tab finished signup, or this credential was bound to an account in
  // the meantime), resolve to it instead of minting a second account.
  //
  // Looked up by external_ref AND by key fingerprint, not just the former. One BTC key
  // yields several addresses, and the fingerprint is what makes them one identity —
  // checking only the address let a second address reach `createUser`, commit the row,
  // and then hit the fingerprint UNIQUE constraint, leaving an account nobody can sign
  // into and a Lumen handle nobody can ever have.
  const existingBinder =
    (await creds.findByMethodAndRef(pending.method, pending.externalRef)) ??
    (pending.keyFingerprint
      ? await creds.findByFingerprint(pending.method, pending.keyFingerprint)
      : null);
  if (existingBinder) {
    const u = await users.findUserById(existingBinder.userId);
    // ★ The same three refusals `resolveLogin` makes. Without them this branch was a
    // side door into a session for a banned, suspended or UPGRADED account — and for an
    // upgraded one that means a keyless 'full'-tier session under the Lumen handle,
    // which is exactly what XC-1 forbids.
    if (u) {
      if (u.status === 'banned' || u.status === 'suspended') {
        session.liteSignup = undefined;
        await session.save();
        return {
          status: 'error',
          code: `account_${u.status}`,
          message: 'This account cannot be used right now.'
        };
      }
      if (u.accountTier === 'full' || u.hiveAccountName) {
        session.liteSignup = undefined;
        await session.save();
        return {
          status: 'error',
          code: 'account_upgraded',
          message: 'This wallet already belongs to a full Hive account — sign in with its keys.'
        };
      }
      return { status: 'ok', user: await issueSession(u) };
    }
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
      // F-L30: this name exists on Hive PERMANENTLY — it will never free. Clear the
      // pending session so a held session cannot sit and retry the same doomed name,
      // draining the signup rate budget on a request that can never succeed. (A user
      // who wants a different name re-authenticates — one signature.)
      session.liteSignup = undefined;
      return { status: 'error', code: 'name_on_chain', message: 'That name already exists on Hive.' };
    }
    if (existence.status === 'api_error') {
      // Fail closed — never let a node outage let someone grab a real name.
      await names.releasePending(displayName);
      return { status: 'error', code: 'vetting_unavailable', message: 'Could not verify the name right now, please retry.' };
    }

    // F-L30: charge the SCARCE success-velocity budget HERE — the request has passed
    // every doomed-name check and is about to create a real account, so failing names
    // never touch it. Exhausted → a transient capacity refusal; the name is released and
    // the pending session kept so the user can retry once the daily budget frees.
    if (!(await enforceSignupSuccessRate())) {
      await names.releasePending(displayName);
      return {
        status: 'error',
        code: 'capacity',
        message: "Sign-ups have hit today's limit — please try again later."
      };
    }

    const emailCiphertext = pending.emailCiphertextB64
      ? Buffer.from(pending.emailCiphertextB64, 'base64')
      : null;

    // ★ ONE TRANSACTION. These three writes are one fact: "this person has this name
    // with this credential." Committed separately, a failure on the third left an
    // account with NO credential — unreachable forever — while permanently consuming
    // the display name, which is UNIQUE. Repeatable, so it could burn Lumen handles in
    // bulk.
    const user = await withTransaction(async (client) => {
      const exec = execOn(client);
      const created = await users.createUser({ displayName }, exec);
      const promoted = await names.promoteToActive(displayName, created.userId, exec);
      if (!promoted) {
        // The hold this transaction relies on is gone or belongs to someone else.
        // Rolling back is the only honest outcome: committing would leave
        // `name_reservation` and `lumen_user` disagreeing about who owns the name.
        throw new Error('name_reservation_lost');
      }
      await creds.createCredential(
        {
          userId: created.userId,
          method: pending.method,
          externalRef: pending.externalRef,
          network: pending.network ?? null,
          keyFingerprint: pending.keyFingerprint ?? null,
          emailCiphertext,
          emailHash: pending.emailHash ?? null,
          isPrimary: true
        },
        exec
      );
      return created;
    });
    return { status: 'ok', user: await issueSession(user) };
  } catch (error) {
    await names.releasePending(displayName);
    // SEQ-2 (PRUNED 2026-07-22): a concurrent signup can promote the same name
    // between reservePending and createUser (the display_name UNIQUE constraint
    // then fires) — surface it as a clean 'name_taken' rather than an uncaught 500.
    if (
      (error && typeof error === 'object' && (error as { code?: string }).code === '23505') ||
      (error instanceof Error && error.message === 'name_reservation_lost')
    ) {
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
  // Address AND key: binding must refuse a key that already belongs to someone,
  // even when presented under a different address encoding — otherwise the
  // three-addresses-per-key trick just moves from signup to linking.
  const existing =
    (await creds.findByMethodAndRef(method, externalRef)) ??
    (extras.keyFingerprint ? await creds.findByFingerprint(method, extras.keyFingerprint) : null);
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
    keyFingerprint: extras.keyFingerprint ?? null,
    emailCiphertext,
    emailHash: extras.emailHash ?? null,
    isPrimary: false
  });
  // F-L2: record the link at the single chokepoint every bind branch flows through.
  await creds.writeCredentialAudit(userId, null, 'bind', method);
  return { status: 'ok' };
}
