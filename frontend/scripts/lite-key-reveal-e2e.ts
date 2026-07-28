/**
 * Proves the reveal-once outbox (migration 0015) against a REAL Postgres.
 *
 *   cd apps/blog && npx tsx ../../scripts/lite-key-reveal-e2e.ts
 *
 * The AccountCreator is stubbed because the real one burns an account-creation token
 * and writes to Hive; everything below it — encryption, the DB rows, the ordering
 * guarantees, the recovery path — is the real code against the real database. The
 * whole point of this table is what happens when things fail, so most of these cases
 * are failures.
 */

import { randomBytes } from 'crypto';
import { query } from '../apps/blog/lib/lite/db/pool';
import * as users from '../apps/blog/lib/lite/repositories/user-repository';
import { AccountCreator, GeneratedKeys, setAccountCreator } from '../apps/blog/lib/lite/upgrade/account-creator';
import {
  acknowledgeReveal,
  fetchOutstandingReveal,
  upgradeToFullAccount
} from '../apps/blog/lib/lite/upgrade/upgrade-service';

const REVEAL_KEY = randomBytes(32).toString('base64');
process.env.LITE_KEY_REVEAL_ENCRYPTION_KEY = REVEAL_KEY;

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

function keysFor(name: string): GeneratedKeys {
  const wif = (role: string) => `5${role}${name}${'K'.repeat(40)}`.slice(0, 51);
  return {
    masterPassword: `P5${name}${'M'.repeat(40)}`.slice(0, 52),
    owner: { publicKey: `STM-owner-${name}`, privateWif: wif('o') },
    active: { publicKey: `STM-active-${name}`, privateWif: wif('a') },
    posting: { publicKey: `STM-posting-${name}`, privateWif: wif('p') },
    memo: { publicKey: `STM-memo-${name}`, privateWif: wif('m') }
  };
}

/** Records what it was asked to do, so tests can assert the account was NEVER created. */
function stubCreator(opts: {
  exists?: boolean;
  failGenerate?: boolean;
  failCreate?: boolean;
}): AccountCreator & { createCalls: number; generateCalls: number } {
  const state = { createCalls: 0, generateCalls: 0 };
  const impl: AccountCreator = {
    async accountExists() {
      return Boolean(opts.exists);
    },
    async pendingActCount() {
      return 5;
    },
    async claimAct() {
      return { trxId: 'act-trx' };
    },
    async generateKeys(name: string) {
      state.generateCalls++;
      if (opts.failGenerate) throw new Error('keygen exploded');
      return keysFor(name);
    },
    async createClaimedAccount(name: string) {
      state.createCalls++;
      if (opts.failCreate) throw new Error('broadcast timed out');
      return { trxId: `create-${name}` };
    }
  };
  return Object.assign(impl, state, {
    get createCalls() {
      return state.createCalls;
    },
    get generateCalls() {
      return state.generateCalls;
    }
  });
}

async function makeLiteUser(tag: string) {
  // Must stay well under Hive's 16-char limit: the tests derive the upgrade name by
  // appending a character, and a 16-char handle would slice back to itself and trip
  // the "pick a different name" rule instead of testing anything.
  const displayName = `rv${tag}${Date.now().toString(36).slice(-6)}`;
  const user = await users.createUser({ displayName });
  return {
    userId: user.userId,
    displayName: user.displayName,
    session: { userId: user.userId, account_tier: 'lite' as const, isLoggedIn: true, username: user.displayName }
  };
}

