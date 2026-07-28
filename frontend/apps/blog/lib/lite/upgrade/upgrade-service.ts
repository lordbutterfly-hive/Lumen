// Type-only: a value import drags @hiveio/wax into every runtime that touches this
// module (ops scripts, the migration runner, tests), and wax has no CJS export map.
import type { User } from '@smart-signer/types/common';
import { getLogger } from '@ui/lib/logging';
import { withAdvisoryLock } from '../db/pool';
import { vetNameFormat } from '../names/vetting';
import * as users from '../repositories/user-repository';
import * as names from '../repositories/name-reservation-repository';
import * as upgradeEvents from '../repositories/upgrade-event-repository';
import * as follows from '../repositories/follow-repository';
import { LITE_HANDLE_REUSE_MESSAGE, isOwnLiteHandle } from '../names/upgrade-name';
import { AccountPublicKeys, getAccountCreator, hasAccountCreator } from './account-creator';

/**
 * Lite -> full Hive account upgrade (spec §F). Idempotent, chain-reconciled, and
 * re-vets a NEW on-chain name that must differ from the permanent Lumen handle.
 * `user_id` never changes, so the Lumen history stays continuous across the on-chain
 * author change.
 *
 * ★ CUSTODY. This function never sees a private key. The browser generates the master
 * password, derives the four role keys, makes the user save them, and sends only the
 * PUBLIC keys here. A master password is the account's owner key — a server that mints
 * or receives one can take the account back at any time, however carefully it stores
 * it, and this screen promises the user the opposite. So the secret never exists on
 * this side of the wire and there is nothing here to encrypt, log, leak or subpoena.
 *
 * What that costs, and how it is paid. The old design could re-hand keys to a user
 * whose response was lost, because it had kept a copy. It cannot now — so the browser
 * makes the user confirm they have saved the keys BEFORE the account is created, which
 * closes the window entirely: at every instant either the account does not exist, or
 * the user already has its keys. The remaining case — the account was created but our
 * bookkeeping never ran — is reconciled by {@link resumeInFlightUpgrade} using the
 * recorded owner PUBLIC key, no secret required.
 */

const logger = getLogger('app');

export type UpgradeResult =
  | {
      status: 'ok';
      hiveAccountName: string;
      /** True when the account already existed from an earlier attempt of this user's. */
      resumed?: boolean;
    }
  | { status: 'error'; code: string; message: string; hiveAccountName?: string };

/**
 * How long the chain gets to settle a broadcast before absence is read as failure.
 *
 * The number is not arbitrary. A wax transaction expires 60 seconds after it is built
 * (`createTransaction()` defaults to `+1m`), and the attempt's clock starts a little
 * BEFORE that — the row is written first, then the existence check, the token-pool read
 * and possibly a claim with its ~12s wait run before anything is broadcast. Five
 * minutes covers that whole span with room to spare, and the cost of being generous is
 * only that a genuinely failed attempt waits a few minutes before its name is freed —
 * against the cost of being hasty, which is freeing a name we may already own.
 */
const SETTLE_WINDOW_S = 300;

const NAME_LOCK_TTL_S = 300;

/** The prefix-independent body of a public key (STM on mainnet, TST on a testnet). */
function keyBody(key: string): string {
  return /^[A-Z]{3}[1-9A-HJ-NP-Za-km-z]+$/.test(key) ? key.slice(3) : key;
}

/** Compare public keys ignoring the network prefix. */
function sameKey(a: string, b: string): boolean {
  return keyBody(a) === keyBody(b);
}

const PUBLIC_KEY_PATTERN = /^[A-Z]{3}[1-9A-HJ-NP-Za-km-z]{45,55}$/;

/**
 * Accept only four well-formed, distinct public keys, and nothing that could be a
 * private key.
 *
 * The last clause is the important one. A client bug that posted a WIF into one of
 * these fields would put a private key in our request logs — exactly the exposure this
 * whole change removes — so it is refused at the boundary rather than trusted to be
 * impossible. Hive public keys start with a 3-letter prefix; WIFs and master passwords
 * start with `5` or `P5`, and cannot match the pattern.
 */
