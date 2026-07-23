import { User } from '@smart-signer/types/common';
import { vetNameFormat } from '../names/vetting';
import * as users from '../repositories/user-repository';
import * as names from '../repositories/name-reservation-repository';
import * as upgradeEvents from '../repositories/upgrade-event-repository';
import { GeneratedKeys, getAccountCreator, hasAccountCreator } from './account-creator';

/**
 * Lite -> full Hive account upgrade (spec §F). Idempotent, chain-reconciled, and
 * re-vets a NEW on-chain name that must differ from the permanent Lumen handle.
 * On success the account's keys are returned ONCE (reveal-once custody) and the
 * accrued balance is swept to the new account. `user_id` never changes, so the
 * Lumen history stays continuous across the on-chain author change.
 */

export type UpgradeResult =
  | { status: 'ok'; hiveAccountName: string; keys: GeneratedKeys }
  | { status: 'error'; code: string; message: string };

const NAME_LOCK_TTL_S = 300;

export async function upgradeToFullAccount(
  sessionUser: User | undefined,
  newNameRaw: string
): Promise<UpgradeResult> {
  if (!sessionUser?.userId || sessionUser.account_tier !== 'lite') {
    return { status: 'error', code: 'unauthorized', message: 'Not signed in as a lite account.' };
  }
  if (!hasAccountCreator()) {
    return { status: 'error', code: 'unavailable', message: 'Account creation is not configured.' };
  }

  const user = await users.findUserById(sessionUser.userId);
  if (!user) return { status: 'error', code: 'not_found', message: 'Account not found.' };
  // Idempotency: already upgraded?
  if (user.accountTier === 'full' || user.hiveAccountName) {
    return { status: 'error', code: 'already_upgraded', message: 'This account has already been upgraded.' };
  }

  const newName = newNameRaw.trim().toLowerCase();
  // "Pick another name" is firm — must differ from the permanent Lumen handle (§F.2).
  if (newName === user.displayName.toLowerCase()) {
    return { status: 'error', code: 'name_must_differ', message: 'Choose a name different from your Lumen handle.' };
  }
  const vet = vetNameFormat(newName);
  if (!vet.ok) return { status: 'error', code: 'invalid_name', message: vet.error };
  // Re-vet against Lumen's own namespace (a self-inflicted collision we control now).
  if (await users.findUserByDisplayName(newName)) {
    return { status: 'error', code: 'name_taken', message: 'That name is in use on Lumen.' };
  }
  if (await users.findUserByHiveAccountName(newName)) {
    return { status: 'error', code: 'name_taken', message: 'That name is already claimed.' };
  }

  const creator = getAccountCreator();
  const locked = await names.reservePending(newName, NAME_LOCK_TTL_S);
  if (!locked) return { status: 'error', code: 'name_taken', message: 'That name is being claimed.' };

  const event = await upgradeEvents.create(user.userId, newName);
  try {
    // Chain reconciliation: never burn a second ACT if the account already exists.
    if (await creator.accountExists(newName)) {
      await names.releasePending(newName);
      await upgradeEvents.fail(event.id, 'name_on_chain');
      return { status: 'error', code: 'name_on_chain', message: 'That name already exists on Hive.' };
    }

    const keys = await creator.generateKeys(newName);
    const { trxId } = await creator.createClaimedAccount(newName, keys);

    // ─── POINT OF NO RETURN: the on-chain account now EXISTS with `keys`. ───
    // UPGRADE-KEYLOSS (PRUNED 2026-07-22): the master password is random and is
    // NEVER stored server-side, so from here the reveal-once keys MUST reach the
    // caller no matter what fails below — a throw here (a flaky settle was the
    // proven trigger) would discard an unrecoverable key and permanently lock the
    // user out of their brand-new account. Every step below is therefore
    // best-effort and can NEVER throw out of this function before the keys are
    // returned; bookkeeping/settlement failures are recorded, not raised.
    try {
      await upgradeEvents.markCreated(event.id, trxId);
      // Even if a concurrent request already flipped the flag, THIS request
      // created the on-chain account, so these keys are the real ones and must be
      // returned either way (never short-circuit the reveal on the idem race).
      const updated = await users.markUpgraded(user.userId, newName);
      if (updated) await names.promoteToActive(newName, user.userId);
      // No earnings settlement: lite accounts hold NO balance (rewards are
      // rejected at publish, decision 2026-07-23), so upgrade only creates the
      // on-chain account and hands over the keys — there is nothing to sweep.
    } catch (postCreateError) {
      await upgradeEvents
        .fail(
          event.id,
          `post_create:${postCreateError instanceof Error ? postCreateError.message : String(postCreateError)}`
        )
        .catch(() => undefined); // bookkeeping is best-effort; never mask the reveal
    }

    // Keys returned ONCE to the caller (reveal-once). Never stored server-side.
    // REMAINING before wiring setAccountCreator: a durable encrypted reveal
    // outbox so a LOST HTTP RESPONSE can't lock a user out either — persist keys
    // at the point of no return and let the user re-fetch until confirmed. (The
    // idempotency short-circuit at the top of this function must then return the
    // stored keys rather than an error.)
    return { status: 'ok', hiveAccountName: newName, keys };
  } catch (error) {
    // Reached ONLY for pre-creation failures (accountExists/generateKeys/
    // createClaimedAccount) — the on-chain account does not exist yet, so no
    // reveal-once key can be stranded; safe to surface as an error.
    await names.releasePending(newName);
    await upgradeEvents.fail(event.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
