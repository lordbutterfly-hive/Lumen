/**
 * `withTtlCache` invariants — plain assertions, no test runner (this repo has
 * none, and adding one is out of scope).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/server-ttl-cache.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHAT IS PROVEN HERE
 *   1. The pre-existing contract still holds — hit inside the TTL, single-flight
 *      on a miss, failures never stored, bounded eviction.
 *   2. ★ THE NEGATIVE CONTROL: with `staleWhileRevalidateMs` omitted, expiry
 *      still BLOCKS. Without this the suite could not tell the new option from
 *      an accident, and every "serves stale" check below would be unfalsifiable.
 *   3. Serve-stale returns the OLD value with no wait, and refreshes behind it.
 *   4. Exactly ONE background refresh, no matter how many readers arrive stale.
 *   5. A REJECTING background refresh neither crashes the process nor stores the
 *      failure, and the stale value keeps being served.
 *   6. Past the stale window the behaviour returns to blocking — degraded to
 *      un-cached, never wrong.
 *   7. A per-value window of 0 is honoured, which is what keeps
 *      `getAccountFullCached`'s 10s absence from being stretched to 40s.
 *
 * ★ TIME IS REAL HERE, NOT MOCKED. The module reads `Date.now()` directly and
 * injecting a clock would mean changing production code to suit its test. The
 * TTLs below are in tens of milliseconds instead, so the whole file runs in well
 * under a second and exercises the same arithmetic the app runs.
 */
import { withTtlCache } from '../server-ttl-cache';

let checks = 0;
let failures = 0;
const lines: string[] = [];

function out(s: string): void {
  lines.push(s);
}

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    out(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  out(`\n${name}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A loader that counts its calls and returns a value that changes every call. */
function countingLoader(delayMs = 0) {
  const state = { calls: 0 };
  const load = async (key: string): Promise<string> => {
    state.calls++;
    if (delayMs) await sleep(delayMs);
    return `${key}#${state.calls}`;
  };
  return { state, load };
}

