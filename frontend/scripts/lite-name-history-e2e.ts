/**
 * Proves the upgrade name picker and — the part that actually matters — that a
 * user's Lumen history follows them to their new Hive name.
 *
 *   cd apps/blog && npx tsx ../../scripts/lite-name-history-e2e.ts
 *
 * Runs against a REAL Postgres. The AccountCreator is stubbed (creating an account
 * spends a real token) and the Hive lookup is stubbed at `fetch`, so the suggestion
 * rules can be tested against a chain state we control instead of whatever names
 * happen to be free on mainnet today.
 */

import { randomBytes } from 'crypto';
import { query } from '../apps/blog/lib/lite/db/pool';
import * as users from '../apps/blog/lib/lite/repositories/user-repository';
import * as posts from '../apps/blog/lib/lite/repositories/post-repository';
import { AccountCreator, AccountPublicKeys, setAccountCreator } from '../apps/blog/lib/lite/upgrade/account-creator';
import { upgradeToFullAccount } from '../apps/blog/lib/lite/upgrade/upgrade-service';
import { deriveCandidates, suggestNames } from '../apps/blog/lib/lite/names/suggest';
import { publicNameOf, resolvePublicName, resolvePublicNames } from '../apps/blog/lib/lite/render/current-name';
import { vetNameFormat } from '../apps/blog/lib/lite/names/vetting';

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

/**
 * Stand-in for what a browser derives. Public keys only — the server side of this
 * flow has no access to private key material at all (2026-07-28 custody change), so
 * a test fixture should not pretend otherwise.
 */
const PUBLIC_KEYS: AccountPublicKeys = {
  owner: `STMowner${'A'.repeat(45)}`,
  active: `STMactive${'B'.repeat(44)}`,
  posting: `STMposting${'C'.repeat(43)}`,
  memo: `STMmemo${'D'.repeat(46)}`
};

const stubCreator: AccountCreator = {
  async accountExists() {
    return false;
  },
  async pendingActCount() {
    return 5;
  },
  async claimAct() {
    return { trxId: 'act' };
  },
  async createClaimedAccount(name: string) {
    return { trxId: `create-${name}` };
  }
};

/** Pretend these names exist on Hive; everything else is free. */
function stubChain(taken: string[]): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { params?: { accounts?: string[] } };
    const asked = body.params?.accounts ?? [];
    const accounts = asked.filter((n) => taken.includes(n)).map((name) => ({ name }));
    return { ok: true, json: async () => ({ result: { accounts } }) };
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function makeLiteUser(tag: string) {
  const displayName = `nh${tag}${Date.now().toString(36).slice(-6)}`;
  const user = await users.createUser({ displayName });
  return {
    userId: user.userId,
    displayName: user.displayName,
    session: {
      userId: user.userId,
      account_tier: 'lite' as const,
      isLoggedIn: true,
      username: user.displayName
    }
  };
}

async function makePost(userId: string, displayName: string) {
  return posts.createPost({
    userId,
    displayNameSnapshot: displayName,
    parentRef: null,
    tier: 'normal',
    title: 'hello',
    body: 'body',
    tags: ['lumen'],
    community: null,
    beneficiaries: [],
    thumbnailUrl: null,
    summary: null,
    publishMode: 'immediate'
  });
}

