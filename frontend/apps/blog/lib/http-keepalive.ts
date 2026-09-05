/**
 * ★★★ WHETHER THE SERVER'S OUTBOUND HIVE CALLS REUSE THEIR TLS CONNECTION,
 * DECIDED BY ONE ENV FLAG (2026-09-05, cold-profile work). Pure, no I/O, no
 * imports, unit-tested next door -- exactly the shape of
 * `lib/feed/posts-prefetch-budget.ts`, and for the same reason: the value is
 * read once at boot in `instrumentation.ts`, where a mistake is invisible until
 * production, so the parsing lives somewhere a test can reach it.
 *
 * ★ WHAT IS ACTUALLY WRONG TODAY. Nothing in this repo ever configures an
 * outbound HTTP dispatcher. `packages/transaction/lib/hive-api.ts` reaches Hive
 * through wax, wax uses the bare global `fetch`, and Node 20's `fetch` is
 * undici with its DEFAULT `Agent`. That default keeps an idle socket for
 * `keepAliveTimeout = 4000ms` when the upstream sends no `Keep-Alive: timeout=`
 * hint (undici `lib/dispatcher/client.js`: `keepAliveTimeout == null ? 4e3`),
 * and when the upstream DOES send a hint it uses `hint - 2000ms`
 * (`keepAliveTimeoutThreshold`). Either way a profile render whose Hive calls
 * land more than a few seconds after the previous ones opens a NEW TCP
 * connection and pays a NEW TLS handshake.
 *
 * That is not a theory about a fast path; it is the measured cost of the two
 * calls that are left in the layout after the banned-edges fan-out was switched
 * off (COLD-FIX-AND-RECSYS-TIMEOUT-2026-09-05, sections 15 and 16): `getAccount` p50 212ms
 * and `bridge.get_profile` p50 202ms, each a separate HTTPS request. Prior
 * measurement puts ~70ms of that on api.openhive.network and up to ~240ms on
 * api.hive.blog in the handshake alone. A reused socket removes that part and
 * nothing else -- it cannot make the upstream itself faster, which is exactly
 * why this ships as a flag with a before/after rather than as a claim.
 *
 * ★★ WHY IT IS OFF BY DEFAULT AND WHAT "OFF" MEANS. `LUMEN_HTTP_KEEPALIVE=yes`
 * installs the dispatcher; anything else installs NOTHING, so the process keeps
 * Node's own default agent and every outbound request behaves byte for byte as
 * it does today. The only trace of this module with the flag off is one boot log
 * line saying so, which is what makes the A/B readable: an operator reading the
 * log can tell which arm a given process is in without guessing from behaviour.
 *
 * ★★ WHY `keepAliveMaxTimeout` IS DERIVED AND CAN ONLY GO UP. undici uses
 * `keepAliveTimeout` ONLY when the upstream sends no `Keep-Alive` hint, and
 * uses `min(hint - threshold, keepAliveMaxTimeout)` when it does. So a
 * `keepAliveMaxTimeout` BELOW undici's own 600_000 default would SHORTEN socket
 * reuse for any upstream that advertises a long idle timeout -- i.e. the flag
 * could make things worse on some origins while making them better on others,
 * and the A/B would be measuring two opposite changes at once. `Math.max` of the
 * two keeps the change strictly additive: raise the no-hint floor, never lower
 * the hint ceiling.
 *
 * ★ WHY 50_000 AND NOT MORE. api.hive.blog closes an idle connection at roughly
 * 75s. A socket we hold past the far end's close is a socket we will try to
 * write a request onto after it is gone, and undici does NOT retry a request
 * that was already written when the connection dies (its `client-h1.js` "Fail
 * head of pipeline" path errors it; retry is opt-in via `RetryAgent`, which is
 * NOT in use here). Hive JSON-RPC is POST, which undici does not even consider
 * idempotent, so such a request would surface as a failed render rather than a
 * transparently retried one. 50s sits a full 25s inside the upstream's window,
 * and undici 6.28+ additionally revalidates an idle socket (yielding to the
 * event loop's check phase so a pending FIN/RST is processed) before writing a
 * new request onto it. Raise this number only with that 75s in mind.
 *
 * ★ WHAT WAS ACTUALLY CHECKED, AND WHAT WAS NOT. The 50s hold was reasoned
 * against `api.openhive.network` and `api.hive.blog` only: neither returns a
 * `Keep-Alive: timeout=` response header, which is what makes this flag do
 * anything at all (undici applies `keepAliveTimeout` ONLY in the no-hint case;
 * given a hint it uses `min(hint - 2000ms, keepAliveMaxTimeout)` and ignores our
 * number entirely). The other two endpoints in the rotation --
 * `api.deathwing.me` and `rpc.mahdiyari.info`, see `FALLBACK_ENDPOINTS` in
 * `common-hiveio-packages/src/wax/hive-chain-service.ts` -- were NOT measured. A
 * failover onto one of those is therefore running on an unmeasured assumption:
 * if such a node closes an idle connection sooner than 50s, the first request
 * after a quiet spell can lose the race described above. Check their headers
 * before treating a failover window's numbers as evidence about this flag.
 *
 * ★★ WHY `connections` IS 64 AND NOT 16, AND NOT UNLIMITED. This is the one part
 * of the change that can make things WORSE, so both bounds are argued.
 *
 * NOT 16, because the cap is not per-endpoint in any useful sense: wax talks to
 * exactly ONE node at a time (`common-hiveio-packages/src/wax/hive-chain-service.ts`
 * keeps a single `hiveChain.api.endpointUrl` and the rotation only MOVES it on
 * failover), so every outbound Hive call on a worker shares one origin and one
 * pool. A cap of 16 is therefore a cap on ALL Hive concurrency for that worker.
 * A crawler burst is well past it -- a single cold profile render alone can have
 * getAccount, get_profile and the posts read in flight, and the budget work of
 * 2026-09-05 exists precisely because dozens of anonymous renders arrive at once.
 * The 17th call would then wait on undici's pool queue, which has NO timeout of
 * its own: the wait shows up as upstream latency, in the very numbers this flag
 * is meant to improve, and it would look exactly like a slow node.
 *
 * NOT UNLIMITED (undici's default), because unlimited is what turns a Hive node
 * having a bad minute into this box opening sockets until something else breaks,
 * and because an unbounded pool has no ceiling to state in a log line or to
 * reason about against the node's own connection limits.
 *
 * 64 per worker is 3 x 64 = 192 sockets per origin worst case across the cluster:
 * comfortably above any burst measured on this box, still a number. If the boot
 * line's `connections=` ever turns out to be the ceiling being hit, raise it with
 * `LUMEN_HTTP_KEEPALIVE_CONNECTIONS` rather than guessing at build time.
 *
 * ★ `pipelining: 1` IS STATED, NOT INHERITED. It is already undici's h1 default,
 * but pipelining > 1 puts a second request on the wire before the first has
 * answered, and every one of these requests is a POST -- a connection failure
 * mid-pipeline would fail requests that were never even sent. Writing it down
 * means a later "let's try pipelining" is a deliberate edit rather than a
 * default drifting under us.
 */