export function checkPublicKeys(input: unknown): AccountPublicKeys | null {
  const keys = input as Partial<AccountPublicKeys> | null | undefined;
  if (!keys) return null;
  const roles: (keyof AccountPublicKeys)[] = ['owner', 'active', 'posting', 'memo'];
  for (const role of roles) {
    const value = keys[role];
    if (typeof value !== 'string' || !PUBLIC_KEY_PATTERN.test(value)) return null;
  }
  const out: AccountPublicKeys = {
    owner: String(keys.owner),
    active: String(keys.active),
    posting: String(keys.posting),
    memo: String(keys.memo)
  };
  // Compared prefix-stripped, exactly as the creator compares them
  // (hive-account-creator.ts). Two validators disagreeing about what "the same key"
  // means is how a request passes the boundary and then throws deep inside the
  // creator, where the failure is indistinguishable from a broadcast that may have
  // landed.
  if (new Set(roles.map((role) => keyBody(out[role]))).size !== roles.length) return null;
  return out;
}

/**
 * Finish an upgrade whose account may already exist on chain.
 *
 * The window this closes: the create broadcast landed, then the process died, the
 * connection dropped, or the bookkeeping threw. The user is still marked lite here
 * while owning a real Hive account there. Left alone, their next attempt would try to
 * create a second account and their first one would be orphaned with our creator as
 * its permanent recovery agent.
 *
 * Reconciliation uses the owner PUBLIC key recorded before the broadcast, because
 * "the name exists" is not the same as "we created it" — an ambiguous broadcast leaves
 * the name free for a while and anyone can take it. Only a matching owner key proves
 * the account belongs to the keys this user is holding.
 */
async function resumeInFlightUpgrade(userId: string): Promise<UpgradeResult | null> {
  const inFlight = await upgradeEvents.findInFlightByUser(userId);
  if (!inFlight || !hasAccountCreator()) return null;

  const creator = getAccountCreator();
  let exists: boolean;
  try {
    exists = await creator.accountExists(inFlight.hiveAccountName);
  } catch (error) {
    // A node hiccup is not evidence either way. Leave the attempt in flight and say so
    // — resolving it wrongly either strands an account or burns a second token.
    logger.warn({ err: error }, 'Lite upgrade: could not reconcile an in-flight attempt against chain');
    return {
      status: 'error',
      code: 'reconcile_unavailable',
      message: 'We cannot reach Hive to check your last attempt. Please try again in a minute.'
    };
  }

  if (!exists) {
    // ★ ABSENCE IS ONLY EVIDENCE ONCE THE CHAIN HAS HAD TIME TO SPEAK.
    //
    // A broadcast returns as soon as a node takes the transaction into its mempool.
    // Inclusion needs at least one 3-second block, then propagation to whichever node
    // answers this read, and a Hive transaction can legitimately sit unconfirmed until
    // it expires. So a single "no such account" seconds after an ambiguous broadcast
    // means nothing — and acting on it does real damage: it frees a name we may
    // already own and marks a live attempt dead, which is exactly how a user ends up
    // with two accounts and one orphan. Wait out the window first.
    if (inFlight.ageSeconds < SETTLE_WINDOW_S) {
      return {
        status: 'error',
        code: 'still_settling',
        message: 'Your last attempt is still settling on Hive. Give it a minute and reload this page.'
      };
    }
    await upgradeEvents.fail(inFlight.id, 'not_on_chain').catch(() => undefined);
    await names.releasePending(inFlight.hiveAccountName, userId).catch(() => undefined);
    return null;
  }

  // ★ The name is taken. Adopting it requires PROOF that it is ours — never merely the
  // absence of proof that it is not. Everything this function does afterwards is
  // irreversible for the user: `markUpgraded` is a one-way door, so adopting a
  // stranger's account marks them upgraded to an account they cannot open and can
  // never try again. An unavailable check is therefore refused, not waved through.
  const provenOurs = await ownsAccount(creator, inFlight);
  if (provenOurs === 'no') {
    logger.warn(
      { hiveAccountName: inFlight.hiveAccountName, upgradeEventId: inFlight.id },
      'Lite upgrade: the pending name belongs to a DIFFERENT account — our creation never landed'
    );
    await upgradeEvents.fail(inFlight.id, 'name_taken_by_other').catch(() => undefined);
    await names.releasePending(inFlight.hiveAccountName, userId).catch(() => undefined);
    return null;
  }
  if (provenOurs === 'unknown') {
    return {
      status: 'error',
      code: 'reconcile_unavailable',
      message: 'We cannot confirm your last attempt with Hive right now. Please try again in a minute.'
    };
  }

  const linked = await completeBookkeeping(userId, inFlight.hiveAccountName, inFlight.id, '');
  if (!linked) {
    return {
      status: 'error',
      code: 'created_not_linked',
      message:
        'Your Hive account exists, but we could not finish linking it to your Lumen profile. Your keys are still valid — please contact support before creating another account.',
      hiveAccountName: inFlight.hiveAccountName
    };
  }
  return { status: 'ok', hiveAccountName: inFlight.hiveAccountName, resumed: true };
}

