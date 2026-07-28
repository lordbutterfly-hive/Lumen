// Type-only: a value import drags @hiveio/wax into every runtime that touches this
// module (ops scripts, the migration runner, tests), and wax has no CJS export map.
import type { User } from '@smart-signer/types/common';
import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '../config';
import { vetNameFormat } from '../names/vetting';
import * as users from '../repositories/user-repository';
import * as names from '../repositories/name-reservation-repository';
import * as upgradeEvents from '../repositories/upgrade-event-repository';
import * as keyReveals from '../repositories/key-reveal-repository';
import { GeneratedKeys, getAccountCreator, hasAccountCreator } from './account-creator';
import { decryptKeys, encryptKeys, isKeyRevealConfigured } from './key-reveal-crypto';

/**
 * Lite -> full Hive account upgrade (spec §F). Idempotent, chain-reconciled, and
 * re-vets a NEW on-chain name that must differ from the permanent Lumen handle.
 * `user_id` never changes, so the Lumen history stays continuous across the on-chain
 * author change.
 *
 * CUSTODY. `create_claimed_account` cannot be undone and the master password is random
 * and never derivable again, so the keys have exactly one journey from this function to
 * the user. They are therefore encrypted and persisted to `key_reveal` BEFORE the
 * account is created (migration 0015), and stay there until the user acknowledges
 * receipt. A dropped connection, a closed tab or a crashed render is now a re-fetch
 * rather than a permanently lost account.
 */

const logger = getLogger('app');

export type UpgradeResult =
  | {
      status: 'ok';
      hiveAccountName: string;
      keys: GeneratedKeys;
      /** Acknowledge with this to wipe the stored copy — see /api/account/upgrade/reveal. */
      revealId: string;
      /** True when these keys came from the outbox rather than a fresh creation. */
      resumed?: boolean;
    }
  | { status: 'error'; code: string; message: string };

const NAME_LOCK_TTL_S = 300;

/**
 * Hands back keys this user is already owed, reconciling an 'uncertain' row against
 * the chain first. Returns null when there is nothing outstanding.
 */
async function resumeOutstandingReveal(userId: string): Promise<UpgradeResult | null> {
  const outstanding = await keyReveals.findOutstandingByUser(userId);
  if (!outstanding) return null;

  const keys = decryptKeys(outstanding.ciphertext);
  if (!keys) {
    // Rotated key, truncated row, or tampered ciphertext. Say so instead of returning
    // an empty success the user would copy down as real keys.
    logger.error(
      { revealId: outstanding.revealId },
      'Lite upgrade: stored reveal could not be decrypted — the user cannot be given their keys'
    );
    return {
      status: 'error',
      code: 'reveal_unreadable',
      message: 'Your account was created but its keys can no longer be read. Please contact support.'
    };
  }

  // An 'uncertain' row means the create broadcast failed ambiguously — it may or may
  // not have landed. Settle that against the chain before handing over keys that might
  // belong to no account at all.
  if (outstanding.status === 'uncertain' && hasAccountCreator()) {
    try {
      const exists = await getAccountCreator().accountExists(outstanding.hiveAccountName);
      if (!exists) {
        await keyReveals.discard(outstanding.revealId);
        await names.releasePending(outstanding.hiveAccountName).catch(() => undefined);
        return null; // nothing was created — let the caller start a clean attempt
      }
      await keyReveals.markAvailable(outstanding.revealId, '');
    } catch (error) {
      // Node hiccup: keep the row and hand the keys over. Holding them back because a
      // node was briefly unreachable is the worse failure by far.
      logger.warn({ err: error }, 'Lite upgrade: could not reconcile an uncertain reveal against chain');
    }
  }

  await keyReveals.recordFetch(outstanding.revealId);
  return {
    status: 'ok',
    hiveAccountName: outstanding.hiveAccountName,
    keys,
    revealId: outstanding.revealId,
    resumed: true
  };
}