/** No upstream hint: how long an idle socket is held. undici's default is 4_000. */
export const HTTP_KEEPALIVE_TIMEOUT_MS: number = 50_000;

/** Max sockets per origin, per worker process. undici's default is unlimited. */
export const HTTP_KEEPALIVE_CONNECTIONS: number = 64;

/**
 * undici's own `keepAliveMaxTimeout` default. Used as a FLOOR, never as a
 * ceiling -- see this module's doc comment.
 *
 * ★ ALL THREE CONSTANTS ARE ANNOTATED `: number` ON PURPOSE. Without it each is
 * a LITERAL type, and `http-keepalive.test.ts` asserting `=== 600_000` becomes a
 * comparison TypeScript resolves at compile time: changing the constant then
 * fails with TS2367 ("no overlap") before the test ever runs, which is a red
 * build with a confusing message instead of a named failing check. Widening
 * costs nothing (every consumer already takes `number`) and keeps the mutation
 * check honest and readable.
 */
export const HTTP_KEEPALIVE_MAX_TIMEOUT_FLOOR_MS: number = 600_000;

/** Exactly the option bag handed to `new Agent(...)`, plus the on/off answer. */
export interface HttpKeepAliveSettings {
  /** `LUMEN_HTTP_KEEPALIVE === 'yes'`. Nothing is installed when false. */
  enabled: boolean;
  keepAliveTimeout: number;
  keepAliveMaxTimeout: number;
  connections: number;
  pipelining: 1;
}