/**
 * Is the on-chain account the one THIS user's browser generated keys for?
 *
 * Three answers, and the difference between the last two is the whole point:
 *   'yes'     — the chain's owner key matches the one recorded before the broadcast.
 *   'no'      — it matches something else; somebody took the name.
 *   'unknown' — we could not tell (no recorded key, no reader, a node error, or an
 *               owner authority with no key at all). NOT the same as 'yes'.
 */
async function ownsAccount(
  creator: ReturnType<typeof getAccountCreator>,
  inFlight: { hiveAccountName: string; ownerPublicKey: string | null }
): Promise<'yes' | 'no' | 'unknown'> {
  if (!creator.accountOwnerKeys || !inFlight.ownerPublicKey) return 'unknown';
  try {
    const onChainOwners = await creator.accountOwnerKeys(inFlight.hiveAccountName);
    if (onChainOwners === null) return 'unknown';
    // An account whose owner authority names NO key is provably not one we created —
    // every account we create is minted with exactly our key in that slot.
    if (onChainOwners.length === 0) return 'no';
    // Membership, not position: `key_auths` is sorted by key, so ours may not be first
    // if the owner later added another.
    const ours = inFlight.ownerPublicKey;
    return onChainOwners.some((key) => sameKey(key, ours)) ? 'yes' : 'no';
  } catch (error) {
    logger.warn({ err: error }, 'Lite upgrade: owner-key check failed — refusing to decide');
    return 'unknown';
  }
}

/**
 * Everything Lumen records once the on-chain account exists. Never throws: the account
 * is already real, and no bookkeeping failure may present itself to the user as "your
 * upgrade failed" when their account is sitting on chain.
 */
async function completeBookkeeping(
  userId: string,
  newName: string,
  eventId: string,
  trxId: string
): Promise<boolean> {
  try {
    // ★ ORDER MATTERS, AND THE MARKER IS CLEARED LAST.
    //
    // `status = 'creating'` is the ONLY record that an account may exist without a
    // Lumen row behind it — `findInFlightByUser` reads nothing else, and no sweeper
    // exists. Clearing it first (as this did) meant a failure on the very next
    // statement left an account on chain that reconciliation could never see again:
    // the user stays 'lite', is invited to upgrade again, and burns a second creation
    // token on a second account while the first is orphaned with our creator as its
    // permanent recovery agent.
    //
    // Every step below is idempotent (`markUpgraded` is guarded on tier, `promoteToActive`
    // on status), so failing part-way and re-running the whole sequence is safe. Marking
    // the event last makes that re-run happen by itself.
    const flipped = await users.markUpgraded(userId, newName);
    if (!flipped) {
      // `markUpgraded` is guarded on `account_tier = 'lite'`, so a no-op means the row
      // was already flipped. That is fine when it was flipped to THIS name (a retry) —
      // and a serious inconsistency when it names a different account, which must never
      // be reported as a successful link.
      const row = await users.findUserById(userId);
      if (row?.hiveAccountName?.toLowerCase() !== newName.toLowerCase()) {
        logger.error(
          { userId, hiveAccountName: newName, existing: row?.hiveAccountName },
          'Lite upgrade: refusing to link — this user is already bound to a DIFFERENT Hive account'
        );
        return false;
      }
    }
    await names.promoteToActive(newName, userId).catch(() => undefined);
    // Followers travel with the user id, which never changes, so nothing has to be
    // rewritten for them. This handles the one remaining case: any edge stored against
    // the NAME they just took is folded into their account, so they cannot end up as
    // two people in the follow graph.
    await follows.absorbHiveActor(userId, newName);
    // No earnings settlement: lite accounts hold NO balance (rewards are rejected at
    // publish, decision 2026-07-23), so upgrade only creates the on-chain account.
    await upgradeEvents.markCreated(eventId, trxId);
    return true;
  } catch (error) {
    logger.error(
      { err: error, userId, hiveAccountName: newName, upgradeEventId: eventId },
      'Lite upgrade: the Hive account was CREATED but Lumen could not record the upgrade — the account exists on chain and this user is still marked lite. The attempt stays in flight so the next request retries it.'
    );
    return false;
  }
}