async function main(): Promise<void> {
  const created: string[] = [];

  /* ─────────────────────── 1. suggestion rules (pure) ─────────────────────── */
  console.log('\n1. derived names are usable');
  {
    const list = deriveCandidates('alice');
    check('produces alternatives', list.length >= 5, `got ${list.length}`);
    check('never suggests the name itself', !list.includes('alice'));
    check('no duplicates', new Set(list).size === list.length);
    check('every suggestion passes the server’s own vetting', list.every((n) => vetNameFormat(n).ok));
    // vetNameFormat rejects "lumen" anywhere as impersonation, so a suggestion
    // containing it would be handed to the user and then refused on submit.
    check('never suggests a name containing "lumen"', !list.some((n) => n.includes('lumen')));

    const long = deriveCandidates('abcdefghijklmnop'); // already 16 chars
    check('respects the 16-character limit', long.every((n) => n.length <= 16), long.join(','));
    check('long names still get alternatives', long.length > 0);
    check('empty input yields nothing', deriveCandidates('').length === 0);
  }

  console.log('\n2. availability + alternatives in one call');
  {
    let restore = stubChain([]);
    let result = await suggestNames('alice');
    restore();
    check('a free name reports available', result.baseAvailable);
    check('no alternatives offered when the name is free', result.suggestions.length === 0);

    restore = stubChain(['alice', 'alice1', 'alice2']);
    result = await suggestNames('alice');
    restore();
    check('a taken name reports unavailable', !result.baseAvailable);
    check('gives a reason', typeof result.baseReason === 'string' && result.baseReason.length > 0);
    check('offers alternatives', result.suggestions.length > 0);
    check(
      'never offers a name that is also taken',
      !result.suggestions.some((n) => ['alice', 'alice1', 'alice2'].includes(n)),
      result.suggestions.join(',')
    );

    // Fail CLOSED: telling a user a name is free when we could not ask sends them
    // into a creation attempt that fails.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('node down');
    }) as unknown as typeof globalThis.fetch;
    const offline = await suggestNames('alice');
    globalThis.fetch = realFetch;
    check('an unreachable node does NOT report available', !offline.baseAvailable);
    check('an unreachable node offers no alternatives', offline.suggestions.length === 0);

    restore = stubChain([]);
    const reserved = await suggestNames('lumen');
    restore();
    check('a reserved name is refused before any chain call', !reserved.baseAvailable);
  }

  console.log('\n2b. suggestions respect Lumen’s own namespace, not just Hive');
  {
    // A name can be free on chain and still belong to a Lumen user. Offering it would
    // mean the picker says yes and the upgrade then says "that name is in use".
    const base = `sg${Date.now().toString(36).slice(-6)}`;
    const squatter = await users.createUser({ displayName: `${base}1` });
    created.push(squatter.userId);

    const restore = stubChain([base]); // only the base is taken on Hive
    const result = await suggestNames(base);
    restore();

    check('the base is reported taken', !result.baseAvailable);
    check(
      'a derivative already held by a Lumen user is NOT offered',
      !result.suggestions.includes(`${base}1`),
      result.suggestions.join(',')
    );
    check('other derivatives are still offered', result.suggestions.length > 0);
  }

  /* ──────────────── 3. history follows the user to the new name ──────────── */
  console.log('\n3. the whole history moves to the new Hive name');
  {
    const u = await makeLiteUser('h');
    created.push(u.userId);
    const post = await makePost(u.userId, u.displayName);

    check('before upgrade, the post shows the Lumen handle', (await resolvePublicName(post)) === u.displayName);

    setAccountCreator(stubCreator);
    const newName = `${u.displayName}1`.slice(0, 16);
    const result = await upgradeToFullAccount(u.session as never, newName, PUBLIC_KEYS);
    check('upgrade succeeded', result.status === 'ok', JSON.stringify(result));

    // The row is untouched — the snapshot is what was BROADCAST and can never change.
    const stored = await posts.getPostById(post.postId);
    check('the post row still holds the original snapshot', stored?.displayNameSnapshot === u.displayName);

    // ...but what a reader sees is the new name.
    check(
      'after upgrade, the SAME old post shows the new Hive name',
      (await resolvePublicName(post)) === newName,
      await resolvePublicName(post)
    );

    const batch = await resolvePublicNames([post]);
    check('the feed path agrees with the single-post path', batch.get(post.postId) === newName);

    // Explicit, because the check above would also pass if the name resolved by
    // accident. The upgrade must actually be RECORDED — a returned 'ok' does not
    // prove it (the service returns ok even when post-create bookkeeping throws).
    const upgraded = await users.findUserById(u.userId);
    check(
      'the upgrade is recorded in the database, not just returned',
      upgraded?.accountTier === 'full' && upgraded?.hiveAccountName === newName,
      `tier=${upgraded?.accountTier} hive=${upgraded?.hiveAccountName}`
    );
  }

  console.log('\n4. name resolution order');
  {
    const post = { postId: 'p', userId: 'u', displayNameSnapshot: 'snapshot' } as never;
    check(
      'an upgraded user resolves to their Hive name',
      publicNameOf(post, { hiveAccountName: 'onchain', displayName: 'lumenhandle' } as never) === 'onchain'
    );
    check(
      'a lite user resolves to their current handle, not the snapshot',
      publicNameOf(post, { hiveAccountName: null, displayName: 'lumenhandle' } as never) === 'lumenhandle'
    );
    check('a missing user falls back to the snapshot', publicNameOf(post, null) === 'snapshot');
  }

  /* ───────────────────────── 5. who may take a name ──────────────────────── */
  console.log('\n5. name rules on upgrade');
  {
    // THE REGRESSION THIS BLOCK EXISTS FOR. `lumen_user` has a CHECK constraint
    // (hive_name_differs_from_display, migration 0001) that makes hive_account_name ==
    // display_name unrepresentable — and that row is written AFTER the on-chain
    // account exists. Allowing the reuse therefore spent a real, non-refundable
    // token, created a permanent account, and then silently failed to record it:
    // proven by running it, 2026-07-28. Asserting only on the return status is not
    // enough, because the service deliberately returns 'ok' (the user must still get
    // their keys) even when the bookkeeping throws. So assert that NOTHING was
    // created at all.
    const u = await makeLiteUser('k');
    created.push(u.userId);
    let createCalls = 0;
    setAccountCreator({
      ...stubCreator,
      async createClaimedAccount(name: string) {
        createCalls++;
        return { trxId: `create-${name}` };
      }
    });

    const same = await upgradeToFullAccount(u.session as never, u.displayName, PUBLIC_KEYS);
    check(
      'reusing your own Lumen handle is refused',
      same.status === 'error' && same.code === 'name_must_differ',
      JSON.stringify(same)
    );
    check('...and NO on-chain account was created', createCalls === 0, `createClaimedAccount ran ${createCalls}x`);
    check(
      '...and the refusal happens for the uppercase form too',
      (await upgradeToFullAccount(u.session as never, u.displayName.toUpperCase(), PUBLIC_KEYS)).status === 'error'
    );
    check('...still no account created', createCalls === 0);

    const after = await users.findUserById(u.userId);
    check('...and the user is untouched', after?.accountTier === 'lite' && after?.hiveAccountName === null);
  }
  {
    // Somebody else's handle is still refused.
    const owner = await makeLiteUser('o');
    const other = await makeLiteUser('t');
    created.push(owner.userId, other.userId);
    setAccountCreator(stubCreator);
    const stolen = await upgradeToFullAccount(other.session as never, owner.displayName, PUBLIC_KEYS);
    check(
      'another user’s Lumen name is refused',
      stolen.status === 'error' && stolen.code === 'name_taken',
      JSON.stringify(stolen)
    );
  }

  /* ─────────── 6. one upgrade at a time, and only OUR account counts ────────── */
  console.log('\n6. concurrency and reconciliation');
  {
    // Two upgrades at once with DIFFERENT names both used to pass the "already
    // upgraded?" check (read before either committed) and both used to take their own
    // per-name lock — so both created a real account and burned a real token. Only one
    // could then be recorded; the other became an on-chain account Lumen has no record
    // of, with our creator account as its permanent recovery agent.
    const u = await makeLiteUser('c');
    created.push(u.userId);
    let createCalls = 0;
    setAccountCreator({
      ...stubCreator,
      async createClaimedAccount(name: string) {
        createCalls++;
        await new Promise((r) => setTimeout(r, 120)); // widen the window
        return { trxId: `create-${name}` };
      }
    });

    const base = u.displayName.slice(0, 14);
    const results = await Promise.all([
      upgradeToFullAccount(u.session as never, `${base}1`, PUBLIC_KEYS).catch((e) => ({ status: 'threw', code: String(e) })),
      upgradeToFullAccount(u.session as never, `${base}2`, PUBLIC_KEYS).catch((e) => ({ status: 'threw', code: String(e) }))
    ]);
    check(
      'two simultaneous upgrades create exactly ONE account',
      createCalls === 1,
      `createClaimedAccount ran ${createCalls}x`
    );
    check(
      'exactly one of them succeeded',
      results.filter((r) => r.status === 'ok').length === 1,
      JSON.stringify(results.map((r) => r.status + ':' + ((r as { code?: string }).code ?? '')))
    );
  }
  // (The ambiguous-create and "the name is not ours" cases moved to
  // scripts/lite-upgrade-e2e.ts when server-side key custody was removed: there is no
  // reveal to hand over any more, so reconciliation is proven there against the public
  // owner key instead of here.)

  for (const userId of created) {
    await query('DELETE FROM key_reveal WHERE user_id = $1', [userId]).catch(() => undefined);
    await query('DELETE FROM upgrade_event WHERE user_id = $1', [userId]).catch(() => undefined);
    await query('DELETE FROM publish_job WHERE post_id IN (SELECT post_id FROM lumen_post WHERE user_id = $1)', [
      userId
    ]).catch(() => undefined);
    await query('DELETE FROM lumen_post WHERE user_id = $1', [userId]).catch(() => undefined);
    await query('DELETE FROM name_reservation WHERE user_id = $1', [userId]).catch(() => undefined);
    await query('DELETE FROM lumen_user WHERE user_id = $1', [userId]).catch(() => undefined);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
