/**
 * ════ RETRY FOR UPSTREAM HIVE CALLS (A6, 2026-08-18) ════
 *
 * ★★ WHAT WAS ACTUALLY WRONG. Routes like `/api/community` awaited a single upstream
 * Hive API call inside a bare `try`, and turned ANY throw into a 502. A public Hive node
 * dropping one connection — a reset socket, a DNS blip, a node cycling — became a hard
 * failure page for the reader, even though the very next request would have succeeded.
 * The harness saw exactly this: intermittent 502s on `/api/community`,
 * `/api/followers` and `/api/notifications/unread` that never reproduced on a re-run.
 *
 * ★★★ IT ONLY RETRIES WHAT IS WORTH RETRYING, AND THAT IS THE WHOLE DESIGN.
 *
 * A retry on a deterministic error is not resilience, it is the same wrong answer three
 * times at three times the latency — and on a write path it is duplicate work. So:
 *
 *   RETRIED    transport faults and 5xx — the request never got a considered answer.
 *   NOT RETRIED  4xx, and anything that does not look like a transport fault. A node
 *                saying "no such community" will say it again.
 *
 * ★ THE TIME BUDGET IS THE POINT, NOT THE ATTEMPT COUNT. A route that retries without a
 * deadline converts a fast failure into a slow one and holds a server connection open
 * while it does — under load that is how a retry turns a blip into an outage. `budgetMs`
 * is checked BEFORE each sleep, so the caller's worst case is bounded whatever the
 * attempt count says.
 *
 * ★ JITTER IS NOT DECORATION. Without it, every request that failed on the same upstream
 * hiccup retries in the same millisecond, which is the thundering herd that keeps a
 * recovering node down.
 */

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  /** Base backoff; attempt n waits roughly baseMs * 2^(n-1), plus jitter. */
  baseMs?: number;
  /** Hard ceiling on time spent retrying. The first attempt is never cut short by this. */
  budgetMs?: number;
  /** Included in the thrown error so a log line says which call gave up. */
  label?: string;
}

const DEFAULTS: Required<Omit<RetryOptions, 'label'>> = {
  attempts: 3,
  baseMs: 150,
  budgetMs: 2500
};

/**
 * ★★ A DETERMINISTIC ERROR THAT CONTAINS THE WORD "TIMEOUT" IS STILL DETERMINISTIC.
 *
 * The first version of this regex matched a bare `timeout`, which swept up Hivemind's
 * Postgres statement timeout (SQLSTATE 57014, "canceling statement due to statement
 * timeout"). That error is not a failure to ANSWER - it is the answer: the query is too
 * expensive and will be too expensive again. `/api/search` was hardened on this exact
 * point earlier the same day, because retrying it cannot succeed and costs ~12.4s of a
 * reader's time to learn nothing.
 *
 * So the exclusions come first and win. Everything left is a transport fault: the request
 * never reached a considered answer, and asking again may get one.
 */
const NOT_TRANSIENT = /statement timeout|canceling statement|57014/i;

const TRANSPORT_FAULT =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|request timed out|timed out|aborted/i;