export interface UpgradeStatus {
  /**
   * `created_not_linked` is the state that matters: an account exists on chain for this
   * user but Lumen has not recorded it. Reporting that as 'lite' — which is what the
   * user row still says — walks them into creating a SECOND account.
   */
  state: 'lite' | 'upgraded' | 'created_not_linked' | 'still_settling';
  hiveAccountName: string | null;
}

/**
 * Where this account stands, with any in-flight attempt settled first.
 *
 * Read-only from the user's point of view, but deliberately NOT passive: it runs the
 * same reconciliation the upgrade does, because the state it is reporting on is
 * exactly the one that needs resolving — an account created on chain that Lumen never
 * recorded. Answering "still lite" without checking would invite the caller to create
 * a second account.
 *
 * Takes the per-user lock so it cannot race an upgrade running in another tab.
 */
export async function upgradeStatus(sessionUser: User | undefined): Promise<UpgradeStatus> {
  const userId = sessionUser?.userId;
  if (!userId) return { state: 'lite', hiveAccountName: null };

  // Wrapped in an object: `withAdvisoryLock` returns null when the lock was not
  // granted, which would otherwise be indistinguishable from "the user row is null".
  const settled = await withAdvisoryLock(upgradeLockKey(userId), async () => {
    const outcome = await resumeInFlightUpgrade(userId).catch(() => null);
    return { user: await users.findUserById(userId), outcome };
  });
  // Reconciliation's own answer outranks the user row: the row still says 'lite' in
  // exactly the case where an account already exists for this person.
  const outcome = settled?.outcome;
  if (outcome && outcome.status === 'error') {
    if (outcome.code === 'created_not_linked') {
      return { state: 'created_not_linked', hiveAccountName: outcome.hiveAccountName ?? null };
    }
    if (outcome.code === 'still_settling') {
      return { state: 'still_settling', hiveAccountName: null };
    }
  }
  // Lock not granted (an upgrade is mid-flight in another tab): report the row as it
  // stands rather than blocking. The POST path re-checks under the lock anyway.
  const user = settled ? settled.user : await users.findUserById(userId);
  if (!user) return { state: 'lite', hiveAccountName: null };

  return user.hiveAccountName
    ? { state: 'upgraded', hiveAccountName: user.hiveAccountName }
    : { state: 'lite', hiveAccountName: null };
}

/**
 * Advisory-lock key for one user's upgrade. Namespaced above the publisher drain
 * (971_020_301) and the ACT claim (971_020_302) so the ranges cannot meet. A hash
 * collision between two users merely serialises two unrelated upgrades, which is
 * harmless; what matters is that the SAME user can never run two at once.
 */
function upgradeLockKey(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) % 100_000_000;
  return 972_000_000 + hash;
}

/**
 * One upgrade at a time per user, cluster-wide.
 *
 * Without this, two concurrent requests from one session with two DIFFERENT names both
 * read `account_tier = 'lite'` before either commits, both take their own (per-name)
 * reservation, and both run to completion: two account creation tokens burned, two real
 * Hive accounts created. The per-name lock cannot prevent it — the names differ. A
 * double-click on the upgrade button is enough.
 */
export async function upgradeToFullAccount(
  sessionUser: User | undefined,
  newNameRaw: string,
  publicKeys: unknown
): Promise<UpgradeResult> {
  if (!sessionUser?.userId || sessionUser.account_tier !== 'lite') {
    return { status: 'error', code: 'unauthorized', message: 'Not signed in as a lite account.' };
  }
  const result = await withAdvisoryLock(upgradeLockKey(sessionUser.userId), () =>
    runUpgrade(sessionUser, newNameRaw, publicKeys)
  );
  // null means the lock was not granted — never a real result, since runUpgrade either
  // returns an UpgradeResult or throws.
  return (
    result ?? {
      status: 'error',
      code: 'upgrade_in_progress',
      message: 'An upgrade is already running for this account. Give it a moment and refresh.'
    }
  );
}

