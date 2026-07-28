/**
 * Proves the lite → full Hive account upgrade against a REAL Postgres, with the
 * account creator stubbed (a real `create_claimed_account` permanently spends a token
 * and occupies a name).
 *
 *   cd apps/blog && npx tsx ../../scripts/lite-upgrade-e2e.ts
 *
 * The property under test above all others: **no private key material exists on this
 * side of the wire.** Keys are generated in the browser; only public keys arrive. Half
 * of what follows is therefore about what happens when things go wrong — a create that
 * lands but is never recorded, a name taken by someone else mid-broadcast, a node that
 * cannot be reached — because those are the cases where a design without a server-side
 * key copy has to work differently from one with it.
 *
 * (Replaces lite-key-reveal-e2e.ts, which proved the encrypted server-side key outbox.
 * That outbox and its table were deleted with the custody change on 2026-07-28.)
 */

import { User } from '@smart-signer/types/common';
import { query } from '../apps/blog/lib/lite/db/pool';
import * as users from '../apps/blog/lib/lite/repositories/user-repository';
import {
  AccountCreator,
  AccountPublicKeys,
  setAccountCreator
} from '../apps/blog/lib/lite/upgrade/account-creator';
import {
  checkPublicKeys,
  upgradeStatus,
  upgradeToFullAccount
} from '../apps/blog/lib/lite/upgrade/upgrade-service';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const created: string[] = [];

/** Pretend the in-flight attempt was made long enough ago for the chain to have settled. */
async function ageInFlight(userId: string, seconds = 600): Promise<void> {
  await query(
    `UPDATE upgrade_event SET created_at = now() - make_interval(secs => $2)
      WHERE user_id = $1 AND status = 'creating'`,
    [userId, seconds]
  );
}

async function makeLiteUser(tag: string) {
  const displayName = `upg${tag}${Date.now().toString(36).slice(-6)}`.toLowerCase().slice(0, 16);
  const user = await users.createUser({ displayName });
  created.push(user.userId);
  const session = {
    isLoggedIn: true,
    username: displayName,
    userId: user.userId,
    account_tier: 'lite'
  } as unknown as User;
  return { ...user, displayName, session };
}

/**
 * Public keys shaped exactly like the ones a browser derives. Real base58 characters
 * and real lengths, so the boundary validation is exercised rather than bypassed.
 */
function publicKeys(seed: string): AccountPublicKeys {
  const body = (role: string) =>
    `STM${role}${seed}${'A'.repeat(50)}`.slice(0, 53).replace(/[^1-9A-HJ-NP-Za-km-z]/g, 'x');
  return { owner: body('o'), active: body('a'), posting: body('p'), memo: body('m') };
}

interface StubOptions {
  exists?: boolean | (() => boolean);
  ownerKey?: string | null;
  /** Full owner authority; overrides `ownerKey`. `[]` = exists with no key at all. */
  ownerKeys?: string[];
  existsThrows?: boolean;
  ownerKeyThrows?: boolean;
  /** Omit `accountOwnerKey` entirely — a partial implementation. */
  noOwnerKeyReader?: boolean;
  createThrows?: boolean;
  /** Throw BEFORE the broadcast: nothing reached the chain. */
  failsBeforeBroadcast?: boolean;
}

