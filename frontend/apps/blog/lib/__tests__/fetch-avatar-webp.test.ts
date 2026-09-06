/**
 * `fetchAsWebp` / `hopSignal` timeout + total-budget invariants — plain assertions,
 * no test runner (this repo has none; same shape as `lib/retry-transient.test.ts`
 * and `lib/http-keepalive.test.ts`).
 *
 * RUN IT (from `apps/blog`):
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/fetch-avatar-webp.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS. `app/api/avatar/route.ts`'s `fetchAsWebp` used to make up to
 * three outbound `fetch()` calls (a redirect probe, a WebP refetch, a PNG
 * fallback) with NO `AbortSignal` on any of them, wrapped in `withRetry`
 * (`@transaction/lib/retry`), whose `budgetMs` only bounds the SLEEP between
 * attempts, never an in-flight `fn()` call. Production logged the result three
 * times: `withRetry` give-ups at 28735ms, 54998ms and 59564ms, all on this
 * function's probe hop (see `fetch-avatar-webp.ts`'s own doc comment for the
 * exact log lines). Worse, a failure here did not even reach the route's
 * existing generated-avatar fallback — it rejected past `fetchAsWebp`, straight
 * into `GET`'s outer `catch`, which is what actually printed those log lines,
 * as a 500.
 *
 * The fix pulled the function into this `lib/` module specifically so it could
 * be exercised here with a mocked `fetch` — a Next.js Route Handler file may
 * only export the HTTP-verb functions Next recognises, so the logic could not
 * stay in `route.ts` and still be importable by a plain script.
 *
 * A global `unhandledRejection` guard is installed below and checked at the end,
 * because "never an unhandled rejection" is exactly the property a `try/await`
 * around a single call cannot rule out on its own (a stray un-awaited promise
 * from a mock or from `AbortSignal.timeout`'s internals would surface there, not
 * here).
 */