async function runUpgrade(
  sessionUser: User,
  newNameRaw: string,
  publicKeysInput: unknown
): Promise<UpgradeResult> {
  const user = await users.findUserById(sessionUser.userId as string);
  if (!user) return { status: 'error', code: 'not_found', message: 'Account not found.' };

  // An account this user may already own outranks everything below — including the
  // "already upgraded" refusal, which is exactly the state they land in when a first
  // attempt succeeded on chain but never got recorded here.
  const resumed = await resumeInFlightUpgrade(user.userId);
  if (resumed) return resumed;

  if (user.accountTier === 'full' || user.hiveAccountName) {
    // Carry the REAL name. Without it the screen tells the user "your account is
    // @<whatever they just typed>" — a name that is not theirs and may be a stranger's.
    return {
      status: 'error',
      code: 'already_upgraded',
      message: 'This account has already been upgraded.',
      hiveAccountName: user.hiveAccountName ?? undefined
    };
  }
  // A suspended or banned account may not upgrade its way out. Upgrading burns one of
  // OUR account creation tokens and hands over a full Hive account with its own keys —
  // an account we can no longer moderate at all. Checked here, before the name lock and
  // long before the ACT, so nothing is spent on a refusal.
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

  const publicKeys = checkPublicKeys(publicKeysInput);
  if (!publicKeys) {
    return {
      status: 'error',
      code: 'invalid_keys',
      message: 'Your browser did not send a usable set of public keys. Reload the page and try again.'
    };
  }

  const newName = newNameRaw.trim().toLowerCase();
  // Refused here, before anything is spent. This is NOT a soft preference: the
  // `hive_name_differs_from_display` CHECK on lumen_user makes the resulting row
  // impossible, and that row is written only AFTER the on-chain account exists — so
  // allowing it burns a real token and strands the user. See names/upgrade-name.ts.
  if (isOwnLiteHandle(newName, user.displayName)) {
    return { status: 'error', code: 'name_must_differ', message: LITE_HANDLE_REUSE_MESSAGE };
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
  const locked = await names.reservePending(newName, NAME_LOCK_TTL_S, user.userId);
  if (!locked) return { status: 'error', code: 'name_taken', message: 'That name is being claimed.' };

  let creationAttempted = false;
  let event: { id: string };
  try {
    // Recorded BEFORE the broadcast, owner key included: this row is the only thing
    // that can later tell an account we created from a name someone else took. Inside
    // the try so that a failure here releases the name rather than leaking the hold.
    event = await upgradeEvents.create(user.userId, newName, publicKeys.owner);
  } catch (error) {
    await names.releasePending(newName, user.userId).catch(() => undefined);
    throw error;
  }
  try {
    // Chain reconciliation: never burn a second ACT if the account already exists.
    if (await creator.accountExists(newName)) {
      await names.releasePending(newName, user.userId);
      await upgradeEvents.fail(event.id, 'name_on_chain');
      return { status: 'error', code: 'name_on_chain', message: 'That name already exists on Hive.' };
    }

    // Only a failure that may have REACHED THE CHAIN counts as ambiguous. Everything
    // `createClaimedAccount` does first — validating the keys, loading the signer,
    // reading and topping up the token pool — throws with nothing broadcast, and
    // treating those as ambiguous strands the name for 300 seconds and leaves an
    // attempt in flight that the next request has to clear before it can proceed.
    const { trxId } = await creator.createClaimedAccount(newName, publicKeys, () => {
      creationAttempted = true;
    });

    // ─── POINT OF NO RETURN: the on-chain account now exists. ───
    // The user already holds its keys — they confirmed saving them before this request
    // was sent — so nothing below can lock them out. Bookkeeping is recorded, never
    // raised.
    const linked = await completeBookkeeping(user.userId, newName, event.id, trxId);
    if (!linked) {
      // The account is real and the user holds its keys; only OUR record is missing.
      // Saying "ok" here is what let a half-written upgrade look complete and invite a
      // second one. The attempt stays in flight, so the next request retries the link.
      return {
        status: 'error',
        code: 'created_not_linked',
        message:
          'Your Hive account was created, but we could not finish linking it to your Lumen profile. Your keys are valid — reload this page in a moment, and contact support if it persists.',
        hiveAccountName: newName
      };
    }
    return { status: 'ok', hiveAccountName: newName };
  } catch (error) {
    // Release the name ONLY when nothing was broadcast. After an ambiguous create,
    // freeing it invites someone else to take the very name we may already own — and
    // reconciliation would then find the name occupied and have to decide with no
    // evidence. The pending hold expires by itself (NAME_LOCK_TTL_S).
    if (!creationAttempted) {
      await names.releasePending(newName, user.userId);
      await upgradeEvents.fail(event.id, error instanceof Error ? error.message : String(error));
    } else {
      // Leave the event in 'creating' on purpose: that is the marker the resume path
      // looks for, and this is exactly the case it exists to settle.
      logger.warn(
        { err: error, userId: user.userId, hiveAccountName: newName, upgradeEventId: event.id },
        'Lite upgrade: create broadcast failed ambiguously — left in flight for reconciliation'
      );
    }
    throw error;
  }
}