function stubCreator(options: StubOptions = {}) {
  const calls: { name: string; keys: AccountPublicKeys }[] = [];
  const impl: AccountCreator = {
    async accountExists(name: string) {
      if (options.existsThrows) throw new Error('node unreachable');
      const value = typeof options.exists === 'function' ? options.exists() : options.exists;
      return Boolean(value) || calls.some((c) => c.name === name);
    },
    async accountOwnerKeys() {
      if (options.ownerKeyThrows) throw new Error('node unreachable');
      if (options.ownerKeys) return options.ownerKeys;
      if (options.ownerKey === null || options.ownerKey === undefined) return null;
      return [options.ownerKey];
    },
    async pendingActCount() {
      return 5;
    },
    async claimAct() {
      return { trxId: 'claim' };
    },
    async createClaimedAccount(name: string, keys: AccountPublicKeys, onBroadcast?: () => void) {
      // Mirrors the real creator: everything that can fail offline fails BEFORE the
      // broadcast is announced, so the caller can tell "nothing was sent" from "it may
      // have landed".
      if (options.failsBeforeBroadcast) throw new Error('no account creation token');
      onBroadcast?.();
      if (options.createThrows) throw new Error('broadcast timed out');
      calls.push({ name, keys });
      return { trxId: `trx-${name}` };
    }
  };
  if (options.noOwnerKeyReader) delete (impl as { accountOwnerKeys?: unknown }).accountOwnerKeys;
  return { impl, calls };
}

/** Anything that looks like a Hive private key or master password. */
const SECRET_PATTERN = /\bP?5[HJK][1-9A-HJ-NP-Za-km-z]{45,55}\b/;