/**
 * ★★★ THE REASON IS BURIED, SO THE PREDICATE HAS TO DIG (2026-09-05).
 *
 * This used to read the TOP-LEVEL error only, which is exactly the bug
 * `smart-signer/lib/hive-network-error.ts` was written to fix on the other side
 * of the app: wax does not surface the transport failure, it WRAPS it, and the
 * thing that actually carried `ETIMEDOUT` on this box was an `AggregateError`
 * two levels down from a `WaxUnknownRequestError`. A top-level read of that sees
 * a message with no `ECONNRESET` in it anywhere and calls it permanent.
 *
 * What that costs is not an extra 150ms. `getProfileInfo` (hive-api.ts) is
 * wrapped in `withRetry`, and its caller `getAccountFull` swallows a failure
 * with `.catch(() => null)` into `follower_count: 0, following_count: 0,
 * reputation: 25`. So a single wrapped reset does not show up as an error at
 * all: the profile renders with a plausible-looking WRONG follower count, and
 * that render is then held by the edge for up to 5 minutes for every anonymous
 * reader. A silently wrong number is the worst outcome available here, which is
 * why this is worth fixing whether or not connection reuse is ever switched on
 * (`apps/blog/lib/http-keepalive.ts`) -- reuse only makes a stale-socket reset
 * more likely, it does not create the class.
 *
 * ★ WHY THIS DOES NOT JUST CALL `isHiveNetworkError`. Two reasons, and the
 * second is the load-bearing one:
 *   1. That module imports the endpoint-rotation machinery and a logger at its
 *      top level, so importing it here would drag both into every consumer of a
 *      dependency-free 100-line file.
 *   2. Its pattern list matches a BARE `/timeout/i`, on purpose, because for a
 *      login "we could not reach the node" is the only question. Here it is not:
 *      this module's whole doc comment above is about `NOT_TRANSIENT`, i.e. that
 *      Hivemind's Postgres statement timeout is an ANSWER and retrying it costs
 *      a reader ~12.4s to learn nothing. Sharing the predicate would re-introduce
 *      precisely the bug that regex was added to kill.
 * So the SHAPE is copied (walk `cause`, follow `AggregateError.errors`, cap the
 * depth, read wax's `type` as well as `name`) and the RULES stay this module's
 * own. If the shape ever needs to change, both files change together.
 *
 * ★ EXCLUSIONS WIN ACROSS THE WHOLE CHAIN, not just at the level they appear.
 * `NOT_TRANSIENT` is checked over every level FIRST, so a statement timeout
 * cannot be dragged back into "retry me" by some outer wrapper whose generic
 * message happens to say "fetch failed".
 *
 * ★ AN HTTP STATUS STILL SHORT-CIRCUITS AT THE LEVEL THAT CARRIES IT. A node
 * that answered 404 has answered; walking deeper to find a transport-shaped word
 * would turn "no such community" into three slow 404s.
 */
const MAX_CAUSE_DEPTH = 5;

/** Every error in the `cause` / `AggregateError.errors` tree, shallowest first. */
function causeChain(error: unknown, depth = 0, seen = new Set<unknown>()): unknown[] {
  if (error === null || error === undefined) return [];
  if (depth >= MAX_CAUSE_DEPTH) return [];
  // A `cause` that points back at an ancestor would otherwise spin until the
  // depth cap; cheap to make impossible rather than merely bounded.
  if (typeof error === 'object' && seen.has(error)) return [];
  if (typeof error === 'object') seen.add(error);

  const chain: unknown[] = [error];
  const aggregated = (error as { errors?: unknown[] }).errors;
  if (Array.isArray(aggregated)) {
    for (const nested of aggregated) chain.push(...causeChain(nested, depth + 1, seen));
  }
  chain.push(...causeChain((error as { cause?: unknown }).cause, depth + 1, seen));
  return chain;
}

/**
 * The text one level is matched on. `name` and wax's `type` are included because
 * wax reports its class as `type` ("WaxRequestTimeoutError") while `name` stays
 * the generic "WaxError" -- the same reasoning `hive-network-error.ts` records.
 * `code` is included because a bare `ECONNRESET` often lives only there.
 */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const waxType = (error as { type?: unknown }).type;
  const code = (error as NodeJS.ErrnoException).code ?? '';
  return `${error.name}: ${typeof waxType === 'string' ? `${waxType}: ` : ''}${error.message} ${code}`;
}

/**
 * True when the failure carries no information about the request itself — i.e. retrying
 * could plausibly produce a different answer.
 */
export function isTransient(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const chain = causeChain(error);

  // Exclusions first and across the whole chain. See the doc comment.
  if (chain.some((level) => NOT_TRANSIENT.test(errorText(level)))) return false;

  for (const level of chain) {
    const status = level as { status?: number; statusCode?: number; response?: { status?: number } };
    const code = status.status ?? status.statusCode ?? status.response?.status;
    if (typeof code === 'number') {
      // 5xx is the upstream failing to answer. 4xx is the upstream answering.
      if (code >= 500) return true;
      if (code >= 400) return false;
    }
    if (TRANSPORT_FAULT.test(errorText(level))) return true;
  }

  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts, baseMs, budgetMs } = { ...DEFAULTS, ...options };
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // A permanent error must surface immediately and unchanged — the caller's own
      // handling (a 404, a validation message) is the correct response to it.
      if (!isTransient(error)) throw error;
      if (attempt === attempts) break;

      const backoff = baseMs * 2 ** (attempt - 1);
      const jittered = backoff / 2 + Math.random() * backoff;
      // Checked BEFORE sleeping: never spend budget we are about to exceed anyway.
      if (Date.now() - startedAt + jittered > budgetMs) break;
      await sleep(jittered);
    }
  }

  if (lastError instanceof Error && options.label) {
    lastError.message = `${options.label}: ${lastError.message} (gave up after ${Date.now() - startedAt}ms)`;
  }
  throw lastError;
}