async function revealRow(userId: string) {
  const { rows } = await query<{
    reveal_id: string;
    status: string;
    ciphertext: Buffer | null;
    fetch_count: number;
    hive_account_name: string;
  }>(
    `SELECT reveal_id, status, ciphertext, fetch_count, hive_account_name
       FROM key_reveal WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

async function main(): Promise<void> {
  const created: string[] = [];

  // ── 1. Happy path: keys reach the caller AND are durably stored, encrypted. ──
  console.log('\n1. upgrade stores keys encrypted and returns them');
  {
    const u = await makeLiteUser('a');
    created.push(u.userId);
    const creator = stubCreator({});
    setAccountCreator(creator);

    const result = await upgradeToFullAccount(u.session as never, `${u.displayName}x`.slice(0, 16));
    check('upgrade succeeded', result.status === 'ok', JSON.stringify(result));
    if (result.status !== 'ok') return;

    // THE BUG THIS SUITE EXISTS FOR: the panel used to read `privateKey` and render
    // "undefined" for every key. Assert the field the server actually sends.
    check('owner key is a real WIF, not undefined', typeof result.keys.owner.privateWif === 'string' && result.keys.owner.privateWif.length > 10);
    check('master password present', result.keys.masterPassword.startsWith('P'));
    check('revealId returned', typeof result.revealId === 'string' && result.revealId.length > 0);

    const row = await revealRow(u.userId);
    check('reveal row exists', !!row);
    check('reveal marked available', row?.status === 'available', row?.status);
    check('ciphertext stored', !!row?.ciphertext && row.ciphertext.length > 28);
    check(
      'ciphertext is not plaintext',
      !!row?.ciphertext && !row.ciphertext.toString('utf8').includes(result.keys.owner.privateWif)
    );
  }

  // ── 2. The lost response: the user gets their keys back. ────────────────────
  console.log('\n2. a lost response is recoverable');
  {
    const u = await makeLiteUser('b');
    created.push(u.userId);
    setAccountCreator(stubCreator({}));
    const first = await upgradeToFullAccount(u.session as never, `${u.displayName}y`.slice(0, 16));
    if (first.status !== 'ok') return check('setup upgrade', false, JSON.stringify(first));

    // Pretend the response never arrived — the user reloads the page.
    const again = await fetchOutstandingReveal(u.session as never);
    check('reveal re-fetched', again.status === 'ok', JSON.stringify(again));
    if (again.status !== 'ok') return;
    check('same owner key returned', again.keys.owner.privateWif === first.keys.owner.privateWif);
    check('same master password', again.keys.masterPassword === first.keys.masterPassword);
    check('flagged as resumed', again.resumed === true);

    // And re-POSTing /upgrade must hand the keys over, not refuse with already_upgraded.
    const retry = await upgradeToFullAccount(u.session as never, 'somethingelse');
    check('re-POST returns keys, not already_upgraded', retry.status === 'ok' && retry.resumed === true, JSON.stringify(retry));

    const row = await revealRow(u.userId);
    check('fetches are counted for audit', (row?.fetch_count ?? 0) >= 2, String(row?.fetch_count));
  }

  // ── 3. Acknowledgement erases the stored copy. ──────────────────────────────
  console.log('\n3. acknowledging wipes the ciphertext');
  {
    const u = await makeLiteUser('c');
    created.push(u.userId);
    setAccountCreator(stubCreator({}));
    const first = await upgradeToFullAccount(u.session as never, `${u.displayName}z`.slice(0, 16));
    if (first.status !== 'ok') return check('setup upgrade', false, JSON.stringify(first));

    const other = await makeLiteUser('c2');
    created.push(other.userId);
    const stolen = await acknowledgeReveal(other.session as never, first.revealId);
    check('another user cannot acknowledge it', stolen.status === 'error', JSON.stringify(stolen));

    const rowBefore = await revealRow(u.userId);
    check('ciphertext still present after the failed ack', !!rowBefore?.ciphertext);

    const ack = await acknowledgeReveal(u.session as never, first.revealId);
    check('owner acknowledged', ack.status === 'ok', JSON.stringify(ack));

    const row = await revealRow(u.userId);
    check('ciphertext erased', row?.ciphertext === null);
    check('status acknowledged', row?.status === 'acknowledged', row?.status);

    const after = await fetchOutstandingReveal(u.session as never);
    check('nothing left to reveal', after.status === 'error' && after.code === 'no_reveal', JSON.stringify(after));
    const twice = await acknowledgeReveal(u.session as never, first.revealId);
    check('acknowledging twice is refused, not a crash', twice.status === 'error');
  }

  // ── 4. Ambiguous broadcast failure: keys are KEPT, then reconciled. ─────────
  console.log('\n4. an ambiguous create failure keeps the keys');
  {
    const u = await makeLiteUser('d');
    created.push(u.userId);
    setAccountCreator(stubCreator({ failCreate: true }));
    const name = `${u.displayName}q`.slice(0, 16);
    let threw = false;
    try {
      await upgradeToFullAccount(u.session as never, name);
    } catch {
      threw = true;
    }
    check('upgrade surfaced the failure', threw);

    const row = await revealRow(u.userId);
    check('reveal kept as uncertain', row?.status === 'uncertain', row?.status);
    check('ciphertext retained — the broadcast may have landed', !!row?.ciphertext);

    // Reconcile against a chain that says the account DOES exist: hand the keys over.
    setAccountCreator(stubCreator({ exists: true }));
    const rescued = await fetchOutstandingReveal(u.session as never);
    check('keys handed over when the account exists on chain', rescued.status === 'ok', JSON.stringify(rescued));
    check('reveal promoted to available', (await revealRow(u.userId))?.status === 'available');
  }

  console.log('\n5. a create that definitively did not happen discards the keys');
  {
    const u = await makeLiteUser('e');
    created.push(u.userId);
    setAccountCreator(stubCreator({ failCreate: true }));
    try {
      await upgradeToFullAccount(u.session as never, `${u.displayName}w`.slice(0, 16));
    } catch {
      /* expected */
    }
    // Chain says the account does not exist, so the keys are meaningless.
    setAccountCreator(stubCreator({ exists: false }));
    const result = await fetchOutstandingReveal(u.session as never);
    check('no keys handed over', result.status === 'error' && result.code === 'no_reveal', JSON.stringify(result));
    const row = await revealRow(u.userId);
    check('ciphertext discarded', row?.ciphertext === null);
  }

  // ── 6. Refuse to create an account we could not durably record. ─────────────
  console.log('\n6. a missing encryption key refuses BEFORE creating anything');
  {
    const u = await makeLiteUser('f');
    created.push(u.userId);
    const creator = stubCreator({});
    setAccountCreator(creator);
    delete process.env.LITE_KEY_REVEAL_ENCRYPTION_KEY;
    const result = await upgradeToFullAccount(u.session as never, `${u.displayName}r`.slice(0, 16));
    process.env.LITE_KEY_REVEAL_ENCRYPTION_KEY = REVEAL_KEY;

    check('refused as unavailable', result.status === 'error' && result.code === 'unavailable', JSON.stringify(result));
    check('no account was created', creator.createCalls === 0, `createCalls=${creator.createCalls}`);
    check('no reveal row written', (await revealRow(u.userId)) === null);
  }

  // ── 7. A pre-creation failure strands nothing. ──────────────────────────────
  console.log('\n7. a keygen failure leaves no account and no stored keys');
  {
    const u = await makeLiteUser('g');
    created.push(u.userId);
    const creator = stubCreator({ failGenerate: true });
    setAccountCreator(creator);
    try {
      await upgradeToFullAccount(u.session as never, `${u.displayName}t`.slice(0, 16));
    } catch {
      /* expected */
    }
    check('no account was created', creator.createCalls === 0);
    check('no reveal row written', (await revealRow(u.userId)) === null);
  }

  // ── cleanup: CASCADE removes key_reveal + upgrade_event rows. ───────────────
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