async function main(): Promise<void> {
  console.log('Lite upgrade e2e — keys never touch the server\n');

  // ── 1. the happy path ──────────────────────────────────────────────────────
  console.log('1. upgrade with browser-generated public keys');
  const alice = await makeLiteUser('a');
  const aliceName = `${alice.displayName}h`.slice(0, 16);
  const aliceKeys = publicKeys('alice');
  {
    const { impl, calls } = stubCreator();
    setAccountCreator(impl);

    const result = await upgradeToFullAccount(alice.session, aliceName, aliceKeys);
    check('upgrade succeeded', result.status === 'ok', JSON.stringify(result));
    check('exactly one account created', calls.length === 1);
    check(
      'the creator received the keys the browser sent, unchanged',
      JSON.stringify(calls[0]?.keys) === JSON.stringify(aliceKeys)
    );

    // The whole point: nothing secret can come back, because nothing secret exists.
    const serialised = JSON.stringify(result);
    check('the response carries no private key material', !SECRET_PATTERN.test(serialised), serialised);
    check('the response carries no "keys" field at all', !('keys' in (result as object)));

    const row = await users.findUserById(alice.userId);
    check('the account is marked upgraded', row?.accountTier === 'full');
    check('with the new Hive name', row?.hiveAccountName === aliceName);

    const event = await query<{ owner_public_key: string; status: string }>(
      `SELECT owner_public_key, status FROM upgrade_event WHERE user_id = $1`,
      [alice.userId]
    );
    check('the attempt recorded the owner PUBLIC key', event.rows[0]?.owner_public_key === aliceKeys.owner);
    check('and is marked created', event.rows[0]?.status === 'created');
  }

  // ── 2. nothing is stored that could open an account ───────────────────────
  console.log('\n2. the datastore holds no key material');
  {
    const table = await query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'key_reveal') AS exists`
    );
    check('the key_reveal table is gone', table.rows[0]?.exists === false);

    // Every text column on the upgrade trail, scanned for anything key-shaped.
    const dump = await query<{ row: string }>(`SELECT upgrade_event::text AS row FROM upgrade_event`);
    check(
      'no upgrade_event row contains anything key-shaped',
      dump.rows.every((r) => !SECRET_PATTERN.test(r.row))
    );
  }

  // ── 3. what the boundary refuses ──────────────────────────────────────────
  console.log('\n3. malformed key sets are refused before anything is spent');
  {
    const bob = await makeLiteUser('b');
    const name = `${bob.displayName}h`.slice(0, 16);
    const good = publicKeys('bob');
    const { impl, calls } = stubCreator();
    setAccountCreator(impl);

    const cases: [string, unknown][] = [
      ['no keys at all', undefined],
      ['a missing role', { owner: good.owner, active: good.active, posting: good.posting }],
      ['a malformed key', { ...good, memo: 'nope' }],
      ['the same key in two roles', { ...good, posting: good.active }],
      ['a private WIF where a public key belongs', { ...good, owner: '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ' }]
    ];
    for (const [label, keys] of cases) {
      const result = await upgradeToFullAccount(bob.session, name, keys);
      check(
        `refused: ${label}`,
        result.status === 'error' && result.code === 'invalid_keys',
        JSON.stringify(result)
      );
    }
    check('and no account was created by any of them', calls.length === 0);
    check('the user is still lite', (await users.findUserById(bob.userId))?.accountTier === 'lite');
  }

  // ── 4. an account created on chain but never recorded here ────────────────
  console.log('\n4. resume: the create landed, the bookkeeping did not');
  {
    const carol = await makeLiteUser('c');
    const name = `${carol.displayName}h`.slice(0, 16);
    const keys = publicKeys('carol');

    // The create broadcast throws AFTER the chain accepted it — the ambiguous case.
    const failing = stubCreator({ createThrows: true });
    setAccountCreator(failing.impl);
    await upgradeToFullAccount(carol.session, name, keys).catch(() => undefined);

    const inFlight = await query<{ status: string }>(
      `SELECT status FROM upgrade_event WHERE user_id = $1`,
      [carol.userId]
    );
    check('the attempt stays in flight for reconciliation', inFlight.rows[0]?.status === 'creating');
    check('the user is still lite', (await users.findUserById(carol.userId))?.accountTier === 'lite');

    // Now the chain says the account exists, with OUR owner key.
    const settled = stubCreator({ exists: true, ownerKey: keys.owner });
    setAccountCreator(settled.impl);
    const status = await upgradeStatus(carol.session);
    check('status reconciles it to upgraded', status.state === 'upgraded', JSON.stringify(status));
    check('under the right name', status.hiveAccountName === name);
    check('and no second account was created', settled.calls.length === 0);
  }

  // ── 5. the name was taken by somebody else ────────────────────────────────
  console.log('\n5. resume: the name exists but is NOT ours');
  {
    const dave = await makeLiteUser('d');
    const name = `${dave.displayName}h`.slice(0, 16);
    const keys = publicKeys('dave');

    const failing = stubCreator({ createThrows: true });
    setAccountCreator(failing.impl);
    await upgradeToFullAccount(dave.session, name, keys).catch(() => undefined);

    // Exists — with a stranger's owner key. Adopting it would tell this user their
    // saved keys open an account that they do not.
    const other = stubCreator({ exists: true, ownerKey: publicKeys('stranger').owner });
    setAccountCreator(other.impl);
    const status = await upgradeStatus(dave.session);
    check('NOT adopted as ours', status.state === 'lite', JSON.stringify(status));

    const event = await query<{ status: string }>(`SELECT status FROM upgrade_event WHERE user_id = $1`, [
      dave.userId
    ]);
    check('the attempt is marked failed', event.rows[0]?.status === 'failed');

    // And a fresh attempt with a different name still works.
    const fresh = stubCreator();
    setAccountCreator(fresh.impl);
    const second = `${dave.displayName}x`.slice(0, 16);
    const retry = await upgradeToFullAccount(dave.session, second, publicKeys('dave2'));
    check('a fresh attempt succeeds', retry.status === 'ok', JSON.stringify(retry));
    check('creating exactly one account', fresh.calls.length === 1);
  }

  // ── 6. nothing was created at all ─────────────────────────────────────────
  console.log('\n6. resume: the create never landed');
  {
    const erin = await makeLiteUser('e');
    const name = `${erin.displayName}h`.slice(0, 16);

    const failing = stubCreator({ createThrows: true });
    setAccountCreator(failing.impl);
    await upgradeToFullAccount(erin.session, name, publicKeys('erin')).catch(() => undefined);

    // Fresh attempt + "no such account" must NOT be read as failure: the transaction
    // may still be in the mempool. This is the window in which freeing the name would
    // hand it to somebody else while we may already own it.
    const tooSoon = stubCreator({ exists: false });
    setAccountCreator(tooSoon.impl);
    const settling = await upgradeToFullAccount(erin.session, name, publicKeys('erin'));
    check(
      'a fresh absence is treated as "still settling", not as failure',
      settling.status === 'error' && settling.code === 'still_settling',
      JSON.stringify(settling)
    );
    const held = await query(`SELECT 1 FROM name_reservation WHERE display_name_norm = $1`, [name]);
    check('and the name is still held', held.rows.length === 1);

    await ageInFlight(erin.userId);
    const absent = stubCreator({ exists: false });
    setAccountCreator(absent.impl);
    const status = await upgradeStatus(erin.session);
    check('once the window passes, still lite', status.state === 'lite');

    // The name is free again, so the SAME name can be retried.
    const retry = stubCreator();
    setAccountCreator(retry.impl);
    const result = await upgradeToFullAccount(erin.session, name, publicKeys('erin'));
    check('the same name can be retried', result.status === 'ok', JSON.stringify(result));
  }

  // ── 7. a node we cannot reach is not an answer ────────────────────────────
  console.log('\n7. resume: the node is unreachable');
  {
    const frank = await makeLiteUser('f');
    const name = `${frank.displayName}h`.slice(0, 16);

    const failing = stubCreator({ createThrows: true });
    setAccountCreator(failing.impl);
    await upgradeToFullAccount(frank.session, name, publicKeys('frank')).catch(() => undefined);

    const unreachable = stubCreator({ existsThrows: true });
    setAccountCreator(unreachable.impl);
    const result = await upgradeToFullAccount(frank.session, name, publicKeys('frank'));
    check(
      'the upgrade refuses rather than guessing',
      result.status === 'error' && result.code === 'reconcile_unavailable',
      JSON.stringify(result)
    );
    check('no account was created', unreachable.calls.length === 0);
    const event = await query<{ status: string }>(`SELECT status FROM upgrade_event WHERE user_id = $1`, [
      frank.userId
    ]);
    check('the attempt is left in flight', event.rows[0]?.status === 'creating');
  }

  // ── 8. refusals that cost nothing ─────────────────────────────────────────
  console.log('\n8. refusals');
  {
    const { impl, calls } = stubCreator();
    setAccountCreator(impl);

    const already = await upgradeToFullAccount(alice.session, 'someothername', publicKeys('x'));
    check(
      'an already-upgraded account is refused',
      already.status === 'error' && already.code === 'already_upgraded',
      JSON.stringify(already)
    );

    const grace = await makeLiteUser('g');
    const own = await upgradeToFullAccount(grace.session, grace.displayName, publicKeys('g'));
    check(
      'reusing the Lumen handle is refused',
      own.status === 'error' && own.code === 'name_must_differ',
      JSON.stringify(own)
    );

    await users.setUserStatus(grace.userId, 'suspended', 'test');
    const suspended = await upgradeToFullAccount(
      grace.session,
      `${grace.displayName}h`.slice(0, 16),
      publicKeys('g')
    );
    check(
      'a suspended account is refused',
      suspended.status === 'error' && suspended.code === 'account_suspended',
      JSON.stringify(suspended)
    );
    await users.setUserStatus(grace.userId, 'active', null);

    const anon = await upgradeToFullAccount(undefined, 'whoever', publicKeys('x'));
    check('a signed-out caller is refused', anon.status === 'error' && anon.code === 'unauthorized');

    check('none of those created an account', calls.length === 0);
  }

  // ── 9. a double-click cannot create two accounts ──────────────────────────
  console.log('\n9. two upgrades at once');
  {
    const heidi = await makeLiteUser('h');
    const { impl, calls } = stubCreator();
    setAccountCreator(impl);

    const results = await Promise.all([
      upgradeToFullAccount(heidi.session, `${heidi.displayName}h`.slice(0, 16), publicKeys('h1')),
      upgradeToFullAccount(heidi.session, `${heidi.displayName}x`.slice(0, 16), publicKeys('h2'))
    ]);
    check(
      'exactly one account was created',
      calls.length === 1,
      `${calls.length} creations: ${calls.map((c) => c.name).join(', ')}`
    );
    check('one call succeeded', results.filter((r) => r.status === 'ok').length === 1, JSON.stringify(results));
  }

  // ── 10. an unprovable claim is never adopted ──────────────────────────────
  console.log('\n10. reconciliation refuses to guess');
  {
    // (a) the owner-key read throws
    const ivan = await makeLiteUser('i');
    const nameI = `${ivan.displayName}h`.slice(0, 16);
    setAccountCreator(stubCreator({ createThrows: true }).impl);
    await upgradeToFullAccount(ivan.session, nameI, publicKeys('ivan')).catch(() => undefined);

    setAccountCreator(stubCreator({ exists: true, ownerKeyThrows: true }).impl);
    const thrown = await upgradeToFullAccount(ivan.session, nameI, publicKeys('ivan'));
    check(
      'a failed owner-key read refuses instead of adopting',
      thrown.status === 'error' && thrown.code === 'reconcile_unavailable',
      JSON.stringify(thrown)
    );
    check('the user is still lite', (await users.findUserById(ivan.userId))?.accountTier === 'lite');

    // (b) a creator that cannot read owner keys is refused AT WIRING TIME. Accepting it
    // would leave every interrupted upgrade permanently unreconcilable, discovered only
    // when a user is already stuck.
    let wiringRefused = '';
    try {
      setAccountCreator(stubCreator({ exists: true, noOwnerKeyReader: true }).impl);
    } catch (error) {
      wiringRefused = error instanceof Error ? error.message : String(error);
    }
    check(
      'a creator without accountOwnerKeys cannot be installed at all',
      /accountOwnerKeys/.test(wiringRefused),
      wiringRefused || 'it was accepted'
    );

    // (c) an account whose owner authority names no key at all is provably NOT one we
    // created — every account we mint carries our key there — so this is a definite
    // "not ours", which frees the name and lets a fresh attempt run.
    setAccountCreator(stubCreator({ exists: true, ownerKeys: [] }).impl);
    const noKey = await upgradeToFullAccount(ivan.session, nameI, publicKeys('ivan2'));
    // Not adopted, and the honest answer for a name that is taken on chain by somebody
    // else: pick another one. (Contrast with the 'unknown' cases above, which refuse to
    // decide at all.)
    check(
      'an empty owner authority is read as NOT ours',
      noKey.status === 'error' && noKey.code === 'name_on_chain',
      JSON.stringify(noKey)
    );
    check('the user is still lite', (await users.findUserById(ivan.userId))?.accountTier === 'lite');
  }

  // ── 11. a failure BEFORE the broadcast frees the name immediately ──────────
  console.log('\n11. an offline failure is not ambiguous');
  {
    const judy = await makeLiteUser('j');
    const nameJ = `${judy.displayName}h`.slice(0, 16);
    const stub = stubCreator({ failsBeforeBroadcast: true });
    setAccountCreator(stub.impl);
    await upgradeToFullAccount(judy.session, nameJ, publicKeys('judy')).catch(() => undefined);

    const held = await query(`SELECT 1 FROM name_reservation WHERE display_name_norm = $1`, [nameJ]);
    check('the name is released at once', held.rows.length === 0);
    const event = await query<{ status: string }>(
      `SELECT status FROM upgrade_event WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [judy.userId]
    );
    check('the attempt is marked failed, not left in flight', event.rows[0]?.status === 'failed');

    // So the next attempt runs clean, with no reconciliation to clear first.
    const retry = stubCreator();
    setAccountCreator(retry.impl);
    const ok = await upgradeToFullAccount(judy.session, nameJ, publicKeys('judy'));
    check('and the retry succeeds immediately', ok.status === 'ok', JSON.stringify(ok));
  }

  // ── 12. a half-written upgrade never reports success ──────────────────────
  console.log('\n12. bookkeeping that fails is not "ok"');
  {
    const ken = await makeLiteUser('k');
    const nameK = `${ken.displayName}h`.slice(0, 16);
    const stub = stubCreator();
    // Break the link the way a transient database failure would: the rename happens
    // AFTER every up-front check, at the moment the account is created, so
    // `markUpgraded` runs into the `hive_name_differs_from_display` constraint. What
    // matters is that a write fails between "the account exists" and "Lumen knows".
    const broken: AccountCreator = {
      ...stub.impl,
      async createClaimedAccount(name, keys, onBroadcast) {
        await query(`UPDATE lumen_user SET display_name = $2 WHERE user_id = $1`, [ken.userId, nameK]);
        return stub.impl.createClaimedAccount(name, keys, onBroadcast);
      }
    };
    setAccountCreator(broken);

    const result = await upgradeToFullAccount(ken.session, nameK, publicKeys('ken'));
    check(
      'the user is told the account exists but is not linked',
      result.status === 'error' && result.code === 'created_not_linked',
      JSON.stringify(result)
    );
    check('the account name is reported', 'hiveAccountName' in result);
    const event = await query<{ status: string }>(
      `SELECT status FROM upgrade_event WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ken.userId]
    );
    check('the attempt stays in flight so the link can be retried', event.rows[0]?.status === 'creating');

    // ★ THE POINT OF THE ORDERING. Un-break the condition that made the link fail, then
    // reconcile: the account is adopted and linked with no second creation. Asserting
    // this is what turns "the marker is cleared last so the next request retries it"
    // from a comment into a fact.
    await query(`UPDATE lumen_user SET display_name = $2 WHERE user_id = $1`, [
      ken.userId,
      `${nameK}zz`.slice(0, 16)
    ]);
    const healer = stubCreator({ exists: true, ownerKey: publicKeys('ken').owner });
    setAccountCreator(healer.impl);
    const status = await upgradeStatus(ken.session);
    check('a later request completes the link by itself', status.state === 'upgraded', JSON.stringify(status));
    check('under the right name', status.hiveAccountName === nameK);
    check('and no second account was created', healer.calls.length === 0);
    const healed = await query<{ status: string }>(
      `SELECT status FROM upgrade_event WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ken.userId]
    );
    check('the attempt is finally marked created', healed.rows[0]?.status === 'created');
  }

  // ── 12b. only the LAST step failing (the ordering this fix is about) ───────
  console.log('\n12b. the marker write itself fails');
  {
    const liam = await makeLiteUser('m');
    const nameL = `${liam.displayName}h`.slice(0, 16);
    const stub = stubCreator();
    setAccountCreator(stub.impl);

    // Break ONLY the final write, and do it the way a real database failure would: the
    // transaction id is written by `markCreated` and by nothing before it, so a value
    // Postgres refuses (a NUL byte is not valid in `text`) fails exactly that statement
    // and leaves every earlier write committed.
    const poison = stubCreator();
    setAccountCreator({
      ...poison.impl,
      async createClaimedAccount(name, keys, onBroadcast) {
        await poison.impl.createClaimedAccount(name, keys, onBroadcast);
        return { trxId: 'trx\u0000broken' };
      }
    });
    const result = await upgradeToFullAccount(liam.session, nameL, publicKeys('liam'));
    check(
      'a failure on the final write is not reported as success',
      result?.status === 'error' && result.code === 'created_not_linked',
      JSON.stringify(result)
    );
    // The user row WAS written (it is earlier in the sequence), and the event is still
    // in flight — so the next request finishes the job rather than creating again.
    const linked = await users.findUserById(liam.userId);
    check('the user is already linked', linked?.hiveAccountName === nameL);
    const healer2 = stubCreator({ exists: true, ownerKey: publicKeys('liam').owner });
    setAccountCreator(healer2.impl);
    const status2 = await upgradeStatus(liam.session);
    check('and a later request settles it', status2.state === 'upgraded', JSON.stringify(status2));
    check('with no second account', healer2.calls.length === 0);
  }

  // ── 13. one attempt in flight per user ────────────────────────────────────
  console.log('\n13. superseded attempts cannot pile up');
  {
    const lena = await makeLiteUser('l');
    setAccountCreator(stubCreator({ failsBeforeBroadcast: true }).impl);
    for (const suffix of ['a', 'b', 'c']) {
      await upgradeToFullAccount(
        lena.session,
        `${lena.displayName.slice(0, 14)}${suffix}`,
        publicKeys(`lena${suffix}`)
      ).catch(() => undefined);
    }
    const inFlight = await query<{ c: string }>(
      `SELECT count(*)::text AS c FROM upgrade_event WHERE user_id = $1 AND status = 'creating'`,
      [lena.userId]
    );
    check('at most one attempt is ever in flight', Number(inFlight.rows[0]?.c ?? 0) <= 1);
  }

  // ── 14. one user's cleanup cannot delete another's name hold ──────────────
  console.log('\n14. name holds are owned');
  {
    const names = await import('../apps/blog/lib/lite/repositories/name-reservation-repository');
    const mia = await makeLiteUser('o');
    const contested = `hold${Date.now().toString(36).slice(-6)}`;

    // A signup takes an unowned hold on the name.
    check('a signup can take the hold', await names.reservePending(contested, 300));
    // An upgrade's cleanup for the same name must not delete it.
    await names.releasePending(contested, mia.userId);
    const stillHeld = await query(`SELECT 1 FROM name_reservation WHERE display_name_norm = $1`, [
      contested
    ]);
    check("an upgrade's release leaves a signup hold alone", stillHeld.rows.length === 1);

    // And the signup's own release does remove it.
    await names.releasePending(contested);
    const gone = await query(`SELECT 1 FROM name_reservation WHERE display_name_norm = $1`, [contested]);
    check('the owner can release it', gone.rows.length === 0);

    // The mirror case: an upgrade's owned hold survives a signup's cleanup.
    check('an upgrade can take an owned hold', await names.reservePending(contested, 300, mia.userId));
    await names.releasePending(contested);
    const survived = await query(`SELECT 1 FROM name_reservation WHERE display_name_norm = $1`, [
      contested
    ]);
    check("a signup's release leaves an owned hold alone", survived.rows.length === 1);
    await names.releasePending(contested, mia.userId);
  }

  // ── 15. both key validators agree on every input ──────────────────────────
  console.log('\n15. the two key validators cannot disagree');
  {
    const { hiveAccountCreator } = await import(
      '../apps/blog/lib/lite/upgrade/hive-account-creator'
    );
    const good = publicKeys('agree');
    // The case that motivated the fix: same key BODY, different network prefix. One
    // validator compared raw strings and the other compared bodies, so this passed the
    // boundary and then threw deep inside the creator — where the failure is
    // indistinguishable from a broadcast that may have landed.
    const sameBodyDifferentPrefix = { ...good, active: `TST${good.active.slice(3)}` };
    const cases: Record<string, unknown> = {
      'same body, different prefix': sameBodyDifferentPrefix,
      'a duplicated key': { ...good, posting: good.active },
      'a malformed key': { ...good, memo: 'nope' },
      'well-formed and distinct': good
    };
    for (const [label, keys] of Object.entries(cases)) {
      let creatorRefused = false;
      try {
        await hiveAccountCreator.createClaimedAccount('lumentest1', keys as never);
      } catch (error) {
        creatorRefused = /malformed|must be distinct/.test(
          error instanceof Error ? error.message : ''
        );
      }
      const boundaryRefused = checkPublicKeys(keys) === null;
      check(`both validators agree on: ${label}`, boundaryRefused === creatorRefused, `boundary=${boundaryRefused} creator=${creatorRefused}`);
    }
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  for (const userId of created) {
    await query('DELETE FROM lumen_user WHERE user_id = $1', [userId]).catch(() => undefined);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
