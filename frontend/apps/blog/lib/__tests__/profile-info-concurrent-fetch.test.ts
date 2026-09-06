/**
 * UNIT TESTS for the 2026-09-07 fix to `getProfileInfo`
 * (`packages/transaction/lib/hive-api.ts`): it awaited `bridge.get_profile`
 * and only THEN started `bannedFollowEdges(username)`, which needs nothing
 * from the profile response except the username it already had. The two now
 * start together.
 *
 * This file proves the two things the fix has to hold:
 *   1. THE TWO CALLS RUN CONCURRENTLY — proven by ORDERING, not timing. Both
 *      underlying chain calls are made to log their own start BEFORE either
 *      is allowed to resolve (each is gated behind a manually-controlled
 *      promise the test resolves on its own schedule). If the edges call's
 *      start were still gated on the profile call resolving first (the old
 *      sequential shape), its start event could never appear before the
 *      profile resolve event in the log — no clock is read anywhere in this
 *      file.
 *   2. A FAILURE OF THE SOFT CALL STILL YIELDS A PROFILE — the follow-edges
 *      fan-out failing (its own `.catch` inside `getProfileInfo`) must not
 *      stop a normal profile from coming back, uncorrected.
 *
 * Also covers: the hard call (`get_profile`) failing still rejects
 * `getProfileInfo` exactly as before (nothing here softened that path), and
 * the pre-existing "no profile" early return still returns the same zeroed
 * shape.
 *
 * ★ WHY `@hiveio/wax`/`@hiveio/hb-auth` ARE MONKEY-PATCHED, AND WHY
 * `./chain` IS TOO: see `lib/__tests__/manabar-shares-account-fetch.test.ts`'s
 * header for the full reasoning (`Module._load` is the only working seam;
 * `./chain` is patched so this test controls `chain.api.bridge.*` directly
 * instead of standing up `hive-chain-service.ts`'s real generation/reset
 * machinery). These tests never touch the network or a real WASM chain.
 *
 * `LUMEN_BANNED_AUTHORS` and `LUMEN_BANNED_FOLLOW_EDGES` are set BEFORE the
 * module is required so `bannedFollowEdges` actually reaches the chain (see
 * that fix's own report: on real production, `LUMEN_BANNED_FOLLOW_EDGES=no`
 * short-circuits before any chain call, which is the right prod default but
 * would make concurrency unobservable here — this test deliberately exercises
 * the switch-ON path, which is exactly the path the fix matters for).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/profile-info-concurrent-fetch.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 */

process.env.REACT_APP_API_ENDPOINT = 'https://api.example.invalid';
process.env.REACT_APP_REST_API_ENDPOINT = 'https://rest.example.invalid';
// One banned name is enough to make `bannedFollowEdges` issue real (fake)
// chain calls instead of short-circuiting on an empty list.
process.env.LUMEN_BANNED_AUTHORS = 'sometroll';
delete process.env.LUMEN_BANNED_FOLLOW_EDGES; // unset = enabled (today's default)

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
/** Flush the microtask queue without asserting on any real clock. */
async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// 1. THE FAKE CHAIN. `get_profile` and `get_relationship_between_accounts`
//    each log a `start` event immediately, then hang on a manually-resolved
//    gate until the test releases them — this is the ordering instrument.
// ---------------------------------------------------------------------------
let events: string[] = [];
let profileGate: Promise<AnyRecord | null>;
let resolveProfileGate: (value: AnyRecord | null) => void;
let profileImpl: () => Promise<AnyRecord | null>;
let edgeImpl: (pair: [string, string]) => Promise<AnyRecord | null>;

function resetGates(): void {
  events = [];
  resolveProfileGate = () => {};
  profileGate = new Promise((resolve) => {
    resolveProfileGate = resolve;
  });
}
resetGates();