export async function upgradeToFullAccount(
  sessionUser: User | undefined,
  newNameRaw: string
): Promise<UpgradeResult> {
  if (!sessionUser?.userId || sessionUser.account_tier !== 'lite') {
    return { status: 'error', code: 'unauthorized', message: 'Not signed in as a lite account.' };
  }
  const user = await users.findUserById(sessionUser.userId);
  if (!user) return { status: 'error', code: 'not_found', message: 'Account not found.' };

  // Keys already owed to this user outrank everything below — including the
  // "already upgraded" refusal, which is exactly the state a user lands in when their
  // first response was lost. Refusing them here is what used to strand the account.
  const resumed = await resumeOutstandingReveal(user.userId);
  if (resumed) return resumed;

  if (user.accountTier === 'full' || user.hiveAccountName) {
    return { status: 'error', code: 'already_upgraded', message: 'This account has already been upgraded.' };
  }
  // A suspended or banned account may not upgrade its way out. Upgrading burns one of
  // OUR account creation tokens and hands over a full Hive account with its own keys —
  // an account we can no longer moderate at all. Checked here, before the name lock
  // and long before the ACT, so nothing is spent on a refusal.
  if (user.status !== 'active') {
    return {
      status: 'error',
      code: `account_${user.status}`,
      message: 'This account cannot be upgraded right now.'
    };
  }
  // Checked AFTER the account's own eligibility so a suspended user is told the real
  // reason ("you are suspended") rather than a misleading "not configured yet".
  if (!hasAccountCreator()) {
    return { status: 'error', code: 'unavailable', message: 'Account creation is not configured.' };
  }
  // Refuse to start what we could not durably record. Checked here — while refusing is
  // still free — rather than discovering it after the account exists on chain.
  if (!isKeyRevealConfigured()) {
    logger.error('Lite upgrade blocked: LITE_KEY_REVEAL_ENCRYPTION_KEY is missing or not 32 bytes');
    return { status: 'error', code: 'unavailable', message: 'Account creation is not configured.' };
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

  // Best-effort hygiene: drop key material whose window has closed. Reads already
  // filter on expiry, so this only stops keys living at rest indefinitely.
  await keyReveals.purgeExpired().catch(() => undefined);

  const creator = getAccountCreator();
  const locked = await names.reservePending(newName, NAME_LOCK_TTL_S);
  if (!locked) return { status: 'error', code: 'name_taken', message: 'That name is being claimed.' };

  const event = await upgradeEvents.create(user.userId, newName);
  let revealId: string | null = null;
  let creationAttempted = false;
  try {
    // Chain reconciliation: never burn a second ACT if the account already exists.
    if (await creator.accountExists(newName)) {
      await names.releasePending(newName);
      await upgradeEvents.fail(event.id, 'name_on_chain');
      return { status: 'error', code: 'name_on_chain', message: 'That name already exists on Hive.' };
    }

    const keys = await creator.generateKeys(newName);

    // ─── The outbox is written FIRST, while failing is still free. ───
    // If this throws, no account has been created and nothing is stranded.
    const stored = await keyReveals.create({
      userId: user.userId,
      upgradeEventId: event.id,
      hiveAccountName: newName,
      ciphertext: encryptKeys(keys),
      ttlHours: liteConfig.keyRevealTtlHours
    });
    revealId = stored.revealId;

    creationAttempted = true;
    const { trxId } = await creator.createClaimedAccount(newName, keys);

    // ─── POINT OF NO RETURN: the on-chain account now EXISTS with `keys`. ───
    // UPGRADE-KEYLOSS (PRUNED 2026-07-22): from here the keys MUST reach the caller no
    // matter what fails below. They are already durably stored, so a failure here is a
    // re-fetch rather than a lockout — but nothing below may throw out of this function
    // before the keys are returned. Bookkeeping failures are recorded, not raised.
    try {
      await keyReveals.markAvailable(revealId, trxId);
      await upgradeEvents.markCreated(event.id, trxId);
      // Even if a concurrent request already flipped the flag, THIS request created the
      // on-chain account, so these keys are the real ones and must be returned either
      // way (never short-circuit the reveal on the idem race).
      const updated = await users.markUpgraded(user.userId, newName);
      if (updated) await names.promoteToActive(newName, user.userId);
      // No earnings settlement: lite accounts hold NO balance (rewards are rejected at
      // publish, decision 2026-07-23), so upgrade only creates the on-chain account and
      // hands over the keys — there is nothing to sweep.
    } catch (postCreateError) {
      await upgradeEvents
        .fail(
          event.id,
          `post_create:${postCreateError instanceof Error ? postCreateError.message : String(postCreateError)}`
        )
        .catch(() => undefined); // bookkeeping is best-effort; never mask the reveal
    }

    return { status: 'ok', hiveAccountName: newName, keys, revealId };
  } catch (error) {
    if (revealId && creationAttempted) {
      // The create broadcast failed, but a timeout is not proof it did not land. Keep
      // the ciphertext; the next attempt reconciles it against the chain and either
      // hands these keys over or discards them.
      await keyReveals.markUncertain(revealId).catch(() => undefined);
    } else if (revealId) {
      await keyReveals.discard(revealId).catch(() => undefined);
    }
    // Only reached for pre-creation failures when `creationAttempted` is false, in
    // which case no account exists and no key can be stranded.
    await names.releasePending(newName);
    await upgradeEvents.fail(event.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Re-fetch the keys this user is still owed. Backs GET /api/account/upgrade/reveal —
 * the path a user takes when the original response never arrived.
 */
export async function fetchOutstandingReveal(sessionUser: User | undefined): Promise<UpgradeResult> {
  if (!sessionUser?.userId) {
    return { status: 'error', code: 'unauthorized', message: 'Not signed in.' };
  }
  const resumed = await resumeOutstandingReveal(sessionUser.userId);
  if (resumed) return resumed;
  return { status: 'error', code: 'no_reveal', message: 'There are no keys waiting for you.' };
}

/**
 * The user confirmed they have written the keys down; wipe the stored copy. Scoped by
 * user so a reveal id alone can never destroy someone else's only copy.
 */
export async function acknowledgeReveal(
  sessionUser: User | undefined,
  revealId: string
): Promise<{ status: 'ok' } | { status: 'error'; code: string; message: string }> {
  if (!sessionUser?.userId) {
    return { status: 'error', code: 'unauthorized', message: 'Not signed in.' };
  }
  const done = await keyReveals.acknowledge(revealId, sessionUser.userId);
  if (!done) {
    return { status: 'error', code: 'not_found', message: 'There is nothing to acknowledge.' };
  }
  return { status: 'ok' };
}
