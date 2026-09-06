/**
 * UNIT TESTS for the 2026-09-07 dupe-call fix: `app/api/account/route.ts` and
 * `app/api/manabar/route.ts` each independently called
 * `database_api.find_accounts` for the SAME user, milliseconds apart
 * (`use-logged-user.tsx` fires both queries in the same post-hydration
 * burst). `getManabars`/`getManabar` (`packages/transaction/lib/hive-api.ts`)
 * now take the already-fetched `FullAccount` (as a `Promise`, so a rejection
 * is still caught by `getManabars`'s own `catch`) instead of calling
 * `find_accounts` a second time. `voting_manabar`/`downvote_manabar` were
 * already on `FullAccount`; `post_voting_power` was added for this fix
 * (`packages/common-hiveio-packages/src/wax/app-types.ts`).
 *
 * This file proves two things:
 *   1. `getAccounts` (the function behind the shared answer) carries
 *      `post_voting_power`/`voting_manabar`/`downvote_manabar` through
 *      UNCHANGED from what `find_accounts` returned — the fields the mana
 *      math needs really are already on the account record.
 *   2. `getManabars`, given that shared account, computes manabars by feeding
 *      those SAME fields into the same wax math calls as before, and never
 *      calls `find_accounts` itself.
 *
 * ★ WHY `@hiveio/wax` IS MONKEY-PATCHED, NOT MOCKED VIA A TEST FRAMEWORK, and
 * why `./chain` is too. Same reasoning as
 * `lib/__tests__/hive-chain-service-rebuild.test.ts`: `@hiveio/wax`'s
 * package.json is ESM-only (`"exports"` with only an `"import"` condition),
 * so a plain `require('@hiveio/wax')` from this project's commonjs
 * `test:unit` harness throws `ERR_PACKAGE_PATH_NOT_EXPORTED` before any code
 * of ours runs. `./chain` (`packages/transaction/lib/chain.ts`) is ALSO
 * patched, by module specifier, so `getManabars`/`getAccounts` get a trivial
 * fake chain directly — this test does not need `hive-chain-service.ts`'s
 * real generation/reset machinery, only `chain.api.database_api.*`,
 * `chain.api.rc_api.*` and the two `calculate*` mana functions. Both patches
 * use `Module._load`, the only working seam for either (`require.resolve`
 * fails the same way `@hiveio/wax` does).
 *
 * These tests never touch the network or a real WASM chain.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/manabar-shares-account-fetch.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 */

// Primed before anything is required — same reason as hive-chain-service-rebuild.test.ts:
// `@hive/ui/config/site` reads these at module-load time if the real chain
// service module is ever reached.
process.env.REACT_APP_API_ENDPOINT = 'https://api.example.invalid';
process.env.REACT_APP_REST_API_ENDPOINT = 'https://rest.example.invalid';

import Module from 'module';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