const fakeChain: AnyRecord = {
  api: {
    bridge: {
      get_profile: async (_params: unknown) => {
        events.push('profile:start');
        const result = await profileImpl();
        events.push('profile:resolve');
        return result;
      },
      get_relationship_between_accounts: async (pair: [string, string]) => {
        events.push(`edge:start:${pair.join('->')}`);
        const result = await edgeImpl(pair);
        events.push(`edge:resolve:${pair.join('->')}`);
        return result;
      }
    }
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === '@hiveio/wax') return {};
  if (request === '@hiveio/hb-auth') return {};
  if (request === './chain') return { getChain: async () => fakeChain, resetTransactionChain: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};

type HiveApiModule = typeof import('@transaction/lib/hive-api');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const hiveApi = require('@transaction/lib/hive-api') as HiveApiModule;

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  section('A. Both calls start before either settles — proven by ordering, not timing');
  // -------------------------------------------------------------------------
  {
    resetGates();
    profileImpl = () => profileGate;
    edgeImpl = async () => ({ follows: false });

    const infoPromise = hiveApi.getProfileInfo('concurrencyuser');
    await tick();

    const edgeStartIndexBeforeRelease = events.findIndex((e) => e.startsWith('edge:start:'));
    check(
      'get_profile was invoked before being resolved',
      events.includes('profile:start') && !events.includes('profile:resolve')
    );
    check(
      'get_relationship_between_accounts was ALREADY invoked while get_profile is still pending — the sequential ' +
        'version could not have logged this until AFTER profile:resolve',
      edgeStartIndexBeforeRelease !== -1,
      events.join(', ')
    );

    // Release profile now; the edge calls already have their own resolved
    // (non-gated) implementation and settle on their own.
    resolveProfileGate({ stats: { followers: 100, following: 50 }, reputation: 60 });
    const info = await infoPromise;
    const profileResolveIndex = events.indexOf('profile:resolve');
    check(
      "THE ORDERING PROOF: the edge call's start precedes profile's resolve in ONE shared log " +
        '(index comparison, no clock read anywhere in this file)',
      edgeStartIndexBeforeRelease !== -1 && profileResolveIndex !== -1 && edgeStartIndexBeforeRelease < profileResolveIndex,
      `edge:start@${edgeStartIndexBeforeRelease}, profile:resolve@${profileResolveIndex}`
    );
    check(
      'a normal profile still comes back correctly once both settle',
      info.follow_stats.follower_count === 100 && info.follow_stats.following_count === 50 && info.reputation === 60
    );
  }

  // -------------------------------------------------------------------------
  section('B. A failure of the soft call (banned-edges fan-out) still yields a profile');
  // -------------------------------------------------------------------------
  {
    resetGates();
    profileImpl = async () => ({ stats: { followers: 84, following: 12 }, reputation: 71 });
    edgeImpl = async () => {
      throw new Error('relationship lookup exploded');
    };

    const info = await hiveApi.getProfileInfo('softfailuser');
    check('getProfileInfo did not throw when the edges fan-out failed', true);
    check(
      'the profile came back UNCORRECTED (banned counts defaulted to 0), not blank',
      info.follow_stats.follower_count === 84 && info.follow_stats.following_count === 12 && info.reputation === 71
    );
  }

  // -------------------------------------------------------------------------
  section('C. UNCHANGED: a hard failure of get_profile itself still rejects (not softened by this fix)');
  // -------------------------------------------------------------------------
  {
    resetGates();
    profileImpl = async () => {
      throw new Error('deterministic, non-transient profile failure');
    };
    edgeImpl = async () => ({ follows: false });

    let threw = false;
    try {
      await hiveApi.getProfileInfo('hardfailuser');
    } catch (error) {
      threw = true;
      check('the rejection is the get_profile error, not a swallowed one', (error as Error).message.includes('deterministic, non-transient profile failure'));
    }
    check('getProfileInfo still rejects on a hard get_profile failure (this fix did not soften that)', threw);
  }

  // -------------------------------------------------------------------------
  section('D. UNCHANGED: an account with no profile/no stats still returns the same zeroed shape');
  // -------------------------------------------------------------------------
  {
    resetGates();
    profileImpl = async () => null;
    edgeImpl = async () => ({ follows: false });

    const info = await hiveApi.getProfileInfo('noprofileuser');
    check(
      'no-profile branch still returns zeroed follow_stats and reputation 25',
      info.follow_stats.follower_count === 0 && info.follow_stats.following_count === 0 && info.reputation === 25
    );
  }

  if (failures === 0) {
    console.log(`\nprofile-info-concurrent-fetch: ALL ${checks} CHECKS PASSED`);
    process.exit(0);
  } else {
    console.error(`\nprofile-info-concurrent-fetch: ${failures}/${checks} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('profile-info-concurrent-fetch: UNCAUGHT ERROR', error);
  process.exit(1);
});
