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
 * True when the failure carries no information about the request itself — i.e. retrying
 * could plausibly produce a different answer.
 */
export function isTransient(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const status = (error as { status?: number; statusCode?: number; response?: { status?: number } });
  const code = status.status ?? status.statusCode ?? status.response?.status;
  if (typeof code === 'number') {
    // 5xx is the upstream failing to answer. 4xx is the upstream answering.
    if (code >= 500) return true;
    if (code >= 400) return false;
  }

  const message = error instanceof Error ? `${error.message} ${(error as NodeJS.ErrnoException).code ?? ''}` : String(error);
  if (NOT_TRANSIENT.test(message)) return false;
  return TRANSPORT_FAULT.test(message);
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