async function main(): Promise<void> {
  // ── 1. the contract that existed before serve-stale ───────────────────────
  section('1. pre-existing contract');
  {
    const { state, load } = countingLoader();
    const cached = withTtlCache(load, (k: string) => k, { ttlMs: 10_000 });

    const first = await cached('a');
    const second = await cached('a');
    check('a miss calls the loader once', state.calls === 1, `calls=${state.calls}`);
    check('a hit inside the TTL does not call again', state.calls === 1, `calls=${state.calls}`);
    check('the hit returns the stored value', first === second, `${first} vs ${second}`);

    const other = await cached('b');
    check('a different key misses', state.calls === 2, `calls=${state.calls}`);
    check('and returns its own value', other.startsWith('b#'), other);
  }
  {
    const { state, load } = countingLoader(30);
    const cached = withTtlCache(load, (k: string) => k, { ttlMs: 10_000 });
    const all = await Promise.all([cached('a'), cached('a'), cached('a'), cached('a')]);
    check('four concurrent misses single-flight into one call', state.calls === 1, `calls=${state.calls}`);
    check('and all four get the same value', new Set(all).size === 1, JSON.stringify(all));
  }
  {
    let calls = 0;
    const load = async (): Promise<string> => {
      calls++;
      throw new Error('upstream 429');
    };
    const cached = withTtlCache(load, () => 'k', { ttlMs: 10_000 });
    await cached().catch(() => undefined);
    await cached().catch(() => undefined);
    check('a rejection is never stored, so the next call retries', calls === 2, `calls=${calls}`);
  }
  {
    const { state, load } = countingLoader();
    const cached = withTtlCache(load, (k: string) => k, { ttlMs: 10_000, max: 2 });
    await cached('a');
    await cached('b');
    await cached('c'); // evicts 'a'
    const callsBefore = state.calls;
    await cached('a');
    check('eviction is bounded by `max`', state.calls === callsBefore + 1, `calls=${state.calls}`);
  }

  // ── 2. NEGATIVE CONTROL — without the option, expiry still blocks ─────────
  //
  // If this check ever passes for the wrong reason, every serve-stale check
  // below means nothing: a cache that always refetched would satisfy them all.
  section('2. negative control — serve-stale OFF is still the old behaviour');
  {
    const { state, load } = countingLoader(60);
    const cached = withTtlCache(load, (k: string) => k, { ttlMs: 30 });
    const first = await cached('a');
    await sleep(50); // past the TTL, no stale window configured
    const t0 = Date.now();
    const second = await cached('a');
    const waited = Date.now() - t0;
    check('the expired read calls upstream again', state.calls === 2, `calls=${state.calls}`);
    check('the caller WAITED for it', waited >= 50, `waited=${waited}ms`);
    check('and got the FRESH value, not the stale one', second !== first, `${first} vs ${second}`);
  }

  // ── 3. serve-stale returns the old value without waiting ─────────────────
  //
  // ★ THE TIMINGS HERE HAVE DELIBERATE MARGIN, because the refreshed value gets
  // a TTL of its own and the last check reads it back. A first draft used a 30ms
  // TTL and slept 90ms for a 60ms refresh: the refresh landed at ~60ms and its
  // own TTL lapsed at ~90ms, so the read raced the second expiry and a third
  // upstream call. It passed once and failed the next run. With a 20ms loader
  // and a 60ms TTL every edge below is 20-40ms away from the assertion.
  section('3. serve-stale');
  {
    const { state, load } = countingLoader(20);
    const cached = withTtlCache(load, (k: string) => k, { ttlMs: 60, staleWhileRevalidateMs: 10_000 });
    const first = await cached('a'); // resolves ~t+20, expires ~t+80
    await sleep(80); // ~t+100: expired, inside the stale window

    const t0 = Date.now();
    const stale = await cached('a');
    const waited = Date.now() - t0;
    check('the stale read returns immediately', waited < 20, `waited=${waited}ms`);
    check('and returns the value we already held', stale === first, `${stale} vs ${first}`);
    check('while a refresh was started behind it', state.calls === 2, `calls=${state.calls}`);

    await sleep(40); // refresh landed ~20ms ago and is fresh for another ~40ms
    const refreshed = await cached('a');
    check('the refreshed value is served afterwards', refreshed !== first, `${refreshed} vs ${first}`);
    check('and serving it needed no further call', state.calls === 2, `calls=${state.calls}`);
  }

  // ── 4. one refresh, however many stale readers ────────────────────────────
  section('4. single-flight across the background refresh');
  {
    const { state, load } = countingLoader(60);
    const cached = withTtlCache(load, (k: string) => k, { ttlMs: 30, staleWhileRevalidateMs: 10_000 });
    const first = await cached('a');
    await sleep(50);
    const many = await Promise.all([cached('a'), cached('a'), cached('a'), cached('a'), cached('a')]);
    check('five stale readers trigger exactly one refresh', state.calls === 2, `calls=${state.calls}`);
    check('and every one of them got the stale value', many.every((v) => v === first), JSON.stringify(many));
  }

  // ── 5. a failing refresh must not crash, and must not be stored ───────────
  //
  // This is the check that would have caught an unhandled rejection: without the
  // `.catch()` on the background load, Node 20 terminates the process here and
  // this file exits non-zero without printing a summary.
  section('5. a failing background refresh');
  {
    let calls = 0;
    const load = async (): Promise<string> => {
      calls++;
      if (calls === 1) return 'good';
      await sleep(10);
      throw new Error('upstream 429');
    };
    const cached = withTtlCache(load, () => 'k', { ttlMs: 30, staleWhileRevalidateMs: 10_000 });
    const first = await cached();
    await sleep(50);
    const stale = await cached();
    check('the stale value is served while the doomed refresh runs', stale === first, `${stale} vs ${first}`);
    await sleep(60); // the refresh rejects in here
    check('the process survived the rejected background refresh', true);
    const still = await cached();
    check('the failure was not stored — the stale value stands', still === first, `${still} vs ${first}`);
    check('and another refresh was attempted', calls >= 3, `calls=${calls}`);
  }

  // ── 6. past the stale window, back to blocking ────────────────────────────
  section('6. the stale window ends');
  {
    const { state, load } = countingLoader(60);
    const cached = withTtlCache(load, (k: string) => k, { ttlMs: 20, staleWhileRevalidateMs: 20 });
    const first = await cached('a');
    await sleep(70); // past ttl + stale window
    const t0 = Date.now();
    const fresh = await cached('a');
    const waited = Date.now() - t0;
    check('the caller waits again once the window has passed', waited >= 50, `waited=${waited}ms`);
    check('and gets a fresh value', fresh !== first, `${fresh} vs ${first}`);
    check('having called upstream', state.calls === 2, `calls=${state.calls}`);
  }

  // ── 7. a per-value window of 0 opts that value out ────────────────────────
  //
  // The shape `getAccountFullCached` relies on: a real account may be served
  // stale, an ABSENCE never is, so a just-created account still appears within
  // its 10s TTL rather than its TTL plus a stale window.
  //
  // ★ ASSERT ON THE WAIT, NOT ON THE CALL COUNT. Counting calls cannot tell the
  // two apart: serving stale ALSO starts a refresh, so both paths increment by
  // one. A first draft of this section counted calls and a mutation that ignored
  // the per-value window entirely (`staleFor` hardcoded to 10s) passed it —
  // MISSED. What actually separates them is who waits: a served-stale read
  // returns at once, a re-read blocks on the upstream. So the loader is slow
  // here on purpose, and the clock is the assertion.
  section('7. per-value window (the absence opt-out)');
  {
    let calls = 0;
    const load = async (name: string): Promise<{ name: string } | null> => {
      calls++;
      await sleep(60);
      return name === 'ghost' ? null : { name: `${name}#${calls}` };
    };
    const cached = withTtlCache(load, (n: string) => n, {
      ttlMs: 30,
      shouldCache: () => true, // an absence is a real answer here, as in cached-api.ts
      staleWhileRevalidateMs: (v) => (v && v.name ? 10_000 : 0)
    });

    const real = await cached('alice');
    await sleep(50);
    const callsBeforeReal = calls;
    const tReal = Date.now();
    const staleReal = await cached('alice');
    const waitedReal = Date.now() - tReal;
    check('a real value IS served stale', staleReal === real, JSON.stringify([staleReal, real]));
    check('and served WITHOUT waiting', waitedReal < 20, `waited=${waitedReal}ms`);
    check('with a refresh behind it', calls === callsBeforeReal + 1, `calls=${calls}`);

    await cached('ghost');
    await sleep(50);
    const tGhost = Date.now();
    const ghost = await cached('ghost');
    const waitedGhost = Date.now() - tGhost;
    check('an absence is NOT served stale — the caller WAITS for a re-read', waitedGhost >= 50, `waited=${waitedGhost}ms`);
    check('and the re-read still reports the absence', ghost === null, JSON.stringify(ghost));
  }
}

main()
  .then(() => {
    out('');
    out(
      failures === 0
        ? `PASS — ${checks} checks, serve-stale proven with its negative control`
        : `FAIL — ${failures} of ${checks} checks failed`
    );
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.log(`${lines.join('\n')}\n\nFAIL — the suite itself threw: ${String(err)}`);
    process.exit(1);
  });