import { fetchAsWebp, hopSignal, HOP_TIMEOUT_MS, TOTAL_BUDGET_MS } from '../fetch-avatar-webp';

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, evidence?: string): void {
  checks += 1;
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}${evidence ? ` — ${evidence}` : ''}`);
    failures += 1;
  }
}

let sawUnhandledRejection: unknown = undefined;
process.on('unhandledRejection', (reason) => {
  sawUnhandledRejection = reason;
});

/** An `AbortError` shaped the way undici's real fetch throws one, so the
 *  module's own `isTransient` regex (which matches the word "aborted") treats
 *  it identically to a real timeout-induced abort. */
function abortError(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

type FetchInit = { signal?: AbortSignal; redirect?: string; headers?: Record<string, string> };
type FetchHandler = (url: string, init?: FetchInit) => Promise<Response>;

/** Rejects the moment `init.signal` fires, and never otherwise — this IS the
 *  hop that "never resolves" the task asks to prove is abandoned. */
function hangsUntilAbortedWithSignal(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return; // would hang forever — never exercised by this suite
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function installFetch(handler: FetchHandler): () => void {
  const original = global.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = (url: any, init?: any) => handler(String(url), init);
  return () => {
    global.fetch = original;
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, elapsedMs: Date.now() - start };
}

const SHORTCUT_URL = 'https://images.hive.blog/u/testuser/avatar/small';
const REDIRECT_LOCATION = '/p/deadbeef?width=&height=';

/**
 * Records every value handed to `AbortSignal.timeout` while `fn` runs, and puts
 * the real one back afterwards. This is how the hop-deadline checks assert what
 * our own arithmetic DECIDED, instead of waiting on the operating system to
 * honour a timer it demonstrably fires early. See check 1 for the measurement
 * that forced this.
 */
function captureTimeoutArgs(fn: () => unknown): number[] {
  const original = AbortSignal.timeout;
  const asked: number[] = [];
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
    asked.push(ms);
    return original.call(AbortSignal, ms);
  };
  try {
    fn();
    return asked;
  } finally {
    (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = original;
  }
}

async function main(): Promise<void> {
  // ── 1. THE PER-HOP DEADLINE, IN ISOLATION (far-future total deadline, so
  //      HOP_TIMEOUT_MS — not the remaining budget — is the tighter of the
  //      two). This is the exact mechanism a hung fetch is abandoned by.
  //
  //      ★ ASSERTED ON THE VALUE `hopSignal` DECIDES, NOT ON A REAL TIMER
  //      FIRING (2026-09-07, after a review measured this test failing 2 runs
  //      in 6). The original waited for the actual `abort` event and checked
  //      the wall clock. That is a test of Node's timer, not of our code, and
  //      Node's `AbortSignal.timeout` was reproduced firing at ~300ms instead
  //      of 2000ms roughly one call in seven on this machine. The arithmetic
  //      in `hopSignal` was correct every single time. So capture what it asks
  //      for and leave the OS out of it — the same reason this file already
  //      mocks `fetch` rather than reaching the network. ────────────────────
  {
    const asked = captureTimeoutArgs(() => hopSignal(Date.now() + 10 * HOP_TIMEOUT_MS));
    check(
      'with the total deadline far away, a hop asks for exactly HOP_TIMEOUT_MS',
      asked.length === 1 && asked[0] === HOP_TIMEOUT_MS,
      `asked=${JSON.stringify(asked)} HOP_TIMEOUT_MS=${HOP_TIMEOUT_MS}`
    );
  }

  // ── 2. THE SHORTER OF THE TWO WINS. When the remaining total budget is
  //      tighter than the per-hop ceiling, the signal honours the tighter one —
  //      this is what makes the TOTAL budget actually total. ────────────────
  {
    const asked = captureTimeoutArgs(() => hopSignal(Date.now() + 300));
    check(
      'when the remaining budget is tighter than the hop ceiling, the hop asks for the remaining budget',
      asked.length === 1 && asked[0] < HOP_TIMEOUT_MS && asked[0] > 250 && asked[0] <= 300,
      `asked=${JSON.stringify(asked)}`
    );
  }

  // A spent budget must ask for zero rather than a negative number, which is
  // what stops a hop starting at all once the total is gone.
  {
    const asked = captureTimeoutArgs(() => hopSignal(Date.now() - 5_000));
    check('a deadline already in the past asks for 0, never a negative', asked.length === 1 && asked[0] === 0, `asked=${JSON.stringify(asked)}`);
  }

  // ── 3. A HOP THAT NEVER RESOLVES IS ABANDONED, AND THE WHOLE CALL RETURNS —
  //      never hangs, never throws, never a 500. The probe itself never
  //      answers at all (the exact shape production logged: `avatar(...)-probe:
  //      fetch failed`). ────────────────────────────────────────────────────
  {
    const restore = installFetch((_url, init) => hangsUntilAbortedWithSignal(init?.signal));
    let threw: unknown = undefined;
    let response: Response | undefined;
    let elapsedMs = -1;
    try {
      const t = await timed(() => fetchAsWebp(SHORTCUT_URL, 'avatar(neverresolves)'));
      response = t.result;
      elapsedMs = t.elapsedMs;
    } catch (error) {
      threw = error;
    } finally {
      restore();
    }
    check('a permanently-hanging probe hop does not make fetchAsWebp throw', threw === undefined, String(threw));
    check(
      'the whole call returns comfortably under 5s, nowhere near the 28.7-59.6s hangs actually logged in production',
      elapsedMs >= TOTAL_BUDGET_MS - 200 && elapsedMs < 5000,
      `elapsedMs=${elapsedMs} TOTAL_BUDGET_MS=${TOTAL_BUDGET_MS}`
    );
    check('a spent budget yields a not-ok Response (the existing !response.ok fallback branch in route.ts)', response?.ok === false);
  }

  // ── 4. THE TOTAL BUDGET IS SHARED ACROSS HOPS: probe answers fast, but BOTH
  //      the webp hop and the would-be PNG-fallback hop hang. Three hops of
  //      up to HOP_TIMEOUT_MS each must not sum to 3 x HOP_TIMEOUT_MS — the
  //      third hop must not even be attempted once the budget from the first
  //      two is spent. ────────────────────────────────────────────────────
  {
    let fallbackHopCalls = 0;
    const restore = installFetch((url, init) => {
      if (url === SHORTCUT_URL) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: REDIRECT_LOCATION } }));
      }
      if (url.includes('format=webp')) {
        return hangsUntilAbortedWithSignal(init?.signal);
      }
      // the un-modified resolved URL — the PNG-fallback hop
      fallbackHopCalls += 1;
      return hangsUntilAbortedWithSignal(init?.signal);
    });
    let threw: unknown = undefined;
    let response: Response | undefined;
    let elapsedMs = -1;
    try {
      const t = await timed(() => fetchAsWebp(SHORTCUT_URL, 'avatar(twohopshang)'));
      response = t.result;
      elapsedMs = t.elapsedMs;
    } catch (error) {
      threw = error;
    } finally {
      restore();
    }
    check('two hanging hops after a fast probe still does not throw', threw === undefined, String(threw));
    check(
      'total elapsed is bounded near TOTAL_BUDGET_MS, not 2x or 3x HOP_TIMEOUT_MS (2s hops do not become 6s)',
      elapsedMs < 2 * HOP_TIMEOUT_MS + 500,
      `elapsedMs=${elapsedMs} HOP_TIMEOUT_MS=${HOP_TIMEOUT_MS} 2xHOP=${2 * HOP_TIMEOUT_MS}`
    );
    check('the budget was exhausted by the second hop, so the third (fallback) hop was never even attempted', fallbackHopCalls === 0, `fallbackHopCalls=${fallbackHopCalls}`);
    check('the exhausted-budget response is not-ok', response?.ok === false);
  }

  // ── 5. HAPPY PATH: probe redirects, webp hop answers ok+body fast — the
  //      route's WebP negotiation must be byte-for-byte unchanged. ──────────
  {
    const webpBody = 'webp-bytes';
    const restore = installFetch((url) => {
      if (url === SHORTCUT_URL) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: REDIRECT_LOCATION } }));
      }
      if (url.includes('format=webp')) {
        return Promise.resolve(new Response(webpBody, { status: 200, headers: { 'content-type': 'image/webp' } }));
      }
      throw new Error(`unexpected fetch in happy-path test: ${url}`);
    });
    let response: Response | undefined;
    let elapsedMs = -1;
    try {
      const t = await timed(() => fetchAsWebp(SHORTCUT_URL, 'avatar(happy)'));
      response = t.result;
      elapsedMs = t.elapsedMs;
    } finally {
      restore();
    }
    check('the happy path still resolves to the webp response', response?.ok === true && response?.headers.get('content-type') === 'image/webp');
    check('the happy path is fast — no timeout path was ever engaged', elapsedMs < 300, `elapsedMs=${elapsedMs}`);
  }

  // ── 6. PNG FALLBACK NEGOTIATION UNCHANGED: webp hop fails (not ok), the
  //      un-modified resolved URL is fetched next and its response wins. ────
  {
    const pngBody = 'png-bytes';
    const restore = installFetch((url) => {
      if (url === SHORTCUT_URL) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: REDIRECT_LOCATION } }));
      }
      if (url.includes('format=webp')) {
        return Promise.resolve(new Response(null, { status: 415 })); // origin can't transcode this source
      }
      return Promise.resolve(new Response(pngBody, { status: 200, headers: { 'content-type': 'image/png' } }));
    });
    let response: Response | undefined;
    try {
      response = await fetchAsWebp(SHORTCUT_URL, 'avatar(pngfallback)');
    } finally {
      restore();
    }
    check(
      'a webp hop that answers-but-fails still falls through to the PNG fallback, exactly as before',
      response?.ok === true && response?.headers.get('content-type') === 'image/png'
    );
  }

  // ── 7. NO REDIRECT AT ALL (missing account / upstream error): the probe
  //      response is handed back untouched — no further hops attempted. ─────
  {
    let hopsAfterProbe = 0;
    const restore = installFetch((url) => {
      if (url === SHORTCUT_URL) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      hopsAfterProbe += 1;
      return Promise.resolve(new Response(null, { status: 500 }));
    });
    let response: Response | undefined;
    try {
      response = await fetchAsWebp(SHORTCUT_URL, 'avatar(noredirect)');
    } finally {
      restore();
    }
    check('a non-redirecting probe (e.g. a 404) is returned untouched', response?.status === 404);
    check('no further hop is attempted when there is nothing to resolve', hopsAfterProbe === 0);
  }

  // Give any stray microtask from a mock a turn before checking for leaks.
  await new Promise((resolve) => setTimeout(resolve, 10));
  check('no unhandled rejection occurred anywhere in this suite', sawUnhandledRejection === undefined, String(sawUnhandledRejection));

  if (failures === 0) {
    console.log(`\nfetch-avatar-webp: ALL ${checks} CHECKS PASSED`);
    process.exit(0);
  } else {
    console.error(`\nfetch-avatar-webp: ${failures} of ${checks} CHECK(S) FAILED`);
    process.exit(1);
  }
}

// ★ KEEP THE PROCESS ALIVE (found by running this, not guessed). `AbortSignal.timeout()`'s
// internal timer is deliberately UNREF'd in Node — reasonable for real production traffic,
// where the in-flight `fetch()` itself (a real socket) is what keeps the event loop open
// while the timeout races it. This suite's mocked hops do no real I/O, so with nothing else
// ref'd, Node considered the event loop empty and exited 0 with ZERO output the instant the
// synchronous part of `main()` finished — silently skipping every `await` on a mocked
// timeout before it ever fired. A ref'd interval, cleared once `main()` settles, is enough.
const keepAlive = setInterval(() => {}, 1000);
main()
  .then(() => clearInterval(keepAlive))
  .catch((error) => {
    clearInterval(keepAlive);
    console.error('fetch-avatar-webp: the suite itself threw:', error);
    process.exit(1);
  });