let checks = 0;
let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  checks += 1;
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(name: string): void {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------------------
// 1. THE STUBS. `find_accounts` is a counting spy — the whole point of this
//    fix is that `getManabars` must never call it, so this is the direct
//    regression guard for that.
// ---------------------------------------------------------------------------
let findAccountsCalls = 0;
const RAW_ACCOUNT: AnyRecord = {
  name: 'lordbutterfly',
  owner: {}, active: {}, posting: {}, memo_key: 'STM...', post_count: 1,
  created: '2020-01-01T00:00:00', json_metadata: '{}', posting_json_metadata: '{}',
  last_vote_time: '2026-09-07T00:00:00', last_post: '2026-09-07T00:00:00',
  reward_hbd_balance: { amount: '0', precision: 3, nai: '@@000000013' },
  reward_vesting_hive: { amount: '0', precision: 3, nai: '@@000000021' },
  reward_hive_balance: { amount: '0', precision: 3, nai: '@@000000021' },
  reward_vesting_balance: { amount: '0', precision: 6, nai: '@@000000037' },
  governance_vote_expiration_ts: '1970-01-01T00:00:00',
  balance: { amount: '1000', precision: 3, nai: '@@000000021' },
  vesting_shares: { amount: '500000', precision: 6, nai: '@@000000037' },
  hbd_balance: { amount: '0', precision: 3, nai: '@@000000013' },
  savings_balance: { amount: '0', precision: 3, nai: '@@000000021' },
  savings_hbd_balance: { amount: '0', precision: 3, nai: '@@000000013' },
  savings_hbd_seconds: '0', hbd_last_interest_payment: '1970-01-01T00:00:00',
  savings_hbd_seconds_last_update: '1970-01-01T00:00:00',
  next_vesting_withdrawal: '1970-01-01T00:00:00',
  delegated_vesting_shares: { amount: '0', precision: 6, nai: '@@000000037' },
  received_vesting_shares: { amount: '0', precision: 6, nai: '@@000000037' },
  vesting_withdraw_rate: { amount: '0', precision: 6, nai: '@@000000037' },
  to_withdraw: 0, withdrawn: 0, proxy: '', proxied_vsf_votes: [],
  // The three fields this whole fix is about:
  post_voting_power: { amount: '444555666', precision: 6, nai: '@@000000037' },
  voting_manabar: { current_mana: '111222333', last_update_time: 1757000000 },
  downvote_manabar: { current_mana: '4000000', last_update_time: 1757000001 }
};

function makeFakeChain(overrides: Partial<AnyRecord> = {}): AnyRecord {
  return {
    api: {
      database_api: {
        find_accounts: async (_req: unknown) => {
          findAccountsCalls += 1;
          return { accounts: [RAW_ACCOUNT] };
        },
        get_dynamic_global_properties: async () => ({
          time: '2026-09-07T00:00:10',
          downvote_pool_percent: 2500
        })
      },
      rc_api: {
        find_rc_accounts: async (_req: unknown) => ({
          rc_accounts: [{ max_rc: '900000', rc_manabar: { current_mana: '450000', last_update_time: 1757000002 } }]
        })
      }
    },
    // Spies: record every call's args, return a value derived from the args so
    // the test can prove WHICH numbers actually reached the math, not just
    // that some numbers did.
    calculateManabarFullRegenerationTimeCalls: [] as AnyRecord[],
    calculateCurrentManabarValueCalls: [] as AnyRecord[],
    calculateManabarFullRegenerationTime(time: number, max: unknown, current: unknown, lastUpdate: unknown) {
      this.calculateManabarFullRegenerationTimeCalls.push({ time, max, current, lastUpdate });
      return Number(lastUpdate) + 1000;
    },
    calculateCurrentManabarValue(time: number, max: unknown, current: unknown, lastUpdate: unknown) {
      this.calculateCurrentManabarValueCalls.push({ time, max, current, lastUpdate });
      return { max: String(max), current: String(current), percent: Number(lastUpdate) % 100 };
    },
    ...overrides
  };
}

let fakeChain: AnyRecord = makeFakeChain();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === '@hiveio/wax') return {};
  // `@hive/common-hiveio-packages`'s root index re-exports `./hb-auth` unconditionally
  // (`hive-network-error.ts` -> `@hive/common-hiveio-packages` -> `hbauth-service.ts`
  // -> real `@hiveio/hb-auth`, ESM-only, same `ERR_PACKAGE_PATH_NOT_EXPORTED` shape as
  // `@hiveio/wax`). Nothing under test calls into it, so an empty stub is enough.
  if (request === '@hiveio/hb-auth') return {};
  if (request === './chain') return { getChain: async () => fakeChain, resetTransactionChain: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// 2. LOAD THE REAL MODULE UNDER TEST (only after the stubs above are armed).
// ---------------------------------------------------------------------------
type HiveApiModule = typeof import('@transaction/lib/hive-api');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const hiveApi = require('@transaction/lib/hive-api') as HiveApiModule;

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  section('A. The account mapping carries the mana fields through unchanged');
  // -------------------------------------------------------------------------
  {
    findAccountsCalls = 0;
    const [account] = await hiveApi.getAccounts(['lordbutterfly']);
    check('find_accounts was called exactly once (this is the shared answer)', findAccountsCalls === 1, String(findAccountsCalls));
    check(
      'post_voting_power survives the mapping unchanged',
      JSON.stringify(account.post_voting_power) === JSON.stringify(RAW_ACCOUNT.post_voting_power)
    );
    check(
      'voting_manabar survives the mapping unchanged',
      JSON.stringify(account.voting_manabar) === JSON.stringify(RAW_ACCOUNT.voting_manabar)
    );
    check(
      'downvote_manabar survives the mapping unchanged',
      JSON.stringify(account.downvote_manabar) === JSON.stringify(RAW_ACCOUNT.downvote_manabar)
    );
  }

  // -------------------------------------------------------------------------
  section('B. getManabars, given the shared account, never calls find_accounts again');
  // -------------------------------------------------------------------------
  {
    fakeChain = makeFakeChain();
    findAccountsCalls = 0;
    const sharedAccount = (await hiveApi.getAccounts(['lordbutterfly']))[0];
    check('getAccounts made the one call that produced the shared answer', findAccountsCalls === 1, String(findAccountsCalls));

    const manabars = await hiveApi.getManabars('lordbutterfly', Promise.resolve(sharedAccount));

    check('find_accounts was NOT called again by getManabars (the fix)', findAccountsCalls === 1, String(findAccountsCalls));
    check('getManabars returned a result, not null', manabars !== null);

    if (manabars) {
      // WIRING: the upvote/downvote regeneration + current-value calls must have
      // been fed the SHARED account's own fields, not some other/default value.
      const upvoteRegenCall = fakeChain.calculateManabarFullRegenerationTimeCalls[0];
      check(
        'upvote cooldown math used the shared account post_voting_power.amount',
        upvoteRegenCall.max === RAW_ACCOUNT.post_voting_power.amount,
        String(upvoteRegenCall.max)
      );
      check(
        'upvote cooldown math used the shared account voting_manabar.current_mana',
        upvoteRegenCall.current === RAW_ACCOUNT.voting_manabar.current_mana,
        String(upvoteRegenCall.current)
      );
      check(
        'upvote cooldown math used the shared account voting_manabar.last_update_time',
        upvoteRegenCall.lastUpdate === RAW_ACCOUNT.voting_manabar.last_update_time,
        String(upvoteRegenCall.lastUpdate)
      );

      const upvoteValueCall = fakeChain.calculateCurrentManabarValueCalls[0];
      check(
        'upvote current-value math used the same shared fields',
        upvoteValueCall.current === RAW_ACCOUNT.voting_manabar.current_mana,
        String(upvoteValueCall.current)
      );

      // OUTPUT FIDELITY: the values getManabars returns are exactly what the
      // (stubbed) wax math produced, unchanged by the extra plumbing — "the
      // mana path returns the same values as today from the shared answer".
      check(
        'returned upvote.max/current/percent match the stub output',
        manabars.upvote.max === upvoteValueCall.max &&
          manabars.upvote.current === upvoteValueCall.current &&
          manabars.upvote.percent === Number(RAW_ACCOUNT.voting_manabar.last_update_time) % 100
      );
      check(
        'rc math used the shared rc_accounts answer (max_rc)',
        fakeChain.calculateCurrentManabarValueCalls[2]?.max === '900000',
        String(fakeChain.calculateCurrentManabarValueCalls[2]?.max)
      );
    }
  }

  // -------------------------------------------------------------------------
  section('C. A rejected account promise still swallows to null, exactly as a failed find_accounts used to');
  // -------------------------------------------------------------------------
  {
    fakeChain = makeFakeChain();
    findAccountsCalls = 0;
    const rejected = Promise.reject(new Error('account fetch failed'));
    // Prevent Node's own unhandled-rejection warning for the promise we hand in
    // deliberately unresolved before getManabars gets to it.
    rejected.catch(() => {});
    const manabars = await hiveApi.getManabars('lordbutterfly', rejected);
    check('getManabars returns null (not a throw) when the shared account promise rejects', manabars === null);
    check('find_accounts was still never called', findAccountsCalls === 0, String(findAccountsCalls));
  }

  // -------------------------------------------------------------------------
  section('D. NEGATIVE CONTROL — a genuinely missing post_voting_power is caught, not silently accepted');
  // -------------------------------------------------------------------------
  {
    fakeChain = makeFakeChain();
    const degenerate = { ...RAW_ACCOUNT, post_voting_power: undefined } as AnyRecord;
    const manabars = await hiveApi.getManabars(
      'lordbutterfly',
      Promise.resolve(degenerate) as unknown as Promise<import('@hive/common-hiveio-packages/wax').FullAccount>
    );
    check('a shared account with no post_voting_power resolves to null, not a thrown TypeError', manabars === null);
  }

  if (failures === 0) {
    console.log(`\nmanabar-shares-account-fetch: ALL ${checks} CHECKS PASSED`);
    process.exit(0);
  } else {
    console.error(`\nmanabar-shares-account-fetch: ${failures}/${checks} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('manabar-shares-account-fetch: UNCAUGHT ERROR', error);
  process.exit(1);
});