/**
 * One override parser for both numeric knobs. Anything that is not a positive
 * finite number -- unset, empty, `'   '`, `abc`, `0`, negative, `Infinity` --
 * falls back to the constant.
 *
 * ★ WHAT UNDICI ACTUALLY DOES WITH A BAD VALUE, MEASURED RATHER THAN ASSUMED
 * (2026-09-05, review). An earlier version of this comment claimed
 * `new Agent({ keepAliveTimeout: NaN })` throws `InvalidArgumentError` at
 * construction. It does not, and the truth is worse in both directions:
 *
 *  · `NaN` and `Infinity` are SILENTLY ERASED. `Agent` deep-clones its options
 *    through `JSON.parse(JSON.stringify(...))` (undici `lib/dispatcher/agent.js`),
 *    and JSON has no NaN, so the value arrives as `null` and undici substitutes
 *    its OWN default. The boot line would then report `on` with a number the
 *    dispatcher is not using -- an A/B that silently measures the control arm
 *    against itself, which is the one failure mode an instrument may not have.
 *  · A NEGATIVE value survives the clone and throws NOTHING at boot. It throws on
 *    the FIRST REQUEST, from inside a render, as `TypeError: fetch failed` with
 *    `cause: invalid connections`. `getAccountFull` catches that into
 *    `follower_count: 0, reputation: 25`, so a typo in `/opt/lumen/.env` would
 *    quietly serve wrong profile numbers to every reader on that worker until
 *    someone restarted it.
 *
 * Either way the damage is invisible, which is exactly why the guard is here and
 * why it is tested. A misconfigured env var must degrade to the documented
 * default, visibly, at boot.
 */
function positiveOverride(raw: string | undefined, fallback: number): number {
  const override = Number(raw);
  if (!Number.isFinite(override) || override <= 0) return fallback;
  return Math.floor(override);
}

/**
 * The dispatcher settings for this process. `env` is injectable for the test
 * only; production always passes `process.env`.
 *
 *   · `LUMEN_HTTP_KEEPALIVE`             `yes` to install anything at all
 *   · `LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS`  default 50_000
 *   · `LUMEN_HTTP_KEEPALIVE_CONNECTIONS` default 16
 *
 * The numeric knobs are parsed whether or not the flag is on, so that the boot
 * line can report what WOULD be used and a misconfigured number is visible in
 * the off arm too, before it is switched on in front of readers.
 */
export function httpKeepAliveSettings(
  env: Record<string, string | undefined> = process.env
): HttpKeepAliveSettings {
  const keepAliveTimeout = positiveOverride(env.LUMEN_HTTP_KEEPALIVE_TIMEOUT_MS, HTTP_KEEPALIVE_TIMEOUT_MS);
  return {
    enabled: env.LUMEN_HTTP_KEEPALIVE === 'yes',
    keepAliveTimeout,
    keepAliveMaxTimeout: Math.max(keepAliveTimeout, HTTP_KEEPALIVE_MAX_TIMEOUT_FLOOR_MS),
    connections: positiveOverride(env.LUMEN_HTTP_KEEPALIVE_CONNECTIONS, HTTP_KEEPALIVE_CONNECTIONS),
    pipelining: 1
  };
}

/**
 * The one boot line, in the `render-timing:` family so it greps out of the app
 * log alongside the per-render stages it is meant to explain. `note` carries the
 * one thing the settings cannot say for themselves: whether the dispatcher was
 * actually installed, or why it was not.
 *
 * Off, this reads:
 *   render-timing: http-keepalive off (LUMEN_HTTP_KEEPALIVE=yes to enable;
 *   node default holds an idle socket 4000ms)
 * On:
 *   render-timing: http-keepalive on keepAliveTimeout=50000ms
 *   keepAliveMaxTimeout=600000ms connections=16 pipelining=1
 */
export function httpKeepAliveLogLine(settings: HttpKeepAliveSettings, note?: string): string {
  const suffix = note ? ` ${note}` : '';
  if (!settings.enabled) {
    return (
      'render-timing: http-keepalive off ' +
      '(LUMEN_HTTP_KEEPALIVE=yes to enable; node default holds an idle socket 4000ms)' +
      suffix
    );
  }
  return (
    `render-timing: http-keepalive on keepAliveTimeout=${settings.keepAliveTimeout}ms ` +
    `keepAliveMaxTimeout=${settings.keepAliveMaxTimeout}ms ` +
    `connections=${settings.connections} pipelining=${settings.pipelining}${suffix}`
  );
}
